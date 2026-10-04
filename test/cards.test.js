// The card JSON for each state of a gate. SAMPLE DATA: every id, name and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card, confirmEnd, note, reasonModal, safe, parseCustomId, customId } from '../src/cards.js';
import { peopleOf } from '../src/handle.js';
import { step, openGate, MINUTE } from '../src/vote.js';
import { ASKS, MEMBERS, CONFIG, ERICK, MAYA, JON, clock, openAsk } from '../examples/sample.js';

const PEOPLE = peopleOf(MEMBERS, CONFIG);
const T0 = clock(14, 31);
const END = clock(15, 1);
const ts = (ms) => Math.floor(ms / 1000);
const run = (gate, events) => events.reduce((g, e) => step(g, e, PEOPLE.holders, PEOPLE.leads).gate, gate);
const ballot = (by, part, option, at, reason) => ({ type: 'press', by, part, option, at, via: 'discord', ...(reason !== undefined && { reason }) });
const buttons = (c) => c.components.map((r) => r.components.map((b) => `${b.custom_id} ${b.label} s${b.style}${b.disabled ? ' off' : ''}`));

test('an open batch card: a live countdown, the tally per part with voters and non-voters, and the end row', () => {
  const gate = run(openAsk('B7', T0), [
    { type: 'press', by: ERICK, part: 0, option: 'A', at: T0 + MINUTE, via: 'terminal' },
    ballot(JON, 0, 'A', T0 + 2 * MINUTE), ballot(ERICK, 1, 'A', T0 + 3 * MINUTE),
    ballot(JON, 1, 'B', T0 + 4 * MINUTE, 'Our EU customers read day/month first.'),
  ]);
  const c = card(gate, ASKS.B7, PEOPLE);
  const [embed] = c.embeds;
  assert.equal(embed.title, 'Batch vote B7 · T7 CSV export for reports');
  assert.equal(embed.description, `3 product questions of T7. Vote on each part; change your vote until the vote ends. Closes at <t:${ts(END)}:t> (<t:${ts(END)}:R>).`);
  assert.equal(embed.fields[0].name, 'Part 1 · Which columns go in the export?');
  assert.equal(embed.fields[0].value, [
    '**A.** Only the columns visible in the table · Recommended · 2 votes (Erick (terminal), Jon)',
    '**B.** All fields, also the hidden ones · 0 votes',
    '**C.** Visible columns, plus an "Include hidden fields" box · 0 votes',
    'The chief recommends A: A matches what the user sees; B can leak internal ids.',
    'Voted: Erick (terminal), Jon · Not voted: Maya',
    'Ahead: A',
  ].join('\n'));
  assert.match(embed.fields[1].value, /Voted: Erick, Jon · Not voted: Maya\nEven so far$/);
  assert.match(embed.fields[2].value, /Voted: nobody yet · Not voted: Erick, Maya, Jon\nNo votes yet$/);
  assert.deepEqual(embed.fields[3], { name: 'Jon, part 2', value: 'Our EU customers read day/month first.' });
  assert.deepEqual(buttons(c), [
    ['press:B7:0:0 Part 1, A: Only the columns visible in the table s1', 'press:B7:0:1 Part 1, B: All fields, also the hidden ones s2',
      'press:B7:0:2 Part 1, C: Visible columns, plus an "Include hidden fields" box s2'],
    ['press:B7:1:0 Part 2, A: 2026-10-04 (ISO) s1', "press:B7:1:1 Part 2, B: 04/10/2026 (the user's locale) s2", 'press:B7:1:2 Part 2, C: Both, in two columns s2'],
    ['press:B7:2:0 Part 3, A: reports-2026-10-04.csv s1', 'press:B7:2:1 Part 3, B: The report title and the date s2'],
    ['end:B7 End vote now (sage-lead only) s4'],
  ]);
  assert.deepEqual(c.allowedMentions, { parse: [] });
});

test('a reason with mentions, markdown, newlines and backticks shows as one inert line', () => {
  const hostile = '@everyone <@123> <@&9> **bold** _it_ ~~gone~~ ||spoiler|| `code` ```block```\n# heading\n- list\n[x](https://a.b) <t:1:R> <:e:1>';
  const gate = run(openAsk('B7', T0), [ballot(MAYA, 0, 'A', T0 + MINUTE, hostile)]);
  const c = card(gate, ASKS.B7, PEOPLE);
  assert.deepEqual(c.embeds[0].fields[3], { name: 'Maya, part 1',
    value: '@everyone @123 @&9 \\*\\*bold\\*\\* \\_it\\_ \\~\\~gone\\~\\~ \\|\\|spoiler\\|\\| code block # heading - list \\[x\\](https:// a.b) t:1:R :e:1' });
  assert.equal(safe('a\r\n\t b   c '), 'a b c');
  // A hostile display name is made inert the same way, everywhere a name shows.
  const names = new Map([[MAYA, '**@everyone** <@1>']]);
  const named = card(gate, ASKS.B7, { ...PEOPLE, names });
  assert.match(named.embeds[0].fields[0].value, /1 vote \(\\\*\\\*@everyone\\\*\\\* @1\)/);
  assert.equal(note('closed', run(openAsk('G5', T0), [{ type: 'press', by: MAYA, option: 'A', at: T0, via: 'discord' }]), names).content,
    'Already answered by \\*\\*@everyone\\*\\* @1: A');
});

