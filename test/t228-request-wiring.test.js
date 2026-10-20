// T228 (issue 60 PR 3, with T229, T239 and the late note of T240): /sage request on the fake Discord, end to end. The form, the confirm,
// Send, the line with its thread and the card; Approve, Decline and Withdraw; who may press; forged and replayed ids; the sync loop for a
// decision at the terminal, a dead claim after a restart and the kill switch; the open requests on /sage board; the private line for a
// person who is not in the crew. The state tool is the pinned sage copy in a scratch HOME. SAMPLE DATA ONLY: every id, name and text is
// made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restoreLink, setLinkOff } from '../src/audit.js';
import { createAsk } from '../src/ask.js';
import { openChannels } from '../src/channels.js';
import { CREW, namesOf } from '../src/crew.js';
import { routes } from '../src/discord.js';
import { fakeCommand, fakeDiscord, fakeInteraction, fakeMention } from '../src/fake-discord.js';
import { loadProjects } from '../src/projects.js';
import { requestNote } from '../src/requestCards.js';
import { createRequestFlow } from '../src/requestFlow.js';
import { approve, loadRequests, Refused, requestsPathOf, RETRY_AFTER, toolOf } from '../src/requests.js';
import { sageTool } from '../src/sage.js';
import { CONFIG, JON, MAYA, OWNER, SAGE, SAM, setup, spawnSync, table, T0 } from './bridge-setup.js';
const NOT_CREW = 'Only the sage-crew role can use sage-bot.'; // src/crew.js notCrew with the bot's name unknown
const US = namesOf(CONFIG);

const ASK = '400000000000000009'; // the project channel where people request
const ROLES = { [OWNER]: [CREW], [MAYA]: [CREW], [JON]: [CREW, 'Moderators'], [SAM]: [] };
const NAMES = { [OWNER]: 'Erick', [MAYA]: 'Maya', [JON]: 'Jon', [SAM]: 'Sam' };
const PRIVATE = 64; // MessageFlags.Ephemeral
const QUIET = { parse: [] };
const TITLE = 'Add CSV export';
const TEXT = 'Users need the monthly report as a CSV file.';
const t = (ms) => `<t:${Math.floor(ms / 1000)}:t>`;

