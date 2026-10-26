/**
 * 自带曲集：钢琴经典曲集与小提琴经典曲集。
 *
 * 每个曲集在 `public/presets/<曲集>` 下放一份 manifest：曲名、作曲者与统计，
 * `*.musicxml` 是压掉空白的乐谱原文，`*.svg` 是 Verovio 渲染的首页预览，直接当
 * 谱架缩略图。首次打开谱架时逐个写进 IndexedDB，之后即使用户删掉谱集也不会再出现；
 * 清除浏览器数据后重新导入。
 *
 * 导入后与用户自己导入的 MusicXML 没有区别：只有一条 pageId 为 null 的识别记录，
 * 版面由 Verovio 现场排版，跟随、评分与批注照常可用。
 */

import { deleteBatch, getAllByIndex, getRecord, writeBatch } from '~/lib/db/database'
import { deleteScore } from '~/lib/db/scores'
import type { AssetRecord, CollectionRecord, RecognitionRecord, ScoreRecord } from '~/lib/db/schema'

interface PresetFamily {
  /** manifest 与乐谱所在的目录。 */
  base: string
  /** 安装成功后写下的标记，避免重复导入。 */
  doneKey: string
  /** 谱集记录 id；manifest 里的 id 必须与之一致。 */
  collectionId: string
}

const PIANO: PresetFamily = {
  base: '/presets/piano',
  doneKey: 'noteflow:preset:piano:v1',
  collectionId: 'preset-piano-classics'
}

const VIOLIN: PresetFamily = {
  base: '/presets/violin',
  doneKey: 'noteflow:preset:violin:v1',
  collectionId: 'preset-violin-solo'
}

/** 上一版自带的小提琴曲集是图片识别出来的，换成 MusicXML 后清掉，谱架上不留两份。 */
const LEGACY_COLLECTION_ID = 'preset-violin-classics'
const LEGACY_KEY = 'noteflow:preset:violin:removed'
/** 验收脚本写入 1，跳过自带曲集，保证干净库的断言不被影响。 */
export const PRESET_SKIP_KEY = 'noteflow:preset:off'

/** 一首曲目在 manifest 里的样子，数值由 `scripts/build-preset.mjs` 统计写入。 */
interface PresetScore {
  id: string
  title: string
  composer: string
  /** 作品号，例如 BWV 1004；卡片上不显示，留在数据里便于追溯。 */
  note: string
  file: string
  preview: string
  notes: number
  measures: number
  staves: number
  /** Verovio 排出来的页数，只用于核对。 */
  pages: number
  time: { beats: number, beatType: number } | null
  source: string
  license: string
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`无法加载 ${url}`)
  return await response.text()
}

async function fetchManifest(base: string): Promise<PresetManifest> {
  const response = await fetch(`${base}/manifest.json`)
  if (!response.ok) throw new Error('无法加载自带曲集')
  return await response.json() as PresetManifest
}

/**
 * 删掉上一版自带的小提琴曲集。它整份都是预置内容，用户最多在上面写过批注或
 * 成绩；换成新的 MusicXML 曲集后留着只会让谱架上出现两份示例。失败时下次再试，
 * 不影响打开谱架。
 */
async function removeLegacyImageCollection(): Promise<void> {
  try {
    const collection = await getRecord<CollectionRecord>('collections', LEGACY_COLLECTION_ID)
    if (collection !== undefined) {
      const scores = await getAllByIndex<ScoreRecord>('scores', 'byCollection', LEGACY_COLLECTION_ID)
      for (const score of scores) await deleteScore(score.id)
      // deleteScore 只在最后一首删完时带走谱集记录，封面资源不归它管，这里补一刀。
      await deleteBatch([
        { store: 'collections', keys: [LEGACY_COLLECTION_ID] },
        { store: 'assets', keys: collection.coverAssetId === null ? [] : [collection.coverAssetId] }
      ])
    }
    localStorage.setItem(LEGACY_KEY, '1')
  } catch {
    // 旧曲集读不到时下次再试。
  }
}

/**
 * 安装一个曲集。失败（离线、资产缺失）不写完成标记，下次再试；已导入过或验收
 * 要求跳过时直接返回 false。
 */
async function installFamily(family: PresetFamily): Promise<boolean> {
  if (!import.meta.client) return false
  try {
    if (localStorage.getItem(PRESET_SKIP_KEY) === '1') return false
    if (localStorage.getItem(LEGACY_KEY) === null) await removeLegacyImageCollection()
    if (localStorage.getItem(family.doneKey) !== null) return false
    if (await getRecord<CollectionRecord>('collections', family.collectionId) !== undefined) {
      localStorage.setItem(family.doneKey, '1')
      return false
    }

    const manifest = await fetchManifest(family.base)
    if (manifest.collection.id !== family.collectionId) throw new Error('manifest 与谱集 id 不一致')
    const now = Date.now()
    const scores: ScoreRecord[] = []
    const assets: AssetRecord[] = []
    const recognitions: RecognitionRecord[] = []

    const cover = await fetchBlob(`${family.base}/${manifest.cover}`).catch(() => null)
    const coverAssetId = cover === null ? null : `${family.collectionId}-cover`
    if (cover !== null && coverAssetId !== null) {
      assets.push({
        id: coverAssetId,
        scoreId: null,
        kind: 'cover',
        mimeType: cover.type || 'image/webp',
        blob: cover,
        width: 0,
        height: 0,
        createdAt: now
      })
    }

    for (const [scoreIndex, entry] of manifest.scores.entries()) {
      const musicXml = await fetchText(`${family.base}/${entry.file}`)
      const preview = await fetchBlob(`${family.base}/${entry.preview}`).catch(() => null)
      const previewAssetId = preview === null ? null : `${entry.id}-preview`
      if (preview !== null && previewAssetId !== null) {
        assets.push({
          id: previewAssetId,
          scoreId: entry.id,
          kind: 'thumbnail',
          mimeType: preview.type || 'image/svg+xml',
          blob: preview,
          width: 0,
          height: 0,
          createdAt: now
        })
      }

      recognitions.push({
        id: `${entry.id}-recognition`,
        scoreId: entry.id,
        pageId: null,
        origin: 'import',
        musicXml,
        sidecar: null,
        noteSymbols: [],
        modelVersion: `MusicXML · 公有领域（${entry.license}）`,
        sourceRevision: entry.source,
        status: 'completed',
        createdAt: now
      })
      scores.push({
        id: entry.id,
        title: entry.title,
        composer: entry.composer,
        collectionId: family.collectionId,
        collectionOrder: scoreIndex,
        sourceType: 'musicxml',
        scoreFormat: 'structured',
        recognitionStatus: entry.notes > 0 ? 'completed' : 'needsReview',
        pageCount: 0,
        noteCount: entry.notes,
        thumbnailAssetId: previewAssetId,
        createdAt: now + scoreIndex,
        updatedAt: now + scoreIndex
      })
    }

    const collection: CollectionRecord = {
      id: family.collectionId,
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
      { store: 'assets', records: assets },
      { store: 'recognitions', records: recognitions }
    ])
    localStorage.setItem(family.doneKey, '1')
    return true
  } catch {
    return false
  }
}

export async function installPianoPreset(): Promise<boolean> {
  return await installFamily(PIANO)
}

export async function installViolinPreset(): Promise<boolean> {
  return await installFamily(VIOLIN)
}
