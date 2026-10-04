// The bridge (B3) through the fake Discord layer and a scratch sage logbook. SAMPLE DATA ONLY: every id, name and reason is made up.
// The sage state tool runs with HOME and SAGE_HOME in a scratch folder, so no test touches a real logbook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, frame, monotonic, SETTLE } from '../src/bridge.js';
import { fakeDiscord, fakeInteraction } from '../src/fake-discord.js';
import { sageTool } from '../src/sage.js';
import { load, save } from '../src/state.js';
import { ballotsOf, HOUR, MINUTE, openGate, parseGate, MAX_BALLOTS } from '../src/vote.js';

export const SAGE = process.env.SAGE_TOOL ?? '/Users/erickb336/.claude/plugins/cache/sage/sage/39e9bf767a1f/skills/sage/sage.mjs';
const DRIVER = '300000000000000001';
const LEADR = '300000000000000002';
export const [OWNER, MAYA, JON, SAM, BOT] = ['100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004', '100000000000000005'];
const MEMBERS = [
  { id: OWNER, name: 'Erick', roles: [DRIVER, LEADR] },
  { id: MAYA, name: 'Maya', roles: [DRIVER] },
  { id: JON, name: 'Jon', roles: [DRIVER, LEADR] },
  { id: SAM, name: 'Sam', roles: [] },
  { id: BOT, name: 'sage bridge', roles: [DRIVER, LEADR], bot: true },
];
const CONFIG = { ownerId: OWNER, driverRole: DRIVER, leadRole: LEADR };
const T0 = Date.UTC(2026, 9, 4, 14, 0);

/** A scratch project with a sage logbook, and a bridge on it with the fake Discord layer and a clock that the test moves. */
export function setup({ members = MEMBERS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sage-bot-b3-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), SAGE_HOME: join(root, 'home', 'sage') };
  const sh = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', project], { env, encoding: 'utf8' }).trim();
  sh('init');
  const discord = fakeDiscord(members);
  const lines = [];
  const b = { root, project, sh, discord, lines, now: T0, statePath: join(root, 'state', 'gates.json') };
  b.sage = sageTool({ sagePath: SAGE, project, env });
  b.make = () => createBridge({ sage: b.sage, discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => lines.push(l) });
  b.bridge = b.make();
  b.gates = () => readFileSync(join(sh('logbook'), 'gates.tsv'), 'utf8');
  b.answerOf = (id) => b.gates().split('\n').find((l) => l.startsWith(`${id}\t`)).split('\t')[6];
  b.press = async (user, customId, fields) => {
    const i = fakeInteraction({ user, customId, fields });
    await b.bridge.interaction(i);
    return i.replies;
  };
  /** Two loops SETTLE apart: the first sees the new gates, the second posts them. */
  b.post = async () => { await b.bridge.loop(); b.now += SETTLE; await b.bridge.loop(); };
  return b;
}
const card = (b, id = [...b.discord.messages.keys()][0]) => b.discord.latest(id);
const text = (payload) => JSON.stringify(payload);

test('end to end: a scratch logbook gets a gate, the bridge posts its card, two holders press, and sage records the answer', async () => {
  const b = setup();
  b.sh('task', 'add', '--title', 'Fix login timeout', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'When a session expires, what does the user see?', '--options', 'Sign in again silently|Show a Session ended screen', '--recommend', 'Sign in again silently');
  await b.post();
  assert.equal(b.discord.posts.length, 1);
  const posted = b.discord.posts[0];
  assert.equal(posted.content, `<@&${DRIVER}> T1 needs one product answer. The first answer is final.`);
  assert.deepEqual(posted.allowedMentions, { parse: [], roles: [DRIVER] });
  assert.equal(posted.embeds[0].title, 'Question G1 · T1 Fix login timeout');
  b.now += MINUTE;
  await b.press(MAYA, 'press:G1:0:1');
  b.now += 1000;
  const later = await b.press(JON, 'press:G1:0:0');
  assert.equal(later[0].content, 'Already answered by Maya: B');
  assert.equal(b.answerOf('G1'), 'B. Show a Session ended screen');
  assert.match(card(b).embeds[0].description, /Answered by Maya at <t:\d+:t>: B\. Show a Session ended screen\. Final\./);
  assert.ok(b.lines.includes('sage gate G1 answered: B. Show a Session ended screen'));
});

