/**
 * 渲染副本：给每个 `<note>` 补一个 `nf-<序号>` id，点击 SVG 音符时用它定位。
 *
 * 只改内存里的副本。原始识别结果、导出的 MusicXML 都保持 Worker 写出的字节，
 * 与参考实现逐字节一致。
 */

import { parseMusicXml } from './document'

/** 渲染副本里的音符 id 前缀；导出时不带。 */
export const NOTE_ID_PREFIX = 'nf-'

function serialise(document: Document): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(document)}`
}

/** 按文档顺序给每个音符加 id；序号与侧车 `noteSymbols`、Inspector 的编号一致。 */
export function buildDisplayXml(source: string): string {
  const document = parseMusicXml(source)
  let index = 0
  for (const part of document.getElementsByTagName('part')) {
    for (const measure of part.children) {
      if (measure.nodeName !== 'measure') continue
      for (const child of measure.children) {
        if (child.nodeName !== 'note') continue
        child.setAttribute('id', `${NOTE_ID_PREFIX}${index}`)
        index += 1
      }
    }
  }
  return serialise(document)
}
