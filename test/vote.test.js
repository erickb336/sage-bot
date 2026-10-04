// Table-driven tests of the vote rules. SAMPLE DATA: every id here is a made-up sample, not a real Discord id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGate, step, view, nextReminderAt, cleanReason, MINUTE } from '../src/vote.js';

const ERICK = 'sample-erick';
const MAYA = 'sample-maya';
const JON = 'sample-jon';
const SAM = 'sample-sam'; // not on the holder list
const THREE = [ERICK, MAYA, JON];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time

const normal = () => openGate({ id: 'g1', kind: 'question', options: ['A', 'B', 'C'], askedBy: ERICK, at: T0 });
const critical = (kind = 'publish') => openGate({ id: 'g2', kind, askedBy: ERICK, at: T0 });

const press = (by, option, min, extra = {}) => ({ type: 'press', by, option, at: T0 + min * MINUTE, via: 'discord', ...extra });
const object = (by, min) => ({ type: 'object', by, at: T0 + min * MINUTE });
const tick = (min) => ({ type: 'tick', at: T0 + min * MINUTE });

/** Apply the events in order; return the last gate and all effects. */
function run(gate, events, holders = THREE) {
  const effects = [];
  for (const event of events) {
    const out = step(gate, event, holders);
    gate = out.gate;
    effects.push(...out.effects);
  }
  return { gate, effects, view: view(gate, holders) };
}

