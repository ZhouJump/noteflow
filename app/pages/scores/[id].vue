<script setup lang="ts">
import { deleteScore, describeStorageError, loadScoreDetail, updateScoreMeta } from '~/lib/db/scores'
import type { ScoreDetail, ScorePageDetail } from '~/lib/db/schema'
import type { RecognitionStaff, RecognitionSymbol } from '~/lib/homr/recognition'
import { buildDisplayXml } from '~/lib/musicxml/display'
import { readMusicXmlSource, type ParsedMusicXml } from '~/lib/musicxml/document'

/**
 * 曲谱页（手机优先）：一页一屏，顶部返回与翻页，点音符在底部显示音高、时值和小节。
 *
 * 图片曲谱只显示识别后的页面图，不再用 Verovio 另排一份；MusicXML 导入没有页面，
 * 仍用 EngravedScore 展示。识别结果只读，导出的是 Worker 写出的原始 MusicXML。
 */
const route = useRoute()
const scoreId = computed(() => String(route.params.id))

const detail = shallowRef<ScoreDetail | null>(null)
const loading = ref(true)
const failure = ref<string | null>(null)

const pagePosition = ref(0)
const selectedIndex = ref<number | null>(null)

const renameOpen = ref(false)
const metaTitle = ref('')
const metaComposer = ref('')
const metaSaving = ref(false)
const metaError = ref<string | null>(null)

const pageDetails = computed<ScorePageDetail[]>(() => detail.value?.pages ?? [])
const currentPage = computed<ScorePageDetail | null>(() => pageDetails.value[pagePosition.value] ?? null)
const pageCount = computed(() => pageDetails.value.length)
const recognition = computed(() => currentPage.value?.recognition ?? detail.value?.recognition ?? null)

const parsedState = computed<{ parsed: ParsedMusicXml | null, error: string | null }>(() => {
  const record = recognition.value
  if (record === null || !import.meta.client) return { parsed: null, error: null }
  try {
    return { parsed: readMusicXmlSource(record.musicXml), error: null }
  } catch (exception) {
    return { parsed: null, error: (exception as Error).message }
  }
})
const parsed = computed(() => parsedState.value.parsed)
const notes = computed(() => parsed.value?.notes ?? [])

/**
 * 跟弹练习：麦克风音高推进当前页的下一个目标音。
 *
 * 图片曲谱一页一条识别记录，目标也只取当前页；弹完一页由面板上的“下一页”
 * 手动切换，自动翻页属于后续里程碑。
 */
const practice = usePractice(() => notes.value)
const practiceOn = practice.active
const practiceSnapshot = practice.snapshot
const practiceIndex = computed(() => practiceSnapshot.value?.current?.lead ?? null)

/** 每个音符对应的识别符号：`noteSymbols` 的顺序与 `<note>` 文档顺序一致。 */
const symbolIndex = computed(() => {
  const map = new Map<string, { staff: RecognitionStaff, symbol: RecognitionSymbol }>()
  for (const staff of recognition.value?.sidecar?.staffs ?? []) {
    for (const symbol of staff.symbols) map.set(symbol.id, { staff, symbol })
  }
  return map
})

/** 定位点最大吸附距离（1920 宽页面坐标）：约为 1.5 个谱表间距。 */
const HEAD_SNAP_RADIUS = 60

/**
 * 每个音符的页面落点。
 *
 * 模型给的是符号的注意力点，和印刷符头平均差十几像素、最多四十几像素，直接画
 * 圈会落在符头旁边。非休止符吸附到同一谱表里最近的符头；R-C 上 215 个音符里
 * 最近符头就是自己的符头（注意力点大多在符干顶端，横向偏差不超过 32），最大
 * 偏移 47px 仍在半个音符间距以内。
 */
const locations = computed<({ x: number, y: number } | null)[]>(() => {
  const ids = recognition.value?.noteSymbols ?? []
  return notes.value.map((note, index) => {
    const id = ids[index]
    const entry = id === null || id === undefined ? undefined : symbolIndex.value.get(id)
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
    return nearest === null ? anchor : { x: nearest.x, y: nearest.y }
  })
})

const pageImageBlob = computed<Blob | null>(() => {
  const page = currentPage.value?.page
  const assets = detail.value?.assets
  if (page === undefined || assets === undefined) return null
  const id = page.processedAssetId ?? page.originalAssetId
  return id === null ? null : assets.get(id)?.blob ?? null
})
const pageImageUrl = useAssetUrl(pageImageBlob)
const hasImage = computed(() => pageImageBlob.value !== null)
const pageSize = computed(() => {
  const page = currentPage.value?.page
  const assets = detail.value?.assets
  if (page !== undefined && assets !== undefined) {
    const id = page.processedAssetId ?? page.originalAssetId
    const asset = id === null ? undefined : assets.get(id)
    if (asset !== undefined && asset.width > 0 && asset.height > 0) {
      return { width: asset.width, height: asset.height }
    }
  }
  return recognition.value?.sidecar?.page ?? null
})

const selectedNote = computed(() => {
  const index = selectedIndex.value
  return index === null ? null : notes.value[index] ?? null
})

const displayXml = shallowRef<string | null>(null)
const displayError = ref<string | null>(null)

watch(
  [() => recognition.value?.musicXml ?? '', hasImage],
  ([source, image]) => {
    // 图片曲谱只看页面图，不额外排版。
    if (image || source === '' || !import.meta.client) {
      displayXml.value = null
      displayError.value = null
      return
    }
    try {
      displayXml.value = buildDisplayXml(source)
      displayError.value = null
    } catch (exception) {
      displayXml.value = null
      displayError.value = (exception as Error).message
    }
  },
  { immediate: true }
)

