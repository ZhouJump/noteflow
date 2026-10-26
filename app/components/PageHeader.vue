<script setup lang="ts">
/**
 * 所有页面的顶栏：固定高度、统一留白与标题排版。
 *
 * 左侧返回按钮的位置固定占位（没有返回时留空），标题不会因为页面层级不同
 * 而左右移动；右侧操作、顶栏正中的内容与第二行附加内容分别用默认插槽、
 * `center` 插槽与 `sub` 插槽。安装成桌面应用后，这一栏同时充当自定义标题栏：
 * `data-app-titlebar` 让全局样式避让窗口按钮并允许拖动。
 *
 * 顶栏与页面正文共用同一列宽（max-w-4xl，移动端 px-4），切换页面时内容不会
 * 左右跳；曲谱页需要给乐谱留宽度，其余页面也按这一列居中。
 */
withDefaults(defineProps<{
  title: string
  back?: string
  backLabel?: string
}>(), {
  back: undefined,
  backLabel: '返回'
})

const slots = useSlots()
/** 有 `center` 插槽时改成三栏网格，让中间内容相对顶栏真正居中。 */
const centered = computed(() => slots.center !== undefined)
</script>

<template>
  <header
    class="sticky top-0 z-20 border-b border-default bg-default/95 backdrop-blur"
    data-app-titlebar
  >
    <div
      class="mx-auto h-12 max-w-4xl items-center gap-1 px-4"
      :class="centered ? 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]' : 'flex'"
    >
      <div class="flex min-w-0 flex-1 items-center gap-1">
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
      </div>
      <div
        v-if="centered"
        class="justify-self-center"
      >
        <slot name="center" />
      </div>
      <div class="flex shrink-0 items-center justify-end justify-self-end gap-1">
        <slot />
      </div>
    </div>
    <slot name="sub" />
  </header>
</template>
