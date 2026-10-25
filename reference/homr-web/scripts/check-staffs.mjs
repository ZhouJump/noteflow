/**
 * Compare the staff detection stages against HOMR's own output.
 *
 *   node scripts/check-staffs.mjs [page]
 *
 * The stages are checked in the order HOMR runs them: the staff fragments, the wide
 * fragment split, the three anchor searches, the anchor filter, the raw staffs, the
 * resampled grids, and finally the brace/dot symbols and the grand staff grouping.
 *
 * Inputs that the note stage already verified (clefs, keys and bar lines) are rebuilt
 * from the reference JSON, so a failure here points at the staff code and not at the
 * segmentation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  RotatedBoundingBox,
  createRotatedBoundingBoxes,
} from '../src/lib/homr/boundingBoxes.ts';
import {
  findBracesBracketsAndGrandStaffLines,
  prepareBraceDotImage,
} from '../src/lib/homr/braceDot.ts';
import {
  breakWideFragments,
  detectStaff,
  filterEdgeOfVision,
  filterUnusualAnchors,
  findRawStaffsByConnectingLineFragments,
  findStaffAnchors,
  predictOtherAnchorsFromClefs,
  removeDuplicateStaffs,
  resampleStaffs,
  sortStaffsTopToBottom,
} from '../src/lib/homr/staffDetection.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/stage-reference', source);

const load = (name) => JSON.parse(fs.readFileSync(path.join(refDir, name), 'utf8'));
const reference = {
  boxes: load('stage_boxes.json'),
  anchorCalls: load('stage_staffAnchorCalls.json'),
  anchorsKept: load('stage_staffAnchorsKept.json'),
  rawStaffs: load('stage_rawStaffs.json'),
  rawStaffsWithDuplicates: load('stage_rawStaffsWithDuplicates.json'),
  staffsBeforeMerge: load('stage_staffsBeforeMerge.json'),
  multiStaffs: load('stage_multiStaffs.json'),
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

/** The normalised box only: enough to identify the rect, ignores the polygon. */
function boxDiffers(box, expected) {
  return (
    !near(box.center.x, expected.center[0]) ||
    !near(box.center.y, expected.center[1]) ||
    !near(box.size[0], expected.size[0]) ||
    !near(box.size[1], expected.size[1]) ||
    !near(box.angle, expected.angle, ANGLE_TOLERANCE)
  );
}

/** Box plus the contour length, i.e. the full `_box_json`. */
function rectDiffers(box, expected) {
  return boxDiffers(box, expected) || box.contour.length !== expected.nContour;
}

const describe = (box) =>
  `(${box.center.x.toFixed(3)},${box.center.y.toFixed(3)}) ` +
  `(${box.size[0].toFixed(3)},${box.size[1].toFixed(3)}) ${box.angle.toFixed(3)} ` +
  `n=${box.contour.length}`;

const describeExpected = (entry) =>
  `(${entry.center[0]},${entry.center[1]}) (${entry.size[0]},${entry.size[1]}) ` +
  `${entry.angle} n=${entry.nContour}`;

/** Rebuild an input box from the reference; the polygon is not needed as an input. */
function rebuildBox(entry) {
  return new RotatedBoundingBox(
    {
      center: { x: entry.rect[0][0], y: entry.rect[0][1] },
      size: [entry.rect[1][0], entry.rect[1][1]],
      angle: entry.rect[2],
    },
    [],
  );
}

let failures = 0;

function report(name, mismatched, expectedCount, actualCount, total, details) {
  const same = mismatched === 0;
  if (!same) failures += 1;
  console.log(
    `${name.padEnd(24)} homr ${String(expectedCount).padStart(4)} | ` +
      `port ${String(actualCount).padStart(4)} | total ${String(total).padStart(5)} | ` +
      `${same ? 'IDENTICAL' : `${mismatched} differ`}`,
  );
  for (const line of details.slice(0, 8)) console.log(line);
}

