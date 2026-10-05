// T55: a deleted session thread moves its open cards to the parent channel (G17), an old line is retired when a session gets a new
// one, and the hook reads a --project word of quoted and bare pieces as the shell does (F-T55-1). Through the fake Discord layer, a
// scratch sage logbook and a scratch spool. SAMPLE DATA ONLY: every id is made up.
process.env.TZ = 'UTC'; // the title of a thread has the host's date: 2026-10-04 is a Sunday in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectOf, record } from '../src/sessions.js';
import { setup } from './bridge-setup.js';

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const spoolDir = (b) => `${b.statePath}.sessions`;
test('F-T55-1: a --project word of quoted and bare pieces is read as /bin/sh reads it; a word with another $, a backtick or a command is ignored', () => {
  const b = setup();
  const home = join(b.root, 'home dir');
  const project = join(home, 'x y');
  mkdirSync(project, { recursive: true });
  // Through the hook first: the gate is recorded when the word names the project, also with mixed quotes.
  const post = (command, gate) => record(
    { session_id: S1, cwd: project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: `${gate} open · Q?\n`, stderr: '' } },
    { project, dir: spoolDir(b), pid: process.pid, now: b.now, home });
  assert.deepEqual([
    post(`node sage.mjs gate add T1 --project "$HOME"/'x y' --question "Q?"`, 'G1'),
    post(`node sage.mjs gate add T2 --project ~/'x y'`, 'G2'),
    post(`node sage.mjs gate add T3 --project "\${HOME}/x y"`, 'G3'),
    post(`node sage.mjs gate add T4 --project "$HOME"/x`, 'G4'),
    post(`node sage.mjs gate add T5 --project "$(pwd)"`, 'G5'),
  ], [`PostToolUse ${S1}`, `PostToolUse ${S1}`, `PostToolUse ${S1}`, 'another project', 'a project that only the shell knows']);
  // Each word as /bin/sh gives it, with the same HOME.
  const words = [`"$HOME"/x`, `"$HOME"/'x y'`, `~/'x y'`, `"\${HOME}/x"`, `"$HOME/x y"`, `~`, `~/x`, `'~/x'`, `a"b c"'d'`, `"$HOME"`];
  const shell = (word) => spawnSync('/bin/sh', ['-c', `printf %s ${word}`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }).stdout;
  assert.deepEqual(words.map((w) => projectOf(w, home)), words.map(shell));
  assert.deepEqual([`"$(pwd)"`, '`pwd`', '"$HOME"/$(pwd)', '$PROJECT', '"$HOMEx"', '~root/x', `"x`, '$HOME/x'].map((w) => projectOf(w, home)), Array(8).fill(undefined));
  assert.equal(shell('$HOME/x'), `${join(b.root, 'home')}dir/x`); // the shell splits a bare $HOME with a space into two words
});
