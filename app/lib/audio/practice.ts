/**
 * 练习模式跟踪：把麦克风音高帧匹配到乐谱上的目标音。
 *
 * 这里不碰 Web Audio 和 DOM，输入是统一的音高帧，输出是游标状态，因此可以在
 * Node 里用合成帧回归（scripts/check-tracker.mjs）。跟踪原则：
 *
 * - 只按时间向前推进；只匹配当前目标，不向前搜索，漏掉的音必须重新演奏或手动定位。
 * - 同一拍点按手分组：双手谱要求两只手都在时间窗内各演奏一个音才推进。
 * - 同一个音高持续发声只算一次；重新起音需要静音或音高变化。
 * - 揉弦造成的半音内抖动不算换音，见 `midiWithHysteresis`。
 * - 弓弦换弓、擦弦偶尔掉一帧：确认起音时容忍一次漏检，不把稳定帧清零。
 * - 八度等价匹配单独计数：单音检测偶尔把基频判成泛音，练习模式仍推进但会提示。
 */

import type { MusicXmlNote, MusicXmlPitch } from '~/lib/musicxml/document'

const A4_MIDI = 69
const A4_FREQUENCY = 440
const SEMITONE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const STEP_SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11
}

/** 频率转 MIDI（可能带小数）：440Hz → 69。 */
export function midiForFrequency(frequency: number): number {
  return A4_MIDI + 12 * Math.log2(frequency / A4_FREQUENCY)
}

/**
 * 带滞回的音高量化：揉弦会在半音边界反复抖动，贴着当前半音就不会每帧都算换音。
 * 只有偏离超过大半个半音才跳到新的音，真正换音仍能立即识别。
 */
export function midiWithHysteresis(frequency: number, current: number | null): number {
  const raw = midiForFrequency(frequency)
  if (current !== null && Math.abs(raw - current) <= 0.7) return current
  return Math.round(raw)
}

/** MIDI 转频率：69 → 440Hz。 */
export function frequencyForMidi(midi: number): number {
  return A4_FREQUENCY * 2 ** ((midi - A4_MIDI) / 12)
}

/** 音高显示名：69 → `A4`，61 → `C#4`。 */
export function midiLabel(midi: number): string {
  const pitchClass = ((midi % 12) + 12) % 12
  return `${SEMITONE_NAMES[pitchClass]}${Math.floor(midi / 12) - 1}`
}

/** MusicXML 音高转 MIDI；没有音高（休止、打击乐）返回 null。 */
export function midiForPitch(pitch: MusicXmlPitch | null): number | null {
  if (pitch === null) return null
  const step = STEP_SEMITONES[pitch.step]
  if (step === undefined) return null
  return 12 * (pitch.octave + 1) + step + pitch.alter
}

/**
 * 一个练习目标：同一拍点上的所有音算作一组。组内按手（partId + staff）
 * 再分：双手谱里每只手都要演奏一个音才推进，避免单手就跳过去。
 * 休止符、装饰音和延音线后半段不要求演奏。
 */
export interface PracticeHand {
  /** 手序号：按文档里第一次出现的 partId + staff 分配，用于箭头颜色。 */
  hand: number
  /** 该手在这个目标里的第一个音符序号。 */
  lead: number
  /** 该手在这个目标里的音高（MIDI，去重）。 */
  pitches: number[]
}

export interface PracticeTarget {
  /** 组内第一个音符在 MusicXML 文档中的序号，用于定位与高亮。 */
  lead: number
  /** 组内全部音符序号。 */
  indices: number[]
  /** 组内音高（MIDI，去重）。 */
  pitches: number[]
  /** 按手分组；每只手对应乐谱上的一个箭头。 */
  hands: PracticeHand[]
  /** 面板上的音名，例如 `G4` 或 `C4 · E4`。 */
  label: string
  /** 组内第一个音所在的拍点，用于跨声部排序。 */
  onset: number
}

interface TargetDraft {
  lead: number
  indices: number[]
  pitches: Set<number>
  hands: Map<number, { lead: number, pitches: Set<number> }>
  onset: number
}

/** 左右手箭头颜色：第一只手（通常是右手/高音谱号）蓝色，第二只手红色。 */
const HAND_COLORS = ['#1d4ed8', '#b91c1c', '#b45309']

/** 手序号对应的箭头颜色；超过三只手时统一用琥珀色。 */
export function handColor(hand: number): string {
  return HAND_COLORS[hand] ?? HAND_COLORS[HAND_COLORS.length - 1] ?? '#b45309'
}

