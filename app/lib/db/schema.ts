/**
 * IndexedDB 实体。开发指引第 16 节建议的模型在这里收敛成四个 store：
 *
 *   scores        曲谱（标题、来源、识别状态、封面缩略图）
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
 * 识别结果只读，导出的是 Worker 写出的原始 MusicXML。谱集、曲谱设置、批注、
 * 练习记录属于后续里程碑；新增 store 时在 `database.ts` 的 `upgrade` 里补上即可。
 */

import type { RecognitionResult } from '~/lib/homr/recognition'

export type ScoreSourceType = 'camera' | 'images' | 'pdf' | 'musicxml'

/** 图片曲谱（页面是图片）或结构化乐谱（直接来自 MusicXML）。 */
export type ScoreFormat = 'image' | 'structured'

export type RecognitionStatus = 'processing' | 'completed' | 'needsReview' | 'failed'

export interface ScoreRecord {
  id: string
  title: string
  composer: string
  /** 谱集功能尚未接入，字段先保留，后续迁移不需要改表。 */
  collectionId: string | null
  sourceType: ScoreSourceType
  scoreFormat: ScoreFormat
  recognitionStatus: RecognitionStatus
  pageCount: number
  /** 乐谱音符数（`<note>` 元素个数），用于书架概览。 */
  noteCount: number
  thumbnailAssetId: string | null
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
  recognitionResultId: string | null
  createdAt: number
}

export type AssetKind = 'original' | 'processed' | 'thumbnail'

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
