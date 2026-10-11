// T158: the sage-bot broker. Each test plays a bridge session s1 against a fake GitHub: a local bare repository for git and the
// in-process fake REST API (src/fake-github.js). No network, no real token: SAMPLE DATA ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBroker, IDENTITY, runGit, textOf } from '../src/broker.js';
import { fakeGitHub, samplePull } from '../src/fake-github.js';
import { tempFolder } from './temp-folder.js';

const TOKEN = 'sample-token-not-real';
const OWNER = 'sample-owner', REPO = 'sample-repo';
const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Mallory', GIT_AUTHOR_EMAIL: 'mallory@example.com', GIT_COMMITTER_NAME: 'Mallory', GIT_COMMITTER_EMAIL: 'mallory@example.com' };
/** git as the test's session or the test's GitHub, never as the broker. */
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function world({ pulls = [] } = {}) {
  const root = tempFolder('t158-');
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), folder = join(root, 'sessions', 's1'), tmp = join(root, 'tmp', 's1');
  const workDir = join(root, 'broker');
  for (const d of [seed, tmp, workDir]) mkdirSync(d, { recursive: true });
  sh(root, 'init', '--bare', '--quiet', '-b', 'main', origin);
  sh(seed, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'sample\n');
  sh(seed, 'add', 'README.md'); sh(seed, 'commit', '--quiet', '-m', 'first');
  sh(seed, 'push', '--quiet', origin, 'main', 'main:refs/heads/sage-lead/s2');
  sh(seed, 'tag', 'v1'); sh(seed, 'push', '--quiet', origin, 'v1');
  sh(root, 'clone', '--quiet', origin, folder);
  const calls = [];
  const git = (args, o) => { calls.push({ args, cwd: o.cwd, env: o.env }); return runGit(args, o); };
  const gh = fakeGitHub({ owner: OWNER, repo: REPO, token: TOKEN, pulls });
  const broker = createBroker({ policy: { session: 's1', folder, tmp }, github: { owner: OWNER, repo: REPO, remote: origin },
    token: () => TOKEN, workDir, fetch: gh.fetch, git });
  const refs = () => Object.fromEntries(sh(origin, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').map((l) => l.split(' ')));
  const commit = (file, text, message = `change ${file}`) => {
    mkdirSync(join(folder, file, '..'), { recursive: true });
    writeFileSync(join(folder, file), text);
    sh(folder, 'add', file); sh(folder, 'commit', '--quiet', '-m', message);
    return sh(folder, 'rev-parse', 'HEAD');
  };
  return { root, origin, folder, tmp, workDir, broker, gh, calls, refs, commit };
}

test('upload: the session\'s commits land on sage-lead/s1 only, with the fixed identity, by fast-forward', async () => {
  const w = world();
  const before = w.refs();
  const c1 = w.commit('a.txt', 'one\n');
  const r1 = await w.broker.call('upload', { commit: c1 });
  assert.equal(r1.ok, true, r1.refused);
  assert.deepEqual([r1.branch, r1.commits, r1.pushed], ['sage-lead/s1', 1, true]);
  const after = w.refs();
  assert.equal(after['refs/heads/sage-lead/s1'], r1.head);
  for (const ref of ['refs/heads/main', 'refs/heads/sage-lead/s2', 'refs/tags/v1']) assert.equal(after[ref], before[ref], ref);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'refs/heads/sage-lead/s1'].sort());
  // The fixed identity (G62 a); the tree and the message are the session's.
  assert.equal(sh(w.origin, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', r1.head), `${IDENTITY.name} <${IDENTITY.email}>|${IDENTITY.name} <${IDENTITY.email}>|change a.txt`);
  assert.equal(sh(w.origin, 'rev-parse', `${r1.head}^{tree}`), sh(w.folder, 'rev-parse', 'HEAD^{tree}'));
  // A second commit: a fast-forward that keeps the first one; the same upload again pushes nothing.
  const c2 = w.commit('b.txt', 'two\n');
  const r2 = await w.broker.call('upload', { commit: c2 });
  assert.deepEqual([r2.ok, r2.commits, r2.pushed, sh(w.origin, 'rev-parse', `${r2.head}~1`)], [true, 2, true, r1.head]);
  assert.deepEqual(await w.broker.call('upload', { commit: c2 }), { ok: true, branch: 'sage-lead/s1', head: r2.head, commits: 2, pushed: false });
  assert.deepEqual(readdirSync(w.workDir), [], 'each verb removes its own folder');
});

test('upload: no other branch, no tag, no force-push and no deletion; only the commit id as input', async () => {
  const w = world();
  const c1 = w.commit('a.txt', 'one\n');
  const first = await w.broker.call('upload', { commit: c1 });
  const before = w.refs();
  const refused = async (input, text) => {
    const r = await w.broker.call('upload', input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.refused, text);
  };
  await refused({ commit: c1, branch: 'main' }, /upload takes commit, not "branch"/);
  await refused({ commit: c1, branch: 'sage-lead/s2' }, /not "branch"/);
  await refused({ commit: c1, ref: 'refs/tags/v2' }, /not "ref"/);
  await refused({ commit: c1, force: true }, /not "force"/);
  await refused({ commit: c1, delete: true }, /not "delete"/);
  for (const commit of ['HEAD', 'main', `:refs/heads/sage-lead/s1`, `+${c1}`, `${c1}:refs/heads/main`, c1.toUpperCase()]) {
    await refused({ commit }, /commit must be the 40-character id/);
  }
  // A rewritten history is not a fast-forward: the broker never forces.
  sh(w.folder, 'reset', '--quiet', '--hard', 'HEAD~1');
  await refused({ commit: w.commit('a.txt', 'other\n') }, /not a fast-forward of sage-lead\/s1/);
  // A commit that main already has: nothing to upload, and nothing deleted.
  await refused({ commit: sh(w.folder, 'rev-parse', 'origin/main') }, /nothing to upload/);
  assert.deepEqual(w.refs(), before);
  assert.equal(before['refs/heads/sage-lead/s1'], first.head);
});

test('upload: refuses a merge, a change under .github and a message with a hidden character', async () => {
  const w = world();
  const base = sh(w.folder, 'rev-parse', 'HEAD');
  const before = w.refs();
  const refused = async (commit, text) => { const r = await w.broker.call('upload', { commit }); assert.equal(r.ok, false); assert.match(r.refused, text); };
  await refused(w.commit('.github/workflows/x.yml', 'on: push\n'), /changes "\.github\/workflows\/x\.yml"/);
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  await refused(w.commit('a.txt', 'one\n', 'hidden ‮ text'), /has the character U\+202E/);
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  const side = w.commit('a.txt', 'one\n');
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  w.commit('b.txt', 'two\n');
  sh(w.folder, 'merge', '--quiet', '--no-edit', side);
  await refused(sh(w.folder, 'rev-parse', 'HEAD'), /is a merge or has no parent/);
  assert.deepEqual(w.refs(), before);
});

test('host git never runs in the session folder: no call there, and the session\'s hooks and config never run', async () => {
  const w = world();
  const c1 = w.commit('a.txt', 'one\n');
  // The session plants code that git runs at its start: a hook folder, a hook and an fsmonitor, each writing a sentinel.
  const sentinel = join(w.root, 'ran');
  const hook = join(w.folder, '.git', 'hooks', 'reference-transaction');
  writeFileSync(hook, `#!/bin/sh\ntouch ${sentinel}\n`, { mode: 0o755 });
  sh(w.folder, 'config', 'core.fsmonitor', hook);
  const r = await w.broker.call('upload', { commit: c1 });
  assert.equal(r.ok, true, r.refused);
  assert.ok((await w.broker.call('fetch')).ok);
  assert.equal(existsSync(sentinel), false, 'the session\'s hook ran');
  assert.ok(w.calls.length > 5);
  for (const { args, cwd, env } of w.calls) {
    assert.ok(!cwd.startsWith(w.folder) && cwd.startsWith(w.workDir), cwd);
    assert.ok(!args.some((a) => a.includes(w.folder)), args.join(' '));
    assert.ok(!args.some((a) => a.includes(TOKEN)), 'the token is in an argument');
    assert.equal(args[0], '--git-dir'); assert.ok(args[1].startsWith(w.workDir));
    assert.deepEqual([env.GIT_DIR, env.GIT_WORK_TREE, env.GIT_CONFIG_GLOBAL], [undefined, undefined, '/dev/null']);
  }
  // The control: the same hook runs when git runs in the session folder.
  sh(w.folder, 'update-ref', 'refs/heads/x', 'HEAD');
  assert.equal(existsSync(sentinel), true);
});

test('upload: a link in the session\'s .git is not followed', async () => {
  const w = world();
  const c1 = w.commit('a.txt', 'one\n');
  const dir = readdirSync(join(w.folder, '.git', 'objects')).find((d) => /^[0-9a-f]{2}$/.test(d));
  symlinkSync(join(w.root, 'seed', 'README.md'), join(w.folder, '.git', 'objects', dir, 'f'.repeat(38)));
  const r = await w.broker.call('upload', { commit: c1 });
  assert.equal(r.ok, false);
  assert.match(r.refused, /is not a plain file that the broker can read/);
  rmSync(join(w.folder, '.git', 'objects', dir, 'f'.repeat(38)));
  assert.equal((await w.broker.call('upload', { commit: c1 })).ok, true, 'the control: without the link, the upload works');
});

test('fetch is read-only: GitHub\'s refs stay, no REST call, and a bundle in the session\'s temp folder', async () => {
  const w = world();
  const before = w.refs();
  const r = await w.broker.call('fetch');
  assert.equal(r.ok, true, r.refused);
  assert.deepEqual([r.main, r.branch], [before['refs/heads/main'], null]);
  assert.ok(r.bundle.startsWith(`${w.tmp}/fetch-`) && r.bundle.endsWith('.bundle'));
  assert.equal(sh(w.root, 'bundle', 'list-heads', r.bundle), `${before['refs/heads/main']} refs/heads/main`);
  assert.deepEqual(w.refs(), before);
  assert.deepEqual(w.gh.calls, []);
  assert.ok(w.calls.every(({ args }) => !args.includes('push')));
  assert.match((await w.broker.call('fetch', { ref: 'main' })).refused, /fetch takes no input, not "ref"/);
});

test('pull request: create, edit and view only the session\'s own; no merge, approve, other PR or other base', async () => {
  const w = world({ pulls: [samplePull({ owner: OWNER, repo: REPO, number: 1, branch: 'sage-lead/s2' })] });
  const made = await w.broker.call('pr_create', { title: 'Add a.txt', body: 'What and why.\n\n- one' });
  assert.equal(made.ok, true, made.refused);
  assert.deepEqual([made.number, made.state, made.title, made.base], [2, 'open', 'Add a.txt', 'main']);
  const created = w.gh.state.pulls.find((p) => p.number === 2);
  assert.deepEqual([created.head.ref, created.base.ref, created.body], ['sage-lead/s1', 'main', 'What and why.\n\n- one']);
  assert.match((await w.broker.call('pr_create', { title: 't', body: 'b' })).refused, /already has its pull request #2/);
  assert.equal((await w.broker.call('pr_edit', { title: 'Add a.txt and b.txt', base: 'main' })).title, 'Add a.txt and b.txt');
  assert.equal((await w.broker.call('pr_view', {})).number, 2);
  const refused = async (verb, input, text) => { const r = await w.broker.call(verb, input); assert.equal(r.ok, false, `${verb} ${JSON.stringify(input)}`); assert.match(r.refused, text); };
  await refused('pr_edit', { number: 1, title: 'taken over' }, /#1 is not this session's pull request \(#2\)/);
  await refused('pr_view', { number: 1 }, /#1 is not this session's pull request/);
  await refused('pr_edit', { base: 'release', title: 'x' }, /base of the session's pull request stays main/);
  await refused('pr_edit', { state: 'closed' }, /pr_edit takes number, title, body, base, not "state"/);
  await refused('pr_create', { title: 't', body: 'b', base: 'release' }, /not "base"/);
  await refused('pr_create', { title: 'a​b', body: 'b' }, /title has the character U\+200B/);
  await refused('pr_create', { title: 'line\nbreak', body: 'b' }, /title has the character U\+000A/);
  for (const verb of ['pr_merge', 'merge', 'approve', 'pr_review', 'push', 'delete_branch', 'ruleset', '__proto__', 'toString']) {
    await refused(verb, {}, /that is not a broker verb/);
  }
  assert.equal(w.gh.state.pulls[0].title, 'another session');
  const writes = w.gh.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(writes, [`POST /repos/${OWNER}/${REPO}/pulls`, `PATCH /repos/${OWNER}/${REPO}/pulls/2`]);
});

test('pull request: fail closed when GitHub lists a pull request of another branch for the session', async () => {
  const w = world({ pulls: [samplePull({ owner: OWNER, repo: REPO, number: 7, branch: 'sage-lead/s1' })] });
  w.gh.state.pulls[0].head.repo.full_name = 'someone/fork';
  const r = await w.broker.call('pr_view', {});
  assert.match(r.refused, /one that is not this session's/);
});

test('the text allow-list, over every Unicode code point (standing order 12): people on GitHub read it', () => {
  const hidden = /^[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u;
  let kept = 0;
  for (let cp = 0; cp <= 0x10FFFF; cp += 1) {
    const ch = String.fromCodePoint(cp);
    let ok = true;
    try { textOf('body', `a${ch}`, 10, true); } catch { ok = false; }
    if (ok) kept += 1;
    if (ok && cp !== 0x0A) assert.ok(!hidden.test(ch) && (cp === 0x20 || !/^\s$/u.test(ch)), `U+${cp.toString(16)} passed`);
  }
  for (const ch of ['é', '中', '`', '#', '>', '\n', ' ']) assert.doesNotThrow(() => textOf('body', `a${ch}`, 10, true), ch);
  assert.throws(() => textOf('title', 'a\nb', 10, false));
  assert.ok(kept > 150_000, `${kept}`); // 159,347 on Node 26: the letters of every script stay
});
