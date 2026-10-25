<script setup lang="ts">
import type { AnnotationPoint, AnnotationStroke } from '~/lib/db/schema'

/**
 * 批注覆盖层：铺在页面图或 Verovio 乐谱上，坐标归一化到 0–1。
 *
 * 只在铅笔或橡皮激活时接收指针事件，其余时候完全透明，点音符不会被挡住。
 * 笔画保存为中轴点和千分之一页宽单位的线宽；渲染时生成两端收尖的填充轮廓，
 * 模拟钢笔落笔、收笔。橡皮按真实半径裁掉笔画经过的部分，而不是整条删除。
 */
const props = withDefaults(defineProps<{
  /** 当前页的矢量笔画。 */
  strokes: AnnotationStroke[]
  /** `null` 表示批注工具未激活。 */
  tool: 'pen' | 'eraser' | null
  color?: string
  /** 新笔画的线宽，单位是千分之一页宽。 */
  width?: number
}>(), {
  color: '#111111',
  width: 4
})

const emit = defineEmits<{
  stroke: [stroke: AnnotationStroke]
  replace: [strokes: AnnotationStroke[]]
}>()

/** 橡皮半径（屏幕像素）；换成归一化坐标时按页面宽高分别折算。 */
const ERASER_RADIUS = 16

const host = ref<HTMLElement | null>(null)
const size = ref({ width: 1, height: 1 })
const draft = ref<AnnotationPoint[]>([])
const eraserPoint = ref<AnnotationPoint | null>(null)
/** 橡皮拖动过程中的预览结果；松手后才提交给父组件。 */
const working = ref<AnnotationStroke[] | null>(null)

let observer: ResizeObserver | null = null
let erasing = false
/** 本次橡皮按住后的工作副本：每擦一下都从它减去，多次擦除才能叠加。 */
let eraserWork: AnnotationStroke[] = []
let eraserDirty = false
let lastErase: AnnotationPoint | null = null

const active = computed(() => props.tool !== null)
const displayStrokes = computed(() => working.value ?? props.strokes)

function measure(): void {
  const element = host.value
  if (element === null) return
  const rect = element.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    size.value = { width: rect.width, height: rect.height }
  }
}

function pointFor(event: PointerEvent): AnnotationPoint | null {
  const element = host.value
  if (element === null) return null
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  }
}

function strokeWidth(stroke: AnnotationStroke): number {
  return Math.max(0.6, (stroke.width / 1000) * size.value.width)
}

/** 单点笔画画成一个小圆点，避免收锋后完全消失。 */
function dotPath(point: AnnotationPoint, radius: number): string {
  const x = point.x * size.value.width
  const y = point.y * size.value.height
  return `M ${(x - radius).toFixed(2)} ${y.toFixed(2)}`
    + ` a ${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 0 ${(radius * 2).toFixed(2)} 0`
    + ` a ${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 0 ${(-radius * 2).toFixed(2)} 0 Z`
}

/**
 * 由中轴点生成两侧轮廓：法线方向按距离页宽的比例偏移，首尾把宽度收到 0，
 * 形成自然的笔尖。`fill-rule="nonzero"` 能容忍急转时的自交。
 */
