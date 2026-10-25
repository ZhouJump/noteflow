<script setup lang="ts">
/**
 * 所有页面的顶栏：固定高度、统一留白与标题排版。
 *
 * 左侧返回按钮的位置固定占位（没有返回时留空），标题不会因为页面层级不同
 * 而左右移动；右侧操作与第二行（翻页等）分别用默认插槽和 `sub` 插槽。
 */
withDefaults(defineProps<{
  title: string
  back?: string
  backLabel?: string
}>(), {
  back: undefined,
  backLabel: '返回'
})
</script>

<template>
  <header class="sticky top-0 z-20 border-b border-default bg-default/95 backdrop-blur">
    <div class="mx-auto flex h-12 max-w-2xl items-center gap-1 px-2">
      <!-- 返回位固定 32px，有无返回按钮标题都从同一处开始。 -->
      <div class="flex size-8 shrink-0 items-center justify-center">
        <UButton
          v-if="back"
          :to="back"
          icon="i-lucide-chevron-left"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="backLabel"
        />
      </div>
      <h1
        class="min-w-0 flex-1 truncate text-base font-medium"
        data-test="page-title"
      >
        {{ title }}
      </h1>
      <slot />
    </div>
    <slot name="sub" />
  </header>
</template>