test('end to end: a task with two open gates is one batch vote; two holders vote, the tick at the limit decides, sage gets both answers', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T7', '--question', 'Which columns?', '--options', 'Visible only|All fields', '--recommend', 'Visible only');
  b.sh('gate', 'add', 'T7', '--question', 'Which date format?', '--options', 'ISO|Locale|Both', '--recommend', 'ISO');
  await b.post();
  const [id] = b.discord.messages.keys();
  assert.equal(b.discord.posts[0].content, `<@&${DRIVER}> T7 has 2 product questions. Vote on each part within 30 minutes.`);
  assert.equal(b.discord.posts[0].embeds[0].title, 'Batch vote G1+G2 · T7 ');
  b.now += MINUTE;
  assert.equal((await b.press(MAYA, 'press:G1+G2:0:0'))[0].kind, 'modal');
  await b.press(MAYA, 'reason:G1+G2:0:0', { reason: 'Hidden fields leak ids.' });
  await b.press(JON, 'press:G1+G2:1:2');
  await b.press(MAYA, 'press:G1+G2:1:2');
  assert.equal(b.answerOf('G1'), '');
  b.now = T0 + SETTLE + 30 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['A. Visible only', 'C. Both']);
  assert.match(card(b, id).embeds[0].description, /Closed: every part is decided\. T7 goes on\./);
});

test('F-T28-19: a task with 5 open gates is refused, once, and nothing is posted; 4 gates post as one batch', async () => {
  const b = setup();
  for (let i = 1; i <= 5; i++) b.sh('gate', 'add', 'T2', '--question', `Q${i}?`, '--options', 'x|y', '--recommend', 'x');
  await b.post();
  await b.bridge.loop();
  assert.equal(b.discord.posts.length, 0);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('not posted')), ['not posted: T2 has 5 open gates, and a batch holds at most 4 parts. Answer them at the terminal.']);
  b.sh('gate', 'add', 'T3', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  for (let i = 1; i <= 3; i++) b.sh('gate', 'add', 'T3', '--question', `R${i}?`, '--options', 'x|y', '--recommend', 'x');
  await b.post();
  assert.equal(b.discord.posts.length, 1);
  assert.equal(b.discord.posts[0].embeds[0].title, 'Batch vote G6+G7+G8+G9 · T3 ');
  assert.equal(b.discord.posts[0].components.length, 5);
});

test('F-T28-18: a single gate or a part holds at most 5 options, in openGate, parseGate and the framing', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.throws(() => openGate({ id: 'g', kind: 'single', options: six, askedBy: OWNER, at: T0 }), TypeError);
  assert.throws(() => openGate({ id: 'g', kind: 'batch', parts: [['x'], six], askedBy: OWNER, at: T0 }), TypeError);
  const five = JSON.parse(JSON.stringify(openGate({ id: 'g', kind: 'single', options: six.slice(0, 5), askedBy: OWNER, at: T0 })));
  assert.equal(parseGate(structuredClone(five)).options.length, 5);
  five.options.push('f');
  assert.throws(() => parseGate(five), /bad options/);
  const row = { id: 'G1', task: 'T1', question: 'Q?', options: six.join('|'), recommendation: 'a', default: '', answer: '' };
  assert.deepEqual(frame([row], '', OWNER, T0), { refused: 'G1 needs 1 to 5 different options' });
});

test('F-T28-11: parseGate refuses a part with more than MAX_BALLOTS ballots', () => {
  const g = JSON.parse(JSON.stringify(openGate({ id: 'g', kind: 'batch', parts: [['x', 'y']], askedBy: OWNER, at: T0 })));
  g.parts[0].ballots = Array.from({ length: MAX_BALLOTS + 1 }, (_, i) => [`u${i}`, { option: 'x', at: T0, via: 'discord' }]);
  assert.throws(() => parseGate(g), /more ballots than MAX_BALLOTS/);
  g.parts[0].ballots.pop();
  assert.equal(ballotsOf(parseGate(structuredClone(g)).parts[0]).size, 1000);
});

