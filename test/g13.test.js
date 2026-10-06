// The owner's decision project/G13: the bridge posts only the gates that sage marked as team votes (scripts/vote.mjs).
// Through the fake Discord layer and a scratch sage logbook. SAMPLE DATA ONLY: every id, name and question is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadVotes, migrateMarks, saveVotes } from '../src/state.js';
import { MINUTE } from '../src/vote.js';
import { MAYA, SAGE, setAt, setup, spawnSync } from './bridge-setup.js';

const VOTE = new URL('../scripts/vote.mjs', import.meta.url).pathname;
const titles = (b) => b.discord.posts.filter((p) => p.embeds).map((p) => p.embeds[0].title);
const kept = (b) => b.lines.filter((l) => l.includes('stays at the terminal'));
/** Runs scripts/vote.mjs with HOME in the scratch folder, where `config` (if given) is the default config file. */
function vote(b, args, config = { project: b.project, sagePath: SAGE, statePath: b.statePath }) {
  const home = join(b.root, 'home');
  mkdirSync(join(home, '.config', 'sage-bot'), { recursive: true });
  writeFileSync(join(home, '.config', 'sage-bot', 'config.json'), JSON.stringify(config));
  const r = spawnSync(process.execPath, [VOTE, ...args], { cwd: b.project, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }); // sage runs it in the project's folder
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('G13: an unlisted gate gets no card and one log line in all; a listed gate of another task gets its card', async () => {
  const b = setup({ markAll: false });
  b.sh('gate', 'add', 'T1', '--question', 'Rename the field?', '--options', 'yes|no', '--recommend', 'yes');
  b.sh('gate', 'add', 'T2', '--question', 'Which colour?', '--options', 'red|blue', '--recommend', 'red');
  b.mark('G2');
  await b.post();
  b.now += MINUTE;
  await b.bridge.loop();
  await b.bridge.loop();
  assert.deepEqual(titles(b), ['Question project/G2 · T2 ']);
  assert.deepEqual(kept(b), ['project/G1 stays at the terminal: sage did not mark it as a team vote']);
  assert.equal(b.answerOf('G1'), '');
});

test('G13, G10 c: a gate marked after its task\'s card was posted is posted at the next loop, on its own card', async () => {
  const b = setup({ markAll: false });
  b.sh('gate', 'add', 'T5', '--question', 'A?', '--options', 'x|y', '--recommend', 'x');
  b.sh('gate', 'add', 'T5', '--question', 'B?', '--options', 'p|q', '--recommend', 'p');
  b.mark('G1');
  await b.post();
  assert.deepEqual(titles(b), ['Question project/G1 · T5 ']);
  b.now += 10 * MINUTE;
  await b.bridge.loop();
  assert.equal(titles(b).length, 1);
  b.mark('G2');
  await b.bridge.loop(); // one loop: G2 was seen 10 minutes ago, so it does not wait again
  assert.deepEqual(titles(b), ['Question project/G1 · T5 ', 'Question project/G2 · T5 ']);
});

test('G13, F-T28-28: a listed question about a merge is still never posted, and the log says so once', async () => {
  const b = setup({ markAll: false });
  b.sh('gate', 'add', 'T1', '--question', 'Merge PR 12 now?', '--options', 'yes|no', '--recommend', 'yes');
  b.mark('G1');
  await b.post();
  await b.bridge.loop();
  assert.deepEqual(b.discord.posts, []);
  assert.deepEqual(kept(b), ['project/G1 stays at the terminal: it is about a merge, and a merge never goes to a vote']);
});

test('G13, G9: only listed gates group: 3 gates asked together with 2 marked are a batch of those 2; 5 together with 4 marked are a batch of 4', async () => {
  const b = setup({ markAll: false });
  for (const q of ['A?', 'B?', 'C?']) b.sh('gate', 'add', 'T4', '--question', q, '--options', 'x|y', '--recommend', 'x');
  for (let i = 1; i <= 5; i++) b.sh('gate', 'add', 'T6', '--question', `Q${i}?`, '--options', 'x|y', '--recommend', 'x');
  setAt(b, { G1: '2026-10-04T13:00:00Z', G2: '2026-10-04T13:00:05Z', G3: '2026-10-04T13:00:10Z' });
  b.mark('G1', 'G3', 'G4', 'G5', 'G6', 'G8');
  await b.post();
  assert.deepEqual(titles(b), ['Batch vote project/G1+G3 · T4 ', 'Batch vote project/G4+G5+G6+G8 · T6 ']);
  assert.equal(b.lines.some((l) => l.startsWith('not posted')), false);
});

test('project/G13: the bridge refuses a team votes file with mode 0644 or of another user, posts nothing, and says why once', async (t) => {
  const b = setup({ markAll: false });
  b.sh('gate', 'add', 'T1', '--question', 'Q?', '--options', 'x|y', '--recommend', 'x');
  b.mark('G1');
  const votes = `${b.statePath}.votes`;
  chmodSync(votes, 0o644);
  await b.post();
  await b.bridge.loop();
  assert.deepEqual(b.discord.posts, []);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('no gate is posted')), [`no gate is posted: the team votes file ${votes} must be a regular file of this user with mode 0600. Nothing was loaded.`]);
  assert.match(vote(b, ['--list']).err, /must be a regular file of this user with mode 0600/);
  chmodSync(votes, 0o600);
  // Another user: the file is the same, only its owner's uid differs from this process's.
  t.mock.method(process, 'getuid', () => statSync(votes).uid + 1);
  assert.throws(() => loadVotes(votes), /must be a regular file of this user with mode 0600/);
  t.mock.restoreAll();
  await b.bridge.loop();
  assert.deepEqual(titles(b), ['Question project/G1 · T1 ']);
});

