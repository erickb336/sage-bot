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
  assert.notEqual(readFileSync(join(copy, 'how-dark.svg'), 'utf8'), readFileSync(join(drawn, 'how-dark.svg'), 'utf8'));
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

test('T90: the README shows each graphic in the reader\'s theme, inside a link to its light file, with a short alt text that is the SVG\'s own label', () => {
  // As in sage's README: the <a> line stands alone, because on the same line as <picture> GitHub drops the dark version.
  // The alt text is the graphic's aria-label (F-T90-13): 80 to 170 characters, the main point; the text beside the graphic has the detail.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const drawn = redraw();
  const names = [...new Set(readdirSync(drawn).map((f) => f.replace(/-(light|dark)\.svg$/, '')))];
  const wrong = names.flatMap((name) => {
    const svg = (theme) => `docs/assets/${name}-${theme}\\.svg`;
    const shown = new RegExp(`<a href="${svg('light')}">\\n<picture>\\n\\s*<source media="\\(prefers-color-scheme: dark\\)" srcset="${svg('dark')}">\\n\\s*<img alt="([^"]*)" src="${svg('light')}"[^>]*>\\n</picture>\\n</a>\\n`).exec(readme);
    if (!shown) return [`${name}: not shown as a picture in a link`];
    const labels = ['light', 'dark'].map((theme) => /aria-label="([^"]*)"/.exec(readFileSync(join(drawn, `${name}-${theme}.svg`), 'utf8'))[1]);
    const alt = shown[1];
    return [
      ...labels.filter((l) => l !== alt).map(() => `${name}: the alt text differs from the SVG's aria-label`),
      ...(alt.length < 80 || alt.length > 170 ? [`${name}: the alt text has ${alt.length} characters, not 80 to 170`] : []),
    ];
  });
  assert.deepEqual(wrong, []);
});

/** Each SVG file whose smallest text is under 36 in a graphic 1100 wide, with that size. */
function tooSmall(dir) {
  return readdirSync(dir).flatMap((f) => {
    const svg = readFileSync(join(dir, f), 'utf8');
    const width = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
    const least = Math.min(...[...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1])));
    return (least * 1100) / width < 36 ? [`${f}: ${least} in ${width}`] : [];
  });
}

test('F-T90-9: each text in a graphic is 36 or more in 1100, so about 10.5 px or more where a phone shows it 320 px wide', () => {
  assert.deepEqual(tooSmall(redraw()), []);
  // The check fails for one label of 35 in a copy of a clean redraw.
  const copy = redraw();
  writeFileSync(join(copy, 'roles-dark.svg'), readFileSync(join(copy, 'roles-dark.svg'), 'utf8').replace('font-size="36"', 'font-size="35"'));
  assert.deepEqual(tooSmall(copy), ['roles-dark.svg: 35 in 1100']);
});
