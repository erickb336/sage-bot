// T97: one word for the session that runs the work. People read "sage", never "chief" (the owner's request).
// The check reads every text file that a person reads or that sends text to a person: the README, the docs and diagrams, the
// examples, the design pages, and src/, scripts/ and test/ (string literals, logs and the tests that assert them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLACES = ['README.md', 'docs', 'examples', 'design/b2', 'design/t69', 'src', 'scripts', 'test'];
const TEXT = /\.(md|mjs|js|json|html|svg|txt)$/;
/** The only files that may hold the word: this check, which names it to find it. */
const ALLOWED = new Set(['test/t97-sage-word.test.js']);
const WORD = /\bchief\b/i;

/** Each line of a text file under `places` that holds the word as a word, as "path:line: text". */
function chiefLines(root, places = PLACES) {
  const files = places.map((p) => join(root, p)).filter(existsSync).flatMap((at) => (statSync(at).isFile() ? [at]
    : readdirSync(at, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))));
  return files.map((f) => relative(root, f)).filter((f) => TEXT.test(f) && !ALLOWED.has(f)).flatMap((f) =>
    readFileSync(join(root, f), 'utf8').split('\n').flatMap((line, i) => (WORD.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])));
}

test('T97: no person-read text says "chief"; sage-bot says "sage" for the session that runs the work', () => {
  assert.deepEqual(chiefLines(ROOT), []);
});
