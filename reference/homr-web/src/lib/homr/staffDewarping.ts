/**
 * The dewarping step that turns a curved staff crop into the image the transformer
 * reads.
 *
 * HOMR (`staff_dewarping.py`) measures where the middle staff line runs at every 80th
 * x, puts six horizontal bands over the crop, pulls each band to its average y, and
 * realises that with a Delaunay mesh of piecewise affine maps. On the sample pages the
 * page only bends by 0.2..0.6 of a line spacing and the mesh never moves a point
 * horizontally, so a per-column piecewise linear y shift reproduces HOMR's 256x1280
 * canvas to within 1.4% of its pixels (`scripts/probe_column_dewarp.py`). Skipping the
 * step entirely changes 31..58% of the canvas, which is why it stays in the port.
 *
 * The mesh data is still produced by the same `calculateSpanAndOptimalPoints` walk as
 * HOMR, so the layout decisions stay comparable with the reference artefacts.
 */

import type { Point } from '../vision/contours.ts';
import type { Staff } from './model.ts';
import { pyRound } from './numeric.ts';

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface StaffDewarping {
  /** Warp the staff crop; `fillColor` is the border value HOMR uses (1). */
  dewarp(image: GrayImage, fillColor?: number): GrayImage;
  /** Move one staff coordinate through the same mapping. */
  dewarpPoint(point: Point): Point;
}

export const identityDewarping: StaffDewarping = {
  dewarp: (image) => image,
  dewarpPoint: (point) => point,
};

export interface DewarpPoints {
  spanPoints: Point[][];
  optimalPoints: Point[][];
}

const NUMBER_OF_Y_INTERVALS = 6;
const X_STEP = 80;
const IMAGE_MARGIN = 10;
const MINIMUM_NUMBER_OF_POINTS = 2;

/** `is_point_on_image`: the transformer discards samples too close to the border. */
function isPointOnImage(point: Point, width: number, height: number): boolean {
  if (
    point.x < IMAGE_MARGIN ||
    point.x > width - IMAGE_MARGIN ||
    point.y < IMAGE_MARGIN ||
    point.y > height - IMAGE_MARGIN
  ) {
    return false;
  }
  return true;
}

/**
 * `calculate_span_and_optimal_points`: one horizontal band every `height / 6` pixels,
 * sampled every 80 px. Each sample follows the middle staff line (`y[2]`), and the
 * optimum for a band is its average y, i.e. a straight line.
 */
export function calculateSpanAndOptimalPoints(
  staff: Staff,
  width: number,
  height: number,
): DewarpPoints {
  const spanPoints: Point[][] = [];
  const optimalPoints: Point[][] = [];
  const step = Math.trunc(height / NUMBER_OF_Y_INTERVALS);
  if (step === 0) return { spanPoints, optimalPoints };

  // Python's `if not first_y_offset` treats a zero offset as "not set yet".
  let firstYOffset: number | null = null;
  for (let y = 2; y < height - 2; y += step) {
    const linePoints: Point[] = [];
    for (let x = 2; x < width; x += X_STEP) {
      const staffPoint = staff.getAt(x);
      if (staffPoint === null) continue;
      const yOffset = staffPoint.y[2];
      let yDelta = 0;
      if (!firstYOffset) {
        firstYOffset = yOffset;
      } else {
        yDelta = Math.trunc(yOffset - firstYOffset);
      }
      const point = { x, y: y + yDelta };
      if (isPointOnImage(point, width, height)) linePoints.push(point);
    }
    if (linePoints.length > MINIMUM_NUMBER_OF_POINTS) {
      const averageY = linePoints.reduce((sum, point) => sum + point.y, 0) / linePoints.length;
      spanPoints.push(linePoints);
      optimalPoints.push(linePoints.map((point) => ({ x: point.x, y: Math.trunc(averageY) })));
    }
  }
  return { spanPoints, optimalPoints };
}

/** `np.interp` for a sorted control point list. */
function interpolate(value: number, xs: number[], ys: number[]): number {
  if (xs.length === 0) return 0;
  if (value <= xs[0]) return ys[0];
  const last = xs.length - 1;
  if (value >= xs[last]) return ys[last];
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (xs[middle] <= value) low = middle;
    else high = middle;
  }
  const span = xs[high] - xs[low];
  if (span === 0) return ys[high];
  return ys[low] + ((value - xs[low]) / span) * (ys[high] - ys[low]);
}