/** A scratch project, the bridge's ask and request sides on one fake Discord, and helpers that act as people do. */
function world(tt) {
  const b = setup({ markAll: false });
  tt.after(() => rmSync(b.root, { recursive: true, force: true }));
  const config = { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
  const projects = loadProjects(config);
  const channels = openChannels(config, projects);
  const fake = fakeDiscord([]);
  // `b.onPost` and `b.onThread` run after Discord made the message or the thread, before its id comes back: a test fails a reply there.
  // `b.manage`: a post in a locked thread works and opens it, as Discord does for a bot with Manage Threads. `b.onUnarchive` runs before
  // an unarchive, and `b.lockReads` counts the reads of a lock.
  const manage = async (at, payload) => {
    const t = fake.threads.get(at);
    if (!b.manage || !t?.locked) return fake.post(at, payload);
    t.locked = false;
    try { return await fake.post(at, payload); } finally { t.locked = true; }
  };
  const port = { post: async (at, payload) => { const id = await manage(at, payload); await b.onPost?.(payload); return id; }, edit: fake.edit,
    startThread: async (at, line, name) => { const id = await fake.startThread(line, name); await b.onThread?.(); return id; },
    threadFrom: (at, line) => fake.threadFrom(line), unarchive: async (id) => { await b.onUnarchive?.(id); return fake.unarchive(id); },
    locked: (id) => { b.lockReads += 1; return fake.locked(id); } };
  b.lockReads = 0;
  b.tool = sageTool({ sagePath: SAGE, project: b.project, env: b.env });
  b.make = (tool = () => b.tool) => createRequestFlow({ config, channels, projects, discord: port, now: () => b.now, log: (l) => b.lines.push(l), tool });
  b.flow = b.make();
  b.ask = createAsk({ config, channels, projects, now: () => b.now, log: (l) => b.lines.push(l), env: b.env, requests: b.flow });
  Object.assign(b, { config, fake, path: requestsPathOf(config), killPath: `${b.statePath}.leads-off` });
  b.file = () => loadRequests(b.path);
  b.r = (id = 'RQ1') => b.file().requests.find((r) => r.id === id);
  /** /sage <sub> by `user`; returns its replies. */
  b.cmd = async (user, sub = 'request', o = {}) => {
    const i = fakeCommand({ user, name: o.name ?? NAMES[user], roles: ROLES[user], channelId: o.channelId ?? ASK, parentId: o.parentId, sub, options: o.options });
    await b.ask.command(i);
    return i.replies;
  };
  /** A press (or a form) of a request by `user`; returns its replies. */
  b.press = async (user, customId, o = {}) => {
    const i = fakeInteraction({ user, customId, roles: o.roles ?? ROLES[user], message: o.message, sentAt: o.sentAt, fields: o.fields });
    await b.flow.interaction(i);
    return i.replies;
  };
  /** /sage request, the form and the confirm by `user`: returns the draft key and the replies of each step. */
  b.draft = async (user, { title = TITLE, text = TEXT } = {}) => {
    const opened = await b.cmd(user);
    const key = /^rq1:form:(D\d+)$/.exec(opened[0].custom_id)[1];
    const confirm = await b.press(user, `rq1:form:${key}`, { fields: { title, text } });
    return { key, opened, confirm };
  };
  /** A whole request by `user`, sent with the crew voting on design questions. */
  b.request = async (user, o) => {
    const { key } = await b.draft(user, o);
    return b.press(user, `rq1:send-team:${key}`);
  };
  b.card = (id = 'RQ1') => b.fake.latest(b.r(id).card);
  b.line = (id = 'RQ1') => b.fake.latest(b.r(id).line);
  b.status = (embed) => embed.fields.find((f) => f.name === 'Status').value;
  b.tasks = () => table(b, 'tasks').map((r) => r.title);
  return b;
}

test('a crew member requests a feature end to end: the form with no defer, the confirm, Send, one line, one thread, one card that pings the owner once; the owner approves', async (tt) => {
  const b = world(tt);
  const { key, opened, confirm } = await b.draft(JON);
  // The form is Discord's first answer: no defer before it.
  assert.equal(opened.length, 1);
  assert.equal(opened[0].kind, 'modal');
  assert.equal(opened[0].title, 'Request a feature');
  assert.equal(confirm.length, 1);
  assert.equal(confirm[0].flags, PRIVATE);
  assert.equal(confirm[0].embeds[0].title, 'Your request · project');
  assert.deepEqual(confirm[0].components[0].components.map((c) => c.custom_id),
    [`rq1:send-team:${key}`, `rq1:send-owner:${key}`, `rq1:edit:${key}`, `rq1:cancel:${key}`]);
  assert.deepEqual(b.fake.posts, []); // nothing public before Send

  const sent = await b.press(JON, `rq1:send-team:${key}`);
  const r = b.r();
  assert.deepEqual(sent.map((x) => x.kind), ['deferUpdate', 'editReply']);
  assert.equal(sent[1].content, `Sent to Erick as RQ1. Its thread is <#${r.thread}>. You can withdraw it there until Erick decides.`);
  assert.deepEqual(sent[1].components, []);
  // One line in the project channel, one thread from it, one card in the thread, which pings only the owner, once.
  assert.deepEqual(b.fake.in(ASK), [r.line]);
  assert.deepEqual([...b.fake.threads.values()].map((x) => [x.from, x.name]), [[r.line, `RQ1 · ${TITLE}`]]);
  assert.deepEqual(b.fake.in(r.thread), [r.card]);
  assert.equal(b.line().content, `**Jon (sage-crew) requests a feature:** ${TITLE} · RQ1 · waiting for Erick`);
  assert.deepEqual(b.line().allowedMentions, QUIET);
  assert.equal(b.card().content, `<@${OWNER}> a new request waits for you.`);
  assert.deepEqual(b.card().allowedMentions, { parse: [], users: [OWNER] });
  assert.deepEqual([r.status, r.requester, r.requesterName, r.designQuestions, r.channel, r.shown], ['pending', JON, 'Jon', 'team', ASK, 'pending']);
  assert.deepEqual(b.card().components[0].components.map((c) => [c.label, c.custom_id, c.disabled]),
    [['Approve', 'rq1:approve:RQ1', false], ['Decline', 'rq1:decline:RQ1', false], ['Withdraw', 'rq1:withdraw:RQ1', false]]);
  await b.flow.loop();
  assert.equal(b.fake.posts.length, 2); // the loop draws nothing more: no second line or card, no second ping

  const approved = await b.press(OWNER, 'rq1:approve:RQ1', { message: r.card });
  assert.deepEqual(approved.map((x) => [x.kind, x.flags]), [['defer', PRIVATE], ['editReply', undefined]]);
  assert.equal(approved[1].content, 'You approved RQ1. sage task T1 is added to project.');
  assert.deepEqual(b.tasks(), [`RQ1: ${TITLE}`]);
  assert.deepEqual([b.r().status, b.r().task, b.r().decidedBy, b.r().via, b.r().shown], ['approved', 'T1', OWNER, 'discord', 'approved']);
  assert.match(b.status(b.card().embeds[0]), /^\*\*Approved by Erick at <t:\d+:t>\. sage task T1 is in the sage logbook\.\*\*$/);
  assert.deepEqual([b.card().components, b.card().allowedMentions, b.card().content], [[], QUIET, '']);
  assert.equal(b.line().content, `**Jon (sage-crew) requests a feature:** ${TITLE} · RQ1 · approved · sage task T1`);
  const after = b.fake.in(r.thread).map((id) => b.fake.latest(id).content);
  assert.match(after[1], /^\*\*Approved\.\*\* sage task T1 is in the sage logbook\./);
  await b.flow.loop();
  assert.equal(b.fake.posts.length, 3); // the post after the decision comes once
});

test('someone who is not in the crew gets one private line for /sage and for each button, nothing changes, and a mention stays silent (T239)', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const before = readFileSync(b.path, 'utf8');
  const posts = b.fake.posts.length;
  const line = { kind: 'reply', content: NOT_CREW, flags: PRIVATE, allowedMentions: QUIET };
  assert.equal(NOT_CREW, 'Only the sage-crew role can use sage-bot.');
  for (const sub of ['request', 'board', 'stop', 'unregister']) assert.deepEqual(await b.cmd(SAM, sub), [line], sub);
  for (const id of ['rq1:approve:RQ1', 'rq1:decline:RQ1', 'rq1:withdraw:RQ1', 'rq1:withdraw!:RQ1']) {
    assert.deepEqual(await b.press(SAM, id, { message: b.r().card }), [line], id);
  }
  // The kill switch and unregister confirms (src/ask.js press) and a gate card (src/bridge.js) answer the same line.
  const stop = fakeInteraction({ user: SAM, customId: 'leads-stop' });
  await b.ask.press({ ...stop, roles: [] });
  assert.deepEqual(stop.replies, [line]);
  // A mention gets nothing: no reply, no thread, no post.
  const m = fakeMention({ user: SAM, roles: [], channelId: ASK, content: '<@1> board', place: fakeDiscord([]) });
  await b.ask.mention(m);
  assert.deepEqual([m.replies, m.place.posts], [[], []]);
  assert.equal(readFileSync(b.path, 'utf8'), before);
  assert.equal(b.fake.posts.length, posts);
});

