// Makes src/confusables.json, the look-alike extract that the cleaners in src/clean.js read (F-T143-10, F-T143-11).
// Usage: node scripts/confusables.mjs <path to a local copy of confusables.txt>
// Download the file once, by hand, from SOURCE (the pinned version), to a folder outside the repo; this script never downloads.
// The extract holds each source code point whose confusables target, as it is or after NFKC, holds a character of SEEDS, or the
// source of an entry already in the extract (repeated until nothing changes). The target goes in as it is, so that forLead can map
// each angle to a parenthesis. The same file and the same Node give the same bytes.
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'https://www.unicode.org/Public/17.0.0/security/confusables.txt';
const VERSION = '17.0.0';
const SEEDS = ['<', '>', '"', "'", '`'];
const OUT = new URL('../src/confusables.json', import.meta.url);

const [file, ...more] = process.argv.slice(2);
if (!file || more.length) {
  console.error('usage: node scripts/confusables.mjs <path to confusables.txt>');
  process.exit(2);
}
const text = readFileSync(file, 'utf8');
const date = /^# Date: (.+)$/m.exec(text)?.[1];
const version = /^# Version: (.+)$/m.exec(text)?.[1];
if (version !== VERSION || !date) {
  console.error(`${file} is version ${version ?? 'unknown'}, not ${VERSION} from ${SOURCE}. Nothing was written.`);
  process.exit(1);
}

const chars = (hex) => hex.trim().split(/\s+/).map((h) => String.fromCodePoint(parseInt(h, 16))).join('');
const entries = text.split('\n').filter((l) => /^[0-9A-F]/.test(l)).map((l) => {
  const [source, target] = l.split(';');
  return { hex: source.trim(), source: chars(source), target: chars(target), targetHex: target.trim() };
});

const looks = new Set(SEEDS);
const extract = new Map();
for (let grew = true; grew;) {
  grew = false;
  for (const e of entries) {
    if (extract.has(e.hex)) continue;
    if ([...e.target, ...e.target.normalize('NFKC')].some((c) => looks.has(c))) {
      extract.set(e.hex, e.targetHex);
      looks.add(e.source);
      grew = true;
    }
  }
}

const order = [...extract].sort(([a], [b]) => parseInt(a, 16) - parseInt(b, 16));
const json = [
  '{',
  `  "source": ${JSON.stringify(SOURCE)},`,
  `  "version": ${JSON.stringify(VERSION)},`,
  `  "date": ${JSON.stringify(date)},`,
  '  "licence": "Unicode License v3, https://www.unicode.org/license.txt. Extract of the Unicode data file above; © Unicode, Inc.",',
  '  "made by": "node scripts/confusables.mjs <confusables.txt>",',
  `  "rule": ${JSON.stringify(`each source whose target, as it is or after NFKC, holds one of ${SEEDS.join(' ')} or a source of this list`)},`,
  '  "extract": {',
  order.map(([hex, target]) => `    "U+${hex}": "${target}"`).join(',\n'),
  '  }',
  '}',
  '',
].join('\n');
writeFileSync(OUT, json);
console.log(`wrote ${order.length} code points to src/confusables.json`);
