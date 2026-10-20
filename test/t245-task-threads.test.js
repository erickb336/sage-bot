// T245 (issue 60 PR 5 and 6): task threads. After the owner approves a request, its thread becomes the thread of its sage task (thread map
// version 2, kind 'task'), and the bridge posts the design questions of that task there as votes of 10 minutes (the stored `limit` of a
// gate, F2 of R917). The crew votes, the votes decide at the limit, and a tie waits for the owner. Presses in a task thread reach the
// bridge (F3). On the fake Discord, with the pinned sage copy in a scratch HOME. SAMPLE DATA ONLY: every id, name and text is made up.
// Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createBridge, SETTLE } from '../src/bridge.js';
import { card } from '../src/cards.js';
import { openChannels } from '../src/channels.js';
import { createAsk, openAskFiles, UNREGISTER } from '../src/ask.js';
import { CREW, namesOf } from '../src/crew.js';
import { routes } from '../src/discord.js';
import { fakeCommand, fakeInteraction, fakeMention } from '../src/fake-discord.js';
import { loadProjects } from '../src/projects.js';
import { createRequestFlow } from '../src/requestFlow.js';
import { approve as approveAt, loadRequests, requestsPathOf } from '../src/requests.js';
import { writeWhole } from '../src/state.js';
import { isLiveTask, loadThreads, threadsPathOf } from '../src/threads.js';
import { BATCH_LIMIT, MINUTE, openGate, parseGate, step } from '../src/vote.js';
import { CHANNEL, CONFIG, CREW_ROLE, GUILD, JON, MAYA, NAME, OWNER, SAGE, SAM, setup, T0 } from './bridge-setup.js';

const ASK = '400000000000000009'; // the project channel where the crew requests: not the home channel
const ROLES = { [OWNER]: [CREW], [MAYA]: [CREW], [JON]: [CREW], [SAM]: [] };
const ONLY_OWNER = 'Only Erick can do this: ask Erick. Your votes on the parts count like everyone\'s.';

/**
 * A scratch project, the request flow and the bridge on one fake Discord, sharing one thread map as src/discord.js does (F4), and an
 * approved request RQ1 whose sage task is T1. `b.thread` is the request's thread.
 */