async function load(): Promise<void> {
  loading.value = true
  failure.value = null
  try {
    const value = await loadScoreDetail(scoreId.value)
    if (value === null) {
      failure.value = '这份曲谱不在本机存储里，可能已被删除。'
      return
    }
    detail.value = value
    metaTitle.value = value.score.title
    metaComposer.value = value.score.composer
  } catch (exception) {
    failure.value = describeStorageError(exception)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function select(index: number): void {
  if (index < 0 || index >= notes.value.length) return
  selectedIndex.value = index
  if (practiceOn.value) practice.seek(index)
}

function togglePractice(): void {
  if (practiceOn.value) {
    practice.stop()
    return
  }
  void practice.start()
}

function goPage(delta: number): void {
  const next = pagePosition.value + delta
  if (next < 0 || next >= pageCount.value) return
  // 翻页会换一套目标音，继续听旧页没有意义。
  if (practiceOn.value) practice.stop()
  pagePosition.value = next
  selectedIndex.value = null
}

/** 完成一页后从面板翻到下一页，并直接开始新一页的跟弹。 */
async function practiceNextPage(): Promise<void> {
  if (pagePosition.value >= pageCount.value - 1) return
  goPage(1)
  await nextTick()
  await practice.start()
}

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

function exportMusicXml(): void {
  const record = recognition.value
  if (record === null) return
  const suffix = pageCount.value > 1 ? `-第${pagePosition.value + 1}页` : ''
  const url = URL.createObjectURL(
    new Blob([record.musicXml], { type: 'application/vnd.recordare.musicxml+xml' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeName(detail.value?.score.title ?? 'score')}${suffix}.musicxml`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function remove(): Promise<void> {
  const title = detail.value?.score.title ?? '这份曲谱'
  if (!window.confirm(`删除「${title}」？本机上的页面图片与识别结果会一起删除。`)) return
  try {
    await deleteScore(scoreId.value)
    await navigateTo('/')
  } catch (exception) {
    window.alert(`删除失败：${describeStorageError(exception)}`)
  }
}

const menuItems = computed(() => [
  [{ label: '编辑信息', icon: 'i-lucide-pencil', onSelect: openRename }],
  [{
    label: pageCount.value > 1 ? '导出本页 MusicXML' : '导出 MusicXML',
    icon: 'i-lucide-download',
    onSelect: exportMusicXml
  }],
  [{ label: '删除曲谱', icon: 'i-lucide-trash-2', onSelect: remove }]
])
</script>

<template>
  <div
    class="min-h-dvh bg-default"
    :class="practiceOn ? 'pb-48' : 'pb-28'"
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
      class="mx-auto grid max-w-2xl gap-4 px-4 py-10"
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
        label="返回书架"
        class="justify-self-start"
      />
    </div>

    <template v-else-if="detail">
      <PageHeader
        :title="detail.score.title"
        back="/"
        back-label="返回书架"
      >
        <UButton
          :icon="practiceOn ? 'i-lucide-square' : 'i-lucide-mic'"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="practiceOn ? '结束跟弹练习' : '开始跟弹练习'"
          :disabled="notes.length === 0"
          data-test="practice-toggle"
          @click="togglePractice"
        />

        <UDropdownMenu :items="menuItems">
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="更多操作"
          />
        </UDropdownMenu>

        <template #sub>
          <div
            v-if="pageCount > 1"
            class="mx-auto flex h-10 max-w-2xl items-center justify-center gap-1 border-t border-default/60 px-2"
          >
            <UButton
              icon="i-lucide-chevron-left"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="上一页"
              :disabled="pagePosition === 0"
              data-test="page-prev"
              @click="goPage(-1)"
            />
            <span
              class="min-w-16 text-center text-xs text-muted tabular-nums"
              data-test="page-indicator"
            >第 {{ pagePosition + 1 }} / {{ pageCount }} 页</span>
            <UButton
              icon="i-lucide-chevron-right"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="下一页"
              :disabled="pagePosition >= pageCount - 1"
              data-test="page-next"
              @click="goPage(1)"
            />
          </div>
        </template>
      </PageHeader>

      <main class="mx-auto max-w-2xl">
        <PageImage
          v-if="hasImage"
          :image-url="pageImageUrl"
          :page="pageSize"
          :locations="locations"
          :selected-index="selectedIndex"
          :active-index="practiceOn ? practiceIndex : null"
          @select="select"
        />

        <template v-else>
          <UAlert
            v-if="displayError"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="这份乐谱无法排版"
            :description="displayError"
          />
          <EngravedScore
            v-if="displayXml !== null"
            :key="pagePosition"
            :xml="displayXml"
            :selected-index="selectedIndex"
            :current-index="practiceOn ? practiceIndex : null"
            @select="select"
          />
          <div
            v-else
            class="grid aspect-4/3 place-items-center px-6 text-center text-sm text-muted"
          >
            没有可显示的乐谱。
          </div>
        </template>
      </main>

      <div
        v-if="practiceOn"
        class="fixed inset-x-0 bottom-0 z-30"
      >
        <div class="mx-auto max-w-2xl">
          <PracticePanel
            :snapshot="practiceSnapshot"
            :has-next-page="pagePosition < pageCount - 1"
            @stop="practice.stop"
            @restart="practice.restart"
            @retry="practice.start"
            @next="practiceNextPage"
          />
        </div>
      </div>

      <div
        v-else-if="selectedNote && selectedIndex !== null"
        class="fixed inset-x-0 bottom-0 z-30 border-t border-default bg-default/95 backdrop-blur"
      >
        <div class="mx-auto max-w-2xl">
          <NoteDetails
            :key="`${pagePosition}-${selectedIndex}`"
            :index="selectedIndex"
            :total="notes.length"
            :note="selectedNote"
            @close="selectedIndex = null"
          />
        </div>
      </div>

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
