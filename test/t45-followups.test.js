// T45: the low findings of seven small bridge follow-ups (F-T41-1, F-T45-1, F-T46-1, F-T48-1, F-T49-1, F-T61-1, F-T68-1).
// Through the fake Discord layer and a scratch sage logbook. SAMPLE DATA ONLY: every id, name and answer is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { LOOP, MERGE } from '../src/bridge.js';
import { HOUR, MINUTE } from '../src/vote.js';
import { JON, MAYA, MEMBERS, OWNER, setup } from './bridge-setup.js';

const REFERENCE = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
const refused = () => Promise.reject(Object.assign(new Error('Internal Server Error'), { status: 500 }));
const card = (b, id = [...b.discord.messages.keys()][0]) => b.discord.latest(id);
const add = (b, task, question, options = 'x|y') => b.sh('gate', 'add', ...(task ? [task] : []), '--question', question, '--options', options, '--recommend', options.split('|')[0]);
const stays = (b, id) => b.lines.filter((l) => l.startsWith(`project/${id} stays at the terminal`));

test('F-T41-1: the merge rule takes every word that holds "merg", in any letter case, and no other word', async () => {
  for (const word of ['merge', 'merges', 'merged', 'merging', 'mergeable', 'unmerged', 'automerge', 'auto_merge', 'MERGE_CHECK', 'Merge']) {
    assert.equal(MERGE.test(`Is PR 12 ${word} now?`), true, word);
  }
  for (const word of ['margin', 'mirage', 'merchant', 'emerald', 'mere', 'urge']) assert.equal(MERGE.test(`Is PR 12 ${word} now?`), false, word);
  const b = setup();
  add(b, 'T1', 'Is PR 12 mergeable now?', 'yes|no');
  await b.post();
  assert.equal(b.discord.posts.length, 0);
  assert.deepEqual(stays(b, 'G1'), ['project/G1 stays at the terminal: it is about a merge, and a merge never goes to a vote']);
});

test('F-T45-1: the owner\'s own words at the terminal on a single question are the final answer on the card, not a withdraw', async () => {
  const b = setup();
  add(b, 'T1', 'Which page?');
  await b.post();
  b.sh('gate', 'answer', 'G1', 'neither, ship the old one');
  await b.bridge.loop();
  const e = b.bridge.entry('project/G1');
  assert.equal(e.gate.outcome.status, 'open');
  assert.deepEqual(e.ask.parts[0].final, { by: OWNER, at: b.now, text: 'other: neither, ship the old one' });
  assert.match(card(b).embeds[0].description, /Answered by Erick \(terminal\) at <t:\d+:t>: other: neither, ship the old one\. Final\./);
  assert.doesNotMatch(card(b).embeds[0].description, /Withdrawn/);
  assert.equal(b.answerOf('G1'), 'other: neither, ship the old one'); // the bridge writes nothing over it
});

test('F-T45-1: a redraw for new holders that Discord refuses is tried again at the next loop', async () => {
  const members = structuredClone(MEMBERS);
  const b = setup({ members });
  add(b, 'T1', 'Which page?');
  await b.post();
  const [id] = b.discord.messages.keys();
  const real = b.discord.edit;
  let refuse = true;
  b.discord.edit = (...a) => (refuse ? ((refuse = false), refused()) : real(...a));
  members[1].roles = []; // Maya loses the sage-apprentice role
  await b.bridge.loop(); // the redraw is refused
  const edits = b.discord.messages.get(id).length;
  await b.bridge.loop();
  assert.equal(b.discord.messages.get(id).length, edits + 1);
});

test('F-T46-1: a merge gate that is first unmarked, then marked, gets the merge line too', async () => {
  const b = setup({ markAll: false });
  add(b, 'T1', 'Merge PR 12 now?', 'yes|no');
  await b.post();
  b.mark('G1');
  await b.bridge.loop();
  assert.deepEqual(stays(b, 'G1'), [
    'project/G1 stays at the terminal: sage did not mark it as a team vote',
    'project/G1 stays at the terminal: it is about a merge, and a merge never goes to a vote',
  ]);
});

test('F-T46-1: when the team votes file is refused, a marked gate is logged with that reason, never as "not marked"', async () => {
  const b = setup();
  add(b, 'T1', 'Which page?');
  chmodSync(`${b.statePath}.votes`, 0o644);
  await b.post();
  await b.bridge.loop();
  assert.equal(b.discord.posts.length, 0);
  assert.deepEqual(stays(b, 'G1'), [`project/G1 stays at the terminal: the bridge cannot read the marks, so no gate is posted (see the line "no gate is posted")`]);
  chmodSync(`${b.statePath}.votes`, 0o600);
  await b.post();
  assert.equal(b.discord.posts.length, 1); // the card comes when the file is readable again
});

