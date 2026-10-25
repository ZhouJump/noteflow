/**
 * 把本地的大体积资产准备到 public/，避免在仓库里重复存放。
 *
 *   node scripts/prepare-assets.mjs
 *
 * 准备内容：
 *   public/models/{segnet,encoder,decoder}.onnx.part-*  <- reference/homr 或构建时下载，10 MB 分片
 *   public/models/{segnet,encoder,decoder}.onnx.json    <- 分片清单
 *   public/samples                                      <- reference/samples/input（复制）
 *   public/ort/ort.wasm.js                              <- node_modules/onnxruntime-web/dist（API）
 *   public/ort/ort-wasm-simd-threaded.js                <- node_modules/onnxruntime-web/dist（胶水代码）
 *   public/ort/ort-wasm-simd-threaded.wasm.*            <- 由 wasm 切成的 10 MB 分片
 *   public/ort/ort-wasm-simd-threaded.wasm.json         <- 分片清单
 *   public/verovio/verovio-module.js                    <- node_modules/verovio/dist（复制）
 *   public/verovio/verovio.js                           <- node_modules/verovio/dist（复制）
 *
 * 模块脚本一律落成 `.js`：EdgeOne 这类静态托管没给 `.mjs` 配 MIME，会以
 * application/octet-stream 返回，浏览器按模块脚本加载时直接拒绝。
 *
 * reference/homr、reference/samples 不入库（见 .gitignore）。构建环境里没有
 * reference/homr 时，三个 ONNX 模型从 homr 的 GitHub Release 下载，解压后缓存在
 * .cache/noteflow-models/；下载地址可用 HOMR_MODEL_BASE 覆盖（镜像或代理）。
 *
 * 所有资产都按 ≤10 MB 落盘：模型与 wasm 切成分片，前端按清单拼回；Verovio 和示例图
 * 直接复制而不是符号链接——部署只会带走 .output/.edgeone，链接指向的仓库外路径不会跟着走。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { unzipSync } from 'fflate'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pub = path.join(root, 'public')
const homr = path.join(root, 'reference/homr/homr')
const ort = path.join(root, 'node_modules/onnxruntime-web/dist')
const verovio = path.join(root, 'node_modules/verovio/dist')
const modelCache = path.join(root, '.cache/noteflow-models')
/** 单个分片的上限，与 `scripts/check-bundle-size.mjs` 保持一致。 */
const CHUNK = 10_000_000
/** fp32 模型：与 reference/homr 在 CPU 上用的是同一组权重。 */
const MODEL_BASE = (
  process.env.HOMR_MODEL_BASE
  ?? 'https://github.com/liebharc/homr/releases/download/onnx_checkpoints/'
).replace(/\/?$/, '/')

const models = [
  ['segmentation/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx', 'segnet.onnx'],
  [
    'transformer/encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx',
    'encoder.onnx'
  ],
  [
    'transformer/decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx',
    'decoder.onnx'
  ]
]

/** 小文件复制：文件按字节数、目录按相对路径逐个比较，内容没变就不重写。 */
const copies = [
  [path.join(root, 'reference/samples/input'), 'samples'],
  [path.join(verovio, 'verovio-module.mjs'), 'verovio/verovio-module.js'],
  [path.join(verovio, 'verovio.mjs'), 'verovio/verovio.js']
]

const listFiles = directory => fs
  .readdirSync(directory, { recursive: true })
  .filter(relative => fs.statSync(path.join(directory, relative)).isFile())

function sameDirectory(source, target) {
  const sourceFiles = listFiles(source)
  const targetFiles = listFiles(target)
  if (sourceFiles.length !== targetFiles.length) return false
  return sourceFiles.every(relative => fs.statSync(path.join(source, relative)).size
    === fs.statSync(path.join(target, relative)).size)
}

function copyAsset(source, rel) {
  const target = path.join(pub, rel)
  const stat = fs.statSync(source)
  // 旧版本留下的是符号链接：即使大小一致也要换成真实文件。
  if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
    const targetStat = fs.statSync(target)
    const same = stat.isDirectory()
      ? targetStat.isDirectory() && sameDirectory(source, target)
      : targetStat.isFile() && targetStat.size === stat.size
    if (same) {
      console.log(`${rel} (kept)`)
      return
    }
  }
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true })
  console.log(`${rel} -> ${path.relative(root, source)}`)
}

/** 找到模型源文件；本地没有就从 Release 下载并解压到缓存目录。 */
async function ensureModel(relative) {
  const local = path.join(homr, relative)
  if (fs.existsSync(local)) return local
  const name = path.basename(relative)
  const cached = path.join(modelCache, name)
  if (fs.existsSync(cached)) return cached

  fs.mkdirSync(modelCache, { recursive: true })
  const url = `${MODEL_BASE}${path.basename(name, '.onnx')}.zip`
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`download: ${url}`)
      // 构建机上卡住的连接不能无限等：单次下载超过 20 分钟就换下一次。
      const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
      const entry = Object.keys(files).find(key => key.endsWith('.onnx'))
      if (entry === undefined) throw new Error('压缩包里没有 .onnx 文件')
      fs.writeFileSync(cached, files[entry])
      console.log(`downloaded: ${name}（${files[entry].length} 字节）`)
      return cached
    } catch (error) {
      lastError = error
      console.log(`  第 ${attempt} 次失败：${error.message}`)
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 3000))
    }
  }
  throw new Error(`无法获取模型 ${name}（${lastError?.message}），可用 HOMR_MODEL_BASE 指定镜像`)
}

