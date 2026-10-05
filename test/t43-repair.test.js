// T43 repair 1: the write back of the owner's answer is durable (F-T43-5), and the card shows it as final in the same turn (F-T43-6).
// The owner's `gate answer` goes in the window between the bridge's last read of gates.tsv and its own write, through the sage adapter.
// SAMPLE DATA ONLY: every id, name and answer is made up. HOME and SAGE_HOME are in a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAYA, setup } from './bridge-setup.js';

const RESTORED = (id, text) => `${id}: the owner answered at the terminal just before the bridge; the bridge wrote the owner's answer back: ${text}`;
const busy = () => Object.assign(new Error('the logbook is busy'), { code: 1 });

/**
 * A bridge whose sage adapter calls `write(b, id, text, real)` for each `sage gate answer`; `real` writes to the scratch logbook.
 * The default writes. A hook can write the owner's answer first, throw (sage refused), or never return (the bridge stopped).
 */
function raced(write) {
  const b = setup();
  const sage = b.sage;
  b.real = sage;
  b.sage = { ...sage, answer: (id, text) => write(b, id, text, () => sage.answer(id, text)) };
  b.bridge = b.make();
  return b;
}

const oneGate = async (b) => {
  b.sh('gate', 'add', 'T1', '--question', 'Which login page?', '--options', 'Old page|New page', '--recommend', 'Old page');
  await b.post();
};
/** The text of the card of the gate, as Discord shows it now. */
const cardText = (b) => [...b.discord.messages.keys()].map((id) => JSON.stringify(b.discord.latest(id))).find((t) => t.includes('Which login page?'));
const restored = (b) => b.lines.filter((l) => l.includes('wrote the owner'));

test('T43 repair: the write back fails once (the logbook is busy), and the next loop writes the owner answer back', async () => {
  let calls = 0;
  const b = raced(async (b, id, text, real) => {
    calls += 1;
    if (calls === 1) { b.sh('gate', 'answer', id, 'New page'); return real(); } // the owner types B as Maya presses A
    if (calls === 2) throw busy(); // the first write back
    return real();
  });
  await oneGate(b);
  await b.press(MAYA, 'press:G1:0:0');
  assert.equal(b.answerOf('G1'), 'A. Old page'); // the write back failed: the owner's answer is only in decisions.tsv
  b.now += 15_000;
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'New page');
  assert.equal(b.bridge.entry('G1').ask.parts[0].final.text, 'B. New page');
  assert.match(cardText(b), /Answered by Erick \(terminal\) at <t:\d+:t>: B\. New page\. Final\./);
  for (let i = 0; i < 10; i++) { b.now += 60_000; await b.bridge.loop(); } // no flip over many loops
  await b.make().loop(); // nor after a restart
  assert.equal(b.answerOf('G1'), 'New page');
  assert.deepEqual(restored(b), [RESTORED('G1', 'New page')]);
  assert.equal(calls, 3);
});

test('T43 repair: the bridge stops between its write and the write back, and the restore happens after the restart', async () => {
  let stopped = false;
  const b = raced(async (b, id, text, real) => {
    if (stopped) return new Promise(() => {}); // a stopped bridge does nothing more
    b.sh('gate', 'answer', id, 'New page');
    await real();
    stopped = true;
    return new Promise(() => {}); // the bridge stops just after sage wrote its answer, before it saved anything
  });
  await oneGate(b);
  b.press(MAYA, 'press:G1:0:0'); // never returns
  while (!stopped) await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.answerOf('G1'), 'A. Old page');
  b.sage = b.real;
  const restart = b.make();
  await restart.loop();
  assert.equal(b.answerOf('G1'), 'New page');
  assert.equal(restart.entry('G1').ask.parts[0].final.text, 'B. New page');
  for (let i = 0; i < 5; i++) { b.now += 60_000; await restart.loop(); }
  assert.equal(b.answerOf('G1'), 'New page');
  assert.deepEqual(restored(b), [RESTORED('G1', 'New page')]);
});

test('T43 repair: right after the write back, in the same turn, the card shows the owner answer as final', async () => {
  let once = true;
  const b = raced(async (b, id, text, real) => {
    if (once) { once = false; b.sh('gate', 'answer', id, 'New page'); }
    return real();
  });
  await oneGate(b);
  await b.press(MAYA, 'press:G1:0:0'); // no loop after the press
  assert.equal(b.answerOf('G1'), 'New page');
  assert.equal(b.bridge.entry('G1').ask.parts[0].final.text, 'B. New page');
  assert.match(cardText(b), /Answered by Erick \(terminal\) at <t:\d+:t>: B\. New page\. Final\./);
  assert.doesNotMatch(cardText(b), /Old page\. Final/);
});

test('T43 repair: a write back that sage refused never lands over a later owner answer, and the latest owner answer wins', async () => {
  // a) [owner New, bridge A, owner "Old page after all", write back New]: the owner's later answer must be written back, and its
  //    first write back fails. The next loop writes it.
  let calls = 0;
  const a = raced(async (b, id, text, real) => {
    calls += 1;
    if (calls === 1) b.sh('gate', 'answer', id, 'New page');
    if (calls === 2) b.sh('gate', 'answer', id, 'Old page after all'); // lands just before the first write back
    if (calls === 3) throw busy(); // the second write back
    return real();
  });
  await oneGate(a);
  await a.press(MAYA, 'press:G1:0:0');
  assert.equal(a.answerOf('G1'), 'New page');
  await a.bridge.loop();
  assert.equal(a.answerOf('G1'), 'Old page after all');
  assert.equal(a.bridge.entry('G1').ask.parts[0].final.text, 'Old page after all');
  for (let i = 0; i < 5; i++) { a.now += 60_000; await a.bridge.loop(); }
  assert.equal(a.answerOf('G1'), 'Old page after all');
  assert.deepEqual(restored(a), [RESTORED('G1', 'New page'), RESTORED('G1', 'Old page after all')]);

  // b) The write back of New fails; before the next loop the owner answers again. The next loop leaves the later answer.
  let n = 0;
  const b = raced(async (b, id, text, real) => {
    n += 1;
    if (n === 1) b.sh('gate', 'answer', id, 'New page');
    if (n === 2) throw busy();
    return real();
  });
  await oneGate(b);
  await b.press(MAYA, 'press:G1:0:0');
  b.sh('gate', 'answer', 'G1', 'Old page after all');
  for (let i = 0; i < 5; i++) { b.now += 60_000; await b.bridge.loop(); }
  assert.equal(b.answerOf('G1'), 'Old page after all');
  assert.equal(n, 2);
  assert.deepEqual(restored(b), []);
  assert.equal(b.bridge.entry('G1').ask.parts[0].final.text, 'Old page after all');
});
