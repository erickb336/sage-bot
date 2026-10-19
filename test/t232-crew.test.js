// T232: one shared role found by its NAME, sage-crew, and the owner by user id (C1, C10, C12). The crew answers and votes; only the
// owner ends a vote early or breaks a tie, never a role. The owner comes from the config's ownerId, else from the Discord application.
// The role keys of before T232 start with a warning and do nothing.
// SAMPLE DATA ONLY: every id and name is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, ClientApplication, GatewayIntentBits } from 'discord.js';
import { tempFolder } from './temp-folder.js';
import { CREW, crewWarning, oldRoleKeys, ownerOf, placeOf } from '../src/crew.js';
import { appOf, rolesOf, watchCrew } from '../src/discord.js';
import { createBridge } from '../src/bridge.js';
import { fakeCommand, fakeDiscord, fakeMention } from '../src/fake-discord.js';
import { askCommand, createAsk, STOP, STOP_CANCEL } from '../src/ask.js';
import { auditPathOf, killPathOf, verifyLog } from '../src/audit.js';
import { openChannels, withHome } from '../src/channels.js';
import { loadProjects } from '../src/projects.js';
import { LINK_OFF } from '../src/threads.js';
import { peopleOf } from '../src/handle.js';
import { MINUTE, openGate, step } from '../src/vote.js';
import { CHANNEL, CONFIG, CREW_ROLE, JON, MAYA, OWNER, SAGE, SAM, setup, spawnSync, T0 } from './bridge-setup.js';

const ROOT = new URL('..', import.meta.url).pathname;
const GUILD = '200000000000000001';
const [CREW_B, RENAMED, MODS] = ['300000000000000007', '300000000000000008', '300000000000000009'];

/** A real discord.js guild with no login: the roles as Discord sends them, so rolesOf reads discord.js's own role cache. */
function guildOf(roles) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const guild = client.guilds._add({ id: GUILD, name: 'sample', members: [], roles: [{ id: GUILD, name: '@everyone', permissions: '0', position: 0 },
    ...roles.map(([id, name], i) => ({ id, name, permissions: '0', position: i + 1 }))] });
  return { client, guild };
}

test('placeOf, over the role names of a member: only a role named exactly sage-crew makes the crew; only the owner\'s id makes the owner', () => {
  const rows = [
    // [the case, user id, role names, { owner, crew }]
    ['no role', MAYA, [], { owner: false, crew: false }],
    ['the sage-crew role', MAYA, [CREW], { owner: false, crew: true }],
    ['the sage-crew role among others', MAYA, ['Moderators', CREW], { owner: false, crew: true }],
    ['a role renamed away from sage-crew', MAYA, ['sage-crew-old'], { owner: false, crew: false }],
    ['another case of the name', MAYA, ['Sage-Crew'], { owner: false, crew: false }],
    ['the name with a space after it', MAYA, ['sage-crew '], { owner: false, crew: false }],
    ['two roles with the same name', MAYA, [CREW, CREW], { owner: false, crew: true }],
    ['the owner without a role', OWNER, [], { owner: true, crew: false }],
    ['the owner with the sage-crew role', OWNER, [CREW], { owner: true, crew: true }],
    ['a role named like the old sage-lead role', JON, ['sage-lead'], { owner: false, crew: false }],
  ];
  for (const [what, id, names, want] of rows) assert.deepEqual(placeOf(id, names, OWNER), want, what);
  assert.deepEqual(placeOf(OWNER, [CREW], undefined), { owner: false, crew: true }, 'no owner id makes nobody the owner');
});

test('rolesOf reads the names from discord.js\'s role cache: two roles named sage-crew both count, and a rename counts at once', () => {
  const { client, guild } = guildOf([[CREW_ROLE, CREW], [CREW_B, CREW], [RENAMED, CREW], [MODS, 'Moderators']]);
  try {
    const joined = new Date(0).toISOString();
    const maya = guild.members._add({ user: { id: MAYA, username: 'maya' }, roles: [CREW_ROLE], joined_at: joined });
    const jon = guild.members._add({ user: { id: JON, username: 'jon' }, roles: [CREW_B, MODS], joined_at: joined });
    const sam = guild.members._add({ user: { id: SAM, username: 'sam' }, roles: [RENAMED], joined_at: joined });
    const crew = () => [maya, jon, sam].filter((m) => placeOf(m.id, rolesOf(m), OWNER).crew).map((m) => m.id);
    assert.deepEqual(crew(), [MAYA, JON, SAM]);
    guild.roles.cache.get(RENAMED)._patch({ id: RENAMED, name: 'former crew', permissions: '0', position: 3 }); // what Discord's role update does
    assert.deepEqual(crew(), [MAYA, JON]);
    // The raw API member of an interaction has role ids only; the guild's roles give their names.
    assert.deepEqual(rolesOf({ roles: [CREW_B, RENAMED, '300000000000000099'] }, guild.roles.cache), [CREW, 'former crew']);
    assert.equal(crewWarning(guild.roles.cache.values()), `2 roles are named ${CREW} (${CREW_ROLE}, ${CREW_B}): each member of any of them is in the crew. Delete or rename all but one.`);
  } finally {
    client.destroy();
  }
});

