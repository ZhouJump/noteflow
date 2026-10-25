/**
 * HOMR's `transformer/vocabulary.py`: the six token alphabets, the `EncodedSymbol` the
 * decoder produces, and the clean-up that runs before the MusicXML writer sees a voice.
 *
 * The token ids matter as much as the names: the ONNX decoder emits ids, so the tables
 * are built in exactly the order `build_dict` builds them in Python. That order is
 * verified against the reference `vocab.json` (see `scripts/check-voices.mjs`), which
 * makes importing a vocabulary file unnecessary.
 */

import { Fraction, sortedFractions } from './fraction.ts';

export const NONOTE = '.';
/** Decorations of a note that has none. */
export const EMPTY = '_';

export type TokenTable = Map<string, number>;

function buildDict(tokens: string[]): TokenTable {
  const result: TokenTable = new Map();
  for (const token of tokens) {
    if (result.has(token)) throw new Error(`Duplicated vocabulary entry for ${token}`);
    result.set(token, result.size);
  }
  return result;
}

function buildRhythm(): TokenTable {
  const rhythm: string[] = [];
  rhythm.push('PAD', 'BOS', 'EOS');
  rhythm.push('chord');
  rhythm.push('barline', 'doublebarline', 'bolddoublebarline');
  rhythm.push('repeatStart', 'repeatEnd', 'repeatEndStart');
  rhythm.push('voltaStart', 'voltaStop', 'voltaDiscontinue');
  for (let c = 3; c < 6; c += 1) rhythm.push(`clef_F${c}`);
  for (let c = 1; c < 6; c += 1) rhythm.push(`clef_C${c}`);
  for (let c = 1; c < 3; c += 1) rhythm.push(`clef_G${c}`);
  for (let c = -7; c < 8; c += 1) rhythm.push(`keySignature_${c}`);
  for (const c of [1, 2, 3, 4, 6, 8, 12, 16, 32, 48]) rhythm.push(`timeSignature/${c}`);
  for (let c = 2; c < 11; c += 1) rhythm.push(`rest_${c}m`);

  // Kern durations, https://www.humdrum.org/rep/kern/; itertools.product order.
  const kernBaseDurations = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 32, 64, 128];
  const dots = ['', '.', '..'];
  const grace = ['', 'G'];
  const kernValues: string[] = [];
  for (const base of kernBaseDurations) {
    for (const graceValue of grace) {
      for (const dot of dots) kernValues.push(`${base}${graceValue}${dot}`);
    }
  }
  const irregularDurations = [7, 11, 13, 18, 20, 21, 22, 24, 26, 28, 30, 34, 36, 40, 48, 56, 96];
  for (const duration of kernValues) rhythm.push(`note_${duration}`);
  for (const duration of irregularDurations) rhythm.push(`note_${duration}`);
  for (const duration of kernValues) rhythm.push(`rest_${duration}`);
  for (const duration of irregularDurations) rhythm.push(`rest_${duration}`);
  return buildDict(rhythm);
}

function buildLift(): TokenTable {
  return buildDict([NONOTE, EMPTY, '#', '##', 'N', 'b', 'bb']);
}

function buildPosition(): TokenTable {
  return buildDict([NONOTE, 'upper', 'lower']);
}

