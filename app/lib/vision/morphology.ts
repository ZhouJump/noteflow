/**
 * The binary morphology HOMR uses before it looks for boxes.
 *
 * `make_lines_stronger` dilates the staff mask with a tiny kernel and thresholds the
 * result back to 0/1, which is what closes the one pixel gaps between staff line
 * fragments. `prepare_staff_image` and `prepare_brace_dot_image` erode first, to drop
 * everything thinner than the kernel. Only binary images are needed, so this is a
 * plain OR (dilate) or AND (erode) over the kernel instead of cv2's filter engine.
 */

/** Round half to even, like cvRound(). */
function cvRound(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

export interface StructuringElement {
  width: number
  height: number
  /** Row major, 1 = part of the element. */
  mask: Uint8Array
}

/**
 * cv2.getStructuringElement(MORPH_ELLIPSE, (width, height)).
 *
 * OpenCV does not test every pixel against the ellipse; it fills a horizontal run per
 * row, `anchor.x +- round(width/2 * sqrt(1 - dy^2 / (height/2)^2))`. For a tall kernel
 * that makes entire rows solid, which a per-pixel test would not.
 */
export function ellipseKernel(width: number, height: number): StructuringElement {
  const mask = new Uint8Array(width * height)
  const radius = Math.floor(height / 2)
  const halfWidth = Math.floor(width / 2)
  const anchorX = Math.floor(width / 2)
  const inverseRadiusSquared = radius ? 1 / (radius * radius) : 0
  for (let i = 0; i < height; i += 1) {
    const dy = i - radius
    const span = cvRound(
      halfWidth * Math.sqrt(Math.max(0, (radius * radius - dy * dy) * inverseRadiusSquared))
    )
    const start = Math.max(anchorX - span, 0)
    const stop = Math.min(anchorX + span + 1, width)
    mask.fill(1, i * width + start, i * width + stop)
  }
  return { width, height, mask }
}

/** cv2.getStructuringElement(MORPH_RECT, (width, height)), i.e. all ones. */
export function rectangleKernel(width: number, height: number): StructuringElement {
  return { width, height, mask: new Uint8Array(width * height).fill(1) }
}

/**
 * cv2.dilate on a binary image. The anchor is the kernel centre and, like the
 * morphology default, out-of-image neighbours are ignored.
 */
export function dilate(
  binary: Uint8Array,
  width: number,
  height: number,
  kernel: StructuringElement
): Uint8Array {
  const output = new Uint8Array(width * height)
  const anchorX = Math.floor(kernel.width / 2)
  const anchorY = Math.floor(kernel.height / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!binary[y * width + x]) continue
      // dst(x', y') = src(x' + kx - anchorX, y' + ky - anchorY), so a source pixel
      // spreads to (x - kx + anchorX, y - ky + anchorY).
      for (let ky = 0; ky < kernel.height; ky += 1) {
        const targetY = y - ky + anchorY
        if (targetY < 0 || targetY >= height) continue
        const kernelRow = ky * kernel.width
        const rowOffset = targetY * width
        for (let kx = 0; kx < kernel.width; kx += 1) {
          if (!kernel.mask[kernelRow + kx]) continue
          const targetX = x - kx + anchorX
          if (targetX < 0 || targetX >= width) continue
          output[rowOffset + targetX] = 1
        }
      }
    }
  }
  return output
}

/**
 * cv2.erode on a binary image: a pixel survives only if the whole kernel fits in the
 * foreground. Like the morphology default, out-of-image neighbours are ignored.
 */
export function erode(
  binary: Uint8Array,
  width: number,
  height: number,
  kernel: StructuringElement
): Uint8Array {
  const output = new Uint8Array(width * height)
  const anchorX = Math.floor(kernel.width / 2)
  const anchorY = Math.floor(kernel.height / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // src(x', y') = dst(x' + kx - anchorX, y' + ky - anchorY).
      let keep = 1
      for (let ky = 0; ky < kernel.height && keep; ky += 1) {
        const sourceY = y + ky - anchorY
        if (sourceY < 0 || sourceY >= height) continue
        const kernelRow = ky * kernel.width
        const rowOffset = sourceY * width
        for (let kx = 0; kx < kernel.width; kx += 1) {
          if (!kernel.mask[kernelRow + kx]) continue
          const sourceX = x + kx - anchorX
          if (sourceX < 0 || sourceX >= width) continue
          if (!binary[rowOffset + sourceX]) {
            keep = 0
            break
          }
        }
      }
      output[y * width + x] = keep
    }
  }
  return output
}