test('a crew member cannot approve or decline; the owner can decline with a reason that the thread shows', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const card = b.r().card;
  const drawn = b.fake.messages.get(card).length; // the post, and the edit of the draw that posted it (F-T228-11)
  for (const user of [MAYA, JON]) {
    for (const id of ['rq1:approve:RQ1', 'rq1:decline:RQ1']) assert.deepEqual((await b.press(user, id, { message: card }))[0].content, 'Only Erick approves or declines a request. Nothing changed.');
    assert.deepEqual((await b.press(user, 'rq1:decline!:RQ1', { message: card, fields: { reason: 'no' } }))[0].content, 'Only Erick approves or declines a request. Nothing changed.');
  }
  assert.equal(b.r().status, 'pending');
  assert.deepEqual(b.tasks(), []);
  assert.equal(b.fake.messages.get(card).length, drawn); // no refused press edited the card

  const form = await b.press(OWNER, 'rq1:decline:RQ1', { message: card });
  assert.deepEqual([form[0].kind, form[0].custom_id], ['modal', 'rq1:decline!:RQ1']);
  const declined = await b.press(OWNER, 'rq1:decline!:RQ1', { message: card, fields: { reason: 'We plan it for January.' } });
  assert.deepEqual(declined.map((x) => x.kind), ['defer', 'editReply']);
  assert.equal(declined[1].content, 'You declined RQ1. Its thread says so. Nothing goes to sage.');
  assert.deepEqual([b.r().status, b.r().reason, b.r().decidedBy], ['declined', 'We plan it for January.', OWNER]);
  assert.match(b.status(b.card().embeds[0]), /^\*\*Declined by Erick at <t:\d+:t>\.\*\*\nReason: We plan it for January\.$/);
  assert.match(b.line().content, / · RQ1 · declined by Erick$/);
  assert.match(b.fake.latest(b.fake.in(b.r().thread)[1]).content, /^\*\*Declined\.\*\* Nothing goes to sage\. Jon can send a new request/);
  assert.deepEqual(b.tasks(), []);
});

test('withdraw: only the requester, only while it waits, with a confirm that expires', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const card = b.r().card;
  const notJon = 'Only Jon, who sent RQ1, can withdraw it. Nothing changed.';
  assert.equal((await b.press(MAYA, 'rq1:withdraw:RQ1', { message: card }))[0].content, notJon);
  assert.equal((await b.press(OWNER, 'rq1:withdraw:RQ1', { message: card }))[0].content, notJon); // the owner declines instead
  assert.equal((await b.press(MAYA, 'rq1:withdraw!:RQ1', { message: '900000000000000099', sentAt: b.now }))[0].content, notJon);
  const confirm = await b.press(JON, 'rq1:withdraw:RQ1', { message: card });
  assert.equal(confirm[0].flags, PRIVATE);
  assert.deepEqual(confirm[0].components[0].components.map((c) => c.custom_id), ['rq1:withdraw!:RQ1', 'rq1:keep:RQ1']);
  assert.equal((await b.press(JON, 'rq1:keep:RQ1', { message: '900000000000000099' }))[0].content, 'RQ1 stays as it is. Nothing changed.');
  // A confirm older than 10 minutes changes nothing.
  const old = await b.press(JON, 'rq1:withdraw!:RQ1', { message: '900000000000000099', sentAt: b.now - 11 * 60_000 });
  assert.deepEqual([old[0].kind, old[0].content], ['update', 'This confirm expired after 10 minutes. Nothing changed. Press Withdraw on the card again.']);
  assert.equal(b.r().status, 'pending');
  const done = await b.press(JON, 'rq1:withdraw!:RQ1', { message: '900000000000000099', sentAt: b.now });
  assert.deepEqual(done.map((x) => x.kind), ['deferUpdate', 'editReply']);
  assert.equal(done[1].content, 'You withdrew RQ1. Nothing goes to sage. You can send a new request at once.');
  assert.deepEqual([b.r().status, b.r().decidedBy], ['withdrawn', JON]);
  assert.match(b.status(b.card().embeds[0]), /^\*\*Withdrawn by Jon at <t:\d+:t>\.\*\* Nothing goes to sage\.$/);
  // Only while it waits: the same confirm again, and Withdraw on a decided request, get the late note.
  const again = await b.press(JON, 'rq1:withdraw!:RQ1', { message: '900000000000000099', sentAt: b.now });
  assert.deepEqual([again[0].kind, again[0].content], ['update', `RQ1 was withdrawn at ${t(b.now)} meanwhile. Nothing changed.`]);
  await b.request(JON, { title: 'Add PDF export' });
  await b.press(OWNER, 'rq1:approve:RQ2', { message: b.r('RQ2').card });
  assert.equal((await b.press(JON, 'rq1:withdraw:RQ2', { message: b.r('RQ2').card }))[0].content, `RQ2 was approved at ${t(b.now)} meanwhile. Nothing changed.`);
  assert.equal(b.r('RQ2').status, 'approved');
});

