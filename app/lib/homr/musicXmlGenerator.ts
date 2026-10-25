/**
 * `music_xml_generator.py`: turn the recognised voices into a MusicXML score.
 *
 * The timing rules live in `musicXmlTiming.ts`; this file builds the XML tree.
 *
 * Two arguments of HOMR's writer are not ported because they need the visual sidecar:
 * a printed time signature (`read_time_signatures`), tuplet repair and shared notehead
 * timing. `metronome`, `tempo` and `large_page` are command line options of the CLI and
 * are left out of the browser demo. Everything else follows the fork's writer.
 */

import { serialiseDocument, XmlElement } from '../musicxml/element'
import { Fraction } from './fraction'
import {
  addTupletStartStop,
  afterShortestAdvance,
  ConversionState,
  groupIntoChords,
  inferMeters,
  loneRestIds,
  MeasureRest,
  splitMixedChords,
  SymbolChord,
  withMeasureRests
} from './musicXmlTiming'
import { EMPTY, EncodedSymbol, NONOTE } from './vocabulary'

export interface XmlGeneratorArguments {
  /**
   * `--guess-meter-per-section`: infer each time signature's beat count from the bars
   * it governs, measured by when their notes end.
   */
  guessMeterPerSection?: boolean
  /**
   * Called once per `<note>` element, in document order. The symbol carries the id the
   * decoder gave it, which is how the UI joins a written note back to its attention
   * point. Notes synthesised by the writer (measure rests) reuse the rest's id.
   */
  onNote?: (symbol: EncodedSymbol) => void
}

const LIFT_TO_ALTER = new Map<string, number>([
  ['N', 0],
  ['#', 1],
  ['##', 2],
  ['b', -1],
  ['bb', -2]
])

const DURATION_NAMES = new Map<number, string>([
  [0, 'breve'],
  [1, 'whole'],
  [2, 'half'],
  [4, 'quarter'],
  [8, 'eighth'],
  [16, '16th'],
  [32, '32nd'],
  [64, '64th'],
  [128, '128th']
])

/** `build_work` */
function buildWork(titleText: string): XmlElement {
  const work = new XmlElement('work')
  work.addChild(new XmlElement('work-title', {}, titleText))
  return work
}

/** Identification/encoding so validators and apps can attribute the file. */
function buildIdentification(): XmlElement {
  const identification = new XmlElement('identification')
  const encoding = identification.addChild(new XmlElement('encoding'))
  encoding.addChild(new XmlElement('software', {}, 'homr'))
  return identification
}

/**
 * `build_part_list`'s metadata: classified by staff layout only. `midiProgram` is
 * 1-based (1 = Acoustic Grand Piano, 54 = Voice Oohs).
 */
function partMetadata(hasTwoStaves: boolean): [string, string, string, number] {
  if (hasTwoStaves) return ['Piano', 'Piano', 'keyboard.piano', 1]
  return ['Voice', 'Voice', 'voice', 54]
}

function getPartId(index: number): string {
  return `P${index + 1}`
}

function buildPartList(hasTwoStavesByPart: boolean[]): XmlElement {
  const partList = new XmlElement('part-list')
  for (let part = 0; part < hasTwoStavesByPart.length; part += 1) {
    const partId = getPartId(part)
    const [partName, instrumentName, instrumentSound, midiProgram] = partMetadata(
      hasTwoStavesByPart[part]
    )
    const scorePart = partList.addChild(new XmlElement('score-part', { id: partId }))
    scorePart.addChild(new XmlElement('part-name', {}, partName))
    const scoreInstrument = scorePart.addChild(
      new XmlElement('score-instrument', { id: `${partId}-I1` })
    )
    scoreInstrument.addChild(new XmlElement('instrument-name', {}, instrumentName))
    scoreInstrument.addChild(new XmlElement('instrument-sound', {}, instrumentSound))
    const midiInstrument = scorePart.addChild(
      new XmlElement('midi-instrument', { id: `${partId}-I1` })
    )
    midiInstrument.addChild(new XmlElement('midi-channel', {}, part + 1))
    midiInstrument.addChild(new XmlElement('midi-program', {}, midiProgram))
    midiInstrument.addChild(new XmlElement('volume', {}, 100))
    midiInstrument.addChild(new XmlElement('pan', {}, 0))
  }
  return partList
}

