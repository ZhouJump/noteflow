/**
 * Border following on a binary image, the parts of cv2.findContours the port needs.
 *
 * HOMR calls `cv2.findContours(img, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)` and
 * ignores the hierarchy, but it keeps every contour it gets back, holes included: the
 * brace/dot mask has seven small rings inside the brace glyphs. The tracer is
 * Moore-neighbour following with Jacob's stopping criterion; the chain is then reduced
 * the way CHAIN_APPROX_SIMPLE does it (one point per straight run).
 *
 * Verified against cv2 on the six stage masks: see scripts/check-contours.mjs.
 */

export interface Point {
  x: number;
  y: number;
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

// Background is labelled with 4-connectivity: an 8-connected hole would cut through
// diagonal foreground pixels, which cv2 counts as one solid region.
const DX4 = [1, 0, -1, 0];
const DY4 = [0, 1, 0, -1];

function direction(from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // The order matches DX/DY: E, SE, S, SW, W, NW, N, NE (clockwise).
  if (dx === 1 && dy === 0) return 0;
  if (dx === 1 && dy === 1) return 1;
  if (dx === 0 && dy === 1) return 2;
  if (dx === -1 && dy === 1) return 3;
  if (dx === -1 && dy === 0) return 4;
  if (dx === -1 && dy === -1) return 5;
  if (dx === 0 && dy === -1) return 6;
  return 7;
}

/**
 * Walk the 8-connected border of the foreground region that contains `start`.
 * `backDir` is the direction from `start` towards the background pixel the walk
 * enters from; the neighbour scan resumes there and goes counter-clockwise, which
 * is the orientation cv2.findContours gives outer contours in image coordinates.
 */
function traceBorder(
  binary: Uint8Array,
  width: number,
  height: number,
  start: Point,
  backDir: number,
): Point[] {
  const chain: Point[] = [start];
  // Moore tracing can revisit pixels on thin spurs; the cap only protects against
  // a pathological loop, a real border is far shorter.
  const limit = 8 * (width + height);
  let current = start;
  let entry = backDir;
  for (;;) {
    let next: Point | null = null;
    let outDir = 0;
    for (let step = 0; step < 8; step += 1) {
      const dir = (entry - step + 8) & 7;
      const x = current.x + DX[dir];
      const y = current.y + DY[dir];
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (binary[y * width + x]) {
        next = { x, y };
        outDir = dir;
        break;
      }
    }
    if (next === null) break; // isolated pixel
    // The pixel we came from sits at (outDir + 4); resume just after it, in the
    // same rotational direction, so the walk keeps circling instead of stepping back.
    entry = (outDir + 3) & 7;
    current = next;
    if (current.x === start.x && current.y === start.y) break;
    chain.push(current);
    if (chain.length > limit) break;
  }
  return chain;
}

/**
 * Keep one point per straight run, like CHAIN_APPROX_SIMPLE.
 *
 * The chain is closed, so the first point is tested against the last one as well: on a
 * thin ring the start often sits in the middle of a diagonal run and cv2 drops it.
 */
function simplify(chain: Point[]): Point[] {
  const count = chain.length;
  if (count <= 2) return chain;
  const result: Point[] = [];
  for (let i = 0; i < count; i += 1) {
    const previous = chain[(i + count - 1) % count];
    const current = chain[i];
    const next = chain[(i + 1) % count];
    if (direction(previous, current) !== direction(current, next)) result.push(current);
  }
  return result.length > 0 ? result : chain;
}

/** Contours of every 8-connected foreground component, in cv2.findContours order. */
export function findContours(
  binary: Uint8Array,
  width: number,
  height: number,
): Point[][] {
  const labels = new Int32Array(width * height).fill(-1);
  const starts: number[] = [];
  const stack: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!binary[index] || labels[index] >= 0) continue;
      const id = starts.length;
      starts.push(index);
      labels[index] = id;
      stack.length = 0;
      stack.push(index);
      while (stack.length > 0) {
        const current = stack.pop() as number;
        const cx = current % width;
        const cy = (current - cx) / width;
        for (let dir = 0; dir < 8; dir += 1) {
          const nx = cx + DX[dir];
          const ny = cy + DY[dir];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (!binary[neighbour] || labels[neighbour] >= 0) continue;
          labels[neighbour] = id;
          stack.push(neighbour);
        }
      }
    }
  }

  // Holes grouped by the component that encloses them.
  const holes = findHoles(binary, labels, width, height);
  const contours: Point[][] = [];
  // cv2 hands the contours back in the reverse of its discovery order: the components
  // come out monotonically decreasing by start point, i.e. bottom row first and
  // rightmost first inside a row, and every component is followed by its own holes in
  // the same decreasing order. Box order follows contour order
  // (merge_overlaying_bounding_boxes keeps the first box of every group), so the flip
  // has to happen here.
  for (let id = starts.length - 1; id >= 0; id -= 1) {
    const startIndex = starts[id];
    const startX = startIndex % width;
    const startY = (startIndex - startX) / width;
    // Enter the component from its left, i.e. direction 4 (west).
    contours.push(simplify(traceBorder(binary, width, height, { x: startX, y: startY }, 4)));

    const own = holes.get(id);
    if (!own) continue;
    for (let i = own.length - 1; i >= 0; i -= 1) {
      const holeIndex = own[i];
      const holeX = holeIndex % width;
      const holeY = (holeIndex - holeX) / width;
      // The ring of foreground pixels around a hole is walked from the pixel left of
      // the hole's first pixel, entering from the hole itself (east, direction 0).
      contours.push(
        simplify(traceBorder(binary, width, height, { x: holeX - 1, y: holeY }, 0)),
      );
    }
  }
  return contours;
}

