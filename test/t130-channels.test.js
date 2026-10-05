// T130: the channel registry. The file is safe like the gate file; an old config migrates; Erick registers and unregisters channels at
// the terminal; a sage-lead may only unregister one, with a confirm; /sage works in each registered channel and its threads, for the
// channel's project. SAMPLE DATA ONLY: every id, name and project is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { createAsk, projectsOf, UNREGISTER } from '../src/ask.js';
import { createBridge } from '../src/bridge.js';
import { channelsPathOf, checkChannels, loadChannels, openChannels, withHome } from '../src/channels.js';
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
  const projects = projectsOf(b.config);
  openChannels(b.config, projects);
  assert.equal(mode(b.registry), 0o600);
  assert.deepEqual(readdirSync(dirname(b.registry)).filter((n) => n.endsWith('.tmp')), []); // the temp file was renamed over it
  const good = readFileSync(b.registry, 'utf8');
  const stops = (why) => assert.throws(() => openChannels(b.config, projects), { message: `the channel registry ${b.registry} ${why}` });
  // A symlink: the open refuses it (O_NOFOLLOW), also when it points to a good file.
  writeFileSync(join(b.root, 'elsewhere.json'), good, { mode: 0o600 });
  rmSync(b.registry);
  symlinkSync(join(b.root, 'elsewhere.json'), b.registry);
  stops('must be a regular file of this user with mode 0600. Nothing was loaded.');
  rmSync(b.registry);
  // A wrong mode.
  writeFileSync(b.registry, good, { mode: 0o644 });
  chmodSync(b.registry, 0o644);
  stops('must be a regular file of this user with mode 0600. Nothing was loaded.');
  chmodSync(b.registry, 0o600);
  // Bad JSON, a wrong shape, a project that the config does not list, and two home channels.
  writeFileSync(b.registry, '{"version":1,');
  stops('is not JSON. Nothing was loaded.');
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [ASK]: { project: 'project', admin: true } } }));
  stops('has an entry that the bridge did not write. Nothing was loaded.');
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [ASK]: { project: 'payroll', home: true } } }));
  stops(`maps the channel ${ASK} to the project "payroll", which is not in the config's projects. Nothing was loaded.`);
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [ASK]: { project: 'project', home: true }, [CHANNEL]: { project: 'project', home: true } } }));
  stops('must have exactly one home channel (the channel of the votes and cards). Nothing was loaded.');
  // In every case the bad file stays as it was: the start never writes over it.
  assert.equal(readFileSync(b.registry, 'utf8'), JSON.stringify({ version: 1, channels: { [ASK]: { project: 'project', home: true }, [CHANNEL]: { project: 'project', home: true } } }));
});

test('T130 migration: an old config with channelId and askChannelId makes the registry at the first start; /sage answers in the old #ask-sage, cards post in the old parent channel', async (t) => {
  const b = world(t);
  assert.equal(existsSync(b.registry), false);
  const lines = [];
  const channels = openChannels(b.config, projectsOf(b.config), (l) => lines.push(l));
  assert.deepEqual(file(b), { version: 1, channels: { [ASK]: { project: 'project' }, [CHANNEL]: { project: 'project', home: true } } });
  assert.deepEqual(lines, [`made the channel registry ${b.registry} from the config: ${ASK} -> project, ${CHANNEL} -> project (home)`]);
  const ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, log: () => {} });
  b.sh('task', 'add', '--title', 'Pick a name', '--size', 'tiny');
  assert.deepEqual((await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'task', { id: 'T1' }))[1].content, '**T1 · Pick a name**\ntiny · framed · no pull request');
  // The cards: the bridge on the home channel of the registry posts the session line and its thread there.
  b.sh('gate', 'add', 'T1', '--question', 'Which name?', '--options', 'Ada|Bo', '--recommend', 'Ada');
  b.bridge = createBridge({ sage: b.sage, discord: b.discord, config: withHome(CONFIG, channels), statePath: b.statePath, now: () => b.now, log: () => {} });
  await b.post();
  assert.equal(b.discord.in(CHANNEL).length > 0, true);
  assert.equal(b.discord.in(ASK).length, 0);
  // A second start reads the file and changes nothing.
  openChannels({ ...b.config, askChannelId: undefined, channelId: undefined }, projectsOf(b.config));
  assert.deepEqual(file(b), { version: 1, channels: { [ASK]: { project: 'project' }, [CHANNEL]: { project: 'project', home: true } } });
});

