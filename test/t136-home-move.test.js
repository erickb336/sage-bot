// T136: the home channel moves only when nothing waits in the old home, and every message of scripts/channels.mjs names what to do.
// SAMPLE DATA ONLY: every id, name and project is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects } from '../src/projects.js';
import { channelsPathOf, loadChannels, openChannels, word } from '../src/channels.js';
import { load, save } from '../src/state.js';
import { CHANNEL, CONFIG, execFileSync, MAYA, SAGE, setup, spawnSync } from './bridge-setup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASK = '400000000000000009'; // the old #ask-sage
const OTHER = '400000000000000011'; // the new home
const THREAD = '400000000000000012'; // a session thread in the old home
const SID = '0b9e5c1e-3f2a-4c55-9d1e-7a0c2b4d6e8f';
const START = 'launchctl load ~/Library/LaunchAgents/com.sage.bot.plist';
const STOP = 'launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist (or Ctrl-C where you run it by hand)';
const WAIT_FIX = `Wait until they are settled. Or answer them at the terminal, then start the bridge for one loop, because only the bridge copies the answers into the gate file: start it with: ${START}, wait until its log shows the answers, stop it with: ${STOP}, and run this again. Nothing was changed.`;

function world(t) {
  const b = setup({ markAll: true });
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  b.env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  b.config = { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
  b.registry = channelsPathOf(b.config);
  b.configPath = join(b.root, 'config.json');
  /** Runs Erick's script with the config `text` (default: b.config as JSON). */
  b.script = (args, text = JSON.stringify(b.config)) => {
    writeFileSync(b.configPath, text);
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'channels.mjs'), '--config', b.configPath, ...args], { encoding: 'utf8', env: b.env });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  /** A card of project/G1 that waits in the home channel CHANNEL. */
  b.card = async () => {
    b.sh('task', 'add', '--title', 'Pick a name', '--size', 'tiny');
    b.sh('gate', 'add', 'T1', '--question', 'Which name?', '--options', 'Ada|Bo', '--recommend', 'Ada');
    await b.post();
    assert.equal(b.discord.in(CHANNEL).length > 0, true);
  };
  return b;
}
const channelsOf = (b) => JSON.parse(readFileSync(b.registry, 'utf8')).channels;

test('F-T136-1: the home cannot move while a sage session has an open thread in the old home; the refusal names it and what to do', (t) => {
  const b = world(t);
  openChannels(b.config, loadProjects(b.config));
  const before = readFileSync(b.registry, 'utf8');
  const session = { id: SID, n: 3, title: 'Session 3 · project · Mon 12 Oct', line: '600000000000000001', thread: THREAD, closed: false };
  const refusal = `sage-bot channels: the home channel cannot move while 1 sage session(s) have an open thread in the old home channel ${CHANNEL} or its threads `
    + `(Session 3 · project · Mon 12 Oct: thread ${THREAD}): their next card would post there, where presses stop working. End each session in Claude Code and settle its cards. `
    + `Then start the bridge with: ${START}, wait until its log or the session's line says that it ended and the thread is locked, stop it with: ${STOP}, and run this again. Nothing was changed.\n`;
  // A running session (no end), and an ended one whose thread the bridge did not lock yet: both refused, and the registry stays.
  for (const s of [session, { ...session, endedAt: Date.UTC(2026, 9, 12) }, { ...session, closed: true }]) {
    save(b.statePath, [], [s]);
    const r = b.script(['register', OTHER, 'project', '--home']);
    assert.deepEqual([r.status, r.err], [1, refusal], JSON.stringify(s));
    assert.equal(readFileSync(b.registry, 'utf8'), before);
  }
  // The session ended and the bridge locked its thread: the home moves. A session with no thread never blocks it.
  save(b.statePath, [], [{ ...session, closed: true, endedAt: Date.UTC(2026, 9, 12) }, { ...session, id: SID.replace('0b9e', '1b9e'), n: 4, line: null, thread: null }]);
  const r = b.script(['register', OTHER, 'project', '--home']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(channelsOf(b), { [ASK]: { project: 'project' }, [CHANNEL]: { project: 'project' }, [OTHER]: { project: 'project', home: true } });
});

test('F-T136-8: with no registry, the home cannot move while a card waits; the card\'s own channel says where it is', async (t) => {
  const b = world(t);
  await b.card(); // the card waits in CHANNEL; no registry yet (the bridge of the test has none)
  assert.equal(existsSync(b.registry), false);
  let r = b.script(['register', OTHER, 'project', '--home']);
  assert.deepEqual([r.status, r.err], [1, `sage-bot channels: the home channel cannot move while 1 card(s) wait in a channel or thread that may not be ${OTHER}: with no channel registry, nothing says where the home was (project/G1): their buttons would stop working. ${WAIT_FIX}\n`]);
  assert.equal(existsSync(b.registry), false); // F-T136-2: nothing written before the refusal
  // The card's own channel is the channel that becomes the home: its buttons keep working, so this works.
  r = b.script(['register', CHANNEL, 'project', '--home']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(channelsOf(b), { [CHANNEL]: { project: 'project', home: true } });
});

test('F-T136-2: on an old config, a refused change writes no registry', (t) => {
  const b = world(t);
  // channelId and askChannelId but no registry: the refusal comes before any write.
  let r = b.script(['register', OTHER, 'payroll']);
  assert.deepEqual([r.status, r.err], [1, 'sage-bot channels: the project "payroll" is not in the config\'s projects (project). Nothing was changed\n']);
  assert.equal(existsSync(b.registry), false);
  r = b.script(['unregister', OTHER]);
  assert.equal(r.status, 1);
  assert.equal(existsSync(b.registry), false);
  // The same change that works makes it, and says so first.
  r = b.script(['register', OTHER, 'project']);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`^made the channel registry .+ from the config: ${ASK} -> project, ${CHANNEL} -> project \\(home\\)\nregistered the channel ${OTHER} for the project project\n`));
});

