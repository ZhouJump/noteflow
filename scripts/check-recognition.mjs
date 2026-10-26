/**
 * 用真实 Chromium 驱动 Nuxt 的 /import/images 页面跑一次完整识别，并把结果落盘。
 *
 *   node scripts/check-recognition.mjs [--image <path>] [--url http://127.0.0.1:3000/import/images]
 *                                     [--out reference/artifacts/nuxt-browser]
 *
 * 验收只看真实运行：页面有没有进入“识别完成”、MusicXML 是否非空、和参考实现
 * （reference/artifacts/browser-reference/<page>）的输出是否一致。
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

const image = path.resolve(flag('--image', path.join(root, 'reference/samples/input/永远同在1.jpg')))
const page = path.basename(image, path.extname(image))
const url = flag('--url', 'http://127.0.0.1:3000/import/images')
const outDir = path.resolve(flag('--out', path.join(root, 'reference/artifacts/nuxt-browser')), page)
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
const PORT = Number(process.env.CDP_PORT ?? 9334)
const TIMEOUT = Number(process.env.TIMEOUT ?? 15 * 60_000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      // 继续轮询
    }
    await sleep(300)
  }
  throw new Error(`timeout: ${label}`)
}

// 临时目录用系统默认：Linux 上是 /tmp，Windows 上不会因为 /tmp 不存在而 ENOENT。
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'noteflow-edge-'))
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
    url
  ],
  { stdio: 'ignore' }
)
// 临时 profile 有几百 MB：退出时连同浏览器一起清理，避免 /tmp 被历次验收堆满。
process.on('exit', () => {
  browser.kill('SIGKILL')
  fs.rmSync(profile, { recursive: true, force: true })
})

const version = await waitFor(async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
  return (await response.json()).webSocketDebuggerUrl
}, 30_000, 'devtools endpoint')

const targets = await waitFor(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const found = list.filter(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
  return found.length > 0 ? found : null
}, 30_000, 'page target')

void version
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
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ')
    if (text) console.log(`[console] ${text}`)
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

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')

// 页面在连接前已经启动：先给新文档写入跳过标记，再重新加载，让安装提示不要出现。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('noteflow:install:off', '1') } catch {}`
})
await send('Page.reload')
await sleep(400)

await waitFor(() => evaluate('document.readyState === \'complete\''), 60_000, 'page load')
// 事件要在 Vue 挂载（监听器绑定）之后再派发，否则会被静默丢弃。
await waitFor(() => evaluate('Boolean(document.querySelector("#__nuxt")?.__vue_app__)'), 60_000, 'vue mount')
await sleep(500)

console.log(`browser ${await evaluate('navigator.userAgent')}`)
console.log(`url ${await evaluate('location.href')}`)
console.log(`crossOriginIsolated=${await evaluate('crossOriginIsolated')}`)

const statusOf = () =>
  evaluate(`document.querySelector('[data-test="status"]')?.textContent?.trim() ?? ''`)

/** 把图片塞进页面真实的 file input，并返回它拿到的文件信息。 */
async function attach() {
  const { root } = await send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  if (!nodeId) throw new Error('file input not found')
  await send('DOM.setFileInputFiles', { nodeId, files: [image] })
  // 部分 Chromium 构建只写入 files 而不派发 change，这里补一次。页面收到事件后会立刻清空
  // input.value，因此已经派发过的实现不会走到这里，也就不会重复识别。
  return evaluate(`(() => {
    const input = document.querySelector('input[type=file]')
    if (!input || input.files.length === 0) return null
    const file = input.files[0]
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { name: file.name, size: file.size }
  })()`)
}

console.log(`image ${image}`)
let accepted = false
for (let attempt = 1; attempt <= 3 && !accepted; attempt += 1) {
  const attached = await attach()
  console.log(attached ? `attached ${attached.name} (${attached.size} bytes)` : 'attached via native change event')
  accepted = await waitFor(async () => (await statusOf()) !== '等待图片', 5_000, 'recognition start')
    .then(() => true)
    .catch(() => false)
  if (!accepted) console.log('  page did not react to the file, retrying')
}
if (!accepted) throw new Error('page never picked up the image')