function buildArticulation(): TokenTable {
  const articulations = [
    'accent',
    'accent_arpeggiate',
    'accent_arpeggiate_fermata',
    'accent_arpeggiate_staccato',
    'accent_arpeggiate_tenuto',
    'accent_breathMark',
    'accent_breathMark_fermata',
    'accent_fermata',
    'accent_fermata_staccato',
    'accent_staccatissimo',
    'accent_staccato',
    'accent_staccato_tenuto',
    'accent_tenuto',
    'accent_tremolo',
    'accent_trill',
    'accent_fermata_trill',
    'arpeggiate',
    'arpeggiate_breathMark_fermata',
    'arpeggiate_fermata',
    'arpeggiate_fermata_staccato',
    'arpeggiate_staccatissimo',
    'arpeggiate_staccato',
    'arpeggiate_staccato_tenuto',
    'arpeggiate_tenuto',
    'arpeggiate_tremolo',
    'arpeggiate_trill',
    'breathMark',
    'breathMark_fermata',
    'breathMark_fermata_tenuto',
    'breathMark_staccato',
    'breathMark_tenuto',
    'breathMark_trill',
    'breathMark_tremolo',
    'breathMark_staccato_tenuto',
    'fermata',
    'fermata_staccato',
    'fermata_staccato_tenuto',
    'fermata_tenuto',
    'fermata_tremolo',
    'fermata_trill',
    'fermata_turn',
    'spiccato',
    'staccatissimo',
    'staccato',
    'staccato_tenuto',
    'staccato_tremolo',
    'staccato_trill',
    'staccato_turn',
    'tenuto',
    'tremolo',
    'trill',
    'turn',
  ];
  return buildDict([NONOTE, EMPTY, ...articulations]);
}

function buildSlur(): TokenTable {
  return buildDict([NONOTE, EMPTY, 'slurStart_slurStop', 'slurStart', 'slurStop']);
}

function buildPitch(): TokenTable {
  const pitch: string[] = [NONOTE, EMPTY];
  const noteNames = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const names: string[] = [];
  for (let octave = 0; octave < 10; octave += 1) {
    for (const name of noteNames) names.push(`${name}${octave}`);
  }
  // `reversed(...)`: the table starts at B9 and ends at C0.
  pitch.push(...names.reverse());
  return buildDict(pitch);
}

export class Vocabulary {
  readonly rhythm = buildRhythm();
  readonly lift = buildLift();
  readonly articulation = buildArticulation();
  readonly pitch = buildPitch();
  readonly slur = buildSlur();
  readonly position = buildPosition();

  /** `{id: token}` for one head, the direction the decoder needs. */
  static inverse(table: TokenTable): string[] {
    const result: string[] = [];
    for (const [token, id] of table) result[id] = token;
    return result;
  }
}

export function hasRhythmSymbolAPosition(rhythm: string): boolean {
  return rhythm.startsWith('note') || rhythm.startsWith('rest') || rhythm.startsWith('clef');
}

/**
 * The value of one note, in the three forms the writer needs: the exact fraction of a
 * whole note, the kern base duration (the `XMLType` name), and the tuplet ratio.
 */
export class SymbolDuration {
  readonly baseDuration: Fraction;
  readonly dots: number;
  readonly actualNotes: number;
  readonly normalNotes: number;
  readonly kern: number;
  readonly fraction: Fraction;

  constructor(
    baseDuration: Fraction,
    dots: number,
    actualNotes: number,
    normalNotes: number,
    kern: number,
  ) {
    this.baseDuration = baseDuration;
    this.dots = dots;
    // Python reduces Fraction(actual, normal) and keeps numerator/denominator.
    const ratio = new Fraction(actualNotes, normalNotes);
    this.actualNotes = Number(ratio.numerator);
    this.normalNotes = Number(ratio.denominator);

    let duration = baseDuration;
    let add = duration.div(2);
    for (let i = 0; i < dots; i += 1) {
      duration = duration.add(add);
      add = add.div(2);
    }
    if (this.actualNotes !== this.normalNotes) {
      duration = duration.mul(new Fraction(this.normalNotes, this.actualNotes));
    }
    this.fraction = duration;
    this.kern = kern;
  }
}

/** The next power of two <= n. */
export function priorPowerOfTwo(n: number): number {
  if (n < 1) return 1;
  let power = 1;
  while (power * 2 <= n) power *= 2;
  return power;
}

