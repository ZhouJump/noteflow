<script setup lang="ts">
import type { HandMode } from '~/lib/audio/score'
import { handColor } from '~/lib/audio/practice'
import { MAX_BPM, MIN_BPM, RHYTHM_PATTERNS, rhythmLabel } from '~/lib/db/settings'

/**
 * 左侧栏：节拍器与声部筛选。
 *
 * 节拍器开关、节奏型、BPM 与拍点指示都留在这里，练习时不用离开乐谱。
 * BPM 与节奏型都用对话框输入，移动端不会被软键盘顶开；声部筛选只在双手谱出现，
 * 左右手各有一个手形图标，激活时用与箭头一致的颜色。
 */
const props = defineProps<{
  bpm: number
  beats: number
  beatType: number
  beat: number
  metronomeOn: boolean
  handMode: HandMode
  /** 曲谱里实际出现过的手序号。 */
  hands: Set<number>
}>()

const emit = defineEmits<{
  toggleMetronome: []
  adjustBpm: [delta: number]
  setBpm: [value: number]
  setRhythm: [beats: number, beatType: number]
  selectHand: [hand: number]
}>()

const dots = computed(() => Math.min(8, Math.max(1, Math.round(props.beats))))
const label = computed(() => rhythmLabel(props.beats, props.beatType))

/**
 * 节拍器图标随拍点摆动：每响一拍左右翻转一次，停下时回到正立。
 *
 * `beat` 只在换拍时变化，4/4、3/4、2/4 都是一拍一次，所以单独翻转状态而
 * 不是取 `beat % 2`——3/4 的第三拍会和第一拍落在同一侧，摆动就不均匀了。
 */
const metronomeFlipped = ref(false)
watch(() => props.beat, () => {
  if (props.metronomeOn) metronomeFlipped.value = !metronomeFlipped.value
})
watch(() => props.metronomeOn, (on) => {
  if (!on) metronomeFlipped.value = false
})

const bpmOpen = ref(false)
const bpmDraft = ref('')
const bpmError = ref<string | null>(null)
const rhythmOpen = ref(false)

const rhythmOptions = computed(() => RHYTHM_PATTERNS.map(pattern => ({
  ...pattern,
  active: pattern.beats === props.beats && pattern.beatType === props.beatType,
  test: `rhythm-option-${pattern.label.replace('/', '-')}`
})))

/** 当前激活的手：`both` 两只都亮，单声部只亮对应的一只；没有音符的手不亮。 */
const activeHands = computed(() => {
  const candidates = props.handMode === 'both' ? [0, 1] : [props.handMode === 'right' ? 0 : 1]
  const visible = candidates.filter(hand => props.hands.has(hand))
  return new Set(visible.length > 0 ? visible : candidates)
})

const handButtons = computed(() => [
  {
    hand: 1,
    label: '左手',
    mirror: true,
    color: handColor(1),
    tint: '#fee2e2',
    disabled: !props.hands.has(1)
  },
  {
    hand: 0,
    label: '右手',
    mirror: false,
    color: handColor(0),
    tint: '#dbeafe',
    disabled: !props.hands.has(0)
  }
])

async function openBpm(): Promise<void> {
  bpmDraft.value = String(Math.round(props.bpm))
  bpmError.value = null
  bpmOpen.value = true
  await nextTick()
  const input = document.querySelector<HTMLInputElement>('[data-test="bpm-input"]')
  input?.focus()
  input?.select()
}

function commitBpm(): void {
  const value = Number.parseInt(bpmDraft.value, 10)
  if (!Number.isFinite(value) || value < MIN_BPM || value > MAX_BPM) {
    bpmError.value = `请输入 ${MIN_BPM}–${MAX_BPM} 之间的数字`
    return
  }
  emit('setBpm', value)
  bpmOpen.value = false
}

function chooseRhythm(beats: number, beatType: number): void {
  emit('setRhythm', beats, beatType)
  rhythmOpen.value = false
}
</script>

