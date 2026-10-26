/**
 * M7 验收：评分引擎回归 + 真实浏览器评分流程。
 *
 *   node scripts/check-scoring.mjs [--url http://127.0.0.1:3000] [--pure]
 *
 * 前半段不启动浏览器，用合成音高帧验证 `ScoreTracker`：首音锚定、完美/良好/
 * 偏早/偏晚、错音、八度、漏音、暂停后重新锚定与主动结束；`--pure` 只跑这一半。
 * 后半段生成一份八音单声部
 * MusicXML 和 60 BPM 的 WAV，让 Edge 把 WAV 当作麦克风，走完整的
 * getUserMedia → Pitchy → 评分时间线 → 成绩对话框 → IndexedDB 历史记录。
 *
 * 报告写到 reference/artifacts/m7/scoring.run.json。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// 源码里的相对导入省略了 `.ts`（Nuxt/Vite 能解析）；Node 直接跑 TS 时需要补上。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts') && context.parentURL?.endsWith('.ts')) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})

const {
  SCORE_OUTCOME_LABELS,
  ScoreTracker,
  buildScoreNotes,
  scoreGrade
} = await import('../app/lib/audio/scoring.ts')
const {
  buildPracticeTargets,
  frequencyForMidi
} = await import('../app/lib/audio/practice.ts')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const pureOnly = process.argv.includes('--pure')
const base = flag('--url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const outDir = path.resolve(flag('--out', path.join(root, 'reference/artifacts/m7')))
const BROWSER = process.env.BROWSER ?? '/usr/bin/microsoft-edge'
const PORT = Number(process.env.CDP_PORT ?? 9337)
const workDir = fs.mkdtempSync('/tmp/noteflow-m7-')
const fixturePath = path.join(workDir, 'scoring.musicxml')
const wavPath = path.join(workDir, 'scoring.wav')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `（${detail}）` : ''}`)
  return ok
}

/** 构造只带跟踪需要字段的音符；序号即文档顺序。 */
function note(index, step, octave, onset, extra = {}) {
  return {
    index,
    pitch: { step, alter: 0, octave },
    onset,
    partId: 'P1',
    staff: 1,
    isRest: false,
    isGrace: false,
    tieStart: false,
    tieStop: false,
    ...extra
  }
}

const frame = (midi, at, options = {}) => ({
  frequency: midi === null ? null : frequencyForMidi(midi),
  clarity: 0.95,
  rms: 0.1,
  at,
  ...options
})

function feed(tracker, midi, at, count = 4) {
  let update = tracker.state()
  for (let index = 0; index < count; index += 1) {
    update = tracker.push(frame(midi, at + index * 60))
  }
  return update
}

