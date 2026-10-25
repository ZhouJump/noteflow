<script setup lang="ts">
import type { ScoreRecord } from '~/lib/db/schema'

/**
 * 谱架与谱集页共用的曲谱卡片内容：封面、曲名与作曲/页数。
 *
 * 外层的链接、拖拽与选中样式由页面负责，这里只保证两种列表的视觉一致。
 * `backdrop` 是第二页的缩略图：多页曲谱把它垫在封面下面，稍旋转露出一点，
 * 看上去像一叠散开的纸。
 */
defineProps<{
  score: ScoreRecord
  thumbnail: string | null
  backdrop?: string | null
}>()
</script>

<template>
  <div class="group flex flex-col">
    <div class="relative">
      <div
        v-if="backdrop"
        class="absolute inset-0 translate-x-1 translate-y-1 rotate-3 border border-default bg-white shadow-sm"
        data-test="score-backdrop"
      >
        <img
          :src="backdrop"
          alt=""
          class="h-full w-full object-cover object-top opacity-90"
          draggable="false"
        >
      </div>
      <div class="relative aspect-3/4 overflow-hidden border border-default bg-white shadow-sm">
        <img
          v-if="thumbnail"
          :src="thumbnail"
          :alt="`${score.title} 的缩略图`"
          class="h-full w-full object-cover object-top"
          draggable="false"
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
  </div>
</template>
