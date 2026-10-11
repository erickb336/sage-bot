// T90: the README's graphics in docs/assets are exactly what scripts/graphics.mjs draws, so nobody edits or adds an SVG by hand.
// The test redraws every graphic into a temp folder, as `node scripts/graphics.mjs --out <folder>`, and compares the two folders
// byte for byte. The Discord symbol files in docs/assets/brand/ are Discord's own, unchanged (G77): they are not drawn, so the test
// pins their SHA-256 instead. It also checks how the README shows each graphic, and that each text stays readable on a phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempFolder } from './temp-folder.js';
import { execFileSync } from './bridge-setup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(ROOT, 'docs/assets');

/** Redraws every graphic into a new temp folder with the script, as a person runs it, and returns the folder. */
function redraw() {
  const out = tempFolder('sage-bot-graphics-');
  execFileSync(process.execPath, [join(ROOT, 'scripts/graphics.mjs'), '--out', out], { encoding: 'utf8' });
  return out;
}

/** The files of `assets` (its own files, not its subfolders) that differ from the redrawn folder `drawn`, one line each. */
function differences(assets, drawn) {
  const filesOf = (dir) => readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort();
  const have = filesOf(assets), want = filesOf(drawn);
  return [
    ...want.filter((f) => !have.includes(f)).map((f) => `${f}: missing; run node scripts/graphics.mjs`),
    ...have.filter((f) => !want.includes(f)).map((f) => `${f}: scripts/graphics.mjs does not draw it; draw it there, or delete it`),
    ...have.filter((f) => want.includes(f) && !readFileSync(join(assets, f)).equals(readFileSync(join(drawn, f)))).map((f) => `${f}: differs from scripts/graphics.mjs; run node scripts/graphics.mjs`),
  ];
}

test('T90: every file in docs/assets is what scripts/graphics.mjs draws, and it draws 6 graphics in light and dark', () => {
  const drawn = redraw();
  assert.deepEqual(differences(ASSETS, drawn), []);
  assert.deepEqual(readdirSync(drawn).sort(), ['hero', 'how', 'roles', 'safety', 'threads', 'tip-mention'].flatMap((n) => [`${n}-dark.svg`, `${n}-light.svg`]));
});

test('T90: the comparison fails for an SVG changed by hand, an SVG added by hand and an SVG removed', () => {
  const drawn = redraw();
  const copy = tempFolder('sage-bot-assets-');
  cpSync(drawn, copy, { recursive: true }); // a copy of a clean redraw, so this test does not depend on docs/assets
  writeFileSync(join(copy, 'how-dark.svg'), readFileSync(join(copy, 'how-dark.svg'), 'utf8').replace('LEAD TALK', 'LEAD CHAT'));
  writeFileSync(join(copy, 'extra-light.svg'), '<svg/>');
  rmSync(join(copy, 'roles-light.svg'));
  assert.deepEqual(differences(copy, drawn), [
    'roles-light.svg: missing; run node scripts/graphics.mjs',
    'extra-light.svg: scripts/graphics.mjs does not draw it; draw it there, or delete it',
    'how-dark.svg: differs from scripts/graphics.mjs; run node scripts/graphics.mjs',
  ]);
});

test('G77: the Discord symbol files are Discord\'s own, unchanged, and nothing else is in docs/assets/brand', () => {
  const sha = (f) => createHash('sha256').update(readFileSync(join(ASSETS, 'brand', f))).digest('hex');
  assert.deepEqual(readdirSync(join(ASSETS, 'brand')).sort().map((f) => [f, sha(f)]), [
    ['Discord-Symbol-Blurple.svg', 'd06eaa51e78a9984ebbd3fbc82f0245ac2ecb5bf0150f537204397c1da5c7bd8'],
    ['Discord-Symbol-White.svg', 'de4cc484cdc0e3a8f3a58a84b0c80c5ac8acefeebf730930545ff3b279b5d0a3'],
  ]);
});

test('T90: the README shows each graphic in the reader\'s theme, with alt text, inside a link to its light file', () => {
  // As in sage's README: the <a> line stands alone, because on the same line as <picture> GitHub drops the dark version.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const names = [...new Set(readdirSync(redraw()).map((f) => f.replace(/-(light|dark)\.svg$/, '')))];
  const missing = names.filter((name) => {
    const svg = (theme) => `docs/assets/${name}-${theme}\\.svg`;
    return !new RegExp(`<a href="${svg('light')}">\\n<picture>\\n\\s*<source media="\\(prefers-color-scheme: dark\\)" srcset="${svg('dark')}">\\n\\s*<img alt="[^"]{80,}" src="${svg('light')}"[^>]*>\\n</picture>\\n</a>\\n`).test(readme);
  });
  assert.deepEqual(missing, []);
});

test('T90: each text in a graphic is 7 px or more on a phone, where GitHub shows a graphic 324 px wide', () => {
  const drawn = redraw();
  const small = readdirSync(drawn).flatMap((f) => {
    const svg = readFileSync(join(drawn, f), 'utf8');
    const width = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
    const least = Math.min(...[...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1])));
    return (least * 324) / width < 7 ? [`${f}: ${least} px in ${width}`] : [];
  });
  assert.deepEqual(small, []);
});
