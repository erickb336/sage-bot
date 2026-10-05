// T133: the guard hook (scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead (SAGE_ORIGIN=lead).
// The corpus cases go through decideText(), the function that the hook calls with its stdin; the hook's own protocol
// (stdout JSON, exit codes, the size limit, a crash) is tested by feeding the real hook JSON on stdin, as Claude Code does.
// Nothing runs: the commands are only text. The folders are made in a new scratch folder: a repository with the session's
// worktree in it, a scratch folder with sample projects, and a home folder with a sample .ssh key.
// SAMPLE DATA ONLY. No real `claude`, gh or git command runs, and no settings file changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideText } from '../src/guard.js';

const HOOK = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORPUS = JSON.parse(readFileSync(new URL('./guard-corpus.json', import.meta.url), 'utf8'));

const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-bot-guard-')));
const F = { REPO: join(base, 'repo'), WT: join(base, 'repo', 'wt'), SCRATCH: join(base, 'scratch'), HOME: join(base, 'home'), TMPDIR: join(base, 'tmp'), TOOL: join(base, 'plugin', 'sage.mjs') };
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
for (const d of [join(F.WT, 'src'), F.TMPDIR]) mkdirSync(d, { recursive: true });
put(join(F.HOME, '.ssh', 'id_ed25519'), 'SAMPLE, NOT A KEY\n');
put(F.TOOL, '// sample sage state tool\n');
put(join(F.REPO, '.git', 'config'), '[remote "origin"]\n\turl = https://SAMPLE-NOT-A-TOKEN@example.com/r.git\n');
put(join(F.WT, '.git'), `gitdir: ${F.REPO}/.git/worktrees/wt\n`);
put(join(F.WT, 'README.md'), 'sample\n');
// An agent's worktree in scratch with a sample .env, one with none, a folder with a file named HEAD, links out.
put(join(F.SCRATCH, 'proj', '.git'), 'gitdir: x\n');
put(join(F.SCRATCH, 'proj', 'config', '.env'), 'TOKEN=SAMPLE\n');
put(join(F.SCRATCH, 'proj', 'config', '.env.template'), 'TOKEN=\n');
put(join(F.SCRATCH, 'proj', 'src', 'a.js'), '// sample\n');
put(join(F.SCRATCH, 'clean', '.git'), 'gitdir: x\n');
put(join(F.SCRATCH, 'clean', 'src', 'a.js'), '// sample\n');
put(join(F.SCRATCH, 'clean', 'node_modules', 'pkg', 'credentials.js'), '// a package file\n');
put(join(F.SCRATCH, 'bare', 'HEAD'), 'ref: refs/heads/x\n');
mkdirSync(join(F.SCRATCH, 'links'));
symlinkSync(join(F.HOME, '.ssh'), join(F.SCRATCH, 'links', 'link-to-ssh'));
symlinkSync(F.HOME, join(F.SCRATCH, 'links', 'link-to-home'));

const fill = (v) => JSON.parse(JSON.stringify(v).replace(/\{(\w+)\}/g, (m, k) => F[k] ?? m));
const LEAD = { SAGE_ORIGIN: 'lead', SAGE_WORKTREE: F.WT, SAGE_SCRATCH: F.SCRATCH, SAGE_REPO: F.REPO, SAGE_TOOL: F.TOOL, SAGE_BRANCH: 't133-guard', HOME: F.HOME };
const text = (stdin) => (typeof stdin === 'string' ? stdin : JSON.stringify(stdin));

