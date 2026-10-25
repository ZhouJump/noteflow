/**
 * The bounding-box classes of HOMR's bounding_boxes.py and the two factories that
 * turn a filtered mask into boxes.
 *
 * A box keeps two rectangles apart, exactly like HOMR does:
 *
 *   - `box` is the *normalised* RotatedRect: the angle is folded into [-45, 45] and
 *     the size is swapped whenever that needs a 90 degree turn. The cheap
 *     "can these two shapes possibly touch" test and every size filter read this.
 *   - `polygon` is the *raw* minAreaRect / fitEllipse result rasterised to integer
 *     corners. The actual overlap test reads this.
 *
 * Both matter: the normalisation happens after the polygon was built, so the polygon
 * is not recoverable from `box`.
 *
 * `BoundingBox` is the axis aligned sibling. It keeps the (x1, y1, x2, y2) rect and
 * builds its polygon from a zero-angle rotated rect, which is what the staff point and
 * clef boxes hand to `is_overlapping`.
 *
 * Verified against HOMR per box: see scripts/check-boxes.mjs.
 */

import type { Point } from '../vision/contours'
import { findContours, pointInPolygon } from '../vision/contours'
import { ellipsePolygonFromRect, fitEllipse } from '../vision/ellipse'
import { boxPoints, boxPointsInt, minAreaRect, type RotatedRect } from '../vision/rect'
import { maxLineGapSize, toleranceForStaffLineDetection } from './constants'

export interface SizeFilter {
  minSize?: [number, number]
  maxSize?: [number, number]
}

/**
 * The part of a box the overlap tests read. HOMR's `is_overlapping` accepts both an
 * `AngledBoundingBox` and a `BoundingBox`, and only touches these three fields.
 */
export interface Overlappable {
  readonly polygon: Point[]
  readonly center: Point
  readonly size: [number, number]
}

export class AngledBoundingBox implements Overlappable {
  readonly contour: Point[]
  readonly debugId: number
  /** Normalised rotated rect. */
  readonly box: RotatedRect
  readonly center: Point
  readonly size: [number, number]
  readonly angle: number
  readonly topLeft: Point
  readonly bottomLeft: Point
  readonly topRight: Point
  readonly bottomRight: Point
  /** Raw polygon, integer corners of the un-normalised rect. */
  readonly polygon: Point[]

  constructor(box: RotatedRect, contour: Point[], polygon: Point[], debugId = 0) {
    this.debugId = debugId
    this.contour = contour
    this.polygon = polygon
    this.box = normaliseAngle(box)
    this.center = this.box.center
    this.size = this.box.size
    this.angle = this.box.angle
    const halfWidth = this.size[0] / 2
    const halfHeight = this.size[1] / 2
    // The four named corners ignore the angle, like calculate_edges_of_rotated_rectangle.
    this.topLeft = { x: this.center.x - halfWidth, y: this.center.y - halfHeight }
    this.bottomLeft = { x: this.center.x - halfWidth, y: this.center.y + halfHeight }
    this.topRight = { x: this.center.x + halfWidth, y: this.center.y - halfHeight }
    this.bottomRight = { x: this.center.x + halfWidth, y: this.center.y + halfHeight }
  }

  /** Does any vertex of either polygon fall inside (or on) the other polygon? */
  isOverlapping(other: Overlappable): boolean {
    if (!this.canShapesPossiblyTouch(other)) return false
    return doPolygonsOverlap(this.polygon, other.polygon)
  }

  isOverlappingWithAny(others: Overlappable[]): boolean {
    return others.some(other => this.isOverlapping(other))
  }

  /**
   * Cheap reject: if the centre distance exceeds the sum of the larger half sizes the
   * two shapes cannot touch.
   */
  canShapesPossiblyTouch(other: Overlappable): boolean {
    const majorAxis1 = Math.max(this.size[0], this.size[1])
    const majorAxis2 = Math.max(other.size[0], other.size[1])
    const distance = Math.hypot(this.center.x - other.center.x, this.center.y - other.center.y)
    return distance <= majorAxis1 + majorAxis2
  }
}

