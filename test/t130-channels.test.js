// T130: the channel registry. The file is safe like the gate file; an old config migrates; Erick registers and unregisters channels at
// the terminal; a sage-lead may only unregister one, with a confirm; /sage works in each registered channel and its threads, for the
// channel's project. SAMPLE DATA ONLY: every id, name and project is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { CANCEL, createAsk, UNREGISTER } from '../src/ask.js';
import { loadProjects } from '../src/projects.js';
import { createBridge } from '../src/bridge.js';
import { channelsPathOf, checkChannels, loadChannels, openChannels, withHome } from '../src/channels.js';
import { enter, prepare, routes } from '../src/discord.js';
import { fakeCommand, fakeMention } from '../src/fake-discord.js';
import { APPRENTICE, CHANNEL, CONFIG, JON, LEADR, MAYA, SAGE, SAM, setup } from './bridge-setup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASK = '400000000000000009'; // the old #ask-sage
const OTHER = '400000000000000011'; // a second registered channel
const THREAD = '400000000000000012';
const NOWHERE = '400000000000000013'; // never registered

function world(t) {
  const b = setup({ markAll: true });
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  b.env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  b.config = { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
  mkdirSync(join(b.root, 'beta')); // the folder of the second project of the tests: loadProjects refuses one that does not exist
  b.registry = channelsPathOf(b.config);
  b.cmd = async (ask, user, roles, channelId, sub, options = {}, parentId = null) => {
    const i = fakeCommand({ user, roles, channelId, parentId, sub, options });
    await ask.command(i);
    return i.replies;
  };
  return b;
}
const file = (b) => JSON.parse(readFileSync(b.registry, 'utf8'));
const mode = (path) => statSync(path).mode & 0o777;

test('T130 file safety: the registry is 0600 and written whole; a symlink, a wrong mode or bad JSON stops the start with a clear message', (t) => {
  const b = world(t);
  const projects = loadProjects(b.config);
  openChannels(b.config, projects);
  assert.equal(mode(b.registry), 0o600);
  assert.deepEqual(readdirSync(dirname(b.registry)).filter((n) => n.endsWith('.tmp')), []); // the temp file was renamed over it
  const good = readFileSync(b.registry, 'utf8');
  const aside = `Move it aside with: mv ${b.registry} ${b.registry}.bad, then register the home channel again with: node scripts/channels.mjs --config <config.json> register <channel id> <project> --home`;
  const stops = (why, fix = aside) => assert.throws(() => openChannels(b.config, projects), { message: `the channel registry ${b.registry} ${why} ${fix}` });
  // A symlink: the open refuses it (O_NOFOLLOW), also when it points to a good file.
  writeFileSync(join(b.root, 'elsewhere.json'), good, { mode: 0o600 });
  rmSync(b.registry);
  symlinkSync(join(b.root, 'elsewhere.json'), b.registry);
  stops('must be a regular file of this user with mode 0600. Nothing was loaded.');
  rmSync(b.registry);
  // A wrong mode.
  writeFileSync(b.registry, good, { mode: 0o644 });
  chmodSync(b.registry, 0o644);
  stops('must be a regular file of this user with mode 0600. Nothing was loaded.', `Fix it with: chmod 600 ${b.registry}`);
  chmodSync(b.registry, 0o600);
  // Bad JSON, a wrong shape, a project that the config does not list, and two home channels.
  writeFileSync(b.registry, '{"version":1,');
  stops('is not JSON. Nothing was loaded.');
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [ASK]: { project: 'project', admin: true } } }));
  stops('has an entry that the bridge did not write. Nothing was loaded.');
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { abc: { project: 'project', home: true } } })); // a key that is not a Discord id
  stops('has an entry that the bridge did not write. Nothing was loaded.');
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [ASK]: { project: 'project', home: true }, [CHANNEL]: { project: 'project', home: true } } }));
  stops('must have exactly one home channel (the channel of the votes and cards). Nothing was loaded.');
  // In every case the bad file stays as it was: the start never writes over it.
  assert.equal(readFileSync(b.registry, 'utf8'), JSON.stringify({ version: 1, channels: { [ASK]: { project: 'project', home: true }, [CHANNEL]: { project: 'project', home: true } } }));
});

