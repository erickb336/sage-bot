// T189: the broker's four logbook verbs (G30 A, G81), against a dummy state tool that records each argv it gets. The dummy is a
// small script in a temp folder. One contract test runs the pinned copy of the state tool (test/fixtures/sage, as the other bridge
// tests do) in a scratch logbook; no test reads or writes a real logbook. GitHub is src/fake-github.js. SAMPLE DATA ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBroker, LIMITS } from '../src/broker.js';
import { fakeGitHub, samplePull } from '../src/fake-github.js';
import { sageTool } from '../src/sage.js';
import { SAGE } from './bridge-setup.js';
import { tempFolder } from './temp-folder.js';

const TOKEN = 'sample-token-not-real';
const OWNER = 'sample-owner', REPO = 'sample-repo';
const HEAD = 'ab'.repeat(20);

// The dummy state tool: it appends { pid, args } to DUMMY_LOG, then hangs (DUMMY_HANG names the command), fails with a path in its
// error (DUMMY_FAIL), or prints one line with a hidden character (U+202E) that the broker must not pass to the session.
const DUMMY = `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DUMMY_LOG, JSON.stringify({ pid: process.pid, args }) + '\\n');
if (args[0] === process.env.DUMMY_HANG) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (args[0] === process.env.DUMMY_FAIL) { process.stderr.write('refused: /Users/someone/.claude/sage/x/tasks.tsv is locked\\n'); process.exit(3); }
else process.stdout.write('dummy ' + args[0] + ' ok\\u202E\\n');
`;

function world({ pulls = [samplePull({ owner: OWNER, repo: REPO, number: 7, branch: 'sage-lead/s1' })], hang = '', fail = '', logbook = true } = {}) {
  const root = realpathSync(tempFolder('t189-'));
  const project = join(root, 'project'), log = join(root, 'argv.log'), dummy = join(root, 'dummy.mjs');
  for (const d of [project, join(root, 'session'), join(root, 'tmp'), join(root, 'broker')]) mkdirSync(d);
  writeFileSync(dummy, DUMMY);
  writeFileSync(log, '');
  const tool = sageTool({ sagePath: dummy, project, env: { PATH: process.env.PATH, DUMMY_LOG: log, DUMMY_HANG: hang, DUMMY_FAIL: fail } });
  const gh = fakeGitHub({ owner: OWNER, repo: REPO, token: TOKEN, pulls: pulls.map((p) => ({ ...p, head: { ...p.head, sha: HEAD } })) });
  const broker = createBroker({ policy: { session: 's1', folder: join(root, 'session'), tmp: join(root, 'tmp') },
    github: { owner: OWNER, repo: REPO, remote: join(root, 'none.git') }, ...(logbook && { logbook: { tool, task: 'T5', run: 'R12' } }),
    token: () => TOKEN, workDir: join(root, 'broker'), fetch: gh.fetch });
  const runs = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const argv = () => runs().map((r) => r.args);
  return { root, project, broker, gh, runs, argv };
}

test('each logbook verb runs exactly its fixed argv, with the session\'s task, run, pull request and project', async () => {
  const w = world();
  const P = ['--project', w.project];
  assert.deepEqual(await w.broker.call('run_done', { status: 'done' }), { ok: true, line: 'dummy run ok ' });
  assert.deepEqual(await w.broker.call('verdict', { kind: 'findings', cycle: 2 }), { ok: true, line: 'dummy verdict ok ', sha: HEAD, number: 7 });
  assert.deepEqual(await w.broker.call('finding_add', { severity: 'medium', summary: 'The — summary, «quoted» & 100%' }), { ok: true, line: 'dummy finding ok ' });
  // A summary that looks like an option stays the value of --summary: it goes in the same word, after "=".
  assert.equal((await w.broker.call('finding_add', { severity: 'low', summary: '--project=/elsewhere' })).ok, true);
  assert.deepEqual(await w.broker.call('task_status', {}), { ok: true, line: 'dummy task ok ' });
  assert.deepEqual(w.argv(), [
    ['run', 'done', 'R12', '--status=done', ...P],
    ['verdict', 'T5', `--sha=${HEAD}`, '--kind=findings', '--cycle=2', '--pr=7', '--run=R12', ...P],
    ['finding', 'add', 'T5', '--source=R12', '--severity=medium', '--summary=The — summary, «quoted» & 100%', ...P],
    ['finding', 'add', 'T5', '--source=R12', '--severity=low', '--summary=--project=/elsewhere', ...P],
    ['task', 'T5', ...P],
  ]);
});

