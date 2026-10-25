/**
 * Compare the MusicXML writer against HOMR's own output.
 *
 *   node scripts/check-musicxml.mjs [page]
 *
 * The writer takes the recognised voices, so the reference `stage_voices.json` is fed
 * straight in: a mismatch points at the writer, not at the transformer or the geometry.
 * The reference score was produced with `homr ... --guess-meter-per-section`, so the same
 * argument is passed here.
 *
 * The title is the one difference the comparison allows: HOMR reads it off the page with
 * an OCR pass, the browser demo uses the file name. The reference title is therefore read
 * back from the reference score instead of being passed as the demo would.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateMusicXmlString } from '../src/lib/homr/musicXmlGenerator.ts';
import { EncodedSymbol } from '../src/lib/homr/vocabulary.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const source = process.argv[2] ?? '永远同在1';
const refDir = path.join(repo, 'artifacts/stage-reference', source);

/** The reference stores `null` for symbols the decoder gave no position. */
function loadSymbol(entry) {
  const coordinates = entry.x === null || entry.y === null ? null : { x: entry.x, y: entry.y };
  return new EncodedSymbol(
    entry.rhythm,
    entry.pitch,
    entry.lift,
    entry.articulation,
    entry.slur,
    entry.position,
    coordinates,
  );
}

const voices = JSON.parse(fs.readFileSync(path.join(refDir, 'stage_voices.json'), 'utf8')).map(
  (voice) => voice.map(loadSymbol),
);
const expectedText = fs.readFileSync(path.join(refDir, `${source}.musicxml`), 'utf8');
const title = /<work-title>(.*)<\/work-title>/.exec(expectedText)?.[1] ?? source;

const started = performance.now();
const actualText = generateMusicXmlString(voices, title, { guessMeterPerSection: true });
const elapsed = performance.now() - started;

const expectedLines = expectedText.split('\n');
const actualLines = actualText.split('\n');
const total = Math.max(expectedLines.length, actualLines.length);
const details = [];
let mismatched = 0;
for (let i = 0; i < total; i += 1) {
  const want = expectedLines[i];
  const got = actualLines[i];
  if (want === got) continue;
  mismatched += 1;
  if (details.length < 24) {
    details.push(`  line ${i + 1}`);
    details.push(`  homr ${want === undefined ? '<end of file>' : want.trim()}`);
    details.push(`  port ${got === undefined ? '<end of file>' : got.trim()}`);
  }
}

const symbols = voices.reduce((sum, voice) => sum + voice.length, 0);
const parts = voices.length;
const measures = (actualText.match(/<measure /g) ?? []).length;
console.log(
  `musicxml ${String(expectedLines.length).padStart(5)} lines | ` +
    `port ${String(actualLines.length).padStart(5)} lines | ` +
    `${parts} voices, ${symbols} symbols, ${measures} measures | ` +
    `${mismatched === 0 ? 'IDENTICAL' : `${mismatched} lines differ`}`,
);
for (const line of details) console.log(line);

console.log(
  `\n${mismatched === 0 ? 'musicxml identical' : 'musicxml differs'} ` +
    `(${elapsed.toFixed(0)} ms)`,
);
if (mismatched > 0) process.exitCode = 1;
