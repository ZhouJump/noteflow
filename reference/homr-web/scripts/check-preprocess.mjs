/**
 * Compare the browser-side preprocessing against the Python baseline tensors.
 *
 * Runs in Node (no browser needed) so the image pipeline can be iterated quickly:
 *   node scripts/check-preprocess.mjs
 *
 * The error is measured in three separate steps so a regression can be attributed:
 *   1. jpeg decode   browser decoder vs libjpeg-turbo (cv2.imread)
 *   2. resize        our BICUBIC vs PIL BICUBIC, both fed the *same* decoded RGB
 *   3. clahe         our CLAHE vs cv2.createCLAHE, both fed the *same* gray
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { clahe, grayFromRgb, resizeBicubic } from '../src/lib/imageops.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/browser-reference', source);
const sourceImage = path.join(repo, 'samples/input', `${source}.jpg`);

// pngjs always hands back RGBA, including for grayscale files.
function readRgba(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { data: png.data, width: png.width, height: png.height };
}

function rgbaToRgb(rgba, width, height) {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0; i < out.length; i += 3, p += 4) {
    out[i] = rgba[p];
    out[i + 1] = rgba[p + 1];
    out[i + 2] = rgba[p + 2];
  }
  return out;
}

function readRgb(file) {
  const png = readRgba(file);
  return { data: rgbaToRgb(png.data, png.width, png.height), width: png.width, height: png.height };
}

function readGray(file) {
  const png = readRgba(file);
  const out = new Uint8Array(png.width * png.height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = png.data[p];
  return { data: out, width: png.width, height: png.height };
}

export function compare(label, actual, expected, { stride = 1 } = {}) {
  let maxAbs = 0;
  let maxAt = -1;
  let sumAbs = 0;
  let over1 = 0;
  let differing = 0;
  const length = Math.min(actual.length, expected.length);
  for (let i = 0; i < length; i += 1) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > maxAbs) {
      maxAbs = d;
      maxAt = i;
    }
    if (d > 1) over1 += 1;
    if (d !== 0) differing += 1;
    sumAbs += d;
  }
  const report = {
    label,
    lengthMismatch: actual.length !== expected.length ? `${actual.length}/${expected.length}` : null,
    maxAbs,
    meanAbs: Number((sumAbs / length).toFixed(4)),
    differingPct: Number(((differing / length) * 100).toFixed(3)),
    over1Pct: Number(((over1 / length) * 100).toFixed(3)),
    maxAt,
  };
  const where =
    maxAt >= 0 ? ` at x=${(maxAt / stride) | 0} c=${maxAt % stride}` : '';
  console.log(
    `${label.padEnd(28)} max=${String(maxAbs).padStart(3)} mean=${report.meanAbs.toFixed(4)} ` +
      `diff=${report.differingPct.toFixed(2)}% >1: ${report.over1Pct.toFixed(3)}%${where}`,
  );
  return report;
}

// ---------------------------------------------------------------- step 1: JPEG
const jpg = jpeg.decode(fs.readFileSync(sourceImage), { useTArray: true });
const browserRgb = rgbaToRgb(jpg.data, jpg.width, jpg.height);
console.log(`source ${jpg.width}x${jpg.height}`);

const decoded = readRgb(path.join(refDir, 'page_decoded.png'));
if (decoded.width !== jpg.width || decoded.height !== jpg.height) {
  console.log(`!! decoded size ${decoded.width}x${decoded.height} != ${jpg.width}x${jpg.height}`);
}
compare('jpeg rgb vs libjpeg-turbo', browserRgb, decoded.data, { stride: 3 });

// -------------------------------------------------------------- step 2: resize
const expectedResized = readRgb(path.join(refDir, 'page_resized.png'));
const dstW = expectedResized.width;
const dstH = expectedResized.height;

let t = performance.now();
const resizedFromCv = resizeBicubic(decoded.data, decoded.width, decoded.height, dstW, dstH, 3);
console.log(`resize ${(performance.now() - t).toFixed(0)} ms -> ${dstW}x${dstH}`);
compare('resize(cv2 decode) vs PIL', resizedFromCv, expectedResized.data, { stride: 3 });

t = performance.now();
const resizedFromBrowser = resizeBicubic(browserRgb, jpg.width, jpg.height, dstW, dstH, 3);
console.log(`resize(browser decode) ${(performance.now() - t).toFixed(0)} ms`);
compare('resize(browser) vs PIL', resizedFromBrowser, expectedResized.data, { stride: 3 });

// ---------------------------------------------------------------- step 3: gray
const expectedGray = readGray(path.join(refDir, 'page_gray.png'));
compare('gray(cv2 decode) vs cv2', grayFromRgb(resizedFromCv, dstW, dstH), expectedGray.data);

// --------------------------------------------------------------- step 4: clahe
const expectedClahe = readGray(path.join(refDir, 'page_clahe.png'));

t = performance.now();
const enhanced = clahe(grayFromRgb(resizedFromCv, dstW, dstH), dstW, dstH, 8, 8, 1.0);
console.log(`clahe ${(performance.now() - t).toFixed(0)} ms`);
compare('clahe(chained) vs cv2 CLAHE', enhanced, expectedClahe.data);

// What the worker will actually produce, starting from the browser's own decoder.
t = performance.now();
const browserEnhanced = clahe(grayFromRgb(resizedFromBrowser, dstW, dstH), dstW, dstH, 8, 8, 1.0);
console.log(`clahe(browser) ${(performance.now() - t).toFixed(0)} ms`);
compare('clahe(browser) vs cv2 CLAHE', browserEnhanced, expectedClahe.data);

fs.writeFileSync('/tmp/browser_clahe.bin', Buffer.from(enhanced));
fs.writeFileSync('/tmp/browser_clahe_from_browser.bin', Buffer.from(browserEnhanced));
