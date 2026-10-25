/**
 * Verovio 排版引擎：把 MusicXML 渲染成 SVG。
 *
 * 构建与 ORT 的做法一致——`scripts/prepare-assets.mjs` 把 `node_modules/verovio/dist`
 * 里的两个文件复制到 `public/verovio/`，运行时用原生 `import()` 取。这样 7 MB 的
 * WASM 不经过打包器，也不会在 SSR 阶段被求值；只有真正打开曲谱页时才加载。
 *
 * 文件名用 `.js` 而不是原包的 `.mjs`：EdgeOne 这类静态托管没给 `.mjs` 配 MIME，
 * 会以 `application/octet-stream` 返回，浏览器按模块脚本加载时直接拒绝。
 *
 * 引擎是单例（Verovio 只允许一个实例），渲染请求串行执行。
 */

const MODULE_URL = '/verovio/verovio-module.js'
const TOOLKIT_URL = '/verovio/verovio.js'

/** 页面宽度按 2100 排版；`svgViewBox` 让 SVG 跟随容器缩放。 */
const RENDER_OPTIONS = {
  scale: 45,
  pageWidth: 2100,
  pageMarginLeft: 40,
  pageMarginRight: 40,
  pageMarginTop: 40,
  pageMarginBottom: 40,
  breaks: 'auto',
  adjustPageHeight: true,
  svgViewBox: true,
  header: 'none',
  footer: 'none',
  justifyVertically: false
} satisfies Record<string, unknown>

export interface VerovioToolkit {
  setOptions(options: Record<string, unknown>): void
  loadData(data: string): number
  renderToSVG(page: number): string
  getPageCount(): number
  getLog(): string
  destroy?(): void
}

type ModuleFactory = () => Promise<unknown>

let toolkit: Promise<VerovioToolkit> | null = null
let queue: Promise<unknown> = Promise.resolve()

export function loadVerovioToolkit(): Promise<VerovioToolkit> {
  if (!import.meta.client) return Promise.reject(new Error('乐谱排版需要在浏览器里进行'))
  toolkit ??= (async () => {
    const factory = (await import(/* @vite-ignore */ MODULE_URL)).default as ModuleFactory
    const wrapper = (await import(/* @vite-ignore */ TOOLKIT_URL)) as {
      VerovioToolkit: new (module: unknown) => VerovioToolkit
    }
    const module = await factory()
    const instance = new wrapper.VerovioToolkit(module)
    instance.setOptions(RENDER_OPTIONS)
    return instance
  })().catch((error: unknown) => {
    toolkit = null
    throw error
  })
  return toolkit
}

export interface RenderedScore {
  /** 每页一个 `<svg>` 元素，拼在一起按页纵向排列。 */
  svg: string
  pages: number
  warnings: string[]
}

function readWarnings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { log?: { message?: string, level?: number }[] }
    const entries = parsed.log ?? []
    return entries
      .map(entry => entry.message?.trim() ?? '')
      .filter(message => message !== '')
      .slice(0, 8)
  } catch {
    return []
  }
}

/**
 * 渲染整份乐谱。加载失败、XML 不被接受时抛出可读的错误，由页面显示并回退到
 * 图像/文本视图，而不是留一张空白页。
 */
export function renderMusicXml(xml: string): Promise<RenderedScore> {
  const run = queue.then(async () => {
    const verovio = await loadVerovioToolkit()
    verovio.setOptions(RENDER_OPTIONS)
    if (verovio.loadData(xml) === 0) {
      // 排版器的原始告警是英文技术细节，留给控制台。
      console.warn('乐谱排版失败', readWarnings(verovio.getLog()))
      throw new Error('这份乐谱内容有误，暂时无法显示')
    }
    const pages = Math.max(1, verovio.getPageCount())
    const parts: string[] = []
    for (let page = 1; page <= pages; page += 1) parts.push(verovio.renderToSVG(page))
    return { svg: parts.join('\n'), pages, warnings: readWarnings(verovio.getLog()) }
  })
  queue = run.catch(() => undefined)
  return run
}
