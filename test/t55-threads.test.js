// T55: a deleted session thread moves its open cards to the parent channel (G17), an old line is retired when a session gets a new
// one, and the hook reads a --project word of quoted and bare pieces as the shell does (F-T55-1). Through the fake Discord layer, a
// scratch sage logbook and a scratch spool. SAMPLE DATA ONLY: every id is made up.
process.env.TZ = 'UTC'; // the title of a thread has the host's date: 2026-10-04 is a Sunday in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectOf, record } from '../src/sessions.js';
import { HOUR, MINUTE } from '../src/vote.js';
import { CHANNEL, DRIVER, JON, LEADR, MAYA, setAt, setup } from './bridge-setup.js';

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const spoolDir = (b) => `${b.statePath}.sessions`;
const hook = (b, event, extra = {}) => record({ session_id: S1, cwd: b.project, hook_event_name: event, ...extra },
  { project: b.project, dir: spoolDir(b), pid: process.pid, now: b.now });
/** `sage gate add` at the test's clock, then the PostToolUse hook of S1 with its real output. */
function gateAdd(b, task, question = `${task} question?`) {
  const out = b.sh('gate', 'add', task, '--question', question, '--options', 'x|y', '--recommend', 'x');
  setAt(b, { [out.split(' ')[0]]: new Date(b.now).toISOString().slice(0, 19) + 'Z' });
  hook(b, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `node sage.mjs gate add ${task}` }, tool_response: { stdout: `${out}\n`, stderr: '' } });
}
/** The messages of one place: a card by its title, any other message by its content. */
const shown = (b, at) => b.discord.in(at).map((id) => b.discord.latest(id)).map((p) => p.embeds?.[0].title ?? p.content);
const cardIn = (b, at, title) => b.discord.latest(b.discord.in(at).find((id) => b.discord.messages.get(id)[0].embeds?.[0].title === title));

test('G17: a deleted session thread: its open single and open batch are posted again in the parent channel with their votes; presses count there; the tie post, the lead\'s post and the reminder go there; a settled card is not posted again', async () => {
  const b = setup();
  hook(b, 'SessionStart');
  gateAdd(b, 'T1'); // G1, a single question
  gateAdd(b, 'T2', 'A?'); // G2+G3, a batch
  gateAdd(b, 'T2', 'B?');
  gateAdd(b, 'T3'); // G4, settled before the delete
  await b.post();
  const thread = b.bridge.threadOf(S1);
  assert.deepEqual(shown(b, thread), ['Question G1 · T1 ', 'Batch vote G2+G3 · T2 ', 'Question G4 · T3 ']);
  b.now += MINUTE;
  await b.press(MAYA, 'press:G4:0:0');
  await b.press(MAYA, 'press:G2+G3:0:0');
  const batchBefore = cardIn(b, thread, 'Batch vote G2+G3 · T2 ').embeds;
  assert.match(batchBefore[0].fields[0].value, /\*\*A\.\*\* x · Recommended · 1 vote \(Maya\)/);
  b.discord.deleteThread(thread);

  // The vote ends: the edit of the batch card finds the thread gone, the open cards move, and the tie post goes with them.
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  const [line, ...rest] = shown(b, CHANNEL);
  assert.match(line, /^\*\*Session 1 · Sun 4 Oct\*\*/);
  assert.deepEqual(rest.slice(0, 2), ['Question G1 · T1 ', 'Batch vote G2+G3 · T2 ']);
  assert.match(rest[2], new RegExp(`^<@&${LEADR}> G2\\+G3 is tied after its vote`));
  assert.equal(rest.length, 3);
  const moved = cardIn(b, CHANNEL, 'Batch vote G2+G3 · T2 ');
  assert.match(moved.embeds[0].fields[0].value, /\*\*A\.\*\* x · Recommended · 1 vote \(Maya\)/); // the vote cast in the thread
  assert.match(moved.embeds[0].fields[1].value, /\*\*Tied: no votes\.\*\*/);
  assert.equal(b.discord.messages.get(b.discord.in(CHANNEL)[1])[0].content,
    `<@&${DRIVER}> T1 needs one product answer. The first answer is final. Its session thread was deleted, so the card is here now, with the votes so far.`);
  assert.deepEqual(b.lines.filter((l) => /\(G17\)$/.test(l)), [
    'G1: its card is posted again in the parent channel, because the thread of Session 1 · Sun 4 Oct is gone (G17)',
    'G2+G3: its card is posted again in the parent channel, because the thread of Session 1 · Sun 4 Oct is gone (G17)']);

  // A lead breaks the tie on the moved card: the press counts, the card in the parent channel changes, and the lead's post goes there.
  await b.press(JON, 'tiebreak:G2+G3:1:1');
  assert.match(cardIn(b, CHANNEL, 'Batch vote G2+G3 · T2 ').embeds[0].fields[1].value, /tie broken by Jon/);
  assert.equal(shown(b, CHANNEL).at(-1), 'Jon (sage-lead) broke the tie on part 2 of G2+G3: B.');
  // The reminder of the open single goes to the parent channel; then a press on it counts there.
  b.now += 2 * HOUR;
  await b.bridge.loop();
  assert.match(shown(b, CHANNEL).at(-1), new RegExp(`^<@&${DRIVER}> reminder: G1 waits for an answer`));
  await b.press(MAYA, 'press:G1:0:1');
  assert.match(cardIn(b, CHANNEL, 'Question G1 · T1 ').embeds[0].description, /Answered by Maya/);
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2'), b.answerOf('G3'), b.answerOf('G4')], ['B. y', 'A. x', 'B. y', 'A. x']);
  // G4 was settled: it stays in the deleted thread and is not posted again.
  assert.equal(shown(b, CHANNEL).filter((t) => t === 'Question G4 · T3 ').length, 0);
});