test('at the limit a tied part shows tie-break buttons for the tied options only; decided parts are provisional', () => {
  const gate = run(openAsk('B7', T0), [
    ballot(ERICK, 0, 'A', T0 + MINUTE), ballot(JON, 0, 'A', T0 + MINUTE), ballot(MAYA, 0, 'A', T0 + MINUTE),
    ballot(ERICK, 1, 'A', T0 + MINUTE), ballot(JON, 1, 'B', T0 + MINUTE),
    ballot(ERICK, 2, 'A', T0 + MINUTE), ballot(JON, 2, 'B', T0 + MINUTE), ballot(MAYA, 2, 'A', T0 + MINUTE),
    { type: 'tick', at: END },
  ]);
  const c = card(gate, ASKS.B7, PEOPLE);
  assert.equal(c.embeds[0].description, `Voting ended at <t:${ts(END)}:t>. 1 part is tied: it waits for a sage-lead. The other parts are provisional, and T7 waits.`);
  assert.match(c.embeds[0].fields[0].value, /\n\*\*Provisional: A\*\* · 3 of 3 votes$/);
  assert.match(c.embeds[0].fields[1].value, /\n\*\*Tied: A, B at 1 vote each\.\*\* A sage-lead breaks the tie\.$/);
  assert.match(c.embeds[0].fields[2].value, /\n\*\*Provisional: A\*\* · 2 of 3 votes$/);
  assert.deepEqual(buttons(c), [
    ['press:B7:0:0 Part 1, A: Only the columns visible in the table s3 off', 'press:B7:0:1 Part 1, B: All fields, also the hidden ones s2 off',
      'press:B7:0:2 Part 1, C: Visible columns, plus an "Include hidden fields" box s2 off'],
    ['tiebreak:B7:1:0 Part 2, break the tie: A (sage-lead only) s4', 'tiebreak:B7:1:1 Part 2, break the tie: B (sage-lead only) s4'],
    ['press:B7:2:0 Part 3, A: reports-2026-10-04.csv s3 off', 'press:B7:2:1 Part 3, B: The report title and the date s2 off'],
  ]);
  // A part with no votes offers every option to the lead, and the lead's early end says so (F-T27-18), not "closed".
  const early = run(openAsk('B9', T0), [ballot(ERICK, 0, 'A', T0 + MINUTE), { type: 'end', by: JON, at: T0 + 2 * MINUTE, via: 'discord' }]);
  const e = card(early, ASKS.B9, PEOPLE);
  assert.equal(e.embeds[0].description, `Ended early at <t:${ts(T0 + 2 * MINUTE)}:t> by a sage-lead, with the votes so far. 1 part is tied: it waits for a sage-lead. The other parts are provisional, and T9 waits.`);
  assert.match(e.embeds[0].fields[1].value, /\n\*\*Tied: no votes\.\*\* A sage-lead breaks the tie\.$/);
  assert.deepEqual(buttons(e)[1], ['tiebreak:B9:1:0 Part 2, break the tie: A (sage-lead only) s4', 'tiebreak:B9:1:1 Part 2, break the tie: B (sage-lead only) s4']);
});

test('a withdrawn batch says who withdrew it and when, decides nothing and disables every button', () => {
  const gate = run(openAsk('B9', T0), [ballot(ERICK, 0, 'A', T0 + MINUTE), ballot(JON, 0, 'A', T0 + MINUTE), { type: 'withdraw', by: ERICK, at: clock(15, 20) }]);
  const c = card(gate, ASKS.B9, PEOPLE);
  assert.equal(c.embeds[0].description, `**Withdrawn by Erick at <t:${ts(clock(15, 20))}:t>.** Closed: nothing is decided.`);
  assert.match(c.embeds[0].fields[0].value, /Voted: Erick, Jon · Not voted: Maya$/);
  assert.doesNotMatch(c.embeds[0].fields[0].value, /Decided|Provisional|Ahead/);
  assert.deepEqual(buttons(c), [['press:B9:0:0 Part 1, A: An example report and a "Create report" button s1 off', 'press:B9:0:1 Part 1, B: Only a "Create report" button s2 off'],
    ['press:B9:1:0 Part 2, A: Yes, under the button s1 off', 'press:B9:1:1 Part 2, B: No s2 off']]);
  // A withdraw after the limit, with a tied part, reads the same way.
  const late = run(openAsk('B9', T0), [{ type: 'withdraw', by: ERICK, at: END + MINUTE }]);
  assert.equal(card(late, ASKS.B9, PEOPLE).embeds[0].description, `**Withdrawn by Erick at <t:${ts(END + MINUTE)}:t>.** Closed: nothing is decided.`);
  const single = run(openAsk('G5', T0), [{ type: 'withdraw', by: ERICK, at: T0 + MINUTE }]);
  assert.match(card(single, ASKS.G5, PEOPLE).embeds[0].description, /\n\*\*Withdrawn by Erick at <t:\d+:t>\.\*\* Nothing to answer\.$/);
});