test('a forged or replayed button id does nothing', async (tt) => {
  const b = world(tt);
  const { key } = await b.draft(JON);
  // Another person's draft key, and a draft key that never was, open nothing and send nothing.
  const gone = 'This request form is gone: it expired, or sage-bot restarted. Nothing was sent. Type /sage request again.';
  assert.equal((await b.press(MAYA, `rq1:send-team:${key}`))[0].content, gone);
  assert.equal((await b.press(JON, 'rq1:send-team:D12345'))[0].content, gone);
  assert.equal(b.file().requests.length, 0);
  await b.press(JON, `rq1:send-owner:${key}`);
  // A replayed Send: the draft is gone, so no second request, line or card.
  assert.equal((await b.press(JON, `rq1:send-owner:${key}`))[0].content, gone);
  assert.equal(b.file().requests.length, 1);
  assert.equal(b.fake.posts.length, 2);
  const r = b.r();
  // Ids outside the allow-list get nothing at all; a request that is not in the file gets its refusal.
  for (const id of ['rq2:approve:RQ1', 'rq1:approve:RQ01', 'rq1:merge:RQ1', 'rq1:approve:RQ1:x', 'press:project/G1:0:0', 'rq1:send-team:RQ1', 'rq1:approve:D1']) {
    assert.deepEqual(await b.press(OWNER, id, { message: r.card }), [], id);
  }
  assert.match((await b.press(OWNER, 'rq1:approve:RQ9', { message: r.card }))[0].content, /^there is no request RQ9 \(the latest: RQ1\)\. Nothing changed\.$/);
  // The button of a card counts only on that card's own message: the line, a copy or another message do nothing.
  for (const message of [r.line, '900000000000000099', undefined]) {
    assert.equal((await b.press(OWNER, 'rq1:approve:RQ1', { message }))[0].content, 'This button is not on the card of RQ1. Nothing changed.');
  }
  assert.deepEqual(b.tasks(), []);
  await b.press(OWNER, 'rq1:approve:RQ1', { message: r.card });
  // A replayed Approve is single use: the late note, and still one task.
  const replay = await b.press(OWNER, 'rq1:approve:RQ1', { message: r.card });
  assert.equal(replay[0].content, `RQ1 was approved at ${t(b.now)} meanwhile. Nothing changed.`);
  assert.deepEqual(b.tasks(), [`RQ1: ${TITLE}`]);
});

test('the routes send a request press in any registered channel to the requests, with the role names of the member', async () => {
  const calls = [];
  const on = routes({ config: { guildId: '500000000000000001', channelId: '400000000000000001' }, ask: {}, bridge: { interaction: () => calls.push('bridge') },
    requests: { interaction: (x) => calls.push(x) }, fetch: async () => null, botId: '1', guildRoles: new Map([['300000000000000001', { name: CREW }]]) });
  const press = (customId, guildId = '500000000000000001') => ({
    guildId, customId, channelId: '400000000000000009', user: { id: JON, bot: false }, member: { roles: ['300000000000000001'] },
    message: { id: '900000000000000001', createdTimestamp: T0 }, isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, isButton: () => true, isModalSubmit: () => false,
  });
  await on.interaction(press('rq1:approve:RQ1'));
  await on.interaction(press('rq1:approve:RQ1', '500000000000000002')); // another guild: nothing
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].user, calls[0].roles, calls[0].customId, calls[0].message], [{ id: JON, bot: false }, [CREW], 'rq1:approve:RQ1', { id: '900000000000000001', createdTimestamp: T0 }]);
});

test('a decision made at the terminal shows on the card and the line at the next loop, once', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  // The terminal runs the same approve as scripts/requests.mjs approve.
  await approve(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.tool, now: () => b.now });
  assert.equal(b.status(b.card().embeds[0]), 'Waiting for Erick'); // Discord has not changed yet
  await b.flow.loop();
  assert.match(b.status(b.card().embeds[0]), /^\*\*Approved by Erick \(terminal\) at <t:\d+:t>\. sage task T1 is in the sage logbook\.\*\*$/);
  assert.deepEqual(b.card().components, []);
  assert.match(b.line().content, / · RQ1 · approved · sage task T1$/);
  assert.equal(b.fake.in(b.r().thread).length, 2);
  assert.equal(b.r().shown, 'approved');
  const edits = [...b.fake.messages.values()].reduce((n, m) => n + m.length, 0);
  await b.flow.loop();
  assert.equal([...b.fake.messages.values()].reduce((n, m) => n + m.length, 0), edits); // nothing more
});

