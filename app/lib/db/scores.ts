/**
 * 曲谱仓储：把识别结果/导入结果写成 IndexedDB 里的曲谱，以及书架、详情、删除。
 *
 * 只有这里碰 DOM 的 Blob 与 Canvas：原图、处理后页面和缩略图在进入事务之前就编码
 * 好，事务里只做纯写入。
 */

import { toRaw } from 'vue'
import { HOMR_SOURCE_REVISION, RECOGNITION_MODELS, type RecognitionResult } from '~/lib/homr/recognition'
import { readMusicXmlSource, type ParsedMusicXml } from '~/lib/musicxml/document'
import { deleteBatch, getAllByIndex, getAllRecords, getRecord, writeBatch } from './database'
import type {
  AssetRecord,
  PageRecord,
  RecognitionRecord,
  RecognitionSidecar,
  ScoreDetail,
  ScoreRecord
} from './schema'

/** `segnet / encoder / decoder` 的版本串，写进识别记录。 */
export const MODEL_VERSION = RECOGNITION_MODELS.join('; ')

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('无法编码图片'))
        else resolve(blob)
      },
      type,
      quality
    )
  })
}

async function decodeSize(blob: Blob): Promise<{ width: number, height: number }> {
  const bitmap = await createImageBitmap(blob)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

async function thumbnailFromBlob(blob: Blob, targetWidth = 420): Promise<Blob | null> {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, targetWidth / bitmap.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (context === null) return null
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await canvasToBlob(canvas, 'image/jpeg', 0.72)
  } finally {
    bitmap.close()
  }
}

/** 模型看到的页面（已缩放、增强），在主线程编码成 PNG 后再交给仓储。 */
export interface ProcessedPageImage {
  blob: Blob
  width: number
  height: number
}

export interface RecognizedPageInput {
  /** 用户选中的原始页面；从相册或文件选择拿到的都是一份 Blob。 */
  source: Blob | null
  fileName: string
  result: RecognitionResult
  /** 处理后的页面图片；解码或编码失败时为 null。 */
  processed: ProcessedPageImage | null
}

export interface RecognizedScoreInput {
  title?: string
  /** 按用户选择顺序排列，一页一条。 */
  pages: RecognizedPageInput[]
}

export interface SaveResult {
  scoreId: string
  title: string
}

function recognitionStatusFor(parsed: ParsedMusicXml, withoutPosition: number): ScoreRecord['recognitionStatus'] {
  if (parsed.notes.length === 0) return 'needsReview'
  return withoutPosition > 0 ? 'needsReview' : 'completed'
}

/**
 * 保存一次导入的全部页面。每页存原图、处理后页面和一条识别记录，第一页再生成
 * 书架缩略图；所有写入在一个事务里完成，失败不会留下半份曲谱。
 */
