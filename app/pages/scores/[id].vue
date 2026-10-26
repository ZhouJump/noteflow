<script setup lang="ts">
import { buildPracticeTargets } from '~/lib/audio/practice'
import { availableHands, combineScoreNotes, type HandMode } from '~/lib/audio/score'
import { loadAnnotations, saveAnnotation, STRUCTURED_PAGE_KEY } from '~/lib/db/annotations'
import { buildScoreRunRecord, listScoreRuns, saveScoreRun } from '~/lib/db/runs'
import { deleteScore, describeStorageError, loadScoreDetail, updateScoreMeta } from '~/lib/db/scores'
import type {
  AnnotationStroke,
  RecognitionRecord,
  ScoreDetail,
  ScoreRunRecord,
  ScoreSettingsRecord
} from '~/lib/db/schema'
import {
  clampBpm,
  DEFAULT_BEAT_TYPE,
  DEFAULT_BEATS,
  DEFAULT_BPM,
  defaultScoreSettings,
  loadScoreSettings,
  saveScoreSettings
} from '~/lib/db/settings'
import type { RecognitionStaff, RecognitionSymbol } from '~/lib/homr/recognition'
import { buildDisplayXml } from '~/lib/musicxml/display'
import { readMusicXmlSource, type MusicXmlNote, type ParsedMusicXml } from '~/lib/musicxml/document'
import { revealInViewport } from '~/lib/reveal'

/**
 * 曲谱页（手机优先）：整份曲谱从上往下排开，跟随推进时自动滚动到当前目标。
 *
 * 图片曲谱每页一条识别记录，这里把每页音符拼成一条全局序列（`combineScoreNotes`），
 * 练习覆盖整份曲谱；页内坐标仍用侧车符号，箭头和锚点各页自己画。MusicXML 导入
 * 没有页面图，交给 Verovio 一次排版全部页面。节拍器、练习与批注控件在左右两侧，
 * 底部只保留状态条和音符卡片。识别结果只读，导出的是 Worker 写出的原始 MusicXML。
 */
const route = useRoute()
const scoreId = computed(() => String(route.params.id))

const detail = shallowRef<ScoreDetail | null>(null)
const loading = ref(true)
const failure = ref<string | null>(null)

// 曲名要等 IndexedDB 读回后才知道，标题与描述用 getter，重命名后也会跟着变。
const seoTitle = computed(() => {
  const score = detail.value?.score
  return score === undefined ? '曲谱 · NoteFlow' : `${score.title} · NoteFlow`
})
const seoDescription = computed(() => {
  const score = detail.value?.score
  if (score === undefined) return '打开曲谱，跟随、节拍器、批注与评分。'
  const composer = score.composer ? `${score.composer} · ` : ''
  return `${composer}${score.pageCount} 页曲谱，支持跟随、节拍器、批注与评分。`
})
usePageSeo(seoTitle, seoDescription)

// 返回跟着曲谱归属走：谱集里的曲谱回谱集，独立曲谱回谱架；刷新或直接打开也一致。
const backTarget = computed(() => {
  const collectionId = detail.value?.score.collectionId ?? null
  return collectionId === null ? '/' : `/collections/${collectionId}`
})
const backLabel = computed(() =>
  (detail.value?.score.collectionId ?? null) === null ? '返回谱架' : '返回谱集'
)

const selectedIndex = ref<number | null>(null)
const tool = ref<'pen' | 'eraser' | null>(null)
const persistError = ref<string | null>(null)
/** 顶部 tab 选中的演奏模式；播放/暂停只操作当前模式。 */
const mode = ref<'practice' | 'score'>('practice')

const renameOpen = ref(false)
const metaTitle = ref('')
const metaComposer = ref('')
const metaSaving = ref(false)
const metaError = ref<string | null>(null)

/** 所有确认都走 Nuxt UI 对话框，不再使用浏览器原生 confirm/alert。 */
const clearOpen = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)

/** 评分成绩、历史与最近一次演奏的配置快照。 */
const detailRunOpen = ref(false)
const historyOpen = ref(false)
const activeRun = ref<ScoreRunRecord | null>(null)
const activeRunHistory = ref(false)
const recentRuns = ref<ScoreRunRecord[]>([])
const runConfig = ref({
  bpm: DEFAULT_BPM,
  beats: DEFAULT_BEATS,
  beatType: DEFAULT_BEAT_TYPE,
  handMode: 'both' as HandMode
})

