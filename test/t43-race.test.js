// T43 (F-T43-1): the owner's answer at the terminal survives a bridge answer at the same moment (G10 a).
// The owner's `gate answer` goes in the window between the bridge's last read of gates.tsv and its own write, through the
// sage adapter. SAMPLE DATA ONLY: every id, name and answer is made up. HOME and SAGE_HOME are in a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAYA, setup } from './bridge-setup.js';

const RESTORED = (id, text) => `${id}: the owner answered at the terminal just before the bridge; the bridge wrote the owner's answer back: ${text}`;

/** A bridge whose sage adapter runs `before(id)` just before each of its writes, and `check()` at each read of the decisions. */
function raced({ before = () => {}, check = () => {} } = {}) {
  const b = setup();
  const sage = b.sage;
  b.sage = {
    ...sage,
    answer: async (id, text) => { before(b, id, text); return sage.answer(id, text); },
    decisions: async () => { check(b); return sage.decisions(); },
  };
  b.bridge = b.make();
  return b;
}

const twoGates = async (b) => {
  b.sh('gate', 'add', 'T1', '--question', 'Which login page?', '--options', 'Old page|New page', '--recommend', 'Old page');
  b.sh('gate', 'add', 'T2', '--question', 'Which footer?', '--options', 'Short|Long', '--recommend', 'Short');
  await b.post();
};

test('T43: the owner answers between the read and the write of the bridge: gates.tsv ends with the owner answer, with one line', async () => {
  let once = true;
  const b = raced({ before: (b, id) => { if (id === 'G1' && once) { once = false; b.sh('gate', 'answer', 'G1', 'New page'); } } });
  await twoGates(b);
  await b.press(MAYA, 'press:G1:0:0'); // Maya presses A; the owner types B at the same moment
  await b.press(MAYA, 'press:G2:0:1'); // no owner answer on G2
  assert.equal(b.answerOf('G1'), 'New page');
  assert.equal(b.answerOf('G2'), 'B. Long'); // without an owner answer, the bridge answer stays
  assert.deepEqual(b.lines.filter((l) => l.includes('wrote the owner')), [RESTORED('G1', 'New page')]);
  await b.bridge.loop();
  assert.equal(b.bridge.entry('G1').ask.parts[0].final.text, 'B. New page'); // the card shows the owner answer as final
});

test('T43: repeated loops and presses after the write back never flip the answer', async () => {
  let once = true;
  const b = raced({ before: (b, id) => { if (once) { once = false; b.sh('gate', 'answer', id, 'New page'); } } });
  await twoGates(b);
  await b.press(MAYA, 'press:G1:0:0');
  for (let i = 0; i < 4; i++) { b.now += 60_000; await b.bridge.loop(); }
  await b.press(MAYA, 'press:G1:0:0');
  const restart = b.make(); // a restart reads the saved state
  await restart.loop();
  assert.equal(b.answerOf('G1'), 'New page');
  assert.equal(b.lines.filter((l) => l.includes('wrote the owner')).length, 1);
  assert.equal(b.lines.filter((l) => l === 'sage gate G1 answered: A. Old page').length, 1);
});

test('T43: the bridge never writes back over a later owner answer, also one that lands during its own check', async () => {
  // a) The owner changes the answer again after the bridge's write, while the bridge reads the trail to check.
  let phase = 0;
  const a = raced({
    before: (b, id, text) => { if (phase === 0 && text === 'A. Old page') { phase = 1; b.sh('gate', 'answer', id, 'New page'); } },
    check: (b) => { if (phase === 1 && b.answerOf('G1') === 'A. Old page') { phase = 2; b.sh('gate', 'answer', 'G1', 'Old page after all'); } },
  });
  await twoGates(a);
  await a.press(MAYA, 'press:G1:0:0');
  await a.bridge.loop();
  assert.equal(a.answerOf('G1'), 'Old page after all');
  assert.equal(phase, 2);
  assert.equal(a.lines.filter((l) => l.includes('wrote the owner')).length, 0);
  assert.equal(a.bridge.entry('G1').ask.parts[0].final.text, 'Old page after all');

  // b) The owner changes the answer again between the bridge's check and its write back: the next check writes back the later one.
  let step = 0;
  const b = raced({
    before: (b, id, text) => {
      if (step === 0 && text === 'A. Old page') { step = 1; b.sh('gate', 'answer', id, 'New page'); }
      else if (step === 1 && text === 'New page') { step = 2; b.sh('gate', 'answer', id, 'Old page after all'); }
    },
  });
  await twoGates(b);
  await b.press(MAYA, 'press:G1:0:0');
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'Old page after all');
  assert.equal(step, 2);
  assert.deepEqual(b.lines.filter((l) => l.includes('wrote the owner')), [RESTORED('G1', 'New page'), RESTORED('G1', 'Old page after all')]);
  assert.equal(b.bridge.entry('G1').ask.parts[0].final.text, 'Old page after all');
});
