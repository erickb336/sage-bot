// T244 (issue 60, PR 4): several owners each run their own sage-bot in one Discord server. C4: a sage-bot leaves every server but its
// own. C5: a message that sets no allowedMentions pings nobody. The copy names each bot's owner and the bot itself by their Discord
// names, cleaned by one allow-list. Two bots in one fake server: neither acts on the other's buttons, mentions, threads or files.
// SAMPLE DATA ONLY: no token, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { Client, MessagePayload } from 'discord.js';
import { askCommand, createAsk } from '../src/ask.js';
import { card } from '../src/cards.js';
import { openChannels } from '../src/channels.js';
import { CREW, NAME_MAX, namesOf, personName } from '../src/crew.js';
import { CLIENT_OPTIONS, keepToGuild, routes } from '../src/discord.js';
import { fakeCommand, fakeDiscord, fakeGuilds, fakeInteraction, fakeMention } from '../src/fake-discord.js';
import { peopleOf } from '../src/handle.js';
import { loadProjects } from '../src/projects.js';
import { requestCard } from '../src/requestCards.js';
import { createRequestFlow } from '../src/requestFlow.js';
import { loadRequests, requestsPathOf } from '../src/requests.js';
import { threadsPathOf } from '../src/threads.js';
import { openGate } from '../src/vote.js';
import { CONFIG, JON, MAYA, OWNER, SAGE, SAM, setup, T0 } from './bridge-setup.js';

const GUILD = CONFIG.guildId;
const ASK = '400000000000000009'; // #ask-sage: both bots take requests here
const PRIVATE = 64;

// ---- C4: one server ------------------------------------------------------------------------------------------------------------

test('C4: at the start the bot leaves every server but its own, with one log line each; a server it is added to later is left too', async () => {
  const OTHER = '500000000000000077';
  const LATER = '500000000000000078';
  const client = fakeGuilds([GUILD, OTHER]);
  const lines = [];
  await keepToGuild(client, GUILD, (l) => lines.push(l));
  assert.deepEqual(client.left, [OTHER]);
  assert.deepEqual([...client.guilds.cache.keys()], [GUILD]);
  assert.deepEqual(lines, [`sage-bot left the server ${OTHER} (server 77): it serves only the server ${GUILD} of its config`]);
  client.join(LATER);
  client.join(GUILD); // its own server again (for example after an outage): it stays
  await new Promise(setImmediate);
  assert.deepEqual(client.left, [OTHER, LATER]);
  assert.deepEqual([...client.guilds.cache.keys()], [GUILD]);
  assert.equal(lines.length, 2);
});

test('C4: a refused leave is logged, and the start goes on', async () => {
  const OTHER = '500000000000000077';
  const client = fakeGuilds([OTHER, GUILD], { refuse: { [OTHER]: 50001 } });
  const lines = [];
  await keepToGuild(client, GUILD, (l) => lines.push(l));
  assert.deepEqual(client.left, []);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^Discord refused to let sage-bot leave the server 500000000000000077; it ignores that server all the same: /);
});

// ---- C5: no ping by default ----------------------------------------------------------------------------------------------------

/** The body that discord.js sends for `payload` from a channel of a Client with sage-bot's options, as TextChannel.send makes it. */
const sent = (payload) => {
  const client = new Client(CLIENT_OPTIONS);
  return MessagePayload.create({ client }, payload).resolveBody().body;
};

test('C5: a send with no allowedMentions pings nobody: @everyone, @here, a role and a user stay text', () => {
  const body = sent({ content: `@everyone @here <@&300000000000000001> <@${JON}> look` });
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  // The control: a Client with discord.js's default options would ping all of them (Discord parses every mention when the field is missing).
  assert.equal(MessagePayload.create({ client: new Client({ intents: [] }) }, { content: '@everyone' }).resolveBody().body.allowed_mentions, undefined);
});

test('C5: the explicit pings still work: the request card pings its owner, the crew alert pings the crew role', () => {
  const r = { id: 'RQ1', project: 'project', title: 'Add CSV export', text: 'Users need the monthly report as a CSV file.', designQuestions: 'team',
    requester: JON, requesterName: 'Jon', status: 'pending', createdAt: T0 };
  const first = sent(requestCard(r, { ownerId: OWNER, us: namesOf(CONFIG), ping: true }));
  assert.deepEqual([first.content, first.allowed_mentions], [`<@${OWNER}> a new request waits for you.`, { parse: [], users: [OWNER] }]);
  const alert = sent({ content: '<@&300000000000000001> project T1 needs one product answer.', allowedMentions: { parse: [], roles: ['300000000000000001'] } });
  assert.deepEqual(alert.allowed_mentions, { parse: [], roles: ['300000000000000001'] });
});

