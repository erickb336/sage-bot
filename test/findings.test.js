// Tests for the review findings that still apply under the owner's rules of 2026-10-04
// (single gates and 30-minute batch votes). SAMPLE DATA: every id here is a made-up sample, not a real Discord id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGate, step, cleanReason, MINUTE } from '../src/vote.js';

const ERICK = 'sample-erick';
const MAYA = 'sample-maya';
const JON = 'sample-jon';
const SAM = 'sample-sam';
const LEA = 'sample-lea';
const THREE = [ERICK, MAYA, JON];
const FOUR = [ERICK, MAYA, JON, SAM];
const LEADS = [LEA];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time

const single = () => openGate({ id: 'g1', kind: 'single', options: ['A', 'B'], askedBy: ERICK, at: T0 });
const batch = () => openGate({ id: 'g2', kind: 'batch', parts: [['A', 'B']], askedBy: ERICK, at: T0 });
const press = (by, option, min, extra = {}) => ({ type: 'press', by, option, at: T0 + min * MINUTE, via: 'discord', ...extra });
const ballot = (by, option, min, extra = {}) => press(by, option, min, { part: 0, ...extra });
const tick = (min) => ({ type: 'tick', at: T0 + min * MINUTE });

/** Apply [event, holders, leads?] steps in order; return the last gate and all effects. */
function run(gate, steps) {
  const effects = [];
  for (const [event, holders, leads = LEADS] of steps) {
    const out = step(gate, event, holders, leads);
    gate = out.gate;
    effects.push(...out.effects);
  }
  return { gate, effects };
}

// F-T1-23: a change of the holder list. Only holders at the time limit count.

test('F-T1-23: the ballot of a removed holder no longer counts at the time limit', () => {
  // With Sam, B leads 2 to 1. Without him, it is 1 to 1: the part stays open.
  const r = run(batch(), [[ballot(MAYA, 'B', 0), FOUR], [ballot(JON, 'A', 1), FOUR], [ballot(SAM, 'B', 2), FOUR], [tick(30), THREE]]);
  assert.equal(r.gate.phase, 'tied');
  assert.deepEqual(r.gate.parts[0].outcome, { status: 'open' });
  // The same ballots with Sam still a holder decide B.
  const kept = run(batch(), [[ballot(MAYA, 'B', 0), FOUR], [ballot(JON, 'A', 1), FOUR], [ballot(SAM, 'B', 2), FOUR], [tick(30), FOUR]]);
  assert.deepEqual(kept.gate.parts[0].outcome, { status: 'decided', option: 'B', how: 'votes' });
});

test('F-T1-23: a holder added to the list counts at once, with no vote', () => {
  const r = run(single(), [[press(SAM, 'A', 0), THREE], [press(SAM, 'A', 1), FOUR]]);
  assert.deepEqual(r.effects, [
    { type: 'ignored', by: SAM, why: 'not-holder' },
    { type: 'closed', outcome: { status: 'answered', option: 'A', by: SAM } },
  ]);
});

// F-T1-18: only the kinds single and batch.

test('F-T1-18: openGate refuses any kind but single and batch, with no case or space folding', () => {
  for (const kind of ['Single', 'batch ', 'question', 'publish', 'delete-data', 'force-push', 'deploy', 'role-change', '', undefined]) {
    assert.throws(() => openGate({ id: 'g', kind, options: ['A'], parts: [['A']], askedBy: ERICK, at: T0 }), RangeError, String(kind));
  }
});

// F-T1-21: odd gates are refused at open; odd events never throw.

test('F-T1-21: openGate refuses a single gate without a non-empty list of string options', () => {
  for (const options of [undefined, [], 'A', [1], ['A', '']]) {
    assert.throws(() => openGate({ id: 'g', kind: 'single', options, askedBy: ERICK, at: T0 }), TypeError);
  }
});

