/**
 * 复音识别回归：不接麦克风，验窗口切片和 Basic Pitch 的接线。
 *
 *   node scripts/check-pitch.mjs
 *
 * 前半段只跑纯逻辑：`BasicPitchWindow` 必须把每段音频的帧正好发一次、按时间单调、
 * 中间不留空档；块大小变了、推理跟不上调宽间隔之后也要成立。
 *
 * 后半段在有 `public/models/nmp.onnx` 时跑一次真的推理（`pnpm assets` 会在本地
 * 准备它，产物不入库，所以拿不到就跳过），用合成的钢琴音确认 note/onset 两路
 * 输出没有接反、阈值能正常触发。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BASIC_PITCH_FRAME_SAMPLES,
  BASIC_PITCH_FRAMES,
  BASIC_PITCH_MIN_MIDI,
  BASIC_PITCH_NOTE_THRESHOLD,
  BASIC_PITCH_RATE,
  BASIC_PITCH_WINDOW,
  BasicPitchWindow,
  activePitches,
  frameRms,
  pickNoteOnset
} from '../app/lib/audio/basicPitch.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const modelFile = path.join(root, 'public/models/nmp.onnx')

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `（${detail}）` : ''}`)
  return ok
}

const FRAME_MS = BASIC_PITCH_FRAME_SAMPLES / BASIC_PITCH_RATE * 1000

/** 一直喂到 `seconds` 秒，返回这一路发出去的帧时间（毫秒）。 */
function collect(seconds, block, { widen = 0 } = {}) {
  const window = new BasicPitchWindow()
  const times = []
  const total = Math.round(seconds * BASIC_PITCH_RATE)
  let fed = 0
  let runs = 0
  while (fed < total) {
    const size = Math.min(block, total - fed)
    window.append(new Float32Array(size))
    fed += size
    for (let next = window.next(); next !== null; next = window.next()) {
      for (let frame = next.from; frame < BASIC_PITCH_FRAMES; frame += 1) {
        times.push((next.start + frame * BASIC_PITCH_FRAME_SAMPLES) / BASIC_PITCH_RATE * 1000)
      }
      runs += 1
      if (widen > 0 && runs % 4 === 0) window.slow(window.hop + widen)
    }
  }
  return { times, runs }
}

/**
 * 帧时间必须单调、不重复。第一个窗口之前的那段（不足一整窗）本来就出不了帧，
 * 所以只统计从第二帧起的间隔；后续的间隔上限是「一块音频」——只有还积在待处理块
 * 里的采样才可能被下一窗滑过去。
 */
function continuity(times) {
  let worstGap = 0
  let duplicates = 0
  for (let index = 2; index < times.length; index += 1) {
    const delta = times[index] - times[index - 1]
    if (delta <= 0) duplicates += 1
    worstGap = Math.max(worstGap, delta)
  }
  return { worstGap, duplicates }
}