/**
 * Background regions that are fully enclosed by foreground, keyed by component id.
 *
 * The value is the scan-order start index of every hole; callers walk them backwards.
 */
function findHoles(
  binary: Uint8Array,
  labels: Int32Array,
  width: number,
  height: number,
): Map<number, number[]> {
  const seen = new Uint8Array(width * height);
  const holes = new Map<number, number[]>();
  const stack: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (binary[index] || seen[index]) continue;
      seen[index] = 1;
      stack.length = 0;
      stack.push(index);
      let touchesBorder = x === 0 || y === 0;
      while (stack.length > 0) {
        const current = stack.pop() as number;
        const cx = current % width;
        const cy = (current - cx) / width;
        for (let dir = 0; dir < 4; dir += 1) {
          const nx = cx + DX4[dir];
          const ny = cy + DY4[dir];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (binary[neighbour] || seen[neighbour]) continue;
          seen[neighbour] = 1;
          if (nx === 0 || ny === 0 || nx === width - 1 || ny === height - 1) touchesBorder = true;
          stack.push(neighbour);
        }
      }
      // A region that reaches the image border is open background, not a hole. The
      // pixel to the left of a hole's top-left pixel is the enclosing foreground.
      if (touchesBorder) continue;
      const parent = labels[index - 1];
      const own = holes.get(parent);
      if (own) own.push(index);
      else holes.set(parent, [index]);
    }
  }
  return holes;
}

/** cv2.boundingRect */
export function boundingRect(points: Point[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * cv2.pointPolygonTest: +1 inside, 0 on the boundary, -1 outside.
 *
 * The polygons HOMR overlaps are integer pixel coordinates (cv2.boxPoints truncated
 * to int64, or ellipse2Poly output) and the queried points are those same vertices,
 * so cv2 always takes the "purely integer" branch of geometry.cpp: an even-odd
 * crossing count with `int64` cross products, and every touched edge returning 0.
 */
export function pointPolygonTest(polygon: Point[], point: Point): number {
  const total = polygon.length;
  if (total === 0) return -1;
  const { x: px, y: py } = point;
  let previous = polygon[total - 1];
  let counter = 0;
  for (let i = 0; i < total; i += 1) {
    const current = polygon[i];
    if (
      (previous.y <= py && current.y <= py) ||
      (previous.y > py && current.y > py) ||
      (previous.x < px && current.x < px)
    ) {
      const onHorizontalEdge =
        py === current.y &&
        (px === current.x ||
          (py === previous.y &&
            ((previous.x <= px && px <= current.x) || (current.x <= px && px <= previous.x))));
      if (onHorizontalEdge) return 0;
      previous = current;
      continue;
    }

    let distance = (py - previous.y) * (current.x - previous.x) - (px - previous.x) * (current.y - previous.y);
    if (distance === 0) return 0;
    if (current.y < previous.y) distance = -distance;
    if (distance > 0) counter += 1;
    previous = current;
  }
  return counter % 2 === 0 ? -1 : 1;
}

/** cv2.pointPolygonTest(polygon, point, false) >= 0 */
export function pointInPolygon(polygon: Point[], point: Point): boolean {
  return pointPolygonTest(polygon, point) >= 0;
}
