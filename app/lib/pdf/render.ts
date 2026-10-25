/**
 * PDF 导入：用 PDF.js 把每一页渲染成 JPEG，再交给统一的图片识别流程。
 *
 * PDF.js 的主库、Worker、字体与 CMap 都放在 `public/pdf/`（脚本落成 `.js`），
 * 运行时才按需加载：不打进首屏包，也避开静态托管对 `.mjs` 的 MIME 问题。
 * 只做页面渲染，不尝试从矢量 PDF 里提取音符——扫描件与排版文件都按图片识别。
 */

/** 与样例图一致的页面宽度：HOMR 在这附近的字号上表现最稳。 */
const PAGE_WIDTH = 1920
/** 一次导入的页数上限：整批页面要在内存里等到识别结束。 */
const MAX_PAGES = 30

interface PdfRenderTask {
  promise: Promise<void>
}

interface PdfViewport {
  width: number
  height: number
}

interface PdfPage {
  getViewport: (options: { scale: number }) => PdfViewport
  render: (options: { canvasContext: CanvasRenderingContext2D, viewport: PdfViewport }) => PdfRenderTask
  cleanup: () => void
}

interface PdfDocument {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPage>
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>
  /** 关闭文档与 Worker；PDF.js 6 起只有这里能销毁。 */
  destroy: () => Promise<void>
}

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument: (options: {
    data: Uint8Array
    isEvalSupported: boolean
    cMapUrl: string
    cMapPacked: boolean
    standardFontDataUrl: string
    wasmUrl: string
  }) => PdfLoadingTask
}

export interface RenderedPage {
  name: string
  file: Blob
}

export interface RenderedPdf {
  pages: RenderedPage[]
  /** PDF 的总页数；超过上限时只有前 30 页进了 `pages`。 */
  total: number
  truncated: boolean
}

export interface PdfProgress {
  done: number
  total: number
}

/**
 * 逐页渲染 PDF。页面按原始顺序返回，文件名带上页码；
 * 页数超过上限时只渲染前 30 页，`truncated` 用来提示用户。
 */
export async function renderPdfPages(
  file: File,
  onProgress?: (progress: PdfProgress) => void
): Promise<RenderedPdf> {
  if (!import.meta.client) return { pages: [], total: 0, truncated: false }
  // 静态 URL 交给运行时解析：路径写进变量，类型检查才不会去 node_modules 里找它。
  const moduleUrl = '/pdf/pdf.min.js'
  const pdfjs = await import(/* @vite-ignore */ moduleUrl) as unknown as PdfJs
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.js'

  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: '/pdf/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdf/standard_fonts/',
    wasmUrl: '/pdf/wasm/'
  })
  const pdf = await loadingTask.promise

  const baseName = file.name.replace(/\.pdf$/i, '') || 'PDF'
  const total = pdf.numPages
  const count = Math.min(total, MAX_PAGES)
  const pages: RenderedPage[] = []

  try {
    for (let number = 1; number <= count; number += 1) {
      onProgress?.({ done: number - 1, total: count })
      const page = await pdf.getPage(number)
      try {
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: PAGE_WIDTH / base.width })
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('无法创建 2D 画布')
        // PDF 页面背景透明，先铺白底，避免识别时把透明区当成黑色。
        context.fillStyle = '#fff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvasContext: context, viewport }).promise
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
        if (blob === null) throw new Error(`第 ${number} 页编码失败`)
        pages.push({ name: `${baseName}-${number}.jpg`, file: blob })
        canvas.width = 0
        canvas.height = 0
      } finally {
        await page.cleanup()
      }
    }
  } finally {
    await loadingTask.destroy()
  }

  onProgress?.({ done: count, total: count })
  return { pages, total, truncated: total > count }
}
