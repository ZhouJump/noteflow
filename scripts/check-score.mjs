/**
 * M5 验收：用真实 Chromium 走一遍「选两页图片 → 拖动排序 → 识别 → 保存到谱架 →
 * 纵向翻看 → 点选音符 → 侧栏控件 → 节拍器与批注 → 导入 MusicXML → 谱集整理 →
 * 多页 PDF 导入」。
 *
 *   node scripts/check-score.mjs [--url http://127.0.0.1:3000]
 *                                [--image <第一页>] [--image2 <第二页>]
 *                                [--musicxml <基准>] [--pdf <多页 PDF>]
 *                                [--out reference/artifacts/m5]
 *
 * 先启动开发服务器（pnpm dev），再运行本脚本。脚本只验证真实运行：
 *   - 选页后仍能继续添加，长按拖动可以调整页面顺序；
 *   - 选中的两页按顺序识别完成，保存成同一份曲谱；
 *   - 每一页都有自己的 RecognitionRecord，第一页 MusicXML 与界面展示逐字节一致；
 *   - 曲谱页两页纵向排开，没有翻页按钮与页码，切页后音符编号是全局的；
 *   - 点页面图上的音符能显示音高、时值，SVG 选中圈落在符头上；
 *   - 节拍器、声部、跟随与批注控件分居乐谱两侧；
 *   - BPM 与批注写入 IndexedDB，刷新后恢复；
 *   - 谱架出现刚保存的曲谱；
 *   - MusicXML 导入走同一个曲谱页，没有页面图与纵向页容器；
 *   - 长按拖动可把两首独立曲谱组成谱集，拖到谱集卡可加入，删除谱集后曲谱回到谱架；
 *   - 多页 PDF 逐页渲染成缩略图，识别后保存成同一份两页曲谱；
 *   - 首次打开自动安装自带的「钢琴经典曲集」与「小提琴经典曲集」（结构化 MusicXML），
 *     曲名与作曲家分开保存。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const firstImage = path.resolve(flag('--image', path.join(root, 'reference/samples/input/永远同在1.jpg')))
const secondImage = path.resolve(flag('--image2', path.join(root, 'reference/samples/input/永远同在2.jpg')))
const page = path.basename(firstImage, path.extname(firstImage))
// MusicXML 只当导入用例：优先用参考实现的产物，新环境里没有就退回入库的 expected。
const musicxmlCandidates = [
  path.join(root, 'reference/artifacts/browser', page, `${page}.musicxml`),
  path.join(root, 'reference/samples/expected', page, `${page}.musicxml`)
]
const musicxmlPath = path.resolve(
  flag('--musicxml', musicxmlCandidates.find(file => fs.existsSync(file)) ?? musicxmlCandidates[0])
)
const pdfPath = path.resolve(flag('--pdf', path.join(root, 'reference/samples/input/永远同在1.pdf')))
const base = flag('--url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const outDir = path.resolve(flag('--out', path.join(root, 'reference/artifacts/m5')), page)
/** 默认用系统 Edge；Windows 上的安装路径不在 PATH 里，按常见位置找一次。 */
function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER
  if (process.platform !== 'win32') return '/usr/bin/microsoft-edge'
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ]
  return candidates.find(file => fs.existsSync(file)) ?? 'msedge'
}

const BROWSER = findBrowser()
const PORT = Number(process.env.CDP_PORT ?? 9335)
const TIMEOUT = Number(process.env.TIMEOUT ?? 20 * 60_000)

if (!fs.existsSync(firstImage)) throw new Error(`图片不存在：${firstImage}`)
if (!fs.existsSync(secondImage)) throw new Error(`第二页图片不存在：${secondImage}`)
if (!fs.existsSync(musicxmlPath)) throw new Error(`MusicXML 不存在：${musicxmlPath}`)
if (!fs.existsSync(pdfPath)) throw new Error(`PDF 不存在：${pdfPath}`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`timeout: ${label}${lastError ? `（${lastError.message}）` : ''}`)
}

// 临时目录用系统默认：Linux 上是 /tmp，Windows 上不会因为 /tmp 不存在而 ENOENT。
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'noteflow-m5-'))

/** 自动滚动验收用静音“麦克风”，让练习停在当前目标而不是被假音推进。 */
function writeSilence(file) {
  const sampleRate = 48_000
  const seconds = 60
  const data = Buffer.alloc(sampleRate * seconds * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}
const silencePath = path.join(profile, 'silence.wav')
writeSilence(silencePath)

const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${silencePath}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
)
// 临时 profile 有几百 MB：退出时连同浏览器一起清理，避免 /tmp 被历次验收堆满。
// 浏览器刚被 SIGKILL 时目录里可能还在写入，删除要带重试且不能把退出钩子拖崩。
process.on('exit', () => {
  browser.kill('SIGKILL')
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // 剩下一点临时文件交给系统回收，不影响验收结果。
  }
})

await waitFor(async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
  return (await response.json()).webSocketDebuggerUrl
}, 30_000, 'devtools endpoint')

const targets = await waitFor(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const found = list.filter(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
  return found.length > 0 ? found : null
}, 30_000, 'page target')

const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    console.log(`[page error] ${details.exception?.description ?? details.text}`)
  }
})
// 浏览器崩溃时连接会直接断开：让挂起的命令立刻失败，而不是停在 unsettled await。
socket.addEventListener('close', () => {
  for (const { reject } of pending.values()) reject(new Error('浏览器连接已断开'))
  pending.clear()
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = (nextId += 1)
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const text = selector =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`)

const count = selector =>
  evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)

async function click(selector) {
  const clicked = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    element.scrollIntoView({ block: 'center' })
    if (element instanceof HTMLElement) element.click()
    else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  })()`)
  if (!clicked) throw new Error(`元素不存在：${selector}`)
}

async function attachFiles(selector, files) {
  const { root: documentRoot } = await send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector })
  if (!nodeId) throw new Error(`file input 不存在：${selector}`)
  await send('DOM.setFileInputFiles', { nodeId, files })
  // 部分 Chromium 构建只写入 files 而不派发 change；页面处理后会清空 input，重复派发无副作用。
  await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (input && input.files && input.files.length > 0) {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })()`)
}

/** 缩略图当前顺序（文件名），用来验证拖动排序。 */
const pageOrder = () =>
  evaluate(`[...document.querySelectorAll('[data-page-id]')].map(item => item.dataset.pageName)`)

async function tileCenter(index) {
  return evaluate(`(() => {
    const element = document.querySelectorAll('[data-page-id]')[${index}]
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
}

/** 用真实鼠标事件模拟长按拖动，覆盖缩略图的排序手势。 */
async function dragPage(from, to) {
  const start = await tileCenter(from)
  const end = await tileCenter(to)
  if (start === null || end === null) throw new Error('缩略图不存在')
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(450)
  for (let step = 1; step <= 6; step += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + ((end.x - start.x) * step) / 6,
      y: start.y + ((end.y - start.y) * step) / 6,
      button: 'left',
      buttons: 1
    })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(150)
}

/** 元素中心点；先滚到视口中央，避免卡片在屏幕外。 */
function centerOf(selector) {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    element.scrollIntoView({ block: 'center' })
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
}

/** 长按 500ms 后拖到目标点；谱架与谱集页的整理手势都走这一条路径。
 *  `probe` 在进入拖拽、尚未松手时执行，用来检查拖拽中的 ghost。 */
async function longPressDrag(start, end, probe) {
  if (start === null || end === null) throw new Error('拖动起点或终点不存在')
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(500)
  if (probe !== undefined) await probe()
  for (let step = 1; step <= 8; step += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + ((end.x - start.x) * step) / 8,
      y: start.y + ((end.y - start.y) * step) / 8,
      button: 'left',
      buttons: 1
    })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(400)
}

