/**
 * HOMR's staff_detection.py: turn the staff line fragments into a staff grid.
 *
 * The staffs are found in two passes. First, `find_staff_anchors` looks for five
 * parallel fragments next to a clef or a bar line, which is what makes a group of
 * fragments trustworthy. `connect_staff_lines` then grows those fragments along the
 * page by extrapolating each line's centre, and `resample_staff` walks the resulting
 * raw staffs every 10 px to produce the `Staff` grid the rest of the pipeline uses.
 *
 * Two details are easy to get wrong and are kept verbatim:
 *
 *   - `resample_staff` derives the next start from `range().stop`, not from the last
 *     value it emitted, and `round_to_density` rounds like Python.
 *   - `resample_staff_segment` indexes the uncompressed `axis_center` with deltas
 *     computed from the compressed non-None values. That off-by-None is HOMR's, and
 *     the downstream numbers depend on it.
 *
 * Verified against HOMR per stage: see scripts/check-staffs.mjs.
 */

import type { Point } from '../vision/contours.ts';
import { minAreaRect } from '../vision/rect.ts';
import {
  RotatedBoundingBox,
  boxKey,
  createRotatedBoundingBox,
} from './boundingBoxes.ts';
import {
  MAX_ANGLE_FOR_LINES_TO_BE_PARALLEL,
  NUMBER_OF_LINES_ON_A_STAFF,
  STAFF_LINE_SEGMENT_X_TOLERANCE,
  isShortConnectedLine,
  isShortLine,
  maxLineGapSize,
} from './constants.ts';
import { findPeaks } from './findPeaks.ts';
import { Staff, StaffPoint } from './model.ts';
import { diff, mean, median, pyRound } from './numeric.ts';

/** A 0/1 image, the shape the masks and the morphology helpers use. */
export interface BinaryImage {
  binary: Uint8Array;
  width: number;
  height: number;
}

/** Python's `range(start, stop)`: stop is exclusive and kept even for an empty range. */
interface IntRange {
  start: number;
  stop: number;
}

function makeRange(start: number, stop: number): IntRange {
  return { start, stop };
}

function rangeValues(range: IntRange, step: number): number[] {
  const values: number[] = [];
  if (step > 0) {
    for (let value = range.start; value < range.stop; value += step) values.push(value);
  } else {
    for (let value = range.start; value > range.stop; value += step) values.push(value);
  }
  return values;
}

