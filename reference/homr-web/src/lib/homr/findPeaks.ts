/**
 * HOMR's find_peaks.py: a scipy-free peak finder with the same filter chain.
 *
 * The only caller is the staff line search, which peaks on the rows of a vertical
 * slice that carry the most ink. The port keeps HOMR's quirks: a plateau yields one
 * peak at its midpoint, `distance` keeps the tallest peak first, and ties in that
 * ordering keep numpy's reversed discovery order.
 */

export interface PeakOptions {
  /** Minimum value a peak must reach. */
  height?: number;
  /** Minimum distance between two kept peaks, in samples. */
  distance?: number;
  /** Minimum height above the lower of the two surrounding minima. */
  prominence?: number;
}

export function findPeaks(x: ArrayLike<number>, options: PeakOptions = {}): number[] {
  const length = x.length;
  if (length < 3) return [];

  const peaks: number[] = [];
  let i = 1;
  while (i < length - 1) {
    if (x[i] > x[i - 1]) {
      let j = i;
      while (j < length - 1 && x[j] === x[j + 1]) j += 1;
      if (j < length - 1 && x[j] > x[j + 1]) {
        peaks.push(Math.floor((i + j) / 2));
        i = j + 1;
      } else {
        i = j + 1;
      }
    } else if (x[i] === x[i - 1]) {
      let j = i;
      while (j < length - 1 && x[j] === x[j + 1]) j += 1;
      if (j < length - 1 && x[j] > x[j + 1]) peaks.push(Math.floor((i + j) / 2));
      i = j + 1;
    } else {
      i += 1;
    }
  }

  let kept = peaks;
  if (options.height !== undefined) {
    kept = kept.filter((peak) => x[peak] >= (options.height as number));
  }
  if (kept.length === 0) return [];

  if (options.prominence !== undefined) {
    const prominence = options.prominence;
    kept = kept.filter((peak) => {
      let leftMin = x[peak];
      for (let k = peak - 1; k >= 0; k -= 1) {
        if (x[k] > x[peak]) break;
        leftMin = Math.min(leftMin, x[k]);
      }
      let rightMin = x[peak];
      for (let k = peak + 1; k < length; k += 1) {
        if (x[k] > x[peak]) break;
        rightMin = Math.min(rightMin, x[k]);
      }
      return x[peak] - Math.max(leftMin, rightMin) >= prominence;
    });
  }
  if (kept.length === 0) return [];

  if (options.distance !== undefined && kept.length > 1) {
    const distance = options.distance;
    // np.argsort(values)[::-1]: ascending and stable, then flipped, so equal heights
    // come back in reverse discovery order.
    const order = kept.map((_, index) => index).sort((a, b) => x[kept[a]] - x[kept[b]] || a - b);
    const byHeight = order.reverse().map((index) => kept[index]);
    const keep: number[] = [];
    for (const peak of byHeight) {
      if (keep.length === 0 || keep.every((other) => Math.abs(other - peak) >= distance)) {
        keep.push(peak);
      }
    }
    kept = keep.sort((a, b) => a - b);
  }

  return kept;
}
