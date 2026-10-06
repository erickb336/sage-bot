// T132 repair round 1: the own project is the listed project whose real folder is the config's `project`, else nothing starts
// (F-T132-1); a card of a project that left the config takes no press (F-T132-2); a card posted before T132 keeps a mark until an edit
// gives it the keyed buttons, and its old buttons work until then (F-T132-5, F-T132-3); a session keeps its first project, and the
// answers of a project that left the config are not sent (F-T132-6). SAMPLE DATA ONLY: scratch logbooks, made-up ids, the fake Discord layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { prepare } from '../src/discord.js';
import { sageTool } from '../src/sage.js';
import { loadProjects, pickProject } from '../src/projects.js';
import { record } from '../src/sessions.js';
import { openGate } from '../src/vote.js';
import { CHANNEL, CONFIG, execFileSync, MAYA, SAGE, setup, spawnSync, T0 } from './bridge-setup.js';

const SCRIPT = (name) => new URL(`../scripts/${name}`, import.meta.url).pathname;
const UNKNOWN = 'I do not know this button or its question. Nothing changed.';
const REFUSED = (project) => `the config's project (${project}) is not in its projects. Add it to projects, with a name. Nothing was started.`;
const GONE = 'This question\'s project is no longer served; Erick answers it at the terminal.';
const S1 = 'eeeeeeee-0000-4000-8000-000000000132';

/** A scratch project (the own one, `project`) and a second one, `beta`, each with its own logbook, task T1 and gate G1. */
function two() {
  const b = setup({ markAll: false });
  b.beta = join(b.root, 'beta');
  mkdirSync(b.beta);
  const env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  b.shBeta = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', b.beta], { env, encoding: 'utf8' }).trim();
  b.shBeta('init');
  b.betaSage = sageTool({ sagePath: SAGE, project: b.beta, env });
  b.sh('task', 'add', '--title', 'Alpha export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  b.shBeta('task', 'add', '--title', 'Beta colours', '--size', 'small');
  b.shBeta('gate', 'add', 'T1', '--question', 'Which colour?', '--options', 'Red|Blue', '--recommend', 'Red');
  // The own project is listed second: a fall back to the first project would take beta's logbook.
  b.projects = [{ name: 'beta', project: b.beta, sagePath: SAGE }, { name: 'project', project: b.project, sagePath: SAGE, own: true }];
  b.with = (sages, own) => createBridge({ sages: new Map(sages), own, discord: b.discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  b.answerOfBeta = (id) => b.betaSage.gates().then((rows) => rows.find((r) => r.id === id).answer);
  return b;
}

/** The gate file of the time before T132 (version 2, bare ids) with one card of G1 of the own project, posted with its old buttons. */
async function oldCard(b, final) {
  const gate = openGate({ id: 'G1', kind: 'single', options: ['A', 'B'], askedBy: CONFIG.ownerId, at: T0 });
  const ask = { kind: 'single', task: 'T1', title: 'Alpha export',
    parts: [{ question: 'Which file type?', why: 'CSV', recommended: 'A', options: { A: 'CSV', B: 'JSON' }, ...(final && { final }) }] };
  const message = await b.discord.post(CHANNEL, { content: 'the card of G1, posted before T132', components: [{ type: 1, components: [{ custom_id: 'press:G1:0:0' }, { custom_id: 'press:G1:0:1' }] }] });
  mkdirSync(join(b.root, 'state'), { recursive: true, mode: 0o700 });
  writeFileSync(b.statePath, JSON.stringify({ version: 2, entries: [{ gate, ask, sage: ['G1'], texts: [['CSV', 'JSON']], message, remindedAt: T0, sent: {}, session: null }], sessions: [] }), { mode: 0o600 });
  writeFileSync(`${b.statePath}.votes`, '["G1"]', { mode: 0o600 });
  return message;
}
const buttons = (payload) => (payload.components ?? []).flatMap((row) => row.components.map((c) => c.custom_id));
const saved = (b) => JSON.parse(readFileSync(b.statePath, 'utf8'));

test('F-T132-1: the own project is found by its real folder: a trailing slash and a symlink name it, a folder that is not listed is refused', () => {
  const b = two();
  execFileSync('git', ['init', '-q', b.project]); // a link names a folder in git only (F-T132-24)
  const link = join(b.root, 'link');
  symlinkSync(b.project, link);
  const own = (project, projects = b.projects) => pickProject(loadProjects({ project, projects })).name;
  assert.equal(own(`${b.project}/`), 'project');
  assert.equal(own(link), 'project');
  assert.equal(own(b.project, [b.projects[0], { ...b.projects[1], project: `${link}/` }]), 'project');
  const elsewhere = join(b.root, 'elsewhere');
  assert.throws(() => own(elsewhere), { message: REFUSED(elsewhere) });
  assert.throws(() => own(undefined), { message: 'the config: project must be an absolute path' }); // F-T132-25
});

test('F-T132-1: a config whose project is not listed: the bridge, vote.mjs, reasons.mjs and the hook each refuse with one line and change nothing', () => {
  const b = two();
  const elsewhere = join(b.root, 'elsewhere');
  const file = { ...CONFIG, guildId: '200000000000000001', project: elsewhere, sagePath: SAGE, statePath: b.statePath, projects: b.projects };
  assert.throws(() => prepare(file, () => {}), { message: REFUSED(elsewhere) });
  assert.equal(existsSync(`${b.statePath}.lock`), false); // refused before the lock and the channel registry
  assert.equal(existsSync(`${b.statePath}.channels`), false);
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify(file));
  const run = (script, ...args) => spawnSync(process.execPath, [SCRIPT(script), '--config', config, ...args],
    { env: { PATH: process.env.PATH, HOME: join(b.root, 'home') }, encoding: 'utf8', input: JSON.stringify({ session_id: S1, cwd: b.project, hook_event_name: 'SessionStart' }) });
  const vote = run('vote.mjs', 'G1');
  assert.deepEqual([vote.status, vote.stdout, vote.stderr], [1, '', `sage-bot vote: ${REFUSED(elsewhere)}\n`]);
  assert.equal(existsSync(`${b.statePath}.votes`), false);
  const reasons = run('reasons.mjs', 'G1');
  assert.deepEqual([reasons.status, reasons.stdout, reasons.stderr], [1, '', `sage-bot reasons: ${REFUSED(elsewhere)}\n`]);
  const hook = run('hook.mjs');
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', `sage-bot hook: nothing recorded: ${REFUSED(elsewhere)}\n`]);
  assert.equal(existsSync(`${b.statePath}.sessions`), false);
});

test('F-T132-1: with a trailing slash on project and the own project listed second, vote.mjs and the old card both stay in the own logbook', async () => {
  const b = two();
  const old = await oldCard(b);
  const config = { project: `${b.project}/`, statePath: b.statePath, projects: b.projects };
  const own = pickProject(loadProjects(config)).name;
  assert.equal(own, 'project');
  b.bridge = b.with([['beta', b.betaSage], ['project', b.sage]], own);
  assert.deepEqual([saved(b).entries[0].gate.id, readFileSync(`${b.statePath}.votes`, 'utf8')], ['project/G1', JSON.stringify({ 'project/G1': b.project })]);
  b.now += 60_000;
  await b.press(MAYA, 'press:G1:0:1'); // the old button, before the first loop
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), await b.answerOfBeta('G1')], ['B. JSON', '']);
  assert.deepEqual(buttons(b.discord.latest(old)), ['press:project/G1:0:0', 'press:project/G1:0:1']);
  // vote.mjs with the same config marks the own project's gate.
  const file = join(b.root, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  const vote = spawnSync(process.execPath, [SCRIPT('vote.mjs'), '--config', file, 'G2'], { cwd: b.project, env: { PATH: process.env.PATH, HOME: join(b.root, 'home') }, encoding: 'utf8' });
  assert.deepEqual([vote.status, vote.stdout.trim()], [0, 'team votes: project/G1 project/G2']);
});

