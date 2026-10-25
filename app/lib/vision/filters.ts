/**
 * cv2.filter2D, for the one call HOMR makes: a 3x3 Laplacian over a grey tile with the
 * default BORDER_REFLECT_101 padding, accumulated in double precision.
 */

export interface Kernel {
  width: number
  height: number
  /** Row major weights. */
  values: number[]
}

/** cv2.filter2D: correlation (not convolution) with the anchor in the kernel centre. */
export function filter2D(
  source: Uint8Array,
  width: number,
  height: number,
  kernel: Kernel
): Float64Array {
  const output = new Float64Array(width * height)
  const anchorX = Math.floor(kernel.width / 2)
  const anchorY = Math.floor(kernel.height / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let ky = 0; ky < kernel.height; ky += 1) {
        const sourceY = reflect101(y + ky - anchorY, height)
        const rowOffset = sourceY * width
        const kernelRow = ky * kernel.width
        for (let kx = 0; kx < kernel.width; kx += 1) {
          const weight = kernel.values[kernelRow + kx]
          if (weight === 0) continue
          sum += weight * source[rowOffset + reflect101(x + kx - anchorX, width)]
        }
      }
      output[y * width + x] = sum
    }
  }
  return output
}

/** cv2's borderInterpolate for BORDER_REFLECT_101. */
function reflect101(position: number, length: number): number {
  if (position >= 0 && position < length) return position
  if (length === 1) return 0
  let p = position
  do {
    p = p < 0 ? -p : 2 * (length - 1) - p
  } while (p < 0 || p >= length)
  return p
}
