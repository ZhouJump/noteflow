<script setup lang="ts">
import { handColor } from '~/lib/audio/practice'

/**
 * 曲谱页面图：只画当前选中的音符和跟随时每只手的三角箭头。
 *
 * 页面图直接放进 `<img>`，定位与箭头用一层同样大小的 SVG 覆盖；这样多页纵向
 * 排列时不用为每页维护一张全尺寸 canvas，音符锚点也能被自动滚动直接查询。
 */
const props = defineProps<{
  imageUrl: string | null
  page: { width: number, height: number } | null
  /** 每个音符一个定位点；`null` 表示识别阶段没有给出位置。 */
  locations: ({ x: number, y: number } | null)[]
  selectedIndex: number | null
  /** 跟随模式里每只手的当前目标：音符序号与手序号（决定箭头颜色）。 */
  activeTargets: { index: number, hand: number }[]
}>()

const emit = defineEmits<{ select: [index: number] }>()

const selection = computed(() => {
  const index = props.selectedIndex
  if (index === null) return null
  const point = props.locations[index]
  return point === null || point === undefined ? null : point
})

const arrows = computed(() => {
  const list: { x: number, y: number, hand: number }[] = []
  for (const target of props.activeTargets) {
    const point = props.locations[target.index]
    if (point === null || point === undefined) continue
    list.push({ x: point.x, y: point.y, hand: target.hand })
  }
  return list
})

const scale = computed(() => (props.page === null ? 1 : props.page.width / 1200))

function onClick(event: MouseEvent): void {
  const page = props.page
  if (page === null) return
  const element = event.currentTarget as HTMLElement | null
  if (element === null) return
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
  <div
    class="relative bg-white"
    @click="onClick"
  >
    <template v-if="page !== null">
      <img
        v-if="imageUrl !== null"
        :src="imageUrl"
        alt=""
        class="block h-auto w-full select-none"
        data-test="page-image"
        :data-page-width="page.width"
        :data-page-height="page.height"
      >
      <div
        v-else
        class="grid aspect-4/3 place-items-center border border-dashed border-default px-6 text-center text-sm text-muted"
      >
        这一页没有可显示的图片
      </div>

      <svg
        class="pointer-events-none absolute inset-0 size-full"
        :viewBox="`0 0 ${page.width} ${page.height}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <!-- 每个有定位的音符留一个透明锚点，自动滚动按它找位置。 -->
        <template
          v-for="(location, index) in locations"
          :key="`anchor-${index}`"
        >
          <circle
            v-if="location !== null"
            :cx="location.x"
            :cy="location.y"
            r="2"
            fill="transparent"
            :data-note-anchor="index"
          />
        </template>

        <circle
          v-if="selection"
          data-test="selection-ring"
          :cx="selection.x"
          :cy="selection.y"
          :r="14 * scale"
          fill="none"
          stroke="rgba(180, 83, 9, 0.9)"
          :stroke-width="4 * scale"
        />

        <!-- 每只手一个三角箭头，白边保证在谱线和符头上都看得清。 -->
        <path
          v-for="(arrow, index) in arrows"
          :key="`arrow-${index}`"
          data-test="practice-arrow"
          :data-hand="arrow.hand"
          :d="`M ${arrow.x} ${arrow.y - 10 * scale} L ${arrow.x - 10 * scale} ${arrow.y - 28 * scale} L ${arrow.x + 10 * scale} ${arrow.y - 28 * scale} Z`"
          :fill="handColor(arrow.hand)"
          stroke="rgba(255, 255, 255, 0.95)"
          :stroke-width="2 * scale"
          stroke-linejoin="round"
        />
      </svg>
    </template>

    <div
      v-else
      class="grid aspect-4/3 place-items-center border border-dashed border-default px-6 text-center text-sm text-muted"
    >
      这一页没有可显示的图片
    </div>
  </div>
</template>