// 选好的页面先停在缩略图网格里，点“开始识别”才进入 Worker。
const startButton = await evaluate(
  `Boolean(document.querySelector('[data-test="start-recognition"]'))`
)
if (startButton) {
  await evaluate(`document.querySelector('[data-test="start-recognition"]').click()`)
  await sleep(300)
}

const started = Date.now()
const deadline = started + TIMEOUT
let last = ''

while (Date.now() < deadline) {
  const status = await statusOf()
  if (status && status !== last) {
    console.log(`  ${status}`)
    last = status
  }
  if (status.startsWith('识别完成')) break
  if (status.includes('失败') || status.includes('取消')) {
    throw new Error(status)
  }
  await sleep(1000)
}
if (!last.startsWith('识别完成')) throw new Error(`timeout: recognition (last status: ${last})`)

const result = await evaluate(`(() => {
  const pairs = {}
  const dl = document.querySelector('[data-test="result"] dl')
  if (dl) {
    for (const dt of dl.querySelectorAll('dt')) {
      pairs[dt.textContent.trim()] = dt.nextElementSibling?.textContent?.trim() ?? ''
    }
  }
  return {
    status: document.querySelector('[data-test="status"]')?.textContent?.trim() ?? '',
    counts: pairs,
    musicxml: document.querySelector('[data-test="musicxml"]')?.textContent ?? '',
    runtime: document.querySelector('[data-test="runtime"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
  }
})()`)

const elapsed = Date.now() - started
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, `${page}.musicxml`), result.musicxml)

/**
 * 基准按可信度排序：
 *   browser            参考实现（reference/homr-web）在同一张图上的浏览器输出，本移植的直接对照；
 *   browser-reference  历史存档，标题取自 `Andante.jpg`，个别记号数是 Python 链的结果；
 *   python             Python 链输出，浏览器链本来就和它在少数记号上不一致。
 */
const baselines = [
  ['browser', '参考实现浏览器输出'],
  ['browser-reference', '历史存档'],
  ['python', 'Python 链']
]

const current = result.musicxml.trim()
const comparisons = []
for (const [dir, label] of baselines) {
  const file = path.join(root, 'reference/artifacts', dir, page, `${page}.musicxml`)
  if (!fs.existsSync(file)) continue
  const reference = fs.readFileSync(file, 'utf8').trim()
  let firstDiff = null
  if (current !== reference) {
    const a = current.split('\n')
    const b = reference.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        firstDiff = { line: i + 1, current: a[i] ?? '<missing>', reference: b[i] ?? '<missing>' }
        break
      }
    }
  }
  comparisons.push({ dir, label, baseline: path.relative(root, file), identical: current === reference, firstDiff })
}
/** 只有参考实现的浏览器基准是硬要求，其余只报告差异。 */
const primary = comparisons.find(entry => entry.dir === 'browser') ?? null

const report = {
  page,
  url,
  image: path.relative(root, image),
  elapsedMs: elapsed,
  status: result.status,
  counts: result.counts,
  runtime: result.runtime,
  musicxmlBytes: result.musicxml.length,
  comparison: primary,
  comparisons,
  generatedAt: new Date().toISOString()
}
fs.writeFileSync(path.join(outDir, `${page}.run.json`), `${JSON.stringify(report, null, 2)}\n`)

const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
fs.writeFileSync(path.join(outDir, `${page}.png`), Buffer.from(screenshot.data, 'base64'))

console.log(`elapsed ${(elapsed / 1000).toFixed(1)} s`)
console.log(`counts ${JSON.stringify(result.counts)}`)
console.log(`musicxml ${result.musicxml.length} chars -> ${path.relative(root, outDir)}`)
if (comparisons.length === 0) console.log('没有找到基准，跳过对比')
for (const entry of comparisons) {
  const diff = entry.firstDiff ? `，第 ${entry.firstDiff.line} 行起不同` : ''
  console.log(`${entry.label}：${entry.identical ? '逐字节一致' : `有差异${diff}`}（${entry.baseline}）`)
}

const ok = result.musicxml.length > 0
  && result.status.startsWith('识别完成')
  && (primary === null || primary.identical)
socket.close()
browser.kill('SIGKILL')
process.exit(ok ? 0 : 1)
