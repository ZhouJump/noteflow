/**
 * HOMR's noise_filtering.py: a grid of 20x20 cells over the staff mask, a Laplacian
 * noise estimate per cell, and a mask that drops the cells which are both noisy and
 * next to another noisy cell.
 *
 * On a normal scan this filters nothing at all, but it is cheap and a badly lit photo
 * does rely on it.
 */

import { filter2D } from '../vision/filters'
import { IMAGE_NOISE_LIMIT } from './constants'
import type { InputMasks } from './masks'

const LAPLACIAN = {
  width: 3,
  height: 3,
  values: [1, -2, 1, -2, 4, -2, 1, -2, 1]
}

/** estimate_noise: mean absolute Laplacian response over the tile. */
export function estimateNoise(gray: Uint8Array, width: number, height: number): number {
  const filtered = filter2D(gray, width, height, LAPLACIAN)
  let total = 0
  for (let i = 0; i < filtered.length; i += 1) total += Math.abs(filtered[i])
  return total / (width * height)
}

export interface NoiseGrid {
  /** Truncated to uint8 per cell, like the numpy assignment. */
  cells: Uint8Array
  columns: number
  rows: number
  rowStep: number
  columnStep: number
}

/** create_grid */
export function createGrid(
  gray: Uint8Array,
  width: number,
  height: number
): NoiseGrid {
  const rowStep = Math.floor(height / 20)
  const columnStep = Math.floor(width / 20)
  const rows = Math.ceil(height / rowStep)
  const columns = Math.ceil(width / columnStep)
  const cells = new Uint8Array(rows * columns)

  const tile = new Uint8Array(rowStep * columnStep)
  for (let i = 0; i < rows; i += 1) {
    const y1 = i * rowStep
    const y2 = Math.min(y1 + rowStep, height)
    for (let j = 0; j < columns; j += 1) {
      const x1 = j * columnStep
      const x2 = Math.min(x1 + columnStep, width)
      const tileWidth = x2 - x1
      const tileHeight = y2 - y1
      for (let y = 0; y < tileHeight; y += 1) {
        const source = (y1 + y) * width + x1
        const target = y * tileWidth
        for (let x = 0; x < tileWidth; x += 1) tile[target + x] = gray[source + x]
      }
      // The cast to the uint8 grid truncates, like numpy does on assignment.
      cells[i * columns + j] = Math.trunc(estimateNoise(tile, tileWidth, tileHeight))
    }
  }
  return { cells, columns, rows, rowStep, columnStep }
}

function neighbors(grid: NoiseGrid, i: number, j: number): number[] {
  const values: number[] = []
  const { cells, columns, rows } = grid
  if (i > 0) values.push(cells[(i - 1) * columns + j])
  if (j > 0) values.push(cells[i * columns + j - 1])
  if (i < rows - 1) values.push(cells[(i + 1) * columns + j])
  if (j < columns - 1) values.push(cells[i * columns + j + 1])
  return values
}

export interface NoiseFilterResult {
  /** null when HOMR decides the filtering would remove too much of the page. */
  mask: Uint8Array | null
  filteredCells: number
  totalCells: number
}

/** create_noise_grid + apply_noise_filter + handle_filter_results */
export function createNoiseGrid(
  gray: Uint8Array,
  width: number,
  height: number
): NoiseFilterResult {
  const grid = createGrid(gray, width, height)
  const mask = new Uint8Array(width * height)
  let filteredCells = 0
  let totalCells = 0

  for (let i = 0; i < grid.rows; i += 1) {
    const y1 = i * grid.rowStep
    const y2 = Math.min(y1 + grid.rowStep, height)
    for (let j = 0; j < grid.columns; j += 1) {
      const x1 = j * grid.columnStep
      const x2 = Math.min(x1 + grid.columnStep, width)
      const noise = grid.cells[i * grid.columns + j]
      const anyNeighborAboveLimit = neighbors(grid, i, j).some(
        value => value > IMAGE_NOISE_LIMIT
      )
      if (noise > IMAGE_NOISE_LIMIT && anyNeighborAboveLimit) {
        filteredCells += 1
      } else {
        for (let y = y1; y < y2; y += 1) {
          mask.fill(1, y * width + x1, y * width + x2)
        }
      }
      totalCells += 1
    }
  }

  if (filteredCells / totalCells > 0.5) return { mask: null, filteredCells, totalCells }
  if (filteredCells > 0) return { mask, filteredCells, totalCells }
  return { mask: null, filteredCells, totalCells }
}

/** filter_predictions: every mask is ANDed with the noise mask when there is one. */
export function filterPredictions(
  masks: InputMasks,
  width: number,
  height: number
): { masks: InputMasks, filteredCells: number, totalCells: number } {
  const result = createNoiseGrid(masks.staff, width, height)
  if (!result.mask) return { masks, filteredCells: result.filteredCells, totalCells: result.totalCells }
  const mask = result.mask
  const apply = (source: Uint8Array): Uint8Array => {
    const output = new Uint8Array(source.length)
    for (let i = 0; i < source.length; i += 1) output[i] = source[i] & mask[i]
    return output
  }
  return {
    masks: {
      notehead: apply(masks.notehead),
      symbols: apply(masks.symbols),
      staff: apply(masks.staff),
      clefs_keys: apply(masks.clefs_keys),
      stems_rest: apply(masks.stems_rest)
    },
    filteredCells: result.filteredCells,
    totalCells: result.totalCells
  }
}
