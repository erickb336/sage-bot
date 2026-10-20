// T241 (R918 C9, C11): the catch-up at each gateway ready, the heartbeat file, and the card line about buttons while sage-bot is offline.
// SAMPLE DATA ONLY: every id, name and text is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAsk } from '../src/ask.js';
import { alivePathOf, createCatchUp, idAt, loadAlive, offlineLine, OLD, WINDOW } from '../src/catchup.js';
import { card } from '../src/cards.js';
import { openChannels, withHome } from '../src/channels.js';
import { catchUpPort, forMe, rolesOf, routes, watchGateway } from '../src/discord.js';
import { fakeDiscord, fakeGateway, fakeMention } from '../src/fake-discord.js';
import { loadProjects } from '../src/projects.js';
import { LOOP } from '../src/bridge.js';
import { openGate } from '../src/vote.js';
import { CREW, namesOf } from '../src/crew.js';
import { CONFIG, MAYA, OWNER, SAGE, SAM, setup, T0 } from './bridge-setup.js';
import { tempFolder } from './temp-folder.js';
const OFFLINE = 'If a button does not respond, sage-bot is offline. Press it again later.';

const ASK = '400000000000000009'; // a registered channel
const ROLES = { [MAYA]: [CREW], [OWNER]: [], [SAM]: [] }; // the owner counts by the user id, with no role
const AUTHOR_ONLY = { parse: [], repliedUser: true };
const NONE = { parse: [] };
const MIN = 60_000;
const offline = (from, to, n) => `I was offline from <t:${Math.floor(from / 1000)}:f> to <t:${Math.floor(to / 1000)}:f>. I picked up ${n} message${n === 1 ? '' : 's'}.`;

/**
 * The bridge's mention path (src/ask.js) on a fake Discord, with a catch-up whose port reads the fake's history as src/discord.js maps
 * Discord's: each message's `handle` gives it to ask.mention, as on.message does. `b.extra` are more watched places.
 */
function world(t) {
  const b = setup({ markAll: false });
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  b.sh('task', 'add', '--title', 'Board sort', '--size', 'small');
  b.env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  b.config = { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
  b.place = fakeDiscord([]);
  const channels = openChannels(b.config, loadProjects(b.config));
  b.ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, now: () => b.now, log: (l) => b.lines.push(l) });
  b.handled = [];
  b.extra = [];
  b.make = () => createCatchUp({ config: b.config, now: () => b.now, log: (l) => b.lines.push(l),
    places: () => ({ ids: [ASK, ...b.extra], partial: false }), roles: async (user) => ROLES[user] ?? [],
    fetch: async (at, after) => (await b.place.fetchAfter(at, after)).map((m) => ({
      id: m.id, forMe: !m.bot && !m.webhook && m.mentions, user: { id: m.user },
      reply: async (payload) => { b.place.messages.get(m.id).push({ reply: payload }); b.replies.push([m.id, payload]); },
      handle: async () => { b.handled.push(m.id); await b.ask.mention(fakeMention({ id: m.id, user: m.user, roles: m.roles, channelId: at, content: m.content, place: b.place })); } })),
    post: (at, payload) => b.place.post(at, payload) });
  b.replies = [];
  b.catchUp = b.make();
  /** A message of `user` in `place` at `at` that mentions sage-bot, unless `mentions` is false. */
  b.said = (user, content, at, { place = ASK, ...o } = {}) => b.place.said(place, { at, user, roles: ROLES[user], content, ...o });
  /** The posts in `place`, as their content. */
  b.in = (place) => b.place.in(place).map((id) => b.place.latest(id)).filter((m) => !m.reply).map((m) => m.content);
  return b;
}

test('T241: a mention sent while sage-bot was offline is answered once after the ready, and a second ready answers nothing again', async (t) => {
  const b = world(t);
  b.catchUp.beat(); // the last loop turn before the sleep
  const asleep = b.now;
  const id = b.said(MAYA, '<@1> board', T0 + 20 * MIN);
  b.now = T0 + 60 * MIN; // the Mac wakes up
  await b.catchUp.run();
  const [thread] = b.place.threads.keys();
  assert.equal(b.place.threads.get(thread).from, id); // the normal mention path: a thread from the message
  assert.match(b.place.latest(b.place.in(thread)[0]).content, /^\*\*Board · project\*\*/);
  const note = b.place.in(ASK).filter((m) => m !== id).map((m) => b.place.latest(m));
  assert.deepEqual(note, [{ content: offline(asleep, b.now, 1), allowedMentions: NONE }]);
  assert.deepEqual(b.handled, [id]);
  // A second ready, and a ready after a restart (a new catch-up from the same file): nothing is answered or noted again.
  const posts = b.place.posts.length;
  await b.catchUp.run();
  await b.make().run();
  assert.deepEqual([b.handled, b.place.posts.length, b.place.threads.size], [[id], posts, 1]);
});