/** The guard's decision for one stdin, as the hook gives it: a throw is a crash, and the hook refuses then (exit code 2). */
function guard(stdin, env = LEAD) {
  try {
    const reason = decideText(text(stdin), env);
    return reason ? { decision: 'deny', reason } : { decision: 'allow' };
  } catch (e) {
    return { decision: 'deny', reason: `a crash: ${e.message}` };
  }
}
/** Runs the real hook once, as Claude Code does: the JSON on stdin. Gives the decision and the time it took. */
function hook(stdin, env = LEAD) {
  const t = Date.now();
  const { status, stdout, stderr } = spawnSync(process.execPath, [HOOK], { input: text(stdin), env: { PATH: process.env.PATH, TMPDIR: F.TMPDIR, ...env }, encoding: 'utf8' });
  const ms = Date.now() - t;
  if (status === 2) return { decision: 'deny', reason: stderr.trim(), status, ms };
  assert.equal(status, 0, stderr);
  if (!stdout.trim()) return { decision: 'allow', status, ms };
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, status, ms };
}
const bash = (command, cwd = F.WT) => ({ session_id: 'aaaaaaaa-0000-4000-8000-000000000133', hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: fill(command) } });
const tool = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', cwd: F.WT, tool_name, tool_input: fill(tool_input) });
const MESSAGE = /^sage-bot guard: .+ is refused in a lead session\. (Erick must approve this at the terminal\.|sage can do this instead: .+\.)$/s;

test(`T133: the corpus holds Bash commands to refuse (${CORPUS.refuse.length}) and to allow (${CORPUS.allow.length}), each once, and tool calls (${CORPUS.tools.refuse.length} and ${CORPUS.tools.allow.length})`, () => {
  assert.ok(CORPUS.refuse.length >= 300 && CORPUS.allow.length >= 80 && CORPUS.tools.refuse.length >= 60 && CORPUS.tools.allow.length >= 35);
  const all = [...CORPUS.refuse, ...CORPUS.allow];
  assert.equal(new Set(all).size, all.length);
});

test('T133: with SAGE_ORIGIN unset or not "lead", the guard allows every corpus case (it is inert)', () => {
  const env = { ...LEAD };
  delete env.SAGE_ORIGIN;
  const all = [...CORPUS.refuse.map((c) => bash(c)), ...CORPUS.tools.refuse.map(([n, i]) => tool(n, i))];
  assert.deepEqual(all.filter((x) => guard(x, env).decision !== 'allow'), []);
  for (const origin of ['owner', 'LEAD', '', 'lead ']) assert.equal(hook(bash(CORPUS.refuse[0]), { ...LEAD, SAGE_ORIGIN: origin }).decision, 'allow');
  assert.equal(hook('not json', {}).decision, 'allow');
  assert.equal(hook('x'.repeat(100_000), {}).decision, 'allow');
});

test('T133: in a lead session, every dangerous Bash command of the corpus is refused, and the refusal says how to rephrase or that Erick approves', () => {
  const results = CORPUS.refuse.map((c) => [c, guard(bash(c))]);
  assert.deepEqual(results.filter(([, r]) => r.decision !== 'deny').map(([c]) => c), []);
  assert.deepEqual(results.filter(([, r]) => !MESSAGE.test(r.reason)).map(([c, r]) => [c, r.reason]), []);
});

test('T133: in a lead session, every normal developer command of the corpus is allowed', () => {
  assert.deepEqual(CORPUS.allow.map((c) => [c, guard(bash(c)).reason]).filter(([, why]) => why), []);
});

test('T133: the other tools: every corpus call to refuse is refused, every call to allow is allowed', () => {
  assert.deepEqual(CORPUS.tools.refuse.filter(([n, i]) => guard(tool(n, i)).decision !== 'deny').map((x) => JSON.stringify(x)), []);
  assert.deepEqual(CORPUS.tools.allow.map(([n, i]) => [n, i, guard(tool(n, i)).reason]).filter(([, , why]) => why), []);
});

