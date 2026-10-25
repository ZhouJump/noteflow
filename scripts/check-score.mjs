/**
 * M5 验收：用真实 Chromium 走一遍「选两页图片 → 拖动排序 → 识别 → 保存到书架 → 翻页 →
 * 点选音符 → 页面图 → 导入 MusicXML」。
 *
 *   node scripts/check-score.mjs [--url http://127.0.0.1:3000]
 *                                [--image <第一页>] [--image2 <第二页>]
 *                                [--musicxml <基准>] [--out reference/artifacts/m5]
 *
 * 先启动开发服务器（pnpm dev），再运行本脚本。脚本只验证真实运行：
 *   - 选页后仍能继续添加，长按拖动可以调整页面顺序；
 *   - 选中的两页按顺序识别完成，保存成同一份曲谱；
 *   - 每一页都有自己的 RecognitionRecord，第一页 MusicXML 与界面展示逐字节一致；
 *   - 曲谱页只显示页面图，可以在两页之间切换，切页后清空选中；
 *   - 点页面图上的音符能显示音高、时值；
 *   - 书架出现刚保存的曲谱；
 *   - MusicXML 导入走同一个曲谱页，没有页面图与翻页。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
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
const musicxmlPath = path.resolve(
  flag('--musicxml', path.join(root, 'reference/artifacts/browser', page, `${page}.musicxml`))
)
const base = flag('--url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const outDir = path.resolve(flag('--out', path.join(root, 'reference/artifacts/m5')), page)
const BROWSER = process.env.BROWSER ?? '/usr/bin/microsoft-edge'
const PORT = Number(process.env.CDP_PORT ?? 9335)
const TIMEOUT = Number(process.env.TIMEOUT ?? 20 * 60_000)

if (!fs.existsSync(firstImage)) throw new Error(`图片不存在：${firstImage}`)
if (!fs.existsSync(secondImage)) throw new Error(`第二页图片不存在：${secondImage}`)
if (!fs.existsSync(musicxmlPath)) throw new Error(`MusicXML 不存在：${musicxmlPath}`)

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

const profile = fs.mkdtempSync('/tmp/noteflow-m5-')
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
    'about:blank'
  ],
  { stdio: 'ignore' }
)
process.on('exit', () => browser.kill('SIGKILL'))

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

/** 打开页面并等 Vue 挂载。整页导航会销毁执行上下文，因此这里不做失败重试之外的假设。 */
async function open(target) {
  await send('Page.navigate', { url: `${base}${target}` })
  await waitFor(() => evaluate('document.readyState === \'complete\''), 60_000, `load ${target}`)
  await waitFor(() => evaluate('Boolean(document.querySelector("#__nuxt")?.__vue_app__)'), 60_000, `vue ${target}`)
  await sleep(300)
}

/** 在页面图上按侧车坐标点一下，选中最接近的音符。 */
async function clickPagePoint(point) {
  const located = await evaluate(`(() => {
    const element = document.querySelector('[data-test="page-image"]')
    if (!element) return false
    const rect = element.getBoundingClientRect()
    const x = rect.left + (${point.x} / element.width) * rect.width
    const y = rect.top + (${point.y} / element.height) * rect.height
    window.scrollBy(0, y - window.innerHeight / 2)
    return true
  })()`)
  if (!located) return false
  await sleep(250)
  const position = await evaluate(`(() => {
    const element = document.querySelector('[data-test="page-image"]')
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return {
      x: rect.left + (${point.x} / element.width) * rect.width,
      y: rect.top + (${point.y} / element.height) * rect.height
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

/** 选中后圈画在定位点上：采样半径上的像素，确认琥珀色圆环确实落在符头周围。 */
function amberRingAt(point) {
  return evaluate(`(() => {
    const element = document.querySelector('[data-test="page-image"]')
    if (!element) return null
    const context = element.getContext('2d')
    const scale = element.width / 1200
    const radius = 14 * scale
    let hits = 0
    for (let step = 0; step < 8; step += 1) {
      const angle = (step * Math.PI) / 4
      const x = Math.round(${point.x} + Math.cos(angle) * radius)
      const y = Math.round(${point.y} + Math.sin(angle) * radius)
      const [red, green, blue] = context.getImageData(x, y, 1, 1).data
      if (red > 110 && red < 235 && green > 45 && green < 145 && blue < 90) hits += 1
    }
    return hits
  })()`)
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
    const [scores, pages, recognitions] = await Promise.all([
      readAll('scores'),
      readAll('pages'),
      readAll('recognitions')
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
        ? { pageCount: score.pageCount, noteCount: score.noteCount, hasThumbnail: score.thumbnailAssetId !== null }
        : null,
      pages: scorePages,
      recognitions: records
    }
  })()`)
}

