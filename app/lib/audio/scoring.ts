/**
 * 评分模式：按 BPM 给每个音排好时间线，等第一个音落下后开始计时。
 *
 * 与跟随练习不同，评分不会停下来等待漏掉的音：过了容错窗口就记漏音，时间线
 * 继续向前。这样一首曲谱演奏完会得到完整的逐音结果。和声/双手按 `PracticeTarget`
 * 里已经分好的手拆成独立的评分音符，单声道音高检测每次只能确认一个音。
 *
 * 这里同样不碰 Web Audio 和 DOM，输入是 `PitchFrame`，因此可以在 Node 里用
 * 合成帧回归（scripts/check-scoring.mjs）。
 */

import {
  midiForFrequency,
  midiLabel,
  type PitchFrame,
  type PracticeTarget
} from './practice'

export type ScoringPhase = 'idle' | 'waiting' | 'running' | 'paused' | 'finished' | 'error'

export type ScoreOutcome = 'perfect' | 'good' | 'early' | 'late' | 'octave' | 'wrong' | 'missed'

/** 评分用的单个音；同一只手里的和弦算一个音。 */
export interface ScoreNote {
  /** 在整份曲谱里的音符序号，用于高亮与滚动。 */
  index: number
  /** 所属目标；同一拍点的两只手共享一个目标序号。 */
  targetIndex: number
  /** 拍点，单位是四分音符。 */
  onset: number
  /** 到下一个拍点的长度，单位是四分音符。 */
  duration: number
  pitches: number[]
  hand: number
  label: string
}

export interface ScoreNoteResult {
  note: ScoreNote
  outcome: ScoreOutcome
  /** 0–1，音高与时间共同决定。 */
  points: number
  /** 实际起音时间 - 应演奏时间（毫秒）；负值是偏早。 */
  deviationMs: number | null
  heard: number | null
}

export interface ScoreSummary {
  total: number
  judged: number
  perfect: number
  good: number
  missed: number
  wrong: number
  /** 0–100。 */
  accuracy: number
  /** 0–1 的加权总分之和。 */
  points: number
  durationMs: number
  results: ScoreNoteResult[]
}

export interface ScoreSnapshot {
  phase: ScoringPhase
  total: number
  judged: number
  current: ScoreNote | null
  last: ScoreNoteResult | null
  accuracy: number
  perfect: number
  good: number
  missed: number
  wrong: number
  heard: number | null
  error: string | null
}

export interface ScoringOptions {
  bpm: number
  /** 连续多少帧算稳定起音；每帧约 60ms。 */
  stableFrames: number
  minClarity: number
  minRms: number
  releaseRms: number
  /** 匹配的时间窗：应演奏时间前后各多久内算尝试过。 */
  matchWindowMs: number
  /** 超过应演奏时间多久还没演奏就记漏音。 */
  missWindowMs: number
}

const DEFAULT_OPTIONS: ScoringOptions = {
  bpm: 80,
  stableFrames: 3,
  minClarity: 0.8,
  minRms: 0.008,
  releaseRms: 0.004,
  matchWindowMs: 650,
  missWindowMs: 500
}

export const SCORE_OUTCOME_LABELS: Record<ScoreOutcome, string> = {
  perfect: '完美',
  good: '良好',
  early: '偏早',
  late: '偏晚',
  octave: '八度',
  wrong: '错音',
  missed: '漏音'
}

/** 成绩等级；只用于结果对话框的标题。 */
export function scoreGrade(accuracy: number): string {
  if (accuracy >= 95) return '非常稳'
  if (accuracy >= 85) return '完成得不错'
  if (accuracy >= 70) return '基本跟上'
  return '再练一遍'
}

