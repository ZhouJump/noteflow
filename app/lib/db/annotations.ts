/**
 * 乐谱批注：一页一条记录，坐标归一化保存。图片页用 pageId 作 pageKey，
 * 结构化乐谱用 `structured`；换屏幕尺寸或重新渲染都不会丢位置。
 */

import { deleteBatch, getAllByIndex, writeBatch } from './database'
import type { AnnotationRecord, AnnotationStroke } from './schema'

/** 没有图片页的结构化乐谱（MusicXML 导入）的批注键。 */
export const STRUCTURED_PAGE_KEY = 'structured'

export function annotationId(scoreId: string, pageKey: string): string {
  return `${scoreId}:${pageKey}`
}

/** 读取一份曲谱的全部批注，按 pageKey 分组。 */
export async function loadAnnotations(scoreId: string): Promise<Map<string, AnnotationStroke[]>> {
  const records = await getAllByIndex<AnnotationRecord>('annotations', 'byScore', scoreId)
  return new Map(records.map(record => [record.pageKey, record.strokes]))
}

/** 整页写入；清空时直接删记录，避免留下空壳。 */
export async function saveAnnotation(
  scoreId: string,
  pageKey: string,
  strokes: AnnotationStroke[]
): Promise<void> {
  const id = annotationId(scoreId, pageKey)
  if (strokes.length === 0) {
    await deleteBatch([{ store: 'annotations', keys: [id] }])
    return
  }
  // 页面传进来的是 Vue 的响应式数组，IndexedDB 的结构化克隆不收 Proxy；
  // 这里按字段复制成纯对象再写。
  const plain: AnnotationStroke[] = strokes.map(stroke => ({
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map(point => ({ x: point.x, y: point.y }))
  }))
  await writeBatch([{
    store: 'annotations',
    records: [{
      id,
      scoreId,
      pageKey,
      strokes: plain,
      updatedAt: Date.now()
    } satisfies AnnotationRecord]
  }])
}
