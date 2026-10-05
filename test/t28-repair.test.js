// The repair of B3's review findings (F-T28-26 to F-T28-32) and the owner's answers G9 and G10, through the fake Discord layer
// and a scratch sage logbook. SAMPLE DATA ONLY: every id, name and question is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askedTogether, MERGE } from '../src/bridge.js';
import { lock, load, save } from '../src/state.js';
import { HOUR, MINUTE } from '../src/vote.js';
import { APPRENTICE, JON, LEADR, MAYA, MEMBERS, OWNER, setAt, setup, table } from './bridge-setup.js';

/** The members with the owner in no role: the owner's terminal answer must count all the same (G10). */
const noRoles = () => MEMBERS.map((m) => (m.id === OWNER ? { ...m, roles: [] } : { ...m }));
const lastCard = (b, n = 0) => b.discord.latest([...b.discord.messages.keys()][n]);
const decisionsOf = (b, question) => table(b, 'decisions').filter((d) => d.decision.startsWith(`${question} →`)).map((d) => d.decision);
/** The posts that ping exactly these roles. */
const pings = (b, ...roles) => b.discord.posts.filter((p) => JSON.stringify(p.allowedMentions?.roles) === JSON.stringify(roles)).map((p) => p.content);

test('acceptance, F-T28-26, G10 a: the owner (no roles) answers G1 at the terminal, a holder presses after: sage keeps the owner\'s answer', async () => {
  const b = setup({ members: noRoles() });
  b.sh('task', 'add', '--title', 'Fix login timeout', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'What does the user see?', '--options', 'Sign in again|Session ended screen', '--recommend', 'Sign in again');
  await b.post();
  b.sh('gate', 'answer', 'G1', 'Session ended screen');
  b.now += MINUTE;
  // The press comes before the next loop: the bridge reads the logbook first, so the press does not count.
  const replies = await b.press(MAYA, 'press:G1:0:0');
  assert.deepEqual(replies.map((r) => r.content), ['Already answered by Erick at the terminal: B. Session ended screen. Your press did not count.']);
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'Session ended screen');
  assert.deepEqual(decisionsOf(b, 'What does the user see?'), ['What does the user see? → Session ended screen']);
  assert.match(lastCard(b).embeds[0].description, /\*\*Answered by Erick \(terminal\) at <t:\d+:t>: B\. Session ended screen\. Final\.\*\*$/);
  assert.equal(lastCard(b).components[0].components.every((c) => c.disabled), true);
  assert.equal(b.lines.some((l) => l.startsWith('sage gate G1 answered')), false);
});

test('G10 a: the owner\'s answer after a loop closes the card; a later press of a lead changes nothing in sage', async () => {
  const b = setup({ members: noRoles() });
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  await b.post();
  b.sh('gate', 'answer', 'G1', 'A');
  b.now += MINUTE;
  await b.bridge.loop();
  assert.match(lastCard(b).embeds[0].description, /Answered by Erick \(terminal\) at <t:\d+:t>: A\. x\. Final\./);
  assert.equal((await b.press(JON, 'press:G1:0:1'))[0].content, 'Already answered by Erick at the terminal: A. x. Your press did not count.');
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'A');
  assert.deepEqual(decisionsOf(b, 'Q?'), ['Q? → A']);
});

test('G10 a: before each `sage gate answer` the bridge reads the row again: an owner answer between two loops is never replaced', async () => {
  const b = setup({ members: noRoles() });
  b.sh('gate', 'add', 'T7', '--question', 'Which columns?', '--options', 'Visible|All', '--recommend', 'Visible');
  b.sh('gate', 'add', 'T7', '--question', 'Which format?', '--options', 'ISO|Locale', '--recommend', 'ISO');
  await b.post();
  await b.press(MAYA, 'press:G1+G2:0:1');
  await b.press(MAYA, 'press:G1+G2:1:0');
  // The owner answers G1 just before the limit; the next loop sends the tick first, then reads the logbook.
  b.now += 29 * MINUTE;
  b.sh('gate', 'answer', 'G1', 'Visible');
  b.now += 2 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['Visible', 'A. ISO']);
  assert.deepEqual(decisionsOf(b, 'Which columns?'), ['Which columns? → Visible']);
  assert.deepEqual(decisionsOf(b, 'Which format?'), ['Which format? → A. ISO']);
  assert.equal(b.bridge.entry('G1+G2').ask.parts[0].final.text, 'A. Visible');
});

