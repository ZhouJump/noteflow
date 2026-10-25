<script setup lang="ts">
import { SCORE_OUTCOME_LABELS, type ScoreOutcome, type ScoreSnapshot } from '~/lib/audio/scoring'

/**
 * 底部评分状态条：当前音、准确度与逐音反馈。
 *
 * 开始/暂停/结束都在右侧栏；这里只读展示，不占用手势。
 */
const props = defineProps<{
  snapshot: ScoreSnapshot | null
}>()

const currentLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return ''
  if (snapshot.phase === 'waiting') return '等待首音'
  if (snapshot.phase === 'finished') return '完成'
  return snapshot.current?.label ?? '—'
})

const progressLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return '评分'
  if (snapshot.phase === 'finished') return '评分完成'
  if (snapshot.total === 0) return '评分'
  return `第 ${Math.min(snapshot.judged + 1, snapshot.total)} / ${snapshot.total} 音`
})

const statusLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return ''
  if (snapshot.phase === 'error') return '麦克风不可用'
  if (snapshot.phase === 'waiting') return '演奏当前音开始计时'
  if (snapshot.phase === 'paused') return '已暂停'
  if (snapshot.phase === 'finished') return '这份曲谱评分完成'
  const last = snapshot.last
  if (last === null) return '请演奏这个音'
  const label = SCORE_OUTCOME_LABELS[last.outcome]
  if (last.outcome === 'missed') return `${label}，继续往下`
  if (last.deviationMs === null) return label
  const deviation = last.deviationMs > 0 ? `+${last.deviationMs}` : `${last.deviationMs}`
  return `${label} ${deviation}ms`
})

const percent = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null || snapshot.total === 0) return 0
  return Math.round((snapshot.judged / snapshot.total) * 100)
})

const lastTone = computed<ScoreOutcome | null>(() => props.snapshot?.last?.outcome ?? null)

const toneClass = computed(() => {
  if (lastTone.value === 'perfect' || lastTone.value === 'good') return 'text-emerald-700'
  if (lastTone.value === 'wrong' || lastTone.value === 'missed') return 'text-error'
  if (lastTone.value === null) return 'text-muted'
  return 'text-amber-700'
})
</script>

<template>
  <section
    class="border-t border-default bg-default/95 backdrop-blur"
    data-test="score-panel"
    :data-phase="snapshot?.phase ?? 'idle'"
  >
    <div class="mx-auto max-w-3xl px-3 py-2">
      <div class="flex items-baseline gap-2">
        <span
          class="truncate text-lg font-semibold tracking-tight"
          data-test="score-current"
        >{{ currentLabel }}</span>
        <span
          class="min-w-0 flex-1 truncate text-xs"
          :class="toneClass"
          data-test="score-status"
        >{{ statusLabel }}</span>
        <span
          class="shrink-0 text-xs text-muted tabular-nums"
          data-test="score-progress"
        >{{ progressLabel }}</span>
      </div>

      <p
        v-if="snapshot?.phase === 'error'"
        class="mt-1 text-sm text-error"
        data-test="score-error"
      >
        {{ snapshot.error }}
      </p>
      <div
        v-else
        class="mt-1.5 flex items-center gap-3"
      >
        <div
          class="h-1 flex-1 bg-elevated"
          role="progressbar"
          :aria-valuemin="0"
          :aria-valuemax="snapshot?.total ?? 0"
          :aria-valuenow="snapshot?.judged ?? 0"
          aria-label="评分进度"
        >
          <div
            class="h-full bg-emerald-700 transition-[width] duration-300"
            :style="{ width: `${percent}%` }"
          />
        </div>
        <span
          class="shrink-0 text-sm font-semibold tabular-nums"
          data-test="score-accuracy"
        >{{ snapshot?.accuracy ?? 0 }}<span class="ml-0.5 text-[10px] font-normal text-muted">分</span></span>
      </div>
    </div>
  </section>
</template>