try {
  const seconds = 8
  for (const block of [128, 1024, 4096, 65_536]) {
    const { times, runs } = collect(seconds, block)
    const { worstGap, duplicates } = continuity(times)
    // 块比 hop 大时会滑掉一点：工作线程拿到 1024 采样一块，这项上限实际只有 46ms。
    const blockMs = block / BASIC_PITCH_RATE * 1000
    check(
      `${block} 采样的块：帧连续且不重复`,
      times.length > 0
      && duplicates === 0
      && worstGap < blockMs + FRAME_MS * 2
      && times[0] < blockMs + FRAME_MS
      && times[times.length - 1] > seconds * 1000 - 1500,
      `${times.length} 帧 / ${runs} 次推理 / 最大间隔 ${worstGap.toFixed(1)}ms / 起点 ${times[0].toFixed(0)}ms`
    )
  }

  // 推理跟不上时把间隔放宽，覆盖仍然不能断。
  const slow = collect(seconds, 1024, { widen: 700 })
  const slowGap = continuity(slow.times)
  check(
    '推理变慢后自动放宽间隔也不漏帧',
    slowGap.duplicates === 0 && slowGap.worstGap < FRAME_MS * 2,
    `${slow.times.length} 帧 / ${slow.runs} 次推理 / 最大间隔 ${slowGap.worstGap.toFixed(1)}ms`
  )

  check(
    'onset 取更稀疏的那一路',
    pickNoteOnset(['a', 'b'], [1800, 300]).onset === 'b' && pickNoteOnset(['a', 'b'], [1800, 300]).note === 'a'
  )
  check(
    '两路都是零时按输出顺序取 onset',
    pickNoteOnset(['sparse', 'dense'], [0, 0]).onset === 'sparse'
  )

  const bins = new Float32Array(88)
  bins[3] = 0.9
  bins[40] = 0.1
  const active = activePitches(bins, BASIC_PITCH_NOTE_THRESHOLD)
  check(
    '逐帧音高按阈值和 MIDI 偏移换算',
    active.length === 1 && active[0] === BASIC_PITCH_MIN_MIDI + 3,
    active.join(',')
  )

  const loud = new Float32Array(2048).fill(0.25)
  check('RMS 按 8 帧窗口算', Math.abs(frameRms(loud, 0) - 0.25) < 1e-6 && frameRms(loud, 4096) === 0)

  // ---------------------------------------------------------------------------
  // 真的推理一次：合成一段钢琴式的 C4，再叠一个 E4+G4 和弦。
  // ---------------------------------------------------------------------------
  if (!fs.existsSync(modelFile)) {
    console.log(`skip 模型推理（找不到 ${path.relative(root, modelFile)}，先跑 pnpm assets）`)
  } else {
    const ort = await import('onnxruntime-web/wasm')
    const dist = path.join(root, 'node_modules/onnxruntime-web/dist')
    ort.env.wasm.numThreads = 1
    ort.env.wasm.wasmPaths = `${pathToFileURL(dist).href}/`

    const seconds = 4
    const audio = new Float32Array(seconds * BASIC_PITCH_RATE)
    const notes = [
      { pitch: 60, at: 0.2, until: 1.4 },
      { pitch: 64, at: 1.6, until: 3.4 },
      { pitch: 67, at: 1.6, until: 3.4 }
    ]
    for (const note of notes) {
      const frequency = 440 * 2 ** ((note.pitch - 69) / 12)
      const from = Math.round(note.at * BASIC_PITCH_RATE)
      const to = Math.round(note.until * BASIC_PITCH_RATE)
      for (let index = from; index < to; index += 1) {
        const seconds = (index - from) / BASIC_PITCH_RATE
        const envelope = Math.exp(-seconds * 3) * 0.18
        for (let harmonic = 1; harmonic <= 5; harmonic += 1) {
          audio[index] += envelope / harmonic * Math.sin(2 * Math.PI * frequency * harmonic * seconds)
        }
      }
    }

    const session = await ort.InferenceSession.create(fs.readFileSync(modelFile))
    const inputName = session.inputNames[0]
    const meta = session.outputMetadata
    const names = session.outputNames.filter((_name, index) => meta[index].shape[2] === 88)
    let noteName = ''
    let onsetName = ''

    const window = new BasicPitchWindow()
    const events = []
    for (let offset = 0; offset < audio.length; offset += 1024) {
      window.append(audio.subarray(offset, Math.min(offset + 1024, audio.length)))
      for (let next = window.next(); next !== null; next = window.next()) {
        const output = await session.run({
          [inputName]: new ort.Tensor('float32', next.samples, [1, BASIC_PITCH_WINDOW, 1])
        })
        if (noteName === '') {
          // 用这一窗自己判断哪一路是 onset：两路都是 [1,172,88]，只能靠稀疏度分。
          const sums = names.map((name) => {
            let sum = 0
            for (const value of output[name].data) sum += value
            return sum
          })
          const picked = pickNoteOnset(names, sums)
          noteName = picked.note
          onsetName = picked.onset
        }
        for (let frame = next.from; frame < BASIC_PITCH_FRAMES; frame += 1) {
          events.push({
            at: (next.start + frame * BASIC_PITCH_FRAME_SAMPLES) / BASIC_PITCH_RATE,
            rms: frameRms(next.samples, frame * BASIC_PITCH_FRAME_SAMPLES),
            pitches: activePitches(output[noteName].data, BASIC_PITCH_NOTE_THRESHOLD, frame * 88),
            onsets: activePitches(output[onsetName].data, 0.5, frame * 88)
          })
        }
      }
    }

    const onsetsAt = pitch => events.filter(event => event.onsets.includes(pitch)).map(event => event.at)
    const soundingAt = (pitch, from, to) => events
      .filter(event => event.at >= from && event.at <= to)
      .filter(event => event.pitches.includes(pitch)).length
    const c4 = onsetsAt(60)
    const e4 = onsetsAt(64)
    const g4 = onsetsAt(67)

    check('单音 C4 的起音被检出', c4.length > 0 && c4[0] > 0.1 && c4[0] < 0.6, `${c4.length} 帧，最早 ${c4[0]?.toFixed(2)}s`)
    check('C4 持续段一直被识别', soundingAt(60, 0.7, 1.3) > 40, `${soundingAt(60, 0.7, 1.3)} 帧`)
    check('和弦里的 E4 起音被检出', e4.length > 0 && e4[0] > 1.5 && e4[0] < 2.0, `${e4.length} 帧，最早 ${e4[0]?.toFixed(2)}s`)
    check('和弦里的 G4 起音被检出', g4.length > 0 && g4[0] > 1.5 && g4[0] < 2.0, `${g4.length} 帧，最早 ${g4[0]?.toFixed(2)}s`)
    check(
      '和弦两个音同时被识别',
      soundingAt(64, 2.0, 3.0) > 40 && soundingAt(67, 2.0, 3.0) > 40,
      `E4 ${soundingAt(64, 2.0, 3.0)} 帧 / G4 ${soundingAt(67, 2.0, 3.0)} 帧`
    )
    const loudest = Math.max(...events.map(event => event.rms))
    check('音量能区分有声和静音', loudest > 0.01 && events.filter(event => event.at > 0.1 && event.at < 0.15)[0]?.rms < 0.01, `峰值 ${loudest.toFixed(3)}`)
  }

  const failed = checks.filter(entry => !entry.ok)
  console.log(`checks ${checks.length - failed.length}/${checks.length}`)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`[failure] ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}
