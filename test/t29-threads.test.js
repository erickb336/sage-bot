// T29: one Discord thread per chief session and one line per session in the parent channel. Through the fake Discord layer, a scratch
// sage logbook and a scratch spool; the hook runs as Claude Code runs it, with its JSON on stdin. SAMPLE DATA ONLY: every id is made up.
process.env.TZ = 'UTC'; // the title of a thread has the host's date: 2026-10-04 is a Sunday in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accepts } from '../src/discord.js';
import { readSpools, record } from '../src/sessions.js';
import { load } from '../src/state.js';
import { HOUR, MINUTE, openGate } from '../src/vote.js';
import { CHANNEL, DRIVER, JON, LEADR, MAYA, OWNER, setAt, setup, T0 } from './bridge-setup.js';
import { fakeInteraction } from '../src/fake-discord.js';

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
/** sage's time of `gate add` for the test's clock: the wall clock to the second, as sage writes it. */
const sageAt = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
/** `sage gate add` in the scratch logbook at the test's clock, then the PostToolUse hook of session `id` with its real output. Returns the gate id. */
function gateAdd(b, id, task, question = `${task} question?`) {
  const out = b.sh('gate', 'add', task, '--question', question, '--options', 'x|y', '--recommend', 'x');
  const gate = out.split(' ')[0];
  setAt(b, { [gate]: sageAt(b.now) });
  if (id) hook(b, id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node sage.mjs gate add ${task} --question "${question}"` }, tool_response: { stdout: `${out}\n`, stderr: '' } });
  return gate;
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
    [{ ...ok, cwd: 7 }, /nothing recorded: the cwd is not a path$/],
    [{ ...ok, hook_event_name: 'Stop' }, /nothing recorded: not a hook event of the sage bridge$/],
    [{ ...ok, hook_event_name: 'SessionEnd' }, /^$/], // the end of a session that has no spool: nothing to record
  ];
  for (const [input, err] of cases) {
    const r = runHook(b, input);
    assert.deepEqual([r.code, r.out], [0, ''], JSON.stringify(input));
    assert.match(r.err, err, JSON.stringify(input));
  }
  // A config without a project: still exit 0.
  assert.deepEqual(runHook(b, ok, { statePath: b.statePath }), { code: 0, out: '', err: 'sage-bot hook: nothing recorded: the config has no project' });
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
  const fetch = async () => { throw new Error('not fetched: the channel is in the cache'); };
  assert.equal(await accepts(press(CHANNEL, { isThread: () => false }), CHANNEL, fetch), true);
  assert.equal(await accepts(press(thread, { isThread: () => true, parentId: CHANNEL }), CHANNEL, fetch), true);
  assert.equal(await accepts(press(thread, { isThread: () => true, parentId: '400000000000000002' }), CHANNEL, fetch), false);
  assert.equal(await accepts(press('400000000000000002', { isThread: () => false }), CHANNEL, fetch), false);
  assert.equal(await accepts({ ...press(thread, { isThread: () => true, parentId: CHANNEL }), isButton: () => false }, CHANNEL, fetch), false);
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

test('G15: a session that ends with an open batch keeps its thread open: the line says ended at once, presses count, reminders go to the thread; the thread locks at the first loop after the vote settles', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart', {}, DEAD);
  hook(b, S2, 'SessionStart');
  gateAdd(b, S2, 'T1', 'A?');
  gateAdd(b, S2, 'T1', 'B?');
  await b.post();
  const thread = b.bridge.threadOf(S2);
  assert.deepEqual(cardsIn(b, thread), ['Batch vote G1+G2 · T1 ']);
  // S2's Claude Code process is gone (no SessionEnd): the next loop shows it as ended, and the thread stays open.
  hook(b, S2, 'SessionStart', {}, DEAD);
  await b.bridge.loop();
  assert.equal(lineOf(b, 'Session 1 · Sun 4 Oct'), `**Session 1 · Sun 4 Oct**\nended <t:${b.now / 1000}:f> · 1 task · 2 open questions`);
  assert.deepEqual([b.discord.threads.get(thread).archived, b.discord.threads.get(thread).locked], [false, false]);
  // The team votes on in the thread: the presses count, the vote ends in a tie on part 1, the tie post goes to the thread.
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1+G2:0:0');
  await b.press(JON, 'press:G1+G2:0:1');
  await b.press(MAYA, 'press:G1+G2:1:0');
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  const contents = () => b.discord.in(thread).map((id) => b.discord.latest(id).content);
  assert.match(contents().at(-1), new RegExp(`^<@&${LEADR}> G1\\+G2 is tied after its vote`));
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), / · 1 open question$/);
  // The reminder to the leads 2 hours later goes to the thread too; the thread is still open.
  b.now += 2 * HOUR;
  await b.bridge.loop();
  assert.match(contents().at(-1), new RegExp(`^<@&${LEADR}> reminder: part 1 of G1\\+G2 still tied`));
  assert.equal(b.discord.threads.get(thread).locked, false);
  // A lead breaks the tie: the last question settles, and the next loop archives and locks the thread.
  await b.press(JON, 'tiebreak:G1+G2:0:1');
  assert.equal(b.discord.threads.get(thread).locked, false);
  await b.bridge.loop();
  assert.deepEqual([b.discord.threads.get(thread).archived, b.discord.threads.get(thread).locked], [true, true]);
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), /\nended <t:\d+:f> · 1 task · no open questions$/);
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['B. y', 'A. x']);
});

test('G15: a session that ends with no open question locks its thread at once; a withdrawn question counts as settled', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.post();
  const thread = b.bridge.threadOf(S1);
  b.sh('gate', 'answer', 'G1', 'dropped: not needed any more'); // the owner withdraws it at the terminal
  await b.bridge.loop();
  assert.equal(b.discord.threads.get(thread).locked, false); // the session runs
  hook(b, S1, 'SessionEnd', { reason: 'clear' });
  await b.bridge.loop();
  assert.deepEqual([b.discord.threads.get(thread).archived, b.discord.threads.get(thread).locked], [true, true]);
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), /\nended <t:\d+:f> · 1 task · no open questions$/);
});
test('a resume (the same session id) opens the old thread again; a /clear (a new session id) gets a new thread; a late card of an ended session opens its thread', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart', { source: 'startup' });
  gateAdd(b, S1, 'T1');
  await b.post();
  const first = b.bridge.threadOf(S1);
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1:0:0');
  hook(b, S1, 'SessionEnd', { reason: 'prompt_input_exit' });
  await b.bridge.loop();
  assert.equal(b.discord.threads.get(first).locked, true);
  // Resume: the hook takes away the end; the next loop unlocks the same thread, and a new card goes there.
  b.now += HOUR;
  hook(b, S1, 'SessionStart', { source: 'resume' });
  await b.bridge.loop();
  assert.deepEqual(b.discord.threads.get(first), { from: b.discord.in(CHANNEL)[0], name: 'Session 1 · Sun 4 Oct', archived: false, locked: false });
  gateAdd(b, S1, 'T2');
  await b.post();
  assert.deepEqual(cardsIn(b, first), ['Question G1 · T1 ', 'Question G2 · T2 ']);
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), /\nrunning · 2 tasks · 1 open question$/);
  // /clear: Claude Code ends S1 and starts S2. S1's thread stays open for G2; S2's first team vote makes Session 2.
  hook(b, S1, 'SessionEnd', { reason: 'clear' });
  b.now += MINUTE;
  hook(b, S2, 'SessionStart', { source: 'clear' });
  gateAdd(b, S2, 'T3');
  await b.post();
  assert.deepEqual(threadNames(b), ['Session 1 · Sun 4 Oct', 'Session 2 · Sun 4 Oct']);
  assert.deepEqual(cardsIn(b, b.bridge.threadOf(S2)), ['Question G3 · T3 ']);
  assert.equal(b.discord.threads.get(first).locked, false);
  assert.equal(b.discord.in(CHANNEL).length, 2); // the lines of sessions 1 and 2, the newest at the bottom
  await b.press(MAYA, 'press:G2:0:0');
  await b.bridge.loop();
  assert.equal(b.discord.threads.get(first).locked, true);
  // A gate that S1 asked just before its end gets its card after the lock: the thread opens again for it, and locks when it settles.
  gateAdd(b, S1, 'T4');
  await b.post();
  assert.deepEqual([cardsIn(b, first).at(-1), b.discord.threads.get(first).locked], ['Question G4 · T4 ', false]);
  await b.press(MAYA, 'press:G4:0:1');
  await b.bridge.loop();
  assert.equal(b.discord.threads.get(first).locked, true);
});
test('a version 1 gate file loads: its card stays in the parent channel with its reminders, no session takes it, and the file becomes version 2', async () => {
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
  assert.equal(b.bridge.threadOf(S1), undefined);
  assert.deepEqual(b.discord.in(CHANNEL).map((id) => b.discord.latest(id).content).slice(1), [`<@&${DRIVER}> reminder: G1 waits for an answer since <t:${T0 / 1000}:t>. T1 waits.`]);
  await b.press(MAYA, 'press:G1:0:1');
  assert.match(b.discord.latest(card).embeds[0].description, /Answered by Maya/);
  const saved = JSON.parse(readFileSync(b.statePath, 'utf8'));
  assert.deepEqual([saved.version, saved.entries[0].session, saved.sessions], [2, null, []]);
  assert.equal(load(b.statePath).entries[0].session, null);
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

test('F-T29-2: a thread that Discord made but whose reply was lost: the card goes to the parent channel, and the next card takes the thread (code 160004)', async () => {
  const b = setup();
  const start = b.discord.startThread;
  let lost = 1;
  b.discord.startThread = async (...args) => {
    const id = await start(...args);
    if (lost-- > 0) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return id;
  };
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.post();
  assert.deepEqual([cardsIn(b, CHANNEL), b.bridge.threadOf(S1)], [['Question G1 · T1 '], undefined]);
  // Every later try of startThread gets 160004 from Discord; the bridge takes the thread of the line instead.
  gateAdd(b, S1, 'T2');
  await b.post();
  const thread = threadOf(b, 'Session 1 · Sun 4 Oct');
  assert.deepEqual([b.bridge.threadOf(S1), cardsIn(b, thread), threadNames(b)], [thread, ['Question G2 · T2 '], ['Session 1 · Sun 4 Oct']]);
  // The press on the card in the parent channel counts, and the line counts both cards.
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1:0:1');
  assert.equal(b.answerOf('G1'), 'B. y');
  await b.bridge.loop();
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), /\nrunning · 2 tasks · 1 open question$/);
});

test('F-T29-2: without the permission to make threads, the cards go to the parent channel, the refusal is logged once, and a later card makes the thread', async () => {
  const b = setup();
  const start = b.discord.startThread;
  b.discord.startThread = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); };
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.post();
  gateAdd(b, S1, 'T2');
  await b.post();
  for (let i = 0; i < 4; i++) { b.now += LOOP_GAP; await b.bridge.loop(); }
  assert.deepEqual([cardsIn(b, CHANNEL), threadNames(b)], [['Question G1 · T1 ', 'Question G2 · T2 '], []]);
  assert.deepEqual(b.lines.filter((l) => l.includes('refused the thread')), ['Discord refused the thread of Session 1 · Sun 4 Oct, so its cards go to the parent channel until a later card makes it: code 50013, status 403: Missing Permissions']);
  // The owner gives the permission: the next card makes the thread; the reminders of the first cards stay with them in the parent channel.
  b.discord.startThread = start;
  gateAdd(b, S1, 'T3');
  await b.post();
  assert.deepEqual(cardsIn(b, b.bridge.threadOf(S1)), ['Question G3 · T3 ']);
  b.now += 2 * HOUR;
  await b.bridge.loop();
  const reminders = (at) => b.discord.in(at).map((id) => b.discord.latest(id).content).filter((c) => c?.includes('reminder')).length;
  assert.deepEqual([reminders(CHANNEL), reminders(b.bridge.threadOf(S1))], [2, 1]);
});
const LOOP_GAP = 15_000;

test('F-T29-3: the hook ignores a gate add for another project; a gate id in two spools goes to the session that started last before sage asked it', async () => {
  const b = setup();
  const other = join(b.root, 'other');
  mkdirSync(other);
  const post = (id, command, stdout) => hook(b, id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });
  hook(b, S1, 'SessionStart');
  assert.equal(post(S1, `node sage.mjs gate add T9 --question "Q?" --project "${other}"`, 'G1 open · Q?\n'), 'another project');
  assert.equal(post(S1, `node sage.mjs gate add T9 --project=${other}/ --question "Q?"`, 'G1 open · Q?\n'), 'another project');
  assert.equal(post(S1, `cd ${b.project} && node sage.mjs gate add T9 --project ../other`, 'G1 open · Q?\n'), 'another project');
  assert.deepEqual(spool(b, S1).gates, []);
  // --project naming this project, or a worktree folder in it, counts.
  mkdirSync(join(b.project, '.claude', 'worktrees', 'x'), { recursive: true });
  assert.equal(post(S1, `node sage.mjs gate add T8 --project '${b.project}/.claude/worktrees/x'`, 'G5 open · Q?\n'), `PostToolUse ${S1}`);
  assert.deepEqual(spool(b, S1).gates, ['G5']);
  // S1 also lists G1 from an older logbook. S2 starts an hour later and asks G1 of this logbook; S3 starts after it and lists it too.
  post(S1, 'node sage.mjs gate add T9', 'G1 open · old\n');
  b.now += HOUR;
  hook(b, S2, 'SessionStart');
  b.now += MINUTE;
  gateAdd(b, S2, 'T1');
  b.now += MINUTE;
  hook(b, S3, 'SessionStart');
  post(S3, 'node sage.mjs gate add T1', 'G1 open · T1 question?\n');
  await b.post();
  assert.deepEqual([threadNames(b), cardsIn(b, b.bridge.threadOf(S2))], [['Session 1 · Sun 4 Oct'], ['Question G1 · T1 ']]);
});

test('F-T29-4: a card in the parent channel keeps its tie post, tie-break note and reminders there; no session takes it, and a session ends without it', async () => {
  const b = setup();
  gateAdd(b, null, 'T7', 'A?');
  gateAdd(b, null, 'T7', 'B?');
  await b.post(); // no session yet: the batch goes to the parent channel
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.post();
  const thread = b.bridge.threadOf(S1);
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1+G2:0:0');
  await b.press(JON, 'press:G1+G2:0:1');
  await b.press(MAYA, 'press:G1+G2:1:0');
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  b.now += 2 * HOUR;
  await b.bridge.loop();
  await b.press(JON, 'tiebreak:G1+G2:0:1');
  // The first text of each message, without the wake notes (the test's clock jumps): the card, S1's line, the tie, the reminder, the note.
  const contents = (at) => b.discord.in(at).map((id) => b.discord.messages.get(id)[0].content).filter((c) => !c.startsWith('The host'));
  assert.deepEqual(contents(CHANNEL).map((c) => c.split(' ').slice(1, 3).join(' ')), ['T7 has', '1 ·', 'G1+G2 is', 'reminder: part', '(sage-lead) broke']);
  assert.equal(contents(thread).filter((c) => c.includes('G1+G2')).length, 0);
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), / · 1 task · 1 open question$/);
});

test('F-T29-6 and F-T29-4: a press that posts while the loop waits for a session\'s line makes no second line or thread', async () => {
  const b = setup();
  gateAdd(b, null, 'T7', 'A?');
  gateAdd(b, null, 'T7', 'B?');
  await b.post();
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1+G2:0:0');
  await b.press(JON, 'press:G1+G2:0:1');
  await b.press(MAYA, 'press:G1+G2:1:0');
  b.now += 30 * MINUTE;
  await b.bridge.loop(); // the batch is tied
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.bridge.loop();
  b.now += 30_000;
  // The next loop posts S1's line; Discord is slow to answer, and a lead breaks the tie meanwhile.
  const post = b.discord.post;
  let release;
  let started;
  const waiting = new Promise((r) => { started = r; });
  b.discord.post = async (at, p) => {
    if (p.content?.startsWith('**Session') && !release) { started(); await new Promise((r) => { release = r; }); }
    return post(at, p);
  };
  const loop = b.bridge.loop();
  await waiting;
  await b.press(JON, 'tiebreak:G1+G2:0:1');
  release();
  await loop;
  await b.bridge.loop();
  assert.deepEqual([b.discord.in(CHANNEL).filter((id) => b.discord.latest(id).content?.startsWith('**Session')).length, threadNames(b)], [1, ['Session 1 · Sun 4 Oct']]);
  assert.ok(b.discord.in(CHANNEL).some((id) => b.discord.latest(id).content === 'Jon (sage-lead) broke the tie on part 1 of G1+G2: B.'));
  assert.deepEqual(cardsIn(b, b.bridge.threadOf(S1)), ['Question G3 · T1 ']);
});

test('F-T29-5: the hook records from a subfolder, a worktree folder or a link to the project; an event outside the project is ignored with no stderr', async () => {
  const b = setup();
  const sub = join(b.project, '.claude', 'worktrees', 't9', 'src');
  mkdirSync(sub, { recursive: true });
  symlinkSync(b.project, join(b.root, 'link'));
  mkdirSync(join(b.root, 'other'));
  const event = (cwd, name, extra = {}) => runHook(b, { session_id: S1, cwd, hook_event_name: name, ...extra });
  assert.deepEqual(event(join(b.root, 'link'), 'SessionStart'), { code: 0, out: '', err: '' });
  // F-T29-12: the link event alone writes the spool, so a check without the real paths fails here.
  assert.deepEqual({ ...spool(b, S1), startedAt: 0 }, { id: S1, cwd: b.project, startedAt: 0, pid: process.pid, gates: [], tasks: [] });
  const out = b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  assert.deepEqual(event(sub, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node sage.mjs gate add T1' }, tool_response: { stdout: `${out}\n` } }), { code: 0, out: '', err: '' });
  assert.deepEqual(event(join(b.root, 'other'), 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node sage.mjs gate add T2' }, tool_response: { stdout: 'G2 open · Q?\n' } }), { code: 0, out: '', err: '' });
  assert.deepEqual(event(join(b.root, 'project-2'), 'SessionEnd'), { code: 0, out: '', err: '' }); // a sibling folder whose name starts the same
  assert.deepEqual([spool(b, S1).gates, spool(b, S1).endedAt], [['G1'], undefined]);
  assert.deepEqual(event(sub, 'SessionEnd'), { code: 0, out: '', err: '' });
  assert.equal(typeof spool(b, S1).endedAt, 'number');
});

test('T29 with T39: a session thread gets the tie post after a lead ends the vote early; after a restart the tie-break note and the card in the thread name the lead, and the version 2 file keeps the session, endedBy, by and at', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1', 'A?');
  gateAdd(b, S1, 'T1', 'B?');
  await b.post();
  const thread = b.bridge.threadOf(S1);
  const [cardId] = b.discord.in(thread);
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1+G2:0:0');
  await b.press(JON, 'press:G1+G2:0:1');
  await b.press(MAYA, 'press:G1+G2:1:0');
  b.now += MINUTE;
  const endAt = b.now;
  await b.press(JON, 'end:G1+G2'); // asks to confirm
  await b.bridge.interaction(fakeInteraction({ user: JON, customId: 'end!:G1+G2', ephemeral: true }));
  const contents = () => b.discord.in(thread).map((id) => b.discord.latest(id).content);
  assert.match(contents().at(-1), new RegExp(`^<@&${LEADR}> G1\\+G2 is tied after its vote`));
  // The file on disk is version 2: the entry has its session and the lead who ended the vote.
  const saved = JSON.parse(readFileSync(b.statePath, 'utf8'));
  assert.deepEqual([saved.version, saved.entries[0].session, saved.entries[0].gate.endedBy], [2, S1, JON]);
  // A restart: a new bridge loads the file, keeps the thread of S1, and the tie-break goes to the thread.
  b.bridge = b.make();
  assert.equal(b.bridge.threadOf(S1), thread);
  b.now += MINUTE;
  const breakAt = b.now;
  await b.press(JON, 'tiebreak:G1+G2:0:1');
  assert.equal(contents().at(-1), `Jon (sage-lead) broke the tie on part 1 of G1+G2: B.`);
  const s = (ms) => `<t:${Math.floor(ms / 1000)}:t>`;
  const drawn = b.discord.latest(cardId).embeds[0];
  assert.equal(drawn.description, `Ended early by Jon (sage-lead) at ${s(endAt)}, with the votes so far. Closed: every part is decided. T1 goes on.`);
  assert.equal(drawn.fields[0].value.split('\n').at(-1), `**Decided: B** · tie broken by Jon (sage-lead) at ${s(breakAt)}`);
  assert.equal(b.discord.in(CHANNEL).filter((id) => /G1\+G2/.test(b.discord.latest(id).content ?? '')).length, 0);
  const entry = load(b.statePath).entries[0];
  assert.deepEqual([entry.session, entry.gate.endedBy, entry.gate.parts[0].outcome], [S1, JON, { status: 'decided', option: 'B', how: 'lead-tiebreak', by: JON, at: breakAt }]);
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['B. y', 'A. x']);
});

test('F-T29-10: a press in a thread that is not in the cache (i.channel is null) is fetched by its id: a thread of the channel counts, any other place does not', async () => {
  const thread = '400000000000000009';
  const places = new Map([
    [thread, { isThread: () => true, parentId: CHANNEL }],
    ['400000000000000008', { isThread: () => true, parentId: '400000000000000002' }],
    ['400000000000000007', { isThread: () => false }],
  ]);
  const fetched = [];
  const fetch = async (id) => { fetched.push(id); if (!places.has(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); return places.get(id); };
  const press = (channelId) => ({ isButton: () => true, isModalSubmit: () => false, channelId, channel: null });
  const results = [];
  for (const id of [thread, '400000000000000008', '400000000000000007', '400000000000000006']) results.push(await accepts(press(id), CHANNEL, fetch));
  assert.deepEqual(results, [true, false, false, false]);
  assert.deepEqual(fetched, [thread, '400000000000000008', '400000000000000007', '400000000000000006']);
});

test('F-T29-11: the hook records only a run of the sage state tool with gate add; ~ and $HOME in --project are the hook\'s HOME, any other shell value is ignored; a folder named ..cache is inside', () => {
  const b = setup();
  const home = b.root; // so ~/project is the project, and ~/other is outside it
  mkdirSync(join(b.root, 'other'));
  mkdirSync(join(b.project, '~', 'project'), { recursive: true });
  const post = (command, stdout = 'G4 open · Q?\n', cwd = b.project) => record(
    { session_id: S1, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } },
    { project: b.project, dir: spoolDir(b), pid: process.pid, now: b.now, home });
  const results = [
    post('cat notes.txt', 'G9 open · a line of a file\n'),
    post('echo "G9 open · x" # gate add T9'),
    post('node other.mjs gate add T9'),
    post('node sage.mjs gate add T9 --project ~/other'),
    post('node sage.mjs gate add T9 --project $HOME/other'),
    post('node sage.mjs gate add T9 --project "${HOME}/other"'),
    post('node sage.mjs gate add T9 --project "$(pwd)"'),
    post('node sage.mjs gate add T9 --project `pwd`'),
    post('node sage.mjs gate add T9 --project $PROJECT'),
    post("node sage.mjs gate add T9 --project '~/project'"),
  ];
  assert.deepEqual(results, ['no gate add', 'no gate add', 'no gate add', 'another project', 'another project', 'another project',
    'a project that only the shell knows', 'a project that only the shell knows', 'a project that only the shell knows', `PostToolUse ${S1}`]);
  assert.deepEqual(spool(b, S1).gates, ['G4']); // only the last one: '~/project' in single quotes is a folder named ~ inside the project
  // ~ and $HOME that name the project, a quoted path to sage.mjs, and a folder named ..cache in the project count.
  const cache = join(b.project, '..cache');
  mkdirSync(cache);
  assert.equal(post('node ~/sage.mjs gate add T5 --project ~/project', 'G5 open · Q?\n'), `PostToolUse ${S1}`);
  assert.equal(post(`node "/a b/skills/sage/sage.mjs" gate add T6 --project "$HOME/project/..cache"`, 'G6 open · Q?\n'), `PostToolUse ${S1}`);
  assert.equal(post('node sage.mjs gate add T7', 'G7 open · Q?\n', cache), `PostToolUse ${S1}`);
  assert.deepEqual([spool(b, S1).gates, spool(b, S1).tasks], [['G4', 'G5', 'G6', 'G7'], ['T9', 'T5', 'T6', 'T7']]);
});

test('F-T29-9: a session thread deleted in Discord: the next card goes to the parent channel in the same loop, one log line, the card after it gets a new thread from the line (or from a new line when the line is gone too)', async () => {
  const b = setup();
  hook(b, S1, 'SessionStart');
  gateAdd(b, S1, 'T1');
  await b.post();
  const first = b.bridge.threadOf(S1);
  const [line] = b.discord.in(CHANNEL);
  b.discord.deleteThread(first);
  gateAdd(b, S1, 'T2');
  await b.post();
  for (let i = 0; i < 4; i++) { b.now += LOOP_GAP; await b.bridge.loop(); }
  // G17: the open card G1 of the deleted thread is posted again in the parent channel.
  assert.deepEqual([cardsIn(b, CHANNEL), b.bridge.threadOf(S1)], [['Question G1 · T1 ', 'Question G2 · T2 '], undefined]);
  assert.deepEqual(b.lines.filter((l) => /gone|refused/.test(l)), [
    `the thread ${first} of Session 1 · Sun 4 Oct is gone from Discord, so its cards go to the parent channel until the next card makes a new thread: code 10003, status 404: Unknown Channel`,
    'G1: its card is posted again in the parent channel, because the thread of Session 1 · Sun 4 Oct is gone (G17)']);
  // The next card makes a new thread from the same line.
  gateAdd(b, S1, 'T3');
  await b.post();
  const second = b.bridge.threadOf(S1);
  assert.notEqual(second, first);
  assert.deepEqual([b.discord.threads.get(second).from, cardsIn(b, second)], [line, ['Question G3 · T3 ']]);
  // The line and the new thread are both deleted: the next card goes to the parent channel, the one after it gets a new line and thread.
  b.discord.deleteThread(second);
  b.discord.deleteMessage(line);
  gateAdd(b, S1, 'T4');
  await b.post();
  gateAdd(b, S1, 'T5');
  await b.post();
  const third = b.bridge.threadOf(S1);
  const lines = b.discord.in(CHANNEL).filter((id) => b.discord.latest(id).content?.startsWith('**Session'));
  assert.deepEqual([cardsIn(b, CHANNEL), cardsIn(b, third), lines.length, b.discord.threads.get(third).from], [['Question G1 · T1 ', 'Question G2 · T2 ', 'Question G3 · T3 ', 'Question G4 · T4 '], ['Question G5 · T5 '], 1, lines[0]]);
  assert.match(lineOf(b, 'Session 1 · Sun 4 Oct'), /\nrunning · 5 tasks · 5 open questions$/);
  // A lock of a deleted thread forgets it too: the session ends, the lock is refused once, and no loop tries again.
  b.discord.deleteThread(third);
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G5']) b.sh('gate', 'answer', id, 'x');
  hook(b, S1, 'SessionEnd');
  for (let i = 0; i < 3; i++) { b.now += LOOP_GAP; await b.bridge.loop(); }
  assert.equal(b.bridge.threadOf(S1), undefined);
  assert.equal(b.lines.filter((l) => l.startsWith(`the thread ${third} `)).length, 1);
});
