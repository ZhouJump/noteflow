<script setup lang="ts">
import type { PracticeSnapshot } from '~/composables/usePractice'

/**
 * 底部跟弹面板：当前音、进度、麦克风状态，以及完成后的“从头再来 / 下一页”。
 *
 * 面板只在练习时占住底部；结束后回到音符卡片。所有状态都来自 `usePractice`，
 * 这里不碰音频，也不推断匹配结果。
 */
const props = defineProps<{
  snapshot: PracticeSnapshot | null
  hasNextPage: boolean
}>()

const emit = defineEmits<{ stop: [], restart: [], retry: [], next: [] }>()

const currentLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return ''
  if (snapshot.phase === 'done') return '完成'
  return snapshot.current?.label ?? '—'
})

const progressLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return '跟弹练习'
  if (snapshot.phase === 'done') return `跟弹练习 · ${snapshot.total} 音完成`
  if (snapshot.total === 0) return '跟弹练习'
  return `跟弹练习 · 第 ${snapshot.position + 1} / ${snapshot.total} 音`
})

const statusLabel = computed(() => {
  const snapshot = props.snapshot
  if (snapshot === null) return ''
  if (snapshot.phase === 'error') return '麦克风不可用'
  if (snapshot.phase === 'starting') return '正在打开麦克风'
  if (snapshot.phase === 'done') return '这一页弹完了'
  if (snapshot.stale) return '没听到匹配的音符，可以点音符换位置'
  if (snapshot.outcome === 'unmatched') return '没听清，继续'
  if (snapshot.outcome === 'octave') return '疑似高了或低了八度'
  if (snapshot.outcome === 'skipped') return '跳过了前面的音'
  if (snapshot.outcome === 'matched') {
    return snapshot.heard === null ? '请弹这个音' : `听到 ${snapshot.heard}`
  }
  if (snapshot.outcome === 'quiet') return '正在听…'
  return '请弹这个音'
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
  >
    <div class="mx-auto max-w-2xl px-4 py-3">
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <p
            class="truncate text-xs text-muted tabular-nums"
            data-test="practice-progress"
          >
            {{ progressLabel }}
          </p>
          <p class="mt-0.5 flex items-baseline gap-2">
            <span
              class="truncate text-xl font-semibold tracking-tight"
              data-test="practice-current"
            >{{ currentLabel }}</span>
            <span
              class="truncate text-sm text-muted"
              data-test="practice-status"
            >{{ statusLabel }}</span>
          </p>
        </div>

        <template v-if="snapshot?.phase === 'done'">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            label="从头再来"
            data-test="practice-restart"
            @click="emit('restart')"
          />
          <UButton
            v-if="hasNextPage"
            size="sm"
            label="下一页"
            data-test="practice-next"
            @click="emit('next')"
          />
        </template>
        <UButton
          v-else-if="snapshot?.phase === 'error'"
          size="sm"
          label="重试"
          data-test="practice-retry"
          @click="emit('retry')"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="结束跟弹练习"
          data-test="practice-stop"
          @click="emit('stop')"
        />
      </div>

      <p
        v-if="snapshot?.phase === 'error'"
        class="mt-2 text-sm text-error"
        data-test="practice-error"
      >
        {{ snapshot.error }}
      </p>
      <div
        v-else
        class="mt-2"
      >
        <div
          class="h-1 bg-elevated"
          role="progressbar"
          :aria-valuemin="0"
          :aria-valuemax="snapshot?.total ?? 0"
          :aria-valuenow="snapshot?.position ?? 0"
          aria-label="跟弹进度"
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