/** `build_or_get_attributes` */
function buildOrGetAttributes(
  measure: XmlElement,
  lastAttributes: XmlElement | null,
  forceNew = false
): XmlElement {
  if (lastAttributes !== null && !forceNew) return lastAttributes
  return measure.addChild(new XmlElement('attributes'))
}

/** `build_or_get_barline` */
function buildOrGetBarline(measure: XmlElement, location: string): XmlElement {
  for (const child of measure.getChildrenOfType('barline')) {
    if (child.attributes.get('location') === location) return child
  }
  return measure.addChild(new XmlElement('barline', { location }))
}

/** `get_staff`: the writer puts every symbol not on the upper staff on the lower one. */
function getStaff(symbol: EncodedSymbol): number {
  return symbol.position === 'lower' ? 2 : 1
}

/**
 * `get_xml_voice`: voice numbers are part-global, so reserve 4 per staff to keep
 * independent rhythmic layers apart. Staff 1 gets voices 1-4, staff 2 gets 5-8.
 */
function getXmlVoice(staffNum: number, rhythmicLayer: number): number {
  return (staffNum - 1) * 4 + rhythmicLayer + 1
}

interface TimedNoteEvent {
  staffNum: number
  start: number
  end: number
  notes: XmlElement[]
}

/** `rebalance_measure_voices`: assign stable non-overlapping voices per staff. */
function rebalanceMeasureVoices(measure: XmlElement): void {
  const timedEvents: TimedNoteEvent[] = []
  let currentTime = 0
  let lastNoteStart = 0
  for (const child of measure.children) {
    if (child.name === 'backup' || child.name === 'forward') {
      const durations = child.getChildrenOfType('duration')
      if (durations.length > 0) {
        const value = Number(durations[0].text)
        currentTime += child.name === 'backup' ? -value : value
      }
      continue
    }
    if (child.name !== 'note') continue

    const durationNodes = child.getChildrenOfType('duration')
    const duration = durationNodes.length > 0 ? Number(durationNodes[0].text) : 0
    const staffNodes = child.getChildrenOfType('staff')
    const staffNum = staffNodes.length > 0 ? Number(staffNodes[0].text) : 1
    const isChordTone = child.getChildrenOfType('chord').length > 0
    const start = isChordTone ? lastNoteStart : currentTime
    const end = start + duration
    if (isChordTone) {
      const last = timedEvents[timedEvents.length - 1]
      if (
        last !== undefined
        && last.staffNum === staffNum
        && last.start === start
        && last.end === end
      ) {
        last.notes.push(child)
        continue
      }
    } else {
      lastNoteStart = start
      currentTime += duration
    }
    timedEvents.push({ staffNum, start, end, notes: [child] })
  }

  const byStaff = new Map<number, TimedNoteEvent[]>()
  for (const event of timedEvents) {
    const list = byStaff.get(event.staffNum)
    if (list === undefined) byStaff.set(event.staffNum, [event])
    else list.push(event)
  }
  for (const [staffNum, events] of byStaff) {
    const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end)
    let active: [number, number][] = []
    for (const event of sorted) {
      active = active.filter(([activeEnd]) => activeEnd > event.start)
      const used = new Set(active.map(([, voiceNo]) => voiceNo))
      let voiceNo = 1
      while (used.has(voiceNo)) voiceNo += 1
      active.push([event.end, voiceNo])
      const xmlVoice = String(getXmlVoice(staffNum, voiceNo - 1))
      for (const note of event.notes) {
        const voiceNodes = note.getChildrenOfType('voice')
        if (voiceNodes.length > 0) voiceNodes[0].text = xmlVoice
      }
    }
  }
}

