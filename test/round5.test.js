// Tests for the round-5 findings F-T1-56 to F-T1-59. SAMPLE DATA: every id and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openGate, step, ballotsOf, parseGate, MINUTE } from '../src/vote.js';

const [ERICK, MAYA, JON, LEA] = ['sample-erick', 'sample-maya', 'sample-jon', 'sample-lea'];
const HOLDERS = [ERICK, MAYA, JON, LEA];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time
const END = T0 + 30 * MINUTE;
const batch = () => openGate({ id: 'g2', kind: 'batch', parts: [['A', 'B'], ['X', 'Y']], askedBy: ERICK, at: T0 });
const ballot = (by, option, at, part = 0, extra = {}) => ({ type: 'press', by, part, option, at, via: 'discord', ...extra });

/** A ballot with this reason, then save, load and check the gate as B3 does, then end the vote. */
function roundTrip(reason) {
  const voted = step(batch(), ballot(MAYA, 'A', T0, 0, { reason }), HOLDERS, [LEA]).gate;
  const loaded = parseGate(JSON.parse(JSON.stringify(voted)));
  const ended = step(loaded, { type: 'tick', at: END }, HOLDERS, [LEA]).gate;
  return { stored: ballotsOf(loaded.parts[0]).get(MAYA).reason, ended };
}

test('F-T1-56: the three probe reasons are stored as typed and survive step, JSON, parseGate and step', () => {
  const probes = [
    ['a'.repeat(499) + ' b…', 'a'.repeat(499) + ' '], // a space at the cut stays
    ['e<́', 'e<́'], // a combining mark after <
    ['n`̃', 'n`̃'], // a combining mark after a backtick
  ];
  for (const [reason, stored] of probes) {
    const r = roundTrip(reason);
    assert.equal(r.stored, stored);
    assert.deepEqual(r.ended.parts[0].outcome, { status: 'decided', option: 'A', how: 'votes' });
  }
});

test('F-T1-56: 1,000 random reasons survive step, JSON, parseGate and step', () => {
  // A seeded generator (mulberry32), so that a failure repeats. The pieces are the hard cases for a cut or a cleaner.
  let seed = 56;
  const rand = (n) => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
  };
  const pieces = ['a', ' ', '<', '>', '`', '́', '̸', '\u{1F600}', '\u{1F468}‍\u{1F469}', '\uD83D', '\uDE00', '\n', 'é', '＜'];
  for (let i = 0; i < 1000; i++) {
    const length = i % 10 === 0 ? 480 + rand(60) : rand(40); // every tenth reason reaches the cut
    const reason = Array.from({ length }, () => pieces[rand(pieces.length)]).join('');
    const expected = Array.from(reason.toWellFormed()).slice(0, 500).join('') || undefined;
    const r = roundTrip(reason);
    assert.equal(r.stored, expected, JSON.stringify(reason));
    assert.equal(r.ended.phase, 'tied'); // part 1 has no votes
  }
});

test('F-T1-57: a gate from openGate, step or parseGate is frozen all through, so a change to one gate cannot reach another', () => {
  const fresh = batch(); // straight from openGate, before any step
  assert.throws(() => { fresh.parts[0].ballots.push([JON, { option: 'A', at: T0, via: 'discord' }]); }, TypeError);
  assert.throws(() => { fresh.parts[0].options[0] = 'Z'; }, TypeError);
  assert.throws(() => { fresh.outcome.status = 'decided'; }, TypeError);
  assert.throws(() => { fresh.phase = 'closed'; }, TypeError);
  const first = step(batch(), ballot(MAYA, 'A', T0), HOLDERS, [LEA]).gate;
  const second = step(first, ballot(JON, 'B', T0 + 1), HOLDERS, [LEA]).gate;
  assert.equal(first.parts[1], second.parts[1]); // the unchanged part is shared ...
  assert.throws(() => { first.parts[1].ballots.push([JON, { option: 'X', at: T0, via: 'discord' }]); }, TypeError); // ... and frozen
  assert.throws(() => { first.parts[1].options.push('Z'); }, TypeError);
  assert.throws(() => { second.parts[0].ballots.pop(); }, TypeError);
  assert.throws(() => { second.parts[0] = null; }, TypeError);
  assert.deepEqual(ballotsOf(second.parts[1]), new Map());
  const decided = step(second, { type: 'end', by: LEA, at: T0 + 2, via: 'discord' }, HOLDERS, [LEA]).gate;
  assert.throws(() => { decided.parts[0].outcome.option = 'B'; }, TypeError);
  const loaded = parseGate(JSON.parse(JSON.stringify(decided)));
  assert.throws(() => { loaded.parts[0].ballots[0][1].option = 'B'; }, TypeError);
});

test('F-T1-58: a late withdraw on a batch with a tied part emits only the withdrawn close', () => {
  const voted = step(batch(), ballot(MAYA, 'A', T0), HOLDERS, [LEA]).gate; // part 0 would win, part 1 is tied
  const r = step(voted, { type: 'withdraw', by: ERICK, at: END + MINUTE }, HOLDERS, [LEA]);
  assert.deepEqual(r.effects, [{ type: 'closed', outcome: { status: 'withdrawn' } }]);
  assert.deepEqual(r.gate.parts.map((p) => p.outcome), [{ status: 'open' }, { status: 'open' }]);
  // A late event that does not withdraw still reports what the time limit settled.
  const late = step(voted, ballot(JON, 'B', END + MINUTE), HOLDERS, [LEA]);
  assert.deepEqual(late.effects, [
    { type: 'vote-ended', by: null },
    { type: 'decided', part: 0, option: 'A', how: 'votes' },
    { type: 'ignored', by: JON, why: 'closed' },
  ]);
});

test('F-T1-59: the README says that reasons are untrusted, cut silently, and that the bridge acts only on closed', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of [
    'B1 stores reasons as typed. They are untrusted text. The bridge must clean and frame them before any reason reaches the chief or a log.',
    'A longer reason is cut to 500, with no error.',
    "The bridge acts only on the `'closed'` effect",
    '`openedAt`', '`lastAt`', '`[id, ballot]` pairs',
  ]) assert.ok(readme.includes(text), text);
});
