/**
 * Compare `parseStaffs`' voice assembly against `stage_voices.json`, without a model run.
 *
 *   node scripts/check-voices.mjs [page]
 *
 * `artifacts/browser-reference/<page>/staff_<i>_symbols.json` is the raw decoder output
 * per staff: chord markers, canvas coordinates, no newline. Splicing those in HOMR's
 * order - voice major, systems inside - appending a `newline` per staff and running the
 * result through `removeDuplicatedSymbols` has to give exactly the voices HOMR fed into
 * the MusicXML writer. That covers the staff order, the lower-staff filter, the newline
 * placement and the cleanup rules, none of which the decoder comparison touches.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EncodedSymbol, removeDuplicatedSymbols } from '../src/lib/homr/vocabulary.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const stageDir = path.join(repo, 'artifacts/stage-reference', source);
const browserDir = path.join(repo, 'artifacts/browser-reference', source);

const load = (name) => JSON.parse(fs.readFileSync(path.join(stageDir, name), 'utf8'));
const multiStaffs = load('stage_multiStaffs.json');
const expected = load('stage_voices.json');

/** The dumped token is exactly what the decoder returned, coordinates included. */
function rebuild(entry) {
  return new EncodedSymbol(
    entry.rhythm,
    entry.pitch,
    entry.lift,
    entry.articulation,
    entry.slur,
    entry.position,
    entry.x === null || entry.y === null ? null : { x: entry.x, y: entry.y },
  );
}

const FIELDS = ['rhythm', 'pitch', 'lift', 'articulation', 'slur', 'position'];

function differs(actual, target) {
  for (const field of FIELDS) {
    if (actual[field] !== target[field]) return field;
  }
  if (target.x === null || target.y === null) {
    return actual.coordinates === null ? null : 'coordinates';
  }
  if (actual.coordinates === null) return 'coordinates';
  const tolerance = 1e-4;
  if (Math.abs(actual.coordinates.x - target.x) > tolerance) return 'x';
  if (Math.abs(actual.coordinates.y - target.y) > tolerance) return 'y';
  return null;
}

const describe = (symbol) =>
  `${symbol.rhythm}/${symbol.pitch}/${symbol.lift}/${symbol.articulation}/${symbol.slur}/${symbol.position}` +
  (symbol.coordinates === null
    ? ' @none'
    : ` @(${symbol.coordinates.x.toFixed(4)},${symbol.coordinates.y.toFixed(4)})`);

const describeExpected = (entry) =>
  `${entry.rhythm}/${entry.pitch}/${entry.lift}/${entry.articulation}/${entry.slur}/${entry.position}` +
  (entry.x === null ? ' @none' : ` @(${entry.x.toFixed(4)},${entry.y.toFixed(4)})`);

// Voice major, systems inside: `index = voice * systemCount + system`, the order
// `parse_staffs` walks the staffs in.
const systemCount = multiStaffs.length;
const voiceCount = multiStaffs[0].staffCount;
const started = performance.now();
let failures = 0;
let filtered = 0;

for (let voice = 0; voice < voiceCount; voice += 1) {
  const symbols = [];
  for (let system = 0; system < systemCount; system += 1) {
    const index = voice * systemCount + system;
    const raw = JSON.parse(
      fs.readFileSync(path.join(browserDir, `staff_${index}_symbols.json`), 'utf8'),
    ).map(rebuild);
    // `predict_best`: a staff that is not part of a grand staff has no lower voice.
    const isGrandStaff = multiStaffs[system].staffCount > 1;
    const tokens = isGrandStaff ? raw : raw.filter((symbol) => symbol.position !== 'lower');
    filtered += raw.length - tokens.length;
    if (tokens.length === 0) continue;
    symbols.push(...tokens, new EncodedSymbol('newline'));
  }

  const actual = removeDuplicatedSymbols(symbols);
  const target = expected[voice];
  let mismatched = Math.abs(actual.length - target.length);
  const details = [];
  for (let i = 0; i < Math.min(actual.length, target.length); i += 1) {
    const field = differs(actual[i], target[i]);
    if (field !== null) {
      mismatched += 1;
      if (details.length < 6) {
        details.push(`  #${i} ${field}: homr ${describeExpected(target[i])}`);
        details.push(`  #${i} ${field}: port ${describe(actual[i])}`);
      }
    }
  }

  if (mismatched > 0) failures += 1;
  console.log(
    `voice ${voice}  homr ${String(target.length).padStart(4)} | ` +
      `port ${String(actual.length).padStart(4)} | ` +
      `${mismatched === 0 ? 'IDENTICAL' : `${mismatched} differ`}`,
  );
  for (const line of details) console.log(line);
}

const positions = expected.reduce(
  (sum, voice) => sum + voice.filter((entry) => entry.x !== null).length,
  0,
);
const total = expected.reduce((sum, voice) => sum + voice.length, 0);
console.log(
  `\n${voiceCount} voices, ${total} symbols, ${positions} with a position, ` +
    `${filtered} lower staff tokens dropped (${(performance.now() - started).toFixed(0)} ms)`,
);
console.log(failures === 0 ? 'all voices identical' : `${failures} voice(s) differ`);
if (failures > 0) process.exitCode = 1;