const settings = ref<ScoreSettingsRecord>(defaultScoreSettings(scoreId.value))
const annotations = ref<Map<string, AnnotationStroke[]>>(new Map())
/** 每次修改前的整页快照，撤销按页恢复。 */
const history = ref<{ pageKey: string, strokes: AnnotationStroke[] }[]>([])

/** 定位点最大吸附距离（1920 宽页面坐标）：约为 1.5 个谱表间距。 */
const HEAD_SNAP_RADIUS = 60

interface PageView {
  pageId: string
  pageIndex: number
  notes: MusicXmlNote[]
  /** 每个音符在页面上的落点；`null` 表示侧车没有位置。 */
  locations: ({ x: number, y: number } | null)[]
  imageBlob: Blob | null
  pageSize: { width: number, height: number } | null
  musicXml: string
}

function parseRecord(record: RecognitionRecord | null): ParsedMusicXml | null {
  if (record === null || !import.meta.client) return null
  try {
    return readMusicXmlSource(record.musicXml)
  } catch {
    return null
  }
}

/**
 * 每个音符的页面落点：非休止符吸附到同谱表里最近的符头。
 *
 * 模型给的是符号的注意力点，和印刷符头平均差十几像素、最多四十几像素；R-C 上
 * 215 个音符里最近符头就是自己的符头，最大偏移 47px 仍在半个音符间距以内。
 */
function noteLocations(
  record: RecognitionRecord | null,
  notes: MusicXmlNote[]
): ({ x: number, y: number } | null)[] {
  if (record === null) return notes.map(() => null)
  const symbols = new Map<string, { staff: RecognitionStaff, symbol: RecognitionSymbol }>()
  for (const staff of record.sidecar?.staffs ?? []) {
    for (const symbol of staff.symbols) symbols.set(symbol.id, { staff, symbol })
  }
  const ids = record.noteSymbols
  return notes.map((note, index) => {
    const id = ids[index]
    const entry = id === null || id === undefined ? undefined : symbols.get(id)
    if (entry === undefined) return null
    const { staff, symbol } = entry
    if (symbol.x === null || symbol.y === null) return null
    const anchor = { x: symbol.x, y: symbol.y }
    if (note.isRest) return anchor
    let nearest: { x: number, y: number } | null = null
    let best = HEAD_SNAP_RADIUS
    for (const head of staff.notes) {
      const distance = Math.hypot(head.x - anchor.x, head.y - anchor.y)
      if (distance < best) {
        best = distance
        nearest = head
      }
    }
    return nearest ?? anchor
  })
}

/** 图片曲谱的页面列表；结构化乐谱为空。 */
const pageViews = computed<PageView[]>(() => {
  const value = detail.value
  if (value === null || !import.meta.client) return []
  return value.pages.map((entry, index) => {
    const page = entry.page
    const record = entry.recognition
    const parsed = parseRecord(record)
    const assetId = page.processedAssetId ?? page.originalAssetId
    const asset = assetId === null ? undefined : value.assets.get(assetId)
    const sidecarPage = record?.sidecar?.page ?? null
    return {
      pageId: page.id,
      pageIndex: index,
      notes: parsed?.notes ?? [],
      locations: noteLocations(record, parsed?.notes ?? []),
      imageBlob: asset?.blob ?? null,
      pageSize: asset !== undefined && asset.width > 0 && asset.height > 0
        ? { width: asset.width, height: asset.height }
        : sidecarPage,
      musicXml: record?.musicXml ?? ''
    }
  })
})

const pageImageUrls = useAssetUrls(() => pageViews.value.map(view => view.imageBlob))
const hasPages = computed(() => pageViews.value.length > 0)

const structuredRecord = computed(() => detail.value?.recognition ?? null)
const structuredParsed = computed(() => parseRecord(structuredRecord.value))
const structuredView = computed<{ xml: string | null, error: string | null }>(() => {
  const record = structuredRecord.value
  if (record === null || !import.meta.client) return { xml: null, error: null }
  try {
    return { xml: buildDisplayXml(record.musicXml), error: null }
  } catch (exception) {
    return { xml: null, error: (exception as Error).message }
  }
})

