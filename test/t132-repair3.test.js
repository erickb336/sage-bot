// T132 repair round 3: vote.mjs and reasons.mjs take the project of the cwd (F-T132-13); a listed folder that does not exist stops the
// start (F-T132-14); a closed card of a project that returns gets its buttons back (F-T132-15); a card is closed once in total, also across
// restarts and in a locked thread (F-T132-16). SAMPLE DATA ONLY: scratch logbooks, made-up ids, the fake Discord layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { prepare } from '../src/discord.js';
import { sageTool } from '../src/sage.js';
import { record } from '../src/sessions.js';
import { CONFIG, execFileSync, MAYA, SAGE, setup, spawnSync } from './bridge-setup.js';

const SCRIPT = (name) => new URL(`../scripts/${name}`, import.meta.url).pathname;
const GONE = 'This question\'s project is no longer served; Erick answers it at the terminal.';
const CLOSED = 'beta/G1: its project is no longer in the config, so the bridge closed its card; Erick answers it at the terminal';
const S1 = 'eeeeeeee-0000-4000-8000-000000000133';

/** The own project `project` and a second one, `beta`, each with its own logbook, task T1 and gate G1, both marked. */
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
  writeFileSync(`${b.statePath}.votes`, '["beta/G1","project/G1"]', { mode: 0o600 });
  b.projects = [{ name: 'project', project: b.project, sagePath: SAGE, own: true }, { name: 'beta', project: b.beta, sagePath: SAGE }];
  b.both = () => createBridge({ sages: new Map([['project', b.sage], ['beta', b.betaSage]]), own: 'project', discord: b.discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  b.ownOnly = () => createBridge({ sages: new Map([['project', b.sage]]), own: 'project', discord: b.discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  b.answerOfBeta = (id) => b.betaSage.gates().then((rows) => rows.find((r) => r.id === id).answer);
  b.betaCard = () => [...b.discord.messages.keys()].find((id) => b.discord.messages.get(id)[0].embeds?.[0].title === 'Question beta/G1 · T1 Beta colours');
  return b;
}
const buttons = (payload) => (payload.components ?? []).flatMap((row) => row.components.map((c) => c.custom_id));
/** The text above the embed as Discord shows it: an edit without `content` keeps the last one. */
const contentOf = (b, id) => b.discord.messages.get(id).findLast((p) => 'content' in p).content;
const shutOf = (b) => JSON.parse(readFileSync(b.statePath, 'utf8')).entries.find((e) => e.gate.id === 'beta/G1').shut;
const run = (script, config, cwd, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT(script), '--config', config, ...args], { cwd, env: { PATH: process.env.PATH, HOME: join(cwd, 'no-home') }, encoding: 'utf8' });
  return [r.status, r.stdout.trim(), r.stderr.trim()];
};

test('F-T132-13, F-T132-22: without --project, vote.mjs and reasons.mjs take the listed project whose folder holds the cwd, and refuse in any other folder', () => {
  const b = two();
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify({ project: b.project, sagePath: SAGE, statePath: b.statePath, projects: b.projects }));
  mkdirSync(join(b.beta, 'src'));
  assert.deepEqual(run('vote.mjs', config, b.beta, 'G3'), [0, 'team votes: beta/G1 beta/G3 project/G1', '']);
  assert.deepEqual(run('vote.mjs', config, join(b.beta, 'src'), 'G4'), [0, 'team votes: beta/G1 beta/G3 beta/G4 project/G1', '']);
  // In no listed folder: one line that asks for --project, and the votes file does not change (G45 A, F-T132-22).
  const votes = readFileSync(`${b.statePath}.votes`, 'utf8');
  const refused = `no listed project's folder holds ${b.root}. Name the project with --project <name> (project, beta). Nothing changed.`;
  assert.deepEqual(run('vote.mjs', config, b.root, 'G5'), [1, '', `sage-bot vote: ${refused}`]);
  assert.equal(readFileSync(`${b.statePath}.votes`, 'utf8'), votes);
  // --project works from anywhere.
  assert.deepEqual(run('vote.mjs', config, b.root, '--project', 'project', 'G5')[1], 'team votes: beta/G1 beta/G3 beta/G4 project/G1 project/G5');
  assert.deepEqual(run('vote.mjs', config, b.beta, '--project', 'project', 'G6')[1], 'team votes: beta/G1 beta/G3 beta/G4 project/G1 project/G5 project/G6');
  const usage = 'usage: node scripts/reasons.mjs [--config <config.json>] [--project <name>] <gate id>';
  assert.deepEqual(run('reasons.mjs', config, b.beta, 'G9'), [1, '', `sage-bot reasons: no bridge gate beta/G9. ${usage}`]);
  assert.deepEqual(run('reasons.mjs', config, b.root, 'G9'), [1, '', `sage-bot reasons: ${refused}`]);
  assert.deepEqual(run('reasons.mjs', config, b.root, '--project', 'project', 'G9'), [1, '', `sage-bot reasons: no bridge gate project/G9. ${usage}`]);
});