test('T130 migration: an old config with channelId and askChannelId makes the registry at the first start; /sage answers in the old #ask-sage, cards post in the old parent channel', async (t) => {
  const b = world(t);
  assert.equal(existsSync(b.registry), false);
  const lines = [];
  const channels = openChannels(b.config, loadProjects(b.config), (l) => lines.push(l));
  assert.deepEqual(file(b), { version: 1, channels: { [ASK]: { project: 'project' }, [CHANNEL]: { project: 'project', home: true } } });
  assert.deepEqual(lines, [`made the channel registry ${b.registry} from the config: ${ASK} -> project, ${CHANNEL} -> project (home)`]);
  const ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, log: () => {} });
  b.sh('task', 'add', '--title', 'Pick a name', '--size', 'tiny');
  assert.deepEqual((await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'task', { id: 'T1' }))[1].content, '**T1 · Pick a name**\ntiny · framed · no pull request');
  // The cards: the bridge on the home channel of the registry posts the session line and its thread there.
  b.sh('gate', 'add', 'T1', '--question', 'Which name?', '--options', 'Ada|Bo', '--recommend', 'Ada');
  b.bridge = createBridge({ sages: new Map([['project', b.sage]]), own: 'project', discord: b.discord, config: withHome(CONFIG, channels), statePath: b.statePath, now: () => b.now, log: () => {} });
  await b.post();
  assert.equal(b.discord.in(CHANNEL).length > 0, true);
  assert.equal(b.discord.in(ASK).length, 0);
  // A second start reads the file and changes nothing.
  openChannels({ ...b.config, askChannelId: undefined, channelId: undefined }, loadProjects(b.config));
  assert.deepEqual(file(b), { version: 1, channels: { [ASK]: { project: 'project' }, [CHANNEL]: { project: 'project', home: true } } });
});

test('T130: with no registry and no channelId, the start stops and says how to register the home channel', (t) => {
  const b = world(t);
  assert.throws(() => openChannels({ ...b.config, channelId: undefined }, loadProjects(b.config)),
    { message: `there is no channel registry ${b.registry}, and the config has no channelId to make one from. Register the home channel with: node scripts/channels.mjs --config <config.json> register <channel id> <project> --home` });
});

/** Runs Erick's script with a config file in the scratch folder. */
function script(b, ...args) {
  const path = join(b.root, 'config.json');
  writeFileSync(path, JSON.stringify(b.config));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'channels.mjs'), '--config', path, ...args], { encoding: 'utf8', env: b.env });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('T130 terminal: Erick registers a channel for a project and unregisters it; a project not in the config is refused; the home stays', (t) => {
  const b = world(t);
  b.config.projects = [{ name: 'alpha', project: b.project }, { name: 'beta', project: join(b.root, 'beta') }];
  let r = script(b, 'register', OTHER, 'beta');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`^made the channel registry .+ from the config: ${ASK} -> alpha, ${CHANNEL} -> alpha \\(home\\)\nregistered the channel ${OTHER} for the project beta\n`));
  assert.match(r.out, /At its next start the bridge checks that sage-bot has these permissions there, and logs each missing one: View Channel, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links\./);
  assert.deepEqual(file(b).channels, { [ASK]: { project: 'alpha' }, [CHANNEL]: { project: 'alpha', home: true }, [OTHER]: { project: 'beta' } });
  assert.equal(mode(b.registry), 0o600);
  r = script(b, 'register', NOWHERE, 'payroll');
  assert.deepEqual([r.status, r.err], [1, `sage-bot channels: the project "payroll" is not in the config's projects (alpha, beta). Nothing was changed\n`]);
  r = script(b, 'unregister', CHANNEL);
  assert.equal(r.status, 1);
  assert.match(r.err, /is the home channel of the votes and cards\. Make another channel the home first/);
  r = script(b, 'unregister', OTHER);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`^unregistered the channel ${OTHER} \\(it was for the project beta\\)\n`));
  assert.deepEqual(file(b).channels, { [ASK]: { project: 'alpha' }, [CHANNEL]: { project: 'alpha', home: true } });
  r = script(b, 'register', OTHER, 'beta', '--home'); // the home moves
  assert.deepEqual(file(b).channels, { [ASK]: { project: 'alpha' }, [CHANNEL]: { project: 'alpha' }, [OTHER]: { project: 'beta', home: true } });
});

test('T130 terminal: the script refuses while a bridge holds the lock, and changes nothing', (t) => {
  const b = world(t);
  mkdirSync(dirname(b.statePath), { recursive: true });
  const start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' } }).trim();
  writeFileSync(`${b.statePath}.lock`, `${process.pid} ${start}`); // this test process stands in for a running bridge
  const r = script(b, 'register', OTHER, 'project');
  assert.deepEqual([r.status, r.err], [1, `sage-bot channels: a sage bridge runs on ${b.statePath}, and only one of the two may change the channel registry. Stop the bridge with: launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist (or Ctrl-C where you run it by hand), run this again, then start the bridge with: launchctl load ~/Library/LaunchAgents/com.sage.bot.plist. list works while it runs. If no bridge runs, remove ${b.statePath}.lock. Nothing was changed.\n`]);
  assert.equal(existsSync(b.registry), false);
  // F-T130-5: list only reads, so it works while the bridge runs.
  openChannels(b.config, loadProjects(b.config));
  const l = script(b, 'list');
  assert.deepEqual([l.status, l.out], [0, `${ASK}  project\n${CHANNEL}  project  (home: votes and cards)\n`]);
});