/**
 * The piecewise linear replacement for HOMR's triangle mesh: every column gets an
 * offset curve over y, zero at the image top and bottom and the band offset at each
 * band row, so the image edges stay where they are exactly like the mesh corners.
 */
class ColumnDewarping implements StaffDewarping {
  private readonly width: number;
  private readonly height: number;
  private readonly offsets: Float32Array;

  constructor(width: number, height: number, offsets: Float32Array) {
    this.width = width;
    this.height = height;
    this.offsets = offsets;
  }

  private offsetAt(x: number, y: number): number {
    const column = Math.min(Math.max(Math.trunc(x), 0), this.width - 1);
    const clampedY = Math.min(Math.max(y, 0), this.height - 1);
    const y0 = Math.trunc(clampedY);
    const y1 = Math.min(y0 + 1, this.height - 1);
    const fraction = clampedY - y0;
    const top = this.offsets[y0 * this.width + column];
    const bottom = this.offsets[y1 * this.width + column];
    return top + (bottom - top) * fraction;
  }

  dewarpPoint(point: Point): Point {
    return { x: point.x, y: point.y - this.offsetAt(point.x, point.y) };
  }

  dewarp(image: GrayImage, fillColor = 1): GrayImage {
    const width = image.width;
    const height = image.height;
    const output = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // cv2.remap samples through the same 1/32 pixel grid and 15 bit weights as
        // warpAffine; the map itself is stored as float32.
        const sourceY = Math.fround(y - this.offsetAt(x, y));
        const fixed = pyRound(sourceY * 32);
        const sy = fixed >> 5;
        const fy = fixed & 31;
        const top = sy >= 0 && sy < height ? image.data[sy * width + x] : fillColor;
        const bottom =
          sy + 1 >= 0 && sy + 1 < height ? image.data[(sy + 1) * width + x] : fillColor;
        const value = (((32 - fy) * top + fy * bottom) * 1024 + 16384) >> 15;
        output[y * width + x] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
    }
    return { data: output, width, height };
  }
}

/** Build the column warp from the band points; fewer than three points means give up. */
export function createColumnDewarping(
  width: number,
  height: number,
  spanPoints: Point[][],
  optimalPoints: Point[][],
): StaffDewarping {
  if (spanPoints.length < 2) return identityDewarping;

  const offsets = new Float32Array(width * height);
  const rows = Array.from({ length: height }, (_, index) => index);

  for (let x = 0; x < width; x += 1) {
    // The mesh vertices of one band do not share a y: each follows the staff line.
    // Using the band's mean row instead would bend the interpolation near the outer
    // staff lines by up to two pixels (visible in the transformed staff grid).
    const controlRows = [0];
    const values = [0];
    for (let band = 0; band < spanPoints.length; band += 1) {
      const line = spanPoints[band];
      const optimal = optimalPoints[band];
      const sampleXs = line.map((point) => point.x);
      const sampleYs = line.map((point) => point.y);
      const sampleOffsets = line.map((point, index) => optimal[index].y - point.y);
      controlRows.push(interpolate(x, sampleXs, sampleYs));
      values.push(interpolate(x, sampleXs, sampleOffsets));
    }
    controlRows.push(height - 1);
    values.push(0);
    for (const y of rows) offsets[y * width + x] = interpolate(y, controlRows, values);
  }
  return new ColumnDewarping(width, height, offsets);
}

/**
 * `dewarp_staff_image`: measure the bands and build the warp. HOMR catches every
 * exception here and carries on without dewarping, which is what the identity return
 * mirrors.
 */
export function dewarpStaffImage(image: GrayImage, staff: Staff): StaffDewarping {
  try {
    const { spanPoints, optimalPoints } = calculateSpanAndOptimalPoints(
      staff,
      image.width,
      image.height,
    );
    if (spanPoints.length < 2) return identityDewarping;
    return createColumnDewarping(image.width, image.height, spanPoints, optimalPoints);
  } catch {
    return identityDewarping;
  }
}