function populationStd(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export class StaffLineSegment {
  readonly debugId: number;
  readonly staffFragments: RotatedBoundingBox[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;

  constructor(debugId: number, staffFragments: RotatedBoundingBox[]) {
    this.debugId = debugId;
    // Sorted by the normalised box centre x, which is a stable sort in Python too.
    this.staffFragments = [...staffFragments].sort((a, b) => a.box.center.x - b.box.center.x);
    this.minX = Math.min(...staffFragments.map((line) => line.center.x - line.size[0] / 2));
    this.maxX = Math.max(...staffFragments.map((line) => line.center.x + line.size[0] / 2));
    this.minY = Math.min(...staffFragments.map((line) => line.center.y - line.size[1] / 2));
    this.maxY = Math.max(...staffFragments.map((line) => line.center.y + line.size[1] / 2));
  }

  /** Union of both fragment lists, compared by box value like HOMR's `not in`. */
  merge(other: StaffLineSegment): StaffLineSegment {
    const staffLines = [...this.staffFragments];
    const seen = new Set(staffLines.map(boxKey));
    for (const fragment of other.staffFragments) {
      const key = boxKey(fragment);
      if (seen.has(key)) continue;
      seen.add(key);
      staffLines.push(fragment);
    }
    return new StaffLineSegment(this.debugId, staffLines);
  }

  getAt(x: number): RotatedBoundingBox | null {
    const tolerance = STAFF_LINE_SEGMENT_X_TOLERANCE;
    for (const fragment of this.staffFragments) {
      if (
        x >= fragment.center.x - fragment.size[0] / 2 - tolerance &&
        x <= fragment.center.x + fragment.size[0] / 2 + tolerance
      ) {
        return fragment;
      }
    }
    return null;
  }

  isOverlapping(other: StaffLineSegment): boolean {
    for (const line of this.staffFragments) {
      for (const otherLine of other.staffFragments) {
        if (line.isOverlapping(otherLine)) return true;
      }
    }
    return false;
  }

  /** HOMR compares segments as `frozenset` of their fragments. */
  equals(other: StaffLineSegment): boolean {
    const own = new Set(this.staffFragments.map(boxKey));
    const theirs = new Set(other.staffFragments.map(boxKey));
    if (own.size !== theirs.size) return false;
    for (const key of own) if (!theirs.has(key)) return false;
    return true;
  }
}

export class StaffAnchor {
  readonly staffLines: StaffLineSegment[];
  readonly unitSizes: number[];
  readonly averageUnitSize: number;
  readonly symbol: RotatedBoundingBox;
  readonly maxY: number;
  readonly minY: number;
  readonly yRange: IntRange;
  readonly zone: IntRange;

  constructor(staffLines: StaffLineSegment[], symbol: RotatedBoundingBox) {
    this.staffLines = staffLines;
    const yPositions = staffLines
      .map((line) => line.staffFragments[0].getCenterExtrapolated(symbol.center.x))
      .sort((a, b) => a - b);
    const yDeltas: number[] = [];
    for (let i = 1; i < yPositions.length; i += 1) {
      yDeltas.push(Math.abs(yPositions[i] - yPositions[i - 1]));
    }
    this.unitSizes = yDeltas;
    this.averageUnitSize = yDeltas.length === 0 ? 0 : mean(yDeltas);
    this.symbol = symbol;
    this.maxY = Math.max(...staffLines.map((line) => line.maxY));
    this.minY = Math.min(...staffLines.map((line) => line.minY));
    const maxNumberOfLedgerLines = 5;
    this.yRange = {
      start: Math.trunc(Math.min(...yPositions)),
      stop: Math.trunc(Math.max(...yPositions)),
    };
    this.zone = {
      start: Math.trunc(this.minY - maxNumberOfLedgerLines * this.averageUnitSize),
      stop: Math.trunc(this.maxY + maxNumberOfLedgerLines * this.averageUnitSize),
    };
  }
}

function getAllContours(lines: StaffLineSegment[]): Point[] {
  const allFragments: RotatedBoundingBox[] = [];
  for (const line of lines) allFragments.push(...line.staffFragments);
  const result: Point[] = [];
  for (const fragment of allFragments) result.push(...fragment.contour);
  return result;
}

/** A staff made of the fragments that were found, before it is resampled. */
export class RawStaff extends RotatedBoundingBox {
  readonly staffId: number;
  readonly lines: StaffLineSegment[];
  readonly anchors: StaffAnchor[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;

  constructor(staffId: number, lines: StaffLineSegment[], anchors: StaffAnchor[]) {
    const contours = getAllContours(lines);
    super(minAreaRect(contours), contours, staffId);
    this.staffId = staffId;
    this.lines = lines;
    this.anchors = anchors;
    this.minX = this.center.x - this.size[0] / 2;
    this.maxX = this.center.x + this.size[0] / 2;
    this.minY = this.center.y - this.size[1] / 2;
    this.maxY = this.center.y + this.size[1] / 2;
  }

  merge(other: RawStaff): RawStaff {
    const lines: StaffLineSegment[] = [];
    for (let i = 0; i < this.lines.length; i += 1) {
      lines.push(other.lines[i].merge(this.lines[i]));
    }
    return new RawStaff(this.staffId, lines, [...this.anchors, ...other.anchors]);
  }
}

export function getStaffForAnchor(anchor: StaffAnchor, staffs: RawStaff[]): RawStaff | null {
  for (const staff of staffs) {
    for (let i = 0; i < anchor.staffLines.length; i += 1) {
      const requirement = new Set(anchor.staffLines[i].staffFragments.map(boxKey));
      const available = new Set(staff.lines[i].staffFragments.map(boxKey));
      let subset = true;
      for (const key of requirement) {
        if (!available.has(key)) {
          subset = false;
          break;
        }
      }
      if (subset) return staff;
    }
  }
  return null;
}

/**
 * Build the raw staffs: connect all fragments in an anchor's zone, then take the
 * connected lines that go through the anchor. A staff that already carries this
 * anchor is merged with the new lines instead of being added twice.
 */
export function findRawStaffsByConnectingLineFragments(
  anchors: StaffAnchor[],
  staffFragments: RotatedBoundingBox[],
): RawStaff[] {
  const staffs: RawStaff[] = [];
  let staffId = 0;
  for (const anchor of anchors) {
    const existingStaff = getStaffForAnchor(anchor, staffs);
    const fragments = staffFragments.filter(
      (fragment) =>
        fragment.center.y >= anchor.zone.start && fragment.center.y <= anchor.zone.stop,
    );
    const connected = connectStaffLines(fragments, anchor.averageUnitSize);
    const staffLines: StaffLineSegment[] = [];
    for (const anchorLine of anchor.staffLines) {
      const requirement = new Set(anchorLine.staffFragments.map(boxKey));
      const matchingAnchor = connected.filter((line) => {
        const available = new Set(line.staffFragments.map(boxKey));
        for (const key of requirement) if (!available.has(key)) return false;
        return true;
      });
      if (matchingAnchor.length === 1) staffLines.push(...matchingAnchor);
      else staffLines.push(anchorLine);
    }
    if (existingStaff) {
      // Python's list.remove uses RawStaff.__eq__, which compares the box value.
      const existingKey = boxKey(existingStaff);
      const index = staffs.findIndex((staff) => boxKey(staff) === existingKey);
      if (index >= 0) staffs.splice(index, 1);
      staffs.push(existingStaff.merge(new RawStaff(staffId, staffLines, [anchor])));
    } else {
      staffs.push(new RawStaff(staffId, staffLines, [anchor]));
    }
    staffId += 1;
  }
  return staffs;
}

/**
 * Sometimes the same staff is found twice but not connected. Keep the staff with the
 * most anchors; two or more overlapping staffs are all kept as they are.
 */
export function removeDuplicateStaffs(staffs: RawStaff[]): RawStaff[] {
  let result: RawStaff[] = [];
  for (const staff of staffs) {
    const overlapping = result.filter((other) => staff.isOverlapping(other));
    if (overlapping.length === 0) {
      result.push(staff);
      continue;
    }
    const staffDuplicates = 2;
    if (overlapping.length >= staffDuplicates) continue;
    if (overlapping[0].anchors.length < staff.anchors.length) {
      const duplicateKey = boxKey(overlapping[0]);
      result = result.filter((entry) => boxKey(entry) !== duplicateKey);
      result.push(staff);
    }
  }
  return result;
}

/**
 * Connect fragments into staff lines. The fragments are walked left to right and every
 * fragment is appended to *every* active line it continues, which is why one fragment
 * can end up in more than one line.
 */
export function connectStaffLines(
  staffLines: RotatedBoundingBox[],
  unitSize: number,
): StaffLineSegment[] {
  const sortedByRightToLeft = [...staffLines].sort(
    (a, b) => b.bottomLeft.x - a.bottomLeft.x,
  );
  const result: RotatedBoundingBox[][] = [];
  let activeLinesToCheck: RotatedBoundingBox[][] = [];
  let lastCleanupAtX = 0;
  while (sortedByRightToLeft.length > 0) {
    const currentStaffLine = sortedByRightToLeft.pop() as RotatedBoundingBox;
    const x = currentStaffLine.bottomLeft.x;

    if (x - lastCleanupAtX > maxLineGapSize(unitSize)) {
      activeLinesToCheck = activeLinesToCheck.filter(
        (item) => x - item[item.length - 1].bottomRight.x < maxLineGapSize(unitSize),
      );
      lastCleanupAtX = x;
    }

    if (currentStaffLine.box.size[0] < isShortLine(unitSize)) continue;

    let connected = false;
    for (const activeLine of activeLinesToCheck) {
      const last = activeLine[activeLine.length - 1];
      if (last.isOverlappingExtrapolated(currentStaffLine, unitSize)) {
        activeLine.push(currentStaffLine);
        connected = true;
      }
    }
    if (!connected) {
      const newList = [currentStaffLine];
      result.push(newList);
      activeLinesToCheck.push(newList);
    }
  }
  const resultTopToBottom = [...result].sort((a, b) => a[0].box.center.y - b[0].box.center.y);
  return resultTopToBottom.map((lines, index) => new StaffLineSegment(index, lines));
}

export function areLinesCrossing(lines: StaffLineSegment[]): boolean {
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[i].isOverlapping(lines[j])) return true;
    }
  }
  return false;
}

