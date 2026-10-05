// The repair of the B2 review findings (F-T27-7 to F-T27-18): each test fails on the B2 head 504f66c and passes now.
// SAMPLE DATA: every id, name and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { embedLength } from 'discord.js';
import { card, confirmEnd, reasonModal, safe } from '../src/cards.js';
import { handle, peopleOf } from '../src/handle.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { openGate, step, ballotsOf, MINUTE } from '../src/vote.js';
import { ASKS, MEMBERS, CONFIG, ERICK, MAYA, JON, clock, openAsk } from '../examples/sample.js';

const PEOPLE = peopleOf(MEMBERS, CONFIG);
const PRIVATE = { flags: 64, allowedMentions: { parse: [] } };
const UNKNOWN = { kind: 'reply', content: 'I do not know this button or its question. Nothing changed.', ...PRIVATE };
const T0 = clock(14, 31);
const ballot = (by, part, option, at, reason) => ({ type: 'press', by, part, option, at, via: 'discord', ...(reason !== undefined && { reason }) });
const labels = (c) => c.components.flatMap((r) => r.components.map((b) => b.label));

/** A bridge with these open gates and a clock that the test moves. */
function bridge(ids, at, people = PEOPLE) {
  const gates = new Map(ids.map((id) => [id, { gate: openAsk(id, at), ask: ASKS[id] }]));
  const ctx = { gates, people, clock: () => ctx.now, now: at };
  ctx.press = async (user, customId, fields, ephemeral) => {
    const i = fakeInteraction({ user, customId, fields, ephemeral });
    const out = await handle(i, ctx);
    return { ...out, replies: i.replies, reply: i.replies[0] };
  };
  ctx.gate = (id) => gates.get(id).gate;
  ctx.send = (id, event) => gates.set(id, { gate: step(gates.get(id).gate, event, people.holders, people.leads).gate, ask: ASKS[id] });
  return ctx;
}

test('F-T27-8: every masked link is escaped, also the second and the third', () => {
  assert.equal(safe('see [a](http://x.example) and [b](http://y.example)'), 'see \\[a\\](http:// x.example) and \\[b\\](http:// y.example)');
  assert.equal(safe('[1](http://a) [2](<http://b>) [3](http://c)'), '\\[1\\](http:// a) \\[2\\](\\<http:// b\\>) \\[3\\](http:// c)');
  assert.doesNotMatch(safe('[x](http://a) [y](http://b)'), /[^\\]\]\(/);
  assert.equal(safe('plain ] and [ alone'), 'plain \\] and \\[ alone');
});

test('F-T27-11: hiding characters (zero-width space, bidi controls and marks, BOM, soft hyphen) are removed from reasons and names', () => {
  assert.equal(safe('Er\u200bick\u202ekcire\u200e\ufeff'), 'Erickkcire'); // zero-width space, right-to-left override, left-to-right mark, BOM
  assert.equal(safe('\u2066A\u2069 \u00adB\u061cC'), 'A BC'); // isolates, soft hyphen, Arabic letter mark; the joiners stay (see t27-repair2)
  const gate = step(openAsk('B7', T0), ballot(MAYA, 0, 'A', T0 + MINUTE, 'yes​‮ please'), PEOPLE.holders, PEOPLE.leads).gate;
  const names = new Map([[MAYA, 'Ma​ya']]);
  const c = card(gate, ASKS.B7, { ...PEOPLE, names });
  assert.deepEqual(c.embeds[0].fields[3], { name: 'Maya, part 1', value: 'yes please' });
});

/** A batch of `nParts` parts with 3 options, and `nHolders` holders with 15-character names. */
function team(nHolders, nParts) {
  const members = Array.from({ length: nHolders }, (_, i) => ({ id: `h${i}`, name: `Holder Number ${i}`, roles: ['drv', ...(i === 0 ? ['ld'] : [])] }));
  const people = peopleOf(members, { driverRole: 'drv', leadRole: 'ld' });
  const parts = Array.from({ length: nParts }, () => ['A', 'B', 'C']);
  const ask = { kind: 'batch', task: 'T7', title: 'date formats', parts: parts.map((_, i) => ({ question: `Question ${i + 1}`, why: 'because', recommended: 'A', options: { A: 'alpha', B: 'beta', C: 'gamma' } })) };
  const gates = new Map([['B7', { gate: openGate({ id: 'B7', kind: 'batch', parts, askedBy: 'h0', at: T0 }), ask }]]);
  const ctx = { gates, people, clock: () => ctx.now, now: T0, ask };
  return ctx;
}

