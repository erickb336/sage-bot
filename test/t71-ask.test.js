// T71: the read commands of #ask-sage (/sage board, task, gates, files) and the pointer for an @sage-bot mention, on a scratch logbook
// with the fake Discord. SAMPLE DATA ONLY: every id, name and file is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { askCommand, BUILDS, createAsk, HOUR, MAX_FILE, NO_ROLE, POINTER, projectsOf } from '../src/ask.js';
import { rolesOf } from '../src/discord.js';
import { fakeCommand, fakeMention } from '../src/fake-discord.js';
import { APPRENTICE, BOT, CONFIG, JON, LEADR, MAYA, SAGE, SAM, setup, T0 } from './bridge-setup.js';

const ASK = '400000000000000009';
const ELSEWHERE = '400000000000000001';
const SECRET = 'ZZSECRET';
const PRIVATE = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };

/** A scratch logbook with two tasks, a team vote, a terminal question, and the secret marker in every place that /sage must never read. */
function world(t) {
  const b = setup({ markAll: false });
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  b.sh('task', 'add', '--title', 'Board sort', '--size', 'small', '--why', `why ${SECRET}`);
  b.sh('task', 'T1', 'set', 'state=briefed');
  b.sh('task', 'T1', 'set', 'state=building', 'pr=17', `branch=${SECRET.toLowerCase()}-branch`);
  b.sh('task', 'add', '--title', 'Wake notes', '--size', 'tiny');
  b.sh('finding', 'add', 'T1', '--source', 'qa', '--severity', 'high', '--summary', `finding ${SECRET}`);
  b.sh('log', 'T1', `owner said ${SECRET}`, '--why', `security detail ${SECRET}`);
  b.sh('gate', 'add', 'T1', '--question', 'Which sort is the default?', '--options', 'Name|Date', '--recommend', `Name ${SECRET}`, '--default', 'Name');
  b.sh('gate', 'add', 'T2', '--question', 'Ship the wake note?', '--options', 'Yes|No', '--recommend', 'Yes');
  b.mark('G1');
  const book = b.sh('logbook');
  appendFileSync(join(book, 'decisions.tsv'), `2026-10-04T00:00:00Z\tT1\tdecision ${SECRET}\twhy ${SECRET}\n`);
  writeFileSync(join(book, 'briefs', 'R1.md'), `brief ${SECRET}\n`);
  writeFileSync(join(book, 'reports', 'R1.md'), `report ${SECRET}\n`);
  const env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  b.makeAsk = (extra = {}) => createAsk({ config: { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath, ...extra }, now: () => b.now, log: (l) => b.lines.push(l), env });
  b.ask = b.makeAsk();
  /** One /sage command; returns its replies. */
  b.cmd = async (user, sub, options = {}, o = {}) => {
    const i = fakeCommand({ user, roles: o.roles ?? { [MAYA]: [APPRENTICE], [JON]: [LEADR] }[user] ?? [], bot: o.bot, channelId: o.channelId ?? ASK, sub, options });
    await b.ask.command(i);
    return i.replies;
  };
  b.mention = async (user, content, channelId = ASK, bot = false) => {
    const m = fakeMention({ user, bot, channelId, content });
    await b.ask.mention(m);
    return m.replies;
  };
  return b;
}

const BOARD = '**Board · project**\n2 task(s) · building 1 · framed 1\n2 task(s) left. Time left is not estimated yet: the logbook has no estimate.\n2 open question(s):\n- G1 (T1): Which sort is the default?\n- G2 (T2): Ship the wake note?';
const GATES = '**Open questions · project** (2)\n- G1 (T1), team vote: Which sort is the default?\n  A. Name · B. Date\n- G2 (T2), answered at the terminal: Ship the wake note?\n  A. Yes · B. No';

test('each command answers an apprentice and a lead in private, from the safe columns only', async (t) => {
  const b = world(t);
  for (const who of [MAYA, JON]) {
    assert.deepEqual(await b.cmd(who, 'board'), [{ content: BOARD, ...PRIVATE }]);
    assert.deepEqual(await b.cmd(who, 'gates', { project: 'project' }), [{ content: GATES, ...PRIVATE }]);
    assert.deepEqual(await b.cmd(who, 'task', { id: 't1' }), [{ content: '**T1 · Board sort**\nsmall · building · pull request #17', ...PRIVATE }]);
    assert.deepEqual(await b.cmd(who, 'task', { id: 'T2' }), [{ content: '**T2 · Wake notes**\ntiny · framed · no pull request', ...PRIVATE }]);
    assert.deepEqual(await b.cmd(who, 'task', { id: 'T9' }), [{ content: 'project has no task T9.', ...PRIVATE }]);
    assert.deepEqual(await b.cmd(who, 'files'), [{ content: 'project shares no files.', ...PRIVATE }]);
  }
});

