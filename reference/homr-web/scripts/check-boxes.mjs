/**
 * Compare the browser box factories against HOMR's own output.
 *
 *   node scripts/check-boxes.mjs [page]
 *
 * Every input is the same PNG HOMR saw: stage_notehead.png, stage_clefs_keys.png and
 * stage_stems_rest.png are the filtered masks, stage_staff_stronger.png is the staff
 * mask after make_lines_stronger. The bar line image is built from stems_rest with
 * prepare_bar_line_image, exactly like main.predict_symbols does it.
 *
 * Boxes are compared one by one on the normalised rect (centre / size / angle) and on
 * the point count of the contour they were fitted to; the order of the list is part of
 * the comparison because the merged groups keep the order of their first box.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  createBoundingEllipses,
  createRotatedBoundingBoxes,
} from '../src/lib/homr/boundingBoxes.ts';
import { makeLinesStronger } from '../src/lib/homr/masks.ts';
import { dilate, rectangleKernel } from '../src/lib/vision/morphology.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/stage-reference', source);

const reference = JSON.parse(fs.readFileSync(path.join(refDir, 'stage_boxes.json'), 'utf8'));

const POSITION_TOLERANCE = 0.01;
const ANGLE_TOLERANCE = 0.01;

function readMask(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const binary = new Uint8Array(png.width * png.height);
  for (let i = 0; i < binary.length; i += 1) binary[i] = png.data[i * 4] > 0 ? 1 : 0;
  return { binary, width: png.width, height: png.height };
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

function boxDiffers(box, expected) {
  return (
    !near(box.center.x, expected.center[0], POSITION_TOLERANCE) ||
    !near(box.center.y, expected.center[1], POSITION_TOLERANCE) ||
    !near(box.size[0], expected.size[0], POSITION_TOLERANCE) ||
    !near(box.size[1], expected.size[1], POSITION_TOLERANCE) ||
    !near(box.angle, expected.angle, ANGLE_TOLERANCE) ||
    !near(box.box.center.x, expected.rect[0][0], POSITION_TOLERANCE) ||
    !near(box.box.center.y, expected.rect[0][1], POSITION_TOLERANCE) ||
    !near(box.box.size[0], expected.rect[1][0], POSITION_TOLERANCE) ||
    !near(box.box.size[1], expected.rect[1][1], POSITION_TOLERANCE) ||
    !near(box.box.angle, expected.rect[2], ANGLE_TOLERANCE) ||
    box.contour.length !== expected.nContour
  );
}

function describe(box) {
  const { center, size, angle } = box;
  return (
    `(${center.x.toFixed(3)},${center.y.toFixed(3)}) ` +
    `(${size[0].toFixed(3)},${size[1].toFixed(3)}) ${angle.toFixed(3)} ` +
    `n=${box.contour.length}`
  );
}

function describeExpected(entry) {
  return (
    `(${entry.center[0]},${entry.center[1]}) (${entry.size[0]},${entry.size[1]}) ` +
    `${entry.angle} n=${entry.nContour}`
  );
}

let failures = 0;

function compare(name, actual, expected) {
  const details = [];
  let mismatched = Math.abs(actual.length - expected.length);
  const shared = Math.min(actual.length, expected.length);
  for (let i = 0; i < shared; i += 1) {
    if (boxDiffers(actual[i], expected[i])) {
      mismatched += 1;
      if (details.length < 6) {
        details.push(`  #${i} homr ${describeExpected(expected[i])}`);
        details.push(`  #${i} port ${describe(actual[i])}`);
      }
    }
  }
  const same = mismatched === 0;
  if (!same) failures += 1;
  console.log(
    `${name.padEnd(18)} homr ${String(expected.length).padStart(4)} boxes | ` +
      `port ${String(actual.length).padStart(4)} | ${same ? 'IDENTICAL' : `${mismatched} differ`}`,
  );
  for (const line of details) console.log(line);
}

const noteheadMask = readMask(path.join(refDir, 'stage_notehead.png'));
const clefsMask = readMask(path.join(refDir, 'stage_clefs_keys.png'));
const stemsMask = readMask(path.join(refDir, 'stage_stems_rest.png'));
const staffMask = readMask(path.join(refDir, 'stage_staff.png'));
const strongerMask = readMask(path.join(refDir, 'stage_staff_stronger.png'));

// make_lines_stronger first: the staff fragments are built from the dilated mask.
let started = performance.now();
const stronger = makeLinesStronger(staffMask.binary, staffMask.width, staffMask.height, [1, 2]);
let maskDiff = 0;
for (let i = 0; i < stronger.length; i += 1) {
  if (stronger[i] !== strongerMask.binary[i]) maskDiff += 1;
}
const maskSame = maskDiff === 0;
if (!maskSame) failures += 1;
console.log(
  `make_lines_stronger  ${maskSame ? 'IDENTICAL' : `${maskDiff} pixels differ`} ` +
    `(${(performance.now() - started).toFixed(0)} ms)`,
);

started = performance.now();
compare(
  'noteheads',
  createBoundingEllipses(noteheadMask.binary, noteheadMask.width, noteheadMask.height, {
    minSize: [4, 4],
  }),
  reference.raw.noteheads,
);
console.log(`  ${(performance.now() - started).toFixed(0)} ms`);

started = performance.now();
compare(
  'staff_fragments',
  createRotatedBoundingBoxes(stronger, staffMask.width, staffMask.height, {
    skipMerging: true,
    minSize: [5, 1],
    maxSize: [10000, 100],
  }),
  reference.raw.staff_fragments,
);
console.log(`  ${(performance.now() - started).toFixed(0)} ms`);

started = performance.now();
compare(
  'clefs_keys',
  createRotatedBoundingBoxes(clefsMask.binary, clefsMask.width, clefsMask.height, {
    minSize: [20, 40],
    maxSize: [1000, 1000],
  }),
  reference.raw.clefs_keys,
);
console.log(`  ${(performance.now() - started).toFixed(0)} ms`);

started = performance.now();
compare(
  'stems_rest',
  createRotatedBoundingBoxes(stemsMask.binary, stemsMask.width, stemsMask.height),
  reference.raw.stems_rest,
);
console.log(`  ${(performance.now() - started).toFixed(0)} ms`);

started = performance.now();
const barLineImage = dilate(
  stemsMask.binary,
  stemsMask.width,
  stemsMask.height,
  rectangleKernel(3, 5),
);
compare(
  'bar_lines',
  createRotatedBoundingBoxes(barLineImage, stemsMask.width, stemsMask.height, {
    skipMerging: true,
    minSize: [1, 5],
  }),
  reference.raw.bar_lines,
);
console.log(`  ${(performance.now() - started).toFixed(0)} ms`);

console.log(
  `\n${failures === 0 ? 'all box sets identical' : `${failures} box set(s) differ`}`,
);
if (failures > 0) process.exitCode = 1;