test('F-T1-21: openGate refuses a batch without a non-empty list of parts with options', () => {
  for (const parts of [undefined, [], 'A', [[]], [['A'], []], [['A', '']], ['A']]) {
    assert.throws(() => openGate({ id: 'g', kind: 'batch', parts, askedBy: ERICK, at: T0 }), TypeError, JSON.stringify(parts));
  }
});

test('F-T1-21: openGate refuses a gate without askedBy', () => {
  assert.throws(() => openGate({ id: 'g', kind: 'single', options: ['A'], at: T0 }), TypeError);
});

test('F-T1-21: step ignores odd events with a reason and never throws', () => {
  for (const gate of [single(), batch()]) {
    const odd = [
      [null, 'bad-event'],
      ['press', 'bad-event'],
      [{ type: 'object', by: MAYA, at: T0 }, 'bad-event'],
      [{ type: 'press', option: 'A', at: T0, via: 'discord' }, 'bad-event'],
      [press(MAYA, 7, 0), 'bad-event'],
      [press(MAYA, 'A', 0, { via: 'cli' }), 'bad-event'],
      [press(MAYA, 'A', 0, { via: undefined }), 'bad-event'],
      [{ type: 'end', by: LEA, at: T0 }, 'bad-event'],
      [{ type: 'tiebreak', by: LEA, part: 0, at: T0, via: 'discord' }, 'bad-event'],
      [ballot(MAYA, 'A', 0, { reason: { toString() { throw new Error('boom'); } } }), 'bad-event'],
      [ballot(MAYA, 'A', 0, { reason: null }), 'bad-event'],
    ];
    for (const [event, why] of odd) {
      const out = step(gate, event, THREE, LEADS);
      assert.equal(out.gate, gate);
      assert.deepEqual(out.effects.map((e) => e.why), [why], JSON.stringify(event));
    }
  }
  assert.deepEqual(step(single(), press(MAYA, 'A', 0), 'not-a-list', LEADS).effects, [{ type: 'ignored', by: MAYA, why: 'not-holder' }]);
  const out = step(batch(), { type: 'end', by: LEA, at: T0, via: 'discord' }, THREE, 'not-a-list');
  assert.deepEqual(out.effects, [{ type: 'ignored', by: LEA, why: 'not-lead' }]);
});

// F-T1-24: never decide anything with an empty holder set.

test('F-T1-24: a single gate takes no answer while the holder list is empty', () => {
  const r = run(single(), [[press(MAYA, 'A', 0), []], [press(ERICK, 'A', 0, { via: 'terminal' }), []]]);
  assert.equal(r.gate.phase, 'open');
  assert.deepEqual(r.effects.map((e) => e.why), ['not-holder', 'not-holder']);
});

test('F-T1-24: a batch decides no part when the holder list is empty at the limit', () => {
  const r = run(batch(), [[ballot(MAYA, 'A', 0), THREE], [tick(30), []]]);
  assert.equal(r.gate.phase, 'tied');
  assert.deepEqual(r.gate.parts[0].outcome, { status: 'open' });
});

test('F-T1-24: a lead cannot break a tie while the holder list is empty', () => {
  const r = run(batch(), [[tick(30), THREE], [{ type: 'tiebreak', by: LEA, part: 0, option: 'A', at: T0 + 31 * MINUTE, via: 'discord' }, []]]);
  assert.equal(r.gate.phase, 'tied');
  assert.deepEqual(r.effects.at(-1), { type: 'ignored', by: LEA, why: 'no-holders' });
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
  const r = run(batch(), [[ballot(MAYA, 'B', 0, { reason: 'line one\nline two' }), THREE]]);
  assert.equal(r.gate.parts[0].ballots[MAYA].reason, 'line one line two');
});

// F-T1-19 and F-T1-26: caller time.

