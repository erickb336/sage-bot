// T249: the README's hero graphic. The committed SVGs are what scripts/hero.mjs writes, they scale with the page
// (a viewBox, no width or height), and they hold only drawing elements: no script, no event handler, no external reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hero } from '../scripts/hero.mjs';

const THEMES = ['light', 'dark'];
const committed = (theme) => readFileSync(new URL(`../docs/assets/hero-${theme}.svg`, import.meta.url), 'utf8');
// The elements a hero may use (an allow-list): every other element, such as script, image or foreignObject, is a problem.
const ELEMENTS = new Set(['svg', 'defs', 'linearGradient', 'radialGradient', 'stop', 'filter', 'feDropShadow', 'g', 'rect', 'circle', 'ellipse', 'path', 'text', 'tspan']);

/** The problems of one SVG text: [] when it is safe to show and scales with the page. */
function problems(svg) {
  const out = [];
  const root = /^<svg\b([^>]*)>/.exec(svg)?.[1];
  if (root === undefined) return ['the file does not start with <svg>'];
  if (!/\sviewBox="0 0 \d+ \d+"/.test(root)) out.push('the root has no viewBox');
  if (/\s(width|height)=/.test(root)) out.push('the root has a width or a height');
  for (const [, name] of svg.matchAll(/<\/?([A-Za-z][\w:-]*)/g)) if (!ELEMENTS.has(name)) out.push(`element <${name}>`);
  for (const [attr] of svg.matchAll(/\s(on[a-z]+|[\w:]*href|style)=/gi)) out.push(`attribute ${attr.trim()}`);
  for (const [ref] of svg.matchAll(/url\((?!#)[^)]*\)/g)) out.push(`reference ${ref}`);
  if (svg.replace(' xmlns="http://www.w3.org/2000/svg"', '').includes('://')) out.push('an external address');
  return out;
}

test('T249: the committed hero SVGs equal what node scripts/hero.mjs writes', () => {
  for (const theme of THEMES) assert.equal(committed(theme), hero(theme), `docs/assets/hero-${theme}.svg is stale: run node scripts/hero.mjs`);
});

test('T249: each hero SVG has only a viewBox (no width or height) and no script or external reference', () => {
  for (const theme of THEMES) assert.deepEqual(problems(committed(theme)), [], `docs/assets/hero-${theme}.svg`);
  // The check finds each kind of problem (the check itself).
  assert.deepEqual(problems('<svg width="10" viewBox="0 0 1 1"><script>x</script><image href="https://e.test/a.png"/><rect onclick="x" fill="url(https://e.test/#a)"/></svg>'), [
    'the root has a width or a height', 'element <script>', 'element <script>', 'element <image>',
    'attribute href=', 'attribute onclick=', 'reference url(https://e.test/#a)', 'an external address',
  ]);
});

test('T249: the README shows the hero under its title and pitch, with the dark file for a dark theme', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const picture = readme.indexOf('<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg"><img src="docs/assets/hero-light.svg" alt="');
  assert.ok(picture > readme.indexOf('**sage-bot is'), 'the hero comes after the pitch');
  assert.ok(picture < readme.indexOf('```mermaid'), 'the hero comes before the Mermaid diagram');
});
