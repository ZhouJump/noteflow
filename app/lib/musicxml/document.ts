/**
 * MusicXML 读取：安全解析、元数据、以及 UI 需要的逐个音符模型。
 *
 * 只做解析，不改写文档；渲染副本见 `display.ts`。解析结果里的音符序号就是
 * `<note>` 元素在文档中的顺序，和 HOMR 侧车的 `noteSymbols`、点选音符的编号一一对应。
 *
 * 安全：不使用任何外部实体，也不加载外部资源。带 `<!ENTITY>` 的文档直接拒绝，
 * `<!DOCTYPE>` 在交给 DOMParser 之前剥掉。
 */

export interface MusicXmlPitch {
  step: string
  alter: number
  octave: number
}

export interface MusicXmlNote {
  /** `<note>` 在文档中的顺序（跨 part 连续编号）。 */
  index: number
  id: string | null
  partId: string
  measureNumber: string
  /** 该 part 内的第几个小节，从 1 开始。 */
  measureIndex: number
  voice: string
  staff: number
  isRest: boolean
  isChord: boolean
  isGrace: boolean
  pitch: MusicXmlPitch | null
  /** 以 divisions 计的时值。 */
  duration: number
  type: string | null
  dots: number
  accidental: string | null
  tieStart: boolean
  tieStop: boolean
  /** 从头开始的四分音符位置。 */
  onset: number
  /** 相对本小节开头的四分音符位置。 */
  offsetInMeasure: number
}

export interface MusicXmlPart {
  id: string
  name: string
  measureCount: number
}

export interface ParsedMusicXml {
  title: string
  composer: string
  software: string | null
  parts: MusicXmlPart[]
  notes: MusicXmlNote[]
  measureCount: number
  keyFifths: number | null
  timeSignature: { beats: number, beatType: number } | null
}

export class MusicXmlError extends Error {}

const NOTE_TYPES = ['breve', 'whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th', '128th']

/** `type` 对应的四分音符时值；未知类型返回 null。 */
export function quartersForType(type: string): number | null {
  if (!NOTE_TYPES.includes(type)) return null
  return 4 / 2 ** NOTE_TYPES.indexOf(type)
}

/** 去掉 DOCTYPE 与 BOM；带内部实体声明的一律视为不安全。 */
export function sanitiseMusicXml(source: string): string {
  const text = source.replace(/^\uFEFF/, '')
  if (/<!ENTITY/i.test(text)) {
    throw new MusicXmlError('这个文件里有无法安全读取的内容，暂时不能导入')
  }
  return text.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?[^>]*>/i, '')
}

/** 解析成 DOM；根元素不是 `score-partwise` 时给出明确原因。 */
export function parseMusicXml(source: string): Document {
  const text = sanitiseMusicXml(source)
  if (text.trim() === '') throw new MusicXmlError('文件是空的，可能没有下载完整')
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.querySelector('parsererror') !== null) {
    throw new MusicXmlError('文件内容不完整或已损坏，读不出来')
  }
  const root = document.documentElement
  if (root === null) throw new MusicXmlError('文件里没有找到乐谱内容')
  if (root.nodeName === 'score-timewise') {
    throw new MusicXmlError('暂不支持这种排列方式的乐谱，请在导出时选择按小节排列')
  }
  if (root.nodeName !== 'score-partwise') {
    throw new MusicXmlError('这不是一份可用的乐谱文件')
  }
  return document
}

function directChild(parent: Element, name: string): Element | null {
  for (const child of parent.children) {
    if (child.nodeName === name) return child
  }
  return null
}

function childText(parent: Element | null, name: string): string | null {
  if (parent === null) return null
  const child = directChild(parent, name)
  return child?.textContent?.trim() ?? null
}

function parsePitch(note: Element): MusicXmlPitch | null {
  const pitch = directChild(note, 'pitch')
  if (pitch === null) return null
  const step = childText(pitch, 'step')
  const octave = childText(pitch, 'octave')
  if (step === null || octave === null) return null
  return {
    step: step.toUpperCase(),
    alter: Number(childText(pitch, 'alter') ?? '0') || 0,
    octave: Number(octave)
  }
}

function partNames(document: Document): Map<string, string> {
  const names = new Map<string, string>()
  for (const scorePart of document.getElementsByTagName('score-part')) {
    const id = scorePart.getAttribute('id')
    if (id === null) continue
    names.set(id, childText(scorePart, 'part-name') ?? '')
  }
  return names
}

