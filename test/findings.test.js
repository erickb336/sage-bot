// Tests for the review findings of the first build (keys F-T1-17 to F-T1-26).
// Each test failed on 1941ee0. SAMPLE DATA: every id here is a made-up sample, not a real Discord id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGate, step, view, result, cleanReason, MINUTE } from '../src/vote.js';

const ERICK = 'sample-erick';
const MAYA = 'sample-maya';
const JON = 'sample-jon';
const SAM = 'sample-sam';
const THREE = [ERICK, MAYA, JON];
const FOUR = [ERICK, MAYA, JON, SAM];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time

const normal = () => openGate({ id: 'g1', kind: 'question', options: ['A', 'B', 'C'], askedBy: ERICK, at: T0 });
const critical = (kind = 'publish') => openGate({ id: 'g2', kind, askedBy: ERICK, at: T0 });
const press = (by, option, min, extra = {}) => ({ type: 'press', by, option, at: T0 + min * MINUTE, via: 'discord', ...extra });
const object = (by, min) => ({ type: 'object', by, at: T0 + min * MINUTE });
const tick = (min) => ({ type: 'tick', at: T0 + min * MINUTE });

/** Apply [event, holders] pairs in order; return the last gate and all effects. */
function run(gate, steps) {
  const effects = [];
  for (const [event, holders] of steps) {
    const out = step(gate, event, holders);
    gate = out.gate;
    effects.push(...out.effects);
  }
  return { gate, effects };
}

// F-T1-23: a change of the holder list re-checks an open vote.

test('F-T1-23: a normal vote closes on a tick when a removed holder makes 2 of 3 a majority', () => {
  const r = run(normal(), [
    [press(MAYA, 'B', 0), FOUR], [press(JON, 'A', 1), FOUR], [press(ERICK, 'B', 2), FOUR], // B 2 of 4: open
    [tick(3), THREE], // Sam removed: B 2 of 3
  ]);
  assert.deepEqual(r.gate.outcome, { status: 'approved', option: 'B' });
  assert.deepEqual(r.effects.at(-1), { type: 'closed', outcome: { status: 'approved', option: 'B' } });
});

test('F-T1-23: a critical vote closes on a tick when the only holder without a yes is removed', () => {
  const r = run(critical(), [[press(ERICK, 'yes', 0), THREE], [press(MAYA, 'yes', 1), THREE], [tick(2), [ERICK, MAYA]]]);
  assert.deepEqual(r.gate.outcome, { status: 'approved', option: 'yes' });
});

test('F-T1-23: an ignored press also re-checks the vote with the current holders', () => {
  const r = run(normal(), [
    [press(MAYA, 'B', 0), FOUR], [press(JON, 'A', 1), FOUR], [press(ERICK, 'B', 2), FOUR],
    [press(SAM, 'A', 3), THREE], // Sam is no longer a holder: ignored, but the vote closes
  ]);
  assert.deepEqual(r.effects.slice(-2), [
    { type: 'ignored', by: SAM, why: 'not-holder' },
    { type: 'closed', outcome: { status: 'approved', option: 'B' } },
  ]);
});

test('F-T1-23: the ballot of a removed holder no longer counts', () => {
  // Without Sam's ballot, B has 1 of 3 and A has 1 of 3: the vote stays open and tied.
  const r = run(normal(), [
    [press(MAYA, 'B', 0), FOUR], [press(JON, 'A', 1), FOUR], [press(SAM, 'B', 2), FOUR], // B 2 of 4: open
    [tick(3), THREE],
  ]);
  assert.equal(r.gate.phase, 'vote');
  assert.deepEqual(view(r.gate, THREE), { phase: 'vote', outcome: { status: 'open' }, counts: { B: 1, A: 1 }, tied: true });
});

test('F-T1-23: the first answerer changing their own press replaces the answer and restarts the window', () => {
  const steps = [[press(MAYA, 'B', 0), THREE], [press(MAYA, 'A', 3), THREE]];
  let r = run(normal(), [...steps, [tick(12.99), THREE]]);
  assert.equal(r.gate.phase, 'window');
  assert.deepEqual(r.effects, [{ type: 'answer', option: 'B', by: MAYA }, { type: 'answer', option: 'A', by: MAYA }]);
  r = run(normal(), [...steps, [tick(13), THREE]]);
  assert.deepEqual(r.gate.outcome, { status: 'approved', option: 'A' });
});

test('decision: a first answer from a holder who is removed later still stands', () => {
  const r = run(normal(), [[press(SAM, 'B', 0), FOUR], [tick(10), THREE]]);
  assert.deepEqual(r.gate.outcome, { status: 'approved', option: 'B' });
});

// F-T1-21: odd gates are refused at open; odd events never throw.

test('F-T1-21: openGate refuses a normal gate without a non-empty list of string options', () => {
  for (const options of [undefined, [], 'A', [1], ['A', '']]) {
    assert.throws(() => openGate({ id: 'g', kind: 'question', options, askedBy: ERICK, at: T0 }), TypeError);
  }
});

