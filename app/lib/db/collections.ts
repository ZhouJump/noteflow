/**
 * 谱集仓储：谱架分组、长按拖拽整理与谱集详情。
 *
 * 谱集与曲谱是一对多：曲谱记录 `collectionId`，谱集本身不保存成员列表。
 * 曲谱在谱集内的顺序用 `collectionOrder`，与谱架排序分开保存；删除谱集只把
 * `collectionId` 清空，曲谱仍留在本机。
 */

import { getAllByIndex, getAllRecords, getRecord, writeAndDeleteBatch, writeBatch } from './database'
import { newId } from './ids'
import { makeThumbnail } from './images'
import type { AssetRecord, CollectionRecord, PageRecord, ScoreRecord } from './schema'

export interface ShelfCollection {
  collection: CollectionRecord
  /** 按谱集内顺序排列。 */
  scores: ScoreRecord[]
}

export interface ShelfData {
  collections: ShelfCollection[]
  /** 没有归属谱集的曲谱，按最近更新排序。 */
  standalone: ScoreRecord[]
  /** 缩略图 asset id -> Blob；谱集封面也走这里。 */
  thumbnails: Map<string, Blob>
  /** 独立曲谱的第二页缩略图（scoreId -> Blob）；只有两页及以上的曲谱才有。 */
  backCovers: Map<string, Blob>
}

export interface CollectionDetail {
  collection: CollectionRecord
  scores: ScoreRecord[]
  thumbnails: Map<string, Blob>
}

function inCollection(score: ScoreRecord): string | null {
  return typeof score.collectionId === 'string' && score.collectionId !== '' ? score.collectionId : null
}

function compareCollectionOrder(left: ScoreRecord, right: ScoreRecord): number {
  return (left.collectionOrder ?? 0) - (right.collectionOrder ?? 0)
    || left.createdAt - right.createdAt
}

/** 按 id 取缩略图，避免把几十 MB 的页面原图读进谱架。 */
async function thumbnailsFor(scores: ScoreRecord[], extraIds: string[] = []): Promise<Map<string, Blob>> {
  const ids = [
    ...new Set([
      ...scores
        .map(score => score.thumbnailAssetId)
        .filter((id): id is string => typeof id === 'string'),
      ...extraIds
    ])
  ]
  const assets = await Promise.all(ids.map(id => getRecord<AssetRecord>('assets', id)))
  const thumbnails = new Map<string, Blob>()
  for (const asset of assets) {
    if (asset !== undefined) thumbnails.set(asset.id, asset.blob)
  }
  return thumbnails
}

/**
 * 谱架列表。指向已删除谱集的曲谱会退回独立曲谱，避免数据异常时从谱架上消失。
 */
export async function listShelf(): Promise<ShelfData> {
  const [collections, scores] = await Promise.all([
    getAllRecords<CollectionRecord>('collections'),
    getAllRecords<ScoreRecord>('scores')
  ])
  const known = new Set(collections.map(collection => collection.id))
  const grouped = new Map<string, ScoreRecord[]>()
  const standalone: ScoreRecord[] = []
  for (const score of scores) {
    const collectionId = inCollection(score)
    if (collectionId === null || !known.has(collectionId)) {
      standalone.push(score)
      continue
    }
    const members = grouped.get(collectionId) ?? []
    members.push(score)
    grouped.set(collectionId, members)
  }
  standalone.sort((left, right) => right.updatedAt - left.updatedAt)

  const shelfCollections = collections
    .map(collection => ({
      collection,
      scores: (grouped.get(collection.id) ?? []).sort(compareCollectionOrder)
    }))
    .filter(entry => entry.scores.length > 0)
    .sort((left, right) => right.collection.sortOrder - left.collection.sortOrder
      || right.collection.createdAt - left.collection.createdAt)

  const visible = [...standalone, ...shelfCollections.flatMap(entry => entry.scores)]
  const extraIds = collections
    .map(collection => collection.coverAssetId)
    .filter((id): id is string => typeof id === 'string')
  const [thumbnails, backCovers] = await Promise.all([
    thumbnailsFor(visible, extraIds),
    secondPageThumbnails(standalone)
  ])
  return { collections: shelfCollections, standalone, thumbnails, backCovers }
}

/**
 * 多页曲谱的第二页缩略图：谱架上把它垫在封面下面，一眼看出这是多页的曲谱。
 * 旧数据的页面没有缩略图，直接跳过，不为了这个效果去读原图。
 */