/** HOMR's normalisation: fold the angle and swap the size when a 90 degree turn is needed. */
function normaliseAngle(box: RotatedRect): RotatedRect {
  let angle = box.angle
  if (angle > 135) {
    angle -= 180
    return { center: box.center, size: box.size, angle }
  }
  if (angle < -135) {
    angle += 180
    return { center: box.center, size: box.size, angle }
  }
  if (angle > 45) {
    angle -= 90
    return { center: box.center, size: [box.size[1], box.size[0]], angle }
  }
  if (angle < -45) {
    angle += 90
    return { center: box.center, size: [box.size[1], box.size[0]], angle }
  }
  return { center: box.center, size: box.size, angle }
}

function doPolygonsOverlap(polygon1: Point[], polygon2: Point[]): boolean {
  for (const point of polygon1) {
    if (pointInPolygon(polygon2, point)) return true
  }
  for (const point of polygon2) {
    if (pointInPolygon(polygon1, point)) return true
  }
  return false
}

const f32 = Math.fround

/**
 * cv2's `rotatedRectangleIntersection`, reduced to "is the result not INTERSECT_NONE".
 * Transplanted from OpenCV's modules/imgproc/src/intersection.cpp: the two rects are
 * shifted so their average centre is at the origin (cv2 does this to keep the float32
 * arithmetic well conditioned), then two tests run.
 *
 *   - all 4x4 edge pairs are solved for `t1`, `t2` in [0, 1]; any hit is PARTIAL,
 *   - a vertex of one rect whose four line-sign tests agree lies inside the other rect.
 *
 * Both tests accept a single point, so a shared edge or a shared corner is an
 * intersection. A vertex that lands on the *interior* of the other rect's edge is not:
 * the sign test then splits 3 / 1. That asymmetry is what decides the staff anchors.
 */
function rectanglesIntersect(first: RotatedRect, second: RotatedRect): boolean {
  const width1 = f32(first.size[0])
  const height1 = f32(first.size[1])
  const width2 = f32(second.size[0])
  const height2 = f32(second.size[1])
  // `Size_<float>::empty()` rejects a negative or zero side as well.
  if (width1 <= 0 || height1 <= 0 || width2 <= 0 || height2 <= 0) return false

  // `rotatedRectangleIntersection` moves both centres towards the origin first.
  const center1 = { x: f32(first.center.x), y: f32(first.center.y) }
  const center2 = { x: f32(second.center.x), y: f32(second.center.y) }
  const averageX = f32(f32(center1.x + center2.x) / 2)
  const averageY = f32(f32(center1.y + center2.y) / 2)
  const points1 = boxPoints({
    center: { x: f32(center1.x - averageX), y: f32(center1.y - averageY) },
    size: first.size,
    angle: first.angle
  })
  const points2 = boxPoints({
    center: { x: f32(center2.x - averageX), y: f32(center2.y - averageY) },
    size: second.size,
    angle: second.angle
  })

  // L2 metric, initially derived from the larger rect area.
  let samePointEps = f32(1e-6 * Math.max(f32(width1 * height1), f32(width2 * height2)))

  let same = true
  for (let i = 0; i < 4; i += 1) {
    if (
      Math.abs(f32(points1[i].x - points2[i].x)) > samePointEps
      || Math.abs(f32(points1[i].y - points2[i].y)) > samePointEps
    ) {
      same = false
      break
    }
  }
  if (same) return true

  const vectors1: Point[] = []
  const vectors2: Point[] = []
  for (let i = 0; i < 4; i += 1) {
    const next = (i + 1) % 4
    vectors1.push({
      x: f32(points1[next].x - points1[i].x),
      y: f32(points1[next].y - points1[i].y)
    })
    vectors2.push({
      x: f32(points2[next].x - points2[i].x),
      y: f32(points2[next].y - points2[i].y)
    })
  }

  // The epsilon is capped by the shortest edge of either rect.
  for (let i = 0; i < 4; i += 1) {
    const length1 = f32(Math.sqrt(f32(f32(vectors1[i].x * vectors1[i].x) + f32(vectors1[i].y * vectors1[i].y))))
    const length2 = f32(Math.sqrt(f32(f32(vectors2[i].x * vectors2[i].x) + f32(vectors2[i].y * vectors2[i].y))))
    samePointEps = Math.min(samePointEps, length1, length2)
  }
  // 与 cv2 的 epsilon 计算保持一致；后续的相交判断不再读取该值。
  // eslint-disable-next-line no-useless-assignment
  samePointEps = Math.max(f32(1e-16), samePointEps)

  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      const x21 = f32(points2[j].x - points1[i].x)
      const y21 = f32(points2[j].y - points1[i].y)
      const vx1 = vectors1[i].x
      const vy1 = vectors1[i].y
      const vx2 = vectors2[j].x
      const vy2 = vectors2[j].y

      const det = f32(f32(vx2 * vy1) - f32(vx1 * vy2))
      // cv2 treats |det| < 1e-12 as parallel and skips the pair.
      if (Math.abs(det) < 1e-12) continue
      const detInverse = f32(1 / det)

      const t1 = f32(f32(f32(vx2 * y21) - f32(vy2 * x21)) * detInverse)
      const t2 = f32(f32(f32(vx1 * y21) - f32(vy1 * x21)) * detInverse)
      if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue

      if (t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1) return true
    }
  }

  return (
    hasAllVerticesOnOneSide(points1, points2, vectors2)
    || hasAllVerticesOnOneSide(points2, points1, vectors1)
  )
}