/** `kern_to_symbol_duration`: parse a Humdrum `**kern` duration string. */
export function kernToSymbolDuration(kern: string): SymbolDuration {
  // HOMR's multirest branch builds a duration and then falls through to the numeric
  // parse below (`rest_2m` therefore lasts a half note). The fall-through is kept:
  // the writer measures bars with it, so changing it would change the meters.
  let digits = 0;
  while (digits < kern.length && kern[digits] >= '0' && kern[digits] <= '9') digits += 1;
  const baseString = kern.slice(0, digits);
  const rest = kern.slice(digits);
  const base = baseString === '' ? 4 : Number.parseInt(baseString, 10);
  const dots = rest.split('.').length - 1;

  if (kern.includes('G')) {
    return new SymbolDuration(Fraction.ZERO, dots, 1, 1, base);
  }
  if (base === 0) {
    return new SymbolDuration(Fraction.ONE, dots, 1, 1, base);
  }
  if ((base & (base - 1)) === 0) {
    return new SymbolDuration(new Fraction(1, base), dots, 1, 1, base);
  }
  const normalNotes = priorPowerOfTwo(base);
  return new SymbolDuration(new Fraction(1, normalNotes), dots, base, normalNotes, normalNotes);
}

export interface Point2D {
  x: number;
  y: number;
}

/**
 * `EncodedSymbol`: one musical symbol split into the decoder's six branches.
 *
 * `coordinates` is the decoder's `attention` output, a point in `model-input` space
 * (the 1280x256 staff canvas) and, as the fork's docstring says, only as precise as the
 * model's localisation; it is never used to decide the music.
 */
export class EncodedSymbol {
  rhythm: string;
  pitch: string;
  lift: string;
  articulation: string;
  slur: string;
  position: string;
  coordinates: Point2D | null;
  private duration: SymbolDuration | null = null;

  constructor(
    rhythm: string,
    pitch: string = NONOTE,
    lift: string = NONOTE,
    articulation: string = NONOTE,
    slur: string = NONOTE,
    position: string = NONOTE,
    coordinates: Point2D | null = null,
  ) {
    this.rhythm = rhythm;
    this.pitch = pitch;
    this.lift = lift;
    this.articulation = articulation;
    this.slur = slur;
    this.position = position;
    this.coordinates = coordinates;
  }

  copy(): EncodedSymbol {
    const result = new EncodedSymbol(
      this.rhythm,
      this.pitch,
      this.lift,
      this.articulation,
      this.slur,
      this.position,
      this.coordinates,
    );
    result.duration = this.duration;
    return result;
  }

  isControlSymbol(): boolean {
    return this.rhythm === 'BOS' || this.rhythm === 'EOS' || this.rhythm === 'PAD';
  }

  isTuplet(): boolean {
    return this.removeTuplet().rhythm !== this.rhythm;
  }

  removeTuplet(): EncodedSymbol {
    const match = /^(note|rest)_(\d+)(.*)$/.exec(this.rhythm);
    if (!match) return this;
    let duration = Number.parseInt(match[2], 10);
    if (duration % 3 === 0) duration = (duration / 3) * 2;
    else if (duration % 5 === 0) duration = (duration / 5) * 4;
    else if (duration % 7 === 0) duration = (duration / 7) * 4;
    else return this;
    const result = this.copy();
    result.rhythm = `${match[1]}_${duration}${match[3]}`;
    result.duration = null;
    return result;
  }

  changeLift(lift: string): EncodedSymbol {
    const result = this.copy();
    result.lift = lift;
    return result;
  }

  toUpperPosition(): EncodedSymbol {
    if (this.position !== 'lower') return this;
    const result = this.copy();
    result.position = 'upper';
    return result;
  }

  getDuration(): SymbolDuration {
    if (this.duration !== null) return this.duration;
    if (!this.rhythm.startsWith('note') && !this.rhythm.startsWith('rest')) {
      const fallback = new SymbolDuration(Fraction.ZERO, 0, 1, 1, 1);
      return fallback;
    }
    const kern = this.rhythm.split('_')[1];
    const duration = kernToSymbolDuration(kern);
    this.duration = duration;
    return duration;
  }

