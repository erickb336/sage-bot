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
import { createAsk, openAskFiles } from '../src/ask.js';
import { CREW, namesOf } from '../src/crew.js';
import { routes } from '../src/discord.js';
import { fakeCommand, fakeInteraction, fakeMention } from '../src/fake-discord.js';
import { loadProjects } from '../src/projects.js';
import { createRequestFlow } from '../src/requestFlow.js';
import { approve as approveAt, loadRequests, requestsPathOf } from '../src/requests.js';
import { writeWhole } from '../src/state.js';
import { loadThreads, threadsPathOf } from '../src/threads.js';
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
  b.flow = createRequestFlow({ config, channels: openChannels(config, projects), projects, discord: port, now: () => b.now, log: (l) => b.lines.push(l), tool: () => b.sage, threads: b.threads });
  b.bridge = createBridge({ sages: new Map([[NAME, b.sage]]), own: NAME, discord: fake, config: CONFIG, statePath: b.statePath, threads: b.threads, now: () => b.now, log: (l) => b.lines.push(l) });
  b.config = config;
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

test('a version 1 thread map loads as it is and saves as version 2; a task entry in a version 1 file, or a bad task entry, is refused', async (tt) => {
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
  assert.deepEqual(Object.fromEntries(map), v1);
  const task = { kind: 'task', task: 'T5', request: 'RQ1', project: NAME, folder: b.project, channel: ASK };
  map.set(K, task);
  map.save();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2, threads: { ...v1, [K]: task } });
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
    fetch: async () => ({ isThread: () => true, parentId: ASK }), botId: '1', threads: b.threads });
  const pressIn = (channelId) => ({ ...fakeInteraction({ user: MAYA, customId: `press:${id}:0:1`, message: b.discord.cardOf(id) }), guildId: GUILD, channelId,
    isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false });
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
  const projects = loadProjects(b.config);
  const asker = createAsk({ config: b.config, channels: openChannels(b.config, projects), projects, now: () => b.now, log: (l) => b.lines.push(l), env: b.env,
    requests: b.flow, files: { ...openAskFiles(b.config, projects), threads: b.threads } });
  const m = fakeMention({ user: MAYA, roles: [CREW], channelId: b.thread, parentId: ASK, content: '<@1> board', place: b.discord });
  await asker.mention(m);
  const reply = b.discord.latest(b.discord.in(b.thread).at(-1));
  assert.match(reply.content, /^\*\*Board · project\*\*/);
  assert.deepEqual(b.threads.get(b.thread), { kind: 'task', task: 'T1', request: 'RQ1', project: NAME, folder: b.project, channel: ASK });
});
