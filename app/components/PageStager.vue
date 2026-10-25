<script setup lang="ts">
import { describeStorageError, saveRecognizedScore } from '~/lib/db/scores'
import type { RecognitionResult } from '~/lib/homr/recognition'

/**
 * 页面暂存与识别：相册图片和 PDF 渲染出的页面都进这里。
 *
 * 两列缩略图展示页面，末尾留一格继续添加；长按缩略图可以拖动排序，
 * 右上角移除。识别统计与 MusicXML 属于验收/排查信息，放在隐藏节点里。
 * 添加动作交给父页面：图片走相册，PDF 先渲染成图片再 `addPages()`。
 */
const props = defineProps<{
  addLabel: string
}>()

const emit = defineEmits<{
  add: []
  count: [value: number]
}>()

const { running, stageLabel, fraction, error, pages, total, currentIndex, recognizeFiles, cancel, reset }
  = useHomrRecognition()

interface StagedPage {
  id: string
  file: Blob
  name: string
  url: string
}

const staged = shallowRef<StagedPage[]>([])
const title = ref('')
const composer = ref('')
const saving = ref(false)
const saveError = ref<string | null>(null)
const saveOpen = ref(false)
const draggingId = ref<string | null>(null)

const recognized = computed(() => pages.value.length > 0)
const showBadges = computed(() => running.value || recognized.value || error.value !== null)
const firstResult = computed<RecognitionResult | null>(() => pages.value[0]?.result ?? null)
const noteTotal = computed(() => pages.value.reduce((sum, page) => sum + page.result.counts.notes, 0))
const restTotal = computed(() => pages.value.reduce((sum, page) => sum + page.result.counts.rests, 0))

const statusText = computed(() => {
  if (error.value) return error.value === '已取消识别' ? error.value : `识别失败：${error.value}`
  if (running.value) {
    const stage = stageLabel.value ? ` · ${stageLabel.value}` : ''
    return `识别中 · 第 ${currentIndex.value + 1} / ${total.value} 页${stage}`
  }
  if (recognized.value) {
    if (pages.value.length === 1) return `识别完成：${noteTotal.value} 个音符，${restTotal.value} 个休止符`
    return `识别完成：${pages.value.length} 页，${noteTotal.value} 个音符，${restTotal.value} 个休止符`
  }
  if (staged.value.length > 0) return `已选 ${staged.value.length} 页，可以开始识别`
  return '等待页面'
})

watch(() => staged.value.length, value => emit('count', value), { immediate: true })

/** 缩略图上的状态；没开始识别时不显示，避免页面列表变成状态表。 */
function tileStatus(index: number): string {
  if (index < pages.value.length) return '已完成'
  if (running.value && index === currentIndex.value) return stageLabel.value || '识别中'
  if (error.value && index === currentIndex.value) return '失败'
  return '等待'
}

function releasePreviews(): void {
  for (const page of staged.value) URL.revokeObjectURL(page.url)
}

/** 页面组成变了，之前的识别结果就不再对应当前页面，直接作废。 */
function invalidate(): void {
  if (recognized.value || error.value !== null) reset()
}

let serial = 0

/** 追加页面；`meta` 给 PDF 这类来源一个干净的默认曲名与作曲者。 */
function addPages(
  files: { file: Blob, name: string }[],
  meta?: { title?: string, composer?: string }
): void {
  if (running.value || files.length === 0) return
  invalidate()
  const additions = files.map(({ file, name }) => ({
    id: `page-${(serial += 1)}`,
    file,
    name,
    url: URL.createObjectURL(file)
  }))
  staged.value = [...staged.value, ...additions]
  if (title.value.trim() === '') title.value = meta?.title ?? files[0].name.replace(/\.[^.]+$/, '')
  if (composer.value.trim() === '' && meta?.composer !== undefined) composer.value = meta.composer
  saveError.value = null
}

function removePage(id: string): void {
  if (running.value) return
  const page = staged.value.find(entry => entry.id === id)
  if (page === undefined) return
  URL.revokeObjectURL(page.url)
  staged.value = staged.value.filter(entry => entry.id !== id)
  invalidate()
  if (staged.value.length === 0) title.value = ''
}

async function startRecognition(): Promise<void> {
  if (staged.value.length === 0 || running.value) return
  saveError.value = null
  draggingId.value = null
  await recognizeFiles(staged.value.map(page => ({ file: page.file, name: page.name })))
  if (pages.value.length > 0 && title.value.trim() === '') {
    title.value = pages.value[0].result.title
  }
}