/** `build_clef` */
function buildClef(modelClef: EncodedSymbol, attributes: XmlElement): void {
  const signAndLine = modelClef.rhythm.split('_')[1]
  const clef = attributes.addChild(new XmlElement('clef', { number: getStaff(modelClef) }))
  clef.addChild(new XmlElement('sign', {}, signAndLine[0]))
  clef.addChild(new XmlElement('line', {}, Number(signAndLine[1])))
}

/** `build_key` */
function buildKey(modelKey: EncodedSymbol, attributes: XmlElement): void {
  const key = attributes.addChild(new XmlElement('key'))
  key.addChild(new XmlElement('fifths', {}, Number(modelKey.rhythm.split('_')[1])))
}

/** `build_time_signature` */
function buildTimeSignature(
  modelTimeSignature: EncodedSymbol,
  attributes: XmlElement,
  state: ConversionState
): void {
  const denominator = Number(modelTimeSignature.rhythm.split('/')[1])
  const time = attributes.addChild(new XmlElement('time'))
  const nominator = state.sectionNominators.get(modelTimeSignature) ?? state.nominator
  const beats = Math.max(nominator.mul(denominator).trunc(), 1)
  time.addChild(new XmlElement('beats', {}, String(beats)))
  time.addChild(new XmlElement('beat-type', {}, denominator))
  state.beats = beats
  state.barLength = new Fraction(beats, denominator)
}

/** `build_barline_style` */
function buildBarlineStyle(barline: EncodedSymbol, xml: XmlElement): void {
  const style = barline.rhythm === 'bolddoublebarline' ? 'heavy-heavy' : 'light-light'
  xml.addChild(new XmlElement('bar-style', {}, style))
}

/** `build_barline_ending` */
function buildBarlineEnding(volta: EncodedSymbol, xml: XmlElement, voltaNumber: number): void {
  let type: string
  if (volta.rhythm.startsWith('voltaStart')) type = 'start'
  else if (volta.rhythm.startsWith('voltaStop')) type = 'stop'
  else if (volta.rhythm.startsWith('voltaDiscontinue')) type = 'discontinue'
  else throw new Error(`Unknown ending ${volta.rhythm}`)
  xml.addChild(new XmlElement('ending', { type, number: voltaNumber }))
}

/** `build_repeat` */
function buildRepeat(barline: EncodedSymbol, xml: XmlElement): void {
  if (xml.getChildrenOfType('repeat').length > 0) {
    console.warn('barline already has a repeat')
    return
  }
  const direction = barline.rhythm === 'repeatStart' ? 'forward' : 'backward'
  xml.addChild(new XmlElement('repeat', { direction }))
}

/**
 * `build_articulations`. HOMR's chain tests `arpeggiate` and `fermata` twice; the first
 * branch wins, so a fermata is a direct child of `notations` and never reaches the
 * `articulations` group. Only the winning branches are ported.
 */
