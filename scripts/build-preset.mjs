/**
 * 生成自带曲集「小提琴经典曲集」的预识别数据。
 *
 *   pnpm dev                                     # 另开终端
 *   node scripts/build-preset.mjs                # 全部四首，写入 public/presets/violin
 *   node scripts/build-preset.mjs --only 小步舞曲 --out /tmp/preset-test
 *
 * 脚本用真实 Chromium 走一遍现有的 PDF 导入链路：渲染 → HOMR 识别 → 保存，
 * 再把 IndexedDB 里的识别结果导出成静态资产（manifest + 每页图片），应用首次
 * 打开谱架时由 `app/lib/presets/violin.ts` 写回本机库。
 *
 * 输入是 `public/samples/violin` 下的四份「曲名 — 作曲家.pdf」与封面 `cover.webp`；
 * 这个目录不在 `pnpm assets` 的清理范围里（只同步它自己复制的样例）。
 *
 * 这里的识别在浏览器里跑，耗时取决于页数（单页约半分钟到一分钟），四首合计
 * 十几分钟。中途失败会保留已导出的内容，方便排查。
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const base = flag('--url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const SAMPLE_DIR = path.join(root, 'public/samples/violin')
const DEFAULT_OUT = path.join(root, 'public/presets/violin')
const BROWSER = process.env.BROWSER ?? '/usr/bin/microsoft-edge'
const PORT = Number(process.env.CDP_PORT ?? 9337)
const RECOGNITION_TIMEOUT = Number(process.env.TIMEOUT ?? 20 * 60_000)

/** 谱集内顺序：春、巴赫、贝多芬、佩措尔德。 */
const ENTRIES = [
  '《春》第一乐章 — 维瓦尔第.pdf',
  'E 大调第三无伴奏小提琴组曲：前奏曲 — 巴赫.pdf',
  'F 大调浪漫曲 — 贝多芬.pdf',
  'G 大调小步舞曲 — 佩措尔德.pdf'
]

const only = flag('--only', '')
const selected = ENTRIES.filter(name => only === '' || name.includes(only))
if (selected.length === 0) throw new Error(`没有匹配的曲目：${only}`)
// 先确认输入齐全再清理输出目录：缺一份 PDF 时不能把已生成的数据删掉。
const absent = selected.filter(name => !fs.existsSync(path.join(SAMPLE_DIR, name)))
if (absent.length > 0) {
  throw new Error(`缺少原始 PDF：${absent.join('、')}（放在 ${path.relative(root, SAMPLE_DIR)}）`)
}
const outDir = path.resolve(flag('--out', DEFAULT_OUT))
if (only === '') fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const COLLECTION = { id: 'preset-violin-classics', title: '小提琴经典曲集' }
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
    await sleep(400)
  }
  throw new Error(`timeout: ${label}${lastError ? `（${lastError.message}）` : ''}`)
}

/** 「曲名 — 作曲家.pdf」拆成两个字段；没有分隔符时整段都是曲名。 */
function splitEntry(file) {
  const stem = file.replace(/\.pdf$/i, '').trim()
  const match = /^(.+?)\s+—\s+(.+)$/.exec(stem)
  return match === null
    ? { title: stem, composer: '' }
    : { title: match[1].trim(), composer: match[2].trim() }
}

function pdfPages(file) {
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' })
  const match = /^Pages:\s+(\d+)/m.exec(info)
  if (match === null) throw new Error(`无法读取页数：${file}`)
  return Number(match[1])
}

const profile = fs.mkdtempSync('/tmp/noteflow-preset-')
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

process.on('exit', () => {
  browser.kill('SIGKILL')
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // 剩余临时文件交给系统回收。
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

/** 写值并派发 input，让 Vue 的 v-model 收到变化。 */
async function fill(selector, value) {
  const filled = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) return false
    setter.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!filled) throw new Error(`输入框不存在：${selector}`)
}