test('watchCrew: one warning line in the log and #sage-audit when two roles share the name, again only after the name was unique', async () => {
  const roles = [{ id: CREW_ROLE, name: CREW }];
  const lines = [];
  const posts = [];
  const check = watchCrew(() => roles, { log: (l) => lines.push(l), audit: async (p) => { posts.push(p); } });
  assert.deepEqual([lines, posts], [[], []]);
  roles.push({ id: CREW_B, name: CREW });
  check();
  check(); // a second role event with the same two roles says nothing more
  const warning = `2 roles are named ${CREW} (${CREW_ROLE}, ${CREW_B}): each member of any of them is in the crew. Delete or rename all but one.`;
  assert.deepEqual(lines, [warning]);
  assert.deepEqual(posts, [{ content: warning, allowedMentions: { parse: [] } }]);
  roles.pop();
  check();
  roles.push({ id: CREW_B, name: CREW });
  check();
  assert.equal(posts.length, 2);
  const none = [];
  watchCrew(() => [{ id: MODS, name: 'Moderators' }], { log: (l) => none.push(l) });
  assert.deepEqual(none, [`no role of the server is named ${CREW}: only the owner can use sage-bot until a role has that name`]);
});

test('ownerOf with a fake Discord application: user-owned, team-owned with and without ownerId, and a warning when they differ', () => {
  const client = new Client({ intents: [] });
  try {
    const userApp = appOf(new ClientApplication(client, { id: '1', name: 'sage-bot', owner: { id: OWNER, username: 'erick' } }));
    const teamApp = appOf(new ClientApplication(client, { id: '1', name: 'sage-bot', owner: { id: '9', username: 'team' },
      team: { id: '7', name: 'the team', owner_user_id: JON, members: [] } }));
    assert.deepEqual(userApp, { owner: { id: OWNER }, team: null });
    assert.deepEqual(teamApp, { owner: null, team: { ownerId: JON } });
    assert.deepEqual(ownerOf(undefined, userApp), { ownerId: OWNER, warning: null }, 'user-owned: the app owner');
    assert.deepEqual(ownerOf(OWNER, userApp), { ownerId: OWNER, warning: null }, 'the config agrees');
    assert.deepEqual(ownerOf(MAYA, userApp), { ownerId: MAYA,
      warning: `the config's ownerId ${MAYA} is not the owner of the Discord application (${OWNER}): sage-bot takes ${MAYA} as its owner` }, 'the config wins, with a warning');
    assert.deepEqual(ownerOf(OWNER, teamApp), { ownerId: OWNER,
      warning: `the config's ownerId ${OWNER} is not the owner of the Discord application (${JON}): sage-bot takes ${OWNER} as its owner` }, 'team-owned with the config');
    assert.throws(() => ownerOf(undefined, teamApp), { message: 'the Discord application of sage-bot belongs to a Developer Team, so sage-bot cannot tell who its owner is. Add "ownerId" with your Discord user id to the config, then start sage-bot again. Nothing was started.' });
    assert.throws(() => ownerOf(undefined, { owner: null, team: null }), /Add "ownerId" with your Discord user id to the config/);
  } finally {
    client.destroy();
  }
});

