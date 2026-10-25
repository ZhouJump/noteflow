/**
 * A minimal XML tree for the MusicXML writer.
 *
 * The Python writer builds `musicxml` elements, which reorder their children into the
 * order the MusicXML schema's `sequence` groups demand before serialising. The
 * recogniser adds children in whatever order the music is met, so the same reordering
 * is needed here: without it a note would read `type, duration, staff, voice` and a
 * schema-aware reader would reject it.
 *
 * `CHILD_ORDER` lists only the elements the writer creates; a sort is stable, so
 * children of an element that is not listed keep their insertion order (that is what
 * `measure`, whose content model is a repeating choice, needs).
 */

const CHILD_ORDER: Record<string, string[]> = {
  'score-partwise': [
    'work',
    'movement-number',
    'movement-title',
    'identification',
    'defaults',
    'credit',
    'part-list',
    'part'
  ],
  'work': ['work-number', 'work-title'],
  'identification': ['creator', 'rights', 'encoding', 'relation', 'miscellaneous'],
  'encoding': ['software', 'encoding-date', 'encoder', 'encoding-description', 'supports'],
  'defaults': [
    'scaling',
    'page-layout',
    'system-layout',
    'staff-layout',
    'appearance',
    'music-font',
    'word-font',
    'lyric-font',
    'lyric-language'
  ],
  'page-layout': ['page-height', 'page-width', 'page-margins'],
  'part-list': ['part-group', 'score-part'],
  'score-part': [
    'identification',
    'part-name',
    'part-name-display',
    'part-abbreviation',
    'part-abbreviation-display',
    'group',
    'score-instrument',
    'midi-device',
    'midi-instrument'
  ],
  'score-instrument': [
    'instrument-name',
    'instrument-abbreviation',
    'instrument-sound',
    'solo',
    'ensemble'
  ],
  'midi-instrument': [
    'midi-channel',
    'midi-name',
    'midi-bank',
    'midi-program',
    'volume',
    'pan',
    'elevation'
  ],
  'attributes': [
    'footnote',
    'level',
    'divisions',
    'key',
    'time',
    'staves',
    'part-symbol',
    'instruments',
    'clef',
    'staff-details',
    'transpose',
    'directive',
    'measure-style'
  ],
  'key': ['cancel', 'fifths', 'mode', 'key-step', 'key-alter', 'key-accidental', 'key-octave'],
  'time': ['beats', 'beat-type', 'senza-misura', 'interchangeable'],
  'clef': ['sign', 'line', 'clef-octave-change'],
  'barline': [
    'bar-style',
    'footnote',
    'level',
    'wavy-line',
    'segno',
    'coda',
    'fermata',
    'ending',
    'repeat'
  ],
  'note': [
    'grace',
    'chord',
    'pitch',
    'unpitched',
    'rest',
    'duration',
    'tie',
    'instrument',
    'footnote',
    'level',
    'voice',
    'type',
    'dot',
    'accidental',
    'time-modification',
    'stem',
    'notehead',
    'notehead-text',
    'staff',
    'beam',
    'notations',
    'lyric',
    'play',
    'listen'
  ],
  'pitch': ['step', 'alter', 'octave'],
  'time-modification': ['actual-notes', 'normal-notes', 'normal-type', 'normal-dot'],
  'backup': ['duration', 'footnote', 'level'],
  'forward': ['duration', 'footnote', 'level', 'voice', 'staff'],
  'measure-style': ['multiple-rest', 'measure-repeat', 'beat-repeat', 'slash', 'numbered']
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

export class XmlElement {
  readonly name: string
  readonly attributes: Map<string, string>
  readonly children: XmlElement[] = []
  /** Text content; `null` for an element that holds children instead. */
  text: string | null

  constructor(
    name: string,
    attributes: Record<string, string | number> = {},
    text: string | number | null = null
  ) {
    this.name = name
    this.attributes = new Map()
    for (const [key, value] of Object.entries(attributes)) {
      this.attributes.set(key, String(value))
    }
    this.text = text === null ? null : String(text)
  }

  setAttribute(name: string, value: string | number): void {
    this.attributes.set(name, String(value))
  }

  addChild<T extends XmlElement>(child: T): T {
    this.children.push(child)
    return child
  }

  getChildrenOfType(name: string): XmlElement[] {
    return this.children.filter(child => child.name === name)
  }

  private orderedChildren(): XmlElement[] {
    const order = CHILD_ORDER[this.name]
    if (order === undefined) return this.children
    const rank = new Map(order.map((childName, index) => [childName, index]))
    const fallback = order.length
    const indexOf = new Map(this.children.map((child, index) => [child, index]))
    return [...this.children].sort((a, b) => {
      const left = rank.get(a.name) ?? fallback
      const right = rank.get(b.name) ?? fallback
      if (left !== right) return left - right
      return (indexOf.get(a) as number) - (indexOf.get(b) as number)
    })
  }

  private openTag(): string {
    let tag = `<${this.name}`
    for (const [key, value] of this.attributes) tag += ` ${key}="${escapeAttribute(value)}"`
    return tag
  }

  toXml(indent = 0): string {
    const padding = '  '.repeat(indent)
    if (this.children.length === 0) {
      if (this.text === null) return `${padding}${this.openTag()} />`
      return `${padding}${this.openTag()}>${escapeText(this.text)}</${this.name}>`
    }
    const lines = [(`${padding}${this.openTag()}>`)]
    for (const child of this.orderedChildren()) lines.push(child.toXml(indent + 1))
    lines.push(`${padding}</${this.name}>`)
    return lines.join('\n')
  }
}

/** The document, with the declaration Python's `musicxml` writes. */
export function serialiseDocument(root: XmlElement): string {
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
  return `${header}\n${root.toXml()}\n`
}
