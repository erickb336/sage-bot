// T73, the owner's decision G18 item 8: sage marks a Yes or No question "leads only" with scripts/vote.mjs --leads. Only the
// sage-leads can answer its card; their answer reaches sage as a recommendation, and the owner decides at the terminal (G10).
// sage-bot never switches a mode of sage. Through the fake Discord layer and a scratch sage logbook.
// SAMPLE DATA ONLY: every id, name and question is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { load, saveVotes } from '../src/state.js';
import { MINUTE } from '../src/vote.js';
import { SETTLE } from '../src/bridge.js';
import { APPRENTICE, CHANNEL, JON, MAYA, MEMBERS, OWNER, SAGE, SAM, setup } from './bridge-setup.js';

const LEAD = '300000000000000002';
const VOTE = new URL('../scripts/vote.mjs', import.meta.url).pathname;
const QUESTION = ['Switch the automatic-merge mode on for this session?', 'Yes|No'];
const NOTE = { kind: 'reply', content: 'Only a sage-lead can answer this. Erick decides.', flags: 64, allowedMentions: { parse: [] } };

/**
 * The phrases that switch sage's modes, built from their words so that this file never holds one: no text of the bridge may hold any.
 * (The words come from the sage dictionary's rows for the two modes.)
 */
const [MODE, PILOT] = [['sage', 'mode'].join(' '), ['auto', 'pilot'].join('')];
const SWITCHES = [MODE, PILOT, [PILOT, 'on'], [PILOT, 'off'], [MODE, 'off'], [MODE, PILOT]].map((p) => [p].flat().join(' ').toLowerCase());
const switchesIn = (text) => SWITCHES.filter((p) => text.toLowerCase().includes(p));

/** Runs scripts/vote.mjs with HOME in the scratch folder and the scratch config (with the scratch logbook) as the default config file. */
function vote(b, ...args) {
  return voteWith(b, { sagePath: SAGE }, ...args);
}
/** The same with `sage` as the sage fields of the config: { sagePath } or {} for none. */
function voteWith(b, sage, ...args) {
  const home = join(b.root, 'home');
  mkdirSync(join(home, '.config', 'sage-bot'), { recursive: true });
  writeFileSync(join(home, '.config', 'sage-bot', 'config.json'), JSON.stringify({ statePath: b.statePath, ...sage, project: b.project }));
  const env = { PATH: process.env.PATH, HOME: home, SAGE_HOME: join(home, 'sage') };
  const r = spawnSync(process.execPath, [VOTE, ...args], { cwd: b.project, env, encoding: 'utf8' }); // sage runs it in the project's folder
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
/** A scratch project where sage asked the mode question as G1 of T1 and marked it leads only; the card is posted. */
async function asked({ question = QUESTION[0], options = QUESTION[1], members } = {}) {
  const b = setup({ markAll: false, ...(members && { members }) });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', question, '--options', options, '--recommend', 'No');
  saveVotes(`${b.statePath}.votes.leads`, new Map([['project/G1', b.project]]));
  await b.post();
  return b;
}
const cards = (b) => b.discord.posts.filter((p) => p.embeds);
/** The description of the card as it is now, after its edits. */
const text = (b) => b.discord.latest(b.discord.in(CHANNEL).find((id) => b.discord.messages.get(id)[0].embeds)).embeds[0].description;

test('T73: vote.mjs --leads marks one gate, --unmark clears it, and a batch is refused with nothing changed', () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Ship it?', '--options', 'Yes|No', '--recommend', 'No');
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  const leadsFile = `${b.statePath}.votes.leads`;
  assert.deepEqual(vote(b, 'G2'), { code: 0, out: 'team votes: project/G2', err: '' });
  assert.deepEqual(vote(b, '--leads', 'G2'), { code: 0, out: 'team votes: none\nleads only: project/G2', err: '' }); // a mark moves the gate
  assert.equal(readFileSync(leadsFile, 'utf8'), JSON.stringify({ 'project/G2': b.project }));
  assert.deepEqual(vote(b, '--leads', 'G3', 'G4'), { code: 1, out: '',
    err: 'sage-bot vote: a leads-only question is one Yes or No question, never a batch: give one gate id to --leads, not 2. Nothing changed.' });
  assert.deepEqual(vote(b, '--list'), { code: 0, out: 'team votes: none\nleads only: project/G2', err: '' });
  assert.deepEqual(vote(b, '--unmark', 'G2'), { code: 0, out: 'team votes: none', err: '' });
  assert.equal(readFileSync(leadsFile, 'utf8'), '{}');
});

