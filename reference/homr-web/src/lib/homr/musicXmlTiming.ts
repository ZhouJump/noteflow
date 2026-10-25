/**
 * `music_xml_generator.py`'s timing half: the symbols grouped into chords, the inferred
 * meters, and the rules that decide where a chord group starts.
 *
 * Everything here is independent of the XML tree, which is why it lives apart from the
 * writer: `scripts/check-voices.mjs` and the writer share it.
 *
 * One thing is deliberately absent. HOMR can place a bar by the earliest sounding note
 * instead of by the shortest note of the group, but only when the bar's meter is
 * trusted, which needs the printed time signatures the visual sidecar reads. The
 * browser port runs without that sidecar, so `trustedBarLength` stays null and every
 * bar is placed after its shortest note; `staffEnds` and the earliest-end comparison
 * would never run.
 */

import { Fraction, lcm, medianFraction } from './fraction.ts';
import { EncodedSymbol, SymbolDuration, sortTokenChords } from './vocabulary.ts';

/** `constants.duration_of_quarter`, in divisions per quarter note. */
export const DURATION_OF_QUARTER = 16;

/** The rules `bar_placement.py` names; only the second one is reachable here. */
export const EARLIEST_END = 'earliest_end';
export const AFTER_SHORTEST = 'after_shortest';

/** `ConversionState`: what the writer knows while it walks one voice. */
export class ConversionState {
  /** Written for a bar whose content leaves no length (`breve` duration). */
  beats = 4 * DURATION_OF_QUARTER;
  readonly division: number;
  readonly nominator: Fraction;
  /**
   * The typical bar length of the bars each time signature governs, keyed by the token
   * object; a piece that changes meter has one entry per section.
   */
  sectionNominators = new Map<EncodedSymbol, Fraction>();
  /**
   * The bar length a lone rest is written to fill: the time signature's once one is
   * written, until then the typical bar length of this voice if it is a whole number of
   * eighths.
   */
  barLength: Fraction | null;
  /** The bar length while the meter is trusted; never set without a sidecar. */
  trustedBarLength: Fraction | null = null;
  tremoloState = 'stop';
  voltaNumber = 1;
  lastVoltaMeasure = -10;

  constructor(division: number, nominator: Fraction) {
    this.division = division;
    this.nominator = nominator;
    this.barLength = nominator.compare(0) > 0 && nominator.mul(8).denominator === 1n ? nominator : null;
  }

  startVolta(measureNo: number): number {
    if (measureNo === this.lastVoltaMeasure + 1) this.voltaNumber += 1;
    else this.voltaNumber = 1;
    return this.voltaNumber;
  }

  stopVolta(measureNo: number): number {
    this.lastVoltaMeasure = measureNo;
    return this.voltaNumber;
  }

  toggleTremoloState(): string {
    this.tremoloState = this.tremoloState === 'start' ? 'stop' : 'start';
    return this.tremoloState;
  }
}

/** A staff's only rest in a bar, written to fill the bar whatever glyph was read. */
export class MeasureRest extends EncodedSymbol {
  constructor(rest: EncodedSymbol, barLength: Fraction) {
    super(
      rest.rhythm,
      rest.pitch,
      rest.lift,
      rest.articulation,
      rest.slur,
      rest.position,
      rest.coordinates,
    );
    this.setDuration(new SymbolDuration(barLength, 0, 1, 1, 1));
  }
}

/** `SymbolChord`: the symbols the transformer says start together. */
export class SymbolChord {
  readonly symbols: EncodedSymbol[];
  tupletMark: string;

  constructor(symbols: EncodedSymbol[], tupletMark = '') {
    this.symbols = symbols;
    this.tupletMark = tupletMark;
  }

  toString(): string {
    return this.symbols.map((symbol) => symbol.toString()).join('&');
  }

  isBarline(): boolean {
    if (this.symbols.length === 0) return false;
    const first = this.symbols[0].rhythm;
    return first.includes('barline') || first.includes('repeat');
  }

