/**
 * Ellipse fitting and rasterisation: cv2.fitEllipse / cv2.ellipse2Poly.
 *
 * cv2.fitEllipse is not the Fitzgibbon direct fit; for more than five points it runs
 * Daniel Weiss' two-stage fit (a conic through `-Ax^2 - By^2 - Cxy + Dx + Ey = 1`,
 * then the centre, then a re-fit of A-C around that centre). This is a line-by-line
 * port of `fitEllipseNoDirect` in OpenCV's shapedescr.cpp, including its float
 * arithmetic on the centroid and its default angle of 0 when width <= height.
 *
 * One path is not ported: OpenCV retries with random sub-pixel jitter when the design
 * matrix is rank deficient. It needs OpenCV's RNG state to reproduce, and the fit is
 * meaningless in that case anyway.
 *
 * Verified against cv2 per contour: see scripts/check-primitives.mjs.
 */

import type { Point } from './contours'
import type { RotatedRect } from './rect'
import { leastSquares, solve2x2 } from './linalg'

const FLT_EPSILON = 1.1920928955078125e-7
const MIN_EPS = 1e-8
const f32 = Math.fround

/** cv2.fitEllipse, `fitEllipseNoDirect`. */
export function fitEllipse(points: Point[]): RotatedRect {
  const n = points.length
  if (n < 5) return { center: { x: 0, y: 0 }, size: [0, 0], angle: 0 }

  // cv2 accumulates the centroid into a Point2f, so the mean carries float32 error.
  let centerX = 0
  let centerY = 0
  for (const point of points) {
    centerX = f32(centerX + point.x)
    centerY = f32(centerY + point.y)
  }
  centerX = f32(centerX / n)
  centerY = f32(centerY / n)

  const shifted: number[][] = new Array(n)
  let deviation = 0
  for (let i = 0; i < n; i += 1) {
    const x = f32(points[i].x - centerX)
    const y = f32(points[i].y - centerY)
    shifted[i] = [x, y]
    deviation += Math.abs(x) + Math.abs(y)
  }
  const scale = 100 / (deviation > FLT_EPSILON ? deviation : FLT_EPSILON)

  // First fit: the four coefficients A, B, C, D, E of the general conic.
  const firstRows: number[][] = new Array(n)
  const firstRhs = new Array<number>(n).fill(10000)
  for (let i = 0; i < n; i += 1) {
    const px = shifted[i][0] * scale
    const py = shifted[i][1] * scale
    firstRows[i] = [-px * px, -py * py, -px * py, px, py]
  }
  const conic = leastSquares(firstRows, firstRhs)

  // Centre of the conic: differentiate the general form and solve for x and y.
  const [offsetX, offsetY] = solve2x2(
    2 * conic[0],
    conic[2],
    conic[2],
    2 * conic[1],
    conic[3],
    conic[4]
  )

  // Second fit: A, B, C with the centre already removed.
  const secondRows: number[][] = new Array(n)
  const secondRhs = new Array<number>(n).fill(1)
  for (let i = 0; i < n; i += 1) {
    const px = shifted[i][0] * scale - offsetX
    const py = shifted[i][1] * scale - offsetY
    secondRows[i] = [px * px, py * py, px * py]
  }
  const quadric = leastSquares(secondRows, secondRhs)

  // Angle and radii, exactly as OpenCV converts them (`APP` angle convention).
  const rotation = -0.5 * Math.atan2(quadric[2], quadric[1] - quadric[0])
  const t
    = Math.abs(quadric[2]) > MIN_EPS
      ? quadric[2] / Math.sin(-2 * rotation)
      : quadric[1] - quadric[0]
  let radiusA = Math.abs(quadric[0] + quadric[1] - t)
  if (radiusA > MIN_EPS) radiusA = Math.sqrt(2 / radiusA)
  let radiusB = Math.abs(quadric[0] + quadric[1] + t)
  if (radiusB > MIN_EPS) radiusB = Math.sqrt(2 / radiusB)

  let width = f32((radiusA * 2) / scale)
  let height = f32((radiusB * 2) / scale)
  let angle = 0
  if (width > height) {
    const swap = width
    width = height
    height = swap
    angle = f32(90 + (rotation * 180) / Math.PI)
  }
  if (angle < -180) angle += 360
  if (angle > 360) angle -= 360

  return {
    center: { x: f32(offsetX / scale) + centerX, y: f32(offsetY / scale) + centerY },
    size: [width, height],
    angle
  }
}

/** Round half to even, like cvRound(). */
function cvRound(value: number): number {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * cv2.ellipse2Poly(center, axes, angle, 0, 360, 1): one sample per degree, keeping
 * only the samples that moved to a new pixel.
 */
export function ellipse2Poly(center: Point, axes: [number, number], angle: number): Point[] {
  const polygon: Point[] = []
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const [a, b] = axes
  let previousX = NaN
  let previousY = NaN
  for (let degrees = 0; degrees <= 360; degrees += 1) {
    const t = (degrees * Math.PI) / 180
    const ct = Math.cos(t)
    const st = Math.sin(t)
    const x = cvRound(center.x + a * ct * cos - b * st * sin)
    const y = cvRound(center.y + a * ct * sin + b * st * cos)
    if (x === previousX && y === previousY) continue
    polygon.push({ x, y })
    previousX = x
    previousY = y
  }
  return polygon
}

/** `cv2.ellipse2Poly` with the integer truncation BoundingEllipse applies to its box. */
export function ellipsePolygonFromRect(rect: RotatedRect): Point[] {
  return ellipse2Poly(
    { x: Math.trunc(rect.center.x), y: Math.trunc(rect.center.y) },
    [Math.trunc(rect.size[0] / 2), Math.trunc(rect.size[1] / 2)],
    Math.trunc(rect.angle)
  )
}