test('every forbidden shape is refused, and the state tool never runs', async () => {
  const w = world();
  const refused = async (verb, input, text) => {
    const r = await w.broker.call(verb, input);
    assert.equal(r.ok, false, `${verb} ${JSON.stringify(input)}`);
    assert.match(r.refused, text);
    assert.match(r.refused, /The broker did nothing more\.$/);
  };
  // Another task, run, project or commit: no verb takes one (an extra key).
  await refused('task_status', { task: 'T9' }, /task_status takes no input, not "task"/);
  await refused('run_done', { status: 'done', run: 'R9' }, /run_done takes status, not "run"/);
  await refused('finding_add', { severity: 'low', summary: 'x', task: 'T9' }, /not "task"/);
  await refused('finding_add', { severity: 'low', summary: 'x', source: 'R9' }, /not "source"/);
  await refused('finding_add', { severity: 'low', summary: 'x', key: 'F-T5-1' }, /not "key"/);
  await refused('verdict', { kind: 'qa-fail', cycle: 1, project: '/elsewhere' }, /not "project"/);
  await refused('verdict', { kind: 'qa-fail', cycle: 1, sha: HEAD.replace('a', 'c') }, /verdict takes kind, cycle, not "sha"/);
  await refused('verdict', { kind: 'qa-fail', cycle: 1, pr: 8 }, /not "pr"/);
  await refused('verdict', { kind: 'qa-fail', cycle: 1, run: 'R9' }, /not "run"/);
  // Values outside the allow-lists.
  for (const kind of ['review-clean', 'security-clean', 'ux-clean', 'qa-pass', 'evidence-clean', 'merged', 'qa-fail --cycle=9', '', undefined, ['qa-fail']]) {
    await refused('verdict', { kind, cycle: 1 }, /kind is one of checks-pass, checks-fail, findings, qa-fail; a clean review verdict must come from an independent review outside the session/);
  }
  for (const cycle of [0, 11, 1.5, '1', -1, undefined]) await refused('verdict', { kind: 'findings', cycle }, /cycle must be a whole number from 1 to 10/);
  for (const status of ['running', 'merged', 'Done', '', undefined]) await refused('run_done', { status }, /status is one of done, blocked, question, failed/);
  for (const severity of ['critical', 'HIGH', undefined]) await refused('finding_add', { severity, summary: 'x' }, /severity is one of low, medium, high/);
  // A summary with a control, format, bidi or hidden character, a newline, too long or empty.
  for (const [summary, text] of [['a\u0007b', /U\+0007/], ['a\tb', /U\+0009/], ['a\nb', /U\+000A/], ['a‮b', /U\+202E/], ['a​b', /U\+200B/],
    ['a⠀b', /U\+2800/], ['a�b', /U\+FFFD/], ['a\u{E0041}b', /U\+E0041/], ['x'.repeat(501), /501 characters; the most is 500/], [' ', /not empty/], [7, /not empty/]]) {
    await refused('finding_add', { severity: 'high', summary }, text);
  }
  assert.equal((await w.broker.call('finding_add', { severity: 'high', summary: 'x'.repeat(500) })).ok, true, 'the control: 500 characters pass');
  assert.equal(w.argv().length, 1, 'only the control ran the tool');
});

test('the verdict SHA is the head of the session\'s own open pull request, as GitHub has it at the call', async () => {
  const w = world({ pulls: [samplePull({ owner: OWNER, repo: REPO, number: 3, branch: 'sage-lead/s2' }), samplePull({ owner: OWNER, repo: REPO, number: 7, branch: 'sage-lead/s1' })] });
  const moved = 'cd'.repeat(20);
  w.gh.state.pulls.find((p) => p.number === 7).head.sha = moved; // a new upload moved the head on GitHub
  const r = await w.broker.call('verdict', { kind: 'checks-pass', cycle: 1 });
  assert.deepEqual([r.ok, r.sha, r.number], [true, moved, 7], r.refused);
  assert.deepEqual(w.argv()[0].slice(2, 6), [`--sha=${moved}`, '--kind=checks-pass', '--cycle=1', '--pr=7']);
  // No pull request, a merged one, a closed one: refused, nothing run.
  for (const change of [(p) => { p.merged_at = '2026-10-01T00:00:00Z'; p.state = 'closed'; }, (p) => { p.state = 'closed'; }]) {
    const v = world();
    change(v.gh.state.pulls[0]);
    assert.match((await v.broker.call('verdict', { kind: 'findings', cycle: 1 })).refused, /no open pull request/);
    assert.deepEqual(v.argv(), []);
  }
  const none = world({ pulls: [] });
  assert.match((await none.broker.call('verdict', { kind: 'findings', cycle: 1 })).refused, /no open pull request/);
  const short = world();
  short.gh.state.pulls[0].head.sha = 'abc';
  assert.match((await short.broker.call('verdict', { kind: 'findings', cycle: 1 })).refused, /no 40-character head id/);
  assert.deepEqual([none.argv(), short.argv()], [[], []]);
});

