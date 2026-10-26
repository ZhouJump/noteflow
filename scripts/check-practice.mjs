/**
 * M6 验收：用真实浏览器和“假麦克风”走一遍 MusicXML 导入 → 跟随练习。
 *
 *   node scripts/check-practice.mjs [--url http://127.0.0.1:3000]
 *
 * 先启动开发服务器（pnpm dev）。脚本生成一份四拍双手的 MusicXML（右手 C5 D5 E5 F5，
 * 左手 C4 D4 E4 F4）和对应的 WAV，让 Edge 通过 `--use-file-for-fake-audio-capture`
 * 把 WAV 当作麦克风输入；应用走的是真实的 getUserMedia → AudioContext → Pitchy
 * → 跟踪器链路，不是页面里的测试钩子。
 *
 * WAV 开头先反复只演奏右手 C5：验证没有同时按下两只手时游标停在第一个音；随后才是
 * 双手交替的八个音。验证：练习状态条出现、左右手各有一个目标箭头、单手中途不推进、
 * 两手都演奏才推进、可以暂停与恢复、点击音符可以定位、结束练习后释放面板与箭头。
 * 截图和报告写到 reference/artifacts/m6/。
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

const base = flag('--url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const outDir = path.resolve(flag('--out', path.join(root, 'reference/artifacts/m6')))
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
const PORT = Number(process.env.CDP_PORT ?? 9336)
// 临时目录用系统默认：Linux 上是 /tmp，Windows 上不会因为 /tmp 不存在而 ENOENT。
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noteflow-m6-'))
const fixturePath = path.join(workDir, 'practice.musicxml')
const singlePath = path.join(workDir, 'single.musicxml')
const wavPath = path.join(workDir, 'practice.wav')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function writeFixture() {
  const note = (step, octave, staff) => `      <note>
        <pitch><step>${step}</step><octave>${octave}</octave></pitch>
        <duration>1</duration>
        <voice>${staff}</voice>
        <type>quarter</type>
        <staff>${staff}</staff>
      </note>`
  const right = [['C', 5], ['D', 5], ['E', 5], ['F', 5]]
    .map(([step, octave]) => note(step, octave, 1))
    .join('\n')
  const left = [['C', 4], ['D', 4], ['E', 4], ['F', 4]]
    .map(([step, octave]) => note(step, octave, 2))
    .join('\n')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>跟随测试</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
${right}
      <backup><duration>4</duration></backup>
${left}
    </measure>
  </part>
</score-partwise>
`
  fs.writeFileSync(fixturePath, xml)

  // 单谱表：只有一只手，用来验证声部筛选不出现。
  const single = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>单谱表测试</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Violin</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>1</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
      </attributes>
${right}
    </measure>
  </part>
</score-partwise>
`
  fs.writeFileSync(singlePath, single)
}

/**
 * 生成 48kHz/16bit 单声道 WAV。开头 6 秒只反复演奏右手 C5（每音 0.3 秒、间隔 0.45 秒），
 * 用来验证单手不推进；随后静音 1.2 秒，进入双手循环：按拍先右手、再左手（C5/C4、
 * D5/D4、E5/E4、F5/F4），每音 0.3 秒、间隔 0.08 秒，结尾 1 秒静音，循环三遍。
 */
