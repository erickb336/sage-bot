// Table-driven tests of the vote rules. SAMPLE DATA: every id here is a made-up sample, not a real Discord id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGate, step, ballotsOf, nextReminderAt, MINUTE, BATCH_LIMIT } from '../src/vote.js';

const ERICK = 'sample-erick';
const MAYA = 'sample-maya';
const JON = 'sample-jon';
const SAM = 'sample-sam'; // not on the holder list
const LEA = 'sample-lea'; // a lead and a holder who does not vote
const THREE = [ERICK, MAYA, JON];
const HOLDERS = [...THREE, LEA];
const LEADS = [LEA];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time

const single = () => openGate({ id: 'g1', kind: 'single', options: ['A', 'B'], askedBy: ERICK, at: T0 });
const batch = () => openGate({ id: 'g2', kind: 'batch', parts: [['A', 'B'], ['X', 'Y', 'Z']], askedBy: ERICK, at: T0 });

const at = (min) => T0 + min * MINUTE;
const press = (by, option, min, extra = {}) => ({ type: 'press', by, option, at: at(min), via: 'discord', ...extra });
const ballot = (by, part, option, min, extra = {}) => press(by, option, min, { part, ...extra });
const end = (by, min, via = 'discord') => ({ type: 'end', by, at: at(min), via });
const tiebreak = (by, part, option, min, via = 'discord') => ({ type: 'tiebreak', by, part, option, at: at(min), via });
const withdraw = (by, min) => ({ type: 'withdraw', by, at: at(min) });
const tick = (min) => ({ type: 'tick', at: at(min) });

/** Apply the events in order; return the last gate and all effects. */
function run(gate, events, holders = HOLDERS, leads = LEADS) {
  const effects = [];
  for (const event of events) {
    const out = step(gate, event, holders, leads);
    gate = out.gate;
    effects.push(...out.effects);
  }
  return { gate, effects };
}

const OPEN = { status: 'open' };
const votes = (option) => ({ status: 'decided', option, how: 'votes' });
const lead = (option, min) => ({ status: 'decided', option, how: 'lead-tiebreak', by: LEA, at: at(min) });
const answered = (option, by, via = 'discord') => ({ status: 'answered', option, by, via });

