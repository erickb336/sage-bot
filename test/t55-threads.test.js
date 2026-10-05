// T55: a deleted session thread moves its open cards to the parent channel (G17), an old line is retired when a session gets a new
// one, and the hook reads a --project word of quoted and bare pieces as the shell does (F-T55-1). Through the fake Discord layer, a
// scratch sage logbook and a scratch spool. SAMPLE DATA ONLY: every id is made up.
process.env.TZ = 'UTC'; // the title of a thread has the host's date: 2026-10-04 is a Sunday in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectOf, record } from '../src/sessions.js';
import { HOUR, MINUTE } from '../src/vote.js';
import { CHANNEL, APPRENTICE, JON, LEADR, MAYA, setAt, setup } from './bridge-setup.js';

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const spoolDir = (b) => `${b.statePath}.sessions`;
const hook = (b, event, extra = {}) => record({ session_id: S1, cwd: b.project, hook_event_name: event, ...extra },
  { projects: [{ name: 'project', project: b.project, own: true }], dir: spoolDir(b), pid: process.pid, now: b.now });
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
  assert.deepEqual(shown(b, thread), ['Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ', 'Question project/G4 · T3 ']);
  b.now += MINUTE;
  await b.press(MAYA, 'press:project/G4:0:0');
  await b.press(MAYA, 'press:project/G2+G3:0:0');
  const batchBefore = cardIn(b, thread, 'Batch vote project/G2+G3 · T2 ').embeds;
  assert.match(batchBefore[0].fields[0].value, /\*\*A\.\*\* x · Recommended · 1 vote \(Maya\)/);
  b.discord.deleteThread(thread);

  // The vote ends: the edit of the batch card finds the thread gone, the open cards move, and the tie post goes with them, in the
  // same loop: the cards first, then the tie post below the card that it is about (F-T55-3, T65).
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  const [line, ...rest] = shown(b, CHANNEL);
  assert.match(line, /^\*\*Session 1 · project · Sun 4 Oct\*\*/);
  assert.deepEqual(rest.slice(0, 2), ['Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ']);
  assert.match(rest[2], new RegExp(`^<@&${LEADR}> project/G2\\+G3 is tied after its vote`));
  const moved = cardIn(b, CHANNEL, 'Batch vote project/G2+G3 · T2 ');
  assert.match(moved.embeds[0].fields[0].value, /\*\*A\.\*\* x · Recommended · 1 vote \(Maya\)/); // the vote cast in the thread
  assert.match(moved.embeds[0].fields[1].value, /\*\*Tied: no votes\.\*\*/);
  assert.equal(b.discord.messages.get(b.discord.in(CHANNEL)[1])[0].content,
    `<@&${APPRENTICE}> <@&${LEADR}> project T1 needs one product answer. The first answer is final. Its session thread was deleted, so the card is here now, with the votes so far.`);
  assert.deepEqual(b.lines.filter((l) => /\(G17\)$/.test(l)), [
    'project/G1: its card moves to the parent channel, because the thread of Session 1 · project · Sun 4 Oct is gone (G17)',
    'project/G2+G3: its card moves to the parent channel, because the thread of Session 1 · project · Sun 4 Oct is gone (G17)']);

  // A lead breaks the tie on the moved card: the press counts, the card in the parent channel changes, and the lead's post goes there.
  await b.press(JON, 'tiebreak:project/G2+G3:1:1');
  assert.match(cardIn(b, CHANNEL, 'Batch vote project/G2+G3 · T2 ').embeds[0].fields[1].value, /tie broken by Jon/);
  assert.equal(shown(b, CHANNEL).at(-1), 'Jon (sage-lead) broke the tie on part 2 of project/G2+G3: B.');
  // The reminder of the open single goes to the parent channel; then a press on it counts there.
  b.now += 2 * HOUR;
  await b.bridge.loop();
  assert.match(shown(b, CHANNEL).at(-1), new RegExp(`^<@&${APPRENTICE}> <@&${LEADR}> reminder: project/G1 waits for an answer`));
  await b.press(MAYA, 'press:project/G1:0:1');
  assert.match(cardIn(b, CHANNEL, 'Question project/G1 · T1 ').embeds[0].description, /Answered by Maya/);
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2'), b.answerOf('G3'), b.answerOf('G4')], ['B. y', 'A. x', 'B. y', 'A. x']);
  // G4 was settled: it stays in the deleted thread and is not posted again.
  assert.equal(shown(b, CHANNEL).filter((t) => t === 'Question project/G4 · T3 ').length, 0);
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
    '**Session 1 · project · Sun 4 Oct**\nmoved to a new line below',
    '**Session 1 · project · Sun 4 Oct**\nrunning · 3 tasks · 3 open questions']);
  assert.equal(lines[0], oldLine);
  assert.equal(b.discord.threads.get(b.bridge.threadOf(S1)).from, lines[1]);
  assert.deepEqual(shown(b, b.bridge.threadOf(S1)), ['Question project/G3 · T3 ']);
});

