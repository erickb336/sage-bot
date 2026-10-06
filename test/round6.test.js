// Tests for the round-6 findings F-T1-65 to F-T1-68. SAMPLE DATA: every id here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGate, step, parseGate, MINUTE } from '../src/vote.js';
import { spawnSync } from './bridge-setup.js';

const [ERICK, MAYA, LEA, SAM] = ['sample-erick', 'sample-maya', 'sample-lea', 'sample-sam']; // SAM is not a holder
const HOLDERS = [ERICK, MAYA, LEA];
const T0 = Date.UTC(2026, 9, 4, 12, 0); // sample time
const END = T0 + 30 * MINUTE;
const json = (gate) => JSON.parse(JSON.stringify(gate));

test('F-T1-66: a part with no counted votes is tied, with one option or two, and with no holders', () => {
  for (const options of [['only'], ['A', 'B']]) {
    for (const holders of [[], HOLDERS]) {
      const gate = openGate({ id: 'g', kind: 'batch', parts: [options], askedBy: ERICK, at: T0 });
      const r = step(gate, { type: 'tick', at: END }, holders, [LEA]);
      assert.deepEqual(r.effects, [{ type: 'vote-ended', by: null }]);
      assert.equal(r.gate.phase, 'tied');
      assert.deepEqual(r.gate.parts[0].outcome, { status: 'open' });
      assert.deepEqual(r.gate.parts[0].tied, options);
    }
  }
});

test('F-T1-66: a one-option part with one vote is decided by votes; with no votes a lead decides it', () => {
  const gate = openGate({ id: 'g', kind: 'batch', parts: [['only'], ['only']], askedBy: ERICK, at: T0 });
  const voted = step(gate, { type: 'press', by: MAYA, part: 0, option: 'only', at: T0, via: 'discord' }, HOLDERS, [LEA]).gate;
  const ended = step(voted, { type: 'tick', at: END }, HOLDERS, [LEA]).gate;
  assert.deepEqual(ended.parts.map((p) => p.outcome.status), ['decided', 'open']);
  const r = step(ended, { type: 'tiebreak', by: LEA, part: 1, option: 'only', at: END + 1, via: 'discord' }, HOLDERS, [LEA]);
  assert.deepEqual(r.gate.parts[1].outcome, { status: 'decided', option: 'only', how: 'lead-tiebreak', by: LEA, at: END + 1 });
  assert.deepEqual(r.gate.outcome, { status: 'decided' });
});

test('F-T1-67: parseGate refuses a voting gate whose lastAt or a ballot is at or after endsAt', () => {
  const gate = openGate({ id: 'g', kind: 'batch', parts: [['A', 'B']], askedBy: ERICK, at: T0 });
  const voted = json(step(gate, { type: 'press', by: MAYA, part: 0, option: 'A', at: T0 + 1, via: 'discord' }, HOLDERS, []).gate);
  assert.equal(parseGate(json(voted)).lastAt, T0 + 1);
  const late = (t) => ({ ...voted, lastAt: t });
  for (const t of [END, END + 1]) assert.throws(() => parseGate(late(t)), TypeError);
  const lateBallot = { ...late(END + 5), parts: [{ ...voted.parts[0], ballots: [[MAYA, { option: 'A', at: END + 5, via: 'discord' }]] }] };
  assert.throws(() => parseGate(lateBallot), TypeError);
});

test('F-T1-68: a non-holder gets not-holder on an open or a closed gate, single or batch', () => {
  const single = openGate({ id: 'g1', kind: 'single', options: ['A'], askedBy: ERICK, at: T0 });
  const answered = step(single, { type: 'press', by: MAYA, option: 'A', at: T0, via: 'discord' }, HOLDERS, []).gate;
  const batch = openGate({ id: 'g2', kind: 'batch', parts: [['A', 'B']], askedBy: ERICK, at: T0 });
  const tied = step(batch, { type: 'tick', at: END }, HOLDERS, [LEA]).gate;
  const decided = step(tied, { type: 'tiebreak', by: LEA, part: 0, option: 'A', at: END, via: 'discord' }, HOLDERS, [LEA]).gate;
  assert.deepEqual([answered.phase, tied.phase, decided.phase], ['closed', 'tied', 'closed']);
  const events = [
    { type: 'press', by: SAM, option: 'A', part: 0, at: END + 1, via: 'discord' },
    { type: 'end', by: SAM, at: END + 1, via: 'discord' },
    { type: 'tiebreak', by: SAM, part: 0, option: 'A', at: END + 1, via: 'discord' },
  ];
  for (const gate of [single, answered, batch, tied, decided]) {
    for (const event of events) {
      if (gate.kind === 'single' && event.type !== 'press') continue;
      assert.deepEqual(step(gate, event, HOLDERS, [LEA, SAM]).effects.at(-1), { type: 'ignored', by: SAM, why: 'not-holder' });
    }
  }
  // A holder still gets closed on a closed gate.
  assert.deepEqual(step(answered, { type: 'press', by: MAYA, option: 'A', at: T0 + 1, via: 'discord' }, HOLDERS, []).effects,
    [{ type: 'ignored', by: MAYA, why: 'closed' }]);
});

test('F-T1-65: npm in this project writes nothing to HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'sage-bot-home-'));
  try {
    // Drop the npm_config_* values that a parent `npm run` passes down, so that only the project's .npmrc counts.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
    const r = spawnSync('npm', ['pkg', 'get', 'name'], { cwd: join(import.meta.dirname, '..'), env: { ...env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '"sage-bot"');
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