function runPureChecks() {
  check('七种评分结果都有中文标签', Object.keys(SCORE_OUTCOME_LABELS).length === 7)
  check('成绩等级随准确度变化', scoreGrade(96) === '非常稳' && scoreGrade(60) === '再练一遍')

  const targets = buildPracticeTargets([
    note(0, 'C', 4, 0),
    note(1, 'D', 4, 1),
    note(2, 'E', 4, 2),
    note(3, 'F', 4, 3),
    note(4, 'G', 4, 4)
  ])
  const notes = buildScoreNotes(targets)
  check(
    '评分音符沿用拍点与全局序号',
    notes.length === 5
    && notes.map(entry => entry.onset).join(',') === '0,1,2,3,4'
    && notes.map(entry => entry.index).join(',') === '0,1,2,3,4',
    notes.map(entry => `${entry.label}@${entry.onset}`).join(' / ')
  )

  const hands = buildScoreNotes(buildPracticeTargets([
    note(0, 'C', 5, 0, { staff: 1 }),
    note(1, 'C', 4, 0, { staff: 2 }),
    note(2, 'D', 5, 1, { staff: 1 }),
    note(3, 'D', 4, 1, { staff: 2 })
  ]))
  check(
    '同一拍点的两只手拆成两个评分音',
    hands.length === 4
    && hands[0].onset === 0
    && hands[1].onset === 0
    && hands[0].hand !== hands[1].hand,
    hands.map(entry => entry.label).join(' / ')
  )

  let tracker = new ScoreTracker(notes, { bpm: 60 })
  let update = tracker.start()
  check(
    '开始后等待首音',
    update.phase === 'waiting' && update.total === 5 && update.current?.label === 'C4',
    `${update.phase} / ${update.current?.label}`
  )
  update = tracker.push(frame(null, 500, { clarity: 0, rms: 0 }))
  check('首音落下前不推进', update.phase === 'waiting' && update.judged === 0, update.phase)

  update = feed(tracker, 60, 1000)
  check(
    '首音锚定时间线',
    update.phase === 'running' && update.judged === 1 && update.last?.outcome === 'perfect',
    `${update.last?.outcome} / ${update.last?.deviationMs}ms`
  )

  update = feed(tracker, 62, 2000)
  check('准点音判为完美', update.last?.outcome === 'perfect' && update.perfect === 2, `${update.last?.outcome}`)

  update = feed(tracker, 64, 3300)
  check(
    '偏晚 300ms 判为偏晚',
    update.last?.outcome === 'late' && Math.abs((update.last?.deviationMs ?? 0) - 300) <= 1,
    `${update.last?.outcome} / ${update.last?.deviationMs}ms`
  )

  update = feed(tracker, 65, 3700)
  check(
    '偏早 300ms 判为偏早',
    update.last?.outcome === 'early' && Math.abs((update.last?.deviationMs ?? 0) + 300) <= 1,
    `${update.last?.outcome} / ${update.last?.deviationMs}ms`
  )

  update = feed(tracker, null, 5600, 1)
  check(
    '超过窗口记漏音并结束',
    update.phase === 'finished' && update.missed === 1,
    `${update.phase} / 漏 ${update.missed}`
  )
  let summary = tracker.summary()
  check(
    '成绩统计逐音结果',
    summary !== null
    && summary.total === 5
    && summary.judged === 5
    && summary.perfect === 2
    && summary.good === 2
    && summary.missed === 1
    && summary.accuracy === 70
    && summary.durationMs === 4600,
    summary === null ? '没有成绩' : `${summary.accuracy} 分 / ${summary.durationMs}ms`
  )

  // 错音：同一时间窗内最近的待判音记 0 分，并保留实际听到的音高。
  const wrongNotes = buildScoreNotes(buildPracticeTargets([
    note(0, 'C', 4, 0),
    note(1, 'D', 4, 1)
  ]))
  tracker = new ScoreTracker(wrongNotes, { bpm: 60 })
  tracker.start()
  feed(tracker, 60, 1000)
  update = feed(tracker, 67, 2000)
  summary = tracker.summary()
  check(
    '错音记 0 分并保留听到的音',
    update.last?.outcome === 'wrong'
    && update.last?.heard === 67
    && summary?.wrong === 1
    && summary.accuracy === 50,
    `${update.last?.outcome} / 听到 ${update.last?.heard} / ${summary?.accuracy} 分`
  )

  // 八度：音高按 0.8 计权。
  const octaveNotes = buildScoreNotes(buildPracticeTargets([note(0, 'C', 4, 0)]))
  tracker = new ScoreTracker(octaveNotes, { bpm: 60 })
  tracker.start()
  update = feed(tracker, 72, 1000)
  check(
    '八度等价按 0.8 音高分计',
    update.last?.outcome === 'octave' && update.accuracy === 88,
    `${update.last?.outcome} / ${update.accuracy} 分`
  )

  // 暂停：恢复后回到等待当前未判音，等它落下再建立新的时间原点。
  tracker = new ScoreTracker(buildScoreNotes(buildPracticeTargets([
    note(0, 'C', 4, 0),
    note(1, 'D', 4, 1),
    note(2, 'E', 4, 2)
  ])), { bpm: 60 })
  tracker.start()
  feed(tracker, 60, 1000)
  update = tracker.pause(1400)
  check('暂停后冻结时间线', update.phase === 'paused' && update.judged === 1, update.phase)
  update = tracker.push(frame(62, 1800))
  check('暂停期间不吃帧', update.phase === 'paused' && update.judged === 1, update.phase)
  update = tracker.resume(2400)
  check('恢复后回到等待当前音', update.phase === 'waiting', update.phase)
  update = feed(tracker, 62, 3000)
  check(
    '恢复后演奏当前音重新锚定为完美',
    update.last?.outcome === 'perfect' && update.phase === 'running',
    `${update.last?.outcome} / ${update.phase}`
  )
  tracker.stop(3400)
  summary = tracker.summary()
  check(
    '暂停与等待时长不计入演奏时长',
    summary !== null && summary.durationMs >= 750 && summary.durationMs <= 850,
    `${summary?.durationMs}ms`
  )

  // 还在等首音时结束：本次取消，不产生成绩。
  tracker = new ScoreTracker(notes, { bpm: 60 })
  tracker.start()
  const cancelled = tracker.stop(1200)
  check('等待首音时结束不产生成绩', cancelled === null && tracker.state().phase === 'idle')

  // 开始后主动结束：未演奏的音补齐为漏音。
  tracker = new ScoreTracker(buildScoreNotes(buildPracticeTargets([
    note(0, 'C', 4, 0),
    note(1, 'D', 4, 1)
  ])), { bpm: 60 })
  tracker.start()
  feed(tracker, 60, 1000)
  summary = tracker.stop(1500)
  check(
    '主动结束补齐剩余漏音',
    summary !== null
    && summary.total === 2
    && summary.missed === 1
    && summary.durationMs === 500,
    summary === null ? '没有成绩' : `${summary.missed} 漏音 / ${summary.durationMs}ms`
  )
}

