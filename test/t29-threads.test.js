// T29: one Discord thread per chief session and one line per session in the parent channel. Through the fake Discord layer, a scratch
// sage logbook and a scratch spool; the hook runs as Claude Code runs it, with its JSON on stdin. SAMPLE DATA ONLY: every id is made up.
process.env.TZ = 'UTC'; // the title of a thread has the host's date: 2026-10-04 is a Sunday in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accepts } from '../src/discord.js';
import { readSpools, record } from '../src/sessions.js';
import { load } from '../src/state.js';
import { HOUR, MINUTE, openGate } from '../src/vote.js';
import { CHANNEL, DRIVER, MAYA, OWNER, setup, T0 } from './bridge-setup.js';

const HOOK = new URL('../scripts/hook.mjs', import.meta.url).pathname;
const SESSION = new URL('../scripts/session.mjs', import.meta.url).pathname;
const [S1, S2, S3] = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
/** The pid of a process that ran and is gone. */
const DEAD = spawnSync(process.execPath, ['-e', '']).pid;
const spoolDir = (b) => `${b.statePath}.sessions`;

/** One hook event, recorded in-process as scripts/hook.mjs records it, with this test process as the Claude Code process. */
function hook(b, id, event, extra = {}, pid = process.pid) {
  return record({ session_id: id, cwd: b.project, hook_event_name: event, ...extra }, { project: b.project, dir: spoolDir(b), pid, now: b.now });
}
/** `sage gate add` in the scratch logbook, then the PostToolUse hook of session `id` with its real output. Returns the gate id. */
function gateAdd(b, id, task, question = `${task} question?`) {
  const out = b.sh('gate', 'add', task, '--question', question, '--options', 'x|y', '--recommend', 'x');
  if (id) hook(b, id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node sage.mjs gate add ${task} --question "${question}"` }, tool_response: { stdout: `${out}\n`, stderr: '' } });
  return out.split(' ')[0];
}
const threadNames = (b) => [...b.discord.threads.values()].map((t) => t.name);
/** The cards posted in one place, by title. */
const cardsIn = (b, at) => b.discord.in(at).map((id) => b.discord.messages.get(id)[0]).filter((p) => p.embeds).map((p) => p.embeds[0].title);
const threadOf = (b, name) => [...b.discord.threads].find(([, t]) => t.name === name)?.[0];
const lineOf = (b, name) => b.discord.latest(b.discord.threads.get(threadOf(b, name)).from).content;

/** Runs scripts/hook.mjs as Claude Code does, through `sh -c`, with a scratch HOME and a config file. */
function runHook(b, input, config = { project: b.project, statePath: b.statePath }) {
  const home = join(b.root, 'home');
  mkdirSync(home, { recursive: true });
  const path = join(b.root, 'hook-config.json');
  writeFileSync(path, JSON.stringify(config));
  const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${HOOK}" --config "${path}"; :`], {
    input: typeof input === 'string' ? input : JSON.stringify(input), env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr.trim() };
}
const spool = (b, id) => JSON.parse(readFileSync(join(spoolDir(b), `${id}.json`), 'utf8'));

