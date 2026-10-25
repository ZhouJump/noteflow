/**
 * HOMR's brace_dot_detection.py: the braces, brackets and grand staff lines that join
 * two staffs.
 *
 * The symbols mask minus the staff mask leaves everything that sits between the staffs
 * but is not a staff line. Eroding with a 1x5 kernel drops the remains of horizontal
 * lines, dilating with 5x35 makes the tall elements big enough to survive the size
 * filter, and the rest is a search for symbols that touch both staffs at the left edge,
 * at a bar line or at a staff line.
 *
 * Verified against HOMR per stage: see scripts/check-staffs.mjs.
 */

import { dilate, ellipseKernel, erode } from '../vision/morphology'
import type { RotatedBoundingBox } from './boundingBoxes'
import {
  MINIMUM_CONNECTIONS_TO_FORM_COMBINED_STAFF,
  maxWidthForBraceRough,
  minHeightForBrace,
  minHeightForBraceRough,
  toleranceForStaffAtAnyPoint,
  toleranceForTouchingClefs
} from './constants'
import { MultiStaff, type Staff } from './model'
import type { BinaryImage } from './staffDetection'

/**
 * prepare_brace_dot_image: `cv2.subtract(symbols, staff)` keeps only the symbols that
 * are not staff ink, then the two morphological passes drop anything thin and short.
 */
export function prepareBraceDotImage(
  symbols: BinaryImage,
  staff: BinaryImage
): Uint8Array {
  const braceDot = new Uint8Array(symbols.binary.length)
  for (let i = 0; i < braceDot.length; i += 1) {
    // cv2.subtract saturates at zero, so a staff pixel never subtracts a symbol.
    braceDot[i] = symbols.binary[i] && !staff.binary[i] ? 1 : 0
  }
  const eroded = erode(
    braceDot,
    symbols.width,
    symbols.height,
    ellipseKernel(1, 5)
  )
  return dilate(eroded, symbols.width, symbols.height, ellipseKernel(5, 35))
}

/**
 * Two step filter: a rough unit size first to shrink the list, then the unit size of the
 * closest staff so that the warping of the page is taken into account.
 */
export function filterForTallElements(
  braceDot: RotatedBoundingBox[],
  staffs: Staff[]
): RotatedBoundingBox[] {
  const roughUnitSize = staffs[0].averageUnitSize
  const symbolsLargerThanRoughEstimate = braceDot.filter(
    symbol =>
      symbol.size[1] > minHeightForBraceRough(roughUnitSize)
      && symbol.size[0] < maxWidthForBraceRough(roughUnitSize)
  )

  const result: RotatedBoundingBox[] = []
  for (const symbol of symbolsLargerThanRoughEstimate) {
    // `min` keeps the first staff on a tie.
    let closestStaff = staffs[0]
    let closestDistance = closestStaff.yDistanceTo(symbol.center)
    for (const staff of staffs) {
      const distance = staff.yDistanceTo(symbol.center)
      if (distance < closestDistance) {
        closestDistance = distance
        closestStaff = staff
      }
    }
    if (symbol.size[1] > minHeightForBrace(closestStaff.averageUnitSize)) {
      result.push(symbol)
    }
  }
  return result
}

export function getConnectionsBetweenStaffsAtBarLines(
  staff1: Staff,
  staff2: Staff,
  braceDot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const barLines1 = staff1.getBarLines()
  const barLines2 = staff2.getBarLines()
  const result: RotatedBoundingBox[] = []
  for (const symbol of braceDot) {
    const symbolThicker = symbol.makeBoxThicker(30)
    const firstOverlappingStaff1 = barLines1.filter(line =>
      symbolThicker.isOverlapping(line.box)
    )
    const firstOverlappingStaff2 = barLines2.filter(line =>
      symbolThicker.isOverlapping(line.box)
    )
    if (firstOverlappingStaff1.length >= 1 && firstOverlappingStaff2.length >= 1) {
      result.push(symbol)
    }
  }
  return result
}

