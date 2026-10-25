/**
 * Link the ONNX models and the Python reference tensors into web/public so the
 * dev server can serve them without copying hundreds of megabytes.
 *
 *   node scripts/prepare-assets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const repo = path.resolve(web, '..');
const pub = path.join(web, 'public');
const transformer = path.join(repo, 'homr/homr/transformer');
const suffix = 'pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx';

const links = [
  [
    path.join(repo, 'homr/homr/segmentation/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx'),
    'models/segnet.onnx',
  ],
  [path.join(transformer, `encoder_${suffix}`), 'models/encoder.onnx'],
  [path.join(transformer, `decoder_${suffix}`), 'models/decoder.onnx'],
  [path.join(repo, 'artifacts/browser-reference/永远同在1'), 'reference/current'],
  [path.join(repo, 'samples/input'), 'samples'],
];

fs.mkdirSync(pub, { recursive: true });
for (const [source, rel] of links) {
  if (!fs.existsSync(source)) {
    console.log(`missing: ${path.relative(repo, source)}`);
    continue;
  }
  const target = path.join(pub, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true, recursive: true });
  try {
    fs.symlinkSync(path.relative(path.dirname(target), source), target, 'dir');
  } catch {
    fs.cpSync(source, target, { recursive: true });
  }
  console.log(`${rel} -> ${path.relative(repo, source)}`);
}