export function areLinesParallel(lines: StaffLineSegment[], unitSize: number): boolean {
  const allAngles: number[] = [];
  const allFragments: RotatedBoundingBox[] = [];
  for (const line of lines) {
    for (const fragment of line.staffFragments) {
      allAngles.push(fragment.angle);
      allFragments.push(fragment);
    }
  }
  if (allAngles.length === 0) return false;
  const averageAngle = mean(allAngles);
  for (const fragment of allFragments) {
    if (
      Math.abs(fragment.angle - averageAngle) > MAX_ANGLE_FOR_LINES_TO_BE_PARALLEL &&
      fragment.size[0] > isShortConnectedLine(unitSize)
    ) {
      return false;
    }
  }
  return true;
}

export function beginsOrEndsOnOneStaffLine(
  line: RotatedBoundingBox,
  staffLines: StaffLineSegment[],
  unitSize: number,
): boolean {
  for (const staffLine of staffLines) {
    const fragment = staffLine.getAt(line.center.x);
    if (fragment === null) continue;
    const staffY = fragment.getCenterExtrapolated(line.center.x);
    if (Math.abs(staffY - line.center.y) < unitSize) return true;
  }
  return false;
}

/**
 * Find groups of five parallel staff lines next to a symbol that is always on a staff
 * (a clef or a bar line). Each candidate x offset yields at most one anchor.
 */