test('T130 permissions: the start names each permission that sage-bot lacks in a registered channel, and a channel it cannot see', async () => {
  const all = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads, PermissionFlagsBits.EmbedLinks]);
  const some = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]);
  const map = new Map([[CHANNEL, { project: 'alpha', home: true }], [ASK, { project: 'alpha' }], [OTHER, { project: 'beta' }]]);
  const perms = { [CHANNEL]: all, [ASK]: some };
  assert.deepEqual(await checkChannels(map, async (id) => { if (id === OTHER) throw new Error('Missing Access'); return perms[id]; }), [
    `sage-bot lacks these permissions in the registered channel ${ASK} (alpha): Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links. Give them to its role in that channel`,
    `sage-bot cannot see the registered channel ${OTHER} (beta): add it to the channel, or unregister the channel`,
  ]);
  assert.deepEqual(await checkChannels(new Map([[CHANNEL, { project: 'alpha', home: true }]]), async () => all), []);
});

/** A press of a button of the confirm, as src/discord.js maps it; Discord made the confirm `age` ms ago. */
function press(user, roles, customId, age = 0) {
  const replies = [];
  return { user: { id: user, name: `name-${user.slice(-2)}`, bot: false }, roles, customId, sentAt: Date.now() - age, replies,
    update: async (p) => { replies.push({ kind: 'update', ...p }); }, reply: async (p) => { replies.push({ kind: 'reply', ...p }); } };
}

test('T130 unregister: a lead unregisters with a confirm; an apprentice is refused; a member with no role gets nothing; the home cannot go', async (t) => {
  const b = world(t);
  const lines = [];
  const channels = openChannels(b.config, loadProjects(b.config));
  const ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, log: (l) => lines.push(l) });
  const before = readFileSync(b.registry, 'utf8');
  // No role: nothing, for the command and for a press.
  assert.deepEqual(await b.cmd(ask, SAM, [], ASK, 'unregister'), []);
  const none = press(SAM, [], `${UNREGISTER}${ASK}`);
  await ask.press(none);
  assert.deepEqual(none.replies, []);
  // An apprentice: refused, also when they press a lead's confirm; the confirm stays and the registry does not change.
  assert.deepEqual((await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'unregister'))[1].content, 'Only a sage-lead can unregister a channel. Ask a lead.');
  const apprentice = press(MAYA, [APPRENTICE], `${UNREGISTER}${ASK}`);
  await ask.press(apprentice);
  assert.deepEqual(apprentice.replies, [{ kind: 'reply', content: 'Only a sage-lead can unregister a channel. Nothing changed.', allowedMentions: { parse: [] } }]);
  // The home channel: refused for a lead too.
  assert.equal((await b.cmd(ask, JON, [LEADR], CHANNEL, 'unregister'))[1].content, `<#${CHANNEL}> is the home channel of the votes and cards. Only Erick can change it, at the terminal.`);
  assert.equal(readFileSync(b.registry, 'utf8'), before);
  // A lead, in a thread of the channel: the confirm names the channel and has one button for it.
  const confirm = (await b.cmd(ask, JON, [LEADR], THREAD, 'unregister', {}, ASK))[1];
  assert.equal(confirm.content, `Unregister <#${ASK}>? sage-bot then ignores /sage and mentions here and in its threads. Only Erick can register it again, at the terminal.`);
  assert.deepEqual(confirm.components, [{ type: 1, components: [{ type: 2, style: 4, label: 'Unregister this channel', custom_id: `${UNREGISTER}${ASK}` },
    { type: 2, style: 2, label: 'Cancel', custom_id: 'channel-unregister:cancel' }] }]);
  assert.equal(readFileSync(b.registry, 'utf8'), before); // nothing changes before the press
  const lead = press(JON, [LEADR], confirm.components[0].components[0].custom_id);
  await ask.press(lead);
  assert.deepEqual(lead.replies, [{ kind: 'update', content: `<#${ASK}> is unregistered: sage-bot ignores /sage and mentions here now. Only Erick can register it again.`, components: [], allowedMentions: { parse: [] } }]);
  assert.deepEqual(file(b).channels, { [CHANNEL]: { project: 'project', home: true } });
  assert.deepEqual(lines, [`the sage-lead name-03 (${JON}) unregistered the channel ${ASK} (it was for the project project)`]); // F-T130-6
  // After it, the channel is like any other that is not registered: one pointer a day, then nothing.
  assert.deepEqual((await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'board'))[1].content, `I answer /sage in <#${CHANNEL}>, so please ask there.`);
  assert.deepEqual(await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'board'), [{ kind: 'defer' }, { kind: 'remove' }]);
});

