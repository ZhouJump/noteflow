/**
 * 把本地的大体积资产链接进 public/，避免在仓库里重复存放。
 *
 *   node scripts/prepare-assets.mjs
 *
 * 链接内容：
 *   public/models/{segnet,encoder,decoder}.onnx  <- reference/homr/homr/**
 *   public/samples                               <- reference/samples/input
 *   public/ort                                   <- node_modules/onnxruntime-web/dist
 *   public/verovio/verovio-module.mjs            <- node_modules/verovio/dist（排版引擎，wasm 内嵌）
 *   public/verovio/verovio.mjs                   <- node_modules/verovio/dist（Toolkit 包装）
 *
 * reference/homr、reference/samples 不入库（见 .gitignore），新环境需要先准备这些文件。
 * Verovio 只取两个运行时需要的文件：7 MB 的模块由浏览器按需加载，不经过打包器。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pub = path.join(root, 'public')
const homr = path.join(root, 'reference/homr/homr')
const ort = path.join(root, 'node_modules/onnxruntime-web/dist')
const verovio = path.join(root, 'node_modules/verovio/dist')

const links = [
  [path.join(homr, 'segmentation/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx'), 'models/segnet.onnx'],
  [
    path.join(homr, 'transformer/encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx'),
    'models/encoder.onnx'
  ],
  [
    path.join(homr, 'transformer/decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx'),
    'models/decoder.onnx'
  ],
  [path.join(root, 'reference/samples/input'), 'samples'],
  [ort, 'ort'],
  [path.join(verovio, 'verovio-module.mjs'), 'verovio/verovio-module.mjs'],
  [path.join(verovio, 'verovio.mjs'), 'verovio/verovio.mjs']
]

fs.mkdirSync(pub, { recursive: true })
for (const [source, rel] of links) {
  if (!fs.existsSync(source)) {
    console.log(`missing: ${path.relative(root, source)}`)
    continue
  }
  const target = path.join(pub, rel)
  const directory = fs.statSync(source).isDirectory()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.rmSync(target, { force: true, recursive: true })
  try {
    fs.symlinkSync(path.relative(path.dirname(target), source), target, directory ? 'dir' : 'file')
  } catch {
    if (directory) fs.cpSync(source, target, { recursive: true })
    else fs.copyFileSync(source, target)
  }
  console.log(`${rel} -> ${path.relative(root, source)}`)
}
