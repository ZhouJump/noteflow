<script setup lang="ts">
import { addScoreToCollection, createCollectionFromScores, listShelf, type ShelfCollection } from '~/lib/db/collections'
import type { CollectionRecord, ScoreRecord } from '~/lib/db/schema'
import { describeStorageError } from '~/lib/db/scores'
import { installViolinPreset } from '~/lib/presets/violin'

/**
 * 谱架：谱集在前，独立曲谱在后，只读取本机 IndexedDB，不展示演示数据。
 *
 * 长按 300ms 进入拖拽：拖到独立曲谱上创建一个新谱集，拖到谱集卡上加入谱集。
 * 拖拽期间只更新预览与高亮，松手后才写库；取消或落空不会修改任何记录。
 * 缩略图在这里换成临时 URL，离开页面时统一回收。
 */
usePageSeo('谱架 · NoteFlow', '谱架：按谱集整理曲谱，长按拖拽分组，打开曲谱即可演奏。')

const toast = useToast()

const collections = ref<ShelfCollection[]>([])
const standalone = ref<ScoreRecord[]>([])
const thumbnails = shallowRef(new Map<string, string>())
const backdrops = shallowRef(new Map<string, string>())
const loading = ref(true)
const failure = ref<string | null>(null)

const totalScores = computed(() =>
  standalone.value.length + collections.value.reduce((total, entry) => total + entry.scores.length, 0)
)

function releaseUrls(): void {
  for (const url of thumbnails.value.values()) URL.revokeObjectURL(url)
  for (const url of backdrops.value.values()) URL.revokeObjectURL(url)
  thumbnails.value = new Map()
  backdrops.value = new Map()
}

async function load(): Promise<void> {
  if (collections.value.length === 0 && standalone.value.length === 0) loading.value = true
  failure.value = null
  try {
    const shelf = await listShelf()
    const urls = new Map<string, string>()
    for (const [id, blob] of shelf.thumbnails) urls.set(id, URL.createObjectURL(blob))
    const covers = new Map<string, string>()
    for (const [scoreId, blob] of shelf.backCovers) covers.set(scoreId, URL.createObjectURL(blob))
    releaseUrls()
    thumbnails.value = urls
    backdrops.value = covers
    collections.value = shelf.collections
    standalone.value = shelf.standalone
  } catch (exception) {
    failure.value = describeStorageError(exception)
  } finally {
    loading.value = false
  }
}

function thumbnailOf(score: ScoreRecord): string | null {
  if (score.thumbnailAssetId === null) return null
  return thumbnails.value.get(score.thumbnailAssetId) ?? null
}

/** 多页曲谱的第二页，斜着垫在封面下面。 */
function backdropOf(score: ScoreRecord): string | null {
  return backdrops.value.get(score.id) ?? null
}

/** 用户给谱集设的封面；为 null 时用默认的叠纸封面。 */
function coverOf(entry: ShelfCollection): string | null {
  const id = entry.collection.coverAssetId
  return id === null ? null : thumbnails.value.get(id) ?? null
}

// ---- 长按拖拽整理 ----
interface ScoreDropTarget {
  type: 'score'
  score: ScoreRecord
}

interface CollectionDropTarget {
  type: 'collection'
  collection: CollectionRecord
}

type DropTarget = ScoreDropTarget | CollectionDropTarget | null

const dragScore = ref<ScoreRecord | null>(null)
const dragPoint = reactive({ x: 0, y: 0 })
const dropTarget = ref<DropTarget>(null)

const dropKey = computed(() => {
  const target = dropTarget.value
  if (target === null) return ''
  return target.type === 'score' ? `score:${target.score.id}` : `collection:${target.collection.id}`
})

let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressOrigin: { x: number, y: number } | null = null
let pressScore: ScoreRecord | null = null
let lastPointer = { x: 0, y: 0 }
// 拖动结束后的指针事件还会补发一次 click；在网格捕获阶段吞掉它，避免误进曲谱。
let suppressClick = false
let suppressTimer: ReturnType<typeof setTimeout> | null = null

function blockTouchScroll(event: TouchEvent): void {
  event.preventDefault()
}

function clearPress(): void {
  if (pressTimer !== null) clearTimeout(pressTimer)
  pressTimer = null
  pressOrigin = null
  pressScore = null
}

function resetDrag(): void {
  dragScore.value = null
  dropTarget.value = null
  document.removeEventListener('touchmove', blockTouchScroll)
  document.body.style.userSelect = ''
}

function releaseSuppress(): void {
  if (suppressTimer !== null) clearTimeout(suppressTimer)
  suppressTimer = setTimeout(() => {
    suppressClick = false
  }, 320)
}

