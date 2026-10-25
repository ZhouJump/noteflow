/**
 * Small dense linear algebra for the cv2 primitives: symmetric eigen decomposition
 * (cyclic Jacobi) and least squares through the normal equations.
 *
 * Everything here is double precision. cv2 mixes float and double internally; for
 * the fits below the difference stays far below the four decimals the reference
 * artefacts are rounded to.
 */

export interface Eigen {
  values: number[]
  /** `vectors[column]` belongs to `values[column]`. */
  vectors: number[][]
}

/** Jacobi rotations on a symmetric matrix; eigenvalues come back in descending order. */
export function symmetricEigen(matrix: number[][]): Eigen {
  const n = matrix.length
  const a = matrix.map(row => row.slice())
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  )

  for (let sweep = 0; sweep < 64; sweep += 1) {
    let off = 0
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) off += a[i][j] * a[i][j]
    }
    if (off < 1e-26) break
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p][q]
        if (Math.abs(apq) < 1e-20) continue
        const theta = (a[q][q] - a[p][p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i])
  return {
    values: order.map(i => a[i][i]),
    vectors: order.map(i => v.map(row => row[i]))
  }
}

/**
 * Least-squares solution of `rows * x = rhs` through the normal equations. This is
 * cv2's `solve(..., DECOMP_SVD)` for the shapes the ellipse fit uses, except that
 * rank-deficient directions are dropped instead of being solved in the least-norm
 * sense; the fits are always well determined in practice.
 */
export function leastSquares(rows: number[][], rhs: number[], relativeTolerance = 1e-13): number[] {
  const m = rows.length
  const k = rows[0].length
  const ata: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0))
  const atb = new Array<number>(k).fill(0)
  for (let i = 0; i < m; i += 1) {
    const row = rows[i]
    const value = rhs[i]
    for (let a = 0; a < k; a += 1) {
      atb[a] += row[a] * value
      for (let b = a; b < k; b += 1) ata[a][b] += row[a] * row[b]
    }
  }
  for (let a = 0; a < k; a += 1) {
    for (let b = 0; b < a; b += 1) ata[a][b] = ata[b][a]
  }

  const { values, vectors } = symmetricEigen(ata)
  const largest = Math.max(...values.map(Math.abs))
  const result = new Array<number>(k).fill(0)
  for (let i = 0; i < k; i += 1) {
    if (values[i] <= 0 || values[i] < largest * relativeTolerance) continue
    const vector = vectors[i]
    let projection = 0
    for (let a = 0; a < k; a += 1) projection += vector[a] * atb[a]
    const coefficient = projection / values[i]
    for (let a = 0; a < k; a += 1) result[a] += coefficient * vector[a]
  }
  return result
}

/** Solve a 2x2 system the way cv2's DECOMP_SVD does for well conditioned input. */
export function solve2x2(
  a: number,
  b: number,
  c: number,
  d: number,
  r0: number,
  r1: number
): [number, number] {
  const determinant = a * d - b * c
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d))
  if (scale === 0 || Math.abs(determinant) < 1e-14 * scale * scale) return [0, 0]
  return [(d * r0 - b * r1) / determinant, (a * r1 - c * r0) / determinant]
}