  /** Overrides the value without touching the token, used by measure rests. */
  setDuration(duration: SymbolDuration): void {
    this.duration = duration;
  }

  toString(): string {
    return [this.rhythm, this.pitch, this.lift, this.articulation, this.slur, this.position].join(
      ' ',
    );
  }
}

export function symbolsEqual(a: EncodedSymbol, b: EncodedSymbol): boolean {
  return a.toString() === b.toString();
}

/** `sorted(chord)`: `__lt__` compares the string forms in descending order. */
export function sortedChord(chord: EncodedSymbol[]): EncodedSymbol[] {
  return [...chord].sort((a, b) => {
    const left = a.toString();
    const right = b.toString();
    if (left > right) return -1;
    if (left < right) return 1;
    return 0;
  });
}

export function sortTokenChords(
  symbols: EncodedSymbol[],
  keepChordSymbol = false,
): EncodedSymbol[][] {
  const chords: EncodedSymbol[][] = [];
  let isInChord = false;
  for (const symbol of symbols) {
    if (symbol.rhythm === 'chord') {
      isInChord = true;
    } else if (isInChord && chords.length > 0) {
      if (keepChordSymbol) chords[chords.length - 1].push(new EncodedSymbol('chord'));
      chords[chords.length - 1].push(symbol);
      isInChord = false;
    } else {
      chords.push([symbol]);
    }
  }
  return chords.map((chord) => sortedChord(chord));
}

function groupIntoChords(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  const chords: EncodedSymbol[][] = [];
  let isInChord = false;
  for (const symbol of symbols) {
    if (symbol.rhythm === 'chord') {
      isInChord = true;
    } else if (isInChord && chords.length > 0) {
      chords[chords.length - 1].push(symbol);
      isInChord = false;
    } else {
      chords.push([symbol]);
    }
  }
  return chords;
}

function flattenChords(chords: EncodedSymbol[][]): EncodedSymbol[] {
  const result: EncodedSymbol[] = [];
  for (const chord of chords) {
    let isInChord = false;
    for (const symbol of chord) {
      if (isInChord) result.push(new EncodedSymbol('chord'));
      result.push(symbol);
      isInChord = true;
    }
  }
  return result;
}

function groupIntoMeasures(chords: EncodedSymbol[][]): EncodedSymbol[][][] {
  const measures: EncodedSymbol[][][] = [];
  let currentMeasure: EncodedSymbol[][] = [];
  for (const chord of chords) {
    currentMeasure.push(chord);
    if (chord.length > 0 && (chord[0].rhythm.includes('barline') || chord[0].rhythm.includes('repeat'))) {
      measures.push(currentMeasure);
      currentMeasure = [];
    }
  }
  if (currentMeasure.length > 0) measures.push(currentMeasure);
  return measures;
}

function flattenMeasures(measures: EncodedSymbol[][][]): EncodedSymbol[][] {
  return measures.flat();
}

function getDurationOfMeasure(measure: EncodedSymbol[][]): Fraction {
  let total = Fraction.ZERO;
  for (const chord of measure) {
    let duration = Fraction.ZERO;
    for (const symbol of chord) {
      if (!symbol.rhythm.startsWith('note') && !symbol.rhythm.startsWith('rest')) continue;
      const fraction = symbol.getDuration().fraction;
      const shorter = fraction.compare(duration) < 0;
      if (fraction.compare(0) > 0 && (shorter || duration.isZero())) duration = fraction;
    }
    total = total.add(duration);
  }
  return total;
}

function getTypicalDurationOfMeasures(measures: EncodedSymbol[][][]): Fraction {
  const durations = measures.map(getDurationOfMeasure);
  if (durations.length === 0) return Fraction.ZERO;
  return sortedFractions(durations)[Math.floor(durations.length / 2)];
}

function removeTuplets(measure: EncodedSymbol[][]): EncodedSymbol[][] {
  return measure.map((chord) => chord.map((symbol) => symbol.removeTuplet()));
}