test('T73: the card of a leads-only question pings sage-lead only and is titled as a recommendation for Erick', async () => {
  const b = await asked();
  assert.deepEqual(b.discord.posts.map((p) => [p.content, p.allowedMentions.roles, p.embeds?.[0].title]), [[
    `<@&${LEAD}> project T1 asks the sage-leads for a recommendation to Erick. The first sage-lead answer is the recommendation; Erick decides at the terminal.`,
    [LEAD], 'Recommend for Erick: Question project/G1 · T1 Ship the export page',
  ]]);
  assert.match(text(b), /\*\*Who can answer:\*\* every sage-lead$/);
  assert.equal(b.lines.filter((l) => l.includes('merge')).length, 0); // a leads-only question about a merge is posted, not kept at the terminal
  // The 2-hour reminder pings sage-lead only too.
  b.now += 2 * 60 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual(b.discord.posts.at(-1).allowedMentions.roles, [LEAD]);
});

test('T73: an apprentice press gets the leads-only note, a press with no role gets no reply (G20), and sage gets nothing', async () => {
  const b = await asked();
  b.now += MINUTE;
  assert.deepEqual(await b.press(MAYA, 'press:project/G1:0:0'), [NOTE]);
  assert.deepEqual(await b.press(SAM, 'press:project/G1:0:0'), []);
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), '');
  assert.doesNotMatch(text(b), /Recommended by/);
});

test('T73: a lead\'s press records the answer in sage, posts the recommendation note and prints one terminal line, with no switch phrase in any text', async () => {
  const b = await asked();
  b.now += MINUTE;
  const replies = await b.press(JON, 'press:project/G1:0:0');
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'A. Yes (sage-leads recommend; the owner decides)'); // never the owner's plain "A. Yes" (F-T73-1)
  assert.deepEqual(b.discord.posts.at(-1), { content: 'Recommendation recorded: Jon recommends Yes. Erick decides at the terminal.', allowedMentions: { parse: [] } });
  assert.deepEqual(b.lines.filter((l) => l.includes('G1')), ['sage gate project/G1 answered: A. Yes (sage-leads recommend; the owner decides)',
    'project/G1: sage-leads recommend Yes. If you agree, switch the mode yourself at the terminal.']);
  assert.deepEqual((await b.sage.decisions()).map((d) => d.decision), ['Switch the automatic-merge mode on for this session? → A. Yes (sage-leads recommend; the owner decides)']);
  assert.match(text(b), /\*\*Recommended by Jon \(sage-lead\) at <t:\d+:t>: A\. Yes\. Erick decides at the terminal\.\*\*/);
  // Every text that the bridge and vote.mjs made: the posts and edits, the replies, the log and the output of sage's command.
  const all = JSON.stringify([[...b.discord.messages.values()], replies, b.lines, vote(b, '--list'), vote(b, '--leads', 'G1', 'G2')]);
  assert.deepEqual(switchesIn(all), []);
  assert.deepEqual(switchesIn(`Turn ${SWITCHES[2]} now`), [PILOT, SWITCHES[2]]); // the check finds a phrase when one is there
});

test('T73: a leads-only question whose options are not Yes and No gets no card', async () => {
  const b = await asked({ options: 'Merge now|Wait' });
  assert.deepEqual(cards(b), []);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('not posted')), ['not posted: project: G1 is leads only, and a leads-only question needs the options Yes|No. Answer them at the terminal.']);
});

test('T73: a bad leads-only file is refused at load: no card, one log line, and vote.mjs stops with the same reason', async () => {
  const b = setup({ markAll: false });
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  const leadsFile = `${b.statePath}.votes.leads`;
  mkdirSync(join(b.root, 'state'), { recursive: true, mode: 0o700 });
  writeFileSync(leadsFile, '{"G1":true}', { mode: 0o600 });
  await b.post();
  const why = `the leads-only file ${leadsFile} must be a JSON object of sage gate keys (a project name, a slash, G and digits) and their folders. Nothing was loaded.`;
  assert.deepEqual(cards(b), []);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('no gate')), [`no gate is posted: ${why}`]);
  assert.deepEqual(vote(b, '--list'), { code: 1, out: '', err: `sage-bot vote: ${why}` });
  writeFileSync(leadsFile, '["G1"]');
  chmodSync(leadsFile, 0o644);
  assert.match(vote(b, '--list').err, /the leads-only file .* must be a regular file of this user with mode 0600/);
});