function outline(points: AnnotationPoint[], width: number): string {
  if (points.length === 0 || size.value.width <= 0 || size.value.height <= 0) return ''
  const pixels = points.map(point => ({
    x: point.x * size.value.width,
    y: point.y * size.value.height
  }))
  const half = Math.max(0.3, width / 2)
  if (pixels.length === 1) {
    const only = pixels[0]
    return only === undefined ? '' : dotPath({ x: only.x / size.value.width, y: only.y / size.value.height }, half)
  }

  const distances: number[] = [0]
  let total = 0
  for (let index = 1; index < pixels.length; index += 1) {
    const previous = pixels[index - 1]
    const current = pixels[index]
    if (previous === undefined || current === undefined) continue
    total += Math.hypot(current.x - previous.x, current.y - previous.y)
    distances.push(total)
  }
  const firstPoint = pixels[0]
  if (firstPoint === undefined || total < 0.01) {
    return dotPath({ x: firstPoint?.x ?? 0, y: firstPoint?.y ?? 0 }, half)
  }

  // 收锋长度按笔画长度和粗细共同决定，短笔画不会变成两片尖叶子。
  const taper = Math.min(total * 0.22, Math.max(3, half * 4))
  const halfAt = (distance: number): number => {
    const edge = Math.min(distance, total - distance)
    const ratio = Math.min(1, Math.max(0, edge / taper))
    return half * Math.sin((ratio * Math.PI) / 2) ** 0.65
  }

  const left: { x: number, y: number }[] = []
  const right: { x: number, y: number }[] = []
  for (let index = 0; index < pixels.length; index += 1) {
    const point = pixels[index]
    const previous = pixels[Math.max(0, index - 1)]
    const next = pixels[Math.min(pixels.length - 1, index + 1)]
    if (point === undefined || previous === undefined || next === undefined) continue
    let dx = next.x - previous.x
    let dy = next.y - previous.y
    const length = Math.hypot(dx, dy) || 1
    dx /= length
    dy /= length
    // 法线与行进方向垂直；起笔处宽度为 0，两侧点重合在中轴上。
    const offset = halfAt(distances[index] ?? 0)
    left.push({ x: point.x - dy * offset, y: point.y + dx * offset })
    right.push({ x: point.x + dy * offset, y: point.y - dx * offset })
  }
  if (left.length === 0 || right.length === 0) return ''

  const coordinates = [...left, ...right.reverse()]
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
  return `${coordinates} Z`
}

/** 把归一化点换成页面像素。 */
function toPixels(points: AnnotationPoint[]): { x: number, y: number }[] {
  return points.map(point => ({ x: point.x * size.value.width, y: point.y * size.value.height }))
}

function toPoint(point: { x: number, y: number }): AnnotationPoint {
  return {
    x: Math.min(1, Math.max(0, point.x / size.value.width)),
    y: Math.min(1, Math.max(0, point.y / size.value.height))
  }
}

/**
 * 线段与橡皮圆重叠的参数区间；没有重叠返回 null。
 *
 * 只看顶点会把稀疏笔迹整条漏掉：快速画出的直线只有两端两个点，橡皮从
 * 中间划过时两个点都在圈外，必须按线段与圆求交才能切到笔画。
 */
function circleSpan(
  a: { x: number, y: number },
  b: { x: number, y: number },
  center: { x: number, y: number },
  radius: number
): [number, number] | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq < 1e-6) {
    return Math.hypot(a.x - center.x, a.y - center.y) <= radius ? [0, 1] : null
  }
  const fx = a.x - center.x
  const fy = a.y - center.y
  const bCoef = 2 * (fx * dx + fy * dy)
  const cCoef = fx * fx + fy * fy - radius * radius
  const disc = bCoef * bCoef - 4 * lengthSq * cCoef
  if (disc < 0) return null
  const root = Math.sqrt(disc)
  const start = Math.max(0, (-bCoef - root) / (2 * lengthSq))
  const end = Math.min(1, (-bCoef + root) / (2 * lengthSq))
  return start < end ? [start, end] : null
}

/** 把一条笔画按橡皮范围裁成若干段；返回空数组表示整条被擦掉。 */
function eraseRuns(
  points: AnnotationPoint[],
  center: AnnotationPoint,
  radius: number
): AnnotationPoint[][] {
  const pixels = toPixels(points)
  if (pixels.length === 0) return []
  const centerPx = { x: center.x * size.value.width, y: center.y * size.value.height }
  const runs: AnnotationPoint[][] = []
  let current: { x: number, y: number }[] = []
  const flush = (): void => {
    if (current.length >= 2) runs.push(current.map(toPoint))
    current = []
  }

  const first = pixels[0]
  if (first === undefined) return []
  if (Math.hypot(first.x - centerPx.x, first.y - centerPx.y) > radius) current.push(first)

  for (let index = 1; index < pixels.length; index += 1) {
    const a = pixels[index - 1]
    const b = pixels[index]
    if (a === undefined || b === undefined) continue
    const span = circleSpan(a, b, centerPx, radius)
    if (span === null) {
      current.push(b)
      continue
    }
    const [start, end] = span
    if (start > 0.0001) {
      current.push({ x: a.x + (b.x - a.x) * start, y: a.y + (b.y - a.y) * start })
      flush()
    } else {
      flush()
    }
    if (end < 0.9999) {
      current.push({ x: a.x + (b.x - a.x) * end, y: a.y + (b.y - a.y) * end })
      current.push(b)
    }
  }
  flush()
  return runs
}