  getDuration(): Fraction {
    const durations: Fraction[] = [];
    for (const symbol of this.symbols) {
      if (symbol.rhythm.startsWith('note') || symbol.rhythm.startsWith('rest')) {
        durations.push(symbol.getDuration().fraction);
      }
    }
    if (durations.length === 0) return Fraction.ZERO;
    let shortest = durations[0];
    for (const duration of durations) if (duration.compare(shortest) < 0) shortest = duration;
    return shortest;
  }

  /**
   * Split into the upper and lower staff. A lower staff holding only rests is written
   * first, so a whole-bar rest does not run after the other hand's notes.
   */
  intoPositions(): SymbolChord[] {
    const upper: EncodedSymbol[] = [];
    const lower: EncodedSymbol[] = [];
    let lowerIsOnlyRest = true;
    for (const symbol of this.symbols) {
      if (symbol.position === 'upper') {
        upper.push(symbol);
      } else {
        lower.push(symbol);
        lowerIsOnlyRest = lowerIsOnlyRest && symbol.rhythm.startsWith('rest');
      }
    }
    let chords = [new SymbolChord(upper, this.tupletMark), new SymbolChord(lower, this.tupletMark)];
    if (lowerIsOnlyRest) chords = [chords[1], chords[0]];
    return chords.filter((chord) => chord.symbols.length > 0);
  }
}

/** `after_shortest_advance`: the shortest timed note of the group, zero if none. */
export function afterShortestAdvance(group: SymbolChord, lost: Fraction[] = []): Fraction {
  const timed: Fraction[] = [];
  for (const symbol of group.symbols) {
    if (!symbol.rhythm.startsWith('note') && !symbol.rhythm.startsWith('rest')) continue;
    const duration = symbol.getDuration().fraction;
    if (duration.compare(0) > 0) timed.push(duration);
  }
  timed.push(...lost);
  if (timed.length === 0) return Fraction.ZERO;
  let shortest = timed[0];
  for (const duration of timed) if (duration.compare(shortest) < 0) shortest = duration;
  return shortest;
}

/**
 * `_advance_to_next_group`: how far the next group starts after this one, updating the
 * sounding notes in place. Grace notes have no duration and take no time.
 */
export function advanceToNextGroup(
  group: SymbolChord,
  clock: Fraction,
  sounding: Fraction[],
): Fraction {
  const timed: Fraction[] = [];
  for (const symbol of group.symbols) {
    if (!symbol.rhythm.startsWith('note') && !symbol.rhythm.startsWith('rest')) continue;
    const duration = symbol.getDuration().fraction;
    if (duration.compare(0) > 0) timed.push(duration);
  }
  if (timed.length === 0) return Fraction.ZERO;
  for (const duration of timed) sounding.push(clock.add(duration));
  let earliest: Fraction | null = null;
  for (const end of sounding) {
    if (end.compare(clock) <= 0) continue;
    if (earliest === null || end.compare(earliest) < 0) earliest = end;
  }
  // The group's own notes were just added, so one of them ends after the clock.
  return (earliest as Fraction).sub(clock);
}

/** `_measure_length`: when the bar's last note ends under `rule`. */
export function measureLength(
  chords: EncodedSymbol[][],
  rule: string = EARLIEST_END,
): Fraction {
  let clock = Fraction.ZERO;
  let sounding: Fraction[] = [];
  for (const chord of chords) {
    const group = new SymbolChord(chord);
    // Either way the group's notes are recorded as sounding, for where the bar ends.
    let advance = advanceToNextGroup(group, clock, sounding);
    if (rule !== EARLIEST_END) advance = afterShortestAdvance(group);
    clock = clock.add(advance);
    sounding = sounding.filter((end) => end.compare(clock) > 0);
  }
  let result = clock;
  for (const end of sounding) if (end.compare(result) > 0) result = end;
  return result;
}

/**
 * `_lone_rest_staves`: the staves whose only timed symbol in this bar is one rest. Such
 * a rest fills the bar whatever glyph was read.
 */
export function loneRestStaves(chords: EncodedSymbol[][]): Set<string> {
  const timedByStaff = new Map<string, EncodedSymbol[]>();
  for (const chord of chords) {
    for (const symbol of chord) {
      if (!symbol.rhythm.startsWith('note') && !symbol.rhythm.startsWith('rest')) continue;
      if (symbol.getDuration().fraction.compare(0) <= 0) continue;
      const list = timedByStaff.get(symbol.position);
      if (list === undefined) timedByStaff.set(symbol.position, [symbol]);
      else list.push(symbol);
    }
  }
  const result = new Set<string>();
  for (const [position, symbols] of timedByStaff) {
    if (symbols.length === 1 && symbols[0].rhythm.startsWith('rest')) result.add(position);
  }
  return result;
}

