/**
 * M4 Web Worker: the whole HOMR chain, in the browser.
 *
 * Two entry points, both driven from main.ts:
 *   page     decode -> resize -> gray -> CLAHE -> 54 SegNet tiles -> class map ->
 *            symbols -> staffs -> transformer -> voices -> MusicXML
 *   replay   run encoder + greedy decoder on the Python-made staff canvases and
 *            diff the token streams against staff_<i>_symbols.json
 *
 * Everything model-side runs here so the main thread only paints. Coordinates leaving
 * the worker are page coordinates, i.e. the 1920 px wide image the models see; `scale`
 * converts them to pixels of the file the user picked.
 */

import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import wasmMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

import { clahe, grayFromRgb, resizeBicubic } from './lib/imageops.js';
import {
  createBoundingEllipses,
  createRotatedBoundingBoxes,
} from './lib/homr/boundingBoxes.ts';
import { detectBarLines, prepareBarLineImage } from './lib/homr/barLineDetection.ts';
import {
  findBracesBracketsAndGrandStaffLines,
  prepareBraceDotImage,
} from './lib/homr/braceDot.ts';
import { masksFromClassMap, makeLinesStronger } from './lib/homr/masks.ts';
import type { Staff, StaffPoint } from './lib/homr/model.ts';
import { generateMusicXmlString } from './lib/homr/musicXmlGenerator.ts';
import { addNotesToStaffs, combineNoteheadsWithStems } from './lib/homr/noteDetection.ts';
import { filterPredictions } from './lib/homr/noiseFiltering.ts';
import { median, pyRound } from './lib/homr/numeric.ts';
import { type GrayImage } from './lib/homr/staffDewarping.ts';
import { toPrediction } from './lib/homr/staffParsing.ts';
import { parseStaffs, type ParsedStaff } from './lib/homr/staffParsingPipeline.ts';
import { breakWideFragments, detectStaff } from './lib/homr/staffDetection.ts';
import { type EncodedSymbol } from './lib/homr/vocabulary.ts';

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

const ctx = self as unknown as WorkerScope;

ort.env.logLevel = 'error';
ort.env.wasm.simd = true;
ort.env.wasm.numThreads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1));
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmMjs };

const PAGE_WIDTH = 1920;
const WIN = 320;
const CLASSES = 6;
const HEIGHT = 256;
const WIDTH = 1280;
/** `--guess-meter-per-section` is what the reference runs use, see check-musicxml.mjs. */
const XML_ARGUMENTS = { guessMeterPerSection: true };
const MAX_SEQ = 608;
const BOS = 1;
const EOS = 2;
const NONOTE = 0;
const MEAN = 0.7931;
const STD = 0.1738;

type Stage = 'preprocess' | 'segnet' | 'symbols' | 'staffs' | 'transformer' | 'musicxml';

const sessions = new Map<string, Promise<ort.InferenceSession>>();