test('C1 in the vote rules: a crew member cannot break a tie or end a vote early; the owner can, also without the crew role', () => {
  const at = Date.UTC(2026, 9, 4, 14, 0);
  const crew = [MAYA, JON];
  const open = () => openGate({ id: 'g', kind: 'batch', parts: [['a', 'b']], askedBy: OWNER, at });
  // The end: Jon (crew) is refused; the owner, who holds no crew role here, ends it.
  let out = step(open(), { type: 'end', by: JON, at: at + MINUTE, via: 'discord' }, crew, OWNER);
  assert.deepEqual(out.effects, [{ type: 'ignored', by: JON, why: 'not-owner' }]);
  out = step(open(), { type: 'end', by: OWNER, at: at + MINUTE, via: 'discord' }, crew, OWNER);
  assert.deepEqual(out.effects[0], { type: 'vote-ended', by: OWNER });
  // The tie-break after a 1-1 tie.
  let gate = open();
  for (const [by, option] of [[MAYA, 'a'], [JON, 'b']]) gate = step(gate, { type: 'press', by, part: 0, option, at: at + MINUTE, via: 'discord' }, crew, OWNER).gate;
  gate = step(gate, { type: 'tick', at: gate.endsAt }, crew, OWNER).gate;
  assert.equal(gate.phase, 'tied');
  out = step(gate, { type: 'tiebreak', by: MAYA, part: 0, option: 'a', at: gate.endsAt + MINUTE, via: 'discord' }, crew, OWNER);
  assert.deepEqual(out.effects, [{ type: 'ignored', by: MAYA, why: 'not-owner' }]);
  out = step(gate, { type: 'tiebreak', by: OWNER, part: 0, option: 'a', at: gate.endsAt + MINUTE, via: 'discord' }, crew, OWNER);
  assert.deepEqual(out.effects, [{ type: 'decided', part: 0, option: 'a', how: 'lead-tiebreak' }, { type: 'closed', outcome: { status: 'decided' } }]);
  // The owner without the role does not vote: a press is not-holder.
  out = step(open(), { type: 'press', by: OWNER, part: 0, option: 'a', at: at + MINUTE, via: 'discord' }, crew, OWNER);
  assert.deepEqual(out.effects, [{ type: 'ignored', by: OWNER, why: 'not-holder' }]);
});

test('C1 on Discord: a crew member\'s tie-break and End vote now change nothing; the owner\'s count; the tie pings only the owner', async (t) => {
  const b = setup({ members: [{ id: OWNER, name: 'Erick', roles: [] }, { id: MAYA, name: 'Maya', roles: [CREW] }, { id: JON, name: 'Jon', roles: [CREW] }],
    roles: [{ id: CREW_ROLE, name: CREW }, { id: CREW_B, name: CREW }] });
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  b.sh('gate', 'add', 'T7', '--question', 'Which columns?', '--options', 'Visible only|All fields', '--recommend', 'Visible only');
  b.sh('gate', 'add', 'T7', '--question', 'Which date format?', '--options', 'ISO|Locale', '--recommend', 'ISO');
  await b.post();
  const pings = () => b.discord.posts.filter((p) => p.content).map((p) => [p.content, p.allowedMentions]);
  // A new card pings each role named sage-crew, and nobody else.
  assert.deepEqual(pings(), [[`<@&${CREW_ROLE}> <@&${CREW_B}> project T7 has 2 product questions. Vote on each part within 30 minutes.`, { parse: [], roles: [CREW_ROLE, CREW_B] }]]);
  const id = 'project/G1+G2';
  assert.equal((await b.press(JON, `end:${id}`))[0].content, 'Only Erick can do this: ask Erick. Your votes on the parts count like everyone\'s.');
  assert.equal(b.bridge.entry(id).gate.phase, 'voting');
  await b.press(MAYA, `press:${id}:0:0`);
  await b.press(JON, `press:${id}:0:1`);
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual(pings().at(-1), [`<@${OWNER}> ${id} is tied after its vote. T7 waits: please break the tie with the buttons on the card.\nPart 1 is tied: A, B. Nobody gave a reason.\nPart 2 is tied: A, B. Nobody gave a reason.`, { parse: [], users: [OWNER] }]);
  assert.equal((await b.press(JON, `tiebreak:${id}:0:0`))[0].content, 'Only Erick can do this: ask Erick. Your votes on the parts count like everyone\'s.');
  assert.equal(b.bridge.entry(id).gate.parts[0].outcome.status, 'open');
  await b.press(OWNER, `tiebreak:${id}:0:1`); // the owner holds no crew role, and the press counts
  assert.deepEqual(b.bridge.entry(id).gate.parts[0].outcome, { status: 'decided', option: 'B', how: 'lead-tiebreak', by: OWNER, at: b.now });
  assert.equal(b.discord.posts.at(-1).content, `Erick broke the tie on part 1 of ${id}: B.`);
  // The owner's press on an option, with no crew role, is no vote.
  b.sh('gate', 'add', 'T8', '--question', 'Ship it?', '--options', 'Yes|No', '--recommend', 'Yes');
  await b.post();
  assert.equal((await b.press(OWNER, 'press:project/G3:0:0'))[0].content, 'Only a sage-crew member answers or votes here. To vote, give yourself the sage-crew role. Your answer at the terminal is final.');
  assert.equal(b.bridge.entry('project/G3').gate.phase, 'open');
  // Sam has no crew role and is not the owner: no reply, and nothing changes.
  assert.deepEqual(await b.press(SAM, 'press:project/G3:0:0'), []);
});

