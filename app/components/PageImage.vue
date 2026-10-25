<script setup lang="ts">
/**
 * 曲谱页面图：显示处理后的一页，点按页面选中最近的识别音符。
 *
 * 只画当前选中的音符和跟弹时的目标箭头，不铺识别点或谱表轮廓；这些信息对
 * 手机阅读没有帮助。
 */
const props = defineProps<{
  imageUrl: string | null
  page: { width: number, height: number } | null
  /** 每个音符一个定位点；`null` 表示识别阶段没有给出位置。 */
  locations: ({ x: number, y: number } | null)[]
  selectedIndex: number | null
  /** 跟弹模式里下一个要弹的音符；`null` 表示没有在练习。 */
  activeIndex: number | null
}>()

const emit = defineEmits<{ select: [index: number] }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const image = shallowRef<HTMLImageElement | null>(null)

function draw(): void {
  const element = canvas.value
  const page = props.page
  if (element === null || page === null) return
  element.width = page.width
  element.height = page.height
  const context = element.getContext('2d')
  if (context === null) return

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, page.width, page.height)
  const bitmap = image.value
  if (bitmap !== null) context.drawImage(bitmap, 0, 0, page.width, page.height)

  const location = props.selectedIndex === null ? null : props.locations[props.selectedIndex]
  const scale = page.width / 1200
  if (location !== null && location !== undefined) {
    context.beginPath()
    context.arc(location.x, location.y, 14 * scale, 0, 2 * Math.PI)
    context.lineWidth = 4 * scale
    context.strokeStyle = 'rgba(180, 83, 9, 0.9)'
    context.stroke()
    context.beginPath()
    context.arc(location.x, location.y, 3 * scale, 0, 2 * Math.PI)
    context.fillStyle = 'rgba(180, 83, 9, 0.9)'
    context.fill()
  }

  const active = props.activeIndex === null ? null : props.locations[props.activeIndex]
  if (active === null || active === undefined) return
  // 目标音上方的小三角，和选中圈的用途分开。
  context.beginPath()
  context.moveTo(active.x, active.y - 18 * scale)
  context.lineTo(active.x - 9 * scale, active.y - 34 * scale)
  context.lineTo(active.x + 9 * scale, active.y - 34 * scale)
  context.closePath()
  context.fillStyle = 'rgba(180, 83, 9, 0.95)'
  context.fill()
}

watch(
  [() => props.page, () => props.locations, () => props.selectedIndex, () => props.activeIndex],
  () => draw(),
  { deep: true, flush: 'post' }
)

watch(
  () => props.imageUrl,
  (url) => {
    if (url === null) {
      image.value = null
      draw()
      return
    }
    const bitmap = new Image()
    bitmap.onload = () => {
      image.value = bitmap
      draw()
    }
    bitmap.onerror = () => {
      image.value = null
      draw()
    }
    bitmap.src = url
  },
  { immediate: true }
)

onMounted(draw)
onBeforeUnmount(() => {
  const bitmap = image.value
  if (bitmap !== null) bitmap.src = ''
  image.value = null
})

function onClick(event: MouseEvent): void {
  const element = canvas.value
  const page = props.page
  if (element === null || page === null) return
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  const pointX = ((event.clientX - rect.left) / rect.width) * page.width
  const pointY = ((event.clientY - rect.top) / rect.height) * page.height
  // 点击容差按显示尺寸给 24px，换算成页面像素。
  const tolerance = (24 / rect.width) * page.width
  let bestIndex = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [index, location] of props.locations.entries()) {
    if (location === null) continue
    const distance = Math.hypot(location.x - pointX, location.y - pointY)
    if (distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  }
  if (bestIndex >= 0 && bestDistance <= tolerance) emit('select', bestIndex)
}
</script>

<template>
  <div class="bg-white">
    <canvas
      v-if="page !== null"
      ref="canvas"
      class="block h-auto w-full cursor-pointer select-none"
      data-test="page-image"
      @click="onClick"
    />
    <div
      v-else
      class="grid aspect-4/3 place-items-center border border-dashed border-default px-6 text-center text-sm text-muted"
    >
      这一页没有可显示的图片
    </div>
  </div>
</template>