test('F-T1-19: an event with a time that is not finite is ignored and ends nothing', () => {
  for (const at of [undefined, NaN, Infinity, '0']) {
    const r = run(batch(), [[ballot(MAYA, 'B', 0), THREE], [{ type: 'tick', at }, THREE], [{ ...ballot(JON, 'A', 1), at }, THREE]]);
    assert.equal(r.gate.phase, 'voting', String(at));
    assert.deepEqual(r.effects.map((e) => e.why), ['bad-time', 'bad-time']);
  }
  assert.throws(() => openGate({ id: 'g', kind: 'single', options: ['A'], askedBy: ERICK, at: NaN }), RangeError);
});

test('F-T1-26: an event earlier than the last accepted time is ignored', () => {
  // Maya's ballot at minute 4 comes after her ballot at minute 5: it does not replace it.
  const r = run(batch(), [[ballot(MAYA, 'B', 5), THREE], [ballot(MAYA, 'A', 4), THREE]]);
  assert.deepEqual(r.effects, [{ type: 'ignored', by: MAYA, why: 'out-of-order' }]);
  assert.equal(r.gate.parts[0].ballots[MAYA].option, 'B');
});

test('F-T1-26: a late ballot stamped before the limit does not count after a tick ended the vote', () => {
  const r = run(batch(), [[ballot(MAYA, 'B', 0), THREE], [tick(30), THREE], [ballot(JON, 'A', 29), THREE]]);
  assert.deepEqual(r.gate.parts[0].outcome, { status: 'decided', option: 'B', how: 'votes' });
  assert.deepEqual(r.effects.at(-1), { type: 'ignored', by: JON, why: 'out-of-order' });
});

// F-T1-20: holders and leads are sets of unique, non-empty ids.

test('F-T1-20: a duplicate holder id counts once', () => {
  const holders = [MAYA, MAYA, MAYA, JON];
  const r = run(batch(), [[ballot(MAYA, 'B', 0), holders], [ballot(JON, 'A', 1), holders], [tick(30), holders]]);
  assert.deepEqual(r.gate.parts[0].outcome, { status: 'open' }); // 1 to 1, not 3 to 1
});

test('F-T1-20: an empty or non-string id counts for nothing', () => {
  const holders = [MAYA, '', null, 7];
  const r = run(single(), [[press('', 'A', 0), holders], [press(null, 'A', 0), holders]]);
  assert.deepEqual(r.effects, [{ type: 'ignored', by: null, why: 'bad-event' }, { type: 'ignored', by: null, why: 'bad-event' }]);
  assert.equal(r.gate.phase, 'open');
});

// F-T1-22: withdraw needs a `by`.

test('F-T1-22: a withdraw without by is ignored as a bad event', () => {
  const r = run(single(), [[{ type: 'withdraw', at: T0 }, THREE]]);
  assert.equal(r.gate.phase, 'open');
  assert.deepEqual(r.effects, [{ type: 'ignored', by: null, why: 'bad-event' }]);
});

// F-T1-25: an empty cleaned reason.

test('F-T1-25: a reason that cleans to nothing leaves no reason on the ballot', () => {
  const r = run(batch(), [[ballot(MAYA, 'B', 0, { reason: ' <>` \n' }), THREE]]);
  assert.deepEqual(r.gate.parts[0].ballots[MAYA], { option: 'B', at: T0, via: 'discord' });
});

// F-T1-27: counts kept on a plain object read inherited keys such as "constructor".

test('F-T1-27: an option named like an Object property can win a part', () => {
  const gate = openGate({ id: 'g', kind: 'batch', parts: [['constructor', 'toString'], ['__proto__', 'valueOf']], askedBy: ERICK, at: T0 });
  const holders = [...THREE, '__proto__'];
  const r = run(gate, [
    [press(MAYA, 'constructor', 0, { part: 0 }), holders], [press('__proto__', '__proto__', 1, { part: 1 }), holders], [tick(30), holders],
  ]);
  assert.deepEqual(r.gate.parts.map((p) => p.outcome), [
    { status: 'decided', option: 'constructor', how: 'votes' },
    { status: 'decided', option: '__proto__', how: 'votes' },
  ]);
});
