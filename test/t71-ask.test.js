// T71: the read commands of #ask-sage (/sage board, task, gates, files) and the pointer for an @sage-bot mention, on a scratch logbook
// with the fake Discord. SAMPLE DATA ONLY: every id, name and file is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { askCommand, attachmentName, BUILDS, createAsk, HOUR, MAX_BYTES, POINTER, projectsOf, readShared, sharedFiles } from '../src/ask.js';
import { rolesOf, routes } from '../src/discord.js';
import { fakeCommand, fakeMention } from '../src/fake-discord.js';
import { APPRENTICE, BOT, CONFIG, JON, LEADR, MAYA, SAGE, SAM, setup, T0 } from './bridge-setup.js';

const ASK = '400000000000000009';
const ELSEWHERE = '400000000000000001';
const SECRET = 'ZZSECRET';
const PUBLIC = { allowedMentions: { parse: [] } }; // on the edit; the defer before it is public too (checked in `answers`), G20
const ROLES = { [MAYA]: [APPRENTICE], [JON]: [LEADR] };

/** The edits of a fake command's reply, after a check that its first call is one public defer: no flags, so not Ephemeral (64). */
function answers(i) {
  assert.deepEqual(i.replies[0], { kind: 'defer' });
  assert.ok(i.replies.slice(1).every((r) => r.kind === 'edit'), JSON.stringify(i.replies));
  return i.replies.slice(1).map(({ kind, ...payload }) => payload);
}

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
  b.sh('gate', 'add', 'T1', '--question', 'Which sort is the default?', '--options', 'Name|Date', '--recommend', 'Name', '--default', 'Date');
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
    const i = fakeCommand({ user, roles: o.roles ?? ROLES[user] ?? [], bot: o.bot, channelId: o.channelId ?? ASK, parentId: o.parentId, sub, options, onDefer: o.onDefer });
    await b.ask.command(i);
    return o.bot ? i.replies : answers(i);
  };
  b.mention = async (user, content, channelId = ASK, bot = false, parentId = null) => {
    const m = fakeMention({ user, roles: ROLES[user] ?? [], bot, channelId, parentId, content });
    await b.ask.mention(m);
    return m.replies;
  };
  return b;
}

const G1 = '  A. Name · B. Date\n  Recommended: Name · Default: Date';
const G2 = '  A. Yes · B. No\n  Recommended: Yes';
const BOARD = "**Board · project**\n2 task(s) · building 1 · framed 1\n2 task(s) left. Time left is not estimated yet: the project's records have no estimate.\n2 open question(s):\n- G1 (T1): Which sort is the default?\n  A. Name · B. Date\n- G2 (T2): Ship the wake note?\n  A. Yes · B. No";
const GATES = `**Open questions · project** (2)\n- G1 (T1), team vote: Which sort is the default?\n${G1}\n- G2 (T2), answered at the terminal: Ship the wake note?\n${G2}`;

test('each command answers an apprentice and a lead in public (G20), from the safe columns only', async (t) => {
  const b = world(t);
  for (const who of [MAYA, JON]) {
    assert.deepEqual(await b.cmd(who, 'board'), [{ content: BOARD, ...PUBLIC }]);
    assert.deepEqual(await b.cmd(who, 'gates', { project: 'project' }), [{ content: GATES, ...PUBLIC }]);
    assert.deepEqual(await b.cmd(who, 'task', { id: 't1' }), [{ content: '**T1 · Board sort**\nsmall · building · pull request #17', ...PUBLIC }]);
    assert.deepEqual(await b.cmd(who, 'task', { id: 'T2' }), [{ content: '**T2 · Wake notes**\ntiny · framed · no pull request', ...PUBLIC }]);
    assert.deepEqual(await b.cmd(who, 'task', { id: 'T9' }), [{ content: 'project has no task T9.', ...PUBLIC }]);
    assert.deepEqual(await b.cmd(who, 'files'), [{ content: 'project shares no files.', ...PUBLIC }]);
  }
});

test('the PR of a task links to the repository when the project names one', async (t) => {
  const b = world(t);
  b.ask = b.makeAsk({ projects: [{ name: 'sage-bot', project: b.project, repo: 'https://github.com/sample/sage-bot' }] });
  assert.deepEqual(await b.cmd(MAYA, 'task', { id: 'T1' }), [{ content: '**T1 · Board sort**\nsmall · building · pull request [#17](<https://github.com/sample/sage-bot/pull/17>)', ...PUBLIC }]);
});