/**
 * `_bar_length_evidence`: the length a bar's content gives it, or zero when nothing in
 * the bar says. A staff whose only content is one rest shows nothing.
 */
export function barLengthEvidence(chords: EncodedSymbol[][]): Fraction {
  const lone = loneRestStaves(chords);
  const kept = chords
    .map((chord) => chord.filter((symbol) => !lone.has(symbol.position)))
    .filter((chord) => chord.length > 0);
  return measureLength(kept);
}

/**
 * `_lone_rest_ids`: every rest that is its staff's only timed symbol in its bar, mapped
 * to how long the bar's other staves last (zero when nothing else is timed).
 */
export function loneRestIds(groups: SymbolChord[]): Map<EncodedSymbol, Fraction> {
  const result = new Map<EncodedSymbol, Fraction>();
  let bar: EncodedSymbol[][] = [];
  for (const group of [...groups, new SymbolChord([new EncodedSymbol('barline')])]) {
    if (!group.isBarline()) {
      bar.push(group.symbols);
      continue;
    }
    const lone = loneRestStaves(bar);
    const otherStaves = barLengthEvidence(bar);
    for (const chord of bar) {
      for (const symbol of chord) {
        if (!lone.has(symbol.position)) continue;
        if (!symbol.rhythm.startsWith('rest') || symbol.rhythm.endsWith('m')) continue;
        result.set(symbol, otherStaves);
      }
    }
    bar = [];
  }
  return result;
}

/**
 * `_with_measure_rests`: write each lone rest as a measure rest filling the bar.
 *
 * The bar lasts `barLength`, unless both the rest as read and the bar's other staves
 * are shorter; a pickup bar or the bar after a repeat sign is short on the page.
 */
export function withMeasureRests(
  group: SymbolChord,
  loneRests: Map<EncodedSymbol, Fraction>,
  barLength: Fraction,
): SymbolChord {
  const filled = (symbol: EncodedSymbol): Fraction | null => {
    const evidence = loneRests.get(symbol);
    if (evidence === undefined) return null;
    const read = symbol.getDuration().fraction;
    const other = evidence;
    const longer = read.compare(other) > 0 ? read : other;
    const length = barLength.compare(longer) < 0 ? barLength : longer;
    return length.equals(read) && read.compare(barLength) < 0 ? null : length;
  };
  const lengths = group.symbols.map(filled);
  if (lengths.every((length) => length === null)) return group;
  const symbols = group.symbols.map((symbol, index) => {
    const length = lengths[index];
    return length === null ? symbol : new MeasureRest(symbol, length);
  });
  return new SymbolChord(symbols, group.tupletMark);
}

/** `find_common_division`: the smallest denominator expressing every duration. */
export function findCommonDivision(durations: Fraction[]): number {
  const denominators: number[] = [];
  for (const duration of durations) {
    if (duration.compare(0) > 0) denominators.push(Number(duration.denominator));
  }
  if (denominators.length === 0) return 1;
  let common = denominators[0];
  for (let i = 1; i < denominators.length; i += 1) common = lcm(common, denominators[i]);
  return common;
}

/**
 * `find_division_and_time_signature_nominator`: the division, and the typical bar
 * length taken from the bars as the sum of each group's shortest note.
 */
