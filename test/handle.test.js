// A Discord-shaped interaction through the fake layer, the handler and the vote rules, to the reply.
// SAMPLE DATA: every id, name and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, peopleOf } from '../src/handle.js';
import { note } from '../src/cards.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { step, ballotsOf, MINUTE } from '../src/vote.js';
import { ASKS, MEMBERS, CONFIG, ERICK, MAYA, JON, SAM, BRIDGE, clock, openAsk } from '../examples/sample.js';

const PEOPLE = peopleOf(MEMBERS, CONFIG);
const PRIVATE = { flags: 64, allowedMentions: { parse: [] } };
const NO_ROLE = 'Your press did not count. Only people with the sage-apprentice or sage-lead role can answer or vote. You can still read this thread.';

/** A bridge with these open gates and a clock that the test moves. */
function bridge(ids, at) {
  const gates = new Map(ids.map((id) => [id, { gate: openAsk(id, at), ask: ASKS[id] }]));
  const ctx = { gates, people: PEOPLE, clock: () => ctx.now, now: at };
  ctx.press = async (user, customId, fields, ephemeral = false) => {
    const i = fakeInteraction({ user, customId, fields, ephemeral });
    const out = await handle(i, ctx);
    return { ...out, replies: i.replies, reply: i.replies[0] };
  };
  ctx.gate = (id) => gates.get(id).gate;
  ctx.send = (id, event) => gates.set(id, { gate: step(gates.get(id).gate, event, PEOPLE.holders, PEOPLE.leads).gate, ask: ASKS[id] });
  return ctx;
}

test('F-T27-12: holders are exactly the members with the driver role, leads those with the lead role; a bot is neither', () => {
  assert.deepEqual([...PEOPLE.holders], [ERICK, MAYA, JON]);
  assert.deepEqual([...PEOPLE.leads], [ERICK, JON]);
  assert.deepEqual([PEOPLE.names.get(SAM), PEOPLE.names.get(BRIDGE)], ['Sam', 'sage bridge']);
  // The owner (Erick, who asks) is a holder only through the role: without it, nobody is a holder.
  const noRoles = peopleOf([{ id: ERICK, name: 'Erick', roles: [] }], CONFIG);
  assert.deepEqual([[...noRoles.holders], [...noRoles.leads]], [[], []]);
});

test('a single question: the first press answers it and updates the card; a later press gets a private note', async () => {
  const b = bridge(['G5'], clock(14, 20));
  b.now = clock(14, 22);
  const first = await b.press(MAYA, 'press:G5:0:0');
  assert.deepEqual(first.effects, [{ type: 'closed', outcome: { status: 'answered', option: 'A', by: MAYA, via: 'discord' } }]);
  assert.equal(first.reply.kind, 'update');
  assert.match(first.reply.embeds[0].description, /\*\*Answered by Maya at <t:1791123720:t>: A\. Sign in again silently and keep the page\. Final\.\*\*$/);
  assert.deepEqual(first.reply.components[0].components.map((c) => [c.label, c.style, c.disabled]),
    [['A. Sign in again silently and keep the page', 3, true], ['B. Show a "Session ended" screen with a Sign-in button', 2, true], ['C. Ask first if the page has unsaved work', 2, true]]);
  b.now += 1000;
  const later = await b.press(JON, 'press:G5:0:1');
  assert.deepEqual(later.replies, [{ kind: 'reply', content: 'Already answered by Maya: A', ...PRIVATE }]);
  assert.equal(later.gate, first.gate);
});

test('a press from someone without the role gets the no-role note and changes nothing', async () => {
  const b = bridge(['G5', 'B7'], clock(14, 20));
  for (const id of ['press:G5:0:0', 'press:B7:0:0', 'end:B7', 'tiebreak:B7:0:0']) {
    const before = b.gate(id.split(':')[1]);
    const r = await b.press(SAM, id);
    assert.deepEqual(r.replies, [{ kind: 'reply', content: NO_ROLE, ...PRIVATE }], id);
    assert.equal(r.gate, before, id);
  }
});

