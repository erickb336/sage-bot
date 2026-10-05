// T43 repair 2: a restore marker never stops the other gates (F-T43-7), and a shortened decisions trail never makes repeated writes (F-T43-8).
// A marker is left open by a failed write back of the owner's answer; then the logbook changes under it, as a `logbook repair` does.
// SAMPLE DATA ONLY: every id, name and answer is made up. HOME and SAGE_HOME are in a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAYA, setup } from './bridge-setup.js';

const busy = () => Object.assign(new Error('the logbook is busy'), { code: 1 });

/**
 * A bridge on a scratch logbook with two gates, G1 (task T1) and G2 (task T2), on two cards. Maya presses A on G1; the owner types
 * B in the same moment, and the bridge's write back of B fails, so G1 has an open marker. `b.writes` lists each `sage gate answer`.
 */
async function openMarker() {
  const b = setup();
  const real = b.sage;
  b.writes = [];
  b.hide = new Set(); // gate ids that the sage adapter no longer shows, as after a repair of gates.tsv
  b.fail = 0; // the count of the next reads of decisions.tsv that throw
  b.sage = {
    ...real,
    gates: async () => (await real.gates()).filter((r) => !b.hide.has(r.id)),
    decisions: async () => {
      if (b.fail > 0) { b.fail -= 1; throw new Error('decisions.tsv is not readable'); }
      return real.decisions();
    },
    answer: async (id, text) => {
      b.writes.push(`${id} ${text}`);
      if (b.writes.length === 1) b.sh('gate', 'answer', id, 'New page'); // the owner types B as Maya presses A
      if (b.writes.length === 2) throw busy(); // the first write back
      return real.answer(id, text);
    },
  };
  b.bridge = b.make();
  b.sh('gate', 'add', 'T1', '--question', 'Which login page?', '--options', 'Old page|New page', '--recommend', 'Old page');
  b.sh('gate', 'add', 'T2', '--question', 'Which footer?', '--options', 'Short|Long', '--recommend', 'Short');
  await b.post();
  await b.press(MAYA, 'press:project/G1:0:0');
  assert.deepEqual(b.writes, ['G1 A. Old page', 'G1 New page']);
  assert.equal(b.answerOf('G1'), 'A. Old page'); // the marker of G1 is open: the owner's answer is only in decisions.tsv
  return b;
}

test('F-T43-7: a marker on a gate that is gone from gates.tsv is cleared, and the next gate is answered in the same flush', async () => {
  const b = await openMarker();
  b.hide.add('G1');
  await b.press(MAYA, 'press:project/G2:0:0'); // one flush: the marker of G1 first, then the answer of G2
  assert.equal(b.answerOf('G2'), 'A. Short');
  assert.deepEqual(b.writes.slice(2), ['G2 A. Short']);
  const gone = 'G1: the gate is not in gates.tsv any more; the bridge stops its check of the owner\'s answer and writes nothing back';
  assert.deepEqual(b.lines.filter((l) => l.startsWith('G1: the gate')), [gone]);
  b.hide.clear(); // the marker is gone: G1 comes back, and no loop writes to it again
  for (let i = 0; i < 3; i++) { b.now += 60_000; await b.bridge.loop(); }
  assert.deepEqual(b.writes.slice(2), ['G2 A. Short']);
  assert.equal(b.lines.filter((l) => l.startsWith('G1: the gate')).length, 1);
});

test('F-T43-7: an error in the restore of one gate does not stop the answers of the other gates', async () => {
  const b = await openMarker();
  b.fail = 1; // the restore of G1 reads decisions.tsv first, and that read throws
  await b.press(MAYA, 'press:project/G2:0:0');
  assert.equal(b.answerOf('G2'), 'A. Short');
  assert.ok(b.lines.includes('the answers of project/G1 to sage failed; the bridge tries again: decisions.tsv is not readable'));
  b.now += 60_000;
  await b.bridge.loop(); // the marker of G1 is still open, and the next flush writes the owner's answer back
  assert.equal(b.answerOf('G1'), 'New page');
  assert.deepEqual(b.writes.slice(2), ['G2 A. Short', 'G1 New page']);
});

test('F-T43-8: a decisions trail made shorter under a pending write back gives at most one write in a flush and clears the marker', async () => {
  const b = await openMarker();
  const path = join(b.sh('logbook'), 'decisions.tsv');
  writeFileSync(path, `${readFileSync(path, 'utf8').split('\n')[0]}\n`); // as `logbook repair --accept-loss decisions` can leave it
  b.now += 60_000;
  await b.bridge.loop();
  assert.ok(b.writes.length - 2 <= 1, `writes in one flush: ${b.writes.slice(2)}`);
  const short = 'G1: the decisions trail is shorter than at the last check; the bridge stops its check of the owner\'s answer and writes nothing back';
  assert.deepEqual(b.lines.filter((l) => l.startsWith('G1: the decisions')), [short]);
  const after = b.writes.length;
  for (let i = 0; i < 3; i++) { b.now += 60_000; await b.bridge.loop(); } // the marker is cleared: no later write
  assert.equal(b.writes.length, after);
  assert.equal(b.lines.filter((l) => l.startsWith('G1: the decisions')).length, 1);
});