const cases = [
  // Single gate.
  {
    rule: 'single: the first answer from a holder is final at once',
    gate: single, events: [press(MAYA, 'B', 0)],
    phase: 'closed', outcome: answered('B', MAYA),
    effects: [{ type: 'closed', outcome: answered('B', MAYA) }],
  },
  {
    rule: 'single: a later press is ignored as closed',
    gate: single, events: [press(MAYA, 'B', 0), press(JON, 'A', 0.1)],
    phase: 'closed', outcome: answered('B', MAYA),
    effects: [{ type: 'closed', outcome: answered('B', MAYA) }, { type: 'ignored', by: JON, why: 'closed' }],
  },
  {
    rule: 'single: a non-holder press counts for nothing',
    gate: single, events: [press(SAM, 'A', 0)],
    phase: 'open', outcome: OPEN, effects: [{ type: 'ignored', by: SAM, why: 'not-holder' }],
  },
  {
    rule: 'single: the owner\'s terminal answer is the first answer',
    gate: single, events: [press(ERICK, 'A', 0, { via: 'terminal' }), press(MAYA, 'B', 1)],
    phase: 'closed', outcome: answered('A', ERICK, 'terminal'),
  },
  {
    rule: 'single: a press for an option the gate does not have is ignored',
    gate: single, events: [press(MAYA, 'Z', 0)],
    phase: 'open', outcome: OPEN, effects: [{ type: 'ignored', by: MAYA, why: 'unknown-option' }],
  },
  {
    rule: 'single: a lead action is the wrong kind',
    gate: single, events: [end(LEA, 1)],
    phase: 'open', outcome: OPEN, effects: [{ type: 'ignored', by: LEA, why: 'wrong-kind' }],
  },
  // Batch: ballots and the time limit.
  {
    rule: 'batch: the last ballot of each person per part counts',
    gate: batch,
    events: [ballot(MAYA, 0, 'A', 0), ballot(JON, 0, 'A', 1), ballot(MAYA, 0, 'B', 2), ballot(ERICK, 0, 'B', 3),
      ballot(MAYA, 1, 'X', 4), tick(30)],
    phase: 'closed', outcome: { status: 'decided' }, parts: [votes('B'), votes('X')],
  },
  {
    rule: 'batch: at 29:59.999 the vote is still open',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(MAYA, 1, 'X', 0), { type: 'tick', at: T0 + BATCH_LIMIT - 1 }],
    phase: 'voting', outcome: OPEN, parts: [OPEN, OPEN], effects: [],
  },
  {
    rule: 'batch: at exactly 30:00 each part goes to the most votes cast; non-voters do not count',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(JON, 0, 'A', 1), ballot(ERICK, 0, 'B', 2), ballot(MAYA, 1, 'Y', 3),
      { type: 'tick', at: T0 + BATCH_LIMIT }],
    phase: 'closed', outcome: { status: 'decided' }, parts: [votes('A'), votes('Y')],
    effects: [{ type: 'vote-ended', by: null }, { type: 'decided', part: 0, option: 'A', how: 'votes' },
      { type: 'decided', part: 1, option: 'Y', how: 'votes' }, { type: 'closed', outcome: { status: 'decided' } }],
  },
  {
    rule: 'batch: a tied part and a part with zero votes stay open at the limit, also a week later',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(JON, 0, 'B', 1), tick(30), tick(7 * 24 * 60)],
    phase: 'tied', outcome: OPEN, parts: [OPEN, OPEN],
    effects: [{ type: 'vote-ended', by: null }],
  },
  {
    rule: 'batch: a ballot at or after the limit is ignored as closed',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(JON, 0, 'B', 30)],
    phase: 'tied', outcome: OPEN, parts: [votes('A'), OPEN],
    effects: [{ type: 'vote-ended', by: null }, { type: 'decided', part: 0, option: 'A', how: 'votes' },
      { type: 'ignored', by: JON, why: 'closed' }],
  },
  {
    rule: 'batch: the terminal answer counts as one ballot',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(ERICK, 0, 'B', 1, { via: 'terminal' }), ballot(JON, 0, 'B', 2), tick(30)],
    phase: 'tied', outcome: OPEN, parts: [votes('B'), OPEN],
  },
  {
    rule: 'batch: a non-holder ballot counts for nothing',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(SAM, 0, 'B', 1), tick(30)],
    phase: 'tied', outcome: OPEN, parts: [votes('A'), OPEN],
  },
  {
    rule: 'batch: a ballot for a part the batch does not have is ignored',
    gate: batch, events: [ballot(MAYA, 2, 'A', 0), press(MAYA, 'A', 0), ballot(MAYA, '0', 'A', 0)],
    phase: 'voting', outcome: OPEN,
    effects: ['unknown-part', 'unknown-part', 'unknown-part'].map((why) => ({ type: 'ignored', by: MAYA, why })),
  },
  {
    rule: 'batch: a ballot for an option the part does not have is ignored',
    gate: batch, events: [ballot(MAYA, 0, 'X', 0)],
    phase: 'voting', outcome: OPEN, effects: [{ type: 'ignored', by: MAYA, why: 'unknown-option' }],
  },
  // Batch: leads.
  {
    rule: 'batch: a lead ends the vote early; parts are decided as at the limit',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(JON, 1, 'X', 1), ballot(ERICK, 1, 'Y', 2), end(LEA, 10), ballot(JON, 1, 'Y', 11)],
    phase: 'tied', outcome: OPEN, parts: [votes('A'), OPEN],
    effects: [{ type: 'vote-ended', by: LEA }, { type: 'decided', part: 0, option: 'A', how: 'votes' },
      { type: 'ignored', by: JON, why: 'closed' }],
  },
  {
    rule: 'batch: a holder who is not a lead cannot end the vote early',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), end(MAYA, 10)],
    phase: 'voting', outcome: OPEN, effects: [{ type: 'ignored', by: MAYA, why: 'not-lead' }],
  },
  {
    rule: 'batch: a lead breaks a tie; when every part is decided the batch closes',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), ballot(JON, 0, 'B', 1), ballot(MAYA, 1, 'Z', 2), tick(30), tiebreak(LEA, 0, 'B', 45)],
    phase: 'closed', outcome: { status: 'decided' }, parts: [lead('B', 45), votes('Z')],
    effects: [{ type: 'vote-ended', by: null }, { type: 'decided', part: 1, option: 'Z', how: 'votes' },
      { type: 'decided', part: 0, option: 'B', how: 'lead-tiebreak' }, { type: 'closed', outcome: { status: 'decided' } }],
  },
  {
    rule: 'batch: a lead may pick any option of a part with zero votes',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), tick(30), tiebreak(LEA, 1, 'Z', 31)],
    phase: 'closed', outcome: { status: 'decided' }, parts: [votes('A'), lead('Z', 31)],
  },
  {
    rule: 'batch: a lead action from the terminal is refused',
    gate: batch, events: [end(LEA, 1, 'terminal'), tick(30), tiebreak(LEA, 0, 'A', 31, 'terminal')],
    phase: 'tied', outcome: OPEN, parts: [OPEN, OPEN],
    effects: [{ type: 'ignored', by: LEA, why: 'lead-needs-discord' }, { type: 'vote-ended', by: null },
      { type: 'ignored', by: LEA, why: 'lead-needs-discord' }],
  },
  {
    rule: 'batch: a non-lead cannot break a tie',
    gate: batch, events: [tick(30), tiebreak(MAYA, 0, 'A', 31)],
    phase: 'tied', outcome: OPEN, parts: [OPEN, OPEN],
    effects: [{ type: 'vote-ended', by: null }, { type: 'ignored', by: MAYA, why: 'not-lead' }],
  },
  {
    rule: 'batch: a tie-break while voting, or on a decided part, is refused',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), tiebreak(LEA, 1, 'X', 1), tick(30), tiebreak(LEA, 0, 'B', 31)],
    phase: 'tied', outcome: OPEN, parts: [votes('A'), OPEN],
    effects: [{ type: 'ignored', by: LEA, why: 'not-tied' }, { type: 'vote-ended', by: null },
      { type: 'decided', part: 0, option: 'A', how: 'votes' }, { type: 'ignored', by: LEA, why: 'not-tied' }],
  },
  {
    rule: 'batch: a tie-break for an option or a part the batch does not have is refused',
    gate: batch, events: [tick(30), tiebreak(LEA, 0, 'X', 31), tiebreak(LEA, 5, 'A', 32)],
    phase: 'tied', outcome: OPEN, parts: [OPEN, OPEN],
    effects: [{ type: 'vote-ended', by: null }, { type: 'ignored', by: LEA, why: 'unknown-option' },
      { type: 'ignored', by: LEA, why: 'unknown-part' }],
  },
  {
    rule: 'batch: a lead cannot end a vote that already ended',
    gate: batch, events: [tick(30), end(LEA, 31)],
    phase: 'tied', outcome: OPEN,
    effects: [{ type: 'vote-ended', by: null }, { type: 'ignored', by: LEA, why: 'closed' }],
  },
  // Withdraw.
  {
    rule: 'withdraw by the person who asked closes a single gate as withdrawn',
    gate: single, events: [withdraw(ERICK, 5), press(MAYA, 'A', 6)],
    phase: 'closed', outcome: { status: 'withdrawn' },
    effects: [{ type: 'closed', outcome: { status: 'withdrawn' } }, { type: 'ignored', by: MAYA, why: 'closed' }],
  },
  {
    rule: 'withdraw by the person who asked closes a tied batch as withdrawn; no part stays decided',
    gate: batch, events: [ballot(MAYA, 0, 'A', 0), tick(30), withdraw(ERICK, 40)],
    phase: 'closed', outcome: { status: 'withdrawn' }, parts: [OPEN, OPEN],
  },
  {
    rule: 'withdraw by anyone else is ignored',
    gate: batch, events: [withdraw(MAYA, 1)],
    phase: 'voting', outcome: OPEN, effects: [{ type: 'ignored', by: MAYA, why: 'not-asker' }],
  },
];

