/**
 * 麦克风 + 练习跟踪：把音高帧交给 `PracticeTracker`，并把状态交给界面。
 *
 * 识别优先走复音链路（AudioWorklet + Basic Pitch），和弦、双声部都能分开；模型
 * 或 ORT 一时拿不到时退回 Pitchy 单音检测，功能不中断，只是双音会被听成其中一个。
 *
 * 只在浏览器里运行：AudioContext、媒体流和动态导入都发生在 `start()` 之后，
 * 所以 SSR 阶段可以安全地导入这个 composable。停止、完成、页面隐藏都会释放
 * 麦克风，避免后台一直录音。
 */

import {
  PracticeTracker,
  buildPracticeTargets,
  type PracticeTarget,
  type TrackerOutcome,
  type TrackerUpdate
} from '~/lib/audio/practice'
import { describeMicrophoneError } from '~/lib/audio/microphone'
import { startLivePitch, type LivePitch } from '~/lib/audio/livePitch'
import { filterTargetsByHand, type HandMode } from '~/lib/audio/score'
import type { MusicXmlNote } from '~/lib/musicxml/document'

export type PracticePhase = 'idle' | 'starting' | 'listening' | 'paused' | 'done' | 'error'

/** 当前用的检测器：复音模型能分开和弦，退回单音时只能听出一个音。 */
export type PracticeEngine = 'idle' | 'polyphonic' | 'single'

export interface PracticeSnapshot {
  phase: PracticePhase
  /** 0 基：下一个要演奏的目标；完成时等于 total。 */
  position: number
  total: number
  current: PracticeTarget | null
  matched: number
  octaveMatches: number
  outcome: TrackerOutcome
  stale: boolean
  engine: PracticeEngine
  error: string | null
}

/** 每 30ms 取一帧；两帧稳定音高约 60ms 确认，短音也能凑够确认帧数。 */
const FRAME_MS = 30

