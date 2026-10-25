/**
 * The parts of HOMR's model.py the segmentation pipeline builds: a staff grid, the
 * notes and bar lines that get placed on it, and the grand staff grouping.
 *
 * A `StaffPoint` is one vertical slice through a staff: five (or ten, for a grand
 * staff) line y positions and the angle of the slice. `Staff` is the list of those
 * slices plus everything the later stages attach to it. `MultiStaff` groups the staffs
 * a brace or bracket connects.
 *
 * Verified against HOMR per staff: see scripts/check-notes.mjs and check-staffs.mjs.
 */

import type { Point } from '../vision/contours'
import {
  BoundingBox,
  boxKey,
  type AngledBoundingBox,
  type BoundingEllipse,
  type RotatedBoundingBox
} from './boundingBoxes'
import {
  GRANDSTAFF_X_DISTANCE_THRESHOLD_FACTOR,
  GRANDSTAFF_Y_OVERLAP_THRESHOLD_FACTOR,
  MAX_NUMBER_OF_LEDGER_LINES,
  NUMBER_OF_LINES_ON_A_STAFF,
  STAFF_POSITION_TOLERANCE
} from './constants'
import { diff, mean, median, pyRound } from './numeric'

export type StemDirection = 'UP' | 'DOWN'

/** SymbolOnStaff: anything the XML generator places at a position on a staff. */
export abstract class SymbolOnStaff {
  center: Point

  protected constructor(center: Point) {
    this.center = center
  }

  /** HOMR's abstract `copy`, used by `transform_coordinates`. */
  abstract copy(): SymbolOnStaff

  transformCoordinates(transformation: (point: Point) => Point): SymbolOnStaff {
    const copy = this.copy()
    copy.center = transformation(this.center)
    return copy
  }
}

export class Note extends SymbolOnStaff {
  readonly box: BoundingEllipse
  readonly position: number
  readonly stem: RotatedBoundingBox | null
  readonly stemDirection: StemDirection | null
  /** `vnote-<n>`, only used to name the note in debug output. */
  readonly visualId: string | null
  readonly splitClumpId: string | null
  readonly splitClumpBounds: [number, number, number, number] | null
  hasDot = false
  circleOfFifth = 0
  beams: RotatedBoundingBox[] = []
  flags: RotatedBoundingBox[] = []

  constructor(
    box: BoundingEllipse,
    position: number,
    stem: RotatedBoundingBox | null,
    stemDirection: StemDirection | null,
    visualId: string | null,
    splitClumpId: string | null = null,
    splitClumpBounds: [number, number, number, number] | null = null
  ) {
    super(box.center)
    this.box = box
    this.position = position
    this.stem = stem
    this.stemDirection = stemDirection
    this.visualId = visualId
    this.splitClumpId = splitClumpId
    this.splitClumpBounds = splitClumpBounds
  }

  copy(): Note {
    const result = new Note(
      this.box,
      this.position,
      this.stem,
      this.stemDirection,
      this.visualId,
      this.splitClumpId,
      this.splitClumpBounds
    )
    result.hasDot = this.hasDot
    result.circleOfFifth = this.circleOfFifth
    result.beams = [...this.beams]
    result.flags = [...this.flags]
    return result
  }
}

export class BarLine extends SymbolOnStaff {
  readonly box: RotatedBoundingBox

  constructor(box: RotatedBoundingBox) {
    super(box.center)
    this.box = box
  }

  copy(): BarLine {
    return new BarLine(this.box)
  }
}

export class Clef extends SymbolOnStaff {
  readonly box: BoundingBox

  constructor(box: BoundingBox) {
    super(box.center)
    this.box = box
  }

  copy(): Clef {
    return new Clef(this.box)
  }
}

export class StaffPoint {
  readonly x: number
  readonly y: number[]
  readonly angle: number
  /** Mean distance between two staff lines at this slice. */
  readonly averageUnitSize: number

  constructor(x: number, y: number[], angle: number) {
    if (y.length % NUMBER_OF_LINES_ON_A_STAFF !== 0) {
      throw new Error('A staff must consist of 5, 10, ... lines')
    }
    this.x = x
    this.y = y
    this.angle = angle
    this.averageUnitSize = mean(diff(y))
  }

