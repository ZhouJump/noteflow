/**
 * 曲谱设置：BPM、拍号与默认声部。每首曲谱一条，缺失时按 MusicXML 拍号生成默认值。
 */

import { getRecord, writeBatch } from './database'
import type { ScoreSettingsRecord } from './schema'

export const DEFAULT_BPM = 80
export const MIN_BPM = 30
export const MAX_BPM = 240
export const DEFAULT_BEATS = 4
export const DEFAULT_BEAT_TYPE = 4

/** 节拍器可切换的节奏型；拍号同样写进每首曲谱的设置。 */
export interface RhythmPattern {
  beats: number
  beatType: number
  label: string
}

export const RHYTHM_PATTERNS: RhythmPattern[] = [
  { beats: 4, beatType: 4, label: '4/4' },
  { beats: 3, beatType: 4, label: '3/4' },
  { beats: 2, beatType: 4, label: '2/4' }
]

export function rhythmLabel(beats: number, beatType: number): string {
  return `${Math.max(1, Math.round(beats))}/${Math.max(1, Math.round(beatType))}`
}

/** 只保留 4/4、3/4、2/4；导入的 6/8 等拍号归一到默认的 4/4。 */
export function normaliseRhythm(beats: number, beatType: number): RhythmPattern {
  const value = rhythmLabel(beats, beatType)
  const found = RHYTHM_PATTERNS.find(pattern => pattern.label === value)
  return found ?? { beats: DEFAULT_BEATS, beatType: DEFAULT_BEAT_TYPE, label: '4/4' }
}

export function clampBpm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BPM
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(value)))
}

/** 新曲谱的默认设置；拍号优先取 MusicXML 里解析到的值，但不支持的拍号回退到 4/4。 */
export function defaultScoreSettings(
  scoreId: string,
  timeSignature: { beats: number, beatType: number } | null = null
): ScoreSettingsRecord {
  const rhythm = normaliseRhythm(
    timeSignature?.beats ?? DEFAULT_BEATS,
    timeSignature?.beatType ?? DEFAULT_BEAT_TYPE
  )
  return {
    scoreId,
    bpm: DEFAULT_BPM,
    beats: rhythm.beats,
    beatType: rhythm.beatType,
    handMode: 'both',
    updatedAt: Date.now()
  }
}

export async function loadScoreSettings(
  scoreId: string,
  fallback: ScoreSettingsRecord
): Promise<ScoreSettingsRecord> {
  const stored = await getRecord<ScoreSettingsRecord>('settings', scoreId)
  if (stored === undefined) return fallback
  const rhythm = normaliseRhythm(
    stored.beats ?? fallback.beats,
    stored.beatType ?? fallback.beatType
  )
  return {
    ...fallback,
    ...stored,
    beats: rhythm.beats,
    beatType: rhythm.beatType,
    bpm: clampBpm(stored.bpm),
    handMode: stored.handMode === 'right' || stored.handMode === 'left' ? stored.handMode : 'both'
  }
}

export async function saveScoreSettings(settings: ScoreSettingsRecord): Promise<void> {
  await writeBatch([{
    store: 'settings',
    records: [{
      ...settings,
      bpm: clampBpm(settings.bpm),
      updatedAt: Date.now()
    }]
  }])
}
