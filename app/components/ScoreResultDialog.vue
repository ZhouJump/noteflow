<script setup lang="ts">
import { handColor } from '~/lib/audio/practice'
import { SCORE_OUTCOME_LABELS, scoreGrade, type ScoreOutcome } from '~/lib/audio/scoring'
import type { ScoreRunRecord } from '~/lib/db/schema'
import { formatDeviation, formatDuration, formatRunTime } from '~/lib/format'

/**
 * 成绩对话框：本次评分结束时自动打开，也可以从历史记录里打开某一次。
 *
 * 上半部分是总分和四项统计，下半部分是逐音结果；列表在模态内部滚动，
 * 长曲谱也不会把按钮顶出屏幕。
 */
const props = withDefaults(defineProps<{
  open: boolean
  run: ScoreRunRecord | null
  /** 历史记录显示“成绩详情”，刚演奏完显示“本次评分”。 */
  history?: boolean
}>(), {
  history: false
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'retry': []
}>()

const grade = computed(() => props.run === null ? '' : scoreGrade(props.run.accuracy))

function outcomeClass(outcome: ScoreOutcome): string {
  if (outcome === 'perfect' || outcome === 'good') return 'text-emerald-700 bg-emerald-50'
  if (outcome === 'wrong' || outcome === 'missed') return 'text-red-700 bg-red-50'
  return 'text-amber-700 bg-amber-50'
}

function retry(): void {
  emit('update:open', false)
  emit('retry')
}
</script>

<template>
  <UModal
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <template #header>
      <h2 class="text-base font-semibold">
        {{ history ? '成绩详情' : '本次评分' }}
      </h2>
    </template>
    <template #body>
      <div
        v-if="run"
        class="grid gap-4"
        data-test="score-result"
      >
        <div class="flex items-end gap-3">
          <div>
            <p class="text-4xl font-semibold tabular-nums leading-none">
              {{ run.accuracy }}<span class="ml-1 text-sm font-normal text-muted">分</span>
            </p>
            <p class="mt-1 text-sm font-medium">
              {{ grade }}
            </p>
          </div>
          <p
            class="ml-auto text-right text-xs text-muted"
            data-test="score-result-meta"
          >
            {{ run.beats }}/{{ run.beatType }} · {{ run.bpm }} BPM<br>
            {{ formatDuration(run.durationMs) }} · {{ formatRunTime(run.finishedAt) }}
          </p>
        </div>

        <div class="grid grid-cols-4 gap-2 text-center">
          <div class="rounded-lg bg-elevated/60 px-1 py-2">
            <p class="text-lg font-semibold tabular-nums text-emerald-700">
              {{ run.perfect }}
            </p>
            <p class="text-[11px] text-muted">
              完美
            </p>
          </div>
          <div class="rounded-lg bg-elevated/60 px-1 py-2">
            <p class="text-lg font-semibold tabular-nums text-amber-700">
              {{ run.good }}
            </p>
            <p class="text-[11px] text-muted">
              良好
            </p>
          </div>
          <div class="rounded-lg bg-elevated/60 px-1 py-2">
            <p class="text-lg font-semibold tabular-nums text-red-700">
              {{ run.missed }}
            </p>
            <p class="text-[11px] text-muted">
              漏音
            </p>
          </div>
          <div class="rounded-lg bg-elevated/60 px-1 py-2">
            <p class="text-lg font-semibold tabular-nums text-red-700">
              {{ run.wrong }}
            </p>
            <p class="text-[11px] text-muted">
              错音
            </p>
          </div>
        </div>

        <div class="max-h-[46dvh] overflow-y-auto border-t border-default">
          <div
            v-for="note in run.notes"
            :key="`${note.index}-${note.hand}-${note.label}`"
            class="flex items-center gap-2 border-b border-default py-1.5 text-sm last:border-b-0"
            data-test="score-result-note"
          >
            <span class="w-9 shrink-0 text-right text-xs text-muted tabular-nums">
              {{ note.index + 1 }}
            </span>
            <span
              class="size-1.5 shrink-0 rounded-full"
              :style="{ backgroundColor: handColor(note.hand) }"
            />
            <span class="min-w-0 flex-1 truncate font-medium">
              {{ note.label }}
              <span
                v-if="note.heard && note.heard !== note.label"
                class="ml-1 text-xs font-normal text-muted"
              >听到 {{ note.heard }}</span>
            </span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[11px]"
              :class="outcomeClass(note.outcome)"
            >{{ SCORE_OUTCOME_LABELS[note.outcome] }}</span>
            <span class="w-12 shrink-0 text-right text-xs text-muted tabular-nums">
              {{ formatDeviation(note.deviationMs) }}
            </span>
          </div>
        </div>
      </div>
      <p
        v-else
        class="text-sm text-muted"
      >
        没有可显示的成绩。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          label="关闭"
          data-test="score-result-close"
          @click="emit('update:open', false)"
        />
        <UButton
          icon="i-lucide-rotate-ccw"
          label="再评一次"
          data-test="score-result-retry"
          @click="retry"
        />
      </div>
    </template>
  </UModal>
</template>
