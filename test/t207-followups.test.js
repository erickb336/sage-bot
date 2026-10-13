// T207: six small vote and bridge follow-ups (F-T35-1, F-T60-1, F-T66-1, F-T206-1, F-T207-1, F-T208-1).
// Through the vote rules, the cards, the fake Discord layer and a scratch sage logbook.
// SAMPLE DATA ONLY: every id, name and answer is made up. HOME and SAGE_HOME are in a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmEnd, safe } from '../src/cards.js';
import { LOOP } from '../src/bridge.js';
import { BATCH_LIMIT, MINUTE, openGate, parseGate, step } from '../src/vote.js';
import { changedSage, JON, MAYA, MEMBERS, setup } from './bridge-setup.js';

const T0 = Date.UTC(2026, 9, 4, 12, 0);
const at = (min) => T0 + min * MINUTE;
const [ERICK, LEA] = ['sample-erick', 'sample-lea'];
const HOLDERS = ['sample-maya', 'sample-jon', ERICK, LEA];
const json = (gate) => JSON.parse(JSON.stringify(gate));
const refused = (value, why) => assert.throws(() => parseGate(value), { name: 'TypeError', message: new RegExp(`: ${why}$`) });
const add = (b, task, question) => b.sh('gate', 'add', task, '--question', question, '--options', 'x|y', '--recommend', 'x');
const card = (b, id = [...b.discord.messages.keys()][0]) => b.discord.latest(id);

/** A batch whose vote a sage-lead ended at minute 5: part 1 is tied A, B; part 2 went to X by votes. */
function ended() {
  let gate = openGate({ id: 'g2', kind: 'batch', parts: [['A', 'B'], ['X', 'Y', 'Z']], askedBy: ERICK, at: T0 });
  for (const event of [
    { type: 'press', by: 'sample-maya', option: 'A', part: 0, at: at(1), via: 'discord' },
    { type: 'press', by: 'sample-jon', option: 'B', part: 0, at: at(2), via: 'discord' },
    { type: 'press', by: 'sample-maya', option: 'X', part: 1, at: at(3), via: 'discord' },
    { type: 'end', by: LEA, at: at(5), via: 'discord' },
  ]) ({ gate } = step(gate, event, HOLDERS, [LEA]));
  assert.equal(gate.phase, 'tied');
  return json(gate);
}

test('F-T35-1: parseGate refuses a ballot after the end of the vote; a ballot at the end loads', () => {
  const g = ended();
  g.lastAt = at(6);
  g.parts[0].ballots[1][1].at = at(5);
  assert.equal(parseGate(json(g)).parts[0].ballots[1][1].at, at(5));
  g.parts[0].ballots[1][1].at = at(6);
  refused(g, 'a ballot comes after the end of the vote');
});

test('F-T35-1: parseGate refuses tied options on a part decided by votes', () => {
  const g = ended();
  assert.equal(parseGate(json(g)).parts[1].outcome.how, 'votes');
  g.parts[1].tied = ['X', 'Y'];
  refused(g, 'a part decided by votes has tied options');
});

test('F-T35-1: parseGate refuses one tied option of several; the one option of a part with no votes is tied and loads', () => {
  const g = ended();
  g.parts[0].tied = ['A'];
  refused(g, 'a part has one tied option of several');
  let solo = openGate({ id: 'g3', kind: 'batch', parts: [['A', 'B'], ['only']], askedBy: ERICK, at: T0 });
  ({ gate: solo } = step(solo, { type: 'tick', at: at(30) }, HOLDERS, [LEA]));
  assert.deepEqual(parseGate(json(solo)).parts.map((p) => p.tied), [['A', 'B'], ['only']]);
});

test('F-T35-1: openGate refuses a batch whose end is not a safe integer; parseGate refuses such a gate too', () => {
  const late = Number.MAX_SAFE_INTEGER - 10;
  assert.throws(() => openGate({ id: 'g4', kind: 'batch', parts: [['A', 'B']], askedBy: ERICK, at: late }),
    { name: 'RangeError', message: 'openGate: a batch needs a time whose end, 30 minutes later, is in whole ms' });
  assert.equal(openGate({ id: 'g5', kind: 'single', options: ['A', 'B'], askedBy: ERICK, at: late }).openedAt, late); // a single gate has no end
  const g = json(openGate({ id: 'g4', kind: 'batch', parts: [['A', 'B']], askedBy: ERICK, at: T0 }));
  Object.assign(g, { openedAt: late, lastAt: late, endsAt: late + BATCH_LIMIT });
  refused(g, 'endsAt is not 30 minutes after openedAt');
});

