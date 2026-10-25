/**
 * 评分记录仓储：一次演奏一条，按曲谱索引，历史列表按结束时间倒序。
 *
 * 记录里保存逐音结果，成绩对话框和以后回放定位都用同一份数据；写库前把
 * `ScoreSummary` 转成普通对象，避免 Vue 代理和 MIDI 常量进入 IndexedDB。
 */

import { midiLabel } from '~/lib/audio/practice'
import type { ScoreSummary } from '~/lib/audio/scoring'
import type { HandMode } from '~/lib/audio/score'
import { getAllByIndex, writeBatch } from './database'
import type { ScoreRunNote, ScoreRunRecord } from './schema'

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface ScoreRunInput {
  scoreId: string
  bpm: number
  beats: number
  beatType: number
  handMode: HandMode
  summary: ScoreSummary
}

export async function saveScoreRun(input: ScoreRunInput): Promise<ScoreRunRecord> {
  const record = buildScoreRunRecord(input)
  await writeBatch([{ store: 'runs', records: [record] }])
  return record
}

/** 把一次评分汇总转成持久化记录；保存失败时成绩对话框也能直接展示。 */
export function buildScoreRunRecord(
  input: ScoreRunInput,
  options: { id?: string, finishedAt?: number } = {}
): ScoreRunRecord {
  const summary = input.summary
  const finishedAt = options.finishedAt ?? Date.now()
  const notes: ScoreRunNote[] = summary.results.map(result => ({
    index: result.note.index,
    label: result.note.label,
    hand: result.note.hand,
    outcome: result.outcome,
    points: result.points,
    deviationMs: result.deviationMs,
    heard: result.heard === null ? null : midiLabel(result.heard)
  }))
  return {
    id: options.id ?? newId(),
    scoreId: input.scoreId,
    bpm: input.bpm,
    beats: input.beats,
    beatType: input.beatType,
    handMode: input.handMode,
    startedAt: finishedAt - summary.durationMs,
    finishedAt,
    durationMs: summary.durationMs,
    total: summary.total,
    perfect: summary.perfect,
    good: summary.good,
    missed: summary.missed,
    wrong: summary.wrong,
    accuracy: summary.accuracy,
    notes
  }
}

export async function listScoreRuns(scoreId: string): Promise<ScoreRunRecord[]> {
  const runs = await getAllByIndex<ScoreRunRecord>('runs', 'byScore', scoreId)
  return runs.sort((left, right) => right.finishedAt - left.finishedAt)
}