async function secondPageThumbnails(scores: ScoreRecord[]): Promise<Map<string, Blob>> {
  const multi = scores.filter(score => score.pageCount >= 2)
  const pages = await Promise.all(
    multi.map(score => getAllByIndex<PageRecord>('pages', 'byScore', score.id))
  )
  const seconds: { scoreId: string, assetId: string }[] = []
  for (const entries of pages) {
    const page = entries.sort((left, right) => left.pageIndex - right.pageIndex)[1]
    if (page !== undefined && typeof page.thumbnailAssetId === 'string') {
      seconds.push({ scoreId: page.scoreId, assetId: page.thumbnailAssetId })
    }
  }
  const assets = await Promise.all(seconds.map(entry => getRecord<AssetRecord>('assets', entry.assetId)))
  const covers = new Map<string, Blob>()
  for (const [index, asset] of assets.entries()) {
    const entry = seconds[index]
    if (asset !== undefined && entry !== undefined) covers.set(entry.scoreId, asset.blob)
  }
  return covers
}

export async function loadCollection(collectionId: string): Promise<CollectionDetail | null> {
  const collection = await getRecord<CollectionRecord>('collections', collectionId)
  if (collection === undefined) return null
  const scores = await getAllByIndex<ScoreRecord>('scores', 'byCollection', collectionId)
  const ordered = scores.sort(compareCollectionOrder)
  const coverIds = collection.coverAssetId === null ? [] : [collection.coverAssetId]
  return { collection, scores: ordered, thumbnails: await thumbnailsFor(ordered, coverIds) }
}

export interface CollectionChange {
  collectionId: string
  title: string
}

/**
 * 把两首独立曲谱合成一个新谱集。目标曲谱在前，拖过来的曲谱在后；先校验再写，
 * 任何一步失败都不会留下空谱集或只改一半的归属。
 */
export async function createCollectionFromScores(
  targetScoreId: string,
  draggedScoreId: string
): Promise<CollectionChange> {
  if (targetScoreId === draggedScoreId) throw new Error('不能把曲谱拖到它自己身上')
  const [target, dragged] = await Promise.all([
    getRecord<ScoreRecord>('scores', targetScoreId),
    getRecord<ScoreRecord>('scores', draggedScoreId)
  ])
  if (target === undefined || dragged === undefined) throw new Error('曲谱不存在，可能已被删除')
  if (inCollection(target) !== null || inCollection(dragged) !== null) {
    throw new Error('这两首曲谱里已有谱集成员，请刷新后重试')
  }
  const now = Date.now()
  const collection: CollectionRecord = {
    id: newId(),
    title: `${target.title.trim() || '新建'} 谱集`,
    coverAssetId: null,
    sortOrder: now,
    createdAt: now,
    updatedAt: now
  }
  await writeBatch([
    { store: 'collections', records: [collection] },
    {
      store: 'scores',
      records: [
        { ...target, collectionId: collection.id, collectionOrder: 0, updatedAt: now },
        { ...dragged, collectionId: collection.id, collectionOrder: 1, updatedAt: now }
      ]
    }
  ])
  return { collectionId: collection.id, title: collection.title }
}

/** 把曲谱加入谱集；已属于别的谱集时移动过来，仍保持“最多一个谱集”。 */
export async function addScoreToCollection(collectionId: string, scoreId: string): Promise<void> {
  const [collection, score, members] = await Promise.all([
    getRecord<CollectionRecord>('collections', collectionId),
    getRecord<ScoreRecord>('scores', scoreId),
    getAllByIndex<ScoreRecord>('scores', 'byCollection', collectionId)
  ])
  if (collection === undefined) throw new Error('谱集不存在，可能已被删除')
  if (score === undefined) throw new Error('曲谱不存在，可能已被删除')
  const previousId = inCollection(score)
  const previousMembers = previousId === null || previousId === collectionId
    ? []
    : await getAllByIndex<ScoreRecord>('scores', 'byCollection', previousId)
  const emptyPreviousKeys = previousId !== null && previousId !== collectionId
    && previousMembers.every(member => member.id === scoreId)
    ? [previousId]
    : []
  const nextOrder = members.reduce((max, member) => Math.max(max, member.collectionOrder ?? 0), -1) + 1
  const now = Date.now()
  await writeAndDeleteBatch([
    { store: 'scores', records: [{ ...score, collectionId, collectionOrder: nextOrder, updatedAt: now }] },
    { store: 'collections', records: [{ ...collection, updatedAt: now }] }
  ], [
    { store: 'collections', keys: emptyPreviousKeys },
    { store: 'assets', keys: await coverKeysFor(emptyPreviousKeys) }
  ])
}

