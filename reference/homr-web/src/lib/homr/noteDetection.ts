/**
 * HOMR's note_detection.py: attach stems to noteheads, split clumped noteheads, and
 * place the notes on their staff.
 *
 * The clump splitting is the interesting part. SegNet merges touching noteheads into
 * one blob, so a notehead whose box is wider than one notehead is cut in half, and a
 * box that is taller than one notehead is cut into equal slices. The cut boxes are
 * then shrunk to the ink they actually contain, which is what `adjustBbox` does.
 *
 * Everything here consumes the same boxes as HOMR: noteheads are ellipses, stems and
 * bar lines are rotated boxes.
 */

import type { Point } from '../vision/contours.ts';
import {
  BoundingEllipse,
  type RotatedBoundingBox,
} from './boundingBoxes.ts';
import { NOTEHEAD_SIZE_RATIO } from './constants.ts';
import { Note, type Staff, type StemDirection } from './model.ts';
import { pyRound } from './numeric.ts';

/** A 0/1 mask, the shape the box factories already take. */
export interface BinaryMask {
  binary: Uint8Array;
  width: number;
  height: number;
}

/** (x1, y1, x2, y2), the `cv2.Rect` HOMR passes around here. */
type Rect = [number, number, number, number];

export class NoteheadWithStem {
  readonly notehead: BoundingEllipse;
  readonly stem: RotatedBoundingBox | null;
  readonly stemDirection: StemDirection | null;
  /** Only set for members of a split clump; the XML stage ignores it. */
  readonly splitClumpId: string | null;
  readonly splitClumpBounds: [number, number, number, number] | null;

  constructor(
    notehead: BoundingEllipse,
    stem: RotatedBoundingBox | null,
    stemDirection: StemDirection | null = null,
    splitClumpId: string | null = null,
    splitClumpBounds: [number, number, number, number] | null = null,
  ) {
    this.notehead = notehead;
    this.stem = stem;
    this.stemDirection = stemDirection;
    this.splitClumpId = splitClumpId;
    this.splitClumpBounds = splitClumpBounds;
  }
}

/** Shrink the box vertically to the notehead ink inside it. */
export function adjustBbox(bbox: Rect, noteheads: BinaryMask): Rect {
  const [x1, y1, x2, y2] = bbox;
  if (x2 <= x1 || y2 <= y1) return bbox; // an empty slice has no ink either
  const right = Math.min(x2, noteheads.width);
  const bottom = Math.min(y2, noteheads.height);
  let top = Infinity;
  let low = -Infinity;
  for (let y = y1; y < bottom; y += 1) {
    const rowOffset = y * noteheads.width;
    for (let x = x1; x < right; x += 1) {
      if (!noteheads.binary[rowOffset + x]) continue;
      if (y < top) top = y;
      if (y > low) low = y;
    }
  }
  if (top === Infinity) return bbox; // invalid note, dropped by the zero height
  return [x1, top - 1, x2, low + 1];
}

/** Centre of a rect, rounded like Python's `round`. */
export function getCenter(bbox: Rect): [number, number] {
  return [pyRound((bbox[0] + bbox[2]) / 2), pyRound((bbox[1] + bbox[3]) / 2)];
}

/**
 * Split a notehead box until every part holds a single notehead. A box wider than one
 * notehead is cut vertically, otherwise it is cut into as many horizontal slices as
 * its height fits, and each slice is re-checked.
 */
export function checkBboxSize(bbox: Rect, noteheads: BinaryMask, unitSize: number): Rect[] {
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const [centerX] = getCenter(bbox);
  const noteWidth = NOTEHEAD_SIZE_RATIO * unitSize;
  const noteHeight = unitSize;

  let newBbox: Rect[] = [];
  if (Math.abs(width - noteWidth) > Math.abs(width - noteWidth * 2)) {
    // Contains at least two notes, one left and one right.
    const left = adjustBbox([bbox[0], bbox[1], centerX, bbox[3]], noteheads);
    const right = adjustBbox([centerX, bbox[1], bbox[2], bbox[3]], noteheads);
    newBbox.push(...checkBboxSize(left, noteheads, unitSize));
    newBbox.push(...checkBboxSize(right, noteheads, unitSize));
  }

  if (newBbox.length > 0) {
    const expanded: Rect[] = [];
    for (const box of newBbox) expanded.push(...checkBboxSize(box, noteheads, unitSize));
    newBbox = expanded;
  } else {
    const numberOfNotes = Math.trunc(pyRound(height / noteHeight));
    if (numberOfNotes > 0) {
      const sliceHeight = Math.floor(height / numberOfNotes);
      for (let i = 0; i < numberOfNotes; i += 1) {
        newBbox.push([
          bbox[0],
          pyRound(bbox[1] + i * sliceHeight),
          bbox[2],
          pyRound(bbox[1] + (i + 1) * sliceHeight),
        ]);
      }
    }
  }

  return newBbox;
}