async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, 'base64'))
}

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')
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

  // ---- 保存到书架 ----
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="save-score"]\'))'),
    30_000,
    'save button'
  )
  await click('[data-test="save-score"]')

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

  // ---- 第一页：只有页面图，没有 Verovio 视图 ----
  const canvas1 = await waitFor(async () => {
    const size = await evaluate(`(() => {
      const element = document.querySelector('[data-test="page-image"]')
      return element ? { width: element.width, height: element.height } : null
    })()`)
    return size && size.width > 0 && size.height > 0 ? size : null
  }, 60_000, 'page 1 image')
  check(
    '图片曲谱只显示页面图',
    canvas1.width > 0 && (await count('[data-test="score-surface"]')) === 0,
    `${canvas1.width}×${canvas1.height}`
  )

  const indicator1 = await waitFor(async () => {
    const value = await text('[data-test="page-indicator"]')
    return value.includes('1 / 2') ? value : ''
  }, 30_000, 'page indicator 1')
  check('多页页码正确', indicator1.length > 0, indicator1)
  await screenshot('page-1.png')

  let stored = await waitFor(async () => {
    const record = await readScore(scoreId)
    return record && record.pages.length === 2 ? record : null
  }, 30_000, 'stored score')
  const firstRecord = stored.recognitions.find(entry => entry.pageId === stored.pages[0].id)
  const firstSnapped = firstRecord?.snapped ?? []
  const targetIndex = Math.min(5, firstSnapped.length - 1)
  const firstPoint = firstSnapped[targetIndex] ?? null
  check('侧车给出音符定位', firstPoint !== null, `${targetIndex} → ${JSON.stringify(firstPoint)}`)
  const clicked = firstPoint !== null && await clickPagePoint(firstPoint)
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
  const ring = firstPoint === null ? 0 : await amberRingAt(firstPoint)
  check('选中圈落在音符上', typeof ring === 'number' && ring >= 4, `${ring} / 8 个采样点在圆环上`)

  // ---- 第二页 ----
  await click('[data-test="page-next"]')
  const indicator2 = await waitFor(async () => {
    const value = await text('[data-test="page-indicator"]')
    return value.includes('2 / 2') ? value : ''
  }, 30_000, 'page indicator 2')
  check('可以切到第二页', indicator2.length > 0, indicator2)

  const selectionCleared = await evaluate('!document.querySelector(\'[data-test="note-inspector"]\')')
  check('翻页后清除选中', selectionCleared === true)

  const secondRecord = stored.recognitions.find(entry => entry.pageId === stored.pages[1].id)
  const secondPage = secondRecord?.page ?? null
  const canvas2 = await waitFor(async () => {
    const size = await evaluate(`(() => {
      const element = document.querySelector('[data-test="page-image"]')
      return element ? { width: element.width, height: element.height } : null
    })()`)
    return size && size.width > 0 && size.height > 0 ? size : null
  }, 60_000, 'page 2 image')
  check(
    '第二页换成自己的页面图',
    secondPage !== null && canvas2.width === secondPage.width && canvas2.height === secondPage.height,
    `${canvas2.width}×${canvas2.height}`
  )

  const secondSnapped = secondRecord?.snapped ?? []
  const secondIndex = Math.min(2, secondSnapped.length - 1)
  const secondPoint = secondSnapped[secondIndex] ?? null
  const clicked2 = secondPoint !== null && await clickPagePoint(secondPoint)
  check('第二页音符可选中', clicked2 === true, `第 ${secondIndex + 1} 音`)
  const summary2 = await waitFor(() => text('[data-test="note-summary"]'), 30_000, 'page 2 note')
  const number2 = await text('[data-test="note-number"]')
  check(
    '第二页显示音高与时值',
    summary2.length > 0 && number2.startsWith(`第 ${secondIndex + 1} `),
    `${number2} · ${summary2}`
  )
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
  const firstNoteCount = (firstRecord?.musicXml.match(/<note[\s>]/g) ?? []).length
  check('第一页侧车覆盖全部 note', firstRecord?.noteSymbols === firstNoteCount, `${firstRecord?.noteSymbols} / ${firstNoteCount}`)

  // ---- 书架 ----
  await open('/')
  const cards = await waitFor(async () => {
    const value = await count('[data-test="shelf-score"]')
    return value > 0 ? value : null
  }, 60_000, 'shelf cards')
  const shelfText = await text('[data-test="shelf-score"]')
  check('书架展示已保存曲谱', cards >= 1, `${cards} 份；首张：${shelfText.replace(/\s+/g, ' ').slice(0, 60)}`)
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
    '!document.querySelector(\'[data-test="page-indicator"]\') && !document.querySelector(\'[data-test="page-image"]\')'
  )
  check('导入曲谱不显示翻页与页面图', noPageUi === true)
  await screenshot('imported.png')

  const importedRecord = await readScore(importedId)
  const structured = importedRecord.recognitions.find(entry => entry.pageId === null)
  check(
    '导入的 MusicXML 逐字节保存',
    structured !== undefined && structured.musicXml === importedXml,
    `${importedXml.length} 字符`
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
    selected: { index: targetIndex, noteNumber, noteSummary, noteDuration, ring },
    canvas: { first: canvas1, second: canvas2 },
    shelf: { cards, first: shelfText.replace(/\s+/g, ' ').slice(0, 120) },
    import: { scoreId: importedId, notes: importedNotes, noPageUi, bytes: importedXml.length },
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