export function usePractice(
  notes: () => MusicXmlNote[],
  options: { handMode?: () => HandMode } = {}
) {
  const phase = ref<PracticePhase>('idle')
  const error = ref<string | null>(null)
  const engine = ref<PracticeEngine>('idle')
  const snapshot = shallowRef<PracticeSnapshot | null>(null)

  const active = computed(() => phase.value !== 'idle')
  const starting = computed(() => phase.value === 'starting')
  const paused = computed(() => phase.value === 'paused')

  let tracker: PracticeTracker | null = null
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  /** 复音检测引擎；为空说明这次用的是 Pitchy 单音检测。 */
  let live: LivePitch | null = null
  let timer: number | null = null
  let tickFn: (() => void) | null = null
  let running = false
  let generation = 0
  let lastKey = ''

  function release(): void {
    running = false
    tickFn = null
    live?.stop()
    live = null
    engine.value = 'idle'
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

  /** 只在可见状态变化时更新响应式快照，避免每 40ms 触发一次渲染。 */
  function publish(update: TrackerUpdate): void {
    const nextPhase: PracticePhase = update.done ? 'done' : 'listening'
    const key = [nextPhase, update.position, update.outcome, update.stale].join('|')
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
      octaveMatches: update.octaveMatches,
      outcome: update.outcome,
      stale: update.stale,
      engine: engine.value,
      error: null
    }
    if (update.done) release()
  }

  /** 打开麦克风并开始取帧；token 用来丢弃已经被停止或替换的会话。 */
  async function listen(token: number): Promise<void> {
    const media = navigator.mediaDevices
    if (media === undefined) {
      throw new Error('这个页面用不了麦克风。请安装成应用后打开，或换一个浏览器试试。')
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
        autoGainControl: false,
        // 立体声麦克风两路相位不同时会在 down-mix 里互相抵消，单声道更稳。
        channelCount: { ideal: 1 }
      }
    })
    if (token !== generation) {
      for (const track of audio.getTracks()) track.stop()
      return
    }
    stream = audio

    const source = audioContext.createMediaStreamSource(audio)

    // 复音链路优先：小提琴的双音、钢琴的和弦，单音检测根本无法分开。
    // 等待有上限（模型和 ORT 首次要下十几 MB），拿不到就当场退回单音检测。
    running = true
    engine.value = 'polyphonic'
    try {
      live = await startLivePitch(audioContext, source, (frames) => {
        if (!running || tracker === null || token !== generation) return
        // 一次推理会带回好几帧，逐帧推进；完成后的帧不再需要。
        for (const event of frames) {
          const update = tracker.push({
            frequency: null,
            clarity: 1,
            rms: event.rms,
            at: event.at,
            pitches: event.pitches,
            onsets: event.onsets
          })
          publish(update)
          if (update.done) return
        }
      })
      if (token !== generation) {
        release()
        return
      }
      return
    } catch (exception) {
      if (token !== generation) return
      // 分片 404、wasm 被拦这些细节只进控制台，界面上一句“用着就行”就够。
      console.warn('复音检测不可用，退回单音检测', exception)
      engine.value = 'single'
      running = false
    }

    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)

    const { PitchDetector } = await import('pitchy')
    const detector = PitchDetector.forFloat32Array(analyser.fftSize)
    // 峰值挑选和音量门槛都放宽：小提琴、手机麦克风的音量常常偏小，
    // 真正的判断交给跟踪器的清晰度和音量阈值。
    detector.clarityThreshold = 0.5
    detector.minVolumeDecibels = -60

    const frame = new Float32Array(analyser.fftSize)
    running = true
    const tick = (): void => {
      if (!running || tracker === null || token !== generation) return
      analyser.getFloatTimeDomainData(frame)
      const at = performance.now()
      let energy = 0
      for (let index = 0; index < frame.length; index += 1) {
        energy += frame[index] * frame[index]
      }
      const rms = Math.sqrt(energy / frame.length)
      const [frequency, clarity] = detector.findPitch(frame, audioContext.sampleRate)
      const update = tracker.push({
        frequency: frequency > 0 ? frequency : null,
        clarity,
        rms,
        at
      })
      publish(update)
      if (update.done) return
      // 扣掉分析本身的耗时，稳定地按 FRAME_MS 取帧，不让延迟越积越多。
      timer = window.setTimeout(tick, Math.max(0, FRAME_MS - (performance.now() - at)))
    }
    tickFn = tick
    tick()
  }

  async function start(): Promise<void> {
    if (
      phase.value === 'starting'
      || phase.value === 'listening'
      || phase.value === 'paused'
      || phase.value === 'done'
    ) return
    const token = ++generation
    error.value = null
    const targets = filterTargetsByHand(buildPracticeTargets(notes()), options.handMode?.() ?? 'both')
    if (targets.length === 0) {
      phase.value = 'error'
      error.value = '这份曲谱没有可跟随的音符。'
      snapshot.value = {
        phase: 'error',
        position: 0,
        total: 0,
        current: null,
        matched: 0,
        octaveMatches: 0,
        outcome: 'idle',
        stale: false,
        engine: 'idle',
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
      octaveMatches: 0,
      outcome: 'idle',
      stale: false,
      engine: 'idle',
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
        octaveMatches: 0,
        outcome: 'idle',
        stale: false,
        engine: 'idle',
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

  /** 暂停取帧但保留麦克风，恢复时不用重新申请权限。 */
  function pause(): void {
    if (phase.value !== 'listening') return
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    running = false
    live?.setPaused(true)
    tracker?.rearm()
    phase.value = 'paused'
    lastKey = ''
    if (snapshot.value !== null) {
      snapshot.value = {
        ...snapshot.value,
        phase: 'paused',
        outcome: 'idle',
        stale: false
      }
    }
  }

  function resume(): void {
    if (phase.value !== 'paused') return
    if (tracker === null || context === null) return
    if (tickFn === null && live === null) return
    tracker.rearm()
    phase.value = 'listening'
    lastKey = ''
    if (snapshot.value !== null) {
      snapshot.value = { ...snapshot.value, phase: 'listening' }
    }
    void context.resume().catch(() => {})
    running = true
    live?.setPaused(false)
    tickFn?.()
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
    publish(update)
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
    engine,
    snapshot,
    active,
    starting,
    paused,
    start,
    stop,
    pause,
    resume,
    restart,
    seek
  }
}