function buildArticulations(
  note: XmlElement,
  articulations: string,
  tupletMark: string,
  state: ConversionState
): void {
  const notation = note.addChild(new XmlElement('notations'))
  const xmlArticulations: XmlElement[] = []
  const xmlOrnaments: XmlElement[] = []

  for (const articulation of articulations.split('_')) {
    if (articulation === '') continue
    else if (articulation === NONOTE) console.warn('note without valid articulation', articulations)
    else if (articulation === 'fermata') notation.addChild(new XmlElement('fermata'))
    else if (articulation === 'arpeggiate') notation.addChild(new XmlElement('arpeggiate'))
    else if (articulation === 'accent') xmlArticulations.push(new XmlElement('accent'))
    else if (articulation === 'staccato') xmlArticulations.push(new XmlElement('staccato'))
    else if (articulation === 'staccatissimo') {
      xmlArticulations.push(new XmlElement('staccatissimo'))
    } else if (articulation === 'tenuto') xmlArticulations.push(new XmlElement('tenuto'))
    else if (articulation === 'tremolo') {
      xmlOrnaments.push(new XmlElement('tremolo', { type: state.toggleTremoloState() }, '3'))
    } else if (articulation === 'trill') xmlOrnaments.push(new XmlElement('trill-mark'))
    else if (articulation === 'breathMark') xmlArticulations.push(new XmlElement('breath-mark'))
    else if (articulation === 'turn') xmlOrnaments.push(new XmlElement('inverted-turn'))
    else if (articulation === 'caesura') xmlArticulations.push(new XmlElement('caesura'))
    else if (articulation === 'doit') xmlArticulations.push(new XmlElement('doit'))
    else if (articulation === 'slurStart') notation.addChild(new XmlElement('slur', { type: 'start' }))
    else if (articulation === 'slurStop') notation.addChild(new XmlElement('slur', { type: 'stop' }))
    else if (articulation === 'tieStart') notation.addChild(new XmlElement('tied', { type: 'start' }))
    else if (articulation === 'tieStop') notation.addChild(new XmlElement('tied', { type: 'stop' }))
    else throw new Error(`Unsupported articulation ${articulation}`)
  }

  if (tupletMark !== '') notation.addChild(new XmlElement('tuplet', { type: tupletMark }))

  if (xmlArticulations.length > 0) {
    const parent = notation.addChild(new XmlElement('articulations'))
    for (const child of xmlArticulations) parent.addChild(child)
  }
  if (xmlOrnaments.length > 0) {
    const parent = notation.addChild(new XmlElement('ornaments'))
    for (const child of xmlOrnaments) parent.addChild(child)
  }
}

/** `build_slurs` */
function buildSlurs(note: XmlElement, slurs: string, slurNumber: number): void {
  const notations = note.getChildrenOfType('notations')
  const notation
    = notations.length > 0 ? notations[0] : note.addChild(new XmlElement('notations'))

  if (slurs === EMPTY || slurs === '') return
  if (slurs === NONOTE) {
    console.warn('note without valid articulation', slurs)
    return
  }
  if (slurs === 'slurStart') notation.addChild(new XmlElement('slur', { type: 'start', number: slurNumber }))
  else if (slurs === 'slurStop') notation.addChild(new XmlElement('slur', { type: 'stop', number: slurNumber }))
  else if (slurs === 'slurStart_slurStop') {
    // It is important to add the stop first, otherwise the slur starts and stops at once.
    notation.addChild(new XmlElement('slur', { type: 'stop', number: slurNumber }))
    notation.addChild(new XmlElement('slur', { type: 'start', number: slurNumber }))
  } else throw new Error(`Unsupported slur ${slurs}`)
}

/** `build_multi_measure_rest` */
function buildMultiMeasureRest(symbol: EncodedSymbol, attributes: XmlElement): void {
  if (attributes.getChildrenOfType('measure-style').length > 0) {
    console.warn('Measure already has a multi rest')
    return
  }
  const duration = Number(symbol.rhythm.split('_')[1].replace('m', ''))
  const style = attributes.addChild(new XmlElement('measure-style'))
  style.addChild(new XmlElement('multiple-rest', {}, duration))
}

/** `_group_notes`: group a chord's notes by written value, whole-bar rests by the longest. */
function groupNotes(notes: EncodedSymbol[]): { duration: Fraction, notes: EncodedSymbol[] }[] {
  let maxDuration = notes[0].getDuration().fraction
  for (const note of notes) {
    const duration = note.getDuration().fraction
    if (duration.compare(maxDuration) > 0) maxDuration = duration
  }
  const groups = new Map<string, { duration: Fraction, notes: EncodedSymbol[] }>()
  for (const note of notes) {
    const duration = note.getDuration()
    let fraction: Fraction
    if (note.rhythm.includes('G')) fraction = Fraction.ZERO
    else if (duration.fraction.numerator === 0n) fraction = maxDuration
    else fraction = duration.fraction
    const key = fraction.toString()
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { duration: fraction, notes: [note] })
    else existing.notes.push(note)
  }
  return [...groups.values()].sort((a, b) => a.duration.compare(b.duration))
}

