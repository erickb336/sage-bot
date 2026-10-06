// T132 repair round 5 (G45 A): each card, mark and session holds the folder of its project, so a name that the owner points at another
// folder never sends an answer to that folder's logbook (F-T132-21); vote.mjs and reasons.mjs refuse outside the listed folders
// (F-T132-22, in t132-repair3.test.js); a spool of the time before T132 is never written over (F-T132-23); a symlink path to a folder
// outside git (F-T132-24) and a `~` path (F-T132-25) are refused at load. SAMPLE DATA ONLY: scratch logbooks, made-up ids, the fake
// Discord layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { loadProjects } from '../src/projects.js';
import { sageTool } from '../src/sage.js';
import { record, sessionOf } from '../src/sessions.js';
import { loadVotes, saveVotes, writeWhole } from '../src/state.js';
import { CONFIG, execFileSync, MAYA, SAGE, setup } from './bridge-setup.js';

const NOTE = 'This question\'s project is no longer served; Erick answers it at the terminal.';
const S1 = 'eeeeeeee-0000-4000-8000-000000000145';

/**
 * The own project `project` and two more folders, beta and gamma, each with its own logbook. beta asks "Which colour?" (G1) and
 * "Which font?" (G2); gamma asks "Delete the prod database?" (G1) and "Drop the users table?" (G2). Nothing is marked yet.
 */
