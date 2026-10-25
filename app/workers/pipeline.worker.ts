/**
 * HOMR 识别 Worker：整条链路都在浏览器里完成。
 *
 *   page   解码 -> 缩放 -> 灰度 -> CLAHE -> SegNet 分块 -> 类别图 ->
 *          符号/谱表几何 -> Transformer -> 声部 -> MusicXML
 *
 * 模型相关的计算全部在这个 Worker 里，主线程只负责绘制。离开 Worker 的坐标是
 * 页面坐标（模型看到的 1920px 宽图像），`scale` 负责换算回用户所选图片的像素。
 */

import * as ort from 'onnxruntime-web/wasm'

import { clahe, grayFromRgb, resizeBicubic } from '../lib/imageops.js'
import {
  createBoundingEllipses,
  createRotatedBoundingBoxes
} from '../lib/homr/boundingBoxes'
import { detectBarLines, prepareBarLineImage } from '../lib/homr/barLineDetection'
import {
  findBracesBracketsAndGrandStaffLines,
  prepareBraceDotImage
} from '../lib/homr/braceDot'
import { masksFromClassMap, makeLinesStronger } from '../lib/homr/masks'
import type { Staff, StaffPoint } from '../lib/homr/model'
import { generateMusicXmlString } from '../lib/homr/musicXmlGenerator'
import { addNotesToStaffs, combineNoteheadsWithStems } from '../lib/homr/noteDetection'
import { filterPredictions } from '../lib/homr/noiseFiltering'
import { median, pyRound } from '../lib/homr/numeric'
import type { GrayImage } from '../lib/homr/staffDewarping'
import { toPrediction } from '../lib/homr/staffParsing'
import { parseStaffs, type ParsedStaff } from '../lib/homr/staffParsingPipeline'
import { breakWideFragments, detectStaff } from '../lib/homr/staffDetection'
import type { EncodedSymbol } from '../lib/homr/vocabulary'

/** ORT 运行时由 `scripts/prepare-assets.mjs` 链接到 `public/ort/`。 */
const ORT_WASM = '/ort/ort-wasm-simd-threaded.wasm'
const ORT_MJS = '/ort/ort-wasm-simd-threaded.mjs'

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const ctx = self as unknown as WorkerScope

ort.env.logLevel = 'error'
ort.env.wasm.simd = true
ort.env.wasm.numThreads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1))
ort.env.wasm.wasmPaths = { wasm: ORT_WASM, mjs: ORT_MJS }

const PAGE_WIDTH = 1920
const WIN = 320
const CLASSES = 6
/** `--guess-meter-per-section` 与 reference 里的 Python 基准保持一致。 */
const XML_ARGUMENTS = { guessMeterPerSection: true }

type Stage = 'preprocess' | 'segnet' | 'symbols' | 'staffs' | 'transformer' | 'musicxml'

const sessions = new Map<string, Promise<ort.InferenceSession>>()

function session(name: 'segnet' | 'encoder' | 'decoder'): Promise<ort.InferenceSession> {
  let cached = sessions.get(name)
  if (!cached) {
    cached = (async () => {
      const response = await fetch(`/models/${name}.onnx`)
      if (!response.ok) throw new Error(`${name}.onnx: HTTP ${response.status}`)
      const bytes = await response.arrayBuffer()
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      })
    })()
    sessions.set(name, cached)
  }
  return cached
}

function progress(stage: Stage, done: number, total: number): void {
  ctx.postMessage({ type: 'progress', stage, done, total })
}

/** Tile origins, generated exactly like HOMR's inference(). */
function tileOrigins(size: number): number[] {
  const origins: number[] = []
  for (let v = 0; v < Math.max(size, WIN); v += WIN) origins.push(Math.min(v, size - WIN))
  return origins
}

/** A token row for the report; the coordinates stay with the staff they came from. */
function tokenRow(symbol: EncodedSymbol): Record<string, string> {
  return {
    rhythm: symbol.rhythm,
    pitch: symbol.pitch,
    lift: symbol.lift,
    articulation: symbol.articulation,
    slur: symbol.slur,
    position: symbol.position
  }
}