function modelsKept(target, sources) {
  try {
    for (const [, name, size] of sources) {
      const manifest = JSON.parse(fs.readFileSync(path.join(target, `${name}.json`), 'utf8'))
      if (manifest.size !== size || manifest.parts.length !== Math.ceil(size / CHUNK)) return false
      for (const [index, part] of manifest.parts.entries()) {
        const expected = Math.min(CHUNK, size - index * CHUNK)
        if (fs.statSync(path.join(target, part)).size !== expected) return false
      }
    }
    // 旧版本留下的整文件链接不再需要。
    return !fs.readdirSync(target).some(entry => entry.endsWith('.onnx'))
  } catch {
    return false
  }
}

/**
 * 模型有 47–57 MB，直接复制会让产物里出现超过 10 MB 的文件。
 * 这里切成固定大小的分片并生成清单，`app/workers/pipeline.worker.ts`
 * 在创建 session 前按清单取回并拼起来。
 */
async function prepareModels() {
  const target = path.join(pub, 'models')
  const sources = []
  for (const [relative, name] of models) {
    const source = await ensureModel(relative)
    sources.push([source, name, fs.statSync(source).size])
  }

  // 重复运行时保持现有分片，避免打断正在加载模型的 Worker。
  if (modelsKept(target, sources)) {
    const count = sources.reduce((total, [, , size]) => total + Math.ceil(size / CHUNK), 0)
    console.log(`models (kept, ${count} 片)`)
    return
  }

  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const [source, name, size] of sources) {
    const bytes = fs.readFileSync(source)
    const parts = []
    for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK, index += 1) {
      const part = `${name}.part-${index}`
      fs.writeFileSync(path.join(target, part), bytes.subarray(offset, offset + CHUNK))
      parts.push(part)
    }
    const manifest = { size, chunkSize: CHUNK, parts }
    fs.writeFileSync(path.join(target, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`${name} -> ${parts.length} 片（${size} 字节）`)
  }
}

/**
 * ORT 的 wasm 有 14 MB，直接复制会让产物里出现超过 10 MB 的文件。
 * 这里只复制 JS 胶水代码，把 wasm 切成固定大小的分片，并生成 manifest；
 * `app/lib/homr/ortRuntime.ts` 在首次识别时按清单取回全部分片再拼起来。
 */
function prepareOrt() {
  const wasm = path.join(ort, 'ort-wasm-simd-threaded.wasm')
  const glue = path.join(ort, 'ort-wasm-simd-threaded.mjs')
  const api = path.join(ort, 'ort.wasm.mjs')
  const target = path.join(pub, 'ort')
  const manifestPath = path.join(target, 'ort-wasm-simd-threaded.wasm.json')
  const apiTarget = path.join(target, 'ort.wasm.js')
  const glueTarget = path.join(target, 'ort-wasm-simd-threaded.js')
  // 重复运行时保持现有分片，避免打断正在加载这些文件的 Worker。
  try {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const same = existing.size === fs.statSync(wasm).size
      && existing.parts.every(part => fs.existsSync(path.join(target, part)))
      && fs.statSync(apiTarget).size === fs.statSync(api).size
      && fs.statSync(glueTarget).size === fs.statSync(glue).size
    if (same) {
      console.log(`ort (kept, ${existing.parts.length} 片)`)
      return
    }
  } catch {
    // 首次生成或清单损坏，走重建
  }
  fs.rmSync(target, { recursive: true, force: true })
  if (!fs.existsSync(wasm) || !fs.existsSync(glue) || !fs.existsSync(api)) {
    console.log(`missing: ${path.relative(root, wasm)} / ${path.relative(root, glue)} / ${path.relative(root, api)}`)
    return
  }
  fs.mkdirSync(target, { recursive: true })
  fs.copyFileSync(api, apiTarget)
  fs.copyFileSync(glue, glueTarget)
  const bytes = fs.readFileSync(wasm)
  const parts = []
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK, index += 1) {
    const name = `ort-wasm-simd-threaded.wasm.part-${index}`
    fs.writeFileSync(path.join(target, name), bytes.subarray(offset, offset + CHUNK))
    parts.push(name)
  }
  const manifest = { size: bytes.length, chunkSize: CHUNK, parts }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`ort -> ${parts.length} 片（${bytes.length} 字节）`)
}

fs.mkdirSync(pub, { recursive: true })
const missing = []
for (const [source, rel] of copies) {
  if (!fs.existsSync(source)) {
    console.log(`missing: ${path.relative(root, source)}`)
    missing.push(rel)
    continue
  }
  copyAsset(source, rel)
}
if (missing.length > 0) {
  console.log(`警告：${missing.length} 个资产缺失（${missing.join('、')}），构建产物里不会包含它们`)
}

// 旧版本按 .mjs 落盘，部署到 EdgeOne 后模块脚本会被 MIME 检查拒绝；清掉残留。
for (const legacy of ['verovio/verovio-module.mjs', 'verovio/verovio.mjs']) {
  fs.rmSync(path.join(pub, legacy), { force: true })
}

await prepareModels()
prepareOrt()