test('F-T1-21: openGate refuses a gate without askedBy', () => {
  assert.throws(() => openGate({ id: 'g', kind: 'publish', at: T0 }), TypeError);
});

test('F-T1-21: step ignores odd events with a reason and never throws', () => {
  const gate = normal();
  const odd = [
    [null, 'bad-event'],
    ['press', 'bad-event'],
    [{ type: 'vote', by: MAYA, at: T0 }, 'bad-event'],
    [{ type: 'press', option: 'A', at: T0, via: 'discord' }, 'bad-event'],
    [press(MAYA, 7, 0), 'bad-event'],
    [press(MAYA, 'A', 0, { reason: { toString() { throw new Error('boom'); } } }), 'bad-event'],
    [press(MAYA, 'A', 0, { reason: null }), 'bad-event'],
  ];
  for (const [event, why] of odd) {
    const out = step(gate, event, THREE);
    assert.equal(out.gate, gate);
    assert.equal(out.effects.length, 1);
    assert.equal(out.effects[0].why, why);
  }
  assert.deepEqual(step(gate, press(MAYA, 'A', 0), 'not-a-list').effects, [{ type: 'ignored', by: MAYA, why: 'not-holder' }]);
});

// F-T1-24: no holders, no approval.

test('F-T1-24: result never approves a critical vote with no holders', () => {
  assert.deepEqual(result(critical(), []), { status: 'open' });
});

test('F-T1-24: a normal first answer does not close approved while the holder list is empty', () => {
  let r = run(normal(), [[press(MAYA, 'B', 0), THREE], [tick(60), []]]);
  assert.equal(r.gate.phase, 'window');
  r = run(r.gate, [[tick(61), THREE]]);
  assert.deepEqual(r.gate.outcome, { status: 'approved', option: 'B' });
});

// F-T1-17: reason cleaning.

const tags = String.fromCodePoint(0xE0001, 0xE0069, 0xE0067, 0xE007F);
const reasons = [
  ['NFKC maps fullwidth < > to ASCII, which is then removed', '＜channel＞ ｀x｀ ﹤y﹥', 'channel x y'],
  ['removes angle lookalikes that NFKC keeps', '‹a› 〈b〉 ⟨c⟩ ⟪d⟫ 《e》 ❮f❯', 'a b c d e f'],
  ['removes zero-width characters and U+FEFF', 'a​b‌c‍d﻿e⁠f', 'abcdef'],
  ['removes bidi marks and embeddings', 'a‎b‏c؜d‪e⁧f', 'abcdef'],
  ['removes tag characters', 'ok' + tags, 'ok'],
  ['removes variation selectors', 'a️b\u{E0100}c', 'abc'],
  ['removes lone surrogates', 'a\uD83Db\uDE00c', 'abc'],
  ['maps CRLF, CR, LF and NEL to one space each', 'a\r\nb\rc\nd\u0085e', 'a b c d e'],
  ['maps line and paragraph separators to a space', 'a b c', 'a b c'],
  ['collapses runs of spaces and trims', '  a \n\n  b\t\t c  ', 'a b c'],
  ['cuts to 500 characters without a lone surrogate at the end', 'a'.repeat(499) + '\uD83D' + 'b', 'a'.repeat(499) + 'b'],
  ['keeps an emoji whole at the cut', 'a'.repeat(499) + '\u{1F600}x', 'a'.repeat(499) + '\u{1F600}'],
];
for (const [name, input, expected] of reasons) {
  test(`F-T1-17: reason ${name}`, () => assert.equal(cleanReason(input), expected));
}

test('F-T1-17: a ballot keeps the reason with the newline as a space', () => {
  const r = run(normal(), [[press(MAYA, 'B', 0, { reason: 'line one\nline two' }), THREE]]);
  assert.equal(r.gate.ballots[MAYA].reason, 'line one line two');
});

// F-T1-18: kind and via fail closed.

test('F-T1-18: openGate refuses an unknown kind, with no case or space folding', () => {
  for (const kind of ['Publish', 'publish ', 'DELETE-DATA', 'role-change', 'pick', '', undefined]) {
    assert.throws(() => openGate({ id: 'g', kind, options: ['yes', 'no'], askedBy: ERICK, at: T0 }), RangeError, String(kind));
  }
});

test('F-T1-18: a critical gate accepts a press only with via discord', () => {
  const r = run(critical(), [
    [press(ERICK, 'yes', 0, { via: 'Terminal' }), THREE],
    [press(MAYA, 'yes', 1, { via: 'cli' }), THREE],
    [press(JON, 'yes', 2, { via: undefined }), THREE],
    [press(ERICK, 'yes', 3, { via: 'terminal' }), THREE],
  ]);
  assert.deepEqual(r.gate.outcome, { status: 'open' });
  assert.deepEqual(r.gate.ballots, {});
  assert.deepEqual(r.effects.map((e) => e.why), ['bad-event', 'bad-event', 'bad-event', 'terminal-on-critical']);
});