export function findDivisionAndTimeSignatureNominator(
  voice: SymbolChord[],
): [number, Fraction] {
  const durations: Fraction[] = [new Fraction(1, 4)];
  let durationInMeasure = Fraction.ZERO;
  const measureDuration: Fraction[] = [];
  for (const chord of voice) {
    if (chord.isBarline() && durationInMeasure.compare(0) > 0) {
      measureDuration.push(durationInMeasure);
      durationInMeasure = Fraction.ZERO;
      continue;
    }
    for (const symbol of chord.symbols) {
      if (symbol.rhythm.startsWith('note') || symbol.rhythm.startsWith('rest')) {
        const fraction = symbol.getDuration().fraction;
        if (fraction.compare(0) > 0) durations.push(fraction);
      } else if (symbol.rhythm.startsWith('timeSignature/')) {
        // A measure rest lasts a whole bar of this time signature.
        durations.push(new Fraction(1, Number(symbol.rhythm.split('/')[1])));
      }
    }
    const duration = chord.getDuration();
    if (duration.compare(0) > 0) durationInMeasure = durationInMeasure.add(duration);
  }
  if (durationInMeasure.compare(0) > 0) measureDuration.push(durationInMeasure);
  if (measureDuration.length === 0) return [findCommonDivision(durations), Fraction.ONE];
  return [findCommonDivision(durations), medianFraction(measureDuration)];
}

/**
 * `sounding_time_signature_nominator`: the typical bar length with each bar measured by
 * the earliest end, without a staff whose only content is a rest, and leaving out the
 * bars in which nothing says how long they are.
 */
export function soundingTimeSignatureNominator(voice: SymbolChord[]): Fraction {
  const lengths: Fraction[] = [];
  let bar: EncodedSymbol[][] = [];
  for (const chord of [...voice, new SymbolChord([new EncodedSymbol('barline')])]) {
    if (chord.isBarline()) {
      const length = barLengthEvidence(bar);
      if (length.compare(0) > 0) lengths.push(length);
      bar = [];
    } else {
      bar.push(chord.symbols);
    }
  }
  if (lengths.length === 0) return Fraction.ONE;
  return medianFraction(lengths);
}

/**
 * `time_signature_section_nominators`: the typical bar length of each time signature's
 * section, keyed by the token object.
 */
export function timeSignatureSectionNominators(
  voice: SymbolChord[],
): Map<EncodedSymbol, Fraction> {
  const lengths = new Map<EncodedSymbol, Fraction[]>();
  let section: EncodedSymbol | null = null;
  let bar: EncodedSymbol[][] = [];
  for (const chord of [...voice, new SymbolChord([new EncodedSymbol('barline')])]) {
    if (chord.isBarline()) {
      const length = barLengthEvidence(bar);
      if (section !== null && length.compare(0) > 0) {
        const list = lengths.get(section);
        if (list === undefined) lengths.set(section, [length]);
        else list.push(length);
      }
      bar = [];
      continue;
    }
    for (const symbol of chord.symbols) {
      if (symbol.rhythm.startsWith('timeSignature/')) section = symbol;
    }
    bar.push(chord.symbols);
  }
  const result = new Map<EncodedSymbol, Fraction>();
  for (const [key, values] of lengths) result.set(key, medianFraction(values));
  return result;
}

export interface InferredMeters {
  division: number;
  nominator: Fraction;
  sections: Map<EncodedSymbol, Fraction>;
}

/**
 * `TimingRepairs._guess_meter` without the repairs: the same meters, and no shared
 * notehead ends or lost note lengths because those need the sidecar's noteheads.
 */
export function inferMeters(groups: SymbolChord[], guessMeterPerSection: boolean): InferredMeters {
  const [division, nominator] = findDivisionAndTimeSignatureNominator(groups);
  if (!guessMeterPerSection) return { division, nominator, sections: new Map() };
  return {
    division,
    nominator: soundingTimeSignatureNominator(groups),
    sections: timeSignatureSectionNominators(groups),
  };
}

/** `group_into_chords` */
export function groupIntoChords(voice: EncodedSymbol[]): SymbolChord[] {
  return sortTokenChords(voice).map((chord) => new SymbolChord(chord));
}

const BEFORE_NOTES_ORDER = ['clef', 'keySignature', 'timeSignature'];

/**
 * `_split_mixed_chord`: the transformer sometimes joins a clef, key, time signature or
 * barline to a chord of notes. Clefs, keys and time signatures go before the notes (in
 * the order they have at the start of a line), barlines and repeats after them.
 */