/**
 * 全局音符序列：图片曲谱按页拼接，结构化乐谱只有一页。
 * `refs` 把全局序号映射回「第几页 / 页内第几个」，页面图和 Verovio 各画各的。
 */
const combined = computed(() => {
  const pages = hasPages.value
    ? pageViews.value.map(view => ({ pageIndex: view.pageIndex, notes: view.notes }))
    : [{ pageIndex: 0, notes: structuredParsed.value?.notes ?? [] }]
  return combineScoreNotes(pages)
})
const notes = computed(() => combined.value.notes)
const noteRefs = computed(() => combined.value.refs)
const pageStarts = computed(() => combined.value.pageStarts)

const allPracticeTargets = computed(() => buildPracticeTargets(notes.value))
const practiceHands = computed(() => availableHands(allPracticeTargets.value))
/** 单谱表没有声部可筛，始终按全部手演奏。 */
const effectiveHandMode = computed<HandMode>(() => (
  practiceHands.value.size >= 2 ? settings.value.handMode : 'both'
))

const practice = usePractice(() => notes.value, { handMode: () => effectiveHandMode.value })
const practiceOn = practice.active
const practicePhase = practice.phase
const practiceSnapshot = practice.snapshot

/** 跟随时每只手的当前目标；图片页和 Verovio 页用它画箭头。 */
const practiceTargets = computed<{ index: number, hand: number }[]>(() => {
  const target = practiceSnapshot.value?.current
  if (!practiceOn.value || target === null || target === undefined) return []
  return target.hands.map(hand => ({ index: hand.lead, hand: hand.hand }))
})

const metronome = useMetronome(
  () => settings.value.bpm,
  () => settings.value.beats
)
const metronomeOn = metronome.running
const metronomeBeat = metronome.beat
/** 暂停练习时如果节拍器开着，恢复练习时一并恢复。 */
let metronomeWasRunning = false

const scoring = useScoring(
  () => notes.value,
  {
    handMode: () => effectiveHandMode.value,
    bpm: () => settings.value.bpm
  }
)
const scoringPhase = scoring.phase
const scoringSnapshot = scoring.snapshot
/** 评分进行中（含等待首音与麦克风错误）；完成后立即重置并弹出成绩。 */
const scoringOn = computed(() => (
  scoringPhase.value === 'waiting'
  || scoringPhase.value === 'running'
  || scoringPhase.value === 'paused'
  || scoringPhase.value === 'error'
))
const focusMode = computed(() => practiceOn.value || scoringOn.value)

/** 跟随或评分当前要标出的音符；两种模式互斥，由顶部 tab 决定显示哪一边。 */
const activeTargets = computed<{ index: number, hand: number }[]>(() => {
  if (mode.value === 'practice' && practiceOn.value) return practiceTargets.value
  const current = scoringSnapshot.value?.current
  if (mode.value !== 'score' || !scoringOn.value || current === null || current === undefined) return []
  return [{ index: current.index, hand: current.hand }]
})

const selectedNote = computed(() => {
  const index = selectedIndex.value
  return index === null ? null : notes.value[index] ?? null
})
const selectedRef = computed(() => {
  const index = selectedIndex.value
  return index === null ? null : noteRefs.value[index] ?? null
})
const selectedPageLabel = computed(() => {
  if (pageViews.value.length <= 1) return undefined
  const ref = selectedRef.value
  return ref === null ? undefined : `第 ${ref.pageIndex + 1} 页`
})

const hasAnnotations = computed(() => (
  [...annotations.value.values()].some(strokes => strokes.length > 0)
))
const canUndo = computed(() => history.value.length > 0)

function strokesFor(pageKey: string): AnnotationStroke[] {
  return annotations.value.get(pageKey) ?? []
}

function selectedIndexForPage(pageIndex: number): number | null {
  const ref = selectedRef.value
  return ref !== null && ref.pageIndex === pageIndex ? ref.index : null
}