// ---- The names in the copy -------------------------------------------------------------------------------------------------------

test('names: the owner and the bot by their Discord names; "the owner" and "sage-bot" when unknown; a hostile name is inert', () => {
  assert.deepEqual(namesOf({}), { owner: 'the owner', Owner: 'The owner', bot: 'sage-bot' });
  assert.deepEqual(namesOf({ ownerName: 'Maya', botName: "Maya's sage" }), { owner: 'Maya', Owner: 'Maya', bot: "Maya's sage" });
  assert.deepEqual(namesOf({ ownerName: '🙂 <@&> *** ||' }), { owner: 'the owner', Owner: 'The owner', bot: 'sage-bot' });
  assert.equal(personName('**@everyone** <@100000000000000001>'), 'everyone 100000000000000001');
  assert.equal(personName('[Erick](https://x.test) `rm`'), 'Erick https x.test rm');
  assert.equal(personName("-- Ana-Luc\u00eda O'Neil\u202e\u200b"), "Ana-Luc\u00eda O'Neil");
  // NFC makes Z and U+0301 one letter (U+0179); then at most 3 marks stay on it.
  assert.equal(personName('Z\u0301\u0302\u0303\u0304\u0305a'), '\u0179\u0302\u0303\u0304a');
  assert.equal(personName('\uff4d\uff41\uff59\uff41'), '\uff4d\uff41\uff59\uff41'); // full-width letters are letters
  assert.equal(personName('x'.repeat(50)), 'x'.repeat(NAME_MAX));
});

test('names, standing order 12: the sweep over every Unicode code point: a name keeps only letters, marks on a letter, digits, spaces and . \' -', () => {
  // Who reads the cleaned name: people on Discord only (cards, buttons, notes and /sage descriptions), never a model.
  const ALLOWED = /^[[\p{L}\p{M}\p{Nd} .'\-]--\p{Default_Ignorable_Code_Point}]*$/v;
  let letters = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp);
    const out = personName(`A${ch}B`);
    if (!ALLOWED.test(out) || !out.normalize('NFD').startsWith('A') || Array.from(out).length > NAME_MAX) assert.fail(`U+${cp.toString(16)} gives ${JSON.stringify(out)}`);
    if (/^[\p{L}--\p{Default_Ignorable_Code_Point}]$/v.test(ch) && out === `A${ch.normalize('NFC')}B`) letters++;
    const alone = personName(ch.repeat(40));
    if (!ALLOWED.test(alone) || /^[^\p{L}\p{Nd}]/u.test(alone)) assert.fail(`U+${cp.toString(16)} alone gives ${JSON.stringify(alone)}`);
  }
  assert.ok(letters > 130000, `${letters} letters stay as they are`);
});

