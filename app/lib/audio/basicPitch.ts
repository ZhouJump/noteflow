/**
 * Basic Pitch 的输入输出规格与逐帧后处理。
 *
 * 模型固定吃约 1.99s 的 22050Hz 波形（内部的 CQT 也在模型里），吐出 172 帧 × 88
 * 个音高 bin 的三路结果：note（这个音在响）、onset（这个音刚起）和 contour（音高
 * 弯曲，练习模式用不到）。88 个 bin 对应 MIDI 21..108，一帧 256 个采样 ≈ 11.6ms。
 *
 * 阈值是拿钢琴、提琴两组真实录音跑端到端选出来的（见 `.cache/eval-basicpitch.mjs`）：
 * note 取 0.2 时九成的音能被稳定检出；onset 取 0.5 才能把「延音一直挂着」和「真的
 * 又弹了一次」区分开，取低了钢琴踏板会让光标提前跑。
 */

/** 模型要求的采样率与波形长度。 */
export const BASIC_PITCH_RATE = 22_050
export const BASIC_PITCH_WINDOW = 43_844
/** 输出的帧数与每帧覆盖的采样数。 */
export const BASIC_PITCH_FRAMES = 172
export const BASIC_PITCH_FRAME_SAMPLES = 256
/** 88 个音高 bin 里第一个对应的 MIDI 音高。 */
export const BASIC_PITCH_MIN_MIDI = 21
export const BASIC_PITCH_BINS = 88

export const BASIC_PITCH_FRAME_SECONDS = BASIC_PITCH_FRAME_SAMPLES / BASIC_PITCH_RATE

export const BASIC_PITCH_NOTE_THRESHOLD = 0.2
export const BASIC_PITCH_ONSET_THRESHOLD = 0.5
/**
 * 推理间隔。窗口固定 1.99s，间隔决定的是「多久看一次新音」而不是等待时间：
 * 250ms 时起音不会被跨过去，单次推理约 60ms，占不满一个核。
 */
export const BASIC_PITCH_HOP_SECONDS = 0.25

/** 一帧的识别结果，字段与 `PitchFrame` 里复音的部分一一对应。 */
export interface BasicPitchEvent {
  /** 这一帧对应音频的起始时刻，主线程 `performance.now()` 的毫秒。 */
  at: number
  /** 这一帧附近的时域音量，供跟踪器的音量门槛。 */
  rms: number
  pitches: number[]
  onsets: number[]
}

/**
 * 两个 88 bin 输出里，onset 只在音头有值，明显比 note 稀疏。
 * 导出图里输出名字（`StatefulPartitionedCall:N`）不保证跨版本不变，所以按占比判断；
 * 两者一样大说明这段音频没有音头，按输出顺序取前面的那个。
 */
export function pickNoteOnset(
  names: readonly string[],
  sums: readonly number[]
): { note: string, onset: string } {
  const onset = (sums[0] ?? 0) <= (sums[1] ?? 0) ? 0 : 1
  return { note: names[1 - onset] ?? names[0] ?? '', onset: names[onset] ?? names[0] ?? '' }
}

/** 一帧里超过阈值的音高（MIDI）。 */
export function activePitches(data: Float32Array, threshold: number, from = 0): number[] {
  const pitches: number[] = []
  for (let bin = 0; bin < BASIC_PITCH_BINS; bin += 1) {
    if (data[from + bin] >= threshold) pitches.push(BASIC_PITCH_MIN_MIDI + bin)
  }
  return pitches
}

/** 从某一帧起 8 帧（约 93ms）的 RMS；越界部分按实际长度平均。 */
export function frameRms(samples: Float32Array, from: number, length = BASIC_PITCH_FRAME_SAMPLES * 8): number {
  const start = Math.max(0, from)
  const end = Math.min(samples.length, from + length)
  if (end <= start) return 0
  let energy = 0
  for (let index = start; index < end; index += 1) energy += samples[index] * samples[index]
  return Math.sqrt(energy / (end - start))
}

/** 一次推理要用的整窗音频，以及这一窗里还没发出去的帧区间。 */
export interface PitchRun {
  /** 整窗波形的副本：推理是异步的，攒新音频时下一块会盖掉环形缓冲。 */
  samples: Float32Array
  /** 窗口第一个采样在整条流里的绝对位置。 */
  start: number
  /** 这一窗里第一个需要输出的帧，之后的帧号一直属于新增段。 */
  from: number
}

/**
 * 把连续进来的音频块裁成「整窗 + 新增的帧」。
 *
 * 模型窗口固定 1.99s，但相邻两次推理重叠 1.99s-hop，每窗只有尾部 hop 那段是新的。
 * 位置全部用整条流的绝对采样数记，所以 hop 中途变了也不会重复发或者漏发。
 * 抽出来单独放在这里，是为了在 Node 里不靠麦克风也能回归（scripts/check-pitch.mjs）。
 */
export class BasicPitchWindow {
  private readonly ring = new Float32Array(BASIC_PITCH_WINDOW)
  private filled = 0
  /** 累计收进来的采样数。 */
  private stream = 0
  /** 已经发出去的帧覆盖到的绝对位置。 */
  private emitted = 0
  /** 上一次推理看完了多少采样。 */
  private consumed = 0
  private stride: number

  constructor(stride = Math.round(BASIC_PITCH_HOP_SECONDS * BASIC_PITCH_RATE)) {
    this.stride = stride
  }

  /** 当前推理间隔（采样数）。 */
  get hop(): number {
    return this.stride
  }

  /** 放宽推理间隔；推理跟不上时用，只会越放越宽。 */
  slow(min: number): void {
    this.stride = Math.max(this.stride, Math.min(min, BASIC_PITCH_WINDOW))
  }

  /** 接一块音频；超出窗口长度的从头部丢掉。 */
  append(block: Float32Array): void {
    if (block.length >= BASIC_PITCH_WINDOW) {
      this.ring.set(block.subarray(block.length - BASIC_PITCH_WINDOW))
      this.filled = BASIC_PITCH_WINDOW
    } else {
      const overflow = this.filled + block.length - BASIC_PITCH_WINDOW
      if (overflow > 0) {
        this.ring.copyWithin(0, overflow, this.filled)
        this.filled -= overflow
      }
      this.ring.set(block, this.filled)
      this.filled += block.length
    }
    this.stream += block.length
  }

  /** 够一整窗并且隔够 hop 就返回这一窗，否则 null。 */
  next(): PitchRun | null {
    if (this.filled < BASIC_PITCH_WINDOW || this.stream - this.consumed < this.stride) return null
    const start = this.stream - this.filled
    const from = Math.max(0, Math.floor((this.emitted - start) / BASIC_PITCH_FRAME_SAMPLES))
    if (from < BASIC_PITCH_FRAMES) {
      this.emitted = start + BASIC_PITCH_FRAMES * BASIC_PITCH_FRAME_SAMPLES
    }
    this.consumed = this.stream
    return { samples: this.ring.slice(), start, from }
  }
}
