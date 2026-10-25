/**
 * 多页曲谱的练习序列：把每页自己的 MusicXML 音符拼成一条全局序列。
 *
 * 图片曲谱一页一条识别记录，`<note>` 序号和拍点都从 0 重新开始。纵向排开后，
 * 练习必须按页序连续推进，因此这里给音符重新编号，并把每页的 onset 接在前一页
 * 之后；`refs` 保留全局序号到「第几页、页内第几个音」的映射，页面图和 Verovio
 * 各自用自己的坐标画箭头。
 */

import type { MusicXmlNote } from '~/lib/musicxml/document'
import { midiLabel, type PracticeTarget } from './practice'

/** 声部筛选：双手、右手（第一只手）、左手（第二只手）。 */
export type HandMode = 'both' | 'right' | 'left'

/** 页与页之间留出的拍数，保证后一页的目标不会排到前一页前面。 */
const PAGE_ONSET_GAP = 4

export interface ScorePageNotes {
  /** 页在曲谱里的顺序，从 0 开始。 */
  pageIndex: number
  notes: MusicXmlNote[]
}

export interface ScoreNoteRef {
  pageIndex: number
  /** 页内音符序号，和该页 `locations`、侧车 `noteSymbols` 的索引一致。 */
  index: number
}

export interface CombinedScoreNotes {
  /** 全局音符：序号连续，onset 已按页偏移。 */
  notes: MusicXmlNote[]
  /** 与 `notes` 一一对应。 */
  refs: ScoreNoteRef[]
  /** 每页第一个音符的全局序号；没有音符的页也占一个位置。 */
  pageStarts: number[]
}

/**
 * 按页序拼接音符。
 *
 * `note.index` 在页内是文档顺序，通常等于数组下标；这里用它写 `refs`，而不是
 * 数组下标，避免调用方传进来的音符已经做过筛选。全局序号始终用拼接后的下标。
 */
export function combineScoreNotes(pages: ScorePageNotes[]): CombinedScoreNotes {
  const notes: MusicXmlNote[] = []
  const refs: ScoreNoteRef[] = []
  const pageStarts: number[] = []
  let onsetBase = 0

  for (const page of pages) {
    pageStarts.push(notes.length)
    let maxOnset = 0
    for (const note of page.notes) {
      maxOnset = Math.max(maxOnset, note.onset)
      notes.push({
        ...note,
        index: notes.length,
        onset: note.onset + onsetBase
      })
      refs.push({ pageIndex: page.pageIndex, index: note.index })
    }
    // 空页也推进一点，保持页与页之间的顺序稳定。
    onsetBase += maxOnset + PAGE_ONSET_GAP
  }

  return { notes, refs, pageStarts }
}

/**
 * 只保留某只手的目标。双手谱里同一个拍点可能两只手各有音符；筛选后该目标的
 * 音名、箭头和“哪只手到齐”的判断都只针对留下的那只手。
 *
 * `both` 返回原数组，其余值按手序号 0（右手）/ 1（左手）过滤。返回的目标保留
 * 原来的 `indices`，点任意音符仍能 seek 到这一拍。
 */
export function filterTargetsByHand(targets: PracticeTarget[], mode: HandMode): PracticeTarget[] {
  if (mode === 'both') return targets
  const hand = mode === 'right' ? 0 : 1
  return targets.flatMap((target) => {
    const hands = target.hands.filter(entry => entry.hand === hand)
    if (hands.length === 0) return []
    const pitches = [...new Set(hands.flatMap(entry => entry.pitches))].sort((left, right) => left - right)
    return [{
      ...target,
      lead: hands[0]?.lead ?? target.lead,
      pitches,
      hands,
      label: pitches.map(midiLabel).join(' · ')
    }]
  })
}

/** 曲谱里实际出现过的手序号；没有音符时为空。 */
export function availableHands(targets: PracticeTarget[]): Set<number> {
  return new Set(targets.flatMap(target => target.hands.map(hand => hand.hand)))
}