async function world(tt) {
  const b = setup({ markAll: false });
  tt.after(() => rmSync(b.root, { recursive: true, force: true }));
  const config = { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
  const projects = loadProjects(config);
  const fake = b.discord;
  const port = { post: fake.post, edit: fake.edit, startThread: (at, line, name) => fake.startThread(line, name), threadFrom: (at, line) => fake.threadFrom(line), unarchive: fake.unarchive };
  b.threads = loadThreads(threadsPathOf(config));
  b.channels = openChannels(config, projects); // the one registry of the process, as src/discord.js shares it
  b.flow = createRequestFlow({ config, channels: b.channels, projects, discord: port, now: () => b.now, log: (l) => b.lines.push(l), tool: () => b.sage, threads: b.threads });
  b.newBridge = (threads = b.threads) => createBridge({ sages: new Map([[NAME, b.sage]]), own: NAME, discord: fake, config: CONFIG, statePath: b.statePath,
    threads, channels: b.channels, now: () => b.now, log: (l) => b.lines.push(l) });
  b.bridge = b.newBridge();
  b.config = config;
  b.asker = () => createAsk({ config, channels: b.channels, projects, now: () => b.now, log: (l) => b.lines.push(l), env: b.env,
    requests: b.flow, files: { ...openAskFiles(config, projects), threads: b.threads } });
  b.r = () => loadRequests(requestsPathOf(config)).requests[0];
  b.ask = async (user, customId, o = {}) => {
    const i = fakeInteraction({ user, customId, roles: ROLES[user], fields: o.fields, message: o.message, sentAt: b.now });
    await b.flow.interaction(i);
    return i.replies;
  };
  // /sage request goes through src/ask.js, which calls the flow's command with the registered channel.
  const typed = fakeCommand({ user: JON, name: 'Jon', roles: ROLES[JON], channelId: ASK, sub: 'request' });
  await b.flow.command(typed, ASK);
  const key = /^rq1:form:(D\d+)$/.exec(typed.replies[0].custom_id)[1];
  await b.ask(JON, `rq1:form:${key}`, { fields: { title: 'Add CSV export', text: 'Users need the monthly report as a CSV file.' } });
  await b.ask(JON, `rq1:send-team:${key}`);
  b.thread = b.r().thread;
  return b;
}
/** The owner approves RQ1 on its card. */
const approve = (b) => b.ask(OWNER, 'rq1:approve:RQ1', { message: b.r().card });
/** sage adds the gates of `task` (each [question, options]) and marks them as team votes; two loops SETTLE apart post them. */
async function ask(b, task, ...questions) {
  for (const [q, options] of questions) b.sh('gate', 'add', task, '--question', q, '--options', options, '--recommend', options.split('|')[0]);
  const ids = b.gates().split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')[0]);
  b.mark(...ids.slice(-questions.length));
  await b.post();
}
/** A press on the card of `gateId`, on its own message. */
async function press(b, user, customId) {
  const i = fakeInteraction({ user, customId, message: b.discord.cardOf(customId.split(':')[1]) });
  await b.bridge.interaction(i);
  return i.replies;
}
const pinged = (b) => b.discord.posts.filter((p) => p.content).map((p) => p.content);

test('Approve turns the request thread into the task thread: one entry in the shared thread map, saved as version 2', async (tt) => {
  const b = await world(tt);
  assert.equal(b.threads.has(b.thread), false); // a request thread is no task thread while it waits
  const replies = await approve(b);
  assert.equal(replies.at(-1).content.includes('sage task T1'), true);
  const entry = { kind: 'task', task: 'T1', request: 'RQ1', project: NAME, folder: b.project, channel: ASK };
  assert.deepEqual(b.threads.get(b.thread), entry);
  assert.deepEqual(JSON.parse(readFileSync(threadsPathOf(b.config), 'utf8')), { version: 2, threads: { [b.thread]: entry } });
  assert.equal(b.lines.includes(`RQ1: its thread ${b.thread} is now the thread of T1 in ${NAME}`), true);
  // A new process loads the same map.
  assert.deepEqual([...loadThreads(threadsPathOf(b.config))], [[b.thread, entry]]);
});

test('an approve at the terminal (or before a restart) makes the task thread at the next loop of the request flow, once', async (tt) => {
  const b = await world(tt);
  await approveAt(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.sage, now: () => b.now });
  assert.equal(b.threads.has(b.thread), false);
  await b.flow.loop();
  assert.equal(b.threads.get(b.thread).task, 'T1');
  await b.flow.loop();
  assert.equal(b.lines.filter((l) => l.includes('is now the thread of T1')).length, 1);
});