export function findStaffAnchors(
  staffLines: RotatedBoundingBox[],
  anchorSymbols: RotatedBoundingBox[],
  areClefs = false,
): StaffAnchor[] {
  const result: StaffAnchor[] = [];
  const offsets = areClefs ? [-10, 0, 10, 30, 60, 80] : [-10, -5, 0, 5, 10];

  for (const centerSymbol of anchorSymbols) {
    const adjacent = offsets.map((offset) => centerSymbol.moveToXHorizontalBy(offset));
    for (const symbol of adjacent) {
      const estimatedUnitSize = pyRound(
        symbol.size[1] / (NUMBER_OF_LINES_ON_A_STAFF - 1),
      );
      const thickenedBarLine = symbol.makeBoxTaller(estimatedUnitSize);
      const overlappingStaffLines = staffLines.filter((line) =>
        line.isIntersecting(thickenedBarLine),
      );
      let connectedLines = connectStaffLines(overlappingStaffLines, estimatedUnitSize);
      if (connectedLines.length > NUMBER_OF_LINES_ON_A_STAFF) {
        connectedLines = connectedLines.filter(
          (line) => line.maxX - line.minX > isShortConnectedLine(estimatedUnitSize),
        );
      }
      if (connectedLines.length !== NUMBER_OF_LINES_ON_A_STAFF) continue;
      if (!areLinesParallel(connectedLines, estimatedUnitSize)) continue;
      if (areLinesCrossing(connectedLines)) continue;
      if (
        !areClefs &&
        !beginsOrEndsOnOneStaffLine(symbol, connectedLines, estimatedUnitSize)
      ) {
        continue;
      }
      result.push(new StaffAnchor(connectedLines, symbol));
    }
  }
  return result;
}

/**
 * Walk the staff between two x positions and yield one `StaffPoint` per step, filling
 * gaps from the closest complete slice. The index used to invalidate a pair of lines is
 * the index into the *compressed* delta list, exactly like HOMR.
 */
export function* resampleStaffSegment(
  anchor: StaffAnchor,
  staff: RawStaff,
  axisRange: number[],
): Generator<StaffPoint> {
  const anchorX = anchor.symbol.center.x;
  const lineFragments = anchor.staffLines.map((line) => line.staffFragments[0]);
  const centers = lineFragments.map((line) => line.getCenterExtrapolated(anchorX));
  // Dummy point at the anchor points.
  let previousPoint = new StaffPoint(
    anchorX,
    centers,
    mean(lineFragments.map((line) => line.angle)),
  );

  for (const x of axisRange) {
    const lines: (RotatedBoundingBox | null)[] = staff.lines.map((line) => line.getAt(x));
    const axisCenter: (number | null)[] = lines.map((line) =>
      line === null ? null : line.getCenterExtrapolated(x),
    );
    const incomplete = axisCenter.every((center) => center === null);
    if (incomplete) continue;
    const centerValues = axisCenter.filter((center): center is number => center !== null);
    const deltas = diff(centerValues);
    const nonParallel = deltas.map(
      (delta) => delta < 0.5 * anchor.averageUnitSize,
    );
    for (let i = 0; i < nonParallel.length; i += 1) {
      if (nonParallel[i]) {
        axisCenter[i] = null;
        axisCenter[i + 1] = null;
      }
    }

    for (let i = 0; i < previousPoint.y.length; i += 1) {
      const centerValue = axisCenter[i];
      if (
        centerValue !== null &&
        centerValue !== undefined &&
        Math.abs(centerValue - previousPoint.y[i]) > 0.5 * anchor.averageUnitSize
      ) {
        axisCenter[i] = null;
      }
    }

    // Fill from the closest known slice in both directions.
    let prevCenter = -1;
    const visit: number[] = [];
    for (let i = 0; i < axisCenter.length; i += 1) visit.push(i);
    for (let i = axisCenter.length - 1; i >= 0; i -= 1) visit.push(i);
    for (const i of visit) {
      if (axisCenter[i] !== null) {
        prevCenter = i;
      } else if (prevCenter >= 0) {
        const centerValue = axisCenter[prevCenter];
        if (centerValue !== null) {
          axisCenter[i] = centerValue + anchor.averageUnitSize * (i - prevCenter);
        }
      }
    }
    if (axisCenter.some((center) => center === null)) continue;

    const angle = mean(
      lines.filter((line): line is RotatedBoundingBox => line !== null).map((line) => line.angle),
    );
    previousPoint = new StaffPoint(x, axisCenter as number[], angle);
    yield previousPoint;
  }
}