test('G13, G45 A: the team votes file round-trips with folders, is 0600, and a file that is not an object of gate keys and folders is refused', () => {
  const b = setup({ markAll: false });
  const path = `${b.statePath}.votes`;
  saveVotes(path, new Map([['project/G10', '/p'], ['beta/G2', '/b'], ['project/G2', '/p'], ['project/G9', null]]));
  assert.deepEqual([...loadVotes(path)], [['beta/G2', '/b'], ['project/G2', '/p'], ['project/G9', null], ['project/G10', '/p']]);
  assert.equal(readFileSync(path, 'utf8'), '{"beta/G2":"/b","project/G2":"/p","project/G9":null,"project/G10":"/p"}');
  // A list is the file before G45 A: bare gate ids (before T132) and keys. A read refuses it; migrateMarks writes it once as an object,
  // under the lock of vote.mjs, also the leads-only file: a bare id is of the own project, and each key takes the folder that its name
  // names now, or null for a name that is not listed (F-T132-1, F-T132-21).
  writeFileSync(path, '["G2","beta/G9","gone/G3"]', { mode: 0o600 });
  writeFileSync(`${path}.leads`, '["G4"]', { mode: 0o600 });
  assert.throws(() => loadVotes(path), /must be a JSON object of sage gate keys/);
  const folders = new Map([['project', '/p'], ['beta', '/b']]);
  assert.equal(migrateMarks({ statePath: b.statePath }, 'project', folders), true);
  assert.deepEqual([readFileSync(path, 'utf8'), readFileSync(`${path}.leads`, 'utf8')], ['{"beta/G9":"/b","gone/G3":null,"project/G2":"/p"}', '{"project/G4":"/p"}']);
  // Once only: a second run, also with other folders, changes nothing.
  assert.equal(migrateMarks({ statePath: b.statePath }, 'beta', new Map([['beta', '/x']])), false);
  assert.equal(readFileSync(path, 'utf8'), '{"beta/G9":"/b","gone/G3":null,"project/G2":"/p"}');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const bad of ['{"G1":"/p"}', '{"project/G1":true}', '{"project/G1":1}', '[1]', '{"Project/G1":"/p"}', '{"project/G1/G2":"/p"}', '{"/G1":"/p"}', '{"project/T1":"/p"}', '["project/G1"]', 'null']) {
    writeFileSync(path, bad);
    assert.throws(() => loadVotes(path), /must be a JSON object of sage gate keys/, bad);
  }
});

test('G13: scripts/vote.mjs marks, lists and unmarks gates, and refuses an id that is not a sage gate id', () => {
  const b = setup({ markAll: false });
  assert.deepEqual(vote(b, ['--list']), { code: 0, out: 'team votes: none', err: '' });
  assert.deepEqual(vote(b, ['G3', 'G1']), { code: 0, out: 'team votes: project/G1 project/G3', err: '' });
  assert.deepEqual(vote(b, ['--unmark', 'G3']), { code: 0, out: 'team votes: project/G1', err: '' });
  for (const bad of [['G1', 'T7'], ['g2'], ['G'], ['../G1'], ['--unmark', 'G1x']]) {
    const r = vote(b, bad);
    assert.equal(r.code, 1, bad.join(' '));
    assert.match(r.err, /^sage-bot vote: not a sage gate id \(G and digits\): .+\. Nothing changed\.$/);
  }
  assert.deepEqual([...loadVotes(`${b.statePath}.votes`).keys()], ['project/G1']);
  assert.match(vote(b, []).err, /^sage-bot vote: usage:/);
  // `votesPath` in the config wins over `<statePath>.votes`; --config names another config file.
  const other = join(b.root, 'other.votes');
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify({ project: b.project, sagePath: SAGE, statePath: b.statePath, votesPath: other }));
  assert.equal(vote(b, ['--config', config, 'G7']).out, 'team votes: project/G7');
  assert.deepEqual([...loadVotes(other).keys()], ['project/G7']);
});

test('end to end, G13: two gates are added, sage marks one with scripts/vote.mjs; only that one is posted and answered', async () => {
  const b = setup({ markAll: false });
  b.sh('task', 'add', '--title', 'Export page', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which columns?', '--options', 'Visible only|All fields', '--recommend', 'Visible only');
  b.sh('task', 'add', '--title', 'Rename a helper', '--size', 'small');
  b.sh('gate', 'add', 'T2', '--question', 'Which name?', '--options', 'toCsv|asCsv', '--recommend', 'toCsv');
  assert.equal(vote(b, ['G1']).out, 'team votes: project/G1');
  await b.post();
  assert.deepEqual(titles(b), ['Question project/G1 · T1 Export page']);
  b.now += MINUTE;
  await b.press(MAYA, 'press:project/G1:0:1');
  await b.bridge.loop();
  assert.deepEqual([b.answerOf('G1'), b.answerOf('G2')], ['B. All fields', '']);
  assert.equal(titles(b).length, 1);
  assert.deepEqual(kept(b), ['project/G2 stays at the terminal: sage did not mark it as a team vote']);
});
