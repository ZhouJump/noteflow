/**
 * M3 de-risk: can onnxruntime-web's WASM backend load the three HOMR models?
 *
 * The decoder is the one that matters: it is int8 dynamic-quantized and uses two
 * `com.microsoft` operators (MultiHeadAttention, SkipLayerNormalization), so a
 * successful session here is the precondition for the whole browser port.
 *
 *   node scripts/smoke-ort.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as ort from 'onnxruntime-web';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const homr = path.join(repo, 'homr/homr');

const MODELS = {
  segnet: path.join(homr, 'segmentation/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx'),
  encoder: path.join(
    homr,
    'transformer/encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx',
  ),
  decoder: path.join(
    homr,
    'transformer/decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx',
  ),
};

ort.env.logLevel = 'error';
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 1);
ort.env.wasm.simd = true;

const fmt = (ms) => `${ms.toFixed(0)} ms`;

async function open(name, file) {
  const started = performance.now();
  try {
    const session = await ort.InferenceSession.create(file, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    const ms = performance.now() - started;
    const io = {
      inputs: session.inputNames.length,
      outputs: session.outputNames.length,
    };
    console.log(`  OK  ${name.padEnd(7)} ${fmt(ms).padStart(8)}  ${io.inputs} in / ${io.outputs} out`);
    return session;
  } catch (error) {
    console.log(`  FAIL ${name.padEnd(7)} ${error.message.split('\n')[0]}`);
    return null;
  }
}

async function timeIt(label, fn) {
  const t0 = performance.now();
  const out = await fn();
  console.log(`  run  ${label.padEnd(18)} ${fmt(performance.now() - t0).padStart(8)}`);
  return out;
}

const pick = (result, name) => (result instanceof Map ? result.get(name) : result[name]);

console.log(
  `onnxruntime-web ${ort.env.versions?.web ?? ort.version ?? '?'} / wasm threads=${ort.env.wasm.numThreads}`,
);

const sessions = {};
for (const [name, file] of Object.entries(MODELS)) {
  sessions[name] = await open(name, file);
}

if (sessions.segnet) {
  const input = new ort.Tensor('float32', new Float32Array(3 * 320 * 320).fill(128), [1, 3, 320, 320]);
  await timeIt('segnet warmup', () => sessions.segnet.run({ input }));
  const out = await timeIt('segnet 320x320', () => sessions.segnet.run({ input }));
  const tensor = pick(out, 'output');
  console.log(`       output ${tensor.dims.join('x')} ${tensor.type}`);

  // 54 tiles is one page; batch them the way inference_segnet.py does.
  const batch = new Float32Array(8 * 3 * 320 * 320).fill(128);
  const batchInput = new ort.Tensor('float32', batch, [8, 3, 320, 320]);
  await timeIt('segnet batch 8', () => sessions.segnet.run({ input: batchInput }));
}

if (sessions.encoder) {
  const input = new ort.Tensor('float32', new Float32Array(256 * 1280), [1, 1, 256, 1280]);
  const out = await timeIt('encoder 256x1280', () => sessions.encoder.run({ input }));
  console.log(`       output ${pick(out, 'output').dims.join('x')}`);
}

if (sessions.decoder) {
  // Step 0 takes the full encoder context (1280 positions); later steps take a
  // single position (see homr/transformer/decoder_inference.py:71-85).
  const context = new ort.Tensor('float32', new Float32Array(1280 * 512), [1, 1280, 512]);
  const feeds = {
    rhythms: new ort.Tensor('int64', BigInt64Array.from([1n]), [1, 1]),
    pitchs: new ort.Tensor('int64', BigInt64Array.from([0n]), [1, 1]),
    lifts: new ort.Tensor('int64', BigInt64Array.from([0n]), [1, 1]),
    articulations: new ort.Tensor('int64', BigInt64Array.from([0n]), [1, 1]),
    slurs: new ort.Tensor('int64', BigInt64Array.from([0n]), [1, 1]),
    context,
    cache_len: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
  };
  const emptyCache = new Float32Array(0);
  for (let i = 0; i < 32; i += 1) {
    feeds[`cache_in${i}`] = new ort.Tensor('float32', emptyCache, [1, 8, 0, 64]);
  }

  try {
    const step0 = await timeIt('decoder step 0', () => sessions.decoder.run(feeds));
    const rhythm = pick(step0, 'out_rhythms');
    const attention = pick(step0, 'attention');
    console.log(`       out_rhythms ${rhythm.dims.join('x')} argmax=${argmax(rhythm.data)}`);
    console.log(`       attention ${attention.dims.join('x')} = ${Array.from(attention.data)}`);
    console.log(`       cache_out0 ${pick(step0, 'cache_out0').dims.join('x')}`);

    const next = {
      rhythms: new ort.Tensor('int64', BigInt64Array.from([BigInt(argmax(rhythm.data))]), [1, 1]),
      pitchs: new ort.Tensor('int64', BigInt64Array.from([BigInt(argmax(pick(step0, 'out_pitchs').data))]), [1, 1]),
      lifts: new ort.Tensor('int64', BigInt64Array.from([BigInt(argmax(pick(step0, 'out_lifts').data))]), [1, 1]),
      articulations: new ort.Tensor('int64', BigInt64Array.from([BigInt(argmax(pick(step0, 'out_articulations').data))]), [1, 1]),
      slurs: new ort.Tensor('int64', BigInt64Array.from([BigInt(argmax(pick(step0, 'out_slurs').data))]), [1, 1]),
      context: new ort.Tensor('float32', new Float32Array(512), [1, 1, 512]),
      cache_len: new ort.Tensor('int64', BigInt64Array.from([1n]), [1]),
    };
    for (let i = 0; i < 32; i += 1) next[`cache_in${i}`] = pick(step0, `cache_out${i}`);
    const step1 = await timeIt('decoder step 1', () => sessions.decoder.run(next));
    console.log(`       step1 rhythm argmax=${argmax(pick(step1, 'out_rhythms').data)}`);
  } catch (error) {
    console.log(`  FAIL decoder ${error.message.split('\n')[0]}`);
  }
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
  return best;
}