test('the PR of a task links to the repository when the project names one', async (t) => {
  const b = world(t);
  b.ask = b.makeAsk({ projects: [{ name: 'sage-bot', project: b.project, repo: 'https://github.com/sample/sage-bot' }] });
  assert.deepEqual(await b.cmd(MAYA, 'task', { id: 'T1' }), [{ content: '**T1 · Board sort**\nsmall · building · pull request [#17](<https://github.com/sample/sage-bot/pull/17>)', ...PRIVATE }]);
});

test('no answer holds text from decisions.tsv, findings, briefs, reports, a recommendation or a branch', async (t) => {
  const b = world(t);
  const all = [];
  for (const [sub, options] of [['board'], ['gates'], ['task', { id: 'T1' }], ['task', { id: 'T2' }], ['files']]) all.push(...await b.cmd(JON, sub, options));
  all.push(...await b.mention(MAYA, 'what is new?'));
  assert.equal(all.length, 6);
  for (const r of all) assert.ok(!JSON.stringify(r).toUpperCase().includes(SECRET), JSON.stringify(r));
});

test('a member with no role gets the role note; a bot gets nothing; both in private where there is a reply', async (t) => {
  const b = world(t);
  assert.deepEqual(await b.cmd(SAM, 'board'), [{ content: NO_ROLE, ...PRIVATE }]);
  assert.deepEqual(await b.cmd(BOT, 'board', {}, { roles: [APPRENTICE, LEADR], bot: true }), []);
  assert.deepEqual(await b.mention(BOT, 'hello', ASK, true), []);
});

test('a command outside #ask-sage gets a private pointer to it and no data', async (t) => {
  const b = world(t);
  assert.deepEqual(await b.cmd(MAYA, 'board', {}, { channelId: ELSEWHERE }), [{ content: `I answer /sage in <#${ASK}>, so please ask there.`, ...PRIVATE }]);
});

test('a project that is not in the list is refused, and the reply names no other project', async (t) => {
  const b = world(t);
  assert.deepEqual(await b.cmd(MAYA, 'board', { project: 'payroll' }), [{ content: 'I do not know a shared project called "payroll".', ...PRIVATE }]);
  assert.deepEqual(await b.cmd(MAYA, 'board', { project: '<@&1> **x**' }), [{ content: 'I do not know a shared project called "\\<@&1\\> \\*\\*x\\*\\*".', ...PRIVATE }]);
});

test('the 11th ask in a rolling hour is refused with the time of the next ask; refused asks count too', async (t) => {
  const b = world(t);
  await b.cmd(MAYA, 'board', {}, { channelId: ELSEWHERE }); // refused for the channel, still counts
  for (let n = 2; n <= 10; n++) { b.now += 60_000; assert.equal((await b.cmd(MAYA, 'task', { id: 'T1' }))[0].content.startsWith('**T1'), true); }
  const next = Math.floor((T0 + HOUR) / 1000);
  assert.deepEqual(await b.cmd(MAYA, 'board'), [{ content: `You asked 10 times in the last hour; that is the limit. Your next ask works at <t:${next}:t>.`, ...PRIVATE }]);
  assert.equal((await b.cmd(JON, 'board'))[0].content, BOARD); // the limit is per person
  b.now = T0 + HOUR + 1;
  assert.equal((await b.cmd(MAYA, 'board'))[0].content, BOARD);
});

test('a mention in #ask-sage gets one public pointer that pings nobody; a build ask gets the lead line; the limit holds with one note', async (t) => {
  const b = world(t);
  const quiet = { parse: [], repliedUser: false };
  assert.deepEqual(await b.mention(MAYA, '<@1> show the board'), [{ content: POINTER, allowedMentions: quiet }]);
  assert.deepEqual(await b.mention(SAM, '<@1> add a dark mode'), [{ content: `${POINTER} ${BUILDS}`, allowedMentions: quiet }]);
  for (let n = 2; n <= 10; n++) assert.equal((await b.mention(MAYA, 'hi')).length, 1);
  assert.deepEqual((await b.mention(MAYA, 'hi'))[0].content, `You asked 10 times in the last hour; that is the limit. Your next ask works at <t:${Math.floor((T0 + HOUR) / 1000)}:t>.`);
  assert.deepEqual(await b.mention(MAYA, 'hi'), []); // one note, not one per mention
  assert.equal((await b.cmd(MAYA, 'board'))[0].content.startsWith('You asked 10 times'), true); // mentions and commands share the count
});

