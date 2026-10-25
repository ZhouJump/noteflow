/**
 * Attribute the BICUBIC resize difference to the horizontal or vertical pass.
 *
 * Expects /tmp/pil_h.bin and /tmp/pil_full.bin from scripts/probe_resize.py.
 *   node scripts/probe-resize.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { resizeBicubic } from '../src/lib/imageops.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/browser-reference', source);

const png = PNG.sync.read(fs.readFileSync(path.join(refDir, 'page_decoded.png')));
const srcW = png.width;
const srcH = png.height;
const rgb = new Uint8Array(srcW * srcH * 3);
for (let i = 0, p = 0; i < rgb.length; i += 3, p += 4) {
  rgb[i] = png.data[p];
  rgb[i + 1] = png.data[p + 1];
  rgb[i + 2] = png.data[p + 2];
}

const dstW = 1920;
const dstH = 2714;

function stats(label, actual, expected, width) {
  const hist = new Int32Array(16);
  let maxAbs = 0;
  let signed = 0;
  let over1 = 0;
  const badX = new Map();
  const badC = [0, 0, 0];
  for (let i = 0; i < expected.length; i += 1) {
    const d = actual[i] - expected[i];
    const a = Math.abs(d);
    signed += d;
    if (a > maxAbs) maxAbs = a;
    if (a > 1) {
      over1 += 1;
      const x = ((i / 3) | 0) % width;
      badX.set(x, (badX.get(x) ?? 0) + 1);
      badC[i % 3] += 1;
    }
    hist[a < 16 ? a : 15] += 1;
  }
  const top = [...badX.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(
    `${label.padEnd(20)} max=${maxAbs} signedMean=${(signed / expected.length).toFixed(3)} ` +
      `>1=${over1} (${((over1 / expected.length) * 100).toFixed(2)}%)`,
  );
  console.log(`  hist0..15 ${Array.from(hist).join(' ')}`);
  console.log(`  >1 by channel ${badC.join('/')}`);
  console.log(`  >1 worst x ${top.map(([x, n]) => `${x}:${n}`).join(' ')}`);
}

const myH = resizeBicubic(rgb, srcW, srcH, dstW, srcH, 3);
const pilH = fs.readFileSync('/tmp/pil_h.bin');
stats('horizontal only', myH, pilH, dstW);

const myFull = resizeBicubic(rgb, srcW, srcH, dstW, dstH, 3);
const pilFull = fs.readFileSync('/tmp/pil_full.bin');
stats('full resize', myFull, pilFull, dstW);

// Split the vertical pass: feed *PIL's* horizontal result through our vertical pass.
const fromPilH = resizeBicubic(pilH, dstW, srcH, dstW, dstH, 3);
stats('vertical only', fromPilH, pilFull, dstW);