  /**
   * Which staff position the notehead sits on: 2 per line step, 1 per space step,
   * counted from the bottom line. `round` is Python's, so it halves to even.
   */
  findPositionInUnitSizes(box: AngledBoundingBox): number {
    const centerY = box.center.y
    let closest = 0
    let closestDistance = Infinity
    for (let i = 0; i < this.y.length; i += 1) {
      const distance = Math.abs(this.y[i] - centerY)
      if (distance < closestDistance) {
        closestDistance = distance
        closest = i
      }
    }
    const distance = this.y[closest] - centerY
    const distanceInUnitSizes = pyRound((2 * distance) / this.averageUnitSize)
    return 2 * (this.y.length - closest) + distanceInUnitSizes - 1
  }

  /** Join two slices at the same x into one with both sets of staff lines. */
  merge(other: StaffPoint): StaffPoint {
    if (Math.abs(this.x - other.x) > 1e-3) {
      throw new Error('Can\'t merge points at different positions')
    }
    const y = [...this.y, ...other.y].sort((a, b) => a - b)
    return new StaffPoint(this.x, y, (this.angle + other.angle) / 2)
  }

  /** The dewarping stage moves every grid point and keeps the mean x of the slice. */
  transformCoordinates(transformation: (point: Point) => Point): StaffPoint {
    const transformed = this.y.map(y => transformation({ x: this.x, y }))
    const averageX = mean(transformed.map(point => point.x))
    return new StaffPoint(averageX, transformed.map(point => point.y), this.angle)
  }

  /**
   * The slice as a zero width `BoundingBox`. The brace search tests whether a thickened
   * brace symbol overlaps this line at the symbol's x position.
   */
  toBoundingBox(): BoundingBox {
    return new BoundingBox(
      [
        Math.trunc(this.x),
        Math.trunc(this.y[0]),
        Math.trunc(this.x),
        Math.trunc(this.y[this.y.length - 1])
      ],
      [],
      -2
    )
  }
}

export class Staff {
  readonly grid: StaffPoint[]
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly averageUnitSize: number
  symbols: SymbolOnStaff[] = []
  isGrandStaff = false
  private readonly yTolerance: number

  constructor(grid: StaffPoint[]) {
    this.grid = grid
    this.minX = grid[0].x
    this.maxX = grid[grid.length - 1].x
    this.minY = Math.min(...grid.map(point => Math.min(...point.y)))
    this.maxY = Math.max(...grid.map(point => Math.max(...point.y)))
    this.averageUnitSize = median(grid.map(point => point.averageUnitSize))
    this.yTolerance = MAX_NUMBER_OF_LEDGER_LINES * this.averageUnitSize
  }

  addSymbol(symbol: SymbolOnStaff): void {
    this.symbols.push(symbol)
  }

  /**
   * Combine two staffs into a grand staff. Only x positions both staves know are kept,
   * unless enough of them are shared to extrapolate the missing side from the median
   * line offsets; that is what lets one partially detected stave stay complete.
   */
  merge(other: Staff): Staff {
    const gridA = new Map<number, StaffPoint>()
    for (const point of this.grid) gridA.set(Math.trunc(pyRound(point.x)), point)
    const gridB = new Map<number, StaffPoint>()
    for (const point of other.grid) gridB.set(Math.trunc(pyRound(point.x)), point)
    const sharedX = [...gridA.keys()].filter(x => gridB.has(x))
    const allX = [...new Set([...gridA.keys(), ...gridB.keys()])]

    const minimumSharedGridPoints = 3
    const canExtend
      = sharedX.length >= minimumSharedGridPoints
        && sharedX.every(
          x =>
            (gridA.get(x) as StaffPoint).y.length === (gridB.get(x) as StaffPoint).y.length
        )
    let lineOffsets: number[] | null = null
    let angleOffset = 0
    if (canExtend) {
      // `sorted(shared_x)` for both medians: they are accumulated in that order.
      const shared = [...sharedX].sort((a, b) => a - b)
      const lineCount = (gridA.get(shared[0]) as StaffPoint).y.length
      lineOffsets = []
      for (let i = 0; i < lineCount; i += 1) {
        lineOffsets.push(
          median(shared.map(x => (gridA.get(x) as StaffPoint).y[i] - (gridB.get(x) as StaffPoint).y[i]))
        )
      }
      angleOffset = median(
        shared.map(x => (gridA.get(x) as StaffPoint).angle - (gridB.get(x) as StaffPoint).angle)
      )
    }

    const offsets = lineOffsets
    const grid: StaffPoint[] = []
    const xs = (offsets !== null ? allX : sharedX).sort((a, b) => a - b)
    for (const x of xs) {
      let pointA = gridA.get(x)
      let pointB = gridB.get(x)
      if (pointA === undefined && pointB !== undefined && offsets !== null) {
        pointA = new StaffPoint(
          pointB.x,
          pointB.y.map((y, i) => y + offsets[i]),
          pointB.angle + angleOffset
        )
      } else if (pointB === undefined && pointA !== undefined && offsets !== null) {
        pointB = new StaffPoint(
          pointA.x,
          pointA.y.map((y, i) => y - offsets[i]),
          pointA.angle - angleOffset
        )
      }
      if (pointA !== undefined && pointB !== undefined) grid.push(pointA.merge(pointB))
    }

    const result = new Staff(grid)
    result.symbols.push(...this.symbols, ...other.symbols)
    result.isGrandStaff = true
    return result
  }

