// F-T156-23: the mutation run of the lead policy counts a mutation as killed only when the mutated file parses and a test fails; a test
// file that does not load is no failing test. Each case runs the real test runner on sample test files in a new temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parses, verdictOf } from '../scripts/lead-policy-mutations.mjs';
import { spawnSync } from './bridge-setup.js';

const FILES = ['a.test.js', 'b.test.js'];
const PASS = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const FAIL = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n";
const BROKEN = "import { test } from 'node:test';\nimport './m.js';\ntest('passes', () => {});\n"; // m.js does not parse

/** The verdict of a run of the two sample files a and b, with the given bodies, as the mutation run calls the test runner. */
function verdict(a, b, parses = true) {
  const dir = mkdtempSync(join(tmpdir(), 'sage-bot-t156-mut-'));
  try {
    writeFileSync(join(dir, 'm.js'), 'export const x = (;\n');
    writeFileSync(join(dir, FILES[0]), a);
    writeFileSync(join(dir, FILES[1]), b);
    return verdictOf(spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...FILES], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } }), FILES, parses); // no NODE_TEST_CONTEXT of this run
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('F-T156-23: a failing test kills a mutation; all tests passing is a survivor', () => {
  assert.deepEqual(verdict(PASS, FAIL), { verdict: 'KILLED', failed: 1 });
  assert.deepEqual(verdict(PASS, PASS), { verdict: 'SURVIVED', failed: 0 });
});

test('F-T156-23: a test file that does not load is no failing test: INVALID alone, KILLED only with a failing test of another file', () => {
  assert.deepEqual(verdict(BROKEN, PASS), { verdict: 'INVALID', failed: 0 });
  assert.deepEqual(verdict(BROKEN, FAIL), { verdict: 'KILLED', failed: 1 });
});

test('F-T156-23: a mutated file that does not parse is INVALID, even with failing tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-bot-t156-mut-'));
  try {
    writeFileSync(join(dir, 'good.js'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'bad.js'), 'export const x = (;\n');
    assert.deepEqual([parses(join(dir, 'good.js')), parses(join(dir, 'bad.js'))], [true, false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(verdict(PASS, FAIL, false), { verdict: 'INVALID', failed: 1 });
});

test('F-T156-23: a run that exits non-zero with no failing test (the runner crashed) is INVALID', () => {
  assert.deepEqual(verdictOf({ status: 1, stdout: '' }, FILES, true), { verdict: 'INVALID', failed: 0 });
  assert.deepEqual(verdictOf({ status: null, stdout: 'ok 1 - passes\n' }, FILES, true), { verdict: 'INVALID', failed: 0 });
});
