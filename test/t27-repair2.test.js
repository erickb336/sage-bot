// The second repair of the B2 findings (F-T27-19 to F-T27-23): each test fails on the B2 head a05b938 and passes now.
// SAMPLE DATA: every id, name and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { card, reasonModal, safe } from '../src/cards.js';
import { handle, peopleOf } from '../src/handle.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { step, ballotsOf, MINUTE } from '../src/vote.js';
import { ASKS, MEMBERS, CONFIG, ERICK, MAYA, JON, clock, openAsk } from '../examples/sample.js';

const PEOPLE = peopleOf(MEMBERS, CONFIG);
const PRIVATE = { flags: 64, allowedMentions: { parse: [] } };
const T0 = clock(14, 31);
const ballot = (by, part, option, at, reason) => ({ type: 'press', by, part, option, at, via: 'discord', ...(reason !== undefined && { reason }) });
const apply = (gate, ...events) => events.reduce((g, e) => step(g, e, PEOPLE.holders, PEOPLE.leads).gate, gate);

/** A bridge with these open gates and a clock that the test moves; `refuse` makes every reply reject. */
function bridge(ids, at, refuse) {
  const gates = new Map(ids.map((id) => [id, { gate: openAsk(id, at), ask: ASKS[id] }]));
  const ctx = { gates, people: PEOPLE, clock: () => ctx.now, now: at };
  ctx.press = async (user, customId, fields, ephemeral = false) => {
    const i = fakeInteraction({ user, customId, fields, ephemeral, refuse });
    const out = await handle(i, ctx);
    return { ...out, replies: i.replies, reply: i.replies[0] };
  };
  ctx.gate = (id) => gates.get(id).gate;
  ctx.send = (id, ...events) => gates.set(id, { gate: apply(gates.get(id).gate, ...events), ask: ASKS[id] });
  return ctx;
}

test('F-T27-19: a reason of only spaces, newlines or hiding characters gives no reason field; a real reason gives one', () => {
  for (const reason of ['​​​', '   ', '\n\n', '‮ ﻿\n']) {
    const gate = apply(openAsk('B9', T0), ballot(MAYA, 0, 'A', T0 + MINUTE, reason));
    assert.equal(ballotsOf(gate.parts[0]).get(MAYA).reason, reason); // the gate keeps it as typed
    const [embed] = card(gate, ASKS.B9, PEOPLE).embeds;
    assert.deepEqual(embed.fields.map((f) => f.name), ['Part 1 · What does the empty reports page show?', 'Part 2 · Does the empty page link to the help article?'], JSON.stringify(reason));
    for (const f of embed.fields) assert.ok(f.name.length >= 1 && f.value.length >= 1);
  }
  const gate = apply(openAsk('B9', T0), ballot(MAYA, 0, 'A', T0 + MINUTE, ' yes ​'));
  assert.deepEqual(card(gate, ASKS.B9, PEOPLE).embeds[0].fields.at(-1), { name: 'Maya, part 1', value: 'yes' });
});

test('F-T27-19: the form submit of a space-only reason updates the card with no reason field', async () => {
  const b = bridge(['B9'], T0);
  b.now += MINUTE;
  await b.press(MAYA, 'press:B9:0:0');
  b.now += MINUTE;
  const r = await b.press(MAYA, 'reason:B9:0:0', { reason: ' ' });
  assert.equal(r.reply.kind, 'update');
  assert.equal(r.reply.embeds[0].fields.length, 2);
  assert.equal(ballotsOf(b.gate('B9').parts[0]).get(MAYA).reason, ' ');
});

test('F-T27-19, F-T27-22 d, F-T27-29: a holder whose name is empty, or only hiding characters, shows as "member …" and the last 4 of the id; no field is empty', () => {
  const names = new Map([[MAYA, ''], [JON, '​‮'], [ERICK, 'Erick']]);
  const gate = apply(openAsk('B9', T0), ballot(MAYA, 0, 'A', T0 + MINUTE, 'yes'), ballot(JON, 1, 'B', T0 + MINUTE));
  const [embed] = card(gate, ASKS.B9, { ...PEOPLE, names }).embeds;
  assert.deepEqual(embed.fields.at(-1), { name: 'member …maya, part 1', value: 'yes' });
  assert.match(embed.fields[1].value, /\*\*B\.\*\* No · 1 vote \(member …-jon\)/);
  assert.match(embed.fields[0].value, /Not voted: Erick, member …-jon/);
  const answered = apply(openAsk('G5', T0), { type: 'press', by: MAYA, option: 'A', at: T0 + MINUTE, via: 'discord' });
  assert.match(card(answered, ASKS.G5, { ...PEOPLE, names }).embeds[0].description, /Answered by member …maya /);
});