test('T133: the reason names what is refused, and says how to rephrase when a safe form exists', () => {
  const why = (c) => guard(bash(c)).reason;
  assert.equal(why('gh pr merge 12'), 'sage-bot guard: gh pr merge is refused in a lead session. Erick must approve this at the terminal.');
  assert.equal(why('git push origin main'), "sage-bot guard: git push to anything but origin t133-guard, the session's own branch is refused in a lead session. sage can do this instead: git push origin t133-guard.");
  assert.match(why('git push --forc origin t133-guard'), /git push with the option --forc is refused .* instead: git push origin t133-guard\.$/);
  assert.match(why('git push'), /sage can do this instead: git push origin t133-guard\.$/);
  // The usual commit form, a heredoc in $( ), stays refused, and the message says how to give the text instead.
  assert.match(why("git commit -m \"$(cat <<'EOF'\nT133\nEOF\n)\""), /cannot read \(a \$ inside double quotes\) is refused .* sage can do this instead: .*put long or special text in a file in the scratch folder and pass it with git commit -F <file> or gh pr create --body-file <file>\.$/s);
  assert.match(why('HOME={SCRATCH} git status'), /a variable in front of git \(git reads its config from HOME\) is refused .* instead: run git with no variable in front of it\.$/);
  assert.match(why('git checkout x && ls'), /git checkout with another command after it .* instead: run it as a call of its own, then the rest\.$/);
  assert.match(why('cat {SCRATCH}/proj/config/*'), /it holds \.env, .* instead: name a folder or the files without it, or use the Grep tool with a glob such as \*\*\/\*\.js\.$/);
  // Each option must be an entry of the command's table by its full spelling; the message lists the entries.
  assert.equal(why('grep --recur token {SCRATCH}/proj'), 'sage-bot guard: grep with the option --recur is refused in a lead session. sage can do this instead: give grep only the options -n -i -in -l -c -v -w -o -h -H -E -F -q -s -x -e -A -B -C -m --, each one spelled in full and alone.');
  assert.match(why('grep token {SCRATCH}/proj'), /proj as an operand \(a folder: this command takes files only\) is refused .* instead: name the files, or search a folder with the Grep tool\.$/);
  assert.match(why('rg token'), /rg with no file, .* instead: name existing files, or search a folder with the Grep tool\.$/);
  assert.match(why('git add -A'), /git add without -- and file names .* instead: git add -- <file> <file>, each file by its full name \(git rm -- <file> for a deleted file\)\.$/);
  assert.match(why("git add -- 'src/*'"), /git add of src\/\* \(git reads it as a pattern\) is refused .* instead: git add -- <file> <file>/);
  assert.match(why('cd nowhere && ls'), /cd nowhere \(not an existing folder\) is refused .* instead: cd <a folder in the worktree or the scratch folder> && <command>, or name the full path in the command\.$/);
  assert.match(why('cd src ; ls'), /cannot read \(the operator ; \(only && joins parts\)\) is refused .* instead: one command per call, or commands joined only by && /);
  assert.match(why('ls | sh'), /a \| into sh is refused .* instead: pipe only into head, tail, wc, sort or grep, or run the commands one by one\.$/);
  assert.match(why('git fetch upstream'), /instead: git fetch origin\.$/);
  assert.match(why('gh pr edit 12 --body-file {WT}/README.md'), /instead: write the body to a file in the scratch folder and pass it with --body-file\.$/);
  assert.match(why('gh pr edit 12 --base main'), /gh pr edit with the option --base .* instead: gh pr edit <number> --title <title> --body-file <file in the scratch folder>\.$/);
  assert.match(why('node {TOOL} gate answer G1 yes'), /the sage state tool command gate answer \(only status, logbook, merge-check, standing, task, run, finding and verdict\) is refused .* Erick must approve/);
});

test('T133: a push needs SAGE_BRANCH, and never goes to a protected branch, also when SAGE_BRANCH names one', () => {
  const none = { ...LEAD };
  delete none.SAGE_BRANCH;
  assert.match(guard(bash('git push origin t133-guard'), none).reason, /git push \(the session has no branch of its own in SAGE_BRANCH\)/);
  assert.equal(guard(bash('git push origin main'), { ...LEAD, SAGE_BRANCH: 'main' }).decision, 'deny');
  assert.equal(guard(bash('git push origin main'), { ...LEAD, SAGE_BRANCH: 'Release-1' }).decision, 'deny');
  assert.equal(guard(bash('git push origin x'), { ...LEAD, SAGE_BRANCH: 'x' }).decision, 'allow');
  // SAGE_BRANCH is compared word for word: a value with + or : would be a forced or a renamed upload.
  for (const branch of ['+feature', 'x:main', 'x;y']) assert.equal(guard(bash(`git push origin ${branch}`), { ...LEAD, SAGE_BRANCH: branch }).decision, 'deny', branch);
});