function writeFixture() {
  const note = (step, octave) => `      <note>
        <pitch><step>${step}</step><octave>${octave}</octave></pitch>
        <duration>1</duration>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
      </note>`
  const first = [['C', 4], ['D', 4], ['E', 4], ['F', 4]]
    .map(([step, octave]) => note(step, octave))
    .join('\n')
  const second = [['G', 4], ['A', 4], ['B', 4], ['C', 5]]
    .map(([step, octave]) => note(step, octave))
    .join('\n')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>评分测试</work-title></work>
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
${first}
    </measure>
    <measure number="2">
${second}
    </measure>
  </part>
</score-partwise>
`
  fs.writeFileSync(fixturePath, xml)
}

/** 60 BPM 的八个四分音符：1 秒静音后每 1 秒一个音，音长 0.35 秒。 */
function writeWav() {
  const sampleRate = 48_000
  const mids = [60, 62, 64, 65, 67, 69, 71, 72]
  const lead = 1
  const step = 1
  const tone = 0.35
  const tail = 2
  const totalSamples = Math.ceil((lead + mids.length * step + tail) * sampleRate)
  const data = Buffer.alloc(totalSamples * 2)
  const fade = 0.012

  const sample = (midi, position) => {
    const frequency = 440 * 2 ** ((midi - 69) / 12)
    const envelope = Math.min(1, position / fade, (tone - position) / fade)
    return 0.35 * Math.sin(2 * Math.PI * frequency * position) * envelope
  }

  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / sampleRate
    const local = time - lead
    let amplitude = 0
    if (local >= 0) {
      const noteIndex = Math.floor(local / step)
      if (noteIndex < mids.length) {
        const position = local - noteIndex * step
        if (position < tone) amplitude = sample(mids[noteIndex], position)
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

async function runBrowserChecks() {
  writeFixture()
  writeWav()
  const profile = fs.mkdtempSync('/tmp/noteflow-m7-edge-')
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
  const cleanup = () => {
    browser.kill('SIGKILL')
    try {
      // 浏览器刚被 SIGKILL 时目录里可能还在写入，删除要带重试且不能把退出钩子拖崩。
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // 剩下一点临时文件交给系统回收，不影响验收结果。
    }
  }
  process.on('exit', cleanup)

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

  async function mouseClick(expression) {
    const point = await evaluate(`(() => {
      const element = ${expression}
      if (!element) return null
      element.scrollIntoView({ block: 'center' })
      const rect = element.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    if (point === null) throw new Error(`元素不存在：${expression}`)
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1
    })
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

  function readRuns(scoreId) {
    return evaluate(`(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('noteflow')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const rows = await new Promise((resolve, reject) => {
        const request = database.transaction('runs', 'readonly').objectStore('runs').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      database.close()
      return rows
        .filter(entry => entry.scoreId === ${JSON.stringify(scoreId)})
        .map(entry => ({
          id: entry.id,
          bpm: entry.bpm,
          beats: entry.beats,
          beatType: entry.beatType,
          accuracy: entry.accuracy,
          total: entry.total,
          perfect: entry.perfect,
          good: entry.good,
          missed: entry.missed,
          wrong: entry.wrong,
          notes: entry.notes.length,
          finishedAt: entry.finishedAt
        }))
    })()`)
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

  try {
    await open('/import/musicxml')
    await attachFiles('input[type=file]', [fixturePath])
    const preview = await waitFor(async () => {
      const value = await text('[data-test="musicxml-preview"]')
      return value.includes('8 个音符') ? value : ''
    }, 60_000, 'musicxml preview')
    check('评分用 MusicXML 解析出八个音', preview.length > 0, preview.replace(/\s+/g, ' ').slice(0, 80))

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
    await waitFor(
      () => evaluate('document.querySelectorAll(\'[data-test="score-surface"] [id^="nf-"]\').length === 8'),
      180_000,
      'verovio render'
    )
    check('曲谱页渲染出八个音', true)

    // 假麦克风按 60 BPM 演奏；先把本题 BPM 改成 60。
    await click('[data-test="bpm-value"]')
    await waitFor(
      () => evaluate('Boolean(document.querySelector(\'[data-test="bpm-input"]\'))'),
      5_000,
      'bpm input'
    )
    await evaluate('document.querySelector(\'[data-test="bpm-input"]\').select()')
    await send('Input.insertText', { text: '60' })
    await click('[data-test="bpm-confirm"]')
    await waitFor(async () => (await text('[data-test="bpm-value"]')) === '60', 5_000, 'bpm 60')

    await click('[data-test="mode-score"]')
    await click('[data-test="transport-toggle"]')
    const waiting = await waitFor(async () => {
      const error = await text('[data-test="score-error"]')
      if (error.length > 0) throw new Error(error)
      const status = await text('[data-test="score-status"]')
      return status.includes('等待首音') || status.includes('演奏当前音') ? status : ''
    }, 20_000, 'score waiting')
    check('评分先等待首音', waiting.length > 0, waiting)
    const total = await text('[data-test="score-progress"]')
    check('评分进度显示总音数', total.includes('/ 8'), total)
    await screenshot('scoring-waiting.png')

    await waitFor(
      () => evaluate('Boolean(document.querySelector(\'[data-test="score-result"]\'))'),
      30_000,
      'score result'
    )
    const resultText = await text('[data-test="score-result"]')
    const resultNotes = await count('[data-test="score-result-note"]')
    const meta = await text('[data-test="score-result-meta"]')
    const score = Number.parseInt(resultText, 10)
    check('演奏八个音后弹出成绩', resultNotes === 8 && Number.isFinite(score), `${score} 分 / ${resultNotes} 音`)
    check('成绩记录节奏与 BPM', meta.includes('4/4') && meta.includes('60 BPM'), meta.replace(/\s+/g, ' '))
    check('假麦克风的音准达到良好', score >= 75, `${score} 分`)
    await screenshot('scoring-result.png')

    const runs = await waitFor(async () => {
      const rows = await readRuns(scoreId)
      return rows.length > 0 ? rows : null
    }, 15_000, 'score run stored')
    const run = runs[0]
    check(
      '成绩写入 IndexedDB',
      run !== undefined
      && run.total === 8
      && run.notes === 8
      && run.bpm === 60
      && run.beats === 4
      && run.beatType === 4,
      run === undefined ? '没有记录' : `${run.accuracy} 分 / ${run.notes} 音 / ${run.bpm} BPM`
    )
    check(
      '漏音与错音为零',
      run !== undefined && run.missed === 0 && run.wrong === 0,
      run === undefined ? '' : `漏 ${run.missed} / 错 ${run.wrong}`
    )

    await click('[data-test="score-result-close"]')
    await waitFor(
      () => evaluate('!document.querySelector(\'[data-test="score-result"]\')'),
      10_000,
      'result closed'
    )

    await mouseClick('document.querySelector(\'button[aria-label="更多操作"]\')')
    await waitFor(
      () => evaluate('document.querySelectorAll(\'[role="menuitem"]\').length > 0'),
      5_000,
      'score menu'
    )
    await mouseClick(
      '[...document.querySelectorAll(\'[role="menuitem"]\')].find(item => item.textContent.includes(\'评分记录\'))'
    )
    const historyCount = await waitFor(async () => {
      const value = await count('[data-test="score-history-item"]')
      return value > 0 ? value : null
    }, 10_000, 'score history')
    check('菜单里的评分记录列出本次成绩', historyCount >= 1, `${historyCount} 条`)
    await screenshot('scoring-history.png')

    await click('[data-test="score-history-item"]')
    const detail = await waitFor(
      () => evaluate('Boolean(document.querySelector(\'[data-test="score-result"]\'))'),
      10_000,
      'history detail'
    )
    check('历史记录可以打开成绩详情', detail === true)
    await click('[data-test="score-result-close"]')

    // 暂停：继续后回到等待当前音，而不是沿用暂停前的时间线。
    await click('[data-test="transport-toggle"]')
    await waitFor(async () => {
      const phase = await evaluate('document.querySelector(\'[data-test="score-panel"]\')?.dataset.phase ?? \'\'')
      return phase === 'waiting' || phase === 'running' ? phase : ''
    }, 20_000, 'score restarted')
    await click('[data-test="transport-toggle"]')
    const paused = await waitFor(
      () => evaluate('document.querySelector(\'[data-test="score-panel"]\')?.dataset.phase ?? \'\'')
        .then(phase => (phase === 'paused' ? phase : '')),
      10_000,
      'score paused'
    )
    check('评分可以暂停', paused === 'paused', paused)
    await click('[data-test="transport-toggle"]')
    const resumed = await waitFor(
      () => evaluate('document.querySelector(\'[data-test="score-panel"]\')?.dataset.phase ?? \'\'')
        .then(phase => (phase === 'waiting' ? phase : '')),
      10_000,
      'score resumed waiting'
    )
    check('继续评分回到等待当前音', resumed === 'waiting', resumed)
    await click('[data-test="transport-stop"]')

    return { scoreId, score, resultNotes, meta, run, historyCount }
  } finally {
    socket.close()
    cleanup()
  }
}

let browserReport = null
let browserError = null
try {
  runPureChecks()
  browserReport = pureOnly ? null : await runBrowserChecks()
} catch (error) {
  browserError = error instanceof Error ? error.message : String(error)
  console.error(`[failure] ${browserError}`)
}

const failed = checks.filter(entry => !entry.ok)
const report = {
  ok: browserError === null && failed.length === 0,
  error: browserError,
  browser: browserReport,
  checks,
  generatedAt: new Date().toISOString()
}
fs.mkdirSync(outDir, { recursive: true })
const reportName = pureOnly ? 'scoring.pure.json' : 'scoring.run.json'
fs.writeFileSync(path.join(outDir, reportName), `${JSON.stringify(report, null, 2)}\n`)
console.log(`checks ${checks.length - failed.length}/${checks.length}`)
console.log(`report ${path.relative(root, path.join(outDir, reportName))}`)
process.exit(report.ok ? 0 : 1)
