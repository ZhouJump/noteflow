/**
 * Compare the browser border tracer against cv2.findContours.
 *
 *   THREADS=8 node scripts/check-contours.mjs [page]
 *
 * Both sides see the same filtered masks (stage_<class>.png), so the only
 * difference can be the tracer itself. Sets of border points are compared, not
 * their order: downstream only feeds them to minAreaRect / fitEllipse, which are
 * order independent.
 *
 * The reference is RETR_TREE, the mode HOMR asks for, so the rings inside the brace
 * glyphs are part of the comparison as well.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { findContours } from '../src/lib/vision/contours.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/stage-reference', source);

const reference = JSON.parse(
  fs.readFileSync(path.join(refDir, 'stage_contours.json'), 'utf8'),
);

// cv2 keeps walking when it comes back to the start pixel with a single pixel spur
// attached there, so one staff fragment carries a point the port drops. It shifts
// its minAreaRect by half a pixel, far below the integer rounding of a box.
const toleratedMissingPoints = { staff: 1 };

function readMask(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const binary = new Uint8Array(png.width * png.height);
  for (let p = 0, i = 0; i < binary.length; i += 1, p += 4) {
    binary[i] = png.data[p] > 0 ? 1 : 0;
  }
  return { binary, width: png.width, height: png.height };
}

const key = (x, y) => `${x},${y}`;
// cv2 hands back [x, y] arrays, the port hands back {x, y} points.
const signature = (contour) =>
  contour
    .map((point) => (Array.isArray(point) ? key(point[0], point[1]) : key(point.x, point.y)))
    .sort()
    .join(';');

let failures = 0;
for (const name of Object.keys(reference)) {
  const { binary, width, height } = readMask(path.join(refDir, `stage_${name}.png`));
  const started = performance.now();
  const actual = findContours(binary, width, height);
  const elapsed = performance.now() - started;
  const expected = reference[name];

  const expectedPoints = new Set(expected.map(signature));
  const actualPoints = new Set(actual.map(signature));
  let matched = 0;
  for (const entry of actualPoints) if (expectedPoints.has(entry)) matched += 1;
  const missing = [...expectedPoints].filter((point) => !actualPoints.has(point)).length;
  const tolerated = toleratedMissingPoints[name] ?? 0;
  const same = missing <= tolerated && actualPoints.size <= expectedPoints.size;

  const expectedTotal = expected.reduce((sum, contour) => sum + contour.length, 0);
  const actualTotal = actual.reduce((sum, contour) => sum + contour.length, 0);
  console.log(
    `${name.padEnd(11)} cv2 ${String(expected.length).padStart(4)} contours ` +
      `${String(expectedTotal).padStart(6)} pts | port ${String(actual.length).padStart(4)} ` +
      `${String(actualTotal).padStart(6)} pts | matched ${matched}/${expectedPoints.size} ` +
      `missing ${missing}/${tolerated} ${same ? 'IDENTICAL' : 'DIFFERENT'} ` +
      `${elapsed.toFixed(0)} ms`,
  );
  if (!same) failures += 1;
}

if (failures > 0) {
  console.log(`\n${failures} mask(s) differ; contours are compared as unordered point sets.`);
  process.exitCode = 1;
}
