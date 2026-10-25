/**
 * `staff_parsing.py`: cut one staff out of the page and scale it to the 256x1280
 * canvas the transformer reads, carrying the staff grid and its notes through every
 * step so the recognised symbols can be mapped back to page coordinates.
 *
 * The order matters and is the same as HOMR's:
 *
 *   region crop -> scale to at most 256x1280 -> crop with margin -> dewarp ->
 *   crop again -> remove black blobs touching the border -> resize to the canvas
 *
 * Dewarping is not a goal of its own: the M4 demo does not reproduce HOMR's Delaunay
 * mesh, it uses the column shift from `staffDewarping.ts`. That shift was measured
 * against HOMR's canvas (0.6-1.4% of pixels differ, versus 31-58% without any warp),
 * which is what the recognition needs. Pass `{ dewarp: false }` to skip it entirely;
 * `scripts/check-dewarp.mjs` keeps the comparison against HOMR's canvas.
 */

import type { Point } from '../vision/contours'
import { boundingRect, findContours } from '../vision/contours'
import { resizeLinear } from '../vision/resize'
import { blackSpotRemovalThreshold } from './constants'
import type { MultiStaff, Staff } from './model'
import { pyRound } from './numeric'
import {
  dewarpStaffImage,
  identityDewarping,
  type GrayImage,
  type StaffDewarping
} from './staffDewarping'

export const TR_OMR_MAX_HEIGHT = 256
export const TR_OMR_MAX_WIDTH = 1280

/** `StaffRegions`: where the neighbouring systems start, used to clip the region. */
export class StaffRegions {
  private readonly centers: [number, number][] = []

  constructor(staffs: MultiStaff[]) {
    for (const multiStaff of staffs) {
      for (const staff of multiStaff.staffs) this.centers.push([staff.minY, staff.maxY])
    }
  }

  getStartOfClosestStaffAbove(y: number): number {
    const above = this.centers.filter(([minY]) => minY < y).map(([, maxY]) => maxY)
    if (above.length === 0) return 0
    return Math.max(...above)
  }

  getStartOfClosestStaffBelow(y: number): number {
    const below = this.centers.filter(([, maxY]) => maxY > y).map(([minY]) => minY)
    if (below.length === 0) return 1e12
    return Math.min(...below)
  }
}

/**
 * `get_tr_omr_canvas_size`: the largest size with the region's aspect ratio that fits
 * into 1280x256; the caller only ever needs the height to compute the scaling.
 */
export function getTrOmrCanvasSize(
  height: number,
  width: number,
  marginTop = 0,
  marginBottom = 0
): [number, number] {
  const maxHeightWithMargin = TR_OMR_MAX_HEIGHT - marginTop - marginBottom
  const ratio = maxHeightWithMargin / TR_OMR_MAX_WIDTH
  if (height / width > ratio) {
    return [Math.trunc((width / height) * maxHeightWithMargin), maxHeightWithMargin]
  }
  return [TR_OMR_MAX_WIDTH, Math.trunc((height / width) * TR_OMR_MAX_WIDTH)]
}

/** `center_image_on_canvas`: resize to the canvas size and centre it on white. */
export function centerImageOnCanvas(
  image: GrayImage,
  canvasSize: [number, number],
  marginTop = 0,
  marginBottom = 0
): GrayImage {
  const [canvasWidth, canvasHeight] = canvasSize
  const resized = resizeLinear(
    image.data,
    image.width,
    image.height,
    canvasWidth,
    canvasHeight
  )
  const data = new Uint8Array(TR_OMR_MAX_WIDTH * TR_OMR_MAX_HEIGHT).fill(255)
  const yOffset
    = Math.floor((TR_OMR_MAX_HEIGHT - marginTop - marginBottom - canvasHeight) / 2) + marginTop
  for (let row = 0; row < canvasHeight; row += 1) {
    const targetRow = yOffset + row
    if (targetRow < 0 || targetRow >= TR_OMR_MAX_HEIGHT) continue
    data.set(resized.subarray(row * canvasWidth, (row + 1) * canvasWidth), targetRow * TR_OMR_MAX_WIDTH)
  }
  return { data, width: TR_OMR_MAX_WIDTH, height: TR_OMR_MAX_HEIGHT }
}

/**
 * `remove_black_contours_at_edges_of_image`: big black blobs that touch the border are
 * usually neighbouring systems or page furniture caught by the crop. Enclosed dark
 * areas are kept: a filled look is normal inside noteheads and clefs.
 */
