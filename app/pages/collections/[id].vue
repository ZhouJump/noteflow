<script setup lang="ts">
import {
  clearCollectionCover,
  deleteCollection,
  loadCollection,
  removeScoreFromCollection,
  renameCollection,
  setCollectionCover,
  type CollectionDetail
} from '~/lib/db/collections'
import type { ScoreRecord } from '~/lib/db/schema'
import { describeStorageError } from '~/lib/db/scores'

/**
 * 谱集详情：列出谱集内的曲谱，支持重命名、删除谱集、设置封面和长按拖出。
 *
 * 删除谱集只解除归属，曲谱回到谱架；长按曲谱拖到底部区域同样只是移出。
 * 移出最后一首后谱集会被自动删除，直接返回谱架。
 */
const route = useRoute()
const toast = useToast()
const collectionId = computed(() => String(route.params.id ?? ''))

const detail = ref<CollectionDetail | null>(null)
const thumbnails = shallowRef(new Map<string, string>())
const loading = ref(true)
const failure = ref<string | null>(null)

// 谱集名要等 IndexedDB 读回后才知道，标题与描述用 getter，加载完成后自动更新。
const seoTitle = computed(() => {
  const collection = detail.value?.collection
  return collection === undefined ? '谱集 · NoteFlow' : `${collection.title} · 谱集 · NoteFlow`
})
const seoDescription = computed(() => {
  const value = detail.value
  if (value === null) return '谱架上的谱集：查看曲谱、设置封面与整理演出顺序。'
  return `「${value.collection.title}」谱集，共 ${value.scores.length} 首曲谱，可以设置封面、重命名与拖拽移出。`
})
usePageSeo(seoTitle, seoDescription)

const editOpen = ref(false)
const editTitle = ref('')
const editError = ref<string | null>(null)
const savingEdit = ref(false)

const deleteOpen = ref(false)
const deleting = ref(false)

// ---- 编辑对话框里的封面 ----
// 选中的图片先留在草稿里，点保存才写库；取消或关掉对话框时直接丢掉。
const cameraInput = ref<HTMLInputElement | null>(null)
const pickerInput = ref<HTMLInputElement | null>(null)
const coverDraft = shallowRef<{ blob: Blob, url: string } | null>(null)
const coverRemoved = ref(false)

/** 已保存封面的预览；对话框里用它判断有没有封面可移除。 */
const savedCoverUrl = computed(() => {
  const id = detail.value?.collection.coverAssetId
  return id === null || id === undefined ? null : thumbnails.value.get(id) ?? null
})

/** 草稿优先，其次已保存封面；移除后回到空状态。 */
const coverPreviewUrl = computed(() => {
  if (coverDraft.value !== null) return coverDraft.value.url
  return coverRemoved.value ? null : savedCoverUrl.value
})

function releaseDraft(): void {
  if (coverDraft.value !== null) URL.revokeObjectURL(coverDraft.value.url)
  coverDraft.value = null
}

/** 同一个文件连续选两次也要触发 change，选完先清空 input。 */
function onCoverPicked(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined) return
  releaseDraft()
  coverDraft.value = { blob: file, url: URL.createObjectURL(file) }
  coverRemoved.value = false
}

/** 移除：点保存时清掉已存的封面；只有草稿时直接回到未设置。 */
function dropCover(): void {
  releaseDraft()
  coverRemoved.value = true
}

function releaseThumbnails(): void {
  for (const url of thumbnails.value.values()) URL.revokeObjectURL(url)
  thumbnails.value = new Map()
}