const cases = [
  {
    rule: 'first answer wins: the answer goes out at once, and closes approved when the 10-minute window ends',
    gate: normal, events: [press(MAYA, 'B', 0), tick(10)],
    phase: 'closed', outcome: { status: 'approved', option: 'B' },
    effects: [{ type: 'answer', option: 'B', by: MAYA }, { type: 'closed', outcome: { status: 'approved', option: 'B' } }],
  },
  {
    rule: 'inside the window the first answer stands but is not final yet',
    gate: normal, events: [press(MAYA, 'B', 0), tick(9.99)],
    phase: 'window', outcome: { status: 'open' },
  },
  {
    rule: 'an objection inside the window makes a vote',
    gate: normal, events: [press(MAYA, 'B', 0), object(JON, 5)],
    phase: 'vote', outcome: { status: 'open' },
    effects: [{ type: 'answer', option: 'B', by: MAYA }, { type: 'vote-opened', by: JON }],
  },
  {
    rule: 'a second, different press inside the window is an objection',
    gate: normal, events: [press(MAYA, 'B', 0), press(JON, 'A', 3)],
    phase: 'vote', outcome: { status: 'open' }, tied: true, counts: { A: 1, B: 1 },
  },
  {
    rule: 'a second, same press inside the window is not an objection',
    gate: normal, events: [press(MAYA, 'B', 0), press(JON, 'B', 3)],
    phase: 'window', outcome: { status: 'open' },
  },
  {
    rule: 'a press after the window does not object; the first answer is final',
    gate: normal, events: [press(MAYA, 'B', 0), press(JON, 'A', 10)],
    phase: 'closed', outcome: { status: 'approved', option: 'B' },
    effects: [
      { type: 'answer', option: 'B', by: MAYA },
      { type: 'closed', outcome: { status: 'approved', option: 'B' } },
      { type: 'ignored', by: JON, why: 'closed' },
    ],
  },
  {
    rule: 'an objection after the window does nothing',
    gate: normal, events: [press(MAYA, 'B', 0), object(JON, 11)],
    phase: 'closed', outcome: { status: 'approved', option: 'B' },
  },
  {
    rule: 'a strict majority (2 of 3) closes a normal vote',
    gate: normal, events: [press(MAYA, 'B', 0), object(JON, 1), press(ERICK, 'B', 30)],
    phase: 'closed', outcome: { status: 'approved', option: 'B' },
  },
  {
    rule: 'agreement before the objection counts: 2 of 3 already agree when the vote opens',
    gate: normal, events: [press(MAYA, 'B', 0), press(ERICK, 'B', 1), press(JON, 'A', 2)],
    phase: 'closed', outcome: { status: 'approved', option: 'B' },
  },
  {
    rule: 'half is not a strict majority: 2 of 4 holders stays open',
    gate: normal, holders: [...THREE, SAM], events: [press(MAYA, 'B', 0), object(JON, 1), press(ERICK, 'B', 2), press(JON, 'A', 3)],
    phase: 'vote', outcome: { status: 'open' },
  },
  {
    rule: '1-1 with 3 holders stays open, shown as tied; no deadline and no default after a week',
    gate: normal, events: [press(MAYA, 'B', 0), press(JON, 'A', 1), tick(7 * 24 * 60)],
    phase: 'vote', outcome: { status: 'open' }, tied: true, counts: { A: 1, B: 1 },
  },
  {
    rule: '1-1-1 stays open, shown as tied',
    gate: normal, events: [press(MAYA, 'B', 0), press(JON, 'A', 1), press(ERICK, 'C', 2)],
    phase: 'vote', outcome: { status: 'open' }, tied: true, counts: { A: 1, B: 1, C: 1 },
  },
  {
    rule: 'a vote with one leader and no majority is open and not tied',
    gate: normal, events: [press(MAYA, 'B', 0), object(JON, 1)],
    phase: 'vote', outcome: { status: 'open' }, tied: false, counts: { B: 1 },
  },
  {
    rule: 'changing a vote ends a tie: the last ballot of each person counts',
    gate: normal, events: [press(MAYA, 'B', 0), press(JON, 'A', 1), press(ERICK, 'C', 2), press(ERICK, 'A', 60)],
    phase: 'closed', outcome: { status: 'approved', option: 'A' },
  },
  {
    rule: 'a press for an option the gate does not have is ignored',
    gate: normal, events: [press(MAYA, 'Z', 0)],
    phase: 'waiting', outcome: { status: 'open' },
    effects: [{ type: 'ignored', by: MAYA, why: 'unknown-option' }],
  },
  {
    rule: 'critical needs every holder: 2 of 3 yes stays open',
    gate: critical, events: [press(ERICK, 'yes', 0), press(MAYA, 'yes', 1)],
    phase: 'vote', outcome: { status: 'open' },
  },
  {
    rule: 'critical approves when every holder says yes',
    gate: critical, events: [press(ERICK, 'yes', 0), press(MAYA, 'yes', 1), press(JON, 'yes', 2)],
    phase: 'closed', outcome: { status: 'approved', option: 'yes' },
  },
  {
    rule: 'one No rejects a critical vote at once',
    gate: critical, events: [press(ERICK, 'yes', 0), press(JON, 'no', 1), press(MAYA, 'yes', 2)],
    phase: 'closed', outcome: { status: 'rejected' },
  },
  ...['delete-data', 'force-push'].map((kind) => ({
    rule: `${kind} is critical: one No rejects`,
    gate: () => critical(kind), events: [press(MAYA, 'no', 0)],
    phase: 'closed', outcome: { status: 'rejected' },
  })),
  ...['merge', 'autopilot', 'deploy'].map((kind) => ({
    rule: `${kind} is a normal kind: the first answer wins`,
    gate: () => openGate({ id: 'g3', kind, options: ['yes', 'no'], askedBy: ERICK, at: T0 }), events: [press(MAYA, 'yes', 0), tick(10)],
    phase: 'closed', outcome: { status: 'approved', option: 'yes' },
  })),
  {
    rule: 'the terminal answer counts on a normal gate as one press',
    gate: normal, events: [press(ERICK, 'C', 0, { via: 'terminal' }), tick(10)],
    phase: 'closed', outcome: { status: 'approved', option: 'C' },
  },
  {
    rule: 'the terminal answer counts as one ballot inside a normal vote',
    gate: normal, events: [press(MAYA, 'B', 0), object(JON, 1), press(ERICK, 'B', 2, { via: 'terminal' })],
    phase: 'closed', outcome: { status: 'approved', option: 'B' },
  },
  {
    rule: 'the terminal answer is refused on a critical vote',
    gate: critical, events: [press(MAYA, 'yes', 0), press(JON, 'yes', 1), press(ERICK, 'yes', 2, { via: 'terminal' })],
    phase: 'vote', outcome: { status: 'open' },
    effects: [{ type: 'ignored', by: ERICK, why: 'terminal-on-critical' }],
  },
  {
    rule: 'a non-holder press counts for nothing',
    gate: normal, events: [press(SAM, 'A', 0)],
    phase: 'waiting', outcome: { status: 'open' },
    effects: [{ type: 'ignored', by: SAM, why: 'not-holder' }],
  },
  {
    rule: 'a non-holder objection counts for nothing',
    gate: normal, events: [press(MAYA, 'B', 0), object(SAM, 1), tick(10)],
    phase: 'closed', outcome: { status: 'approved', option: 'B' },
  },
  {
    rule: 'a non-holder No does not stop a critical vote',
    gate: critical, events: [press(SAM, 'no', 0), press(ERICK, 'yes', 1), press(MAYA, 'yes', 2), press(JON, 'yes', 3)],
    phase: 'closed', outcome: { status: 'approved', option: 'yes' },
  },
  {
    rule: 'withdraw by the person who asked closes the gate as withdrawn',
    gate: normal, events: [press(MAYA, 'B', 0), press(JON, 'A', 1), { type: 'withdraw', by: ERICK, at: T0 + 5 * MINUTE }],
    phase: 'closed', outcome: { status: 'withdrawn' },
  },
  {
    rule: 'withdraw by anyone else is ignored',
    gate: critical, events: [{ type: 'withdraw', by: MAYA, at: T0 }],
    phase: 'vote', outcome: { status: 'open' },
    effects: [{ type: 'ignored', by: MAYA, why: 'not-asker' }],
  },
];