test('T241: missed mentions older than 24 hours get no answer and one "please ask again" for each person, which pings only that person', async (t) => {
  const b = world(t);
  b.catchUp.beat();
  const old = b.said(MAYA, '<@1> board', T0 + 60 * MIN);
  b.said(MAYA, '<@1> board?', T0 + 61 * MIN);
  b.said(MAYA, '<@1> board!!', T0 + 62 * MIN);
  const ownerOld = b.said(OWNER, '<@1> gates', T0 + 63 * MIN);
  const fresh = b.said(OWNER, '<@1> board', T0 + 30 * 60 * MIN); // 30 h after T0
  b.now = T0 + 31 * 60 * MIN;
  assert.ok(b.now - (T0 + 63 * MIN) > WINDOW && b.now - (T0 + 30 * 60 * MIN) < WINDOW);
  await b.catchUp.run();
  // F-T241-5 and F-T241-3: one OLD for Maya (not 3) and one for the owner, each with repliedUser true and no other ping.
  assert.deepEqual(b.replies, [[old, { content: 'This is old, please ask again.', allowedMentions: AUTHOR_ONLY }],
    [ownerOld, { content: 'This is old, please ask again.', allowedMentions: AUTHOR_ONLY }]]);
  assert.deepEqual(b.handled, [fresh]); // only the fresh one goes to the mention path
  // F-T241-1 and F-T241-2: the line has the date (style f), and counts the answered and the old apart.
  assert.deepEqual(b.in(ASK).filter((c) => c.startsWith('I was offline')),
    [`I was offline from <t:${T0 / 1000}:f> to <t:${b.now / 1000}:f>. I picked up 1 message; 4 were too old.`]);
  await b.catchUp.run();
  assert.equal(b.replies.length, 2);
});

test('T241: the offline line has the date and time, and counts the answered and the old mentions apart', () => {
  // 2026-10-04 22:10 UTC to 2026-10-06 05:10 UTC, 31 h: style f shows the date, so the gap does not read as 7 hours (F-T241-1).
  const [from, to] = [Date.UTC(2026, 9, 4, 22, 10), Date.UTC(2026, 9, 6, 5, 10)];
  const at = '<t:1791151800:f> to <t:1791263400:f>';
  assert.deepEqual([offlineLine(from, to, 1, 0), offlineLine(from, to, 2, 0), offlineLine(from, to, 1, 1), offlineLine(from, to, 3, 2),
    offlineLine(from, to, 0, 1), offlineLine(from, to, 0, 2)], [
    `I was offline from ${at}. I picked up 1 message.`,
    `I was offline from ${at}. I picked up 2 messages.`,
    `I was offline from ${at}. I picked up 1 message; 1 was too old.`,
    `I was offline from ${at}. I picked up 3 messages; 2 were too old.`,
    `I was offline from ${at}. 1 message was too old.`,
    `I was offline from ${at}. 2 messages were too old.`]);
});

test('T241: a mention of someone outside the crew, of a bot or of a webhook, and a message with no mention, are skipped silently', async (t) => {
  const b = world(t);
  b.catchUp.beat();
  b.said(SAM, '<@1> board', T0 + MIN);
  b.said(MAYA, '<@1> board', T0 + 2 * MIN, { bot: true });
  b.said(MAYA, '<@1> board', T0 + 3 * MIN, { webhook: true });
  b.said(MAYA, 'lunch at noon?', T0 + 4 * MIN, { mentions: false });
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  assert.deepEqual([b.handled, b.replies, b.place.posts, b.place.threads.size], [[], [], [], 0]);
  // The crew member's own mention after them is picked up, and the note counts only it.
  const id = b.said(MAYA, '<@1> board', T0 + 11 * MIN);
  b.now = T0 + 12 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled, [id]);
  assert.deepEqual(b.in(ASK).filter((c) => c.startsWith('I was offline')), [offline(T0 + 10 * MIN, b.now, 1)]);
});