function beginDrag(): void {
  const score = pressScore
  if (score === null) return
  clearPress()
  dragScore.value = score
  dragPoint.x = lastPointer.x
  dragPoint.y = lastPointer.y
  suppressClick = true
  document.addEventListener('touchmove', blockTouchScroll, { passive: false })
  document.body.style.userSelect = 'none'
  navigator.vibrate?.(8)
}

function onPointerDown(event: PointerEvent, score: ScoreRecord): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  if (event.target instanceof Element && event.target.closest('button') !== null) return
  clearPress()
  pressOrigin = { x: event.clientX, y: event.clientY }
  lastPointer = { x: event.clientX, y: event.clientY }
  pressScore = score
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  pressTimer = setTimeout(beginDrag, 300)
}

/** 按坐标找可投放的卡片；用矩形命中而不是 elementFromPoint，避免浮层挡住判定。 */
function resolveDrop(x: number, y: number, dragged: ScoreRecord): DropTarget {
  let hit: HTMLElement | null = null
  for (const card of document.querySelectorAll<HTMLElement>('[data-drop-type]')) {
    const rect = card.getBoundingClientRect()
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) hit = card
  }
  const type = hit?.dataset.dropType
  const id = hit?.dataset.dropId
  if (type === 'collection' && id !== undefined) {
    const match = collections.value.find(entry => entry.collection.id === id)
    return match === undefined ? null : { type: 'collection', collection: match.collection }
  }
  if (type === 'score' && id !== undefined && id !== dragged.id) {
    const match = standalone.value.find(score => score.id === id)
    return match === undefined ? null : { type: 'score', score: match }
  }
  return null
}

function onPointerMove(event: PointerEvent): void {
  lastPointer = { x: event.clientX, y: event.clientY }
  if (pressTimer !== null && pressOrigin !== null) {
    const moved = Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y)
    if (moved > 8) clearPress()
  }
  const dragged = dragScore.value
  if (dragged === null) return
  if (event.cancelable) event.preventDefault()
  dragPoint.x = event.clientX
  dragPoint.y = event.clientY
  dropTarget.value = resolveDrop(event.clientX, event.clientY, dragged)
  const margin = 72
  if (event.clientY < margin) window.scrollBy(0, -12)
  else if (event.clientY > window.innerHeight - margin) window.scrollBy(0, 12)
}

function onPointerUp(event: PointerEvent): void {
  clearPress()
  const dragged = dragScore.value
  if (dragged === null) return
  const target = resolveDrop(event.clientX, event.clientY, dragged)
  resetDrag()
  if (target === null) {
    releaseSuppress()
    return
  }
  void applyDrop(dragged, target)
}

function onPointerCancel(): void {
  clearPress()
  resetDrag()
  releaseSuppress()
}

async function applyDrop(score: ScoreRecord, target: DropTarget): Promise<void> {
  if (target === null) return
  try {
    if (target.type === 'score') {
      const created = await createCollectionFromScores(target.score.id, score.id)
      toast.add({
        title: '已创建谱集',
        description: `「${score.title}」和「${target.score.title}」已放入「${created.title}」。`,
        icon: 'i-lucide-library-big',
        color: 'primary'
      })
    } else {
      await addScoreToCollection(target.collection.id, score.id)
      toast.add({
        title: '已加入谱集',
        description: `「${score.title}」已加入「${target.collection.title}」。`,
        icon: 'i-lucide-library-big',
        color: 'primary'
      })
    }
    await load()
  } catch (exception) {
    toast.add({
      title: '整理失败',
      description: describeStorageError(exception),
      icon: 'i-lucide-triangle-alert',
      color: 'error'
    })
  } finally {
    releaseSuppress()
  }
}

function onCardClick(event: MouseEvent): void {
  if (!suppressClick) return
  event.preventDefault()
  event.stopPropagation()
}

function onGridClickCapture(event: MouseEvent): void {
  if (!suppressClick) return
  event.preventDefault()
  event.stopPropagation()
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || dragScore.value === null) return
  clearPress()
  resetDrag()
  releaseSuppress()
}

async function loadWithPreset(): Promise<void> {
  // 首次打开先把自带曲集写进本机库，再一次性读谱架，避免闪一下空状态。
  await installViolinPreset()
  await load()
}

onMounted(() => {
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('keydown', onKeyDown)
  void loadWithPreset()
})

onBeforeUnmount(() => {
  clearPress()
  resetDrag()
  if (suppressTimer !== null) clearTimeout(suppressTimer)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('keydown', onKeyDown)
  releaseUrls()
})
</script>