test('F-T206-1: the end-early confirm cuts each final answer, so 4 long final answers stay within 2000 characters', () => {
  const gate = openGate({ id: 'project/G1+G2+G3+G4', kind: 'batch', parts: [['A', 'B'], ['A', 'B'], ['A', 'B'], ['A', 'B']], askedBy: ERICK, at: T0 });
  // As the bridge keeps the owner's words: cut to 500, then made safe, so each underscore doubles.
  const final = { by: ERICK, at: at(1), text: safe('_'.repeat(500)) };
  assert.equal(final.text.length, 1000);
  const ask = { parts: gate.parts.map(() => ({ final })) };
  const { content } = confirmEnd(gate, { holders: new Set(HOLDERS), names: new Map() }, ask);
  assert.ok(content.length <= 2000, `${content.length} characters`);
  const lines = content.split('\n');
  assert.equal(lines.length, 6);
  for (const [i, line] of lines.slice(1, 5).entries()) {
    assert.equal(line, `Part ${i + 1} has the final answer from the terminal: ${'\\_'.repeat(99)}\\….`);
  }
});

test('F-T60-1: two presses started together on one single question: the first that reaches the bridge is final, the other gets the late reply', async () => {
  const b = setup();
  add(b, 'T1', 'Which page?');
  await b.post();
  const [maya, jon] = await Promise.all([b.press(MAYA, 'press:project/G1:0:0'), b.press(JON, 'press:project/G1:0:1')]);
  const kinds = [maya, jon].map((r) => r.map((x) => x.kind).join());
  assert.deepEqual([...kinds].sort(), ['reply', 'update']); // one card update, one private reply
  const [won, lost] = kinds[0] === 'update' ? [['Maya', 'A', 'x'], jon] : [['Jon', 'B', 'y'], maya];
  assert.equal(lost[0].content, `Already answered by ${won[0]}: ${won[1]}`);
  assert.equal(b.answerOf('G1'), won[2]);
  assert.match(card(b).embeds[0].description, new RegExp(`Answered by ${won[0]} at <t:\\d+:t>: ${won[1]}\\. ${won[2]}\\. Final\\.`));
});

test('F-T66-1: a new card answered at the terminal before its first post is never posted, also after a restart', async () => {
  const b = setup();
  add(b, 'T1', 'Which page?');
  const real = b.discord.post;
  b.discord.post = () => Promise.reject(Object.assign(new Error('Internal Server Error'), { status: 500 }));
  await b.post(); // the entry is saved, and Discord refuses its card
  assert.equal(b.discord.posts.length, 0);
  b.discord.post = real;
  b.sh('gate', 'answer', 'G1', 'y'); // Erick answers at the terminal before the card is posted
  b.bridge = b.make(); // as after a crash
  b.now += LOOP;
  await b.bridge.loop();
  await b.bridge.loop();
  assert.deepEqual(b.discord.posts, []); // no card and no role ping for a question that is answered
  assert.equal(b.answerOf('G1'), 'y');
});

test('F-T207-1: with the bridge\'s check open because sage changed its answer rows, a later terminal answer by Erick shows on the card as final', async () => {
  const b = setup({ tool: changedSage() });
  add(b, 'T1', 'Which page?');
  await b.post();
  await b.press(MAYA, 'press:project/G1:0:0'); // Maya presses x; the bridge writes it, and the trail does not show the write
  assert.equal(b.answerOf('G1'), 'x');
  assert.deepEqual(b.lines.filter((l) => l.includes('decisions trail')), [
    "project/G1: the decisions trail does not show the bridge's write: sage's gate answer rows changed; the owner's answer is not protected. "
    + "Update sage-bot so it reads sage's new answer rows, then restart the bridge"]);
  b.now += MINUTE;
  b.sh('gate', 'answer', 'G1', 'y'); // later, Erick answers y at the terminal
  b.now += LOOP;
  await b.bridge.loop();
  assert.match(card(b).embeds[0].description, /\*\*Answered by Erick \(terminal\) at <t:\d+:t>: B\. y\. Final\.\*\*$/);
  assert.ok(b.lines.includes('project/G1 was answered at the terminal: the card shows it as final'));
  assert.equal(b.answerOf('G1'), 'y'); // the bridge writes nothing over it
});

test('F-T208-1: a press redraws its card at once, also while the card waits in the redraw back-off', async () => {
  const members = structuredClone(MEMBERS);
  const b = setup({ members });
  add(b, 'T1', 'Which page?');
  add(b, 'T1', 'Which colour?');
  await b.post();
  const [id] = b.discord.messages.keys();
  assert.match(card(b, id).embeds[0].title, /^Batch vote project\/G1\+G2/);
  const real = b.discord.edit;
  b.discord.edit = () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }));
  members[1].roles = []; // Maya loses the sage-apprentice role: the redraw is refused, and the card waits in the back-off
  await b.bridge.loop();
  b.now += LOOP;
  await b.bridge.loop();
  assert.equal(b.lines.filter((l) => l.startsWith('Discord refused the edit of project/G1+G2')).length, 1);
  b.discord.edit = real; // Discord takes edits again, but the back-off has not run out
  const edits = b.discord.messages.get(id).length;
  const replies = await b.press(JON, 'press:project/G1+G2:0:1'); // Jon votes y on part 1: the reply is the reason form, not the card
  assert.deepEqual(replies.map((r) => r.kind), ['modal']);
  assert.equal(b.discord.messages.get(id).length, edits + 1);
  assert.match(JSON.stringify(card(b, id).embeds[0]), /Jon/);
});
