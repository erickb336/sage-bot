// T39 (owner decision G11): the card names the sage-lead who broke a tie or ended a vote early, with the time.
// SAMPLE DATA ONLY (examples/sample.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, parseGate, step } from '../src/vote.js';
import { card } from '../src/cards.js';
import { peopleOf } from '../src/handle.js';
import { ASKS, CONFIG, ERICK, JON, MAYA, MEMBERS, clock, openAsk } from '../examples/sample.js';

const PEOPLE = peopleOf(MEMBERS, CONFIG);
const T0 = clock(14, 31);
const END = T0 + 30 * MINUTE;
const ts = (ms) => Math.floor(ms / 1000);
const run = (gate, events) => events.reduce((g, e) => step(g, e, PEOPLE.holders, PEOPLE.leads).gate, gate);
const ballot = (by, part, option, at) => ({ type: 'press', by, part, option, at, via: 'discord' });
/** B7 at the limit: part 2 tied A-B, parts 1 and 3 decided by votes. */
const tied = () => run(openAsk('B7', T0), [ballot(ERICK, 0, 'A', T0 + MINUTE), ballot(JON, 0, 'A', T0 + MINUTE),
  ballot(ERICK, 1, 'A', T0 + MINUTE), ballot(JON, 1, 'B', T0 + MINUTE), ballot(ERICK, 2, 'A', T0 + MINUTE), { type: 'tick', at: END }]);
const BREAK = clock(17, 5);
const broken = () => run(tied(), [{ type: 'tiebreak', by: JON, part: 1, option: 'A', at: BREAK, via: 'discord' }]);
const EARLY = clock(15, 28);
const early = () => run(openAsk('B9', clock(15, 10)), [ballot(ERICK, 0, 'A', clock(15, 15)), { type: 'end', by: JON, at: EARLY, via: 'discord' }]);
const json = (gate) => JSON.parse(JSON.stringify(gate));
const lastLine = (text) => text.split('\n').at(-1);

test('T39: a tie-break card says "tie broken by <name> (sage-lead) at <t>"', () => {
  const gate = broken();
  assert.deepEqual(gate.parts[1].outcome, { status: 'decided', option: 'A', how: 'lead-tiebreak', by: JON, at: BREAK });
  assert.equal(lastLine(card(gate, ASKS.B7, PEOPLE).embeds[0].fields[1].value), `**Decided: A** · tie broken by Jon (sage-lead) at <t:${ts(BREAK)}:t>`);
});

test('T39: an early-end card says "Ended early by <name> (sage-lead) at <t>, with the votes so far."', () => {
  const gate = early();
  assert.equal(gate.endedBy, JON);
  assert.equal(card(gate, ASKS.B9, PEOPLE).embeds[0].description,
    `Ended early by Jon (sage-lead) at <t:${ts(EARLY)}:t>, with the votes so far. 1 part is tied: it waits for a sage-lead. The other parts are provisional, and T9 waits.`);
});

test('T39: an end by time names nobody', () => {
  const gate = tied();
  assert.equal(gate.endedBy, null);
  assert.equal(card(gate, ASKS.B7, PEOPLE).embeds[0].description,
    `Voting ended at <t:${ts(END)}:t>. 1 part is tied: it waits for a sage-lead. The other parts are provisional, and T7 waits.`);
});

test('T39: the lead name goes through the people lookup and safe(): markdown and mentions stay inert text', () => {
  const names = new Map([...PEOPLE.names, [JON, '**@everyone** <@123>']]);
  const c = card(broken(), ASKS.B7, { ...PEOPLE, names });
  assert.equal(lastLine(c.embeds[0].fields[1].value), `**Decided: A** · tie broken by \\*\\*@everyone\\*\\* \\<@123\\> (sage-lead) at <t:${ts(BREAK)}:t>`);
  assert.deepEqual(c.allowedMentions, { parse: [] });
  // A lead with no display name gets the same fallback as every other name, never the raw id.
  const noName = card(early(), ASKS.B9, { ...PEOPLE, names: new Map() }).embeds[0].description;
  assert.match(noName, /^Ended early by member \(sage-lead\) at /);
});