test('F-T27-9, F-T27-30: 5 holders, 4 parts and 500-character reasons fit Discord: the newest reasons at 200 characters, the oldest go', async () => {
  const ctx = team(5, 4);
  for (let p = 0; p < 4; p++) for (let h = 0; h < 5; h++) {
    ctx.now += 1000;
    await handle(fakeInteraction({ user: `h${h}`, customId: `reason:B7:${p}:0`, fields: { reason: `${p}${h}`.repeat(250) } }), ctx);
  }
  const gate = ctx.gates.get('B7').gate;
  assert.equal(ballotsOf(gate.parts[3]).get('h4').reason.length, 500); // the gate keeps the full text
  const [embed] = card(gate, ctx.ask, ctx.people).embeds;
  assert.ok(embedLength(embed) <= 6000, `embed length ${embedLength(embed)}`);
  // 20 reasons of 200 characters do not fit beside 4 parts, so the 2 oldest (h0 and h1 on part 1) go; the 18 newest show whole at 200.
  const reasons = embed.fields.slice(4);
  assert.equal(embed.fields.length, 22);
  assert.deepEqual(reasons.map((f) => f.name), [1, 2, 3, 4].flatMap((p) => [0, 1, 2, 3, 4].map((h) => `Holder Number ${h}, part ${p}`)).slice(2));
  for (const f of reasons) assert.ok(f.value.length === 200 && f.value.endsWith('…'), f.value.length);
  assert.ok(embed.fields.every((f) => f.name.length <= 256 && f.value.length <= 1024));
  // 32-character names (Discord's longest) with markdown: more of the oldest reasons go; the shown ones still have their 200 characters.
  const names = new Map([...ctx.people.names].map(([id]) => [id, '*'.repeat(32)]));
  const [wide] = card(gate, ctx.ask, { ...ctx.people, names }).embeds;
  assert.ok(embedLength(wide) <= 6000, `embed length ${embedLength(wide)}`);
  assert.ok(wide.fields.length < 22 && wide.fields.length > 10, `${wide.fields.length} fields`);
  assert.ok(wide.fields.slice(4).every((f) => f.value.length === 200 && f.value.endsWith('…')));
  assert.equal(wide.fields.at(-1).value, '34'.repeat(100).slice(0, 199) + '…'); // the newest reason, h4 on part 4
});

test('F-T27-9: a card that cannot be built leaves the stored gate as it was', async () => {
  const ctx = team(2, 6); // 6 parts: 6 rows of buttons and the end row, over Discord's 5
  const before = ctx.gates.get('B7').gate;
  ctx.now += 1000;
  const i = fakeInteraction({ user: 'h0', customId: 'reason:B7:0:0', fields: { reason: 'x' } });
  await assert.rejects(handle(i, ctx), RangeError);
  assert.equal(ctx.gates.get('B7').gate, before);
  assert.deepEqual(i.replies, []);
});

test('F-T27-13: End vote now on an ended, closed or withdrawn vote, or past the limit by the clock, gets the closed note, never a confirm', async () => {
  const b = bridge(['B7', 'B9', 'G5'], T0);
  b.now = T0 + MINUTE;
  await b.press(ERICK, 'press:B7:0:0'); await b.press(JON, 'press:B7:0:0'); await b.press(MAYA, 'press:B7:0:1');
  // Past the limit by the clock, before any tick: the press settles the vote and the note says when it ended.
  b.now = clock(15, 2);
  const late = await b.press(JON, 'end:B7');
  assert.deepEqual(late.replies, [{ kind: 'reply', content: 'The vote on B7 ended at <t:1791126060:t>. Your press did not count.', ...PRIVATE }]);
  assert.equal(late.gate.phase, 'tied');
  assert.deepEqual(late.effects.map((e) => e.type), ['vote-ended', 'decided', 'ignored']);
  // Ended (tied, waits for a lead): the same note.
  assert.equal((await b.press(ERICK, 'end:B7')).reply.content, 'The vote on B7 ended at <t:1791126060:t>. Your press did not count.');
  // Withdrawn.
  b.send('B9', { type: 'withdraw', by: ERICK, at: b.now });
  assert.deepEqual((await b.press(JON, 'end:B9')).replies, [{ kind: 'reply', content: 'B9 was withdrawn by Erick. Nothing to answer.', ...PRIVATE }]);
  // Closed by an answer.
  await b.press(MAYA, 'press:G5:0:0');
  assert.deepEqual((await b.press(JON, 'end:G5')).replies, [{ kind: 'reply', content: 'Already answered by Maya: A', ...PRIVATE }]);
  for (const r of [late]) assert.doesNotMatch(r.reply.content, /End .* now\?/);
});

test('F-T27-14: End vote now (confirmed) and Cancel count only from the private confirm; from the public card they are unknown', async () => {
  const b = bridge(['B9'], T0);
  b.now = T0 + MINUTE;
  await b.press(ERICK, 'press:B9:0:0');
  const before = b.gate('B9');
  for (const id of ['end!:B9', 'cancel:B9']) {
    const r = await b.press(JON, id, undefined, false);
    assert.deepEqual(r.replies, [UNKNOWN], id);
    assert.deepEqual(r.effects, [], id);
    assert.equal(b.gate('B9'), before, id);
  }
  const ok = await b.press(JON, 'end!:B9', undefined, true);
  assert.equal(ok.reply.kind, 'update');
  assert.equal(ok.gate.votingEndedAt, b.now);
});