test('F-T132-2: a card of a project that left the config refuses each press with a private note, logs once, and gets no answer', async () => {
  const b = two();
  writeFileSync(`${b.statePath}.votes`, '["beta/G1","project/G1"]', { mode: 0o600 });
  b.bridge = b.with([['beta', b.betaSage], ['project', b.sage]], 'project');
  await b.post();
  const card = [...b.discord.messages.keys()].find((id) => b.discord.latest(id).embeds?.[0].title === 'Question beta/G1 · T1 Beta colours');
  const before = b.discord.messages.get(card).length;
  b.bridge = b.with([['project', b.sage]], 'project'); // beta left the config
  b.now += 60_000;
  for (let n = 0; n < 2; n++) assert.deepEqual((await b.press(MAYA, 'press:beta/G1:0:1')).map((r) => r.content), [GONE]);
  await b.bridge.loop();
  assert.equal(await b.answerOfBeta('G1'), '');
  // The one edit is the close of F-T132-8: no buttons, the note, and no answer on the card.
  assert.equal(b.discord.messages.get(card).length, before + 1);
  assert.deepEqual([buttons(b.discord.latest(card)), b.discord.latest(card).content], [[], GONE]);
  assert.equal(saved(b).entries.find((e) => e.gate.id === 'beta/G1').gate.outcome.status, 'open');
  assert.equal(b.lines.filter((l) => l.startsWith('beta/G1: its project is no longer in the config, so its card takes no press')).length, 1, b.lines.join('\n'));
});