test('a batch press counts at once and opens the reason modal; the modal submit stores the reason and updates the card', async () => {
  const b = bridge(['B7'], clock(14, 31));
  b.now = clock(14, 40);
  const pressed = await b.press(JON, 'press:B7:1:1');
  assert.deepEqual(pressed.replies.map((r) => r.kind), ['modal']);
  assert.equal(pressed.reply.custom_id, 'reason:B7:1:1');
  assert.equal(pressed.reply.title, "B. 04/10/2026 (the user's locale)"); // the prefix goes first when the full title does not fit in 45 characters (F-T27-18, F-T27-29)
  assert.deepEqual(pressed.reply.components[0].components[0], {
    type: 4, custom_id: 'reason', label: 'Reason for part 2 (optional)', style: 2, max_length: 500, required: false,
    placeholder: 'Everyone sees it on the card. The chief gets it as quoted text and sums up the arguments.',
  });
  assert.deepEqual(ballotsOf(b.gate('B7').parts[1]).get(JON), { option: 'B', at: clock(14, 40), via: 'discord' }); // counted before any reason
  b.now += MINUTE;
  const sent = await b.press(JON, 'reason:B7:1:1', { reason: 'Our EU customers read day/month first.' });
  assert.equal(sent.reply.kind, 'update');
  assert.deepEqual(ballotsOf(sent.gate.parts[1]).get(JON), { option: 'B', at: clock(14, 41), via: 'discord', reason: 'Our EU customers read day/month first.' });
  assert.deepEqual(sent.reply.embeds[0].fields.at(-1), { name: 'Jon, part 2', value: 'Our EU customers read day/month first.' });
  assert.match(sent.reply.embeds[0].fields[1].value, /\*\*B\.\*\* 04\/10\/2026 \(the user's locale\) · 1 vote \(Jon\)\n/);
  assert.match(sent.reply.embeds[0].fields[1].value, /Voted: Jon · Not voted: Erick, Maya\nAhead: B$/);
  // A changed vote replaces the ballot and the reason goes with the old ballot.
  const changed = await b.press(JON, 'press:B7:1:0');
  assert.deepEqual(ballotsOf(changed.gate.parts[1]).get(JON), { option: 'A', at: clock(14, 41), via: 'discord' });
});

test('a modal submit after the vote ended gets the vote-ended note, and the time limit still settles the vote', async () => {
  const b = bridge(['B7'], clock(14, 31));
  b.now = clock(14, 40);
  await b.press(MAYA, 'press:B7:0:0');
  b.now = clock(15, 1);
  const late = await b.press(MAYA, 'reason:B7:0:0', { reason: 'late' });
  assert.deepEqual(late.replies, [{ kind: 'reply', content: 'The vote on B7 ended at <t:1791126060:t>. Your press did not count.', ...PRIVATE }]);
  assert.deepEqual(late.effects, [{ type: 'vote-ended', by: null }, { type: 'decided', part: 0, option: 'A', how: 'votes' }, { type: 'ignored', by: MAYA, why: 'closed' }]);
  assert.equal(late.gate.phase, 'tied');
});

test('end vote now: a lead gets a confirm, confirms, and the vote ends; a non-lead holder and a cancel change nothing', async () => {
  const b = bridge(['B9'], clock(15, 10));
  b.now = clock(15, 20);
  await b.press(ERICK, 'press:B9:0:0'); await b.press(JON, 'press:B9:0:0'); await b.press(MAYA, 'press:B9:0:1');
  const maya = await b.press(MAYA, 'end:B9');
  assert.deepEqual(maya.replies, [{ kind: 'reply', content: "Only a sage-lead can do this. Your votes on the parts count like everyone's.", ...PRIVATE }]);
  const cancel = await b.press(JON, 'cancel:B9', undefined, true);
  assert.deepEqual(cancel.replies, [{ kind: 'update', content: 'Cancelled. The vote goes on.', ...PRIVATE, components: [] }]);
  assert.equal(cancel.gate.phase, 'voting');
  b.now = clock(15, 28);
  const confirm = await b.press(JON, 'end:B9');
  assert.equal(confirm.reply.kind, 'reply');
  assert.equal(confirm.reply.content, ['**End B9 now?**', 'Part 1 goes to A: 2 of 3 votes (Erick, Jon).',
    'Part 2 has no votes. It stays open until a sage-lead breaks the tie.', 'Nobody can vote after this.'].join('\n'));
  assert.deepEqual(confirm.reply.components[0].components.map((c) => [c.custom_id, c.label, c.style]), [['cancel:B9', 'Cancel', 2], ['end!:B9', 'End vote now', 4]]);
  assert.equal(confirm.gate.phase, 'voting');
  const ended = await b.press(JON, 'end!:B9', undefined, true);
  assert.deepEqual(ended.effects, [{ type: 'vote-ended', by: JON }, { type: 'decided', part: 0, option: 'A', how: 'votes' }]);
  assert.deepEqual(ended.replies, [{ kind: 'update', content: 'You ended the vote on B9 at <t:1791127680:t>.', ...PRIVATE, components: [] }]);
  assert.equal(ended.gate.votingEndedAt, clock(15, 28));
  // Maya forges the confirm button on her own private note: the vote rules refuse her.
  const forged = await b.press(MAYA, 'end!:B9', undefined, true);
  assert.deepEqual(forged.effects, [{ type: 'ignored', by: MAYA, why: 'not-lead' }]);
});

test('a tie-break: only a lead, only a tied option, only on a tied part; then the batch closes', async () => {
  const b = bridge(['B7'], clock(14, 31));
  b.now = clock(14, 40);
  await b.press(ERICK, 'press:B7:0:0'); await b.press(JON, 'press:B7:0:0');
  await b.press(ERICK, 'press:B7:1:0'); await b.press(JON, 'press:B7:1:1');
  await b.press(ERICK, 'press:B7:2:0'); await b.press(JON, 'press:B7:2:0');
  b.send('B7', { type: 'tick', at: clock(15, 1) });
  b.now = clock(15, 2);
  const tiedCard = (await b.press(JON, 'tiebreak:B7:1:2')).replies; // C has no votes: not among the tied
  assert.deepEqual(tiedCard, [{ kind: 'reply', content: 'Only one of the tied options can break the tie.', ...PRIVATE }]);
  const notTied = await b.press(JON, 'tiebreak:B7:0:0');
  assert.deepEqual(notTied.replies, [{ kind: 'reply', content: 'This part is not tied, so there is no tie to break.', ...PRIVATE }]);
  const maya = await b.press(MAYA, 'tiebreak:B7:1:0');
  assert.equal(maya.reply.content, "Only a sage-lead can do this. Your votes on the parts count like everyone's.");
  b.now = clock(17, 5);
  const broken = await b.press(JON, 'tiebreak:B7:1:0');
  assert.deepEqual(broken.effects, [{ type: 'decided', part: 1, option: 'A', how: 'lead-tiebreak' }, { type: 'closed', outcome: { status: 'decided' } }]);
  assert.equal(broken.reply.kind, 'update');
  assert.equal(broken.reply.embeds[0].description, 'Voting ended at <t:1791126060:t>. Closed: every part is decided. T7 goes on.');
  assert.match(broken.reply.embeds[0].fields[1].value, /\*\*Decided: A\*\* · tie broken by Jon \(sage-lead\) at <t:1791133500:t>$/);
  assert.match(broken.reply.embeds[0].fields[0].value, /\*\*Decided: A\*\* · 2 of 3 votes$/);
  assert.ok(broken.reply.components.every((r) => r.components.every((c) => c.disabled)));
});

test('a forged custom_id is refused: unknown gate, part, option index, or option text; a single question needs part 0', async () => {
  const b = bridge(['G5', 'B7'], clock(14, 31));
  const cases = [
    ['press:G9:0:0', 'I do not know this button or its question. Nothing changed.'],
    ['press:G5:0:A', 'I do not know this button or its question. Nothing changed.'],
    ['press:B7:1:Both, in two columns', 'I do not know this button or its question. Nothing changed.'],
    ['nonsense', 'I do not know this button or its question. Nothing changed.'],
    ['press:G5:1:0', 'This part is not on the card. Nothing changed.'],
    ['press:B7:3:0', 'This part is not on the card. Nothing changed.'],
    ['press:G5:0:3', 'This option is not on the card. Nothing changed.'],
    ['press:B7:2:2', 'This option is not on the card. Nothing changed.'],
    ['tiebreak:B7:9:0', 'This part is not on the card. Nothing changed.'],
  ];
  for (const [customId, content] of cases) {
    const r = await b.press(JON, customId);
    assert.deepEqual(r.replies, [{ kind: 'reply', content, ...PRIVATE }], customId);
    assert.deepEqual(r.effects, [], customId);
  }
  const single = await b.press(JON, 'end:G5');
  assert.deepEqual(single.replies, [{ kind: 'reply', content: 'This is a single question, not a vote: there is nothing to end and no tie to break.', ...PRIVATE }]);
  assert.deepEqual(single.effects, [{ type: 'ignored', by: JON, why: 'wrong-kind' }]);
  assert.equal(b.gate('G5').phase, 'open');
  assert.deepEqual(b.gate('B7').parts.map((p) => p.ballots), [[], [], []]);
});

test('by, via and at never come from the interaction: a press with a forged at and via still uses the user id, discord and the clock', async () => {
  const b = bridge(['B7'], clock(14, 31));
  b.now = clock(14, 45);
  const i = fakeInteraction({ user: MAYA, customId: 'press:B7:0:1' });
  Object.assign(i, { at: 1, via: 'terminal', by: ERICK, member: { user: { id: ERICK } } });
  const out = await handle(i, b);
  assert.deepEqual(ballotsOf(out.gate.parts[0]).get(MAYA), { option: 'B', at: clock(14, 45), via: 'discord' });
  assert.equal(ballotsOf(out.gate.parts[0]).has(ERICK), false);
});

test('a bad clock gives the bad-time note and a clock that goes back gives the out-of-order note', async () => {
  const b = bridge(['B7'], clock(14, 31));
  b.now = NaN;
  assert.equal((await b.press(MAYA, 'press:B7:0:0')).reply.content, 'The bridge clock gave a bad time, so nothing changed. Please press again.');
  b.now = clock(14, 30);
  assert.equal((await b.press(MAYA, 'press:B7:0:0')).reply.content, 'The bridge clock went back, so nothing changed. Please press again.');
  assert.deepEqual(b.gate('B7').parts[0].ballots, []);
});

test('every why code of the vote rules has its own private note, and so does the unknown-gate case', () => {
  const codes = ['bad-event', 'bad-time', 'out-of-order', 'not-holder', 'not-lead', 'lead-needs-discord', 'not-asker', 'unknown-option',
    'unknown-part', 'wrong-kind', 'not-tied', 'not-tied-option', 'closed', 'unknown-gate'];
  const gate = openAsk('B7', clock(14, 31));
  const texts = codes.map((why) => note(why, gate, PEOPLE.names).content);
  assert.equal(new Set(texts).size, codes.length);
  for (const n of codes.map((why) => note(why, gate, PEOPLE.names))) assert.deepEqual([n.flags, n.allowedMentions], [64, { parse: [] }]);
  assert.equal(note('not-asker', gate, PEOPLE.names).content, 'Only Erick, who asked B7, can withdraw it.');
  const withdrawn = step(gate, { type: 'withdraw', by: ERICK, at: clock(14, 32) }, PEOPLE.holders, PEOPLE.leads).gate;
  assert.equal(note('closed', withdrawn, PEOPLE.names).content, 'B7 was withdrawn by Erick. Nothing to answer.');
});