test('a single question card: options with Recommended and Default, the rule, and one button per option', () => {
  const c = card(openAsk('G5', clock(14, 20)), ASKS.G5, PEOPLE);
  assert.equal(c.embeds[0].title, 'Question G5 · T8 Fix login timeout on mobile');
  assert.equal(c.embeds[0].description, [
    '**When a session expires on mobile, what does the user see?**', '',
    '**A.** Sign in again silently and keep the page · Recommended · Default',
    '**B.** Show a "Session ended" screen with a Sign-in button',
    '**C.** Ask first if the page has unsaved work', '',
    '**Why recommended:** A keeps the user in flow; the token refresh exists.',
    '**Default:** Sign in again silently and keep the page, but no time-out applies it',
    '**Rule:** the first answer is final · reminder every 2 h until answered',
    '**Who can answer:** every sage-driver',
  ].join('\n'));
  assert.deepEqual(buttons(c), [['press:G5:0:0 A. Sign in again silently and keep the page s1',
    'press:G5:0:1 B. Show a "Session ended" screen with a Sign-in button s2', 'press:G5:0:2 C. Ask first if the page has unsaved work s2']]);
  const terminal = run(openAsk('G5', T0), [{ type: 'press', by: ERICK, option: 'B', at: T0 + MINUTE, via: 'terminal' }]);
  assert.match(card(terminal, ASKS.G5, PEOPLE).embeds[0].description, /\*\*Answered by Erick \(terminal\) at <t:\d+:t>: B\. Show a "Session ended" screen with a Sign-in button\. Final\.\*\*$/);
});

test('the reason modal and the end confirm carry the limits and the custom ids; a card with more than 5 rows is refused', () => {
  const gate = openAsk('B7', T0);
  const modal = reasonModal(gate, ASKS.B7, 2, 1);
  assert.equal(modal.custom_id, 'reason:B7:2:1');
  assert.equal(modal.title, 'B. The report title and the date'); // the prefix goes first when the full title does not fit in 45 characters (F-T27-18, F-T27-29)
  assert.equal(reasonModal(openAsk('B9', T0), ASKS.B9, 1, 0).title, 'Your vote counts: A. Yes, under the button');
  assert.equal(modal.components[0].components[0].max_length, 500);
  const confirm = confirmEnd(run(gate, [ballot(ERICK, 1, 'A', T0 + MINUTE), ballot(JON, 1, 'B', T0 + MINUTE)]), PEOPLE);
  assert.equal(confirm.content, ['**End B7 now?**', 'Part 1 has no votes. It stays open until a sage-lead breaks the tie.',
    'Part 2 is tied A, B at 1 vote each. It stays open until a sage-lead breaks the tie.',
    'Part 3 has no votes. It stays open until a sage-lead breaks the tie.', 'Nobody can vote after this.'].join('\n'));
  assert.deepEqual([confirm.flags, confirm.allowedMentions], [64, { parse: [] }]);
  const wide = openGate({ id: 'g', kind: 'batch', parts: [['a'], ['a'], ['a'], ['a'], ['a']], askedBy: ERICK, at: T0 });
  const ask = { kind: 'batch', task: 'T', title: 't', parts: wide.parts.map(() => ({ question: 'q', why: 'w', recommended: 'a', options: { a: 'a' } })) };
  assert.throws(() => card(wide, ask, PEOPLE), RangeError);
  assert.equal(card(run(wide, [{ type: 'tick', at: END }]), ask, PEOPLE).components.length, 5); // no end row after the vote
});

test('custom ids carry indexes, never option text, and parse back; a gate id may hold a colon', () => {
  assert.equal(customId('press', 'G:5', 0, 2), 'press:G:5:0:2');
  assert.deepEqual(parseCustomId('press:G:5:0:2'), { action: 'press', gateId: 'G:5', part: 0, index: 2 });
  assert.deepEqual(parseCustomId('end!:B7'), { action: 'end!', gateId: 'B7' });
  for (const bad of ['press:B7:1:B', 'press:B7:1', 'vote:B7:0:0', 'end:', '', 'press:B7:-1:0']) assert.equal(parseCustomId(bad), null, bad);
});