export function getConnectionsBetweenStaffsAtClefs(
  staff1: Staff,
  staff2: Staff,
  braceDot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const clefs1 = staff1.getClefs()
  const clefs2 = staff2.getClefs()
  const result: RotatedBoundingBox[] = []
  for (const symbol of braceDot) {
    const symbolThicker = symbol.makeBoxThicker(
      toleranceForStaffAtAnyPoint(staff1.averageUnitSize)
    )
    const firstOverlappingStaff1 = clefs1.filter(clef =>
      symbolThicker.isOverlapping(clef.box)
    )
    const firstOverlappingStaff2 = clefs2.filter(clef =>
      symbolThicker.isOverlapping(clef.box)
    )
    if (firstOverlappingStaff1.length >= 1 && firstOverlappingStaff2.length >= 1) {
      result.push(symbol)
    }
  }
  return result
}

/** A connection at the staff lines: the symbol has to touch both staffs' slices. */
export function getConnectionsBetweenStaffsAtLines(
  staff1: Staff,
  staff2: Staff,
  braceDot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = []
  for (const symbol of braceDot) {
    const symbolThicker = symbol.makeBoxThicker(
      toleranceForTouchingClefs(staff1.averageUnitSize)
    )
    const point1 = staff1.getAt(symbol.center.x)
    const point2 = staff2.getAt(symbol.center.x)
    if (point1 === null || point2 === null) continue
    if (
      symbolThicker.isOverlapping(point1.toBoundingBox())
      && symbolThicker.isOverlapping(point2.toBoundingBox())
    ) {
      result.push(symbol)
    }
  }
  return result
}

export function getConnectionsBetweenStaffs(
  staff1: Staff,
  staff2: Staff,
  braceDot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = []
  result.push(...getConnectionsBetweenStaffsAtBarLines(staff1, staff2, braceDot))
  result.push(...getConnectionsBetweenStaffsAtClefs(staff1, staff2, braceDot))
  result.push(...getConnectionsBetweenStaffsAtLines(staff1, staff2, braceDot))
  return result
}

/** If two MultiStaff objects share a staff, merge them into one. */
export function mergeMultiStaffIfTheyShareAStaff(staffs: MultiStaff[]): MultiStaff[] {
  const result: MultiStaff[] = []
  for (const staff of staffs) {
    let anyMerged = false
    for (const existing of [...result]) {
      // `set(staff.staffs)` compares Staff by identity, not by grid.
      if (staff.staffs.some(entry => existing.staffs.includes(entry))) {
        result.splice(result.indexOf(existing), 1)
        result.push(existing.merge(staff))
        anyMerged = true
        break
      }
    }
    if (!anyMerged) result.push(staff)
  }
  return result
}

export function createGrandstaffs(
  staffs: MultiStaff[],
  braceDot: RotatedBoundingBox[]
): MultiStaff[] {
  if (staffs.length === 0) return staffs
  return staffs.map(staff => staff.createGrandstaffs(braceDot))
}

/**
 * Connect staffs from multiple voices or grand staffs by searching for brackets and
 * grand staff lines. Every staff is paired with each neighbour it shares a symbol with.
 */
export function findBracesBracketsAndGrandStaffLines(
  staffs: Staff[],
  braceDot: RotatedBoundingBox[]
): MultiStaff[] {
  const tallElements = filterForTallElements(braceDot, staffs)
  const result: MultiStaff[] = []
  for (let i = 0; i < staffs.length; i += 1) {
    const neighbors: Staff[] = []
    if (i > 0) neighbors.push(staffs[i - 1])
    if (i < staffs.length - 1) neighbors.push(staffs[i + 1])

    let anyConnectedNeighbor = false
    for (const neighbor of neighbors) {
      const connections = getConnectionsBetweenStaffs(staffs[i], neighbor, tallElements)
      if (connections.length >= MINIMUM_CONNECTIONS_TO_FORM_COMBINED_STAFF) {
        result.push(new MultiStaff([staffs[i], neighbor], connections))
        anyConnectedNeighbor = true
      }
    }
    if (!anyConnectedNeighbor) result.push(new MultiStaff([staffs[i]], []))
  }

  return createGrandstaffs(mergeMultiStaffIfTheyShareAStaff(result), tallElements)
}