/**
 * 把文档顺序的音符整理成按时间排列的练习目标。
 *
 * MusicXML 里多个 part 各自从 0 开始计拍，文档顺序也是 part 1 全部在前，
 * 所以必须按 `onset` 重新排序；同一 onset 的音合并成和弦组，再按 partId + staff
 * 拆成手。延音线用 `partId + 音高` 记录，后半段不再作为独立目标。
 */
export function buildPracticeTargets(notes: MusicXmlNote[]): PracticeTarget[] {
  const drafts = new Map<number, TargetDraft>()
  const openTies = new Set<string>()
  const handOrder = new Map<string, number>()

  // 手序号按音符在文档里第一次出现分配：一般 part 1 / staff 1 是右手，staff 2 是左手。
  // 两个 part 各有自己的 staff 1 时也能区分开。
  const handOf = (note: MusicXmlNote): number => {
    const key = `${note.partId}:${note.staff}`
    let hand = handOrder.get(key)
    if (hand === undefined) {
      hand = handOrder.size
      handOrder.set(key, hand)
    }
    return hand
  }

  for (const note of notes) {
    const midi = midiForPitch(note.pitch)
    const tieKey = `${note.partId}:${midi ?? 'none'}`
    const continuation = midi !== null && note.tieStop && openTies.has(tieKey)
    if (midi !== null && note.tieStart) openTies.add(tieKey)
    if (midi !== null && note.tieStop && !note.tieStart) openTies.delete(tieKey)
    if (midi === null || note.isRest || note.isGrace || continuation) continue

    const hand = handOf(note)
    const key = Math.round(note.onset * 1000)
    const draft = drafts.get(key)
    if (draft === undefined) {
      drafts.set(key, {
        lead: note.index,
        indices: [note.index],
        pitches: new Set([midi]),
        hands: new Map([[hand, { lead: note.index, pitches: new Set([midi]) }]]),
        onset: note.onset
      })
      continue
    }
    draft.indices.push(note.index)
    draft.pitches.add(midi)
    const group = draft.hands.get(hand)
    if (group === undefined) {
      draft.hands.set(hand, { lead: note.index, pitches: new Set([midi]) })
    } else {
      group.pitches.add(midi)
    }
  }

  return [...drafts.values()]
    .sort((left, right) => left.onset - right.onset)
    .map((draft) => {
      const pitches = [...draft.pitches].sort((left, right) => left - right)
      return {
        lead: draft.lead,
        indices: draft.indices,
        pitches,
        hands: [...draft.hands.entries()]
          .sort(([left], [right]) => left - right)
          .map(([hand, group]) => ({
            hand,
            lead: group.lead,
            pitches: [...group.pitches].sort((left, right) => left - right)
          })),
        label: pitches.map(midiLabel).join(' · '),
        onset: draft.onset
      }
    })
}

/** 一帧音高输入；`frequency` 为 null 表示这一帧没有可用音高。 */
export interface PitchFrame {
  frequency: number | null
  /** Pitchy 的清晰度 0–1。 */
  clarity: number
  /** 时域 RMS，0–1。 */
  rms: number
  /** `performance.now()` 毫秒。 */
  at: number
}

export type TrackerOutcome = 'idle' | 'quiet' | 'unmatched' | 'partial' | 'matched' | 'octave' | 'jumped' | 'done'

export interface TrackerUpdate {
  outcome: TrackerOutcome
  /** 接下来要演奏的目标；全部演奏完为 null。 */
  current: PracticeTarget | null
  done: boolean
  stale: boolean
  /** 0 基：下一个目标序号；done 时等于 total。 */
  position: number
  total: number
  matched: number
  octaveMatches: number
}

export interface PracticeTrackerOptions {
  /** 连续多少帧算稳定起音。 */
  stableFrames: number
  minClarity: number
  minRms: number
  /** 低于这个音量才认为声音停了，可以用来重新起音。 */
  releaseRms: number
  /** 双手目标里，两只手必须在这个窗口内都发声。 */
  handWindowMs: number
  /** 多久没有推进就提示。 */
  staleMs: number
}

const DEFAULT_OPTIONS: PracticeTrackerOptions = {
  stableFrames: 2,
  minClarity: 0.7,
  minRms: 0.003,
  releaseRms: 0.0015,
  handWindowMs: 1500,
  staleMs: 4000
}

