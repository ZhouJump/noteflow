/**
 * Min-area rectangles, the parts of cv2.minAreaRect / cv2.boxPoints the port needs.
 *
 * This is a port of two OpenCV files, because the exact output of minAreaRect depends
 * on both of them:
 *
 *   - convexHull (convexhull.cpp): Sklansky's method over the x/y sorted points. The
 *     order it returns decides which hull edge the sweep below tests first.
 *   - rotatingCalipers (rotcalipers.cpp): four tangents rotating around the hull,
 *     keeping the smallest bounding rectangle with `<=` so the last tie wins.
 *
 * Both use single precision float arithmetic like the C++ code, and the final
 * (center, size, angle) conversion is copied verbatim: `width` spans across the
 * winning hull edge and `angle` is in [-90, 0).
 *
 * Verified against cv2 per contour: see scripts/check-primitives.mjs.
 */

import type { Point } from './contours.ts';

export interface RotatedRect {
  center: Point;
  /** [width along `angle`, height across `angle`], both >= 0. */
  size: [number, number];
  /** Degrees, in [-90, 0). */
  angle: number;
}

const f32 = Math.fround;
const FLT_MAX = 3.4028234663852886e38;
const DEFAULT_ANGLE_RADIANS = -Math.PI / 2;

function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/**
 * One half of Sklansky's scan (`Sklansky_` in convexhull.cpp). Indices refer to the
 * sorted `points` array; the resulting index list is written at `stack[offset...]` and
 * the length is returned.
 */
function sklansky(
  points: Point[],
  start: number,
  end: number,
  stack: Int32Array,
  offset: number,
  nsign: number,
  sign2: number,
): number {
  const increment = end > start ? 1 : -1;
  let previous = start;
  let current = previous + increment;
  let next = current + increment;
  let stackSize = 3;

  if (
    start === end ||
    (points[start].x === points[end].x && points[start].y === points[end].y)
  ) {
    stack[offset] = start;
    return 1;
  }

  stack[offset] = previous;
  stack[offset + 1] = current;
  stack[offset + 2] = next;
  end += increment; // make `end` exclusive

  while (next !== end) {
    const currentY = points[current].y;
    const nextY = points[next].y;
    const deltaY = nextY - currentY;

    if (sign(deltaY) !== nsign) {
      const ax = points[current].x - points[previous].x;
      const ay = currentY - points[previous].y;
      const bx = points[next].x - points[current].x;
      const by = deltaY;
      const convexity = ay * bx - ax * by;
      if (sign(convexity) === sign2 && (ax !== 0 || ay !== 0)) {
        previous = current;
        current = next;
        next += increment;
        stack[offset + stackSize] = next;
        stackSize += 1;
      } else if (previous === start) {
        current = next;
        stack[offset + 1] = current;
        next += increment;
        stack[offset + 2] = next;
      } else {
        stack[offset + stackSize - 2] = next;
        current = previous;
        previous = stack[offset + stackSize - 4];
        stackSize -= 1;
      }
    } else {
      next += increment;
      stack[offset + stackSize - 1] = next;
    }
  }

  return stackSize - 1;
}