export function removeBlackContoursAtEdgesOfImage(image: GrayImage, unitSize: number): GrayImage {
  const { data, width, height } = image
  const binary = new Uint8Array(width * height)
  for (let index = 0; index < data.length; index += 1) {
    binary[index] = data[index] <= 97 ? 1 : 0
  }
  const contours = findContours(binary, width, height)
  const threshold = blackSpotRemovalThreshold(unitSize)
  for (const contour of contours) {
    const rect = boundingRect(contour)
    if (rect.width < threshold || rect.height < threshold) continue
    const touchesBorder
      = rect.x === 0
        || rect.y === 0
        || rect.x + rect.width === width
        || rect.y + rect.height === height
    if (!touchesBorder) continue
    let dark = 0
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      const row = y * width
      for (let x = rect.x; x < rect.x + rect.width; x += 1) dark += binary[row + x]
    }
    // thresh holds 255 for ink, so a mean below 127 means the block is mostly dark.
    if ((dark * 255) / (rect.width * rect.height) < 127) continue
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      const row = y * width
      for (let x = rect.x; x < rect.x + rect.width; x += 1) data[row + x] = 255
    }
  }
  return image
}

/** `_calculate_region`: two units left and right, four above and below the staff. */
export function calculateRegion(
  staff: Staff,
  regions: StaffRegions
): [number, number, number, number] {
  const unit = staff.averageUnitSize
  const xMin = staff.minX - 2 * unit
  const xMax = staff.maxX + 2 * unit
  const yMin = Math.max(staff.minY - 4 * unit, regions.getStartOfClosestStaffAbove(staff.minY))
  const yMax = Math.min(staff.maxY + 4 * unit, regions.getStartOfClosestStaffBelow(staff.maxY))
  return [Math.trunc(xMin), Math.trunc(yMin), Math.trunc(xMax), Math.trunc(yMax)]
}

