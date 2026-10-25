/**
 * Compare `prepareStaffImage` with HOMR's `stage_canvases.json` and canvas PNGs.
 *
 *   node web/scripts/check-dewarp.mjs R-C
 *
 * `DEWARP=0` runs the same comparison with the column warp switched off, which shows
 * whether the warp moves the canvas towards or away from HOMR's Delaunay result.
 *
 * The page image comes from `artifacts/browser-reference/<name>/page_clahe.png`, the
 * geometry references from `artifacts/stage-reference/<name>/`. Three things are
 * checked per staff: the staff after the region crop and scale, the staff in canvas
 * coordinates, and the canvas pixels. The port uses a column wise piecewise linear
 * dewarp instead of HOMR's Delaunay mesh, so the staff coordinates are expected to
 * match and the pixels are expected to differ around the warped pixels only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { MultiStaff, Staff, StaffPoint } from '../src/lib/homr/model.ts';
import { StaffRegions, prepareStaffImage } from '../src/lib/homr/staffParsing.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? 'R-C';
const dewarp = process.env.DEWARP !== '0';
const stageDir = path.join(repo, 'artifacts/stage-reference', source);
const browserDir = path.join(repo, 'artifacts/browser-reference', source);

const load = (name) => JSON.parse(fs.readFileSync(path.join(stageDir, name), 'utf8'));

function readGray(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const data = new Uint8Array(png.width * png.height);
  for (let index = 0; index < data.length; index += 1) data[index] = png.data[index * 4];
  return { data, width: png.width, height: png.height };
}

function rebuildStaff(entry) {
  return new Staff(
    entry.grid.map((point) => new StaffPoint(point.x, [...point.y], point.angle)),
  );
}

const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance;

function gridDiffers(staff, expected, tolerance = 0.01, unitTolerance = 0.001) {
  if (staff.grid.length !== expected.grid.length) return `grid length ${staff.grid.length}`;
  if (!near(staff.averageUnitSize, expected.unitSize, unitTolerance)) {
    return `unit ${staff.averageUnitSize} != ${expected.unitSize}`;
  }
  if (!near(staff.minX, expected.minX, tolerance)) return `minX ${staff.minX} != ${expected.minX}`;
  if (!near(staff.maxX, expected.maxX, tolerance)) return `maxX ${staff.maxX} != ${expected.maxX}`;
  if (!near(staff.minY, expected.minY, tolerance)) return `minY ${staff.minY} != ${expected.minY}`;
  if (!near(staff.maxY, expected.maxY, tolerance)) return `maxY ${staff.maxY} != ${expected.maxY}`;
  for (let index = 0; index < staff.grid.length; index += 1) {
    const point = staff.grid[index];
    const target = expected.grid[index];
    if (!near(point.x, target.x, tolerance)) return `point ${index} x ${point.x} != ${target.x}`;
    if (!near(point.angle, target.angle, tolerance)) {
      return `point ${index} angle ${point.angle} != ${target.angle}`;
    }
    for (let row = 0; row < point.y.length; row += 1) {
      if (!near(point.y[row], target.y[row], tolerance)) {
        return `point ${index} y[${row}] ${point.y[row]} != ${target.y[row]}`;
      }
    }
  }
  return null;
}

function describeGrid(staff) {
  return (
    `grid ${staff.grid.length} unit ${staff.averageUnitSize.toFixed(4)} ` +
    `x [${staff.minX.toFixed(2)},${staff.maxX.toFixed(2)}] ` +
    `y [${staff.minY.toFixed(2)},${staff.maxY.toFixed(2)}]`
  );
}

function compareTransform(actual, expected) {
  const names = ['regionTopLeft', 'regionScaling', 'cropTopLeft', 'canvasScaling', 'canvasYOffset'];
  for (const name of names) {
    const a = actual[name];
    const b = expected[name];
    if (Array.isArray(a)) {
      for (let index = 0; index < a.length; index += 1) {
        if (!near(a[index], b[index], 0.001)) return name;
      }
    } else if (!near(a, b, 0.001)) {
      return name;
    }
  }
  return null;
}

function compareCanvas(actual, expected) {
  let changed = 0;
  let sum = 0;
  let maximum = 0;
  for (let index = 0; index < actual.data.length; index += 1) {
    const difference = Math.abs(actual.data[index] - expected.data[index]);
    if (difference !== 0) changed += 1;
    sum += difference;
    if (difference > maximum) maximum = difference;
  }
  return {
    changed,
    percent: (100 * changed) / actual.data.length,
    mean: sum / actual.data.length,
    maximum,
  };
}

const canvases = load('stage_canvases.json');
const multiEntries = load('stage_multiStaffs.json');
const page = readGray(path.join(browserDir, 'page_clahe.png'));
const multiStaffs = multiEntries.map(
  (entry) => new MultiStaff(entry.staffs.map(rebuildStaff), []),
);
const regions = new StaffRegions(multiStaffs);

const started = performance.now();
let failures = 0;
let index = 0;
for (let voice = 0; voice < multiStaffs[0].staffs.length; voice += 1) {
  for (const multiStaff of multiStaffs) {
    const staff = multiStaff.staffs[voice];
    const reference = canvases[index];
    const time = performance.now();
    const prepared = prepareStaffImage(index, staff, page, regions, { dewarp });
    const elapsed = performance.now() - time;

    const problems = [];
    const transformedProblem = gridDiffers(prepared.transformedStaff, reference.transformedStaff);
    if (transformedProblem) {
      problems.push(
        `transformed: ${transformedProblem}; port ${describeGrid(prepared.transformedStaff)} / homr ${describeGrid(
          rebuildStaff(reference.transformedStaff),
        )}`,
      );
    }
    // The mesh moves every staff grid point through its own triangle, the column warp
    // interpolates per axis, so the two disagree by a few pixels where the warp is not
    // affine - measured on the samples 3.0-6.0 px, always on the outermost grid points.
    // The canvas pixels below are the real criterion; this only catches gross drift.
    const canvasProblem = gridDiffers(prepared.finalStaff, reference.canvasStaff, 8, 0.01);
    if (canvasProblem) {
      problems.push(
        `canvas staff: ${canvasProblem}; port ${describeGrid(prepared.finalStaff)} / homr ${describeGrid(
          rebuildStaff(reference.canvasStaff),
        )}`,
      );
    }
    const transformName = compareTransform(
      {
        regionTopLeft: prepared.transform.regionTopLeft,
        regionScaling: prepared.transform.regionScaling,
        cropTopLeft: prepared.transform.cropTopLeft,
        canvasScaling: prepared.transform.canvasScaling,
        canvasYOffset: prepared.transform.canvasYOffset,
      },
      reference.transform,
    );
    if (transformName) problems.push(`transform ${transformName} differs`);

    const expectedCanvas = readGray(path.join(stageDir, `stage_staff-${index}_canvas.png`));
    if (
      prepared.canvas.width !== expectedCanvas.width ||
      prepared.canvas.height !== expectedCanvas.height
    ) {
      problems.push(
        `canvas size ${prepared.canvas.width}x${prepared.canvas.height} != ${expectedCanvas.width}x${expectedCanvas.height}`,
      );
    }
    const pixels = compareCanvas(prepared.canvas, expectedCanvas);
    if (pixels.percent > 5) {
      problems.push(`canvas pixels ${pixels.percent.toFixed(2)}% differ, more than the warp explains`);
    }

    if (problems.length > 0) failures += 1;
    const status = problems.length === 0 ? 'ok  ' : 'DIFF';
    console.log(
      `${status} staff ${index} (${elapsed.toFixed(0)} ms) pixels: ` +
        `${pixels.changed} differ (${pixels.percent.toFixed(2)}%), ` +
        `max ${pixels.maximum}, mean ${pixels.mean.toFixed(3)}`,
    );
    for (const problem of problems) console.log(`     ${problem}`);
    index += 1;
  }
}

console.log(
  `\n${failures === 0 ? 'all staff canvases reproduced' : `${failures} staff stage(s) differ`} ` +
    `(${(performance.now() - started).toFixed(0)} ms)`,
);
if (failures > 0) process.exitCode = 1;
