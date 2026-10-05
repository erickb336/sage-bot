// T133: the guard hook (scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead (SAGE_ORIGIN=lead).
// Each case feeds the hook a PreToolUse JSON on stdin, as Claude Code does, and reads its decision. Nothing runs: the
// commands are only text. The folders are made in a new scratch folder: a repository with the session's worktree in it,
// a scratch folder, a home folder with a sample .ssh key, and links from the worktree to the home folder.
// SAMPLE DATA ONLY. No real `claude`, gh or git command runs, and no settings file changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORPUS = JSON.parse(readFileSync(new URL('./guard-corpus.json', import.meta.url), 'utf8'));

const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-bot-guard-')));
const F = { REPO: join(base, 'repo'), WT: join(base, 'repo', 'wt'), SCRATCH: join(base, 'scratch'), HOME: join(base, 'home'), TMPDIR: join(base, 'tmp'), TOOL: join(base, 'plugin', 'sage.mjs') };
for (const d of [F.WT, F.SCRATCH, join(F.HOME, '.ssh'), F.TMPDIR, join(base, 'plugin'), join(F.WT, 'src')]) mkdirSync(d, { recursive: true });
writeFileSync(join(F.HOME, '.ssh', 'id_ed25519'), 'SAMPLE, NOT A KEY\n');
writeFileSync(F.TOOL, '// sample sage state tool\n');
writeFileSync(join(F.WT, 'README.md'), 'sample\n');
symlinkSync(join(F.HOME, '.ssh'), join(F.WT, 'link-to-ssh'));
symlinkSync(F.HOME, join(F.WT, 'link-to-home'));

const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => F[k]);
const LEAD = { SAGE_ORIGIN: 'lead', SAGE_WORKTREE: F.WT, SAGE_SCRATCH: F.SCRATCH, SAGE_REPO: F.REPO, SAGE_TOOL: F.TOOL };

