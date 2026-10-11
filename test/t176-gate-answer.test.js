// T176: the bridge records an answer with the current form of `sage gate answer` (`--option <n>` or `--other-hex <hex>`), checks at
// start that the tool on its path takes it, and never takes an answer of the old form ("A. text") for the owner's. SAMPLE DATA ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempFolder } from './temp-folder.js';
import { answerArgs, OTHER, probeTool } from '../src/sage.js';
import { key, MAYA, SAGE, setup, table } from './bridge-setup.js';

const ROW = { id: 'G1', options: 'Sign in | Continue|Log in' };

test('answerArgs: an option by its text is --option <n>; the owner\'s own words after "other: " are --other-hex; anything else is refused', () => {
  assert.deepEqual(answerArgs(ROW, 'Sign in'), ['--option', '1']);
  assert.deepEqual(answerArgs(ROW, 'Log in'), ['--option', '3']);
  assert.deepEqual(answerArgs(ROW, `${OTHER}Ask the team again`), ['--other-hex', '41736b20746865207465616d20616761696e']);
  assert.throws(() => answerArgs(ROW, 'A. Sign in'), { message: 'G1: "A. Sign in" is not the text of one of its options and does not start with "other: "' });
  assert.throws(() => answerArgs(ROW, OTHER), /does not start with/);
});

test('the bridge records a press as the option\'s text, and sage keeps it as `gate answer --option <n>` does', async () => {
  const b = setup();
  b.sh('task', 'add', '--title', 'Sign-in page copy', '--size', 'tiny');
  b.sh('gate', 'add', 'T1', '--question', 'What does the sign-in button say?', '--options', 'Sign in|Continue', '--recommend', 'Sign in');
  await b.post();
  await b.press(MAYA, `press:${key('G1')}:0:1`);
  assert.equal(b.answerOf('G1'), 'Continue');
  assert.ok(b.lines.includes(`sage gate ${key('G1')} answered: Continue`), b.lines.join('\n'));
  assert.deepEqual(table(b, 'decisions').map((d) => d.decision), ['What does the sign-in button say? → Continue']);
});

test('probeTool: the pinned tool passes; a tool that refuses --option is refused with one line that names it and the needed form', async () => {
  await probeTool(SAGE, { PATH: process.env.PATH });
  const old = join(tempFolder('sage-bot-t176-'), 'sage.mjs');
  // A fake of the state tool before 6ea307ffa7b5: `gate answer` took the answer text and refused --option.
  writeFileSync(old, `const a = process.argv.slice(2);
if (a[0] === 'gate' && a[1] === 'answer' && a.includes('--option')) { console.error('sage: gate answer takes the answer text'); process.exit(1); }
console.log(a[0] === 'init' ? 'logbook /nowhere' : 'ok');
`);
  await assert.rejects(probeTool(old, { PATH: process.env.PATH }), {
    message: `the sage state tool ${old} refused gate answer --option; the bridge needs gate answer <G> --option <n> (sage plugin 6ea307ffa7b5 or later): sage: gate answer takes the answer text. Nothing was started.`,
  });
});

test('an answer of the old form, "A. text", in an existing logbook never counts as the owner\'s terminal answer', async () => {
  const b = setup();
  b.sh('task', 'add', '--title', 'CSV export', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which file type?', '--options', 'CSV|JSON', '--recommend', 'CSV');
  await b.post();
  // As the bridge before T176 wrote it, straight into gates.tsv: sage no longer takes this text.
  const path = join(b.sh('logbook'), 'gates.tsv');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^(G1\t(?:[^\t]*\t){5})[^\t]*/m, '$1A. CSV'));
  assert.equal(b.answerOf('G1'), 'A. CSV');
  await b.bridge.loop();
  assert.equal(b.bridge.entry(key('G1')).ask.parts[0].final, undefined);
  assert.equal(b.lines.some((l) => l.includes('answered at the terminal')), false, b.lines.join('\n'));
  // The vote goes on: a press settles it and the bridge writes the option's text.
  await b.press(MAYA, `press:${key('G1')}:0:1`);
  assert.equal(b.answerOf('G1'), 'JSON');
});