/** `build_note_or_rest` */
function buildNoteOrRest(
  modelNote: EncodedSymbol,
  rhythmicLayer: number,
  isChord: boolean,
  state: ConversionState,
  tupletMark: string,
  args: XmlGeneratorArguments
): XmlElement {
  const note = new XmlElement('note')
  if (isChord) note.addChild(new XmlElement('chord'))
  const modelPitch = modelNote.pitch
  const modelDuration = modelNote.getDuration()
  if (modelPitch === EMPTY) {
    if (modelDuration.fraction.numerator === 0n || modelNote instanceof MeasureRest) {
      note.addChild(new XmlElement('rest', { measure: 'yes' }))
    } else {
      note.addChild(new XmlElement('rest'))
    }
  } else if (modelPitch === NONOTE) {
    console.warn('note without pitch', modelNote.toString())
    note.addChild(new XmlElement('rest'))
  } else {
    const pitch = note.addChild(new XmlElement('pitch'))
    pitch.addChild(new XmlElement('step', {}, modelPitch[0]))
    const octave = Number(modelPitch.slice(1))
    const alter = LIFT_TO_ALTER.get(modelNote.lift)
    if (modelNote.lift === NONOTE) console.warn('note with invalid lift', modelNote.toString())
    else if (modelNote.lift !== EMPTY) pitch.addChild(new XmlElement('alter', {}, alter as number))
    pitch.addChild(new XmlElement('octave', {}, octave))
  }

  if (modelNote.rhythm.includes('G')) {
    note.addChild(new XmlElement('grace'))
    const durationName = DURATION_NAMES.get(modelDuration.kern) as string
    note.addChild(new XmlElement('type', {}, durationName))
  } else if (modelDuration.fraction.numerator > 0n) {
    const baseDuration = modelDuration.kern === 0 ? 1 : modelDuration.kern
    note.addChild(new XmlElement('type', {}, DURATION_NAMES.get(baseDuration) as string))
    note.addChild(
      new XmlElement(
        'duration',
        {},
        Math.max(1, modelDuration.fraction.mul(state.division).trunc())
      )
    )
  } else {
    note.addChild(new XmlElement('type', {}, DURATION_NAMES.get(0) as string))
    note.addChild(new XmlElement('duration', {}, state.beats))
  }

  const staffNum = getStaff(modelNote)
  note.addChild(new XmlElement('staff', {}, staffNum))
  note.addChild(new XmlElement('voice', {}, String(getXmlVoice(staffNum, rhythmicLayer))))
  for (let dot = 0; dot < modelDuration.dots; dot += 1) {
    note.addChild(new XmlElement('dot'))
  }
  if (modelDuration.actualNotes !== modelDuration.normalNotes) {
    const timeModification = note.addChild(new XmlElement('time-modification'))
    timeModification.addChild(new XmlElement('actual-notes', {}, modelDuration.actualNotes))
    timeModification.addChild(new XmlElement('normal-notes', {}, modelDuration.normalNotes))
    buildArticulations(note, modelNote.articulation, tupletMark, state)
    buildSlurs(note, modelNote.slur, staffNum)
  } else {
    buildArticulations(note, modelNote.articulation, '', state)
    buildSlurs(note, modelNote.slur, staffNum)
  }
  args.onNote?.(modelNote)
  return note
}

function backupOf(duration: Fraction, division: number): XmlElement {
  const backup = new XmlElement('backup')
  backup.addChild(new XmlElement('duration', {}, Math.max(1, duration.mul(division).trunc())))
  return backup
}

/**
 * `build_note_chord`: write the staff positions of one group, backing up between
 * different note values and back to where the group started afterwards.
 */
function buildNoteChord(
  noteChord: SymbolChord,
  state: ConversionState,
  chordDuration: Fraction,
  args: XmlGeneratorArguments
): XmlElement[] {
  const byDuration = groupNotes(noteChord.symbols)
  const result: XmlElement[] = []
  let finalDuration = Fraction.ZERO
  for (let i = 0; i < byDuration.length; i += 1) {
    const group = byDuration[i]
    let isFirst = true
    for (const note of group.notes) {
      result.push(
        buildNoteOrRest(note, i, !isFirst, state, noteChord.tupletMark, args)
      )
      isFirst = false
    }
    if (i !== byDuration.length - 1 && group.duration.compare(0) > 0) {
      result.push(backupOf(group.duration, state.division))
    }
    finalDuration = group.duration
  }
  // Reset the position to match the chord position.
  if (chordDuration.compare(finalDuration) < 0) {
    result.push(backupOf(finalDuration.sub(chordDuration), state.division))
  }
  return result
}

