// T243: the catch-up after a sleep or a restart, made reliable (the low findings F-T241-9 to F-T241-13 of the PR 66 review).
// SAMPLE DATA ONLY: every id, name and text is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alivePathOf, createCatchUp, idAt, loadAlive, WINDOW } from '../src/catchup.js';
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

/** A catch-up on a fake Discord whose `handle` only records. `b.threads` are the thread map's threads; `b.rolesDown` the users whose roles fail. */
function light(places = [ASK]) {
  const statePath = join(tempFolder('sage-bot-t243-'), 'state', 'gates.json');
  const b = { now: T0, place: fakeDiscord([]), handled: [], lines: [], statePath, places, threads: [], rolesDown: new Set() };
  b.make = () => createCatchUp({ config: { ...CONFIG, statePath }, now: () => b.now, log: (l) => b.lines.push(l),
    places: () => { if (b.placesDown) throw new Error('no places'); return { ids: b.places, threads: b.threads, partial: false }; },
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
  await b.catchUp.live(ASK, live, async () => { b.handled.push(live); });
  // The process restarts before the next run: a new catch-up from the same file.
  b.now += 5 * MIN;
  const again = b.make();
  await again.run();
  assert.deepEqual(b.handled, [live]);
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), live);
  assert.deepEqual([...loadAlive(alivePathOf(b)).taken], []); // the run's end takes it off the list
  // A file of before T243, with no list of handled messages, loads with an empty one.
  writeFileSync(alivePathOf(b), `{"version":1,"at":${T0},"seen":{"${ASK}":"${live}"}}`, { mode: 0o600 });
  assert.deepEqual(loadAlive(alivePathOf(b)), { at: T0, seen: new Map([[ASK, live]]), taken: new Map() });
});

test('T243 F-T241-12: the catch-up reads the channels, the open threads and only the threads of the map that were active in the 24 hours', async () => {
  const OLD_T = idAt(T0 - WINDOW - 60 * MIN); // made 25 hours before the gap, quiet since
  const NEW_T = idAt(T0 - 60 * MIN); // made an hour before the gap
  const TALK_T = idAt(T0 - 5 * WINDOW); // made 5 days before, with a message just before the gap
  const b = light([ASK, THREAD]);
  b.threads = [OLD_T, NEW_T, TALK_T, THREAD];
  b.catchUp.beat();
  b.now = T0 + MIN;
  await b.catchUp.run();
  assert.deepEqual(b.read(), new Set([ASK, THREAD, NEW_T]));
  const chat = b.place.said(TALK_T, { at: b.now, user: MAYA, mentions: false });
  await b.catchUp.live(TALK_T, chat, async () => {});
  b.catchUp.beat();
  b.catchUp.down();
  const ids = [OLD_T, NEW_T, TALK_T].map((at) => b.place.said(at, { at: b.now + MIN, user: OWNER }));
  b.place.reads.length = 0;
  b.now += 60 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.read(), new Set([ASK, THREAD, NEW_T, TALK_T]));
  assert.deepEqual(new Set(b.handled), new Set(ids.slice(1)));
  assert.equal(loadAlive(alivePathOf(b)).seen.has(OLD_T), false); // a quiet thread keeps no mark
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
