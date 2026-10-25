import type { ProcessedPageImage } from '~/lib/db/scores'
import { STAGE_LABELS, STAGE_SPAN, type PagePreview, type RecognitionResult, type RecognitionStage } from '~/lib/homr/recognition'

/** 一页识别完成后留在主线程的草稿：原图、处理图与识别结果。 */
export interface RecognizedPageDraft {
  source: Blob
  fileName: string
  result: RecognitionResult
  processed: ProcessedPageImage | null
}

export interface RecognitionInput {
  file: Blob
  name: string
}

/**
 * 把页面图片依次交给 HOMR Worker，并跟踪阶段、预览和每页结果。
 *
 * Worker 与模型在多次识别之间复用，模型只加载一次；页面必须一页接一页地发，
 * 因为 Worker 的消息处理是并发的。每页识别完成后立刻把模型看到的页面编码成
 * PNG，避免把多页 RGB 同时留在内存里。
 *
 * 只在浏览器里运行：Worker、画布与图片解码都在 `recognizeFiles()` 被调用时才创建，
 * 因此页面可以在 SSR 阶段安全地导入这个 composable。
 */
export function useHomrRecognition() {
  const worker = shallowRef<Worker | null>(null)
  const running = ref(false)
  const stage = ref<RecognitionStage | null>(null)
  const detail = ref<{ done: number, total: number }>({ done: 0, total: 0 })
  const preview = ref<PagePreview | null>(null)
  const result = ref<RecognitionResult | null>(null)
  const error = ref<string | null>(null)
  const fileName = ref('')
  const pages = ref<RecognizedPageDraft[]>([])
  const total = ref(0)
  const currentIndex = ref(0)

  let pending: { resolve: (value: RecognitionResult) => void, reject: (error: Error) => void } | null = null

  const stageLabel = computed(() => (stage.value ? STAGE_LABELS[stage.value] : ''))
  const currentFraction = computed(() => {
    if (!running.value || !stage.value) return 0
    const [start, end] = STAGE_SPAN[stage.value]
    if (end - start <= 0 || detail.value.total <= 0) return end
    return start + (end - start) * Math.min(1, detail.value.done / detail.value.total)
  })
  /** 已完成的页加上当前页进度，再除以总页数。 */
  const fraction = computed(() => {
    if (total.value === 0) return 0
    return Math.min(1, (pages.value.length + currentFraction.value) / total.value)
  })

  function fail(message: string): void {
    error.value = message
    const current = pending
    pending = null
    current?.reject(new Error(message))
    running.value = false
  }

  function ensureWorker(): Worker {
    if (worker.value) return worker.value
    const instance = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), {
      type: 'module'
    })
    instance.addEventListener('message', (event: MessageEvent) => {
      const data = event.data
      if (data.type === 'progress') {
        stage.value = data.stage as RecognitionStage
        detail.value = { done: data.done, total: data.total }
        return
      }
      if (data.type === 'page-done') {
        preview.value = {
          width: data.width,
          height: data.height,
          rgb: new Uint8Array(data.rgb),
          mask: new Uint8Array(data.mask),
          histogram: data.histogram,
          timings: data.timings
        }
        return
      }
      if (data.type === 'result') {
        const output = data as RecognitionResult
        result.value = output
        const current = pending
        pending = null
        current?.resolve(output)
        return
      }
      if (data.type === 'error') {
        fail(data.message as string)
      }
    })
    // Worker 脚本本身加载失败（模块解析、wasm 初始化）时不会走 message，只能靠 error 事件。
    instance.addEventListener('error', (event) => {
      const failure = event as ErrorEvent
      const where = failure.filename ? `（${failure.filename}:${failure.lineno}）` : ''
      fail(`Worker 加载失败：${failure.message || '脚本无法执行'}${where}`)
    })
    instance.addEventListener('messageerror', () => {
      fail('Worker 无法解析主线程发来的数据')
    })
    worker.value = instance
    return instance
  }

  function reset(): void {
    result.value = null
    preview.value = null
    stage.value = null
    detail.value = { done: 0, total: 0 }
    error.value = null
    pages.value = []
    total.value = 0
    currentIndex.value = 0
  }

  /** 放弃当前任务：Worker 直接终止，模型缓存也随之释放，下次识别会重新加载。 */
  function cancel(): void {
    if (!running.value) return
    worker.value?.terminate()
    worker.value = null
    fail('已取消识别')
  }

  async function drawToBuffer(blob: Blob): Promise<ImageData> {
    const bitmap = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('无法创建 2D 画布')
      context.drawImage(bitmap, 0, 0)
      return context.getImageData(0, 0, bitmap.width, bitmap.height)
    } finally {
      bitmap.close()
    }
  }

  /** 把模型看到的 1920px 页面编码成 PNG，RGB 随后就可以释放。 */
  async function encodePreview(page: PagePreview): Promise<ProcessedPageImage | null> {
    const image = new ImageData(page.width, page.height)
    for (let i = 0, p = 0, q = 0; i < page.width * page.height; i += 1, p += 4, q += 3) {
      image.data[p] = page.rgb[q]
      image.data[p + 1] = page.rgb[q + 1]
      image.data[p + 2] = page.rgb[q + 2]
      image.data[p + 3] = 255
    }
    const canvas = document.createElement('canvas')
    canvas.width = page.width
    canvas.height = page.height
    const context = canvas.getContext('2d')
    if (context === null) return null
    context.putImageData(image, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    return blob === null ? null : { blob, width: page.width, height: page.height }
  }

  function recognizeOne(file: Blob, name: string): Promise<RecognitionResult> {
    const image = drawToBuffer(file)
    return image.then((data) => {
      const instance = ensureWorker()
      return new Promise<RecognitionResult>((resolve, reject) => {
        pending = { resolve, reject }
        try {
          instance.postMessage(
            { type: 'page', rgba: data.data.buffer, width: data.width, height: data.height, name },
            [data.data.buffer]
          )
        } catch (exception) {
          pending = null
          reject(exception as Error)
        }
      })
    })
  }

  /**
   * 顺序识别选中的页面。任何一页失败就停下，已完成的页保留在 `pages` 里；
   * 用户重新选择后会清空重来。
   */
  async function recognizeFiles(inputs: RecognitionInput[]): Promise<void> {
    reset()
    if (inputs.length === 0) return
    total.value = inputs.length
    running.value = true
    for (const [index, input] of inputs.entries()) {
      currentIndex.value = index
      fileName.value = input.name
      stage.value = null
      detail.value = { done: 0, total: 0 }
      preview.value = null
      result.value = null
      try {
        const output = await recognizeOne(input.file, input.name)
        const processed = preview.value === null ? null : await encodePreview(preview.value)
        pages.value = [...pages.value, { source: input.file, fileName: input.name, result: output, processed }]
        preview.value = null
      } catch (exception) {
        error.value = (exception as Error).message
        running.value = false
        return
      }
    }
    running.value = false
  }

  if (getCurrentScope()) onScopeDispose(() => worker.value?.terminate())

  return {
    running,
    stage,
    stageLabel,
    detail,
    currentIndex,
    fraction,
    preview,
    result,
    error,
    fileName,
    pages,
    total,
    recognizeFiles,
    cancel,
    reset
  }
}