function compareBoxes(name, boxes, expected) {
  const details = [];
  let mismatched = Math.abs(boxes.length - expected.length);
  for (let i = 0; i < Math.min(boxes.length, expected.length); i += 1) {
    if (rectDiffers(boxes[i], expected[i])) {
      mismatched += 1;
      if (details.length < 8) {
        details.push(`  #${i} homr ${describeExpected(expected[i])}`);
        details.push(`  #${i} port ${describe(boxes[i])}`);
      }
    }
  }
  report(name, mismatched, expected.length, boxes.length, boxes.length, details);
}

function linesDiffer(lines, expectedLines) {
  if (lines.length !== expectedLines.length) return true;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].length !== expectedLines[i].length) return true;
    for (let j = 0; j < lines[i].length; j += 1) {
      if (rectDiffers(lines[i][j], expectedLines[i][j])) return true;
    }
  }
  return false;
}

function anchorDiffers(anchor, expected) {
  return (
    boxDiffers(anchor.symbol, expected.symbol) ||
    !near(anchor.averageUnitSize, expected.unitSize, 0.001) ||
    anchor.zone.start !== expected.zone[0] ||
    anchor.zone.stop !== expected.zone[1] ||
    anchor.yRange.start !== expected.yRange[0] ||
    anchor.yRange.stop !== expected.yRange[1] ||
    !near(anchor.minY, expected.minY) ||
    !near(anchor.maxY, expected.maxY) ||
    linesDiffer(
      anchor.staffLines.map((line) => line.staffFragments),
      expected.lines,
    )
  );
}

function describeAnchor(anchor) {
  return (
    `symbol ${describe(anchor.symbol)} unit ${anchor.averageUnitSize.toFixed(4)} ` +
    `zone [${anchor.zone.start},${anchor.zone.stop}] ` +
    `lines ${anchor.staffLines.map((line) => line.staffFragments.length).join(',')}`
  );
}

function compareAnchors(name, anchors, expected) {
  const details = [];
  let mismatched = Math.abs(anchors.length - expected.length);
  for (let i = 0; i < Math.min(anchors.length, expected.length); i += 1) {
    if (anchorDiffers(anchors[i], expected[i])) {
      mismatched += 1;
      if (details.length < 8) {
        details.push(`  #${i} homr ${describeExpected(expected[i].symbol)} unit ${expected[i].unitSize} ` +
          `zone ${JSON.stringify(expected[i].zone)} lines ${expected[i].lines.map((l) => l.length).join(',')}`);
        details.push(`  #${i} port ${describeAnchor(anchors[i])}`);
      }
    }
  }
  report(name, mismatched, expected.length, anchors.length, anchors.length, details);
}

function gridDiffers(staff, expected) {
  if (
    staff.grid.length !== expected.grid.length ||
    !near(staff.averageUnitSize, expected.unitSize, 0.001) ||
    !near(staff.minX, expected.minX) ||
    !near(staff.maxX, expected.maxX) ||
    !near(staff.minY, expected.minY) ||
    !near(staff.maxY, expected.maxY) ||
    staff.isGrandStaff !== expected.isGrandStaff
  ) {
    return true;
  }
  for (let i = 0; i < staff.grid.length; i += 1) {
    const point = staff.grid[i];
    const expectedPoint = expected.grid[i];
    if (
      !near(point.x, expectedPoint.x, 0.001) ||
      !near(point.angle, expectedPoint.angle) ||
      point.y.length !== expectedPoint.y.length
    ) {
      return true;
    }
    for (let j = 0; j < point.y.length; j += 1) {
      if (!near(point.y[j], expectedPoint.y[j])) return true;
    }
  }
  return false;
}

function compareStaffs(name, staffs, expectedStaffs, total) {
  const details = [];
  let mismatched = Math.abs(staffs.length - expectedStaffs.length);
  for (let i = 0; i < Math.min(staffs.length, expectedStaffs.length); i += 1) {
    if (gridDiffers(staffs[i], expectedStaffs[i])) {
      mismatched += 1;
      if (details.length < 8) {
        const staff = staffs[i];
        details.push(
          `  #${i} homr grid ${expectedStaffs[i].grid.length} unit ${expectedStaffs[i].unitSize} ` +
            `x [${expectedStaffs[i].minX},${expectedStaffs[i].maxX}] y [${expectedStaffs[i].minY},${expectedStaffs[i].maxY}]`,
        );
        details.push(
          `  #${i} port grid ${staff.grid.length} unit ${staff.averageUnitSize.toFixed(4)} ` +
            `x [${staff.minX.toFixed(3)},${staff.maxX.toFixed(3)}] y [${staff.minY.toFixed(3)},${staff.maxY.toFixed(3)}]`,
        );
      }
    }
  }
  report(name, mismatched, expectedStaffs.length, staffs.length, total, details);
}