<template>
  <aside
    class="sticky top-14 z-10 flex w-12 shrink-0 flex-col items-center gap-1 py-2"
    aria-label="节拍器与声部"
  >
    <RailButton
      icon="i-lucide-metronome"
      label="节拍器"
      :active="metronomeOn"
      :icon-class="metronomeFlipped ? '-scale-x-100' : ''"
      test="metronome-toggle"
      @press="emit('toggleMetronome')"
    />

    <button
      type="button"
      class="w-11 rounded-md border border-default bg-default py-1 text-[13px] font-semibold text-default tabular-nums hover:bg-elevated"
      aria-label="切换节奏型"
      data-test="rhythm-select"
      @click="rhythmOpen = true"
    >
      {{ label }}
    </button>

    <div class="flex w-12 flex-col items-center rounded-lg py-0.5 text-muted">
      <button
        type="button"
        class="grid size-8 place-items-center rounded-md hover:bg-elevated hover:text-default"
        aria-label="加快节拍"
        data-test="bpm-up"
        @click="emit('adjustBpm', 5)"
      >
        <UIcon
          name="i-lucide-chevron-up"
          class="size-5"
        />
      </button>
      <button
        type="button"
        class="flex flex-col items-center rounded-md px-1.5 py-0.5 leading-none hover:bg-elevated"
        aria-label="点击输入 BPM"
        @click="openBpm"
      >
        <span
          class="text-base font-semibold text-default tabular-nums"
          data-test="bpm-value"
        >{{ bpm }}</span>
        <span class="mt-1 text-[9px] text-muted">BPM</span>
      </button>
      <button
        type="button"
        class="grid size-8 place-items-center rounded-md hover:bg-elevated hover:text-default"
        aria-label="减慢节拍"
        data-test="bpm-down"
        @click="emit('adjustBpm', -5)"
      >
        <UIcon
          name="i-lucide-chevron-down"
          class="size-5"
        />
      </button>
    </div>

    <div
      class="flex w-12 flex-nowrap items-center justify-center gap-1 py-1"
      :aria-label="`第 ${beat + 1} / ${dots} 拍`"
    >
      <span
        v-for="index in dots"
        :key="index"
        class="size-2 shrink-0 rounded-full transition-colors"
        :class="metronomeOn && index - 1 === beat ? 'bg-amber-600' : 'bg-elevated'"
        data-test="beat-dot"
      />
    </div>

    <div
      v-if="hands.size >= 2"
      class="flex w-12 flex-col items-center gap-1"
      aria-label="声部筛选"
    >
      <button
        v-for="entry in handButtons"
        :key="entry.hand"
        type="button"
        class="flex w-11 flex-col items-center gap-0.5 rounded-lg px-0.5 py-1.5 text-[10px] leading-none transition-colors disabled:opacity-30"
        :class="activeHands.has(entry.hand)
          ? ''
          : 'text-muted hover:bg-elevated hover:text-default'"
        :style="activeHands.has(entry.hand)
          ? { color: entry.color, backgroundColor: entry.tint }
          : undefined"
        :disabled="entry.disabled"
        :aria-label="entry.label"
        :aria-pressed="activeHands.has(entry.hand) ? 'true' : undefined"
        :data-test="entry.hand === 0 ? 'hand-right' : 'hand-left'"
        @click="emit('selectHand', entry.hand)"
      >
        <UIcon
          name="i-lucide-hand"
          class="size-6"
          :class="entry.mirror ? '-scale-x-100' : ''"
        />
        <span>{{ entry.label }}</span>
      </button>
    </div>

    <UModal v-model:open="bpmOpen">
      <template #header>
        <h2 class="text-base font-semibold">
          输入 BPM
        </h2>
      </template>
      <template #body>
        <div class="grid gap-4">
          <UFormField :label="`每分钟拍数（${MIN_BPM}–${MAX_BPM}）`">
            <UInput
              v-model="bpmDraft"
              class="w-full"
              size="xl"
              inputmode="numeric"
              maxlength="3"
              data-test="bpm-input"
              @keydown.enter.prevent="commitBpm"
            />
          </UFormField>
          <div class="grid grid-cols-4 gap-2">
            <UButton
              v-for="value in [60, 80, 100, 120]"
              :key="value"
              color="neutral"
              variant="outline"
              :label="String(value)"
              data-test="bpm-preset"
              @click="bpmDraft = String(value)"
            />
          </div>
          <p
            v-if="bpmError"
            class="text-sm text-error"
            data-test="bpm-error"
          >
            {{ bpmError }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="取消"
            @click="bpmOpen = false"
          />
          <UButton
            label="保存"
            data-test="bpm-confirm"
            @click="commitBpm"
          />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="rhythmOpen">
      <template #header>
        <h2 class="text-base font-semibold">
          选择节奏型
        </h2>
      </template>
      <template #body>
        <div class="grid gap-2">
          <button
            v-for="pattern in rhythmOptions"
            :key="pattern.label"
            type="button"
            class="flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors"
            :class="pattern.active
              ? 'border-amber-500 bg-amber-50 text-amber-900'
              : 'border-default text-default hover:bg-elevated'"
            :data-test="pattern.test"
            @click="chooseRhythm(pattern.beats, pattern.beatType)"
          >
            <span class="text-lg font-semibold tabular-nums">{{ pattern.label }}</span>
            <UIcon
              v-if="pattern.active"
              name="i-lucide-check"
              class="size-5"
            />
          </button>
        </div>
      </template>
    </UModal>
  </aside>
</template>
