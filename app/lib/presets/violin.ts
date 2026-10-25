/**
 * 自带曲集：小提琴经典曲集。
 *
 * 预识别结果放在 `public/presets/violin`：manifest 记录曲名、作曲者、MusicXML 与
 * 定位侧车，每页一张 1920 宽的渲染图。首次打开谱架时写入一次 IndexedDB，之后
 * 即使用户删掉谱集也不会再出现；清除浏览器数据后重新导入。
 *
 * 导入后与用户自己识别的曲谱没有区别：页面、缩略图、识别记录都在同一套 store 里，
 * 编辑、跟随、评分与批注照常可用。
 */

import { getRecord, writeBatch } from '~/lib/db/database'
import { makeThumbnail } from '~/lib/db/images'
import type {
  AssetRecord,
  CollectionRecord,
  PageRecord,
  RecognitionRecord,
  RecognitionSidecar,
  ScoreRecord
} from '~/lib/db/schema'
import { readMusicXmlSource } from '~/lib/musicxml/document'

const BASE = '/presets/violin'
const COLLECTION_ID = 'preset-violin-classics'
const DONE_KEY = 'noteflow:preset:violin:v1'
/** 验收脚本写入 1，跳过自带曲集，保证干净库的断言不被影响。 */
export const PRESET_SKIP_KEY = 'noteflow:preset:off'

interface PresetRecognition {
  id: string
  musicXml: string
  sidecar: RecognitionSidecar | null
  noteSymbols: (string | null)[]
  modelVersion: string
  sourceRevision: string
}

interface PresetPage {
  id: string
  image: string
  width: number
  height: number
  recognition: PresetRecognition
}

interface PresetScore {
  id: string
  title: string
  composer: string
  /** 原始 PDF 文件名，留在 manifest 里方便追溯。 */
  source: string
  pages: PresetPage[]
}

interface PresetManifest {
  version: number
  collection: { id: string, title: string }
  cover: string
  scores: PresetScore[]
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`无法加载 ${url}`)
  return response.blob()
}

async function fetchManifest(): Promise<PresetManifest> {
  const response = await fetch(`${BASE}/manifest.json`)
  if (!response.ok) throw new Error('无法加载自带曲集')
  return await response.json() as PresetManifest
}

/** 与保存识别结果的口径一致：没有音符或存在无位置音符时提示需要检查。 */
function statusFor(noteCount: number, withoutPosition: number): ScoreRecord['recognitionStatus'] {
  if (noteCount === 0) return 'needsReview'
  return withoutPosition > 0 ? 'needsReview' : 'completed'
}

/**
 * 首次打开谱架时安装自带曲集。失败（离线、资产缺失）不写完成标记，下次再试；
 * 已导入过或验收要求跳过时直接返回 false。
 */
export async function installViolinPreset(): Promise<boolean> {
  if (!import.meta.client) return false
  try {
    if (localStorage.getItem(PRESET_SKIP_KEY) === '1') return false
    if (localStorage.getItem(DONE_KEY) !== null) return false
    if (await getRecord<CollectionRecord>('collections', COLLECTION_ID) !== undefined) {
      localStorage.setItem(DONE_KEY, '1')
      return false
    }

    const manifest = await fetchManifest()
    const now = Date.now()
    const scores: ScoreRecord[] = []
    const pages: PageRecord[] = []
    const assets: AssetRecord[] = []
    const recognitions: RecognitionRecord[] = []

    const coverBlob = await fetchBlob(`${BASE}/${manifest.cover}`).catch(() => null)
    const coverAssetId = coverBlob === null ? null : `${COLLECTION_ID}-cover`
    if (coverBlob !== null && coverAssetId !== null) {
      assets.push({
        id: coverAssetId,
        scoreId: null,
        kind: 'cover',
        mimeType: 'image/jpeg',
        blob: coverBlob,
        width: 0,
        height: 0,
        createdAt: now
      })
    }

    for (const [scoreIndex, entry] of manifest.scores.entries()) {
      let noteCount = 0
      let withoutPosition = 0
      const scorePages: PageRecord[] = []

      for (const [pageIndex, page] of entry.pages.entries()) {
        const image = await fetchBlob(`${BASE}/${page.image}`)
        const thumbnail = await makeThumbnail(image).catch(() => null)
        const imageAssetId = `${page.id}-image`
        const thumbnailAssetId = thumbnail === null ? null : `${page.id}-thumbnail`

        assets.push({
          id: imageAssetId,
          scoreId: entry.id,
          kind: 'original',
          mimeType: 'image/jpeg',
          blob: image,
          width: page.width,
          height: page.height,
          createdAt: now
        })
        if (thumbnail !== null && thumbnailAssetId !== null) {
          assets.push({
            id: thumbnailAssetId,
            scoreId: entry.id,
            kind: 'thumbnail',
            mimeType: 'image/jpeg',
            blob: thumbnail,
            width: 0,
            height: 0,
            createdAt: now
          })
        }

        recognitions.push({
          id: page.recognition.id,
          scoreId: entry.id,
          pageId: page.id,
          origin: 'homr',
          musicXml: page.recognition.musicXml,
          sidecar: page.recognition.sidecar,
          noteSymbols: page.recognition.noteSymbols,
          modelVersion: page.recognition.modelVersion,
          sourceRevision: page.recognition.sourceRevision,
          status: 'completed',
          createdAt: now
        })
        scorePages.push({
          id: page.id,
          scoreId: entry.id,
          pageIndex,
          originalAssetId: imageAssetId,
          processedAssetId: null,
          thumbnailAssetId,
          recognitionResultId: page.recognition.id,
          createdAt: now
        })

        try {
          noteCount += readMusicXmlSource(page.recognition.musicXml).notes.length
        } catch {
          // 个别页解析失败不影响整首曲谱的导入；识别记录原文仍然保留。
        }
        withoutPosition += page.recognition.sidecar?.counts.withoutPosition ?? 0
      }

      pages.push(...scorePages)
      scores.push({
        id: entry.id,
        title: entry.title,
        composer: entry.composer,
        collectionId: COLLECTION_ID,
        collectionOrder: scoreIndex,
        sourceType: 'pdf',
        scoreFormat: 'image',
        recognitionStatus: statusFor(noteCount, withoutPosition),
        pageCount: scorePages.length,
        noteCount,
        thumbnailAssetId: scorePages[0]?.thumbnailAssetId ?? null,
        createdAt: now + scoreIndex,
        updatedAt: now + scoreIndex
      })
    }

    const collection: CollectionRecord = {
      id: COLLECTION_ID,
      title: manifest.collection.title,
      coverAssetId,
      // 自带曲集排在用户已有谱集之前，首次打开就能看到。
      sortOrder: now,
      createdAt: now,
      updatedAt: now
    }
    await writeBatch([
      { store: 'collections', records: [collection] },
      { store: 'scores', records: scores },
      { store: 'pages', records: pages },
      { store: 'assets', records: assets },
      { store: 'recognitions', records: recognitions }
    ])
    localStorage.setItem(DONE_KEY, '1')
    return true
  } catch {
    return false
  }
}