/** cv2.convexHull(points, clockwise=false, returnPoints=true) */
export function convexHull(points: Point[]): Point[] {
  const total = points.length;
  if (total === 0) return [];

  const order = Array.from({ length: total }, (_, i) => i).sort((a, b) => {
    if (points[a].x !== points[b].x) return points[a].x - points[b].x;
    if (points[a].y !== points[b].y) return points[a].y - points[b].y;
    return a - b;
  });
  const sorted = order.map((index) => points[index]);

  let minYIndex = 0;
  let maxYIndex = 0;
  for (let i = 1; i < total; i += 1) {
    if (sorted[minYIndex].y > sorted[i].y) minYIndex = i;
    if (sorted[maxYIndex].y < sorted[i].y) maxYIndex = i;
  }

  const stack = new Int32Array(total + 2);
  const hullIndices: number[] = [];
  if (sorted[0].x === sorted[total - 1].x && sorted[0].y === sorted[total - 1].y) {
    hullIndices.push(0);
  } else {
    // Upper half: two scans meeting at the topmost point, emitted second first
    // because `clockwise` is false.
    const topLeftCount = sklansky(sorted, 0, maxYIndex, stack, 0, -1, 1);
    const topRightOffset = topLeftCount;
    const topRightCount = sklansky(sorted, total - 1, maxYIndex, stack, topRightOffset, -1, -1);

    for (let i = 0; i < topRightCount - 1; i += 1) hullIndices.push(stack[topRightOffset + i]);
    for (let i = topLeftCount - 1; i > 0; i -= 1) hullIndices.push(stack[i]);
    const stopIndex =
      topLeftCount > 2
        ? stack[1]
        : topRightCount > 2
          ? stack[topRightOffset + topRightCount - 2]
          : -1;

    // Lower half.
    let bottomLeftCount = sklansky(sorted, 0, minYIndex, stack, 0, 1, -1);
    const bottomRightOffset = bottomLeftCount;
    let bottomRightCount = sklansky(sorted, total - 1, minYIndex, stack, bottomRightOffset, 1, 1);

    if (stopIndex >= 0) {
      const checkIndex =
        bottomLeftCount > 2
          ? stack[1]
          : bottomLeftCount + bottomRightCount > 2
            ? stack[bottomRightOffset + 2 - bottomLeftCount]
            : -1;
      if (
        checkIndex === stopIndex ||
        (checkIndex >= 0 &&
          sorted[checkIndex].x === sorted[stopIndex].x &&
          sorted[checkIndex].y === sorted[stopIndex].y)
      ) {
        // All points are collinear: the bottom half mirrors the top one.
        bottomLeftCount = Math.min(bottomLeftCount, 2);
        bottomRightCount = Math.min(bottomRightCount, 2);
      }
    }

    for (let i = 0; i < bottomLeftCount - 1; i += 1) hullIndices.push(stack[i]);
    for (let i = bottomRightCount - 1; i > 0; i -= 1) {
      hullIndices.push(stack[bottomRightOffset + i]);
    }
  }

  // Map back to indices of the caller's array, then apply cv2's cyclic shift that
  // makes the indices ascend or descend when the hull happens to be contiguous.
  const hull = hullIndices.map((index) => order[index]);
  if (hull.length >= 3) {
    let minIndex = 0;
    let maxIndex = 0;
    let increasing = 0;
    for (let i = 1; i < hull.length; i += 1) {
      const index = hull[i];
      increasing += hull[i - 1] < index ? 1 : 0;
      if (increasing > 1 && increasing <= i - 2) break;
      if (index < hull[minIndex]) minIndex = i;
      if (index > hull[maxIndex]) maxIndex = i;
    }
    const distance = Math.abs(maxIndex - minIndex);
    if ((distance === 1 || distance === hull.length - 1) && (increasing <= 1 || increasing >= hull.length - 2)) {
      const ascending = (maxIndex + 1) % hull.length === minIndex;
      const start = ascending ? minIndex : maxIndex;
      if (start > 0) {
        let j = start;
        let i = 0;
        for (; i < hull.length; i += 1) {
          const current = hull[j];
          stack[i] = current;
          const nextJ = j + 1 < hull.length ? j + 1 : 0;
          if (i < hull.length - 1 && ascending !== current < hull[nextJ]) break;
          j = nextJ;
        }
        if (i === hull.length) {
          for (let k = 0; k < hull.length; k += 1) hull[k] = stack[k];
        }
      }
    }
  }

  return hull.map((index) => points[index]);
}

/** `firstVecIsRight` from rotcalipers.cpp: is vec1 clockwise of vec2? */
function firstVectorIsRight(x1: number, y1: number, x2: number, y2: number): boolean {
  // rotate90CW(vec1) = (y1, -x1), then the float dot product with vec2.
  return f32(f32(y1 * x2) + f32(-x1 * y2)) < 0;
}

