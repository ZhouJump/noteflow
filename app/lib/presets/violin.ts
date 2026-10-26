/**
 * 自带曲集：小提琴经典曲集。
 *
 * 预识别结果放在 `public/presets/violin`：manifest 记录曲名、作曲者、MusicXML 与
 * 定位侧车，每页一张 1920 宽的渲染图。首次打开谱架时写入一次 IndexedDB，之后
 * 即使用户删掉谱集也不会再出现；清除浏览器数据后重新导入。
 *
 * 导入后与用户自己识别的曲谱没有区别：页面、缩略图、识别记录都在同一套 store 里，
 * 编辑、跟随、评分与批注照常可用。双谱表的曲目（独奏加钢琴伴奏）默认只跟随上方
 * 旋律，想带着伴奏一起练时在声部筛选里打开另一只手即可。
 */

import { getAllByIndex, getAllRecords, getRecord, writeBatch } from '~/lib/db/database'
import { makeThumbnail } from '~/lib/db/images'
import type {
  AssetRecord,
  CollectionRecord,
  PageRecord,
  RecognitionRecord,
  RecognitionSidecar,
  ScoreRecord,
  ScoreSettingsRecord
} from '~/lib/db/schema'
import { defaultScoreSettings } from '~/lib/db/settings'
import { readMusicXmlSource } from '~/lib/musicxml/document'

const BASE = '/presets/violin'
const COLLECTION_ID = 'preset-violin-classics'
const DONE_KEY = 'noteflow:preset:violin:v1'
/** 双谱表曲目的声部默认值只补一次；导入完成标记仍用 DONE_KEY，删掉的谱集不会回来。 */
const HANDS_KEY = 'noteflow:preset:violin:hands'
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

interface ScoreShape {
  /** 有第二谱表：小提琴曲集里这种曲目是独奏加钢琴伴奏。 */
  twoStaves: boolean
  timeSignature: { beats: number, beatType: number } | null
}

/** 从一页或多页 MusicXML 里读出拍号和第二谱表；解析失败的页跳过。 */
function scoreShape(sources: string[]): ScoreShape {
  let twoStaves = false
  let timeSignature: { beats: number, beatType: number } | null = null
  for (const source of sources) {
    try {
      const parsed = readMusicXmlSource(source)
      timeSignature ??= parsed.timeSignature
      twoStaves ||= parsed.notes.some(note => note.staff > 1)
    } catch {
      // 个别页解析失败不影响其余页的判断。
    }
  }
  return { twoStaves, timeSignature }
}

/** 双谱表曲目的默认声部：只跟随上方旋律；用户自己保存过设置就保持原样。 */
function soloSettings(scoreId: string, shape: ScoreShape): ScoreSettingsRecord | null {
  if (!shape.twoStaves) return null
  return { ...defaultScoreSettings(scoreId, shape.timeSignature), handMode: 'right' }
}

/**
 * 给更新前已经装好的曲集补上双谱表默认声部。不碰已有设置，失败时下次再补；
 * 不用 DONE_KEY，避免把用户删掉的谱集又装回来。
 */
async function applySoloHandDefaults(): Promise<void> {
  try {
    const scores = await getAllRecords<ScoreRecord>('scores')
    const settings: ScoreSettingsRecord[] = []
    for (const score of scores) {
      if (score.collectionId !== COLLECTION_ID) continue
      if (await getRecord<ScoreSettingsRecord>('settings', score.id) !== undefined) continue
      const recognitions = await getAllByIndex<RecognitionRecord>('recognitions', 'byScore', score.id)
      const shape = scoreShape(recognitions.map(record => record.musicXml))
      const value = soloSettings(score.id, shape)
      if (value !== null) settings.push(value)
    }
    if (settings.length > 0) await writeBatch([{ store: 'settings', records: settings }])
    localStorage.setItem(HANDS_KEY, '1')
  } catch {
    // 旧曲谱读不到时下次再试，不影响打开谱架。
  }
}

/**
 * 首次打开谱架时安装自带曲集。失败（离线、资产缺失）不写完成标记，下次再试；
 * 已导入过或验收要求跳过时直接返回 false。
 */
export async function installViolinPreset(): Promise<boolean> {
  if (!import.meta.client) return false
  try {
    if (localStorage.getItem(PRESET_SKIP_KEY) === '1') return false
    if (localStorage.getItem(HANDS_KEY) === null) await applySoloHandDefaults()
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
    const scoreSettings: ScoreSettingsRecord[] = []

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
      const solo = soloSettings(entry.id, scoreShape(entry.pages.map(page => page.recognition.musicXml)))
      if (solo !== null) scoreSettings.push(solo)
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
      { store: 'recognitions', records: recognitions },
      { store: 'settings', records: scoreSettings }
    ])
    localStorage.setItem(DONE_KEY, '1')
    localStorage.setItem(HANDS_KEY, '1')
    return true
  } catch {
    return false
  }
}
