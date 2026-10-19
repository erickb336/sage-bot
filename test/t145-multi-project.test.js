// T145: the multi-project follow-ups (F-T145-1 to F-T145-5, F-T145-L1 to F-T145-L10). Through the fake Discord layer and scratch
// sage logbooks. SAMPLE DATA ONLY: every id, name and answer is made up. HOME and SAGE_HOME are in a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openLog } from '../src/audit.js';
import { createBridge, LOOP } from '../src/bridge.js';
import { prepare } from '../src/discord.js';
import { loadProjects } from '../src/projects.js';
import { sagePath, sagePlugin, sageToolIn, sageTool } from '../src/sage.js';
import { record } from '../src/sessions.js';
import { writeWhole } from '../src/state.js';
import { tempFolder } from './temp-folder.js';
import { CONFIG, execFileSync, MAYA, MEMBERS, SAGE, setup, spawnSync, toolOf } from './bridge-setup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const S1 = 'eeeeeeee-0000-4000-8000-000000000145';
const SCRIPT = (name) => join(ROOT, 'scripts', name);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Sample', '-c', 'user.email=sample@example.com', ...args], { stdio: 'ignore' });

/** The own project `project` and a second one, `beta`, each with its own logbook, task T1 and gate G1, both marked. */
function two() {
  const b = setup({ markAll: false });
  b.beta = join(b.root, 'beta');
  mkdirSync(b.beta);
  b.shBeta = toolOf(b, b.beta);
  b.shBeta('init');
  b.betaSage = sageTool({ sagePath: SAGE, project: b.beta, env: b.env });
  b.sh('task', 'add', '--title', 'Alpha export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  b.shBeta('task', 'add', '--title', 'Beta colours', '--size', 'small');
  b.shBeta('gate', 'add', 'T1', '--question', 'Which colour?', '--options', 'Red|Blue', '--recommend', 'Red');
  writeWhole(`${b.statePath}.votes`, JSON.stringify({ 'beta/G1': b.beta, 'project/G1': b.project }));
  const make = (sages) => createBridge({ sages: new Map(sages), own: 'project', discord: b.discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  b.both = () => make([['project', b.sage], ['beta', b.betaSage]]);
  b.ownOnly = () => make([['project', b.sage]]);
  b.betaCard = () => [...b.discord.messages.keys()].find((id) => b.discord.messages.get(id)[0].embeds?.[0].title === 'Question beta/G1 · T1 Beta colours');
  return b;
}
const shutOf = (b) => JSON.parse(readFileSync(b.statePath, 'utf8')).entries.find((e) => e.gate.id === 'beta/G1').shut;
const refuse = (code, message) => Promise.reject(Object.assign(new Error(message), { code, status: code === 10008 ? 404 : 403 }));

test('F-T145-4: two listed folders of one sage logbook (a repository and its subfolder, two worktrees) are refused at load with one line; folders outside git load', () => {
  const b = setup({ markAll: false });
  const mono = join(b.root, 'mono');
  const app = join(mono, 'app');
  mkdirSync(app, { recursive: true });
  git('init', '-q', mono);
  git('-C', mono, 'commit', '-q', '--allow-empty', '-m', 'sample');
  const config = (second) => ({ project: b.project, sagePath: SAGE, projects: [{ name: 'project', project: b.project }, { name: 'mono', project: mono }, second] });
  const shared = (name, path) => `projects mono (${mono}) and ${name} (${path}) share one sage logbook, the logbook of ${mono}. Keep one of them in projects. Nothing changed.`;
  assert.throws(() => loadProjects(config({ name: 'app', project: app })), { message: shared('app', app) });
  const tree = join(b.root, 'mono-tree');
  git('-C', mono, 'worktree', 'add', '-q', tree);
  assert.throws(() => loadProjects(config({ name: 'tree', project: tree })), { message: shared('tree', tree) });
  // The bridge stops at load, before its lock (prepare is all that start runs before the Keychain).
  const file = { ...CONFIG, guildId: '200000000000000001', statePath: b.statePath, ...config({ name: 'app', project: app }) };
  assert.throws(() => prepare(file, () => {}), { message: shared('app', app) });
  assert.equal(existsSync(`${b.statePath}.lock`), false);
  // Two folders outside git, one inside the other, have a logbook each, so they load.
  const sub = join(b.project, 'sub');
  mkdirSync(sub);
  assert.deepEqual(loadProjects(config({ name: 'sub', project: sub })).map((p) => p.name), ['project', 'mono', 'sub']);
});

test('F-T145-1, F-T145-L2: a returned card whose message is gone (10008) logs once, loses its mark and gets its reminders again', async () => {
  const b = two();
  b.bridge = b.both();
  await b.post();
  const card = b.betaCard();
  b.discord.deleteMessage(card); // a member deleted the card
  b.bridge = b.ownOnly(); // beta leaves the config: the close finds the message gone, and the card gets the mark
  await b.bridge.loop();
  assert.equal(shutOf(b), true);
  b.bridge = b.both(); // beta is back
  const posts = b.discord.posts.length;
  for (let n = 0; n < 6; n++) { b.now += 30 * 60_000; await b.bridge.loop(); } // 3 hours: a reminder is due
  assert.equal(shutOf(b), undefined);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('Discord refused the edit of beta/G1')),
    ['Discord refused the edit of beta/G1: code 10008, status 404: Unknown Message. Discord can never take this edit, so the bridge stops trying it']);
  assert.equal(b.discord.posts.slice(posts).filter((p) => /^<@&\d+> reminder: beta\/G1 waits/.test(p.content ?? '')).length, 1);
});

test('F-T145-1: a redraw that Discord refuses with 50001 logs once and backs off (the back-off of F-T45-3); a 10008 logs once and is not tried again', async () => {
  for (const [code, message, tries] of [[50001, 'Missing Access', 4], [10008, 'Unknown Message', 1]]) {
    const members = structuredClone(MEMBERS);
    const b = setup({ members });
    b.sh('gate', 'add', 'T1', '--question', 'Which page?', '--options', 'x|y', '--recommend', 'x');
    await b.post();
    const [id] = b.discord.messages.keys();
    const real = b.discord.edit;
    let n = 0;
    b.discord.edit = (target, m, payload) => (m === id ? (n++, refuse(code, message)) : real(target, m, payload));
    members[1].roles = []; // Maya loses the sage-crew role: each open card is redrawn
    for (let i = 0; i < 10; i++) { await b.bridge.loop(); b.now += LOOP; }
    assert.equal(b.lines.filter((l) => l.startsWith('Discord refused the edit of project/G1')).length, 1, `${code}: ${b.lines.join('\n')}`);
    assert.equal(n, tries, String(code));
  }
});

test('F-T145-2: a marks file that is not 0600, or a lock that a vote run holds, is logged once and the bridge runs; the update and the cards follow', async () => {
  const b = setup({ markAll: false });
  b.sh('gate', 'add', 'T1', '--question', 'Which page?', '--options', 'x|y', '--recommend', 'x');
  const votes = `${b.statePath}.votes`;
  mkdirSync(dirname(votes), { recursive: true, mode: 0o700 });
  writeFileSync(votes, '["G1"]', { mode: 0o644 }); // a list of the time before T132, readable by others
  chmodSync(votes, 0o644);
  b.bridge = b.make(); // before: this start threw, so launchd started it again and again
  await b.post();
  const update = (why) => `the one-time update of the marks did not run; the bridge tries again at each loop: ${why}`;
  const mode = `the team votes file ${votes} must be a regular file of this user with mode 0600. Nothing was loaded.`;
  assert.deepEqual(b.lines.filter((l) => l.startsWith('the one-time update')), [update(mode)]);
  assert.equal(b.discord.posts.length, 0);
  chmodSync(votes, 0o600);
  await b.post();
  assert.equal(readFileSync(votes, 'utf8'), JSON.stringify({ 'project/G1': b.project }));
  assert.equal(b.discord.posts.length, 1);

  // A lock of a live vote run (this test's parent process): the start waits its 2 s, logs, and runs on.
  const c = setup({ markAll: false });
  mkdirSync(dirname(`${c.statePath}.votes`), { recursive: true, mode: 0o700 });
  writeWhole(`${c.statePath}.votes`, '["G1"]');
  writeFileSync(`${c.statePath}.votes.lock`, String(process.ppid));
  c.bridge = c.make();
  assert.deepEqual(c.lines.filter((l) => l.startsWith('the one-time update')), [update(`another sage-bot run (pid ${process.ppid}) holds ${c.statePath}.votes.lock. If none runs, remove ${c.statePath}.votes.lock. Nothing changed.`)]);
  rmSync(`${c.statePath}.votes.lock`);
  await c.bridge.loop();
  assert.equal(readFileSync(`${c.statePath}.votes`, 'utf8'), JSON.stringify({ 'project/G1': c.project }));
});

test('F-T145-3, F-T145-L8: a relative or ~ listed path is refused at load, by its place in the list, before pickProject can see it; the hook says the same', () => {
  const b = setup({ markAll: false });
  for (const path of ['beta', '~/beta']) {
    const config = { project: b.project, sagePath: SAGE, statePath: b.statePath, projects: [{ name: 'project', project: b.project }, { name: 'alpha', project: b.project.replace(/project$/, 'alpha') }, { name: 'beta', project: path }] };
    assert.throws(() => loadProjects(config), { message: 'projects[2].project must be an absolute path' });
    const file = join(b.root, 'config.json');
    writeFileSync(file, JSON.stringify(config));
    const r = spawnSync(process.execPath, [SCRIPT('hook.mjs'), '--config', file], { input: '{}', env: { PATH: process.env.PATH, HOME: join(b.root, 'no-home') }, encoding: 'utf8' });
    assert.equal(r.stderr, 'sage-bot hook: nothing recorded: projects[2].project must be an absolute path\n');
  }
});

test('F-T145-5: a card whose gate id now names another question in its logbook gives sage no answer, and the log says so once', async () => {
  const b = setup();
  b.sh('task', 'add', '--title', 'Export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  await b.post();
  // The logbook now has another gate under G1 (an update keyed the card to a project whose logbook is another one).
  const path = join(b.sh('logbook'), 'gates.tsv');
  writeFileSync(path, readFileSync(path, 'utf8').replace('Which file type?', 'Which file type for the archive?'));
  await b.press(MAYA, 'press:project/G1:0:0');
  for (let i = 0; i < 2; i++) { b.now += LOOP; await b.bridge.loop(); }
  assert.equal(b.answerOf('G1'), '');
  assert.deepEqual(b.lines.filter((l) => l.includes('another question')), [
    'project/G1: the logbook of project has another question or other options under G1 than its card, so the bridge gives sage no answer; Erick answers it at the terminal',
  ]);
});

test('F-T145-8: the check of F-T145-5 reads the question as the logbook wrote it: a card saved before it, or framed by another safe(), still gives sage its answer', async () => {
  const b = setup();
  b.sh('task', 'add', '--title', 'Notes', '--size', 'small');
  b.sh('task', 'add', '--title', 'Paths', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Keep ~/notes | archive?', '--options', 'Keep|Drop', '--recommend', 'Keep');
  b.sh('gate', 'add', 'T2', '--question', 'Move ~/old | ~/new?', '--options', 'Move|Stay', '--recommend', 'Move');
  await b.post();
  // The cards as an older bridge saved them: its safe() kept ~ and |. G1's entry is from before F-T145-8 (no raw question); G2's has one.
  const file = JSON.parse(readFileSync(b.statePath, 'utf8'));
  for (const e of file.entries) e.ask.parts[0].question = e.gate.id === 'project/G1' ? 'Keep ~/notes | archive?' : 'Move ~/old | ~/new?';
  delete file.entries.find((e) => e.gate.id === 'project/G1').questions;
  assert.deepEqual(file.entries.find((e) => e.gate.id === 'project/G2').questions, ['Move ~/old | ~/new?']);
  writeWhole(b.statePath, JSON.stringify(file));
  b.bridge = b.make();
  await b.press(MAYA, 'press:project/G1:0:0');
  await b.press(MAYA, 'press:project/G2:0:0');
  for (let i = 0; i < 2; i++) { b.now += LOOP; await b.bridge.loop(); }
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['Keep', 'Move']);
  assert.deepEqual(b.lines.filter((l) => l.includes('another question')), []);
});

test('F-T145-7: two submodules of one superproject, and two repositories whose git folders sit in one folder, have a logbook each, so they load', () => {
  const b = setup({ markAll: false });
  const at = (name) => join(b.root, name);
  const repo = (path) => { git('init', '-q', path); git('-C', path, 'commit', '-q', '--allow-empty', '-m', 'sample'); };
  repo(at('lib1'));
  repo(at('lib2'));
  repo(at('super'));
  git('-c', 'protocol.file.allow=always', '-C', at('super'), 'submodule', 'add', '-q', at('lib1'), 'one');
  git('-c', 'protocol.file.allow=always', '-C', at('super'), 'submodule', 'add', '-q', at('lib2'), 'two');
  mkdirSync(at('gits'));
  git('init', '-q', '--separate-git-dir', join(at('gits'), 'x.git'), at('sx'));
  git('init', '-q', '--separate-git-dir', join(at('gits'), 'y.git'), at('sy'));
  const list = [['project', b.project], ['one', join(at('super'), 'one')], ['two', join(at('super'), 'two')], ['sx', at('sx')], ['sy', at('sy')]];
  const config = { project: b.project, sagePath: SAGE, projects: list.map(([name, project]) => ({ name, project })) };
  assert.deepEqual(loadProjects(config).map((p) => [p.name, p.project]), list);
});

test('F-T145-6: a gate add from a linked worktree of the session\'s repository outside its folder counts, as sage writes it in that logbook', () => {
  const b = setup({ markAll: false });
  const mono = join(b.root, 'mono');
  const out = join(b.root, 'mono-out');
  git('init', '-q', mono);
  git('-C', mono, 'commit', '-q', '--allow-empty', '-m', 'sample');
  git('-C', mono, 'worktree', 'add', '-q', out, '-b', 'out');
  const dir = `${b.statePath}.sessions`;
  const projects = loadProjects({ project: mono, sagePath: SAGE, projects: [{ name: 'mono', project: mono }, { name: 'project', project: b.project }] });
  const at = (cwd, extra) => record({ session_id: S1, cwd, ...extra }, { projects, dir, pid: process.pid, now: b.now, home: b.root });
  const gateAdd = (command, id) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: `${id} open · Q?\n`, stderr: '' } });
  assert.equal(at(mono, { hook_event_name: 'SessionStart' }), `SessionStart ${S1}`);
  assert.equal(at(out, gateAdd('node sage.mjs gate add T1 --question "Q?"', 'G1')), `PostToolUse ${S1}`);
  assert.equal(at(b.project, gateAdd(`node sage.mjs gate add T1 --project ${out}`, 'G2')), `PostToolUse ${S1}`);
  assert.equal(at(b.project, gateAdd('node sage.mjs gate add T1', 'G3')), 'another project'); // the other listed project's logbook
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${S1}.json`), 'utf8')).gates, ['G1', 'G2']);
});

test('F-T145-L1: launchd.mjs refuses a config whose listed folder is missing, with the line of the bridge, and writes no plist', () => {
  const b = setup({ markAll: false });
  const gone = join(b.root, 'gone');
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify({ ...CONFIG, guildId: '200000000000000001', project: b.project, sagePath: SAGE, statePath: b.statePath, projects: [{ name: 'project', project: b.project }, { name: 'gone', project: gone }] }));
  const out = join(b.root, 'com.sage.bot.plist');
  const r = spawnSync(process.execPath, [SCRIPT('launchd.mjs'), config, '--out', out], { env: { PATH: process.env.PATH, HOME: join(b.root, 'no-home') }, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stderr], [1, `sage-bot launchd: in the config file ${config}, the folder of project gone (${gone}) does not exist. Fix its path in projects, or take the project out. No plist written: ${out} is unchanged.\n`]);
  assert.equal(existsSync(out), false);
});

test('F-T145-L3: a sage-lead log folder inside a project folder, written in another letter case, is refused', () => {
  const b = setup({ markAll: false });
  const projects = loadProjects({ project: b.project, sagePath: SAGE, projects: [{ name: 'project', project: b.project }] });
  const upper = join(b.root, 'PROJECT', 'logs'); // the same folder on this Mac's file system, which ignores letter case
  assert.throws(() => openLog(join(upper, 'leads.jsonl'), projects), { message: `the audit log folder ${upper} is in the project folder of project: a session there could change it. Put auditPath outside every project. Nothing was started.` });
  const outside = join(b.root, 'logs');
  assert.equal(openLog(join(outside, 'leads.jsonl'), projects).broken, null);
});

test('F-T145-L6: a marks file refused at run time posts nothing and logs it once, never "x.get is not a function"', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Which page?', '--options', 'x|y', '--recommend', 'x');
  chmodSync(`${b.statePath}.votes`, 0o644);
  await b.post();
  await b.post();
  assert.equal(b.discord.posts.length, 0);
  assert.deepEqual(b.lines.filter((l) => /is not a function|could not read the logbook/.test(l)), []);
  assert.equal(b.lines.filter((l) => l.startsWith('no gate is posted: the team votes file')).length, 1);
});

test('F-T145-L9: the demo\'s lookup of the state tool reads HOME: a sage plugin in a scratch HOME is found there', () => {
  const home = tempFolder('sage-bot-t145-home-');
  const tool = sageToolIn(sagePlugin(join(home, '.claude')).cache, '6ea307ffa7b5');
  cpSync(join(dirname(SAGE), '..', '..'), join(tool, '..', '..', '..'), { recursive: true });
  assert.equal(sagePath({ env: { HOME: home } }), tool);
});

test('F-T145-L10: the test setup finds the pinned sage in a repository whose path has a space', () => {
  const copy = join(realpathSync.native(tempFolder('sage-bot-t145-space-')), 'a repo'); // the real path, as node loads a module (TMPDIR may be under /var)
  for (const part of ['src', 'test/bridge-setup.js', 'test/temp-folder.js', 'test/fixtures/sage', 'package.json']) cpSync(join(ROOT, part), join(copy, part), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'));
  const setupFile = join(copy, 'test', 'bridge-setup.js');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(setupFile).href)}); console.log(m.FIXTURE)`], { env: { PATH: process.env.PATH, HOME: copy, TMPDIR: copy, SAGE_TOOL: '' }, encoding: 'utf8' });
  assert.equal(r.stdout, `${join(copy, 'test', 'fixtures', 'sage', '6ea307ffa7b5', 'skills', 'sage', 'sage.mjs')}\n`, r.stderr);
});