test('T241: forMe, the one rule of both paths, takes no bot, no webhook, no other guild and no message without the mention', () => {
  const m = (o = {}) => ({ guildId: CONFIG.guildId, author: { bot: false }, webhookId: null, mentions: { users: new Map([['1', {}]]) }, ...o });
  assert.deepEqual([m(), m({ author: { bot: true } }), m({ webhookId: '700000000000000001' }), m({ guildId: '500000000000000002' }),
    m({ mentions: { users: new Map() } })].map((x) => forMe(x, CONFIG.guildId, '1')), [true, false, false, false, false]);
  // The live route uses it: a webhook's mention gets nothing.
  const asked = [];
  const on = routes({ config: CONFIG, ask: { mention: (x) => { asked.push(x.id); } }, botId: '1', fetch: async () => null });
  on.message({ ...m({ webhookId: '700000000000000001' }), id: '800000000000000001', author: { id: MAYA, bot: false }, channelId: ASK });
  on.message({ ...m(), id: '800000000000000002', author: { id: MAYA, bot: false }, channelId: ASK });
  assert.deepEqual(asked, ['800000000000000002']);
});

/** A catch-up on a fake Discord whose `handle` only records, for the cases that need no sage logbook. */
function light(t, places = [ASK]) {
  const statePath = join(tempFolder('sage-bot-t241-'), 'state', 'gates.json');
  const b = { now: T0, place: fakeDiscord([]), handled: [], lines: [], statePath, places, partial: false, replies: [], roles: { ...ROLES } };
  b.make = () => createCatchUp({ config: { ...CONFIG, statePath }, now: () => b.now, log: (l) => b.lines.push(l),
    places: () => ({ ids: b.places, partial: b.partial }), roles: async (user) => { if (b.rolesDown) throw new Error('Discord is down'); return user in b.roles ? b.roles[user] : null; },
    fetch: async (at, after) => (await b.place.fetchAfter(at, after)).map((m) => ({ id: m.id, forMe: m.mentions, user: { id: m.user },
      reply: async (payload) => { b.replies.push([m.id, payload]); }, handle: async () => { b.handled.push(m.id); } })),
    post: (at, payload) => b.place.post(at, payload) });
  b.catchUp = b.make();
  b.notes = (at) => b.place.in(at).map((id) => b.place.latest(id).content).filter((c) => c?.startsWith('I was offline'));
  return b;
}

test('T241: 250 missed messages are read in pages of 100, after the last id of each page, and each mention is handled once, in order', async (t) => {
  const b = light(t);
  b.catchUp.beat();
  const mentions = [];
  for (let i = 0; i < 250; i++) {
    const id = b.place.said(ASK, { at: T0 + (i + 1) * 1000, user: MAYA, roles: [CREW], mentions: i % 5 === 0 });
    if (i % 5 === 0) mentions.push(id);
  }
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled, mentions); // 50, oldest first
  const ids = b.place.in(ASK);
  assert.deepEqual(b.place.reads, [[ASK, idAt(T0)], [ASK, ids[99]], [ASK, ids[199]]]);
  assert.deepEqual(b.notes(ASK), [offline(T0, b.now, 50)]);
  // The mark is the last message: the next run reads after it and finds nothing.
  assert.deepEqual(loadAlive(alivePathOf(b)).seen.get(ASK), ids[249]);
  await b.catchUp.run();
  assert.deepEqual([b.handled.length, b.place.reads.at(-1)], [50, [ASK, ids[249]]]);
});

test('T241: the offline line posts once in each place where something was picked up, with that place\'s count, and nowhere else', async (t) => {
  const [THREAD, QUIET_THREAD] = ['600000000000000001', '600000000000000002'];
  const b = light(t, [ASK, THREAD, QUIET_THREAD]);
  b.catchUp.beat();
  for (const [at, n] of [[ASK, 2], [THREAD, 1]]) for (let i = 0; i < n; i++) b.place.said(at, { at: T0 + (i + 1) * MIN, user: OWNER, mentions: true });
  b.place.said(QUIET_THREAD, { at: T0 + MIN, user: MAYA, roles: [CREW], mentions: false });
  b.now = T0 + 2 * 60 * MIN;
  await b.catchUp.run();
  assert.deepEqual([b.notes(ASK), b.notes(THREAD), b.notes(QUIET_THREAD)], [[offline(T0, b.now, 2)], [offline(T0, b.now, 1)], []]);
  assert.equal(b.place.posts.length, 2);
  // A short gap with nothing missed: no line at all.
  b.catchUp.beat();
  b.now += LOOP;
  await b.catchUp.run();
  assert.equal(b.place.posts.length, 2);
});

