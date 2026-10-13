// T45 round 1 repair (R868): F-T45-2 and F-T45-3. Through the fake Discord layer and a scratch sage logbook.
// SAMPLE DATA ONLY: every id, name and answer is made up. HOME and SAGE_HOME are in a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOOP } from '../src/bridge.js';
import { FIXTURE, MAYA, MEMBERS, setup } from './bridge-setup.js';
import { tempFolder } from './temp-folder.js';

const add = (b, question) => b.sh('gate', 'add', 'T1', '--question', question, '--options', 'x|y', '--recommend', 'x');
const LOUD = "project/G1: the decisions trail does not show the bridge's write: sage's gate answer rows changed; the owner's answer is not protected";

/** A scratch copy of the pinned sage whose `gate answer` writes decision rows with another why text, as a newer sage may. */
function changedSage() {
  const root = join(dirname(FIXTURE), '..', '..');
  // The real path: sage runs its command only when its argv[1] is its own real path, and TMPDIR may be a link (/var on macOS).
  const copy = join(realpathSync.native(tempFolder('sage-bot-why-')), 'sage');
  cpSync(root, copy, { recursive: true });
  const state = join(copy, 'core', 'state.mjs');
  const before = readFileSync(state, 'utf8');
  const after = before.replace(`"the user's answer" : "the user's own words"`, `"the owner's answer" : "the owner's own words"`);
  assert.notEqual(after, before, 'the copy changes the why text');
  writeFileSync(state, after);
  return join(copy, 'skills', 'sage', 'sage.mjs');
}

test('F-T45-2: when sage changes the why of its answer rows, the bridge says so loudly and keeps its check, also after a restart', async () => {
  const b = setup({ tool: changedSage() });
  const sage = b.sage;
  let once = true;
  // Erick types y at the terminal between the bridge's last read and its write.
  b.sage = { ...sage, answer: async (id, text) => { if (once) { once = false; b.sh('gate', 'answer', id, 'y'); } return sage.answer(id, text); } };
  b.bridge = b.make();
  add(b, 'Which page?');
  await b.post();
  await b.press(MAYA, 'press:project/G1:0:0'); // Maya presses x
  for (let i = 0; i < 3; i++) { b.now += LOOP; await b.bridge.loop(); }
  assert.equal(b.answerOf('G1'), 'x'); // the bridge cannot see Erick's answer in the trail
  assert.deepEqual(b.lines.filter((l) => l.includes('decisions trail')), [LOUD]); // once, and never "stops its check"
  const restart = b.make(); // the check is still open in the gate file, so a restart says it again
  await restart.loop();
  assert.deepEqual(b.lines.filter((l) => l.includes('decisions trail')), [LOUD, LOUD]);
});

test('F-T45-3: a redraw that Discord keeps refusing with 50013 logs once and backs off', async () => {
  const members = structuredClone(MEMBERS);
  const b = setup({ members });
  add(b, 'Which page?');
  await b.post();
  const [id] = b.discord.messages.keys();
  const real = b.discord.edit;
  let tries = 0;
  b.discord.edit = (target, message, payload) => {
    if (message !== id) return real(target, message, payload);
    tries++;
    return Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }));
  };
  members[1].roles = []; // Maya loses the sage-apprentice role: each open card is redrawn
  for (let i = 0; i < 10; i++) { await b.bridge.loop(); b.now += LOOP; }
  assert.deepEqual(b.lines.filter((l) => l.startsWith('Discord refused the edit of project/G1')), [
    'Discord refused the edit of project/G1: code 50013, status 403: Missing Permissions. The bridge tries again after longer and longer waits',
  ]);
  assert.equal(tries, 4); // at 0, 15, 45 and 105 s of the 150 s: 15 s, then twice as long after each refusal
  b.discord.edit = real;
  b.now += 2 * 60_000; // past the next wait
  const edits = b.discord.messages.get(id).length;
  await b.bridge.loop();
  assert.equal(b.discord.messages.get(id).length, edits + 1); // the redraw lands when Discord takes it again
});
