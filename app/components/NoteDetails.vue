<script setup lang="ts">
import { formatPitch, type MusicXmlNote } from '~/lib/musicxml/document'

/**
 * 手机底部的音符卡片：音高、时值、小节，够用即可。
 *
 * 识别结果只读；识别符号、坐标、声部等细节不在界面上出现。
 */
const props = defineProps<{
  index: number
  total: number
  note: MusicXmlNote
  /** 多页曲谱里当前音符所在页，例如“第 2 页”。 */
  pageLabel?: string
}>()

const emit = defineEmits<{ close: [] }>()

const TYPE_LABELS: Record<string, string> = {
  'breve': '二全',
  'whole': '全',
  'half': '二分',
  'quarter': '四分',
  'eighth': '八分',
  '16th': '十六分',
  '32nd': '三十二分',
  '64th': '六十四分',
  '128th': '一百二十八分'
}

const pitchLabel = computed(() => (props.note.isRest ? '休止符' : formatPitch(props.note.pitch)))
const typeLabel = computed(() => {
  const type = props.note.type
  if (type === null) return '时值未知'
  return `${TYPE_LABELS[type] ?? type}音符${props.note.dots > 0 ? `（${props.note.dots} 个附点）` : ''}`
})
</script>

<template>
  <section
    class="flex items-center gap-3 px-4 py-3"
    data-test="note-inspector"
  >
    <div class="min-w-0 flex-1">
      <p
        class="truncate text-xl font-semibold tracking-tight"
        data-test="note-summary"
      >
        {{ pitchLabel }}
      </p>
      <p
        class="mt-0.5 truncate text-sm text-muted"
        data-test="note-duration"
      >
        {{ typeLabel }} · 第 {{ note.measureNumber }} 小节
        <template v-if="pageLabel">
          · {{ pageLabel }}
        </template>
      </p>
    </div>
    <span
      class="shrink-0 text-xs text-muted tabular-nums"
      data-test="note-number"
    >第 {{ index + 1 }} / {{ total }} 音</span>
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="sm"
      aria-label="关闭音符信息"
      @click="emit('close')"
    />
  </section>
</template>