test('T241: the heartbeat file is 0600, written whole at each loop turn, with the time; a symlink or a strange file stops the start', (t) => {
  const b = light(t);
  b.catchUp.beat();
  const path = alivePathOf(b);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, at: T0, seen: {}, taken: {} });
  b.now += LOOP;
  b.catchUp.beat();
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).at, T0 + LOOP);
  writeFileSync(path, '{"version":1,"at":1,"seen":{"x":"1"}}', { mode: 0o600 });
  assert.throws(() => b.make(), /is not a version 1 catch-up file/);
  rmSync(path);
  symlinkSync(join(b.statePath, '..', 'other'), path);
  assert.throws(() => b.make(), /must be a regular file of this user with mode 0600/);
});

test('T241: a gateway resume, with no restart, runs the catch-up; so does a new session; a drop starts the gap at the last turn', async (t) => {
  const b = light(t);
  const gateway = fakeGateway();
  let turns = 0;
  watchGateway(gateway, { ready: () => { b.ran = b.catchUp.run(); turns++; }, down: () => b.catchUp.down() });
  b.catchUp.beat();
  b.now += LOOP;
  b.catchUp.beat(); // the loop runs on while the network is gone (the Mac is awake)
  const lastTurn = b.now;
  gateway.drop();
  b.now += 5 * LOOP;
  b.catchUp.beat();
  const one = b.place.said(ASK, { at: b.now - LOOP, user: OWNER, mentions: true });
  b.now += MIN;
  gateway.resume();
  await b.ran;
  assert.deepEqual([b.handled, turns, b.notes(ASK)], [[one], 1, [offline(lastTurn, b.now, 1)]]);
  // A sleep: no turn and no event for an hour, then the first turn and a new session.
  const asleep = b.now;
  b.catchUp.beat();
  const two = b.place.said(ASK, { at: b.now + 30 * MIN, user: OWNER, mentions: true });
  b.now += 60 * MIN;
  b.catchUp.beat(); // the loop wakes first; it keeps the start of the gap
  gateway.ready();
  await b.ran;
  assert.deepEqual([b.handled, turns, b.notes(ASK).at(-1)], [[one, two], 2, offline(asleep, b.now, 1)]);
});

test('T241: a message that the gateway brings during a catch-up is handled once, and the mark never passes a message the run has still to read', async (t) => {
  const b = light(t);
  b.catchUp.beat();
  const missed = b.place.said(ASK, { at: T0 + MIN, user: OWNER, mentions: true });
  b.now = T0 + 10 * MIN;
  const run = b.catchUp.run();
  // The gateway brings a new message before the run reads, and replays the missed one: each is handled once.
  const live = b.place.said(ASK, { at: b.now, user: OWNER, mentions: true });
  await b.catchUp.live(ASK, live, async () => { b.handled.push(live); });
  await run;
  await b.catchUp.live(ASK, missed, async () => { b.handled.push(`again ${missed}`); });
  assert.deepEqual(b.handled, [live, missed]);
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), live);
  // Out of a run, a live message moves the mark at once, so the next run starts after it.
  const later = b.place.said(ASK, { at: b.now + MIN, user: OWNER, mentions: true });
  await b.catchUp.live(ASK, later, async () => { b.handled.push(later); });
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), later);
  await b.catchUp.run();
  assert.deepEqual(b.handled, [live, missed, later]);
  // From a drop of the gateway to the next run, a message that comes (before the ready) does not move the mark past the missed ones.
  b.catchUp.down();
  const lost = b.place.said(ASK, { at: b.now + 2 * MIN, user: OWNER, mentions: true });
  const early = b.place.said(ASK, { at: b.now + 3 * MIN, user: OWNER, mentions: true });
  await b.catchUp.live(ASK, early, async () => { b.handled.push(early); });
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), later);
  b.now += 4 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled.slice(3), [early, lost]);
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), early);
});

test('T241: a place with no mark takes nothing older than the gap; a place that Discord refuses is logged once and the others go on', async (t) => {
  const THREAD = '600000000000000001';
  const b = light(t, [ASK, THREAD]);
  b.place.said(ASK, { at: T0 - MIN, user: OWNER, mentions: true }); // before the last turn: not missed
  b.catchUp.beat();
  const after = b.place.said(ASK, { at: T0 + MIN, user: OWNER, mentions: true });
  b.place.refuseHistory(THREAD, 50013);
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  await b.catchUp.run();
  assert.deepEqual(b.handled, [after]);
  assert.deepEqual(b.lines.filter((l) => l.includes(THREAD)).length, 1);
  assert.match(b.lines[0], /could not read the messages of 600000000000000001: sage-bot needs View Channel and Read Message History there: code 50013/);
  // The first run ever (no heartbeat file): it takes nothing from before the start.
  const c = light(t);
  c.place.said(ASK, { at: T0 - MIN, user: OWNER, mentions: true });
  await c.catchUp.run();
  assert.deepEqual(c.handled, []);
});