  /** The grid slice at `x`, or null when the nearest slice is further off than 50 px. */
  getAt(x: number): StaffPoint | null {
    let closest = this.grid[0]
    let closestDistance = Math.abs(closest.x - x)
    for (const point of this.grid) {
      const distance = Math.abs(point.x - x)
      if (distance < closestDistance) {
        closest = point
        closestDistance = distance
      }
    }
    return closestDistance > STAFF_POSITION_TOLERANCE ? null : closest
  }

  /** Distance from `point` to the closest staff line of the slice at `point.x`. */
  yDistanceTo(point: Point): number {
    const staffPoint = this.getAt(point.x)
    if (staffPoint === null) return 1e10 // Something large to mimic infinity
    let closest = Infinity
    for (const y of staffPoint.y) closest = Math.min(closest, Math.abs(y - point.y))
    return closest
  }

  /** Is the item close enough to the staff to be part of it, ledger lines included? */
  isOnStaffZone(item: AngledBoundingBox): boolean {
    const point = this.getAt(item.center.x)
    if (point === null) return false
    const y = item.center.y
    return !(y > point.y[point.y.length - 1] + this.yTolerance || y < point.y[0] - this.yTolerance)
  }

  getNotes(): Note[] {
    return this.symbols.filter((symbol): symbol is Note => symbol instanceof Note)
  }

  getBarLines(): BarLine[] {
    return this.symbols.filter((symbol): symbol is BarLine => symbol instanceof BarLine)
  }

  getClefs(): Clef[] {
    return this.symbols.filter((symbol): symbol is Clef => symbol instanceof Clef)
  }

  /** Stretch the grid horizontally, keeping the y positions of the end slices. */
  extendToXRange(minX: number, maxX: number): Staff {
    const grid = [...this.grid]
    if (minX >= 0 && minX < grid[0].x) {
      grid.unshift(new StaffPoint(minX, grid[0].y, grid[0].angle))
    }
    if (maxX >= 0 && maxX > grid[grid.length - 1].x) {
      grid.push(
        new StaffPoint(maxX, grid[grid.length - 1].y, grid[grid.length - 1].angle)
      )
    }
    return new Staff(grid)
  }

  getNumberOfNotes(): number {
    return this.getNotes().length
  }

  getAllExceptNotes(): SymbolOnStaff[] {
    return this.symbols.filter(symbol => !(symbol instanceof Note))
  }

  /** A fresh staff over the same grid, with no symbols attached yet. */
  copy(): Staff {
    return new Staff(this.grid)
  }

  transformCoordinates(transformation: (point: Point) => Point): Staff {
    const copy = new Staff(this.grid.map(point => point.transformCoordinates(transformation)))
    copy.symbols = this.symbols.map(symbol => symbol.transformCoordinates(transformation))
    copy.isGrandStaff = this.isGrandStaff
    return copy
  }
}

/** A staff pair a brace or bracket joins, with the score that selected it. */
export interface GrandStaffPair {
  pairIndex: [number, number]
  score: number
}

/**
 * A grand staff or a staff with multiple voices.
 *
 * `create_grandstaffs` scores every adjacent staff pair against all brace/dot symbols;
 * the brace has to sit close to the left edge and overlap both staffs vertically. The
 * best pairs are then merged greedily, so a staff is never used twice.
 */