test('a restart settles a dead claim: waits 2 minutes, then waits again with its buttons, or is approved when the logbook has its task; the bridge settles its own failed approve', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  await b.request(MAYA, { title: 'Add PDF export' });
  // A claim of a bridge that is gone: a pid of a process that ended.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const file = JSON.parse(readFileSync(b.path, 'utf8'));
  for (const r of file.requests) Object.assign(r, { status: 'approving', claim: { by: OWNER, via: 'discord', pid: dead, start: 'Mon Oct  5 10:00:00 2026', at: b.now } });
  writeFileSync(b.path, JSON.stringify(file));
  b.sh('task', 'add', '--title', 'RQ2: Add PDF export', '--size', 'large'); // RQ2's tool added its task before the crash
  b.flow = b.make(); // the restart
  await b.flow.loop();
  assert.deepEqual([b.r('RQ1').status, b.r('RQ2').status, b.r('RQ2').task], ['approving', 'approved', 'T1']);
  assert.equal(b.status(b.card('RQ1').embeds[0]), 'Being approved by Erick');
  assert.ok(b.card('RQ1').components[0].components.every((c) => c.disabled));
  assert.match(b.status(b.card('RQ2').embeds[0]), /^\*\*Approved by Erick at /);
  b.now += RETRY_AFTER + 1;
  await b.flow.loop();
  assert.equal(b.r('RQ1').status, 'pending');
  assert.equal(b.status(b.card('RQ1').embeds[0]), 'Waiting for Erick');
  assert.ok(b.card('RQ1').components[0].components.every((c) => !c.disabled));

  // This bridge's own approve fails, and the logbook cannot be read either: the claim stays, and the loop settles it later.
  const good = b.tool;
  let reads = 0; // the first read (before the claim) works; the read after the failed add does not
  b.tool = { tasks: async () => { if (reads++) throw new Error('sample: no logbook'); return good.tasks(); }, addTask: async () => { throw new Error('sample: refused'); } };
  const failed = await b.press(OWNER, 'rq1:approve:RQ1', { message: b.r('RQ1').card });
  // Not a refusal: a fixed line on Discord, and the details in the terminal log (F-T228-5).
  assert.equal(failed[1].content, 'Something went wrong on the bridge, so I could not do this. Erick sees the details at the terminal.');
  assert.match(b.lines.at(-1), /^RQ1: could not add the task of RQ1 \(sample: refused\), and could not read the logbook\. RQ1 stays being approved since /);
  assert.equal(b.r('RQ1').status, 'approving');
  b.tool = good;
  await b.flow.loop();
  assert.equal(b.r('RQ1').status, 'approving'); // its tool could still add the task for 2 minutes
  b.now += RETRY_AFTER + 1;
  await b.flow.loop();
  assert.equal(b.r('RQ1').status, 'pending');
  assert.equal(b.status(b.card('RQ1').embeds[0]), 'Waiting for Erick');
});

test('the kill switch refreshes the open cards and lines at the next loop, and again when the link is on', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  await b.request(MAYA, { title: 'Add PDF export' });
  await b.press(OWNER, 'rq1:approve:RQ2', { message: b.r('RQ2').card });
  const approvedEdits = b.fake.messages.get(b.r('RQ2').card).length;
  setLinkOff(b.killPath, MAYA, b.now);
  await b.flow.loop();
  const off = b.card().embeds[0].fields.map((f) => f.name);
  assert.ok(off.includes('The link from Discord to sage is off'));
  assert.deepEqual(b.card().components[0].components.map((c) => [c.label, c.disabled]), [['Approve', true], ['Decline', false], ['Withdraw', false]]);
  assert.match(b.line().content, / · RQ1 · waiting for Erick · the link to sage is off$/);
  assert.equal(b.fake.messages.get(b.r('RQ2').card).length, approvedEdits); // a decided card stays as it is
  // An Approve press while the link is off changes nothing.
  const refused = await b.press(OWNER, 'rq1:approve:RQ1', { message: b.r().card });
  assert.match(refused[1].content, /^the link from Discord to sage is off, so RQ1 cannot be approved\./);
  assert.equal(b.r().status, 'pending');
  restoreLink(b.killPath);
  await b.flow.loop();
  assert.equal(b.card().embeds[0].fields.some((f) => f.name === 'The link from Discord to sage is off'), false);
  assert.equal(b.card().components[0].components[0].disabled, false);
  assert.match(b.line().content, / · RQ1 · waiting for Erick$/);
});

test('/sage request refuses before the form: the link off, an open request, an unknown project, a name the file cannot keep; and the hourly limit', async (tt) => {
  const b = world(tt);
  const only = (replies) => { assert.equal(replies.length, 1); assert.equal(replies[0].kind, 'reply'); assert.equal(replies[0].flags, PRIVATE); return replies[0].content; };
  assert.equal(only(await b.cmd(JON, 'request', { name: 'x'.repeat(101) })),
    'Your name in this server has 101 characters, and a request takes a name of 1 to 100. Change your server nickname, then try again. Nothing was sent.');
  assert.equal(only(await b.cmd(JON, 'request', { name: '' })),
    'Your name in this server has 0 characters, and a request takes a name of 1 to 100. Change your server nickname, then try again. Nothing was sent.');
  assert.equal(only(await b.cmd(JON, 'request', { options: { project: 'payroll' } })), 'I do not know a shared project called "payroll". Nothing was sent.');
  assert.equal(only(await b.cmd(JON, 'request', { options: { project: '**x** <@&1>' } })), 'I do not know a shared project called "\\*\\*x\\*\\* \\<@&1\\>". Nothing was sent.');
  assert.equal(only(await b.cmd(JON, 'request', { channelId: '400000000000000003' })), `I take requests in <#${ASK}> and the other channels of sage-bot, so please ask there.`);
  await b.request(JON);
  assert.equal(only(await b.cmd(JON)), `You have an open request: RQ1 · ${TITLE}, waiting for Erick since ${t(b.now)} in <#${b.r().thread}>. A sage-crew member can have 1 open request at a time on sage-bot. Withdraw it in its thread, or wait for Erick's answer.`);
  // A /sage request in a thread of the project channel opens the form, and the line goes to the channel.
  const inThread = await b.cmd(MAYA, 'request', { channelId: b.r().thread, parentId: ASK });
  assert.equal(inThread[0].kind, 'modal');
  setLinkOff(b.killPath, MAYA, b.now);
  assert.equal(only(await b.cmd(OWNER)), requestNote('linkOff', US).content);
  restoreLink(b.killPath);
  for (let n = 0; n < 9; n++) await b.cmd(MAYA, 'board'); // with the request in the thread: 10 asks of Maya in the hour
  assert.match(only(await b.cmd(MAYA)), /^You asked 10 times in the last hour; that is the limit\./);
});

