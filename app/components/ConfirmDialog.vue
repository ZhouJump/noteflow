<script setup lang="ts">
/**
 * 通用确认对话框：替代 window.confirm，让移动端和桌面端使用同一套 Nuxt UI 外观。
 *
 * 只负责展示与确认，具体动作由调用方在 `confirm` 事件里执行。
 */
withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmColor?: 'primary' | 'error' | 'warning' | 'neutral'
  loading?: boolean
}>(), {
  description: '',
  confirmLabel: '确认',
  cancelLabel: '取消',
  confirmColor: 'primary',
  loading: false
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'confirm': []
  'cancel': []
}>()

function close(): void {
  emit('update:open', false)
  emit('cancel')
}
</script>

<template>
  <UModal
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <template #header>
      <h2 class="text-base font-semibold">
        {{ title }}
      </h2>
    </template>
    <template #body>
      <p
        v-if="description"
        class="text-sm text-muted"
        data-test="confirm-description"
      >
        {{ description }}
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="cancelLabel"
          data-test="dialog-cancel"
          @click="close"
        />
        <UButton
          :color="confirmColor"
          :label="confirmLabel"
          :loading="loading"
          data-test="dialog-confirm"
          @click="emit('confirm')"
        />
      </div>
    </template>
  </UModal>
</template>
