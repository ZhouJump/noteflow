/**
 * 生成自带曲集：公有领域 MusicXML + 首页预览。
 *
 *   node scripts/build-preset.mjs                  # 钢琴、小提琴各四首，全部重新生成
 *   node scripts/build-preset.mjs --family violin  # 只生成小提琴曲集
 *   node scripts/build-preset.mjs --family piano --only 卡农
 *
 * 曲目来源：钢琴取 musetrainer/library，小提琴取 salu133445/bach-violin-dataset
 * 的参考乐谱（BWV 1001–1006，公有领域），都是 `scores/*.mxl`。脚本把压缩包解成
 * 纯 MusicXML、压掉标签之间的空白，再用 `node_modules` 里的 Verovio 渲染第一页
 * 作为谱架缩略图。缩略图存 SVG：字形路径自带，放大到高分屏也不糊，比截图小得多。
 *
 * 下载缓存在 `.cache/preset-src`；本机有
 * `reference/samples/bach-violin-dataset-v1.0` 时小提琴直接读本地，不再重复下载。
 * 应用首次打开谱架时由 `app/lib/presets/library.ts` 读 manifest 写回本机库。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

/**
 * 每个曲集一份配置。`prefix` 同时是曲目 id 前缀与文件名前缀；`local` 是本机已有
 * 的数据目录，留空表示只能联网下载。
 */
const FAMILIES = {
  piano: {
    out: 'public/presets/piano',
    collection: { id: 'preset-piano-classics', title: '钢琴经典曲集' },
    cover: 'cover.webp',
    prefix: 'preset-piano-',
    remote: 'https://raw.githubusercontent.com/musetrainer/library/master/scores/',
    local: '',
    entries: [
      {
        source: 'Bach_Minuet_in_G_Major_BWV_Anh._114.mxl',
        title: 'G 大调小步舞曲',
        composer: '佩措尔德',
        note: 'BWV Anh. 114'
      },
      { source: 'Fur_Elise.mxl', title: '致爱丽丝', composer: '贝多芬', note: 'WoO 59' },
      {
        source: 'Chopin_-_Nocturne_Op_9_No_2_E_Flat_Major.mxl',
        title: '夜曲 Op.9 No.2',
        composer: '肖邦',
        note: '降 E 大调'
      },
      { source: 'Canon_in_D.mxl', title: '卡农', composer: '帕赫贝尔', note: 'D 大调' }
    ]
  },
  violin: {
    out: 'public/presets/violin',
    collection: { id: 'preset-violin-solo', title: '小提琴经典曲集' },
    cover: 'cover.webp',
    prefix: 'preset-violin-',
    remote: 'https://raw.githubusercontent.com/salu133445/bach-violin-dataset/main/bach-violin/scores/',
    local: 'reference/samples/bach-violin-dataset-v1.0/scores',
    entries: [
      { source: 'bwv1001/bwv1001_mov1.mxl', title: 'G 小调柔板', composer: '巴赫', note: 'BWV 1001' },
      { source: 'bwv1002/bwv1002_mov5.mxl', title: 'B 小调萨拉班德', composer: '巴赫', note: 'BWV 1002' },
      { source: 'bwv1004/bwv1004_mov5.mxl', title: 'D 小调恰空', composer: '巴赫', note: 'BWV 1004' },
      { source: 'bwv1006/bwv1006_mov1.mxl', title: 'E 大调前奏曲', composer: '巴赫', note: 'BWV 1006' }
    ]
  }
}

const CACHE_ROOT = path.join(root, '.cache/preset-src')

/** 预览与 `app/lib/verovio.ts` 的排版参数一致，谱架上看到的就是曲谱页的第一眼。 */
const RENDER_OPTIONS = {
  scale: 45,
  pageWidth: 2100,
  pageMarginLeft: 40,
  pageMarginRight: 40,
  pageMarginTop: 40,
  pageMarginBottom: 40,
  breaks: 'auto',
  adjustPageHeight: true,
  svgViewBox: true,
  header: 'none',
  footer: 'none',
  justifyVertically: false
}

/* ---------- 下载与解包 ---------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 取一份 `.mxl`：缓存优先，其次是本机数据集，最后才联网。GitHub 偶尔会掐连接，
 * 下载失败重试几次再放弃。
 */
async function readSource(family, entry) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true })
  const target = path.join(CACHE_ROOT, entry.source.replace(/\//g, '_'))
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return fs.readFileSync(target)

  const local = family.local === '' ? '' : path.join(root, family.local, entry.source)
  if (local !== '' && fs.existsSync(local)) {
    fs.copyFileSync(local, target)
    return fs.readFileSync(target)
  }

  const url = family.remote + entry.source.split('/').map(encodeURIComponent).join('/')
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(target, buffer)
      return buffer
    } catch (error) {
      if (attempt === 4) throw new Error(`下载失败：${entry.source}（${error.message}）`, { cause: error })
      await sleep(1500 * attempt)
    }
  }
  throw new Error(`下载失败：${entry.source}`)
}

/**
 * 从 zip 里取出一个文件。只用中央目录 + `inflateRaw`，不引入解压依赖：
 * `.mxl` 只装一份 container 与一份乐谱，够用。
 */
function readZipEntry(buffer, wanted) {
  let end = -1
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('不是有效的 zip／mxl 文件')

  const count = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    if (name === wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const data = buffer.subarray(start, start + compressedSize)
      if (method === 0) return data.toString('utf8')
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8')
      throw new Error(`不支持的压缩方式 ${method}：${name}`)
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`zip 里没有 ${wanted}`)
}

