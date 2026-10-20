// T243: the catch-up after a sleep or a restart, made reliable (the low findings F-T241-9 to F-T241-13 of the PR 66 review).
// SAMPLE DATA ONLY: every id, name and text is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alivePathOf, createCatchUp, idAt, loadAlive, OLD, WINDOW } from '../src/catchup.js';
import { liveOf } from '../src/discord.js';
import { fakeDiscord } from '../src/fake-discord.js';
import { LOOP } from '../src/bridge.js';
import { CREW } from '../src/crew.js';
import { CONFIG, MAYA, OWNER, T0 } from './bridge-setup.js';
import { tempFolder } from './temp-folder.js';

const ASK = '400000000000000009'; // a registered channel
const THREAD = '600000000000000001'; // an open request thread: always read
const MIN = 60_000;
const RETRY = 3 * MIN; // a place that a run could not read is read again at the first loop turn this long after that run
const offline = (from, to, n) => `I was offline from <t:${Math.floor(from / 1000)}:f> to <t:${Math.floor(to / 1000)}:f>. I picked up ${n} message${n === 1 ? '' : 's'}.`;

/**
 * A catch-up on a fake Discord whose `handle` only records. `b.threads` are the thread map's threads, each with its newest message as its
 * last message, as the gateway gives it at a ready; `b.rolesDown` the users whose roles fail.
 */
function light(places = [ASK]) {
  const statePath = join(tempFolder('sage-bot-t243-'), 'state', 'gates.json');
  const b = { now: T0, place: fakeDiscord([]), handled: [], lines: [], statePath, places, threads: [], rolesDown: new Set() };
  const last = (id) => b.place.in(id).reduce((a, m) => (a === null || BigInt(m) > BigInt(a) ? m : a), null);
  b.make = () => createCatchUp({ config: { ...CONFIG, statePath }, now: () => b.now, log: (l) => b.lines.push(l),
    places: () => {
      if (b.placesDown) throw new Error('no places');
      if (b.partial) return { ids: b.places.filter((id) => id !== THREAD), threads: [], partial: true }; // the request file cannot be read
      return { ids: b.places, threads: b.threads.map((id) => ({ id, last: last(id) })), partial: false };
    },
    roles: async (user) => { if (b.rolesDown.has(user)) throw new Error('Discord is down'); return user === MAYA ? [CREW] : []; },
    fetch: async (at, after) => (await b.place.fetchAfter(at, after)).map((m) => ({ id: m.id, forMe: m.mentions, user: { id: m.user },
      reply: async () => {}, handle: async () => { b.handled.push(m.id); } })),
    post: (at, payload) => b.place.post(at, payload) });
  b.catchUp = b.make();
  b.notes = (at) => b.place.in(at).map((id) => b.place.latest(id).content).filter((c) => c?.startsWith('I was offline'));
  b.read = () => new Set(b.place.reads.map(([at]) => at));
  return b;
}

test('T243 F-T241-9: a place whose read failed is read again at a loop turn after RETRY, not hours later at the next ready', async () => {
  const b = light();
  b.catchUp.beat();
  const missed = b.place.said(ASK, { at: T0 + MIN, user: OWNER });
  b.place.refuseHistory(ASK, 0); // a network error just after the wake
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  const reads = b.place.reads.length;
  b.place.refuseHistory(ASK, null);
  b.now += RETRY - LOOP;
  await b.catchUp.beat(); // too soon: no read
  assert.deepEqual([b.place.reads.length, b.handled], [reads, []]);
  b.now += LOOP;
  await b.catchUp.beat();
  assert.deepEqual(b.handled, [missed]);
  assert.deepEqual(b.notes(ASK), [offline(T0, T0 + 10 * MIN + RETRY, 1)]); // the gap starts where it started, not at the last turn
  // Nothing is left unread: later turns read nothing.
  const after = b.place.reads.length;
  b.now += 2 * RETRY;
  await b.catchUp.beat();
  assert.equal(b.place.reads.length, after);
});

test('T243 F-T241-9: a run that fails as a whole says when it tries again, and does so at that loop turn', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  b.catchUp.down();
  const missed = b.place.said(ASK, { at: b.now + MIN, user: OWNER });
  b.placesDown = true;
  b.now += 10 * MIN;
  await b.catchUp.run();
  assert.deepEqual([b.lines, b.handled], [['the catch-up failed; it tries again in 3 minutes: no places'], []]);
  b.placesDown = false;
  b.now += RETRY;
  await b.catchUp.beat();
  assert.deepEqual(b.handled, [missed]);
});

