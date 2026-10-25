/**
 * M6 验收：用真实浏览器和“假麦克风”走一遍 MusicXML 导入 → 跟弹练习。
 *
 *   node scripts/check-practice.mjs [--url http://127.0.0.1:3000]
 *
 * 先启动开发服务器（pnpm dev）。脚本生成一份四音（C4 D4 E4 F4）的 MusicXML 和
 * 同样四个音的 WAV，让 Edge 通过 `--use-file-for-fake-audio-capture` 把 WAV 当作
 * 麦克风输入；应用走的是真实的 getUserMedia → AudioContext → Pitchy → 跟踪器链路，
 * 不是页面里的测试钩子。
 *
 * 验证：练习面板出现、当前音在乐谱上高亮、音高推进游标、点击音符可以定位、
 * 结束练习后释放面板与高亮。截图和报告写到 reference/artifacts/m6/。
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

const base = flag('--url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const outDir = path.resolve(flag('--out', path.join(root, 'reference/artifacts/m6')))
const BROWSER = process.env.BROWSER ?? '/usr/bin/microsoft-edge'
const PORT = Number(process.env.CDP_PORT ?? 9336)
const workDir = fs.mkdtempSync('/tmp/noteflow-m6-')
const fixturePath = path.join(workDir, 'practice.musicxml')
const wavPath = path.join(workDir, 'practice.wav')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function writeFixture() {
  const note = (step, octave) => `      <note>
        <pitch><step>${step}</step><octave>${octave}</octave></pitch>
        <duration>1</duration>
        <voice>1</voice>
        <type>quarter</type>
      </note>`
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>跟弹测试</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
${[['C', 4], ['D', 4], ['E', 4], ['F', 4]].map(([step, octave]) => note(step, octave)).join('\n')}
    </measure>
  </part>
</score-partwise>
`
  fs.writeFileSync(fixturePath, xml)
}

/**
 * 生成 48kHz/16bit 单声道 WAV：开头 2 秒静音，然后 C4 D4 E4 F4 各 0.55 秒、
 * 间隔 0.15 秒，结尾 1 秒静音，整段重复三遍。开头静音让浏览器有时间建立练习
 * 会话，而不是一开始就落在旋律中间。
 */
function writeWav() {
  const sampleRate = 48_000
  const mids = [60, 62, 64, 65]
  const tone = 0.55
  const gap = 0.15
  const lead = 2
  const tail = 1
  const cycle = lead + mids.length * (tone + gap) + tail
  const totalSamples = Math.ceil(cycle * 3 * sampleRate)
  const data = Buffer.alloc(totalSamples * 2)
  const fade = 0.012

  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / sampleRate
    const cycleTime = time % cycle
    let amplitude = 0
    if (cycleTime >= lead) {
      const local = cycleTime - lead
      const noteIndex = Math.floor(local / (tone + gap))
      if (noteIndex < mids.length) {
        const position = local - noteIndex * (tone + gap)
        if (position < tone) {
          const frequency = 440 * 2 ** ((mids[noteIndex] - 69) / 12)
          const envelope = Math.min(1, position / fade, (tone - position) / fade)
          amplitude = 0.35 * Math.sin(2 * Math.PI * frequency * position) * envelope
        }
      }
    }
    data.writeInt16LE(Math.round(amplitude * 32767), index * 2)
  }

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
  fs.writeFileSync(wavPath, Buffer.concat([header, data]))
}

writeFixture()
writeWav()

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
    await sleep(250)
  }
  throw new Error(`timeout: ${label}${lastError ? `（${lastError.message}）` : ''}`)
}

