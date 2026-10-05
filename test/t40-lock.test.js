// T40: the bridge's lock survives a stop by a signal, a reboot that gives its pid to another process, and starts in the same millisecond.
// Each bridge here is a child process that takes the lock with src/state.js lock(), as scripts/bridge.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = new URL('../src/state.js', import.meta.url).href;
const gatesIn = (dir) => join(mkdtempSync(join(tmpdir(), `sage-bot-${dir}-`)), 'state', 'gates.json');
/** A start time that no process of this boot has. */
const OLD_START = 'Thu Jan  1 00:00:00 1970';

/** A bridge that takes the lock at `at` (ms, or now), prints "won" or the refusal, and runs until its stdin closes. */
function bridge(path, at = 0) {
  const code = `import { lock } from '${state}';
    while (Date.now() < ${at}); // the same millisecond for every bridge of a round
    try { lock(${JSON.stringify(path)}); console.log('won'); } catch (e) { console.log('lost: ' + e.message); }
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.said = new Promise((done) => { let out = ''; child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) done(out.trim()); }); });
  child.gone = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  return child;
}
/** Runs `code` in a child after it reads the lock module; gives its stdout, or throws with its stderr. */
const node = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', `import { lock } from '${state}'; ${code}`], { encoding: 'utf8' });

test('T40: a stop by SIGTERM, SIGINT or SIGHUP removes the lock; while the bridge runs, a second start is refused', async () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const path = gatesIn('signal');
    const first = bridge(path);
    assert.equal(await first.said, 'won');
    assert.throws(() => node(`lock(${JSON.stringify(path)});`),
      (e) => e.stderr.includes(`another sage bridge (pid ${first.pid}) runs on ${path}. This one stops: two bridges would post each card twice. If no bridge runs, remove ${path}.lock.`));
    first.kill(signal);
    await first.gone;
    assert.equal(existsSync(`${path}.lock`), false, `the lock stays after ${signal}`);
    assert.equal(node(`lock(${JSON.stringify(path)}); console.log('won');`).trim(), 'won');
  }
});

test('T40: a lock with the pid of this process is its own (a reboot gave the bridge its old pid): the start takes it', () => {
  const path = gatesIn('own');
  // The pid alone (the lock of add8820) and the pid with a start time of an earlier boot.
  for (const held of ['${process.pid}', '${process.pid} ' + OLD_START]) {
    assert.equal(node(`import { writeFileSync, mkdirSync } from 'node:fs'; mkdirSync(${JSON.stringify(join(path, '..'))}, { recursive: true });
      writeFileSync(${JSON.stringify(`${path}.lock`)}, \`${held}\`); lock(${JSON.stringify(path)}); console.log('won');`).trim(), 'won');
  }
});

test('T40: a lock whose pid runs, but in another program than the bridge (pid reuse after a reboot), is replaced', async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); // a live process that is not a bridge
  try {
    const path = gatesIn('reuse');
    mkdirSync(join(path, '..'), { recursive: true });
    // The pid with the start time of the old bridge, and the pid alone from add8820, written before the reboot (an hour ago).
    for (const held of [`${other.pid} ${OLD_START}`, String(other.pid)]) {
      writeFileSync(`${path}.lock`, held);
      const hourAgo = new Date(Date.now() - 3600_000);
      utimesSync(`${path}.lock`, hourAgo, hourAgo);
      assert.equal(node(`lock(${JSON.stringify(path)}); console.log('won');`).trim(), 'won', `refused for the lock "${held}"`);
    }
  } finally { other.kill(); }
});

test('T40: an empty lock (a bridge that just made it) is not replaced within the grace time', () => {
  const path = gatesIn('empty');
  node(`lock(${JSON.stringify(path)});`); // makes the folder; the lock goes at the exit
  writeFileSync(`${path}.lock`, '');
  assert.throws(() => node(`lock(${JSON.stringify(path)});`), (e) => e.stderr.includes(`a sage bridge may still be starting on ${path} (pid unknown). Try again in 10 s, or remove ${path}.lock.`));
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), '');
});

test('T40: 8 bridges that start in the same millisecond give exactly one winner, 50 rounds, with no lock and with a stale lock', async () => {
  const counts = [], lost = [];
  for (let round = 0; round < 50; round++) {
    const path = gatesIn('race');
    if (round % 2) { node(`lock(${JSON.stringify(path)});`); writeFileSync(`${path}.lock`, `${process.pid + 1} ${OLD_START}`); }
    const at = Date.now() + 600;
    const all = Array.from({ length: 8 }, () => bridge(path, at));
    const said = await Promise.all(all.map((c) => c.said));
    for (const c of all) c.stdin.end();
    await Promise.all(all.map((c) => c.gone));
    counts.push(said.filter((s) => s === 'won').length);
    lost.push(...said.filter((s) => s !== 'won'));
  }
  assert.deepEqual(counts, Array(50).fill(1));
  assert.deepEqual(lost.filter((s) => !s.startsWith('lost: another sage bridge (pid ')), []); // each loser says who holds the lock
});