test('no answer holds text from decisions.tsv, findings, briefs, reports, a why or a branch; the open questions show in full (G20)', async (t) => {
  const b = world(t);
  b.sh('gate', 'add', 'T2', '--question', 'Rename the <@&300000000000000001> field?', '--options', 'Yes|**No**', '--recommend', '@everyone [x](https://evil.example)', '--default', '`No`');
  const all = [];
  for (const [sub, options] of [['board'], ['gates'], ['task', { id: 'T1' }], ['task', { id: 'T2' }], ['files']]) all.push(...await b.cmd(JON, sub, options));
  all.push(...await b.mention(MAYA, 'what is new?'));
  assert.equal(all.length, 6);
  for (const r of all) assert.ok(!JSON.stringify(r).toUpperCase().includes(SECRET), JSON.stringify(r));
  // The recommendation and the default of each open question, escaped as all logbook text: no ping, no link, no markdown.
  const g3 = 'G3 (T2), answered at the terminal: Rename the \\<@&300000000000000001\\> field?\n  A. Yes · B. \\*\\*No\\*\\*\n  Recommended: @everyone \\[x\\](https:// evil.example) · Default: No';
  assert.deepEqual(all[1], { content: `${GATES.replace('(2)', '(3)')}\n- ${g3}`, ...PUBLIC });
  assert.ok(all[0].content.endsWith('\n- G3 (T2): Rename the \\<@&300000000000000001\\> field?\n  A. Yes · B. \\*\\*No\\*\\*'), all[0].content); // no advice on the board
});

/** Six more open questions of T2 (G3 to G8), each of about the longest normal size: 130 characters, 3 options, a 100-character recommendation. */
function sixLong(b) {
  for (let n = 3; n <= 8; n++) {
    b.sh('gate', 'add', 'T2', '--question', `Q${n} ${'q'.repeat(126)}?`, '--options', 'First option|Second option|Third option', '--recommend', `R${n} ${'r'.repeat(96)}`, '--default', 'First option');
  }
}
const isWhole = (content) => { // every heading in the reply shows its question to the end
  const heads = [...content.matchAll(/^- G(\d+) \(T\d\)[^:]*: (.*)$/gm)].filter((m) => Number(m[1]) > 2);
  assert.ok(heads.length >= 4, content);
  for (const [, n, text] of heads) assert.equal(text, `Q${n} ${'q'.repeat(126)}?`);
};

test('F-T95-1: /sage gates shows the open questions that fit in full, then "N more open question(s)" with the ids of the rest', async (t) => {
  const b = world(t);
  sixLong(b);
  const [{ content }] = await b.cmd(MAYA, 'gates');
  assert.ok(content.length <= 2000, String(content.length));
  assert.deepEqual(content.match(/^- G\d/gm), ['- G1', '- G2', '- G3', '- G4', '- G5', '- G6']);
  assert.ok(content.endsWith(`  Recommended: R6 ${'r'.repeat(96)} · Default: First option\n2 more open question(s): G7, G8.`), content);
  assert.ok(!content.includes('…'), content);
  isWhole(content);
});

test('F-T95-1: when even the ids of the rest do not fit, the reply ends with their count', async (t) => {
  const b = world(t);
  sixLong(b);
  // 400 more open questions, written as rows of gates.tsv in the scratch logbook (one `sage gate add` each would take minutes).
  const rows = Array.from({ length: 400 }, (_, i) => `G${i + 9}\tT2\tShort ${i + 9}?\tYes|No\tYes\tNo\t\t\n`).join('');
  appendFileSync(join(b.sh('logbook'), 'gates.tsv'), rows);
  const [{ content }] = await b.cmd(MAYA, 'gates');
  assert.ok(content.length <= 2000, String(content.length));
  assert.match(content, /^\*\*Open questions · project\*\* \(408\)\n/);
  assert.equal(content.match(/^- G\d/gm).length, 6);
  assert.ok(content.endsWith(`· Default: First option\n402 more open question(s).`), content);
});

test('F-T95-1: the board shows no advice line, and the same "N more open question(s)" line when its list does not fit', async (t) => {
  const b = world(t);
  sixLong(b);
  for (let n = 9; n <= 14; n++) b.sh('gate', 'add', 'T2', '--question', `Q${n} ${'q'.repeat(126)}?`, '--options', 'First option|Second option|Third option', '--recommend', 'x');
  const [{ content }] = await b.cmd(MAYA, 'board');
  assert.ok(content.length <= 2000, String(content.length));
  assert.ok(!/Recommended|Default/.test(content), content);
  assert.match(content, /\n14 open question\(s\):\n- G1 \(T1\): Which sort is the default\?\n  A\. Name · B\. Date\n- G2 /);
  assert.equal(content.match(/^- G\d+/gm).length, 10);
  assert.ok(content.endsWith('\n  A. First option · B. Second option · C. Third option\n4 more open question(s): G11, G12, G13, G14.'), content);
  isWhole(content);
});

