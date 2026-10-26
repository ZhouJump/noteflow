/**
 * 重采样回归：练习模式的音频链要把 48000Hz 压到 Basic Pitch 要的 22050Hz，
 * 这一步出错只能靠听，所以用合成信号在 Node 里验一遍。
 *
 *   node scripts/check-resample.mjs
 *
 * 覆盖：输出长度比、频率不变、通带幅度、直流增益、高频混叠抑制，以及
 * 「分块喂」和「一次喂」结果一致（worklet 每 128 个采样调一次，必须无接缝）。
 */

import { StreamResampler } from '../public/audio/resample.js'

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `（${detail}）` : ''}`)
  return ok
}

const INPUT_RATE = 48_000
const OUTPUT_RATE = 22_050

function tone(frequency, seconds, rate = INPUT_RATE, amplitude = 0.5) {
  const samples = new Float32Array(Math.round(seconds * rate))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin(2 * Math.PI * frequency * index / rate)
  }
  return samples
}

function resample(samples, rate = INPUT_RATE) {
  return new StreamResampler(rate, OUTPUT_RATE).process(samples)
}

/** 过零率估频：纯净正弦足够准，且不需要 FFT。 */
function frequencyOf(samples, rate = OUTPUT_RATE) {
  let crossings = 0
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index - 1] < 0) !== (samples[index] < 0)) crossings += 1
  }
  return crossings / 2 / (samples.length / rate)
}

function rms(samples) {
  let energy = 0
  for (const value of samples) energy += value * value
  return Math.sqrt(energy / samples.length)
}

function peak(samples, from = 0) {
  let best = 0
  for (let index = from; index < samples.length; index += 1) best = Math.max(best, Math.abs(samples[index]))
  return best
}

try {
  const sine = tone(440, 1)
  const out = resample(sine)
  check(
    '1 秒 48000Hz 变成约 22050 个采样',
    Math.abs(out.length - 22_050) < 400,
    `${out.length}`
  )

  // 开头几十个采样落在卷积核的边缘，跳过再量幅度。
  const steady = out.subarray(400)
  const frequency = frequencyOf(steady)
  check('440Hz 过零率不变', Math.abs(frequency - 440) < 4, `${frequency.toFixed(1)}Hz`)
  check('通带幅度基本不变', Math.abs(peak(steady) - 0.5) < 0.03, `${peak(steady).toFixed(3)} / 0.5`)

  const dc = new Float32Array(24_000).fill(0.4)
  const dcOut = resample(dc).subarray(400)
  check('直流增益为 1', Math.abs(dcOut[0] - 0.4) < 0.005, `${dcOut[0]?.toFixed(4)}`)

  const low = resample(tone(110, 1)).subarray(400)
  check('110Hz 低音保留', Math.abs(frequencyOf(low) - 110) < 2 && peak(low) > 0.45, `${frequencyOf(low).toFixed(1)}Hz`)

  // 11kHz 以上的内容折回音符频段会变成假音高，必须压下去。
  const high = resample(tone(15_000, 1)).subarray(400)
  const leak = peak(high) / 0.5
  check('15kHz 混叠被抑制', leak < 0.01, `${(20 * Math.log10(leak + 1e-9)).toFixed(1)}dB`)

  // worklet 里每 128 个采样调一次，拼起来必须和整段一次算完全一致。
  const oneShot = resample(sine)
  const streamed = []
  const streaming = new StreamResampler(INPUT_RATE, OUTPUT_RATE)
  for (let offset = 0; offset < sine.length; offset += 128) {
    const part = streaming.process(sine.subarray(offset, Math.min(offset + 128, sine.length)))
    for (const value of part) streamed.push(value)
  }
  const length = Math.min(oneShot.length, streamed.length)
  let worst = 0
  let worstAt = 0
  for (let index = 0; index < length; index += 1) {
    const delta = Math.abs(oneShot[index] - streamed[index])
    if (delta > worst) {
      worst = delta
      worstAt = index
    }
  }
  check(
    '分块与整段结果一致',
    // 读指针在整段模式下累加到两万多、分块模式下每块都回绕，末几位小数会差一点；
    // 丢采样或错位会让差值跳到 0.0x，这里的上限只卡结构性错误。
    Math.abs(oneShot.length - streamed.length) <= 2 && worst < 1e-4,
    `${length} 点，最大差 ${worst.toExponential(1)}@${worstAt}`
  )
  check('分块输出不是空的', rms(streamed) > 0.3, `rms=${rms(streamed).toFixed(3)}`)

  const failed = checks.filter(entry => !entry.ok)
  console.log(`checks ${checks.length - failed.length}/${checks.length}`)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`[failure] ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}