/** cv2's `_isOnPositiveSide(vec, linePoint, point)`. The boundary counts as positive. */
function isOnPositiveSide(lineVector: Point, linePoint: Point, point: Point): boolean {
  return (
    f32(lineVector.y * f32(linePoint.x - point.x))
    >= f32(lineVector.x * f32(linePoint.y - point.y))
  )
}

/** Does any of `points` sit on one side of all four edges of the `polygon`? */
function hasAllVerticesOnOneSide(points: Point[], polygon: Point[], vectors: Point[]): boolean {
  for (const point of points) {
    let positive = 0
    let negative = 0
    for (let j = 0; j < 4; j += 1) {
      if (isOnPositiveSide(vectors[j], polygon[j], point)) positive += 1
      else negative += 1
    }
    if (positive === 4 || negative === 4) return true
  }
  return false
}

export class BoundingBox implements Overlappable {
  /** (x1, y1, x2, y2). */
  readonly box: [number, number, number, number]
  readonly contour: Point[]
  readonly debugId: number
  readonly center: Point
  readonly size: [number, number]
  readonly angle = 0
  readonly polygon: Point[]

  constructor(box: [number, number, number, number], contour: Point[], debugId = 0) {
    this.box = box
    this.contour = contour
    this.debugId = debugId
    this.center = { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 }
    this.size = [box[2] - box[0], box[3] - box[1]]
    this.polygon = boxPointsInt({ center: this.center, size: this.size, angle: 0 })
  }
}

export class RotatedBoundingBox extends AngledBoundingBox {
  constructor(box: RotatedRect, contour: Point[], debugId = 0) {
    super(box, contour, boxPointsInt(box), debugId)
  }