test('G20: a member with neither sage role gets nothing for a command or a mention, and nothing counts; a bot gets nothing', async (t) => {
  const b = world(t);
  const command = async (user, roles, channelId = ASK) => {
    const i = fakeCommand({ user, roles, channelId, sub: 'board' });
    await b.ask.command(i);
    return i.replies;
  };
  const say = async (user, roles, content, channelId = ASK) => {
    const m = fakeMention({ user, roles, channelId, content });
    await b.ask.mention(m);
    return m.replies;
  };
  for (let n = 1; n <= 12; n++) { // past the limit of 10: no note either
    assert.deepEqual(await command(SAM, []), [], `command ${n}`);
    assert.deepEqual(await command(SAM, ['300000000000000123'], ELSEWHERE), [], `command elsewhere ${n}`);
    assert.deepEqual(await say(SAM, [], '<@1> what is new?'), [], `mention ${n}`);
    assert.deepEqual(await say(SAM, [], '<@1> add a dark mode', ELSEWHERE), [], `mention elsewhere ${n}`);
  }
  assert.deepEqual(b.lines, []);
  // Nothing counted: with a role, Sam gets his daily pointer elsewhere, 9 pointers and a 10th answer here, then the limit note.
  assert.deepEqual(await say(SAM, [APPRENTICE], '<@1> board?', ELSEWHERE), [{ content: `I answer in <#${ASK}>, so everyone can find the answers. Please ask there.`, allowedMentions: { parse: [], repliedUser: false } }]);
  for (let n = 1; n <= 9; n++) assert.deepEqual(await say(SAM, [APPRENTICE], 'hi'), [{ content: POINTER, allowedMentions: { parse: [], repliedUser: false } }], `ask ${n}`);
  assert.deepEqual(await b.cmd(SAM, 'board', {}, { roles: [APPRENTICE] }), [{ content: BOARD, ...PUBLIC }]);
  assert.match((await b.cmd(SAM, 'board', {}, { roles: [APPRENTICE] }))[0].content, /^You asked 10 times in the last hour/);
  assert.deepEqual(await b.cmd(BOT, 'board', {}, { roles: [APPRENTICE, LEADR], bot: true }), []);
  assert.deepEqual(await b.mention(BOT, 'hello', ASK, true), []);
});

test('a command outside #ask-sage gets a public pointer to it and no data', async (t) => {
  const b = world(t);
  assert.deepEqual(await b.cmd(MAYA, 'board', {}, { channelId: ELSEWHERE }), [{ content: `I answer /sage in <#${ASK}>, so please ask there.`, ...PUBLIC }]);
});

test('a project that is not in the list is refused, and the reply names no other project', async (t) => {
  const b = world(t);
  assert.deepEqual(await b.cmd(MAYA, 'board', { project: 'payroll' }), [{ content: 'I do not know a shared project called "payroll".', ...PUBLIC }]);
  assert.deepEqual(await b.cmd(MAYA, 'board', { project: '<@&1> **x**' }), [{ content: 'I do not know a shared project called "\\<@&1\\> \\*\\*x\\*\\*".', ...PUBLIC }]);
});

test('the 11th ask in a rolling hour is refused in public with the time of the next ask; refused asks count too', async (t) => {
  const b = world(t);
  await b.cmd(MAYA, 'board', {}, { channelId: ELSEWHERE }); // refused for the channel, still counts
  for (let n = 2; n <= 10; n++) { b.now += 60_000; assert.equal((await b.cmd(MAYA, 'task', { id: 'T1' }))[0].content.startsWith('**T1'), true); }
  const next = Math.floor((T0 + HOUR) / 1000);
  assert.deepEqual(await b.cmd(MAYA, 'board'), [{ content: `You asked 10 times in the last hour; that is the limit. Your next ask works at <t:${next}:t>.`, ...PUBLIC }]);
  assert.equal((await b.cmd(JON, 'board'))[0].content, BOARD); // the limit is per person
  b.now = T0 + HOUR + 1;
  assert.equal((await b.cmd(MAYA, 'board'))[0].content, BOARD);
});

