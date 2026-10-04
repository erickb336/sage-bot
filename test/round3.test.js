// Tests for the round-3 findings F-T1-41 to F-T1-49. SAMPLE DATA: every id here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGate, step, MINUTE } from '../src/vote.js';

const [ERICK, MAYA, JON, ANA, SAM, LEA] = ['sample-erick', 'sample-maya', 'sample-jon', 'sample-ana', 'sample-sam', 'sample-lea'];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time
const single = () => openGate({ id: 'g1', kind: 'single', options: ['A', 'B'], askedBy: ERICK, at: T0 });
const batch = (parts = [['A', 'B', 'C']]) => openGate({ id: 'g2', kind: 'batch', parts, askedBy: ERICK, at: T0 });
const press = (by, option, min, extra = {}) => ({ type: 'press', by, option, at: T0 + min * MINUTE, via: 'discord', ...extra });
const ballot = (by, option, min, part = 0) => press(by, option, min, { part });
const tick = (min) => ({ type: 'tick', at: T0 + min * MINUTE });
const tiebreak = (by, option, min, part = 0) => ({ type: 'tiebreak', by, part, option, at: T0 + min * MINUTE, via: 'discord' });

/** Apply events in order; return the last gate and all effects. */
function play(gate, events, holders, leads = [LEA]) {
  const effects = [];
  for (const event of events) {
    const out = step(gate, event, holders, leads);
    gate = out.gate;
    effects.push(...out.effects);
  }
  return { gate, effects };
}

test('F-T1-41: holders and leads may be a Set or a Map\'s keys; a string or a number counts as empty', () => {
  const answer = press(MAYA, 'A', 0);
  assert.equal(step(single(), answer, new Set([MAYA]), new Set()).gate.outcome.status, 'answered');
  assert.equal(step(single(), answer, new Map([[MAYA, 'role']]).keys(), []).gate.outcome.status, 'answered');
  for (const odd of [MAYA, 42, { [MAYA]: true }, undefined]) {
    assert.deepEqual(step(single(), answer, odd, []).effects, [{ type: 'ignored', by: MAYA, why: 'not-holder' }], String(odd));
  }
  // Leads as a Set: a lead who is a holder ends the vote.
  const out = step(batch(), { type: 'end', by: LEA, at: T0, via: 'discord' }, new Set([MAYA, LEA]), new Set([LEA]));
  assert.equal(out.gate.phase, 'tied');
});

test('F-T1-42: step throws a TypeError for a missing or wrong gate, with a clear message', () => {
  const event = press(MAYA, 'A', 0);
  const message = /step: the first argument must be a gate from openGate or step/;
  assert.throws(() => step(event, single(), [MAYA], []), { name: 'TypeError', message });
  assert.throws(() => step(undefined, event, [MAYA], []), { name: 'TypeError', message });
  assert.throws(() => step({ kind: 'batch' }, event, [MAYA], []), { name: 'TypeError', message });
  // A gate that went through JSON (as after a restart) is still a gate.
  const saved = JSON.parse(JSON.stringify(single()));
  assert.equal(step(saved, event, [MAYA], []).gate.outcome.option, 'A');
});

// Changed by F-T1-50: no speed target; the team is 2-5 people. The 10,000 voters must only finish without error.
test('F-T1-43: 10,000 voters on one part (holders as a Set) finish without error, and step leaves its input unchanged', () => {
  const voters = Array.from({ length: 10_000 }, (_, i) => `sample-u${i}`);
  const holders = new Set([...voters, LEA]);
  let gate = batch([['A', 'B']]);
  const first = gate;
  const snapshot = JSON.stringify(first);
  voters.forEach((by, i) => { gate = step(gate, ballot(by, i % 3 ? 'A' : 'B', i / 1000), holders, [LEA]).gate; });
  const out = step(gate, tick(30), holders, [LEA]);
  assert.deepEqual(out.effects.slice(1), [{ type: 'decided', part: 0, option: 'A', how: 'votes' }, { type: 'closed', outcome: { status: 'decided' } }]);
  assert.equal(JSON.stringify(first), snapshot);
  // An earlier gate still gives its own result: with only the first voter (B), B wins.
  const early = step(batch([['A', 'B']]), ballot(voters[0], 'B', 0), holders, [LEA]).gate;
  assert.equal(step(early, tick(30), holders, [LEA]).gate.parts[0].outcome.option, 'B');
});

test('F-T1-44: while a part is tied the batch stays open; it closes only when every part is decided', () => {
  const r = play(batch([['A', 'B'], ['X', 'Y']]), [ballot(MAYA, 'A', 0, 0), ballot(MAYA, 'X', 1, 1), ballot(JON, 'Y', 2, 1), tick(30)], [MAYA, JON, LEA]);
  assert.equal(r.gate.phase, 'tied');
  assert.deepEqual(r.gate.outcome, { status: 'open' });
  assert.equal(r.effects.some((e) => e.type === 'closed'), false);
  const done = play(r.gate, [tiebreak(LEA, 'Y', 31, 1)], [MAYA, JON, LEA]);
  assert.deepEqual(done.effects.at(-1), { type: 'closed', outcome: { status: 'decided' } });
});

test('F-T1-47: a tie-break may choose only a tied leader of the part', () => {
  const holders = [MAYA, JON, ANA, SAM, ERICK, LEA];
  const votes = [ballot(MAYA, 'A', 0), ballot(JON, 'A', 1), ballot(ANA, 'B', 2), ballot(SAM, 'B', 3), ballot(ERICK, 'C', 4), tick(30)];
  const tied = play(batch(), votes, holders).gate;
  assert.deepEqual(tied.parts[0].tied, ['A', 'B']);
  const refused = step(tied, tiebreak(LEA, 'C', 31), holders, [LEA]);
  assert.deepEqual(refused.effects, [{ type: 'ignored', by: LEA, why: 'not-tied-option' }]);
  assert.equal(refused.gate, tied);
  assert.deepEqual(step(tied, tiebreak(LEA, 'B', 31), holders, [LEA]).gate.parts[0].outcome, { status: 'decided', option: 'B', how: 'lead-tiebreak' });
  // With 0 votes, every option is tied.
  const empty = play(batch(), [tick(30), tiebreak(LEA, 'C', 31)], holders).gate;
  assert.deepEqual(empty.parts[0].outcome, { status: 'decided', option: 'C', how: 'lead-tiebreak' });
});

test('F-T1-49: a single gate\'s outcome says how the answer came: discord or terminal', () => {
  assert.deepEqual(step(single(), press(ERICK, 'B', 0, { via: 'terminal' }), [ERICK], []).gate.outcome,
    { status: 'answered', option: 'B', by: ERICK, via: 'terminal' });
  assert.deepEqual(step(single(), press(MAYA, 'A', 0), [MAYA], []).gate.outcome,
    { status: 'answered', option: 'A', by: MAYA, via: 'discord' });
});