/** 当前练习/评分目标拆到某一页：把全局序号换成页内序号。 */
function targetsForPage(pageIndex: number): { index: number, hand: number }[] {
  const list: { index: number, hand: number }[] = []
  for (const target of activeTargets.value) {
    const ref = noteRefs.value[target.index]
    if (ref !== undefined && ref.pageIndex === pageIndex) {
      list.push({ index: ref.index, hand: target.hand })
    }
  }
  return list
}

function select(index: number): void {
  if (index < 0 || index >= notes.value.length) return
  selectedIndex.value = index
  if (practiceOn.value) practice.seek(index)
}

function selectPage(pageIndex: number, localIndex: number): void {
  select((pageStarts.value[pageIndex] ?? 0) + localIndex)
}

function patchSettings(patch: Partial<ScoreSettingsRecord>): void {
  const next: ScoreSettingsRecord = {
    ...settings.value,
    ...patch,
    bpm: clampBpm(patch.bpm ?? settings.value.bpm),
    updatedAt: Date.now()
  }
  settings.value = next
  void saveScoreSettings(next)
    .then(() => {
      persistError.value = null
    })
    .catch((exception: unknown) => {
      persistError.value = `设置保存失败：${describeStorageError(exception)}`
    })
}

function adjustBpm(delta: number): void {
  patchSettings({ bpm: clampBpm(settings.value.bpm + delta) })
}

function setBpm(value: number): void {
  patchSettings({ bpm: clampBpm(value) })
}

function setRhythm(beats: number, beatType: number): void {
  patchSettings({ beats, beatType })
}

/** 点手形图标切换声部：两只都亮时关掉一只，只亮一只时点另一只补回双手。 */
function selectHand(hand: number): void {
  if (!practiceHands.value.has(hand)) return
  const active = new Set<number>(
    settings.value.handMode === 'both' ? [0, 1] : [settings.value.handMode === 'right' ? 0 : 1]
  )
  if (active.has(hand)) {
    if (active.size === 1) return
    active.delete(hand)
  } else {
    active.add(hand)
  }
  const nextMode: HandMode = active.size === 2 ? 'both' : active.has(0) ? 'right' : 'left'
  if (nextMode === settings.value.handMode) return
  patchSettings({ handMode: nextMode })
  // 练习或评分中换声部要按新的目标重建跟踪器。
  if (practiceOn.value) void practice.restart()
  if (scoringOn.value) void restartScoring()
}

function toggleMetronome(): void {
  metronome.toggle()
}

/** 顶部 tab 切换模式：离开时直接丢掉另一边的会话，不产生成绩。 */
function selectMode(next: 'practice' | 'score'): void {
  if (mode.value === next) return
  if (practiceOn.value) stopPractice()
  if (scoringPhase.value !== 'idle') scoring.reset()
  mode.value = next
}

/** 开始跟随：点击后才打开麦克风并开始识别音符。 */
function startPractice(): void {
  if (scoringOn.value) scoring.stop()
  const phase = practice.phase.value
  if (phase === 'paused') {
    practice.resume()
    if (metronomeWasRunning) void metronome.start()
    metronomeWasRunning = false
    return
  }
  if (phase === 'listening' || phase === 'starting' || phase === 'done') return
  void practice.start()
}

function pausePractice(): void {
  if (practice.phase.value !== 'listening') return
  metronomeWasRunning = metronomeOn.value
  if (metronomeWasRunning) metronome.stop()
  practice.pause()
}

function stopPractice(): void {
  practice.stop()
  metronomeWasRunning = false
}

/** 开始评分：点击后才进入等待首音；暂停后继续回到等待，等当前音重新锚定。 */
async function startScoring(): Promise<void> {
  if (practiceOn.value) stopPractice()
  const phase = scoringPhase.value
  if (phase === 'paused') {
    scoring.resume()
    return
  }
  if (phase === 'waiting' || phase === 'running') return
  if (phase === 'finished' || phase === 'error') scoring.reset()
  runConfig.value = {
    bpm: settings.value.bpm,
    beats: settings.value.beats,
    beatType: settings.value.beatType,
    handMode: effectiveHandMode.value
  }
  await scoring.start()
}

function stopScoring(): void {
  scoring.stop()
}

/** 重来也要重新快照当前 BPM 与声部，避免沿用上一轮开始的配置。 */
async function restartScoring(): Promise<void> {
  scoring.reset()
  await startScoring()
}