  ensureMinDimension(minWidth: number, minHeight: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: this.box.center,
        size: [Math.max(this.box.size[0], minWidth), Math.max(this.box.size[1], minHeight)],
        angle: this.box.angle
      },
      this.contour,
      this.debugId
    )
  }

  makeBoxThicker(thickness: number): RotatedBoundingBox {
    if (thickness <= 0) return this
    return new RotatedBoundingBox(
      {
        center: this.box.center,
        size: [this.box.size[0] + thickness, this.box.size[1] + thickness],
        angle: this.box.angle
      },
      this.contour,
      this.debugId
    )
  }

  moveToXHorizontalBy(xDelta: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: { x: this.center.x + xDelta, y: this.center.y },
        size: this.box.size,
        angle: this.box.angle
      },
      this.contour,
      this.debugId
    )
  }

  makeBoxTaller(thickness: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: this.box.center,
        size: [this.box.size[0], this.box.size[1] + thickness],
        angle: this.box.angle
      },
      this.contour,
      this.debugId
    )
  }

  makeBoxTallerKeepCenter(thickness: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: { x: this.box.center.x, y: this.box.center.y - Math.trunc(thickness / 2) },
        size: [this.box.size[0], this.box.size[1] + thickness],
        angle: this.box.angle
      },
      this.contour,
      this.debugId
    )
  }

  /** y of the box's centre line at `x`, extrapolating with the box angle. */
  getCenterExtrapolated(x: number): number {
    return (x - this.box.center.x) * Math.tan((this.box.angle / 180) * Math.PI) + this.box.center.y
  }

  isIntersecting(other: RotatedBoundingBox): boolean {
    if (!this.canShapesPossiblyTouch(other)) return false
    return rectanglesIntersect(this.box, other.box)
  }

  /**
   * `is_overlapping` for two staff line fragments that may sit either side of a gap:
   * the gap has to be small and the extrapolated centre lines have to meet.
   */
  isOverlappingExtrapolated(other: RotatedBoundingBox, unitSize: number): boolean {
    const swapped = this.box.center.x > other.box.center.x
    const left = swapped ? other : this
    const right = swapped ? this : other

    const centerX = (left.center.x + right.center.x) * 0.5
    const tolerance = toleranceForStaffLineDetection(unitSize)
    const maxGap = maxLineGapSize(unitSize)

    if (
      centerX - left.center.x - Math.floor(left.size[0] / 2) > maxGap
      || right.center.x - centerX - Math.floor(right.size[0] / 2) > maxGap
    ) {
      return false
    }

    const leftSlope = Math.tan((left.box.angle * Math.PI) / 180)
    const rightSlope = Math.tan((right.box.angle * Math.PI) / 180)
    const leftY = (centerX - left.box.center.x) * leftSlope + left.box.center.y
    const rightY = (centerX - right.box.center.x) * rightSlope + right.box.center.y
    return Math.abs(leftY - rightY) <= tolerance
  }

  /** The axis aligned `BoundingBox` HOMR builds from the two named corners. */
  toBoundingBox(): BoundingBox {
    return new BoundingBox(
      [
        Math.trunc(this.topLeft.x),
        Math.trunc(this.topLeft.y),
        Math.trunc(this.bottomRight.x),
        Math.trunc(this.bottomRight.y)
      ],
      this.contour,
      this.debugId
    )
  }
}

/**
 * Identity of a box for HOMR's `__eq__`/`__hash__`, which compare the normalised
 * (center, size, angle) tuple. Used wherever Python puts boxes in a `set`.
 */
export function boxKey(box: { center: Point, size: [number, number], angle: number }): string {
  return `${box.center.x},${box.center.y}|${box.size[0]},${box.size[1]}|${box.angle}`
}

export class BoundingEllipse extends AngledBoundingBox {
  constructor(box: RotatedRect, contour: Point[], debugId = 0) {
    super(box, contour, ellipsePolygonFromRect(box), debugId)
  }

  makeBoxThicker(thickness: number): BoundingEllipse {
    return new BoundingEllipse(
      {
        center: this.box.center,
        size: [this.box.size[0] + thickness, this.box.size[1] + thickness],
        angle: this.box.angle
      },
      this.contour,
      this.debugId
    )
  }

  makeBoxTaller(thickness: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: this.box.center,
        size: [this.box.size[0], this.box.size[1] + thickness],
        angle: this.box.angle
      },
      this.contour,
      this.debugId
    )
  }
}

function hasValidSize(box: RotatedRect): boolean {
  return (
    !Number.isNaN(box.size[0]) && !Number.isNaN(box.size[1]) && box.size[0] > 0 && box.size[1] > 0
  )
}

export interface RotatedBoxOptions extends SizeFilter {
  skipMerging?: boolean
  thickenBoxes?: number
}

/** create_rotated_bounding_box: one minAreaRect, no size filter and no merging. */
export function createRotatedBoundingBox(contour: Point[], debugId: number): RotatedBoundingBox {
  return new RotatedBoundingBox(minAreaRect(contour), contour, debugId)
}

/**
 * create_rotated_bounding_boxes: minAreaRect of every contour of `binary`, the size
 * filters, then an overlap merge that re-fits each group of touching boxes.
 */