/** `crop_image_and_return_new_top`: clamp the box to the image and crop. */
export function cropImageAndReturnNewTop(
  image: GrayImage,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { image: GrayImage, topLeft: [number, number] } {
  const left = Math.max(0, Math.min(image.width - 1, Math.trunc(pyRound(Math.min(x1, x2)))))
  const top = Math.max(0, Math.min(image.height - 1, Math.trunc(pyRound(Math.min(y1, y2)))))
  const right = Math.max(0, Math.min(image.width - 1, Math.trunc(pyRound(Math.max(x1, x2)))))
  const bottom = Math.max(0, Math.min(image.height - 1, Math.trunc(pyRound(Math.max(y1, y2)))))
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  const data = new Uint8Array(width * height)
  for (let row = 0; row < height; row += 1) {
    const source = (top + row) * image.width + left
    data.set(image.data.subarray(source, source + width), row * width)
  }
  return { image: { data, width, height }, topLeft: [left, top] }
}

/** `_dewarp_staff`: subtract the crop origin, run the dewarp, then scale. */
function dewarpStaff(
  staff: Staff,
  dewarp: StaffDewarping | null,
  region: [number, number],
  scaling: number
): Staff {
  return staff.transformCoordinates((point) => {
    let x = point.x - region[0]
    let y = point.y - region[1]
    if (dewarp !== null) {
      const moved = dewarp.dewarpPoint({ x, y })
      x = moved.x
      y = moved.y
    }
    return { x: x * scaling, y: y * scaling }
  })
}

/** `_transform_staff_for_canvas` */
function transformStaffForCanvas(
  staff: Staff,
  scalingX: number,
  scalingY: number,
  yOffset: number
): Staff {
  return staff.transformCoordinates(point => ({
    x: point.x * scalingX,
    y: point.y * scalingY + yOffset
  }))
}

/**
 * The point mapping between page coordinates and the canvas the transformer reads.
 * `prepare_staff_image` applies the steps one point at a time; recording them lets a
 * position reported on the canvas be carried back to the page.
 */
export interface StaffCanvasTransform {
  regionTopLeft: [number, number]
  regionScaling: number
  dewarp: StaffDewarping
  cropTopLeft: [number, number]
  canvasScaling: [number, number]
  canvasYOffset: number
}

export function toCanvas(transform: StaffCanvasTransform, point: Point): Point {
  let x = (point.x - transform.regionTopLeft[0]) * transform.regionScaling
  let y = (point.y - transform.regionTopLeft[1]) * transform.regionScaling
  const moved = transform.dewarp.dewarpPoint({
    x: x - transform.cropTopLeft[0],
    y: y - transform.cropTopLeft[1]
  })
  x = moved.x
  y = moved.y
  return {
    x: x * transform.canvasScaling[0],
    y: y * transform.canvasScaling[1] + transform.canvasYOffset
  }
}

const MAX_INVERSE_STEPS = 12
const INVERSE_TOLERANCE = 0.05

/** Invert `toCanvas`; null when no page point maps onto the given canvas point. */
export function toPrediction(transform: StaffCanvasTransform, point: Point): Point | null {
  const scaleX = transform.regionScaling * transform.canvasScaling[0]
  const scaleY = transform.regionScaling * transform.canvasScaling[1]
  if (scaleX <= 0 || scaleY <= 0) return null
  let x
    = (point.x / transform.canvasScaling[0] + transform.cropTopLeft[0])
      / transform.regionScaling
      + transform.regionTopLeft[0]
  let y
    = ((point.y - transform.canvasYOffset) / transform.canvasScaling[1]
      + transform.cropTopLeft[1])
    / transform.regionScaling
    + transform.regionTopLeft[1]
  for (let step = 0; step < MAX_INVERSE_STEPS; step += 1) {
    const mapped = toCanvas(transform, { x, y })
    const residualX = point.x - mapped.x
    const residualY = point.y - mapped.y
    if (Math.abs(residualX) < INVERSE_TOLERANCE && Math.abs(residualY) < INVERSE_TOLERANCE) {
      return { x, y }
    }
    x += residualX / scaleX
    y += residualY / scaleY
  }
  const mapped = toCanvas(transform, { x, y })
  if (Math.abs(point.x - mapped.x) < 1 && Math.abs(point.y - mapped.y) < 1) {
    return { x, y }
  }
  return null
}

export interface PreparedStaff {
  /** The 256x1280 image the transformer reads. */
  canvas: GrayImage
  /** The staff after the region crop and scale, before the crop that precedes dewarp. */
  transformedStaff: Staff
  /** The staff in canvas coordinates. */
  finalStaff: Staff
  transform: StaffCanvasTransform
}

export interface PrepareStaffOptions {
  /** Run the column dewarp; on by default, see the module comment. */
  dewarp?: boolean
}

/**
 * `prepare_staff_image`. `staffImage` is the preprocessed page, not a staff crop:
 * HOMR crops out of the full page so it only needs one resize of the whole image per
 * staff.
 */
export function prepareStaffImage(
  index: number,
  staff: Staff,
  staffImage: GrayImage,
  regions: StaffRegions,
  options: PrepareStaffOptions = {}
): PreparedStaff {
  // HOMR uses the index for debug image names only.
  void index
  const region = calculateRegion(staff, regions)
  const imageDimensions = getTrOmrCanvasSize(
    Math.trunc(region[3] - region[1]),
    Math.trunc(region[2] - region[0])
  )
  const scalingFactor = imageDimensions[1] / (region[3] - region[1])

  const scaledWidth = Math.trunc(staffImage.width * scalingFactor)
  const scaledHeight = Math.trunc(staffImage.height * scalingFactor)
  let image: GrayImage = {
    data: resizeLinear(staffImage.data, staffImage.width, staffImage.height, scaledWidth, scaledHeight),
    width: scaledWidth,
    height: scaledHeight
  }

  const scaledRegion = region.map(value => pyRound(value * scalingFactor))
  const withMargin = [
    scaledRegion[0] - 10,
    scaledRegion[1] - 50,
    scaledRegion[2] + 10,
    scaledRegion[3] + 50
  ]
  const firstCrop = cropImageAndReturnNewTop(image, withMargin[0], withMargin[1], withMargin[2], withMargin[3])
  image = firstCrop.image
  const secondCropBox = [
    scaledRegion[0] - firstCrop.topLeft[0],
    scaledRegion[1] - firstCrop.topLeft[1],
    scaledRegion[2] - firstCrop.topLeft[0],
    scaledRegion[3] - firstCrop.topLeft[1]
  ]
  const regionTopLeft: [number, number] = [
    firstCrop.topLeft[0] / scalingFactor,
    firstCrop.topLeft[1] / scalingFactor
  ]
  const regionScaling = scalingFactor

  const transformed = dewarpStaff(staff, null, regionTopLeft, scalingFactor)
  const dewarp
    = options.dewarp === false ? identityDewarping : dewarpStaffImage(image, transformed)
  image = dewarp.dewarp(image)

  const secondCrop = cropImageAndReturnNewTop(
    image,
    secondCropBox[0],
    secondCropBox[1],
    secondCropBox[2],
    secondCropBox[3]
  )
  image = secondCrop.image
  const cropTopLeft: [number, number] = [secondCrop.topLeft[0], secondCrop.topLeft[1]]

  image = removeBlackContoursAtEdgesOfImage(image, transformed.averageUnitSize)

  const canvasScaling: [number, number] = [
    imageDimensions[0] / image.width,
    imageDimensions[1] / image.height
  ]
  const canvasYOffset = Math.floor((TR_OMR_MAX_HEIGHT - imageDimensions[1]) / 2)
  const dewarped = dewarpStaff(transformed, dewarp, cropTopLeft, 1)
  const finalStaff = transformStaffForCanvas(
    dewarped,
    canvasScaling[0],
    canvasScaling[1],
    canvasYOffset
  )
  const canvas = centerImageOnCanvas(image, imageDimensions)

  return {
    canvas,
    transformedStaff: transformed,
    finalStaff,
    transform: {
      regionTopLeft,
      regionScaling,
      dewarp,
      cropTopLeft,
      canvasScaling,
      canvasYOffset
    }
  }
}