export async function saveRecognizedScore(input: RecognizedScoreInput): Promise<SaveResult> {
  if (input.pages.length === 0) throw new Error('没有可保存的页面')
  // UI 传来的结果通常是 Vue 的响应式代理；IndexedDB 的结构化克隆不认 Proxy。
  const pages = input.pages.map((entry) => {
    const result = toRaw(entry.result)
    return {
      source: entry.source,
      fileName: entry.fileName,
      processed: entry.processed,
      result,
      parsed: readMusicXmlSource(result.musicxml)
    }
  })
  const first = pages[0]
  const now = Date.now()
  const scoreId = newId()
  const assets: AssetRecord[] = []
  const pageRecords: PageRecord[] = []
  const recognitions: RecognitionRecord[] = []

  for (const [index, entry] of pages.entries()) {
    const pageId = newId()
    const recognitionId = newId()
    let originalAssetId: string | null = null
    let processedAssetId: string | null = null

    if (entry.source !== null) {
      const size = await decodeSize(entry.source).catch(() => ({ width: 0, height: 0 }))
      originalAssetId = newId()
      assets.push({
        id: originalAssetId,
        scoreId,
        kind: 'original',
        mimeType: entry.source.type || 'image/jpeg',
        blob: entry.source,
        width: size.width,
        height: size.height,
        createdAt: now
      })
    }

    if (entry.processed !== null) {
      processedAssetId = newId()
      assets.push({
        id: processedAssetId,
        scoreId,
        kind: 'processed',
        mimeType: 'image/png',
        blob: entry.processed.blob,
        width: entry.processed.width,
        height: entry.processed.height,
        createdAt: now
      })
    }

    const result = entry.result
    const sidecar: RecognitionSidecar = {
      title: result.title,
      page: result.page,
      image: result.image,
      scale: result.scale,
      voices: result.voices,
      staffs: result.staffs,
      counts: result.counts,
      timings: result.timings,
      runtime: result.runtime
    }
    recognitions.push({
      id: recognitionId,
      scoreId,
      pageId,
      origin: 'homr',
      musicXml: result.musicxml,
      sidecar,
      noteSymbols: [...result.noteSymbols],
      modelVersion: MODEL_VERSION,
      sourceRevision: HOMR_SOURCE_REVISION,
      status: 'completed',
      createdAt: now
    })
    pageRecords.push({
      id: pageId,
      scoreId,
      pageIndex: index,
      originalAssetId,
      processedAssetId,
      recognitionResultId: recognitionId,
      createdAt: now
    })
  }

  const thumbnailSource = first.processed?.blob ?? first.source
  const thumbnail = thumbnailSource === null ? null : await thumbnailFromBlob(thumbnailSource).catch(() => null)
  let thumbnailAssetId: string | null = null
  if (thumbnail !== null) {
    thumbnailAssetId = newId()
    assets.push({
      id: thumbnailAssetId,
      scoreId,
      kind: 'thumbnail',
      mimeType: 'image/jpeg',
      blob: thumbnail,
      width: 0,
      height: 0,
      createdAt: now
    })
  }

  const title = (input.title ?? '').trim()
    || first.parsed.title.trim()
    || first.result.title
    || first.fileName.replace(/\.[^.]+$/, '')
  const composer = pages.map(entry => entry.parsed.composer).find(value => value !== '') ?? ''
  const needsReview = pages.some(
    entry => recognitionStatusFor(entry.parsed, entry.result.counts.withoutPosition) !== 'completed'
  )
  const score: ScoreRecord = {
    id: scoreId,
    title,
    composer,
    collectionId: null,
    sourceType: 'images',
    scoreFormat: 'image',
    recognitionStatus: needsReview ? 'needsReview' : 'completed',
    pageCount: pages.length,
    noteCount: pages.reduce((total, entry) => total + entry.parsed.notes.length, 0),
    thumbnailAssetId,
    createdAt: now,
    updatedAt: now
  }

  await writeBatch([
    { store: 'scores', records: [score] },
    { store: 'pages', records: pageRecords },
    { store: 'assets', records: assets },
    { store: 'recognitions', records: recognitions }
  ])
  return { scoreId, title }
}

export interface MusicXmlImportInput {
  fileName: string
  musicXml: string
  title?: string
  composer?: string
}

/** 直接导入 MusicXML：没有页面图片，定位只依赖渲染后的 SVG 元素。 */
export async function saveMusicXmlScore(input: MusicXmlImportInput): Promise<SaveResult> {
  const parsed = readMusicXmlSource(input.musicXml)
  const now = Date.now()
  const scoreId = newId()
  const recognitionId = newId()
  const fallbackTitle = input.fileName.replace(/\.[^.]+$/, '')
  const title = (input.title ?? '').trim() || parsed.title.trim() || fallbackTitle
  const composer = (input.composer ?? '').trim() || parsed.composer

  const score: ScoreRecord = {
    id: scoreId,
    title,
    composer,
    collectionId: null,
    sourceType: 'musicxml',
    scoreFormat: 'structured',
    recognitionStatus: parsed.notes.length > 0 ? 'completed' : 'needsReview',
    pageCount: 0,
    noteCount: parsed.notes.length,
    thumbnailAssetId: null,
    createdAt: now,
    updatedAt: now
  }

  const recognition: RecognitionRecord = {
    id: recognitionId,
    scoreId,
    pageId: null,
    origin: 'import',
    musicXml: input.musicXml,
    sidecar: null,
    noteSymbols: [],
    modelVersion: parsed.software ?? 'MusicXML 导入',
    sourceRevision: '—',
    status: 'completed',
    createdAt: now
  }

  await writeBatch([
    { store: 'scores', records: [score] },
    { store: 'recognitions', records: [recognition] }
  ])
  return { scoreId, title }
}