test('/sage board lists the open requests of its project, oldest first, with their threads, and no decided one', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  await b.request(MAYA, { title: 'Add *PDF* export <@&1>' });
  await b.request(OWNER, { title: 'Dark mode for the board' });
  await b.press(OWNER, 'rq1:approve:RQ3', { message: b.r('RQ3').card });
  const board = await b.cmd(MAYA, 'board');
  assert.deepEqual(board.map((x) => x.kind), ['defer', 'edit']);
  assert.deepEqual(board[1].allowedMentions, QUIET);
  const lines = board[1].content.split('\n');
  assert.deepEqual(lines.slice(3, 6), [
    '2 open request(s):',
    `- RQ1 · ${TITLE} · by Jon · waiting for Erick · <#${b.r('RQ1').thread}>`,
    `- RQ2 · Add \\*PDF\\* export \\<@&1\\> · by Maya · waiting for Erick · <#${b.r('RQ2').thread}>`,
  ]);
  assert.equal(lines[6], '0 open question(s).');
});

test('the late note never shows 1 Jan 1970: a request being approved names the time of its claim (T240, R956)', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const claimAt = b.now + 5_000;
  const note = requestNote('late', US, { ...b.r(), status: 'approving', claim: { by: OWNER, via: 'discord', pid: 1, start: 'x', at: claimAt } }).content;
  assert.equal(note, `RQ1 is being approved since ${t(claimAt)}. Nothing changed.`);
  assert.doesNotMatch(note, /<t:0:/);
  // On Discord: a Decline while the owner's approve runs.
  let release;
  b.tool = { ...b.tool, tasks: b.tool.tasks, addTask: () => new Promise((done) => { release = () => done('T1'); }) };
  b.now = claimAt;
  const running = b.press(OWNER, 'rq1:approve:RQ1', { message: b.r().card });
  while (b.r().status !== 'approving') await new Promise((r) => setTimeout(r, 5));
  const late = await b.press(OWNER, 'rq1:decline:RQ1', { message: b.r().card });
  assert.equal(late[0].content, `RQ1 is being approved since ${t(claimAt)}. Nothing changed.`);
  release();
  await running;
  for (const r of b.file().requests) assert.notEqual(r.decidedAt, 0);
});

/** Holds the requests file's lock as a live process that is not the bridge does (the test runner), until `free`. */
const hold = (b) => { writeFileSync(`${b.path}.lock`, String(process.ppid)); return () => rmSync(`${b.path}.lock`); };
const pings = (b) => b.fake.posts.filter((p) => p.content === `<@${OWNER}> a new request waits for you.`).length;

test('F-T228-6: a post that the requests file does not take is not posted again; the error is logged once; after the cause clears: 1 line, 1 thread, 1 card, 1 ping, 1 post after the decision', async (tt) => {
  for (const what of ['line', 'card', 'decided']) {
    const b = world(tt);
    let free;
    const is = { line: (p) => p.content?.startsWith('**Jon'), card: (p) => p.embeds, decided: (p) => p.content?.startsWith('**Approved.**') }[what];
    b.onPost = (p) => { if (is(p) && !free) free = hold(b); };
    await b.request(JON);
    if (what === 'decided') await approve(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.tool, now: () => b.now });
    await b.flow.loop();
    await b.flow.loop();
    assert.ok(free, what);
    assert.equal(b.fake.posts.filter(is).length, 1, `${what}: posted once while the file takes no write`);
    assert.equal(b.lines.filter((l) => l.includes(`holds ${b.path}.lock`)).length, 1, what); // logged, once
    free();
    await b.flow.loop();
    await b.flow.loop();
    const r = b.r();
    assert.deepEqual(b.fake.in(ASK), [r.line], what);
    assert.deepEqual([...b.fake.threads.keys()], [r.thread], what);
    assert.equal(b.fake.in(r.thread)[0], r.card, what);
    assert.equal(b.fake.in(r.thread).length, what === 'decided' ? 2 : 1, what);
    assert.equal(pings(b), 1, what);
    assert.equal(r.shown, what === 'decided' ? 'approved' : 'pending', what);
  }
});

test('F-T228-4: a card post whose reply Discord lost is not posted again: the next loop gets the same card by its nonce, and the owner gets 1 ping', async (tt) => {
  const b = world(tt);
  let lost = false;
  b.onPost = (p) => { if (p.embeds && !lost) { lost = true; throw Object.assign(new Error('sample: the reply was lost'), { code: 'ECONNRESET' }); } };
  await b.request(JON);
  assert.equal(b.r().card, null);
  await b.flow.loop();
  const r = b.r();
  assert.deepEqual(b.fake.in(r.thread), [r.card]);
  assert.equal(pings(b), 1);
});