/** Resample one raw staff into a `Staff` grid every 10 px. */
export function resampleStaff(staff: RawStaff): Staff {
  const anchorsLeftToRight = [...staff.anchors].sort(
    (a, b) => a.symbol.center.x - b.symbol.center.x,
  );
  const staffDensity = 10;

  const roundToDensity = (x: number): number =>
    Math.trunc(pyRound(x / staffDensity)) * staffDensity;

  const start = Math.floor(staff.minX / staffDensity) * staffDensity;
  const stop = (Math.floor(staff.maxX / staffDensity) + 1) * staffDensity;

  const grid: StaffPoint[] = [];
  let x = start;
  for (let i = 0; i < anchorsLeftToRight.length; i += 1) {
    const anchor = anchorsLeftToRight[i];
    const toLeft = makeRange(
      roundToDensity(x),
      roundToDensity(anchor.symbol.center.x),
    );
    let toRight: IntRange;
    if (i < anchorsLeftToRight.length - 1) {
      toRight = makeRange(
        Math.trunc(anchor.symbol.center.x),
        Math.trunc(
          (anchor.symbol.center.x + anchorsLeftToRight[i + 1].symbol.center.x) / 2,
        ),
      );
    } else {
      toRight = makeRange(
        roundToDensity(anchor.symbol.center.x),
        roundToDensity(stop),
      );
    }
    // HOMR continues from `to_right.stop`, not from the last emitted x.
    x = toRight.stop;

    const leftPoints: StaffPoint[] = [];
    for (const point of resampleStaffSegment(
      anchor,
      staff,
      rangeValues(toLeft, staffDensity).reverse(),
    )) {
      leftPoints.push(point);
    }
    grid.push(...leftPoints.reverse());
    for (const point of resampleStaffSegment(
      anchor,
      staff,
      rangeValues(toRight, staffDensity),
    )) {
      grid.push(point);
    }
  }

  return new Staff(grid);
}

export function resampleStaffs(staffs: RawStaff[]): Staff[] {
  return staffs.map((staff) => resampleStaff(staff));
}

/** Drop staffs that run off the page and slivers at the left or right edge. */
export function filterEdgeOfVision(
  staffs: Staff[],
  imageHeight: number,
  imageWidth: number,
): Staff[] {
  const staffWidths = staffs.map((staff) => staff.maxX - staff.minX);
  const usualWidth = mean(staffWidths);

  const result: Staff[] = [];
  for (const staff of staffs) {
    const beyondBottom = staff.maxY >= imageHeight;
    const beyondTop = staff.minY < 0;
    if (beyondBottom || beyondTop) continue;

    const staffWidth = staff.maxX - staff.minX;
    const shorterThanUsual = staffWidth < usualWidth / 2;
    const beyondLeft = staff.minX < 0.01 * imageWidth;
    const beyondRight = staff.maxX > 0.99 * imageWidth;

    if ((beyondLeft || beyondRight) && shorterThanUsual) continue;
    result.push(staff);
  }
  return result;
}

export function sortStaffsTopToBottom(staffs: Staff[]): Staff[] {
  return [...staffs].sort((a, b) => a.minY - b.minY);
}

/** Share of the grid line positions that have staff ink in their 3x3 neighbourhood. */
export function staffLineSupport(staff: Staff, staffImage: BinaryImage): number {
  let supported = 0;
  let total = 0;
  const { binary, width, height } = staffImage;
  for (const point of staff.grid) {
    const x = Math.trunc(pyRound(point.x));
    if (x < 0 || x >= width) continue;
    for (const yValue of point.y) {
      const y = Math.trunc(pyRound(yValue));
      if (y < 0 || y >= height) continue;
      total += 1;
      const startY = Math.max(0, y - 1);
      const endY = Math.min(height, y + 2);
      const startX = Math.max(0, x - 1);
      const endX = Math.min(width, x + 2);
      let found = 0;
      for (let yy = startY; yy < endY && !found; yy += 1) {
        const offset = yy * width;
        for (let xx = startX; xx < endX; xx += 1) {
          if (binary[offset + xx]) {
            found = 1;
            break;
          }
        }
      }
      supported += found;
    }
  }
  return total ? supported / total : 0;
}

/**
 * Recover one unanchored stave of an otherwise regular paired (piano) layout. Only used
 * when an odd number of staffs is left and the inferred lines have mask support.
 */