test('T133: a cd changes the folder of the commands after it, also into a folder that is then left', () => {
  assert.equal(guard(bash('cd src && rm -rf ../README.md')).decision, 'allow');
  assert.equal(guard(bash('cd src && rm -rf ../../x')).decision, 'deny');
  assert.equal(guard(bash('rm -rf x', F.HOME)).decision, 'deny');
});

test('T133: the guard never lets a tool write its own files, also when the worktree holds them', () => {
  const env = { ...LEAD, SAGE_WORKTREE: ROOT };
  assert.equal(guard(tool('Write', { file_path: HOOK, content: '' }), env).decision, 'deny');
  assert.equal(guard(tool('Edit', { file_path: join(ROOT, 'src', 'guard.js'), old_string: 'a', new_string: 'b' }), env).decision, 'deny');
  assert.equal(guard(tool('Edit', { file_path: join(ROOT, 'src', 'vote.js'), old_string: 'a', new_string: 'b' }), env).decision, 'allow');
});

test('T133: the hook answers allow with no output and deny with the PreToolUse JSON; a malformed stdin, a field of the wrong type or missing folders refuse (fail closed)', () => {
  const allowed = hook(bash('git status'));
  assert.deepEqual([allowed.decision, allowed.status, allowed.reason], ['allow', 0, undefined]);
  assert.match(hook(bash('gh pr merge 12')).reason, /^sage-bot guard: gh pr merge is refused/);
  for (const stdin of ['', 'not json', '[]', 'null', '{"tool_name":"Bash"}', JSON.stringify(tool('Write', {})), JSON.stringify(tool('Read', { file_path: 42 })), JSON.stringify(tool('Bash', { command: 42 })), JSON.stringify(tool('Skill', 'x')), JSON.stringify({ tool_name: 'Skill' })]) {
    assert.equal(hook(stdin).decision, 'deny', stdin);
  }
  for (const env of [{ SAGE_ORIGIN: 'lead' }, { ...LEAD, SAGE_WORKTREE: join(base, 'nowhere') }, { ...LEAD, SAGE_SCRATCH: 'relative' }, { ...LEAD, SAGE_WORKTREE: '/' }]) {
    assert.equal(guard(bash('git status'), env).reason, 'sage-bot guard: every tool (SAGE_WORKTREE or SAGE_SCRATCH is not an existing folder) is refused in a lead session. Erick must approve this at the terminal.', JSON.stringify(env));
  }
});

test('T133: an input over 64 KB is refused before it is parsed, quickly; a large input under the limit is decided quickly too', () => {
  const over = JSON.stringify(bash(`echo ${'a'.repeat(64 * 1024)}`));
  const r = hook(over);
  assert.match(r.reason, /a tool call over 64 KB is refused .* instead: write long text to a file in the scratch folder/);
  assert.ok(r.ms < 3000, `${r.ms} ms`);
  const huge = hook(JSON.stringify(bash(`echo ${'a '.repeat(2_800_000)}`)));
  assert.equal(huge.decision, 'deny');
  assert.ok(huge.ms < 3000, `${huge.ms} ms for 5.6 MB`);
  // Just under the limit: the parser reads it in linear time.
  const fill64 = (s) => { const b = JSON.stringify(bash('echo ')).length; return `echo ${s.repeat(Math.floor((64 * 1024 - b - 10) / s.length))}`; };
  for (const command of [fill64('a '), fill64("'a'"), fill64('x;')]) {
    const input = JSON.stringify(bash(command));
    assert.ok(input.length <= 64 * 1024, `${input.length}`);
    const t = Date.now();
    guard(input);
    assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
  }
  assert.equal(guard(`${JSON.stringify(bash('git status'))}${' '.repeat(64 * 1024 - JSON.stringify(bash('git status')).length)}`).decision, 'allow');
  assert.equal(guard(`${JSON.stringify(bash('git status'))}${' '.repeat(64 * 1024 - JSON.stringify(bash('git status')).length + 1)}`).decision, 'deny');
});