for (const c of cases) {
  test(c.rule, () => {
    const { gate, effects, view: v } = run(c.gate(), c.events, c.holders);
    assert.equal(gate.phase, c.phase);
    assert.deepEqual(gate.outcome, c.outcome);
    if (c.effects) assert.deepEqual(effects, c.effects);
    if (c.tied !== undefined) assert.equal(v.tied, c.tied);
    if (c.counts) assert.deepEqual(v.counts, c.counts);
  });
}

const reasons = [
  ['keeps plain text', 'Tests fail on main.', 'Tests fail on main.'],
  ['turns newlines and control characters into one space', 'line one\nline two\r\t\u0007end', 'line one line two end'],
  ['removes < > and backticks', '<@everyone> `rm -rf` <b>', '@everyone rm -rf b'],
  ['strips text-direction marks', 'a‮b⁦c', 'abc'],
  ['cuts to 500 characters', 'x'.repeat(600), 'x'.repeat(500)],
  ['cuts after cleaning, so cleaning does not waste the limit', '<'.repeat(100) + 'y'.repeat(500), 'y'.repeat(500)],
  ['cuts by character, not by UTF-16 unit', '\u{1F600}'.repeat(501), '\u{1F600}'.repeat(500)],
];
for (const [name, input, expected] of reasons) {
  test(`reason: ${name}`, () => assert.equal(cleanReason(input), expected));
}

test('a ballot keeps its cleaned reason', () => {
  const r = run(normal(), [press(MAYA, 'B', 0, { reason: 'ok\n<b>' })]);
  assert.equal(r.gate.ballots[MAYA].reason, 'ok b');
});

const reminders = [
  ['a gate nobody answered: first reminder 2 h after it opened', normal, [], 0, 120],
  ['a gate nobody answered: next reminder after the first is due', normal, [], 120, 240],
  ['no reminder in the objection window', normal, [press(MAYA, 'B', 0)], 5, null],
  ['first reminder 2 h after the vote opens', normal, [press(MAYA, 'B', 0), object(JON, 5)], 5, 5 + 120],
  ['next reminder after the first is due', normal, [press(MAYA, 'B', 0), object(JON, 5)], 5 + 120, 5 + 240],
  ['still due after 30 days: a vote has no deadline', critical, [], 30 * 24 * 60 + 1, 30 * 24 * 60 + 120],
  ['no reminder after the vote closes', critical, [press(MAYA, 'no', 0)], 1, null],
];
for (const [name, gate, events, nowMin, dueMin] of reminders) {
  test(`reminder: ${name}`, () => {
    const g = run(gate(), events).gate;
    assert.equal(nextReminderAt(g, T0 + nowMin * MINUTE), dueMin === null ? null : T0 + dueMin * MINUTE);
  });
}