test('T130: /sage works in two registered channels for two projects, each with its own default project, and in their threads', async (t) => {
  const b = world(t);
  const beta = join(b.root, 'beta');
  const sage = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', beta], { env: b.env, encoding: 'utf8' });
  sage('init');
  sage('task', 'add', '--title', 'Beta one', '--size', 'tiny');
  sage('task', 'add', '--title', 'Beta two', '--size', 'tiny');
  b.sh('task', 'add', '--title', 'Alpha one', '--size', 'tiny');
  b.config.projects = [{ name: 'alpha', project: b.project }, { name: 'beta', project: beta }];
  b.config.askChannelId = undefined;
  mkdirSync(dirname(b.registry), { recursive: true, mode: 0o700 });
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [ASK]: { project: 'alpha', home: true }, [OTHER]: { project: 'beta' } } }), { mode: 0o600 });
  const channels = loadChannels(b.registry);
  const ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, log: () => {} });
  const board = async (channelId, parentId = null, options = {}) => (await b.cmd(ask, MAYA, [APPRENTICE], channelId, 'board', options, parentId))[1].content.split('\n').slice(0, 2).join('\n');
  assert.equal(await board(ASK), '**Board · alpha**\n1 task(s) · framed 1');
  assert.equal(await board(OTHER), '**Board · beta**\n2 task(s) · framed 2');
  assert.equal(await board(THREAD, ASK), '**Board · alpha**\n1 task(s) · framed 1');
  assert.equal(await board(THREAD, OTHER), '**Board · beta**\n2 task(s) · framed 2');
  assert.equal(await board(OTHER, null, { project: 'alpha' }), '**Board · alpha**\n1 task(s) · framed 1'); // the option may name any listed project
  // A mention: answered in a registered channel and its thread; elsewhere one pointer a day.
  const mention = async (channelId, parentId = null) => {
    const m = fakeMention({ user: JON, roles: [LEADR], channelId, parentId, content: '<@1> hi' });
    await ask.mention(m);
    return m.replies.map((r) => r.content);
  };
  assert.equal((await mention(THREAD, OTHER)).length, 1);
  assert.deepEqual(await mention(NOWHERE), [`I answer in <#${ASK}>, so everyone can find the answers. Please ask there.`]);
  assert.deepEqual(await mention(NOWHERE), []);
});

// ---- Repair round 1 (R402): the findings of QA R396, code review R394 and security review R395. ----

test('F-T130-2: a new install with no channelId makes its first registry with register --home, as the README says; the bridge then starts', (t) => {
  const b = world(t);
  b.config = { ...b.config, channelId: undefined, askChannelId: undefined };
  let r = script(b, 'list');
  assert.deepEqual([r.status, r.out], [0, `there is no channel registry ${b.registry} yet. The bridge makes it from channelId at its first start; with no channelId, register the home channel with: node scripts/channels.mjs --config <config.json> register <channel id> <project> --home\n`]);
  for (const args of [['register', OTHER, 'project'], ['unregister', OTHER]]) {
    r = script(b, ...args); // only the home channel can come first
    assert.deepEqual([r.status, r.err], [1, 'sage-bot channels: there is no channel registry yet: register the home channel first, with: node scripts/channels.mjs --config <config.json> register <channel id> <project> --home. Nothing was changed\n']);
    assert.equal(existsSync(b.registry), false);
  }
  r = script(b, 'register', CHANNEL, 'project', '--home');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`^registered the channel ${CHANNEL} for the project project \\(home channel of the votes and cards\\)\n`));
  assert.deepEqual(file(b).channels, { [CHANNEL]: { project: 'project', home: true } });
  assert.equal(mode(b.registry), 0o600);
  assert.equal(withHome(b.config, openChannels(b.config, loadProjects(b.config))).channelId, CHANNEL); // the bridge starts on it
});

test('F-T130-3: a project removed from the config: list and unregister still work and name it; the bridge refuses and names the repair', (t) => {
  const b = world(t);
  b.config.projects = [{ name: 'alpha', project: b.project }, { name: 'beta', project: join(b.root, 'beta') }];
  assert.equal(script(b, 'register', OTHER, 'beta').status, 0);
  b.config.projects = [{ name: 'gamma', project: b.project }]; // alpha and beta are gone
  const names = 'which is not in the config\'s projects (gamma). Give the channel a listed project with: node scripts/channels.mjs --config <config.json> register <channel id> <project>, or remove it with: unregister <channel id>. Nothing was loaded.';
  assert.throws(() => openChannels(b.config, loadProjects(b.config)), { message: `the channel registry ${b.registry} maps the channel ${ASK} to the project "alpha", the channel ${CHANNEL} to the project "alpha", the channel ${OTHER} to the project "beta", ${names}` });
  const stale = '  (not in the config: register it again or unregister it)';
  let r = script(b, 'list');
  assert.deepEqual([r.status, r.out], [0, `${ASK}  alpha${stale}\n${CHANNEL}  alpha  (home: votes and cards)${stale}\n${OTHER}  beta${stale}\n`]);
  r = script(b, 'unregister', OTHER);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, `unregistered the channel ${OTHER} (it was for the project beta)\n${ASK}  alpha${stale}\n${CHANNEL}  alpha  (home: votes and cards)${stale}\nThe bridge does not start while a channel has a project that is not in the config.\n`);
  assert.equal(script(b, 'unregister', ASK).status, 0);
  r = script(b, 'register', CHANNEL, 'gamma'); // the home keeps its place and gets a listed project
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(file(b).channels, { [CHANNEL]: { project: 'gamma', home: true } });
  assert.deepEqual([...openChannels(b.config, loadProjects(b.config))], [[CHANNEL, { project: 'gamma', home: true }]]);
});

