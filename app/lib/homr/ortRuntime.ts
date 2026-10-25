/**
 * ONNX Runtime 的浏览器运行时。
 *
 * ORT 的 wasm 有 14 MB，直接复制或打包都会让产物里出现超过 10 MB 的文件。
 * `scripts/prepare-assets.mjs` 把它切成多个分片并生成 manifest；这里在首次识别时
 * 取回全部分片、拼成一个 Blob 再交给 ORT。JS 胶水代码也从 `public/ort/` 按需
 * 动态加载，因此 Worker 的打包产物里不再包含 ORT 或它的 wasm。
 *
 * 只在浏览器里运行：`fetch`、`Blob`、`URL.createObjectURL` 都在调用时才使用，
 * 因此 Node 脚本可以安全地导入同一条链路上的纯计算模块。
 */

export type OrtModule = typeof import('onnxruntime-web/wasm')

const ORT_API = '/ort/ort.wasm.mjs'
const ORT_GLUE = '/ort/ort-wasm-simd-threaded.mjs'
const ORT_MANIFEST = '/ort/ort-wasm-simd-threaded.wasm.json'

interface WasmManifest {
  size: number
  chunkSize: number
  parts: string[]
}

let wasmUrl: Promise<string> | null = null
let runtime: Promise<OrtModule> | null = null
let loaded: OrtModule | null = null

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.arrayBuffer()
}

/** 下载所有 wasm 分片并拼成一个 Blob URL；只执行一次。 */
function wasmUrlOnce(): Promise<string> {
  wasmUrl ??= (async () => {
    const response = await fetch(ORT_MANIFEST)
    if (!response.ok) throw new Error(`${ORT_MANIFEST}: HTTP ${response.status}`)
    const manifest = await response.json() as WasmManifest
    const parts = await Promise.all(manifest.parts.map(part => fetchBytes(`/ort/${part}`)))
    const size = parts.reduce((total, part) => total + part.byteLength, 0)
    if (size !== manifest.size) {
      throw new Error(`wasm 分片不完整：${size} / ${manifest.size} 字节`)
    }
    return URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }))
  })()
  return wasmUrl
}

/** 加载 ORT 模块并配置分片 wasm 路径。同一个 Worker 里只执行一次。 */
export function loadOrt(): Promise<OrtModule> {
  runtime ??= (async () => {
    const [module, url] = await Promise.all([
      import(/* @vite-ignore */ ORT_API) as Promise<OrtModule>,
      wasmUrlOnce()
    ])
    module.env.logLevel = 'error'
    module.env.wasm.simd = true
    module.env.wasm.numThreads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1))
    module.env.wasm.wasmPaths = { wasm: url, mjs: ORT_GLUE }
    loaded = module
    return module
  })()
  return runtime
}

/** 已经由 `loadOrt()` 加载的模块；初始化完成前调用会抛错。 */
export function currentOrt(): OrtModule {
  if (loaded === null) throw new Error('ONNX Runtime 尚未初始化')
  return loaded
}