export function recoverMissingStaffFromRepeatedLayout(
  staffs: Staff[],
  staffImage: BinaryImage,
): Staff[] {
  const sortedStaffs = sortStaffsTopToBottom(staffs);
  if (sortedStaffs.length < 7 || sortedStaffs.length % 2 === 0) return sortedStaffs;
  if (
    sortedStaffs.some(
      (staff) =>
        staff.grid.length === 0 ||
        staff.grid.some((point) => point.y.length !== NUMBER_OF_LINES_ON_A_STAFF),
    )
  ) {
    return sortedStaffs;
  }

  const unitSizes = sortedStaffs.map((staff) => staff.averageUnitSize);
  const typicalUnitSize = median(unitSizes);
  if (
    typicalUnitSize <= 0 ||
    Math.max(...unitSizes.map((unit) => Math.abs(unit - typicalUnitSize))) >
      0.2 * typicalUnitSize
  ) {
    return sortedStaffs;
  }

  const centers = sortedStaffs.map((staff) => (staff.minY + staff.maxY) / 2);
  const gaps = diff(centers);
  const expectedExistingPairGaps = Math.floor((sortedStaffs.length - 1) / 2);
  const ascendingGaps = [...gaps].sort((a, b) => a - b);
  const typicalPairGap = median(ascendingGaps.slice(0, expectedExistingPairGaps));
  const systemGaps = gaps.filter((gap) => gap > typicalPairGap * 1.35);
  if (systemGaps.length < 2) return sortedStaffs;
  const typicalSystemGap = median(systemGaps);
  const combinedGap = typicalPairGap + typicalSystemGap;

  const proposals: [number, number][] = [];
  for (let gapIndex = 0; gapIndex < gaps.length; gapIndex += 1) {
    const gap = gaps[gapIndex];
    if (Math.abs(gap - combinedGap) > combinedGap * 0.2) continue;
    for (const insertedCenter of [
      centers[gapIndex] + typicalPairGap,
      centers[gapIndex + 1] - typicalPairGap,
    ]) {
      const augmentedCenters = [
        ...centers.slice(0, gapIndex + 1),
        insertedCenter,
        ...centers.slice(gapIndex + 1),
      ];
      const augmentedGaps = diff(augmentedCenters);
      const pairGaps = augmentedGaps.filter((_, index) => index % 2 === 0);
      const betweenSystemGaps = augmentedGaps.filter((_, index) => index % 2 === 1);
      const pairMedian = median(pairGaps);
      const systemMedian = median(betweenSystemGaps);
      if (pairMedian <= 0 || systemMedian <= 0 || pairMedian >= systemMedian * 0.8) {
        continue;
      }
      const pairError = pairGaps.map((value) => Math.abs(value - pairMedian) / pairMedian);
      const systemError = betweenSystemGaps.map(
        (value) => Math.abs(value - systemMedian) / systemMedian,
      );
      if (Math.max(...pairError) > 0.25 || Math.max(...systemError) > 0.25) continue;
      proposals.push([mean(pairError) + mean(systemError), gapIndex + 1]);
    }
  }

  if (proposals.length === 0) return sortedStaffs;
  proposals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (proposals.length > 1 && proposals[1][0] - proposals[0][0] < 0.02) return sortedStaffs;
  const insertionIndex = proposals[0][1];

  const augmentedStaffs: (Staff | null)[] = [...sortedStaffs];
  augmentedStaffs.splice(insertionIndex, 0, null);

  const lineOffsets: number[][] = [];
  const angleOffsets: number[] = [];
  for (let i = 0; i + 1 < augmentedStaffs.length; i += 2) {
    const upper = augmentedStaffs[i];
    const lower = augmentedStaffs[i + 1];
    if (upper === null || lower === null) continue;
    const lowerByX = new Map<number, StaffPoint>();
    for (const point of lower.grid) lowerByX.set(Math.trunc(pyRound(point.x)), point);
    for (const upperPoint of upper.grid) {
      const lowerPoint = lowerByX.get(Math.trunc(pyRound(upperPoint.x)));
      if (lowerPoint === undefined) continue;
      lineOffsets.push(lowerPoint.y.map((y, index) => y - upperPoint.y[index]));
      angleOffsets.push(lowerPoint.angle - upperPoint.angle);
    }
  }
  if (lineOffsets.length < 3) return sortedStaffs;

  const lineCount = lineOffsets[0].length;
  const typicalLineOffsets: number[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    typicalLineOffsets.push(median(lineOffsets.map((offsets) => offsets[i])));
  }
  const typicalAngleOffset = median(angleOffsets);

  let sibling: Staff | null;
  let direction: number;
  if (insertionIndex % 2 === 1) {
    sibling = augmentedStaffs[insertionIndex - 1];
    direction = 1;
  } else {
    sibling = augmentedStaffs[insertionIndex + 1];
    direction = -1;
  }
  if (sibling === null) return sortedStaffs;

  const recovered = new Staff(
    sibling.grid.map(
      (point) =>
        new StaffPoint(
          point.x,
          point.y.map((y, index) => y + direction * typicalLineOffsets[index]),
          point.angle + direction * typicalAngleOffset,
        ),
    ),
  );
  const knownSupport = median(sortedStaffs.map((staff) => staffLineSupport(staff, staffImage)));
  const recoveredSupport = staffLineSupport(recovered, staffImage);
  if (recoveredSupport < Math.max(0.4, knownSupport * 0.5)) return sortedStaffs;

  const result = [...sortedStaffs];
  result.splice(insertionIndex, 0, recovered);
  return result;
}

/** Drop anchors whose unit size is more than three standard deviations off. */
export function filterUnusualAnchors(anchors: StaffAnchor[]): StaffAnchor[] {
  if (anchors.length === 0) return anchors;
  const unitSizes = anchors.map((anchor) => anchor.averageUnitSize);
  const averageUnitSize = mean(unitSizes);
  const unitSizeDeviation = populationStd(unitSizes);
  return anchors.filter(
    (anchor) => Math.abs(anchor.averageUnitSize - averageUnitSize) <= 3 * unitSizeDeviation,
  );
}

/**
 * The x ranges to look for staff lines in: everything right of a clef, with overlapping
 * ranges merged.
 */