<template>
  <div class="min-h-dvh bg-default pb-12">
    <PageHeader title="谱架">
      <span
        v-if="!loading && totalScores > 0"
        class="pr-2 text-xs text-muted tabular-nums"
        data-test="shelf-count"
      >{{ totalScores }} 首</span>
    </PageHeader>

    <div class="mx-auto max-w-2xl px-4 pt-4">
      <UAlert
        v-if="failure"
        class="mb-4"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="无法打开谱架"
        :description="failure"
      />

      <div
        class="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3"
        @click.capture="onGridClickCapture"
      >
        <NuxtLink
          to="/import"
          class="flex aspect-3/4 flex-col items-center justify-center gap-2 border border-dashed border-default bg-elevated/20 px-3 text-center"
        >
          <UIcon
            name="i-lucide-plus"
            class="size-8 text-muted"
          />
          <span class="text-sm font-medium">添加曲谱</span>
        </NuxtLink>

        <template v-if="loading">
          <div
            v-for="index in 2"
            :key="index"
            class="aspect-3/4 animate-pulse border border-default bg-elevated/40"
          />
        </template>

        <template v-else>
          <NuxtLink
            v-for="entry in collections"
            :key="entry.collection.id"
            :to="`/collections/${entry.collection.id}`"
            class="group flex select-none flex-col rounded-sm transition"
            :class="dropKey === `collection:${entry.collection.id}` ? 'ring-2 ring-primary' : ''"
            :data-drop-type="'collection'"
            :data-drop-id="entry.collection.id"
            :data-collection-id="entry.collection.id"
            draggable="false"
            data-test="shelf-collection"
            @contextmenu.prevent
            @click="onCardClick"
          >
            <div class="relative aspect-3/4 overflow-hidden border border-default bg-elevated">
              <img
                v-if="coverOf(entry)"
                :src="coverOf(entry) ?? undefined"
                :alt="`${entry.collection.title} 的封面`"
                class="h-full w-full object-cover"
                draggable="false"
                data-test="collection-cover"
              >
              <template v-else>
                <div
                  class="absolute inset-x-0 top-3 flex items-start pl-3"
                  aria-hidden="true"
                >
                  <span class="h-11 w-9 -rotate-6 border border-default bg-default/60" />
                  <span class="-ml-3 h-11 w-9 rotate-3 border border-default bg-default/90" />
                </div>
                <div class="absolute inset-x-0 top-16 px-3">
                  <UIcon
                    name="i-lucide-library-big"
                    class="mb-1 size-4 text-muted"
                  />
                  <p
                    class="line-clamp-3 text-base font-semibold leading-snug"
                    data-test="collection-cover-title"
                  >
                    {{ entry.collection.title }}
                  </p>
                </div>
              </template>
              <span
                class="absolute bottom-1.5 right-1.5 rounded bg-default/85 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-default"
                data-test="collection-count"
              >{{ entry.scores.length }} 首</span>
            </div>
            <p
              class="mt-2 truncate text-sm font-medium"
              data-test="collection-title"
            >
              {{ entry.collection.title }}
            </p>
          </NuxtLink>

          <NuxtLink
            v-for="score in standalone"
            :key="score.id"
            :to="`/scores/${score.id}`"
            class="group flex select-none flex-col rounded-sm transition"
            :class="[
              dropKey === `score:${score.id}` ? 'ring-2 ring-primary' : '',
              dragScore?.id === score.id ? 'opacity-40' : ''
            ]"
            :data-drop-type="'score'"
            :data-drop-id="score.id"
            :data-score-id="score.id"
            draggable="false"
            data-test="shelf-score"
            @contextmenu.prevent
            @pointerdown="onPointerDown($event, score)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerCancel"
            @click="onCardClick"
          >
            <ScoreTile
              :score="score"
              :thumbnail="thumbnailOf(score)"
              :backdrop="backdropOf(score)"
            />
          </NuxtLink>
        </template>
      </div>

      <p
        v-if="!loading && totalScores === 0"
        class="pt-6 text-sm text-muted"
      >
        还没有曲谱。点「添加曲谱」导入图片、PDF 或 MusicXML。
      </p>
    </div>

    <div
      v-if="dragScore"
      class="pointer-events-none fixed z-50 w-24 overflow-hidden rounded-md border border-primary/40 bg-white shadow-xl"
      :style="{ left: `${dragPoint.x}px`, top: `${dragPoint.y}px`, transform: 'translate(-50%, -50%) rotate(2deg)' }"
    >
      <img
        v-if="thumbnailOf(dragScore)"
        :src="thumbnailOf(dragScore) ?? undefined"
        alt=""
        class="aspect-3/4 w-full object-cover object-top"
        draggable="false"
        data-test="shelf-drag-ghost"
      >
      <div
        v-else
        class="grid aspect-3/4 place-items-center"
        data-test="shelf-drag-ghost"
      >
        <UIcon
          name="i-lucide-music"
          class="size-6 text-muted"
        />
      </div>
    </div>
  </div>
</template>
