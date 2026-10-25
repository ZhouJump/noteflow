/**
 * cv2.resize with INTER_LINEAR on 8 bit single channel images, reproduced bit for bit.
 *
 * The staff parsing step resizes every staff crop (`prepare_staff_image`) and then the
 * dewarped image again to fit the 256x1280 transformer canvas, so a rounded pixel here
 * ends up as a different transformer input. OpenCV does not evaluate the bilinear
 * weights in floating point: it converts them to 11 bit fixed point
 * (`INTER_RESIZE_COEF_BITS`), runs a horizontal pass that keeps the unshifted product in
 * an int buffer, and only rounds in the vertical pass with
 *
 *     dst = ((b0 * (S0 >> 4)) >> 16) + ((b1 * (S1 >> 4)) >> 16) + 2) >> 2
 *
 * The float32 casts of the sample position (`fx = (float)((dx + 0.5) * scale - 0.5)`) and
 * of the weights, plus cvRound's round-half-to-even, all matter: without them ~0.5% of
 * the pixels of a 1280x253 canvas differ by one.
 */

const COEF_BITS = 11;
const COEF_SCALE = 1 << COEF_BITS;

/** cvRound: round to nearest, ties to even (the FPU's default rounding mode). */
export function cvRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Sample offsets and the two 11 bit weights per destination index. */
function buildCoefficients(srcLength: number, dstLength: number) {
  const scale = 1 / (dstLength / srcLength);
  const offsets = new Int32Array(dstLength);
  const weights = new Int32Array(dstLength * 2);
  for (let dst = 0; dst < dstLength; dst += 1) {
    let fraction = Math.fround((dst + 0.5) * scale - 0.5);
    let src = Math.floor(fraction);
    fraction = Math.fround(fraction - src);
    if (src < 0) {
      fraction = 0;
      src = 0;
    }
    if (src >= srcLength - 1) {
      fraction = 0;
      src = srcLength - 1;
    }
    offsets[dst] = src;
    weights[dst * 2] = cvRound(Math.fround(Math.fround(1 - fraction) * COEF_SCALE));
    weights[dst * 2 + 1] = cvRound(Math.fround(fraction * COEF_SCALE));
  }
  return { offsets, weights };
}

/**
 * `cv2.resize(src, (dstWidth, dstHeight))` for a `uint8` image of one channel, laid out
 * row by row. Returns a new buffer; a same size request copies.
 */
export function resizeLinear(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8Array {
  if (dstWidth === srcWidth && dstHeight === srcHeight) return src.slice();

  const x = buildCoefficients(srcWidth, dstWidth);
  const y = buildCoefficients(srcHeight, dstHeight);

  // Horizontal pass: keeps the products without the shift, exactly like HResizeLinear.
  const horizontal = new Int32Array(srcHeight * dstWidth);
  for (let row = 0; row < srcHeight; row += 1) {
    const srcRow = row * srcWidth;
    const dstRow = row * dstWidth;
    for (let col = 0; col < dstWidth; col += 1) {
      const sample = x.offsets[col];
      const next = Math.min(sample + 1, srcWidth - 1);
      horizontal[dstRow + col] =
        src[srcRow + sample] * x.weights[col * 2] + src[srcRow + next] * x.weights[col * 2 + 1];
    }
  }

  // Vertical pass: VResizeLinear<uchar, int, short>, including its coarse rounding.
  const dst = new Uint8Array(dstWidth * dstHeight);
  for (let row = 0; row < dstHeight; row += 1) {
    const top = Math.min(Math.max(y.offsets[row], 0), srcHeight - 1);
    const bottom = Math.min(Math.max(y.offsets[row] + 1, 0), srcHeight - 1);
    const b0 = y.weights[row * 2];
    const b1 = y.weights[row * 2 + 1];
    const topRow = top * dstWidth;
    const bottomRow = bottom * dstWidth;
    const dstRow = row * dstWidth;
    for (let col = 0; col < dstWidth; col += 1) {
      const value =
        (((b0 * (horizontal[topRow + col] >> 4)) >> 16) +
          ((b1 * (horizontal[bottomRow + col] >> 4)) >> 16) +
          2) >>
        2;
      dst[dstRow + col] = value > 255 ? 255 : value;
    }
  }
  return dst;
}