test('T243 F-T241-10: a failed role read stops only its own place; the other places are caught up in the same run', async () => {
  const b = light([ASK, THREAD]);
  b.catchUp.beat();
  const first = b.place.said(ASK, { at: T0 + MIN, user: MAYA });
  const other = b.place.said(THREAD, { at: T0 + 2 * MIN, user: OWNER });
  b.rolesDown.add(MAYA);
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled, [other]);
  assert.deepEqual(b.lines, [`the catch-up could not read the roles of a member in ${ASK}; it tries again in 3 minutes: code -, status -: Discord is down`]);
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), idAt(T0)); // its mark waits
  b.rolesDown.clear();
  b.now += RETRY;
  await b.catchUp.beat();
  assert.deepEqual(b.handled, [other, first]);
});

test('T243 F-T241-11: a mention handled live while its mark waits is not answered again after a restart', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  b.catchUp.down(); // the gateway drops: the marks wait for the next run
  const live = b.place.said(ASK, { at: b.now + MIN, user: OWNER });
  await b.catchUp.live(ASK, live, true, async () => { b.handled.push(live); });
  // The process restarts before the next run: a new catch-up from the same file.
  b.now += 5 * MIN;
  const again = b.make();
  await again.run();
  assert.deepEqual(b.handled, [live]);
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), live);
  assert.deepEqual([...loadAlive(alivePathOf(b)).taken], []); // the run's end takes it off the list
  // A file of before T243, with no list of handled messages, loads with an empty one.
  writeFileSync(alivePathOf(b), `{"version":1,"at":${T0},"seen":{"${ASK}":"${live}"}}`, { mode: 0o600 });
  assert.deepEqual(loadAlive(alivePathOf(b)), { at: T0, seen: new Map([[ASK, live]]), taken: new Map(), taking: new Map() });
});

test('T243 F-T241-12: the catch-up reads the channels, the open threads, the threads of the map active in the 24 hours, and a quiet thread with a mention in the gap', async () => {
  const OLD_T = idAt(T0 - WINDOW - 60 * MIN); // made 25 hours before the gap, quiet until a mention in the gap
  const QUIET_T = idAt(T0 - 2 * WINDOW); // made 2 days before the gap, quiet since
  const NEW_T = idAt(T0 - 60 * MIN); // made an hour before the gap
  const TALK_T = idAt(T0 - 5 * WINDOW); // made 5 days before, with a message just before the gap
  const b = light([ASK, THREAD]);
  b.threads = [OLD_T, QUIET_T, NEW_T, TALK_T, THREAD];
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  assert.deepEqual(b.read(), new Set([ASK, THREAD, NEW_T]));
  assert.equal(loadAlive(alivePathOf(b)).seen.has(OLD_T), false); // a quiet thread keeps no mark
  const chat = b.place.said(TALK_T, { at: b.now, user: MAYA, mentions: false });
  await b.catchUp.live(TALK_T, chat, false, async () => {});
  b.catchUp.beat();
  b.catchUp.down();
  const ids = [OLD_T, NEW_T, TALK_T].map((at) => b.place.said(at, { at: b.now + MIN, user: OWNER }));
  b.place.reads.length = 0;
  b.now += 60 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.read(), new Set([ASK, THREAD, OLD_T, NEW_T, TALK_T])); // never the quiet thread with nothing new
  assert.deepEqual(new Set(b.handled), new Set(ids));
  assert.deepEqual(b.notes(OLD_T), [offline(T0 + MIN, b.now, 1)]);
});

test('T243 repair R2: a mention whose handling a crash cut off gets "please ask again" once after the restart, and no second answer', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  const cut = b.place.said(ASK, { at: b.now, user: OWNER });
  b.catchUp.live(ASK, cut, true, () => new Promise(() => {})); // the process dies during the handling
  // The process restarts: a new catch-up from the same file, and a ready.
  b.now += MIN;
  const again = b.make();
  await again.run();
  const old = b.place.posts.filter((p) => p.content === 'This is old, please ask again.');
  assert.deepEqual(old, [{ content: 'This is old, please ask again.', reply: { messageReference: cut }, allowedMentions: { parse: [], repliedUser: true } }]);
  assert.deepEqual(b.handled, []);
  // A second restart says nothing again.
  b.now += MIN;
  await b.make().run();
  assert.equal(b.place.posts.filter((p) => p.content === 'This is old, please ask again.').length, 1);
  assert.deepEqual([...loadAlive(alivePathOf(b)).taking], []);
  // A file of T243 before the repair, with no `taking` list, still loads.
  writeFileSync(alivePathOf(b), `{"version":1,"at":${T0},"seen":{"${ASK}":"${cut}"},"taken":{"${cut}":"${ASK}"}}`, { mode: 0o600 });
  assert.deepEqual(loadAlive(alivePathOf(b)), { at: T0, seen: new Map([[ASK, cut]]), taken: new Map([[cut, ASK]]), taking: new Map() });
});

