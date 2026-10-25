/**
 * Compare the browser minAreaRect / fitEllipse with cv2, one contour at a time.
 *
 *   node scripts/check-primitives.mjs [page]
 *
 * stage_primitives.json holds, for every external contour of the five filtered masks,
 * the contour points, cv2.minAreaRect and (when the contour has >= 5 points)
 * cv2.fitEllipse. Everything downstream is built from these two primitives, so a
 * mismatch here is always a primitive bug rather than a merge-logic bug.
 *
 * minAreaRect is compared on every mask, because every mask produces
 * RotatedBoundingBoxes. fitEllipse only feeds `create_bounding_ellipses`, which homr
 * calls for the notehead mask alone (main.py), so only those are a hard failure; the
 * rest are reported for information (they are mostly 1 px wide stems, where cv2 lands
 * on its degenerate fallback box).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { minAreaRect } from '../src/lib/vision/rect.ts';
import { fitEllipse } from '../src/lib/vision/ellipse.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/stage-reference', source);
const reference = JSON.parse(fs.readFileSync(path.join(refDir, 'stage_primitives.json'), 'utf8'));

// cv2 works in float32 and the reference is rounded to 4 decimals, so exact equality
// is not meaningful; 0.01 px is a tenth of a pixel and far below the int polygon
// truncation the boxes are built from.
const POSITION_TOLERANCE = 0.01;
const ANGLE_TOLERANCE = 0.01;

/** Masks whose ellipses reach the pipeline; see the header comment. */
const ELLIPSES_THAT_MATTER = new Set(['notehead']);

const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

function rectDiffers(actual, expected) {
  const [center, size, angle] = expected;
  return (
    !close(actual.center.x, center[0], POSITION_TOLERANCE) ||
    !close(actual.center.y, center[1], POSITION_TOLERANCE) ||
    !close(actual.size[0], size[0], POSITION_TOLERANCE) ||
    !close(actual.size[1], size[1], POSITION_TOLERANCE) ||
    !close(actual.angle, angle, ANGLE_TOLERANCE)
  );
}

function show(name, index, expected, actual) {
  const [center, size, angle] = expected;
  return (
    `${name} #${index}: cv2 (${center[0]},${center[1]}) (${size[0]},${size[1]}) ${angle} vs ` +
    `port (${actual.center.x.toFixed(4)},${actual.center.y.toFixed(4)}) ` +
    `(${actual.size[0].toFixed(4)},${actual.size[1].toFixed(4)}) ${actual.angle.toFixed(4)}`
  );
}

let failures = 0;
let rectChecked = 0;
let ellipseChecked = 0;

for (const [name, entries] of Object.entries(reference)) {
  let rectBad = 0;
  let ellipseBad = 0;
  let ellipseSkipped = 0;
  const rectDetails = [];
  const ellipseDetails = [];

  entries.forEach((entry, index) => {
    const points = entry.points.map(([x, y]) => ({ x, y }));

    const rect = minAreaRect(points);
    rectChecked += 1;
    if (rectDiffers(rect, entry.rect)) {
      rectBad += 1;
      if (rectDetails.length < 20) rectDetails.push(show('  rect', index, entry.rect, rect));
    }

    if (entry.ellipse) {
      const ellipse = fitEllipse(points);
      ellipseChecked += 1;
      if (rectDiffers(ellipse, entry.ellipse)) {
        if (ELLIPSES_THAT_MATTER.has(name)) {
          ellipseBad += 1;
          if (ellipseDetails.length < 10) {
            ellipseDetails.push(show('  ellipse', index, entry.ellipse, ellipse));
          }
        } else {
          ellipseSkipped += 1;
        }
      }
    }
  });

  const ok = rectBad === 0 && ellipseBad === 0;
  if (!ok) failures += 1;
  const ellipseLabel =
    ellipseBad > 0
      ? `${ellipseBad} differ`
      : ellipseSkipped > 0
        ? `IDENTICAL (${ellipseSkipped} unused differ)`
        : 'IDENTICAL';
  console.log(
    `${name.padEnd(11)} ${String(entries.length).padStart(4)} contours | ` +
      `rect ${rectBad === 0 ? 'IDENTICAL' : `${rectBad} differ`} | ellipse ${ellipseLabel}`,
  );
  for (const line of rectDetails) console.log(line);
  for (const line of ellipseDetails) console.log(line);
}

console.log(`\nchecked ${rectChecked} rects, ${ellipseChecked} ellipses`);
if (failures > 0) process.exitCode = 1;
