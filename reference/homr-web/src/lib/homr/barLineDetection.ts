/**
 * HOMR's bar_line_detection.py.
 *
 * The bar line candidates come from the stems mask, widened by a 5x3 kernel so that
 * a line broken by a notehead becomes one box again. `detectBarLines` then drops the
 * boxes that are too short or too wide to be a bar line.
 */

import type { RotatedBoundingBox } from './boundingBoxes.ts';
import { barLineMaxWidth, barLineMinHeight } from './constants.ts';
import { dilate, rectangleKernel } from '../vision/morphology.ts';

/** prepare_bar_line_image: cv2.dilate with np.ones((5, 3)), i.e. 5 rows and 3 columns. */
export function prepareBarLineImage(
  binary: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  return dilate(binary, width, height, rectangleKernel(3, 5));
}

/** Keep the boxes whose size fits a bar line, given the notehead-based unit size. */
export function detectBarLines(
  barLines: RotatedBoundingBox[],
  unitSize: number,
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const barLine of barLines) {
    if (barLine.size[1] < barLineMinHeight(unitSize)) continue;
    if (barLine.size[0] > barLineMaxWidth(unitSize)) continue;
    result.push(barLine);
  }
  return result;
}