test('T73, G10: Erick\'s answer at the terminal wins, before a lead\'s press and after the leads\' recommendation', async () => {
  const before = await asked();
  before.sh('gate', 'answer', 'G1', 'B. No');
  before.now += MINUTE;
  assert.deepEqual((await before.press(JON, 'press:project/G1:0:0')).map((r) => r.content), ['Already answered by Erick at the terminal: B. No. Your press did not count.']);
  await before.bridge.loop();
  assert.equal(before.answerOf('G1'), 'B. No');
  assert.equal(before.lines.filter((l) => l.includes('recommend')).length, 0);

  const after = await asked();
  after.now += MINUTE;
  await after.press(JON, 'press:project/G1:0:0');
  assert.equal(after.answerOf('G1'), 'A. Yes (sage-leads recommend; the owner decides)');
  after.sh('gate', 'answer', 'G1', 'B. No');
  after.now += MINUTE;
  await after.bridge.loop();
  await after.bridge.loop();
  assert.equal(after.answerOf('G1'), 'B. No');
  assert.match(text(after), /\*\*Answered by Erick \(terminal\) at <t:\d+:t>: B\. No\. Final\.\*\*/);
});

test('F-T73-1: Erick\'s own "A. Yes" at the terminal after the leads\' Yes is his final answer, and the bridge never writes over it', async () => {
  const b = await asked();
  b.now += MINUTE;
  await b.press(JON, 'press:project/G1:0:0');
  b.sh('gate', 'answer', 'G1', 'A. Yes');
  for (let n = 0; n < 3; n++) { b.now += MINUTE; await b.bridge.loop(); }
  assert.equal(b.answerOf('G1'), 'A. Yes');
  assert.match(text(b), /\*\*Answered by Erick \(terminal\) at <t:\d+:t>: A\. Yes\. Final\.\*\*/);
  assert.deepEqual(b.lines.filter((l) => l.endsWith('was answered at the terminal: the card shows it as final')), ['project/G1 was answered at the terminal: the card shows it as final']);
});

test('F-T73-1: vote.mjs --leads refuses a gate that is not the automatic-merge question, and writes nothing', () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Merge PR 18 now?', '--options', 'Yes|No', '--recommend', 'No');
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', 'On|Off', '--recommend', 'Off');
  assert.deepEqual(vote(b, '--leads', 'G1'), { code: 1, out: '',
    err: `sage-bot vote: G1 is leads only, and a leads-only question must be the automatic-merge question, word for word: "${QUESTION[0]}". Nothing changed.` });
  assert.deepEqual(vote(b, '--leads', 'G2'), { code: 1, out: '', err: 'sage-bot vote: G2 is leads only, and a leads-only question needs the options Yes|No. Nothing changed.' });
  assert.deepEqual(vote(b, '--leads', 'G9'), { code: 1, out: '', err: `sage-bot vote: G9 is not a gate of the sage project project. Nothing changed.` });
  assert.equal(existsSync(`${b.statePath}.votes`) || existsSync(`${b.statePath}.votes.leads`), false);
});

test('F-T73-1: the bridge posts no card for a hand-marked leads-only gate that is not the automatic-merge question', async () => {
  const b = await asked({ question: 'Merge PR 18 now?' });
  assert.deepEqual(cards(b), []);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('not posted')),
    [`not posted: project: G1 is leads only, and a leads-only question must be the automatic-merge question, word for word: "${QUESTION[0]}". Answer them at the terminal.`]);
  assert.equal(b.answerOf('G1'), '');
});

test('F-T73-2: a gate in both the team votes file and the leads-only file gets no card and one log line', async () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  saveVotes(`${b.statePath}.votes`, new Map([['project/G1', b.project]]));
  saveVotes(`${b.statePath}.votes.leads`, new Map([['project/G1', b.project]]));
  await b.post();
  await b.bridge.loop();
  assert.deepEqual(cards(b), []);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('project/G1')),
    ['project/G1 stays at the terminal: it is in both the team votes file and the leads-only file. Mark it again with scripts/vote.mjs']);
  // A mark again moves it to one list, and the card comes.
  assert.equal(vote(b, '--leads', 'G1').code, 0);
  await b.post();
  assert.equal(cards(b).length, 1);
});

test('F-T73-2: a mark that moves a gate saves the file that loses it first, then the file that gains it', () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  const savedAt = (path) => statSync(path, { bigint: true }).mtimeNs;
  const [votesFile, leadsFile] = [`${b.statePath}.votes`, `${b.statePath}.votes.leads`];
  assert.equal(vote(b, '--leads', 'G1').out, 'team votes: none\nleads only: project/G1');
  assert.ok(savedAt(votesFile) < savedAt(leadsFile), 'to leads only: the team votes file first');
  assert.equal(vote(b, 'G1').out, 'team votes: project/G1');
  assert.ok(savedAt(leadsFile) < savedAt(votesFile), 'to a team vote: the leads-only file first');
});

