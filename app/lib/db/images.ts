/**
 * 图片编码：把大图等比缩成谱架用的 JPEG。
 *
 * 只用主线程 Canvas，不碰 IndexedDB；调用方拿到 Blob 后自己写进 assets store。
 */

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

/** 按宽度等比缩小并编码成 JPEG；解码失败时抛错，调用方自行决定是否兜底。 */
export async function makeThumbnail(source: Blob, targetWidth = 420): Promise<Blob | null> {
  const bitmap = await createImageBitmap(source)
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