test('F-T28-27, G10 a: in a batch the owner\'s terminal answer closes its part, is no ballot, and the other part keeps voting', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T7', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T7', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  b.sh('gate', 'answer', 'G1', 'y');
  b.now += MINUTE;
  await b.bridge.loop();
  const { gate } = b.bridge.entry('G1+G2');
  assert.deepEqual(gate.parts[0].ballots, []);
  const part1 = lastCard(b).embeds[0].fields[0].value;
  assert.match(part1, /\*\*Answered by Erick \(terminal\) at <t:\d+:t>: B\. y\. Final\.\*\*$/);
  assert.deepEqual(lastCard(b).components[0].components.map((c) => [c.disabled, c.style]), [[true, 1], [true, 3]]);
  // Two holders press on part 1: neither counts, so the vote cannot replace the owner's answer.
  for (const who of [MAYA, JON]) assert.match((await b.press(who, 'press:G1+G2:0:0'))[0].content, /^Already answered by Erick at the terminal: B\. y\./);
  assert.deepEqual(b.bridge.entry('G1+G2').gate.parts[0].ballots, []);
  // Part 2 keeps voting: the press opens the reason form, and the tick decides it.
  assert.equal((await b.press(MAYA, 'press:G1+G2:1:1'))[0].kind, 'modal');
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['y', 'B. q']);
  assert.match(lastCard(b).embeds[0].description, /Closed: every part is decided or answered at the terminal\. T7 goes on\./);
  // Part 1 had no votes, which the vote rules call a tie, but it has the owner's answer: the leads get no ping.
  assert.deepEqual(pings(b, LEADR), []);
});

test('G10 a: a batch whose parts the owner all answers at the terminal closes at once, and the tick then changes nothing', async () => {
  const b = setup({ members: noRoles() });
  b.sh('gate', 'add', 'T7', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T7', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  b.sh('gate', 'answer', 'G1', 'x');
  b.sh('gate', 'answer', 'G2', 'skip this: the task changed');
  await b.bridge.loop();
  const fields = lastCard(b).embeds[0].fields.map((f) => f.value.split('\n').at(-1));
  assert.deepEqual(fields.map((f) => f.replace(/<t:\d+:t>/, 'T')), ['**Answered by Erick (terminal) at T: A. x. Final.**', '**Answered by Erick (terminal) at T: skip this: the task changed. Final.**']);
  assert.equal(lastCard(b).components.length, 2); // no "End vote now"
  b.now += 31 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['x', 'skip this: the task changed']);
  assert.deepEqual(pings(b, LEADR), []);
});

test('the bridge\'s own answer in sage, without its save (a crash in between), stays the bridge\'s: it is not taken as the owner\'s', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  await b.post();
  await b.press(MAYA, 'press:G1:0:1');
  assert.equal(b.answerOf('G1'), 'B. y');
  const data = load(b.statePath).entries.map(({ sent, ...e }) => ({ ...e, sent: {} }));
  save(b.statePath, data);
  b.bridge = b.make();
  await b.bridge.loop();
  assert.equal(b.bridge.entry('G1').ask.parts[0].final, undefined);
  assert.match(lastCard(b).embeds[0].description, /Answered by Maya at/);
  assert.deepEqual(decisionsOf(b, 'Q?'), ['Q? → B. y']);
});