test('T243 repair R3: while a mark waits, only the mentions of sage-bot go on the list in the file, so it grows only with real mentions', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  b.catchUp.down(); // the marks wait for the next run
  for (let i = 1; i <= 50; i++) {
    const chat = b.place.said(ASK, { at: b.now + i * 1000, user: MAYA, mentions: false });
    await b.catchUp.live(ASK, chat, false, async () => {});
  }
  const mention = b.place.said(ASK, { at: b.now + 60_000, user: OWNER });
  await b.catchUp.live(ASK, mention, true, async () => { b.handled.push(mention); });
  assert.deepEqual([...loadAlive(alivePathOf(b)).taken], [[mention, ASK]]);
  b.now += 2 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled, [mention]); // the run does not answer it again
  assert.deepEqual([...loadAlive(alivePathOf(b)).taken], []);
});

test('T243 repair Q1: a catch-up file that holds null gets the normal "Delete it" refusal, not a crash', () => {
  const path = join(tempFolder('sage-bot-t243-'), 'gates.json.alive');
  writeFileSync(path, 'null\n', { mode: 0o600 });
  assert.throws(() => loadAlive(path), { name: 'TypeError', message: `the catch-up file ${path} is not a version 1 catch-up file that the bridge wrote. Delete it: the next catch-up then starts from now. Nothing was loaded.` });
});

test('T243 F-T241-13: a short pause that no drop follows is forgotten; a later drop starts its gap at the last turn', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  b.now += 45_000; // a pause of 45 s: more than 2 loop turns, and the gateway stays up
  b.catchUp.beat();
  for (let i = 0; i < 40; i++) { b.now += LOOP; b.catchUp.beat(); } // 10 minutes of normal turns
  b.now += LOOP;
  const lastTurn = b.now - LOOP;
  b.catchUp.down();
  const id = b.place.said(ASK, { at: b.now, user: OWNER });
  b.now += MIN;
  await b.catchUp.run();
  assert.deepEqual([b.handled, b.notes(ASK)], [[id], [offline(lastTurn, b.now, 1)]]);
});

test('T243 F-T241-13: a pause that a drop follows soon keeps its start, as after a sleep', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  b.catchUp.beat();
  const asleep = b.now;
  const id = b.place.said(ASK, { at: b.now + 10 * MIN, user: OWNER });
  b.now += 60 * MIN;
  b.catchUp.beat(); // the loop wakes first
  for (let i = 0; i < 3; i++) { b.now += LOOP; b.catchUp.beat(); }
  b.catchUp.down(); // discord.js sees the dead socket 45 s after the wake
  b.now += MIN;
  await b.catchUp.run();
  assert.deepEqual([b.handled, b.notes(ASK)], [[id], [offline(asleep, b.now, 1)]]);
});

test('T243 repair 2 S2: a mention of a member who is not crew stays silent, also when a crash cut its handling off', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  const guildRoles = new Map([['r1', { id: 'r1', name: CREW }]]);
  const message = (id, user, roleIds) => ({ id, guildId: CONFIG.guildId, channelId: ASK, author: { id: user, bot: false }, webhookId: null,
    mentions: { users: new Map([['1', {}]]) }, member: { roles: { cache: new Map(roleIds.map((r) => [r, guildRoles.get(r)])) } } });
  const STRANGER = '300000000000000201';
  const stranger = b.place.said(ASK, { at: b.now, user: STRANGER });
  const crew = b.place.said(ASK, { at: b.now + 1000, user: MAYA });
  // The process dies during each handling.
  const live = liveOf({ config: CONFIG, botId: '1', guildRoles, catchUp: b.catchUp, on: { message: () => new Promise(() => {}) } });
  live(message(stranger, STRANGER, []));
  live(message(crew, MAYA, ['r1']));
  b.now += MIN;
  await b.make().run();
  assert.deepEqual(b.place.posts.filter((p) => p.content === OLD).map((p) => p.reply.messageReference), [crew]);
  assert.deepEqual(b.handled, []);
});