async function attachFiles(selector, files) {
  const { root: documentRoot } = await send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector })
  if (!nodeId) throw new Error(`file input 不存在：${selector}`)
  await send('DOM.setFileInputFiles', { nodeId, files })
  await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (input && input.files && input.files.length > 0) {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })()`)
}

async function open(target) {
  await send('Page.navigate', { url: `${base}${target}` })
  await waitFor(() => evaluate('document.readyState === \'complete\''), 60_000, `load ${target}`)
  await waitFor(() => evaluate('Boolean(document.querySelector("#__nuxt")?.__vue_app__)'), 60_000, `vue ${target}`)
  await sleep(300)
}

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')
// 安装提示会盖在页面顶部，生成预置曲集时不需要它。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('noteflow:install:off', '1') } catch {}`
})
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 1, mobile: true
})

/** 读一份曲谱的元数据与识别记录（不含 Blob）。 */
function readScoreBundle(scoreId) {
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
    const [scores, pages, recognitions, assets] = await Promise.all([
      readAll('scores'),
      readAll('pages'),
      readAll('recognitions'),
      readAll('assets')
    ])
    database.close()
    const id = ${JSON.stringify(scoreId)}
    const score = scores.find(entry => entry.id === id)
    if (score === undefined) return null
    return {
      score: {
        id: score.id,
        title: score.title,
        composer: score.composer,
        pageCount: score.pageCount,
        noteCount: score.noteCount
      },
      pages: pages
        .filter(entry => entry.scoreId === id)
        .sort((left, right) => left.pageIndex - right.pageIndex)
        .map(entry => ({
          id: entry.id,
          pageIndex: entry.pageIndex,
          originalAssetId: entry.originalAssetId
        })),
      recognitions: recognitions
        .filter(entry => entry.scoreId === id)
        .map(entry => ({
          id: entry.id,
          pageId: entry.pageId,
          musicXml: entry.musicXml,
          sidecar: entry.sidecar,
          noteSymbols: entry.noteSymbols,
          modelVersion: entry.modelVersion,
          sourceRevision: entry.sourceRevision
        })),
      assets: assets
        .filter(entry => entry.scoreId === id && entry.kind === 'original')
        .map(entry => ({
          id: entry.id,
          width: entry.width,
          height: entry.height
        }))
    }
  })()`)
}

/** 取一张图片资产并编码成 base64。逐张传输，避免一次 CDP 消息塞几十 MB。 */
function assetBase64(assetId) {
  return evaluate(`(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('noteflow')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const asset = await new Promise((resolve, reject) => {
      const request = database.transaction('assets', 'readonly').objectStore('assets').get(${JSON.stringify(assetId)})
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    if (asset === undefined) return null
    const buffer = new Uint8Array(await asset.blob.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < buffer.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, buffer.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
  })()`)
}

/** 谱集封面：cover.webp 缩到 640 宽后编码成 JPEG。 */
async function exportCover() {
  const base64 = await evaluate(`(async () => {
    const response = await fetch('/samples/violin/cover.webp')
    if (!response.ok) throw new Error('封面不存在')
    const bitmap = await createImageBitmap(await response.blob())
    const scale = Math.min(1, 640 / bitmap.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86))
    const buffer = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < buffer.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, buffer.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
  })()`)
  fs.writeFileSync(path.join(outDir, 'cover.jpg'), Buffer.from(base64, 'base64'))
}

await open('/import/pdf')
await exportCover()
console.log(`封面已导出：${path.join(outDir, 'cover.jpg')}`)

const saved = []
for (const [index, file] of selected.entries()) {
  const filePath = path.join(SAMPLE_DIR, file)
  if (!fs.existsSync(filePath)) throw new Error(`PDF 不存在：${filePath}`)
  const expected = pdfPages(filePath)
  const { title, composer } = splitEntry(file)
  console.log(`\n[${index + 1}/${selected.length}] ${title}${composer ? ` · ${composer}` : ''}（${expected} 页）`)

  await open('/import/pdf')
  await attachFiles('[data-test="pdf-input"]', [filePath])
  await waitFor(async () => {
    const failure = await text('[data-test="pdf-error"]')
    if (failure) throw new Error(failure)
    return (await count('[data-test="page-item"]')) === expected
  }, 180_000, `${file} 渲染`)

  await click('[data-test="start-recognition"]')
  const started = Date.now()
  const status = await waitFor(async () => {
    const current = await text('[data-test="status"]')
    if (current.includes('失败') || current.includes('取消')) throw new Error(current)
    return current.startsWith('识别完成') ? current : ''
  }, RECOGNITION_TIMEOUT, `${file} 识别`)
  console.log(`  ${status}（${Math.round((Date.now() - started) / 1000)}s）`)

  await click('[data-test="save-score"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="save-score-confirm"]\'))'),
    10_000,
    'save dialog'
  )
  await fill('[data-test="score-title-input"]', title)
  await fill('[data-test="score-composer-input"]', composer)
  await click('[data-test="save-score-confirm"]')
  const scorePath = await waitFor(
    () => evaluate('location.pathname').then(value => (value.startsWith('/scores/') ? value : '')),
    120_000,
    'score page'
  )
  const scoreId = scorePath.split('/').pop()
  saved.push({ file, title, composer, expected, scoreId })
  console.log(`  已保存 ${scoreId}`)
}

const manifestScores = []
for (const [index, item] of saved.entries()) {
  const bundle = await readScoreBundle(item.scoreId)
  if (bundle === null) throw new Error(`读不到曲谱：${item.scoreId}`)
  const scoreSlug = `preset-violin-${index + 1}`
  const records = new Map(bundle.recognitions.map(record => [record.pageId, record]))
  const pages = []

  for (const page of bundle.pages) {
    const asset = bundle.assets.find(entry => entry.id === page.originalAssetId)
    const record = records.get(page.id)
    if (asset === undefined || record === undefined) {
      throw new Error(`第 ${page.pageIndex + 1} 页缺少原图或识别记录`)
    }
    const imageName = `${scoreSlug}-${page.pageIndex + 1}.jpg`
    const base64 = await assetBase64(asset.id)
    if (base64 === null) throw new Error(`读不到页面图片：${asset.id}`)
    fs.writeFileSync(path.join(outDir, imageName), Buffer.from(base64, 'base64'))
    pages.push({
      id: `${scoreSlug}-page-${page.pageIndex + 1}`,
      image: imageName,
      width: asset.width,
      height: asset.height,
      recognition: {
        id: `${scoreSlug}-recognition-${page.pageIndex + 1}`,
        musicXml: record.musicXml,
        sidecar: record.sidecar,
        noteSymbols: record.noteSymbols,
        modelVersion: record.modelVersion,
        sourceRevision: record.sourceRevision
      }
    })
    console.log(`  ${imageName} ${asset.width}×${asset.height} · ${record.noteSymbols.length} 个音符符号`)
  }

  if (pages.length !== item.expected) {
    throw new Error(`${item.title} 页数不符：期望 ${item.expected}，实际 ${pages.length}`)
  }
  manifestScores.push({
    id: scoreSlug,
    title: bundle.score.title,
    composer: bundle.score.composer,
    source: item.file,
    pages
  })
  console.log(`${item.title}：${pages.length} 页，${bundle.score.noteCount} 个音符`)
}

const manifest = {
  version: 1,
  collection: COLLECTION,
  cover: 'cover.jpg',
  scores: manifestScores
}
const manifestPath = path.join(outDir, 'manifest.json')
// 不缩进：19 页的 MusicXML 与 sidecar 缩进后接近 10 MB，压掉空白能少一半体积。
fs.writeFileSync(manifestPath, JSON.stringify(manifest))

const totalBytes = fs.readdirSync(outDir).reduce(
  (total, name) => total + fs.statSync(path.join(outDir, name)).size,
  0
)
console.log(`\nmanifest ${(fs.statSync(manifestPath).size / 1024).toFixed(0)} KB`)
console.log(`资产合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB → ${outDir}`)
console.log('自带曲集数据已生成。')