test('F-T130-8: the home cannot move while a card waits in the old home; it can stay where it is', async (t) => {
  const b = world(t);
  b.sh('task', 'add', '--title', 'Pick a name', '--size', 'tiny');
  b.sh('gate', 'add', 'T1', '--question', 'Which name?', '--options', 'Ada|Bo', '--recommend', 'Ada');
  await b.post(); // the card of project/G1 waits in CHANNEL, the home
  assert.equal(b.discord.in(CHANNEL).length > 0, true);
  let r = script(b, 'register', OTHER, 'project', '--home');
  assert.deepEqual([r.status, r.err], [1, `sage-bot channels: the home channel cannot move while 1 card(s) wait in the old home channel ${CHANNEL} or its threads (project/G1): their buttons would stop working. Wait until they are settled, or answer them at the terminal, then run this again. Nothing was changed.\n`]);
  assert.deepEqual(file(b).channels, { [ASK]: { project: 'project' }, [CHANNEL]: { project: 'project', home: true } });
  r = script(b, 'register', CHANNEL, 'project', '--home'); // not a move
  assert.equal(r.status, 0, r.err);
  r = script(b, 'register', OTHER, 'project'); // not the home
  assert.equal(r.status, 0, r.err);
});

test('F-T130-9 keepHome: registering the home channel for another project keeps it the home', (t) => {
  const b = world(t);
  b.config.projects = [{ name: 'alpha', project: b.project }, { name: 'beta', project: join(b.root, 'beta') }];
  const r = script(b, 'register', CHANNEL, 'beta');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`registered the channel ${CHANNEL} for the project beta \\(home channel of the votes and cards\\)\n`));
  assert.deepEqual(file(b).channels, { [ASK]: { project: 'alpha' }, [CHANNEL]: { project: 'beta', home: true } });
});

test('F-T130-9 withHome: the start posts the cards in the registry\'s home channel, not in the config\'s channelId', (t) => {
  const b = world(t);
  mkdirSync(dirname(b.registry), { recursive: true, mode: 0o700 });
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [CHANNEL]: { project: 'project' }, [OTHER]: { project: 'project', home: true } } }), { mode: 0o600 });
  const { config, channels } = prepare(b.config, () => {});
  assert.equal(config.channelId, OTHER);
  assert.deepEqual([...channels.keys()], [CHANNEL, OTHER]);
});

const GUILD = '200000000000000001';
test('F-T130-9 permission check: after the login, the start logs each permission that sage-bot lacks in a registered channel', async () => {
  const all = new PermissionsBitField(Object.values(PermissionFlagsBits));
  const some = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
  const set = [];
  const guild = { members: { fetch: async () => {} }, commands: { set: async (c) => { set.push(c.map((x) => x.name)); } } };
  const client = { user: { id: BOT_USER }, guilds: { fetch: async (id) => (id === GUILD ? guild : null) },
    channels: { fetch: async (id) => ({ [CHANNEL]: { permissionsFor: () => all }, [ASK]: { permissionsFor: () => some } })[id] ?? null } };
  const lines = [];
  const channels = new Map([[CHANNEL, { project: 'alpha', home: true }], [ASK, { project: 'alpha' }], [OTHER, { project: 'beta' }]]);
  assert.equal(await enter(client, { config: { guildId: GUILD }, channels, ask: { projects: [] }, log: (l) => lines.push(l) }), guild);
  assert.deepEqual(set, [['sage']]);
  assert.deepEqual(lines, [
    `sage-bot lacks these permissions in the registered channel ${ASK} (alpha): Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links. Give them to its role in that channel`,
    `sage-bot cannot see the registered channel ${OTHER} (beta): add it to the channel, or unregister the channel`,
  ]);
});

const BOT_USER = '100000000000000099';
/** A press of a button of the unregister confirm as discord.js gives it, for `routes`. SAMPLE DATA ONLY. */
const button = ({ user = JON, roles = [LEADR], channelId = ASK, customId, age = 0 }) => {
  const calls = [];
  return { calls, guildId: GUILD, channelId, channel: null, customId, user: { id: user, bot: false, username: 'jon_l' },
    member: { roles: { cache: new Map(roles.map((r) => [r, {}])) }, displayName: 'Jon <Lead>' }, message: { createdTimestamp: Date.now() - age },
    isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false,
    update: async (p) => { calls.push(['update', p.content]); }, reply: async (p) => { calls.push(['reply', p.content]); } };
};

test('F-T130-9 and F-T130-6: routes take an unregister press in any registered channel to ask.press; the log names the lead and their id', async (t) => {
  const b = world(t);
  const channels = openChannels(b.config, loadProjects(b.config));
  const lines = [];
  const config = { ...withHome(b.config, channels), guildId: GUILD };
  const ask = createAsk({ config, channels, env: b.env, log: (l) => lines.push(l) });
  const pressed = [];
  const on = routes({ config, ask, bridge: { interaction: async (i) => { pressed.push(i.customId); } }, fetch: async () => ({ isThread: () => false }), botId: BOT_USER });
  const i = button({ customId: `${UNREGISTER}${ASK}` }); // ASK is not the home channel, where the bridge's own buttons work
  await on.interaction(i);
  assert.deepEqual(i.calls, [['update', `<#${ASK}> is unregistered: sage-bot ignores /sage and mentions here now. Only Erick can register it again.`]]);
  assert.deepEqual(file(b).channels, { [CHANNEL]: { project: 'project', home: true } });
  assert.deepEqual(lines, [`the sage-lead Jon <Lead> (${JON}) unregistered the channel ${ASK} (it was for the project project)`]);
  assert.deepEqual(pressed, []);
});