/** The hook's decision for one stdin, from its exit code and stdout: { decision: 'allow' | 'deny', reason }. */
function decision({ status, stdout, stderr }) {
  if (status === 2) return { decision: 'deny', reason: stderr.trim() };
  assert.equal(status, 0, stderr);
  if (!stdout.trim()) return { decision: 'allow' };
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}
const envOf = (env) => ({ PATH: process.env.PATH, HOME: F.HOME, TMPDIR: F.TMPDIR, ...env });
const text = (stdin) => (typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
/** Runs the hook once, as Claude Code does: the JSON on stdin. */
const hook = (stdin, env = LEAD) => decision(spawnSync(process.execPath, [HOOK], { input: text(stdin), env: envOf(env), encoding: 'utf8' }));
/** The hook's decisions for many inputs, 16 hook processes at a time. */
async function hooks(inputs, env = LEAD) {
  const one = (stdin) => new Promise((done) => {
    const child = spawn(process.execPath, [HOOK], { env: envOf(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done(decision({ status, stdout, stderr })));
    child.stdin.end(text(stdin));
  });
  const out = [];
  for (let i = 0; i < inputs.length; i += 16) out.push(...await Promise.all(inputs.slice(i, i + 16).map(one)));
  return out;
}
const bash = (command, cwd = F.WT) => ({ session_id: 'aaaaaaaa-0000-4000-8000-000000000133', hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command: fill(command) } });
const tool = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', cwd: F.WT, tool_name, tool_input });

test(`T133: the corpus holds at least 80 commands to refuse (${CORPUS.refuse.length}) and 30 to allow (${CORPUS.allow.length}), each once`, () => {
  assert.ok(CORPUS.refuse.length >= 80 && CORPUS.allow.length >= 30);
  const all = [...CORPUS.refuse, ...CORPUS.allow];
  assert.equal(new Set(all).size, all.length);
});

test('T133: with SAGE_ORIGIN unset or not "lead", the hook allows every corpus command (it is inert)', async () => {
  const all = [...CORPUS.refuse, ...CORPUS.allow];
  const env = { ...LEAD };
  delete env.SAGE_ORIGIN;
  const results = await hooks(all.map((c) => bash(c)), env);
  assert.deepEqual(all.filter((c, i) => results[i].decision !== 'allow'), []);
  for (const origin of ['owner', 'LEAD', '', 'lead ']) assert.equal(hook(bash(CORPUS.refuse[0]), { ...LEAD, SAGE_ORIGIN: origin }).decision, 'allow');
  assert.equal(hook('not json', {}).decision, 'allow');
});

test('T133: in a lead session, every dangerous corpus command is refused, and the refusal says that Erick approves at the terminal', async () => {
  const results = await hooks(CORPUS.refuse.map((c) => bash(c)));
  assert.deepEqual(CORPUS.refuse.filter((c, i) => results[i].decision !== 'deny'), []);
  for (const r of results) assert.match(r.reason, /^sage-bot guard: .* Erick must approve this at the terminal\.$/s);
});

test('T133: in a lead session, every normal developer command of the corpus is allowed', async () => {
  const results = await hooks(CORPUS.allow.map((c) => bash(c)));
  assert.deepEqual(CORPUS.allow.map((c, i) => [c, results[i].reason]).filter(([, why]) => why), []);
});

test('T133: the reason names what is refused', () => {
  assert.equal(hook(bash('gh pr merge 12')).reason, 'sage-bot guard: gh pr merge is refused in a lead session. Erick must approve this at the terminal.');
  assert.equal(hook(bash('git push origin main')).reason, 'sage-bot guard: git push: a push to the protected branch main is refused in a lead session. Erick must approve this at the terminal.');
});

test('T133: a cd changes the folder of the commands after it, also into a folder that is then left', () => {
  assert.equal(hook(bash('cd src && rm -rf ../README.md')).decision, 'allow');
  assert.equal(hook(bash('cd src && rm -rf ../../x')).decision, 'deny');
  assert.equal(hook(bash('rm -rf x', F.HOME)).decision, 'deny');
});

test('T133: the file tools read inside the worktree, the scratch folder and the repository, and write inside the worktree and the scratch folder only', async () => {
  const inside = [
    ['Read', { file_path: join(F.WT, 'README.md') }], ['Read', { file_path: join(F.SCRATCH, 'x.md') }], ['Read', { file_path: join(F.REPO, 'README.md') }],
    ['Read', { file_path: 'README.md' }],
    ['Write', { file_path: join(F.WT, 'src', 'new.js'), content: 'x' }], ['Write', { file_path: join(F.SCRATCH, 'r1', 'a.txt'), content: 'x' }],
    ['Edit', { file_path: join(F.WT, 'README.md'), old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: join(F.WT, 'README.md'), edits: [] }],
    ['Glob', { pattern: 'src/**/*.js' }], ['Grep', { pattern: 'guard', path: F.WT }],
    ['WebFetch', { url: 'https://nodejs.org/api/fs.html', prompt: 'x' }], ['TodoWrite', { todos: [] }], ['Agent', { prompt: 'x' }],
  ];
  const outside = [
    ['Read', { file_path: join(F.HOME, '.ssh', 'id_ed25519') }], ['Read', { file_path: join(F.WT, '..', '..', 'home', 'x') }],
    ['Read', { file_path: join(F.WT, '.env') }], ['Read', { file_path: join(F.WT, 'config', '.Env.production') }],
    ['Write', { file_path: join(F.REPO, 'README.md'), content: 'x' }], ['Write', { file_path: join(F.HOME, '.claude', 'settings.json'), content: '{}' }],
    ['Write', { file_path: join(F.WT, '.claude', 'settings.local.json'), content: '{}' }], ['Write', { file_path: join(F.WT, '.mcp.json'), content: '{}' }],
    ['Write', { file_path: join(F.SCRATCH, 'sage-hooks', 'x.json'), content: '{}' }], ['Write', { file_path: join(F.TMPDIR, 'sage-hooks', 'x.json'), content: '{}' }],
    ['Write', { file_path: join(F.HOME, '.config', 'sage-bot', 'lead.log'), content: 'x' }],
    ['Edit', { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }], ['NotebookEdit', { notebook_path: join(F.HOME, 'n.ipynb') }],
    ['Glob', { pattern: '/Users/*/.ssh/*' }], ['Glob', { pattern: '../../**' }], ['Glob', { pattern: '**/*', path: F.HOME }], ['Grep', { pattern: 'x', path: '/' }],
    ['WebFetch', { url: 'file:///etc/passwd', prompt: 'x' }],
    ['mcp__plugin_discord_discord__reply', { text: 'x' }], ['Monitor', { command: 'gh pr merge 12' }], ['BashOutput', {}],
  ];
  const [a, b] = [await hooks(inside.map(([n, i]) => tool(n, i))), await hooks(outside.map(([n, i]) => tool(n, i)))];
  assert.deepEqual(inside.filter((x, k) => a[k].decision !== 'allow'), []);
  assert.deepEqual(outside.filter((x, k) => b[k].decision !== 'deny').map(([n, i]) => `${n} ${JSON.stringify(i)}`), []);
});

test('T133: a symbolic link in the worktree that points outside is refused, for reads and for writes', () => {
  assert.equal(hook(tool('Read', { file_path: join(F.WT, 'link-to-ssh', 'id_ed25519') })).decision, 'deny');
  assert.equal(hook(tool('Read', { file_path: join(F.WT, 'link-to-home', 'notes.txt') })).decision, 'deny');
  assert.equal(hook(tool('Write', { file_path: join(F.WT, 'link-to-home', 'new.txt'), content: 'x' })).decision, 'deny');
  assert.equal(hook(tool('Write', { file_path: `${F.WT}/link-to-home/../x.txt`, content: 'x' })).decision, 'deny');
});

test('T133: the hook never lets a tool write its own files, also when the worktree holds them', () => {
  const env = { ...LEAD, SAGE_WORKTREE: ROOT };
  assert.equal(hook(tool('Write', { file_path: HOOK, content: '' }), env).decision, 'deny');
  assert.equal(hook(tool('Edit', { file_path: join(ROOT, 'src', 'guard.js'), old_string: 'a', new_string: 'b' }), env).decision, 'deny');
  assert.equal(hook(tool('Edit', { file_path: join(ROOT, 'src', 'vote.js'), old_string: 'a', new_string: 'b' }), env).decision, 'allow');
});

test('T133: a malformed stdin, a missing field, or missing folders refuse in a lead session (fail closed)', () => {
  for (const stdin of ['', 'not json', '[]', 'null', '{"tool_name":"Bash"}', JSON.stringify(tool('Write', {})), JSON.stringify(tool('Bash', { command: 42 }))]) {
    assert.equal(hook(stdin).decision, 'deny', stdin);
  }
  for (const env of [{ SAGE_ORIGIN: 'lead' }, { ...LEAD, SAGE_WORKTREE: join(base, 'nowhere') }, { ...LEAD, SAGE_SCRATCH: 'relative' }, { ...LEAD, SAGE_WORKTREE: '/' }]) {
    assert.equal(hook(bash('git status'), env).decision, 'deny', JSON.stringify(env));
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