function writeWav() {
  const sampleRate = 48_000
  const mids = [72, 60, 74, 62, 76, 64, 77, 65]
  const tone = 0.3
  const gap = 0.08
  const rootMidi = 72
  const rootCount = 8
  const rootCycle = 0.75
  const leadIn = rootCount * rootCycle
  const lead = 1.2
  const tail = 1
  const cycle = lead + mids.length * (tone + gap) + tail
  const totalSamples = Math.ceil((leadIn + cycle * 3) * sampleRate)
  const data = Buffer.alloc(totalSamples * 2)
  const fade = 0.012

  const sample = (midi, position) => {
    const frequency = 440 * 2 ** ((midi - 69) / 12)
    const envelope = Math.min(1, position / fade, (tone - position) / fade)
    return 0.35 * Math.sin(2 * Math.PI * frequency * position) * envelope
  }

  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / sampleRate
    let amplitude = 0
    if (time < leadIn) {
      // 只有右手：反复演奏第一个目标里的 C5，跟踪器应停留在 partial。
      const position = time % rootCycle
      if (position < tone) amplitude = sample(rootMidi, position)
    } else {
      const cycleTime = (time - leadIn) % cycle
      if (cycleTime >= lead) {
        const local = cycleTime - lead
        const noteIndex = Math.floor(local / (tone + gap))
        if (noteIndex < mids.length) {
          const position = local - noteIndex * (tone + gap)
          if (position < tone) amplitude = sample(mids[noteIndex], position)
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'noteflow-m6-edge-'))
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
// 浏览器刚被 SIGKILL 时目录里可能还在写入，删除要带重试且不能把退出钩子拖崩。
function removeDir(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // 剩下一点临时文件交给系统回收，不影响验收结果。
  }
}
process.on('exit', () => {
  browser.kill('SIGKILL')
  removeDir(profile)
  removeDir(workDir)
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
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="import-musicxml-confirm"]\'))'),
    10_000,
    'import dialog'
  )
  await click('[data-test="import-musicxml-confirm"]')
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
  check('导入乐谱渲染出八个音', notes === 8, `${notes} 个音符`)

  await click('[data-test="mode-practice"]')
  await click('[data-test="transport-toggle"]')
  const practiceStartedAt = Date.now()
  const panel = await waitFor(async () => {
    const error = await text('[data-test="practice-error"]')
    if (error.length > 0) throw new Error(error)
    const progress = await text('[data-test="practice-progress"]')
    return progress.includes('/ 4') ? progress : ''
  }, 20_000, 'practice panel')
  check('打开跟随面板', panel.includes('跟随练习'), panel)

  const listening = await waitFor(async () => {
    const error = await text('[data-test="practice-error"]')
    if (error.length > 0) throw new Error(error)
    const status = await text('[data-test="practice-status"]')
    return status.length > 0 && status !== '正在打开麦克风' ? status : ''
  }, 20_000, 'microphone listening')
  check('麦克风进入监听状态', listening.length > 0, listening)

  const arrows = await waitFor(async () => {
    const colors = await evaluate(`(() => [...document.querySelectorAll('[data-test="practice-arrow"]')]
      .map(element => element.getAttribute('fill') ?? getComputedStyle(element).backgroundColor))()`)
    return colors.length === 2 ? colors : null
  }, 20_000, 'hand arrows')
  check('左右手各有一个目标箭头', arrows.length === 2 && new Set(arrows).size === 2, arrows.join(' / '))
  const handIcons = await evaluate(`(() => {
    const left = document.querySelector('[data-test="hand-left"]')
    const right = document.querySelector('[data-test="hand-right"]')
    if (!left || !right) return null
    return {
      leftColor: getComputedStyle(left).color,
      leftTint: getComputedStyle(left).backgroundColor,
      rightColor: getComputedStyle(right).color,
      rightTint: getComputedStyle(right).backgroundColor,
      leftMirrored: left.querySelector('.iconify')?.getAttribute('class')?.includes('-scale-x-100') ?? false
    }
  })()`)
  check(
    '左右手图标用各自主题色',
    handIcons !== null
    && handIcons.leftColor === 'rgb(185, 28, 28)'
    && handIcons.rightColor === 'rgb(29, 78, 216)'
    && handIcons.leftTint === 'rgb(254, 226, 226)'
    && handIcons.rightTint === 'rgb(219, 234, 254)',
    handIcons === null ? '手形图标不存在' : `${handIcons.leftColor} / ${handIcons.rightColor}`
  )
  check('左手图标镜像显示', handIcons?.leftMirrored === true)
  const filled = await count('.nf-playing')
  check('跟随目标不再用填充色高亮', filled === 0, `${filled} 个填充高亮`)
  await screenshot('practice-listening.png')

  // 前 6 秒假音频只演奏右手：状态应保持“正在聆听”，游标停在第一个音不推进。
  let waiting = ''
  let stayedOnFirst = true
  while (stayedOnFirst) {
    const status = await text('[data-test="practice-status"]')
    const progress = await text('[data-test="practice-progress"]')
    waiting = `${progress} · ${status}`
    if (!progress.includes('第 1 / 4') || !status.startsWith('正在聆听')) stayedOnFirst = false
    if (Date.now() - practiceStartedAt >= 3500) break
    await sleep(200)
  }
  check('只演奏右手时停在第一个音', stayedOnFirst && waiting.includes('第 1 / 4'), waiting)

  const advanced = await waitFor(async () => {
    const value = await text('[data-test="practice-progress"]')
    const match = value.match(/第 (\d+) \/ 4/)
    if (match && Number(match[1]) >= 3) return value
    return value.includes('4 音完成') ? value : ''
  }, 30_000, 'pitch tracking advanced')
  check('音高推进练习游标', advanced.length > 0, advanced)
  await screenshot('practice-advanced.png')

  await click('[data-test="transport-toggle"]')
  const paused = await waitFor(async () => {
    const status = await text('[data-test="practice-status"]')
    return status.includes('已暂停') ? status : ''
  }, 10_000, 'practice paused')
  check('可以暂停练习', paused.length > 0, paused)
  await sleep(600)
  const stillPaused = await text('[data-test="practice-status"]')
  check('暂停期间不再推进', stillPaused.includes('已暂停'), stillPaused)
  await screenshot('practice-paused.png')

  await click('[data-test="transport-toggle"]')
  const resumed = await waitFor(async () => {
    const status = await text('[data-test="practice-status"]')
    return status.length > 0 && !status.includes('已暂停') && status !== '正在打开麦克风' ? status : ''
  }, 10_000, 'practice resumed')
  check('可以恢复练习', resumed.length > 0, resumed)

  await click('[data-test="transport-stop"]')
  await waitFor(() => evaluate('!document.querySelector(\'[data-test="practice-panel"]\')'), 10_000, 'panel closed')
  const cleared = await count('[data-test="practice-arrow"]')
  check('结束练习后关闭面板并清除箭头', cleared === 0, `${cleared} 个箭头`)

  // 重新开始后立刻点第三个音：手动定位，不依赖音频进度。
  await click('[data-test="transport-toggle"]')
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
  check(
    '点击音符重新定位练习位置',
    sought.length > 0 && (current === 'E4 · E5' || current === '完成'),
    `${sought} · ${current}`
  )
  await screenshot('practice-seek.png')

  await click('[data-test="transport-stop"]')
  const panelGone = await waitFor(
    () => evaluate('!document.querySelector(\'[data-test="practice-panel"]\')'),
    10_000,
    'panel closed again'
  )
  check('可以再次结束练习', panelGone === true)

  // ---- 单谱表：没有双手就不显示声部筛选 ----
  await open('/import/musicxml')
  await attachFiles('input[type=file]', [singlePath])
  await waitFor(async () => {
    const value = await text('[data-test="musicxml-preview"]')
    return value.includes('小节') ? value : ''
  }, 60_000, 'single staff preview')
  await click('[data-test="import-musicxml"]')
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-test="import-musicxml-confirm"]\'))'),
    10_000,
    'single staff dialog'
  )
  await click('[data-test="import-musicxml-confirm"]')
  await waitFor(
    () => evaluate('location.pathname').then(value => (value.startsWith('/scores/') ? value : '')),
    120_000,
    'single staff score'
  )
  await waitFor(async () => (await text('[data-test="page-title"]')).length > 0, 60_000, 'single staff title')
  await waitFor(
    () => evaluate('document.querySelectorAll(\'[data-test="score-surface"] [id^="nf-"]\').length'),
    180_000,
    'single staff render'
  )
  const handControls = await evaluate(`({
    left: Boolean(document.querySelector('[data-test="hand-left"]')),
    right: Boolean(document.querySelector('[data-test="hand-right"]'))
  })`)
  check(
    '单谱表不显示声部筛选',
    handControls.left === false && handControls.right === false,
    `左手 ${handControls.left} / 右手 ${handControls.right}`
  )

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
    paused,
    resumed,
    arrows,
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