test('F-T130-7: the confirm has a Cancel button, and it expires after 10 minutes; neither changes the registry', async (t) => {
  const b = world(t);
  const channels = openChannels(b.config, loadProjects(b.config));
  const ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, log: () => {} });
  const before = readFileSync(b.registry, 'utf8');
  const run = async (p) => { await ask.press(p); return p.replies.map((x) => [x.kind, x.content]); };
  assert.deepEqual(await run(press(JON, [LEADR], CANCEL)), [['update', 'Cancelled. Nothing changed.']]);
  assert.deepEqual(await run(press(MAYA, [APPRENTICE], CANCEL)), [['reply', 'Only a sage-lead can unregister a channel. Nothing changed.']]);
  assert.deepEqual(await run(press(JON, [LEADR], `${UNREGISTER}${ASK}`, 10 * 60_000 + 1)), [['update', 'This confirm expired after 10 minutes. Nothing changed. Type /sage unregister again.']]);
  assert.deepEqual(await run({ ...press(JON, [LEADR], `${UNREGISTER}${ASK}`), sentAt: undefined }), [['update', 'This confirm expired after 10 minutes. Nothing changed. Type /sage unregister again.']]);
  assert.equal(readFileSync(b.registry, 'utf8'), before);
  assert.deepEqual(await run(press(JON, [LEADR], `${UNREGISTER}${ASK}`, 10 * 60_000 - 1000)), [['update', `<#${ASK}> is unregistered: sage-bot ignores /sage and mentions here now. Only Erick can register it again.`]]);
});

test('F-T130-1: a press whose custom_id has no Discord id after the prefix gets nothing, and nothing is echoed', async (t) => {
  const b = world(t);
  const channels = openChannels(b.config, loadProjects(b.config));
  const ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, log: () => {} });
  for (const id of ['@everyone', `${ASK}x`, '', '<@&300000000000000002>', `${ASK} `]) {
    const p = press(JON, [LEADR], `${UNREGISTER}${id}`);
    await ask.press(p);
    assert.deepEqual(p.replies, [], id);
  }
  const p = press(JON, [LEADR], `${UNREGISTER}${NOWHERE}`); // a Discord id still gets its answer
  await ask.press(p);
  assert.deepEqual(p.replies.map((x) => x.content), [`<#${NOWHERE}> is not registered. Nothing changed.`]);
});

test('F-T130-10: a lead\'s press for the home channel is refused; a save that fails keeps the channel registered', async (t) => {
  const b = world(t);
  const channels = openChannels(b.config, loadProjects(b.config));
  const lines = [];
  const ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, log: (l) => lines.push(l) });
  const before = readFileSync(b.registry, 'utf8');
  let p = press(JON, [LEADR], `${UNREGISTER}${CHANNEL}`);
  await ask.press(p);
  assert.deepEqual(p.replies.map((x) => x.content), [`<#${CHANNEL}> is the home channel of the votes and cards. Only Erick can change it, at the terminal.`]);
  assert.equal(readFileSync(b.registry, 'utf8'), before);
  p = press(JON, [LEADR], `${UNREGISTER}${ASK}`);
  chmodSync(dirname(b.registry), 0o500); // the save cannot write its temp file
  try { await ask.press(p); } finally { chmodSync(dirname(b.registry), 0o700); }
  assert.deepEqual(p.replies.map((x) => x.content), ['I could not unregister this channel just now. Nothing changed. Please try again in a minute.']);
  assert.deepEqual([...channels], [[ASK, { project: 'project' }], [CHANNEL, { project: 'project', home: true }]]);
  assert.equal(readFileSync(b.registry, 'utf8'), before);
  assert.match(lines[0], new RegExp(`^the channel registry could not be saved, so ${ASK} stays registered: EACCES`));
  assert.equal((await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'board'))[1].content.split('\n')[0], '**Board · project**'); // /sage still works there
});

test('F-T130-10: the migration gives the home channel the bridge\'s own project, also when it is not the first project', (t) => {
  const b = world(t);
  b.config.projects = [{ name: 'beta', project: join(b.root, 'beta') }, { name: 'alpha', project: b.project }];
  openChannels(b.config, loadProjects(b.config));
  assert.deepEqual(file(b).channels, { [ASK]: { project: 'beta' }, [CHANNEL]: { project: 'alpha', home: true } });
});

