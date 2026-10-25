<script setup lang="ts">
import type { PracticePhase } from '~/composables/usePractice'
import type { ScoringPhase } from '~/lib/audio/scoring'

/**
 * 右侧栏：当前模式（跟随或评分）的开始、暂停、停止，以及批注工具。
 *
 * 模式由曲谱顶部的 tab 选择，这里不再区分跟随/评分入口：一个播放/暂停
 * 切换按钮操作当前模式，旁边是停止/重来。开始只负责启动，暂停后再点同一个
 * 按钮从暂停处接着走。画笔、橡皮、撤销、清空只操作当前曲谱的批注。
 */
const props = defineProps<{
  mode: 'practice' | 'score'
  practicePhase: PracticePhase
  scorePhase: ScoringPhase
  canStart: boolean
  tool: 'pen' | 'eraser' | null
  canUndo: boolean
  hasAnnotations: boolean
}>()

const emit = defineEmits<{
  toggle: []
  stop: []
  restart: []
  pen: []
  eraser: []
  undo: []
  clear: []
}>()

const practiceActive = computed(() => (
  props.practicePhase === 'starting'
  || props.practicePhase === 'listening'
  || props.practicePhase === 'paused'
))
const scoreActive = computed(() => (
  props.scorePhase === 'waiting'
  || props.scorePhase === 'running'
  || props.scorePhase === 'paused'
))
const active = computed(() => (props.mode === 'practice' ? practiceActive.value : scoreActive.value))

const playing = computed(() => (
  props.mode === 'practice'
    ? props.practicePhase === 'listening'
    : props.scorePhase === 'waiting' || props.scorePhase === 'running'
))

const paused = computed(() => (
  props.mode === 'practice'
    ? props.practicePhase === 'paused'
    : props.scorePhase === 'paused'
))

const canToggle = computed(() => {
  if (!props.canStart) return false
  if (props.mode === 'practice') {
    return props.practicePhase === 'idle'
      || props.practicePhase === 'listening'
      || props.practicePhase === 'paused'
      || props.practicePhase === 'error'
  }
  return props.scorePhase === 'idle'
    || props.scorePhase === 'waiting'
    || props.scorePhase === 'running'
    || props.scorePhase === 'paused'
    || props.scorePhase === 'error'
})

const toggleIcon = computed(() => (playing.value ? 'i-lucide-pause' : 'i-lucide-play'))

const toggleLabel = computed(() => {
  if (paused.value) return '继续'
  if (playing.value) return '暂停'
  const failed = props.mode === 'practice'
    ? props.practicePhase === 'error'
    : props.scorePhase === 'error'
  return failed ? '重试' : '开始'
})

const finished = computed(() => (
  props.mode === 'practice'
    ? props.practicePhase === 'done' || props.practicePhase === 'error'
    : props.scorePhase === 'finished' || props.scorePhase === 'error'
))

const canStop = computed(() => active.value || finished.value)

const stopIcon = computed(() => (finished.value ? 'i-lucide-rotate-ccw' : 'i-lucide-square'))
const stopLabel = computed(() => (finished.value ? '重来' : '停止'))

function onStop(): void {
  if (finished.value) emit('restart')
  else emit('stop')
}
</script>

<template>
  <aside
    class="sticky top-14 z-10 flex w-12 shrink-0 flex-col items-center gap-1 py-2"
    aria-label="演奏控制与批注"
  >
    <RailButton
      :icon="toggleIcon"
      :label="toggleLabel"
      :disabled="!canToggle"
      test="transport-toggle"
      @press="emit('toggle')"
    />
    <RailButton
      :icon="stopIcon"
      :label="stopLabel"
      :disabled="!canStop"
      test="transport-stop"
      @press="onStop"
    />

    <div class="my-1 h-px w-7 bg-default" />

    <RailButton
      icon="i-lucide-pencil"
      label="画笔"
      :active="tool === 'pen'"
      test="pen-toggle"
      @press="emit('pen')"
    />
    <RailButton
      icon="i-lucide-eraser"
      label="橡皮"
      :active="tool === 'eraser'"
      test="eraser-toggle"
      @press="emit('eraser')"
    />
    <RailButton
      icon="i-lucide-undo-2"
      label="撤销"
      :disabled="!canUndo"
      test="undo-annotation"
      @press="emit('undo')"
    />
    <RailButton
      icon="i-lucide-trash-2"
      label="清空"
      :disabled="!hasAnnotations"
      test="clear-annotations"
      @press="emit('clear')"
    />
  </aside>
</template>
