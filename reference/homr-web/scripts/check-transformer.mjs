/**
 * M3: encoder + greedy decoder for every staff strip in onnxruntime-web (WASM),
 * compared against the Python reference.
 *
 * The decoder loop mirrors homr/transformer/decoder_inference.py exactly: same
 * cache growth, same `cache_len`, same "full context on step 0, one position
 * afterwards" rule, and the same first-wins argmax. Tokens are compared as
 * strings through vocab.json so a vocabulary numbering mismatch cannot hide.
 *
 *   THREADS=8 node scripts/check-transformer.mjs [page] [staffIndex...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as ort from 'onnxruntime-web';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const page = args[0] ?? '永远同在1';
const only = args.slice(1).map(Number);
const refDir = path.join(repo, 'artifacts/browser-reference', page);
const dir = path.join(repo, 'homr/homr/transformer');
const encoderPath = path.join(dir, 'encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx');
const decoderPath = path.join(dir, 'decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx');

const HEIGHT = 256;
const WIDTH = 1280;
const EOS = 2;
const BOS = 1;
const NONOTE = 0;
const MAX_SEQ = 608;
const MEAN = 0.7931;
const STD = 0.1738;

ort.env.logLevel = 'error';
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 1);
ort.env.wasm.simd = true;

const readGray = (file) => {
  const png = PNG.sync.read(fs.readFileSync(file));
  const out = new Uint8Array(png.width * png.height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = png.data[p];
  return { data: out, width: png.width, height: png.height };
};

const f32 = (file) => {
  const buf = fs.readFileSync(file);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

const vocab = JSON.parse(fs.readFileSync(path.join(refDir, 'vocab.json'), 'utf8'));
const tokenOf = (head, id) => vocab[head]?.[String(id)] ?? `#${id}`;

const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;

console.log(`onnxruntime-web wasm threads=${ort.env.wasm.numThreads}`);

const encoder = await ort.InferenceSession.create(encoderPath, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});
const decoder = await ort.InferenceSession.create(decoderPath, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});
console.log(`encoder in=${encoder.inputNames} out=${encoder.outputNames}`);
console.log(`decoder in=${decoder.inputNames.length} out=${decoder.outputNames.length}`);

const staffs = fs
  .readdirSync(refDir)
  .filter((f) => /^staff_\d+_input\.png$/.test(f))
  .map((f) => Number(f.split('_')[1]))
  .sort((a, b) => a - b)
  .filter((i) => only.length === 0 || only.includes(i));

const collect = (ids) => ids.map((id) => tokenOf('rhythm', id));

for (const index of staffs) {
  const canvas = readGray(path.join(refDir, `staff_${index}_input.png`));
  if (canvas.width !== WIDTH || canvas.height !== HEIGHT) {
    console.log(`staff ${index}: canvas ${canvas.width}x${canvas.height} unexpected, skipping`);
    continue;
  }

  const input = new Float32Array(HEIGHT * WIDTH);
  for (let i = 0; i < input.length; i += 1) input[i] = (canvas.data[i] / 255 - MEAN) / STD;

  const t0 = performance.now();
  const enc = await encoder.run({
    [encoder.inputNames[0]]: new ort.Tensor('float32', input, [1, 1, HEIGHT, WIDTH]),
  });
  const context = enc[encoder.outputNames[0]];
  const encMs = performance.now() - t0;

  const expectedContext = f32(path.join(refDir, `staff_${index}_context.bin`));
  let cMax = 0;
  let cSum = 0;
  for (let i = 0; i < expectedContext.length; i += 1) {
    const d = Math.abs(context.data[i] - expectedContext[i]);
    if (d > cMax) cMax = d;
    cSum += d;
  }
  console.log(
    `staff ${index}: encoder ${fmt(encMs)} context ${context.dims.join('x')} ` +
      `vs python max=${cMax.toExponential(2)} mean=${(cSum / expectedContext.length).toExponential(2)}`,
  );

  const reference = JSON.parse(fs.readFileSync(path.join(refDir, `staff_${index}_symbols.json`), 'utf8'));

  // Greedy loop, cache-shaped like init_cache().
  let cache = [];
  for (let i = 0; i < 32; i += 1) {
    cache.push(new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]));
  }
  let rhythm = [BOS];
  let pitch = [NONOTE];
  let lift = [NONOTE];
  let articulation = [NONOTE];
  let slur = [NONOTE];

  const steps = [];
  const t1 = performance.now();
  for (let step = 0; step < MAX_SEQ; step += 1) {
    const feeds = {
      rhythms: new ort.Tensor('int64', BigInt64Array.from([BigInt(rhythm.at(-1))]), [1, 1]),
      pitchs: new ort.Tensor('int64', BigInt64Array.from([BigInt(pitch.at(-1))]), [1, 1]),
      lifts: new ort.Tensor('int64', BigInt64Array.from([BigInt(lift.at(-1))]), [1, 1]),
      articulations: new ort.Tensor('int64', BigInt64Array.from([BigInt(articulation.at(-1))]), [1, 1]),
      slurs: new ort.Tensor('int64', BigInt64Array.from([BigInt(slur.at(-1))]), [1, 1]),
      cache_len: new ort.Tensor('int64', BigInt64Array.from([BigInt(step)]), [1]),
      context:
        step === 0
          ? context
          : new ort.Tensor('float32', context.data.slice(0, 512), [1, 1, 512]),
    };
    for (let i = 0; i < 32; i += 1) feeds[`cache_in${i}`] = cache[i];

    const out = await decoder.run(feeds);
    cache = [];
    for (let i = 0; i < 32; i += 1) cache.push(out[`cache_out${i}`]);

    const pick = (name) => {
      const tensor = out[name];
      const stride = tensor.dims[tensor.dims.length - 1];
      const base = tensor.data.length - stride;
      let best = 0;
      for (let i = 1; i < stride; i += 1) if (tensor.data[base + i] > tensor.data[base + best]) best = i;
      return best;
    };

    const rhythmId = pick('out_rhythms');
    if (rhythmId === EOS) break;
    const pitchId = pick('out_pitchs');
    const liftId = pick('out_lifts');
    const articulationId = pick('out_articulations');
    const slurId = pick('out_slurs');
    const positionId = pick('out_positions');

    rhythm.push(rhythmId);
    pitch.push(pitchId);
    lift.push(liftId);
    articulation.push(articulationId);
    slur.push(slurId);

    steps.push({
      rhythm: tokenOf('rhythm', rhythmId),
      pitch: tokenOf('pitch', pitchId),
      lift: tokenOf('lift', liftId),
      articulation: tokenOf('articulation', articulationId),
      slur: tokenOf('slur', slurId),
      position: tokenOf('position', positionId),
    });
  }
  const decMs = performance.now() - t1;

  const heads = ['rhythm', 'pitch', 'lift', 'articulation', 'slur', 'position'];
  const bad = {};
  for (const head of heads) bad[head] = 0;
  const limit = Math.min(steps.length, reference.length);
  for (let i = 0; i < limit; i += 1) {
    for (const head of heads) {
      if (steps[i][head] !== reference[i][head]) bad[head] += 1;
    }
  }
  const mismatched = heads.reduce((sum, head) => sum + bad[head], 0);
  console.log(
    `staff ${index}: decoder ${fmt(decMs)} ${steps.length} steps (ref ${reference.length}) ` +
      `token mismatches ${mismatched}` +
      (mismatched ? ` ${JSON.stringify(bad)}` : ''),
  );
  if (mismatched) {
    for (let i = 0; i < limit && i < 400; i += 1) {
      for (const head of heads) {
        if (steps[i][head] !== reference[i][head]) {
          console.log(`  step ${i} ${head}: got ${steps[i][head]} want ${reference[i][head]}`);
        }
      }
    }
  }
}

void collect;