function openSave(): void {
  if (pages.value.length === 0) return
  saveError.value = null
  saveOpen.value = true
}

async function saveToShelf(): Promise<void> {
  if (pages.value.length === 0) return
  saving.value = true
  saveError.value = null
  try {
    const response = await saveRecognizedScore({
      title: title.value,
      composer: composer.value,
      pages: pages.value.map(page => ({
        source: page.source,
        fileName: page.fileName,
        result: page.result,
        processed: page.processed
      }))
    })
    await navigateTo(`/scores/${response.scoreId}`)
  } catch (exception) {
    saveError.value = describeStorageError(exception)
  } finally {
    saving.value = false
  }
}

// ---- 长按拖动排序 ----
// 手指按住 300ms 抬起拖动，期间用 touchmove 的 preventDefault 压掉页面滚动；
// 鼠标同样适用，方便桌面调试。
let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressOrigin: { x: number, y: number } | null = null
let pressId: string | null = null

function blockTouchScroll(event: TouchEvent): void {
  event.preventDefault()
}

function clearPress(): void {
  if (pressTimer !== null) clearTimeout(pressTimer)
  pressTimer = null
  pressOrigin = null
  pressId = null
}

function endDrag(): void {
  if (draggingId.value === null) return
  draggingId.value = null
  document.removeEventListener('touchmove', blockTouchScroll)
  document.body.style.userSelect = ''
}

function movePage(sourceId: string, targetId: string): void {
  const from = staged.value.findIndex(page => page.id === sourceId)
  const to = staged.value.findIndex(page => page.id === targetId)
  if (from < 0 || to < 0 || from === to) return
  const next = [...staged.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  staged.value = next
  invalidate()
}

function onPointerDown(event: PointerEvent, id: string): void {
  if (running.value) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  if ((event.target as Element).closest('button') !== null) return
  pressOrigin = { x: event.clientX, y: event.clientY }
  pressId = id
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  pressTimer = setTimeout(() => {
    pressTimer = null
    if (pressId !== id) return
    draggingId.value = id
    document.addEventListener('touchmove', blockTouchScroll, { passive: false })
    document.body.style.userSelect = 'none'
    navigator.vibrate?.(8)
  }, 300)
}

function onPointerMove(event: PointerEvent): void {
  if (pressTimer !== null && pressOrigin !== null) {
    const moved = Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y)
    if (moved > 8) clearPress()
  }
  const dragged = draggingId.value
  if (dragged === null) return
  if (event.cancelable) event.preventDefault()
  const under = document.elementFromPoint(event.clientX, event.clientY)
  const targetId = under?.closest<HTMLElement>('[data-page-id]')?.dataset.pageId
  if (targetId !== undefined && targetId !== dragged) movePage(dragged, targetId)
  const margin = 72
  if (event.clientY < margin) window.scrollBy(0, -12)
  else if (event.clientY > window.innerHeight - margin) window.scrollBy(0, 12)
}

function onPointerUp(): void {
  clearPress()
  endDrag()
}

onMounted(() => {
  // 指针在缩略图外抬起时也要结束拖动。
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
})

onBeforeUnmount(() => {
  clearPress()
  endDrag()
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  releasePreviews()
})

defineExpose({ addPages })
</script>

