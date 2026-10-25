/**
 * M6 跟踪回归：不启动浏览器，用合成音高帧验证 `PracticeTracker` 的匹配规则。
 *
 *   node scripts/check-tracker.mjs
 *
 * 覆盖：稳定帧确认、持续音只算一次、错音不推进、向前窗口搜索、重复音需要重新
 * 起音、八度等价、低清晰度忽略、和弦/休止/装饰音/延音线整理、手动定位与超时提示。
 * 输出写到 reference/artifacts/m6/tracker.run.json。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PracticeTracker,
  buildPracticeTargets,
  frequencyForMidi,
  midiForFrequency,
  midiLabel
} from '../app/lib/audio/practice.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'reference/artifacts/m6')
fs.mkdirSync(outDir, { recursive: true })

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `（${detail}）` : ''}`)
  return ok
}

/** 构造只带跟踪需要的字段的音符；序号即文档顺序。 */
function note(index, step, octave, onset, extra = {}) {
  return {
    index,
    pitch: { step, alter: 0, octave },
    onset,
    partId: 'P1',
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

const quiet = at => frame(null, at, { clarity: 0, rms: 0 })

function feed(tracker, midi, at, count = 4, options = {}) {
  let update = tracker.state()
  for (let index = 0; index < count; index += 1) {
    update = tracker.push(frame(midi, at + index * 60, options))
  }
  return update
}

const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const A4 = 69
const C5 = 72

try {
  check('440Hz 对应 A4', Math.abs(midiForFrequency(440) - 69) < 1e-9)
  check('MIDI 音名', midiLabel(69) === 'A4' && midiLabel(61) === 'C#4', `${midiLabel(69)} / ${midiLabel(61)}`)

  const ascending = buildPracticeTargets([
    note(0, 'C', 4, 0),
    note(1, 'D', 4, 1),
    note(2, 'E', 4, 2),
    note(3, 'F', 4, 3)
  ])
  check(
    '目标按拍点排列',
    ascending.length === 4
    && ascending.map(target => target.label).join(',') === 'C4,D4,E4,F4'
    && ascending.map(target => target.lead).join(',') === '0,1,2,3',
    ascending.map(target => target.label).join(' / ')
  )

  let tracker = new PracticeTracker(ascending)
  let update = feed(tracker, C4, 1000)
  check('连续稳定帧推进一个音', update.position === 1 && update.outcome === 'matched', `${update.position} / ${update.total}`)

  update = feed(tracker, C4, 1240, 8)
  check('持续同一个音不重复推进', update.position === 1, `${update.position}`)

  update = feed(tracker, G4, 1720, 6)
  check('错音不推进', update.position === 1 && update.outcome === 'unmatched', `${update.outcome}`)

  update = feed(tracker, E4, 2080, 4)
  check('向前窗口内跳过漏音', update.position === 3 && update.skipped === 1 && update.outcome === 'skipped', `跳到第 ${update.position} 个目标`)

  update = feed(tracker, F4, 2320, 4)
  check('最后一个音完成后标记结束', update.done === true && update.position === update.total, `${update.position} / ${update.total}`)

  // 倒退音不能把游标拉回去：游标在 D4 时再弹 C4，保持不动。
  tracker = new PracticeTracker(ascending)
  feed(tracker, C4, 3000)
  feed(tracker, D4, 3240)
  update = feed(tracker, C4, 3480, 6)
  check('已越过的音不会倒退', update.position === 2, `${update.position}`)

  // 重复音：必须重新起音，而不是一直按住。
  const repeated = buildPracticeTargets([
    note(0, 'C', 4, 0),
    note(1, 'C', 4, 1),
    note(2, 'D', 4, 2)
  ])
  tracker = new PracticeTracker(repeated)
  feed(tracker, C4, 4000)
  update = feed(tracker, C4, 4240, 8)
  check('重复音持续发声只算一次', update.position === 1, `${update.position}`)
  for (let index = 0; index < 4; index += 1) tracker.push(quiet(4480 + index * 60))
  update = feed(tracker, C4, 4720)
  check('静音后同名音重新起音', update.position === 2, `${update.position}`)
  update = feed(tracker, D4, 4960)
  check('重复音结束', update.done === true, `${update.position} / ${update.total}`)

  // 八度误判：推进但单独标记。
  const octaveTargets = buildPracticeTargets([note(0, 'C', 4, 0), note(1, 'D', 4, 1)])
  tracker = new PracticeTracker(octaveTargets)
  update = feed(tracker, C5, 6000)
  check('八度等价推进并标记', update.position === 1 && update.octaveMatches === 1 && update.outcome === 'octave', `${update.outcome}`)

  // 清晰度不足的帧不能推进。
  tracker = new PracticeTracker(ascending)
  update = feed(tracker, C4, 7000, 10, { clarity: 0.5 })
  check('低清晰度不推进', update.position === 0, `${update.outcome}`)
  update = feed(tracker, C4, 7660, 4, { clarity: 0.95 })
  check('清晰度恢复后推进', update.position === 1, `${update.position}`)

  // 和弦与跨声部：同一拍点合并，弹中任意一个音都算。
  const chord = buildPracticeTargets([
    note(0, 'C', 4, 0, { partId: 'P1' }),
    note(1, 'E', 4, 0, { partId: 'P2' }),
    note(2, 'G', 4, 1, { partId: 'P1' })
  ])
  check(
    '同一拍点的音合并成和弦',
    chord.length === 2
    && chord[0].pitches.join(',') === '60,64'
    && chord[0].indices.join(',') === '0,1'
    && chord[0].label === 'C4 · E4',
    chord.map(target => target.label).join(' / ')
  )
  tracker = new PracticeTracker(chord)
  update = feed(tracker, E4, 8000)
  check('和弦中任意音推进', update.position === 1 && update.outcome === 'matched', `${update.position}`)

  // 休止符、装饰音和延音线后半段不作为目标。
  const filtered = buildPracticeTargets([
    note(0, 'C', 4, 0, { tieStart: true }),
    note(1, 'C', 4, 1, { tieStop: true }),
    note(2, 'C', 4, 2, { isRest: true, pitch: null }),
    note(3, 'E', 4, 3, { isGrace: true }),
    note(4, 'F', 4, 4)
  ])
  check(
    '休止、装饰音、延音线不要求弹奏',
    filtered.map(target => target.label).join(',') === 'C4,F4' && filtered[1].lead === 4,
    filtered.map(target => target.label).join(' / ')
  )

  // 手动定位：点到第 3 个音，从那里继续。
  tracker = new PracticeTracker(ascending)
  update = tracker.seek(2)
  check('手动定位到指定音符', update.position === 2 && update.current?.lead === 2, `${update.position}`)
  update = feed(tracker, E4, 9000)
  check('定位后能继续推进', update.position === 3, `${update.position}`)

  // 超时提示：一段时间没有推进后 stale 为真，推进后恢复。
  tracker = new PracticeTracker(ascending, { staleMs: 1000 })
  feed(tracker, C4, 10000)
  for (let index = 0; index < 25; index += 1) tracker.push(quiet(10240 + index * 60))
  update = tracker.state()
  check('长时间没有推进给出提示', update.stale === true && update.position === 1, `stale=${update.stale}`)
  update = feed(tracker, D4, 12000)
  check('推进后清除超时提示', update.stale === false && update.position === 2, `stale=${update.stale}`)

  // 查找窗口之外不猜。
  const long = buildPracticeTargets([
    note(0, 'C', 4, 0),
    note(1, 'D', 4, 1),
    note(2, 'E', 4, 2),
    note(3, 'F', 4, 3),
    note(4, 'G', 4, 4),
    note(5, 'A', 4, 5)
  ])
  tracker = new PracticeTracker(long)
  update = feed(tracker, A4, 13000, 6)
  check('窗口外的音不猜', update.position === 0 && update.outcome === 'unmatched', `${update.outcome}`)
  update = feed(tracker, G4, 13400)
  check('窗口边缘可以跳过去', update.position === 5 && update.skipped === 4, `${update.position} / 跳过 ${update.skipped}`)

  const failed = checks.filter(entry => !entry.ok)
  const report = {
    ok: failed.length === 0,
    checks,
    generatedAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(outDir, 'tracker.run.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`checks ${checks.length - failed.length}/${checks.length}`)
  console.log(`report ${path.relative(root, path.join(outDir, 'tracker.run.json'))}`)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`[failure] ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}
