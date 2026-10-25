/**
 * Compare the note / bar line / staff assignment stages against HOMR's own output.
 *
 *   node scripts/check-notes.mjs [page]
 *
 * The inputs are the same filtered masks HOMR saw and, for the staff assignment, the
 * staff grids HOMR detected (stage_staffsBeforeMerge.json). That keeps the staff
 * detection out of this comparison: what is checked here is everything that happens
 * between the mask and the note list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  createBoundingEllipses,
  createRotatedBoundingBoxes,
} from '../src/lib/homr/boundingBoxes.ts';
import {
  detectBarLines,
  prepareBarLineImage,
} from '../src/lib/homr/barLineDetection.ts';
import {
  addNotesToStaffs,
  combineNoteheadsWithStems,
} from '../src/lib/homr/noteDetection.ts';
import { Staff, StaffPoint } from '../src/lib/homr/model.ts';
import { median } from '../src/lib/homr/numeric.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/stage-reference', source);

const load = (name) => JSON.parse(fs.readFileSync(path.join(refDir, name), 'utf8'));
const reference = {
  boxes: load('stage_boxes.json'),
  averageNoteHeadHeight: load('stage_averageNoteHeadHeight.json'),
  noteheadsWithStems: load('stage_noteheadsWithStems.json'),
  staffsBeforeMerge: load('stage_staffsBeforeMerge.json'),
  staffsWithNotes: load('stage_staffsWithNotes.json'),
};

const POSITION_TOLERANCE = 0.01;
const ANGLE_TOLERANCE = 0.01;

function readMask(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const binary = new Uint8Array(png.width * png.height);
  for (let i = 0; i < binary.length; i += 1) binary[i] = png.data[i * 4] > 0 ? 1 : 0;
  return { binary, width: png.width, height: png.height };
}

const near = (a, b, tolerance = POSITION_TOLERANCE) => Math.abs(a - b) <= tolerance;

/** `_box_json` of a box, including the un-normalised rect. */
function rectDiffers(box, expected, maxContour = 0) {
  const expectedCount = maxContour ? Math.min(expected.nContour, maxContour) : expected.nContour;
  return (
    !near(box.center.x, expected.center[0]) ||
    !near(box.center.y, expected.center[1]) ||
    !near(box.size[0], expected.size[0]) ||
    !near(box.size[1], expected.size[1]) ||
    !near(box.angle, expected.angle, ANGLE_TOLERANCE) ||
    !near(box.box.center.x, expected.rect[0][0]) ||
    !near(box.box.center.y, expected.rect[0][1]) ||
    !near(box.box.size[0], expected.rect[1][0]) ||
    !near(box.box.size[1], expected.rect[1][1]) ||
    !near(box.box.angle, expected.rect[2], ANGLE_TOLERANCE) ||
    box.contour.length !== expectedCount
  );
}

const describe = (box) =>
  `(${box.center.x.toFixed(3)},${box.center.y.toFixed(3)}) ` +
  `(${box.size[0].toFixed(3)},${box.size[1].toFixed(3)}) ${box.angle.toFixed(3)} ` +
  `n=${box.contour.length}`;

/** The reference stores note symbols without a rect or contour. */
function noteDiffers(box, expected) {
  return (
    !near(box.center.x, expected.center[0]) ||
    !near(box.center.y, expected.center[1]) ||
    !near(box.size[0], expected.size[0]) ||
    !near(box.size[1], expected.size[1]) ||
    !near(box.angle, expected.angle, ANGLE_TOLERANCE)
  );
}

const describeExpected = (entry) =>
  `(${entry.center[0]},${entry.center[1]}) (${entry.size[0]},${entry.size[1]}) ` +
  `${entry.angle} n=${entry.nContour}`;

let failures = 0;

function report(name, mismatched, expectedCount, actualCount, total, details) {
  const same = mismatched === 0;
  if (!same) failures += 1;
  console.log(
    `${name.padEnd(20)} homr ${String(expectedCount).padStart(4)} | ` +
      `port ${String(actualCount).padStart(4)} | total ${String(total).padStart(4)} | ` +
      `${same ? 'IDENTICAL' : `${mismatched} differ`}`,
  );
  for (const line of details.slice(0, 6)) console.log(line);
}

const noteheadMask = readMask(path.join(refDir, 'stage_notehead.png'));
const stemsMask = readMask(path.join(refDir, 'stage_stems_rest.png'));

// predict_symbols: noteheads are ellipses, stems are merged rotated boxes.
let started = performance.now();
const noteheads = createBoundingEllipses(
  noteheadMask.binary,
  noteheadMask.width,
  noteheadMask.height,
  { minSize: [4, 4] },
);
const stems = createRotatedBoundingBoxes(stemsMask.binary, stemsMask.width, stemsMask.height);

