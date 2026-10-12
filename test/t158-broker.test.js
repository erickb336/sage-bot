// T158: the sage-bot broker. Each test plays a bridge session s1 against a fake GitHub: a local bare repository for git and the
// in-process fake REST API (src/fake-github.js). No network, no real token: SAMPLE DATA ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDeflate } from 'node:zlib';
import { createBroker, IDENTITY, LIMITS, runGit, textOf } from '../src/broker.js';
import { fakeGitHub, samplePull } from '../src/fake-github.js';
import { execFileSync } from './bridge-setup.js';
import { tempFolder } from './temp-folder.js';

const TOKEN = 'sample-token-not-real';
const OWNER = 'sample-owner', REPO = 'sample-repo';
const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Mallory', GIT_AUTHOR_EMAIL: 'mallory@example.com', GIT_COMMITTER_NAME: 'Mallory', GIT_COMMITTER_EMAIL: 'mallory@example.com' };
/** git as the test's session or the test's GitHub, never as the broker. */
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A refusal must name no path (F-T158-15): no "/" that starts a word, and none of the test's folders by value. */
function noPath(text, folders) {
  assert.doesNotMatch(text, /(^|[\s"'(=:])\/[^\s/]+/, text);
  for (const f of folders) assert.ok(!text.includes(f) && !text.includes(f.replace(/^\/private/, '')), text);
}

/**
 * `remote`, `token` and `timeout` change the broker's GitHub, its token function and the most time of each of its git calls.
 * `session` is the session's name; `around(args, run, options)` wraps each git call of the broker, and `fetch(url, init, fake)` each
 * REST request. Every refusal goes through noPath.
 */
function world({ pulls = [], remote, token = () => TOKEN, timeout, session = 's1', around = (args, run) => run(), fetch, repo = REPO, branch = false } = {}) {
  const root = realpathSync(tempFolder('t158-')); // the broker compares the temp folder with its real path
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), folder = join(root, 'sessions', session), tmp = join(root, 'tmp', session);
  const workDir = join(root, 'broker');
  for (const d of [seed, tmp, workDir]) mkdirSync(d, { recursive: true });
  sh(root, 'init', '--bare', '--quiet', '-b', 'main', origin);
  sh(seed, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'sample\n');
  sh(seed, 'add', 'README.md'); sh(seed, 'commit', '--quiet', '-m', 'first');
  sh(seed, 'push', '--quiet', origin, 'main', 'main:refs/heads/sage-lead/s2');
  sh(seed, 'tag', 'v1'); sh(seed, 'push', '--quiet', origin, 'v1');
  if (branch) sh(seed, 'push', '--quiet', origin, `main:refs/heads/sage-lead/${session}`); // as after an upload: pr_create needs it (F-T191-5)
  sh(root, 'clone', '--quiet', origin, folder);
  const calls = [];
  const git = (args, o) => { calls.push({ args, cwd: o.cwd, env: o.env }); return around(args, () => runGit(args, timeout ? { ...o, timeout } : o), o); };
  const gh = fakeGitHub({ owner: OWNER, repo, token: TOKEN, pulls });
  const logs = [];
  const made = createBroker({ policy: { session, folder, tmp }, github: { owner: OWNER, repo, remote: remote ?? origin },
    token, workDir, fetch: fetch ? (url, init) => fetch(url, init, gh.fetch) : gh.fetch, git, log: (line) => logs.push(line) });
  const broker = { ...made, call: async (verb, input) => {
    const r = await made.call(verb, input);
    if (!r.ok) noPath(r.refused, [root, workDir, folder, tmp]);
    return r;
  } };
  const refs = () => Object.fromEntries(sh(origin, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').map((l) => l.split(' ')));
  const commit = (file, text, message = `change ${file}`) => {
    mkdirSync(join(folder, file, '..'), { recursive: true });
    writeFileSync(join(folder, file), text);
    sh(folder, 'add', file); sh(folder, 'commit', '--quiet', '-m', message);
    return sh(folder, 'rev-parse', 'HEAD');
  };
  return { root, origin, folder, tmp, workDir, broker, gh, calls, refs, commit, logs };
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
  sh(w.folder, 'config', 'core.ignorecase', 'false'); // the Mac's disk ignores case; git must keep the name as written
  await refused(w.commit('.GitHub/workflows/y.yml', 'on: push\n'), /changes "\.GitHub\/workflows\/y\.yml"/); // any letter case (F-T158-12)
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  rmSync(join(w.folder, '.GitHub'), { recursive: true, force: true });
  await refused(w.commit('a.txt', 'one\n', 'hidden ‮ text'), /has the character U\+202E/);
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  const side = w.commit('a.txt', 'one\n');
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  w.commit('b.txt', 'two\n');
  sh(w.folder, 'merge', '--quiet', '--no-edit', side);
  await refused(sh(w.folder, 'rev-parse', 'HEAD'), /is a merge or has no parent/);
  assert.deepEqual(w.refs(), before);
});

test('F-T158-21, G82 A: an upload carries main\'s .github as it is now, in any letter case', async () => {
  const w = world();
  sh(w.folder, 'config', 'core.ignorecase', 'false'); // the Mac's disk ignores case; git must keep the name as written
  const refused = async (commit) => {
    const r = await w.broker.call('upload', { commit });
    assert.deepEqual(r, { ok: false, refused: 'the session\'s branch must carry main\'s .github as it is now; a new session can start from the current main. The broker did nothing more.' });
  };
  // On main: A adds .github/workflows/keep.yml and .GitHub/workflows/up.yml; A2 adds .github/workflows/old.yml; B removes up.yml
  // and old.yml. Distinct file names, because the Mac's disk shows .github and .GitHub as one folder.
  w.commit('.github/workflows/keep.yml', 'on: pull_request\n');
  const a = w.commit('.GitHub/workflows/up.yml', 'on: push\n');
  const a2 = w.commit('.github/workflows/old.yml', 'on: push\n');
  sh(w.folder, 'rm', '--quiet', '.github/workflows/old.yml', '.GitHub/workflows/up.yml');
  sh(w.folder, 'commit', '--quiet', '-m', 'B');
  const b = sh(w.folder, 'rev-parse', 'HEAD');
  sh(w.folder, 'push', '--quiet', 'origin', 'HEAD:main');
  // (1) R761's case: a session on the old main commit A2 commits a harmless file; its .github is not main's now.
  sh(w.folder, 'reset', '--quiet', '--hard', a2);
  await refused(w.commit('c.txt', 'harmless\n'));
  // (4) On A, .github is main's now, and only .GitHub is old: a check that reads only ".github" lets this one go.
  sh(w.folder, 'reset', '--quiet', '--hard', a);
  await refused(w.commit('c.txt', 'harmless\n'));
  assert.equal(w.refs()['refs/heads/sage-lead/s1'], undefined);
  // (2) A session on the current main B uploads.
  sh(w.folder, 'reset', '--quiet', '--hard', b);
  const r1 = await w.broker.call('upload', { commit: w.commit('c.txt', 'harmless\n') });
  assert.equal(r1.ok, true, r1.refused);
  // (3) Main changes .github after that upload: the same session's next fast-forward still goes up (the accepted cost of G82 A).
  const seed = join(w.root, 'seed');
  sh(seed, 'pull', '--quiet', w.origin, 'main');
  mkdirSync(join(seed, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(seed, '.github', 'workflows', 'new.yml'), 'on: push\n');
  sh(seed, 'add', '.github'); sh(seed, 'commit', '--quiet', '-m', 'C'); sh(seed, 'push', '--quiet', w.origin, 'main');
  const r2 = await w.broker.call('upload', { commit: w.commit('d.txt', 'two\n') });
  assert.deepEqual([r2.ok, r2.refused, r2.pushed], [true, undefined, true]);
});

test('F-T158-21: an error that reads a tree refuses (fail closed)', async () => {
  const w = world({ around: (args, run) => (args.includes('ls-tree') ? Promise.reject(new Error('sample failure')) : run()) });
  const r = await w.broker.call('upload', { commit: w.commit('a.txt', 'one\n') });
  assert.deepEqual(r, { ok: false, refused: 'git ls-tree failed. The broker did nothing more.' });
  assert.equal(w.refs()['refs/heads/sage-lead/s1'], undefined);
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
  const w = world({ branch: true, pulls: [samplePull({ owner: OWNER, repo: REPO, number: 1, branch: 'sage-lead/s2' })] });
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
  for (const ch of ['é', '中', '`', '#', '>', '\n', ' ', '@']) assert.doesNotThrow(() => textOf('body', `a${ch}`, 10, true), ch);
  // Blank-looking symbols and the replacement character (F-T158-12): each one is refused by its code point.
  for (const cp of [0x2800, 0x3164, 0x115F, 0x1160, 0xFFA0, 0xFFFD]) {
    assert.throws(() => textOf('body', `a${String.fromCodePoint(cp)}`, 10, true), new RegExp(`U\\+${cp.toString(16).toUpperCase()}`));
  }
  assert.throws(() => textOf('title', 'a\nb', 10, false));
  assert.ok(kept > 150_000, `${kept}`); // 159,347 on Node 26: the letters of every script stay
});

/** git as the session, with more environment (for example the commit encoding or a rebase editor). */
const shWith = (cwd, env, ...args) => execFileSync('git', args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const refusedWith = async (w, verb, input, text) => {
  const r = await w.broker.call(verb, input);
  assert.equal(r.ok, false, `${verb} worked`);
  assert.match(r.refused, text);
  return r;
};

test('F-T158-13: a commit that is not UTF-8 is refused, so its bytes never change on the way to GitHub', async () => {
  const w = world();
  const before = w.refs();
  const base = sh(w.folder, 'rev-parse', 'HEAD');
  // ISO-8859-1: the message holds the byte 0xE9 (é), and git writes the header "encoding ISO-8859-1".
  writeFileSync(join(w.folder, 'msg'), Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x0A]));
  writeFileSync(join(w.folder, 'a.txt'), 'one\n');
  sh(w.folder, 'add', 'a.txt');
  shWith(w.folder, {}, '-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '--quiet', '-F', 'msg');
  await refusedWith(w, 'upload', { commit: sh(w.folder, 'rev-parse', 'HEAD') }, /is not UTF-8 text; the broker uploads only UTF-8 commits/);
  // The same encoding with a message that is plain ASCII: the bytes are UTF-8 too, but the header says otherwise.
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  writeFileSync(join(w.folder, 'b.txt'), 'two\n');
  sh(w.folder, 'add', 'b.txt');
  shWith(w.folder, {}, '-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '--quiet', '-m', 'plain');
  await refusedWith(w, 'upload', { commit: sh(w.folder, 'rev-parse', 'HEAD') }, /has the encoding "ISO-8859-1"/);
  assert.deepEqual(w.refs(), before);
  // The control: the same message in UTF-8 goes up with its bytes unchanged.
  sh(w.folder, 'reset', '--quiet', '--hard', base);
  const ok = await w.broker.call('upload', { commit: w.commit('c.txt', 'three\n', 'café') });
  assert.equal(ok.ok, true, ok.refused);
  assert.equal(sh(w.origin, 'cat-file', 'commit', ok.head).split('\n\n')[1], 'café');
});

test('F-T158-5: an error before the work starts leaves no folder of the broker behind', async () => {
  const empty = join(realpathSync(tempFolder('t158-empty-')), 'empty.git');
  sh(join(empty, '..'), 'init', '--bare', '--quiet', empty);
  const cases = [
    [{ remote: join(empty, '..', 'nowhere.git') }, /git ls-remote failed/],
    [{ remote: empty }, /GitHub has no main branch/],
    [{ token: () => { throw new Error('no token in /sample/path'); } }, /could not finish fetch \(an unexpected error\)/], // no text of an unknown error (F-T158-15)
  ];
  for (const [o, text] of cases) {
    const w = world(o);
    await refusedWith(w, 'fetch', {}, text);
    assert.deepEqual(readdirSync(w.workDir), [], String(text));
  }
});

test('F-T158-9, F-T158-7: fetch writes only into the real temp folder of the session; a link or a missing folder is refused', async () => {
  const w = world();
  const outside = join(w.root, 'outside');
  mkdirSync(outside);
  rmSync(w.tmp, { recursive: true });
  symlinkSync(outside, w.tmp);
  await refusedWith(w, 'fetch', {}, /temp folder is missing or is not a real folder of the session/);
  assert.deepEqual(readdirSync(outside), [], 'the broker wrote through the link');
  rmSync(w.tmp);
  const r = await refusedWith(w, 'fetch', {}, /temp folder is missing/);
  assert.ok(!r.refused.includes(w.root) && !r.refused.includes('ENOENT'), r.refused); // one clear line, no path
  assert.deepEqual(readdirSync(w.workDir), []);
  mkdirSync(w.tmp);
  assert.equal((await w.broker.call('fetch')).ok, true, 'the control: a real folder works');
});

/** A loose object of `size` zero bytes, written as a stream: about 1 MB on disk for 1 GB of content. */
async function zeroBlob(folder, size) {
  const head = Buffer.from(`blob ${size}\0`), zero = Buffer.alloc(2 ** 20);
  const sha = createHash('sha1').update(head);
  const tmp = join(folder, '.git', 'objects', 'bomb.tmp');
  async function* content() { yield head; for (let n = 0; n < size; n += zero.length) { sha.update(zero); yield zero; } }
  await pipeline(content, createDeflate({ level: 1 }), createWriteStream(tmp));
  const id = sha.digest('hex');
  mkdirSync(join(folder, '.git', 'objects', id.slice(0, 2)), { recursive: true });
  renameSync(tmp, join(folder, '.git', 'objects', id.slice(0, 2), id.slice(2)));
  return id;
}

/** The longest delay of a 20 ms timer while `work` runs: the event loop of the sage-bot process must keep running. */
async function lagDuring(work) {
  let last = Date.now(), lag = 0;
  const tick = () => { const now = Date.now(); lag = Math.max(lag, now - last - 20); last = now; };
  const timer = setInterval(tick, 20);
  try { return { result: await work(), lag: () => lag }; } finally { clearInterval(timer); tick(); } // the last gap too: a timer that never fired
}

test('F-T158-10: a 1 GB object of zeros is refused before git unpacks it, and the event loop keeps running', async () => {
  const w = world();
  const c1 = w.commit('a.txt', 'one\n');
  const id = await zeroBlob(w.folder, 2 ** 30);
  assert.equal(sh(w.folder, 'cat-file', '-s', id), String(2 ** 30)); // the control: git sees 1 GB
  const start = Date.now();
  const { result, lag } = await lagDuring(() => w.broker.call('upload', { commit: c1 }));
  assert.equal(result.ok, false);
  assert.match(result.refused, /an object over 50 MB, or more than 512 MB of objects, unpacked/);
  assert.ok(Date.now() - start < 10_000, `${Date.now() - start} ms`);
  assert.ok(lag() < 500, `the event loop stopped for ${lag()} ms`);
  assert.deepEqual([LIMITS.object, LIMITS.inflated], [50 * 2 ** 20, 512 * 2 ** 20]);
  assert.deepEqual(readdirSync(w.workDir), []);
});

test('F-T158-10, F-T158-17: a GitHub that never answers times out and refuses; git\'s HTTP helper goes with git', async () => {
  const open = new Set();
  let accepted = 0;
  const silent = createServer((socket) => { // it reads (so that it sees the close) and says nothing
    accepted += 1; open.add(socket); socket.on('close', () => open.delete(socket)); socket.resume();
  });
  await new Promise((done) => silent.listen(0, '127.0.0.1', done));
  try {
    const w = world({ remote: `http://127.0.0.1:${silent.address().port}/sample.git`, timeout: 1500 });
    const start = Date.now();
    const { result, lag } = await lagDuring(() => w.broker.call('fetch'));
    assert.ok(lag() < 500, `the event loop stopped for ${lag()} ms`);
    assert.equal(result.ok, false);
    assert.match(result.refused, /git ls-remote took too long/);
    assert.ok(Date.now() - start < 5000, `${Date.now() - start} ms`);
    assert.deepEqual(readdirSync(w.workDir), []);
    // The listener counts the connections that are still open: the timeout kills git's process group, helper and all.
    const until = Date.now() + 3000;
    while (open.size && Date.now() < until) await sleep(50);
    assert.ok(accepted > 0, 'git never connected');
    assert.equal(open.size, 0, `${open.size} of ${accepted} connections still open ${Date.now() - start} ms after the call began`);
  } finally { for (const socket of open) socket.destroy(); silent.close(); }
});

test('F-T158-14: a push that took too long can still have landed; the refusal says so, and a second upload tells', async () => {
  // The push lands on the local GitHub, then the broker sees a timeout: what a slow GitHub can do.
  const w = world({ around: async (args, run) => {
    const out = await run();
    if (args.includes('push')) throw Object.assign(new Error('sample timeout'), { killed: true });
    return out;
  } });
  const c1 = w.commit('a.txt', 'one\n');
  const r = await w.broker.call('upload', { commit: c1 });
  assert.deepEqual(r, { ok: false, refused: 'git push took too long; the upload may have landed: call upload again to check.' });
  const head = w.refs()['refs/heads/sage-lead/s1'];
  assert.ok(head, 'the control: the ref landed');
  assert.deepEqual(await w.broker.call('upload', { commit: c1 }), { ok: true, branch: 'sage-lead/s1', head, commits: 1, pushed: false });
});

test('F-T158-15: a refusal names a folder by its role, never by its path', async () => {
  const w = world();
  const c1 = w.commit('a.txt', 'one\n');
  rmSync(w.workDir, { recursive: true });
  await refusedWith(w, 'upload', { commit: c1 }, /^the broker's work folder is missing or the broker cannot write in it\./);
  mkdirSync(w.workDir);
  const git = join(w.folder, '.git'), objects = join(git, 'objects'), away = join(w.root, 'away');
  renameSync(objects, away); symlinkSync(away, objects);
  await refusedWith(w, 'upload', { commit: c1 }, /^the session's \.git\/objects folder is missing or is not a folder \(a link is not one\)/);
  rmSync(objects); renameSync(away, objects);
  renameSync(git, away);
  await refusedWith(w, 'upload', { commit: c1 }, /^the session's \.git folder is missing or is not a folder/);
  renameSync(away, git);
  assert.equal((await w.broker.call('upload', { commit: c1 })).ok, true, 'the control: with every folder back, the upload works');
});

test('F-T158-16: the verbs of one session run one at a time; two sessions run at once', async () => {
  const w = world();
  const c1 = w.commit('a.txt', 'one\n');
  const [a, b] = await Promise.all([w.broker.call('upload', { commit: c1 }), w.broker.call('upload', { commit: c1 })]);
  assert.deepEqual([a.ok, a.pushed, b.ok, b.pushed, b.head], [true, true, true, false, a.head], `${a.refused} ${b.refused}`);
  // Each ls-remote takes 300 ms more, and says when it starts and ends.
  const events = [];
  const slow = (session) => async (args, run) => {
    if (args.includes('ls-remote')) { events.push(`${session} start`); await sleep(300); events.push(`${session} end`); }
    return run();
  };
  const s1 = world({ around: slow('s1') }), s2 = world({ session: 's2', around: slow('s2') });
  const all = await Promise.all([s1.broker.call('fetch'), s2.broker.call('fetch'), s1.broker.call('fetch')]);
  assert.deepEqual(all.map((r) => r.ok), [true, true, true], all.map((r) => r.refused).join(' '));
  assert.deepEqual(events.slice(0, 2).sort(), ['s1 start', 's2 start'], events.join(', ')); // two sessions at once
  assert.deepEqual(events.filter((e) => e.startsWith('s1')), ['s1 start', 's1 end', 's1 start', 's1 end'], events.join(', ')); // one session: one at a time
});

test('F-T158-22: session s1 of two repositories runs at once; the verbs of one s1 still run one at a time', async () => {
  // Each REST request takes 300 ms more, and says when it starts and ends.
  const events = [];
  const slow = (name) => async (url, init, fake) => { events.push(`${name} start`); await sleep(300); events.push(`${name} end`); return fake(url, init); };
  const a = world({ repo: 'repo-a', fetch: slow('a') }), b = world({ repo: 'repo-b', fetch: slow('b') });
  const all = await Promise.all([a.broker.call('pr_view'), b.broker.call('pr_view'), a.broker.call('pr_view')]);
  assert.deepEqual(new Set(all.map((r) => r.refused)), new Set(['this session has no pull request yet. The broker did nothing more.'])); // each read GitHub
  assert.deepEqual(events.slice(0, 2), ['a start', 'b start'], events.join(', ')); // b does not wait for a's slow request
  assert.deepEqual(events.filter((e) => e.startsWith('a')), ['a start', 'a end', 'a start', 'a end'], events.join(', ')); // one s1: one at a time
});

/** `run` with LIMITS[key] set to `ms`, and the limit back after. */
async function withLimit(key, ms, run) {
  const before = LIMITS[key];
  LIMITS[key] = ms;
  try { return await run(); } finally { LIMITS[key] = before; }
}
const never = () => new Promise(() => {});
const took = async (call) => { const t0 = Date.now(); const r = await call; return [r, Date.now() - t0]; };

test('F-T158-18: a REST request that never answers refuses at the time limit; the session\'s next verb then runs; s2 never waits', async () => {
  assert.deepEqual([LIMITS.restMs, LIMITS.tokenMs], [60_000, 30_000]);
  await withLimit('restMs', 500, async () => {
    const signals = [];
    let hang = 1; // the first POST never answers, as a GitHub that took the request and hangs
    const w = world({ branch: true, fetch: (url, init, fake) => {
      if (init.method === 'POST' && hang-- > 0) { signals.push(init.signal); return never(); }
      return fake(url, init);
    } });
    const s2 = world({ session: 's2' });
    const first = took(w.broker.call('pr_create', { title: 'one', body: 'first' }));
    const next = took(w.broker.call('pr_create', { title: 'two', body: 'second' })); // waits for the first: one at a time
    const [other, otherMs] = await took(s2.broker.call('pr_view'));
    assert.deepEqual([other.refused, otherMs < 250], ['this session has no pull request yet. The broker did nothing more.', true], `${otherMs} ms`);
    const [a, aMs] = await first;
    assert.deepEqual([a.ok, a.refused], [false, 'GitHub took too long; the change may have happened: call pr_view to check.']);
    assert.ok(aMs >= 450 && aMs < 2000, `${aMs} ms`);
    assert.equal(signals[0].aborted, true); // the request itself is stopped too
    const [b, bMs] = await next;
    assert.deepEqual([b.ok, b.title, b.body], [true, 'two', 'second'], b.refused);
    assert.ok(bMs < aMs + 1000, `${bMs} ms`);
    // A read that took too long changed nothing: it says so.
    const r = world({ fetch: () => never() });
    assert.deepEqual(await r.broker.call('pr_view'), { ok: false, refused: 'GitHub took too long. The broker did nothing more.' });
  });
});

test('F-T158-18: an answer whose body drips forever refuses at the time limit', async () => {
  await withLimit('restMs', 500, async () => {
    let drops = 0, signal;
    const w = world({ fetch: (url, init) => {
      signal = init.signal;
      // The headers come at once; then one byte every 20 ms, never the end.
      const body = new ReadableStream({ async pull(c) { await sleep(20); if (!signal.aborted) { drops += 1; c.enqueue(new Uint8Array([32])); } } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    } });
    const [r, ms] = await took(w.broker.call('pr_view'));
    assert.deepEqual(r, { ok: false, refused: 'GitHub took too long. The broker did nothing more.' });
    assert.ok(ms >= 450 && ms < 2000 && drops > 5, `${ms} ms, ${drops} bytes`);
    assert.equal(signal.aborted, true);
  });
});

test('F-T158-18: a token function that never answers refuses at the time limit and lets the session\'s next verb run', async () => {
  await withLimit('tokenMs', 300, async () => {
    let hang = 2; // the token of the fetch verb (git) and of pr_view (REST) never come
    const w = world({ token: () => (hang-- > 0 ? never() : TOKEN) });
    const s2 = world({ session: 's2' });
    const calls = [took(w.broker.call('fetch')), took(w.broker.call('pr_view')), took(w.broker.call('pr_view'))];
    const [other, otherMs] = await took(s2.broker.call('pr_view'));
    assert.deepEqual([other.refused, otherMs < 150], ['this session has no pull request yet. The broker did nothing more.', true], `${otherMs} ms`);
    const [[f, fMs], [v, vMs], [last, lastMs]] = await Promise.all(calls);
    const late = 'the token lookup took too long. The broker did nothing more.';
    assert.deepEqual([f.refused, v.refused, last.refused], [late, late, 'this session has no pull request yet. The broker did nothing more.']);
    assert.ok(fMs >= 250 && vMs >= 550 && lastMs < 3000, `${fMs}, ${vMs}, ${lastMs} ms`);
    assert.deepEqual(readdirSync(w.workDir), []); // the fetch verb's folder went too
  });
});

test('a work folder that cannot be removed after a push does not turn the push into a refusal; the broker logs it', async () => {
  let workDir;
  const w = world({ around: async (args, run, o) => {
    const out = await run();
    if (args.includes('push')) { workDir = dirname(o.cwd); chmodSync(workDir, 0o555); } // the broker can no longer remove its folder
    return out;
  } });
  const c1 = w.commit('a.txt', 'one\n');
  try {
    const r = await w.broker.call('upload', { commit: c1 });
    assert.deepEqual([r.ok, r.pushed, r.head], [true, true, w.refs()['refs/heads/sage-lead/s1']], r.refused);
    assert.deepEqual(w.logs, ['broker s1: could not remove a work folder (EACCES)']);
  } finally { if (workDir) chmodSync(workDir, 0o755); }
});

test('F-T158-6: a commit id that the session does not have gets the clear refusal', async () => {
  const w = world();
  await refusedWith(w, 'upload', { commit: 'a'.repeat(40) }, new RegExp(`^${'a'.repeat(40)} is not a commit of the session\\.`));
});

test('F-T158-11: a hard link to a file outside the session is not an object, and the upload refuses it', async () => {
  const w = world();
  const c1 = w.commit('a.txt', 'one\n');
  const secret = join(w.root, 'secret.txt');
  writeFileSync(secret, 'sample secret, not a git object\n');
  mkdirSync(join(w.folder, '.git', 'objects', 'ab'), { recursive: true });
  linkSync(secret, join(w.folder, '.git', 'objects', 'ab', 'c'.repeat(38)));
  await refusedWith(w, 'upload', { commit: c1 }, /an object that git cannot read|git (cat-file|fsck) failed/);
  assert.equal(w.refs()['refs/heads/sage-lead/s1'], undefined);
});

test('F-T158-1, -2, -4: a fake bare repository, a rebase exec line and an alternates file in the session folder change nothing', async () => {
  const w = world();
  const sentinel = join(w.root, 'ran');
  const run = `#!/bin/sh\ntouch ${sentinel}\n`;
  // -1: a fake bare repository in the session folder, with a hook that git there would run.
  const fake = join(w.folder, 'fake');
  sh(w.folder, 'init', '--bare', '--quiet', fake);
  writeFileSync(join(fake, 'hooks', 'reference-transaction'), run, { mode: 0o755 });
  // -2: a rebase stopped at "break", with an exec line still in its todo list.
  const c1 = w.commit('a.txt', 'one\n');
  const c2 = w.commit('b.txt', 'two\n');
  shWith(w.folder, { GIT_SEQUENCE_EDITOR: `printf 'break\\nexec touch ${sentinel}\\n' >` }, 'rebase', '--quiet', '-i', c1);
  assert.match(sh(w.folder, 'status'), /interactive rebase in progress/);
  // -4: c2's new blob lives only in another repository, that objects/info/alternates names.
  const blob = sh(w.folder, 'rev-parse', `${c2}:b.txt`);
  const other = join(w.root, 'other.git');
  sh(w.root, 'init', '--bare', '--quiet', other);
  mkdirSync(join(other, 'objects', blob.slice(0, 2)), { recursive: true });
  renameSync(join(w.folder, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), join(other, 'objects', blob.slice(0, 2), blob.slice(2)));
  writeFileSync(join(w.folder, '.git', 'objects', 'info', 'alternates'), `${join(other, 'objects')}\n`);
  assert.equal(sh(w.folder, 'cat-file', '-t', blob), 'blob'); // the control: git in the session folder reads the alternates
  // The broker: c1 goes up from the copied objects; c2 needs the blob that only the alternates have, so it is refused.
  const r1 = await w.broker.call('upload', { commit: c1 });
  assert.equal(r1.ok, true, r1.refused);
  await refusedWith(w, 'upload', { commit: c2 }, /git (fsck|rev-list) failed/);
  assert.equal(existsSync(sentinel), false, 'code of the session ran');
  assert.ok(w.calls.every(({ cwd, args }) => cwd.startsWith(w.workDir) && !args.some((a) => a.includes(w.folder))));
  // The controls: git in the session folder runs the exec line and the fake repository's hook.
  shWith(w.folder, { GIT_EDITOR: 'true' }, 'rebase', '--continue');
  assert.equal(existsSync(sentinel), true, 'the rebase exec line');
  rmSync(sentinel);
  sh(fake, 'update-ref', 'refs/tags/x', sh(fake, 'hash-object', '-w', '--stdin'));
  assert.equal(existsSync(sentinel), true, 'the fake repository\'s hook');
});

// T191 (round 5): truthful refusals. A GitHub answer as the fake's fetch would give it, with a body that names a path (never shown).
const answer = (status) => new Response(JSON.stringify({ message: 'sample text of /sample/path' }), { status });
const mayHappen = 'the change may have happened: call pr_view to check.';

test('F-T191-1: once a write was sent, a 5xx, a list that does not show it yet and a network error each say it may have happened', async () => {
  // A POST that GitHub answers with 502 or 422.
  for (const [status, meaning] of [[502, 'an error of GitHub'], [500, 'an error of GitHub']]) {
    const w = world({ branch: true, fetch: (url, init, fake) => (init.method === 'POST' ? answer(status) : fake(url, init)) });
    assert.deepEqual(await w.broker.call('pr_create', { title: 't', body: 'b' }), { ok: false, refused: `GitHub answered ${status} to POST: ${meaning}; ${mayHappen}` });
  }
  // A POST that lands, while GitHub's list does not show the new pull request yet.
  let posted = false;
  const w = world({ branch: true, fetch: async (url, init, fake) => {
    if (init.method === 'POST') { posted = true; return fake(url, init); }
    return posted ? new Response('[]', { status: 200 }) : fake(url, init);
  } });
  assert.deepEqual(await w.broker.call('pr_create', { title: 't', body: 'b' }), { ok: false, refused: `GitHub does not list the session's pull request yet; ${mayHappen}` });
  assert.equal(w.gh.state.pulls.length, 1, 'the control: the pull request landed');
  // A PATCH whose connection fails: undici throws a TypeError with no code.
  const e = world({ pulls: [samplePull({ owner: OWNER, repo: REPO, number: 3, branch: 'sage-lead/s1' })],
    fetch: (url, init, fake) => (init.method === 'PATCH' ? Promise.reject(new TypeError('fetch failed')) : fake(url, init)) });
  assert.deepEqual(await e.broker.call('pr_edit', { title: 'x' }), { ok: false, refused: `the broker could not finish pr_edit (an unexpected error); ${mayHappen}` });
  // The control: a read that fails sent no change, and says so.
  const r = world({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
  assert.deepEqual(await r.broker.call('pr_view'), { ok: false, refused: 'the broker could not finish pr_view (an unexpected error). The broker did nothing more.' });
});

test('F-T191-8: a GitHub 4xx answer to a write is a definite refusal: nothing changed, and the broker says so', async () => {
  const again = { ok: false };
  for (const status of [401, 403, 404, 422]) {
    const meaning = status === 404 ? 'not found' : status === 422 ? 'GitHub refused the request' : 'the broker\'s GitHub access was refused';
    const post = world({ branch: true, fetch: (url, init, fake) => (init.method === 'POST' ? answer(status) : fake(url, init)) });
    assert.deepEqual(await post.broker.call('pr_create', { title: 't', body: 'b' }), { ...again, refused: `GitHub answered ${status} to POST: ${meaning}. The broker did nothing more.` });
    assert.equal(post.gh.state.pulls.length, 0, 'nothing changed');
    const pull = samplePull({ owner: OWNER, repo: REPO, number: 3, branch: 'sage-lead/s1' });
    const patch = world({ pulls: [pull], fetch: (url, init, fake) => (init.method === 'PATCH' ? answer(status) : fake(url, init)) });
    assert.deepEqual(await patch.broker.call('pr_edit', { title: 'x' }), { ...again, refused: `GitHub answered ${status} to PATCH: ${meaning}. The broker did nothing more.` });
    assert.equal(patch.gh.state.pulls[0].title, pull.title, 'nothing changed');
  }
  // The control: a 502 after the fake made the change still says it may have happened.
  const w = world({ branch: true, fetch: async (url, init, fake) => { const r = await fake(url, init); return init.method === 'POST' ? answer(502) : r; } });
  assert.equal((await w.broker.call('pr_create', { title: 't', body: 'b' })).refused, `GitHub answered 502 to POST: an error of GitHub; ${mayHappen}`);
  assert.equal(w.gh.state.pulls.length, 1);
  // A 4xx on the read-back after a landed write is not the write's refusal: it may have happened.
  let posted = false;
  const rb = world({ branch: true, fetch: async (url, init, fake) => {
    if (init.method === 'POST') { posted = true; return fake(url, init); }
    return posted ? answer(403) : fake(url, init);
  } });
  assert.equal((await rb.broker.call('pr_create', { title: 't', body: 'b' })).refused, `GitHub answered 403 to GET: the broker's GitHub access was refused; ${mayHappen}`);
});

test('F-T194-1: a token lookup that takes too long before the POST sends nothing, and says so', async () => {
  await withLimit('tokenMs', 300, async () => {
    let n = 0; // the token of ls-remote (git) and of the list (GET) come; the one of the POST never does
    const w = world({ branch: true, token: () => (++n === 3 ? never() : TOKEN) });
    assert.deepEqual(await w.broker.call('pr_create', { title: 't', body: 'b' }), { ok: false, refused: 'the token lookup took too long. The broker did nothing more.' });
    assert.deepEqual([n, w.gh.calls.map((c) => c.method)], [3, ['GET']]);
  });
});

test('F-T191-2: a GitHub error status reaches the session as its method, status and meaning, with no path and no text of GitHub', async () => {
  for (const [status, meaning] of [[403, 'the broker\'s GitHub access was refused'], [401, 'the broker\'s GitHub access was refused'], [404, 'not found'], [500, 'an error of GitHub'], [409, 'an answer that the broker does not expect']]) {
    const w = world({ fetch: () => answer(status) });
    assert.deepEqual(await w.broker.call('pr_view'), { ok: false, refused: `GitHub answered ${status} to GET: ${meaning}. The broker did nothing more.` });
  }
});

test('F-T191-5: pr_create before any upload refuses with one clear line, before it calls GitHub', async () => {
  const w = world();
  assert.deepEqual(await w.broker.call('pr_create', { title: 't', body: 'b' }), { ok: false, refused: 'sage-lead/s1 is not on GitHub yet: upload the session\'s branch first. The broker did nothing more.' });
  assert.deepEqual(w.gh.calls, []);
  assert.equal((await w.broker.call('upload', { commit: w.commit('a.txt', 'one\n') })).ok, true);
  const made = await w.broker.call('pr_create', { title: 't', body: 'b' });
  assert.deepEqual([made.ok, made.number], [true, 1], 'the control: after the upload, pr_create works');
});

test('F-T191-4: pr_view gives the url and the base through the text allow-list', async () => {
  const pr = samplePull({ owner: OWNER, repo: REPO, number: 4, branch: 'sage-lead/s1' });
  pr.html_url = `https://github.com/${OWNER}/${REPO}/pull/4\u202E\u0007`;
  pr.base.ref = 'main\u200B\n';
  const w = world({ pulls: [pr] });
  const r = await w.broker.call('pr_view');
  assert.deepEqual([r.url, r.base], [`https://github.com/${OWNER}/${REPO}/pull/4  `, 'main \n']);
});

test('F-T191-7: fetch answers the commit ids that its bundle holds, also when main moves during the fetch', async () => {
  let w;
  w = world({ branch: true, around: async (args, run) => {
    const out = await run();
    if (args.includes('ls-remote')) { // GitHub's main moves after ls-remote and before the fetch
      const seed = join(w.root, 'seed');
      writeFileSync(join(seed, 'moved.txt'), 'moved\n');
      sh(seed, 'add', 'moved.txt'); sh(seed, 'commit', '--quiet', '-m', 'moved');
      sh(seed, 'push', '--quiet', w.origin, 'main', 'main:refs/heads/sage-lead/s1');
    }
    return out;
  } });
  const r = await w.broker.call('fetch');
  assert.equal(r.ok, true, r.refused);
  const heads = sh(w.root, 'bundle', 'list-heads', r.bundle);
  assert.equal(heads, `${r.main} refs/heads/main\n${r.branch} refs/heads/sage-lead/s1`);
  assert.deepEqual([r.main, r.branch], [w.refs()['refs/heads/main'], w.refs()['refs/heads/sage-lead/s1']]);
});

test('F-T191-3: a git call that prints more than LIMITS.output refuses with its own line', async () => {
  assert.equal(LIMITS.output, 256 * 2 ** 20);
  await withLimit('output', 10, async () => {
    const w = world();
    assert.deepEqual(await w.broker.call('fetch'), { ok: false, refused: 'git ls-remote printed too much. The broker did nothing more.' });
    assert.deepEqual(readdirSync(w.workDir), []);
  });
});

test('F-T191-6, G82 A: an old main whose .github has the same names as main\'s now, with another file inside, is refused', async () => {
  const w = world();
  const a = w.commit('.github/workflows/ci.yml', 'on: push\n');
  w.commit('.github/workflows/ci.yml', 'on: pull_request\n');
  sh(w.folder, 'push', '--quiet', 'origin', 'HEAD:main');
  sh(w.folder, 'reset', '--quiet', '--hard', a);
  const r = await w.broker.call('upload', { commit: w.commit('c.txt', 'harmless\n') });
  assert.deepEqual(r, { ok: false, refused: 'the session\'s branch must carry main\'s .github as it is now; a new session can start from the current main. The broker did nothing more.' });
  assert.equal(w.refs()['refs/heads/sage-lead/s1'], undefined);
});