test('F-T28-2: an event gets the bridge clock, never Discord data, and the clock never goes back', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  await b.post();
  b.now += 5 * MINUTE;
  const i = Object.assign(fakeInteraction({ user: MAYA, customId: 'press:G1:0:0' }), { createdTimestamp: 1, createdAt: new Date(1) });
  await b.bridge.interaction(i);
  assert.equal(b.bridge.entry('G1').gate.lastAt, T0 + SETTLE + 5 * MINUTE);
  let wall = 100;
  const clock = monotonic(() => wall, 50);
  assert.deepEqual([clock(), (wall = 40, clock()), (wall = 120, clock())], [100, 100, 120]);
});

test('F-T28-4: a press after the limit with no tick before it settles the vote: the card shows the end and sage gets the answers', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T7', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T7', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  await b.press(MAYA, 'press:G1+G2:0:1');
  await b.press(MAYA, 'press:G1+G2:1:0');
  b.now += 31 * MINUTE;
  const late = await b.press(JON, 'press:G1+G2:0:0');
  assert.match(late[0].content, /^The vote on G1\+G2 ended at <t:\d+:t>\. Your press did not count\.$/);
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['B. y', 'A. p']);
  assert.match(card(b).embeds[0].description, /Closed: every part is decided/);
});

test('F-T28-1: after the Mac slept, the bridge asks for a new press and the tick at endsAt ends the vote', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T6', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T6', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  await b.press(MAYA, 'press:G1+G2:0:0');
  await b.press(JON, 'press:G1+G2:1:1');
  const asleep = b.now;
  b.now += 10 * HOUR;
  await b.bridge.loop();
  const wake = b.discord.posts.find((p) => p.content?.startsWith('The host was asleep'));
  assert.equal(wake.content, `The host was asleep from <t:${asleep / 1000}:t> to <t:${b.now / 1000}:t>. Presses in that time did not count. Please press again on any open question.`);
  assert.deepEqual(wake.allowedMentions, { parse: [] });
  assert.equal(b.bridge.entry('G1+G2').gate.phase, 'closed');
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['A. x', 'B. q']);
  // A loop on time after that is no wake.
  b.now += 15_000;
  await b.bridge.loop();
  assert.equal(b.discord.posts.filter((p) => p.content?.startsWith('The host was asleep')).length, 1);
});

test('F-T28-10, F-T28-12, F-T28-15: the gate file is 0600, written whole, and loaded only through parseGate from its own path', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  await b.post();
  assert.equal(statSync(b.statePath).mode & 0o777, 0o600);
  assert.equal(statSync(join(b.root, 'state')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(b.root, 'state')), ['gates.json']);
  // A restart loads the same gate and goes on with it.
  await b.press(MAYA, 'press:G1:0:0');
  const again = b.make();
  assert.equal(again.entry('G1').gate.outcome.by, MAYA);
  assert.ok(Object.isFrozen(load(b.statePath)[0].gate.outcome));
  // Another user's write bits refuse the file; so does a gate that the vote rules could not have made.
  chmodSync(b.statePath, 0o644);
  assert.throws(() => b.make(), /must be a regular file of this user with mode 0600/);
  chmodSync(b.statePath, 0o600);
  const data = JSON.parse(readFileSync(b.statePath, 'utf8'));
  data.entries[0].gate.outcome.option = 'Z';
  save(b.statePath, data.entries);
  assert.throws(() => b.make(), /parseGate: the first argument must be a gate/);
});

test('F-T28-6: only a Discord id goes into an event: another user id gets a note and changes nothing, and the config needs ids', async () => {
  const b = setup({ members: [...MEMBERS, { id: 'sample-maya', name: 'Fake', roles: [DRIVER] }] });
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  await b.post();
  const replies = await b.press('sample-maya', 'press:G1:0:0');
  assert.equal(replies[0].content, 'I do not know this account. Nothing changed.');
  assert.equal(b.bridge.entry('G1').gate.phase, 'open');
  assert.throws(() => createBridge({ sage: b.sage, discord: b.discord, config: { ...CONFIG, ownerId: 'erick' }, statePath: b.statePath }),
    /the config needs ownerId as a Discord id/);
});

test('F-T28-7: holders and leads come fresh from the members as Sets: a role taken away counts at the next press', async () => {
  const members = structuredClone(MEMBERS);
  const b = setup({ members });
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  await b.post();
  members[1].roles = [];
  const replies = await b.press(MAYA, 'press:G1:0:0');
  assert.match(replies[0].content, /Only people with the sage-driver role can answer or vote/);
  members[1].roles = [DRIVER];
  await b.press(MAYA, 'press:G1:0:0');
  assert.equal(b.bridge.entry('G1').gate.outcome.by, MAYA);
});