/**
 * `build_measures`: walk one voice and append measures to a part.
 *
 * Tokens say which notes start together, not when each group starts: a group starts
 * when the shortest note of the group before ends. HOMR can instead start it when the
 * earliest still-sounding note ends, but only for a bar whose meter is trusted, which
 * needs the visual sidecar; see `musicXmlTiming.ts`.
 */
function buildMeasures(
  args: XmlGeneratorArguments,
  voice: EncodedSymbol[],
  hasTwoStaves = false
): XmlElement[] {
  let clock = Fraction.ZERO
  const measures: XmlElement[] = []
  let measureNumber = 1
  let currentMeasure = new XmlElement('measure', { number: String(measureNumber) })

  const closeCurrentMeasure = (): void => {
    rebalanceMeasureVoices(currentMeasure)
    measures.push(currentMeasure)
    clock = Fraction.ZERO
  }

  const groups = splitMixedChords(addTupletStartStop(groupIntoChords(voice)))
  const meters = inferMeters(groups, args.guessMeterPerSection === true)
  const state = new ConversionState(meters.division, meters.nominator)
  state.sectionNominators = meters.sections
  const loneRests = loneRestIds(groups)

  const firstAttributes = buildOrGetAttributes(currentMeasure, null)
  // The divisions element counts divisions per quarter note.
  firstAttributes.addChild(new XmlElement('divisions', {}, Math.trunc(meters.division / 4)))
  if (hasTwoStaves) {
    firstAttributes.addChild(new XmlElement('staves', {}, 2))
    firstAttributes.addChild(new XmlElement('part-symbol', {}, 'brace'))
  }
  let attributes: XmlElement | null = firstAttributes

  for (let groupNo = 0; groupNo < groups.length; groupNo += 1) {
    const group = groups[groupNo]
    const symbol = group.symbols[0]
    const rhythm = symbol.rhythm
    const lastAttributes = attributes
    attributes = null
    if (rhythm.startsWith('note') || rhythm.startsWith('rest')) {
      if (group.symbols.length === 1 && rhythm.endsWith('m')) {
        attributes = buildOrGetAttributes(currentMeasure, lastAttributes)
        buildMultiMeasureRest(symbol, attributes)
      } else {
        // Only notes and rests take part: anything else the transformer chorded with
        // them, such as a barline, would otherwise be written as a rest.
        const timed = new SymbolChord(
          group.symbols.filter(
            other => other.rhythm.startsWith('note') || other.rhythm.startsWith('rest')
          ),
          group.tupletMark
        )
        // A measure rest starts its bar; a lone rest read later stays as read.
        const written
          = clock.isZero() && state.barLength !== null
            ? withMeasureRests(timed, loneRests, state.barLength)
            : timed
        const staffPositions = written.intoPositions()
        const advance = afterShortestAdvance(written)
        clock = clock.add(advance)
        for (let posNo = 0; posNo < staffPositions.length; posNo += 1) {
          const chordDuration
            = posNo === staffPositions.length - 1 ? advance : Fraction.ZERO
          for (const noteXml of buildNoteChord(staffPositions[posNo], state, chordDuration, args)) {
            currentMeasure.addChild(noteXml)
          }
        }
      }
      continue
    }
    if (rhythm === 'newline') {
      if (groupNo !== groups.length - 1) {
        currentMeasure.addChild(new XmlElement('print', { 'new-system': 'yes' }))
      }
    } else if (rhythm.startsWith('clef')) {
      attributes = buildOrGetAttributes(currentMeasure, lastAttributes, true)
      for (const shouldBeClef of group.symbols) {
        if (shouldBeClef.rhythm.startsWith('clef')) buildClef(shouldBeClef, attributes)
      }
    } else if (rhythm.startsWith('keySignature')) {
      attributes = buildOrGetAttributes(currentMeasure, lastAttributes)
      buildKey(symbol, attributes)
    } else if (rhythm.startsWith('timeSignature')) {
      attributes = buildOrGetAttributes(currentMeasure, lastAttributes)
      buildTimeSignature(symbol, attributes, state)
      // No printed meter is trusted without the sidecar, so `trustedBarLength` stays null.
      state.trustedBarLength = null
    } else if (rhythm.includes('barline')) {
      if (rhythm !== 'barline') {
        // Standard barlines do not need extra handling.
        buildBarlineStyle(symbol, buildOrGetBarline(currentMeasure, 'right'))
      }
      closeCurrentMeasure()
      measureNumber += 1
      currentMeasure = new XmlElement('measure', { number: String(measureNumber) })
    } else if (rhythm === 'repeatStart') {
      closeCurrentMeasure()
      measureNumber += 1
      currentMeasure = new XmlElement('measure', { number: String(measureNumber) })
      buildRepeat(symbol, buildOrGetBarline(currentMeasure, 'right'))
    } else if (rhythm === 'repeatEnd') {
      buildRepeat(symbol, buildOrGetBarline(currentMeasure, 'right'))
      closeCurrentMeasure()
      measureNumber += 1
      currentMeasure = new XmlElement('measure', { number: String(measureNumber) })
    } else if (rhythm === 'repeatEndStart') {
      buildRepeat(new EncodedSymbol('repeatEnd'), buildOrGetBarline(currentMeasure, 'right'))
      closeCurrentMeasure()
      measureNumber += 1
      currentMeasure = new XmlElement('measure', { number: String(measureNumber) })
      buildRepeat(new EncodedSymbol('repeatStart'), buildOrGetBarline(currentMeasure, 'right'))
    } else if (rhythm.startsWith('voltaStart')) {
      const voltaNumber = state.startVolta(measureNumber)
      buildBarlineEnding(symbol, buildOrGetBarline(currentMeasure, 'left'), voltaNumber)
    } else if (rhythm.startsWith('voltaStop') || rhythm.startsWith('voltaDiscontinue')) {
      const voltaNumber = state.stopVolta(measureNumber)
      buildBarlineEnding(symbol, buildOrGetBarline(currentMeasure, 'right'), voltaNumber)
    } else {
      console.warn('Symbol isn\'t supported yet', symbol.toString())
    }
  }

  if (currentMeasure.children.length > 0) closeCurrentMeasure()
  return measures
}

