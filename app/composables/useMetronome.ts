/**
 * 节拍器：用 Web Audio 的音频时钟提前排拍，避免 `setInterval` 抖动。
 *
 * 每 25ms 检查一次，把未来 120ms 内的拍点交给振荡器；界面上的拍点指示由
 * `setTimeout` 按同一时间轴更新，只用于显示。BPM 和拍号每拍重新读取，练习中
 * 调整速度或节奏型会从下一拍生效。
 */

import { clampBpm } from '~/lib/db/settings'

const LOOKAHEAD_MS = 25
const SCHEDULE_AHEAD_SECONDS = 0.12

export function useMetronome(bpm: () => number, beats: () => number) {
  const running = ref(false)
  /** 当前拍（0 基），用于 UI 上的拍点指示。 */
  const beat = ref(0)

  let context: AudioContext | null = null
  let timer: number | null = null
  let nextNoteTime = 0
  let nextBeat = 0

  function clickAt(time: number, accent: boolean): void {
    const audio = context
    if (audio === null) return
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = accent ? 1320 : 880
    // 极短的包络：重拍更响，弱拍刚好能听清，不盖住演奏声。
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.28, time + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.07)
    oscillator.connect(gain)
    gain.connect(audio.destination)
    oscillator.start(time)
    oscillator.stop(time + 0.09)
  }

  /** 每小节第一拍重音；目前只提供单拍子（4/4、3/4、2/4）。 */
  function schedule(): void {
    const audio = context
    if (audio === null || !running.value) return
    while (nextNoteTime < audio.currentTime + SCHEDULE_AHEAD_SECONDS) {
      const count = Math.max(1, Math.round(beats()))
      const index = nextBeat % count
      clickAt(nextNoteTime, index === 0)
      const delay = Math.max(0, (nextNoteTime - audio.currentTime) * 1000)
      window.setTimeout(() => {
        if (running.value) beat.value = index
      }, delay)
      nextNoteTime += 60 / clampBpm(bpm())
      nextBeat = (index + 1) % count
    }
  }

  async function start(): Promise<void> {
    if (running.value) return
    const audio = context ?? new AudioContext({ latencyHint: 'interactive' })
    context = audio
    await audio.resume()
    running.value = true
    beat.value = 0
    nextBeat = 0
    nextNoteTime = audio.currentTime + 0.08
    schedule()
    timer = window.setInterval(schedule, LOOKAHEAD_MS)
  }

  function stop(): void {
    running.value = false
    beat.value = 0
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function toggle(): void {
    if (running.value) stop()
    else void start()
  }

  if (import.meta.client) {
    onBeforeUnmount(() => {
      stop()
      const audio = context
      context = null
      if (audio !== null) void audio.close().catch(() => {})
    })
  }

  return { running, beat, start, stop, toggle }
}