test('a mention in #ask-sage gets one public pointer that pings nobody; a build ask gets the lead line; the limit holds with one note', async (t) => {
  const b = world(t);
  const quiet = { parse: [], repliedUser: false };
  assert.deepEqual(await b.mention(MAYA, '<@1> show the board'), [{ content: POINTER, allowedMentions: quiet }]);
  assert.deepEqual(await b.mention(MAYA, '<@1> add a dark mode'), [{ content: `${POINTER} ${BUILDS}`, allowedMentions: quiet }]);
  for (let n = 3; n <= 10; n++) assert.equal((await b.mention(MAYA, 'hi')).length, 1);
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
  assert.deepEqual(await b.cmd(MAYA, 'task', { id: 'T3' }), [{ content: '**T3 · @everyone \\<@&300000000000000001\\> \\[x\\](https:// evil.example) \\*\\*bold\\*\\***\ntiny · framed · no pull request', ...PUBLIC }]);
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
  writeFileSync(join(project, 'design', 'shots', 'big.png'), Buffer.alloc(MAX_BYTES + 1));
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
  const got = (await ask.command(i), answers(i));
  const names = ['design/shots/01.png', 'design/shots/02.png', 'design/shots/03.png', 'design/shots/04.png', 'design/shots/05.png',
    'design/shots/06.png', 'design/shots/07.png', 'design/shots/08.png', 'design/shots/09.png', 'design/shots/10.png'];
  assert.deepEqual(got, [{
    content: `10 shared file(s) of site:\n${names.map((n) => `- ${n}`).join('\n')}`,
    files: names.map((n, k) => ({ name: n.split('/').at(-1), size: k + 1 })), ...PUBLIC }]);
  const one = createAsk({ config: { ...CONFIG, askChannelId: ASK, sagePath: SAGE, statePath: b.statePath, projects: [{ name: 'site', project, files: ['docs/*.svg', 'docs/up/*.png', 'design/shots/big.png', 'design/shots/link.png'] }] }, log: () => {} });
  const j = fakeCommand({ user: MAYA, roles: [APPRENTICE], channelId: ASK, sub: 'files' });
  await one.command(j);
  assert.deepEqual(answers(j)[0].files, [{ name: 'flow.svg', size: 6 }]); // not .hidden.svg, notes.md, outside.png through docs/up, the 8 MB + 1 big.png or the symlink link.png
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

// ---- Repair round 1 (R333): the findings of R329, R330 and R332. ----

const POINTER_TEXT = "I do not answer free questions yet. Use /sage board, task, gates or files to read the project's records, or ask a lead.";
const THREAD = '400000000000000077';

/** A project folder `site` with the given files (name → content), and an ask whose only project is it, with `files` as its allow-list. */
function site(t, b, contents, files) {
  const root = mkdtempSync(join(tmpdir(), 'sage-bot-r333-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'site');
  mkdirSync(join(project, 'shots'), { recursive: true });
  for (const [name, content] of Object.entries(contents)) writeFileSync(join(project, 'shots', name), content);
  const config = { ...CONFIG, askChannelId: ASK, sagePath: SAGE, statePath: b.statePath, projects: [{ name: 'site', project, files }] };
  return { root, project, config, ask: createAsk({ config, now: () => b.now, log: (l) => b.lines.push(l) }) };
}
const files = async (ask, o = {}) => {
  const i = fakeCommand({ user: MAYA, roles: [APPRENTICE], channelId: ASK, sub: 'files', ...o });
  await ask.command(i);
  return answers(i);
};

test('F-T71-2: every /sage command defers in public before any file or logbook work, then edits that reply', async (t) => {
  const b = world(t);
  // The defer adds a task and a file: an answer that shows them did its work after the defer.
  const [board] = await b.cmd(MAYA, 'board', {}, { onDefer: () => b.sh('task', 'add', '--title', 'Added during the defer', '--size', 'tiny') });
  assert.equal(board.content.split('\n')[1], '3 task(s) · building 1 · framed 2');
  const s = site(t, b, { 'a.svg': '<svg/>' }, ['shots/*.svg']);
  assert.deepEqual(await files(s.ask, { onDefer: () => writeFileSync(join(s.project, 'shots', 'b.svg'), '<svg>b</svg>') }),
    [{ content: '2 shared file(s) of site:\n- shots/a.svg\n- shots/b.svg', files: [{ name: 'a.svg', size: 6 }, { name: 'b.svg', size: 12 }], ...PUBLIC }]);
  // A defer that Discord refuses (the interaction is gone) ends the command: no edit, one log line.
  const i = fakeCommand({ user: MAYA, roles: [APPRENTICE], channelId: ASK, sub: 'board' });
  i.defer = async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
  await b.ask.command(i);
  assert.deepEqual(i.replies, []);
  assert.equal(b.lines.at(-1), 'Discord refused to defer a /sage reply: code 10062: Unknown interaction');
});

test('F-T71-2: the first ask runs the logbook lookup once; a lookup that fails is tried again on the next ask', async (t) => {
  const b = world(t);
  const calls = join(b.root, 'calls.txt');
  const fail = join(b.root, 'fail');
  const wrapper = join(b.root, 'counting-sage.mjs'); // the real sage state tool, with a record of each call
  writeFileSync(wrapper, `import { appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(calls)}, process.argv[2] + '\\n');
if (existsSync(${JSON.stringify(fail)})) process.exit(3);
process.exit(spawnSync(process.execPath, [${JSON.stringify(SAGE)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1);
`);
  const lookups = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((l) => l === 'logbook').length : 0);
  b.ask = b.makeAsk({ sagePath: wrapper });
  writeFileSync(fail, '');
  assert.deepEqual(await b.cmd(MAYA, 'board'), [{ content: 'I could not read the records of project just now. Nothing is lost. Please ask again in a minute.', ...PUBLIC }]);
  assert.equal(lookups(), 1);
  rmSync(fail);
  assert.deepEqual(await b.cmd(MAYA, 'board'), [{ content: BOARD, ...PUBLIC }]);
  assert.equal(lookups(), 2);
  assert.deepEqual(await b.cmd(MAYA, 'gates'), [{ content: GATES, ...PUBLIC }]);
  assert.equal(lookups(), 2);
});

test('F-T71-1: /sage files sends at most 8 MB in one reply; the files that do not fit are listed as not attached', async (t) => {
  const b = world(t);
  const big = Buffer.alloc(MAX_BYTES);
  const names = Array.from({ length: 10 }, (_, n) => `a${String(n + 1).padStart(2, '0')}.png`);
  const s = site(t, b, Object.fromEntries(names.map((n) => [n, big])), ['shots/*.png']);
  const [got] = await files(s.ask);
  assert.deepEqual(got.files, [{ name: 'a01.png', size: 8 * 1024 * 1024 }]);
  assert.equal(got.content, ['1 shared file(s) of site:', '- shots/a01.png', '9 more file(s) not attached: one reply holds at most 8 MB. Ask a lead for them.',
    ...names.slice(1).map((n) => `- shots/${n}`)].join('\n'));
  // A smaller file after one that does not fit still comes: 5 + 3 MB fit, 4 MB does not.
  const mb = (n) => Buffer.alloc(n * 1024 * 1024);
  const mix = site(t, b, { 'b1.png': mb(5), 'b2.png': mb(4), 'b3.png': mb(3) }, ['shots/*.png']);
  assert.deepEqual(await files(mix.ask), [{ content: '2 shared file(s) of site:\n- shots/b1.png\n- shots/b3.png\n1 more file(s) not attached: one reply holds at most 8 MB. Ask a lead for them.\n- shots/b2.png',
    files: [{ name: 'b1.png', size: 5 * 1024 * 1024 }, { name: 'b3.png', size: 3 * 1024 * 1024 }], ...PUBLIC }]);
});

test('F-T71S-1: a file swapped between the check and the read is never sent: not for a symlink, not for another file', async (t) => {
  const b = world(t);
  const s = site(t, b, { 'real.svg': '<svg/>' }, ['shots/*.svg']);
  const outside = join(s.root, 'outside.svg');
  const real = join(s.project, 'shots', 'real.svg');
  writeFileSync(outside, SECRET);
  const p = s.ask.projects[0];
  const text = (r) => ({ attached: r.attached.map((f) => [f.name, f.data.toString()]), over: r.over });
  assert.deepEqual(text(readShared(sharedFiles(p))), { attached: [['shots/real.svg', '<svg/>']], over: [] });
  let checked = sharedFiles(p);
  rmSync(real);
  symlinkSync(outside, real); // after the check, before the read
  assert.deepEqual(text(readShared(checked)), { attached: [], over: [] });
  rmSync(real);
  writeFileSync(real, '<svg/>');
  checked = sharedFiles(p);
  renameSync(outside, real); // another regular file in its place: another inode
  assert.deepEqual(text(readShared(checked)), { attached: [], over: [] });
});

test('F-T71S-2 and F-T71-3: a dangling symlink is skipped and the other files still come; an in-project symlink is left out', async (t) => {
  const b = world(t);
  const s = site(t, b, { 'ok.svg': '<svg/>', 'real.svg': '<svg>r</svg>' }, ['shots/*.svg']);
  symlinkSync(join(s.root, 'missing.svg'), join(s.project, 'shots', 'gone.svg'));
  assert.deepEqual(await files(s.ask), [{ content: '2 shared file(s) of site:\n- shots/ok.svg\n- shots/real.svg', files: [{ name: 'ok.svg', size: 6 }, { name: 'real.svg', size: 12 }], ...PUBLIC }]);
  symlinkSync(join(s.project, 'shots', 'real.svg'), join(s.project, 'shots', 'inlink.svg'));
  const only = createAsk({ config: { ...s.config, projects: [{ name: 'site', project: s.project, files: ['shots/inlink.svg'] }] }, log: () => {} });
  assert.deepEqual(await files(only), [{ content: 'site shares no files.', ...PUBLIC }]);
});

test('F-T71Q-2: an attachment name keeps only A-Z, a-z, 0-9, dot, dash and underscore: a sweep over every code point', async (t) => {
  const keep = /^[A-Za-z0-9._-]$/u;
  const wrong = [];
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    const ch = String.fromCodePoint(cp);
    const out = attachmentName(`a${ch}.png`);
    if (out !== (keep.test(ch) ? `a${ch}.png` : 'a_.png')) wrong.push(cp.toString(16));
  }
  assert.deepEqual(wrong, []);
  const b = world(t);
  const s = site(t, b, { 'evil‮gpj.\nx.svg': '<svg/>' }, ['shots/*.svg']);
  const [got] = await files(s.ask);
  assert.deepEqual(got.files, [{ name: 'evil_gpj._x.svg', size: 6 }]);
  assert.equal(got.content, '1 shared file(s) of site:\n- shots/evilgpj. x.svg'); // the list goes through `safe`
});

test('F-T71-5: a /sage command and a mention in a thread of #ask-sage count as #ask-sage; a thread of another channel does not', async (t) => {
  const b = world(t);
  assert.deepEqual(await b.cmd(MAYA, 'board', {}, { channelId: THREAD, parentId: ASK }), [{ content: BOARD, ...PUBLIC }]);
  assert.deepEqual(await b.cmd(MAYA, 'board', {}, { channelId: THREAD, parentId: Promise.resolve(ASK) }), [{ content: BOARD, ...PUBLIC }]);
  assert.deepEqual(await b.cmd(MAYA, 'board', {}, { channelId: THREAD, parentId: ELSEWHERE }), [{ content: `I answer /sage in <#${ASK}>, so please ask there.`, ...PUBLIC }]);
  const quiet = { parse: [], repliedUser: false };
  assert.deepEqual(await b.mention(MAYA, '<@1> hi', THREAD, false, ASK), [{ content: POINTER_TEXT, allowedMentions: quiet }]);
  assert.deepEqual(await b.mention(JON, '<@1> hi', THREAD, false, ELSEWHERE), [{ content: `I answer in <#${ASK}>, so everyone can find the answers. Please ask there.`, allowedMentions: quiet }]);
});

test('F-T71Q-3 and F-T71Q-4: the mention copy fits the reader: a lead, an apprentice, a build verb that starts a sentence', async (t) => {
  const b = world(t);
  const say = async (who, text) => (await b.mention(who, text))[0]?.content;
  assert.equal(await say(MAYA, '<@1> what is new?'), POINTER_TEXT);
  assert.equal(await say(JON, '<@1> add a dark mode'), `${POINTER_TEXT} Builds from Discord are not ready yet.`);
  for (const text of ['<@1> any update on T7?', '<@1> does that make sense?', '<@1> is the merge done?']) assert.equal(await say(MAYA, text), POINTER_TEXT, text);
  b.now += HOUR; // a new hour, so that the limit does not end the list
  for (const text of ['<@1> add a dark mode', '<@1> please fix the login', '<@1> can you update the README?', '<@1> Thanks. Merge it now']) {
    assert.equal(await say(MAYA, text), `${POINTER_TEXT} Builds are for sage-leads: ask a lead.`, text);
  }
});

test('F-T71Q-5: with no projects, a folder name that makes no valid name gets a message with the cause and the fix', () => {
  const base = { ...CONFIG, askChannelId: ASK, sagePath: '/s/sage.mjs', statePath: '/st/gates.json' };
  const fix = 'makes no valid project name: add a projects entry with a name of lower-case letters, digits and dashes (at most 32)';
  assert.throws(() => projectsOf({ ...base, project: '/Users/x/_scratch' }), { message: `the config has no projects, and the folder name of project ("_scratch") ${fix}` });
  assert.throws(() => projectsOf({ ...base, project: `/Users/x/${'a'.repeat(33)}` }), { message: `the config has no projects, and the folder name of project ("${'a'.repeat(33)}") ${fix}` });
  assert.throws(() => projectsOf({ ...base, project: 'x' }), { message: 'the config: project must be an absolute path' });
  assert.throws(() => projectsOf({ ...base, project: '/Users/x/site', sagePath: undefined }), { message: 'the config: sagePath must be an absolute path' });
  assert.deepEqual(projectsOf({ ...base, project: '/Users/x/My Site' }), [{ name: 'my-site', project: '/Users/x/My Site', sagePath: '/s/sage.mjs', files: [] }]);
});

/** A chat command as discord.js gives it, for `routes`: roles only on `member`; every string option answers `strings[name]`. SAMPLE DATA ONLY. */
function chat({ guildId = CONFIG_GUILD, user = MAYA, roles = [APPRENTICE], channelId = ASK, channel = null, sub = 'board', strings = {} } = {}) {
  const calls = [];
  return { calls, guildId, commandName: 'sage', user: { id: user, bot: false }, member: { roles }, channelId, channel,
    isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false,
    options: { getSubcommand: () => sub, getString: (name) => strings[name] ?? null },
    deferReply: async (p) => { calls.push(['defer', p]); }, editReply: async (p) => { calls.push(['edit', p.content]); } };
}
/** A message as discord.js gives it, for `routes`. SAMPLE DATA ONLY. */
function message({ guildId = CONFIG_GUILD, author = MAYA, bot = false, roles = [APPRENTICE], mentions = [BOT_USER], channelId = ASK, channel = null, content = '<@1> hi' } = {}) {
  const calls = [];
  return { calls, guildId, author: { id: author, bot }, member: { roles }, mentions: { users: new Map(mentions.map((id) => [id, {}])) }, channelId, channel, content,
    reply: async (p) => { calls.push(p.content); } };
}
const CONFIG_GUILD = '200000000000000001';
const BOT_USER = '100000000000000099';

test('F-T71-4: routes take roles from the member, never from options, and answer only their own guild and mentions of the bot', async (t) => {
  const b = world(t);
  const pressed = [];
  const fetch = async (id) => (id === THREAD ? { isThread: () => true, parentId: ASK } : { isThread: () => false });
  const on = routes({ config: { ...CONFIG, guildId: CONFIG_GUILD }, ask: b.ask, bridge: { interaction: async (i) => { pressed.push(i); } }, fetch, botId: BOT_USER });
  const run = async (i, f = 'interaction') => { await on[f](i); return i.calls; };
  const defer = ['defer', {}]; // public (G20)
  // Roles come from the member: an option that names the lead role changes nothing, and a member with no role gets nothing (G20).
  assert.deepEqual(await run(chat({ roles: [], strings: { role: LEADR, roles: LEADR } })), []);
  assert.deepEqual(await run(chat({ user: JON, roles: [LEADR] })), [defer, ['edit', BOARD]]);
  assert.deepEqual(await run(chat({ user: JON, roles: [LEADR], guildId: '200000000000000002' })), []);
  assert.deepEqual(await run(chat({ user: JON, roles: [LEADR], channelId: THREAD })), [defer, ['edit', BOARD]]); // a thread of #ask-sage, not in the cache
  assert.deepEqual(await run(chat({ user: JON, roles: [LEADR], channelId: THREAD, channel: { isThread: () => true, parentId: ELSEWHERE } })),
    [defer, ['edit', `I answer /sage in <#${ASK}>, so please ask there.`]]);
  // Messages: only this guild, only people, only a mention of the bot.
  assert.deepEqual(await run(message({ guildId: '200000000000000002' }), 'message'), []);
  assert.deepEqual(await run(message({ bot: true }), 'message'), []);
  assert.deepEqual(await run(message({ mentions: [JON] }), 'message'), []);
  assert.deepEqual(await run(message({ author: JON, roles: [LEADR], content: '<@1> fix the login' }), 'message'), [`${POINTER_TEXT} Builds from Discord are not ready yet.`]);
  assert.deepEqual(await run(message({ channelId: THREAD }), 'message'), [POINTER_TEXT]);
  assert.deepEqual(pressed, []);
});

// ---- Repair round 2 (R351): the mutations that survived code review R347. ----

/** Sets the state of tasks in tasks.tsv. The state tool lets a task reach merged or concluded only through its route, so the test writes the row. */
function setStates(b, states) {
  const path = join(b.sh('logbook'), 'tasks.tsv');
  const [head, ...rows] = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const col = head.split('\t').indexOf('state');
  writeFileSync(path, `${[head, ...rows.map((l) => { const v = l.split('\t'); if (v[0] in states) v[col] = states[v[0]]; return v.join('\t'); })].join('\n')}\n`);
}

test('F-T71-10 and F-T71-12: an answered question is not open; merged, concluded and abandoned tasks are not left', async (t) => {
  const b = world(t);
  b.sh('gate', 'answer', 'G2', 'Yes');
  b.sh('task', 'add', '--title', 'Spike', '--size', 'tiny');
  b.sh('task', 'add', '--title', 'Dropped', '--size', 'tiny');
  setStates(b, { T1: 'merged', T3: 'concluded', T4: 'abandoned' });
  assert.deepEqual(await b.cmd(MAYA, 'board'), [{ content: ['**Board · project**', '4 task(s) · merged 1 · framed 1 · concluded 1 · abandoned 1',
    "1 task(s) left. Time left is not estimated yet: the project's records have no estimate.", '1 open question(s):', '- G1 (T1): Which sort is the default?', '  A. Name · B. Date'].join('\n'), ...PUBLIC }]);
  assert.deepEqual(await b.cmd(MAYA, 'gates'), [{ content: `**Open questions · project** (1)\n- G1 (T1), team vote: Which sort is the default?\n${G1}`, ...PUBLIC }]);
});

test('F-T71-11: a folder symlink to a sibling folder whose name starts with the project name shares nothing from it', async (t) => {
  const b = world(t);
  const s = site(t, b, { 'ok.svg': '<svg/>' }, ['shots/*.svg', 'shots/old/*.svg']);
  mkdirSync(join(s.root, 'site-old'));
  writeFileSync(join(s.root, 'site-old', 'leak.svg'), SECRET);
  symlinkSync(join(s.root, 'site-old'), join(s.project, 'shots', 'old')); // inside the project, to /…/site-old
  assert.deepEqual(await files(s.ask), [{ content: '1 shared file(s) of site:\n- shots/ok.svg', files: [{ name: 'ok.svg', size: 6 }], ...PUBLIC }]);
});

test('F-T71-13: a reply over 2000 characters is cut to 2000 with an ellipsis, as Discord allows no more', async (t) => {
  // The open questions never reach this cut (F-T95-1); a list of long file names does.
  const b = world(t);
  const names = Array.from({ length: 10 }, (_, n) => `${String(n).padStart(2, '0')}${'f'.repeat(188)}.svg`); // "shots/" and these: 200 characters
  const s = site(t, b, Object.fromEntries(names.map((n) => [n, '<svg/>'])), ['shots/*.svg']);
  const full = ['10 shared file(s) of site:', ...names.map((n) => `- shots/${n}`)].join('\n');
  assert.ok(full.length > 2000, String(full.length));
  assert.equal((await files(s.ask))[0].content, `${full.slice(0, 1999)}…`);
});

test('F-T71-13: the team vote label comes only from the bridge\'s own project, not from a gate of another project with the same id', async (t) => {
  const b = world(t); // its G1 is marked as a team vote
  const other = join(b.root, 'other');
  mkdirSync(other);
  const env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  const sh = (...args) => spawnSync(process.execPath, [SAGE, ...args, '--project', other], { env, encoding: 'utf8' });
  sh('init');
  sh('task', 'add', '--title', 'Other work', '--size', 'tiny');
  sh('gate', 'add', 'T1', '--question', 'Other question?', '--options', 'Yes|No', '--recommend', 'Yes');
  b.ask = b.makeAsk({ projects: [{ name: 'project', project: b.project }, { name: 'other', project: other }] });
  assert.deepEqual(await b.cmd(MAYA, 'gates', { project: 'other' }), [{ content: `**Open questions · other** (1)\n- G1 (T1), answered at the terminal: Other question?\n${G2}`, ...PUBLIC }]);
  assert.deepEqual(await b.cmd(MAYA, 'gates', { project: 'project' }), [{ content: GATES, ...PUBLIC }]);
});

test('F-T71-13: a mention or a command from a user id that is not a Discord id gets nothing', async (t) => {
  const b = world(t);
  for (const id of ['', 'abc', '1234', `${MAYA}x`]) {
    const m = fakeMention({ user: id, roles: [APPRENTICE], channelId: ASK, content: '<@1> hi' });
    await b.ask.mention(m);
    assert.deepEqual(m.replies, [], id);
    const i = fakeCommand({ user: id, roles: [APPRENTICE], channelId: ASK, sub: 'board' });
    await b.ask.command(i);
    assert.deepEqual(i.replies, [], id);
  }
  assert.deepEqual(await b.mention(MAYA, '<@1> hi'), [{ content: POINTER_TEXT, allowedMentions: { parse: [], repliedUser: false } }]); // a real id still gets the pointer
});

/** A button press or a form as discord.js gives it, for `routes`. SAMPLE DATA ONLY. */
const press = ({ guildId = CONFIG_GUILD, channelId = CONFIG.channelId, channel = null, customId, modal = false }) => ({ guildId, channelId, channel, customId,
  isChatInputCommand: () => false, isButton: () => !modal, isModalSubmit: () => modal });

test('F-T71-9: routes send a button or a form in the bridge channel or its thread to the bridge; another guild or channel gets nothing', async (t) => {
  const b = world(t);
  const pressed = [];
  const fetch = async (id) => (id === THREAD ? { isThread: () => true, parentId: CONFIG.channelId } : { isThread: () => false });
  const on = routes({ config: { ...CONFIG, guildId: CONFIG_GUILD }, ask: b.ask, bridge: { interaction: async (i) => { pressed.push(i.customId); } }, fetch, botId: BOT_USER });
  for (const i of [
    press({ customId: 'button-in-channel' }),
    press({ customId: 'form-in-channel', modal: true }),
    press({ customId: 'button-in-thread', channelId: THREAD }),
    press({ customId: 'other-guild', guildId: '200000000000000002' }),
    press({ customId: 'other-guild-form', guildId: '200000000000000002', modal: true }),
    press({ customId: 'other-channel', channelId: ASK }),
    press({ customId: 'thread-of-other', channelId: '400000000000000078', channel: { isThread: () => true, parentId: ASK } }),
  ]) await on.interaction(i);
  assert.deepEqual(pressed, ['button-in-channel', 'form-in-channel', 'button-in-thread']);
});