// combine_noteheads_with_stems
const noteheadsWithStems = combineNoteheadsWithStems(noteheads, stems);
{
  const expected = reference.noteheadsWithStems;
  const details = [];
  let mismatched = Math.abs(noteheadsWithStems.length - expected.length);
  const shared = Math.min(noteheadsWithStems.length, expected.length);
  for (let i = 0; i < shared; i += 1) {
    const actualEntry = noteheadsWithStems[i];
    const expectedEntry = expected[i];
    const expectedDirection =
      expectedEntry.direction === 'None' ? null : expectedEntry.direction.replace('StemDirection.', '');
    let differs = rectDiffers(actualEntry.notehead, expectedEntry.notehead);
    if (expectedEntry.stem === null) {
      differs ||= actualEntry.stem !== null;
    } else {
      differs ||= actualEntry.stem === null || rectDiffers(actualEntry.stem, expectedEntry.stem);
    }
    differs ||= actualEntry.stemDirection !== expectedDirection;
    if (differs) {
      mismatched += 1;
      if (details.length < 6) {
        details.push(
          `  #${i} homr notehead ${describeExpected(expectedEntry.notehead)} stem ` +
            `${expectedEntry.stem ? 'yes' : 'no'} ${expectedEntry.direction}`,
        );
        details.push(
          `  #${i} port notehead ${describe(actualEntry.notehead)} stem ` +
            `${actualEntry.stem ? describe(actualEntry.stem) : 'no'} ${actualEntry.stemDirection}`,
        );
      }
    }
  }
  report(
    'noteheadsWithStems',
    mismatched,
    expected.length,
    noteheadsWithStems.length,
    noteheadsWithStems.length,
    details,
  );
}

// average_note_head_height = median of the ellipse heights
const averageNoteHeadHeight = median(noteheadsWithStems.map((entry) => entry.notehead.size[1]));
{
  const expected = reference.averageNoteHeadHeight;
  const same = near(averageNoteHeadHeight, expected, 0.001);
  if (!same) failures += 1;
  console.log(
    `averageNoteHeadHeight  homr ${expected} | port ${averageNoteHeadHeight.toFixed(4)} ` +
      `${same ? 'IDENTICAL' : 'DIFFERENT'}`,
  );
}

// bar line candidates, minus everything that touches a notehead or a stem
const barLineImage = prepareBarLineImage(stemsMask.binary, stemsMask.width, stemsMask.height);
const barLineCandidates = createRotatedBoundingBoxes(
  barLineImage,
  stemsMask.width,
  stemsMask.height,
  { skipMerging: true, minSize: [1, 5] },
);
const allNoteheads = noteheadsWithStems.map((entry) => entry.notehead);
const allStems = noteheadsWithStems
  .filter((entry) => entry.stem !== null)
  .map((entry) => entry.stem);
const barLinesOrRests = barLineCandidates.filter(
  (line) => !line.isOverlappingWithAny(allNoteheads) && !line.isOverlappingWithAny(allStems),
);
const barLines = detectBarLines(barLinesOrRests, averageNoteHeadHeight);
{
  const expected = reference.boxes.barLinesAccepted;
  const details = [];
  let mismatched = Math.abs(barLines.length - expected.length);
  const shared = Math.min(barLines.length, expected.length);
  for (let i = 0; i < shared; i += 1) {
    if (rectDiffers(barLines[i], expected[i], 80)) {
      mismatched += 1;
      if (details.length < 6) {
        details.push(`  #${i} homr ${describeExpected(expected[i])}`);
        details.push(`  #${i} port ${describe(barLines[i])}`);
      }
    }
  }
  report('barLinesAccepted', mismatched, expected.length, barLines.length, barLines.length, details);
}

// add_notes_to_staffs, on HOMR's staff grids
let noteTotal = 0;
{
  const staffs = reference.staffsBeforeMerge.map(
    (staff) => new Staff(staff.grid.map((point) => new StaffPoint(point.x, point.y, point.angle))),
  );
  const gridDifferences = staffs.filter(
    (staff, index) => !near(staff.averageUnitSize, reference.staffsBeforeMerge[index].unitSize),
  ).length;
  if (gridDifferences > 0) {
    failures += 1;
    console.log(`staff grids          ${gridDifferences} unit size(s) differ`);
  }
  addNotesToStaffs(staffs, noteheadsWithStems, noteheadMask);

  const expectedStaffs = reference.staffsWithNotes;
  const details = [];
  let mismatched = Math.abs(staffs.length - expectedStaffs.length);
  for (let s = 0; s < Math.min(staffs.length, expectedStaffs.length); s += 1) {
    const actualNotes = staffs[s].getNotes();
    const expectedNotes = expectedStaffs[s].symbols.filter((symbol) => symbol.type === 'Note');
    noteTotal += actualNotes.length;
    mismatched += Math.abs(actualNotes.length - expectedNotes.length);
    for (let i = 0; i < Math.min(actualNotes.length, expectedNotes.length); i += 1) {
      const actual = actualNotes[i];
      const expected = expectedNotes[i];
      const differs =
        noteDiffers(actual.box, expected) ||
        actual.position !== expected.position ||
        (actual.stem !== null) !== expected.hasStem;
      if (differs) {
        mismatched += 1;
        if (details.length < 6) {
          details.push(
            `  staff ${s} #${i} homr (${expected.center}) pos=${expected.position} stem=${expected.hasStem}`,
          );
          details.push(
            `  staff ${s} #${i} port ${describe(actual.box)} pos=${actual.position} stem=${actual.stem !== null}`,
          );
        }
      }
    }
  }
  report('staffsWithNotes', mismatched, expectedStaffs.length, staffs.length, noteTotal, details);
}

console.log(
  `\n${failures === 0 ? 'all note stages identical' : `${failures} stage(s) differ`} ` +
    `(${(performance.now() - started).toFixed(0)} ms)`,
);
if (failures > 0) process.exitCode = 1;