test('F-T28-9: a withdraw comes only from the chief side; an answer at the terminal is one press on a normal gate', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T2', '--question', 'R?', '--options', 'x|y', '--recommend', 'x');
  await b.post();
  // No button withdraws: a forged custom id is an unknown button.
  assert.equal((await b.press(OWNER, 'withdraw:G1'))[0].content, 'I do not know this button or its question. Nothing changed.');
  // The owner answers G1 at the terminal with an option: it is the first answer, via the terminal; the bridge writes nothing back.
  b.sh('gate', 'answer', 'G1', 'y');
  // The chief answers G2 with no option: that withdraws it.
  b.sh('gate', 'answer', 'G2', 'dropped: the task changed');
  await b.bridge.loop();
  assert.deepEqual(b.bridge.entry('G1').gate.outcome, { status: 'answered', option: 'B', by: OWNER, via: 'terminal' });
  assert.equal(b.answerOf('G1'), 'y');
  assert.deepEqual(b.bridge.entry('G2').gate.outcome, { status: 'withdrawn' });
  assert.equal(b.answerOf('G2'), 'dropped: the task changed');
  const [g1, g2] = b.discord.messages.keys();
  assert.match(card(b, g1).embeds[0].description, /Answered by Erick \(terminal\)/);
  assert.match(card(b, g2).embeds[0].description, /Withdrawn by Erick/);
});

test('merges never go to a vote: a gate about a merge is not posted', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Merge PR 12 now?', '--options', 'yes|no', '--recommend', 'yes');
  await b.post();
  assert.equal(b.discord.posts.length, 0);
});

test('F-T28-13, F-T28-16, F-T28-17: a tie posts its arguments to the leads, the tie-break names the lead, and the card follows each change', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T7', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T7', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  const [id] = b.discord.messages.keys();
  await b.press(MAYA, 'reason:G1+G2:0:0', { reason: 'x is *cheaper* <@&1> https://evil.example' });
  await b.press(JON, 'reason:G1+G2:0:1', { reason: 'y is safer' });
  await b.press(MAYA, 'press:G1+G2:1:0');
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  const tie = b.discord.posts.at(-1);
  assert.equal(tie.content, [
    `<@&${LEADR}> G1+G2 is tied after its vote. T7 waits: please break the tie with the buttons on the card.`,
    'Part 1 is tied: A, B. The arguments:',
    '- Maya, for A: x is \\*cheaper\\* \\<@&1\\> https:// evil.example',
    '- Jon, for B: y is safer',
  ].join('\n'));
  assert.deepEqual(tie.allowedMentions, { parse: [], roles: [LEADR] });
  assert.match(card(b, id).embeds[0].description, /1 part is tied/);
  await b.press(JON, 'tiebreak:G1+G2:0:1');
  assert.deepEqual(b.discord.posts.at(-1), { content: 'Jon (sage-lead) broke the tie on part 1 of G1+G2: B.', allowedMentions: { parse: [] } });
  assert.match(card(b, id).embeds[0].description, /Closed: every part is decided/);
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['B. y', 'A. p']);
  // The card was edited after each of the 5 changes: 3 ballots, the end, the tie-break.
  assert.equal(b.discord.messages.get(id).length, 1 + 5);
});

test('reminders: an open single gate pings the holders every 2 hours from its opening, a tied batch pings the leads 2 hours after its vote ended', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T2', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T2', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  await b.post();
  const opened = b.now;
  const reminders = () => b.discord.posts.filter((p) => p.content?.includes('reminder')).map((p) => [p.content, p.allowedMentions.roles]);
  for (const at of [30 * MINUTE, 2 * HOUR - 1000, 2 * HOUR, 2 * HOUR + 15_000, 2.5 * HOUR, 4 * HOUR]) {
    b.now = opened + at;
    await b.bridge.loop();
  }
  const single = `<@&${DRIVER}> reminder: G1 waits for an answer since <t:${opened / 1000}:t>. T1 waits.`;
  assert.deepEqual(reminders(), [
    [single, [DRIVER]],
    [`<@&${LEADR}> reminder: part 1, part 2 of G2+G3 still tied since <t:${(opened + 30 * MINUTE) / 1000}:t>. T2 waits.`, [LEADR]],
    [single, [DRIVER]],
  ]);
});