test('F-T73-11: a team vote and the leads-only question of one task, asked together, get two cards, and the leads-only one is never in the batch', async () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Ship it?', '--options', 'Yes|No', '--recommend', 'No');
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  b.mark('G1');
  saveVotes(`${b.statePath}.votes.leads`, new Map([['project/G2', b.project]]));
  await b.post();
  assert.deepEqual(cards(b).map((p) => [p.embeds[0].title, p.allowedMentions.roles]), [
    ['Question project/G1 · T1 Ship the export page', [APPRENTICE, LEAD]],
    ['Recommend for Erick: Question project/G2 · T1 Ship the export page', [LEAD]],
  ]);
  b.now += MINUTE;
  assert.deepEqual(await b.press(MAYA, 'press:project/G2:0:0'), [NOTE]);
  await b.bridge.loop();
  assert.equal(b.answerOf('G2'), '');
});

/** Runs `during` once, when the bridge opens `path`: so it falls between the bridge's reads of the two files. */
function onFirstOpen(path, during) {
  const open = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (p === path) { fs.openSync = open; syncBuiltinESMExports(); during(); }
    return open(p, ...rest);
  };
  syncBuiltinESMExports();
}

test('F-T73-12: a --leads move between the bridge\'s two reads logs no "in both" line, and the card comes; a gate truly in both still gets none', async () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  b.mark('G1');
  // The bridge reads the team votes file (G1 in it), then sage moves G1 to leads only, then the bridge reads the leads-only file.
  let moved;
  onFirstOpen(`${b.statePath}.votes.leads`, () => { moved = vote(b, '--leads', 'G1'); });
  await b.bridge.loop();
  assert.deepEqual(moved, { code: 0, out: 'team votes: none\nleads only: project/G1', err: '' });
  b.now += SETTLE;
  await b.bridge.loop();
  assert.deepEqual(b.lines.filter((l) => l.includes('both')), []);
  assert.deepEqual(cards(b).map((p) => p.embeds[0].title), ['Recommend for Erick: Question project/G1 · T1 Ship the export page']);
  // A gate that stays in both files after the second read gets no card and one line.
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  b.mark('G2');
  saveVotes(`${b.statePath}.votes.leads`, new Map([['project/G1', b.project], ['project/G2', b.project]]));
  await b.post();
  await b.bridge.loop();
  assert.equal(cards(b).length, 1);
  assert.deepEqual(b.lines.filter((l) => l.includes('both')),
    ['project/G2 stays at the terminal: it is in both the team votes file and the leads-only file. Mark it again with scripts/vote.mjs']);
});

test('F-T73-3: the terminal line after a No recommendation says to do nothing, and after a Yes says to switch the mode', async () => {
  const no = await asked();
  no.now += MINUTE;
  await no.press(JON, 'press:project/G1:0:1');
  await no.bridge.loop();
  assert.equal(no.answerOf('G1'), 'B. No (sage-leads recommend; the owner decides)');
  assert.deepEqual(no.discord.posts.at(-1).content, 'Recommendation recorded: Jon recommends No. Erick decides at the terminal.');
  assert.deepEqual(no.lines.filter((l) => l.startsWith('project/G1:')), ['project/G1: sage-leads recommend No. If you agree, do nothing; the mode stays off.']);
  const yes = await asked();
  yes.now += MINUTE;
  await yes.press(JON, 'press:project/G1:0:0');
  assert.deepEqual(yes.lines.filter((l) => l.startsWith('project/G1:')), ['project/G1: sage-leads recommend Yes. If you agree, switch the mode yourself at the terminal.']);
});

test('F-T73-4: a gate file with ask.leads on a batch or with a value other than true is refused at load', async () => {
  const b = await asked();
  const file = JSON.parse(readFileSync(b.statePath, 'utf8'));
  assert.equal(file.entries[0].ask.leads, true);
  assert.equal(load(b.statePath).entries[0].ask.leads, true); // the file as the bridge wrote it loads
  const refused = (edit) => {
    const copy = structuredClone(file);
    edit(copy.entries[0]);
    writeFileSync(b.statePath, JSON.stringify(copy));
    return () => load(b.statePath);
  };
  assert.throws(refused((e) => { e.ask.kind = 'batch'; }), { message: 'the gate file has an entry that the bridge did not write' });
  assert.throws(refused((e) => { e.ask.leads = 'yes'; }), { message: 'the gate file has an entry that the bridge did not write' });
  assert.throws(refused((e) => { e.ask.leads = false; }), { message: 'the gate file has an entry that the bridge did not write' });
});