test('the role keys of before T232: the bridge starts and ignores them, and launchd.mjs warns and still writes the plist', (t) => {
  const dir = tempFolder('sage-bot-t232-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = { apprenticeRole: '300000000000000001', leadRole: '300000000000000002' };
  const warning = `the config has apprenticeRole, leadRole: sage-bot no longer reads them. The crew is every member with the role named ${CREW}. Remove apprenticeRole and leadRole from the config.`;
  assert.equal(oldRoleKeys(old), warning);
  assert.equal(oldRoleKeys({ ownerId: OWNER }), null);
  // The bridge takes a config with the old keys (and with apprenticeRole not a Discord id at all): it reads only ownerId.
  const config = { channelId: CHANNEL, ownerId: OWNER, apprenticeRole: 'not an id', leadRole: '300000000000000002' };
  assert.doesNotThrow(() => createBridge({ sages: new Map([['project', {}]]), own: 'project', discord: fakeDiscord([]), config, statePath: join(dir, 'gates.json'), log: () => {} }));
  assert.deepEqual([...peopleOf([{ id: MAYA, name: 'Maya', roles: ['sage-apprentice'] }, { id: JON, name: 'Jon', roles: [CREW] }], config).holders], [JON]);
  // launchd.mjs: the example config with the old keys added. It has no ownerId: the app's owner is the owner (F-T232-9).
  const example = JSON.parse(readFileSync(join(ROOT, 'examples/config.example.json'), 'utf8'));
  assert.equal(Object.hasOwn(example, 'ownerId'), false);
  const path = join(dir, 'config.json');
  // The project as the disk spells it: the temp folder may be a link (/var on macOS), and the projects check refuses a link.
  writeFileSync(path, JSON.stringify({ ...example, ...old, project: realpathSync.native(dir), projects: undefined }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/launchd.mjs'), path], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
  assert.equal(r.stderr.split('\n')[0], `sage-bot launchd: warning: ${warning}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<key>Label<\/key>/);
});

/** The read commands of one bridge on the fake Discord layer, with a scratch logbook: a command, a press of the stop confirm, a mention. */
function asks(t) {
  const b = setup({ markAll: false });
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  const ASK = '400000000000000009';
  b.config = { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
  const env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  const channels = openChannels(b.config, loadProjects(b.config));
  b.ask = createAsk({ config: withHome(b.config, channels), channels, env, now: () => T0, log: () => {}, audit: async () => {} });
  b.cmd = async (user, roles, sub) => {
    const i = fakeCommand({ user, roles, channelId: ASK, sub });
    await b.ask.command(i);
    return i.replies.slice(1).map((r) => [r.content, r.components?.[0]?.components.map((c) => c.custom_id)]);
  };
  b.press = async (user, roles, customId = STOP) => {
    const replies = [];
    await b.ask.press({ user: { id: user, bot: false }, roles, customId, sentAt: T0,
      update: async (p) => { replies.push(p.content); }, reply: async (p) => { replies.push(p.content); } });
    return replies;
  };
  b.talk = async (user, roles) => {
    const place = fakeDiscord([]);
    await b.ask.mention(fakeMention({ user, roles, channelId: ASK, content: '<@1> talk: the login', place }));
    return [...place.where.keys()].map((id) => place.latest(id)?.content).filter(Boolean);
  };
  b.flag = killPathOf(b.config);
  return b;
}
const CONFIRM = 'Turn off the link from Discord to sage? Then no message from Discord goes to sage until Erick turns it on again at the terminal. Read asks keep working.';

test('the crew\'s emergency stop: a crew member\'s /sage stop and its confirm turn the link off at once, with no approval of the owner', async (t) => {
  const b = asks(t);
  assert.deepEqual(await b.cmd(MAYA, [CREW], 'stop'), [[CONFIRM, [STOP, `${STOP_CANCEL}:${MAYA}`]]]);
  assert.equal(existsSync(b.flag), false); // the command alone sets nothing
  assert.deepEqual(await b.press(MAYA, [CREW]), [`<@${MAYA}> turned off the link from Discord to sage. No message from Discord goes to sage until Erick turns it on again at the terminal. Read asks keep working.`]);
  assert.equal(existsSync(b.flag), true);
  assert.match(readFileSync(b.flag, 'utf8'), new RegExp(MAYA)); // the flag says who
  assert.deepEqual(verifyLog(auditPathOf(b.config)).lines.map((l) => [l.author, l.outcome]), [[MAYA, 'link-off-set']]);
  // The owner's talk now gets the fixed reply: the link is off, with no step of the owner.
  assert.deepEqual(await b.talk(OWNER, [CREW]), ['<@1> talk: the login', LINK_OFF]); // the message, then the reply in its thread
});

test('the crew\'s emergency stop: a crew member cannot turn the link on again; only the terminal (the owner) can', async (t) => {
  const b = asks(t);
  await b.press(MAYA, [CREW]);
  assert.equal(existsSync(b.flag), true);
  // Discord has no command that turns the link on: /sage has no such subcommand.
  assert.deepEqual(askCommand([]).options.map((o) => o.name), ['board', 'task', 'gates', 'files', 'unregister', 'stop']);
  // A second /sage stop, a press of the old confirm and its Cancel change nothing: the flag stays.
  assert.deepEqual(await b.cmd(MAYA, [CREW], 'stop'), [['The link from Discord to sage is already off. Only Erick can turn it on again, at the terminal.', undefined]]);
  assert.deepEqual(await b.press(MAYA, [CREW]), ['The link from Discord to sage is already off. Nothing changed.']);
  assert.deepEqual(await b.press(MAYA, [CREW], `${STOP_CANCEL}:${MAYA}`), ['Cancelled. Nothing changed.']);
  assert.equal(existsSync(b.flag), true);
  // The terminal turns it on: node scripts/leads.mjs restore.
  const cfg = join(b.root, 'config.json');
  writeFileSync(cfg, JSON.stringify(b.config));
  const restore = spawnSync(process.execPath, [join(ROOT, 'scripts', 'leads.mjs'), '--config', cfg, 'restore'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(b.root, 'home') } });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(existsSync(b.flag), false);
});

test('F-T232-11: only the person who typed /sage stop, or the owner, cancels its confirm; any crew member\'s confirm still turns the link off', async (t) => {
  const b = asks(t);
  const [[, buttons]] = await b.cmd(MAYA, [CREW], 'stop');
  const cancel = buttons[1];
  assert.equal(cancel, `${STOP_CANCEL}:${MAYA}`);
  const replies = [];
  const press = (user, roles, customId) => b.ask.press({ user: { id: user, bot: false }, roles, customId, sentAt: T0,
    update: async (p) => { replies.push(['update', p.content]); }, reply: async (p) => { replies.push(['reply', p.content, p.flags]); } });
  // Jon's Cancel on Maya's confirm: a private reply, and the confirm stays (no update).
  await press(JON, [CREW], cancel);
  assert.deepEqual(replies.splice(0), [['reply', 'Only the person who typed /sage stop, or Erick, can cancel it. Nothing changed.', 64]]);
  // Jon cannot close Maya's confirm, so he cannot make her type /sage stop again until its burst limit locks her out.
  await press(JON, [CREW], cancel);
  await press(JON, [CREW], cancel);
  replies.length = 0;
  assert.deepEqual(await b.cmd(MAYA, [CREW], 'stop'), [[CONFIRM, [STOP, cancel]]]);
  // Maya's own Cancel works; so does the owner's.
  await press(MAYA, [CREW], cancel);
  await press(OWNER, [], cancel);
  assert.deepEqual(replies.splice(0), [['update', 'Cancelled. Nothing changed.'], ['update', 'Cancelled. Nothing changed.']]);
  assert.equal(existsSync(b.flag), false);
  // Jon's press of "Turn off the link" on Maya's confirm turns the link off: any crew member may confirm.
  await press(JON, [CREW], STOP);
  assert.deepEqual(replies, [['update', `<@${JON}> turned off the link from Discord to sage. No message from Discord goes to sage until Erick turns it on again at the terminal. Read asks keep working.`]]);
  assert.equal(existsSync(b.flag), true);
});

test('the crew\'s emergency stop: a member with no sage-crew role cannot stop the link, by the command or by the confirm button', async (t) => {
  const b = asks(t);
  for (const roles of [[], ['Moderators'], ['Sage-Crew'], ['sage-crew ']]) {
    assert.deepEqual(await b.cmd(SAM, roles, 'stop'), []); // nothing: no confirm, no reply
    assert.deepEqual(await b.press(SAM, roles), []);
  }
  assert.equal(existsSync(b.flag), false);
  assert.deepEqual(verifyLog(auditPathOf(b.config)).lines, []);
  // The same press by a crew member sets it: the refusal above is the role, not the button.
  await b.press(MAYA, [CREW]);
  assert.equal(existsSync(b.flag), true);
});
