<script setup lang="ts">
/**
 * 侧栏图标按钮：窄屏也放得下，图标下方一行小字。
 *
 * 两侧控件都用它，保证触控尺寸、激活态和键盘焦点一致。
 */
withDefaults(defineProps<{
  icon: string
  label: string
  active?: boolean
  disabled?: boolean
  /** 追加到图标上的类，用于随状态变化的动效。 */
  iconClass?: string
  /** 验收脚本使用的稳定选择器。 */
  test?: string
}>(), {
  active: false,
  disabled: false,
  iconClass: undefined,
  test: undefined
})

const emit = defineEmits<{ press: [] }>()
</script>

<template>
  <button
    type="button"
    class="flex w-11 flex-col items-center gap-0.5 rounded-lg px-0.5 py-1.5 text-[10px] leading-none transition-colors disabled:opacity-40"
    :class="active
      ? 'bg-amber-100 text-amber-800'
      : 'text-muted hover:bg-elevated hover:text-default'"
    :disabled="disabled"
    :aria-label="label"
    :aria-pressed="active ? 'true' : undefined"
    :data-test="test"
    @click="emit('press')"
  >
    <UIcon
      :name="icon"
      class="size-6"
      :class="iconClass"
    />
    <span class="max-w-full truncate">{{ label }}</span>
  </button>
</template>