const profile = fs.mkdtempSync('/tmp/noteflow-m6-edge-')
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
    `--use-file-for-fake-audio-capture=${wavPath}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
)
// 临时 profile 与假音频都有几百 MB：退出时一并清理。
process.on('exit', () => {
  browser.kill('SIGKILL')
  fs.rmSync(profile, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
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

async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, 'base64'))
}

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')
await send('Browser.grantPermissions', { origin: base, permissions: ['audioCapture'] })
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 1, mobile: true
})
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
  console.log(`musicxml ${fixturePath}`)
  console.log(`audio ${wavPath}`)

  await open('/import/musicxml')
  await attachFiles('input[type=file]', [fixturePath])
  const preview = await waitFor(async () => {
    const value = await text('[data-test="musicxml-preview"]')
    return value.includes('小节') ? value : ''
  }, 60_000, 'musicxml preview')
  check('MusicXML 解析预览', preview.length > 0, preview.replace(/\s+/g, ' ').slice(0, 80))

  await click('[data-test="import-musicxml"]')
  const scorePath = await waitFor(
    () => evaluate('location.pathname').then(value => (value.startsWith('/scores/') ? value : '')),
    120_000,
    'navigate to score'
  )
  const scoreId = scorePath.split('/').pop()
  const notes = await waitFor(
    () => evaluate('document.querySelectorAll(\'[data-test="score-surface"] [id^="nf-"]\').length'),
    180_000,
    'verovio render'
  )
  check('导入乐谱渲染出四个音', notes === 4, `${notes} 个音符`)

  await click('[data-test="practice-toggle"]')
  const panel = await waitFor(async () => {
    const error = await text('[data-test="practice-error"]')
    if (error.length > 0) throw new Error(error)
    const progress = await text('[data-test="practice-progress"]')
    return progress.includes('/ 4') ? progress : ''
  }, 20_000, 'practice panel')
  check('打开跟弹面板', panel.includes('跟弹练习'), panel)

  const listening = await waitFor(async () => {
    const error = await text('[data-test="practice-error"]')
    if (error.length > 0) throw new Error(error)
    const status = await text('[data-test="practice-status"]')
    return status.length > 0 && status !== '正在打开麦克风' ? status : ''
  }, 20_000, 'microphone listening')
  check('麦克风进入监听状态', listening.length > 0, listening)

  const playing = await count('.nf-playing')
  check('当前目标音在乐谱上高亮', playing >= 1, `${playing} 个高亮元素`)
  await screenshot('practice-listening.png')

  const advanced = await waitFor(async () => {
    const value = await text('[data-test="practice-progress"]')
    const match = value.match(/第 (\d+) \/ 4/)
    if (match && Number(match[1]) >= 3) return value
    return value.includes('4 音完成') ? value : ''
  }, 30_000, 'pitch tracking advanced')
  check('音高推进练习游标', advanced.length > 0, advanced)
  await screenshot('practice-advanced.png')

  await click('[data-test="practice-stop"]')
  await waitFor(() => evaluate('!document.querySelector(\'[data-test="practice-panel"]\')'), 10_000, 'panel closed')
  const cleared = await count('.nf-playing')
  check('结束练习后关闭面板并清除高亮', cleared === 0)

  // 重新开始后立刻点第三个音：手动定位，不依赖音频进度。
  await click('[data-test="practice-toggle"]')
  await waitFor(() => evaluate('Boolean(document.querySelector(\'[data-test="practice-panel"]\'))'), 20_000, 'practice reopened')
  await waitFor(async () => {
    const status = await text('[data-test="practice-status"]')
    return status.length > 0 && status !== '正在打开麦克风' ? status : ''
  }, 20_000, 'microphone reopened')

  await evaluate(`document.getElementById('nf-2')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  const sought = await waitFor(async () => {
    const value = await text('[data-test="practice-progress"]')
    return value.includes('第 3 / 4') || value.includes('4 音完成') ? value : ''
  }, 10_000, 'seek to third note')
  const current = await text('[data-test="practice-current"]')
  check('点击音符重新定位练习位置', sought.length > 0 && (current === 'E4' || current === '完成'), `${sought} · ${current}`)
  await screenshot('practice-seek.png')

  await click('[data-test="practice-stop"]')
  const panelGone = await waitFor(
    () => evaluate('!document.querySelector(\'[data-test="practice-panel"]\')'),
    10_000,
    'panel closed again'
  )
  check('可以再次结束练习', panelGone === true)

  report = {
    ok: true,
    base,
    fixture: path.relative(root, fixturePath),
    audio: path.relative(root, wavPath),
    scoreId,
    notes,
    panel,
    listening,
    advanced,
    sought,
    current,
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
fs.writeFileSync(path.join(outDir, 'practice.run.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`checks ${checks.filter(entry => entry.ok).length}/${checks.length}`)
console.log(`report ${path.relative(root, path.join(outDir, 'practice.run.json'))}`)

socket.close()
browser.kill('SIGKILL')
process.exit(report.ok ? 0 : 1)