test('T39: a gate saved before T39 (no endedBy, no by and at) still loads, and the card says "a sage-lead"', () => {
  const oldBroken = json(broken());
  delete oldBroken.endedBy;
  delete oldBroken.parts[1].outcome.by;
  delete oldBroken.parts[1].outcome.at;
  assert.equal(lastLine(card(parseGate(oldBroken), ASKS.B7, PEOPLE).embeds[0].fields[1].value), '**Decided: A** · tie broken by a sage-lead');
  const oldEarly = json(early());
  delete oldEarly.endedBy;
  assert.match(card(parseGate(oldEarly), ASKS.B9, PEOPLE).embeds[0].description,
    new RegExp(`^Ended early by a sage-lead at <t:${ts(EARLY)}:t>, with the votes so far\\. `));
  // A step on an old gate goes on; a new tie-break on it is named.
  const next = step(parseGate(oldEarly), { type: 'tiebreak', by: ERICK, part: 1, option: 'A', at: EARLY + 1, via: 'discord' }, PEOPLE.holders, PEOPLE.leads).gate;
  assert.deepEqual(next.parts[1].outcome, { status: 'decided', option: 'A', how: 'lead-tiebreak', by: ERICK, at: EARLY + 1 });
});

test('T39: parseGate refuses a by, at or endedBy that step could not make', () => {
  const forge = (make, change) => { const g = json(make()); change(g); return g; };
  const forged = {
    'by on a part decided by votes': forge(broken, (g) => { Object.assign(g.parts[0].outcome, { by: JON, at: BREAK }); }),
    'a tie-break with by and no at': forge(broken, (g) => { delete g.parts[1].outcome.at; }),
    'a tie-break with at and no by': forge(broken, (g) => { delete g.parts[1].outcome.by; }),
    'a tie-break by an empty id': forge(broken, (g) => { g.parts[1].outcome.by = ''; }),
    'a tie-break by a non-string': forge(broken, (g) => { g.parts[1].outcome.by = 7; }),
    'a tie-break after lastAt': forge(broken, (g) => { g.parts[1].outcome.at = BREAK + 1; }),
    'a tie-break before the vote ended': forge(broken, (g) => { g.parts[1].outcome.at = END - 1; }),
    'a tie-break at a time that is not a safe integer': forge(broken, (g) => { g.parts[1].outcome.at = BREAK - 0.5; }),
    'a tie-break with an unknown field': forge(broken, (g) => { g.parts[1].outcome.via = 'discord'; }),
    'endedBy on a vote that is still open': forge(() => openAsk('B9', T0), (g) => { g.endedBy = JON; }),
    'endedBy null on an early end': forge(early, (g) => { g.endedBy = null; }),
    'endedBy a lead on an end by time': forge(tied, (g) => { g.endedBy = JON; }),
    'endedBy an empty id': forge(early, (g) => { g.endedBy = ''; }),
    'endedBy a number': forge(early, (g) => { g.endedBy = 1; }),
    'endedBy on a single gate': forge(() => openAsk('G5', T0), (g) => { g.endedBy = null; }),
  };
  for (const [what, g] of Object.entries(forged)) assert.throws(() => parseGate(g), TypeError, what);
  // The gates that step makes load, also after a withdraw.
  const withdrawn = run(early(), [{ type: 'withdraw', by: ERICK, at: EARLY + MINUTE }]);
  for (const g of [broken(), early(), tied(), withdrawn]) assert.deepEqual(parseGate(json(g)), json(g));
  assert.equal(withdrawn.endedBy, JON);
});

test('T39: the two design sentences: the open intro says the work goes on; a tied part says sage reminds the leads', () => {
  const open = run(openAsk('B7', T0), [ballot(MAYA, 0, 'A', T0 + MINUTE)]);
  assert.match(card(open, ASKS.B7, PEOPLE).embeds[0].description, /^3 product questions of T7\. Vote on each part; change your vote until the vote ends\. The work on the task goes on\. Closes at /);
  assert.equal(lastLine(card(tied(), ASKS.B7, PEOPLE).embeds[0].fields[1].value),
    '**Tied: A, B at 1 vote each.** A sage-lead breaks the tie. sage-bot reminds @sage-lead every 2 h.');
});