test('F-T228-7: a thread whose reply Discord lost is found again (code 160004): 1 thread, and the card is in it', async (tt) => {
  const b = world(tt);
  let lost = false;
  b.onThread = () => { if (!lost) { lost = true; throw Object.assign(new Error('sample: the reply was lost'), { code: 'ECONNRESET' }); } };
  await b.request(JON);
  assert.deepEqual([b.r().line !== null, b.r().thread], [true, null]);
  await b.flow.loop();
  const r = b.r();
  assert.deepEqual([...b.fake.threads.keys()], [r.thread]);
  assert.deepEqual(b.fake.in(r.thread), [r.card]);
  assert.equal(pings(b), 1);
});

test('F-T228-8: a decision and the kill switch show on the card of a thread that Discord archived: the bridge opens the thread again first', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  await b.request(MAYA, { title: 'Add PDF export' });
  b.fake.archive(b.r('RQ1').thread);
  b.fake.archive(b.r('RQ2').thread);
  setLinkOff(b.killPath, MAYA, b.now);
  await b.flow.loop();
  assert.ok(b.card('RQ2').embeds[0].fields.some((f) => f.name === 'The link from Discord to sage is off'));
  restoreLink(b.killPath);
  await b.flow.loop();
  b.fake.archive(b.r('RQ1').thread);
  await approve(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.tool, now: () => b.now });
  await b.flow.loop();
  assert.match(b.status(b.card().embeds[0]), /^\*\*Approved by Erick \(terminal\)/);
  assert.deepEqual(b.card().components, []);
  assert.equal(b.fake.in(b.r().thread).length, 2); // the card and the post after the decision
  assert.equal(b.fake.threads.get(b.r().thread).archived, false);
});

test('F-T228-5: a press during a file error gets a fixed line, with no path; the terminal log has the details', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const card = b.r().card;
  chmodSync(b.path, 0o644); // a requests file that is not the 0600 file sage-bot wrote
  const replies = await b.press(JON, 'rq1:withdraw:RQ1', { message: card });
  assert.deepEqual(replies.map((x) => [x.kind, x.flags, x.content]),
    [['reply', PRIVATE, 'Something went wrong on the bridge, so I could not do this. Erick sees the details at the terminal.']]);
  assert.ok(b.lines.some((l) => l.startsWith('RQ1: ') && l.includes(b.path)));
});

test('F-T228-3: when Discord refuses the line at Send, the "Sent" note names the channel where its thread opens', async (tt) => {
  const b = world(tt);
  let refused = false;
  b.onPost = () => { if (!refused) { refused = true; throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); } };
  const sent = await b.press(JON, `rq1:send-team:${(await b.draft(JON)).key}`);
  assert.equal(sent[1].content, `Sent to Erick as RQ1. Its thread opens soon from its line in <#${ASK}>. You can withdraw it there until Erick decides.`);
});

test('T241 F-T241-8: the open request threads are unknown (null), not none, while the request file cannot be read', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  await b.flow.loop();
  assert.deepEqual(b.flow.threads(), [b.r().thread]);
  writeFileSync(b.path, 'not a request file');
  assert.equal(b.flow.threads(), null);
});

test('F-T228-9: an Approve whose project left the config gets a note with no folder path; the terminal log has the full text', async (tt) => {
  const b = world(tt);
  mkdirSync(join(b.root, 'other'));
  // The config now serves only another folder (the project left it), or names a folder that is gone (the config cannot be read).
  const cases = [
    [join(b.root, 'other'), 'the project project is not in the config. Add it back, or decline RQ1.', b.project],
    [join(b.root, 'gone'), 'the projects in the config cannot be read now. The details are at the terminal. Nothing changed.', join(b.root, 'gone')],
  ];
  await b.request(JON);
  for (const [folder, note, path] of cases) {
    b.flow = b.make((r) => toolOf({ ...b.config, project: folder }, r));
    b.lines.length = 0;
    const replies = await b.press(OWNER, 'rq1:approve:RQ1', { message: b.r().card });
    assert.deepEqual(replies.map((x) => [x.kind, x.content]), [['defer', undefined], ['editReply', note]]);
    assert.ok(!JSON.stringify(replies).includes(b.root), folder); // no folder path reaches Discord
    assert.ok(b.lines.some((l) => l.startsWith('RQ1: ') && l.includes(path)), folder); // the full text is in the terminal log
    assert.equal(b.r().status, 'pending');
  }
});

test('F-T228-10: a thread that a moderator locked and archived stays locked and archived; the edit of its card is skipped and logged', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const thread = b.r().thread;
  const before = b.fake.messages.get(b.r().card).length;
  await b.fake.setLocked(thread, true); // a moderator locks the thread: Discord archives it too
  await approve(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.tool, now: () => b.now });
  await b.flow.loop();
  await b.flow.loop();
  assert.deepEqual([b.fake.threads.get(thread).archived, b.fake.threads.get(thread).locked], [true, true]);
  assert.equal(b.fake.messages.get(b.r().card).length, before); // the card is as it was
  assert.match(b.line().content, /approved/); // the line in the channel shows the decision
  assert.equal(b.lines.filter((l) => l.startsWith('Discord refused the edit of the card of RQ1')).length, 1);
});