/** rotatingCalipers(..., CALIPERS_MINAREARECT) followed by the box assembly. */
function calipersRect(hull: Point[]): RotatedRect {
  const n = hull.length;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = hull[i].x;
    ys[i] = hull[i].y;
  }

  let left = 0;
  let bottom = 0;
  let right = 0;
  let top = 0;
  let leftX = xs[0];
  let rightX = xs[0];
  let topY = ys[0];
  let bottomY = ys[0];

  const vectorX = new Float32Array(n);
  const vectorY = new Float32Array(n);
  const inverseLength = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (xs[i] < leftX) {
      leftX = xs[i];
      left = i;
    }
    if (xs[i] > rightX) {
      rightX = xs[i];
      right = i;
    }
    if (ys[i] > topY) {
      topY = ys[i];
      top = i;
    }
    if (ys[i] < bottomY) {
      bottomY = ys[i];
      bottom = i;
    }
    const next = i + 1 < n ? i + 1 : 0;
    const dx = xs[next] - xs[i];
    const dy = ys[next] - ys[i];
    vectorX[i] = f32(dx);
    vectorY[i] = f32(dy);
    inverseLength[i] = f32(1 / Math.sqrt(dx * dx + dy * dy));
  }

  // The hull from convexHull is counter-clockwise in the mathematical sense, which is
  // what minAreaRect passes as orientation +1.
  const sequence = [bottom, right, top, left];
  const rotatedX = new Float32Array(4);
  const rotatedY = new Float32Array(4);
  let baseA = 1;
  let baseB = 0;
  let minArea = FLT_MAX;
  let bestLeft = 0;
  let bestBottom = 0;
  let bestWidth = 0;
  let bestHeight = 0;
  let bestBaseA = 1;
  let bestBaseB = 0;

  for (let step = 0; step < n; step += 1) {
    let mainElement = 0;
    rotatedX[0] = vectorX[sequence[0]];
    rotatedY[0] = vectorY[sequence[0]];
    rotatedX[1] = vectorY[sequence[1]]; // rotate90CW
    rotatedY[1] = -vectorX[sequence[1]];
    rotatedX[2] = -vectorX[sequence[2]]; // rotate180
    rotatedY[2] = -vectorY[sequence[2]];
    rotatedX[3] = -vectorY[sequence[3]]; // rotate90CCW
    rotatedY[3] = vectorX[sequence[3]];
    for (let i = 1; i < 4; i += 1) {
      if (firstVectorIsRight(rotatedX[i], rotatedY[i], rotatedX[mainElement], rotatedY[mainElement])) {
        mainElement = i;
      }
    }

    const pivot = sequence[mainElement];
    const leadX = f32(vectorX[pivot] * inverseLength[pivot]);
    const leadY = f32(vectorY[pivot] * inverseLength[pivot]);
    if (mainElement === 0) {
      baseA = leadX;
      baseB = leadY;
    } else if (mainElement === 1) {
      baseA = leadY;
      baseB = -leadX;
    } else if (mainElement === 2) {
      baseA = -leadX;
      baseB = -leadY;
    } else {
      baseA = -leadY;
      baseB = leadX;
    }
    sequence[mainElement] += 1;
    if (sequence[mainElement] === n) sequence[mainElement] = 0;

    let dx = f32(xs[sequence[1]] - xs[sequence[3]]);
    let dy = f32(ys[sequence[1]] - ys[sequence[3]]);
    const width = f32(f32(dx * baseA) + f32(dy * baseB));
    dx = f32(xs[sequence[2]] - xs[sequence[0]]);
    dy = f32(ys[sequence[2]] - ys[sequence[0]]);
    const height = f32(f32(-dx * baseB) + f32(dy * baseA));
    const area = f32(width * height);
    if (area <= minArea) {
      minArea = area;
      bestLeft = sequence[3];
      bestBottom = sequence[0];
      bestWidth = width;
      bestHeight = height;
      bestBaseA = baseA;
      bestBaseB = baseB;
    }
  }

  // Corner where the two caliper lines touch, then centre = corner + (w + h) / 2.
  const a2 = -bestBaseB;
  const b2 = bestBaseA;
  const c1 = f32(f32(bestBaseA * xs[bestLeft]) + f32(ys[bestLeft] * bestBaseB));
  const c2 = f32(f32(a2 * xs[bestBottom]) + f32(ys[bestBottom] * b2));
  const inverseDeterminant = f32(1 / f32(f32(bestBaseA * b2) - f32(a2 * bestBaseB)));
  const cornerX = f32(f32(f32(c1 * b2) - f32(c2 * bestBaseB)) * inverseDeterminant);
  const cornerY = f32(f32(f32(bestBaseA * c2) - f32(a2 * c1)) * inverseDeterminant);

  const widthVectorX = f32(bestBaseA * bestWidth);
  const widthVectorY = f32(bestBaseB * bestWidth);
  const heightVectorX = f32(a2 * bestHeight);
  const heightVectorY = f32(b2 * bestHeight);

  const center = {
    x: f32(cornerX + f32(f32(widthVectorX + heightVectorX) * 0.5)),
    y: f32(cornerY + f32(f32(widthVectorY + heightVectorY) * 0.5)),
  };
  let width = f32(Math.sqrt(heightVectorX * heightVectorX + heightVectorY * heightVectorY));
  let height = f32(Math.sqrt(widthVectorX * widthVectorX + widthVectorY * widthVectorY));
  let angle = DEFAULT_ANGLE_RADIANS;
  if (widthVectorX === 0 && widthVectorY > 0) {
    const swap = width;
    width = height;
    height = swap;
  } else {
    angle = -Math.atan2(widthVectorX, widthVectorY);
  }
  return { center, size: [width, height], angle: f32((angle * 180) / Math.PI) };
}