/** 播放/暂停共用一个按钮：正在听就暂停，否则开始或继续。 */
function toggleCurrent(): void {
  if (mode.value === 'practice') {
    if (practice.phase.value === 'listening') pausePractice()
    else startPractice()
    return
  }
  if (scoringPhase.value === 'waiting' || scoringPhase.value === 'running') pauseScoring()
  else void startScoring()
}

function pauseScoring(): void {
  scoring.pause()
}

function stopCurrent(): void {
  if (mode.value === 'practice') stopPractice()
  else stopScoring()
}

function restartCurrent(): void {
  if (mode.value === 'practice') restartPractice()
  else void restartScoring()
}

/** 评分结束：先弹出成绩，再把记录写入本机；写库失败也不影响查看。 */
watch(scoringPhase, (phase) => {
  if (phase !== 'finished') return
  const summary = scoring.summary.value
  if (summary === null) {
    scoring.reset()
    return
  }
  const input = {
    scoreId: scoreId.value,
    bpm: runConfig.value.bpm,
    beats: runConfig.value.beats,
    beatType: runConfig.value.beatType,
    handMode: runConfig.value.handMode,
    summary
  }
  const local = buildScoreRunRecord(input)
  activeRun.value = local
  activeRunHistory.value = false
  detailRunOpen.value = true
  scoring.reset()
  void saveScoreRun(input)
    .then((record) => {
      recentRuns.value = [record, ...recentRuns.value]
      if (activeRun.value?.id === local.id) activeRun.value = record
    })
    .catch((exception: unknown) => {
      persistError.value = `成绩保存失败：${describeStorageError(exception)}`
    })
})

function retryScoring(): void {
  activeRun.value = null
  activeRunHistory.value = false
  void startScoring()
}

async function openHistory(): Promise<void> {
  historyOpen.value = true
  try {
    recentRuns.value = await listScoreRuns(scoreId.value)
  } catch (exception) {
    persistError.value = `评分记录读取失败：${describeStorageError(exception)}`
  }
}

function openRun(run: ScoreRunRecord): void {
  activeRun.value = run
  activeRunHistory.value = true
  detailRunOpen.value = true
}

function restartPractice(): void {
  void practice.restart()
}

function toggleTool(next: 'pen' | 'eraser'): void {
  tool.value = tool.value === next ? null : next
}

function remember(pageKey: string): void {
  history.value = [...history.value.slice(-49), { pageKey, strokes: strokesFor(pageKey) }]
}

function commit(pageKey: string, strokes: AnnotationStroke[]): void {
  const next = new Map(annotations.value)
  next.set(pageKey, strokes)
  annotations.value = next
  void saveAnnotation(scoreId.value, pageKey, strokes)
    .then(() => {
      persistError.value = null
    })
    .catch((exception: unknown) => {
      persistError.value = `批注保存失败：${describeStorageError(exception)}`
    })
}

function addStroke(pageKey: string, stroke: AnnotationStroke): void {
  remember(pageKey)
  commit(pageKey, [...strokesFor(pageKey), stroke])
}

function replaceStrokes(pageKey: string, strokes: AnnotationStroke[]): void {
  remember(pageKey)
  commit(pageKey, strokes)
}

function undoAnnotation(): void {
  const entry = history.value[history.value.length - 1]
  if (entry === undefined) return
  history.value = history.value.slice(0, -1)
  commit(entry.pageKey, entry.strokes)
}

function clearAnnotations(): void {
  if (!hasAnnotations.value) return
  clearOpen.value = true
}

async function performClearAnnotations(): Promise<void> {
  const keys = [...annotations.value.keys()].filter(key => strokesFor(key).length > 0)
  if (keys.length === 0) {
    clearOpen.value = false
    return
  }
  history.value = [
    ...history.value.slice(-49),
    ...keys.map(pageKey => ({ pageKey, strokes: strokesFor(pageKey) }))
  ]
  const next = new Map(annotations.value)
  for (const key of keys) next.set(key, [])
  annotations.value = next
  clearOpen.value = false
  for (const key of keys) {
    try {
      await saveAnnotation(scoreId.value, key, [])
    } catch (exception) {
      persistError.value = `批注保存失败：${describeStorageError(exception)}`
      return
    }
  }
  persistError.value = null
}