/**
 * Notehead detection can clump several noteheads into one blob; this cuts such a blob
 * into one ellipse per notehead, all carrying the stem of the clump.
 */
export function splitClumpsOfNoteheads(
  notehead: NoteheadWithStem,
  noteheads: BinaryMask,
  staff: Staff,
): NoteheadWithStem[] {
  const { topLeft, bottomRight } = notehead.notehead;
  const bbox: Rect = [
    Math.trunc(topLeft.x),
    Math.trunc(topLeft.y),
    Math.trunc(bottomRight.x),
    Math.trunc(bottomRight.y),
  ];
  const splitBoxes = checkBboxSize(bbox, noteheads, staff.averageUnitSize);
  if (splitBoxes.length <= 1) return [notehead];

  const clumpId = `split-clump-${notehead.notehead.debugId}-${bbox.join('-')}`;
  const result: NoteheadWithStem[] = [];
  for (const box of splitBoxes) {
    const [centerX, centerY] = getCenter(box);
    const width = box[2] - box[0];
    const height = box[3] - box[1];
    const contour: Point[] = [
      { x: box[0], y: box[1] },
      { x: box[2], y: box[3] },
    ];
    result.push(
      new NoteheadWithStem(
        new BoundingEllipse(
          { center: { x: centerX, y: centerY }, size: [width, height], angle: 0 },
          contour,
          notehead.notehead.debugId,
        ),
        notehead.stem,
        notehead.stemDirection,
        clumpId,
        [bbox[0], bbox[1], bbox[2], bbox[3]],
      ),
    );
  }
  return result;
}

/**
 * Pair every notehead with the first stem it touches. A stem widened by 15 px is used
 * for the test, so stems adjacent to the notehead still count.
 */
export function combineNoteheadsWithStems(
  noteheads: BoundingEllipse[],
  stems: RotatedBoundingBox[],
): NoteheadWithStem[] {
  // The sort key is the raw box centre y; the angle normalisation keeps the centre.
  const sorted = [...noteheads].sort((a, b) => a.box.center.y - b.box.center.y);
  const result: NoteheadWithStem[] = [];
  for (const notehead of sorted) {
    const thickened = notehead.makeBoxThicker(15);
    let found = false;
    for (const stem of stems) {
      if (stem.isOverlapping(thickened)) {
        // HOMR collects the used stems in a set, but never reads it: one stem may end
        // up on several noteheads, which is what a chord needs.
        const direction: StemDirection = stem.center.y < notehead.center.y ? 'UP' : 'DOWN';
        result.push(new NoteheadWithStem(notehead, stem, direction));
        found = true;
        break;
      }
    }
    if (!found) result.push(new NoteheadWithStem(notehead, null, null));
  }
  return result;
}

/**
 * add_notes_to_staffs: walk the staffs, take every notehead that sits inside the staff
 * zone, split clumps, drop what is too small or too large for a notehead, and add the
 * rest as notes. The notes are appended to `staff.symbols` in place and returned flat.
 *
 * HOMR also takes the symbols mask here, but never reads it.
 */
export function addNotesToStaffs(
  staffs: Staff[],
  noteheads: NoteheadWithStem[],
  noteheadMask: BinaryMask,
): Note[] {
  const result: Note[] = [];
  let nextVisualId = 1;
  for (const staff of staffs) {
    for (const chunk of noteheads) {
      if (!staff.isOnStaffZone(chunk.notehead)) continue;
      const center = chunk.notehead.center;
      let point = staff.getAt(center.x);
      if (point === null) continue;
      const chunkSize = chunk.notehead.size;
      if (
        chunkSize[0] < 0.5 * point.averageUnitSize ||
        chunkSize[1] < 0.5 * point.averageUnitSize
      ) {
        continue;
      }
      for (const notehead of splitClumpsOfNoteheads(chunk, noteheadMask, staff)) {
        point = staff.getAt(center.x);
        if (point === null) continue;
        const size = notehead.notehead.size;
        const unitSize = point.averageUnitSize;
        if (
          size[0] < 0.5 * unitSize ||
          size[0] > 3 * unitSize ||
          size[1] < 0.5 * unitSize ||
          size[1] > 2 * unitSize
        ) {
          continue;
        }
        const position = point.findPositionInUnitSizes(notehead.notehead);
        const note = new Note(
          notehead.notehead,
          position,
          notehead.stem,
          notehead.stemDirection,
          `vnote-${nextVisualId}`,
          notehead.splitClumpId,
          notehead.splitClumpBounds,
        );
        nextVisualId += 1;
        result.push(note);
        staff.addSymbol(note);
      }
    }
  }
  return result;
}