/** The `n == 2` branch of cv2.minAreaRect. */
function segmentRect(first: Point, second: Point): RotatedRect {
  // `hpoints` is the hull, so the sign of the angle follows the order convexHull emits.
  let width = 0;
  let height = f32(Math.hypot(first.x - second.x, first.y - second.y));
  let angle = DEFAULT_ANGLE_RADIANS;
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  if (dx === 0) {
    const swap = width;
    width = height;
    height = swap;
  } else if (dy < 0) {
    angle = Math.atan2(dy, dx);
    const swap = width;
    width = height;
    height = swap;
  } else if (dy > 0) {
    angle = -Math.atan2(dx, dy);
  }
  return {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    size: [width, height],
    angle: f32((angle * 180) / Math.PI),
  };
}

/** cv2.minAreaRect */
export function minAreaRect(points: Point[]): RotatedRect {
  if (points.length === 0) return { center: { x: 0, y: 0 }, size: [0, 0], angle: -90 };
  const hull = convexHull(points);
  if (hull.length === 1) {
    return { center: { x: hull[0].x, y: hull[0].y }, size: [0, 0], angle: -90 };
  }
  if (hull.length === 2) return segmentRect(hull[0], hull[1]);
  return calipersRect(hull);
}

/**
 * cv2.boxPoints, in cv2's corner order (bottom-right, bottom-left, top-left,
 * top-right for a y-down image). A RotatedRect stores float32 and `points()` computes
 * in float32 as well, so every step is rounded with f32. The rounding is visible: a
 * vertex that is 1802.9999 in float64 comes out as exactly 1803 in cv2, and the int64
 * polygon that cv2.pointPolygonTest then sees can sit a pixel further right.
 */
export function boxPoints(rect: RotatedRect): Point[] {
  const radians = f32(rect.angle) * (Math.PI / 180);
  const b = f32(f32(Math.cos(radians)) * 0.5);
  const a = f32(f32(Math.sin(radians)) * 0.5);
  const cx = f32(rect.center.x);
  const cy = f32(rect.center.y);
  const width = f32(rect.size[0]);
  const height = f32(rect.size[1]);
  const pt0 = {
    x: f32(f32(cx - f32(a * height)) - f32(b * width)),
    y: f32(f32(cy + f32(b * height)) - f32(a * width)),
  };
  const pt1 = {
    x: f32(f32(cx + f32(a * height)) - f32(b * width)),
    y: f32(f32(cy - f32(b * height)) - f32(a * width)),
  };
  return [
    pt0,
    pt1,
    { x: f32(f32(2 * cx) - pt0.x), y: f32(f32(2 * cy) - pt0.y) },
    { x: f32(f32(2 * cx) - pt1.x), y: f32(f32(2 * cy) - pt1.y) },
  ];
}

/** `cv2.boxPoints(rect).astype(np.int64)`, i.e. truncation towards zero. */
export function boxPointsInt(rect: RotatedRect): Point[] {
  return boxPoints(rect).map((point) => ({ x: Math.trunc(point.x), y: Math.trunc(point.y) }));
}