/**
 * 把某个全局音符保持在视口里。
 *
 * 结构化乐谱由 EngravedScore 自己跟随；图片曲谱按页容器的 `data-page-index`
 * 找到锚点，纵向多页共用一条文档滚动条。同一行里的音高差只有几十像素，
 * `revealInViewport` 不会为每个音重新居中，避免游标推进时页面上下轻推。
 */
function scrollToNote(index: number): void {
  if (!hasPages.value) return
  const ref = noteRefs.value[index]
  if (ref === undefined) return
  void nextTick(() => {
    const anchor = document.querySelector(
      `[data-page-index="${ref.pageIndex}"] [data-note-anchor="${ref.index}"]`
    )
    if (anchor === null) return
    revealInViewport(anchor)
  })
}

watch(
  () => practiceSnapshot.value?.current,
  (target) => {
    if (!practiceOn.value || target === null || target === undefined) return
    scrollToNote(target.lead)
  }
)

watch(
  () => scoringSnapshot.value?.current,
  (target) => {
    if (!scoringOn.value || target === null || target === undefined) return
    scrollToNote(target.index)
  }
)

async function load(): Promise<void> {
  loading.value = true
  failure.value = null
  try {
    const value = await loadScoreDetail(scoreId.value)
    if (value === null) {
      failure.value = '这份曲谱已经不在谱架上了，可能被删除了。'
      return
    }
    detail.value = value
    metaTitle.value = value.score.title
    metaComposer.value = value.score.composer

    const record = value.recognition ?? value.pages[0]?.recognition ?? null
    const parsed = parseRecord(record)
    const fallback = defaultScoreSettings(scoreId.value, parsed?.timeSignature ?? null)
    try {
      settings.value = await loadScoreSettings(scoreId.value, fallback)
    } catch {
      settings.value = fallback
    }
    try {
      annotations.value = await loadAnnotations(scoreId.value)
    } catch {
      annotations.value = new Map()
    }
  } catch (exception) {
    failure.value = describeStorageError(exception)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openRename(): void {
  metaTitle.value = detail.value?.score.title ?? ''
  metaComposer.value = detail.value?.score.composer ?? ''
  metaError.value = null
  renameOpen.value = true
}

async function saveMeta(): Promise<void> {
  if (detail.value === null) return
  metaSaving.value = true
  metaError.value = null
  try {
    await updateScoreMeta(scoreId.value, { title: metaTitle.value, composer: metaComposer.value })
    detail.value = {
      ...detail.value,
      score: {
        ...detail.value.score,
        title: metaTitle.value.trim() || detail.value.score.title,
        composer: metaComposer.value.trim()
      }
    }
    renameOpen.value = false
  } catch (exception) {
    metaError.value = `保存失败：${describeStorageError(exception)}`
  } finally {
    metaSaving.value = false
  }
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'score'
}

function downloadXml(musicXml: string, fileName: string): void {
  if (musicXml === '') return
  const url = URL.createObjectURL(
    new Blob([musicXml], { type: 'application/vnd.recordare.musicxml+xml' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 图片曲谱逐页导出，结构化乐谱只有一份。 */
function exportMusicXml(): void {
  const title = safeName(detail.value?.score.title ?? 'score')
  const pages = pageViews.value.filter(view => view.musicXml !== '')
  if (pages.length > 0) {
    pages.forEach((view, index) => {
      const suffix = pages.length > 1 ? `-第${view.pageIndex + 1}页` : ''
      window.setTimeout(() => downloadXml(view.musicXml, `${title}${suffix}.musicxml`), index * 250)
    })
    return
  }
  const record = structuredRecord.value
  if (record !== null) downloadXml(record.musicXml, `${title}.musicxml`)
}

function remove(): void {
  if (detail.value === null) return
  deleteOpen.value = true
}

async function performRemove(): Promise<void> {
  deleting.value = true
  try {
    await deleteScore(scoreId.value)
    deleteOpen.value = false
    await navigateTo('/')
  } catch (exception) {
    deleteOpen.value = false
    persistError.value = `删除失败：${describeStorageError(exception)}`
  } finally {
    deleting.value = false
  }
}

const menuItems = computed(() => [
  [{ label: '编辑信息', icon: 'i-lucide-pencil', onSelect: openRename }],
  [{ label: '评分记录', icon: 'i-lucide-history', onSelect: () => void openHistory() }],
  [{
    label: pageViews.value.length > 1 ? '导出全部 MusicXML' : '导出 MusicXML',
    icon: 'i-lucide-download',
    onSelect: exportMusicXml
  }],
  [{ label: '删除曲谱', icon: 'i-lucide-trash-2', onSelect: remove }]
])
</script>

<template>
  <div
    class="min-h-dvh bg-default"
    :class="focusMode ? 'pb-32' : 'pb-8'"
  >
    <div
      v-if="loading"
      class="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      正在打开曲谱
    </div>

    <div
      v-else-if="failure"
      class="mx-auto grid max-w-4xl gap-4 px-4 py-10"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="无法打开曲谱"
        :description="failure"
        data-test="score-failure"
      />
      <UButton
        to="/"
        variant="outline"
        color="neutral"
        icon="i-lucide-chevron-left"
        label="返回谱架"
        class="justify-self-start"
      />
    </div>

    <template v-else-if="detail">
      <PageHeader
        :title="detail.score.title"
        :back="backTarget"
        :back-label="backLabel"
      >
        <template #center>
          <div
            class="grid grid-cols-2 gap-1 rounded-lg bg-elevated p-1"
            role="tablist"
            aria-label="演奏模式"
          >
            <button
              type="button"
              role="tab"
              data-test="mode-practice"
              :aria-selected="mode === 'practice'"
              class="flex items-center justify-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium transition"
              :class="mode === 'practice' ? 'bg-default text-highlighted shadow-sm' : 'text-muted hover:text-default'"
              @click="selectMode('practice')"
            >
              <UIcon
                name="i-lucide-music"
                class="hidden size-4 sm:block"
              />
              跟随
            </button>
            <button
              type="button"
              role="tab"
              data-test="mode-score"
              :aria-selected="mode === 'score'"
              class="flex items-center justify-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium transition"
              :class="mode === 'score' ? 'bg-default text-highlighted shadow-sm' : 'text-muted hover:text-default'"
              @click="selectMode('score')"
            >
              <UIcon
                name="i-lucide-gauge"
                class="hidden size-4 sm:block"
              />
              评分
            </button>
          </div>
        </template>
        <UDropdownMenu :items="menuItems">
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="更多操作"
          />
        </UDropdownMenu>
      </PageHeader>

      <div class="mx-auto flex max-w-4xl items-start gap-0.5 px-4 sm:gap-2">
        <ScoreControlsLeft
          :bpm="settings.bpm"
          :beats="settings.beats"
          :beat-type="settings.beatType"
          :beat="metronomeBeat"
          :metronome-on="metronomeOn"
          :hand-mode="settings.handMode"
          :hands="practiceHands"
          @toggle-metronome="toggleMetronome"
          @adjust-bpm="adjustBpm"
          @set-bpm="setBpm"
          @set-rhythm="setRhythm"
          @select-hand="selectHand"
        />

        <main class="min-w-0 flex-1 py-1">
          <div
            v-if="persistError"
            class="mb-2"
          >
            <UAlert
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="persistError"
              data-test="persist-error"
            />
          </div>

          <template v-if="hasPages">
            <div
              v-for="view in pageViews"
              :key="view.pageId"
              class="relative mb-2 overflow-hidden rounded-sm bg-white shadow-sm"
              :data-page-index="view.pageIndex"
              :data-page-id="view.pageId"
            >
              <PageImage
                :image-url="pageImageUrls[view.pageIndex] ?? null"
                :page="view.pageSize"
                :locations="view.locations"
                :selected-index="focusMode ? null : selectedIndexForPage(view.pageIndex)"
                :active-targets="targetsForPage(view.pageIndex)"
                @select="(index) => selectPage(view.pageIndex, index)"
              />
              <AnnotationLayer
                :strokes="strokesFor(view.pageId)"
                :tool="tool"
                @stroke="(stroke) => addStroke(view.pageId, stroke)"
                @replace="(strokes) => replaceStrokes(view.pageId, strokes)"
              />
            </div>
          </template>

          <template v-else>
            <UAlert
              v-if="structuredView.error"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="这份乐谱无法排版"
              :description="structuredView.error"
            />
            <div
              v-if="structuredView.xml !== null"
              class="relative bg-white"
            >
              <EngravedScore
                :xml="structuredView.xml"
                :selected-index="focusMode ? null : selectedIndex"
                :current-targets="activeTargets"
                @select="select"
              />
              <AnnotationLayer
                :strokes="strokesFor(STRUCTURED_PAGE_KEY)"
                :tool="tool"
                @stroke="(stroke) => addStroke(STRUCTURED_PAGE_KEY, stroke)"
                @replace="(strokes) => replaceStrokes(STRUCTURED_PAGE_KEY, strokes)"
              />
            </div>
            <div
              v-else-if="!structuredView.error"
              class="grid aspect-4/3 place-items-center px-6 text-center text-sm text-muted"
            >
              没有可显示的乐谱。
            </div>
          </template>
        </main>

        <ScoreControlsRight
          :mode="mode"
          :practice-phase="practicePhase"
          :score-phase="scoringPhase"
          :can-start="notes.length > 0"
          :tool="tool"
          :can-undo="canUndo"
          :has-annotations="hasAnnotations"
          @toggle="toggleCurrent"
          @stop="stopCurrent"
          @restart="restartCurrent"
          @pen="toggleTool('pen')"
          @eraser="toggleTool('eraser')"
          @undo="undoAnnotation"
          @clear="clearAnnotations"
        />
      </div>

      <div
        v-if="practiceOn"
        class="fixed inset-x-0 bottom-0 z-30"
      >
        <PracticePanel :snapshot="practiceSnapshot" />
      </div>

      <div
        v-else-if="scoringOn && mode === 'score'"
        class="fixed inset-x-0 bottom-0 z-30"
      >
        <ScorePanel :snapshot="scoringSnapshot" />
      </div>

      <div
        v-else-if="selectedNote && selectedIndex !== null"
        class="fixed inset-x-0 bottom-0 z-30 border-t border-default bg-default/95 backdrop-blur"
      >
        <div class="mx-auto max-w-4xl">
          <NoteDetails
            :key="selectedIndex"
            :index="selectedIndex"
            :total="notes.length"
            :note="selectedNote"
            :page-label="selectedPageLabel"
            @close="selectedIndex = null"
          />
        </div>
      </div>

      <ConfirmDialog
        v-model:open="clearOpen"
        title="清空批注"
        description="这份曲谱上的所有笔画都会被清除，之后仍可以用撤销恢复。"
        confirm-label="清空"
        confirm-color="error"
        @confirm="performClearAnnotations"
      />

      <ConfirmDialog
        v-model:open="deleteOpen"
        title="删除曲谱"
        :description="`删除「${detail.score.title}」？这份曲谱的页面、批注和成绩会一起删除。`"
        confirm-label="删除"
        confirm-color="error"
        :loading="deleting"
        @confirm="performRemove"
      />

      <ScoreResultDialog
        v-model:open="detailRunOpen"
        :run="activeRun"
        :history="activeRunHistory"
        @retry="retryScoring"
      />

      <ScoreHistoryDialog
        v-model:open="historyOpen"
        :runs="recentRuns"
        @select="openRun"
      />

      <UModal v-model:open="renameOpen">
        <template #header>
          <h2 class="text-base font-semibold">
            曲谱信息
          </h2>
        </template>
        <template #body>
          <div class="grid gap-4">
            <UFormField label="标题">
              <UInput
                v-model="metaTitle"
                class="w-full"
                data-test="meta-title"
              />
            </UFormField>
            <UFormField label="作曲 / 编曲">
              <UInput
                v-model="metaComposer"
                class="w-full"
                data-test="meta-composer"
              />
            </UFormField>
            <p
              v-if="metaError"
              class="text-sm text-error"
            >
              {{ metaError }}
            </p>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              label="取消"
              @click="renameOpen = false"
            />
            <UButton
              label="保存"
              :loading="metaSaving"
              data-test="save-meta"
              @click="saveMeta"
            />
          </div>
        </template>
      </UModal>
    </template>
  </div>
</template>