test('F-T48-1: after a sleep, the sage-leads\' reminders keep their 2-hour steps from the end of the vote, not from the tie post', async () => {
  const b = setup();
  add(b, 'T1', 'A?');
  add(b, 'T1', 'B?');
  await b.post();
  const end = b.now + 30 * MINUTE;
  b.now = end + 92 * MINUTE; // the Mac slept through the end of the vote
  await b.bridge.loop(); // the tick: both parts tied, and the tie post
  const leads = () => b.discord.posts.filter((p) => p.content?.includes('still tied')).length;
  assert.equal(b.discord.posts.filter((p) => p.content?.includes('is tied after its vote')).length, 1);
  b.now = end + 2 * HOUR + 1000; // 29 minutes after the tie post
  await b.bridge.loop();
  assert.equal(leads(), 1);
  assert.match(REFERENCE, /The 2-hour reminders keep their steps from the end of the vote/);
});

test('F-T49-1: gates with no task, asked within 30 s, get one card each', async () => {
  const b = setup();
  add(b, '', 'A?');
  add(b, '', 'B?');
  await b.post();
  assert.deepEqual(b.discord.posts.map((p) => p.embeds?.[0].title.split(' · ')[0]), ['Question project/G1', 'Question project/G2']);
});

test('F-T49-1: a loop turn longer than 75 s is no sleep; a gap between turns still is', async () => {
  const b = setup();
  add(b, 'T1', 'Which page?');
  await b.post();
  const sage = b.sage;
  let slow = false;
  b.sage = { ...sage, gates: async () => { if (slow) { slow = false; b.now += 80_000; } return sage.gates(); } };
  b.bridge = b.make();
  await b.bridge.loop();
  slow = true;
  b.now += LOOP;
  await b.bridge.loop(); // this turn takes 80 s
  b.now += LOOP;
  await b.bridge.loop();
  const notes = () => b.discord.posts.filter((p) => p.content?.startsWith('The host was asleep')).length;
  assert.equal(notes(), 0);
  b.now += 2 * HOUR;
  await b.bridge.loop();
  assert.equal(notes(), 1);
});

test('F-T49-1: a tied part that the owner answered at the terminal lets sage get the other answers while the gate is tied', async () => {
  const b = setup();
  add(b, 'T1', 'A?');
  add(b, 'T1', 'B?');
  await b.post();
  await b.press(MAYA, 'press:project/G1+G2:0:0');
  b.now += 30 * MINUTE;
  await b.bridge.loop(); // part 1 goes to x; part 2 has no votes, so it is tied
  b.sh('gate', 'answer', 'G2', 'y');
  await b.bridge.loop();
  assert.equal(b.bridge.entry('project/G1+G2').gate.phase, 'tied');
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['x', 'y']);
  assert.match(REFERENCE, /sage gets the other answers while the gate is still tied/);
});

/** A bridge whose sage adapter runs `before(b, id, text)` just before each of its writes (as in t43-race.test.js). */
function raced(before) {
  const b = setup();
  const sage = b.sage;
  b.sage = { ...sage, answer: async (id, text) => { before(b, id, text); return sage.answer(id, text); } };
  b.bridge = b.make();
  return b;
}
const once = (work) => { let done = false; return (b, id, text) => { if (!done && id === 'G1') { done = true; work(b, text); } }; };
const writeBacks = (b) => b.lines.filter((l) => /wrote the owner's answer back|owner's answer of G1 again/.test(l));
const loginGate = async (b) => { add(b, 'T1', 'Which login page?', 'Old page|New page'); await b.post(); };

test('F-T61-1: a sage log line that reads like an answer of the gate is not the owner\'s answer', async () => {
  const b = raced(once((b) => b.sh('log', 'T1', 'Which login page? → New page', '--why', 'a note of the session')));
  await loginGate(b);
  await b.press(MAYA, 'press:project/G1:0:0');
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'Old page');
  assert.deepEqual(writeBacks(b), []);
});

