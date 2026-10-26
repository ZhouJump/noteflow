/**
 * 练习模式的音高识别 Worker：22050Hz 音频块进来，逐帧的活跃音高和起音出去。
 *
 * 怎么切窗口、哪些帧还没发过都交给 `BasicPitchWindow`；这里只负责跑模型和拼时间戳。
 * 时间戳按音频采样位置换算回主线程的 `performance.now()`：跟踪器的超时提示、双手
 * 时间窗全靠这一列时间，不能拿 Worker 自己的时钟去凑。
 */

import type * as ort from 'onnxruntime-web/wasm'

import {
  BASIC_PITCH_BINS,
  BASIC_PITCH_FRAME_SAMPLES,
  BASIC_PITCH_FRAMES,
  BASIC_PITCH_NOTE_THRESHOLD,
  BASIC_PITCH_ONSET_THRESHOLD,
  BASIC_PITCH_RATE,
  BASIC_PITCH_WINDOW,
  BasicPitchWindow,
  activePitches,
  frameRms,
  pickNoteOnset,
  type BasicPitchEvent,
  type PitchRun
} from '../lib/audio/basicPitch'
import { loadOrt, type OrtModule } from '../lib/homr/ortRuntime'

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const ctx = self as unknown as WorkerScope

const MODEL_URL = '/models/nmp.onnx'
/** 推理跟不上时最多放宽到 1s 一次：宁可出结果慢一点，也不要把音频堆在内存里。 */
const MAX_STRIDE = BASIC_PITCH_RATE

const capture = new BasicPitchWindow()

let runtime: OrtModule | null = null
let session: ort.InferenceSession | null = null
/** 哪一路输出是 note、哪一路是 onset，由 `decideLayout()` 探测后固定。 */
let noteName = ''
let onsetName = ''
/** 采样 0 对应的主线程时间。 */
let baseAt = 0
let starting = false
let ready = false
let broken = false
let busy = false

/** 88 bin 的两路输出名（note 和 onset）；contour 是 [*, 172, 264]，用不着。 */
function binOutputs(): string[] {
  if (session === null) return []
  const meta = (session as unknown as { outputMetadata?: { shape?: readonly number[] }[] }).outputMetadata
  if (meta === undefined) return session.outputNames.slice(0, 2)
  return session.outputNames.filter((_name, index) => {
    const shape = meta[index]?.shape ?? []
    return shape[shape.length - 1] === BASIC_PITCH_BINS
  })
}

async function predict(samples: Float32Array): Promise<Record<string, ort.Tensor>> {
  if (runtime === null || session === null) throw new Error('模型还没准备好')
  return session.run({
    [session.inputNames[0]]: new runtime.Tensor('float32', samples, [1, BASIC_PITCH_WINDOW, 1])
  })
}

/**
 * 用一段合成音确认两路输出里哪一路是 onset：音头只在起音那一帧有值，比持续
 * 发声的 note 稀疏得多。导出图里的输出名字（`StatefulPartitionedCall:N`）不保证
 * 跨版本不变，所以不写死；顺带把模型预热一次。
 */
async function decideLayout(): Promise<void> {
  const names = binOutputs()
  if (names.length !== 2) throw new Error(`模型输出了 ${names.length} 路音高，只认两路`)
  const probe = new Float32Array(BASIC_PITCH_WINDOW)
  const attack = Math.floor(BASIC_PITCH_WINDOW / 2)
  for (let index = attack; index < BASIC_PITCH_WINDOW; index += 1) {
    const seconds = (index - attack) / BASIC_PITCH_RATE
    probe[index] = Math.sin(2 * Math.PI * 440 * seconds) * Math.exp(-seconds * 4) * 0.5
  }
  const output = await predict(probe)
  const sums = names.map((name) => {
    const data = output[name]?.data as Float32Array | undefined
    if (data === undefined) return 0
    let sum = 0
    for (let index = 0; index < data.length; index += 1) sum += data[index]
    return sum
  })
  const picked = pickNoteOnset(names, sums)
  noteName = picked.note
  onsetName = picked.onset
}

async function startup(): Promise<void> {
  if (starting || ready) return
  starting = true
  try {
    runtime = await loadOrt()
    const response = await fetch(MODEL_URL)
    if (!response.ok) throw new Error(`${MODEL_URL}: HTTP ${response.status}`)
    session = await runtime.InferenceSession.create(new Uint8Array(await response.arrayBuffer()), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    })
    await decideLayout()
    ready = true
    ctx.postMessage({ type: 'ready' })
    void pump()
  } catch (error) {
    broken = true
    ctx.postMessage({ type: 'unavailable', message: (error as Error).message })
  } finally {
    starting = false
  }
}

/** 跑一窗，把新增帧换算成主线程时间发出去。 */
async function infer(next: PitchRun): Promise<void> {
  const began = performance.now()
  const output = await predict(next.samples)
  const note = output[noteName]?.data as Float32Array | undefined
  const onset = output[onsetName]?.data as Float32Array | undefined
  if (note === undefined || onset === undefined) throw new Error('模型输出里没有 note/onset')

  const events: BasicPitchEvent[] = []
  for (let frame = next.from; frame < BASIC_PITCH_FRAMES; frame += 1) {
    const offset = frame * BASIC_PITCH_FRAME_SAMPLES
    events.push({
      at: baseAt + (next.start + offset) / BASIC_PITCH_RATE * 1000,
      rms: frameRms(next.samples, offset),
      pitches: activePitches(note, BASIC_PITCH_NOTE_THRESHOLD, frame * BASIC_PITCH_BINS),
      onsets: activePitches(onset, BASIC_PITCH_ONSET_THRESHOLD, frame * BASIC_PITCH_BINS)
    })
  }
  if (events.length > 0) ctx.postMessage({ type: 'frames', frames: events })

  // 单次推理比间隔还慢时放宽间隔，否则积压只会越来越长。
  if (performance.now() - began > capture.hop / BASIC_PITCH_RATE * 1000 * 0.7) {
    capture.slow(Math.min(MAX_STRIDE, Math.round(capture.hop * 1.6)))
  }
}

/** 有新音频就跑；同时只允许一个推理在跑。 */
async function pump(): Promise<void> {
  if (busy || !ready || broken) return
  busy = true
  try {
    for (let next = capture.next(); next !== null; next = capture.next()) await infer(next)
  } catch (error) {
    broken = true
    ctx.postMessage({ type: 'error', message: (error as Error).message })
  } finally {
    busy = false
  }
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as
    | { type: 'start', baseAt: number }
    | { type: 'audio', samples: Float32Array }
  if (data.type === 'start') {
    baseAt = data.baseAt
    void startup()
    return
  }
  if (data.type === 'audio') {
    capture.append(data.samples)
    void pump()
  }
})