async function load(): Promise<void> {
  failure.value = null
  try {
    const shelf = await loadCollection(collectionId.value)
    if (shelf === null) {
      detail.value = null
      failure.value = '这个谱集已经不在谱架上了，可能被删除了。'
      return
    }
    const urls = new Map<string, string>()
    for (const [id, blob] of shelf.thumbnails) urls.set(id, URL.createObjectURL(blob))
    releaseThumbnails()
    thumbnails.value = urls
    detail.value = shelf
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

function openEdit(): void {
  editTitle.value = detail.value?.collection.title ?? ''
  editError.value = null
  coverRemoved.value = false
  releaseDraft()
  editOpen.value = true
}

async function saveEdit(): Promise<void> {
  if (detail.value === null || savingEdit.value) return
  const title = editTitle.value.trim()
  if (title === '') {
    editError.value = '谱集名称不能为空'
    return
  }
  savingEdit.value = true
  editError.value = null
  try {
    // 封面先写：图片解码失败时名称还没动过，不会留下改了一半的谱集。
    if (coverDraft.value !== null) await setCollectionCover(collectionId.value, coverDraft.value.blob)
    else if (coverRemoved.value) await clearCollectionCover(collectionId.value)
    const renamed = await renameCollection(collectionId.value, title)
    detail.value = {
      ...detail.value,
      collection: { ...detail.value.collection, title: renamed }
    }
    await load()
    editOpen.value = false
  } catch (exception) {
    editError.value = `保存失败：${describeStorageError(exception)}`
  } finally {
    savingEdit.value = false
  }
}

// 关闭对话框就丢掉未保存的封面草稿，避免临时 URL 挂着。
watch(editOpen, (open) => {
  if (open) return
  releaseDraft()
  coverRemoved.value = false
})

async function performDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  const count = detail.value?.scores.length ?? 0
  try {
    await deleteCollection(collectionId.value)
    deleteOpen.value = false
    toast.add({
      title: '已删除谱集',
      description: `${count} 首曲谱已回到谱架，曲谱本身没有被删除。`,
      icon: 'i-lucide-library-big',
      color: 'primary'
    })
    await navigateTo('/')
  } catch (exception) {
    deleteOpen.value = false
    failure.value = `删除失败：${describeStorageError(exception)}`
  } finally {
    deleting.value = false
  }
}

// ---- 长按拖出谱集 ----
const dragScore = ref<ScoreRecord | null>(null)
const dragPoint = reactive({ x: 0, y: 0 })
const overRemove = ref(false)

let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressOrigin: { x: number, y: number } | null = null
let pressScore: ScoreRecord | null = null
let lastPointer = { x: 0, y: 0 }
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
  overRemove.value = false
  document.removeEventListener('touchmove', blockTouchScroll)
  document.body.style.userSelect = ''
}

function releaseSuppress(): void {
  if (suppressTimer !== null) clearTimeout(suppressTimer)
  suppressTimer = setTimeout(() => {
    suppressClick = false
  }, 320)
}

function overRemoveZone(x: number, y: number): boolean {
  const zone = document.querySelector<HTMLElement>('[data-test="collection-remove-zone"]')
  if (zone === null) return false
  const rect = zone.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
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

function onPointerMove(event: PointerEvent): void {
  lastPointer = { x: event.clientX, y: event.clientY }
  if (pressTimer !== null && pressOrigin !== null) {
    const moved = Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y)
    if (moved > 8) clearPress()
  }
  if (dragScore.value === null) return
  if (event.cancelable) event.preventDefault()
  dragPoint.x = event.clientX
  dragPoint.y = event.clientY
  overRemove.value = overRemoveZone(event.clientX, event.clientY)
  const margin = 72
  if (event.clientY < margin) window.scrollBy(0, -12)
  else if (event.clientY > window.innerHeight - margin) window.scrollBy(0, 12)
}

function onPointerUp(event: PointerEvent): void {
  clearPress()
  const dragged = dragScore.value
  if (dragged === null) return
  const shouldRemove = overRemoveZone(event.clientX, event.clientY)
  resetDrag()
  if (!shouldRemove) {
    releaseSuppress()
    return
  }
  void removeDragged(dragged)
}

function onPointerCancel(): void {
  clearPress()
  resetDrag()
  releaseSuppress()
}