test('F-T228-11: when the id write of the line or the card fails and the link goes off before the retry, the line and the card show the link off at the next loop', async (tt) => {
  for (const what of ['line', 'card']) {
    const b = world(tt);
    let free;
    const is = { line: (p) => p.content?.startsWith('**Jon'), card: (p) => p.embeds }[what];
    b.onPost = (p) => { if (is(p) && !free) free = hold(b); };
    await b.request(JON);
    assert.equal(b.r()[what], null, what); // the post is on Discord; the file did not take its id
    setLinkOff(b.killPath, MAYA, b.now);
    free();
    await b.flow.loop(); // writes the id
    await b.flow.loop();
    assert.ok(b.card().embeds[0].fields.some((f) => f.name === 'The link from Discord to sage is off'), what);
    assert.match(b.line().content, /· the link to sage is off$/, what);
    // The card pings only while the link is on (requestCard): it was posted before the link went off, or after it.
    assert.equal(pings(b), what === 'card' ? 1 : 0, what);
  }
});

// Repair round 1 of PR 71 (R1086): C1, C2, S2, S3 and Q2.
test('C1: a restart between the post of the line or the card and the write of its id, while the link goes off: Discord gives back the old post by its nonce, and the next loop shows the link off', async (tt) => {
  for (const what of ['line', 'card']) {
    const b = world(tt);
    let free;
    const is = { line: (p) => p.content?.startsWith('**Jon'), card: (p) => p.embeds }[what];
    b.onPost = (p) => { if (is(p) && !free) free = hold(b); };
    await b.request(JON);
    assert.equal(b.r()[what], null, what); // the post is on Discord; the file did not take its id
    setLinkOff(b.killPath, MAYA, b.now);
    b.flow = b.make(); // a restart: what the last process kept in memory is gone
    free();
    await b.flow.loop(); // posts again with the same nonce: Discord gives back the old message, which shows the link on
    await b.flow.loop();
    assert.deepEqual(b.fake.in(ASK), [b.r().line], what); // one line
    assert.match(b.line().content, /· the link to sage is off$/, what);
    assert.ok(b.card().embeds[0].fields.some((f) => f.name === 'The link from Discord to sage is off'), what);
  }
});

test('C2: when Discord refuses to open an archived thread (50013), the edit of the card is skipped and logged once, and the post after the decision still comes', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const thread = b.r().thread;
  b.onUnarchive = () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); };
  b.fake.archive(thread);
  await approve(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.tool, now: () => b.now });
  await b.flow.loop();
  await b.flow.loop();
  assert.equal(b.r().shown, 'approved');
  assert.equal(b.fake.in(thread).length, 2); // the card and the post after the decision
  assert.match(b.fake.latest(b.fake.in(thread)[1]).content, /^\*\*Approved\.\*\*/);
  assert.match(b.line().content, /approved/);
  assert.equal(b.lines.filter((l) => l.startsWith('Discord refused to open the thread of the card of RQ1: ')).length, 1);
});

test('S2: a Refused needs its line for Discord; the approve refused while the link is off names no command or path on Discord', async (tt) => {
  assert.throws(() => new Refused('the terminal text'), TypeError);
  assert.equal(new Refused('at /Users/someone/project', 'on Discord').forDiscord, 'on Discord');
  const b = world(tt);
  await b.request(JON);
  setLinkOff(b.killPath, MAYA, b.now);
  const replies = await b.press(OWNER, 'rq1:approve:RQ1', { message: b.r().card });
  assert.deepEqual(replies.map((x) => [x.kind, x.content]), [['defer', undefined],
    ['editReply', 'the link from Discord to sage is off, so RQ1 cannot be approved. Restore the link at the terminal first. Nothing changed.']]);
  assert.ok(b.lines.includes('RQ1: the link from Discord to sage is off, so RQ1 cannot be approved. Restore the link first: node scripts/leads.mjs restore. Nothing changed.'));
});

test('S3: no post after the decision in a thread that a moderator locked, although sage-bot could post there; the line in the channel shows the decision', async (tt) => {
  const b = world(tt);
  b.manage = true; // sage-bot has Manage Threads: Discord takes its post in a locked thread and opens the thread
  await b.request(JON);
  const thread = b.r().thread;
  await b.fake.setLocked(thread, true);
  await approve(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.tool, now: () => b.now });
  await b.flow.loop();
  await b.flow.loop();
  assert.deepEqual([b.fake.threads.get(thread).archived, b.fake.threads.get(thread).locked], [true, true]);
  assert.deepEqual(b.fake.in(thread), [b.r().card]); // no post after the decision
  assert.equal(b.r().shown, 'approved');
  assert.match(b.line().content, /approved/);
});

test('Q2: a card edit skipped in a locked thread waits, with one read of the lock a loop, and shows the decision once a moderator unlocks the thread', async (tt) => {
  const b = world(tt);
  await b.request(JON);
  const thread = b.r().thread;
  await b.fake.setLocked(thread, true);
  await approve(b.config, 'RQ1', { by: 'owner', via: 'terminal', tool: b.tool, now: () => b.now });
  await b.flow.loop();
  assert.ok(b.card().components.length > 0); // the card still has its buttons: the thread is locked
  for (let n = 0; n < 3; n += 1) {
    const reads = b.lockReads;
    await b.flow.loop();
    assert.equal(b.lockReads - reads, 1, `loop ${n}`); // one read of the lock, and no edit
  }
  await b.fake.setLocked(thread, false); // a moderator unlocks the thread
  b.fake.archive(thread); // it is still quiet
  await b.flow.loop();
  assert.match(b.status(b.card().embeds[0]), /^\*\*Approved by Erick \(terminal\)/);
  assert.deepEqual(b.card().components, []);
  const reads = b.lockReads;
  await b.flow.loop();
  assert.equal(b.lockReads, reads); // nothing waits now
});
