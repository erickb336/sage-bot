// T47 (F-T47-1): the bridge reads its own files safely against a swapped file, and scripts/vote.mjs is safe against two runs at once.
// SAMPLE DATA: every gate id and file text here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, loadVotes, readOwn } from '../src/state.js';

const VOTE = new URL('../scripts/vote.mjs', import.meta.url).pathname;
const scratch = (name) => mkdtempSync(join(tmpdir(), `sage-bot-t47-${name}-`));
const own = (path, text) => writeFileSync(path, text, { mode: 0o600 });
const REFUSED = (what, path) => `the ${what} ${path} must be a regular file of this user with mode 0600. Nothing was loaded.`;

test('F-T47-1: a link at the gate file or the team votes file is refused, and a file swapped in between the check and the read is never read', async () => {
  const dir = scratch('swap');
  // A link that is there before the read, also one to a 0600 file of this user.
  own(join(dir, 'real.json'), '["G1"]');
  symlinkSync(join(dir, 'real.json'), join(dir, 'gates.json'));
  symlinkSync(join(dir, 'real.json'), join(dir, 'gates.json.votes'));
  assert.throws(() => load(join(dir, 'gates.json')), { message: REFUSED('gate file', join(dir, 'gates.json')) });
  assert.throws(() => loadVotes(join(dir, 'gates.json.votes')), { message: REFUSED('team votes file', join(dir, 'gates.json.votes')) });
  // A link or a 0644 file that comes in between the check and the read, 1,000s of times.
  const path = join(dir, 'gates.json.votes');
  rmSync(path);
  own(path, '["G1"]');
  own(join(dir, 'secret'), '["G666"]');
  chmodSync(join(dir, 'secret'), 0o644);
  // A second process puts, by rename, in turn: the good 0600 file, a link to the 0644 file, and a 0644 copy of it.
  const swapper = spawn(process.execPath, ['-e', `
    const { renameSync, symlinkSync, writeFileSync } = require('node:fs');
    const path = ${JSON.stringify(path)}, tmp = path + '.swap';
    for (const end = Date.now() + 1500; Date.now() < end;) {
      writeFileSync(tmp, '["G1"]', { mode: 0o600 }); renameSync(tmp, path);
      symlinkSync(${JSON.stringify(join(dir, 'secret'))}, tmp); renameSync(tmp, path);
      writeFileSync(tmp, '["G666"]', { mode: 0o644 }); renameSync(tmp, path);
    }`]);
  const ended = new Promise((done) => swapper.on('exit', done));
  await new Promise((r) => setTimeout(r, 100));
  const seen = { good: 0, refused: 0, other: [] };
  for (let i = 0; i < 20000; i++) {
    try {
      const text = readOwn(path, 'team votes file');
      if (text === '["G1"]') seen.good++; else seen.other.push(text);
    } catch (e) {
      if (e.message === REFUSED('team votes file', path)) seen.refused++; else seen.other.push(e.message);
    }
  }
  await ended;
  assert.deepEqual(seen.other.slice(0, 3), []);
  assert.ok(seen.good > 0 && seen.refused > 0, `both outcomes occur: ${JSON.stringify(seen)}`);
});

test('F-T47-1: a folder that group or other users may write is refused without the sticky bit, and accepted with it', () => {
  for (const [mode, ok] of [[0o700, true], [0o755, true], [0o770, false], [0o777, false], [0o1777, true], [0o1770, true]]) {
    const dir = scratch('dir');
    const path = join(dir, 'gates.json.votes');
    own(path, '["G7"]');
    chmodSync(dir, mode);
    try {
      if (ok) assert.deepEqual([...loadVotes(path)], ['G7'], `mode ${mode.toString(8)}`);
      else {
        assert.throws(() => loadVotes(path), {
          message: `the team votes file ${path} is in a folder that other users may write. Make the folder 0700. Nothing was loaded.`,
        }, `mode ${mode.toString(8)}`);
      }
    } finally { chmodSync(dir, 0o700); }
  }
});

/** A config whose team votes file is in a new scratch folder; runs vote.mjs with it. */
function votesSetup(name) {
  const dir = scratch(name);
  const votes = join(dir, 'state', 'gates.json.votes');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ votesPath: votes }));
  const run = (...args) => spawn(process.execPath, [VOTE, '--config', config, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const runSync = (...args) => spawnSync(process.execPath, [VOTE, '--config', config, ...args], { encoding: 'utf8' });
  return { votes, run, runSync };
}

const exited = (child) => new Promise((done) => {
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code) => done({ code, err }));
});

test('F-T47-1: 20 vote.mjs runs at once (10 marks, 10 unmarks of other ids) end with exactly the expected list, over 20 rounds', async () => {
  const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `G${from + i}`);
  const lost = [];
  for (let round = 1; round <= 20; round++) {
    const v = votesSetup('race');
    assert.equal(v.runSync(...ids(1, 10)).status, 0);
    const runs = [...ids(1, 10).map((id) => v.run('--unmark', id)), ...ids(11, 20).map((id) => v.run(id))];
    const results = await Promise.all(runs.map(exited));
    assert.deepEqual(results.filter((r) => r.code !== 0), [], `round ${round}`);
    const list = JSON.parse(readFileSync(v.votes, 'utf8'));
    if (JSON.stringify(list) !== JSON.stringify(ids(11, 20))) lost.push(`round ${round}: ${list.join(' ')}`);
    assert.equal(existsSync(`${v.votes}.lock`), false);
  }
  assert.deepEqual(lost, []);
});

test('F-T47-1: a vote lock of a live run blocks a change for 2 s; a stale lock (a dead pid) is replaced and removed', () => {
  const v = votesSetup('stale');
  mkdirSync(join(v.votes, '..'), { recursive: true, mode: 0o700 });
  own(`${v.votes}.lock`, String(process.pid)); // this test process runs
  const t0 = Date.now();
  const held = v.runSync('G5');
  assert.equal(held.status, 1);
  assert.equal(held.stderr, `sage-bot vote: another vote run (pid ${process.pid}) holds ${v.votes}.lock. If none runs, remove ${v.votes}.lock. Nothing changed.\n`);
  assert.ok(Date.now() - t0 >= 2000);
  assert.equal(existsSync(v.votes), false);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  own(`${v.votes}.lock`, String(dead));
  const r = v.runSync('G5');
  assert.equal(r.stdout, 'team votes: G5\n');
  assert.equal(existsSync(`${v.votes}.lock`), false);
});