test('a mention outside #ask-sage gets one pointer per person per day, then nothing', async (t) => {
  const b = world(t);
  const pointer = [{ content: `I answer in <#${ASK}>, so everyone can find the answers. Please ask there.`, allowedMentions: { parse: [], repliedUser: false } }];
  assert.deepEqual(await b.mention(MAYA, 'board?', ELSEWHERE), pointer);
  assert.deepEqual(await b.mention(MAYA, 'board?', ELSEWHERE), []);
  assert.deepEqual(await b.mention(JON, 'board?', ELSEWHERE), pointer);
  b.now += 24 * HOUR;
  assert.deepEqual(await b.mention(MAYA, 'board?', ELSEWHERE), pointer);
});

test('untrusted logbook text is made safe: no mention, no link, no markdown from a title or a question', async (t) => {
  const b = world(t);
  b.sh('task', 'add', '--title', '@everyone <@&300000000000000001> [x](https://evil.example) **bold**', '--size', 'tiny');
  assert.deepEqual(await b.cmd(MAYA, 'task', { id: 'T3' }), [{ content: '**T3 · @everyone \\<@&300000000000000001\\> \\[x\\](https:// evil.example) \\*\\*bold\\*\\***\ntiny · framed · no pull request', ...PRIVATE }]);
});

/** A project folder with files for /sage files. */
function filesProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'sage-bot-t71-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(join(project, 'docs'), { recursive: true });
  mkdirSync(join(project, 'design', 'shots'), { recursive: true });
  writeFileSync(join(root, 'outside.png'), 'outside');
  writeFileSync(join(project, 'docs', 'flow.svg'), '<svg/>');
  writeFileSync(join(project, 'docs', 'notes.md'), `notes ${SECRET}`);
  writeFileSync(join(project, 'docs', '.hidden.svg'), '<svg/>');
  writeFileSync(join(project, 'design', 'shots', 'big.png'), Buffer.alloc(MAX_FILE + 1));
  for (let n = 1; n <= 11; n++) writeFileSync(join(project, 'design', 'shots', `${String(n).padStart(2, '0')}.png`), Buffer.alloc(n));
  symlinkSync(join(root, 'outside.png'), join(project, 'design', 'shots', 'link.png'));
  symlinkSync(root, join(project, 'docs', 'up'));
  return project;
}

test('/sage files attaches only allow-listed files: regular, inside the project, of the allowed type and size, at most 10', async (t) => {
  const b = world(t);
  const project = filesProject(t);
  const ask = createAsk({ config: { ...CONFIG, askChannelId: ASK, sagePath: SAGE, statePath: b.statePath,
    projects: [{ name: 'site', project, files: ['docs/*.svg', 'docs/up/*.png', 'design/shots/*.png'] }] }, now: () => b.now, log: () => {} });
  const i = fakeCommand({ user: MAYA, roles: [APPRENTICE], channelId: ASK, sub: 'files', options: {} });
  await ask.command(i);
  const names = ['design/shots/01.png', 'design/shots/02.png', 'design/shots/03.png', 'design/shots/04.png', 'design/shots/05.png',
    'design/shots/06.png', 'design/shots/07.png', 'design/shots/08.png', 'design/shots/09.png', 'design/shots/10.png'];
  assert.deepEqual(i.replies, [{
    content: `10 shared file(s) of site:\n${names.map((n) => `- ${n}`).join('\n')}`,
    files: names.map((n, k) => ({ name: n.split('/').at(-1), size: k + 1 })), ...PRIVATE }]);
  const one = createAsk({ config: { ...CONFIG, askChannelId: ASK, sagePath: SAGE, statePath: b.statePath, projects: [{ name: 'site', project, files: ['docs/*.svg', 'docs/up/*.png', 'design/shots/big.png', 'design/shots/link.png'] }] }, log: () => {} });
  const j = fakeCommand({ user: MAYA, roles: [APPRENTICE], channelId: ASK, sub: 'files' });
  await one.command(j);
  assert.deepEqual(j.replies[0].files, [{ name: 'flow.svg', size: 6 }]); // not .hidden.svg, notes.md, outside.png through docs/up, the 8 MB + 1 big.png or the symlink link.png
});

