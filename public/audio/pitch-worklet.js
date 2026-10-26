/**
 * 麦克风采集 worklet：把声音降到 Basic Pitch 要的 22050Hz，约 46ms 发一块给主线程。
 *
 * 这里只做采样率和分块，判断音高不在这里：模型推理在 `app/workers/pitch.worker.ts`。
 * 之所以放在 `public/` 而不是 `app/`，是因为 `audioWorklet.addModule()` 取的是 URL，
 * 不经过打包；重采样器用同目录的相对 import，Node 里的回归脚本能直接测。
 */

import { StreamResampler } from './resample.js'

const TARGET_RATE = 22_050
/** 每块约 46ms：比 Worker 的推理间隔（250ms）细得多，攒窗口的活交给 Worker。 */
const BLOCK = 1024

class PitchTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.resampler = new StreamResampler(sampleRate, TARGET_RATE)
    this.block = new Float32Array(BLOCK)
    this.filled = 0
    this.port.postMessage({ type: 'ready', inputRate: sampleRate, outputRate: TARGET_RATE })
  }

  flush() {
    // slice 出来是一块刚好够长的独立内存，可以零拷贝转给主线程。
    const samples = this.block.slice(0, this.filled)
    this.filled = 0
    this.port.postMessage({ type: 'pcm', samples }, [samples.buffer])
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel === undefined || channel.length === 0) return true
    const output = this.resampler.process(channel)
    for (let offset = 0; offset < output.length; offset += 1) {
      this.block[this.filled] = output[offset]
      this.filled += 1
      if (this.filled === BLOCK) this.flush()
    }
    return true
  }
}

registerProcessor('pitch-tap', PitchTap)