/** 从当前工作副本减去一个橡皮圆；多次调用会连续叠加。 */
function eraseAt(target: AnnotationPoint): void {
  const next: AnnotationStroke[] = []
  let changed = false
  for (const stroke of eraserWork) {
    const runs = eraseRuns(stroke.points, target, ERASER_RADIUS)
    if (runs.length === 1 && runs[0]?.length === stroke.points.length) {
      next.push(stroke)
      continue
    }
    changed = true
    for (const run of runs) next.push({ ...stroke, points: run })
  }
  if (!changed) return
  eraserWork = next
  eraserDirty = true
  working.value = next
}

/** 沿拖动路径按半个橡皮直径采样，快速划过也能擦成一条连续的带。 */
function eraseAlong(from: AnnotationPoint | null, to: AnnotationPoint): void {
  if (from === null) {
    eraseAt(to)
    return
  }
  const distance = Math.hypot(
    (to.x - from.x) * size.value.width,
    (to.y - from.y) * size.value.height
  )
  const steps = Math.max(1, Math.ceil(distance / (ERASER_RADIUS / 2)))
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps
    eraseAt({
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio
    })
  }
}

function onPointerDown(event: PointerEvent): void {
  if (props.tool === null) return
  event.preventDefault()
  try {
    host.value?.setPointerCapture(event.pointerId)
  } catch {
    // 合成事件没有活动指针时捕获会失败，后续 pointermove 仍会冒泡到覆盖层。
  }
  if (props.tool === 'eraser') {
    erasing = true
    eraserWork = props.strokes.map(stroke => ({ ...stroke, points: [...stroke.points] }))
    eraserDirty = false
    const target = pointFor(event)
    eraserPoint.value = target
    lastErase = target
    if (target !== null) eraseAt(target)
    return
  }
  const start = pointFor(event)
  if (start !== null) draft.value = [start]
}

function onPointerMove(event: PointerEvent): void {
  if (props.tool === null) return
  if (props.tool === 'eraser') {
    if (erasing) {
      const target = pointFor(event)
      eraserPoint.value = target
      if (target !== null) {
        eraseAlong(lastErase, target)
        lastErase = target
      }
    } else {
      eraserPoint.value = pointFor(event)
    }
    return
  }
  if (!event.buttons) return
  const next = pointFor(event)
  const last = draft.value[draft.value.length - 1]
  if (next === null || last === undefined) return
  if (Math.hypot(next.x - last.x, next.y - last.y) < 0.0015) return
  draft.value = [...draft.value, next]
}

function onPointerUp(): void {
  eraserPoint.value = null
  if (erasing) {
    erasing = false
    if (eraserDirty) emit('replace', eraserWork)
    working.value = null
    eraserWork = []
    eraserDirty = false
    lastErase = null
    return
  }
  if (draft.value.length === 0) return
  emit('stroke', {
    color: props.color,
    width: props.width,
    points: draft.value
  })
  draft.value = []
}

function onPointerLeave(): void {
  if (!erasing) eraserPoint.value = null
}

onMounted(() => {
  measure()
  if (host.value !== null) {
    observer = new ResizeObserver(() => measure())
    observer.observe(host.value)
  }
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    ref="host"
    class="absolute inset-0"
    :class="active ? 'cursor-crosshair touch-none' : 'pointer-events-none'"
    data-test="annotation-layer"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerleave="onPointerLeave"
  >
    <!-- eslint-disable-next-line better-tailwindcss/no-unknown-classes -- SVG 需要撑满容器 -->
    <svg
      class="size-full"
      :viewBox="`0 0 ${size.width} ${size.height}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        v-for="(stroke, index) in displayStrokes"
        :key="index"
        :d="outline(stroke.points, strokeWidth(stroke))"
        :fill="stroke.color"
        stroke="none"
      />
      <path
        v-if="draft.length > 0"
        :d="outline(draft, Math.max(0.6, (width / 1000) * size.width))"
        :fill="color"
        stroke="none"
      />
      <circle
        v-if="tool === 'eraser' && eraserPoint !== null"
        :cx="eraserPoint.x * size.width"
        :cy="eraserPoint.y * size.height"
        :r="ERASER_RADIUS"
        fill="rgba(255,255,255,0.35)"
        stroke="rgba(17,17,17,0.45)"
        stroke-width="1"
        stroke-dasharray="3 2"
      />
    </svg>
  </div>
</template>