test('F-T136-3: a config that is not JSON, has no statePath or bad projects gets a message that names the config and the field', (t) => {
  const b = world(t);
  const at = b.configPath;
  const cases = [
    ['{"statePath":', /^sage-bot channels: the config .+ is not JSON \(.+\)\. Nothing was changed\.\n$/],
    [JSON.stringify({ ...b.config, statePath: undefined }), `sage-bot channels: the config ${at} has no statePath: the absolute path of the bridge's gate file. The registry is <statePath>.channels. Nothing was changed.\n`],
    ['null', `sage-bot channels: the config ${at} has no statePath: the absolute path of the bridge's gate file. The registry is <statePath>.channels. Nothing was changed.\n`],
    ['[1]', `sage-bot channels: the config ${at} has no statePath: the absolute path of the bridge's gate file. The registry is <statePath>.channels. Nothing was changed.\n`],
    [JSON.stringify({ ...b.config, statePath: 'state/gates.json' }), `sage-bot channels: the config ${at} has no statePath: the absolute path of the bridge's gate file. The registry is <statePath>.channels. Nothing was changed.\n`],
    [JSON.stringify({ ...b.config, project: 'here' }), `sage-bot channels: the config ${at} is refused: the config: project must be an absolute path\n`],
  ];
  for (const [text, want] of cases) {
    for (const args of [['list'], ['register', OTHER, 'project'], ['unregister', OTHER]]) {
      const r = b.script(args, text);
      assert.equal(r.status, 1, `${text} ${args[0]}`);
      if (typeof want === 'string') assert.equal(r.err, want, `${text} ${args[0]}`);
      else assert.match(r.err, want, `${text} ${args[0]}`);
      if (typeof want !== 'string') assert.equal(r.err.includes(at), true);
    }
  }
  assert.equal(existsSync(join(b.root, 'undefined.channels')), false);
});

test('F-T136-4: the refusal for waiting cards says that only the bridge copies terminal answers, and gives the lines to start and stop it', async (t) => {
  const b = world(t);
  await b.card();
  openChannels(b.config, loadProjects(b.config));
  const r = b.script(['register', OTHER, 'project', '--home']);
  assert.deepEqual([r.status, r.err], [1, `sage-bot channels: the home channel cannot move while 1 card(s) wait in the old home channel ${CHANNEL} or its threads (project/G1): their buttons would stop working. ${WAIT_FIX}\n`]);
});