export class PracticeTracker {
  readonly targets: PracticeTarget[]
  private readonly options: PracticeTrackerOptions
  /** 追丢判定使用的按键窗口；连续 8 个按键才能确定演奏者去了别处。 */
  private static readonly JUMP_WINDOW = 8
  /** 最近稳定起音的音高堆栈；追丢后用它匹配乐谱别处的连续音符。 */
  private recent: number[] = []
  private index = 0
  private matched = 0
  private octaveMatches = 0
  private runMidi: number | null = null
  private runFrames = 0
  /** 这一段起音里已经容忍过的漏检帧数；只宽容一帧。 */
  private runSkips = 0
  private runConsumed = false
  private armed = true
  private lastMidi: number | null = null
  private startedAt: number | null = null
  private lastAdvanceAt = 0
  private now = 0
  private lastOutcome: TrackerOutcome = 'idle'
  /** 当前目标里已经听到的手，以及上一次听到手的时间。 */
  private handHits = new Set<number>()
  private handOctave = false
  private lastHandAt = 0

  constructor(targets: PracticeTarget[], options: Partial<PracticeTrackerOptions> = {}) {
    this.targets = targets
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  get done(): boolean {
    return this.index >= this.targets.length
  }

  /** 只读取当前状态，不喂帧。 */
  state(): TrackerUpdate {
    return this.report(this.done ? 'done' : this.lastOutcome)
  }

  /**
   * 喂一帧。只有稳定、可信、且是一次新起音的音高才会尝试匹配；
   * 其余帧只更新提示状态。
   */
  push(frame: PitchFrame): TrackerUpdate {
    if (this.startedAt === null) {
      this.startedAt = frame.at
      this.lastAdvanceAt = frame.at
    }
    this.now = frame.at
    if (this.done) return this.report('done')

    const frequency = frame.frequency
    const usable = frequency !== null
      && Number.isFinite(frequency)
      && frequency > 0
      && frame.clarity >= this.options.minClarity
      && frame.rms >= this.options.minRms
    if (!usable) {
      // 确认起音时掉一帧（换弓、擦弦）：声音还在就先留着已经攒下的帧。
      // 已经推进过的持续音不在这里宽容，掉帧要重新布防，换弓后的重复音才能重新起音。
      if (
        this.runFrames > 0
        && this.runSkips === 0
        && !this.runConsumed
        && frame.rms >= this.options.minRms
      ) {
        this.runSkips = 1
      } else {
        this.runMidi = null
        this.runFrames = 0
        this.runSkips = 0
        this.runConsumed = false
      }
      if (frame.rms < this.options.releaseRms) this.armed = true
      return this.report('quiet')
    }

    const midi = midiWithHysteresis(frequency, this.runMidi)
    if (midi !== this.runMidi) {
      this.runMidi = midi
      this.runFrames = 1
      this.runSkips = 0
      this.runConsumed = false
      // 音高变化就是一次新的起音。
      this.armed = true
    } else {
      this.runFrames += 1
      this.runSkips = 0
    }

    if (this.runFrames < this.options.stableFrames || this.runConsumed) {
      return this.report('idle')
    }
    if (!this.armed && midi === this.lastMidi) return this.report('idle')

    this.runConsumed = true
    this.recent = [...this.recent.slice(-(PracticeTracker.JUMP_WINDOW - 1)), midi]
    const target = this.targets[this.index]
    if (target === undefined) return this.report('done')

    // 两声部之间间隔太久就当作重新开始，避免把先后演奏的单音拼成和弦。
    if (this.handHits.size > 0 && frame.at - this.lastHandAt > this.options.handWindowMs) {
      this.handHits.clear()
      this.handOctave = false
    }
    if (this.handHits.size === 0) this.lastHandAt = frame.at

    const match = this.matchHand(target, midi)
    if (match === null) {
      const jump = this.findJump()
      if (jump !== null) return this.performJump(jump, midi)
      return this.report('unmatched')
    }

    this.handHits.add(match.hand)
    this.handOctave ||= match.octave
    this.lastMidi = midi
    this.lastAdvanceAt = frame.at
    this.lastHandAt = frame.at
    this.armed = false

    if (this.handHits.size < target.hands.length) return this.report('partial')

    const octave = this.handOctave
    this.matched += 1
    if (octave) this.octaveMatches += 1
    this.index += 1
    this.handHits.clear()
    this.handOctave = false
    this.lastHandAt = 0

    if (octave) return this.report('octave')
    return this.report('matched')
  }

  /**
   * 暂停恢复后重新布防：丢掉暂停前累积的起音帧和半只手的命中，避免把暂停期间
   * 的余音或恢复瞬间的同一口气接上一次匹配。
   */
  rearm(): TrackerUpdate {
    this.runMidi = null
    this.runFrames = 0
    this.runSkips = 0
    this.runConsumed = false
    this.armed = true
    this.lastMidi = null
    this.handHits.clear()
    this.handOctave = false
    this.lastHandAt = 0
    this.lastAdvanceAt = this.now
    this.lastOutcome = 'idle'
    this.recent = []
    return this.report(this.done ? 'done' : 'idle')
  }

  /**
   * 从某个音符重新开始。找不到对应目标时退到它之后的第一个目标；
   * 已经越过最后一个目标则标记为完成。
   */
  seek(noteIndex: number): TrackerUpdate {
    let next = this.targets.findIndex(target => target.indices.includes(noteIndex))
    if (next < 0) next = this.targets.findIndex(target => target.lead >= noteIndex)
    this.index = next < 0 ? this.targets.length : next
    this.runMidi = null
    this.runFrames = 0
    this.runSkips = 0
    this.runConsumed = false
    this.armed = true
    this.lastMidi = null
    this.lastAdvanceAt = this.now
    this.handHits.clear()
    this.handOctave = false
    this.lastHandAt = 0
    this.lastOutcome = 'idle'
    this.recent = []
    return this.report(this.done ? 'done' : 'idle')
  }

  /**
   * 追丢判定：最近 8 个按键里命中当前待演奏音符不足 3 个，说明演奏者已经离开
   * 当前位置；如果这 8 个音又完美命中乐谱别处连续 8 个音符，就跳到它们之后。
   *
   * 重叠部分太多容易在重复音型里误跳，因此要求“其它地方”的 8 个目标不包含
   * 当前目标；多个匹配时取离当前位置最近的一段。
   */
  private findJump(): { start: number, end: number } | null {
    const window = PracticeTracker.JUMP_WINDOW
    if (this.recent.length < window) return null
    const currentIndex = this.index
    const current = this.targets[currentIndex]
    if (current === undefined) return null
    const recent = this.recent.slice(-window)
    const hits = recent.filter(midi => current.pitches.includes(midi)).length
    if (hits >= 3) return null

    let best: { start: number, distance: number } | null = null
    for (let start = 0; start + window < this.targets.length; start += 1) {
      if (start <= currentIndex && currentIndex < start + window) continue
      let matched = true
      for (let offset = 0; offset < window; offset += 1) {
        const target = this.targets[start + offset]
        const midi = recent[offset]
        if (target === undefined || midi === undefined || !target.pitches.includes(midi)) {
          matched = false
          break
        }
      }
      if (!matched) continue
      const distance = Math.abs(start - currentIndex)
      if (
        best === null
        || distance < best.distance
        || (distance === best.distance && start > best.start)
      ) {
        best = { start, distance }
      }
    }
    return best === null ? null : { start: best.start, end: best.start + window }
  }

  /** 这 8 个音视为已经演奏过，进度落到它们之后；持续音不会再触发一次跳转。 */
  private performJump(jump: { start: number, end: number }, midi: number): TrackerUpdate {
    this.matched += jump.end - jump.start
    this.index = jump.end
    this.recent = []
    this.handHits.clear()
    this.handOctave = false
    this.lastHandAt = 0
    this.lastAdvanceAt = this.now
    this.lastMidi = midi
    this.armed = false
    this.runConsumed = true
    return this.report(this.done ? 'done' : 'jumped')
  }

  /**
   * 只在当前目标里找能接下这个音高的手；已经听过的右手不会重复计数。
   * 未满足的手优先，两只手同一个音时也能各算一次。
   */
  private matchHand(target: PracticeTarget, midi: number): { hand: number, octave: boolean } | null {
    const ordered = [
      ...target.hands.filter(hand => !this.handHits.has(hand.hand)),
      ...target.hands.filter(hand => this.handHits.has(hand.hand))
    ]
    let octave: { hand: number, octave: boolean } | null = null
    for (const hand of ordered) {
      for (const pitch of hand.pitches) {
        if (pitch === midi) return { hand: hand.hand, octave: false }
        if (octave === null && Math.abs(pitch - midi) === 12) {
          octave = { hand: hand.hand, octave: true }
        }
      }
    }
    return octave
  }

  private get stale(): boolean {
    return !this.done
      && this.startedAt !== null
      && this.now - this.lastAdvanceAt > this.options.staleMs
  }

  private report(outcome: TrackerOutcome): TrackerUpdate {
    // 稳定帧累积、持续发声这些“没有结论”的帧沿用上一次结论，避免提示闪一下就没。
    const effective = outcome === 'idle' ? this.lastOutcome : outcome
    this.lastOutcome = effective
    return {
      outcome: effective,
      current: this.targets[this.index] ?? null,
      done: this.done,
      stale: this.stale,
      position: this.index,
      total: this.targets.length,
      matched: this.matched,
      octaveMatches: this.octaveMatches
    }
  }
}