test('F-T130-4: the script gives one clear line for a wrong verb, a missing config and --config with no path', (t) => {
  const b = world(t);
  const usage = 'usage: node scripts/channels.mjs [--config <config.json>] list | register <channel id> <project> [--home] | unregister <channel id>';
  for (const args of [[], ['remove', OTHER], ['list', 'extra']]) assert.deepEqual(Object.values(script(b, ...args)).slice(0, 3), [1, '', `sage-bot channels: ${usage}\n`], args.join(' '));
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'channels.mjs'), ...args], { encoding: 'utf8', env: b.env });
  let r = run('--config', join(b.root, 'nothing.json'), 'list');
  assert.deepEqual([r.status, r.stderr], [1, `sage-bot channels: cannot read the config ${join(b.root, 'nothing.json')} (ENOENT). Give the bridge's config with --config <config.json>.\n`]);
  r = run('list', '--config');
  assert.deepEqual([r.status, r.stderr], [1, `sage-bot channels: --config needs the path of the bridge's config file. ${usage}\n`]);
});

// ---- Repair round 2 (R410): the findings of QA R409 and code review R407. ----

/** Runs one printed repair line as Erick would: the shell for chmod and mv, the script for the register line (its placeholders filled in). */
function follow(b, line) {
  const reg = /^node scripts\/channels\.mjs --config <config\.json> (register) <channel id> <project> (--home)$/.exec(line);
  if (!reg) { execFileSync('/bin/sh', ['-c', line]); return; }
  const r = script(b, reg[1], CHANNEL, 'project', reg[2]);
  assert.equal(r.status, 0, r.err);
}

test('F-T130-13: each broken registry stops the start, list and register with the exact repair; following it lets prepare() pass', (t) => {
  const FIRST_LINE = 'node scripts/channels.mjs --config <config.json> register <channel id> <project> --home';
  const reg = (channels) => JSON.stringify({ version: 1, channels });
  const cases = [
    ['bad JSON', 'is not JSON. Nothing was loaded.', (p) => writeFileSync(p, '{"version":1,', { mode: 0o600 })],
    ['a wrong mode', 'must be a regular file of this user with mode 0600. Nothing was loaded.', (p) => { writeFileSync(p, reg({ [CHANNEL]: { project: 'project', home: true } })); chmodSync(p, 0o644); }, 'chmod'],
    ['no read bit', 'must be a regular file of this user with mode 0600. Nothing was loaded.', null, 'chmod'], // filled in below: mode 0o200 is refused by the open itself
    ['a symlink', 'must be a regular file of this user with mode 0600. Nothing was loaded.', (p, b) => { writeFileSync(join(b.root, 'elsewhere.json'), reg({ [CHANNEL]: { project: 'project', home: true } }), { mode: 0o600 }); symlinkSync(join(b.root, 'elsewhere.json'), p); }],
    ['a folder in its place', 'must be a regular file of this user with mode 0600. Nothing was loaded.', (p) => mkdirSync(p)],
    ['two homes', 'must have exactly one home channel (the channel of the votes and cards). Nothing was loaded.', (p) => writeFileSync(p, reg({ [ASK]: { project: 'project', home: true }, [CHANNEL]: { project: 'project', home: true } }), { mode: 0o600 })],
    ['zero channels', 'must have exactly one home channel (the channel of the votes and cards). Nothing was loaded.', (p) => writeFileSync(p, reg({}), { mode: 0o600 })],
    ['a bad id', 'has an entry that the bridge did not write. Nothing was loaded.', (p) => writeFileSync(p, reg({ abc: { project: 'project', home: true } }), { mode: 0o600 })],
    ['an entry the bridge did not write', 'has an entry that the bridge did not write. Nothing was loaded.', (p) => writeFileSync(p, reg({ [CHANNEL]: { project: 'project', home: true, admin: true } }), { mode: 0o600 })],
    // F-T130-15: "home": false is refused like any other entry that the bridge did not write (it writes no home key on a normal channel).
    ['"home": false', 'has an entry that the bridge did not write. Nothing was loaded.', (p) => writeFileSync(p, reg({ [CHANNEL]: { project: 'project', home: true }, [ASK]: { project: 'project', home: false } }), { mode: 0o600 })],
  ];
  cases[2][2] = (p) => { writeFileSync(p, reg({ [CHANNEL]: { project: 'project', home: true } })); chmodSync(p, 0o200); };
  for (const [name, why, make, kind] of cases) {
    const b = world(t);
    mkdirSync(dirname(b.registry), { recursive: true, mode: 0o700 });
    make(b.registry, b);
    const fix = kind === 'chmod' ? `Fix it with: chmod 600 ${b.registry}`
      : `Move it aside with: mv ${b.registry} ${b.registry}.bad, then register the home channel again with: ${FIRST_LINE}`;
    const message = `the channel registry ${b.registry} ${why} ${fix}`;
    assert.throws(() => prepare(b.config, () => {}), { message }, name); // the bridge stops before Discord
    rmSync(`${b.statePath}.lock`); // this test process took the lock in prepare(): the stopped bridge gives it back
    for (const args of [['list'], ['register', OTHER, 'project']]) {
      assert.deepEqual(Object.values(script(b, ...args)).slice(0, 3), [1, '', `sage-bot channels: ${message}\n`], `${name}: ${args[0]}`);
    }
    // Erick follows the printed lines, as printed.
    const lines = kind === 'chmod' ? [`chmod 600 ${b.registry}`] : [/Move it aside with: (.+), then/.exec(message)[1], FIRST_LINE];
    for (const line of lines) follow(b, line);
    const { config, channels } = prepare(b.config, () => {});
    assert.equal(config.channelId, CHANNEL, name);
    assert.equal(channels.get(CHANNEL).home, true, name);
    if (kind !== 'chmod') assert.equal(existsSync(`${b.registry}.bad`), true, name); // the bad file is kept, aside
  }
});

