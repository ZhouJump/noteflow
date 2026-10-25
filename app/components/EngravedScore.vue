<script setup lang="ts">
import { NOTE_ID_PREFIX } from '~/lib/musicxml/display'
import { renderMusicXml, type RenderedScore } from '~/lib/verovio'

/**
 * Verovio 渲染出的乐谱。渲染副本里的每个音符带 `nf-<序号>` id，点击元素即可把
 * 选择回传给页面；选中的音符只改填充色，不移动任何元素。跟弹时当前目标用同样
 * 的颜色高亮，并把它滚到屏幕中间。
 */
const props = defineProps<{
  xml: string
  selectedIndex: number | null
  /** 跟弹模式里的下一个目标；`null` 表示没有在练习。 */
  currentIndex: number | null
}>()

const emit = defineEmits<{ select: [index: number] }>()

const surface = ref<HTMLElement | null>(null)
const rendered = shallowRef<RenderedScore | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

let token = 0
let timer: ReturnType<typeof setTimeout> | null = null
/** 上一次滚到的目标，避免每次 paint 都重复滚动。 */
let followed: number | null = null

async function render(): Promise<void> {
  const current = ++token
  loading.value = true
  error.value = null
  try {
    const output = await renderMusicXml(props.xml)
    if (current !== token) return
    rendered.value = output
    await nextTick()
    paint()
  } catch (exception) {
    if (current !== token) return
    rendered.value = null
    error.value = `无法排版这份乐谱：${(exception as Error).message}`
  } finally {
    if (current === token) loading.value = false
  }
}

/** 拖动滑块或改音高时连续变化，等安静下来再排版。 */
function scheduleRender(): void {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void render()
  }, 220)
}

/** 选中与跟弹目标只加 class，避免整页重排。 */
function paint(): void {
  const host = surface.value
  if (host === null) return
  for (const element of host.querySelectorAll('.nf-selected, .nf-playing')) {
    element.classList.remove('nf-selected', 'nf-playing')
  }

  if (props.selectedIndex !== null) {
    const id = CSS.escape(`${NOTE_ID_PREFIX}${props.selectedIndex}`)
    host.querySelectorAll(`[id="${id}"]`).forEach(element => element.classList.add('nf-selected'))
  }

  const current = props.currentIndex
  if (current === null) {
    followed = null
    return
  }
  const id = CSS.escape(`${NOTE_ID_PREFIX}${current}`)
  const element = host.querySelector(`[id="${id}"]`)
  if (element === null) return
  element.classList.add('nf-playing')
  if (followed === current) return
  followed = current
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function onClick(event: MouseEvent): void {
  const target = event.target as Element | null
  const element = target?.closest(`[id^="${NOTE_ID_PREFIX}"]`)
  if (element === null || element === undefined) return
  const index = Number(element.id.slice(NOTE_ID_PREFIX.length))
  if (Number.isInteger(index) && index >= 0) emit('select', index)
}

watch(() => props.xml, () => scheduleRender())
watch(() => props.selectedIndex, () => paint())
watch(() => props.currentIndex, () => paint())
onMounted(() => void render())
onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
})
</script>

<template>
  <div class="relative">
    <div
      v-if="loading"
      class="flex items-center gap-2 px-2 py-3 text-xs text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      正在排版乐谱
    </div>

    <UAlert
      v-if="error"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="error"
      description="可以切换到页面图查看，或导出 MusicXML 后用其他软件打开。"
    />

    <!-- eslint-disable better-tailwindcss/no-unknown-classes, vue/no-v-html -- 组件内 scoped 样式；SVG 来自本地 Verovio -->
    <div
      ref="surface"
      class="nf-score bg-white"
      data-test="score-surface"
      @click="onClick"
      v-html="rendered?.svg ?? ''"
    />
    <!-- eslint-enable better-tailwindcss/no-unknown-classes, vue/no-v-html -->
  </div>
</template>

<style scoped>
.nf-score :deep(svg) {
  display: block;
  margin: 0 auto;
  max-width: 100%;
  height: auto;
}

.nf-score :deep(g.note) {
  cursor: pointer;
}

.nf-score :deep(.nf-selected),
.nf-score :deep(.nf-playing) {
  fill: #b45309;
}
</style>