/** 谱集被删除时，它的封面资源也要一起删，避免留下孤儿图片。 */
async function coverKeysFor(collectionIds: string[]): Promise<string[]> {
  const records = await Promise.all(collectionIds.map(id => getRecord<CollectionRecord>('collections', id)))
  return records
    .map(record => record?.coverAssetId)
    .filter((id): id is string => typeof id === 'string')
}

export interface RemoveResult {
  /** 曲谱原本所属的谱集。 */
  collectionId: string | null
  /** 移出后谱集已空，记录已一起删除。 */
  collectionDeleted: boolean
}

/** 把曲谱移回谱架。谱集空了就一并删除，避免留下没有曲谱的卡片。 */
export async function removeScoreFromCollection(scoreId: string): Promise<RemoveResult> {
  const score = await getRecord<ScoreRecord>('scores', scoreId)
  const collectionId = score === undefined ? null : inCollection(score)
  if (score === undefined || collectionId === null) {
    return { collectionId: null, collectionDeleted: false }
  }
  const members = await getAllByIndex<ScoreRecord>('scores', 'byCollection', collectionId)
  const remaining = members.filter(member => member.id !== scoreId)
  const restored: ScoreRecord = {
    ...score,
    collectionId: null,
    collectionOrder: null,
    updatedAt: Date.now()
  }
  if (remaining.length === 0) {
    // 谱集空了会被删除，封面资源也跟着删。
    await writeAndDeleteBatch(
      [{ store: 'scores', records: [restored] }],
      [
        { store: 'collections', keys: [collectionId] },
        { store: 'assets', keys: await coverKeysFor([collectionId]) }
      ]
    )
    return { collectionId, collectionDeleted: true }
  }
  const collection = await getCollection(collectionId)
  await writeBatch([
    { store: 'scores', records: [restored] },
    { store: 'collections', records: [{ ...collection, updatedAt: Date.now() }] }
  ])
  return { collectionId, collectionDeleted: false }
}

async function getCollection(collectionId: string): Promise<CollectionRecord> {
  const collection = await getRecord<CollectionRecord>('collections', collectionId)
  if (collection === undefined) throw new Error('谱集不存在，可能已被删除')
  return collection
}

export async function renameCollection(collectionId: string, title: string): Promise<string> {
  const trimmed = title.trim()
  if (trimmed === '') throw new Error('谱集名称不能为空')
  const collection = await getCollection(collectionId)
  await writeBatch([
    { store: 'collections', records: [{ ...collection, title: trimmed, updatedAt: Date.now() }] }
  ])
  return trimmed
}

/** 删除谱集，成员全部恢复为独立曲谱；曲谱、页面与成绩都不动。 */
export async function deleteCollection(collectionId: string): Promise<number> {
  const members = await getAllByIndex<ScoreRecord>('scores', 'byCollection', collectionId)
  const now = Date.now()
  const restored = members.map(score => ({
    ...score,
    collectionId: null,
    collectionOrder: null,
    updatedAt: now
  }))
  await writeAndDeleteBatch(
    restored.length > 0 ? [{ store: 'scores', records: restored }] : [],
    [
      { store: 'collections', keys: [collectionId] },
      { store: 'assets', keys: await coverKeysFor([collectionId]) }
    ]
  )
  return restored.length
}

/** 保存谱集封面：缩到 640 宽的 JPEG；换封面时删掉旧图，不让废弃图片占着存储。 */
export async function setCollectionCover(collectionId: string, source: Blob): Promise<void> {
  const collection = await getCollection(collectionId)
  const cover = await makeThumbnail(source, 640).catch(() => null)
  if (cover === null) throw new Error('无法读取这张图片')
  const assetId = newId()
  const now = Date.now()
  const previous = collection.coverAssetId
  await writeAndDeleteBatch(
    [
      {
        store: 'assets',
        records: [{
          id: assetId,
          scoreId: null,
          kind: 'cover',
          mimeType: 'image/jpeg',
          blob: cover,
          width: 0,
          height: 0,
          createdAt: now
        }]
      },
      { store: 'collections', records: [{ ...collection, coverAssetId: assetId, updatedAt: now }] }
    ],
    previous === null ? [] : [{ store: 'assets', keys: [previous] }]
  )
}

/** 去掉自定义封面，谱集卡回到默认的叠纸封面。 */
export async function clearCollectionCover(collectionId: string): Promise<void> {
  const collection = await getCollection(collectionId)
  if (collection.coverAssetId === null) return
  await writeAndDeleteBatch(
    [{ store: 'collections', records: [{ ...collection, coverAssetId: null, updatedAt: Date.now() }] }],
    [{ store: 'assets', keys: [collection.coverAssetId] }]
  )
}