for (const c of cases) {
  test(c.rule, () => {
    const { gate, effects } = run(c.gate(), c.events);
    assert.equal(gate.phase, c.phase);
    assert.deepEqual(gate.outcome, c.outcome);
    if (c.parts) assert.deepEqual(gate.parts.map((p) => p.outcome), c.parts);
    if (c.effects) assert.deepEqual(effects, c.effects);
  });
}

// Since F-T1-56, B1 stores a reason as typed and only cuts it to 500 code points.
const reasons = [
  ['keeps the text as typed, also < > backticks and newlines', '<@everyone> `rm -rf`\n<b>', '<@everyone> `rm -rf`\n<b>'],
  ['cuts to 500 characters', 'x'.repeat(600), 'x'.repeat(500)],
  ['cuts by character, not by UTF-16 unit', '\u{1F600}'.repeat(501), '\u{1F600}'.repeat(500)],
];
for (const [name, reason, stored] of reasons) {
  test(`reason: ${name}`, () => {
    const r = run(batch(), [ballot(MAYA, 0, 'B', 0, { reason })]);
    assert.equal(ballotsOf(r.gate.parts[0]).get(MAYA).reason, stored);
  });
}

const reminders = [
  ['single with no answer: first reminder to the holders 2 h after it opened', single, [], 0, { at: at(120), to: 'holders' }],
  ['single with no answer: the next reminder after the first is due', single, [], 120, { at: at(240), to: 'holders' }],
  ['single with no answer: still due after 30 days', single, [], 30 * 24 * 60 + 1, { at: at(30 * 24 * 60 + 120), to: 'holders' }],
  ['no reminder after a single gate is answered', single, [press(MAYA, 'A', 0)], 1, null],
  ['no reminder while a batch is voting', batch, [], 10, null],
  ['tied batch: first reminder to the leads 2 h after the limit', batch, [tick(30)], 30, { at: at(150), to: 'leads' }],
  ['tied batch: the next reminder after the first is due', batch, [tick(30)], 150, { at: at(270), to: 'leads' }],
  ['tied batch ended early by a lead: 2 h after the end', batch, [end(LEA, 10)], 10, { at: at(130), to: 'leads' }],
  ['no reminder after a batch is decided', batch, [ballot(MAYA, 0, 'A', 0), ballot(MAYA, 1, 'X', 0), tick(30)], 31, null],
];
for (const [name, gate, events, nowMin, due] of reminders) {
  test(`reminder: ${name}`, () => {
    assert.deepEqual(nextReminderAt(run(gate(), events).gate, at(nowMin)), due);
  });
}