function compareRawStaffs(name, staffs, expectedStaffs) {
  const details = [];
  let mismatched = Math.abs(staffs.length - expectedStaffs.length);
  for (let i = 0; i < Math.min(staffs.length, expectedStaffs.length); i += 1) {
    const staff = staffs[i];
    const expected = expectedStaffs[i];
    let differs = staff.staffId !== expected.id || rectDiffers(staff, expected.box);
    differs ||= staff.anchors.length !== expected.anchors;
    differs ||= staff.lines.length !== expected.lines.length;
    for (let j = 0; !differs && j < staff.lines.length; j += 1) {
      const line = staff.lines[j];
      const expectedLine = expected.lines[j];
      differs =
        line.debugId !== expectedLine.debugId ||
        !near(line.minX, expectedLine.minX) ||
        !near(line.maxX, expectedLine.maxX) ||
        !near(line.minY, expectedLine.minY) ||
        !near(line.maxY, expectedLine.maxY) ||
        linesDiffer([line.staffFragments], [expectedLine.fragments]);
    }
    if (differs) {
      mismatched += 1;
      if (details.length < 8) {
        details.push(
          `  #${i} homr id ${expected.id} anchors ${expected.anchors} ` +
            `lines ${expected.lines.map((l) => `${l.debugId}:${l.fragments.length}`).join(',')}`,
        );
        details.push(
          `  #${i} port id ${staff.staffId} anchors ${staff.anchors.length} ` +
            `lines ${staff.lines.map((l) => `${l.debugId}:${l.staffFragments.length}`).join(',')}`,
        );
      }
    }
  }
  report(name, mismatched, expectedStaffs.length, staffs.length, staffs.length, details);
}

const started = performance.now();
const stronger = readMask(path.join(refDir, 'stage_staff_stronger.png'));
const symbolsMask = readMask(path.join(refDir, 'stage_symbols.png'));

let time = performance.now();
const staffFragments = createRotatedBoundingBoxes(stronger.binary, stronger.width, stronger.height, {
  skipMerging: true,
  minSize: [5, 1],
  maxSize: [10000, 100],
});
compareBoxes('staffFragments', staffFragments, reference.boxes.raw.staff_fragments);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

time = performance.now();
const brokenFragments = breakWideFragments(staffFragments);
compareBoxes('staffFragmentsBroken', brokenFragments, reference.boxes.staff_fragments_broken);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

const clefsKeys = reference.boxes.raw.clefs_keys.map(rebuildBox);
const barLines = reference.boxes.barLinesAccepted.map(rebuildBox);

// find_staff_anchors on the clefs
time = performance.now();
const clefAnchors = findStaffAnchors(brokenFragments, clefsKeys, true);
compareAnchors('staffAnchorsFromClefs', clefAnchors, reference.anchorCalls[0].anchors);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

// predict_other_anchors_from_clefs + find_staff_anchors on the prediction
time = performance.now();
const predictedClefs = predictOtherAnchorsFromClefs(clefAnchors, stronger);
const predictedAnchors = findStaffAnchors(brokenFragments, predictedClefs, true);
{
  const expected = reference.anchorCalls[1];
  const details = [];
  let mismatched = Math.abs(predictedClefs.length - expected.symbolCount);
  mismatched += Math.abs(predictedAnchors.length - expected.anchors.length);
  for (let i = 0; i < Math.min(predictedAnchors.length, expected.anchors.length); i += 1) {
    if (anchorDiffers(predictedAnchors[i], expected.anchors[i])) mismatched += 1;
  }
  report(
    'staffAnchorsPredicted',
    mismatched,
    expected.anchors.length,
    predictedAnchors.length,
    predictedClefs.length,
    details,
  );
  console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);
}

// find_staff_anchors on the bar lines
time = performance.now();
const barAnchors = findStaffAnchors(brokenFragments, barLines, false);
compareAnchors('staffAnchorsFromBarLines', barAnchors, reference.anchorCalls[2].anchors);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