test('F-T132-5: a stop and a failed edit before the redraw keep the mark; the old buttons work until an edit gives the keys', async () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Alpha export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  const old = await oldCard(b);
  b.bridge = b.make();
  assert.equal(saved(b).entries[0].oldButtons, true);
  b.bridge = b.make(); // a stop before the first loop: the file is version 4 now, and the mark is still in it
  const edit = b.discord.edit;
  b.discord.edit = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
  await b.bridge.loop();
  b.discord.edit = edit;
  assert.deepEqual([saved(b).entries[0].oldButtons, buttons(b.discord.latest(old))], [true, ['press:G1:0:0', 'press:G1:0:1']]);
  b.bridge = b.make(); // a restart after the failed edit
  b.now += 60_000;
  const replies = await b.press(MAYA, 'press:G1:0:1');
  assert.notEqual(replies[0]?.content, UNKNOWN);
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'B. JSON');
  assert.deepEqual([saved(b).entries[0].oldButtons, buttons(b.discord.latest(old))], [undefined, ['press:project/G1:0:0', 'press:project/G1:0:1']]);
  assert.equal((await b.press(MAYA, 'press:G1:0:0'))[0].content, UNKNOWN); // after the edit, an old button is unknown
});

test('F-T132-3: a settled card with old buttons answers an old press with the usual note, and the next loop gives it the keys too', async () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Alpha export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  b.sh('gate', 'answer', 'G1', 'A');
  const old = await oldCard(b, { by: CONFIG.ownerId, at: T0, option: 'A', text: 'A. CSV' });
  b.bridge = b.make();
  assert.equal((await b.press(MAYA, 'press:G1:0:1'))[0].content, 'Already answered by Erick at the terminal: A. CSV. Your press did not count.');
  await b.bridge.loop();
  assert.deepEqual(buttons(b.discord.latest(old)), ['press:project/G1:0:0', 'press:project/G1:0:1']);
  assert.equal(saved(b).entries[0].oldButtons, undefined);
  assert.equal(b.answerOf('G1'), 'A');
});

test('F-T132-6, G43 A: a session keeps the project of its first event, also for an event in another project\'s folder; a gate add for another --project changes nothing', () => {
  const b = two();
  const dir = `${b.statePath}.sessions`;
  const at = (cwd, extra = {}) => record({ session_id: S1, cwd, ...extra }, { projects: b.projects, dir, pid: process.pid, now: b.now, home: b.root });
  assert.equal(at(b.project, { hook_event_name: 'SessionStart' }), `SessionStart ${S1}`);
  const gateAdd = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node sage.mjs gate add T1 --question "Q?"' }, tool_response: { stdout: 'G7 open · Q?\n', stderr: '' } };
  assert.equal(at(b.beta, gateAdd), `PostToolUse ${S1}`);
  assert.equal(at(b.beta, { hook_event_name: 'SessionStart' }), `SessionStart ${S1}`);
  const toBeta = { ...gateAdd, tool_input: { command: `node sage.mjs gate add T1 --project ${b.beta}` }, tool_response: { stdout: 'G8 open · Q?\n' } };
  assert.equal(at(b.project, toBeta), 'another project');
  const spool = JSON.parse(readFileSync(join(dir, `${S1}.json`), 'utf8'));
  assert.deepEqual([spool.project, spool.cwd, spool.gates], ['project', b.project, ['G7']]);
});

test('F-T132-6: a settled card of a project that left the config sends no answer and logs no failure; the own project\'s answers still go', async () => {
  const b = two();
  writeFileSync(`${b.statePath}.votes`, '["beta/G1","project/G1"]', { mode: 0o600 });
  b.bridge = b.with([['beta', b.betaSage], ['project', b.sage]], 'project');
  await b.post();
  // beta's vote is decided, and sage of beta refuses the answer, so it is not sent when beta leaves the config.
  b.betaSage.answer = async () => { throw new Error('sample: sage is busy'); };
  b.now += 60_000;
  await b.press(MAYA, 'press:beta/G1:0:1');
  await b.bridge.loop();
  assert.deepEqual([saved(b).entries.find((e) => e.gate.id === 'beta/G1').sent, await b.answerOfBeta('G1')], [{}, '']);
  b.bridge = b.with([['project', b.sage]], 'project'); // beta left the config
  const lines = b.lines.length;
  await b.press(MAYA, 'press:project/G1:0:0');
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), await b.answerOfBeta('G1')], ['A. CSV', '']);
  assert.deepEqual(b.lines.slice(lines).filter((l) => /beta\/G1/.test(l)), []);
});