// GUARD_TEST_WALK: a folder with big/ (20001 empty files) and half/ (10001), that the mutation check makes once for every run.
const WALK = process.env.GUARD_TEST_WALK ?? join(F.SCRATCH, 'walk');
if (!process.env.GUARD_TEST_WALK) {
  for (const [name, n] of [['big', 20001], ['half', 10001]]) {
    mkdirSync(join(WALK, name), { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(WALK, name, `f${i}.txt`), '');
  }
}

test('T133: a folder walk stops after 20000 entries and refuses, quickly', () => {
  const big = join(WALK, 'big');
  const t = Date.now();
  assert.match(guard(tool('Grep', { pattern: 'x', path: big }), { ...LEAD, SAGE_REPO: WALK }).reason, /more than 20000 files to check in one call/);
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
  assert.equal(guard(tool('Grep', { pattern: 'x', path: join(F.SCRATCH, 'clean') })).decision, 'allow');
});

test('T133: all the walks of one call share one budget: a 64 KB call that names a large folder many times is refused in under 3 s', () => {
  const half = join(WALK, 'half');
  const env = { ...LEAD, SAGE_SCRATCH: WALK };
  // One walk of 10001 entries is in the budget; a second walk in the same call is not.
  assert.equal(guard(bash(`cat ${half}/f1*`), env).decision, 'allow');
  assert.match(guard(bash(`cat ${half}/f1* ${half}/f2*`), env).reason, /more than 20000 files to check in one call/);
  assert.equal(guard(tool('Grep', { pattern: 'x', path: half }), env).decision, 'allow');
  // Just under 64 KB: the same folder named about 1000 times, as a wildcard, as a folder operand and as a copy.
  const fill = (word, tail = '') => { const b = JSON.stringify(bash(tail)).length; return `${word.repeat(Math.floor((64 * 1024 - b - 10) / word.length))}${tail}`; };
  for (const command of [`cat ${fill(`${half}/f1* `)}`, `grep x ${fill(`${half} `)}`, `rg x ${fill(`${half} `)}`, `cp -r ${fill(`${half} `, WALK)}`]) {
    const input = bash(command);
    assert.ok(JSON.stringify(input).length <= 64 * 1024, `${JSON.stringify(input).length}`);
    const r = hook(input, env);
    assert.equal(r.decision, 'deny', command.slice(0, 80));
    assert.ok(r.ms < 3000, `${r.ms} ms for ${command.slice(0, 40)}`);
    // In the process, with no start of node: the checks stop at the first refusal, so no later folder is read at all.
    const t = Date.now();
    assert.equal(guard(input, env).decision, 'deny');
    assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms in the process for ${command.slice(0, 40)}`);
  }
});

test('T133: a crash of the hook refuses in a lead session (exit code 2)', () => {
  // The rules module throws on load: a copy of the hook next to a broken src/guard.js.
  const dir = mkdtempSync(join(base, 'broken-'));
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'scripts', 'guard.mjs'), readFileSync(HOOK));
  writeFileSync(join(dir, 'src', 'guard.js'), 'throw new Error("sample crash");\n');
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'guard.mjs')], { input: JSON.stringify(bash('git status')), env: { PATH: process.env.PATH, ...LEAD }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused, the guard could not decide \(sample crash\)\. Erick must approve this at the terminal\./);
  const inert = spawnSync(process.execPath, [join(dir, 'scripts', 'guard.mjs')], { input: '{}', env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.deepEqual([inert.status, inert.stdout], [0, '']);
});