export function initZone(clefAnchors: StaffAnchor[], imageWidth: number): IntRange[] {
  const makeZone = (start: number, stop: number): IntRange => ({
    start: Math.max(Math.trunc(start), 0),
    stop: Math.min(Math.trunc(stop), imageWidth),
  });

  const marginRight = 10;
  const ranges = clefAnchors.map((anchor) =>
    makeZone(anchor.symbol.bottomLeft.x, anchor.symbol.topRight.x + marginRight),
  );
  ranges.sort((a, b) => a.start - b.start);
  const result: IntRange[] = [];
  for (let i = 0; i < ranges.length; i += 1) {
    if (i === 0) {
      result.push(ranges[i]);
    } else {
      const last = result[result.length - 1];
      if (ranges[i].start < last.stop) result[result.length - 1] = { start: last.start, stop: ranges[i].stop };
      else result.push(ranges[i]);
    }
  }
  return result;
}

/** Read numpy-style: a negative index wraps to the end of the array. */
function valueAt(values: ArrayLike<number>, index: number): number {
  return index < 0 ? values[values.length + index] : values[index];
}

/**
 * Keep the peaks that belong to a complete group of five staff lines. Returns the valid
 * flags and, for every peak, the group it ended up in.
 */
export function filterLinePeaks(
  peaks: number[],
  norm: ArrayLike<number>,
  maxGapRatio = 1.5,
): { validPeaks: boolean[]; groups: number[] } {
  const validPeaks = peaks.map(() => true);

  // Filter by height
  for (let idx = 0; idx < peaks.length; idx += 1) {
    const maxPeakHeight = 15;
    if (valueAt(norm, peaks[idx]) > maxPeakHeight) validPeaks[idx] = false;
  }

  // Filter by x-axis
  const gaps = peaks.slice(1).map((peak, index) => peak - peaks[index]);
  const count = Math.max(5, pyRound(peaks.length * 0.2));
  const approxUnit = mean(
    [...gaps].sort((a, b) => a - b).slice(0, count),
  );
  const maxGap = approxUnit * maxGapRatio;

  // Prepend an invalid peak for better handling edge case
  const extPeaks = [peaks[0] - maxGap - 1, ...peaks];
  const groups: number[] = [];
  let group = -1;
  for (let i = 1; i < extPeaks.length; i += 1) {
    if (extPeaks[i] - extPeaks[i - 1] > maxGap) group += 1;
    groups.push(group);
  }
  groups.push(groups[groups.length - 1] + 1); // Append an invalid group for edge cases

  let currentGroup = groups[0];
  let run = 1;
  for (let idx = 1; idx < groups.length; idx += 1) {
    const nextGroup = groups[idx];
    if (nextGroup === currentGroup) {
      run += 1;
      continue;
    }

    if (run < NUMBER_OF_LINES_ON_A_STAFF) {
      // Incomplete peaks; also drops the top and bottom incomplete staff lines.
      for (let k = idx - run; k < idx; k += 1) validPeaks[k] = false;
    } else if (run > NUMBER_OF_LINES_ON_A_STAFF) {
      const candidate = peaks.slice(idx - run, idx);
      const headPart = candidate.slice(0, NUMBER_OF_LINES_ON_A_STAFF);
      const tailPart = candidate.slice(-NUMBER_OF_LINES_ON_A_STAFF);
      const headSum = headPart.reduce((sum, peak) => sum + valueAt(norm, peak), 0);
      const tailSum = tailPart.reduce((sum, peak) => sum + valueAt(norm, peak), 0);
      if (headSum > tailSum) {
        for (let k = idx - run + NUMBER_OF_LINES_ON_A_STAFF; k < idx; k += 1) {
          validPeaks[k] = false;
        }
      } else {
        for (let k = idx - run; k < idx - NUMBER_OF_LINES_ON_A_STAFF; k += 1) {
          validPeaks[k] = false;
        }
      }
    }

    currentGroup = nextGroup;
    run = 1;
  }
  return { validPeaks, groups: groups.slice(0, -1) };
}

/**
 * Find the rows that carry staff lines in the given column range: peak on the row ink
 * count, then keep only complete groups of five.
 */