test('T130: with no registry and no channelId, the start stops and says how to register the home channel', (t) => {
  const b = world(t);
  assert.throws(() => openChannels({ ...b.config, channelId: undefined }, projectsOf(b.config)),
    { message: `there is no channel registry ${b.registry}, and the config has no channelId to make one from. Register the home channel with: node scripts/channels.mjs <config> register <channel id> <project> --home` });
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
  assert.equal(r.status, 1);
  assert.match(r.err, /another sage bridge \(pid \d+\) runs on .+ Stop the bridge first/);
  assert.equal(existsSync(b.registry), false);
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

/** A press of the confirm button, as src/discord.js maps it. */
function press(user, roles, customId) {
  const replies = [];
  return { user: { id: user, bot: false }, roles, customId, replies,
    update: async (p) => { replies.push({ kind: 'update', ...p }); }, reply: async (p) => { replies.push({ kind: 'reply', ...p }); } };
}

test('T130 unregister: a lead unregisters with a confirm; an apprentice is refused; a member with no role gets nothing; the home cannot go', async (t) => {
  const b = world(t);
  const lines = [];
  const channels = openChannels(b.config, projectsOf(b.config));
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
  assert.deepEqual(confirm.components, [{ type: 1, components: [{ type: 2, style: 4, label: 'Unregister this channel', custom_id: `${UNREGISTER}${ASK}` }] }]);
  assert.equal(readFileSync(b.registry, 'utf8'), before); // nothing changes before the press
  const lead = press(JON, [LEADR], confirm.components[0].components[0].custom_id);
  await ask.press(lead);
  assert.deepEqual(lead.replies, [{ kind: 'update', content: `<#${ASK}> is unregistered: sage-bot ignores /sage and mentions here now. Only Erick can register it again.`, components: [], allowedMentions: { parse: [] } }]);
  assert.deepEqual(file(b).channels, { [CHANNEL]: { project: 'project', home: true } });
  assert.deepEqual(lines, [`the sage-lead ${JON} unregistered the channel ${ASK} (it was for the project project)`]);
  // After it, the channel is like any other that is not registered: one pointer a day, then nothing.
  assert.deepEqual((await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'board'))[1].content, `I answer /sage in <#${CHANNEL}>, so please ask there.`);
  assert.deepEqual(await b.cmd(ask, MAYA, [APPRENTICE], ASK, 'board'), [{ kind: 'defer' }, { kind: 'remove' }]);
});

test('T130: /sage works in two registered channels for two projects, each with its own default project, and in their threads', async (t) => {
  const b = world(t);
  const beta = join(b.root, 'beta');
  mkdirSync(beta);
  const sage = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', beta], { env: b.env, encoding: 'utf8' });
  sage('init');
  sage('task', 'add', '--title', 'Beta one', '--size', 'tiny');
  sage('task', 'add', '--title', 'Beta two', '--size', 'tiny');
  b.sh('task', 'add', '--title', 'Alpha one', '--size', 'tiny');
  b.config.projects = [{ name: 'alpha', project: b.project }, { name: 'beta', project: beta }];
  b.config.askChannelId = undefined;
  mkdirSync(dirname(b.registry), { recursive: true, mode: 0o700 });
  writeFileSync(b.registry, JSON.stringify({ version: 1, channels: { [ASK]: { project: 'alpha', home: true }, [OTHER]: { project: 'beta' } } }), { mode: 0o600 });
  const channels = loadChannels(b.registry, ['alpha', 'beta']);
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