test('F-T136-5: once the card is settled, the home moves', async (t) => {
  const b = world(t);
  await b.card();
  openChannels(b.config, loadProjects(b.config));
  assert.equal(b.script(['register', OTHER, 'project', '--home']).status, 1);
  await b.press(MAYA, 'press:project/G1:0:0'); // the first answer is final: the card is settled
  assert.equal(b.answerOf('G1'), 'Ada');
  assert.equal(load(b.statePath).entries.length, 1); // the settled card stays in the gate file
  const r = b.script(['register', OTHER, 'project', '--home']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(channelsOf(b), { [ASK]: { project: 'project' }, [CHANNEL]: { project: 'project' }, [OTHER]: { project: 'project', home: true } });
});

test('F-T136-6: the lock path is one shell word; the move aside names the copy; the new registry does not bring back an unregistered askChannelId', (t) => {
  const b = world(t);
  b.config.statePath = join(b.root, 'my state', 'gates.json');
  b.registry = channelsPathOf(b.config);
  mkdirSync(dirname(b.config.statePath), { mode: 0o700 });
  // The lock refusal: the printed path, run as printed, removes the lock.
  const start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' } }).trim();
  writeFileSync(`${b.config.statePath}.lock`, `${process.pid} ${start}`); // this test process stands in for a running bridge
  let r = b.script(['register', OTHER, 'project']);
  const lock = /If no bridge runs, remove (.+)\. Nothing was changed\./.exec(r.err)[1];
  assert.equal(lock, `'${b.config.statePath}.lock'`);
  execFileSync('/bin/sh', ['-c', `rm ${lock}`]);
  assert.equal(existsSync(`${b.config.statePath}.lock`), false);
  // A migrated install: Erick unregisters the old #ask-sage, then the registry breaks.
  r = b.script(['unregister', ASK]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(channelsOf(b), { [CHANNEL]: { project: 'project', home: true } });
  writeFileSync(b.registry, '{', { mode: 0o600 });
  r = b.script(['list']);
  const [, mv, copy, named] = /Move it aside with: (mv '[^']+' ('[^']+')), then register the home channel again with: .+ --home\. The old channels stay in ('[^']+'): register each one again that you need\n$/.exec(r.err);
  assert.equal(named, copy);
  execFileSync('/bin/sh', ['-c', mv]);
  assert.equal(readFileSync(join(dirname(b.registry), copy.slice(1, -1).split('/').at(-1)), 'utf8'), '{'); // the old channels are there
  r = b.script(['register', CHANNEL, 'project', '--home']);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(channelsOf(b), { [CHANNEL]: { project: 'project', home: true } }); // ASK stays unregistered
});

test('F-T136-7: a printed path is always in single quotes, so a path that starts with ~ or - is the file itself', (t) => {
  const b = world(t);
  const sh = (line) => execFileSync('/bin/sh', ['-c', line], { cwd: b.root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(b.root, 'home') } });
  assert.equal(sh(`printf %s ${word('~/gates.json.channels')}`), '~/gates.json.channels'); // not the home folder
  // A relative path that starts with "-": the printed chmod and mv act on that file, and mv does not read it as an option.
  mkdirSync(join(b.root, '-n'), { mode: 0o700 });
  writeFileSync(join(b.root, '-n', 'c'), '{', { mode: 0o644 });
  assert.equal(word('-n/c'), "'./-n/c'");
  sh(`chmod 600 ${word('-n/c')} && mv ${word('-n/c')} ${word('-n/c.bad')}`);
  assert.deepEqual(readdirSync(join(b.root, '-n')), ['c.bad']);
  assert.equal(word("it's"), "'it'\\''s'");
  assert.equal(sh(`printf %s ${word("it's")}`), "it's");
});

test('F-T136-10: a second move aside keeps the first copy, and the docs name the copy and both pointer texts', (t) => {
  const b = world(t);
  mkdirSync(dirname(b.registry), { recursive: true, mode: 0o700 });
  const aside = () => {
    writeFileSync(b.registry, '{', { mode: 0o600 });
    let message = '';
    try { loadChannels(b.registry); } catch (e) { message = e.message; }
    execFileSync('/bin/sh', ['-c', /Move it aside with: (.+), then register/.exec(message)[1]]);
  };
  aside();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); // the names have the time to the second
  aside();
  assert.equal(readdirSync(dirname(b.registry)).filter((f) => /^gates\.json\.channels\.bad-\d{8}-\d{6}$/.test(f)).length, 2);
  const doc = readFileSync(join(ROOT, 'docs', 'reference.md'), 'utf8');
  assert.match(doc, /gates\.json\.channels\.bad-20261012-143005/);
  // The pointer of a mention is not the pointer of /sage (src/ask.js mention and command).
  const ask = readFileSync(join(ROOT, 'src', 'ask.js'), 'utf8');
  for (const text of ['I answer /sage in #channel, so please ask there.', 'I answer in #channel, so everyone can find the answers. Please ask there.']) {
    assert.equal(ask.includes(text.replace('#channel', '${here()}')), true, text);
    assert.equal(doc.includes(`"${text}"`), true, text);
  }
  assert.equal(doc.includes('shared by `/sage` and mentions: "I answer /sage in'), false);
});