test('F-T130-13: a path with a space or a quote is one shell word in the printed repair', (t) => {
  const b = world(t);
  const path = join(b.root, "Erick's state", 'gates.json.channels');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, '{', { mode: 0o600 });
  let message = '';
  try { loadChannels(path); } catch (e) { message = e.message; }
  const mv = /Move it aside with: (.+), then register/.exec(message)[1];
  assert.equal(mv, `mv '${b.root}/Erick'\\''s state/gates.json.channels' '${b.root}/Erick'\\''s state/gates.json.channels.bad'`);
  execFileSync('/bin/sh', ['-c', mv]); // the printed line, as printed
  assert.equal(existsSync(`${path}.bad`), true);
  assert.equal(loadChannels(path), undefined);
});

test('F-T130-14: the refusal while the bridge runs gives the launchctl lines that stop and start it, and the manual case', (t) => {
  const b = world(t);
  mkdirSync(dirname(b.statePath), { recursive: true });
  const start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' } }).trim();
  writeFileSync(`${b.statePath}.lock`, `${process.pid} ${start}`);
  const r = script(b, 'unregister', OTHER);
  assert.deepEqual([r.status, r.err], [1, `sage-bot channels: a sage bridge runs on ${b.statePath}, and only one of the two may change the channel registry. Stop the bridge with: launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist (or Ctrl-C where you run it by hand), run this again, then start the bridge with: launchctl load ~/Library/LaunchAgents/com.sage.bot.plist. list works while it runs. If no bridge runs, remove ${b.statePath}.lock. Nothing was changed.\n`]);
  // The README and the reference give the same two lines beside register and unregister.
  for (const doc of ['README.md', 'docs/reference.md']) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    assert.match(text, /launchctl unload ~\/Library\/LaunchAgents\/com\.sage\.bot\.plist/, doc);
    assert.match(text, /launchctl load ~\/Library\/LaunchAgents\/com\.sage\.bot\.plist/, doc);
    assert.match(text, /Ctrl\+C/, doc);
  }
});

test('F-T130-15: askChannelId equal to channelId migrates to one home entry for the first project, also when the bridge\'s own project is not first', (t) => {
  const b = world(t);
  b.config = { ...b.config, askChannelId: CHANNEL, projects: [{ name: 'beta', project: join(b.root, 'beta') }, { name: 'alpha', project: b.project }] };
  openChannels(b.config, loadProjects(b.config));
  assert.deepEqual(file(b).channels, { [CHANNEL]: { project: 'beta', home: true } });
});

test('F-T130-15: the migration refuses a channelId or askChannelId that is not a Discord id, and writes nothing', (t) => {
  const b = world(t);
  assert.throws(() => openChannels({ ...b.config, channelId: '12345' }, loadProjects(b.config)), { message: 'the config: channelId must be a Discord id (17 to 20 digits)' });
  assert.throws(() => openChannels({ ...b.config, askChannelId: `${ASK}x` }, loadProjects(b.config)), { message: 'the config: askChannelId must be a Discord id (17 to 20 digits)' });
  assert.equal(existsSync(b.registry), false);
});

test('F-T130-15: register with an unknown option is refused, and the registry stays as it was', (t) => {
  const b = world(t);
  openChannels(b.config, loadProjects(b.config));
  const before = readFileSync(b.registry, 'utf8');
  const r = script(b, 'register', OTHER, 'project', '--hom');
  assert.deepEqual([r.status, r.err], [1, 'sage-bot channels: unknown option --hom\n']);
  assert.equal(readFileSync(b.registry, 'utf8'), before);
});

test('F-T130-15: scripts/launchd.mjs makes the plist for a config with no channelId and no askChannelId (a new install)', (t) => {
  const b = world(t);
  const sample = JSON.parse(readFileSync(join(ROOT, 'examples/config.example.json'), 'utf8').replaceAll('/Users/you/workspace/your-project', realpathSync.native(ROOT))); // a folder that exists
  delete sample.channelId;
  delete sample.askChannelId;
  const path = join(b.root, 'new-install.json');
  writeFileSync(path, JSON.stringify(sample));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'launchd.mjs'), path], { encoding: 'utf8', env: { ...process.env, HOME: b.env.HOME } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(r.stdout, new RegExp(`<string>${path}</string>`));
});