function splitMixedChord(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  const isNote = (symbol: EncodedSymbol): boolean =>
    symbol.rhythm.startsWith('note') || symbol.rhythm.startsWith('rest');
  const notes = symbols.filter(isNote);
  if (notes.length === 0 || notes.length === symbols.length) return [symbols];
  const others = symbols.filter((symbol) => !isNote(symbol));
  const after = others.filter(
    (symbol) => symbol.rhythm.includes('barline') || symbol.rhythm.includes('repeat'),
  );
  const before = new Map<string, EncodedSymbol[]>();
  for (const symbol of others) {
    if (after.includes(symbol)) continue;
    const kind = symbol.rhythm.split('_')[0].split('/')[0];
    const list = before.get(kind);
    if (list === undefined) before.set(kind, [symbol]);
    else list.push(symbol);
  }
  const rank = new Map(BEFORE_NOTES_ORDER.map((kind, index) => [kind, index]));
  const ordered = [...before.keys()].sort(
    (a, b) => (rank.get(a) ?? rank.size) - (rank.get(b) ?? rank.size),
  );
  const result: EncodedSymbol[][] = [];
  for (const kind of ordered) result.push(before.get(kind) as EncodedSymbol[]);
  result.push(notes);
  for (const symbol of after) result.push([symbol]);
  return result;
}

/**
 * `split_mixed_chords`. Runs after the tuplet marks are set, so the notes keep their
 * mark and a split-off clef does not interrupt a tuplet.
 */
export function splitMixedChords(groups: SymbolChord[]): SymbolChord[] {
  const result: SymbolChord[] = [];
  let splitBarline = false;
  for (const group of groups) {
    const parts = splitMixedChord(group.symbols);
    if (splitBarline && group.isBarline() && parts.length === 1) {
      // The barline split off the previous chord and this one are the same barline:
      // keep one, preferring a repeat or double barline over a plain barline.
      if (
        group.symbols[0].rhythm === 'barline' &&
        result[result.length - 1].symbols[0].rhythm !== 'barline'
      ) {
        splitBarline = false;
        continue;
      }
      result.pop();
    }
    for (const part of parts) {
      const isNotes = part[0].rhythm.startsWith('note') || part[0].rhythm.startsWith('rest');
      result.push(new SymbolChord(part, isNotes ? group.tupletMark : ''));
    }
    splitBarline = parts.length > 1 && result[result.length - 1].isBarline();
  }
  return result;
}

function getTupletDuration(group: SymbolChord): SymbolDuration | null {
  for (const symbol of group.symbols) {
    if (!symbol.rhythm.startsWith('note') && !symbol.rhythm.startsWith('rest')) continue;
    const duration = symbol.getDuration();
    if (duration.normalNotes !== duration.actualNotes) return duration;
  }
  return null;
}

function splitIntoMeasures(groups: SymbolChord[]): SymbolChord[][] {
  const measures: SymbolChord[][] = [];
  let current: SymbolChord[] = [];
  for (const group of groups) {
    current.push(group);
    if (group.isBarline()) {
      measures.push(current);
      current = [];
    }
  }
  if (current.length > 0) measures.push(current);
  return measures;
}

function addTuplets(groups: SymbolChord[]): boolean {
  let cursor = 0;
  while (cursor < groups.length) {
    const duration = getTupletDuration(groups[cursor]);
    if (duration === null) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    const tupletSize = duration.actualNotes;
    // This loop tries to find a complete tuplet.
    while (cursor - start < tupletSize) {
      if (cursor >= groups.length) return false;
      const current = getTupletDuration(groups[cursor]);
      if (current === null) return false;
      if (
        current.actualNotes !== duration.actualNotes ||
        current.normalNotes !== duration.normalNotes
      ) {
        return false;
      }
      cursor += 1;
    }
    groups[start].tupletMark = 'start';
    groups[cursor - 1].tupletMark = 'stop';
  }
  return true;
}

/**
 * `TupletParser.parse`: split into measures first, so a tuplet that cannot be completed
 * only loses its own measure's marks.
 */
export function addTupletStartStop(groups: SymbolChord[]): SymbolChord[] {
  for (const measureGroups of splitIntoMeasures(groups)) {
    const saved = measureGroups.map((group) => group.tupletMark);
    if (addTuplets(measureGroups)) continue;
    measureGroups.forEach((group, index) => {
      group.tupletMark = saved[index];
    });
  }
  return groups;
}