test('F-T55-1: when a deleted thread forces a new line, the old line is retired: it says that the session moved to a new line below', async () => {
  const b = setup();
  hook(b, 'SessionStart');
  gateAdd(b, 'T1');
  await b.post();
  const [oldLine] = b.discord.in(CHANNEL);
  b.discord.deleteThread(b.bridge.threadOf(S1), { keepOnLine: true }); // Discord keeps the deleted thread on the line
  gateAdd(b, 'T2');
  await b.post(); // G2 finds the thread gone: G1 moves to the parent channel, and G2 goes there too
  gateAdd(b, 'T3');
  await b.post(); // G3 needs a thread: the old line cannot start one, so the session gets a new line
  const lines = b.discord.in(CHANNEL).filter((id) => /^\*\*Session/.test(b.discord.latest(id).content ?? ''));
  assert.deepEqual(lines.map((id) => b.discord.latest(id).content), [
    '**Session 1 · Sun 4 Oct**\nmoved to a new line below',
    '**Session 1 · Sun 4 Oct**\nrunning · 3 tasks · 3 open questions']);
  assert.equal(lines[0], oldLine);
  assert.equal(b.discord.threads.get(b.bridge.threadOf(S1)).from, lines[1]);
  assert.deepEqual(shown(b, b.bridge.threadOf(S1)), ['Question G3 · T3 ']);
});

test('F-T55-1: a --project word of quoted and bare pieces is read as /bin/sh reads it; a word with another $, a backtick or a command is ignored', () => {
  const b = setup();
  const home = join(b.root, 'home dir');
  const project = join(home, 'x y');
  mkdirSync(project, { recursive: true });
  // Through the hook first: the gate is recorded when the word names the project, also with mixed quotes.
  const post = (command, gate) => record(
    { session_id: S1, cwd: project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: `${gate} open · Q?\n`, stderr: '' } },
    { project, dir: spoolDir(b), pid: process.pid, now: b.now, home });
  assert.deepEqual([
    post(`node sage.mjs gate add T1 --project "$HOME"/'x y' --question "Q?"`, 'G1'),
    post(`node sage.mjs gate add T2 --project ~/'x y'`, 'G2'),
    post(`node sage.mjs gate add T3 --project "\${HOME}/x y"`, 'G3'),
    post(`node sage.mjs gate add T4 --project "$HOME"/x`, 'G4'),
    post(`node sage.mjs gate add T5 --project "$(pwd)"`, 'G5'),
  ], [`PostToolUse ${S1}`, `PostToolUse ${S1}`, `PostToolUse ${S1}`, 'another project', 'a project that only the shell knows']);
  // Each word as /bin/sh gives it, with the same HOME.
  const words = [`"$HOME"/x`, `"$HOME"/'x y'`, `~/'x y'`, `"\${HOME}/x"`, `"$HOME/x y"`, `~`, `~/x`, `'~/x'`, `a"b c"'d'`, `"$HOME"`];
  const shell = (word) => spawnSync('/bin/sh', ['-c', `printf %s ${word}`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }).stdout;
  assert.deepEqual(words.map((w) => projectOf(w, home)), words.map(shell));
  assert.deepEqual([`"$(pwd)"`, '`pwd`', '"$HOME"/$(pwd)', '$PROJECT', '"$HOMEx"', '~root/x', `"x`, '$HOME/x'].map((w) => projectOf(w, home)), Array(8).fill(undefined));
  assert.equal(shell('$HOME/x'), `${join(b.root, 'home')}dir/x`); // the shell splits a bare $HOME with a space into two words
});