async function removeDragged(score: ScoreRecord): Promise<void> {
  try {
    const result = await removeScoreFromCollection(score.id)
    toast.add({
      title: '已移出谱集',
      description: result.collectionDeleted
        ? `「${score.title}」已回到谱架，谱集里没有其他曲谱，谱集也已删除。`
        : `「${score.title}」已回到谱架。`,
      icon: 'i-lucide-library-big',
      color: 'primary'
    })
    if (result.collectionDeleted) {
      await navigateTo('/')
      return
    }
    await load()
  } catch (exception) {
    toast.add({
      title: '移出失败',
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

onMounted(() => {
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('keydown', onKeyDown)
  void load()
})

onBeforeUnmount(() => {
  clearPress()
  resetDrag()
  if (suppressTimer !== null) clearTimeout(suppressTimer)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('keydown', onKeyDown)
  releaseDraft()
  releaseThumbnails()
})
</script>

<template>
  <div class="min-h-dvh bg-default pb-12">
    <PageHeader
      :title="detail?.collection.title ?? '谱集'"
      back="/"
      back-label="返回谱架"
    >
      <template v-if="detail">
        <UButton
          icon="i-lucide-pencil"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="编辑谱集"
          data-test="collection-edit"
          @click="openEdit"
        />
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="删除谱集"
          data-test="collection-delete"
          @click="deleteOpen = true"
        />
      </template>
    </PageHeader>

    <div class="mx-auto max-w-4xl px-4 pt-4">
      <div
        v-if="loading"
        class="flex items-center justify-center gap-2 py-16 text-sm text-muted"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 animate-spin"
        />
        正在打开谱集
      </div>

      <div
        v-else-if="failure"
        class="grid gap-4 py-10"
      >
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="无法打开谱集"
          :description="failure"
          data-test="collection-failure"
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
        <div
          class="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3"
          @click.capture="onGridClickCapture"
        >
          <NuxtLink
            v-for="score in detail.scores"
            :key="score.id"
            :to="`/scores/${score.id}`"
            class="group flex select-none flex-col rounded-sm transition"
            :class="dragScore?.id === score.id ? 'opacity-40' : ''"
            :data-score-id="score.id"
            draggable="false"
            data-test="collection-score"
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
            />
          </NuxtLink>
        </div>

        <p
          v-if="detail.scores.length === 0"
          class="py-10 text-sm text-muted"
        >
          这个谱集里还没有曲谱。
        </p>
      </template>
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
      >
      <div
        v-else
        class="grid aspect-3/4 place-items-center"
      >
        <UIcon
          name="i-lucide-music"
          class="size-6 text-muted"
        />
      </div>
    </div>

    <div
      v-if="dragScore"
      class="fixed inset-x-3 bottom-4 z-50 mx-auto flex max-w-md items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-3 text-sm font-medium shadow-lg transition"
      :class="overRemove ? 'border-error bg-error/10 text-error' : 'border-default bg-elevated text-muted'"
      data-test="collection-remove-zone"
    >
      <UIcon
        name="i-lucide-unlink"
        class="size-4"
      />
      拖到这里移出谱集
    </div>

    <UModal v-model:open="editOpen">
      <template #header>
        <h2 class="text-base font-semibold">
          编辑谱集
        </h2>
      </template>
      <template #body>
        <div class="grid gap-4">
          <UFormField label="名称">
            <UInput
              v-model="editTitle"
              class="w-full"
              data-test="collection-title-input"
              @keyup.enter="saveEdit"
            />
          </UFormField>
          <UFormField label="封面">
            <div class="flex items-center gap-3">
              <div class="relative aspect-3/4 w-24 shrink-0 overflow-hidden border border-default bg-elevated">
                <img
                  v-if="coverPreviewUrl"
                  :src="coverPreviewUrl"
                  :alt="`${detail?.collection.title ?? '谱集'} 的封面`"
                  class="h-full w-full object-cover"
                  data-test="collection-cover-image"
                >
                <div
                  v-else
                  class="grid h-full place-items-center"
                >
                  <UIcon
                    name="i-lucide-image"
                    class="size-4 text-muted"
                  />
                </div>
              </div>
              <div class="flex flex-1 flex-wrap gap-2">
                <UButton
                  label="拍摄"
                  icon="i-lucide-camera"
                  color="neutral"
                  variant="outline"
                  size="xs"
                  data-test="collection-cover-camera-button"
                  @click="cameraInput?.click()"
                />
                <UButton
                  label="选择图片"
                  icon="i-lucide-image"
                  color="neutral"
                  variant="outline"
                  size="xs"
                  data-test="collection-cover-picker-button"
                  @click="pickerInput?.click()"
                />
                <UButton
                  v-if="coverPreviewUrl"
                  label="移除"
                  icon="i-lucide-image-off"
                  color="error"
                  variant="ghost"
                  size="xs"
                  data-test="collection-cover-remove"
                  @click="dropCover"
                />
              </div>
            </div>
          </UFormField>
          <p
            v-if="editError"
            class="text-sm text-error"
          >
            {{ editError }}
          </p>
        </div>
        <input
          ref="cameraInput"
          type="file"
          accept="image/*"
          capture="environment"
          class="hidden"
          data-test="collection-cover-camera"
          @change="onCoverPicked"
        >
        <input
          ref="pickerInput"
          type="file"
          accept="image/*"
          class="hidden"
          data-test="collection-cover-picker"
          @change="onCoverPicked"
        >
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="取消"
            @click="editOpen = false"
          />
          <UButton
            label="保存"
            :loading="savingEdit"
            data-test="collection-edit-confirm"
            @click="saveEdit"
          />
        </div>
      </template>
    </UModal>

    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除谱集"
      :description="detail ? `删除「${detail.collection.title}」？谱集内的 ${detail.scores.length} 首曲谱会回到谱架，曲谱本身不会被删除。` : '删除这个谱集？'"
      confirm-label="删除谱集"
      confirm-color="error"
      :loading="deleting"
      @confirm="performDelete"
    />
  </div>
</template>