/** 长按谱集页的曲谱，等移出区域出现后拖进去。 */
async function dragToRemoveZone(selector) {
  const start = await centerOf(selector)
  if (start === null) throw new Error(`曲谱卡片不存在：${selector}`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(500)
  const zone = await waitFor(() => evaluate(`(() => {
    const element = document.querySelector('[data-test="collection-remove-zone"]')
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`), 5_000, 'remove zone')
  for (let step = 1; step <= 8; step += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + ((zone.x - start.x) * step) / 8,
      y: start.y + ((zone.y - start.y) * step) / 8,
      button: 'left',
      buttons: 1
    })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: zone.x, y: zone.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(400)
}

/** 打开页面并等 Vue 挂载。整页导航会销毁执行上下文，因此这里不做失败重试之外的假设。 */
async function open(target) {
  await send('Page.navigate', { url: `${base}${target}` })
  await waitFor(() => evaluate('document.readyState === \'complete\''), 60_000, `load ${target}`)
  await waitFor(() => evaluate('Boolean(document.querySelector("#__nuxt")?.__vue_app__)'), 60_000, `vue ${target}`)
  await sleep(300)
}

/** 在指定页的页面图上按侧车坐标点一下，选中最接近的音符。 */
async function clickPagePoint(point, pageIndex = 0) {
  const located = await evaluate(`(() => {
    const element = document.querySelectorAll('[data-test="page-image"]')[${pageIndex}]
    if (!element) return false
    element.scrollIntoView({ block: 'center' })
    return true
  })()`)
  if (!located) return false
  await sleep(350)
  const position = await evaluate(`(() => {
    const element = document.querySelectorAll('[data-test="page-image"]')[${pageIndex}]
    if (!element) return null
    const pageWidth = Number(element.dataset.pageWidth)
    const rect = element.getBoundingClientRect()
    if (!pageWidth || rect.width === 0) return null
    const scale = rect.width / pageWidth
    return {
      x: rect.left + ${point.x} * scale,
      y: rect.top + ${point.y} * scale
    }
  })()`)
  if (position === null) return false
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: position.x, y: position.y, button: 'left', buttons: 1, clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: position.x, y: position.y, button: 'left', buttons: 0, clickCount: 1
  })
  return true
}

/** 选中后 SVG 圆环的页面坐标；用来确认它确实落在符头定位点上。 */
function selectionRing(pageIndex) {
  return evaluate(`(() => {
    const page = document.querySelectorAll('[data-page-index]')[${pageIndex}]
    const ring = page?.querySelector('[data-test="selection-ring"]')
    if (!ring) return null
    return { cx: Number(ring.getAttribute('cx')), cy: Number(ring.getAttribute('cy')) }
  })()`)
}

/** 页面图缩略显示尺寸 ≠ 页面像素：用 data-page-width 换算点击坐标。 */
function pageImageSize(index) {
  return evaluate(`(() => {
    const element = document.querySelectorAll('[data-test="page-image"]')[${index}]
    return element && element.naturalWidth > 0
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : null
  })()`)
}

/** 滚动到某一页中间，供批注拖拽使用。 */
async function centerPage(index) {
  await evaluate(`document.querySelectorAll('[data-page-index]')[${index}]?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
}

/** 在页面上用指针拖一条线；坐标是页面容器的 0–1 比例。 */
async function drawStroke(pageIndex, points) {
  const box = await evaluate(`(() => {
    const page = document.querySelectorAll('[data-page-index]')[${pageIndex}]
    const layer = page?.querySelector('[data-test="annotation-layer"]')
    if (!layer) return null
    const rect = layer.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })()`)
  if (box === null) return false
  const at = ([x, y]) => ({ x: box.left + box.width * x, y: box.top + box.height * y })
  const first = at(points[0])
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1
  })
  for (const point of points.slice(1)) {
    const position = at(point)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: position.x, y: position.y, button: 'left', buttons: 1
    })
    await sleep(30)
  }
  const last = at(points[points.length - 1])
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1
  })
  return true
}

/** 从 IndexedDB 读回一份曲谱的页面与识别记录（含第一个音落在页面上的坐标）。 */
function readScore(scoreId) {
  return evaluate(`(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noteflow')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readAll = store => new Promise((resolve, reject) => {
      const request = database.transaction(store, 'readonly').objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const [scores, pages, recognitions, annotations] = await Promise.all([
      readAll('scores'),
      readAll('pages'),
      readAll('recognitions'),
      readAll('annotations')
    ])
    database.close()
    const id = ${JSON.stringify(scoreId)}
    const score = scores.find(entry => entry.id === id)
    const scorePages = pages
      .filter(entry => entry.scoreId === id)
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .map(entry => ({ id: entry.id, pageIndex: entry.pageIndex }))
    const records = recognitions
      .filter(entry => entry.scoreId === id)
      .map((entry) => {
        const symbols = new Map()
        const staffOf = new Map()
        for (const staff of entry.sidecar?.staffs ?? []) {
          for (const symbol of staff.symbols) {
            symbols.set(symbol.id, symbol)
            staffOf.set(symbol, staff)
          }
        }
        const pointOf = (symbol) => (symbol && symbol.x !== null && symbol.y !== null ? { x: symbol.x, y: symbol.y } : null)
        const locations = (entry.noteSymbols ?? []).map((symbolId) => {
          const symbol = symbolId === null ? undefined : symbols.get(symbolId)
          return pointOf(symbol)
        })
        // 与曲谱页一致：非休止符吸到同谱表（含大谱表）里最近的符头。
        const snapped = (entry.noteSymbols ?? []).map((symbolId) => {
          const symbol = symbolId === null ? undefined : symbols.get(symbolId)
          const anchor = pointOf(symbol)
          if (anchor === null || symbol.rhythm.startsWith('rest')) return anchor
          const staff = staffOf.get(symbol)
          if (staff === undefined) return anchor
          let nearest = null
          let best = 60
          for (const head of staff.notes ?? []) {
            const distance = Math.hypot(head.x - anchor.x, head.y - anchor.y)
            if (distance < best) {
              best = distance
              nearest = head
            }
          }
          return nearest === null ? anchor : { x: nearest.x, y: nearest.y }
        })
        return {
          pageId: entry.pageId,
          musicXml: entry.musicXml,
          noteSymbols: entry.noteSymbols?.length ?? 0,
          page: entry.sidecar?.page ?? null,
          locations,
          snapped
        }
      })
    return {
      score: score
        ? {
            pageCount: score.pageCount,
            noteCount: score.noteCount,
            hasThumbnail: score.thumbnailAssetId !== null,
            collectionId: score.collectionId ?? null,
            collectionOrder: score.collectionOrder ?? null
          }
        : null,
      pages: scorePages,
      recognitions: records,
      annotations: annotations
        .filter(entry => entry.scoreId === id)
        .map(entry => ({ pageKey: entry.pageKey, strokes: entry.strokes.length }))
    }
  })()`)
}

async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, 'base64'))
}

/** 直接读谱架相关的两个 store，断言拖拽真正写进了 IndexedDB。 */
function readLibrary() {
  return evaluate(`(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noteflow')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readAll = store => new Promise((resolve, reject) => {
      const request = database.transaction(store, 'readonly').objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const [scores, collections] = await Promise.all([readAll('scores'), readAll('collections')])
    // 封面图只统计数量与归属，不把 Blob 带回 Node。
    const covers = await new Promise((resolve, reject) => {
      const request = database.transaction('assets', 'readonly').objectStore('assets').openCursor()
      const found = []
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          if (cursor.value.kind === 'cover') found.push({ id: cursor.value.id, scoreId: cursor.value.scoreId ?? null })
          cursor.continue()
          return
        }
        resolve(found)
      }
      request.onerror = () => reject(request.error)
    })
    database.close()
    return {
      covers,
      scores: scores.map(entry => ({
        id: entry.id,
        title: entry.title,
        composer: entry.composer ?? '',
        collectionId: entry.collectionId ?? null,
        collectionOrder: entry.collectionOrder ?? null,
        scoreFormat: entry.scoreFormat ?? 'image',
        pageCount: entry.pageCount ?? 0
      })),
      collections: collections.map(entry => ({
        id: entry.id,
        title: entry.title,
        coverAssetId: entry.coverAssetId ?? null,
        sortOrder: entry.sortOrder,
        updatedAt: entry.updatedAt
      }))
    }
  })()`)
}

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')
await send('Browser.grantPermissions', { origin: base, permissions: ['audioCapture'] })
// 应用以手机为主：整轮验收都在手机视口下跑，截图也按手机宽度输出。
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 1, mobile: true
})
// 截图里不出现开发工具的悬浮条；浅色主题更接近手机默认观感。
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }]
})
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = 'nuxt-devtools, #nuxt-devtools-container { display: none !important; }'
    document.head.append(style)
  }, { once: true })`
})
// 干净库的断言不能被自带曲集干扰：每个新文档先写入跳过标记。验收末尾会移除它，
// 再验证首次安装自带曲集的流程。
const presetSkip = await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('noteflow:preset:off', '1') } catch {}`
})
// 安装提示会盖在页面顶部，验收不需要它。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('noteflow:install:off', '1') } catch {}`
})
fs.mkdirSync(outDir, { recursive: true })