test('T241 F-T241-7: a run with nothing new in a place reads it once and logs nothing', async (t) => {
  const b = light(t);
  b.catchUp.beat();
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  assert.deepEqual([b.place.reads, b.lines, b.handled], [[[ASK, idAt(T0)]], [], []]);
  // The same with one page that is not full: one read, and nothing logged.
  const id = b.place.said(ASK, { at: b.now + MIN, user: OWNER, mentions: true });
  b.now += 2 * MIN;
  await b.catchUp.run();
  assert.deepEqual([b.place.reads.length, b.lines, b.handled], [2, [], [id]]);
});

test('T241 F-T241-6: a place whose read failed keeps its missed mention: no live message and no end of a run moves its mark past it', async (t) => {
  const b = light(t);
  b.catchUp.beat();
  b.catchUp.down();
  const missed = b.place.said(ASK, { at: T0 + MIN, user: OWNER, mentions: true });
  b.place.refuseHistory(ASK, 0); // a network error just after the wake
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled, []);
  b.place.refuseHistory(ASK, null);
  const chat = b.place.said(ASK, { at: b.now, user: MAYA, roles: [CREW], mentions: false }); // any message, after the run
  await b.catchUp.live(ASK, chat, async () => {});
  b.now += MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled, [missed]);
  assert.equal(loadAlive(alivePathOf(b)).seen.get(ASK), chat);
});

test('T241 F-T241-6: after a run fails part way, the places that it did not read keep their missed mentions', async (t) => {
  const THREAD = '600000000000000001';
  const b = light(t, [ASK, THREAD]);
  b.catchUp.beat();
  b.place.said(ASK, { at: T0 + MIN, user: OWNER, mentions: true });
  const missed = b.place.said(THREAD, { at: T0 + 2 * MIN, user: MAYA, mentions: true });
  b.rolesDown = true; // Discord fails to give the roles: no place is read to its end (F-T241-10: each place waits on its own)
  b.now = T0 + 10 * MIN;
  await b.catchUp.run();
  assert.match(b.lines.join('\n'), /could not read the roles of a member in 600000000000000001; it tries again in 3 minutes: .*Discord is down/);
  const chat = b.place.said(THREAD, { at: b.now, user: MAYA, mentions: false });
  await b.catchUp.live(THREAD, chat, async () => {});
  b.rolesDown = false;
  b.now += MIN;
  await b.catchUp.run();
  assert.ok(b.handled.includes(missed));
});

test('T241 F-T241-8: while the open request threads cannot be known, their marks stay and wait; the next full run reads their gap', async (t) => {
  const REQ = '600000000000000003';
  const b = light(t, [ASK, REQ]);
  b.catchUp.beat();
  const first = b.place.said(REQ, { at: T0 + MIN, user: MAYA, mentions: false });
  await b.catchUp.live(REQ, first, async () => {});
  b.now = T0 + 2 * MIN;
  await b.catchUp.run();
  assert.equal(loadAlive(alivePathOf(b)).seen.get(REQ), first);
  // The request file cannot be read: the places do not include REQ, and say that they are partial.
  b.catchUp.down();
  const missed = b.place.said(REQ, { at: b.now + MIN, user: OWNER, mentions: true });
  [b.places, b.partial] = [[ASK], true];
  b.now += 5 * MIN;
  await b.catchUp.run();
  const chat = b.place.said(REQ, { at: b.now, user: MAYA, mentions: false });
  await b.catchUp.live(REQ, chat, async () => {});
  assert.equal(loadAlive(alivePathOf(b)).seen.get(REQ), first); // kept, and not moved past the missed mention
  [b.places, b.partial] = [[ASK, REQ], false];
  b.now += MIN;
  await b.catchUp.run();
  assert.deepEqual(b.handled, [missed]);
  assert.equal(loadAlive(alivePathOf(b)).seen.get(REQ), chat);
});

/**
 * A guild as discord.js gives it to catchUpPort: `members.fetch` with force reads Discord (`now`) and puts the member in the cache;
 * `cache` holds the members as the gateway left them before a sleep. Messages resolve `member` from the cache, as Message.member does.
 */