/** The four corners of a staff in page coordinates: top line left/right, then bottom. */
function staffQuad(staff: Staff): [number, number][] {
  const first = staff.grid[0]
  const last = staff.grid[staff.grid.length - 1]
  const bottom = (point: StaffPoint): number => point.y[point.y.length - 1]
  return [
    [first.x, first.y[0]],
    [last.x, last.y[0]],
    [last.x, bottom(last)],
    [first.x, bottom(first)]
  ]
}

/** One recognised symbol with the page point the decoder's attention maps to. */
function symbolWithPosition(entry: ParsedStaff, symbol: EncodedSymbol) {
  let x: number | null = null
  let y: number | null = null
  if (symbol.coordinates !== null) {
    const point = toPrediction(entry.prepared.transform, symbol.coordinates)
    if (point !== null) {
      x = point.x
      y = point.y
    }
  }
  return {
    id: symbol.id ?? '',
    rhythm: symbol.rhythm,
    pitch: symbol.pitch,
    lift: symbol.lift,
    articulation: symbol.articulation,
    slur: symbol.slur,
    position: symbol.position,
    x,
    y
  }
}

async function runPage(rgba: Uint8Array, width: number, height: number, name: string) {
  const started = performance.now()
  const t0 = performance.now()
  progress('preprocess', 0, 1)

  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0, p = 0, q = 0; i < width * height; i += 1, p += 4, q += 3) {
    rgb[q] = rgba[p]
    rgb[q + 1] = rgba[p + 1]
    rgb[q + 2] = rgba[p + 2]
  }
  const targetH = pyRound(height * (PAGE_WIDTH / width))
  const resized = resizeBicubic(rgb, width, height, PAGE_WIDTH, targetH, 3)
  const gray = grayFromRgb(resized, PAGE_WIDTH, targetH)
  const page: GrayImage = { data: clahe(gray, PAGE_WIDTH, targetH, 8, 8, 1.0), width: PAGE_WIDTH, height: targetH }
  const preprocessMs = performance.now() - t0
  progress('preprocess', 1, 1)

  // SegNet: every tile is stored back as a soft score so the overlap averages out.
  const t1 = performance.now()
  const segnet = await session('segnet')
  const inputName = segnet.inputNames[0]
  const outputName = segnet.outputNames[0]
  const modelLoadMs = performance.now() - t1

  const ys = tileOrigins(targetH)
  const xs = tileOrigins(PAGE_WIDTH)
  const scoreSum = new Float32Array(CLASSES * PAGE_WIDTH * targetH)
  const coverage = new Float32Array(PAGE_WIDTH * targetH)
  const patch = new Float32Array(3 * WIN * WIN)

  for (const y of ys) {
    for (const x of xs) {
      patch.fill(255)
      const y0 = Math.max(y, 0)
      const x0 = Math.max(x, 0)
      const y1 = Math.min(y + WIN, targetH)
      const x1 = Math.min(x + WIN, PAGE_WIDTH)
      for (let c = 0; c < 3; c += 1) {
        const base = c * WIN * WIN
        for (let row = y0; row < y1; row += 1) {
          const src = row * PAGE_WIDTH + x0
          const dst = base + (row - y0) * WIN
          for (let col = 0; col < x1 - x0; col += 1) patch[dst + col] = page.data[src + col]
        }
      }

      const out = await segnet.run({
        [inputName]: new ort.Tensor('float32', patch, [1, 3, WIN, WIN])
      })
      const scores = out[outputName].data as Float32Array
      for (let c = 0; c < CLASSES; c += 1) {
        const plane = c * PAGE_WIDTH * targetH
        for (let row = y0; row < y1; row += 1) {
          const src = c * WIN * WIN + (row - y0) * WIN
          const dst = plane + row * PAGE_WIDTH + x0
          for (let col = 0; col < x1 - x0; col += 1) scoreSum[dst + col] += scores[src + col]
        }
      }
      for (let row = y0; row < y1; row += 1) {
        const dst = row * PAGE_WIDTH + x0
        for (let col = 0; col < x1 - x0; col += 1) coverage[dst + col] += 1
      }

      progress('segnet', ys.indexOf(y) * xs.length + xs.indexOf(x) + 1, xs.length * ys.length)
    }
  }
  const segnetMs = performance.now() - t1 - modelLoadMs

  const classMap = new Uint8Array(PAGE_WIDTH * targetH)
  const histogram = new Uint32Array(CLASSES)
  for (let i = 0; i < classMap.length; i += 1) {
    const cov = coverage[i] || 1
    let best = 0
    let bestScore = scoreSum[i] / cov
    for (let c = 1; c < CLASSES; c += 1) {
      const s = scoreSum[c * classMap.length + i] / cov
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
    classMap[i] = best
    histogram[best] += 1
  }

  // The class map goes to the UI right away so the page can be painted while the
  // geometry and the transformer run. The mask split happens first: the buffer is
  // transferred, not copied.
  const raw = masksFromClassMap(classMap)
  ctx.postMessage(
    {
      type: 'page-done',
      width: PAGE_WIDTH,
      height: targetH,
      rgb: resized.buffer,
      mask: classMap.buffer,
      histogram: Array.from(histogram),
      timings: { preprocess: preprocessMs, modelLoad: modelLoadMs, segnet: segnetMs, tiles: xs.length * ys.length }
    },
    [resized.buffer, classMap.buffer]
  )

  // filter_predictions and make_lines_stronger, as load_and_preprocess_predictions does.
  const t2 = performance.now()
  const filtered = filterPredictions(raw, PAGE_WIDTH, targetH).masks
  const staffMask = makeLinesStronger(filtered.staff, PAGE_WIDTH, targetH, [1, 2])
  const staffImage = { binary: staffMask, width: PAGE_WIDTH, height: targetH }
  const noteheadMask = { binary: filtered.notehead, width: PAGE_WIDTH, height: targetH }

  // predict_symbols
  const noteheads = createBoundingEllipses(noteheadMask.binary, PAGE_WIDTH, targetH, {
    minSize: [4, 4]
  })
  const staffFragments = breakWideFragments(
    createRotatedBoundingBoxes(staffMask, PAGE_WIDTH, targetH, {
      skipMerging: true,
      minSize: [5, 1],
      maxSize: [10000, 100]
    })
  )
  const clefsKeys = createRotatedBoundingBoxes(filtered.clefs_keys, PAGE_WIDTH, targetH, {
    minSize: [20, 40],
    maxSize: [1000, 1000]
  })
  const stemsRest = createRotatedBoundingBoxes(filtered.stems_rest, PAGE_WIDTH, targetH)
  const barLineImage = prepareBarLineImage(filtered.stems_rest, PAGE_WIDTH, targetH)
  const barLineCandidates = createRotatedBoundingBoxes(barLineImage, PAGE_WIDTH, targetH, {
    skipMerging: true,
    minSize: [1, 5]
  })

  // combine_noteheads_with_stems
  const noteheadsWithStems = combineNoteheadsWithStems(noteheads, stemsRest)
  if (noteheadsWithStems.length === 0) throw new Error('没有检测到音符头，无法识别这张图片')
  const averageNoteHeadHeight = median(
    noteheadsWithStems.map(entry => entry.notehead.size[1])
  )

  const allNoteheads = noteheadsWithStems.map(entry => entry.notehead)
  const allStems = noteheadsWithStems
    .filter(entry => entry.stem !== null)
    .map(entry => entry.stem as NonNullable<typeof entry.stem>)
  const barLines = detectBarLines(
    barLineCandidates.filter(
      line => !line.isOverlappingWithAny(allNoteheads) && !line.isOverlappingWithAny(allStems)
    ),
    averageNoteHeadHeight
  )

  // detect_staff
  const staffs = detectStaff(staffImage, staffFragments, clefsKeys, barLines)
  if (staffs.length === 0) throw new Error('没有检测到谱表，请换一张更清晰的图片')
  progress('staffs', staffs.length, staffs.length)

  const braceDot = createRotatedBoundingBoxes(
    prepareBraceDotImage({ binary: filtered.symbols, width: PAGE_WIDTH, height: targetH }, staffImage),
    PAGE_WIDTH,
    targetH,
    { skipMerging: true, maxSize: [100, -1] }
  )
  addNotesToStaffs(staffs, noteheadsWithStems, noteheadMask)
  const multiStaffs = findBracesBracketsAndGrandStaffLines(staffs, braceDot)
  const symbolsMs = performance.now() - t2
  progress('symbols', 1, 1)

  // parse_staffs: one transformer run per staff row.
  const t3 = performance.now()
  const transformer = { encoder: await session('encoder'), decoder: await session('decoder') }
  const parsed = await parseStaffs(multiStaffs, page, transformer, {
    onStaffDone: (_staff, done, total) => progress('transformer', done, total)
  })
  const transformerMs = performance.now() - t3

  const t4 = performance.now()
  const title = name.replace(/\.[^.]+$/, '')
  // The writer reports one symbol per `<note>`, in document order. Nothing is written
  // into the XML, so the recognition output stays byte-identical to the reference.
  const noteSymbols: (string | null)[] = []
  const musicxml = generateMusicXmlString(parsed.voices, title, {
    ...XML_ARGUMENTS,
    onNote: symbol => noteSymbols.push(symbol.id)
  })
  const musicxmlMs = performance.now() - t4
  progress('musicxml', 1, 1)

  const staffPayload = parsed.staffs.map(entry => ({
    index: entry.index,
    voice: entry.voice,
    systemIndex: entry.systemIndex,
    quad: staffQuad(entry.staff),
    symbols: entry.symbols
      .filter(symbol => symbol.rhythm !== 'newline' && symbol.rhythm !== 'chord')
      .map(symbol => symbolWithPosition(entry, symbol)),
    notes: entry.staff.getNotes().map(note => ({
      x: note.box.center.x,
      y: note.box.center.y,
      width: note.box.size[0],
      height: note.box.size[1],
      angle: note.box.angle
    }))
  }))

  const tokens = staffPayload.flatMap(staff => staff.symbols)
  const positions = tokens.filter(symbol => symbol.x !== null).length
  ctx.postMessage({
    type: 'result',
    title,
    musicxml,
    noteSymbols,
    page: { width: PAGE_WIDTH, height: targetH },
    image: { width, height },
    scale: { x: PAGE_WIDTH / width, y: targetH / height },
    voices: parsed.voices.map(voice => voice.map(tokenRow)),
    staffs: staffPayload,
    counts: {
      noteheads: noteheadsWithStems.length,
      systems: multiStaffs.length,
      staves: parsed.staffs.length,
      symbols: tokens.length,
      notes: tokens.filter(symbol => symbol.rhythm.startsWith('note')).length,
      rests: tokens.filter(symbol => symbol.rhythm.startsWith('rest')).length,
      withPosition: positions,
      withoutPosition: tokens.length - positions
    },
    timings: {
      preprocess: preprocessMs,
      modelLoad: modelLoadMs,
      segnet: segnetMs,
      symbols: symbolsMs,
      transformer: transformerMs,
      musicxml: musicxmlMs,
      total: performance.now() - started
    },
    runtime: {
      threads: ort.env.wasm.numThreads,
      crossOriginIsolated: (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
      hardwareConcurrency: navigator.hardwareConcurrency
    }
  })
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {
    type: 'page'
    rgba: ArrayBuffer
    width: number
    height: number
    name?: string
  }
  if (data.type !== 'page') return
  void (async () => {
    try {
      await runPage(new Uint8Array(data.rgba), data.width, data.height, data.name ?? 'score')
    } catch (error) {
      ctx.postMessage({ type: 'error', message: (error as Error).message })
    }
  })()
})