/** `.mxl` 的主文档名写在 `META-INF/container.xml` 里。 */
function unzipMxl(buffer) {
  const container = readZipEntry(buffer, 'META-INF/container.xml')
  const fullPath = /full-path="([^"]+)"/.exec(container)?.[1]
  if (fullPath === undefined) throw new Error('container.xml 里没有指向乐谱')
  return readZipEntry(buffer, fullPath)
}

/* ---------- 清洗与统计 ---------- */

/**
 * 压掉标签之间的空白与 DOCTYPE。解析时会剥掉 DOCTYPE，这里先删掉省体积；
 * 带内部实体声明的文件按不可信处理，直接拒绝。
 */
function compact(xml) {
  if (/<!ENTITY/i.test(xml)) throw new Error('乐谱里有内部实体声明，拒绝打包')
  return xml
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?[^>]*>/i, '')
    .replace(/>\s+</g, '><')
    .trim()
}

function stats(xml) {
  const notes = (xml.match(/<note[\s>]/g) ?? []).length
  const measures = (xml.match(/<measure[\s>]/g) ?? []).length
  const staves = new Set([...xml.matchAll(/<staff>(\d+)<\/staff>/g)].map(match => Number(match[1])))
  const time = /<time[^>]*>\s*<beats>([^<]+)<\/beats>\s*<beat-type>([^<]+)<\/beat-type>/.exec(xml)
  if (!xml.startsWith('<?xml') && !xml.startsWith('<score-partwise')) {
    throw new Error('乐谱不是 score-partwise')
  }
  if (!/<score-partwise/.test(xml)) throw new Error('乐谱不是 score-partwise')
  return {
    notes,
    measures,
    staves: Math.max(1, ...staves),
    time: time === null ? null : { beats: Number(time[1]), beatType: Number(time[2]) }
  }
}

/* ---------- 预览 ---------- */

let toolkit = null

/** Verovio 的 wasm 模块加载一次就够，两个曲集共用同一个实例。 */
async function renderPreview(xml) {
  if (toolkit === null) {
    const { default: createModule } = await import('verovio/wasm')
    const { VerovioToolkit } = await import('verovio/esm')
    toolkit = new VerovioToolkit(await createModule())
    toolkit.setOptions(RENDER_OPTIONS)
  }
  if (toolkit.loadData(xml) === 0) {
    throw new Error(`Verovio 无法排版：${String(toolkit.getLog()).slice(0, 200)}`)
  }
  return {
    svg: toolkit.renderToSVG(1),
    pages: Math.max(1, toolkit.getPageCount())
  }
}

/* ---------- 主流程 ---------- */

async function buildFamily(family, only) {
  const outDir = path.resolve(root, family.out)
  const selected = family.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => only === '' || entry.title.includes(only))
  if (selected.length === 0) throw new Error(`${family.collection.title} 里没有匹配的曲目：${only}`)

  fs.mkdirSync(outDir, { recursive: true })
  // 只清掉脚本自己生成的文件；封面 cover.webp 是手绘素材，每次重新生成都不该动它。
  if (only === '') {
    const generated = new RegExp(`^${family.prefix}.*\\.(musicxml|svg)$`)
    for (const file of fs.readdirSync(outDir)) {
      if (file === 'manifest.json' || generated.test(file)) {
        fs.rmSync(path.join(outDir, file), { force: true })
      }
    }
  }

  const manifestPath = path.join(outDir, 'manifest.json')
  const previous = only !== '' && fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null

  const scores = []
  for (const { entry, index } of selected) {
    const id = `${family.prefix}${index + 1}`
    const musicXml = compact(unzipMxl(await readSource(family, entry)))
    const info = stats(musicXml)
    const preview = await renderPreview(musicXml)

    const file = `${id}.musicxml`
    const cover = `${id}.svg`
    fs.writeFileSync(path.join(outDir, file), musicXml)
    fs.writeFileSync(path.join(outDir, cover), preview.svg)

    scores.push({
      id,
      title: entry.title,
      composer: entry.composer,
      note: entry.note,
      file,
      preview: cover,
      notes: info.notes,
      measures: info.measures,
      staves: info.staves,
      pages: preview.pages,
      time: info.time,
      source: `${family.remote}${entry.source}`,
      license: 'Public Domain'
    })
    console.log(
      `${entry.title}（${entry.composer}）：${info.measures} 小节 · ${info.notes} 个音符 · `
      + `${preview.pages} 页排版 · ${(musicXml.length / 1024).toFixed(0)} KB`
    )
  }

  const manifest = {
    version: 2,
    collection: family.collection,
    cover: family.cover,
    scores: only === '' || previous === null
      ? scores
      : previous.scores.map(entry => scores.find(next => next.id === entry.id) ?? entry)
  }
  if (!fs.existsSync(path.join(outDir, manifest.cover))) {
    console.warn(`提示：缺少封面 ${manifest.cover}，谱集卡会退回默认叠纸封面`)
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const total = fs.readdirSync(outDir).reduce(
    (sum, file) => sum + fs.statSync(path.join(outDir, file)).size,
    0
  )
  console.log(
    `${family.collection.title}：manifest ${(fs.statSync(manifestPath).size / 1024).toFixed(1)} KB · `
    + `资产合计 ${(total / 1024 / 1024).toFixed(2)} MB → ${family.out}`
  )
}

const only = flag('--only', '')
const requested = flag('--family', '')
const names = requested === '' ? Object.keys(FAMILIES) : [requested]
if (only !== '' && names.length > 1) throw new Error('用 --only 时要用 --family 指定曲集')

for (const name of names) {
  const family = FAMILIES[name]
  if (family === undefined) throw new Error(`没有这个曲集：${name}（可选：${Object.keys(FAMILIES).join('、')}）`)
  await buildFamily(family, only)
}

console.log('\n自带曲集数据已生成。')