test('a design gate of the task posts in its thread as a vote of 10 minutes; the crew votes and the votes decide at 10 minutes', async (tt) => {
  const b = await world(tt);
  await approve(b);
  const before = b.discord.in(b.thread).length;
  await ask(b, 'T1', ['Which columns go in the export?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  const { gate } = b.bridge.entry(id);
  // One question alone is a vote in a task thread, with the stored limit of 10 minutes.
  assert.deepEqual([gate.kind, gate.limit, gate.endsAt - gate.openedAt], ['batch', 10 * MINUTE, 10 * MINUTE]);
  const cardId = b.discord.cardOf(id);
  assert.equal(b.discord.where.get(cardId), b.thread);
  assert.equal(b.discord.in(b.thread).length, before + 1);
  assert.deepEqual(b.discord.in(CHANNEL), []); // nothing in the home channel
  const posted = b.discord.messages.get(cardId)[0];
  assert.equal(posted.content, `<@&${CREW_ROLE}> ${NAME} T1 has 1 product question. Vote on it within 10 minutes. Then the votes decide, and Erick breaks a tie.`);
  assert.deepEqual(posted.allowedMentions, { parse: [], roles: [CREW_ROLE] });
  const embed = b.discord.latest(cardId).embeds[0];
  assert.equal(embed.title, `Vote ${id} · T1 RQ1: Add CSV export`); // one question: no "Batch"
  assert.match(embed.footer.text, /^Rule: 10 minutes, then each part goes to the option with the most votes · a tied part waits for Erick · Who votes: every sage-crew member/);
  assert.match(embed.description, new RegExp(`Closes at <t:${(gate.openedAt + 10 * MINUTE) / 1000}:t>`));
  // Maya and Jon vote A; Sam, outside the crew, gets the private line and nothing counts.
  await press(b, MAYA, `press:${id}:0:0`);
  await press(b, JON, `press:${id}:0:0`);
  assert.equal((await press(b, SAM, `press:${id}:0:1`))[0].content, 'Only the sage-crew role can use sage-bot.');
  b.now = gate.endsAt - 1;
  await b.bridge.loop();
  assert.equal(b.bridge.entry(id).gate.phase, 'voting'); // still open 1 ms before the limit
  b.now = gate.endsAt;
  await b.bridge.loop();
  assert.deepEqual(b.bridge.entry(id).gate.parts[0].outcome, { status: 'decided', option: 'A', how: 'votes' });
  assert.equal(b.answerOf('G1'), 'Visible only'); // sage gets the option of the votes
});

test('a tie in a task thread waits for the owner: the tie post pings only the owner in the thread, and only the owner breaks it', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await ask(b, 'T1', ['Which date format?', 'ISO|Locale']);
  const id = `${NAME}/G1`;
  await press(b, MAYA, `press:${id}:0:0`);
  await press(b, JON, `press:${id}:0:1`);
  b.now = b.bridge.entry(id).gate.endsAt;
  await b.bridge.loop();
  assert.equal(b.bridge.entry(id).gate.phase, 'tied');
  const tie = b.discord.posts.at(-1);
  assert.equal(tie.content, `<@${OWNER}> ${id} is tied after its vote. T1 waits: please break the tie with the buttons on the card.\nPart 1 is tied: A, B. Nobody gave a reason.`);
  assert.deepEqual(tie.allowedMentions, { parse: [], users: [OWNER] });
  assert.equal(b.discord.where.get(b.discord.in(b.thread).at(-1)), b.thread);
  assert.equal(b.discord.messages.get(b.discord.in(b.thread).at(-1))[0].content, tie.content); // the tie post is in the task thread
  assert.equal(b.answerOf('G1'), ''); // nothing goes to sage while the tie waits
  // A crew member cannot break it, nor end a vote; the owner breaks it.
  assert.equal((await press(b, JON, `tiebreak:${id}:0:1`))[0].content, ONLY_OWNER);
  assert.equal(b.bridge.entry(id).gate.phase, 'tied');
  await press(b, OWNER, `tiebreak:${id}:0:1`);
  assert.deepEqual(b.bridge.entry(id).gate.parts[0].outcome.option, 'B');
  assert.equal(b.answerOf('G1'), 'Locale');
  assert.equal(pinged(b).at(-1), `Erick broke the tie on part 1 of ${id}: B.`);
});

test('the owner ends a task-thread vote early; a crew member cannot', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await ask(b, 'T1', ['Which columns go in the export?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  await press(b, MAYA, `press:${id}:0:1`);
  assert.equal((await press(b, JON, `end:${id}`))[0].content, ONLY_OWNER);
  b.now += MINUTE;
  const confirm = fakeInteraction({ user: OWNER, customId: `end!:${id}`, ephemeral: true });
  await b.bridge.interaction(confirm);
  assert.deepEqual(b.bridge.entry(id).gate.parts[0].outcome, { status: 'decided', option: 'B', how: 'votes' });
  assert.equal(b.bridge.entry(id).gate.endedBy, OWNER);
});

test('a gate of a task with no task thread stays in the home channel with 30 minutes, as before', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await ask(b, 'T9', ['Which columns?', 'Visible only|All fields'], ['Which date format?', 'ISO|Locale']);
  await ask(b, 'T8', ['What does the button say?', 'Sign in|Log in']);
  const batch = b.bridge.entry(`${NAME}/G1+G2`).gate;
  assert.deepEqual([batch.limit, batch.endsAt - batch.openedAt], [BATCH_LIMIT, 30 * MINUTE]);
  assert.equal(b.bridge.entry(`${NAME}/G3`).gate.kind, 'single'); // one question alone stays a single answer there
  for (const id of [`${NAME}/G1+G2`, `${NAME}/G3`]) assert.equal(b.discord.where.get(b.discord.cardOf(id)), CHANNEL);
  assert.match(b.discord.latest(b.discord.cardOf(`${NAME}/G1+G2`)).embeds[0].footer.text, /^Rule: 30 minutes,/);
  assert.equal(pinged(b).includes(`<@&${CREW_ROLE}> ${NAME} T9 has 2 product questions. Vote on each part within 30 minutes.`), true);
  // The vote of 30 minutes is still open at 10 minutes.
  b.now = batch.openedAt + 10 * MINUTE;
  await b.bridge.loop();
  assert.equal(b.bridge.entry(`${NAME}/G1+G2`).gate.phase, 'voting');
});

test('a task thread of the same task id in another folder is not this project\'s: its gate stays in the home channel', async (tt) => {
  const b = await world(tt);
  await approve(b);
  b.threads.set(b.thread, { ...b.threads.get(b.thread), folder: '/elsewhere' });
  await ask(b, 'T1', ['Which columns?', 'Visible only|All fields']);
  assert.equal(b.discord.where.get(b.discord.cardOf(`${NAME}/G1`)), CHANNEL);
  assert.equal(b.bridge.entry(`${NAME}/G1`).gate.kind, 'single');
});

test('when Discord refuses the card in the task thread, it goes to the home channel with its 10 minutes', async (tt) => {
  const b = await world(tt);
  await approve(b);
  b.discord.deleteThread(b.thread);
  await ask(b, 'T1', ['Which columns?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  assert.equal(b.discord.where.get(b.discord.cardOf(id)), CHANNEL);
  assert.equal(b.bridge.entry(id).gate.limit, 10 * MINUTE);
});

test('a version 1 thread map loads and saves as version 2 (T247: an owner thread loads as an answer thread, and held mentions are dropped); a task entry in a version 1 file, or a bad task entry, is refused', async (tt) => {
  const b = setup();
  tt.after(() => rmSync(b.root, { recursive: true, force: true }));
  const path = threadsPathOf({ statePath: b.statePath });
  const [A, L, K] = ['900000000000000001', '900000000000000002', '900000000000000003'];
  const v1 = {
    [A]: { kind: 'answer', channel: ASK, project: NAME, by: MAYA, at: T0, held: [{ id: '800000000000000001', user: MAYA, roles: [CREW], content: '<@1> board' }] },
    [L]: { kind: 'lead', channel: ASK, project: NAME, by: OWNER, at: T0 },
  };
  writeWhole(path, JSON.stringify({ version: 1, threads: v1 }));
  const map = loadThreads(path);
  const now = { [A]: { kind: 'answer', channel: ASK, project: NAME, by: MAYA, at: T0 }, [L]: { kind: 'answer', channel: ASK, project: NAME, by: OWNER, at: T0 } };
  assert.deepEqual(Object.fromEntries(map), now);
  const task = { kind: 'task', task: 'T5', request: 'RQ1', project: NAME, folder: b.project, channel: ASK };
  map.set(K, task);
  map.save();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2, threads: { ...now, [K]: task } });
  assert.deepEqual(Object.fromEntries(loadThreads(path)), { ...now, [K]: task });
  assert.deepEqual(loadThreads(path).get(K), task);
  const refused = `the thread map ${path} is not a version 1 or 2 thread map that the bridge wrote. Nothing was loaded.`;
  for (const [version, entry] of [[1, task], [2, { ...task, task: 'T5x' }], [2, { ...task, request: 'R1' }], [2, { ...task, folder: 'relative' }],
    [2, { ...task, by: OWNER }], [2, { ...task, channel: 'home' }], [3, task]]) {
    writeWhole(path, JSON.stringify({ version, threads: { [K]: entry } }));
    assert.throws(() => loadThreads(path), { message: refused }, JSON.stringify([version, entry]));
  }
});

test('a gate saved with no limit (before T245) reads as 30 minutes; a stored limit is 10 or 30 minutes and must match endsAt', () => {
  const json = (g) => JSON.parse(JSON.stringify(g));
  const old = json(openGate({ id: 'project/G1+G2', kind: 'batch', parts: [['A', 'B'], ['A', 'B']], askedBy: OWNER, at: T0 }));
  delete old.limit;
  const gate = parseGate(old);
  assert.equal(gate.endsAt, T0 + 30 * MINUTE);
  assert.equal(card(gate, { kind: 'batch', task: 'T1', title: '', parts: [0, 1].map(() => ({ question: 'Q', why: 'w', recommended: 'A', options: { A: 'a', B: 'b' } })) },
    { holders: new Set([MAYA]), names: new Map(), us: namesOf(CONFIG) }).embeds[0].footer.text.startsWith('Rule: 30 minutes,'), true);
  assert.equal(step(gate, { type: 'tick', at: T0 + 30 * MINUTE - 1 }, [MAYA], OWNER).gate.phase, 'voting');
  assert.equal(step(gate, { type: 'tick', at: T0 + 30 * MINUTE }, [MAYA], OWNER).gate.phase, 'tied');
  const ten = json(openGate({ id: 'g', kind: 'batch', parts: [['A', 'B']], askedBy: OWNER, at: T0, limit: 10 * MINUTE }));
  assert.equal(parseGate(ten).endsAt, T0 + 10 * MINUTE);
  const refused = (g, why) => assert.throws(() => parseGate(g), { name: 'TypeError', message: `parseGate: the first argument must be a gate from openGate or step: ${why}` });
  refused({ ...ten, endsAt: T0 + 30 * MINUTE }, 'endsAt is not the limit after openedAt');
  refused({ ...ten, limit: 20 * MINUTE, endsAt: T0 + 20 * MINUTE }, 'limit is not THREAD_LIMIT or BATCH_LIMIT');
  refused({ ...old, endsAt: T0 + 10 * MINUTE }, 'endsAt is not the limit after openedAt'); // no limit: 30 minutes
  assert.throws(() => openGate({ id: 'g', kind: 'batch', parts: [['A']], askedBy: OWNER, at: T0, limit: 5 * MINUTE }), { name: 'RangeError', message: 'openGate: a batch limit is THREAD_LIMIT or BATCH_LIMIT' });
});

test('the routes take a press of the bridge in a task thread of any registered channel, and not in an unknown thread there', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await ask(b, 'T1', ['Which columns?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  const reached = [];
  const on = routes({ config: CONFIG, ask: {}, requests: {}, bridge: { interaction: (i) => { reached.push(i.channelId); return b.bridge.interaction(i); } },
    fetch: async () => ({ isThread: () => true, parentId: ASK }), botId: '1', threads: b.threads, channels: b.channels });
  const pressIn = (channelId) => ({ ...fakeInteraction({ user: MAYA, customId: `press:${id}:0:1`, message: b.discord.cardOf(id) }), guildId: GUILD, channelId,
    isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, isButton: () => true, isModalSubmit: () => false });
  const unknown = '900000000000000077'; // another thread of the same registered channel
  await on.interaction(pressIn(unknown));
  assert.deepEqual(reached, []);
  assert.equal(b.bridge.entry(id).gate.parts[0].ballots.length, 0);
  await on.interaction(pressIn(b.thread));
  assert.deepEqual(reached, [b.thread]);
  assert.deepEqual(b.bridge.entry(id).gate.parts[0].ballots.map(([by, x]) => [by, x.option]), [[MAYA, 'B']]);
});

test('a crew member\'s mention in a task thread is a read ask, and nothing is held for it', async (tt) => {
  const b = await world(tt);
  await approve(b);
  const asker = b.asker();
  const m = fakeMention({ user: MAYA, roles: [CREW], channelId: b.thread, parentId: ASK, content: '<@1> board', place: b.discord });
  await asker.mention(m);
  const reply = b.discord.latest(b.discord.in(b.thread).at(-1));
  assert.match(reply.content, /^\*\*Board · project\*\*/);
  assert.deepEqual(b.threads.get(b.thread), { kind: 'task', task: 'T1', request: 'RQ1', project: NAME, folder: b.project, channel: ASK });
});

/** The owner's /sage unregister confirm for the request channel ASK, pressed in time, through src/ask.js. */
async function unregister(b) {
  const replies = [];
  await b.asker().press({ user: { id: OWNER, name: 'Erick', bot: false }, roles: [CREW], customId: `${UNREGISTER}${ASK}`, sentAt: b.now,
    update: async (p) => { replies.push(p); }, reply: async (p) => { replies.push(p); } });
  assert.equal(replies[0].content, `<#${ASK}> is unregistered: sage-bot ignores /sage and mentions here now. Only Erick can register it again.`);
}

test('after the owner unregisters its channel, a task thread takes no card, ping or press: the gate goes to the home channel as for a task with no task thread (F-T245-3, F-T245-8)', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await unregister(b);
  const before = b.discord.in(b.thread).length;
  await ask(b, 'T1', ['Which columns go in the export?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  const { gate } = b.bridge.entry(id);
  assert.equal(gate.kind, 'single'); // the rules of a task with no task thread, as for a task approved after the unregister (F-T245-8)
  assert.equal(b.discord.where.get(b.discord.cardOf(id)), CHANNEL); // in the home channel
  assert.equal(b.discord.in(b.thread).length, before); // no card and no crew ping in the old thread
  assert.equal(pinged(b).at(-1), `<@&${CREW_ROLE}> ${NAME} T1 needs one product answer. The first answer is final.`);
  // A press in the old thread does not reach the bridge; the same press in the home channel does.
  const reached = [];
  const on = routes({ config: CONFIG, ask: {}, requests: {}, bridge: { interaction: (i) => { reached.push(i.channelId); return b.bridge.interaction(i); } },
    fetch: async () => ({ isThread: () => true, parentId: ASK }), botId: '1', threads: b.threads, channels: b.channels });
  const pressIn = (channelId) => ({ ...fakeInteraction({ user: MAYA, customId: `press:${id}:0:1`, message: b.discord.cardOf(id) }), guildId: GUILD, channelId,
    isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, isButton: () => true, isModalSubmit: () => false });
  await on.interaction(pressIn(b.thread));
  assert.deepEqual(reached, []);
  assert.equal(b.bridge.entry(id).gate.outcome.status, 'open');
  await on.interaction(pressIn(CHANNEL));
  assert.deepEqual(reached, [CHANNEL]);
  // A mention in the old thread gets the reply for a channel that is not registered.
  const m = fakeMention({ user: MAYA, roles: [CREW], channelId: b.thread, parentId: ASK, content: '<@1> board', place: b.discord });
  await b.asker().mention(m);
  assert.deepEqual(m.replies.map((r) => r.content), [`I answer in <#${CHANNEL}>, so everyone can find the answers. Please ask there.`]);
});

test('an approve after the owner unregistered the request channel makes no task thread (F-T245-3)', async (tt) => {
  const b = await world(tt);
  await unregister(b);
  const replies = await approve(b);
  assert.equal(replies.at(-1).content.includes('sage task T1'), true); // the approve itself works
  await b.flow.loop();
  assert.equal(b.threads.has(b.thread), false);
  assert.deepEqual([...loadThreads(threadsPathOf(b.config))], []); // nothing saved either
  // The bridge sends the task's gates to the home channel, as for any task with no task thread.
  await ask(b, 'T1', ['Which columns?', 'Visible only|All fields']);
  assert.equal(b.discord.where.get(b.discord.cardOf(`${NAME}/G1`)), CHANNEL);
  assert.equal(b.bridge.entry(`${NAME}/G1`).gate.kind, 'single');
});

test('a bridge restart in the middle of a task-thread vote keeps the vote: still open 1 ms before 10 minutes, decided once at 10 minutes (F-T245-4)', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await ask(b, 'T1', ['Which columns go in the export?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  await press(b, MAYA, `press:${id}:0:1`);
  const cardId = b.discord.cardOf(id);
  // A new process: a new thread map and a new bridge from the same files.
  const threads = loadThreads(threadsPathOf(b.config));
  assert.deepEqual(threads.get(b.thread).kind, 'task');
  b.bridge = b.newBridge(threads);
  const { gate } = b.bridge.entry(id);
  assert.deepEqual([gate.limit, gate.endsAt - gate.openedAt, gate.parts[0].ballots.map(([by]) => by)], [10 * MINUTE, 10 * MINUTE, [MAYA]]);
  b.now = gate.endsAt - 1;
  await b.bridge.loop();
  assert.equal(b.bridge.entry(id).gate.phase, 'voting');
  assert.equal(b.answerOf('G1'), '');
  b.now = gate.endsAt;
  await b.bridge.loop();
  const posts = b.discord.posts.length;
  b.now += MINUTE;
  await b.bridge.loop();
  assert.equal(b.discord.posts.length, posts); // decided once: the next loop posts nothing more
  assert.deepEqual(b.bridge.entry(id).gate.parts[0].outcome, { status: 'decided', option: 'B', how: 'votes' });
  assert.equal(b.discord.cardOf(id), cardId); // the same card, still in the task thread
  assert.equal(b.discord.where.get(cardId), b.thread);
  assert.equal(b.answerOf('G1'), 'All fields');
});

// T246: the six low findings of the PR 65 review about task threads whose channel is unregistered, moved or deleted.

const CLOSED_NOTE = 'This question\'s channel is unregistered; Erick answers it at the terminal.';
const buttonsOf = (b, cardId) => b.discord.latest(cardId).components.flatMap((row) => row.components.map((c) => c.custom_id));

test('a waiting card already in the task thread at the unregister closes: no buttons, one note, one terminal line, no tick, tie ping or reminder; a new register opens it again (F-T245-5)', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await ask(b, 'T1', ['Which date format?', 'ISO|Locale']);
  const id = `${NAME}/G1`;
  const cardId = b.discord.cardOf(id);
  await press(b, MAYA, `press:${id}:0:0`);
  await press(b, JON, `press:${id}:0:1`); // a tie at the limit, if the vote ran on
  await unregister(b);
  await b.bridge.loop();
  const shown = b.discord.latest(cardId);
  assert.deepEqual([buttonsOf(b, cardId), shown.content], [[], CLOSED_NOTE]);
  assert.equal(shown.embeds[0].description, '**Closed:** this question\'s channel is unregistered; Erick answers it at the terminal.');
  assert.equal(shown.embeds[0].footer, undefined);
  const posts = b.discord.posts.length;
  const { gate } = b.bridge.entry(id);
  b.now = gate.endsAt;
  await b.bridge.loop();
  b.now += 5 * 60 * MINUTE; // past two reminder marks
  await b.bridge.loop();
  assert.equal(b.discord.posts.length, posts); // no tie ping, no reminder, nothing else
  assert.equal(b.bridge.entry(id).gate.phase, 'voting'); // no tick: the bridge gives sage no answer from a closed card
  assert.equal(b.answerOf('G1'), '');
  assert.deepEqual(b.lines.filter((l) => l.startsWith(`${id}: `)), [`${id}: the channel of its task thread is unregistered, so the bridge closed its card; Erick answers it at the terminal`]);
  // Erick registers the channel again for the project: the card gets its buttons back, and its vote ends with the tie for the owner.
  b.channels.set(ASK, { project: NAME });
  await b.bridge.loop();
  assert.deepEqual([buttonsOf(b, cardId).length > 0, b.discord.messages.get(cardId).findLast((p) => 'content' in p).content], [true, '']); // Discord keeps the last content
  assert.equal(b.bridge.entry(id).gate.phase, 'tied');
  assert.match(b.discord.latest(b.discord.in(b.thread).at(-1)).content, new RegExp(`^<@${OWNER}> ${id} is tied after its vote`)); // in the task thread
});

test('a card that waits for its first post at the unregister posts in the home channel, never in the old task thread (F-T245-6)', async (tt) => {
  const b = await world(tt);
  await approve(b);
  const real = b.discord.post;
  b.discord.post = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); };
  await ask(b, 'T1', ['Which columns?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  assert.equal(b.discord.cardOf(id), undefined); // the entry is saved; its card waits for its first post
  b.discord.post = real;
  await unregister(b);
  const before = b.discord.in(b.thread).length;
  await b.bridge.loop();
  assert.equal(b.discord.where.get(b.discord.cardOf(id)), CHANNEL);
  assert.equal(b.discord.in(b.thread).length, before); // no card and no crew ping in the old thread
});

test('a task thread counts only while its channel is registered to the task\'s own project: a channel moved to another project gives no task thread (F-T245-7)', async (tt) => {
  const entry = { kind: 'task', task: 'T1', request: 'RQ1', project: NAME, folder: '/p', channel: ASK };
  assert.deepEqual([[ASK, NAME], [ASK, 'other'], [CHANNEL, NAME]].map(([c, p]) => isLiveTask(entry, new Map([[c, { project: p }]]))), [true, false, false]);
  const b = await world(tt);
  await approve(b);
  b.channels.set(ASK, { project: 'other' }); // Erick registers the channel to another project at the terminal
  await ask(b, 'T1', ['Which columns?', 'Visible only|All fields']);
  const id = `${NAME}/G1`;
  assert.equal(b.discord.where.get(b.discord.cardOf(id)), CHANNEL);
  assert.equal(b.bridge.entry(id).gate.kind, 'single');
});

test('two tasks of one unregistered channel follow the same vote rules: an old task thread counts as none (F-T245-8)', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await unregister(b);
  // T2 has an entry of the same unregistered channel, made before the unregister; T3 has none, as a task approved after it.
  b.threads.set('900000000000000055', { ...b.threads.get(b.thread), task: 'T2' });
  await ask(b, 'T2', ['Which columns?', 'Visible only|All fields']);
  await ask(b, 'T3', ['Which date format?', 'ISO|Locale']);
  const rules = (id) => { const { gate } = b.bridge.entry(id); return [gate.kind, gate.limit, b.discord.where.get(b.discord.cardOf(id))]; };
  assert.deepEqual(rules(`${NAME}/G1`), ['single', undefined, CHANNEL]);
  assert.deepEqual(rules(`${NAME}/G2`), ['single', undefined, CHANNEL]);
});

test('a waiting card in a task thread that Discord deleted moves to the home channel with its votes, and its tie post goes below it (F-T245-9)', async (tt) => {
  const b = await world(tt);
  await approve(b);
  await ask(b, 'T1', ['Which date format?', 'ISO|Locale']);
  const id = `${NAME}/G1`;
  await press(b, MAYA, `press:${id}:0:0`);
  await press(b, JON, `press:${id}:0:1`);
  b.discord.deleteThread(b.thread);
  b.now = b.bridge.entry(id).gate.endsAt;
  await b.bridge.loop(); // the tie edit and post find the thread gone: the card moves, and the loop posts it home
  const cardId = b.discord.cardOf(id);
  assert.equal(b.discord.where.get(cardId), CHANNEL);
  assert.match(b.discord.messages.get(cardId)[0].content, /Its task thread was deleted, so the card is here now, with the votes so far\.$/);
  assert.equal(b.bridge.entry(id).gate.parts[0].ballots.length, 2);
  const after = b.discord.in(CHANNEL);
  assert.equal(after.at(-1) !== cardId && b.discord.where.get(after.at(-1)), CHANNEL);
  assert.match(b.discord.latest(after.at(-1)).content, new RegExp(`^<@${OWNER}> ${id} is tied after its vote`));
  assert.equal(b.lines.includes(`${id}: its card moves to the parent channel, because its task thread ${b.thread} is gone (G17)`), true);
});