function session(name: 'segnet' | 'encoder' | 'decoder'): Promise<ort.InferenceSession> {
  let cached = sessions.get(name);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(`/models/${name}.onnx`);
      if (!response.ok) throw new Error(`${name}.onnx: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })();
    sessions.set(name, cached);
  }
  return cached;
}

function progress(stage: Stage, done: number, total: number): void {
  ctx.postMessage({ type: 'progress', stage, done, total });
}

const argmaxLast = (data: Float32Array | BigInt64Array, stride: number): number => {
  const base = data.length - stride;
  let best = 0;
  for (let i = 1; i < stride; i += 1) {
    if ((data as Float32Array)[base + i] > (data as Float32Array)[base + best]) best = i;
  }
  return best;
};

/** Tile origins, generated exactly like HOMR's inference(). */
function tileOrigins(size: number): number[] {
  const origins: number[] = [];
  for (let v = 0; v < Math.max(size, WIN); v += WIN) origins.push(Math.min(v, size - WIN));
  return origins;
}

/** A token row for the report; the coordinates stay with the staff they came from. */
function tokenRow(symbol: EncodedSymbol): Record<string, string> {
  return {
    rhythm: symbol.rhythm,
    pitch: symbol.pitch,
    lift: symbol.lift,
    articulation: symbol.articulation,
    slur: symbol.slur,
    position: symbol.position,
  };
}

/** The four corners of a staff in page coordinates: top line left/right, then bottom. */
function staffQuad(staff: Staff): [number, number][] {
  const first = staff.grid[0];
  const last = staff.grid[staff.grid.length - 1];
  const bottom = (point: StaffPoint): number => point.y[point.y.length - 1];
  return [
    [first.x, first.y[0]],
    [last.x, last.y[0]],
    [last.x, bottom(last)],
    [first.x, bottom(first)],
  ];
}

/** One recognised symbol with the page point the decoder's attention maps to. */
function symbolWithPosition(entry: ParsedStaff, symbol: EncodedSymbol) {
  let x: number | null = null;
  let y: number | null = null;
  if (symbol.coordinates !== null) {
    const point = toPrediction(entry.prepared.transform, symbol.coordinates);
    if (point !== null) {
      x = point.x;
      y = point.y;
    }
  }
  return {
    rhythm: symbol.rhythm,
    pitch: symbol.pitch,
    lift: symbol.lift,
    articulation: symbol.articulation,
    slur: symbol.slur,
    position: symbol.position,
    x,
    y,
  };
}

async function runPage(rgba: Uint8Array, width: number, height: number, name: string) {
  const started = performance.now();
  const t0 = performance.now();

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0, q = 0; i < width * height; i += 1, p += 4, q += 3) {
    rgb[q] = rgba[p];
    rgb[q + 1] = rgba[p + 1];
    rgb[q + 2] = rgba[p + 2];
  }
  const targetH = pyRound(height * (PAGE_WIDTH / width));
  const resized = resizeBicubic(rgb, width, height, PAGE_WIDTH, targetH, 3);
  const gray = grayFromRgb(resized, PAGE_WIDTH, targetH);
  const page: GrayImage = { data: clahe(gray, PAGE_WIDTH, targetH, 8, 8, 1.0), width: PAGE_WIDTH, height: targetH };
  const preprocessMs = performance.now() - t0;
  progress('preprocess', 1, 1);

  // SegNet: every tile is stored back as a soft score so the overlap averages out.
  const t1 = performance.now();
  const segnet = await session('segnet');
  const inputName = segnet.inputNames[0];
  const outputName = segnet.outputNames[0];
  const modelLoadMs = performance.now() - t1;

  const ys = tileOrigins(targetH);
  const xs = tileOrigins(PAGE_WIDTH);
  const scoreSum = new Float32Array(CLASSES * PAGE_WIDTH * targetH);
  const coverage = new Float32Array(PAGE_WIDTH * targetH);
  const patch = new Float32Array(3 * WIN * WIN);

  for (const y of ys) {
    for (const x of xs) {
      patch.fill(255);
      const y0 = Math.max(y, 0);
      const x0 = Math.max(x, 0);
      const y1 = Math.min(y + WIN, targetH);
      const x1 = Math.min(x + WIN, PAGE_WIDTH);
      for (let c = 0; c < 3; c += 1) {
        const base = c * WIN * WIN;
        for (let row = y0; row < y1; row += 1) {
          const src = row * PAGE_WIDTH + x0;
          const dst = base + (row - y0) * WIN;
          for (let col = 0; col < x1 - x0; col += 1) patch[dst + col] = page.data[src + col];
        }
      }

      const out = await segnet.run({
        [inputName]: new ort.Tensor('float32', patch, [1, 3, WIN, WIN]),
      });
      const scores = out[outputName].data as Float32Array;
      for (let c = 0; c < CLASSES; c += 1) {
        const plane = c * PAGE_WIDTH * targetH;
        for (let row = y0; row < y1; row += 1) {
          const src = c * WIN * WIN + (row - y0) * WIN;
          const dst = plane + row * PAGE_WIDTH + x0;
          for (let col = 0; col < x1 - x0; col += 1) scoreSum[dst + col] += scores[src + col];
        }
      }
      for (let row = y0; row < y1; row += 1) {
        const dst = row * PAGE_WIDTH + x0;
        for (let col = 0; col < x1 - x0; col += 1) coverage[dst + col] += 1;
      }

      progress('segnet', ys.indexOf(y) * xs.length + xs.indexOf(x) + 1, xs.length * ys.length);
    }
  }
  const segnetMs = performance.now() - t1 - modelLoadMs;

  const classMap = new Uint8Array(PAGE_WIDTH * targetH);
  const histogram = new Uint32Array(CLASSES);
  for (let i = 0; i < classMap.length; i += 1) {
    const cov = coverage[i] || 1;
    let best = 0;
    let bestScore = scoreSum[i] / cov;
    for (let c = 1; c < CLASSES; c += 1) {
      const s = scoreSum[c * classMap.length + i] / cov;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    classMap[i] = best;
    histogram[best] += 1;
  }

  // The class map goes to the UI right away so the page can be painted while the
  // geometry and the transformer run. The mask split happens first: the buffer is
  // transferred, not copied.
  const raw = masksFromClassMap(classMap);
  ctx.postMessage(
    {
      type: 'page-done',
      width: PAGE_WIDTH,
      height: targetH,
      rgb: resized.buffer,
      mask: classMap.buffer,
      histogram: Array.from(histogram),
      timings: { preprocess: preprocessMs, modelLoad: modelLoadMs, segnet: segnetMs, tiles: xs.length * ys.length },
    },
    [resized.buffer, classMap.buffer],
  );

  // filter_predictions and make_lines_stronger, as load_and_preprocess_predictions does.
  const t2 = performance.now();
  const filtered = filterPredictions(raw, PAGE_WIDTH, targetH).masks;
  const staffMask = makeLinesStronger(filtered.staff, PAGE_WIDTH, targetH, [1, 2]);
  const staffImage = { binary: staffMask, width: PAGE_WIDTH, height: targetH };
  const noteheadMask = { binary: filtered.notehead, width: PAGE_WIDTH, height: targetH };

  // predict_symbols
  const noteheads = createBoundingEllipses(noteheadMask.binary, PAGE_WIDTH, targetH, {
    minSize: [4, 4],
  });
  const staffFragments = breakWideFragments(
    createRotatedBoundingBoxes(staffMask, PAGE_WIDTH, targetH, {
      skipMerging: true,
      minSize: [5, 1],
      maxSize: [10000, 100],
    }),
  );
  const clefsKeys = createRotatedBoundingBoxes(filtered.clefs_keys, PAGE_WIDTH, targetH, {
    minSize: [20, 40],
    maxSize: [1000, 1000],
  });
  const stemsRest = createRotatedBoundingBoxes(filtered.stems_rest, PAGE_WIDTH, targetH);
  const barLineImage = prepareBarLineImage(filtered.stems_rest, PAGE_WIDTH, targetH);
  const barLineCandidates = createRotatedBoundingBoxes(barLineImage, PAGE_WIDTH, targetH, {
    skipMerging: true,
    minSize: [1, 5],
  });

  // combine_noteheads_with_stems
  const noteheadsWithStems = combineNoteheadsWithStems(noteheads, stemsRest);
  if (noteheadsWithStems.length === 0) throw new Error('没有检测到音符头，无法识别这张图片');
  const averageNoteHeadHeight = median(
    noteheadsWithStems.map((entry) => entry.notehead.size[1]),
  );

  const allNoteheads = noteheadsWithStems.map((entry) => entry.notehead);
  const allStems = noteheadsWithStems
    .filter((entry) => entry.stem !== null)
    .map((entry) => entry.stem as NonNullable<typeof entry.stem>);
  const barLines = detectBarLines(
    barLineCandidates.filter(
      (line) => !line.isOverlappingWithAny(allNoteheads) && !line.isOverlappingWithAny(allStems),
    ),
    averageNoteHeadHeight,
  );

  // detect_staff
  const staffs = detectStaff(staffImage, staffFragments, clefsKeys, barLines);
  if (staffs.length === 0) throw new Error('没有检测到谱表，请换一张更清晰的图片');
  progress('staffs', staffs.length, staffs.length);

  const braceDot = createRotatedBoundingBoxes(
    prepareBraceDotImage({ binary: filtered.symbols, width: PAGE_WIDTH, height: targetH }, staffImage),
    PAGE_WIDTH,
    targetH,
    { skipMerging: true, maxSize: [100, -1] },
  );
  addNotesToStaffs(staffs, noteheadsWithStems, noteheadMask);
  const multiStaffs = findBracesBracketsAndGrandStaffLines(staffs, braceDot);
  const symbolsMs = performance.now() - t2;
  progress('symbols', 1, 1);

  // parse_staffs: one transformer run per staff row.
  const t3 = performance.now();
  const transformer = { encoder: await session('encoder'), decoder: await session('decoder') };
  const parsed = await parseStaffs(multiStaffs, page, transformer, {
    onStaffDone: (_staff, done, total) => progress('transformer', done, total),
  });
  const transformerMs = performance.now() - t3;

  const t4 = performance.now();
  const title = name.replace(/\.[^.]+$/, '');
  const musicxml = generateMusicXmlString(parsed.voices, title, XML_ARGUMENTS);
  const musicxmlMs = performance.now() - t4;
  progress('musicxml', 1, 1);

  const staffPayload = parsed.staffs.map((entry) => ({
    index: entry.index,
    voice: entry.voice,
    systemIndex: entry.systemIndex,
    quad: staffQuad(entry.staff),
    symbols: entry.symbols
      .filter((symbol) => symbol.rhythm !== 'newline' && symbol.rhythm !== 'chord')
      .map((symbol) => symbolWithPosition(entry, symbol)),
    notes: entry.staff.getNotes().map((note) => ({
      x: note.box.center.x,
      y: note.box.center.y,
      width: note.box.size[0],
      height: note.box.size[1],
      angle: note.box.angle,
    })),
  }));

  const tokens = staffPayload.flatMap((staff) => staff.symbols);
  const positions = tokens.filter((symbol) => symbol.x !== null).length;
  ctx.postMessage({
    type: 'result',
    title,
    musicxml,
    page: { width: PAGE_WIDTH, height: targetH },
    image: { width, height },
    scale: { x: PAGE_WIDTH / width, y: targetH / height },
    voices: parsed.voices.map((voice) => voice.map(tokenRow)),
    staffs: staffPayload,
    counts: {
      noteheads: noteheadsWithStems.length,
      systems: multiStaffs.length,
      staves: parsed.staffs.length,
      symbols: tokens.length,
      notes: tokens.filter((symbol) => symbol.rhythm.startsWith('note')).length,
      rests: tokens.filter((symbol) => symbol.rhythm.startsWith('rest')).length,
      withPosition: positions,
      withoutPosition: tokens.length - positions,
    },
    timings: {
      preprocess: preprocessMs,
      modelLoad: modelLoadMs,
      segnet: segnetMs,
      symbols: symbolsMs,
      transformer: transformerMs,
      musicxml: musicxmlMs,
      total: performance.now() - started,
    },
    runtime: {
      threads: ort.env.wasm.numThreads,
      crossOriginIsolated: (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
      hardwareConcurrency: navigator.hardwareConcurrency,
    },
  });
}

async function runReplay() {
  const base = '/reference/current';
  const meta = await (await fetch(`${base}/meta.json`)).json();
  const vocab = await (await fetch(`${base}/vocab.json`)).json();
  const encoder = await session('encoder');
  const decoder = await session('decoder');

  const heads = ['rhythm', 'pitch', 'lift', 'articulation', 'slur', 'position'];
  const tokenOf = (head: string, id: number) => vocab[head]?.[String(id)] ?? `#${id}`;

  const results = [];
  for (let index = 0; index < meta.staffs.length; index += 1) {
    const response = await fetch(`${base}/staff_${index}_input.png`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const context2d = canvas.getContext('2d');
    if (!context2d) throw new Error('no 2d context');
    context2d.drawImage(bitmap, 0, 0);
    const { data } = context2d.getImageData(0, 0, WIDTH, HEIGHT);

    const input = new Float32Array(HEIGHT * WIDTH);
    for (let i = 0; i < input.length; i += 1) input[i] = (data[i * 4] / 255 - MEAN) / STD;

    const t0 = performance.now();
    const enc = await encoder.run({
      [encoder.inputNames[0]]: new ort.Tensor('float32', input, [1, 1, HEIGHT, WIDTH]),
    });
    const context = enc[encoder.outputNames[0]];
    const encoderMs = performance.now() - t0;

    let cache: ort.Tensor[] = [];
    for (let i = 0; i < 32; i += 1) cache.push(new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]));
    const rhythm = [BOS];
    const pitch = [NONOTE];
    const lift = [NONOTE];
    const articulation = [NONOTE];
    const slur = [NONOTE];
    const steps: Record<string, string>[] = [];

    const t1 = performance.now();
    for (let step = 0; step < MAX_SEQ; step += 1) {
      const feeds: Record<string, ort.Tensor> = {
        rhythms: new ort.Tensor('int64', BigInt64Array.from([BigInt(rhythm.at(-1)!)]), [1, 1]),
        pitchs: new ort.Tensor('int64', BigInt64Array.from([BigInt(pitch.at(-1)!)]), [1, 1]),
        lifts: new ort.Tensor('int64', BigInt64Array.from([BigInt(lift.at(-1)!)]), [1, 1]),
        articulations: new ort.Tensor('int64', BigInt64Array.from([BigInt(articulation.at(-1)!)]), [1, 1]),
        slurs: new ort.Tensor('int64', BigInt64Array.from([BigInt(slur.at(-1)!)]), [1, 1]),
        cache_len: new ort.Tensor('int64', BigInt64Array.from([BigInt(step)]), [1]),
        context: step === 0 ? context : new ort.Tensor('float32', context.data.slice(0, 512) as Float32Array, [1, 1, 512]),
      };
      for (let i = 0; i < 32; i += 1) feeds[`cache_in${i}`] = cache[i];

      const out = await decoder.run(feeds);
      cache = [];
      for (let i = 0; i < 32; i += 1) cache.push(out[`cache_out${i}`]);

      const ids: Record<string, number> = {};
      for (const name of ['out_rhythms', 'out_pitchs', 'out_lifts', 'out_articulations', 'out_slurs', 'out_positions']) {
        const tensor = out[name];
        ids[name] = argmaxLast(tensor.data as Float32Array, tensor.dims[tensor.dims.length - 1]);
      }
      if (ids.out_rhythms === EOS) break;

      rhythm.push(ids.out_rhythms);
      pitch.push(ids.out_pitchs);
      lift.push(ids.out_lifts);
      articulation.push(ids.out_articulations);
      slur.push(ids.out_slurs);
      steps.push({
        rhythm: tokenOf('rhythm', ids.out_rhythms),
        pitch: tokenOf('pitch', ids.out_pitchs),
        lift: tokenOf('lift', ids.out_lifts),
        articulation: tokenOf('articulation', ids.out_articulations),
        slur: tokenOf('slur', ids.out_slurs),
        position: tokenOf('position', ids.out_positions),
      });
    }
    const decoderMs = performance.now() - t1;

    const expected = await (await fetch(`${base}/staff_${index}_symbols.json`)).json();
    const mismatches: string[] = [];
    for (let i = 0; i < Math.min(steps.length, expected.length); i += 1) {
      for (const head of heads) {
        if (steps[i][head] !== expected[i][head]) {
          if (mismatches.length < 5) mismatches.push(`#${i} ${head}: ${steps[i][head]} != ${expected[i][head]}`);
        }
      }
    }

    results.push({
      index,
      encoderMs,
      decoderMs,
      steps: steps.length,
      referenceSteps: expected.length,
      mismatches,
    });
    ctx.postMessage({ type: 'replay-staff', ...results[results.length - 1] });
  }

  ctx.postMessage({ type: 'replay-done', results });
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as
    | { type: 'page'; rgba: ArrayBuffer; width: number; height: number; name?: string }
    | { type: 'replay' };
  void (async () => {
    try {
      if (data.type === 'page') {
        await runPage(new Uint8Array(data.rgba), data.width, data.height, data.name ?? 'score');
      } else {
        await runReplay();
      }
    } catch (error) {
      ctx.postMessage({ type: 'error', message: (error as Error).message });
    }
  })();
});
