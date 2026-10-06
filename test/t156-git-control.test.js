// T156 (F-T156-13): the git control paths of a lead session. Real git, outside any sandbox, runs each attack of the security re-check
// (R518) on a fixture session folder: the sandbox must stop each operation of the attack's control step, and a normal add, commit and
// branch switch must make only operations that the sandbox allows. On macOS, the same attacks then run under a seatbelt profile made
// from the generated denyWrite, to check the model of the rules below against the kernel. SAMPLE DATA ONLY: the fixture is a new temp
// folder, git reads no global or system config, and no model session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './bridge-setup.js';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { leadPolicy, settingsOf } from '../src/lead-policy.js';

// How Claude Code 2.1.289 turns a denyWrite entry into seatbelt rules on macOS (read from its binary: functions ZBt, cGr, lc and mT):
// - a glob denies every write to a path it matches, and to everything below that path (the regex ends in "(/.*)?$");
// - a literal path denies every write to it and below it (subpath);
// - creating or removing a parent of a literal path, or the glob's literal start folder or a parent of it, is denied too.
const globRe = (g) => new RegExp(`^${g.replace(/[.^$+{}()|\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001')
  .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(.*/)?').replace(/\u0001/g, '.*')}(/.*)?$`);
const isGlob = (p) => /[*?[\]]/.test(p);
const startOf = (g) => { const s = g.split(/[*?[\]]/)[0]; return s.endsWith('/') ? s.slice(0, -1) : dirname(s); };
const parents = (p) => { const r = []; for (let d = dirname(p); d !== '/'; d = dirname(d)) r.push(d); return r; };
/** Whether the sandbox denies `kind` ('write' a file's content, 'create' or 'remove' an entry) on `path`. */
function denied(denyWrite, path, kind) {
  return denyWrite.some((e) => {
    if (isGlob(e) ? globRe(e).test(path) : path === e || path.startsWith(`${e}/`)) return true;
    if (kind === 'write') return false;
    return isGlob(e) ? [startOf(e), ...parents(startOf(e))].includes(path) : parents(e).includes(path);
  });
}

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'sage-bot-git-control-')));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));
const POLICY = leadPolicy({ statePath: '/s/state/gates.json', leadSessionsPath: ROOT }, 's1', { env: {}, home: '/h', userTemp: '/u' });
const F = POLICY.folder, TEMPLATE = join(ROOT, 'template'), MARK = join(ROOT, 'pwned');
const DENY_WRITE = settingsOf(POLICY).sandbox.filesystem.denyWrite;
const ENV = { PATH: process.env.PATH, HOME: ROOT, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', MARK,
  // No detached auto maintenance after a commit: it wrote and removed .git/objects/maintenance.lock while snapshot() read the folder.
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false' };
const sh = (script, wrap = []) => spawnSync(wrap[0] ?? 'sh', [...wrap.slice(1), ...(wrap.length ? ['sh'] : []), '-c', script], { cwd: F, env: ENV, encoding: 'utf8' });
const ok = (script) => { const r = sh(script); assert.equal(r.status, 0, `${script}\n${r.stderr}`); return r.stdout; };

// The fixture session folder: a repository with one commit, a submodule m (its git folder in .git/modules/m), a linked worktree wt, and
// the repository format that reads config.worktree. It is made once, kept in TEMPLATE, and copied to F for each case.
mkdirSync(F, { recursive: true });
ok(`set -e; git init -q -b main . && echo a > a && git add a && git commit -qm one
  mkdir .git/modules && git init -q -b main --separate-git-dir="$PWD/.git/modules/m" m && (cd m && git commit -q --allow-empty -m m)
  git worktree add -q wt -b wt
  git config core.repositoryformatversion 1 && git config extensions.worktreeConfig true`);
cpSync(F, TEMPLATE, { recursive: true, verbatimSymlinks: true });
function fresh() { rmSync(F, { recursive: true, force: true }); rmSync(MARK, { force: true }); cpSync(TEMPLATE, F, { recursive: true, verbatimSymlinks: true }); }

/** Every entry below F, and F: its inode and, for a file, its content. */
function snapshot() {
  const out = new Map([[F, { ino: lstatSync(F).ino, data: '' }]]);
  for (const name of readdirSync(F, { recursive: true })) {
    const path = join(F, name), st = lstatSync(path);
    out.set(path, { ino: st.ino, data: st.isFile() ? readFileSync(path, 'base64') : '' });
  }
  return out;
}
/**
 * The file operations from one snapshot to the next. Each is a list of [path, kind]; the sandbox stops the operation when it denies
 * one of them. A rename is one operation (remove the old path, create the new one; what moves with a folder is not written), a hard
 * link is a write to its target, and a file that git replaces (a lock file renamed onto it) is a create. A folder's own entry list is
 * not a write to the folder: seatbelt checks the entry.
 */
function operations(before, after) {
  const inoBefore = new Map([...before].map(([p, v]) => [v.ino, p])), inoAfter = new Set([...after.values()].map((v) => v.ino));
  const ops = [];
  for (const [p, v] of after) {
    const old = before.get(p), from = inoBefore.get(v.ino);
    if (old?.ino === v.ino) { if (old.data !== v.data) ops.push([[p, 'write']]); continue; }
    if (from === undefined) ops.push([[p, 'create']]);
    else if (after.get(from)?.ino === v.ino) ops.push([[from, 'write'], [p, 'create']]); // a hard link
    else if (dirname(from) === dirname(p) || before.get(dirname(from))?.ino !== after.get(dirname(p))?.ino) ops.push([[from, 'remove'], [p, 'create']]);
  }
  for (const [p, v] of before) if (!after.has(p) && !inoAfter.has(v.ino)) ops.push([[p, 'remove']]);
  return ops;
}
const blocked = (op) => op.some(([p, kind]) => denied(DENY_WRITE, p, kind));

// Each attack: a payload that a session may write (it must not redirect git alone), the control step (the sandbox must stop each of
// its operations), what the attack does after it, and a probe that shows the redirect. "!touch $MARK" stands for any code of the attacker.
const ALIAS = `[alias]\n\tpwn = !touch \\"$MARK\\"\n`;
const EVIL = `git init -q --bare evil && printf '${ALIAS}' >> evil/config`;
const alias = (dir) => `git -C ${dir} pwn; test -e "$MARK"`;
const SET = `alias.pwn '!touch "$MARK"'`;
const HOOK = (dir) => `printf '#!/bin/sh\\ntouch "$MARK"\\n' > ${dir}/post-commit && chmod +x ${dir}/post-commit`;
const HOOKS_PATH = `printf '[core]\\n\\thooksPath = %s/hk\\n' "$PWD"`; // config.worktree: git reads no alias from it
const hookRun = (dir) => `cd ${dir} && git hook run post-commit; test -e "$MARK"`;
const ATTRIBUTE = 'git check-attr filter a | grep -q "filter: pwn"';
const ATTACKS = [
  ['.git/commondir names another folder (R518 1)', EVIL, `printf '../evil\\n' > .git/commondir`, '', alias('.')],
  ['.git/config', '', `git config ${SET}`, '', alias('.')],
  ['.git/config by a hard link', '', 'ln .git/config cfg', `printf '${ALIAS}' >> cfg`, alias('.')],
  ['.git/config.worktree', `mkdir hk && ${HOOK('hk')}`, `${HOOKS_PATH} > .git/config.worktree`, '', hookRun('.')],
  ['.git/hooks', '', HOOK('.git/hooks'), '', hookRun('.')],
  ['.git renamed away, changed and renamed back', '', 'mv .git .g', `git --git-dir=.g config ${SET} && mv .g .git`, alias('.')],
  ['.git/modules/<name>/config (R518 2)', '', `git config -f .git/modules/m/config ${SET}`, '', alias('m')],
  ['.git/modules/<name>/hooks (R518 2)', '', HOOK('.git/modules/m/hooks'), '', hookRun('m')],
  ['.git/worktrees/<name>/commondir', EVIL, `printf '../../../evil\\n' > .git/worktrees/wt/commondir`, '', alias('wt')],
  ['.git/worktrees/<name>/config.worktree', `mkdir hk && ${HOOK('hk')}`, `${HOOKS_PATH} > .git/worktrees/wt/config.worktree`, '', hookRun('wt')],
  ['.git/worktrees renamed away, changed and renamed back', EVIL, 'mv .git/worktrees .git/w', `printf '../../../evil\\n' > .git/w/wt/commondir && mv .git/w .git/worktrees`, alias('wt')],
  ['a gitlink file in a subfolder (R518 2)', `${EVIL} && mkdir sub`, `printf 'gitdir: ../evil\\n' > sub/.git`, '', alias('sub')],
  ['the gitlink file of a submodule', EVIL, `printf 'gitdir: ../evil\\n' > m/.git`, '', alias('m')],
  ['a new repository in a subfolder', 'mkdir sub', 'git init -q sub', `git -C sub config ${SET}`, alias('sub')],
  ['.git/info/attributes', '', `printf '* filter=pwn\\n' > .git/info/attributes`, '', ATTRIBUTE],
  ['.git/info renamed away, changed and renamed back', '', 'mv .git/info .git/i', `printf '* filter=pwn\\n' > .git/i/attributes && mv .git/i .git/info`, ATTRIBUTE],
];
const COMMIT = 'echo b > b && git add b && git commit -qm two && git switch -q -c side && echo c > a && git commit -qam three';

test('the sandbox stops each operation of each attack\'s control step, and each attack works without the sandbox', () => {
  for (const [name, payload, control, after, probe] of ATTACKS) {
    fresh();
    if (payload) ok(payload);
    assert.notEqual(sh(probe).status, 0, `${name}: the payload alone redirects git`);
    const before = snapshot();
    ok(control);
    const ops = operations(before, snapshot());
    assert.ok(ops.length > 0, `${name}: the control step changed nothing`);
    assert.deepEqual(ops.filter((op) => !blocked(op)), [], `${name}: operations that the sandbox allows`);
    if (after) ok(after);
    assert.equal(sh(probe).status, 0, `${name}: the attack did not redirect git, so this case proves nothing`);
  }
});

test('a normal add, commit and branch switch make only operations that the sandbox allows', () => {
  fresh();
  const before = snapshot();
  ok(COMMIT);
  const ops = operations(before, snapshot()), paths = ops.flat().map(([p]) => p);
  assert.ok(paths.includes(join(F, '.git/HEAD')) && paths.includes(join(F, '.git/index')), 'the case writes HEAD and the index');
  assert.deepEqual(ops.filter(blocked), []);
});

// The kernel check: the rules above, as Claude Code 2.1.289 writes them, in a seatbelt profile. It runs only where sandbox-exec works
// (macOS, and not already inside a sandbox).
const profile = join(ROOT, 'lead.sb'), q = (s) => JSON.stringify(s);
writeFileSync(profile, ['(version 1)', '(allow default)', ...DENY_WRITE.flatMap((e) => [
  `(deny file-write* ${isGlob(e) ? `(regex ${q(globRe(e).source)})` : `(subpath ${q(e)})`})`,
  ...(isGlob(e) ? [startOf(e), ...parents(startOf(e))] : parents(e)).map((p) => `(deny file-write-unlink file-write-create (literal ${q(p)}))`),
])].join('\n'));
const SEATBELT = ['sandbox-exec', '-f', profile];
const seatbelt = spawnSync('sandbox-exec', ['-f', profile, 'true']).status === 0;

test('seatbelt: each attack fails under the generated denyWrite, and the commit works', { skip: !seatbelt && 'sandbox-exec is not available here' }, () => {
  for (const [name, payload, control, after, probe] of ATTACKS) {
    fresh();
    if (payload) assert.equal(sh(payload, SEATBELT).status, 0, `${name}: the sandbox stops the payload`);
    sh(control, SEATBELT);
    if (after) sh(after, SEATBELT); // the whole attack runs in the session
    assert.notEqual(sh(probe).status, 0, `${name}: the attack redirected git under the sandbox`);
  }
  fresh();
  const r = sh(COMMIT, SEATBELT);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ok('git log --format=%s side'), 'three\ntwo\none\n');
});