const checks = []
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `（${detail}）` : ''}`)
  return ok
}

let report
const started = Date.now()

try {
  console.log(`base ${base}`)
  console.log(`images ${firstImage}`)
  console.log(`        ${secondImage}`)
  console.log(`musicxml ${musicxmlPath}`)
  console.log(`pdf ${pdfPath}`)

  // ---- 多页识别 ----
  await open('/import/images')
  console.log(`crossOriginIsolated=${await evaluate('crossOriginIsolated')}`)

  await attachFiles('input[type=file]', [firstImage, secondImage])
  const stagedCount = await waitFor(async () => {
    const value = await count('[data-test="page-item"]')
    return value === 2 ? value : null
  }, 15_000, 'staged pages')
  check('一次选入两页缩略图', stagedCount === 2, `${stagedCount} 页`)
  check('选完仍可继续添加', (await count('[data-test="add-page"]')) === 1)
  await screenshot('staged.png')

  const before = await pageOrder()
  await dragPage(0, 1)
  const after = await pageOrder()
  check(
    '长按拖动调整页面顺序',
    after.length === 2 && after[0] === before[1] && after[1] === before[0],
    `${before.join(' / ')} → ${after.join(' / ')}`
  )
  await dragPage(0, 1)
  const restored = await pageOrder()
  check('再次拖动恢复原顺序', restored[0] === before[0], restored.join(' / '))

  await click('[data-test="start-recognition"]')
  const accepted = await waitFor(async () => {
    const current = await text('[data-test="status"]')
    return current.startsWith('识别中') ? current : ''
  }, 15_000, 'recognition start')
  check('手动开始识别', Boolean(accepted), accepted)

  const status = await waitFor(async () => {
    const current = await text('[data-test="status"]')
    if (current.startsWith('识别完成')) return current
    if (current.includes('失败') || current.includes('取消')) throw new Error(current)
    return ''
  }, TIMEOUT, 'recognition finished')
  console.log(`  ${status}`)

  const pageItems = await evaluate(`(() => [...document.querySelectorAll('[data-test="page-item"]')]
    .map(item => item.textContent.replace(/\\s+/g, ' ').trim()))()`)
  check(
    '两页都识别完成',
    pageItems.length === 2 && pageItems.every(item => item.includes('已完成')),
    pageItems.join(' | ')
  )

  const firstXml = await evaluate('document.querySelector(\'[data-test="musicxml"]\')?.textContent ?? \'\'')
  check('识别返回 MusicXML', firstXml.length > 0, `${firstXml.length} 字符`)

  // ---- 保存到谱架 ----
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="save-score"]\'))'),
    30_000,
    'save button'
  )
  await click('[data-test="save-score"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="save-score-confirm"]\'))'),
    10_000,
    'save dialog'
  )
  await click('[data-test="save-score-confirm"]')

  const scorePath = await waitFor(
    () => evaluate('location.pathname').then(value => (value.startsWith('/scores/') ? value : '')),
    120_000,
    'navigate to score'
  )
  const scoreId = scorePath.split('/').pop()
  check('保存后跳转曲谱页', Boolean(scoreId), scorePath)

  const title = await waitFor(async () => {
    const value = await text('[data-test="page-title"]')
    return value || ''
  }, 60_000, 'score title')
  check('曲谱标题非空', title.length > 0, title)
  const scoreSeoTitle = await waitFor(async () => {
    const value = await evaluate('document.title')
    return value.includes(title) ? value : ''
  }, 10_000, 'score seo title')
  check('曲谱页标题带曲名', scoreSeoTitle === `${title} · NoteFlow`, scoreSeoTitle)

  // ---- 曲谱页：两页纵向排开，控件在两侧 ----
  const image1 = await waitFor(() => pageImageSize(0), 60_000, 'page 1 image')
  check(
    '图片曲谱只显示页面图',
    image1.width > 0 && (await count('[data-test="score-surface"]')) === 0,
    `${image1.width}×${image1.height}`
  )

  const layout = await waitFor(async () => {
    const pages = await count('[data-page-index]')
    if (pages !== 2) return null
    return evaluate(`(() => {
      const pages = [...document.querySelectorAll('[data-page-index]')]
      if (pages.length !== 2) return null
      const first = pages[0].getBoundingClientRect()
      const second = pages[1].getBoundingClientRect()
      return {
        count: pages.length,
        firstTop: Math.round(first.top + window.scrollY),
        firstBottom: Math.round(first.bottom + window.scrollY),
        secondTop: Math.round(second.top + window.scrollY)
      }
    })()`)
  }, 30_000, 'vertical pages')
  check(
    '两页纵向排开',
    layout.count === 2 && layout.secondTop >= layout.firstBottom,
    `第一页 ${layout.firstTop}–${layout.firstBottom}，第二页从 ${layout.secondTop} 开始`
  )

  const noPaging = await evaluate(
    '!document.querySelector(\'[data-test="page-indicator"]\')'
    + ' && !document.querySelector(\'[data-test="page-prev"]\')'
    + ' && !document.querySelector(\'[data-test="page-next"]\')'
  )
  check('不再有翻页按钮与页码', noPaging === true)

  const rails = await evaluate(`(() => {
    const left = document.querySelector('[aria-label="节拍器与声部"]')
    const right = document.querySelector('[aria-label="演奏控制与批注"]')
    const main = document.querySelector('main')
    if (!left || !right || !main) return null
    const l = left.getBoundingClientRect()
    const m = main.getBoundingClientRect()
    const r = right.getBoundingClientRect()
    return { leftRight: l.right, mainLeft: m.left, mainRight: m.right, rightLeft: r.left }
  })()`)
  check(
    '节拍器与演奏控件分居乐谱两侧',
    rails !== null && rails.leftRight <= rails.mainLeft + 2 && rails.mainRight <= rails.rightLeft + 2,
    rails === null ? '侧栏不存在' : `${Math.round(rails.leftRight)} ≤ ${Math.round(rails.mainLeft)} / ${Math.round(rails.mainRight)} ≤ ${Math.round(rails.rightLeft)}`
  )
  const tabBox = await evaluate(`(() => {
    const header = document.querySelector('header')
    const tab = document.querySelector('[role="tablist"][aria-label="演奏模式"]')
    if (!header || !tab) return null
    const h = header.getBoundingClientRect()
    const t = tab.getBoundingClientRect()
    return {
      inHeader: header.contains(tab),
      offset: Math.abs((t.left + t.right) / 2 - (h.left + h.right) / 2),
      width: t.width
    }
  })()`)
  check(
    '跟随/评分切换居中放在顶栏且保持紧凑',
    tabBox !== null && tabBox.inHeader && tabBox.offset <= 1 && tabBox.width <= 120,
    tabBox === null ? '找不到模式切换' : `偏移 ${tabBox.offset.toFixed(1)}px，宽 ${Math.round(tabBox.width)}px`
  )
  check('节拍器默认 80 BPM', (await text('[data-test="bpm-value"]')) === '80')
  const bpmTrigger = await evaluate(`(() => {
    const value = document.querySelector('[data-test="bpm-value"]')
    const button = value?.closest('button')
    return button ? button.textContent.replace(/\\s+/g, '') : null
  })()`)
  check('BPM 数字与文案在同一个触发按钮里', bpmTrigger === '80BPM', bpmTrigger)
  await screenshot('page-1.png')

  let stored = await waitFor(async () => {
    const record = await readScore(scoreId)
    return record && record.pages.length === 2 ? record : null
  }, 30_000, 'stored score')
  const firstRecord = stored.recognitions.find(entry => entry.pageId === stored.pages[0].id)
  const firstSnapped = firstRecord?.snapped ?? []
  const firstNoteCount = (firstRecord?.musicXml.match(/<note[\s>]/g) ?? []).length
  const targetIndex = Math.min(5, firstSnapped.length - 1)
  const firstPoint = firstSnapped[targetIndex] ?? null
  check('侧车给出音符定位', firstPoint !== null, `${targetIndex} → ${JSON.stringify(firstPoint)}`)
  const clicked = firstPoint !== null && await clickPagePoint(firstPoint, 0)
  check('点击页面图上的音符', clicked === true, `第 ${targetIndex + 1} 音`)

  const noteNumber = await waitFor(async () => {
    const value = await text('[data-test="note-number"]')
    return value.startsWith(`第 ${targetIndex + 1} `) ? value : ''
  }, 30_000, 'note selection')
  const noteSummary = await text('[data-test="note-summary"]')
  const noteDuration = await text('[data-test="note-duration"]')
  check(
    '底部显示音高与时值',
    noteSummary.length > 0 && noteDuration.length > 0,
    `${noteNumber} · ${noteSummary} · ${noteDuration}`
  )
  const ring = firstPoint === null ? null : await selectionRing(0)
  const ringOffset = ring === null || firstPoint === null
    ? null
    : Math.hypot(ring.cx - firstPoint.x, ring.cy - firstPoint.y)
  check(
    '选中圈落在音符上',
    ringOffset !== null && ringOffset <= 1,
    ringOffset === null ? '没有圆环' : `偏差 ${ringOffset.toFixed(2)}px`
  )

  // ---- 第二页：直接往下点，选中编号接在第一页之后 ----
  const secondRecord = stored.recognitions.find(entry => entry.pageId === stored.pages[1].id)
  const secondPage = secondRecord?.page ?? null
  const image2 = await waitFor(() => pageImageSize(1), 60_000, 'page 2 image')
  check(
    '第二页有自己的页面图',
    secondPage !== null && image2.width === secondPage.width && image2.height === secondPage.height,
    `${image2.width}×${image2.height}`
  )

  const secondSnapped = secondRecord?.snapped ?? []
  const secondIndex = Math.min(2, secondSnapped.length - 1)
  const secondPoint = secondSnapped[secondIndex] ?? null
  const clicked2 = secondPoint !== null && await clickPagePoint(secondPoint, 1)
  check('第二页音符可选中', clicked2 === true, `第 ${secondIndex + 1} 音`)
  const globalIndex = firstNoteCount + secondIndex
  const number2 = await waitFor(async () => {
    const value = await text('[data-test="note-number"]')
    return value.startsWith(`第 ${globalIndex + 1} `) ? value : ''
  }, 30_000, 'page 2 note')
  const summary2 = await text('[data-test="note-summary"]')
  const duration2 = await text('[data-test="note-duration"]')
  check(
    '第二页用全局音符编号',
    summary2.length > 0 && number2.length > 0,
    `${number2} · ${summary2}`
  )
  check('多页时标出所在页', duration2.includes('第 2 页'), duration2)
  await screenshot('page-2-image.png')

  // ---- 持久化 ----
  stored = await waitFor(async () => {
    const record = await readScore(scoreId)
    return record && record.pages.length === 2 ? record : null
  }, 30_000, 'stored score')
  check('曲谱保存为两页', stored.pages.length === 2, stored.pages.map(entry => entry.pageIndex).join(' / '))
  check('每页都有识别记录', stored.recognitions.length === 2, `${stored.recognitions.length} 条`)
  check(
    '第一页 MusicXML 原样保存',
    firstRecord !== undefined && firstRecord.musicXml === firstXml,
    `${firstRecord?.noteSymbols ?? 0} 个音符符号`
  )
  check('第一页侧车覆盖全部 note', firstRecord?.noteSymbols === firstNoteCount, `${firstRecord?.noteSymbols} / ${firstNoteCount}`)

  // ---- 侧栏：节拍器、BPM 持久化 ----
  await click('[data-test="metronome-toggle"]')
  const metronomeOn = await waitFor(
    () => evaluate('document.querySelector(\'[data-test="metronome-toggle"]\')?.getAttribute(\'aria-pressed\') === \'true\''),
    5_000,
    'metronome on'
  )
  check('可以打开节拍器', metronomeOn === true)

  await click('[data-test="bpm-value"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="bpm-input"]\'))'),
    5_000,
    'bpm input'
  )
  await evaluate('document.querySelector(\'[data-test="bpm-input"]\').select()')
  await send('Input.insertText', { text: '96' })
  await click('[data-test="bpm-confirm"]')
  const bpmTyped = await waitFor(async () => {
    const value = await text('[data-test="bpm-value"]')
    return value === '96' ? value : ''
  }, 5_000, 'bpm typed')
  check('BPM 对话框可以输入', bpmTyped === '96', bpmTyped)

  await click('[data-test="bpm-up"]')
  const bpmUp = await waitFor(async () => {
    const value = await text('[data-test="bpm-value"]')
    return value === '101' ? value : ''
  }, 5_000, 'bpm up')
  check('BPM 可以调整', bpmUp === '101', bpmUp)
  await click('[data-test="metronome-toggle"]')

  await click('[data-test="rhythm-select"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="rhythm-option-3-4"]\'))'),
    5_000,
    'rhythm dialog'
  )
  await click('[data-test="rhythm-option-3-4"]')
  const rhythm3 = await waitFor(async () => {
    const value = await text('[data-test="rhythm-select"]')
    return value === '3/4' ? value : ''
  }, 5_000, 'rhythm 3/4')
  check('节奏型对话框可以切到 3/4', rhythm3 === '3/4', rhythm3)
  check('三四拍显示三个拍点', (await count('[data-test="beat-dot"]')) === 3)

  await click('[data-test="rhythm-select"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="rhythm-option-4-4"]\'))'),
    5_000,
    'rhythm dialog again'
  )
  await click('[data-test="rhythm-option-4-4"]')
  const rhythm = await waitFor(async () => {
    const value = await text('[data-test="rhythm-select"]')
    return value === '4/4' ? value : ''
  }, 5_000, 'rhythm switched')
  check('节拍器可以切换到 4/4', rhythm === '4/4', rhythm)
  check('四四拍显示四个拍点', (await count('[data-test="beat-dot"]')) === 4)
  const dotRows = await evaluate(`(() => {
    const aside = document.querySelector('[aria-label="节拍器与声部"]')
    const dots = [...document.querySelectorAll('[data-test="beat-dot"]')]
    if (!aside || dots.length === 0) return null
    const box = aside.getBoundingClientRect()
    const rects = dots.map(dot => dot.getBoundingClientRect())
    return {
      rows: new Set(rects.map(rect => Math.round(rect.top))).size,
      inside: rects.every(rect => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5)
    }
  })()`)
  check(
    '拍点保持单行且不超出侧栏',
    dotRows !== null && dotRows.rows === 1 && dotRows.inside,
    dotRows === null ? '找不到拍点' : `${dotRows.rows} 行${dotRows.inside ? '' : '，超出侧栏'}`
  )

  await open(`/scores/${scoreId}`)
  const bpmRestored = await waitFor(async () => {
    const value = await text('[data-test="bpm-value"]')
    return value === '101' ? value : ''
  }, 30_000, 'bpm persisted')
  check('BPM 按曲谱保存', bpmRestored === '101', bpmRestored)
  const rhythmRestored = await waitFor(async () => {
    const value = await text('[data-test="rhythm-select"]')
    return value === '4/4' ? value : ''
  }, 30_000, 'rhythm persisted')
  check('节奏型按曲谱保存', rhythmRestored === '4/4', rhythmRestored)

  // ---- 批注：画笔、持久化、撤销、清空 ----
  await waitFor(() => pageImageSize(0), 60_000, 'page image reloaded')
  const strokeCount = () => count('[data-page-index] [data-test="annotation-layer"] path')

  await click('[data-test="pen-toggle"]')
  await centerPage(1)
  const drewFirst = await drawStroke(1, [[0.18, 0.22], [0.24, 0.26], [0.3, 0.3], [0.36, 0.34]])
  const drawn = await waitFor(async () => {
    const value = await strokeCount()
    return value >= 1 ? value : null
  }, 10_000, 'annotation stroke')
  check('可以使用画笔批注', drewFirst === true && drawn >= 1, `${drawn} 条笔画`)
  const ink = await evaluate(`(() => {
    const path = document.querySelector('[data-page-index] [data-test="annotation-layer"] path')
    return path ? { fill: path.getAttribute('fill'), stroke: path.getAttribute('stroke') } : null
  })()`)
  check('批注使用黑色细笔画', ink?.fill === '#111111' && ink?.stroke === 'none', JSON.stringify(ink))

  const storedStrokes = await waitFor(async () => {
    const record = await readScore(scoreId)
    const total = record.annotations.reduce((sum, entry) => sum + entry.strokes, 0)
    return total >= 1 ? total : null
  }, 10_000, 'annotation stored')
  check('批注写入 IndexedDB', storedStrokes >= 1, `${storedStrokes} 条`)

  await open(`/scores/${scoreId}`)
  const restoredStrokes = await waitFor(async () => {
    const value = await strokeCount()
    return value >= 1 ? value : null
  }, 30_000, 'annotation restored')
  check('刷新后批注恢复', restoredStrokes >= 1, `${restoredStrokes} 条笔画`)
  await screenshot('annotations.png')

  await click('[data-test="pen-toggle"]')
  await centerPage(1)
  await drawStroke(1, [[0.5, 0.2], [0.55, 0.26], [0.6, 0.32]])
  const twoStrokes = await waitFor(async () => {
    const value = await strokeCount()
    return value >= 2 ? value : null
  }, 10_000, 'second stroke')
  check('可以继续添加批注', twoStrokes >= 2, `${twoStrokes} 条笔画`)

  await click('[data-test="undo-annotation"]')
  const undone = await waitFor(async () => {
    const value = await strokeCount()
    return value === 1 ? value : null
  }, 10_000, 'annotation undone')
  check('撤销上一条批注', undone === 1, `${undone} 条笔画`)

  await click('[data-test="eraser-toggle"]')
  await centerPage(1)
  const beforeErase = await evaluate(
    'document.querySelector(\'[data-page-index] [data-test="annotation-layer"] path\')?.getAttribute(\'d\') ?? \'\''
  )
  await drawStroke(1, [[0.28, 0.18], [0.28, 0.24], [0.28, 0.3], [0.28, 0.38]])
  const erased = await waitFor(async () => {
    const value = await evaluate(
      'document.querySelector(\'[data-page-index] [data-test="annotation-layer"] path\')?.getAttribute(\'d\') ?? \'\''
    )
    return value !== '' && value !== beforeErase ? { value, strokes: await strokeCount() } : null
  }, 10_000, 'eraser applied')
  check(
    '按住拖拽可以连续擦除路径上的笔画',
    erased.strokes >= 1 && erased.value !== beforeErase,
    `${erased.strokes} 段`
  )

  await click('[data-test="clear-annotations"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="dialog-confirm"]\'))'),
    10_000,
    'clear dialog'
  )
  await click('[data-test="dialog-confirm"]')
  const clearedStrokes = await waitFor(async () => (await strokeCount()) === 0 ? true : null, 10_000, 'annotations cleared')
  check('清空全部批注', clearedStrokes === true)
  const removedRecord = await waitFor(async () => {
    const record = await readScore(scoreId)
    return record.annotations.length === 0 ? true : null
  }, 10_000, 'annotations removed')
  check('清空后删除本地记录', removedRecord === true)

  // ---- 自动滚动：跟随目标跨页时滚到第二页 ----
  if (secondPoint === null) throw new Error('第二页没有可点击的定位点')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 480, deviceScaleFactor: 1, mobile: true
  })
  await click('[data-test="mode-practice"]')
  await click('[data-test="transport-toggle"]')
  const practiceReady = await waitFor(async () => {
    const error = await text('[data-test="practice-error"]')
    if (error.length > 0) throw new Error(error)
    const status = await text('[data-test="practice-status"]')
    return status.length > 0 && status !== '正在打开麦克风' ? status : ''
  }, 30_000, 'practice started')
  check('图片曲谱可以开始跟随', practiceReady.length > 0, practiceReady)

  // 第一个目标通常就在视口中央，不一定需要滚动；等平滑滚动落定后记下起点。
  await sleep(700)
  const firstScroll = await evaluate('window.scrollY')

  await evaluate(`(() => {
    const image = document.querySelectorAll('[data-test="page-image"]')[1]
    if (!image) return false
    const pageWidth = Number(image.dataset.pageWidth)
    const rect = image.getBoundingClientRect()
    const scale = rect.width / pageWidth
    image.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: rect.left + ${secondPoint.x} * scale,
      clientY: rect.top + ${secondPoint.y} * scale
    }))
    return true
  })()`)
  const scrolled = await waitFor(async () => {
    const value = await evaluate('window.scrollY')
    // 0 也是合法的起点，用对象包一层避免 waitFor 把 0 当作未完成。
    return value > firstScroll + 100 ? { value } : null
  }, 15_000, 'auto scroll to page 2')
  const scrolledY = scrolled.value
  check(
    '跟随目标跨页时自动滚动',
    scrolledY > firstScroll + 100,
    `${Math.round(firstScroll)} → ${Math.round(scrolledY)}`
  )

  await click('[data-test="transport-stop"]')
  await waitFor(() => evaluate('!document.querySelector(\'[data-test="practice-panel"]\')'), 10_000, 'practice stopped')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true
  })

  // ---- 谱架 ----
  await open('/')
  const cards = await waitFor(async () => {
    const value = await count('[data-test="shelf-score"]')
    return value > 0 ? value : null
  }, 60_000, 'shelf cards')
  const shelfText = await text('[data-test="shelf-score"]')
  check('谱架展示已保存曲谱', cards >= 1, `${cards} 首；首张：${shelfText.replace(/\s+/g, ' ').slice(0, 60)}`)
  const backdrops = await count('[data-test="score-backdrop"]')
  check('多页曲谱在封面下叠第二页', backdrops === 1, `${backdrops} 张叠图`)
  await screenshot('shelf.png')

  // ---- 导入 MusicXML ----
  const importedXml = fs.readFileSync(musicxmlPath, 'utf8')
  await open('/import/musicxml')
  await attachFiles('input[type=file]', [musicxmlPath])
  const preview = await waitFor(async () => {
    const value = await text('[data-test="musicxml-preview"]')
    return value.includes('小节') ? value : ''
  }, 60_000, 'musicxml preview')
  check('MusicXML 解析预览', preview.length > 0, preview.replace(/\s+/g, ' ').slice(0, 80))

  await click('[data-test="import-musicxml"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="import-musicxml-confirm"]\'))'),
    10_000,
    'import dialog'
  )
  await click('[data-test="import-musicxml-confirm"]')
  const importedPath = await waitFor(
    () => evaluate('location.pathname').then(value => (value.startsWith('/scores/') ? value : '')),
    120_000,
    'navigate to imported score'
  )
  const importedId = importedPath.split('/').pop()
  await waitFor(async () => (await text('[data-test="page-title"]')).length > 0, 60_000, 'imported title')
  const importedNotes = await waitFor(
    () => evaluate('document.querySelectorAll(\'[data-test="score-surface"] [id^="nf-"]\').length'),
    180_000,
    'imported verovio render'
  )
  check('导入曲谱渲染出音符', importedNotes > 0, `${importedNotes} 个音符`)
  const noPageUi = await evaluate(
    '!document.querySelector(\'[data-page-index]\') && !document.querySelector(\'[data-test="page-image"]\')'
  )
  check('导入曲谱不显示纵向页容器与页面图', noPageUi === true)
  await screenshot('imported.png')

  const importedRecord = await readScore(importedId)
  const structured = importedRecord.recognitions.find(entry => entry.pageId === null)
  check(
    '导入的 MusicXML 逐字节保存',
    structured !== undefined && structured.musicXml === importedXml,
    `${importedXml.length} 字符`
  )

  // ---- 谱集：长按拖动整理 ----
  await open('/')
  await waitFor(async () => {
    const value = await count('[data-test="shelf-score"]')
    return value >= 2 ? value : null
  }, 60_000, 'two standalone scores')
  const initialLibrary = await readLibrary()
  check(
    '整理前两首曲谱都是独立曲谱',
    initialLibrary.scores.length === 2
    && initialLibrary.collections.length === 0
    && initialLibrary.scores.every(entry => entry.collectionId === null),
    `${initialLibrary.scores.length} 首 / ${initialLibrary.collections.length} 个谱集`
  )

  await evaluate('window.scrollTo(0, 0)')
  const targetCenter = await centerOf(`[data-test="shelf-score"][data-score-id="${importedId}"]`)
  const draggedCenter = await centerOf(`[data-test="shelf-score"][data-score-id="${scoreId}"]`)
  let ghostUsesThumbnail = false
  await longPressDrag(draggedCenter, targetCenter, async () => {
    ghostUsesThumbnail = await evaluate(`(() => {
      const ghost = document.querySelector('[data-test="shelf-drag-ghost"]')
      return ghost?.tagName === 'IMG' && (ghost.getAttribute('src') ?? '').startsWith('blob:')
    })()`)
  })
  check('拖拽 ghost 用曲谱第一页图片', ghostUsesThumbnail === true)
  await waitFor(async () => (await count('[data-test="shelf-collection"]')) === 1, 15_000, 'collection card')
  const mergedCount = await text('[data-test="collection-count"]')
  const mergedLibrary = await readLibrary()
  const mergedCollection = mergedLibrary.collections[0]
  const mergedMembers = mergedLibrary.scores.filter(entry => entry.collectionId === mergedCollection?.id)
  check(
    '长按拖动两首曲谱组成谱集',
    mergedLibrary.collections.length === 1
    && mergedMembers.length === 2
    && mergedMembers.map(entry => entry.collectionOrder).sort().join(',') === '0,1',
    `${mergedCollection?.title ?? '无'}；顺序 ${mergedMembers.map(entry => entry.collectionOrder).join(' / ')}`
  )
  check('谱集卡显示曲谱数量', mergedCount.includes('2 首'), mergedCount)
  const coverTitle = await evaluate(`(() => {
    const card = document.querySelector('[data-test="shelf-collection"]')
    return {
      inside: Boolean(card?.querySelector('[data-test="collection-cover-title"]')),
      caption: card?.querySelector('[data-test="collection-title"]')?.textContent?.trim() ?? ''
    }
  })()`)
  check(
    '谱集名在封面里和卡片下方都显示',
    coverTitle.inside === true && coverTitle.caption === mergedCollection?.title,
    `封面内 ${coverTitle.inside} / 卡片下 ${coverTitle.caption}`
  )
  await screenshot('collections.png')

  const mergedCollectionId = mergedCollection?.id ?? ''
  // 拖动结束后的点击抑制持续约 300ms，等它释放再进入谱集页。
  await sleep(400)
  await click('[data-test="shelf-collection"]')
  await waitFor(
    () => evaluate('location.pathname').then(value => (value.startsWith('/collections/') ? value : '')),
    30_000,
    'collection page'
  )
  const memberCards = await waitFor(async () => {
    const value = await count('[data-test="collection-score"]')
    return value === 2 ? value : null
  }, 30_000, 'collection members')
  check('谱集页列出两首曲谱', memberCards === 2, `${memberCards} 首`)
  await screenshot('collection-page.png')

  // ---- 曲谱页返回：从谱集打开就回谱集 ----
  const collectionPath = await evaluate('location.pathname')
  const memberHref = await evaluate(
    'document.querySelector(\'[data-test="collection-score"]\')?.getAttribute(\'href\') ?? \'\''
  )
  await open(memberHref)
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="page-title"]\'))'),
    30_000,
    'member score page'
  )
  const memberBack = await evaluate(`(() => {
    const link = document.querySelector('header a[aria-label^="返回"]')
    return link ? { href: link.getAttribute('href'), label: link.getAttribute('aria-label') } : null
  })()`)
  check(
    '谱集里的曲谱返回指向谱集',
    memberBack?.href === collectionPath && memberBack?.label === '返回谱集',
    memberBack === null ? '未找到返回按钮' : `${memberBack.label} → ${memberBack.href}`
  )
  await click('header a[aria-label^="返回"]')
  await waitFor(
    () => evaluate('location.pathname').then(value => (value === collectionPath ? value : '')),
    30_000,
    'back to collection'
  )
  await waitFor(
    async () => (await count('[data-test="collection-score"]')) === 2,
    30_000,
    'collection restored'
  )

  // ---- 谱集编辑：封面与名称都在对话框里 ----
  await click('[data-test="collection-edit"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="collection-title-input"]\'))'),
    10_000,
    'edit dialog'
  )
  await attachFiles('[data-test="collection-cover-picker"]', [firstImage])
  const coverPreview = await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="collection-cover-image"]\'))'),
    30_000,
    'cover preview'
  )
  await evaluate(`(() => {
    const input = document.querySelector('[data-test="collection-title-input"]')
    if (!input) return false
    input.value = '练习谱集'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await screenshot('collection-cover.png')
  await click('[data-test="collection-edit-confirm"]')
  const editedLibrary = await waitFor(async () => {
    const library = await readLibrary()
    const value = await text('[data-test="page-title"]')
    if (value !== '练习谱集') return null
    return typeof library.collections[0]?.coverAssetId === 'string' ? library : null
  }, 30_000, 'collection edited')
  check(
    '谱集可以在编辑对话框里设置封面',
    coverPreview === true && typeof editedLibrary.collections[0]?.coverAssetId === 'string',
    `封面资源 ${editedLibrary.collections[0]?.coverAssetId ?? '无'}`
  )
  const renamed = await text('[data-test="page-title"]')
  check(
    '谱集可以重命名',
    renamed === '练习谱集' && editedLibrary.collections[0]?.title === '练习谱集',
    renamed
  )
  // 等编辑对话框的关闭动画结束，避免遮罩吃掉下一次长按。
  await sleep(600)

  // ---- 拖出谱集 ----
  const removedScoreId = await evaluate(
    'document.querySelector(\'[data-test="collection-score"]\')?.dataset.scoreId ?? \'\''
  )
  await dragToRemoveZone('[data-test="collection-score"]')
  await waitFor(async () => (await count('[data-test="collection-score"]')) === 1, 15_000, 'member removed')
  const removedLibrary = await readLibrary()
  const removedScore = removedLibrary.scores.find(entry => entry.id === removedScoreId)
  check(
    '拖到底部可以把曲谱移回谱架',
    removedLibrary.scores.filter(entry => entry.collectionId === mergedCollectionId).length === 1
    && removedScore?.collectionId === null,
    `${removedScore?.title ?? ''} 回到独立曲谱`
  )

  // ---- 谱架：加入已有谱集 ----
  await open('/')
  await waitFor(async () => (await count('[data-test="shelf-score"]')) === 1, 30_000, 'standalone score')
  const remainingCollectionCount = await text('[data-test="collection-count"]')
  check(
    '移出的曲谱回到谱架且谱集仍在',
    remainingCollectionCount.includes('1 首'),
    remainingCollectionCount
  )
  const shelfCover = await evaluate(`(() => {
    const card = document.querySelector('[data-test="shelf-collection"]')
    return {
      cover: Boolean(card?.querySelector('[data-test="collection-cover"]')),
      insideTitle: Boolean(card?.querySelector('[data-test="collection-cover-title"]')),
      caption: card?.querySelector('[data-test="collection-title"]')?.textContent?.trim() ?? '',
      badge: card?.querySelector('[data-test="collection-count"]')?.textContent?.trim() ?? ''
    }
  })()`)
  check(
    '有封面的谱集不再显示封面内标题',
    shelfCover.cover === true && shelfCover.insideTitle === false,
    `封面 ${shelfCover.cover} / 封面内标题 ${shelfCover.insideTitle}`
  )
  check(
    '谱集名在图下、数量在封面右下角',
    shelfCover.caption === '练习谱集' && shelfCover.badge === '1 首',
    `${shelfCover.caption} · ${shelfCover.badge}`
  )

  await evaluate('window.scrollTo(0, 0)')
  const remainingCenter = await centerOf('[data-test="shelf-score"]')
  const existingCenter = await centerOf('[data-test="shelf-collection"]')
  await longPressDrag(remainingCenter, existingCenter)
  await waitFor(
    async () => (await text('[data-test="collection-count"]')).includes('2 首'),
    15_000,
    'joined collection'
  )
  const joinedLibrary = await readLibrary()
  const joinedMembers = joinedLibrary.scores.filter(entry => entry.collectionId === mergedCollectionId)
  check('拖到已有谱集卡上可以加入', joinedMembers.length === 2, `${joinedMembers.length} 首`)

  // ---- 删除谱集 ----
  await sleep(400)
  await click('[data-test="shelf-collection"]')
  await waitFor(async () => (await count('[data-test="collection-score"]')) === 2, 30_000, 'collection reopened')
  const collectionSeoTitle = await waitFor(async () => {
    const value = await evaluate('document.title')
    return value.includes('练习谱集') ? value : ''
  }, 10_000, 'collection seo title')
  check('谱集页标题带谱集名', collectionSeoTitle === '练习谱集 · 谱集 · NoteFlow', collectionSeoTitle)
  await click('[data-test="collection-delete"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="dialog-confirm"]\'))'),
    10_000,
    'delete collection dialog'
  )
  await click('[data-test="dialog-confirm"]')
  await waitFor(() => evaluate('location.pathname === \'/\''), 30_000, 'back to shelf')
  const restoredCards = await waitFor(async () => {
    const value = await count('[data-test="shelf-score"]')
    return value === 2 ? value : null
  }, 30_000, 'scores restored')
  const restoredLibrary = await readLibrary()
  check(
    '删除谱集后曲谱全部回到谱架',
    restoredLibrary.collections.length === 0
    && restoredCards === 2
    && restoredLibrary.scores.every(entry => entry.collectionId === null && entry.collectionOrder === null),
    `${restoredCards} 首独立曲谱`
  )
  check(
    '删除谱集后封面图一起清理',
    restoredLibrary.covers.length === 0,
    `${restoredLibrary.covers.length} 张封面资源`
  )

  // ---- 多页 PDF ----
  await open('/import/pdf')
  await attachFiles('[data-test="pdf-input"]', [pdfPath])
  const pdfPageCount = await waitFor(async () => {
    const failure = await text('[data-test="pdf-error"]')
    if (failure) throw new Error(failure)
    const value = await count('[data-test="page-item"]')
    return value === 2 ? value : null
  }, 120_000, 'pdf pages')
  check('多页 PDF 逐页渲染成缩略图', pdfPageCount === 2, `${pdfPageCount} 页`)
  const pdfNames = await evaluate(`[...document.querySelectorAll('[data-page-name]')].map(item => item.dataset.pageName)`)
  check(
    'PDF 页面按页码命名',
    pdfNames.length === 2 && pdfNames[0].endsWith('-1.jpg') && pdfNames[1].endsWith('-2.jpg'),
    pdfNames.join(' / ')
  )
  await screenshot('pdf-staged.png')

  await click('[data-test="start-recognition"]')
  const pdfStatus = await waitFor(async () => {
    const current = await text('[data-test="status"]')
    if (current.startsWith('识别完成')) return current
    if (current.includes('失败') || current.includes('取消')) throw new Error(current)
    return ''
  }, TIMEOUT, 'pdf recognition finished')
  check('PDF 页面识别完成', pdfStatus.startsWith('识别完成：2 页'), pdfStatus)

  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="save-score"]\'))'),
    30_000,
    'pdf save button'
  )
  await click('[data-test="save-score"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="save-score-confirm"]\'))'),
    10_000,
    'pdf save dialog'
  )
  const pdfScorePath = await (async () => {
    await click('[data-test="save-score-confirm"]')
    return waitFor(
      () => evaluate('location.pathname').then(value => (value.startsWith('/scores/') ? value : '')),
      120_000,
      'pdf score page'
    )
  })()
  const pdfScoreId = pdfScorePath.split('/').pop()
  const pdfStored = await waitFor(async () => {
    const record = await readScore(pdfScoreId)
    return record && record.pages.length === 2 ? record : null
  }, 30_000, 'pdf stored score')
  check(
    'PDF 曲谱保存为独立的两页',
    pdfScoreId !== scoreId && pdfStored.pages.length === 2,
    `${pdfScoreId} · ${pdfStored.pages.length} 页`
  )

  // ---- 自带曲集 ----
  // 前面的流程都跳过了自带曲集；这里移除跳过标记并重新打开谱架，验证首次安装。
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: presetSkip.identifier })
  await evaluate('localStorage.removeItem(\'noteflow:preset:off\')')
  await open('/')
  const presetShelf = await waitFor(async () => {
    const titles = await evaluate(`[...document.querySelectorAll('[data-test="collection-title"]')]
      .map(item => item.textContent.trim())`)
    return titles.includes('钢琴经典曲集') ? titles : null
  }, 180_000, 'preset collection')
  check('首次打开自动安装自带曲集', presetShelf.includes('钢琴经典曲集'), presetShelf.join(' / '))

  const presetCard = await evaluate(`(() => {
    const card = [...document.querySelectorAll('[data-test="shelf-collection"]')]
      .find(item => item.textContent.includes('钢琴经典曲集'))
    if (!card) return null
    return {
      id: card.dataset.collectionId,
      badge: card.querySelector('[data-test="collection-count"]')?.textContent?.trim() ?? '',
      hasCover: Boolean(card.querySelector('[data-test="collection-cover"]'))
    }
  })()`)
  check(
    '自带曲集包含四首曲谱与封面',
    presetCard !== null && presetCard.badge === '4 首' && presetCard.hasCover,
    presetCard === null ? '未找到谱集卡' : `${presetCard.badge} · 封面${presetCard.hasCover ? '有' : '无'}`
  )
  await screenshot('preset-collection.png')

  await open(`/collections/${presetCard.id}`)
  const presetDetail = await waitFor(async () => {
    const value = await count('[data-test="collection-score"]')
    return value === 4 ? value : null
  }, 30_000, 'preset collection page')
  check('自带曲集打开后有四项曲目', presetDetail === 4, `${presetDetail} 项`)
  await screenshot('preset-detail.png')

  const presetLibrary = await readLibrary()
  const presetScores = presetLibrary.scores.filter(entry => entry.collectionId === presetCard.id)
  check(
    '自带曲集的曲名与作曲家分开保存',
    presetScores.length === 4
    && presetScores.every(entry => entry.title.length > 0 && entry.composer.length > 0)
    && presetScores.some(entry => entry.title === 'G 大调小步舞曲' && entry.composer === '佩措尔德'),
    presetScores.map(entry => `${entry.title} · ${entry.composer}`).join(' / ')
  )

  // 自带曲谱直接来自 MusicXML：没有页面图片，版面由 Verovio 现场排版。
  check(
    '自带曲谱是结构化 MusicXML',
    presetScores.length === 4
    && presetScores.every(entry => entry.scoreFormat === 'structured' && entry.pageCount === 0),
    presetScores.map(entry => `${entry.title}:${entry.scoreFormat}/${entry.pageCount} 页`).join(' / ')
  )

  // 小提琴曲集与钢琴曲集分开安装，曲目是巴赫无伴奏组曲／奏鸣曲的乐章。
  await open('/')
  const violinShelf = await waitFor(async () => {
    const titles = await evaluate(`[...document.querySelectorAll('[data-test="collection-title"]')]
      .map(item => item.textContent.trim())`)
    return titles.includes('小提琴经典曲集') ? titles : null
  }, 180_000, 'violin preset collection')
  check('首次打开自动安装小提琴曲集', violinShelf.includes('小提琴经典曲集'), violinShelf.join(' / '))

  const violinCard = await evaluate(`(() => {
    const card = [...document.querySelectorAll('[data-test="shelf-collection"]')]
      .find(item => item.textContent.includes('小提琴经典曲集'))
    if (!card) return null
    return {
      id: card.dataset.collectionId,
      badge: card.querySelector('[data-test="collection-count"]')?.textContent?.trim() ?? '',
      hasCover: Boolean(card.querySelector('[data-test="collection-cover"]'))
    }
  })()`)
  check(
    '小提琴曲集包含四首曲谱与封面',
    violinCard !== null && violinCard.badge === '4 首' && violinCard.hasCover,
    violinCard === null ? '未找到谱集卡' : `${violinCard.badge} · 封面${violinCard.hasCover ? '有' : '无'}`
  )
  await screenshot('preset-violin-collection.png')

  await open(`/collections/${violinCard.id}`)
  const violinDetail = await waitFor(async () => {
    const value = await count('[data-test="collection-score"]')
    return value === 4 ? value : null
  }, 30_000, 'violin collection page')
  check('小提琴曲集打开后有四项曲目', violinDetail === 4, `${violinDetail} 项`)
  await screenshot('preset-violin-detail.png')

  const violinLibrary = await readLibrary()
  const violinScores = violinLibrary.scores.filter(entry => entry.collectionId === violinCard.id)
  check(
    '小提琴曲集是巴赫无伴奏 MusicXML',
    violinScores.length === 4
    && violinScores.every(entry => entry.scoreFormat === 'structured' && entry.pageCount === 0)
    && violinScores.some(entry => entry.title === 'D 小调恰空' && entry.composer === '巴赫'),
    violinScores.map(entry => `${entry.title} · ${entry.composer}`).join(' / ')
  )

  report = {
    ok: true,
    base,
    images: [path.relative(root, firstImage), path.relative(root, secondImage)],
    musicxml: path.relative(root, musicxmlPath),
    scoreId,
    title,
    pages: {
      count: stored.pages.length,
      firstNotes: (firstRecord?.musicXml.match(/<note[\s>]/g) ?? []).length,
      secondNotes: (secondRecord?.musicXml.match(/<note[\s>]/g) ?? []).length
    },
    selected: { index: targetIndex, noteNumber, noteSummary, noteDuration, ringOffset },
    pageSizes: { first: image1, second: image2 },
    layout,
    rails,
    annotations: { drawn, restored: restoredStrokes, cleared: clearedStrokes },
    scroll: { first: firstScroll, sought: scrolledY },
    shelf: { cards, first: shelfText.replace(/\s+/g, ' ').slice(0, 120) },
    import: { scoreId: importedId, notes: importedNotes, noPageUi, bytes: importedXml.length },
    collections: {
      id: mergedCollectionId,
      title: renamed,
      removed: removedScoreId,
      restored: restoredLibrary.scores.map(entry => entry.title)
    },
    pdf: { scoreId: pdfScoreId, pages: pdfStored.pages.length, names: pdfNames },
    preset: {
      collection: presetCard?.id ?? null,
      scores: presetScores.map(entry => `${entry.title} · ${entry.composer}`)
    },
    presetViolin: {
      collection: violinCard?.id ?? null,
      scores: violinScores.map(entry => `${entry.title} · ${entry.composer}`)
    },
    elapsedMs: Date.now() - started,
    checks,
    generatedAt: new Date().toISOString()
  }
} catch (error) {
  report = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    checks,
    generatedAt: new Date().toISOString()
  }
  console.error(`[failure] ${report.error}`)
  try {
    const body = await evaluate('document.body?.innerText ?? \'\'')
    console.error(body.slice(0, 2000))
    await screenshot('failure.png')
  } catch {
    // 页面已不可访问时只保留错误信息
  }
}

report.checks = checks
report.ok = report.ok === true && checks.every(entry => entry.ok)
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'm5.run.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`checks ${checks.filter(entry => entry.ok).length}/${checks.length}`)
console.log(`report ${path.relative(root, path.join(outDir, 'm5.run.json'))}`)

socket.close()
browser.kill('SIGKILL')
process.exit(report.ok ? 0 : 1)