test('T243 repair 2 S1: after a crash, only a cut mention of a watched place gets "please ask again"; a mention of any other place gets nothing', async () => {
  const OTHER = '400000000000000077'; // a channel that the bridge does not watch
  const b = light([ASK, THREAD]);
  b.threads = [THREAD];
  b.catchUp.beat();
  const inAsk = b.place.said(ASK, { at: T0, user: OWNER });
  const inThread = b.place.said(THREAD, { at: T0 + 1000, user: OWNER });
  const elsewhere = b.place.said(OTHER, { at: T0 + 2000, user: OWNER });
  writeFileSync(alivePathOf(b), `${JSON.stringify({ version: 1, at: T0, seen: {}, taken: {}, taking: { [inAsk]: ASK, [inThread]: THREAD, [elsewhere]: OTHER } })}\n`, { mode: 0o600 });
  b.now = T0 + MIN;
  const next = b.make();
  await next.run();
  assert.deepEqual(b.place.posts.filter((p) => p.content === OLD).map((p) => p.reply.messageReference), [inAsk, inThread]);
  assert.deepEqual([...loadAlive(alivePathOf(b)).taking], []);
  await next.live(OTHER, elsewhere, true, async () => { b.handled.push(elsewhere); }); // no reply, and never an answer (C5)
  assert.deepEqual(b.handled, []);
});

test('T243 repair 2 C5: a cut mention of an open request thread, at a start that cannot read the request file, gets no reply and no second answer', async () => {
  const b = light([ASK, THREAD]);
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run(); // both places have a mark
  const inThread = b.place.said(THREAD, { at: b.now + 1000, user: MAYA });
  const inAsk = b.place.said(ASK, { at: b.now + 2000, user: MAYA }); // the control: a watched place at the start
  b.now += 3000;
  // The process dies during both answers.
  b.catchUp.live(THREAD, inThread, true, () => new Promise(() => {}));
  b.catchUp.live(ASK, inAsk, true, () => new Promise(() => {}));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...loadAlive(alivePathOf(b)).taking.keys()], [inThread, inAsk]);
  b.partial = true; // the start cannot read the request file, so the open request thread is not one of the places
  b.now += MIN;
  const next = b.make();
  await next.run();
  b.partial = false; // the request file is readable again
  b.now += RETRY + MIN;
  await next.beat();
  await next.run();
  await b.make().run(); // and one more restart
  // The rule: a cut mention gets OLD only when its place is watched at the start; else it gets nothing. Never a second answer.
  assert.deepEqual(b.place.posts.filter((p) => p.content === OLD).map((p) => p.reply.messageReference), [inAsk]);
  assert.deepEqual(b.handled, []);
  assert.deepEqual(b.notes(THREAD), []);
});

test('T243 repair 2 S1: each list of the file holds at most 100 mentions, the oldest go first, and a file with more gets the "Delete it" refusal', async () => {
  const b = light();
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  b.catchUp.down(); // the marks wait, so each mention handled live stays on `taken`
  const ids = [];
  for (let i = 1; i <= 101; i++) {
    const id = b.place.said(ASK, { at: b.now + i * 1000, user: OWNER });
    ids.push(id);
    await b.catchUp.live(ASK, id, true, async () => {});
  }
  assert.deepEqual([...loadAlive(alivePathOf(b)).taken.keys()], ids.slice(1));
  const file = (taking) => `${JSON.stringify({ version: 1, at: T0, seen: {}, taken: {}, taking: Object.fromEntries(taking.map((id) => [id, ASK])) })}\n`;
  writeFileSync(alivePathOf(b), file(ids.slice(1)), { mode: 0o600 });
  assert.equal(loadAlive(alivePathOf(b)).taking.size, 100);
  writeFileSync(alivePathOf(b), file(ids), { mode: 0o600 });
  assert.throws(() => loadAlive(alivePathOf(b)), { name: 'TypeError', message: `the catch-up file ${alivePathOf(b)} is not a version 1 catch-up file that the bridge wrote. Delete it: the next catch-up then starts from now. Nothing was loaded.` });
  const taken = `${JSON.stringify({ version: 1, at: T0, seen: {}, taken: Object.fromEntries(ids.map((id) => [id, ASK])) })}\n`;
  writeFileSync(alivePathOf(b), taken, { mode: 0o600 });
  assert.throws(() => loadAlive(alivePathOf(b)), { name: 'TypeError' });
});