/** 把练习目标拆成逐音评分项；同一拍点的两只手会各占一个音。 */
export function buildScoreNotes(targets: PracticeTarget[]): ScoreNote[] {
  return targets.flatMap((target, targetIndex) => {
    const next = targets[targetIndex + 1]
    const duration = next === undefined
      ? 1
      : Math.max(0.25, next.onset - target.onset)
    return target.hands.map(hand => ({
      index: hand.lead,
      targetIndex,
      onset: target.onset,
      duration,
      pitches: [...hand.pitches],
      hand: hand.hand,
      label: hand.pitches.map(midiLabel).join(' · ')
    }))
  })
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 时间分：正中为 1，偏 500ms 以上为 0。 */
function timingPoints(deviationMs: number): number {
  return clamp01(1 - Math.abs(deviationMs) / 500)
}

/** 音高分：准确 1，八度等价 0.8；错音为 0。 */
function pitchPoints(note: ScoreNote, midi: number): number | null {
  if (note.pitches.includes(midi)) return 1
  if (note.pitches.some(pitch => Math.abs(pitch - midi) === 12)) return 0.8
  return null
}

export class ScoreTracker {
  readonly notes: ScoreNote[]
  private readonly options: ScoringOptions
  private readonly msPerQuarter: number
  private readonly results: (ScoreNoteResult | null)[]
  private phase: ScoringPhase = 'idle'
  private startedAt: number | null = null
  private finishedAt: number | null = null
  private pausedAt: number | null = null
  private pausedTotal = 0
  /** 恢复后重新等待当前音的时间，也从演奏时长里扣除。 */
  private resumedAt: number | null = null
  /** onset 0 对应的 performance.now()。 */
  private origin = 0
  private now = 0
  private lastResult: ScoreNoteResult | null = null
  private heard: number | null = null

  /** 起音检测，与 PracticeTracker 相同的稳定帧规则。 */
  private runMidi: number | null = null
  private runFrames = 0
  private runStartedAt = 0
  private runConsumed = false
  private armed = true
  private lastMidi: number | null = null

  constructor(notes: ScoreNote[], options: Partial<ScoringOptions> = {}) {
    this.notes = notes
    this.options = { ...DEFAULT_OPTIONS, ...options }
    const bpm = Math.min(240, Math.max(30, Math.round(this.options.bpm)))
    this.msPerQuarter = 60_000 / bpm
    this.results = notes.map(() => null)
  }

  get total(): number {
    return this.notes.length
  }

  get snapshots(): ScoreNoteResult[] {
    return this.results.filter((result): result is ScoreNoteResult => result !== null)
  }

  start(): ScoreSnapshot {
    this.phase = 'waiting'
    this.results.fill(null)
    this.lastResult = null
    this.heard = null
    this.startedAt = null
    this.finishedAt = null
    this.pausedAt = null
    this.pausedTotal = 0
    this.resumedAt = null
    this.origin = 0
    this.now = 0
    this.resetOnset()
    return this.state()
  }

  state(): ScoreSnapshot {
    const results = this.snapshots
    const points = results.reduce((sum, result) => sum + result.points, 0)
    const pending = this.results.findIndex(result => result === null)
    return {
      phase: this.phase,
      total: this.total,
      judged: results.length,
      current: pending === -1 ? null : this.notes[pending] ?? null,
      last: this.lastResult,
      accuracy: results.length === 0 ? 0 : Math.round((points / results.length) * 100),
      perfect: results.filter(result => result.outcome === 'perfect').length,
      good: results.filter(result => result.outcome === 'good'
        || result.outcome === 'early'
        || result.outcome === 'late'
        || result.outcome === 'octave').length,
      missed: results.filter(result => result.outcome === 'missed').length,
      wrong: results.filter(result => result.outcome === 'wrong').length,
      heard: this.heard,
      error: null
    }
  }

  /** 喂一帧音高；返回最新快照。 */
  push(frame: PitchFrame): ScoreSnapshot {
    this.now = frame.at
    if (this.phase !== 'waiting' && this.phase !== 'running') return this.state()

    const onset = this.detectOnset(frame)
    if (this.phase === 'waiting') {
      if (onset !== null) {
        this.heard = onset.midi
        this.begin(onset)
      }
      return this.state()
    }

    if (onset !== null) {
      this.heard = onset.midi
      this.attempt(onset.midi, onset.at)
    }
    // 先匹配再结算漏音：稳定起音要积累几帧，判定时间取这一口气的起点，
    // 不能因为检测晚了一百多毫秒就把刚好卡在容错边缘的音判成漏音。
    this.advance(frame.at)
    if (this.results.every(result => result !== null)) this.finish(frame.at)
    return this.state()
  }

  /** 首个音落下后才建立时间线；在此之前可以一直等。 */
  private begin(onset: { midi: number, at: number }): void {
    const firstOnset = this.notes.find(note => this.results[this.notes.indexOf(note)] === null)?.onset
    if (firstOnset === undefined) return
    const candidates = this.notes
      .map((note, index) => ({ note, index }))
      .filter(entry => entry.note.onset === firstOnset && this.results[entry.index] === null)
    let match: { note: ScoreNote, index: number, octave: boolean } | null = null
    for (const entry of candidates) {
      if (entry.note.pitches.includes(onset.midi)) {
        match = { ...entry, octave: false }
        break
      }
      if (match === null && entry.note.pitches.some(pitch => Math.abs(pitch - onset.midi) === 12)) {
        match = { ...entry, octave: true }
      }
    }
    if (match === null) return

    this.origin = onset.at - match.note.onset * this.msPerQuarter
    if (this.startedAt === null) this.startedAt = onset.at
    if (this.resumedAt !== null) {
      this.pausedTotal += Math.max(0, onset.at - this.resumedAt)
      this.resumedAt = null
    }
    this.phase = 'running'
    this.record(match.index, onset.midi, onset.at, match.octave)
    this.advance(onset.at)
    if (this.results.every(result => result !== null)) this.finish(onset.at)
  }

  private scheduledAt(note: ScoreNote): number {
    return this.origin + note.onset * this.msPerQuarter
  }

  /** 找出最近的可匹配音；错音只吃掉时间窗内最近的一个待判音。 */
  private attempt(midi: number, at: number): void {
    let best: { index: number, deviation: number, octave: boolean } | null = null
    for (let index = 0; index < this.notes.length; index += 1) {
      if (this.results[index] !== null) continue
      const note = this.notes[index]
      if (note === undefined) continue
      const deviation = at - this.scheduledAt(note)
      if (Math.abs(deviation) > this.options.matchWindowMs) continue
      const exact = note.pitches.includes(midi)
      const octave = !exact && note.pitches.some(pitch => Math.abs(pitch - midi) === 12)
      if (!exact && !octave) continue
      if (
        best === null
        || (exact && best.octave)
        || (exact === !best.octave && Math.abs(deviation) < Math.abs(best.deviation))
      ) {
        best = { index, deviation, octave }
      }
    }
    if (best !== null) {
      this.record(best.index, midi, at, best.octave)
      return
    }

    let nearest: { index: number, deviation: number } | null = null
    for (let index = 0; index < this.notes.length; index += 1) {
      if (this.results[index] !== null) continue
      const note = this.notes[index]
      if (note === undefined) continue
      const deviation = at - this.scheduledAt(note)
      if (Math.abs(deviation) > 220) continue
      if (nearest === null || Math.abs(deviation) < Math.abs(nearest.deviation)) {
        nearest = { index, deviation }
      }
    }
    if (nearest !== null) {
      const note = this.notes[nearest.index]
      if (note !== undefined) {
        this.results[nearest.index] = {
          note,
          outcome: 'wrong',
          points: 0,
          deviationMs: Math.round(nearest.deviation),
          heard: midi
        }
        this.lastResult = this.results[nearest.index] ?? null
      }
    }
  }

  private record(index: number, midi: number, at: number, octave: boolean): void {
    const note = this.notes[index]
    if (note === undefined || this.results[index] !== null) return
    const scheduled = this.scheduledAt(note)
    const deviation = at - scheduled
    const pitch = pitchPoints(note, midi)
    if (pitch === null) return
    const outcome: ScoreOutcome = octave
      ? 'octave'
      : Math.abs(deviation) <= 100
        ? 'perfect'
        : Math.abs(deviation) <= 250
          ? 'good'
          : deviation < 0 ? 'early' : 'late'
    this.results[index] = {
      note,
      outcome,
      points: clamp01(pitch * 0.6 + timingPoints(deviation) * 0.4),
      deviationMs: Math.round(deviation),
      heard: midi
    }
    this.lastResult = this.results[index] ?? null
  }

  /** 超过容错窗口的待判音记为漏音。 */
  private advance(at: number): void {
    for (let index = 0; index < this.notes.length; index += 1) {
      if (this.results[index] !== null) continue
      const note = this.notes[index]
      if (note === undefined) continue
      if (at <= this.scheduledAt(note) + this.options.missWindowMs) continue
      this.results[index] = {
        note,
        outcome: 'missed',
        points: 0,
        deviationMs: null,
        heard: null
      }
      this.lastResult = this.results[index] ?? null
    }
  }

  private finish(at: number): void {
    this.advance(at)
    for (let index = 0; index < this.notes.length; index += 1) {
      if (this.results[index] !== null) continue
      const note = this.notes[index]
      if (note === undefined) continue
      this.results[index] = {
        note,
        outcome: 'missed',
        points: 0,
        deviationMs: null,
        heard: null
      }
    }
    this.phase = 'finished'
    this.finishedAt = at
    this.resetOnset()
  }

  pause(at: number): ScoreSnapshot {
    if (this.phase !== 'waiting' && this.phase !== 'running') return this.state()
    this.pausedAt = at
    this.phase = 'paused'
    this.resetOnset()
    return this.state()
  }

  /**
   * 继续评分时回到“等待首音”：等下一个未判音落下，以它为新的时间原点。
   * 暂停前已经判定的音保留，暂停时长不计入演奏时长。
   */
  resume(at: number): ScoreSnapshot {
    if (this.phase !== 'paused') return this.state()
    if (this.pausedAt !== null) this.pausedTotal += Math.max(0, at - this.pausedAt)
    this.pausedAt = null
    this.resumedAt = at
    this.phase = 'waiting'
    this.resetOnset()
    return this.state()
  }

  /** 主动结束：开始过就补齐漏音并返回成绩；还在等首音则取消。 */
  stop(at: number): ScoreSummary | null {
    if (this.phase === 'idle' || this.phase === 'finished') return this.summary()
    if (this.startedAt === null) {
      this.reset()
      return null
    }
    if (this.pausedAt !== null) {
      this.pausedTotal += Math.max(0, at - this.pausedAt)
      this.pausedAt = null
    }
    if (this.resumedAt !== null) {
      this.pausedTotal += Math.max(0, at - this.resumedAt)
      this.resumedAt = null
    }
    this.finish(at)
    return this.summary()
  }

  reset(): void {
    this.phase = 'idle'
    this.results.fill(null)
    this.lastResult = null
    this.heard = null
    this.startedAt = null
    this.finishedAt = null
    this.pausedAt = null
    this.pausedTotal = 0
    this.resumedAt = null
    this.origin = 0
    this.now = 0
    this.resetOnset()
  }

  summary(): ScoreSummary | null {
    if (this.startedAt === null || this.phase !== 'finished') return null
    const results = this.results
      .filter((result): result is ScoreNoteResult => result !== null)
      .sort((left, right) => left.note.index - right.note.index)
    const points = results.reduce((sum, result) => sum + result.points, 0)
    const end = this.finishedAt ?? this.startedAt
    return {
      total: this.total,
      judged: results.length,
      perfect: results.filter(result => result.outcome === 'perfect').length,
      good: results.filter(result => result.outcome === 'good'
        || result.outcome === 'early'
        || result.outcome === 'late'
        || result.outcome === 'octave').length,
      missed: results.filter(result => result.outcome === 'missed').length,
      wrong: results.filter(result => result.outcome === 'wrong').length,
      accuracy: results.length === 0 ? 0 : Math.round((points / results.length) * 100),
      points,
      durationMs: Math.max(0, end - this.startedAt - this.pausedTotal),
      results
    }
  }

  /** 稳定起音检测；返回“这一口气”的起始时间和音高。 */
  private detectOnset(frame: PitchFrame): { midi: number, at: number } | null {
    const frequency = frame.frequency
    const usable = frequency !== null
      && Number.isFinite(frequency)
      && frequency > 0
      && frame.clarity >= this.options.minClarity
      && frame.rms >= this.options.minRms
    if (!usable) {
      this.runMidi = null
      this.runFrames = 0
      this.runConsumed = false
      if (frame.rms < this.options.releaseRms) this.armed = true
      return null
    }

    const midi = Math.round(midiForFrequency(frequency))
    if (midi !== this.runMidi) {
      this.runMidi = midi
      this.runFrames = 1
      this.runStartedAt = frame.at
      this.runConsumed = false
      this.armed = true
    } else {
      this.runFrames += 1
    }
    if (this.runFrames < this.options.stableFrames || this.runConsumed) return null
    if (!this.armed && midi === this.lastMidi) return null

    this.runConsumed = true
    this.lastMidi = midi
    this.armed = false
    return { midi, at: this.runStartedAt }
  }

  private resetOnset(): void {
    this.runMidi = null
    this.runFrames = 0
    this.runConsumed = false
    this.armed = true
    this.lastMidi = null
  }
}