function three() {
  const b = setup({ markAll: false });
  const env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  for (const [name, asks] of [['beta', [['Which colour?', 'Red|Blue'], ['Which font?', 'Serif|Sans']]], ['gamma', [['Delete the prod database?', 'Keep|Delete'], ['Drop the users table?', 'Keep|Drop']]]]) {
    const folder = join(b.root, name);
    mkdirSync(folder);
    const sh = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', folder], { env, encoding: 'utf8' }).trim();
    sh('init');
    for (const [n, [question, options]] of asks.entries()) {
      sh('task', 'add', '--title', `${name} task ${n + 1}`, '--size', 'small');
      sh('gate', 'add', `T${n + 1}`, '--question', question, '--options', options, '--recommend', options.split('|')[0]);
    }
    b[name] = { folder, sh, sage: sageTool({ sagePath: SAGE, project: folder, env }), answer: (id) => answerOf(folder, sh, id) };
  }
  /** A bridge whose names point at these folders, for example { beta: 'gamma' }: the name beta for the folder gamma. */
  b.with = (names) => createBridge({ sages: new Map([['project', b.sage], ...Object.entries(names).map(([n, f]) => [n, b[f].sage])]), own: 'project',
    discord: b.discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  /** Marks gates as scripts/vote.mjs does: by their key, with the folder that the name names (G45 A). */
  b.markAs = (name, folder, ...ids) => saveVotes(`${b.statePath}.votes`, new Map([...loadVotes(`${b.statePath}.votes`), ...ids.map((id) => [`${name}/${id}`, b[folder].folder])]));
  b.cardOf = (title) => [...b.discord.messages.keys()].find((id) => b.discord.messages.get(id)[0].embeds?.[0].title.startsWith(`Question ${title} `));
  b.pressOn = async (message, customId) => {
    const i = fakeInteraction({ user: MAYA, customId, message });
    await b.bridge.interaction(i);
    return i.replies.map((r) => r.content ?? r.embeds?.[0]?.title);
  };
  return b;
}
/** The answer of a sage gate in a logbook, from its gates.tsv. */
function answerOf(folder, sh, id) {
  const [head, ...rows] = readFileSync(join(sh('logbook'), 'gates.tsv'), 'utf8').split('\n').filter(Boolean);
  const col = head.split('\t').indexOf('answer');
  return rows.map((r) => r.split('\t')).find((v) => v[0] === id)[col];
}

test('F-T132-21: beta is pointed at the folder gamma: the old card closes once, a press on it records nothing in gamma, and an answer at gamma\'s terminal never shows on it', async () => {
  const b = three();
  b.markAs('beta', 'beta', 'G1', 'G2');
  b.bridge = b.with({ beta: 'beta' });
  await b.post();
  const [old1, old2] = [b.cardOf('beta/G1'), b.cardOf('beta/G2')];
  assert.ok(old1 && old2);
  // Erick points the name beta at the folder gamma, whose G1 is "Delete the prod database?", and restarts the bridge.
  const lines = b.lines.length;
  b.bridge = b.with({ beta: 'gamma' });
  assert.deepEqual(b.lines.slice(lines), [`the gate file holds cards of project 'beta', of the folder ${b.beta.folder}, which projects no longer give that name: G1, G2; the marks name gates of project 'beta', of the folder ${b.beta.folder}, which projects no longer give that name: G1, G2; keep a project's name as it was at its first start`]);
  const edits = (id) => b.discord.messages.get(id).length;
  await b.bridge.loop();
  assert.deepEqual([b.discord.latest(old1).content, b.discord.latest(old1).components], [NOTE, []]);
  assert.deepEqual([b.discord.latest(old2).content, b.discord.latest(old2).components], [NOTE, []]);
  // The old marks do not count for gamma: no card is posted for gamma's G1 or G2.
  b.now += 60_000;
  await b.post();
  assert.equal(b.cardOf('beta/G1'), old1);
  assert.ok(b.lines.includes(`beta/G1 stays at the terminal: its mark is of the folder ${b.beta.folder}, not of beta's folder now. Mark it again with scripts/vote.mjs`));
  // Maya presses B on the old card (an old copy with its buttons): nothing goes to gamma, or to beta.
  assert.deepEqual(await b.pressOn(old1, 'press:beta/G1:0:1'), [NOTE]);
  await b.bridge.loop();
  assert.deepEqual([b.gamma.answer('G1'), b.beta.answer('G1')], ['', '']);
  // An answer at gamma's terminal never shows as final on the old card.
  const before = edits(old1);
  b.gamma.sh('gate', 'answer', 'G1', 'A. Keep');
  await b.bridge.loop();
  assert.equal(edits(old1), before);
  assert.deepEqual(b.lines.filter((l) => /answered at the terminal: the card shows it as final/.test(l)), []);
  // sage marks gamma's G2 under the name beta: a new card with the key beta/G2. Only a press on that card counts for gamma.
  b.markAs('beta', 'gamma', 'G2');
  b.now += 60_000;
  await b.post();
  const fresh = [...b.discord.messages.keys()].filter((id) => b.discord.messages.get(id)[0].embeds?.[0].title.startsWith('Question beta/G2 ')).find((id) => id !== old2);
  assert.ok(fresh);
  assert.deepEqual(await b.pressOn(old2, 'press:beta/G2:0:1'), [NOTE]);
  await b.bridge.loop();
  assert.deepEqual([b.gamma.answer('G2'), b.beta.answer('G2')], ['', '']);
  await b.pressOn(fresh, 'press:beta/G2:0:1');
  await b.bridge.loop();
  assert.deepEqual([b.gamma.answer('G2'), b.beta.answer('G2')], ['B. Drop', '']);
  // The gate file keeps both cards of the key beta/G2, each with its folder.
  const saved = JSON.parse(readFileSync(b.statePath, 'utf8'));
  assert.deepEqual(saved.entries.filter((e) => e.gate.id === 'beta/G2').map((e) => e.folder).sort(), [b.beta.folder, b.gamma.folder].sort());
});

test('F-T132-21: two names swap their folders: both old cards close, and a press on either records nothing in either logbook', async () => {
  const b = three();
  b.markAs('beta', 'beta', 'G1');
  b.markAs('gamma', 'gamma', 'G1');
  b.bridge = b.with({ beta: 'beta', gamma: 'gamma' });
  await b.post();
  const [cardB, cardG] = [b.cardOf('beta/G1'), b.cardOf('gamma/G1')];
  b.bridge = b.with({ beta: 'gamma', gamma: 'beta' });
  await b.bridge.loop();
  assert.deepEqual([b.discord.latest(cardB).content, b.discord.latest(cardG).content], [NOTE, NOTE]);
  assert.deepEqual(await b.pressOn(cardB, 'press:beta/G1:0:1'), [NOTE]);
  assert.deepEqual(await b.pressOn(cardG, 'press:gamma/G1:0:1'), [NOTE]);
  b.now += 60_000;
  await b.post();
  assert.deepEqual([b.beta.answer('G1'), b.gamma.answer('G1')], ['', '']);
  assert.equal(b.discord.posts.length, 2); // no new card: the old marks do not count for the swapped folders
});

test('G45 A: a gate file and marks of the time before the folders migrate once, log it once, and keep working for an unchanged config', async () => {
  const b = three();
  b.markAs('beta', 'beta', 'G1');
  b.bridge = b.with({ beta: 'beta' });
  await b.post();
  const card = b.cardOf('beta/G1');
  // The files as the build before G45 A wrote them: version 3 with no folder, and a list of keys.
  const data = JSON.parse(readFileSync(b.statePath, 'utf8'));
  writeWhole(b.statePath, JSON.stringify({ ...data, version: 3, entries: data.entries.map(({ folder, ...e }) => e) }));
  writeWhole(`${b.statePath}.votes`, '["beta/G1","gone/G4"]');
  const lines = b.lines.length;
  b.bridge = b.with({ beta: 'beta' });
  const update = `one-time update: each card and mark now holds the folder of its project (project: ${b.project}, beta: ${b.beta.folder}); a card or mark of a name that is not in projects gets no folder and stays at the terminal`;
  assert.deepEqual(b.lines.slice(lines), [update, "the marks name gates of project 'gone', which is not in projects: G4; keep a project's name as it was at its first start"]);
  const saved = JSON.parse(readFileSync(b.statePath, 'utf8'));
  assert.deepEqual([saved.version, saved.entries.map((e) => e.folder)], [4, [b.beta.folder]]);
  assert.equal(readFileSync(`${b.statePath}.votes`, 'utf8'), JSON.stringify({ 'beta/G1': b.beta.folder, 'gone/G4': null }));
  // The card still works: Maya's press records the answer in beta.
  await b.pressOn(card, 'press:beta/G1:0:1');
  await b.bridge.loop();
  assert.equal(b.beta.answer('G1'), 'B. Blue');
  // Once only: the next start logs no update.
  const again = b.lines.length;
  b.bridge = b.with({ beta: 'beta' });
  assert.deepEqual(b.lines.slice(again).filter((l) => l.startsWith('one-time update')), []);
});

test('F-T132-23: a spool of the time before T132 whose cwd is in no listed folder is of the own project; a spool that cannot be read is never written over', () => {
  const b = setup({ markAll: false });
  const dir = `${b.statePath}.sessions`;
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, `${S1}.json`);
  const projects = [{ name: 'project', project: b.project, own: true }];
  const elsewhere = join(b.root, 'elsewhere');
  mkdirSync(elsewhere);
  writeWhole(file, JSON.stringify({ id: S1, cwd: elsewhere, startedAt: 1, pid: process.pid, gates: ['G1'], tasks: ['T1'] }));
  const at = (event) => record({ session_id: S1, cwd: elsewhere, hook_event_name: event }, { projects, dir, pid: process.pid, now: b.now, home: b.root });
  assert.equal(at('SessionStart'), `SessionStart ${S1}`);
  const spool = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([spool.project, spool.cwd, spool.gates, spool.tasks], ['project', b.project, ['G1'], ['T1']]);
  // A spool that the hook did not write: the event is refused, and the file stays as it is.
  writeWhole(file, '{"id":"not a session","gates":["G1"]}');
  assert.throws(() => at('SessionEnd'), { message: 'not a spool file of the sage-bot hook' });
  assert.equal(readFileSync(file, 'utf8'), '{"id":"not a session","gates":["G1"]}');
});

test('F-T132-24: a listed symlink path to a folder outside git is refused at load; the same link to a folder in git loads as its real path', () => {
  const b = setup({ markAll: false });
  const link = join(b.root, 'link');
  symlinkSync(b.project, link);
  const config = { project: link, projects: [{ name: 'project', project: link, sagePath: SAGE }] };
  assert.throws(() => loadProjects(config), { message: `the path of project project (${link}) is a link to ${b.project}, and the folder is not in git, so the sage state tool keeps its logbook by the path as written. Write the real path in projects. Nothing changed.` });
  execFileSync('git', ['init', '-q', b.project]);
  assert.equal(loadProjects(config)[0].project, b.project);
});

test('F-T132-25: a `~` in the config\'s project or in a listed path gives "must be an absolute path", before anything reads the disk', () => {
  const b = setup({ markAll: false });
  assert.throws(() => loadProjects({ project: '~/alpha', projects: [{ name: 'alpha', project: b.project, sagePath: SAGE }] }), { message: 'the config: project must be an absolute path' });
  assert.throws(() => loadProjects({ project: b.project, projects: [{ name: 'alpha', project: '~/alpha', sagePath: SAGE }] }), { message: 'projects[0].project must be an absolute path' });
});

test('F-T132-21: a session that the name had in its old folder never takes a card of the new folder', () => {
  const spool = (id, cwd) => [id, { id, project: 'beta', cwd, startedAt: 1_000, pid: 1, gates: ['G1'], tasks: ['T1'] }];
  const S2 = 'eeeeeeee-0000-4000-8000-000000000146';
  const rows = [{ id: 'G1', at: new Date(2_000).toISOString() }];
  const ended = () => false;
  assert.equal(sessionOf(rows, new Map([spool(S1, '/Users/you/beta')]), ended, 'beta', '/Users/you/gamma'), null);
  assert.equal(sessionOf(rows, new Map([spool(S1, '/Users/you/beta'), spool(S2, '/Users/you/gamma')]), ended, 'beta', '/Users/you/gamma'), S2);
});
