// Marks sage gates as team votes (G13): the bridge posts only the gates in this list; every other gate stays at the terminal.
//   node scripts/vote.mjs [--config <config.json>] <gate id> [<gate id> ...]   marks gates
//   node scripts/vote.mjs [--config <config.json>] --unmark <gate id> [...]    unmarks gates
//   node scripts/vote.mjs [--config <config.json>] --list                      prints the list
// The config is the bridge's (default ~/.config/sage-bot/config.json); the list is its `votesPath`, or `<statePath>.votes`.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { forTerminal } from '../src/clean.js';
import { alive, GATE_ID, loadVotes, saveVotes, unlock, votesPathOf } from '../src/state.js';

/**
 * Runs `work` while this run holds `<path>.lock`, so that two runs at once never lose a mark (F-T47-1). The lock holds the pid of its
 * run. A lock of a pid that no process has (or of this pid) is stale and replaced; a lock with no pid yet is being written. A live
 * holder has 2 s to finish.
 */
function withLock(path, work) {
  const file = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (const until = Date.now() + 2000; ;) {
    let fd;
    try { fd = openSync(file, 'wx', 0o600); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== undefined) {
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      try { return work(); } finally { rmSync(file, { force: true }); }
    }
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const pid = /^\d+$/.test(text) ? Number(text) : undefined;
    if (pid !== undefined && (pid === process.pid || !alive(pid))) { unlock(file, text); continue; }
    if (Date.now() > until) throw new Error(`another vote run (pid ${pid ?? 'unknown'}) holds ${file}. If none runs, remove ${file}. Nothing changed.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

const USAGE = 'usage: node scripts/vote.mjs [--config <config.json>] <gate id> ... | --unmark <gate id> ... | --list';

try {
  const args = process.argv.slice(2);
  let configPath = join(homedir(), '.config', 'sage-bot', 'config.json');
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  const mode = ['--unmark', '--list'].includes(args[0]) ? args.shift() : '--mark';
  if (!configPath || (mode === '--list') !== (args.length === 0)) throw new Error(USAGE);
  const bad = args.filter((id) => !GATE_ID.test(id));
  if (bad.length) throw new Error(`not a sage gate id (G and digits): ${bad.join(', ')}. Nothing changed.`);
  const path = votesPathOf(JSON.parse(readFileSync(configPath, 'utf8')));
  if (mode !== '--list') {
    withLock(path, () => {
      const votes = loadVotes(path);
      for (const id of args) votes[mode === '--mark' ? 'add' : 'delete'](id);
      saveVotes(path, votes);
    });
  }
  const ids = [...loadVotes(path)];
  console.log(ids.length ? `team votes: ${ids.join(' ')}` : 'team votes: none');
} catch (e) {
  console.error(`sage-bot vote: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
