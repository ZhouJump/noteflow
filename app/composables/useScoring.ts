/**
 * 评分模式的麦克风循环：与 `usePractice` 一样使用 Pitchy 取帧，但把帧交给
 * `ScoreTracker` 按 BPM 时间线判定。首个音落下前一直等待，之后按时间线推进。
 *
 * 暂停时保留麦克风但停止取帧；继续时回到等待状态，等下一个未判音落下后重新
 * 建立时间原点。切到后台或离开页面会直接取消本次评分，不留下半份成绩。
 */

import { describeMicrophoneError } from '~/lib/audio/microphone'
import { buildPracticeTargets } from '~/lib/audio/practice'
import { filterTargetsByHand, type HandMode } from '~/lib/audio/score'
import {
  ScoreTracker,
  buildScoreNotes,
  type ScoreSnapshot,
  type ScoreSummary,
  type ScoringPhase
} from '~/lib/audio/scoring'
import type { MusicXmlNote } from '~/lib/musicxml/document'

/** 每 30ms 一帧；两帧稳定音高约 60ms 确认起音。 */
const FRAME_MS = 30

function emptySnapshot(phase: ScoringPhase, total: number, message: string | null): ScoreSnapshot {
  return {
    phase,
    total,
    judged: 0,
    current: null,
    last: null,
    accuracy: 0,
    perfect: 0,
    good: 0,
    missed: 0,
    wrong: 0,
    heard: null,
    error: message
  }
}

export function useScoring(
  notes: () => MusicXmlNote[],
  options: { handMode?: () => HandMode, bpm?: () => number } = {}
) {
  const phase = ref<ScoringPhase>('idle')
  const error = ref<string | null>(null)
  const snapshot = shallowRef<ScoreSnapshot | null>(null)
  const summary = shallowRef<ScoreSummary | null>(null)

  const active = computed(() => phase.value !== 'idle')
  const waiting = computed(() => phase.value === 'waiting')
  const running = computed(() => phase.value === 'running')
  const paused = computed(() => phase.value === 'paused')

  let tracker: ScoreTracker | null = null
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let timer: number | null = null
  let tickFn: (() => void) | null = null
  let runningLoop = false
  let generation = 0
  let lastKey = ''

  function release(): void {
    runningLoop = false
    tickFn = null
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

  function publish(state: ScoreSnapshot): void {
    const key = [
      state.phase,
      state.judged,
      state.accuracy,
      state.last?.note.index ?? '',
      state.current?.index ?? '',
      state.heard ?? ''
    ].join('|')
    if (key === lastKey) return
    lastKey = key
    snapshot.value = state
    phase.value = state.phase
  }

  function fail(message: string, total = 0): void {
    release()
    tracker = null
    error.value = message
    phase.value = 'error'
    lastKey = ''
    snapshot.value = emptySnapshot('error', total, message)
  }

  /** 打开麦克风并开始取帧；token 丢弃已经被停止或替换的会话。 */
  async function listen(token: number): Promise<void> {
    const media = navigator.mediaDevices
    if (media === undefined) {
      throw new Error('这个页面用不了麦克风。请安装成应用后打开，或换一个浏览器试试。')
    }

    const audioContext = new AudioContext({ latencyHint: 'interactive' })
    context = audioContext
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
    runningLoop = true
    const tick = (): void => {
      if (!runningLoop || tracker === null || token !== generation) return
      analyser.getFloatTimeDomainData(frame)
      const at = performance.now()
      let energy = 0
      for (let index = 0; index < frame.length; index += 1) {
        energy += frame[index] * frame[index]
      }
      const rms = Math.sqrt(energy / frame.length)
      const [frequency, clarity] = detector.findPitch(frame, audioContext.sampleRate)
      const state = tracker.push({
        frequency: frequency > 0 ? frequency : null,
        clarity,
        rms,
        at
      })
      publish(state)
      if (state.phase === 'finished') {
        summary.value = tracker.summary()
        release()
        return
      }
      // 扣掉分析本身的耗时，稳定地按 FRAME_MS 取帧，不让延迟越积越多。
      timer = window.setTimeout(tick, Math.max(0, FRAME_MS - (performance.now() - at)))
    }
    tickFn = tick
    tick()
  }

  async function start(): Promise<void> {
    if (phase.value === 'waiting' || phase.value === 'running' || phase.value === 'paused') return
    const token = ++generation
    error.value = null
    summary.value = null
    const targets = filterTargetsByHand(buildPracticeTargets(notes()), options.handMode?.() ?? 'both')
    const scoreNotes = buildScoreNotes(targets)
    if (scoreNotes.length === 0) {
      fail('这份曲谱没有可评分的音符。')
      return
    }

    tracker = new ScoreTracker(scoreNotes, { bpm: options.bpm?.() ?? 80 })
    lastKey = ''
    snapshot.value = tracker.start()
    phase.value = 'waiting'
    try {
      await listen(token)
      if (token !== generation) return
    } catch (exception) {
      if (token !== generation) return
      fail(describeMicrophoneError(exception), scoreNotes.length)
    }
  }

  /** 暂停取帧但保留麦克风；继续时回到等待下一个待判音。 */
  function pause(): void {
    if ((phase.value !== 'waiting' && phase.value !== 'running') || tracker === null) return
    runningLoop = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    publish(tracker.pause(performance.now()))
  }

  function resume(): void {
    if (phase.value !== 'paused' || tracker === null || context === null || tickFn === null) return
    publish(tracker.resume(performance.now()))
    void context.resume().catch(() => {})
    runningLoop = true
    tickFn()
  }

  /** 主动结束：开始过就保存成绩；还在等首音则当作取消。 */
  function stop(): void {
    if (phase.value === 'idle') return
    const at = performance.now()
    const result = tracker?.stop(at) ?? null
    if (result === null) {
      reset()
      return
    }
    summary.value = result
    const state = tracker?.state() ?? null
    generation += 1
    release()
    if (state !== null) {
      lastKey = ''
      publish({ ...state, phase: 'finished', error: null })
    } else {
      phase.value = 'finished'
    }
    tracker = null
  }

  /** 清空本次评分状态（关闭成绩对话框、取消等待中的评分）。 */
  function reset(): void {
    generation += 1
    release()
    tracker = null
    phase.value = 'idle'
    error.value = null
    snapshot.value = null
    summary.value = null
    lastKey = ''
  }

  async function restart(): Promise<void> {
    reset()
    await start()
  }

  if (import.meta.client) {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') reset()
    }
    document.addEventListener('visibilitychange', onVisibility)
    onBeforeUnmount(() => {
      document.removeEventListener('visibilitychange', onVisibility)
      reset()
    })
  }

  return {
    phase,
    error,
    snapshot,
    summary,
    active,
    waiting,
    running,
    paused,
    start,
    stop,
    pause,
    resume,
    restart,
    reset
  }
}