test('hook.mjs: SessionStart writes a 0600 spool in a 0700 folder with the id, cwd, start and the pid of Claude Code; gate add and the end are added', () => {
  const b = setup({ markAll: false });
  assert.deepEqual(runHook(b, { session_id: S1, cwd: b.project, hook_event_name: 'SessionStart', source: 'startup' }), { code: 0, out: '', err: '' });
  const s = spool(b, S1);
  // The hook ran in `sh -c "…; :"` (a shell that does not exec it): the recorded pid is past the shell, this test process.
  assert.deepEqual({ ...s, startedAt: typeof s.startedAt }, { id: S1, cwd: b.project, startedAt: 'number', pid: process.pid, gates: [], tasks: [] });
  assert.equal(statSync(join(spoolDir(b), `${S1}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(spoolDir(b)).mode & 0o777, 0o700);
  const out = b.sh('gate', 'add', 'T3', '--question', 'Which name?', '--options', 'a|b', '--recommend', 'a');
  assert.equal(out, 'G1 open · Which name?');
  const post = (stdout, command = 'node sage.mjs gate add T3 --question "Which name?"') => runHook(b, { session_id: S1, cwd: b.project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });
  assert.deepEqual(post(`${out}\n`), { code: 0, out: '', err: '' });
  assert.deepEqual(post('G7 answered · x\n'), { code: 0, out: '', err: '' }); // not a gate add: nothing changes
  assert.deepEqual(post('ls\nG9 opened\n', 'ls'), { code: 0, out: '', err: '' });
  assert.deepEqual([spool(b, S1).gates, spool(b, S1).tasks], [['G1'], ['T3']]);
  assert.equal(spool(b, S1).endedAt, undefined);
  assert.deepEqual(runHook(b, { session_id: S1, cwd: b.project, hook_event_name: 'SessionEnd', reason: 'logout' }), { code: 0, out: '', err: '' });
  assert.equal(typeof spool(b, S1).endedAt, 'number');
  assert.deepEqual(readdirSync(spoolDir(b)), [`${S1}.json`]);
});

test('hook.mjs: bad input is refused with one line on stderr, writes nothing, and the hook still exits 0 with no stdout', () => {
  const b = setup({ markAll: false });
  const ok = { session_id: S1, cwd: b.project, hook_event_name: 'SessionStart' };
  const cases = [
    ['not json', /nothing recorded: Unexpected token/],
    [{ ...ok, session_id: '../../etc/passwd' }, /nothing recorded: the session_id is not a UUID$/],
    [{ ...ok, session_id: S1.toUpperCase() }, /the session_id is not a UUID$/],
    [{ ...ok, cwd: join(b.root, 'other') }, /nothing recorded: the cwd is not the configured project$/],
    [{ ...ok, cwd: 7 }, /the cwd is not the configured project$/],
    [{ ...ok, hook_event_name: 'Stop' }, /nothing recorded: not a hook event of the sage bridge$/],
    [{ ...ok, hook_event_name: 'SessionEnd' }, /^$/], // the end of a session that has no spool: nothing to record
  ];
  for (const [input, err] of cases) {
    const r = runHook(b, input);
    assert.deepEqual([r.code, r.out], [0, ''], JSON.stringify(input));
    assert.match(r.err, err, JSON.stringify(input));
  }
  // No config file, or a config without a project: still exit 0.
  assert.deepEqual(runHook(b, ok, { statePath: b.statePath }).code, 0);
  assert.match(runHook(b, ok, { statePath: b.statePath }).err, /the cwd is not the configured project/);
  assert.equal(existsSync(spoolDir(b)), false);
  // A spool file that is not the hook's is refused by the bridge's reader, by name.
  mkdirSync(spoolDir(b), { recursive: true, mode: 0o700 });
  writeFileSync(join(spoolDir(b), `${S2}.json`), JSON.stringify({ id: S2, cwd: b.project, startedAt: 1, pid: -1, gates: [], tasks: [] }), { mode: 0o600 });
  assert.deepEqual(readSpools(spoolDir(b)).refused, [`the spool file ${S2}.json is refused: not a spool file of the sage-bot hook`]);
});

test('a session whose gates the chief did not mark gets no line and no thread; its first marked gate makes both, and the card goes to the thread', async () => {
  const b = setup({ markAll: false });
  hook(b, S1, 'SessionStart', { source: 'startup' });
  gateAdd(b, S1, 'T1');
  await b.post();
  await b.bridge.loop();
  assert.deepEqual([b.discord.posts, threadNames(b)], [[], []]);
  gateAdd(b, S1, 'T2');
  b.mark('G2');
  await b.post();
  assert.deepEqual(threadNames(b), ['Session 1 · Sun 4 Oct']);
  const thread = threadOf(b, 'Session 1 · Sun 4 Oct');
  const [line] = b.discord.in(CHANNEL);
  assert.equal(b.discord.threads.get(thread).from, line);
  assert.deepEqual(b.discord.messages.get(line)[0], { content: '**Session 1 · Sun 4 Oct**\nrunning · 2 tasks · 1 open question', allowedMentions: { parse: [] } });
  assert.deepEqual(cardsIn(b, thread), ['Question G2 · T2 ']);
  assert.equal(b.discord.latest(b.discord.in(thread)[0]).content, `<@&${DRIVER}> T2 needs one product answer. The first answer is final.`);
  assert.equal(b.bridge.threadOf(S1), thread);
});

test('two sessions at once each get their own thread, numbered in the order of their first team vote; a gate of no known session goes to the newest running one', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart');
  b.now += MINUTE;
  hook(b, S2, 'SessionStart');
  b.now += MINUTE;
  hook(b, S3, 'SessionStart', {}, DEAD); // newer, but its process is gone: it does not run
  gateAdd(b, S2, 'T5');
  await b.post();
  gateAdd(b, S1, 'T6');
  gateAdd(b, null, 'T7'); // no hook saw it: the newest running session is S2
  await b.post();
  assert.deepEqual(threadNames(b), ['Session 1 · Sun 4 Oct', 'Session 2 · Sun 4 Oct']);
  assert.deepEqual(cardsIn(b, b.bridge.threadOf(S2)), ['Question G1 · T5 ', 'Question G3 · T7 ']);
  assert.deepEqual(cardsIn(b, b.bridge.threadOf(S1)), ['Question G2 · T6 ']);
  assert.deepEqual(cardsIn(b, CHANNEL), []);
  assert.equal(b.bridge.threadOf(S3), undefined);
  // Each post about a gate goes to its thread too: the reminder 2 hours after the card.
  b.now += 2 * HOUR;
  await b.bridge.loop();
  const reminders = (at) => b.discord.in(at).map((id) => b.discord.latest(id).content).filter((c) => c?.includes('reminder'));
  assert.deepEqual([reminders(b.bridge.threadOf(S1)).length, reminders(b.bridge.threadOf(S2)).length, reminders(CHANNEL).length], [1, 2, 0]);
});

test('with no session at all (the hooks are not installed yet) a card goes to the parent channel, as before T29', async () => {
  const b = setup();
  gateAdd(b, null, 'T1');
  await b.post();
  assert.deepEqual([cardsIn(b, CHANNEL), threadNames(b)], [['Question G1 · T1 '], []]);
});

test('a press in a thread of the configured channel counts; a press in another channel or in another channel\'s thread does not', async () => {
  const thread = '400000000000000009';
  const press = (channelId, channel) => ({ isButton: () => true, isModalSubmit: () => false, channelId, channel });
  assert.equal(accepts(press(CHANNEL, { isThread: () => false }), CHANNEL), true);
  assert.equal(accepts(press(thread, { isThread: () => true, parentId: CHANNEL }), CHANNEL), true);
  assert.equal(accepts(press(thread, { isThread: () => true, parentId: '400000000000000002' }), CHANNEL), false);
  assert.equal(accepts(press('400000000000000002', { isThread: () => false }), CHANNEL), false);
  assert.equal(accepts(press(thread, null), CHANNEL), false);
  assert.equal(accepts({ ...press(thread, { isThread: () => true, parentId: CHANNEL }), isButton: () => false }, CHANNEL), false);
  // The press on the card in the thread answers the gate, and the card in the thread shows it.
  const b = setup();
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.post();
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1:0:1');
  assert.equal(b.answerOf('G1'), 'B. y');
  assert.match(b.discord.latest(b.discord.in(b.bridge.threadOf(S1))[0]).embeds[0].description, /Answered by Maya/);
});

test('the line is edited in place: tasks and open questions, then "ended" when the session ends; the thread is then archived and locked', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  gateAdd(b, S1, 'T2');
  await b.post();
  const name = 'Session 1 · Sun 4 Oct';
  await b.bridge.loop();
  assert.equal(lineOf(b, name), '**Session 1 · Sun 4 Oct**\nrunning · 2 tasks · 2 open questions');
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1:0:0');
  await b.bridge.loop();
  assert.equal(lineOf(b, name), '**Session 1 · Sun 4 Oct**\nrunning · 2 tasks · 1 open question');
  await b.press(MAYA, 'press:G2:0:0');
  await b.bridge.loop();
  assert.equal(lineOf(b, name), '**Session 1 · Sun 4 Oct**\nrunning · 2 tasks · no open questions');
  assert.equal(b.discord.in(CHANNEL).length, 1); // one line, edited in place
  hook(b, S1, 'SessionEnd', { reason: 'logout' });
  const end = b.now;
  b.now += MINUTE;
  await b.bridge.loop();
  assert.equal(lineOf(b, name), `**Session 1 · Sun 4 Oct**\nended <t:${end / 1000}:f> · 2 tasks · no open questions`);
  assert.deepEqual(b.discord.threads.get(b.bridge.threadOf(S1)), { from: b.discord.in(CHANNEL)[0], name, archived: true, locked: true });
  const edits = b.discord.messages.get(b.discord.in(CHANNEL)[0]).length;
  await b.bridge.loop();
  assert.equal(b.discord.messages.get(b.discord.in(CHANNEL)[0]).length, edits); // no edit when nothing changed
});

test('a session whose Claude Code process is gone counts as ended, without a SessionEnd: the time the bridge saw it', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart', {}, DEAD);
  hook(b, S2, 'SessionStart');
  gateAdd(b, S2, 'T1');
  await b.post();
  // S2 runs; now its spool says the dead process: the next loop ends it.
  hook(b, S2, 'SessionStart', {}, DEAD);
  await b.bridge.loop();
  assert.equal(lineOf(b, 'Session 1 · Sun 4 Oct'), `**Session 1 · Sun 4 Oct**\nended <t:${b.now / 1000}:f> · 1 task · 1 open question`);
  assert.equal(b.discord.threads.get(b.bridge.threadOf(S2)).locked, true);
  // A reminder of an ended session's gate is not posted in its locked thread; the log says why once.
  b.now += 5 * HOUR;
  await b.bridge.loop();
  await b.bridge.loop();
  assert.deepEqual(b.lines.filter((l) => l.includes('has ended')), ['Session 1 · Sun 4 Oct has ended: its thread is locked, so the bridge posts nothing in it']);
  assert.equal(b.discord.posts.filter((p) => p.content?.includes('reminder')).length, 0);
});

test('a resume (the same session id) opens the old thread again before it posts; a /clear (a new session id) gets a new thread', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart', { source: 'startup' });
  gateAdd(b, S1, 'T1');
  await b.post();
  const first = b.bridge.threadOf(S1);
  hook(b, S1, 'SessionEnd', { reason: 'prompt_input_exit' });
  await b.bridge.loop();
  assert.equal(b.discord.threads.get(first).locked, true);
  // A gate of the ended session waits: nothing is posted in its locked thread, and the log says why once.
  gateAdd(b, S1, 'T2');
  await b.post();
  await b.bridge.loop();
  assert.deepEqual(cardsIn(b, first), ['Question G1 · T1 ']);
  assert.deepEqual(b.lines.filter((l) => l.includes('has ended')), ['Session 1 · Sun 4 Oct has ended: its thread is locked, so the bridge posts nothing in it']);
  // Resume: the hook takes away the end; in one loop the bridge unlocks the same thread, then posts the waiting card there.
  b.now += HOUR;
  hook(b, S1, 'SessionStart', { source: 'resume' });
  await b.bridge.loop();
  assert.deepEqual(b.discord.threads.get(first), { from: b.discord.in(CHANNEL)[0], name: 'Session 1 · Sun 4 Oct', archived: false, locked: false });
  assert.deepEqual(cardsIn(b, first), ['Question G1 · T1 ', 'Question G2 · T2 ']);
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), /\nrunning · 2 tasks · 2 open questions$/);
  // /clear: Claude Code ends S1 and starts S2. S1's thread is locked; S2's first team vote makes Session 2.
  hook(b, S1, 'SessionEnd', { reason: 'clear' });
  b.now += MINUTE;
  hook(b, S2, 'SessionStart', { source: 'clear' });
  gateAdd(b, S2, 'T3');
  await b.post();
  assert.deepEqual(threadNames(b), ['Session 1 · Sun 4 Oct', 'Session 2 · Sun 4 Oct']);
  assert.deepEqual(cardsIn(b, b.bridge.threadOf(S2)), ['Question G3 · T3 ']);
  assert.equal(b.discord.threads.get(first).locked, true);
  assert.equal(b.discord.in(CHANNEL).length, 2); // the lines of sessions 1 and 2, the newest at the bottom
});

test('a version 1 gate file loads: its open gate goes to the newest running session, its card is still edited in the parent channel, and the file becomes version 2', async () => {
  const b = setup();
  const gate = openGate({ id: 'G1', kind: 'single', options: ['A', 'B'], askedBy: OWNER, at: T0 });
  const ask = { kind: 'single', task: 'T1', title: '', parts: [{ question: 'Q?', why: 'w', recommended: 'A', options: { A: 'a', B: 'b' } }] };
  const card = await b.discord.post(CHANNEL, { content: 'the card of version 1' });
  mkdirSync(join(b.root, 'state'), { recursive: true, mode: 0o700 });
  writeFileSync(b.statePath, JSON.stringify({ version: 1, entries: [{ gate, ask, sage: ['G1'], texts: [['a', 'b']], message: card, remindedAt: T0, sent: {} }] }), { mode: 0o600 });
  hook(b, S1, 'SessionStart');
  b.bridge = b.make();
  b.now += 2 * HOUR;
  await b.bridge.loop();
  const thread = b.bridge.threadOf(S1);
  assert.deepEqual(b.discord.in(thread).map((id) => b.discord.latest(id).content), [`<@&${DRIVER}> reminder: G1 waits for an answer since <t:${T0 / 1000}:t>. T1 waits.`]);
  await b.press(MAYA, 'press:G1:0:1');
  assert.match(b.discord.latest(card).embeds[0].description, /Answered by Maya/);
  const saved = JSON.parse(readFileSync(b.statePath, 'utf8'));
  assert.deepEqual([saved.version, saved.entries[0].session, saved.sessions.map((s) => [s.id, s.n, s.thread])], [2, S1, [[S1, 1, thread]]]);
  assert.equal(load(b.statePath).entries[0].session, S1);
});

test('the wake note after a sleep goes to each thread with an open question, not to the parent channel', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart');
  hook(b, S2, 'SessionStart');
  gateAdd(b, S1, 'T1');
  gateAdd(b, S2, 'T2');
  await b.post();
  b.now += 8 * HOUR;
  await b.bridge.loop();
  const wakes = (at) => b.discord.in(at).filter((id) => b.discord.latest(id).content?.startsWith('The host was asleep')).length;
  assert.deepEqual([wakes(b.bridge.threadOf(S1)), wakes(b.bridge.threadOf(S2)), wakes(CHANNEL)], [1, 1, 0]);
});

test('scripts/session.mjs thread <session id> prints the thread id; a session with no thread, or a bad id, exits 1', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.post();
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify({ statePath: b.statePath }));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SESSION, '--config', config, ...args], { env: { PATH: process.env.PATH, HOME: join(b.root, 'home') }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  assert.deepEqual(run('thread', S1), { code: 0, out: b.bridge.threadOf(S1), err: '' });
  assert.match(b.bridge.threadOf(S1), /^\d{18}$/);
  assert.deepEqual(run('thread', S2), { code: 1, out: '', err: `sage-bot session: the session ${S2} has no thread yet: it gets one at its first team vote` });
  assert.deepEqual(run('thread', 'G1'), { code: 1, out: '', err: 'sage-bot session: not a Claude Code session id (a UUID)' });
  assert.match(run('lines').err, /^sage-bot session: usage:/);
});

test('end to end: SessionStart, gate add and its PostToolUse, the chief marks the gate, a press in the thread, then SessionEnd; all through scripts/hook.mjs', async () => {
  const b = setup({ markAll: false });
  const event = (name, extra = {}) => runHook(b, { session_id: S1, cwd: b.project, hook_event_name: name, ...extra });
  assert.equal(event('SessionStart', { source: 'startup' }).code, 0);
  b.sh('task', 'add', '--title', 'Export page', '--size', 'small');
  const command = 'node sage.mjs gate add T1 --question "Which columns?" --options "Visible only|All fields" --recommend "Visible only"';
  const out = b.sh('gate', 'add', 'T1', '--question', 'Which columns?', '--options', 'Visible only|All fields', '--recommend', 'Visible only');
  assert.equal(event('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: `${out}\n`, stderr: '' } }).code, 0);
  b.mark('G1');
  await b.post();
  const thread = b.bridge.threadOf(S1);
  assert.deepEqual(cardsIn(b, thread), ['Question G1 · T1 Export page']);
  assert.match(lineOf(b, b.discord.threads.get(thread).name), /\nrunning · 1 task · 1 open question$/);
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1:0:1');
  assert.equal(b.answerOf('G1'), 'B. All fields');
  assert.equal(event('SessionEnd', { reason: 'logout' }).code, 0);
  await b.bridge.loop();
  assert.match(lineOf(b, b.discord.threads.get(thread).name), /\nended <t:\d+:f> · 1 task · no open questions$/);
  assert.deepEqual([b.discord.threads.get(thread).archived, b.discord.threads.get(thread).locked], [true, true]);
});
