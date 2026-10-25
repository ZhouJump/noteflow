<script setup lang="ts">
import type { ScoreRunRecord } from '~/lib/db/schema'
import { formatDuration, formatRunTime } from '~/lib/format'

/**
 * 评分历史：按时间倒序列出本机保存的每一次成绩，点一行打开逐音详情。
 *
 * 记录只存在本机 IndexedDB，删除曲谱时一并删除。
 */
defineProps<{
  open: boolean
  runs: ScoreRunRecord[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'select': [run: ScoreRunRecord]
}>()

function select(run: ScoreRunRecord): void {
  emit('update:open', false)
  emit('select', run)
}
</script>

<template>
  <UModal
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <template #header>
      <h2 class="text-base font-semibold">
        评分记录
      </h2>
    </template>
    <template #body>
      <div
        v-if="runs.length > 0"
        class="max-h-[60dvh] overflow-y-auto"
        data-test="score-history"
      >
        <button
          v-for="run in runs"
          :key="run.id"
          type="button"
          class="flex w-full items-center gap-3 border-b border-default py-2.5 text-left last:border-b-0"
          data-test="score-history-item"
          @click="select(run)"
        >
          <span class="w-12 shrink-0 text-right text-lg font-semibold tabular-nums">
            {{ run.accuracy }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">
              {{ formatRunTime(run.finishedAt) }}
            </span>
            <span class="mt-0.5 block truncate text-xs text-muted">
              {{ run.perfect }} 完美 · {{ run.good }} 良好 · {{ run.missed }} 漏音 · {{ run.wrong }} 错音
            </span>
          </span>
          <span class="shrink-0 text-right text-xs text-muted tabular-nums">
            {{ run.bpm }} BPM<br>
            {{ formatDuration(run.durationMs) }}
          </span>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-4 shrink-0 text-muted"
          />
        </button>
      </div>
      <p
        v-else
        class="py-6 text-center text-sm text-muted"
        data-test="score-history-empty"
      >
        还没有评分记录。打开评分并演奏一遍，成绩会保存在这里。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton
          color="neutral"
          variant="ghost"
          label="关闭"
          data-test="score-history-close"
          @click="emit('update:open', false)"
        />
      </div>
    </template>
  </UModal>
</template>
