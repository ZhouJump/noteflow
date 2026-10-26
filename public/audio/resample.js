/**
 * 流式重采样：把 AudioContext 的采样率（通常是 48000）降到 Basic Pitch 要的 22050。
 *
 * 用 Kaiser 窗 sinc 核做带限插值，对任意输入/输出比都成立。状态（读指针和还没被
 * 消费的输入）留在实例里，所以可以一块一块地调 `process()`，拼起来的结果和一次
 * 处理整段一样；Node 里的回归脚本（scripts/check-resample.mjs）靠这一点验证。
 *
 * 放在 public/ 而不是 app/ 是因为 AudioWorklet 用 URL 加载脚本、不经过打包，
 * 同目录的相对 import 在 worklet 和 Node 里都能直接跑。
 */

/** 核的单边长度（输入采样数）：越长过渡带越窄，32 个抽头的量已经够干净。 */
const HALF = 16
/** 每两个输入采样之间存多少份核表，线性插值用。 */
const OVER = 128
/** Kaiser 窗的形状参数：旁瓣压得够低，11kHz 以上的内容不会折回音符频段。 */
const BETA = 8

/** 零阶第一类修正贝塞尔函数，Kaiser 窗用。 */
function bessel0(x) {
  let sum = 1
  let term = 1
  const half = x / 2
  for (let order = 1; order < 32; order += 1) {
    term *= (half / order) * (half / order)
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

export class StreamResampler {
  constructor(inputRate, outputRate) {
    this.step = inputRate / outputRate
    this.buffer = new Float32Array(4096)
    this.length = 0
    this.position = 0
    if (inputRate === outputRate) return

    // 截止频率取输出侧的奈奎斯特频率，用「每输入采样的周期数」表示。
    const cutoff = 0.5 * Math.min(1, outputRate / inputRate)
    const table = new Float32Array(HALF * OVER + 1)
    const norm = bessel0(BETA)
    for (let index = 0; index < table.length; index += 1) {
      const distance = index / OVER
      // sinc 用归一化定义 sin(πx)/(πx)，低通核要的是 sinc(2·fc·t)。
      const x = 2 * cutoff * distance
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window = bessel0(BETA * Math.sqrt(Math.max(0, 1 - (distance / HALF) ** 2))) / norm
      table[index] = 2 * cutoff * sinc * window
    }
    this.table = table
  }

  /** 喂一块输入，返回这次能算出来的输出采样；可能比输入短得多，也可能为空。 */
  process(block) {
    this.append(block)
    if (this.table === undefined) {
      // 采样率相同：直接透传，读指针用不上。
      const same = this.buffer.slice(0, this.length)
      this.position = 0
      this.length = 0
      return same
    }

    const room = Math.ceil(block.length / this.step) + 2
    const output = new Float32Array(room)
    let count = 0
    while (this.position + HALF <= this.length && count < room) {
      output[count] = this.sample(this.position)
      count += 1
      this.position += this.step
    }
    this.compact()
    return count === 0 ? new Float32Array(0) : output.subarray(0, count)
  }

  append(block) {
    const need = this.length + block.length
    if (need > this.buffer.length) {
      const grown = new Float32Array(Math.max(need, this.buffer.length * 2))
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(block, this.length)
    this.length = need
  }

  /** 丢掉落在外面的输入，避免长会话里缓冲区一直变大。 */
  compact() {
    const drop = Math.floor(this.position) - HALF + 1
    if (drop <= 0) return
    this.buffer.copyWithin(0, drop, this.length)
    this.length -= drop
    this.position -= drop
  }

  /** 在浮点位置 `position` 上做卷积。 */
  sample(position) {
    const from = Math.floor(position) - HALF + 1
    let sum = 0
    for (let index = Math.max(0, from); index < from + 2 * HALF && index < this.length; index += 1) {
      const distance = Math.abs(index - position)
      if (distance >= HALF) continue
      const x = distance * OVER
      const cell = x | 0
      const frac = x - cell
      const low = this.table[cell] ?? 0
      const high = this.table[cell + 1] ?? low
      sum += this.buffer[index] * (low + (high - low) * frac)
    }
    return sum
  }
}