function guildOf(cache, now) {
  const roles = new Map([['r1', { id: 'r1', name: CREW }], ['r2', { id: 'r2', name: 'other' }]]);
  const member = (id, ids) => ({ id, roles: { cache: new Map(ids.map((r) => [r, roles.get(r)])) } });
  const guild = { id: CONFIG.guildId, roles: { cache: roles }, fetched: [],
    members: { cache: new Map(Object.entries(cache).map(([id, ids]) => [id, member(id, ids)])),
      fetch: async ({ user, force }) => {
        guild.fetched.push([user, force]);
        if (!(user in now)) throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
        guild.members.cache.set(user, member(user, now[user]));
        return guild.members.cache.get(user);
      } } };
  return guild;
}

test('T241 F-T241-4: the catch-up reads each author\'s roles fresh from Discord, once in a run: the crew of now counts, not the crew before the sleep', async (t) => {
  const [GONE, NEW, LEFT] = ['300000000000000101', '300000000000000102', '300000000000000103'];
  // Before the sleep: GONE and LEFT were crew, NEW was not. During it: GONE lost the role, NEW got it, LEFT left the server.
  const guild = guildOf({ [GONE]: ['r1'], [NEW]: ['r2'], [LEFT]: ['r1'] }, { [GONE]: ['r2'], [NEW]: ['r1', 'r2'] });
  const fake = fakeDiscord([]);
  const said = [];
  const message = (m) => ({ id: m.id, guildId: CONFIG.guildId, author: { id: m.user, bot: false }, webhookId: null,
    mentions: { users: new Map(m.mentions ? [['1', {}]] : []) }, get member() { return guild.members.cache.get(m.user); } });
  const place = async (at) => ({ messages: { fetch: async ({ after }) => new Map((await fake.fetchAfter(at, after)).map((m) => [m.id, message(m)])) },
    send: (payload) => fake.post(at, payload) });
  const handled = [];
  const on = { message: (m) => { handled.push([m.id, rolesOf(m.member, guild.roles.cache)]); } };
  const statePath = join(tempFolder('sage-bot-t241-'), 'state', 'gates.json');
  let now = T0;
  const lines = [];
  const catchUp = createCatchUp({ config: { ...CONFIG, statePath }, now: () => now, log: (l) => lines.push(l),
    places: () => ({ ids: [ASK], partial: false }), ...catchUpPort({ guild, place, botId: '1', on }) });
  catchUp.beat();
  const ids = [GONE, NEW, LEFT, NEW, GONE].map((user, i) => fake.said(ASK, { at: T0 + (i + 1) * MIN, user, mentions: true }));
  now = T0 + 10 * MIN;
  await catchUp.run();
  // Only NEW's two mentions, and the mention path reads the same fresh roles; GONE and LEFT get nothing, with no word.
  assert.deepEqual(handled, [[ids[1], [CREW, 'other']], [ids[3], [CREW, 'other']]]);
  assert.deepEqual(guild.fetched, [[GONE, true], [NEW, true], [LEFT, true]]);
  assert.deepEqual([fake.in(ASK).map((id) => fake.latest(id).content).filter((c) => c?.startsWith('I was offline')).length, lines], [1, []]);
});

// The open request card says it too: its footer test is in test/t227-request-cards.test.js.
test('T241 C11: an open single card and a batch that waits say that a button may not respond while sage-bot is offline; a closed card does not', () => {
  const people = { holders: new Set([MAYA]), names: new Map(), us: namesOf({}) };
  const part = { question: 'Which?', why: 'w', recommended: 'A', options: { A: 'a', B: 'b' } };
  const single = openGate({ id: 'p/G1', kind: 'single', options: ['A', 'B'], askedBy: OWNER, at: T0 });
  assert.equal(card(single, { task: 'T1', title: 't', parts: [part] }, people).embeds[0].footer.text, OFFLINE);
  const answered = { ...single, phase: 'closed', outcome: { status: 'answered', option: 'A', by: MAYA } };
  assert.equal(card(answered, { task: 'T1', title: 't', parts: [part] }, people).embeds[0].footer, undefined); // no buttons to press
  const batch = openGate({ id: 'p/G1+G2', kind: 'batch', parts: [['A', 'B'], ['A', 'B']], askedBy: OWNER, at: T0 });
  assert.ok(card(batch, { task: 'T1', title: 't', parts: [part, part] }, people).embeds[0].footer.text.endsWith(` · ${OFFLINE}`));
});
