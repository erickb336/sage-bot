// T232: one shared role found by its NAME, sage-crew, and the owner by user id (C1, C10, C12). The crew answers and votes; only the
// owner ends a vote early or breaks a tie, never a role. The owner comes from the config's ownerId, else from the Discord application.
// The role keys of before T232 start with a warning and do nothing.
// SAMPLE DATA ONLY: every id and name is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, ClientApplication, GatewayIntentBits } from 'discord.js';
import { tempFolder } from './temp-folder.js';
import { CREW, crewWarning, oldRoleKeys, ownerOf, placeOf } from '../src/crew.js';
import { appOf, rolesOf, watchCrew } from '../src/discord.js';
import { createBridge } from '../src/bridge.js';
import { fakeDiscord } from '../src/fake-discord.js';
import { peopleOf } from '../src/handle.js';
import { MINUTE, openGate, step } from '../src/vote.js';
import { CHANNEL, CREW_ROLE, JON, MAYA, OWNER, SAM, setup, spawnSync } from './bridge-setup.js';

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
  assert.equal((await b.press(JON, `end:${id}`))[0].content, 'Only Erick can do this. Your votes on the parts count like everyone\'s.');
  assert.equal(b.bridge.entry(id).gate.phase, 'voting');
  await b.press(MAYA, `press:${id}:0:0`);
  await b.press(JON, `press:${id}:0:1`);
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual(pings().at(-1), [`<@${OWNER}> ${id} is tied after its vote. T7 waits: please break the tie with the buttons on the card.\nPart 1 is tied: A, B. Nobody gave a reason.\nPart 2 is tied: A, B. Nobody gave a reason.`, { parse: [], users: [OWNER] }]);
  assert.equal((await b.press(JON, `tiebreak:${id}:0:0`))[0].content, 'Only Erick can do this. Your votes on the parts count like everyone\'s.');
  assert.equal(b.bridge.entry(id).gate.parts[0].outcome.status, 'open');
  await b.press(OWNER, `tiebreak:${id}:0:1`); // the owner holds no crew role, and the press counts
  assert.deepEqual(b.bridge.entry(id).gate.parts[0].outcome, { status: 'decided', option: 'B', how: 'lead-tiebreak', by: OWNER, at: b.now });
  assert.equal(b.discord.posts.at(-1).content, `Erick broke the tie on part 1 of ${id}: B.`);
  // The owner's press on an option, with no crew role, is no vote.
  b.sh('gate', 'add', 'T8', '--question', 'Ship it?', '--options', 'Yes|No', '--recommend', 'Yes');
  await b.post();
  assert.equal((await b.press(OWNER, 'press:project/G3:0:0'))[0].content, 'Only a sage-crew member answers or votes here. Your answer at the terminal is final.');
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
  // launchd.mjs: the example config with the old keys added, and with no ownerId.
  const { ownerId, ...example } = JSON.parse(readFileSync(join(ROOT, 'examples/config.example.json'), 'utf8'));
  assert.equal(ownerId, OWNER);
  const path = join(dir, 'config.json');
  // The project as the disk spells it: the temp folder may be a link (/var on macOS), and the projects check refuses a link.
  writeFileSync(path, JSON.stringify({ ...example, ...old, project: realpathSync.native(dir), projects: undefined }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/launchd.mjs'), path], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
  assert.equal(r.stderr.split('\n')[0], `sage-bot launchd: warning: ${warning}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<key>Label<\/key>/);
});
