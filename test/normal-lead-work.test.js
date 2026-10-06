// T133 (G64 A): the normal work of a lead session, test/normal-lead-work.json, through the real guard hook.
// Each entry goes to scripts/guard.mjs as a child process with SAGE_ORIGIN=lead, as Claude Code gives it. An "allow" entry
// must be allowed. A "hint" entry must be refused with a hint ("sage can do this instead: ...") whose text names the form of
// the entry it leads to, and that entry must be an "allow" entry (or T158: the broker tools, which T158 adds).
// SAMPLE DATA ONLY: the paths do not exist, and nothing runs; the commands are only text.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));
const { entries } = JSON.parse(readFileSync(new URL('./normal-lead-work.json', import.meta.url), 'utf8'));
const byId = new Map(entries.map((e) => [e.id, e]));
const ENV = { PATH: process.env.PATH, SAGE_ORIGIN: 'lead', SAGE_TOOL: '/sample/plugin/state.mjs' };
const HINT = 'sage can do this instead: ';
const base = mkdtempSync(join(tmpdir(), 'sage-bot-normal-'));
after(() => rmSync(base, { recursive: true, force: true }));

/** The hook's answer to one entry: 'allow', or the refusal text. The stdin comes from a file (see test/guard.test.js). */
function hook({ id, tool_name, tool_input }) {
  const path = join(base, id);
  writeFileSync(path, JSON.stringify({ session_id: 'aaaaaaaa-0000-4000-8000-000000000133', hook_event_name: 'PreToolUse', cwd: '/sample/scratch/wt', tool_name, tool_input }));
  const fd = openSync(path, 'r');
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK], { stdio: [fd, 'pipe', 'pipe'], env: ENV, timeout: 20_000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', fail);
    child.on('close', (code) => {
      closeSync(fd);
      if (code !== 0) return done(`exit ${code}: ${err}`);
      done(out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : 'allow');
    });
  });
}

/** Runs the hook for every entry, a few at a time. */
async function answers() {
  const result = new Map();
  const queue = [...entries];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let e = queue.shift(); e; e = queue.shift()) result.set(e.id, await hook(e));
  }));
  return result;
}

// A form in a hint, as a pattern for the call of its target: a <placeholder> is one word or more.
const form = (names) => new RegExp(names.split(/<[^>]+>/).map((t) => t.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')).join('\\S+'));

test(`G64 A: the normal lead work has 180 to 220 entries (${entries.length}), each id once, each a hint to an allowed entry or to T158`, () => {
  assert.ok(entries.length >= 180 && entries.length <= 220, String(entries.length));
  assert.equal(byId.size, entries.length);
  const bad = entries.filter((e) => e.expect === 'hint').filter((e) => {
    if (e.leads_to === 'T158') return false;
    const target = byId.get(e.leads_to);
    if (target?.expect !== 'allow') return true;
    // The form the hint names fits the target: its command text for Bash, its tool's name for another tool.
    return target.tool_name === 'Bash' ? !form(e.names).test(target.tool_input.command) : !e.names.includes(target.tool_name);
  });
  assert.deepEqual(bad.map((e) => e.id), []);
  assert.deepEqual(entries.filter((e) => !['allow', 'hint'].includes(e.expect)).map((e) => e.id), []);
});

test('G64 A: through the real hook, each normal call is allowed, or refused with a hint that names its allowed form', async () => {
  const got = await answers();
  const wrong = [];
  for (const e of entries) {
    const answer = got.get(e.id);
    if (e.expect === 'allow' && answer !== 'allow') wrong.push([e.id, answer]);
    if (e.expect === 'hint') {
      const k = answer.indexOf(HINT);
      const hint = k < 0 ? '' : answer.slice(k + HINT.length);
      if (!hint.includes(e.names)) wrong.push([e.id, answer]);
    }
  }
  assert.deepEqual(wrong, []);
});