export function createRotatedBoundingBoxes(
  binary: Uint8Array,
  width: number,
  height: number,
  options: RotatedBoxOptions = {}
): RotatedBoundingBox[] {
  let boxes: RotatedBoundingBox[] = []
  findContours(binary, width, height).forEach((contour, index) => {
    const fitBox = minAreaRect(contour)
    if (!hasValidSize(fitBox)) return
    const box = new RotatedBoundingBox(fitBox, contour, index)
    const [boxWidth, boxHeight] = box.size
    if (
      options.minSize
      && (boxWidth < options.minSize[0] || boxHeight < options.minSize[1])
    ) {
      return
    }
    if (options.maxSize) {
      if (options.maxSize[0] > 0 && boxWidth > options.maxSize[0]) return
      if (options.maxSize[1] > 0 && boxHeight > options.maxSize[1]) return
    }
    boxes.push(box)
  })
  if (options.skipMerging) return boxes
  if (options.thickenBoxes !== undefined) {
    boxes = boxes.map(box => box.makeBoxThicker(options.thickenBoxes as number))
  }
  return getBoxForWholeGroup(mergeOverlayingBoundingBoxes(boxes))
}

/**
 * create_bounding_ellipses: same walk, but every contour with at least five points is
 * fitted with fitEllipse, and merged groups are re-fitted with minAreaRect.
 */
export function createBoundingEllipses(
  binary: Uint8Array,
  width: number,
  height: number,
  options: SizeFilter & { skipMerging?: boolean } = {}
): BoundingEllipse[] {
  const boxes: BoundingEllipse[] = []
  findContours(binary, width, height).forEach((contour, index) => {
    if (contour.length < 5) return
    const fitBox = fitEllipse(contour)
    if (!hasValidSize(fitBox)) return
    const box = new BoundingEllipse(fitBox, contour, index)
    if (
      options.minSize
      && (box.size[0] < options.minSize[0] || box.size[1] < options.minSize[1])
    ) {
      return
    }
    if (
      options.maxSize
      && (box.size[0] > options.maxSize[0] || box.size[1] > options.maxSize[1])
    ) {
      return
    }
    boxes.push(box)
  })
  if (options.skipMerging) return boxes
  return getEllipseForWholeGroup(mergeOverlayingBoundingBoxes(boxes))
}

function doGroupsOverlap(group1: AngledBoundingBox[], group2: AngledBoundingBox[]): boolean {
  for (const box1 of group1) {
    for (const box2 of group2) {
      if (box1.isOverlapping(box2)) return true
    }
  }
  return false
}

/** Union-find over the initial one-box groups; the group order follows the boxes. */
class UnionFind {
  private readonly parent: number[]
  private readonly rank: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i)
    this.rank = new Array<number>(size).fill(0)
  }

  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) root = this.parent[root]
    let current = x
    while (this.parent[current] !== root) {
      const next = this.parent[current]
      this.parent[current] = root
      current = next
    }
    return root
  }

  union(x: number, y: number): void {
    const rootX = this.find(x)
    const rootY = this.find(y)
    if (rootX === rootY) return
    if (this.rank[rootX] > this.rank[rootY]) {
      this.parent[rootY] = rootX
    } else if (this.rank[rootX] < this.rank[rootY]) {
      this.parent[rootX] = rootY
    } else {
      this.parent[rootY] = rootX
      this.rank[rootX] += 1
    }
  }
}

export function mergeOverlayingBoundingBoxes(
  boxes: AngledBoundingBox[]
): AngledBoundingBox[][] {
  const count = boxes.length
  const unionFind = new UnionFind(count)
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (doGroupsOverlap([boxes[i]], [boxes[j]])) unionFind.union(i, j)
    }
  }

  // A Map keeps the insertion order of the roots, which is what the dict does.
  const merged = new Map<number, AngledBoundingBox[]>()
  for (let i = 0; i < count; i += 1) {
    const root = unionFind.find(i)
    const group = merged.get(root)
    if (group) group.push(boxes[i])
    else merged.set(root, [boxes[i]])
  }
  return [...merged.values()]
}

function concatenateContours(group: AngledBoundingBox[]): Point[] {
  const points: Point[] = []
  for (const box of group) points.push(...box.contour)
  return points
}

function getBoxForWholeGroup(groups: AngledBoundingBox[][]): RotatedBoundingBox[] {
  return groups.map((group) => {
    const contour = concatenateContours(group)
    return new RotatedBoundingBox(minAreaRect(contour), contour)
  })
}

function getEllipseForWholeGroup(groups: AngledBoundingBox[][]): BoundingEllipse[] {
  return groups.map((group) => {
    const contour = concatenateContours(group)
    return new BoundingEllipse(minAreaRect(contour), contour)
  })
}