export async function listScores(): Promise<ScoreRecord[]> {
  const scores = await getAllRecords<ScoreRecord>('scores')
  return scores.sort((left, right) => right.updatedAt - left.updatedAt)
}

export interface ShelfData {
  scores: ScoreRecord[]
  /** 缩略图 asset id -> Blob；书架不读原图与处理后页面。 */
  thumbnails: Map<string, Blob>
}

/** 书架列表：只按 id 取缩略图，避免一次把几十 MB 的页面图读进内存。 */
export async function listShelf(): Promise<ShelfData> {
  const scores = await listScores()
  const ids = scores
    .map(score => score.thumbnailAssetId)
    .filter((id): id is string => id !== null)
  const assets = await Promise.all(ids.map(id => getRecord<AssetRecord>('assets', id)))
  const thumbnails = new Map<string, Blob>()
  for (const asset of assets) {
    if (asset !== undefined) thumbnails.set(asset.id, asset.blob)
  }
  return { scores, thumbnails }
}

export async function loadScoreDetail(scoreId: string): Promise<ScoreDetail | null> {
  const score = await getRecord<ScoreRecord>('scores', scoreId)
  if (score === undefined) return null
  const [pageRecords, assets, recognitions] = await Promise.all([
    getAllByIndex<PageRecord>('pages', 'byScore', scoreId),
    getAllByIndex<AssetRecord>('assets', 'byScore', scoreId),
    getAllByIndex<RecognitionRecord>('recognitions', 'byScore', scoreId)
  ])
  const byPage = new Map<string, RecognitionRecord>()
  let structured: RecognitionRecord | null = null
  for (const recognition of recognitions) {
    if (recognition.pageId === null) structured = structured ?? recognition
    else byPage.set(recognition.pageId, recognition)
  }
  const pages = pageRecords
    .sort((left, right) => left.pageIndex - right.pageIndex)
    .map(page => ({ page, recognition: byPage.get(page.id) ?? null }))
  return {
    score,
    pages,
    recognition: structured,
    assets: new Map(assets.map(asset => [asset.id, asset]))
  }
}

export async function updateScoreMeta(
  scoreId: string,
  patch: { title?: string, composer?: string }
): Promise<void> {
  const score = await getRecord<ScoreRecord>('scores', scoreId)
  if (score === undefined) return
  const updated: ScoreRecord = {
    ...score,
    title: patch.title?.trim() || score.title,
    composer: patch.composer === undefined ? score.composer : patch.composer.trim(),
    updatedAt: Date.now()
  }
  await writeBatch([{ store: 'scores', records: [updated] }])
}

/** 删除曲谱连同页面、资源与识别记录。 */
export async function deleteScore(scoreId: string): Promise<void> {
  const [pages, assets, recognitions] = await Promise.all([
    getAllByIndex<PageRecord>('pages', 'byScore', scoreId),
    getAllByIndex<AssetRecord>('assets', 'byScore', scoreId),
    getAllByIndex<RecognitionRecord>('recognitions', 'byScore', scoreId)
  ])
  await deleteBatch([
    { store: 'scores', keys: [scoreId] },
    { store: 'pages', keys: pages.map(page => page.id) },
    { store: 'assets', keys: assets.map(asset => asset.id) },
    { store: 'recognitions', keys: recognitions.map(recognition => recognition.id) }
  ])
}

/** 存储空间不足是最常见的失败原因，给用户一句能行动的话。 */
export function describeStorageError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'QuotaExceededError') {
    return '本机存储空间不足：请删除部分曲谱或清理浏览器数据后重试'
  }
  if (error instanceof Error) return error.message
  return '本地保存失败'
}
