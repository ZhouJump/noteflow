/**
 * The scalar helpers the port needs to match numpy, Python builtins and cv2.
 */

/** Python's round(): halves go to the even neighbour, also for negative values. */
export function pyRound(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** np.median: the middle value, or the mean of the two middle values. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

/** np.mean */
export function mean(values: number[]): number {
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

/** np.diff */
export function diff(values: number[]): number[] {
  const result: number[] = []
  for (let i = 1; i < values.length; i += 1) result.push(values[i] - values[i - 1])
  return result
}