<template>
  <main class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 px-4 py-3">
    <p
      class="sr-only"
      role="status"
      aria-live="polite"
      data-test="status"
    >
      {{ statusText }}
    </p>

    <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <div
        v-for="(page, index) in staged"
        :key="page.id"
        class="relative aspect-3/4 select-none overflow-hidden border border-default bg-white"
        :class="draggingId === page.id ? 'opacity-40' : 'opacity-100'"
        :data-page-id="page.id"
        :data-page-name="page.name"
        data-test="page-item"
        @pointerdown="onPointerDown($event, page.id)"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @contextmenu.prevent
      >
        <img
          :src="page.url"
          alt=""
          draggable="false"
          class="pointer-events-none h-full w-full object-cover object-top"
        >
        <span class="absolute left-0 top-0 bg-default/85 px-1.5 py-0.5 text-[11px] tabular-nums text-muted">
          {{ index + 1 }}
        </span>
        <button
          v-if="!running"
          type="button"
          class="absolute right-0 top-0 grid size-8 place-items-center bg-default/85 text-muted"
          aria-label="移除这一页"
          data-test="remove-page"
          @click.stop="removePage(page.id)"
        >
          <UIcon
            name="i-lucide-x"
            class="size-4"
          />
        </button>
        <p
          v-if="showBadges"
          class="absolute inset-x-0 bottom-0 bg-default/85 px-1.5 py-0.5 text-[11px]"
        >
          {{ tileStatus(index) }}
        </p>
        <div
          v-if="draggingId === page.id"
          class="pointer-events-none absolute inset-0 border-2 border-primary"
        />
      </div>

      <button
        v-if="!running"
        type="button"
        class="grid aspect-3/4 place-items-center gap-1 border border-dashed border-default text-muted"
        data-test="add-page"
        @click="emit('add')"
      >
        <UIcon
          name="i-lucide-plus"
          class="size-6"
        />
        <span class="text-xs">{{ props.addLabel }}</span>
      </button>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="error"
      description="已完成的页面仍可保存；需要全部页面时重新识别。"
      data-test="recognition-error"
    />

    <!-- 验收脚本读取的识别详情不进入界面。 -->
    <div
      v-if="firstResult"
      class="hidden"
      aria-hidden="true"
    >
      <div data-test="result">
        <dl>
          <dt>谱表 / 系统</dt>
          <dd>{{ firstResult.counts.staves }} / {{ firstResult.counts.systems }}</dd>
          <dt>音符头</dt>
          <dd>{{ firstResult.counts.noteheads }}</dd>
          <dt>识别音符 / 休止符</dt>
          <dd>{{ firstResult.counts.notes }} / {{ firstResult.counts.rests }}</dd>
          <dt>已定位 / 未定位</dt>
          <dd>{{ firstResult.counts.withPosition }} / {{ firstResult.counts.withoutPosition }}</dd>
          <dt>耗时</dt>
          <dd>{{ (firstResult.timings.total / 1000).toFixed(2) }} s</dd>
        </dl>
      </div>
      <div data-test="runtime">
        {{ firstResult.runtime.threads }} 线程 ·
        {{ firstResult.runtime.crossOriginIsolated ? '跨源隔离已启用' : '未跨源隔离' }}
      </div>
      <pre data-test="musicxml">{{ firstResult.musicxml }}</pre>
    </div>
  </main>

  <footer
    v-if="running || recognized || staged.length > 0"
    class="sticky bottom-0 z-20 border-t border-default bg-default px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
  >
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-2">
      <template v-if="running">
        <UProgress
          :model-value="Math.round(fraction * 100)"
          size="sm"
        />
        <UButton
          block
          color="neutral"
          variant="outline"
          icon="i-lucide-x"
          label="取消识别"
          @click="cancel"
        />
      </template>
      <template v-else-if="recognized">
        <UButton
          block
          size="lg"
          icon="i-lucide-library-big"
          label="保存到谱架"
          :loading="saving"
          data-test="save-score"
          @click="openSave"
        />
        <p
          v-if="saveError"
          class="text-sm text-error"
          data-test="save-error"
        >
          {{ saveError }}
        </p>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-refresh-cw"
          label="重新识别"
          @click="startRecognition"
        />
      </template>
      <UButton
        v-else-if="staged.length > 0"
        block
        size="lg"
        icon="i-lucide-scan-text"
        label="开始识别"
        data-test="start-recognition"
        @click="startRecognition"
      />
    </div>
  </footer>

  <UModal
    v-model:open="saveOpen"
    :dismissible="!saving"
  >
    <template #header>
      <h2 class="text-base font-semibold">
        保存到谱架
      </h2>
    </template>
    <template #body>
      <div class="grid gap-4">
        <UFormField label="曲谱名称">
          <UInput
            v-model="title"
            placeholder="曲谱名称"
            class="w-full"
            data-test="score-title-input"
          />
        </UFormField>
        <UFormField label="作曲 / 编曲">
          <UInput
            v-model="composer"
            placeholder="可选"
            class="w-full"
            data-test="score-composer-input"
          />
        </UFormField>
        <p
          v-if="saveError"
          class="text-sm text-error"
          data-test="save-error"
        >
          {{ saveError }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          label="取消"
          :disabled="saving"
          data-test="save-cancel"
          @click="saveOpen = false"
        />
        <UButton
          label="保存"
          :loading="saving"
          data-test="save-score-confirm"
          @click="saveToShelf"
        />
      </div>
    </template>
  </UModal>
</template>