test('F-T27-17: batch buttons read "Part 1, A: option" cut to 80 with …; lead buttons say (sage-lead only); no middle dot in a label', () => {
  const long = 'An option whose text runs on and on, far past the eighty characters that Discord allows on a button';
  const ask = { ...ASKS.B9, parts: [{ ...ASKS.B9.parts[0], options: { ...ASKS.B9.parts[0].options, A: long } }, ASKS.B9.parts[1]] };
  const open = card(openAsk('B9', T0), ask, PEOPLE);
  assert.deepEqual(labels(open), [
    'Part 1, A: An option whose text runs on and on, far past the eighty characters …', 'Part 1, B: Only a "Create report" button',
    'Part 2, A: Yes, under the button', 'Part 2, B: No', 'End vote now (sage-lead only)',
  ]);
  assert.equal(labels(open)[0].length, 80);
  const tied = step(openAsk('B9', T0), { type: 'end', by: JON, at: T0 + MINUTE, via: 'discord' }, PEOPLE.holders, PEOPLE.leads).gate;
  assert.deepEqual(labels(card(tied, ASKS.B9, PEOPLE)), ['Part 1, break the tie: A (sage-lead only)', 'Part 1, break the tie: B (sage-lead only)',
    'Part 2, break the tie: A (sage-lead only)', 'Part 2, break the tie: B (sage-lead only)']);
  for (const c of [open, card(tied, ASKS.B9, PEOPLE), confirmEnd(openAsk('B9', T0), PEOPLE)]) for (const l of labels(c)) assert.doesNotMatch(l, /·/, l);
});

test('F-T27-10: a reason submit with no fields, or without the reason field, gets a note and throws nothing', async () => {
  const b = bridge(['B7'], T0);
  b.now = T0 + MINUTE;
  await b.press(MAYA, 'press:B7:0:0');
  const before = b.gate('B7');
  const note = { kind: 'reply', content: 'This press is not one I understand. Nothing changed.', ...PRIVATE };
  assert.deepEqual((await b.press(MAYA, 'reason:B7:0:0')).replies, [note]); // a button press has no fields
  assert.deepEqual((await b.press(MAYA, 'reason:B7:0:0', { other: 'x' })).replies, [note]);
  assert.equal(b.gate('B7'), before);
  assert.throws(() => fakeInteraction({ user: MAYA, customId: 'reason:B7:0:0', fields: {} }).fields.getTextInputValue('reason'), TypeError);
  assert.equal(fakeInteraction({ user: MAYA, customId: 'press:B7:0:0' }).fields, undefined);
});

test('F-T27-16: with every part tied the card does not call the other parts provisional; the confirm counts "2 of 3 votes"', () => {
  const gate = step(openAsk('B9', T0), { type: 'tick', at: clock(15, 1) }, PEOPLE.holders, PEOPLE.leads).gate;
  assert.equal(card(gate, ASKS.B9, PEOPLE).embeds[0].description, 'Voting ended at <t:1791126060:t>. 2 parts are tied: they wait for a sage-lead. T9 waits.');
  const voted = [ballot(ERICK, 0, 'A', T0 + MINUTE), ballot(JON, 0, 'A', T0 + MINUTE)].reduce((g, e) => step(g, e, PEOPLE.holders, PEOPLE.leads).gate, openAsk('B9', T0));
  assert.match(confirmEnd(voted, PEOPLE).content, /\nPart 1 goes to A: 2 of 3 votes \(Erick, Jon\)\.\n/);
});

test('F-T27-18: the form title shows the option within 45 characters; Cancel comes first; an early end says so on the card', () => {
  assert.equal(reasonModal(openAsk('B7', T0), ASKS.B7, 0, 2).title, 'C. Visible columns, plus an "Include hidden…'); // at a word, without the prefix (F-T27-23, F-T27-29)
  assert.equal(reasonModal(openAsk('B9', T0), ASKS.B9, 1, 1).title, 'Your vote counts: B. No');
  assert.deepEqual(confirmEnd(openAsk('B9', T0), PEOPLE).components[0].components.map((c) => c.label), ['Cancel', 'End vote now']);
  const early = step(openAsk('B9', T0), { type: 'end', by: JON, at: clock(14, 50), via: 'discord' }, PEOPLE.holders, PEOPLE.leads).gate;
  assert.match(card(early, ASKS.B9, PEOPLE).embeds[0].description, /^Ended early by Jon \(sage-lead\) at <t:1791125400:t>, with the votes so far\. /);
  const onTime = step(openAsk('B9', T0), { type: 'tick', at: clock(15, 1) }, PEOPLE.holders, PEOPLE.leads).gate;
  assert.match(card(onTime, ASKS.B9, PEOPLE).embeds[0].description, /^Voting ended at <t:1791126060:t>\. /);
});

test('F-T27-7: the README documents the fake layer: fakeInteraction({ user, customId, fields, ephemeral, refuse }) and the reason input id', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('fakeInteraction({ user, customId, fields, ephemeral, refuse })'));
  assert.ok(readme.includes("`getTextInputValue('reason')`"));
});
