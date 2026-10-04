// Tests for the round-4 findings F-T1-50 to F-T1-55. SAMPLE DATA: every id here is a made-up sample.
// The functions come from the module namespace, so that each test fails on its own if an export is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vote from '../src/vote.js';

const { openGate, step, ballotsOf, nextReminderAt, parseGate, MINUTE } = vote;
const [ERICK, MAYA, JON, LEA] = ['sample-erick', 'sample-maya', 'sample-jon', 'sample-lea'];
const HOLDERS = [ERICK, MAYA, JON, LEA];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time
const END = T0 + 30 * MINUTE;
const single = () => openGate({ id: 'g1', kind: 'single', options: ['A', 'B'], askedBy: ERICK, at: T0 });
const batch = (parts = [['A', 'B'], ['X', 'Y']]) => openGate({ id: 'g2', kind: 'batch', parts, askedBy: ERICK, at: T0 });
const ballot = (by, option, at, part = 0) => ({ type: 'press', by, part, option, at, via: 'discord' });
const withdraw = (at) => ({ type: 'withdraw', by: ERICK, at });
const json = (gate) => JSON.parse(JSON.stringify(gate));

function play(gate, events, holders = HOLDERS) {
  const effects = [];
  for (const event of events) {
    const out = step(gate, event, holders, [LEA]);
    gate = out.gate;
    effects.push(...out.effects);
  }
  return { gate, effects };
}

/** Save, load and check a gate as B3 does, then end its vote with a tick. */
function reloadAndEnd(gate, holders) {
  const loaded = parseGate(JSON.parse(JSON.stringify(gate)));
  assert.deepEqual(structuredClone(gate), loaded);
  return step(loaded, { type: 'tick', at: END }, holders, [LEA]);
}

test('F-T1-50: one voter who presses 10,000 times on one part saves, reloads and decides; the gate stays small', () => {
  let gate = batch([['A', 'B']]);
  for (let i = 0; i < 10_000; i++) gate = step(gate, ballot(MAYA, i % 2 ? 'A' : 'B', T0 + i), HOLDERS, [LEA]).gate;
  const once = step(batch([['A', 'B']]), ballot(MAYA, 'A', T0 + 9_999), HOLDERS, [LEA]).gate;
  assert.equal(JSON.stringify(gate).length, JSON.stringify(once).length);
  assert.deepEqual([...ballotsOf(gate.parts[0])], [[MAYA, { option: 'A', at: T0 + 9_999, via: 'discord' }]]);
  assert.deepEqual(reloadAndEnd(gate, HOLDERS).gate.parts[0].outcome, { status: 'decided', option: 'A', how: 'votes' });
});

test('F-T1-50: 10,000 voters who press once each on one part save, reload and decide', () => {
  const voters = Array.from({ length: 10_000 }, (_, i) => `sample-u${i}`);
  const holders = new Set(voters);
  let gate = batch([['A', 'B']]);
  voters.forEach((by, i) => { gate = step(gate, ballot(by, i % 3 ? 'A' : 'B', T0 + i), holders, []).gate; });
  assert.equal(ballotsOf(gate.parts[0]).size, 10_000);
  assert.deepEqual(reloadAndEnd(gate, holders).gate.parts[0].outcome, { status: 'decided', option: 'A', how: 'votes' });
});

test('F-T1-51: a tied part without its tied options is refused with a clear TypeError, not a crash', () => {
  const tied = json(play(batch(), [{ type: 'tick', at: END }]).gate);
  delete tied.parts[1].tied;
  assert.throws(() => parseGate(tied), { name: 'TypeError', message: /^parseGate: the first argument must be a gate from openGate or step: the phase and the outcomes do not match$/ });
  const tiebreak = { type: 'tiebreak', by: LEA, part: 1, option: 'X', at: END + MINUTE, via: 'discord' };
  assert.throws(() => step(tied, tiebreak, HOLDERS, [LEA]), { name: 'TypeError', message: /^step: the first argument must be a gate from openGate or step/ });
});

test('F-T1-52: a withdraw at or after the time limit, with no tick, has no effect when the vote decided every part', () => {
  for (const at of [END, END + 5 * MINUTE]) {
    const r = play(batch([['A', 'B']]), [ballot(MAYA, 'A', T0), withdraw(at)]);
    assert.deepEqual(r.effects, [
      { type: 'vote-ended', by: null },
      { type: 'decided', part: 0, option: 'A', how: 'votes' },
      { type: 'closed', outcome: { status: 'decided' } },
      { type: 'ignored', by: ERICK, why: 'closed' },
    ], String(at));
    assert.deepEqual(r.gate.parts[0].outcome, { status: 'decided', option: 'A', how: 'votes' });
  }
});

test('F-T1-52: a withdraw after the time limit, with no tick and a tied part, cancels the whole gate', () => {
  const r = play(batch(), [ballot(MAYA, 'A', T0), withdraw(END + 1)]);
  assert.deepEqual(r.effects, [
    { type: 'vote-ended', by: null },
    { type: 'decided', part: 0, option: 'A', how: 'votes' },
    { type: 'closed', outcome: { status: 'withdrawn' } },
  ]);
  assert.deepEqual(r.gate.parts.map((p) => p.outcome), [{ status: 'open' }, { status: 'open' }]);
});