export class MultiStaff {
  readonly staffs: Staff[]
  readonly connections: RotatedBoundingBox[]

  constructor(staffs: Staff[], connections: RotatedBoundingBox[]) {
    // Python's sorted() is stable, so staffs with an equal min_y keep their order.
    this.staffs = [...staffs].sort((a, b) => a.minY - b.minY)
    this.connections = connections
  }

  merge(other: MultiStaff): MultiStaff {
    // `staff not in unique_staffs` compares Staff by identity, connections by box value.
    const uniqueStaffs: Staff[] = []
    for (const staff of [...this.staffs, ...other.staffs]) {
      if (!uniqueStaffs.includes(staff)) uniqueStaffs.push(staff)
    }
    const uniqueConnections: RotatedBoundingBox[] = []
    const seen = new Set<string>()
    for (const connection of [...this.connections, ...other.connections]) {
      const key = boxKey(connection)
      if (seen.has(key)) continue
      seen.add(key)
      uniqueConnections.push(connection)
    }
    return new MultiStaff(uniqueStaffs, uniqueConnections)
  }

  private scoreBraceWithStaffPair(
    symbol: RotatedBoundingBox,
    upperStaff: Staff,
    lowerStaff: Staff
  ): number {
    const unitSize = median([upperStaff.averageUnitSize, lowerStaff.averageUnitSize])
    const xDistanceThreshold = GRANDSTAFF_X_DISTANCE_THRESHOLD_FACTOR * unitSize
    const yOverlapThreshold = GRANDSTAFF_Y_OVERLAP_THRESHOLD_FACTOR * symbol.size[1]

    const symbolMinX = symbol.center.x
    const staffMinX = Math.min(upperStaff.minX, lowerStaff.minX)
    const xDistance = Math.abs(staffMinX - symbolMinX)

    const symbolMinY = symbol.center.y - symbol.size[1] / 2
    const symbolMaxY = symbol.center.y + symbol.size[1] / 2
    const yOverlap = Math.min(symbolMaxY, lowerStaff.maxY) - Math.max(symbolMinY, upperStaff.minY)

    if (
      xDistance < xDistanceThreshold
      && yOverlap > yOverlapThreshold
      && yOverlap > xDistance
    ) {
      return yOverlap - xDistance
    }
    return 0
  }

  private selectGrandstaffs(braceDot: RotatedBoundingBox[]): GrandStaffPair[] {
    const pairScores: GrandStaffPair[] = []
    for (let i = 0; i < this.staffs.length - 1; i += 1) {
      let bestScore = 0
      for (const symbol of braceDot) {
        bestScore = Math.max(
          bestScore,
          this.scoreBraceWithStaffPair(symbol, this.staffs[i], this.staffs[i + 1])
        )
      }
      if (bestScore > 0) pairScores.push({ pairIndex: [i, i + 1], score: bestScore })
    }

    // Greedy by score, so a staff that appears in two pairs only keeps the better one.
    const result: GrandStaffPair[] = []
    const usedStaffIndex = new Set<number>()
    for (const pair of [...pairScores].sort((a, b) => b.score - a.score)) {
      if (pair.pairIndex.some(index => usedStaffIndex.has(index))) continue
      result.push(pair)
      for (const index of pair.pairIndex) usedStaffIndex.add(index)
    }
    return result
  }

  private mergeSelectedPairs(pairs: GrandStaffPair[]): Staff[] {
    const result: Staff[] = []
    let i = 0
    while (i < this.staffs.length) {
      if (pairs.some(pair => pair.pairIndex.includes(i))) {
        result.push(this.staffs[i].merge(this.staffs[i + 1]))
        i += 2
        continue
      }
      // not grandstaff
      result.push(this.staffs[i])
      i += 1
    }
    return result
  }

  createGrandstaffs(braceDot: RotatedBoundingBox[]): MultiStaff {
    if (this.staffs.length < 2) return this
    const pairs = this.selectGrandstaffs(braceDot)
    if (pairs.length === 0) return this
    const mergedStaffs = this.mergeSelectedPairs(pairs)
    return new MultiStaff(mergedStaffs, this.connections)
  }

  breakApart(): MultiStaff[] {
    return this.staffs.map(staff => new MultiStaff([staff], []))
  }
}