export function findHorizontalLines(
  image: BinaryImage,
  columns: IntRange,
  unitSize: number,
  lineThreshold = 0,
): number[][] {
  const { binary, width, height } = image;
  const count = new Float64Array(height + 2);
  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    let rowCount = 0;
    for (let x = columns.start; x < columns.stop; x += 1) {
      if (binary[offset + x]) rowCount += 1;
    }
    count[y + 1] = rowCount;
  }

  const average = mean(Array.from(count));
  const deviation = populationStd(Array.from(count));
  const norm = new Float64Array(count.length);
  for (let i = 0; i < count.length; i += 1) norm[i] = (count[i] - average) / deviation;

  const peaks = findPeaks(norm, {
    height: lineThreshold,
    distance: unitSize,
    prominence: 1,
  });
  if (peaks.length === 0) return [];
  const centers = peaks.map((peak) => peak - 1);
  const trimmed = norm.subarray(1, norm.length - 1); // Remove prepend / append
  const { groups } = filterLinePeaks(centers, trimmed);

  const groupedCenters = new Map<number, number[]>();
  for (let i = 0; i < centers.length; i += 1) {
    const groupNumber = groups[i];
    const group = groupedCenters.get(groupNumber);
    if (group) group.push(centers[i]);
    else groupedCenters.set(groupNumber, [centers[i]]);
  }
  const completeGroups: number[][] = [];
  for (const groupedCenter of groupedCenters.values()) {
    if (groupedCenter.length === NUMBER_OF_LINES_ON_A_STAFF) {
      completeGroups.push([...groupedCenter].sort((a, b) => a - b));
    }
  }
  return completeGroups;
}

/**
 * Guess the staffs the clef anchors did not reach: every clef zone is searched for
 * groups of five horizontal lines, minus the ones a clef already covers.
 */
export function predictOtherAnchorsFromClefs(
  clefAnchors: StaffAnchor[],
  image: BinaryImage,
): RotatedBoundingBox[] {
  if (clefAnchors.length === 0) return [];
  const averageUnitSize = mean(clefAnchors.map((anchor) => anchor.averageUnitSize));
  const anchorSymbols = clefAnchors.map((anchor) => anchor.symbol);
  const clefZones = initZone(clefAnchors, image.width);
  const result: RotatedBoundingBox[] = [];
  for (const zone of clefZones) {
    const linesGroups = findHorizontalLines(image, zone, averageUnitSize);
    for (const group of linesGroups) {
      const minY = Math.min(...group);
      const maxY = Math.max(...group);
      const centerY = (minY + maxY) / 2;
      const centerX = zone.start + (zone.stop - zone.start) / 2;
      result.push(
        new RotatedBoundingBox(
          {
            center: { x: Math.trunc(centerX), y: Math.trunc(centerY) },
            size: [zone.stop - zone.start, Math.trunc(maxY - minY)],
            angle: 0,
          },
          [],
          0,
        ),
      );
    }
  }
  return result.filter((box) => !box.isOverlappingWithAny(anchorSymbols));
}

/**
 * Split fragments wider than `limit` into parts, so that a curved line is approximated
 * by several straighter pieces. Both halves keep a point of the other side, so they stay
 * connected; HOMR appends `right[0]` to both, which is kept as it is.
 */
export function breakWideFragments(
  fragments: RotatedBoundingBox[],
  limit = 100,
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const fragment of fragments) {
    let remainingFragment = fragment;
    while (remainingFragment.size[0] > limit) {
      const points = remainingFragment.contour;
      const minX = Math.min(...points.map((point) => point.x));
      const contoursLeft = points
        .filter((point) => point.x < minX + limit)
        .sort((a, b) => a.x - b.x);
      const contoursRight = points
        .filter((point) => point.x >= minX + limit)
        .sort((a, b) => a.x - b.x);
      if (contoursLeft.length === 0 || contoursRight.length === 0) break;
      // Make sure the parts stay connected by adding a point of the other side.
      contoursLeft.push(contoursRight[0]);
      contoursRight.push(contoursRight[0]);
      result.push(createRotatedBoundingBox(contoursLeft, remainingFragment.debugId));
      remainingFragment = createRotatedBoundingBox(
        contoursRight,
        remainingFragment.debugId,
      );
    }
    result.push(remainingFragment);
  }
  return result;
}

/**
 * Detect the staffs of a page. `image` is the strengthened staff mask, which is what
 * both the row peaks and the recovery support check read.
 */
export function detectStaff(
  image: BinaryImage,
  staffFragments: RotatedBoundingBox[],
  clefsKeys: RotatedBoundingBox[],
  likelyBarOrRestsLines: RotatedBoundingBox[],
): Staff[] {
  const staffAnchors = findStaffAnchors(staffFragments, clefsKeys, true);

  const possibleOtherClefs = predictOtherAnchorsFromClefs(staffAnchors, image);
  staffAnchors.push(...findStaffAnchors(staffFragments, possibleOtherClefs, true));
  staffAnchors.push(...findStaffAnchors(staffFragments, likelyBarOrRestsLines, false));

  const filteredAnchors = filterUnusualAnchors(staffAnchors);
  const rawStaffsWithPossibleDuplicates = findRawStaffsByConnectingLineFragments(
    filteredAnchors,
    staffFragments,
  );
  const rawStaffs = removeDuplicateStaffs(rawStaffsWithPossibleDuplicates);

  let staffs = resampleStaffs(rawStaffs);
  staffs = filterEdgeOfVision(staffs, image.height, image.width);
  staffs = sortStaffsTopToBottom(staffs);

  staffs = recoverMissingStaffFromRepeatedLayout(staffs, image);
  return staffs;
}
