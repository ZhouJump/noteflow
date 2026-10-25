/** Type surface for the JS ports in src/lib (they stay plain JS until M4). */

export function resizeBicubic(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  channels: number
): Uint8Array

export function grayFromRgb(rgb: Uint8Array, width: number, height: number): Uint8Array

export function clahe(
  gray: Uint8Array,
  width: number,
  height: number,
  tilesX?: number,
  tilesY?: number,
  clipLimit?: number
): Uint8Array

export function claheLuts(
  gray: Uint8Array,
  width: number,
  height: number,
  tilesX: number,
  tilesY: number,
  clipLimit: number,
  histSize?: number
): {
  luts: Uint8Array
  padded: { data: Uint8Array, width: number, height: number }
  tileW: number
  tileH: number
  limit: number
  histSize: number
}