test('F-T27-20: when Discord refuses the reply after the store, handle resolves with the new gate, the effects and replyError', async () => {
  const refused = new Error('DiscordAPIError[10062]: Unknown interaction');
  // A single press: the answer closes the gate; the caller still gets the closed effect.
  let b = bridge(['G5', 'B9'], T0, refused);
  b.now += MINUTE;
  const single = await b.press(MAYA, 'press:G5:0:0');
  assert.equal(single.replyError, refused);
  assert.deepEqual(single.effects.map((e) => e.type), ['closed']);
  assert.equal(single.gate.phase, 'closed');
  assert.equal(b.gate('G5'), single.gate);
  assert.deepEqual(single.replies, []);
  // A batch press (the form cannot show): the vote counted. A ballot has no effect of its own in the vote rules.
  const press = await b.press(MAYA, 'press:B9:0:1');
  assert.equal(press.replyError, refused);
  assert.deepEqual(press.effects, []);
  assert.equal(ballotsOf(b.gate('B9').parts[0]).get(MAYA).option, 'B');
  // A reason submit: the reason is stored.
  const reason = await b.press(MAYA, 'reason:B9:0:1', { reason: 'the example confuses' });
  assert.equal(reason.replyError, refused);
  assert.deepEqual(reason.effects, []);
  assert.equal(ballotsOf(b.gate('B9').parts[0]).get(MAYA).reason, 'the example confuses');
  // A confirmed end: the vote ended.
  b.send('B9', ballot(ERICK, 0, 'A', b.now), ballot(JON, 0, 'A', b.now), ballot(ERICK, 1, 'A', b.now));
  b.now += MINUTE;
  const end = await b.press(JON, 'end!:B9', undefined, true);
  assert.equal(end.replyError, refused);
  assert.deepEqual(end.effects.map((e) => e.type), ['vote-ended', 'decided', 'decided', 'closed']);
  assert.equal(b.gate('B9').phase, 'closed');
  // A tie-break that closes the batch.
  b = bridge(['B9'], T0, refused);
  b.send('B9', ballot(ERICK, 0, 'A', T0 + MINUTE), ballot(JON, 0, 'B', T0 + MINUTE), ballot(ERICK, 1, 'A', T0 + MINUTE), { type: 'tick', at: clock(15, 1) });
  b.now = clock(15, 2);
  const broken = await b.press(JON, 'tiebreak:B9:0:0');
  assert.equal(broken.replyError, refused);
  assert.deepEqual(broken.effects.map((e) => e.type), ['decided', 'closed']);
  assert.equal(b.gate('B9').phase, 'closed');
  // Without a refusal there is no replyError.
  assert.equal('replyError' in (await bridge(['G5'], T0).press(MAYA, 'press:G5:0:0')), false);
});

test('F-T27-11: safe keeps the joiners and the tag characters (a family emoji, a Persian word, a subdivision flag), and removes the hiding characters', () => {
  for (const kept of ['👨‍👩‍👧', 'می‌خواهم', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'a‌b‍c']) assert.equal(safe(kept), kept);
  assert.equal(safe('‪a‫b‬c‭d‮e⁦f⁧g⁨h⁩i​j﻿k­l‎m‏n؜o'), 'abcdefghijklmno');
});

test('F-T27-21: one 500-character reason on a small card shows exactly 200 characters, the last one …', () => {
  const gate = apply(openAsk('B9', T0), ballot(MAYA, 0, 'A', T0 + MINUTE, 'word '.repeat(100)));
  const [embed] = card(gate, ASKS.B9, PEOPLE).embeds;
  const { value } = embed.fields.at(-1);
  assert.equal(value.length, 200);
  assert.ok(value.endsWith('…'));
  assert.equal(value.slice(0, 199), 'word '.repeat(100).trim().slice(0, 199));
});

test('F-T27-21, F-T27-29: Cancel on a gate that no longer votes says that the vote ended meanwhile, not "The vote goes on"', async () => {
  const b = bridge(['B9', 'B7'], T0);
  b.send('B9', { type: 'tick', at: clock(15, 1) });
  b.now = clock(15, 2);
  const tied = await b.press(JON, 'cancel:B9', undefined, true);
  assert.deepEqual(tied.replies, [{ kind: 'update', content: 'The vote on B9 ended at <t:1791126060:t> meanwhile. Nothing to cancel.', ...PRIVATE, components: [] }]);
  assert.deepEqual(tied.effects, []);
  b.send('B7', { type: 'withdraw', by: ERICK, at: b.now });
  const withdrawn = await b.press(JON, 'cancel:B7', undefined, true);
  assert.equal(withdrawn.reply.content, 'B7 was withdrawn by Erick. Nothing to answer.');
  const open = await bridge(['B9'], T0).press(JON, 'cancel:B9', undefined, true);
  assert.equal(open.reply.content, 'Cancelled. The vote goes on.');
  const single = await bridge(['G5'], T0).press(JON, 'cancel:G5', undefined, true); // a forged cancel on a single question
  assert.equal(single.reply.content, 'This is a single question, not a vote: there is nothing to end and no tie to break.');
});

test('F-T27-23, F-T27-29: the form title drops its prefix first, then cuts at the last space before 45 characters and keeps the key whole', () => {
  assert.equal(reasonModal(openAsk('B7', T0), ASKS.B7, 0, 0).title, 'A. Only the columns visible in the table');
  assert.equal(reasonModal(openAsk('B7', T0), ASKS.B7, 0, 2).title, 'C. Visible columns, plus an "Include hidden…');
  assert.equal(reasonModal(openAsk('B9', T0), ASKS.B9, 1, 1).title, 'Your vote counts: B. No');
  const ask = { ...ASKS.B9, parts: [{ ...ASKS.B9.parts[0], options: { A: 'x'.repeat(60), B: 'No' } }, ASKS.B9.parts[1]] };
  assert.equal(reasonModal(openAsk('B9', T0), ask, 0, 0).title, `A. ${'x'.repeat(41)}…`);
  assert.equal(reasonModal(openAsk('B9', T0), ask, 0, 0).title.length, 45);
});

test('F-T27-20, F-T27-22: the README tells B3 about replyError, the full not-lead note, the 4-part limit and the cancel button', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('`replyError`'));
  assert.ok(readme.includes('"Only a sage-lead can do this. Your votes on the parts count like everyone\'s."'));
  assert.ok(readme.includes('B3 refuses an ask with more than 4 parts'));
  assert.ok(readme.includes('A `cancel:` press from any private message only answers'));
});