test('F-T28-28: a question about a merge is never posted, in any form; a word that only holds "merg" is', async () => {
  for (const q of ['Merge PR 12 now?', 'Shall I keep merges small?', 'PR 12 merged with a conflict: revert?', 'Start merging the stack?', 'Which way?']) {
    const b = setup();
    b.sh('gate', 'add', 'T1', '--question', q, '--options', q === 'Which way?' ? 'squash and merge|rebase' : 'yes|no', '--recommend', 'yes');
    await b.post();
    assert.equal(b.discord.posts.length, 0, q);
  }
  assert.deepEqual(['emerge', 'emerging', 'submerged', 'Merger'].map((w) => MERGE.test(w)), [false, false, false, false]);
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Which fix should emerge first?', '--options', 'a|b', '--recommend', 'a');
  await b.post();
  assert.equal(b.discord.posts.length, 1);
});

test('F-T28-31: when a voter loses the role, the next loop redraws the open card, and the card then shows what the tick decides', async () => {
  const members = structuredClone(MEMBERS);
  const b = setup({ members });
  b.sh('gate', 'add', 'T7', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T7', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  await b.press(MAYA, 'press:G1+G2:0:1');
  await b.press(JON, 'press:G1+G2:0:1');
  await b.press(OWNER, 'press:G1+G2:0:0');
  await b.press(MAYA, 'press:G1+G2:1:0');
  assert.match(lastCard(b).embeds[0].fields[0].value, /Ahead: B/);
  members.find((m) => m.id === MAYA).roles = [];
  members.find((m) => m.id === JON).roles = [];
  b.now += MINUTE;
  await b.bridge.loop();
  const part1 = lastCard(b).embeds[0].fields[0].value;
  assert.match(part1, /\*\*A\.\*\* x · Recommended · 1 vote \(Erick\)\n\*\*B\.\*\* y · 0 votes/);
  assert.match(part1, /Ahead: A/);
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual(b.bridge.entry('G1+G2').gate.parts[0].outcome, { status: 'decided', option: 'A', how: 'votes' });
  // A loop with the same holders edits nothing.
  const edits = b.discord.messages.get([...b.discord.messages.keys()][0]).length;
  b.now += 15_000;
  await b.bridge.loop();
  assert.equal(b.discord.messages.get([...b.discord.messages.keys()][0]).length, edits);
});

test('F-T28-29, G9: only gates asked within 30 s of each other share a card, also after a restart', async () => {
  const b = setup();
  for (const q of ['A?', 'B?', 'C?']) b.sh('gate', 'add', 'T4', '--question', q, '--options', 'x|y', '--recommend', 'x');
  setAt(b, { G1: '2026-10-04T13:00:00Z', G2: '2026-10-04T13:00:20Z', G3: '2026-10-04T13:40:00Z' });
  b.bridge = b.make(); // as after a restart: every gate is open at once
  await b.post();
  assert.deepEqual(b.discord.posts.map((p) => p.embeds[0].title), ['Batch vote G1+G2 · T4 ', 'Question G3 · T4 ']);
  const rows = (at) => at.map((t, i) => ({ id: `G${i + 1}`, at: t }));
  assert.deepEqual(askedTogether(rows(['2026-10-04T13:00:31Z', '2026-10-04T13:00:00Z', '2026-10-04T13:00:30Z'])).map((g) => g.map((r) => r.id)), [['G2', 'G3'], ['G1']]);
});

test('G10 b: a task refused for 5 questions stays at the terminal until each is answered; a later question gets its card', async () => {
  const b = setup();
  for (let i = 1; i <= 5; i++) b.sh('gate', 'add', 'T2', '--question', `Q${i}?`, '--options', 'x|y', '--recommend', 'x');
  setAt(b, Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`G${i}`, `2026-10-04T13:00:0${i}Z`])));
  await b.post();
  b.sh('gate', 'answer', 'G1', 'x');
  b.sh('gate', 'answer', 'G2', 'x');
  b.now += MINUTE;
  await b.post();
  assert.equal(b.discord.posts.length, 0);
  assert.equal(b.lines.filter((l) => l.startsWith('not posted')).length, 1);
  for (const id of ['G3', 'G4', 'G5']) b.sh('gate', 'answer', id, 'y');
  b.sh('gate', 'add', 'T2', '--question', 'Q6?', '--options', 'x|y', '--recommend', 'x');
  setAt(b, { G6: '2026-10-04T13:05:00Z' });
  await b.post();
  assert.deepEqual(b.discord.posts.map((p) => p.embeds[0].title), ['Question G6 · T2 ']);
});