test('F-T61-1: the answer of another gate whose question starts with this question is not the owner\'s answer of this gate', async () => {
  const b = raced(once((b) => {
    add(b, 'T1', 'Which login page? → which logo?', 'Blue|Red');
    b.sh('gate', 'answer', 'G2', 'Red');
  }));
  await loginGate(b);
  await b.press(MAYA, 'press:project/G1:0:0');
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'Old page');
  assert.deepEqual(writeBacks(b), []);
});

test('F-T61-1: the owner types the same answer as the bridge just before it: no write back, and no write-back line', async () => {
  const b = raced(once((b) => b.sh('gate', 'answer', 'G1', 'Old page')));
  await loginGate(b);
  await b.press(MAYA, 'press:project/G1:0:0');
  await b.bridge.loop();
  assert.equal(b.answerOf('G1'), 'Old page');
  assert.deepEqual(writeBacks(b), []);
});

/** Puts `held` on the first entry of the gate file, as a card whose messages wait, and starts the bridge again on it. */
function withHeld(b, held) {
  const file = JSON.parse(readFileSync(b.statePath, 'utf8'));
  file.entries[0].held = held;
  writeFileSync(b.statePath, JSON.stringify(file));
  b.bridge = b.make();
}
const NOTE = { content: 'a held note', allowedMentions: { parse: [] } };
const heldOf = (b) => JSON.parse(readFileSync(b.statePath, 'utf8')).entries[0].held;

test('F-T68-1: a press and the loop at once post a held message once', async () => {
  const b = setup();
  add(b, 'T1', 'A?');
  add(b, 'T1', 'B?');
  await b.post();
  b.now += 30 * MINUTE;
  await b.bridge.loop(); // nobody voted: both parts are tied
  withHeld(b, [NOTE]);
  const real = b.discord.post;
  let calls = 0;
  let release;
  let called;
  const gate = new Promise((r) => { release = r; });
  const first = new Promise((r) => { called = r; });
  b.discord.post = (target, payload) => {
    if (payload.content !== NOTE.content) return real(target, payload);
    if (++calls === 1) called();
    if (calls === 2) release();
    return gate.then(() => real(target, payload));
  };
  const loop = b.bridge.loop();
  await first; // the loop posts the held note, and Discord has not answered yet
  const press = b.press(JON, 'tiebreak:project/G1+G2:0:0'); // its note about the tie-break posts the held messages first
  await Promise.race([press, new Promise((r) => { setTimeout(r, 2000); })]);
  release();
  await Promise.all([loop, press]);
  assert.equal(b.discord.posts.filter((p) => p.content === NOTE.content).length, 1);
  assert.equal(b.discord.posts.filter((p) => /broke the tie/.test(p.content ?? '')).length, 1);
});

test('F-T68-1: a lasting refusal of a held message backs off, logs once, and adds no reminder to the held list', async () => {
  const b = setup();
  add(b, 'T1', 'Which page?');
  await b.post();
  withHeld(b, [NOTE]);
  const real = b.discord.post;
  let tries = 0;
  b.discord.post = (target, payload) => (payload.content === NOTE.content ? (tries++, refused()) : real(target, payload));
  for (let i = 0; i < 40; i++) { await b.bridge.loop(); b.now += LOOP; } // 10 minutes
  assert.ok(tries <= 8, `${tries} tries in 40 loops`);
  b.now += 5 * HOUR; // past two 2-hour reminders
  for (let i = 0; i < 3; i++) { await b.bridge.loop(); b.now += LOOP; }
  assert.deepEqual(heldOf(b), [NOTE]);
  assert.equal(b.lines.filter((l) => l.includes('Internal Server Error')).length, 1);
  b.discord.post = real;
  b.now += HOUR; // past the longest wait
  await b.bridge.loop();
  assert.deepEqual(heldOf(b), []);
  const after = b.discord.posts.map((p) => p.content).filter((c) => c === NOTE.content || c?.includes('reminder:'));
  assert.equal(after[0], NOTE.content); // the note first, then the reminder that waited behind it
  assert.match(after[1], /reminder: project\/G1 waits/);
});

test('F-T68-1: a held message with no text is refused at load, and the message names the file and the gate', async () => {
  const b = setup();
  add(b, 'T1', 'Which page?');
  await b.post();
  assert.throws(() => withHeld(b, [{ content: '', allowedMentions: { parse: [] } }]), {
    message: `the gate file ${b.statePath} has held messages for project/G1 that the bridge did not write. Nothing was loaded.`,
  });
  assert.throws(() => withHeld(b, [{ content: '   ', allowedMentions: { parse: [] } }]), /held messages for project\/G1/);
});