// filter_unusual_anchors
const allAnchors = [...clefAnchors, ...predictedAnchors, ...barAnchors];
const keptAnchors = filterUnusualAnchors(allAnchors);
compareAnchors('staffAnchorsKept', keptAnchors, reference.anchorsKept);

// find_raw_staffs_by_connecting_line_fragments, then remove_duplicate_staffs
time = performance.now();
const rawWithDuplicates = findRawStaffsByConnectingLineFragments(keptAnchors, brokenFragments);
compareRawStaffs('rawStaffsWithDuplicates', rawWithDuplicates, reference.rawStaffsWithDuplicates);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

time = performance.now();
const rawStaffs = removeDuplicateStaffs(rawWithDuplicates);
compareRawStaffs('rawStaffs', rawStaffs, reference.rawStaffs);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

// resample_staffs, filter_edge_of_vision, sort, recover
time = performance.now();
let staffs = resampleStaffs(rawStaffs);
// resample_staffs returns the staffs bottom to top: sort before comparing with the reference.
compareStaffs(
  'staffsResampled',
  sortStaffsTopToBottom(staffs),
  reference.staffsBeforeMerge,
  staffs.length,
);
staffs = filterEdgeOfVision(staffs, stronger.height, stronger.width);
staffs = sortStaffsTopToBottom(staffs);
compareStaffs('staffsBeforeMerge', staffs, reference.staffsBeforeMerge, staffs.length);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

// The end to end call has to return the same staffs.
time = performance.now();
const detected = detectStaff(stronger, brokenFragments, clefsKeys, barLines);
compareStaffs('detectStaff', detected, reference.staffsBeforeMerge, detected.length);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

// brace/dot symbols
time = performance.now();
const braceDotImage = prepareBraceDotImage(
  { binary: symbolsMask.binary, width: symbolsMask.width, height: symbolsMask.height },
  stronger,
);
const braceDot = createRotatedBoundingBoxes(braceDotImage, symbolsMask.width, symbolsMask.height, {
  skipMerging: true,
  maxSize: [100, -1],
});
compareBoxes('braceDot', braceDot, reference.boxes.braceDot);
console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);

// find_braces_brackets_and_grand_staff_lines
time = performance.now();
const multiStaffs = findBracesBracketsAndGrandStaffLines(staffs, braceDot);
{
  const expected = reference.multiStaffs;
  const details = [];
  let mismatched = Math.abs(multiStaffs.length - expected.length);
  for (let i = 0; i < Math.min(multiStaffs.length, expected.length); i += 1) {
    const actual = multiStaffs[i];
    const referenceMulti = expected[i];
    let differs = actual.staffs.length !== referenceMulti.staffCount;
    differs ||= actual.connections.length !== referenceMulti.connections.length;
    for (let j = 0; !differs && j < actual.connections.length; j += 1) {
      differs = boxDiffers(actual.connections[j], referenceMulti.connections[j]);
    }
    for (let j = 0; !differs && j < actual.staffs.length; j += 1) {
      differs = gridDiffers(actual.staffs[j], referenceMulti.staffs[j]);
    }
    if (differs) {
      mismatched += 1;
      if (details.length < 8) {
        details.push(
          `  #${i} homr staffs ${referenceMulti.staffCount} ` +
            `grids ${referenceMulti.staffs.map((s) => s.grid.length).join(',')} ` +
            `connections ${referenceMulti.connections.length}`,
        );
        details.push(
          `  #${i} port staffs ${actual.staffs.length} ` +
            `grids ${actual.staffs.map((s) => s.grid.length).join(',')} ` +
            `connections ${actual.connections.length}`,
        );
      }
    }
  }
  report('multiStaffs', mismatched, expected.length, multiStaffs.length, multiStaffs.length, details);
  console.log(`  (${(performance.now() - time).toFixed(0)} ms)`);
}

console.log(
  `\n${failures === 0 ? 'all staff stages identical' : `${failures} stage(s) differ`} ` +
    `(${(performance.now() - started).toFixed(0)} ms)`,
);
if (failures > 0) process.exitCode = 1;
