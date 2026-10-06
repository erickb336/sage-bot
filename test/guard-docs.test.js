// The boundary wording of the docs (T133, standing order 14): a text hook never guarantees a file or network boundary; only
// the sandbox does. So each sentence of README.md and docs/reference.md that names the sandbox, the guard or a text hook and
// makes an absolute claim (a phrase of ABSOLUTE) must carry a requirement id (F-T133-<n>, F-T134-<n>, G<n>) or say "second
// layer". It seals two wording slips in a row (F-T133-67, F-T133-68): "nothing runs outside the sandbox" with no proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOUNDARY = /\b(sandbox|guard)\b|text hook|hook rule/i;
const ABSOLUTE = /\b(runs outside|never reaches|cannot change|cannot run|always|only the sandbox)\b/i;
const PROVED = /\b(F-T13[34]-\d+|G\d+)\b|second layer/i;

/** The boundary sentences of a Markdown text that make an absolute claim with no requirement id. */
const unproved = (text) =>
  text.split(/(?<=[.!?])\s+|\n+|\s\|\s/).filter((s) => BOUNDARY.test(s) && ABSOLUTE.test(s) && !PROVED.test(s));

test('F-T133-68: each absolute boundary sentence of README.md and docs/reference.md names its requirement id or says "second layer"', () => {
  for (const doc of ['README.md', 'docs/reference.md']) assert.deepEqual(unproved(readFileSync(join(ROOT, doc), 'utf8')), [], doc);
});

test('F-T133-68: the scan finds the old README sentence, and its fix only with the id', () => {
  const row = '| The broker | The tools run in the sage-bot process (G57 A). They are not a command, so nothing runs outside the sandbox; the session has no token. |';
  assert.deepEqual(unproved(row), ['They are not a command, so nothing runs outside the sandbox; the session has no token.']);
  assert.deepEqual(unproved('The sandbox always holds the state tool. The sandbox always holds the state tool (F-T134-6). The guard cannot change a file, as a second layer.'), ['The sandbox always holds the state tool.']);
  assert.deepEqual(unproved(row.replace('nothing runs outside the sandbox', 'no command of the session runs outside the sandbox')), ['They are not a command, so no command of the session runs outside the sandbox; the session has no token.']);
  assert.deepEqual(unproved(row.replace('nothing runs outside the sandbox', 'no command of the session runs outside the sandbox (F-T134-16)')), []);
  assert.deepEqual(unproved('The hook reads only the text of a call.'), []);
});
