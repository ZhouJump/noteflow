/**
 * IndexedDB 实体。开发指引第 16 节建议的模型在这里收敛成八个 store：
 *
 *   scores        曲谱（标题、来源、识别状态、封面缩略图、所属谱集）
 *   collections   谱集（谱架上的曲谱分组，与曲谱一对多）
 *   pages         页面（一页一条，关联原图与处理后图片）
 *   assets        文件资源（Blob + 尺寸），原图、处理图、缩略图都是 asset
 *   recognitions  识别结果（MusicXML 文本 + HOMR 侧车 + 音符顺序）
 *
 * 图片曲谱一页一条 page，每条 page 关联自己的 recognition；MusicXML 导入没有
 * 页面，只有一条 pageId 为 null 的 recognition。页序就是 `pageIndex`。
 *
 * MusicXML 与侧车直接作为文本/对象存在识别记录里，没有再包一层 asset：它们只有
 * 几十到几百 KB，而每次打开曲谱都必然要读。图片仍然走 asset，按需加载。
 *
 * 识别结果只读，导出的是 Worker 写出的原始 MusicXML。曲谱设置和批注从 M7 起
 * 单独存表；练习记录仍属于后续里程碑。新增 store 时在 `database.ts` 的
 * `upgrade` 里补上即可。
 */

import type { HandMode } from '~/lib/audio/score'
import type { ScoreOutcome } from '~/lib/audio/scoring'
import type { RecognitionResult } from '~/lib/homr/recognition'

export type ScoreSourceType = 'camera' | 'images' | 'pdf' | 'musicxml'

/** 图片曲谱（页面是图片）或结构化乐谱（直接来自 MusicXML）。 */
export type ScoreFormat = 'image' | 'structured'

export type RecognitionStatus = 'processing' | 'completed' | 'needsReview' | 'failed'

export interface ScoreRecord {
  id: string
  title: string
  composer: string
  /** 所属谱集；独立曲谱为 null。一首曲谱最多归属一个谱集。 */
  collectionId: string | null
  /** 在谱集内的顺序；独立曲谱为 null。与谱架排序分开保存。 */
  collectionOrder: number | null
  sourceType: ScoreSourceType
  scoreFormat: ScoreFormat
  recognitionStatus: RecognitionStatus
  pageCount: number
  /** 乐谱音符数（`<note>` 元素个数），用于谱架概览。 */
  noteCount: number
  thumbnailAssetId: string | null
  createdAt: number
  updatedAt: number
}

/** 谱集：谱架上的一组曲谱。删除谱集只解除归属，不删除曲谱。 */
export interface CollectionRecord {
  id: string
  title: string
  /** 用户拍摄或选择的封面；为 null 时用默认背景与名称构成封面。 */
  coverAssetId: string | null
  /** 谱架排序，数值越大越靠前。 */
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface PageRecord {
  id: string
  scoreId: string
  /** 从 0 开始的页序。 */
  pageIndex: number
  originalAssetId: string | null
  processedAssetId: string | null
  /** 本页缩略图；谱架把第二页垫在封面下面。旧数据可能为 null。 */
  thumbnailAssetId?: string | null
  recognitionResultId: string | null
  createdAt: number
}

export type AssetKind = 'original' | 'processed' | 'thumbnail' | 'cover'

export interface AssetRecord {
  id: string
  scoreId: string | null
  kind: AssetKind
  mimeType: string
  blob: Blob
  width: number
  height: number
  createdAt: number
}

export type RecognitionOrigin = 'homr' | 'import'

/** 侧车：Worker 回报的坐标与统计，不含 MusicXML 本身。 */
export type RecognitionSidecar = Omit<RecognitionResult, 'type' | 'musicxml' | 'noteSymbols'>

export interface RecognitionRecord {
  id: string
  scoreId: string
  pageId: string | null
  origin: RecognitionOrigin
  musicXml: string
  sidecar: RecognitionSidecar | null
  /** 每个 `<note>` 一个符号 id（文档顺序），索引即校正里用的音符序号。 */
  noteSymbols: (string | null)[]
  modelVersion: string
  sourceRevision: string
  status: 'completed' | 'failed'
  createdAt: number
}

/** 一页图片曲谱及其识别结果。 */
export interface ScorePageDetail {
  page: PageRecord
  recognition: RecognitionRecord | null
}

export interface ScoreDetail {
  score: ScoreRecord
  /** 图片曲谱的页面，按 pageIndex 排序；MusicXML 导入为空。 */
  pages: ScorePageDetail[]
  /** 没有页面图片的结构化曲谱记录（MusicXML 导入）。 */
  recognition: RecognitionRecord | null
  assets: Map<string, AssetRecord>
}

/** 每首曲谱独立的演奏设置；切换曲谱时不会互相覆盖。 */
export interface ScoreSettingsRecord {
  scoreId: string
  bpm: number
  /** 每小节拍数，来自 MusicXML 的拍号，缺省 4。 */
  beats: number
  beatType: number
  handMode: HandMode
  updatedAt: number
}

/** 批注坐标按所在页面归一化到 0–1，换屏幕尺寸不会错位。 */
export interface AnnotationPoint {
  x: number
  y: number
}

export interface AnnotationStroke {
  /** 墨色；当前固定为黑色。 */
  color: string
  /** 千分之一页宽的线宽，渲染时按页面实际宽度缩放。 */
  width: number
  points: AnnotationPoint[]
}

/** 一页的批注；图片页用 pageId 作 pageKey，结构化乐谱用 `structured`。 */
export interface AnnotationRecord {
  /** `${scoreId}:${pageKey}`，一个页面一条记录。 */
  id: string
  scoreId: string
  pageKey: string
  strokes: AnnotationStroke[]
  updatedAt: number
}

/** 一条逐音成绩；只保留结果对话框需要的信息。 */
export interface ScoreRunNote {
  /** 全局音符序号，可用来在乐谱上重新定位。 */
  index: number
  label: string
  hand: number
  outcome: ScoreOutcome
  points: number
  deviationMs: number | null
  /** 实际听到的音名；漏音为 null。 */
  heard: string | null
}

/** 一次评分演奏；每首曲谱可以保留多次记录。 */
export interface ScoreRunRecord {
  id: string
  scoreId: string
  bpm: number
  beats: number
  beatType: number
  handMode: HandMode
  /** 墙钟时间，用于历史列表排序。 */
  startedAt: number
  finishedAt: number
  /** 去掉暂停后的演奏时长。 */
  durationMs: number
  total: number
  perfect: number
  good: number
  missed: number
  wrong: number
  /** 0–100。 */
  accuracy: number
  notes: ScoreRunNote[]
}

export const SCORE_SOURCE_LABELS: Record<ScoreSourceType, string> = {
  camera: '拍摄',
  images: '相册图片',
  pdf: 'PDF',
  musicxml: 'MusicXML'
}

export const RECOGNITION_STATUS_LABELS: Record<RecognitionStatus, string> = {
  processing: '识别中',
  completed: '已完成',
  needsReview: '需要检查',
  failed: '识别失败'
}