test('F-T132-8: a card of a project that left the config gets no reminder, is closed once with the note, and its thread can lock', async () => {
  const b = two();
  writeFileSync(`${b.statePath}.votes`, '["beta/G1","project/G1"]', { mode: 0o600 });
  const dir = `${b.statePath}.sessions`;
  const at = (event) => record({ session_id: S1, cwd: b.beta, hook_event_name: event }, { projects: b.projects, dir, pid: process.pid, now: b.now, home: b.root });
  at('SessionStart');
  b.bridge = b.with([['beta', b.betaSage], ['project', b.sage]], 'project');
  await b.post();
  const card = [...b.discord.messages.keys()].find((id) => b.discord.latest(id).embeds?.[0].title === 'Question beta/G1 · T1 Beta colours');
  const [thread] = [...b.discord.threads.keys()];
  assert.equal(b.discord.where.get(card), thread);
  b.bridge = b.with([['project', b.sage]], 'project'); // beta left the config
  b.shBeta('gate', 'answer', 'G1', 'B. Blue'); // Erick answers at the terminal; the bridge reads no beta logbook now
  const posts = b.discord.posts.length;
  for (let n = 0; n < 12; n++) { b.now += 30 * 60_000; await b.bridge.loop(); } // 6 hours, a loop every 30 minutes
  assert.deepEqual(b.discord.posts.slice(posts).filter((p) => /beta\/G1/.test(p.content ?? '')), []); // no reminder ping
  assert.equal(b.discord.messages.get(card).filter((p) => p.content === GONE).length, 1); // closed once
  assert.deepEqual(buttons(b.discord.latest(card)), []);
  assert.equal(b.discord.threads.get(thread).locked, false); // the session still runs
  at('SessionEnd');
  b.now += 30 * 60_000;
  await b.bridge.loop();
  assert.equal(b.discord.threads.get(thread).locked, true); // its question no longer counts as open (G15)
  assert.equal(b.lines.filter((l) => l === 'beta/G1: its project is no longer in the config, so the bridge closed its card; Erick answers it at the terminal').length, 1, b.lines.join('\n'));
});

test('F-T132-9: a renamed own project logs its cards and marks at the start, no misleading line, and a re-mark posts no second card', async () => {
  const b = setup({ markAll: false });
  for (const [n, q] of [[1, 'Which file type?'], [2, 'Which port?']]) {
    b.sh('task', 'add', '--title', `Task ${n}`, '--size', 'small');
    b.sh('gate', 'add', `T${n}`, '--question', q, '--options', 'A|B', '--recommend', 'A');
  }
  b.mark('G1', 'G2');
  await b.post();
  b.sh('task', 'add', '--title', 'Task 3', '--size', 'small');
  b.sh('gate', 'add', 'T3', '--question', 'Which name?', '--options', 'A|B', '--recommend', 'A');
  b.mark('G3'); // marked, but the bridge stops before its card
  const cards = () => [...b.discord.messages.keys()].map((id) => b.discord.messages.get(id)[0].embeds?.[0].title).filter(Boolean);
  assert.deepEqual(cards(), ['Question project/G1 · T1 Task 1', 'Question project/G2 · T2 Task 2']);
  // Erick renames the own project from `project` to `alpha` in projects.
  const lines = b.lines.length;
  b.bridge = createBridge({ sages: new Map([['alpha', b.sage]]), own: 'alpha', discord: b.discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  assert.deepEqual(b.lines.slice(lines), ["the gate file holds cards of project 'project', which is not in projects: G1, G2; the marks name gates of project 'project', which is not in projects: G1, G2, G3; keep a project's name as it was at its first start"]);
  await b.post();
  // sage marks the gates again, now under alpha.
  writeFileSync(`${b.statePath}.votes`, JSON.stringify(Object.fromEntries(['alpha/G1', 'alpha/G2', 'alpha/G3', 'project/G1', 'project/G2', 'project/G3'].map((k) => [k, b.project]))), { mode: 0o600 });
  b.now += 60_000;
  await b.post();
  assert.deepEqual(cards(), ['Question project/G1 · T1 Task 1', 'Question project/G2 · T2 Task 2', 'Question alpha/G3 · T3 Task 3']); // G3 had no card
  const after = b.lines.slice(lines + 1);
  assert.deepEqual(after.filter((l) => /did not mark it/.test(l)), []);
  assert.deepEqual(after.filter((l) => /stays at the terminal/.test(l)), [
    "alpha/G1 stays at the terminal: its card is project/G1, of project 'project', which is not in projects; keep a project's name as it was at its first start",
    "alpha/G2 stays at the terminal: its card is project/G2, of project 'project', which is not in projects; keep a project's name as it was at its first start",
    "alpha/G3 stays at the terminal: it has no mark of alpha; the mark is project/G3, of project 'project', which is not in projects; keep a project's name as it was at its first start",
  ]);
});
