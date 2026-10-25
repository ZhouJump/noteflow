/**
 * The five SegNet masks the symbol search consumes, and the one morphology HOMR
 * applies to the staff mask before it looks for boxes.
 */

import {
  CLEFS_KEYS_CLASS,
  NOTEHEAD_CLASS,
  STAFF_CLASS,
  STEMS_REST_CLASS,
  SYMBOLS_CLASS,
} from './constants.ts';
import { dilate, ellipseKernel } from '../vision/morphology.ts';

export interface InputMasks {
  notehead: Uint8Array;
  symbols: Uint8Array;
  staff: Uint8Array;
  clefs_keys: Uint8Array;
  stems_rest: Uint8Array;
}

/**
 * Split the argmax class map into the 0/1 masks. The class ids are the ones
 * `inference_segnet.inference` compares against, and every mask starts out as a plain
 * 8 bit 0/1 image like `(merged == 4).astype(np.uint8)`.
 */
export function masksFromClassMap(classMap: Uint8Array): InputMasks {
  const masks: InputMasks = {
    notehead: new Uint8Array(classMap.length),
    symbols: new Uint8Array(classMap.length),
    staff: new Uint8Array(classMap.length),
    clefs_keys: new Uint8Array(classMap.length),
    stems_rest: new Uint8Array(classMap.length),
  };
  for (let i = 0; i < classMap.length; i += 1) {
    const value = classMap[i];
    if (value === NOTEHEAD_CLASS) masks.notehead[i] = 1;
    else if (value === SYMBOLS_CLASS) masks.symbols[i] = 1;
    else if (value === STAFF_CLASS) masks.staff[i] = 1;
    else if (value === CLEFS_KEYS_CLASS) masks.clefs_keys[i] = 1;
    else if (value === STEMS_REST_CLASS) masks.stems_rest[i] = 1;
  }
  return masks;
}

/**
 * staff_detection.make_lines_stronger: dilate with an elliptical kernel and threshold
 * at 0.1, which on a 0/1 mask is just "is anything left in the kernel window".
 */
export function makeLinesStronger(
  binary: Uint8Array,
  width: number,
  height: number,
  kernelSize: [number, number],
): Uint8Array {
  const dilated = dilate(binary, width, height, ellipseKernel(kernelSize[0], kernelSize[1]));
  for (let i = 0; i < dilated.length; i += 1) dilated[i] = dilated[i] > 0.1 ? 1 : 0;
  return dilated;
}