test('G10 c: a question that a task adds after its card was posted gets its own card', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T5', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T5', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  setAt(b, { G1: '2026-10-04T13:00:00Z', G2: '2026-10-04T13:00:05Z' });
  await b.post();
  b.sh('gate', 'add', 'T5', '--question', 'C?', '--options', 'r|s', '--recommend', 'r');
  setAt(b, { G3: '2026-10-04T13:00:10Z' }); // within 30 s of G1, but its task's card is already out
  await b.post();
  assert.deepEqual(b.discord.posts.map((p) => p.embeds[0].title), ['Batch vote G1+G2 · T5 ', 'Question G3 · T5 ']);
  assert.equal(b.bridge.entry('G1+G2').gate.parts.length, 2);
});

test('F-T28-32: after a sleep past the limit and 2 hours, one loop pings the leads once; the next reminder keeps the 2-hour steps from the end of the vote', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T6', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T6', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  const opened = b.now;
  b.now = opened + 30 * MINUTE + 2 * HOUR + MINUTE;
  await b.bridge.loop();
  assert.equal(pings(b, LEADR).length, 1);
  assert.match(pings(b, LEADR)[0], /is tied after its vote/);
  b.now = opened + 30 * MINUTE + 4 * HOUR - MINUTE;
  await b.bridge.loop();
  assert.equal(pings(b, LEADR).length, 1);
  b.now = opened + 30 * MINUTE + 4 * HOUR;
  await b.bridge.loop();
  assert.deepEqual(pings(b, LEADR).slice(1).map((p) => p.replace(/<t:\d+:t>/, 'T')), [`<@&${LEADR}> reminder: part 1, part 2 of G1+G2 still tied since T. T6 waits.`]);
  assert.equal(pings(b, APPRENTICE, LEADR).length, 1); // only the card's own alert
});

test('F-T28-30: one bridge per gate file: a second lock stops with a clear message; a lock of a gone process is replaced; exit frees it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-bot-lock-'));
  const path = join(dir, 'state', 'gates.json');
  const node = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  const state = new URL('../src/state.js', import.meta.url).href;
  // A bridge that takes the lock and exits leaves no lock behind.
  node(`import { lock } from '${state}'; lock(${JSON.stringify(path)});`);
  assert.equal(existsSync(`${path}.lock`), false);
  // A lock of a process that is gone: the pid of that finished child.
  const gone = node('console.log(process.pid)').trim();
  writeFileSync(`${path}.lock`, `${gone} Thu Jan  1 00:00:00 1970`);
  assert.equal(lock(path), `${path}.lock`);
  assert.match(readFileSync(`${path}.lock`, 'utf8'), new RegExp(`^${process.pid} \\w{3} \\w{3} [ \\d]\\d \\d\\d:\\d\\d:\\d\\d \\d{4}$`));
  // A second bridge while this one runs: refused, in a child, with the pid that holds the lock.
  assert.throws(() => node(`import { lock } from '${state}'; lock(${JSON.stringify(path)});`),
    (e) => e.stderr.includes(`another sage bridge (pid ${process.pid}) runs on ${path}. This one stops: two bridges would post each card twice. If no bridge runs, remove ${path}.lock.`));
});
