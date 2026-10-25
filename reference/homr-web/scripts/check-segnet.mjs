/**
 * M3: run the real SegNet over the whole page in onnxruntime-web (WASM) and
 * compare the merged class map with the Python reference.
 *
 * The tiling, the white padding, the score averaging and the argmax tie break
 * all follow homr/segmentation/inference_segnet.py so any mismatch is a port bug
 * rather than a different merge rule.
 *
 *   THREADS=8 node scripts/check-segnet.mjs [page]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as ort from 'onnxruntime-web';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const page = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/browser-reference', page);
const model = path.join(
  repo,
  'homr/homr/segmentation/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx',
);

const WIN = 320;
const STEP = 320;
const CLASSES = 6;

ort.env.logLevel = 'error';
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 1);
ort.env.wasm.simd = true;

const readGray = (file) => {
  const png = PNG.sync.read(fs.readFileSync(file));
  const out = new Uint8Array(png.width * png.height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = png.data[p];
  return { data: out, width: png.width, height: png.height };
};

const clahePage = readGray(path.join(refDir, 'page_clahe.png'));
const expected = readGray(path.join(refDir, 'page_mask.png'));
const { width: w, height: h } = clahePage;
console.log(`page ${w}x${h}   threads=${ort.env.wasm.numThreads}`);

// Tile origins, generated exactly like inference().
const ys = [];
for (let y = 0; y < Math.max(h, WIN); y += STEP) ys.push(Math.min(y, h - WIN));
const xs = [];
for (let x = 0; x < Math.max(w, WIN); x += STEP) xs.push(Math.min(x, w - WIN));
console.log(`tile grid ${xs.length}x${ys.length} = ${xs.length * ys.length} tiles`);

const session = await ort.InferenceSession.create(model, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});
const inputName = session.inputNames[0];
const outputName = session.outputNames[0];
console.log(`session ready, input=${inputName} output=${outputName}`);

/** float32 [3,320,320], white padded, filled straight from the gray page. */
function extractPatch(y, x) {
  const patch = new Float32Array(3 * WIN * WIN).fill(255);
  const y0 = Math.max(y, 0);
  const x0 = Math.max(x, 0);
  const y1 = Math.min(y + WIN, h);
  const x1 = Math.min(x + WIN, w);
  const rows = y1 - y0;
  const cols = x1 - x0;
  for (let c = 0; c < 3; c += 1) {
    const base = c * WIN * WIN;
    for (let row = 0; row < rows; row += 1) {
      const src = (y0 + row) * w + x0;
      const dst = base + row * WIN;
      for (let col = 0; col < cols; col += 1) patch[dst + col] = clahePage.data[src + col];
    }
  }
  return patch;
}

const scoreSum = new Float32Array(CLASSES * w * h);
const coverage = new Float32Array(w * h);
const tile0Ref = fs.existsSync(path.join(refDir, 'segnet_tile0_out.bin'))
  ? new Float32Array(fs.readFileSync(path.join(refDir, 'segnet_tile0_out.bin')).buffer.slice(0))
  : null;

let index = 0;
let tile0Diff = null;
const started = performance.now();
for (const y of ys) {
  for (const x of xs) {
    const input = new ort.Tensor('float32', extractPatch(y, x), [1, 3, WIN, WIN]);
    const out = await session.run({ [inputName]: input });
    const scores = out[outputName].data;

    if (tile0Diff === null && tile0Ref) {
      let max = 0;
      let sum = 0;
      for (let i = 0; i < scores.length; i += 1) {
        const d = Math.abs(scores[i] - tile0Ref[i]);
        if (d > max) max = d;
        sum += d;
      }
      tile0Diff = { max, mean: sum / scores.length };
    }

    const y0 = Math.max(y, 0);
    const x0 = Math.max(x, 0);
    const y1 = Math.min(y + WIN, h);
    const x1 = Math.min(x + WIN, w);
    for (let c = 0; c < CLASSES; c += 1) {
      const plane = c * w * h;
      for (let row = y0; row < y1; row += 1) {
        const src = c * WIN * WIN + (row - y0) * WIN;
        const dst = plane + row * w + x0;
        for (let col = 0; col < x1 - x0; col += 1) scoreSum[dst + col] += scores[src + col];
      }
    }
    for (let row = y0; row < y1; row += 1) {
      const dst = row * w + x0;
      for (let col = 0; col < x1 - x0; col += 1) coverage[dst + col] += 1;
    }

    index += 1;
    if (index % 6 === 0 || index === xs.length * ys.length) {
      const ms = performance.now() - started;
      console.log(`  ${String(index).padStart(3)}/${xs.length * ys.length} tiles  ${(ms / index).toFixed(0)} ms/tile`);
    }
  }
}
const segMs = performance.now() - started;
console.log(`segnet total ${(segMs / 1000).toFixed(1)} s, ${(segMs / index).toFixed(0)} ms/tile`);

if (tile0Diff) {
  console.log(
    `tile0 scores vs onnxruntime-python: max=${tile0Diff.max.toExponential(2)} mean=${tile0Diff.mean.toExponential(2)}`,
  );
}

// argmax with numpy's first-wins tie break.
const merged = new Uint8Array(w * h);
let argmaxDiff = 0;
let wrong = 0;
const perClass = new Map();
for (let i = 0; i < w * h; i += 1) {
  const cov = coverage[i] || 1;
  let best = 0;
  let bestScore = scoreSum[i] / cov;
  for (let c = 1; c < CLASSES; c += 1) {
    const s = scoreSum[c * w * h + i] / cov;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  merged[i] = best;
  const want = expected.data[i];
  if (best !== want) {
    wrong += 1;
    const key = `${want}->${best}`;
    perClass.set(key, (perClass.get(key) ?? 0) + 1);
  }
}
void argmaxDiff;

const total = w * h;
console.log(`mask agreement ${(((total - wrong) / total) * 100).toFixed(3)}% (${wrong} px differ)`);
for (const [key, count] of [...perClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${key}: ${count}`);
}

for (let c = 0; c < CLASSES; c += 1) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < total; i += 1) {
    const a = merged[i] === c;
    const b = expected.data[i] === c;
    if (a && b) tp += 1;
    else if (a) fp += 1;
    else if (b) fn += 1;
  }
  const iou = tp + fp + fn === 0 ? 1 : tp / (tp + fp + fn);
  console.log(`  class ${c}: IoU=${iou.toFixed(4)} ref=${tp + fn} got=${tp + fp}`);
}