/**
 * The transformer adds too many tuplets, so bars shorter than the typical one lose
 * theirs.
 */
function fixOverEagerTuplets(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  const measures = groupIntoMeasures(chords);
  const mean = getTypicalDurationOfMeasures(measures);
  const result: EncodedSymbol[][][] = [];
  for (const measure of measures) {
    result.push(getDurationOfMeasure(measure).compare(mean) < 0 ? removeTuplets(measure) : measure);
  }
  return flattenMeasures(result);
}

function onlyKeepLowerStaffIfThereIsAClef(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  let hasLowerClef = false;
  const allResults: EncodedSymbol[][] = [];
  for (let i = 0; i < chords.length; i += 1) {
    const result: EncodedSymbol[] = [];
    for (const symbol of chords[i]) {
      if (hasLowerClef) {
        result.push(symbol);
      } else if (i < 5 && symbol.rhythm.startsWith('clef') && symbol.position === 'lower') {
        hasLowerClef = true;
        result.push(symbol);
      } else {
        result.push(symbol.toUpperPosition());
      }
    }
    allResults.push(result);
  }
  return allResults;
}

function removeDuplicatedPitches(chord: EncodedSymbol[]): EncodedSymbol[] {
  if (chord.length <= 1 || (!chord[0].rhythm.startsWith('note') && !chord[0].rhythm.startsWith('rest'))) {
    return chord;
  }
  const byPitch = new Map<string, EncodedSymbol>();
  const orderOfAppearance: string[] = [];
  for (const symbol of chord) {
    const key = `${symbol.pitch} ${symbol.position}`;
    const existing = byPitch.get(key);
    if (existing !== undefined) {
      if (symbol.getDuration().fraction.compare(existing.getDuration().fraction) > 0) {
        // HOMR stores the symbol under the bare pitch here, so the key it was found
        // under keeps the shorter note. Kept as it is: the output would change.
        byPitch.set(symbol.pitch, symbol);
      }
    } else {
      byPitch.set(key, symbol);
      orderOfAppearance.push(key);
    }
  }
  return orderOfAppearance.map((key) => byPitch.get(key) as EncodedSymbol);
}

function removeRedundantClefsKeysAndTimeSignatures(
  chords: EncodedSymbol[][],
): EncodedSymbol[][] {
  let clefUpper = '';
  let clefLower = '';
  let key = '';
  let time = '';
  const resultChords: EncodedSymbol[][] = [];
  for (const chord of chords) {
    const result: EncodedSymbol[] = [];
    for (const symbol of chord) {
      if (symbol.rhythm.startsWith('clef')) {
        if (symbol.position === 'upper') {
          if (symbol.rhythm !== clefUpper) {
            clefUpper = symbol.rhythm;
            result.push(symbol);
          }
        } else if (symbol.rhythm !== clefLower) {
          clefLower = symbol.rhythm;
          result.push(symbol);
        }
      } else if (symbol.rhythm.startsWith('keySignature')) {
        if (symbol.rhythm !== key) {
          key = symbol.rhythm;
          result.push(symbol);
        }
      } else if (symbol.rhythm.startsWith('timeSignature')) {
        if (symbol.rhythm !== time) {
          time = symbol.rhythm;
          result.push(symbol);
        }
      } else {
        result.push(symbol);
      }
    }
    resultChords.push(result);
  }
  return resultChords;
}

/** `remove_duplicated_symbols`: the clean-up each voice gets before the writer. */
export function removeDuplicatedSymbols(
  symbols: EncodedSymbol[],
  cleanupTuplets = true,
): EncodedSymbol[] {
  let chords = groupIntoChords(symbols);
  if (cleanupTuplets) {
    chords = fixOverEagerTuplets(chords);
    chords = onlyKeepLowerStaffIfThereIsAClef(chords);
  }
  chords = chords.map(removeDuplicatedPitches);
  chords = removeRedundantClefsKeysAndTimeSignatures(chords);
  return flattenChords(chords);
}