test('F-T132-14: a listed folder that does not exist stops the bridge before the lock, and vote.mjs and reasons.mjs refuse it, with one line', () => {
  const b = two();
  rmSync(b.beta, { recursive: true });
  const line = `the folder of project beta (${b.beta}) does not exist. Fix its path in projects, or take the project out. Nothing changed.`;
  const file = { ...CONFIG, guildId: '200000000000000001', project: b.project, sagePath: SAGE, statePath: b.statePath, projects: b.projects };
  // prepare is all that src/discord.js start runs before it reads the Keychain: its throw stops the start there.
  assert.throws(() => prepare(file, () => {}), { message: line });
  assert.deepEqual([existsSync(`${b.statePath}.lock`), existsSync(`${b.statePath}.channels`)], [false, false]);
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify(file));
  const votes = readFileSync(`${b.statePath}.votes`, 'utf8');
  assert.deepEqual(run('vote.mjs', config, b.root, '--project', 'beta', 'G2'), [1, '', `sage-bot vote: ${line}`]);
  assert.deepEqual(run('vote.mjs', config, b.root, 'G2'), [1, '', `sage-bot vote: ${line}`]);
  assert.equal(readFileSync(`${b.statePath}.votes`, 'utf8'), votes);
  assert.deepEqual(run('reasons.mjs', config, b.root, 'G1'), [1, '', `sage-bot reasons: ${line}`]);
});

test('F-T132-15: a closed card of a project that returns gets no reminder until its buttons are back; then a press counts and the card shows it', async () => {
  const b = two();
  b.bridge = b.both();
  await b.post();
  const card = b.betaCard();
  b.bridge = b.ownOnly(); // beta leaves the config
  await b.bridge.loop();
  assert.deepEqual([buttons(b.discord.latest(card)), b.discord.latest(card).content, shutOf(b)], [[], GONE, true]);
  b.bridge = b.both(); // beta is in the config again, but Discord refuses edits for a while
  const edit = b.discord.edit;
  b.discord.edit = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
  const posts = b.discord.posts.length;
  for (let n = 0; n < 6; n++) { b.now += 30 * 60_000; await b.bridge.loop(); } // 3 hours: a reminder would be due
  assert.deepEqual(b.discord.posts.slice(posts).filter((p) => /beta\/G1/.test(p.content ?? '')), []);
  assert.equal(b.discord.latest(card).content, GONE);
  b.discord.edit = edit;
  await b.bridge.loop();
  assert.deepEqual([buttons(b.discord.latest(card)), b.discord.latest(card).content, shutOf(b)], [['press:beta/G1:0:0', 'press:beta/G1:0:1'], '', undefined]);
  await b.press(MAYA, 'press:beta/G1:0:1');
  await b.bridge.loop();
  assert.equal(await b.answerOfBeta('G1'), 'B. Blue');
  assert.match(b.discord.latest(card).embeds[0].description, /Blue/);
  assert.equal(contentOf(b, card), '');
});

test('F-T132-16: across restarts a card of a removed project is edited and logged once in total; a locked thread gives one line, then reopens', async () => {
  const b = two();
  const dir = `${b.statePath}.sessions`;
  const at = (event) => record({ session_id: S1, cwd: b.beta, hook_event_name: event }, { projects: b.projects, dir, pid: process.pid, now: b.now, home: b.root });
  at('SessionStart');
  b.bridge = b.both();
  await b.post();
  const card = b.betaCard();
  const before = b.discord.messages.get(card).length;
  for (let n = 0; n < 3; n++) { b.bridge = b.ownOnly(); await b.bridge.loop(); await b.bridge.loop(); } // three restarts with beta removed
  assert.equal(b.discord.messages.get(card).length, before + 1);
  assert.equal(b.lines.filter((l) => l === CLOSED).length, 1, b.lines.join('\n'));

  // A second card of beta: its first close fails, the session ends, and the bridge locks the thread before the next try (G15).
  const c = two();
  const at2 = (event) => record({ session_id: S1, cwd: c.beta, hook_event_name: event }, { projects: c.projects, dir: `${c.statePath}.sessions`, pid: process.pid, now: c.now, home: c.root });
  at2('SessionStart');
  c.bridge = c.both();
  await c.post();
  const card2 = c.betaCard();
  const thread = c.discord.where.get(card2);
  at2('SessionEnd');
  c.bridge = c.ownOnly();
  const edit = c.discord.edit;
  c.discord.edit = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
  await c.bridge.loop();
  c.discord.edit = edit;
  assert.equal(c.discord.threads.get(thread).locked, true);
  assert.equal(c.lines.filter((l) => l === 'Discord refused the edit of beta/G1: code -, status 503: Service Unavailable').length, 1);
  const locked = 'beta/G1: its project is no longer in the config, and Discord cannot edit its card (code 50083, status 400: Thread is locked), so the bridge leaves it; Erick answers it at the terminal';
  const lines = c.lines.length;
  for (let n = 0; n < 3; n++) { await c.bridge.loop(); c.bridge = c.ownOnly(); await c.bridge.loop(); } // three restarts
  assert.deepEqual(c.lines.slice(lines).filter((l) => /beta\/G1/.test(l) && !/^the gate file holds/.test(l)), [locked]);
  assert.equal(c.discord.latest(card2).content, c.discord.messages.get(card2)[0].content); // never edited
  // beta returns: its question counts as open again, so the thread opens, and the card gets its buttons.
  c.bridge = c.both();
  const back = c.lines.length;
  await c.bridge.loop();
  assert.equal(c.discord.threads.get(thread).locked, false);
  assert.deepEqual(buttons(c.discord.latest(card2)), ['press:beta/G1:0:0', 'press:beta/G1:0:1']);
  assert.deepEqual([contentOf(c, card2), c.lines.slice(back).filter((l) => /refused/.test(l))], ['', []]);
});
