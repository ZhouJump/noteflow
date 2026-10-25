<script setup lang="ts">
import { describeStorageError, listShelf } from '~/lib/db/scores'
import type { ScoreRecord } from '~/lib/db/schema'

/**
 * 书架：只读取本机 IndexedDB 里的曲谱，不展示任何演示数据。
 *
 * 手机上只保留封面、曲名与作曲；缩略图在这里换成临时 URL，离开页面时统一回收。
 */
useSeoMeta({ title: '书架 · NoteFlow' })

const scores = ref<ScoreRecord[]>([])
const thumbnails = shallowRef(new Map<string, string>())
const loading = ref(true)
const failure = ref<string | null>(null)

function releaseThumbnails(): void {
  for (const url of thumbnails.value.values()) URL.revokeObjectURL(url)
  thumbnails.value = new Map()
}

async function load(): Promise<void> {
  loading.value = true
  failure.value = null
  try {
    const shelf = await listShelf()
    const urls = new Map<string, string>()
    for (const [id, blob] of shelf.thumbnails) urls.set(id, URL.createObjectURL(blob))
    releaseThumbnails()
    thumbnails.value = urls
    scores.value = shelf.scores
  } catch (exception) {
    failure.value = describeStorageError(exception)
  } finally {
    loading.value = false
  }
}

onMounted(load)
onBeforeUnmount(releaseThumbnails)

function thumbnailOf(score: ScoreRecord): string | null {
  if (score.thumbnailAssetId === null) return null
  return thumbnails.value.get(score.thumbnailAssetId) ?? null
}
</script>

<template>
  <div class="min-h-dvh bg-default pb-12">
    <PageHeader title="书架">
      <span
        v-if="!loading && scores.length > 0"
        class="pr-2 text-xs text-muted tabular-nums"
      >{{ scores.length }} 份</span>
    </PageHeader>

    <div class="mx-auto max-w-2xl px-4 pt-4">
      <UAlert
        v-if="failure"
        class="mb-4"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="无法读取本机曲谱"
        :description="failure"
      />

      <div class="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
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
            v-for="score in scores"
            :key="score.id"
            :to="`/scores/${score.id}`"
            class="group flex flex-col"
            data-test="shelf-score"
          >
            <div class="aspect-3/4 overflow-hidden border border-default bg-white">
              <img
                v-if="thumbnailOf(score)"
                :src="thumbnailOf(score) ?? ''"
                :alt="`${score.title} 的缩略图`"
                class="h-full w-full object-cover object-top"
                data-test="score-thumbnail"
              >
              <div
                v-else
                class="grid h-full place-items-center"
              >
                <UIcon
                  name="i-lucide-music"
                  class="size-8 text-muted"
                />
              </div>
            </div>
            <p class="mt-2 truncate text-sm font-medium">
              {{ score.title }}
            </p>
            <p
              v-if="score.composer"
              class="truncate text-xs text-muted"
            >
              {{ score.composer }}
            </p>
            <p
              v-else-if="score.pageCount > 1"
              class="text-xs text-muted"
            >
              {{ score.pageCount }} 页
            </p>
          </NuxtLink>
        </template>
      </div>

      <p
        v-if="!loading && scores.length === 0"
        class="pt-6 text-sm text-muted"
      >
        还没有曲谱。点「添加曲谱」导入图片或 MusicXML。
      </p>
    </div>
  </div>
</template>
