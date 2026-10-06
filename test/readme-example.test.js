// F-T1-40: the README's example is examples/vote-example.mjs word for word, and it runs with this output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from './bridge-setup.js';

const file = new URL('../examples/vote-example.mjs', import.meta.url);

test('F-T1-40: the README example is the examples/ file and prints the documented effects', () => {
  const readme = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('```js\n' + readFileSync(file, 'utf8') + '```'), 'README must hold examples/vote-example.mjs in a js code block');
  const out = execFileSync(process.execPath, [file.pathname], { encoding: 'utf8' });
  assert.equal(out, [
    '{"type":"vote-ended","by":null}',
    '{"type":"decided","part":0,"option":"x","how":"votes"}',
    '{"type":"decided","part":1,"option":"q","how":"lead-tiebreak"}',
    '{"type":"closed","outcome":{"status":"decided"}}',
    'closed {"status":"decided"}',
    '',
  ].join('\n'));
  assert.ok(readme.includes(out.trimEnd()), 'README must show the example output');
});
