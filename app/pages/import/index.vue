<script setup lang="ts">
/**
 * 导入入口：只列真实可用的两条链路（图片、MusicXML）。
 */
useSeoMeta({ title: '导入乐谱 · NoteFlow' })

const entries = [
  {
    title: '图片',
    description: '从相册选择页面',
    icon: 'i-lucide-images',
    to: '/import/images'
  },
  {
    title: 'MusicXML',
    description: '直接导入乐谱文件',
    icon: 'i-lucide-file-music',
    to: '/import/musicxml'
  }
]
</script>

<template>
  <div class="min-h-dvh bg-default pb-10">
    <PageHeader
      title="导入乐谱"
      back="/"
      back-label="返回书架"
    />

    <div class="mx-auto grid max-w-2xl gap-3 px-4 pt-4">
      <NuxtLink
        v-for="entry in entries"
        :key="entry.title"
        :to="entry.to"
        class="flex items-center gap-4 border border-default bg-elevated/30 p-4"
      >
        <UIcon
          :name="entry.icon"
          class="size-8 shrink-0 text-muted"
        />
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-medium">
            {{ entry.title }}
          </h2>
          <p class="mt-0.5 text-sm text-muted">
            {{ entry.description }}
          </p>
        </div>
        <UIcon
          name="i-lucide-chevron-right"
          class="size-5 shrink-0 text-muted"
        />
      </NuxtLink>
    </div>

    <p class="mx-auto max-w-2xl px-4 pt-6 text-xs text-muted">
      文件只在本机处理，不会上传。
    </p>
  </div>
</template>