/** 读完整份文档。`index` 按文档顺序分配，和 `querySelectorAll('note')` 一致。 */
export function readMusicXml(document: Document): ParsedMusicXml {
  const root = document.documentElement
  const names = partNames(document)
  const notes: MusicXmlNote[] = []
  const parts: MusicXmlPart[] = []
  let keyFifths: number | null = null
  let timeSignature: { beats: number, beatType: number } | null = null

  for (const part of document.getElementsByTagName('part')) {
    const partId = part.getAttribute('id') ?? ''
    const measures = [...part.children].filter(child => child.nodeName === 'measure')
    parts.push({ id: partId, name: names.get(partId) ?? partId, measureCount: measures.length })

    let divisions = 1
    // 以 divisions 为单位：backup / forward 会来回移动，和弦音不推进时钟。
    let clock = 0
    let lastNoteStart = 0

    measures.forEach((measure, measurePosition) => {
      const measureNumber = measure.getAttribute('number') ?? String(measurePosition + 1)
      const measureStart = clock
      for (const child of measure.children) {
        if (child.nodeName === 'attributes') {
          const division = childText(child, 'divisions')
          if (division !== null && Number(division) > 0) divisions = Number(division)
          if (keyFifths === null) {
            const fifths = childText(directChild(child, 'key'), 'fifths')
            if (fifths !== null) keyFifths = Number(fifths)
          }
          if (timeSignature === null) {
            const time = directChild(child, 'time')
            const beats = childText(time, 'beats')
            const beatType = childText(time, 'beat-type')
            if (beats !== null && beatType !== null) {
              timeSignature = { beats: Number(beats), beatType: Number(beatType) }
            }
          }
          continue
        }
        if (child.nodeName === 'backup' || child.nodeName === 'forward') {
          const value = Number(childText(child, 'duration') ?? '0') || 0
          clock += child.nodeName === 'backup' ? -value : value
          continue
        }
        if (child.nodeName !== 'note') continue

        const duration = Number(childText(child, 'duration') ?? '0') || 0
        const isChord = directChild(child, 'chord') !== null
        const isGrace = directChild(child, 'grace') !== null
        const start = isChord ? lastNoteStart : clock
        if (!isChord) {
          lastNoteStart = start
          if (!isGrace) clock += duration
        }
        const dots = [...child.children].filter(element => element.nodeName === 'dot').length
        notes.push({
          index: notes.length,
          id: child.getAttribute('id'),
          partId,
          measureNumber,
          measureIndex: measurePosition + 1,
          voice: childText(child, 'voice') ?? '',
          staff: Number(childText(child, 'staff') ?? '1') || 1,
          isRest: directChild(child, 'rest') !== null,
          isChord,
          isGrace,
          pitch: parsePitch(child),
          duration,
          type: childText(child, 'type'),
          dots,
          accidental: childText(child, 'accidental'),
          tieStart: [...child.getElementsByTagName('tie')].some(
            tie => tie.getAttribute('type') === 'start'
          ),
          tieStop: [...child.getElementsByTagName('tie')].some(
            tie => tie.getAttribute('type') === 'stop'
          ),
          onset: start / divisions,
          offsetInMeasure: (start - measureStart) / divisions
        })
      }
    })
  }

  const workTitle = childText(directChild(root, 'work'), 'work-title')
  const composer = [...document.getElementsByTagName('creator')]
    .find(creator => creator.getAttribute('type') === 'composer')
    ?.textContent?.trim()
  const measureCount = parts.reduce((total, part) => Math.max(total, part.measureCount), 0)

  return {
    title: workTitle ?? childText(root, 'movement-title') ?? '',
    composer: composer ?? '',
    software: [...document.getElementsByTagName('software')][0]?.textContent?.trim() ?? null,
    parts,
    notes,
    measureCount,
    keyFifths,
    timeSignature
  }
}

export function readMusicXmlSource(source: string): ParsedMusicXml {
  return readMusicXml(parseMusicXml(source))
}

/** 音名：`C#4`、`Eb3`。 */
export function formatPitch(pitch: MusicXmlPitch | null): string {
  if (pitch === null) return '休止'
  const accidental = pitch.alter === 0 ? '' : pitch.alter > 0 ? '#'.repeat(pitch.alter) : 'b'.repeat(-pitch.alter)
  return `${pitch.step}${accidental}${pitch.octave}`
}

export const PITCH_STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const
export const DURATION_TYPES = NOTE_TYPES