test('names: the vote card, the request card and /sage name the owner and the bot; the copy says "the owner" when Discord gave no name', () => {
  const maya = { ...CONFIG, ownerId: MAYA, ownerName: 'Maya', botName: "Maya's sage" };
  const members = [{ id: MAYA, name: 'Maya', roles: [CREW] }, { id: JON, name: 'Jon', roles: [CREW] }];
  const gate = openGate({ id: 'project/G1+G2', kind: 'batch', parts: [['A', 'B']], askedBy: MAYA, at: T0 });
  const ask = { kind: 'batch', task: 'T1', title: 'Colours', parts: [{ question: 'Which?', why: 'w', recommended: 'A', options: { A: 'Red', B: 'Blue' } }] };
  const labels = (c) => c.components.flatMap((row) => row.components.map((b) => b.label));
  const own = card(gate, ask, peopleOf(members, maya));
  assert.equal(labels(own).at(-1), 'End vote now (Maya only)');
  assert.match(own.embeds[0].footer.text, /a tied part waits for Maya · .* If a button does not respond, Maya's sage is offline\. Press it again later\.$/);
  const unknown = card(gate, ask, peopleOf(members, { ...maya, ownerName: undefined, botName: undefined }));
  assert.equal(labels(unknown).at(-1), 'End vote now (the owner only)');
  assert.match(unknown.embeds[0].footer.text, /a tied part waits for the owner · .* sage-bot is offline/);
  const r = { id: 'RQ1', project: 'project', title: 'Add CSV export', text: 'Users need it.', designQuestions: 'owner', requester: JON, requesterName: 'Jon',
    status: 'pending', createdAt: T0 };
  const fields = (us) => requestCard(r, { ownerId: MAYA, us, linkOff: true }).embeds[0].fields.map((f) => f.value);
  assert.deepEqual(fields(namesOf(maya)).slice(1), ['When sage designs it, Maya decides them.', 'Waiting for Maya',
    'Approve waits until Maya turns the link on again at the terminal. Maya can still decline, and the sage-crew member who sent it can still withdraw.']);
  assert.deepEqual(fields(namesOf({})).slice(1), ['When sage designs it, the owner decides them.', 'Waiting for the owner',
    'Approve waits until the owner turns the link on again at the terminal. The owner can still decline, and the sage-crew member who sent it can still withdraw.']);
  const descriptions = Object.fromEntries(askCommand([{ name: 'project' }], namesOf(maya)).options.map((o) => [o.name, o.description]));
  assert.deepEqual([descriptions.request, descriptions.unregister, descriptions.stop], ['Request a feature: Maya approves or declines it',
    "Stop Maya's sage in this channel (Maya only)", 'Turn off the link from Discord to sage at once (the crew and Maya)']);
});

// ---- Two bots in one server ----------------------------------------------------------------------------------------------------

const ROLES = { [OWNER]: [CREW], [MAYA]: [CREW], [JON]: [CREW], [SAM]: [] };
const NAMES = { [OWNER]: 'Erick', [MAYA]: 'Maya', [JON]: 'Jon', [SAM]: 'Sam' };
const BOT_A = '100000000000000091';
const BOT_B = '100000000000000092';

/**
 * Two sage-bots in one fake server: A is Erick's (the bridge-setup CONFIG), B is Maya's, each with its own project, state folder and
 * names, both taking requests in #ask-sage. They share one fake Discord, so message and thread ids are unique across them, as in a server.
 */
function twoBots(tt) {
  const fake = fakeDiscord([]);
  const bot = (owner, extra) => {
    const b = setup({ markAll: false });
    tt.after(() => rmSync(b.root, { recursive: true, force: true }));
    const config = { ...CONFIG, ...owner, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
    const projects = loadProjects(config);
    const channels = openChannels(config, projects);
    const port = { post: (at, payload) => fake.post(at, payload, extra.id), edit: fake.edit, startThread: (at, line, name) => fake.startThread(line, name), threadFrom: (at, line) => fake.threadFrom(line), unarchive: fake.unarchive };
    const flow = createRequestFlow({ config, channels, projects, discord: port, now: () => b.now, log: (l) => b.lines.push(l), tool: () => b.sage });
    const ask = createAsk({ config, channels, projects, now: () => b.now, log: (l) => b.lines.push(l), env: b.env, requests: flow });
    return Object.assign(b, extra, { config, flow, ask, r: () => loadRequests(requestsPathOf(config)).requests[0] });
  };
  const a = bot({ botName: 'sage-bot' }, { id: BOT_A });
  const b = bot({ ownerId: MAYA, ownerName: 'Maya', botName: "Maya's sage" }, { id: BOT_B });
  const press = async (x, user, customId, message) => {
    const i = fakeInteraction({ user, customId, roles: ROLES[user], message });
    await x.flow.interaction(i);
    return i.replies;
  };
  /** Jon's request on bot `x`: /sage request, the form, then Send. */
  const request = async (x) => {
    const c = fakeCommand({ user: JON, name: 'Jon', roles: ROLES[JON], channelId: ASK, sub: 'request' });
    await x.ask.command(c);
    const key = /^rq1:form:(D\d+)$/.exec(c.replies[0].custom_id)[1];
    const i = fakeInteraction({ user: JON, customId: `rq1:form:${key}`, roles: ROLES[JON], fields: { title: 'Add CSV export', text: 'Users need the monthly report as a CSV file.' } });
    await x.flow.interaction(i);
    return press(x, JON, `rq1:send-team:${key}`);
  };
  return { fake, a, b, press, request };
}

test('two bots: each request card names and pings its own owner; a press of B\'s card that reached A changes nothing in A or B', async (tt) => {
  const { fake, a, b, press, request } = twoBots(tt);
  const sentA = await request(a);
  const sentB = await request(b);
  const [ra, rb] = [a.r(), b.r()];
  assert.deepEqual([sentA[1].content, sentB[1].content], [`Sent to Erick as RQ1. Its thread is <#${ra.thread}>. You can withdraw it there until Erick decides.`,
    `Sent to Maya as RQ1. Its thread is <#${rb.thread}>. You can withdraw it there until Maya decides.`]);
  assert.deepEqual([ra.id, rb.id], ['RQ1', 'RQ1']); // the same request id on both bots
  assert.notEqual(ra.card, rb.card);
  assert.deepEqual([fake.latest(ra.card).allowedMentions, fake.latest(rb.card).allowedMentions], [{ parse: [], users: [OWNER] }, { parse: [], users: [MAYA] }]);
  assert.deepEqual([ra.thread, rb.thread].map((t) => fake.latest(fake.in(t)[0]).embeds[0].fields[2].value), ['Waiting for Erick', 'Waiting for Maya']);
  // Discord sends a press only to the app that sent the message. If B's press reached A all the same, A's stored message id refuses it.
  assert.deepEqual((await press(a, OWNER, 'rq1:approve:RQ1', rb.card)).map((x) => [x.kind, x.content]),
    [['reply', 'This button is not on the card of RQ1. Nothing changed.']]);
  // Maya is in the crew on A but not its owner: she approves only on her own bot.
  assert.deepEqual((await press(a, MAYA, 'rq1:approve:RQ1', ra.card)).map((x) => x.content), ['Only Erick approves or declines a request. Nothing changed.']);
  assert.deepEqual([a.r().status, b.r().status], ['pending', 'pending']);
  assert.deepEqual((await press(b, MAYA, 'rq1:approve:RQ1', rb.card)).map((x) => [x.kind, x.flags]), [['defer', PRIVATE], ['editReply', undefined]]);
  assert.deepEqual([a.r().status, b.r().status], ['pending', 'approved']);
  // Someone with no crew role gets the private line of the bot they pressed, with that bot's name.
  assert.deepEqual((await press(b, SAM, 'rq1:withdraw:RQ1', rb.card)).map((x) => [x.content, x.flags]), [["Only the sage-crew role can use Maya's sage.", PRIVATE]]);
});

test('two bots: a vote-card press for a gate that only B holds gets A\'s unknown-gate note; A has no card to change', async (tt) => {
  const { a } = twoBots(tt);
  const i = fakeInteraction({ user: JON, customId: 'press:other/G1:0:0', message: '900000000000000999' });
  await a.bridge.interaction(i);
  assert.deepEqual(i.replies.map((x) => [x.kind, x.content, x.flags]), [['reply', 'I do not know this button or its question. Nothing changed.', PRIVATE]]);
});

test('two bots: a mention of B in A\'s thread is not A\'s; a mention of A in B\'s thread moves to a thread of A (T247, R918 C7)', async (tt) => {
  const { fake, a, b } = twoBots(tt);
  // Jon opens a thread of A with a mention of A in #ask-sage.
  const opened = fakeMention({ user: JON, roles: ROLES[JON], channelId: ASK, content: `<@${BOT_A}> board`, place: fake });
  await a.ask.mention(opened);
  const threadA = [...fake.threads.keys()][0];
  const mapA = () => readFileSync(threadsPathOf(a.config), 'utf8');
  assert.match(mapA(), new RegExp(threadA));
  // In that thread, a message that mentions only B: A's routes give it nothing, so A posts nothing and its thread map stays.
  const before = [fake.posts.length, mapA()];
  const message = (bots, channelId) => ({ id: '700000000000000001', guildId: GUILD, author: { id: JON, bot: false }, member: { roles: [] }, channelId, content: `<@${BOT_B}> board`,
    mentions: { users: new Map(bots.map((id) => [id, {}])) }, channel: { isThread: () => true, parentId: ASK } });
  const asked = [];
  const spy = (x) => ({ mention: (m) => { asked.push([x, m.channelId]); } });
  const fetch = async () => null;
  assert.equal(routes({ config: a.config, ask: spy('A'), fetch, botId: BOT_A }).message(message([BOT_B], threadA)), undefined);
  routes({ config: b.config, ask: spy('B'), fetch, botId: BOT_B }).message(message([BOT_B], threadA));
  assert.deepEqual(asked, [['B', threadA]]);
  assert.deepEqual([fake.posts.length, mapA()], before);
  // A thread of B is not in A's thread map: a mention of A there moves to a new thread of A, from a line in A's home channel; the thread
  // of B gets one line that pings nobody, and A keeps no record of B's thread.
  const threadB = '400000000000000555';
  const inB = fakeMention({ user: JON, roles: ROLES[JON], channelId: threadB, parentId: ASK, content: `<@${BOT_A}> board`, place: fake });
  await a.ask.mention(inB);
  const movedTo = [...fake.threads.keys()].at(-1);
  assert.deepEqual(inB.replies, []);
  assert.deepEqual(fake.in(threadB).map((id) => fake.latest(id)).filter((p) => p.allowedMentions), [{ content: `Moved to sage-bot: <#${movedTo}>`, allowedMentions: { parse: [] } }]);
  const map = JSON.parse(mapA()).threads;
  assert.equal(map[movedTo].origin, threadB); // the next mention there goes to the same thread of A
  assert.equal(threadB in map, false);
});

test('two bots: each bot has its own request file and thread map; a request on A is not in B\'s file', async (tt) => {
  const { a, b, request } = twoBots(tt);
  assert.notEqual(requestsPathOf(a.config), requestsPathOf(b.config));
  assert.notEqual(threadsPathOf(a.config), threadsPathOf(b.config));
  await request(a);
  assert.equal(a.r().requester, JON);
  assert.equal(b.r(), undefined);
});