/** `_voice_has_two_staves`: any symbol on the lower staff, e.g. a piano left hand. */
function voiceHasTwoStaves(voice: EncodedSymbol[]): boolean {
  return voice.some(symbol => symbol.position === 'lower')
}

/**
 * `generate_xml`: the score. HOMR takes the title from an OCR pass over the page; the
 * browser demo passes the file name instead.
 */
export function generateMusicXml(
  staffs: EncodedSymbol[][],
  title: string,
  args: XmlGeneratorArguments = {}
): XmlElement {
  const root = new XmlElement('score-partwise', { version: '4.0' })
  root.addChild(buildWork(title))
  root.addChild(buildIdentification())
  root.addChild(new XmlElement('defaults'))
  const hasTwoStavesByPart = staffs.map(voiceHasTwoStaves)
  root.addChild(buildPartList(hasTwoStavesByPart))
  staffs.forEach((voice, index) => {
    const part = root.addChild(new XmlElement('part', { id: getPartId(index) }))
    const measures = buildMeasures(args, voice, hasTwoStavesByPart[index])
    for (const measure of measures) part.addChild(measure)
  })
  return root
}

/** The MusicXML text the demo downloads. */
export function generateMusicXmlString(
  staffs: EncodedSymbol[][],
  title: string,
  args: XmlGeneratorArguments = {}
): string {
  return serialiseDocument(generateMusicXml(staffs, title, args))
}
