<script setup lang="ts">
import { handColor } from '~/lib/audio/practice'
import { NOTE_ID_PREFIX } from '~/lib/musicxml/display'
import { renderMusicXml, type RenderedScore } from '~/lib/verovio'

/**
 * Verovio 渲染出的乐谱。渲染副本里的每个音符带 `nf-<序号>` id，点击元素即可把
 * 选择回传给页面；选中的音符只改填充色，不移动任何元素。跟随时每只手在目标
 * 音符上方画一个三角箭头（不同颜色），并把它滚到屏幕中间。
 */
const props = defineProps<{
  xml: string
  selectedIndex: number | null
  /** 跟随时每只手的当前目标：音符序号与手序号（决定箭头颜色）。 */
  currentTargets: { index: number, hand: number }[]
}>()

const emit = defineEmits<{ select: [index: number] }>()

const surface = ref<HTMLElement | null>(null)
const rendered = shallowRef<RenderedScore | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

let token = 0
let timer: ReturnType<typeof setTimeout> | null = null
/** 上一次滚到的目标组合，避免每次 paint 都重复滚动。 */
let followed: string | null = null
let observer: ResizeObserver | null = null

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
    // 排版器的原始异常多为英文技术信息，留给控制台。
    console.error('乐谱排版失败', exception)
    error.value = '这份乐谱暂时无法显示'
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

/** 选中只加 class；跟随目标改用三角箭头，不再改音符填充色。 */
function paint(): void {
  const host = surface.value
  if (host === null) return
  for (const element of host.querySelectorAll('.nf-selected')) {
    element.classList.remove('nf-selected')
  }
  host.querySelectorAll('.nf-arrow').forEach(element => element.remove())

  if (props.selectedIndex !== null) {
    const id = CSS.escape(`${NOTE_ID_PREFIX}${props.selectedIndex}`)
    host.querySelectorAll(`[id="${id}"]`).forEach(element => element.classList.add('nf-selected'))
  }

  const targets = props.currentTargets
  if (targets.length === 0) {
    followed = null
    return
  }

  const hostRect = host.getBoundingClientRect()
  let first: Element | null = null
  for (const target of targets) {
    const id = CSS.escape(`${NOTE_ID_PREFIX}${target.index}`)
    const element = host.querySelector(`[id="${id}"]`)
    if (element === null) continue
    first ??= element
    const rect = element.getBoundingClientRect()
    const arrow = document.createElement('span')
    arrow.className = 'nf-arrow'
    arrow.dataset.test = 'practice-arrow'
    arrow.dataset.hand = String(target.hand)
    arrow.style.background = handColor(target.hand)
    arrow.style.left = `${rect.left - hostRect.left + rect.width / 2}px`
    // 容器顶部给箭头留出空间，避免高音谱号第一行被裁掉。
    arrow.style.top = `${Math.max(16, rect.top - hostRect.top - 3)}px`
    host.append(arrow)
  }

  if (first === null) return
  const key = targets.map(target => `${target.index}:${target.hand}`).join(',')
  if (followed === key) return
  followed = key
  first.scrollIntoView({ block: 'center', behavior: 'smooth' })
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
watch(() => props.currentTargets, () => paint(), { deep: true })
onMounted(() => {
  void render()
  window.addEventListener('resize', paint)
  if (surface.value !== null) {
    observer = new ResizeObserver(() => paint())
    observer.observe(surface.value)
  }
})
onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  window.removeEventListener('resize', paint)
  observer?.disconnect()
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
      description="可以导出 MusicXML 后用其他软件打开，或重新导入这份文件。"
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

.nf-score {
  position: relative;
}

.nf-score :deep(g.note) {
  cursor: pointer;
}

.nf-score :deep(.nf-selected) {
  fill: #b45309;
}

.nf-score :deep(.nf-arrow) {
  position: absolute;
  z-index: 2;
  width: 16px;
  height: 15px;
  transform: translate(-50%, -100%);
  clip-path: polygon(50% 100%, 0 0, 100% 0);
  filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.95));
  pointer-events: none;
}
</style>