test('F-T55-1: a --project word of quoted and bare pieces is read as /bin/sh reads it; a word with another $, a backtick or a command is ignored', () => {
  const b = setup();
  const home = join(b.root, 'home dir');
  const project = join(home, 'x y');
  mkdirSync(project, { recursive: true });
  // Through the hook first: the gate is recorded when the word names the project, also with mixed quotes.
  const post = (command, gate) => record(
    { session_id: S1, cwd: project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: `${gate} open · Q?\n`, stderr: '' } },
    { projects: [{ name: 'project', project, own: true }], dir: spoolDir(b), pid: process.pid, now: b.now, home });
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

// F-T55-3: a failure or a stop in the middle of a move never leaves an open card in the deleted thread.
/** A session with an open single G1 and a batch G2+G3 with Maya's vote on part 1, in a thread that is then deleted. */
async function movedSetup() {
  const b = setup();
  hook(b, 'SessionStart');
  gateAdd(b, 'T1');
  gateAdd(b, 'T2', 'A?');
  gateAdd(b, 'T2', 'B?');
  await b.post();
  b.now += MINUTE;
  await b.press(MAYA, 'press:project/G2+G3:0:0');
  b.discord.deleteThread(b.bridge.threadOf(S1));
  return b;
}
const cards = (b) => shown(b, CHANNEL).filter((t) => /^(Question|Batch vote) /.test(t));

test('F-T55-3: members() throws in the move of a deleted thread: the next loop posts every open card in the parent channel, each once', async () => {
  const b = await movedSetup();
  const real = b.discord.members;
  let thrown = false; // members() fails once, at its first call after the bridge forgot the thread
  b.discord.members = () => {
    if (!thrown && b.bridge.threadOf(S1) === undefined) { thrown = true; throw Object.assign(new Error('Service Unavailable'), { status: 503 }); }
    return real();
  };
  await b.press(MAYA, 'press:project/G2+G3:1:0'); // the edit of the batch card finds the thread gone
  assert.equal(b.bridge.threadOf(S1), undefined);
  await b.bridge.loop().catch(() => {});
  await b.bridge.loop().catch(() => {});
  assert.equal(thrown, true);
  assert.deepEqual(cards(b), ['Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ']);
  await b.bridge.loop();
  assert.deepEqual(cards(b), ['Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ']); // no duplicate
});

for (const hangAt of [1, 2]) {
  test(`F-T55-3: the bridge stops at the parent-channel card post #${hangAt} of a move: a restarted bridge posts the rest, each card once, and its reminders go to the parent channel`, async () => {
    const b = await movedSetup();
    const real = b.discord.post;
    let n = 0;
    let stopped;
    const stop = new Promise((r) => { stopped = r; });
    b.discord.post = (target, payload) => {
      if (target === CHANNEL && payload.embeds && ++n === hangAt) { stopped(); return new Promise(() => {}); } // a post that never returns
      return real(target, payload);
    };
    b.now += 30 * MINUTE;
    b.bridge.loop(); // the vote of G2+G3 ends, its edit finds the thread gone, and the move starts; this bridge never ends
    await stop;
    b.discord.post = real;
    b.bridge = b.make(); // the restart: a new bridge on the same state file
    b.now += MINUTE;
    await b.bridge.loop();
    await b.bridge.loop();
    assert.deepEqual(cards(b), ['Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ']);
    assert.match(cardIn(b, CHANNEL, 'Batch vote project/G2+G3 · T2 ').embeds[0].fields[0].value, /\*\*A\.\*\* x · Recommended · 1 vote \(Maya\)/);
    b.now += 2 * HOUR;
    await b.bridge.loop();
    const after = shown(b, CHANNEL);
    assert.equal(after.filter((t) => t.startsWith(`<@&${APPRENTICE}> <@&${LEADR}> reminder: project/G1 waits`)).length, 1);
    assert.equal(after.filter((t) => t.startsWith(`<@&${LEADR}> reminder: part 2 of project/G2+G3 still tied`)).length, 1);
    assert.deepEqual(cards(b), ['Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ']);
  });
}


// T65: a moved card that is settled before its new post stays quiet; a moved card's reminders and tie post come after its new post.
const pings = (b) => shown(b, CHANNEL).filter((t) => t?.startsWith(`<@&${APPRENTICE}>`) || t?.startsWith(`<@&${LEADR}>`));

test('F-T65-1: moved cards that are settled before their new post (one at the terminal, one by its vote) are not posted and ping nobody, also after a restart', async () => {
  const b = await movedSetup();
  await b.press(MAYA, 'press:project/G2+G3:1:0'); // the edit of the batch card finds the thread gone: G1 and G2+G3 move
  assert.equal(b.bridge.threadOf(S1), undefined);
  // The bridge stops before the new posts. The owner answers G1 at the terminal, and the vote of G2+G3 ends while it is stopped.
  b.sh('gate', 'answer', 'G1', 'y');
  b.now += 40 * MINUTE;
  b.bridge = b.make();
  await b.bridge.loop();
  await b.bridge.loop();
  assert.deepEqual(cards(b), []);
  assert.deepEqual(pings(b), []);
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2'), b.answerOf('G3')], ['y', 'A. x', 'A. x']);
  b.now += 3 * HOUR; // never later either
  await b.bridge.loop();
  b.bridge = b.make();
  await b.bridge.loop();
  assert.deepEqual(cards(b), []);
  assert.deepEqual(pings(b), []);
});

test('T65: Discord refuses the new posts of moved cards for 3 hours: the tie post waits for its card and comes after it; the reminders count from the new post, not before', async () => {
  const b = await movedSetup();
  const real = b.discord.post;
  b.discord.post = (target, payload) => (target === CHANNEL && payload.embeds
    ? Promise.reject(Object.assign(new Error('Internal Server Error'), { status: 500 })) : real(target, payload));
  b.now += 30 * MINUTE;
  await b.bridge.loop(); // the vote of G2+G3 ends tied on part 2; the edit finds the thread gone; Discord refuses the card posts
  assert.deepEqual(cards(b), []);
  assert.deepEqual(pings(b), []); // the tie post waits for the card that it is about
  b.discord.post = real;
  b.now += 3 * HOUR; // past the 2-hour reminder of both gates
  await b.bridge.loop();
  assert.deepEqual(shown(b, CHANNEL).slice(1).map((t) => t.split('.')[0]), [
    'Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ', `<@&${LEADR}> project/G2+G3 is tied after its vote`]);
  b.now += MINUTE;
  await b.bridge.loop();
  assert.equal(pings(b).length, 1); // no reminder right after the new post: only the tie post
  b.now += HOUR; // past the next 2-hour mark of each gate
  await b.bridge.loop();
  const all = shown(b, CHANNEL);
  assert.equal(all.filter((t) => t.startsWith(`<@&${APPRENTICE}> <@&${LEADR}> reminder: project/G1 waits`)).length, 1);
  assert.equal(all.filter((t) => t.startsWith(`<@&${LEADR}> reminder: part 2 of project/G2+G3 still tied`)).length, 1);
});

test('T65: the bridge stops before the new post of a moved card whose vote ended tied: after the restart the card comes first, then its tie post, once', async () => {
  const b = await movedSetup();
  const real = b.discord.post;
  let stopped;
  const stop = new Promise((r) => { stopped = r; });
  b.discord.post = (target, payload) => {
    if (target === CHANNEL && payload.embeds) { stopped(); return new Promise(() => {}); } // a post that never returns
    return real(target, payload);
  };
  b.now += 30 * MINUTE;
  b.bridge.loop(); // the vote of G2+G3 ends tied, its edit finds the thread gone, and the move starts; this bridge never ends
  await stop;
  b.discord.post = real;
  b.bridge = b.make();
  b.now += MINUTE;
  await b.bridge.loop();
  await b.bridge.loop();
  assert.deepEqual(shown(b, CHANNEL).slice(1).map((t) => t.split('.')[0]), [
    'Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ', `<@&${LEADR}> project/G2+G3 is tied after its vote`]);
});

// F-T65-4: messages held for a moved card keep their order, and a settled card drops them: no stale tie alert after the answer.
/** Discord refuses the tie alert of G2+G3 while `refuse.on` is true; every other post goes through. */
function refuseTieAlert(b) {
  const real = b.discord.post;
  const refuse = { on: true };
  b.discord.post = (target, payload) => (refuse.on && payload.content?.includes('project/G2+G3 is tied after its vote')
    ? Promise.reject(Object.assign(new Error('Internal Server Error'), { status: 500 })) : real(target, payload));
  return refuse;
}
const heldOf = (b, id) => JSON.parse(readFileSync(b.statePath, 'utf8')).entries.find((e) => e.gate.id === id).held;
const tieAlerts = (b) => shown(b, CHANNEL).filter((t) => t.startsWith(`<@&${LEADR}> project/G2+G3 is tied after its vote`));

test('F-T65-4: the moved card posts, Discord refuses its tie alert, then a lead breaks the tie: the tie-break note posts, the stale alert never does, the held list goes', async () => {
  const b = await movedSetup();
  const refuse = refuseTieAlert(b);
  b.now += 30 * MINUTE;
  await b.bridge.loop(); // the vote ends tied on part 2; the cards move and post; the tie alert is refused and held
  assert.deepEqual(cards(b), ['Question project/G1 · T1 ', 'Batch vote project/G2+G3 · T2 ']);
  assert.equal(heldOf(b, 'project/G2+G3').length, 1);
  refuse.on = false;
  await b.press(JON, 'tiebreak:project/G2+G3:1:0');
  await b.bridge.loop();
  await b.bridge.loop();
  assert.deepEqual(tieAlerts(b), []);
  assert.deepEqual(shown(b, CHANNEL).filter((t) => /broke the tie/.test(t)), ['Jon (sage-lead) broke the tie on part 2 of project/G2+G3: A.']);
  assert.equal(heldOf(b, 'project/G2+G3'), undefined);
  assert.deepEqual(b.lines.filter((l) => /drops/.test(l)), ['project/G2+G3: it is settled, so the bridge drops the 1 message(s) that waited for its card']);
});

test('F-T65-4: the owner answers at the terminal while the tie alert is held: the stale alert never posts, the held list goes', async () => {
  const b = await movedSetup();
  const refuse = refuseTieAlert(b);
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  assert.equal(heldOf(b, 'project/G2+G3').length, 1);
  refuse.on = false;
  b.sh('gate', 'answer', 'G3', 'y');
  await b.bridge.loop();
  await b.bridge.loop();
  assert.deepEqual(tieAlerts(b), []);
  assert.equal(heldOf(b, 'project/G2+G3'), undefined);
});

test('F-T65-4: a reminder about a card whose tie alert is held goes after the alert, never before it', async () => {
  const b = await movedSetup();
  const refuse = refuseTieAlert(b);
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  b.now += 2 * HOUR + MINUTE; // past the leads' 2-hour reminder of G2+G3
  await b.bridge.loop();
  assert.deepEqual(pings(b).filter((t) => t.includes('G2+G3')), []);
  refuse.on = false;
  await b.bridge.loop();
  assert.deepEqual(pings(b).filter((t) => t.includes('G2+G3')).map((t) => t.split(' of ')[0].split(' is ')[0]), [
    `<@&${LEADR}> project/G2+G3`, `<@&${LEADR}> reminder: part 2`]);
  assert.deepEqual(heldOf(b, 'project/G2+G3'), []);
});

// F-T65-3: the gate file is the bridge's own, so a held list that the bridge did not write is refused at load.
test('F-T65-3: a gate file with a held list that the bridge did not write is refused at load; one that it did write loads', async () => {
  const b = setup();
  gateAdd(b, 'T1');
  await b.post();
  const file = JSON.parse(readFileSync(b.statePath, 'utf8'));
  const withHeld = (held) => writeFileSync(b.statePath, JSON.stringify({ ...file, entries: [{ ...file.entries[0], held }] }), { mode: 0o600 });
  for (const held of ['abc', [{ content: 'hi', allowedMentions: { parse: [] } }, 7], [{ content: '@everyone hi' }],
    [{ content: '@everyone hi', allowedMentions: { parse: ['everyone'] } }], [{ content: 'hi', allowedMentions: { parse: [], roles: [LEADR] }, tts: true }],
    [{ content: 'x'.repeat(2001), allowedMentions: { parse: [] } }]]) {
    withHeld(held);
    assert.throws(() => b.make(), { message: 'the gate file has an entry with held messages that the bridge did not write' }, JSON.stringify(held).slice(0, 80));
  }
  withHeld([{ content: 'hi', allowedMentions: { parse: [] } }, { content: `<@&${LEADR}> hi`, allowedMentions: { parse: [], roles: [LEADR] } }]);
  assert.equal(typeof b.make().loop, 'function');
});