test('the config is checked at load: a traversal, a type or an absolute file entry, an unsafe name, a relative path, no askChannelId', () => {
  const base = { ...CONFIG, askChannelId: ASK, project: '/p/sage-bot', sagePath: '/s/sage.mjs', statePath: '/st/gates.json' };
  assert.deepEqual(projectsOf(base), [{ name: 'sage-bot', project: '/p/sage-bot', sagePath: '/s/sage.mjs', files: [] }]);
  for (const f of ['../x.png', 'docs/../../x.png', '/etc/x.png', 'docs/*.txt', 'docs/*/x.png', '.git/x.png', 'docs/x.png.exe', 'docs\\..\\x.png', 'x.PNG']) {
    assert.throws(() => projectsOf({ ...base, projects: [{ name: 'a', project: '/p', files: [f] }] }), { message: `projects[0].files: ${JSON.stringify(f)} must be a path in the project, such as "docs/*.svg", with no "..", and end in .png, .jpg, .svg, .pdf` });
  }
  assert.throws(() => projectsOf({ ...base, projects: [{ name: 'A b', project: '/p' }] }), { message: 'projects[0].name must be a new name of lower-case letters, digits and dashes (at most 32)' });
  assert.throws(() => projectsOf({ ...base, projects: [{ name: 'a', project: '/p' }, { name: 'a', project: '/q' }] }), { message: 'projects[1].name must be a new name of lower-case letters, digits and dashes (at most 32)' });
  assert.throws(() => projectsOf({ ...base, projects: [{ name: 'a', project: 'p' }] }), { message: 'projects[0].project must be an absolute path' });
  assert.throws(() => projectsOf({ ...base, projects: [{ name: 'a', project: '/p', repo: 'https://evil.example/x' }] }), { message: 'projects[0].repo must be https://github.com/<owner>/<name>' });
  assert.throws(() => createAsk({ config: { ...base, askChannelId: undefined } }), { message: 'the config needs askChannelId as a Discord id (17 to 20 digits): the id of #ask-sage' });
  assert.deepEqual(projectsOf({ ...base, projects: [{ name: 'site', project: '/p', sagePath: '/o/sage.mjs', files: ['design/b2/shots/*.png'] }] }),
    [{ name: 'site', project: '/p', sagePath: '/o/sage.mjs', files: ['design/b2/shots/*.png'] }]);
});

test('the /sage command has four subcommands, guild only, with the listed projects as the only choices', () => {
  const json = askCommand([{ name: 'sage-bot' }, { name: 'site' }]);
  assert.equal(json.name, 'sage');
  assert.deepEqual(json.contexts, [0]);
  assert.deepEqual(json.options.map((s) => [s.name, s.options.map((o) => [o.name, o.required ?? false, o.choices?.map((c) => c.value)])]), [
    ['board', [['project', false, ['sage-bot', 'site']]]],
    ['task', [['id', true, undefined], ['project', false, ['sage-bot', 'site']]]],
    ['gates', [['project', false, ['sage-bot', 'site']]]],
    ['files', [['project', false, ['sage-bot', 'site']]]],
  ]);
});

test('rolesOf reads the roles from Discord data: a GuildMember or the raw API member', () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const guild = client.guilds._add({ id: '200000000000000001', name: 'sample', members: [], roles: [
      { id: '200000000000000001', name: '@everyone', permissions: '0', position: 0 }, { id: APPRENTICE, name: 'sage-apprentice', permissions: '0', position: 1 }] });
    const maya = guild.members._add({ user: { id: MAYA, username: 'maya' }, roles: [APPRENTICE], joined_at: new Date(0).toISOString() });
    assert.deepEqual(rolesOf(maya), ['200000000000000001', APPRENTICE]);
    assert.deepEqual(rolesOf({ roles: [LEADR] }), [LEADR]);
    assert.deepEqual(rolesOf(null), []);
  } finally {
    client.destroy();
  }
});

test('launchd.mjs refuses a config whose projects the bridge would refuse, with the same message, and prints no plist', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-bot-t71-launchd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = new URL('..', import.meta.url).pathname;
  const sample = JSON.parse(readFileSync(join(root, 'examples/config.example.json'), 'utf8'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ ...sample, projects: [{ name: 'site', project: '/p', files: ['../secrets/*.png'] }] }));
  const r = spawnSync(process.execPath, [join(root, 'scripts/launchd.mjs'), path], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `sage-bot launchd: in the config file ${path}, projects[0].files: "../secrets/*.png" must be a path in the project, such as "docs/*.svg", with no "..", and end in .png, .jpg, .svg, .pdf. No plist printed.\n`);
});
