/**
 * 检查构建产物里没有超过 10 MB 的文件。
 *
 *   node scripts/check-bundle-size.mjs
 *
 * `.output` 里的符号链接（模型、Verovio 等本地大文件）不算产物内容，跳过；
 * 实际落盘的文件按字节比较，超过上限时列出并返回非零退出码。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 10_000_000
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.output')
const links = []

function walk(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(path.relative(root, full))
      continue
    }
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push({ path: full, size: fs.statSync(full).size })
  }
  return files
}

if (!fs.existsSync(output)) {
  console.error('缺少 .output，先运行 pnpm build')
  process.exit(1)
}

const files = walk(output).sort((left, right) => right.size - left.size)
const oversized = files.filter(file => file.size > LIMIT)
for (const file of files.slice(0, 5)) {
  console.log(`${String(file.size).padStart(10)}  ${path.relative(root, file.path)}`)
}

if (oversized.length > 0) {
  console.error(`有 ${oversized.length} 个文件超过 ${LIMIT} 字节：`)
  for (const file of oversized) {
    console.error(`  ${file.size}  ${path.relative(root, file.path)}`)
  }
  process.exit(1)
}

console.log(`ok  ${files.length} 个文件，最大 ${files[0]?.size ?? 0} 字节（上限 ${LIMIT}）`)
if (links.length > 0) {
  console.log(`跳过 ${links.length} 个符号链接（部署时需单独提供）：`)
  for (const link of links.slice(0, 5)) console.log(`  ${link}`)
}
