// T40 repair round 1: F-T40-4 (a failed ps must not make a live bridge's lock stale) and F-T40-6 (clear messages, no leftover temp files).
// Each bridge here is a child process that takes the lock with src/state.js lock(), as scripts/bridge.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from './bridge-setup.js';

const state = new URL('../src/state.js', import.meta.url).href;
const gatesIn = (dir) => { const path = join(mkdtempSync(join(tmpdir(), `sage-bot-${dir}-`)), 'state', 'gates.json'); mkdirSync(join(path, '..'), { recursive: true }); return path; };
/** Runs `code` in a child after `before` and the import of lock; gives what it printed: its stdout, or "lost: " and the error. */
const node = (code, before = '') => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `${before}
    const { lock, startOf } = await import('${state}');
    try { ${code} } catch (e) { console.log('lost: ' + e.message); }`], { encoding: 'utf8' });
  assert.equal(r.stderr, '');
  return r.stdout.trim();
};
/** A pid that no process has: the pid of a child that ended. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const take = (path) => `lock(${JSON.stringify(path)}); console.log('won');`;

test('F-T40-4: when ps fails for the holder (EAGAIN), the start is refused and the live holder keeps its lock', () => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    const path = gatesIn('psfail');
    const held = `${holder.pid} ${execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(holder.pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' } }).trim()}`;
    writeFileSync(`${path}.lock`, held);
    // ps fails for the holder only, as spawnSync fails when the system has no free process slot.
    const failPs = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
      const real = cp.execFileSync;
      cp.execFileSync = (file, args, o) => { if (args.includes('${holder.pid}')) throw Object.assign(new Error('spawnSync /bin/ps EAGAIN'), { code: 'EAGAIN' }); return real(file, args, o); };
      syncBuiltinESMExports();`;
    assert.equal(node(take(path), failPs),
      `lost: could not check whether the bridge with pid ${holder.pid} still runs: spawnSync /bin/ps EAGAIN. Nothing was started.`);
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), held);
    // A real ps for a pid that no process has: no start time, so the lock of that pid is stale and replaced.
    const dead = deadPid();
    assert.equal(node(`console.log(JSON.stringify(startOf(${dead})));`), '""');
    writeFileSync(`${path}.lock`, `${dead} Thu Jan  1 00:00:00 1970`);
    assert.equal(node(take(path)), 'won');
  } finally { holder.kill(); }
});

test('F-T40-6: a fresh lock with a pid only (or empty) says the bridge may still be starting, not that it runs', () => {
  const path = gatesIn('starting');
  const dead = deadPid();
  writeFileSync(`${path}.lock`, String(dead));
  assert.equal(node(take(path)),
    `lost: a sage bridge may still be starting on ${path} (pid ${dead}). Try again in 10 s, or remove ${path}.lock.`);
  writeFileSync(`${path}.lock`, '');
  assert.equal(node(take(path)),
    `lost: a sage bridge may still be starting on ${path} (pid unknown). Try again in 10 s, or remove ${path}.lock.`);
});

test('F-T40-6: an unreadable lock or a folder at the lock path gives a message that names the path and what to do', () => {
  const path = gatesIn('unreadable');
  writeFileSync(`${path}.lock`, '1 x');
  chmodSync(`${path}.lock`, 0o000);
  assert.equal(node(take(path)),
    `lost: the bridge cannot read ${path}.lock (EACCES). If no bridge runs, remove ${path}.lock. Nothing was started.`);
  const other = gatesIn('folder');
  mkdirSync(`${other}.lock`);
  assert.equal(node(take(other)),
    `lost: the bridge cannot read ${other}.lock (EISDIR). If no bridge runs, remove ${other}.lock. Nothing was started.`);
});

test('F-T40-6: a fresh break file names itself and says that it clears itself after 10 s', () => {
  const path = gatesIn('break');
  writeFileSync(`${path}.lock`, `${deadPid()} Thu Jan  1 00:00:00 1970`);
  writeFileSync(`${path}.lock.break`, '');
  assert.equal(node(take(path)),
    `lost: the bridge could not take the lock ${path}.lock: another start holds ${path}.lock.break. That file clears itself after 10 s: try again then. Nothing was started.`);
});

test('F-T40-6: taking the lock removes the temp files of crashed starts, and keeps the temp file of a start that runs', () => {
  const path = gatesIn('tmp');
  const dead = deadPid();
  writeFileSync(`${path}.lock.${dead}.tmp`, `${dead} x`);
  writeFileSync(`${path}.lock.${process.pid}.tmp`, `${process.pid} x`);
  assert.equal(node(take(path)), 'won');
  assert.equal(existsSync(`${path}.lock.${dead}.tmp`), false);
  assert.equal(existsSync(`${path}.lock.${process.pid}.tmp`), true);
});
