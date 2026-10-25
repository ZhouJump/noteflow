/**
 * 麦克风 + 练习跟踪：把 Pitchy 的音高帧交给 `PracticeTracker`，并把状态交给界面。
 *
 * 只在浏览器里运行：AudioContext、媒体流和动态导入都发生在 `start()` 之后，
 * 所以 SSR 阶段可以安全地导入这个 composable。停止、完成、页面隐藏都会释放
 * 麦克风，避免后台一直录音。
 */

import {
  PracticeTracker,
  buildPracticeTargets,
  midiForFrequency,
  midiLabel,
  type PracticeTarget,
  type TrackerOutcome,
  type TrackerUpdate
} from '~/lib/audio/practice'
import type { MusicXmlNote } from '~/lib/musicxml/document'

export type PracticePhase = 'idle' | 'starting' | 'listening' | 'done' | 'error'

export interface PracticeSnapshot {
  phase: PracticePhase
  /** 0 基：下一个要弹的目标；完成时等于 total。 */
  position: number
  total: number
  current: PracticeTarget | null
  matched: number
  skipped: number
  octaveMatches: number
  outcome: TrackerOutcome
  stale: boolean
  /** 最近听到的音名，只用于提示。 */
  heard: string | null
  error: string | null
}

/** 每 60ms 取一帧，和跟踪器的稳定帧数配合，约 240ms 确认一个音。 */
const FRAME_MS = 60

function describeMicrophoneError(exception: unknown): string {
  if (!(exception instanceof Error)) return '无法打开麦克风。'
  if (exception.name === 'NotAllowedError' || exception.name === 'SecurityError') {
    return '麦克风权限被拒绝。请在浏览器设置里允许后重试。'
  }
  if (exception.name === 'NotFoundError' || exception.name === 'OverconstrainedError') {
    return '没有找到可用的麦克风。'
  }
  if (exception.name === 'NotReadableError' || exception.name === 'AbortError') {
    return '麦克风被其他应用占用，关闭后重试。'
  }
  return `无法打开麦克风：${exception.message}`
}

