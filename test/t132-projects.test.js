// T132: one bridge posts the cards and takes the votes of every project in the config. sage's gate ids start at G1 in each logbook,
// so the bridge names each gate by its key, `<project>/<gate id>`, in its gate file, the team votes file, the leads-only file, the
// reasons and the card buttons. SAMPLE DATA ONLY: scratch logbooks, made-up Discord ids, the fake Discord layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { record } from '../src/sessions.js';
import { sageTool } from '../src/sage.js';
import { load, loadVotes, saveVotes } from '../src/state.js';
import { openGate } from '../src/vote.js';
import { APPRENTICE, CHANNEL, CONFIG, JON, LEADR, MAYA, SAGE, setup, T0 } from './bridge-setup.js';

const UNKNOWN = 'I do not know this button or its question. Nothing changed.';
const VOTE = new URL('../scripts/vote.mjs', import.meta.url).pathname;
const S1 = 'bbbbbbbb-0000-4000-8000-000000000132';
const S2 = 'cccccccc-0000-4000-8000-000000000132';

/**
 * A bridge on two scratch projects, `project` (the bridge's own, from setup) and `beta`. Each logbook has its own task T1 and gate G1.
 * Both gates are marked as team votes by their keys.
 */
function twoProjects() {
  const b = setup({ markAll: false });
  b.beta = join(b.root, 'beta');
  mkdirSync(b.beta);
  const env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  b.shBeta = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', b.beta], { env, encoding: 'utf8' }).trim();
  b.shBeta('init');
  b.betaSage = sageTool({ sagePath: SAGE, project: b.beta, env });
  b.make = () => createBridge({ sages: new Map([['project', b.sage], ['beta', b.betaSage]]), own: 'project', discord: b.discord, config: CONFIG,
    statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  b.bridge = b.make();
  b.sh('task', 'add', '--title', 'Alpha export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  b.shBeta('task', 'add', '--title', 'Beta colours', '--size', 'small');
  b.shBeta('gate', 'add', 'T1', '--question', 'Which colour?', '--options', 'Red|Blue', '--recommend', 'Red');
  saveVotes(`${b.statePath}.votes`, new Set(['project/G1', 'beta/G1']));
  b.answerOfBeta = (id) => b.betaSage.gates().then((rows) => rows.find((r) => r.id === id).answer);
  return b;
}
const titles = (b) => b.discord.posts.filter((p) => p.embeds).map((p) => p.embeds[0].title);
const cardOf = (b, title) => [...b.discord.messages.keys()].find((id) => b.discord.messages.get(id)[0].embeds?.[0].title === title);
const buttons = (payload) => payload.components.flatMap((row) => row.components.map((c) => c.custom_id));

test('T132: two projects with a G1 each get two cards; a press on one records its answer in its own logbook and never touches the other', async () => {
  const b = twoProjects();
  await b.post();
  assert.deepEqual(titles(b), ['Question project/G1 · T1 Alpha export', 'Question beta/G1 · T1 Beta colours']);
  // The ping names the project, and the buttons carry the key of the gate.
  assert.deepEqual(b.discord.posts.map((p) => p.content), [
    `<@&${APPRENTICE}> <@&${LEADR}> project T1 needs one product answer. The first answer is final.`,
    `<@&${APPRENTICE}> <@&${LEADR}> beta T1 needs one product answer. The first answer is final.`]);
  const beta = cardOf(b, 'Question beta/G1 · T1 Beta colours');
  const alpha = cardOf(b, 'Question project/G1 · T1 Alpha export');
  assert.deepEqual(buttons(b.discord.latest(beta)), ['press:beta/G1:0:0', 'press:beta/G1:0:1']);
  b.now += 60_000;
  await b.press(MAYA, 'press:beta/G1:0:1');
  assert.equal(await b.answerOfBeta('G1'), 'B. Blue');
  assert.equal(b.answerOf('G1'), ''); // the own project's G1 is still open
  assert.match(b.discord.latest(beta).embeds[0].description, /Answered by Maya at <t:\d+:t>: B\. Blue\. Final\./);
  assert.doesNotMatch(b.discord.latest(alpha).embeds[0].description, /Answered/);
  await b.press(JON, 'press:project/G1:0:0');
  assert.deepEqual([b.answerOf('G1'), await b.answerOfBeta('G1')], ['A. CSV', 'B. Blue']);
  assert.ok(b.lines.includes('sage gate beta/G1 answered: B. Blue'), b.lines.join('\n'));
  assert.ok(b.lines.includes('sage gate project/G1 answered: A. CSV'), b.lines.join('\n'));
  assert.deepEqual(load(b.statePath, 'project').entries.map((e) => [e.gate.id, e.sage]), [['project/G1', ['G1']], ['beta/G1', ['G1']]]);
});

test('T132, G10: Erick\'s answer at the terminal in one project is final there, and the same gate id of the other project keeps voting', async () => {
  const b = twoProjects();
  await b.post();
  b.shBeta('gate', 'answer', 'G1', 'A');
  await b.bridge.loop();
  const beta = cardOf(b, 'Question beta/G1 · T1 Beta colours');
  assert.match(b.discord.latest(beta).embeds[0].description, /Answered by Erick \(terminal\) at <t:\d+:t>: A\. Red\. Final\./);
  const late = await b.press(MAYA, 'press:beta/G1:0:1');
  assert.equal(late[0].content, 'Already answered by Erick at the terminal: A. Red. Your press did not count.');
  assert.equal(await b.answerOfBeta('G1'), 'A');
  await b.press(MAYA, 'press:project/G1:0:1'); // the own project's G1 is another gate: the press counts
  assert.equal(b.answerOf('G1'), 'B. JSON');
});

test('T132: a button id without a project, or with a project that the config does not list, is refused and changes nothing', async () => {
  const b = twoProjects();
  await b.post();
  for (const forged of ['press:G1:0:0', 'press:gamma/G1:0:0', 'press:beta/G9:0:0', 'press:Beta/G1:0:0', 'press:/G1:0:0', 'press:project/beta/G1:0:0']) {
    const replies = await b.press(MAYA, forged);
    assert.equal(replies[0].content, UNKNOWN, forged);
  }
  assert.deepEqual([b.answerOf('G1'), await b.answerOfBeta('G1')], ['', '']);
  // A gate file entry whose key does not match its sage ids, or has no project, is refused at load.
  const file = JSON.parse(readFileSync(b.statePath, 'utf8'));
  for (const id of ['G1', 'beta/G2', 'Beta/G1', 'beta/G1/G1']) {
    writeFileSync(b.statePath, JSON.stringify({ ...file, entries: [{ ...file.entries[1], gate: { ...file.entries[1].gate, id } }] }), { mode: 0o600 });
    assert.throws(() => load(b.statePath, 'project'), { message: 'the gate file has an entry that the bridge did not write' }, id);
  }
});

test('T132: a session in another project gets its thread in the home channel, titled with its project', async () => {
  const b = twoProjects();
  const projects = [{ name: 'project', project: b.project }, { name: 'beta', project: b.beta }];
  record({ session_id: S1, cwd: b.beta, hook_event_name: 'SessionStart' }, { projects, dir: `${b.statePath}.sessions`, pid: process.pid, now: b.now });
  await b.post();
  const [thread] = [...b.discord.threads.values()];
  assert.equal(thread.name, 'Session 1 · beta · Sun 4 Oct');
  assert.deepEqual(b.discord.in([...b.discord.threads.keys()][0]).map((id) => b.discord.messages.get(id)[0].embeds?.[0].title), ['Question beta/G1 · T1 Beta colours']);
  assert.deepEqual(b.discord.in(CHANNEL).map((id) => b.discord.messages.get(id)[0]).map((p) => p.embeds?.[0].title ?? p.content.split('\n')[0]),
    ['Question project/G1 · T1 Alpha export', '**Session 1 · beta · Sun 4 Oct**']); // no session of the own project runs: its card is in the home channel
});

test('T132 migration: a gate file, a team votes file and a spool file of the time before T132 load as the own project, and keep working', async () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Alpha export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  b.sh('gate', 'add', 'T1', '--question', 'Which date format?', '--options', 'ISO|Locale', '--recommend', 'ISO');
  // The files as the bridge and vote.mjs wrote them before T132: bare gate ids, version 2, a spool with no project.
  const gate = openGate({ id: 'G1', kind: 'single', options: ['A', 'B'], askedBy: CONFIG.ownerId, at: T0 });
  const ask = { kind: 'single', task: 'T1', title: 'Alpha export', parts: [{ question: 'Which file type?', why: 'CSV', recommended: 'A', options: { A: 'CSV', B: 'JSON' } }] };
  const old = await b.discord.post(CHANNEL, { content: 'the card of G1, posted before T132', components: [{ type: 1, components: [{ custom_id: 'press:G1:0:0' }] }] });
  mkdirSync(join(b.root, 'state'), { recursive: true, mode: 0o700 });
  writeFileSync(b.statePath, JSON.stringify({ version: 2, entries: [{ gate, ask, sage: ['G1'], texts: [['CSV', 'JSON']], message: old, remindedAt: T0, sent: {}, session: null }], sessions: [] }), { mode: 0o600 });
  writeFileSync(`${b.statePath}.votes`, '["G1","G2"]', { mode: 0o600 });
  mkdirSync(`${b.statePath}.sessions`, { mode: 0o700 });
  writeFileSync(join(`${b.statePath}.sessions`, `${S2}.json`), JSON.stringify({ id: S2, cwd: b.project, startedAt: T0, pid: process.pid, gates: ['G2'], tasks: ['T1'] }), { mode: 0o600 });

  b.bridge = b.make();
  const saved = JSON.parse(readFileSync(b.statePath, 'utf8'));
  assert.deepEqual([saved.version, saved.entries.map((e) => e.gate.id)], [3, ['project/G1']]); // migrated at the start
  await b.post();
  // The open card gets its buttons with the key; a press on an old button is refused, a press on the new one counts.
  assert.deepEqual(buttons(b.discord.latest(old)), ['press:project/G1:0:0', 'press:project/G1:0:1']);
  assert.equal((await b.press(MAYA, 'press:G1:0:1'))[0].content, UNKNOWN);
  await b.press(MAYA, 'press:project/G1:0:1');
  assert.equal(b.answerOf('G1'), 'B. JSON');
  // G2, a bare id in the old team votes file, is the own project's; the old spool lists it, so its card goes to that session's thread.
  const [[threadId, thread]] = [...b.discord.threads];
  assert.equal(thread.name, 'Session 1 · project · Sun 4 Oct');
  assert.deepEqual(b.discord.in(threadId).map((id) => b.discord.messages.get(id)[0].embeds?.[0].title), ['Question project/G2 · T1 Alpha export']);
  assert.deepEqual([...loadVotes(`${b.statePath}.votes`)], ['project/G1', 'project/G2']);
});

test('T132: the hook records a session in every listed project, the deepest one for nested folders, and ignores every other folder', () => {
  const b = setup();
  const outer = join(b.root, 'outer');
  const inner = join(outer, 'inner');
  const elsewhere = join(b.root, 'elsewhere');
  for (const dir of [join(inner, 'src'), elsewhere]) mkdirSync(dir, { recursive: true });
  const projects = [{ name: 'project', project: b.project }, { name: 'outer', project: outer }, { name: 'inner', project: inner }];
  const dir = `${b.statePath}.sessions`;
  const ids = ['dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004'];
  const start = (id, cwd) => record({ session_id: id, cwd, hook_event_name: 'SessionStart' }, { projects, dir, pid: process.pid, now: b.now });
  assert.deepEqual([start(ids[0], b.project), start(ids[1], outer), start(ids[2], join(inner, 'src')), start(ids[3], elsewhere)],
    [`SessionStart ${ids[0]}`, `SessionStart ${ids[1]}`, `SessionStart ${ids[2]}`, 'outside the projects']);
  const spool = (id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
  assert.deepEqual(ids.slice(0, 3).map((id) => [spool(id).project, spool(id).cwd]), [['project', b.project], ['outer', outer], ['inner', inner]]);
  // A gate add of a session in `outer` for the nested project `inner` is not this session's project: it is ignored.
  const add = (id, project) => record({ session_id: id, cwd: outer, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: `node sage.mjs gate add T3 --project ${project} --question "Q?"` }, tool_response: { stdout: 'G3 open · Q?\n', stderr: '' } },
  { projects, dir, pid: process.pid, now: b.now, home: b.root });
  assert.equal(add(ids[1], inner), 'another project');
  assert.equal(add(ids[1], outer), `PostToolUse ${ids[1]}`);
  assert.deepEqual(spool(ids[1]).gates, ['G3']);
  // scripts/hook.mjs reads the projects of the config: a session in the second listed project is recorded.
  const config = join(b.root, 'hook-config.json');
  writeFileSync(config, JSON.stringify({ project: b.project, sagePath: SAGE, statePath: b.statePath, projects: projects.map((p) => ({ ...p })) }));
  const run = spawnSync(process.execPath, [new URL('../scripts/hook.mjs', import.meta.url).pathname, '--config', config],
    { input: JSON.stringify({ session_id: S1, cwd: inner, hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  assert.deepEqual([run.status, run.stdout, run.stderr, spool(S1).project], [0, '', '', 'inner']);
});

test('T132: vote.mjs marks the gates of the project that --project names, the own project without it, and refuses a project that the config does not list', () => {
  const b = setup({ markAll: false });
  const home = join(b.root, 'home');
  const config = join(b.root, 'vote-config.json');
  mkdirSync(join(b.root, 'beta')); // a listed folder that does not exist is refused (F-T132-14)
  writeFileSync(config, JSON.stringify({ project: b.project, sagePath: SAGE, statePath: b.statePath,
    projects: [{ name: 'project', project: b.project }, { name: 'beta', project: join(b.root, 'beta') }] }));
  const vote = (...args) => {
    const r = spawnSync(process.execPath, [VOTE, '--config', config, ...args], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  assert.deepEqual(vote('--project', 'beta', 'G1', 'G2'), { code: 0, out: 'team votes: beta/G1 beta/G2', err: '' });
  assert.deepEqual(vote('G1'), { code: 0, out: 'team votes: beta/G1 beta/G2 project/G1', err: '' });
  assert.deepEqual(vote('--project', 'beta', '--unmark', 'G1'), { code: 0, out: 'team votes: beta/G2 project/G1', err: '' });
  assert.deepEqual(vote('--project', 'nope', 'G1'), { code: 1, out: '', err: 'sage-bot vote: the project "nope" is not in the config\'s projects (project, beta). Nothing changed.' });
  assert.deepEqual(vote('--project', 'nope', '--list'), { code: 1, out: '', err: 'sage-bot vote: the project "nope" is not in the config\'s projects (project, beta). Nothing changed.' });
  assert.equal(readFileSync(`${b.statePath}.votes`, 'utf8'), '["beta/G2","project/G1"]');
});
