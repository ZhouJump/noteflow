<script setup lang="ts">
import type { PracticeSnapshot } from '~/composables/usePractice'

/**
 * 底部跟随状态条：当前音、进度与麦克风提示。
 *
 * 开始、暂停、结束等操作都在右侧栏；这里只读展示，不占用手势。
 */
const props = defineProps<{
  snapshot: PracticeSnapshot | null
}>()

const currentLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return ''
  if (snapshot.phase === 'done') return '完成'
  return snapshot.current?.label ?? '—'
})

const progressLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return '跟随练习'
  if (snapshot.phase === 'done') return '跟随练习 · 全曲完成'
  if (snapshot.total === 0) return '跟随练习'
  return `跟随练习 · 第 ${snapshot.position + 1} / ${snapshot.total} 音`
})

const statusLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return ''
  if (snapshot.phase === 'error') return '麦克风不可用'
  if (snapshot.phase === 'starting') return '正在打开麦克风'
  if (snapshot.phase === 'paused') return '已暂停'
  if (snapshot.phase === 'done') return '已完成'
  return '正在聆听'
})

const percent = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null || snapshot.total === 0) return 0
  return Math.round((snapshot.position / snapshot.total) * 100)
})
</script>

<template>
  <section
    class="border-t border-default bg-default/95 backdrop-blur"
    data-test="practice-panel"
    :data-phase="snapshot?.phase ?? 'idle'"
  >
    <div class="mx-auto max-w-3xl px-3 py-2">
      <div class="flex items-baseline gap-2">
        <span
          class="truncate text-lg font-semibold tracking-tight"
          data-test="practice-current"
        >{{ currentLabel }}</span>
        <span
          class="min-w-0 flex-1 truncate text-xs text-muted"
          data-test="practice-status"
        >{{ statusLabel }}</span>
        <span
          class="shrink-0 text-xs text-muted tabular-nums"
          data-test="practice-progress"
        >{{ progressLabel }}</span>
      </div>

      <p
        v-if="snapshot?.phase === 'error'"
        class="mt-1 text-sm text-error"
        data-test="practice-error"
      >
        {{ snapshot.error }}
      </p>
      <div
        v-else
        class="mt-1.5"
      >
        <div
          class="h-1 bg-elevated"
          role="progressbar"
          :aria-valuemin="0"
          :aria-valuemax="snapshot?.total ?? 0"
          :aria-valuenow="snapshot?.position ?? 0"
          aria-label="跟随进度"
        >
          <div
            class="h-full bg-amber-700 transition-[width] duration-300"
            :style="{ width: `${percent}%` }"
          />
        </div>
      </div>
    </div>
  </section>
</template>