test('F-T1-53: the README names every export; a withdrawn batch keeps its ballots; nextReminderAt refuses a missing gate', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const name of Object.keys(vote)) assert.match(readme, new RegExp(`(\`|### )${name}\\b`), `README must name ${name}`);
  assert.ok(readme.includes("the parts of a withdrawn batch show `{ status: 'open' }` and keep their ballots"));
  const r = play(batch(), [ballot(MAYA, 'A', T0), withdraw(T0 + MINUTE)]);
  assert.deepEqual(r.gate.parts[0].outcome, { status: 'open' });
  assert.deepEqual(ballotsOf(r.gate.parts[0]).get(MAYA), { option: 'A', at: T0, via: 'discord' });
  assert.throws(() => nextReminderAt(undefined, T0), { name: 'TypeError', message: /^nextReminderAt: the first argument must be a gate from openGate or step/ });
});

test('F-T1-54: open outcomes and ballots are frozen, so a change to one gate cannot reach another', () => {
  const [a, b] = [single(), batch()];
  assert.throws(() => { a.outcome.status = 'answered'; }, TypeError);
  assert.throws(() => { b.parts[0].outcome.status = 'decided'; }, TypeError);
  assert.deepEqual([single().outcome, b.outcome, b.parts[1].outcome], [{ status: 'open' }, { status: 'open' }, { status: 'open' }]);
  const first = step(b, ballot(MAYA, 'A', T0), HOLDERS, [LEA]).gate;
  const second = step(first, ballot(JON, 'B', T0 + 1), HOLDERS, [LEA]).gate;
  assert.throws(() => { ballotsOf(second.parts[0]).get(MAYA).option = 'B'; }, TypeError);
  assert.equal(ballotsOf(first.parts[0]).get(MAYA).option, 'A');
});

test('F-T1-55: parseGate returns every gate that openGate and step make, also after JSON', () => {
  const tied = play(batch(), [ballot(MAYA, 'A', T0, 0), ballot(MAYA, 'X', T0, 1), ballot(JON, 'Y', T0, 1), { type: 'tick', at: END }]).gate;
  const gates = [
    single(), step(single(), ballot(MAYA, 'B', T0), HOLDERS, []).gate, step(single(), withdraw(T0), HOLDERS, []).gate,
    batch(), play(batch(), [{ ...ballot(MAYA, 'A', T0), reason: 'cheaper <b>' }]).gate, tied,
    step(tied, { type: 'tiebreak', by: LEA, part: 1, option: 'Y', at: END, via: 'discord' }, HOLDERS, [LEA]).gate,
    step(tied, withdraw(END), HOLDERS, []).gate,
  ];
  assert.deepEqual(gates.map((g) => g.phase), ['open', 'closed', 'closed', 'voting', 'voting', 'tied', 'closed', 'closed']);
  for (const gate of gates) {
    assert.equal(parseGate(gate), gate);
    assert.deepEqual(parseGate(json(gate)), json(gate));
  }
});

test('F-T1-55: parseGate and step refuse a forged gate with a TypeError', () => {
  const tied = json(play(batch(), [ballot(MAYA, 'A', T0, 0), ballot(MAYA, 'X', T0, 1), ballot(JON, 'Y', T0, 1), { type: 'tick', at: END }]).gate);
  const forge = (base, change) => { const g = structuredClone(base); change(g); return g; };
  const forgeries = {
    'tied option not among the options': forge(tied, (g) => { g.parts[1].tied = ['X', 'Z']; }),
    'decided option not among the options': forge(tied, (g) => { g.parts[0].outcome.option = 'Z'; }),
    'lead tie-break of an option that was not tied': forge(tied, (g) => { g.parts[0].outcome.how = 'lead-tiebreak'; }),
    'ballot option not among the options': forge(tied, (g) => { g.parts[0].ballots[0][1].option = 'Z'; }),
    'ballot by an empty id': forge(tied, (g) => { g.parts[0].ballots[0][0] = ''; }),
    'two ballots by one person': forge(tied, (g) => { g.parts[1].ballots[1][0] = MAYA; }),
    'ballot after lastAt': forge(tied, (g) => { g.parts[0].ballots[0][1].at = END + 1; }),
    'ballot time not whole ms': forge(tied, (g) => { g.parts[0].ballots[0][1].at = T0 + 0.5; }),
    'ballot reason not cleaned': forge(tied, (g) => { g.parts[0].ballots[0][1].reason = '<script>'; }),
    'ballots in the old linked-list format': forge(tied, (g) => { g.parts[0].ballots = { by: MAYA, ballot: { option: 'A', at: T0, via: 'discord' }, prev: null }; }),
    'unknown field': forge(tied, (g) => { g.extra = 1; }),
    'part with no outcome': forge(tied, (g) => { delete g.parts[0].outcome; }),
    'tied phase with every part decided': forge(tied, (g) => { g.parts[1].outcome = { status: 'decided', option: 'X', how: 'lead-tiebreak' }; }),
    'voting phase with a decided part': forge(json(batch()), (g) => { g.parts[0].outcome = { status: 'decided', option: 'A', how: 'votes' }; }),
    'phase that is not a phase': forge(tied, (g) => { g.phase = 'constructor'; }),
    'endsAt moved': forge(tied, (g) => { g.endsAt += MINUTE; }),
    'lastAt not whole ms': forge(tied, (g) => { g.lastAt = Infinity; }),
    'single closed with an open outcome': forge(json(single()), (g) => { g.phase = 'closed'; }),
    'single answered with an unknown option': forge(json(single()), (g) => { g.phase = 'closed'; g.outcome = { status: 'answered', option: 'Z', by: MAYA, via: 'discord' }; }),
  };
  for (const [what, gate] of Object.entries(forgeries)) {
    assert.throws(() => parseGate(gate), { name: 'TypeError', message: /^parseGate: the first argument must be a gate from openGate or step: / }, what);
    assert.throws(() => step(gate, { type: 'tick', at: END + MINUTE }, HOLDERS, [LEA]), { name: 'TypeError', message: /^step: the first argument must be a gate/ }, what);
  }
});