test('the scope comes from the bridge only: no scope refuses every logbook verb; a bad scope stops createBroker', async () => {
  const w = world({ logbook: false });
  for (const [verb, input] of [['run_done', { status: 'done' }], ['verdict', { kind: 'qa-fail', cycle: 1 }], ['finding_add', { severity: 'low', summary: 'x' }], ['task_status', {}]]) {
    assert.deepEqual(await w.broker.call(verb, input), { ok: false, refused: 'this session has no task in the logbook. The broker did nothing more.' });
  }
  assert.deepEqual(w.argv(), []);
  const tool = { command: async () => 'x' };
  const make = (logbook) => () => createBroker({ policy: { session: 's1', folder: '/x', tmp: '/y' }, github: { owner: OWNER, repo: REPO }, logbook, token: () => TOKEN, workDir: '/z' });
  for (const bad of [{ tool, task: 'T5 --x', run: 'R1' }, { tool, task: 'T5', run: 'R1;' }, { tool, task: 'F5', run: 'R1' }, { task: 'T5', run: 'R1' }, null]) {
    assert.throws(make(bad), /logbook scope needs/, JSON.stringify(bad));
  }
  assert.doesNotThrow(make({ tool, task: 'T5', run: 'R1' }));
});

test('the contract: the pinned state tool (test/fixtures/sage) takes each argv, in a scratch logbook', async () => {
  const root = realpathSync(tempFolder('t189-pin-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const tool = sageTool({ sagePath: SAGE, project, env: { PATH: process.env.PATH, HOME: join(root, 'home'), SAGE_HOME: join(root, 'home', 'sage') } });
  await tool.command(['init']);
  assert.match(await tool.command(['task', 'add', '--title=sample', '--size=small']), /^T1 framed/);
  assert.match(await tool.command(['run', 'add', 'T1', '--role=qa']), /^R1 running/);
  const gh = fakeGitHub({ owner: OWNER, repo: REPO, token: TOKEN, pulls: [{ ...samplePull({ owner: OWNER, repo: REPO, number: 7, branch: 'sage-lead/s1' }), head: { ref: 'sage-lead/s1', sha: HEAD, repo: { full_name: `${OWNER}/${REPO}` } } }] });
  const broker = createBroker({ policy: { session: 's1', folder: join(root, 's'), tmp: join(root, 't') }, github: { owner: OWNER, repo: REPO },
    logbook: { tool, task: 'T1', run: 'R1' }, token: () => TOKEN, workDir: join(root, 'b'), fetch: gh.fetch });
  assert.deepEqual(await broker.call('finding_add', { severity: 'high', summary: '--kind=qa-pass looks like an option' }), { ok: true, line: 'F-T1-1 open · high · T1' });
  assert.deepEqual(await broker.call('verdict', { kind: 'qa-fail', cycle: 1 }), { ok: true, line: `T1 qa-fail · ${HEAD.slice(0, 7)} · cycle 1`, sha: HEAD, number: 7 });
  assert.deepEqual(await broker.call('run_done', { status: 'question' }), { ok: true, line: 'R1 question' });
  assert.deepEqual(await broker.call('task_status', {}), { ok: true, line: 'T1 framed · small · round 0 · route build,code-review,qa · PR 7' });
});

test('a refusal of the state tool gives its exit code and no text of it (its text can name a path)', async () => {
  const w = world({ fail: 'verdict' });
  assert.deepEqual(await w.broker.call('verdict', { kind: 'findings', cycle: 1 }), { ok: false, refused: 'the state tool refused verdict (exit code 3). The broker did nothing more.' });
});

test('a state tool that hangs is killed at LIMITS.sageMs, and the session\'s next verb then runs', async () => {
  assert.equal(LIMITS.sageMs, 30_000);
  const before = LIMITS.sageMs;
  LIMITS.sageMs = 500;
  try {
    const w = world({ hang: 'run' });
    const t0 = Date.now();
    const first = w.broker.call('run_done', { status: 'failed' });
    const next = w.broker.call('task_status', {}); // waits for the first: one at a time
    const a = await first;
    const ms = Date.now() - t0;
    assert.deepEqual(a, { ok: false, refused: 'the state tool took too long; the logbook may have changed.' });
    assert.ok(ms >= 450 && ms < 3000, `${ms} ms`);
    assert.deepEqual(await next, { ok: true, line: 'dummy task ok ' });
    // The hung tool is gone (SIGKILL: it ignores SIGTERM).
    const { pid } = w.runs()[0];
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await sleep(20); } catch { alive = false; } }
    assert.equal(alive, false, `pid ${pid} still runs`);
    assert.equal(existsSync(w.project), true);
  } finally { LIMITS.sageMs = before; }
});