test('F-T73-5: a press after the recommendation, also Erick\'s own, gets a note that it is a recommendation and did not count', async () => {
  const done = 'Already recommended by Jon (sage-lead): A. Yes. A recommendation only; Erick decides at the terminal. Your press did not count.';
  const b = await asked();
  b.now += MINUTE;
  await b.press(JON, 'press:project/G1:0:0');
  b.now += MINUTE;
  assert.deepEqual((await b.press(OWNER, 'press:project/G1:0:1')).map((r) => r.content), [done]);
  assert.deepEqual((await b.press(JON, 'press:project/G1:0:1')).map((r) => r.content), [done]);
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'A. Yes (sage-leads recommend; the owner decides)');

  // Erick holds sage-lead too: his press in Discord is a recommendation like any lead's, never his final answer (G10).
  const own = await asked();
  own.now += MINUTE;
  await own.press(OWNER, 'press:project/G1:0:1');
  await own.bridge.loop();
  assert.equal(own.answerOf('G1'), 'B. No (sage-leads recommend; the owner decides)');
  assert.match(text(own), /\*\*Recommended by Erick \(sage-lead\) at <t:\d+:t>: B\. No\. Erick decides at the terminal\.\*\*$/);
  assert.deepEqual(own.lines.filter((l) => l.startsWith('project/G1:')), ['project/G1: sage-leads recommend No. If you agree, do nothing; the mode stays off.']);
  own.now += MINUTE;
  assert.deepEqual((await own.press(JON, 'press:project/G1:0:0')).map((r) => r.content),
    ['Already recommended by Erick (sage-lead): B. No. A recommendation only; Erick decides at the terminal. Your press did not count.']);
});

test('F-T73-6: with the owner missing from the member list, every leads-only text still names Erick, with a capital at each sentence start', async () => {
  const b = await asked({ members: MEMBERS.filter((m) => m.id !== OWNER) });
  assert.deepEqual(b.discord.posts.map((p) => [p.content, p.embeds?.[0].title]), [[
    `<@&${LEAD}> project T1 asks the sage-leads for a recommendation to Erick. The first sage-lead answer is the recommendation; Erick decides at the terminal.`,
    'Recommend for Erick: Question project/G1 · T1 Ship the export page',
  ]]);
  assert.match(text(b), /\*\*Rule:\*\* the first sage-lead answer is the leads' recommendation to Erick · Erick decides at the terminal ·/);
  b.now += MINUTE;
  assert.deepEqual(await b.press(MAYA, 'press:project/G1:0:0'), [NOTE]);
  await b.press(JON, 'press:project/G1:0:1');
  await b.bridge.loop();
  assert.deepEqual(b.discord.posts.at(-1).content, 'Recommendation recorded: Jon recommends No. Erick decides at the terminal.');
  assert.match(text(b), /\*\*Recommended by Jon \(sage-lead\) at <t:\d+:t>: B\. No\. Erick decides at the terminal\.\*\*$/);
  b.sh('gate', 'answer', 'G1', 'B. No');
  b.now += MINUTE;
  await b.bridge.loop();
  assert.match(text(b), /\*\*Answered by Erick \(terminal\) at <t:\d+:t>: B\. No\. Final\.\*\*$/);
  assert.deepEqual((await b.press(JON, 'press:project/G1:0:0')).map((r) => r.content), ['Already answered by Erick at the terminal: B. No. Your press did not count.']);
  const all = JSON.stringify([[...b.discord.messages.values()], b.lines]);
  assert.deepEqual(all.match(/member/gi), null); // never "a member" or "member …0001"
});

test('F-T73-7: vote.mjs --leads with no sagePath or a wrong one prints one line, exits 1 and writes nothing', () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Ship the export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', QUESTION[0], '--options', QUESTION[1], '--recommend', 'No');
  const wrong = join(b.root, 'no-such-sage.mjs');
  assert.deepEqual(voteWith(b, {}, '--leads', 'G1'), { code: 1, out: '',
    err: 'sage-bot vote: the config: sagePath must be an absolute path' });
  assert.deepEqual(voteWith(b, { sagePath: wrong }, '--leads', 'G1'), { code: 1, out: '',
    err: `sage-bot vote: could not read the gates of project with the sage state tool ${wrong}. Nothing changed.` });
  assert.equal(existsSync(`${b.statePath}.votes`) || existsSync(`${b.statePath}.votes.leads`), false);
});