export function usePractice(notes: () => MusicXmlNote[]) {
  const phase = ref<PracticePhase>('idle')
  const error = ref<string | null>(null)
  const snapshot = shallowRef<PracticeSnapshot | null>(null)

  const active = computed(() => phase.value !== 'idle')
  const starting = computed(() => phase.value === 'starting')

  let tracker: PracticeTracker | null = null
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let timer: number | null = null
  let running = false
  let generation = 0
  let lastKey = ''

  function release(): void {
    running = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    const current = context
    context = null
    if (current !== null) void current.close().catch(() => {})
  }

  /** 只在可见状态变化时更新响应式快照，避免每 60ms 触发一次渲染。 */
  function publish(update: TrackerUpdate, heard: string | null): void {
    const nextPhase: PracticePhase = update.done ? 'done' : 'listening'
    const nextHeard = heard ?? snapshot.value?.heard ?? null
    const key = [nextPhase, update.position, update.outcome, update.stale, nextHeard].join('|')
    if (key === lastKey) {
      if (update.done) release()
      return
    }
    lastKey = key
    phase.value = nextPhase
    snapshot.value = {
      phase: nextPhase,
      position: update.position,
      total: update.total,
      current: update.current,
      matched: update.matched,
      skipped: update.skipped,
      octaveMatches: update.octaveMatches,
      outcome: update.outcome,
      stale: update.stale,
      heard: nextHeard,
      error: null
    }
    if (update.done) release()
  }

  /** 打开麦克风并开始取帧；token 用来丢弃已经被停止或替换的会话。 */
  async function listen(token: number): Promise<void> {
    const media = navigator.mediaDevices
    if (media === undefined) {
      throw new Error('当前浏览器不支持麦克风。请通过 HTTPS 或 localhost 打开。')
    }

    const audioContext = new AudioContext({ latencyHint: 'interactive' })
    context = audioContext
    // 必须在用户点击的同一个任务里恢复，iOS 才会真正出声/采集。
    await audioContext.resume()
    if (token !== generation) {
      void audioContext.close().catch(() => {})
      return
    }

    const audio = await media.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
    if (token !== generation) {
      for (const track of audio.getTracks()) track.stop()
      return
    }
    stream = audio

    const source = audioContext.createMediaStreamSource(audio)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)

    const { PitchDetector } = await import('pitchy')
    const detector = PitchDetector.forFloat32Array(analyser.fftSize)
    // 峰值挑选放宽，清晰度由跟踪器自己的阈值判断。
    detector.clarityThreshold = 0.5
    detector.minVolumeDecibels = -50

    const frame = new Float32Array(analyser.fftSize)
    running = true
    const tick = (): void => {
      if (!running || tracker === null || token !== generation) return
      analyser.getFloatTimeDomainData(frame)
      let energy = 0
      for (let index = 0; index < frame.length; index += 1) {
        energy += frame[index] * frame[index]
      }
      const rms = Math.sqrt(energy / frame.length)
      const [frequency, clarity] = detector.findPitch(frame, audioContext.sampleRate)
      const usable = frequency > 0 ? frequency : null
      const update = tracker.push({
        frequency: usable,
        clarity,
        rms,
        at: performance.now()
      })
      const heard = usable === null ? null : midiLabel(Math.round(midiForFrequency(usable)))
      publish(update, heard)
      if (update.done) return
      timer = window.setTimeout(tick, FRAME_MS)
    }
    tick()
  }

  async function start(): Promise<void> {
    if (phase.value === 'starting' || phase.value === 'listening' || phase.value === 'done') return
    const token = ++generation
    error.value = null
    const targets = buildPracticeTargets(notes())
    if (targets.length === 0) {
      phase.value = 'error'
      error.value = '这一页没有可跟弹的音符。'
      snapshot.value = {
        phase: 'error',
        position: 0,
        total: 0,
        current: null,
        matched: 0,
        skipped: 0,
        octaveMatches: 0,
        outcome: 'idle',
        stale: false,
        heard: null,
        error: error.value
      }
      lastKey = ''
      return
    }

    tracker = new PracticeTracker(targets)
    phase.value = 'starting'
    snapshot.value = {
      phase: 'starting',
      position: 0,
      total: targets.length,
      current: targets[0] ?? null,
      matched: 0,
      skipped: 0,
      octaveMatches: 0,
      outcome: 'idle',
      stale: false,
      heard: null,
      error: null
    }
    lastKey = ''

    try {
      await listen(token)
      if (token !== generation) return
    } catch (exception) {
      if (token !== generation) return
      release()
      tracker = null
      phase.value = 'error'
      error.value = describeMicrophoneError(exception)
      snapshot.value = {
        phase: 'error',
        position: 0,
        total: targets.length,
        current: targets[0] ?? null,
        matched: 0,
        skipped: 0,
        octaveMatches: 0,
        outcome: 'idle',
        stale: false,
        heard: null,
        error: error.value
      }
      lastKey = ''
    }
  }

  function stop(): void {
    generation += 1
    release()
    tracker = null
    phase.value = 'idle'
    error.value = null
    snapshot.value = null
    lastKey = ''
  }

  async function restart(): Promise<void> {
    stop()
    await start()
  }

  /** 从某个音符重新开始；只在正在听的时候有效。 */
  function seek(noteIndex: number): void {
    if (!running || tracker === null) return
    const update = tracker.seek(noteIndex)
    lastKey = ''
    publish(update, null)
  }

  if (import.meta.client) {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') stop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    onBeforeUnmount(() => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    })
  }

  return {
    phase,
    error,
    snapshot,
    active,
    starting,
    start,
    stop,
    restart,
    seek
  }
}