// F-T1-19 and F-T1-26: caller time.

test('F-T1-19: an event with a time that is not finite is ignored and closes nothing', () => {
  for (const at of [undefined, NaN, Infinity, '0']) {
    const r = run(normal(), [[press(MAYA, 'B', 0), THREE], [{ type: 'tick', at }, THREE], [{ ...press(JON, 'A', 1), at }, THREE]]);
    assert.equal(r.gate.phase, 'window', String(at));
    assert.deepEqual(r.effects.slice(1).map((e) => e.why), ['bad-time', 'bad-time']);
  }
  assert.throws(() => openGate({ id: 'g', kind: 'question', options: ['A'], askedBy: ERICK, at: NaN }), RangeError);
});

test('F-T1-26: an event earlier than the last accepted time is ignored', () => {
  // Erick's press at minute 40 comes after his press at minute 50: it does not replace it.
  const r = run(normal(), [
    [press(MAYA, 'B', 0), THREE], [press(JON, 'A', 1), THREE], [press(ERICK, 'C', 50), THREE], [press(ERICK, 'A', 40), THREE],
  ]);
  assert.equal(r.gate.phase, 'vote');
  assert.deepEqual(r.effects.at(-1), { type: 'ignored', by: ERICK, why: 'out-of-order' });
  assert.equal(r.gate.ballots[ERICK].option, 'C');
});

test('F-T1-26: a late objection stamped inside the window does not reopen a window that a tick closed', () => {
  const r = run(normal(), [[press(MAYA, 'B', 0), THREE], [tick(9), THREE], [object(JON, 5), THREE]]);
  assert.equal(r.gate.phase, 'window');
  assert.deepEqual(r.effects.at(-1), { type: 'ignored', by: JON, why: 'out-of-order' });
});

// F-T1-20: holders are a set.

test('F-T1-20: a duplicate holder id counts once', () => {
  const holders = [MAYA, MAYA, JON];
  const r = run(normal(), [[press(MAYA, 'B', 0), holders], [object(JON, 1), holders], [press(JON, 'A', 2), holders]]);
  assert.equal(r.gate.phase, 'vote'); // 1 of 2 is not a strict majority
  assert.deepEqual(view(r.gate, holders).counts, { B: 1, A: 1 });
});

test('F-T1-20: an empty or non-string holder id counts for nothing', () => {
  const holders = [MAYA, '', null, 7];
  const r = run(normal(), [[press(MAYA, 'B', 0), holders], [press('', 'A', 1), holders]]);
  assert.deepEqual(r.effects.at(-1), { type: 'ignored', by: null, why: 'bad-event' });
});

// F-T1-22: withdraw needs a `by`.

test('F-T1-22: a withdraw without by is ignored as a bad event', () => {
  const r = run(critical(), [[{ type: 'withdraw', at: T0 }, THREE]]);
  assert.equal(r.gate.phase, 'vote');
  assert.deepEqual(r.effects, [{ type: 'ignored', by: null, why: 'bad-event' }]);
});

// F-T1-25: an empty cleaned reason.

test('F-T1-25: a reason that cleans to nothing leaves no reason on the ballot', () => {
  const r = run(normal(), [[press(MAYA, 'B', 0, { reason: ' <>` \n' }), THREE]]);
  assert.deepEqual(r.gate.ballots[MAYA], { option: 'B', at: T0, via: 'discord' });
});

// Found while repairing: counts kept on a plain object read inherited keys such as "constructor".

test('NEW-proto: an option named like an Object property can win a vote', () => {
  const gate = openGate({ id: 'g', kind: 'question', options: ['constructor', 'toString'], askedBy: ERICK, at: T0 });
  const r = run(gate, [[press(MAYA, 'constructor', 0), THREE], [object(JON, 1), THREE], [press(JON, 'constructor', 2), THREE]]);
  assert.deepEqual(r.gate.outcome, { status: 'approved', option: 'constructor' });
});

// Owner rules of 2026-10-04 (through the chief): no role-change vote, deploy is normal.

test('rule: role-change is not a gate kind; the holder list from the bridge is the truth', () => {
  assert.throws(() => openGate({ id: 'g', kind: 'role-change', askedBy: ERICK, at: T0 }), RangeError);
  // A holder added to the list counts at once, with no vote.
  const r = run(normal(), [[press(SAM, 'A', 0), THREE], [press(SAM, 'A', 1), FOUR]]);
  assert.deepEqual(r.effects, [{ type: 'ignored', by: SAM, why: 'not-holder' }, { type: 'answer', option: 'A', by: SAM }]);
});

test('rule: deploy is a normal gate; one No does not reject it, and the first answer wins', () => {
  const gate = openGate({ id: 'g', kind: 'deploy', options: ['yes', 'no'], askedBy: ERICK, at: T0 });
  assert.equal(gate.critical, false);
  const r = run(gate, [[press(MAYA, 'no', 0), THREE], [tick(10), THREE]]);
  assert.deepEqual(r.gate.outcome, { status: 'approved', option: 'no' });
});
