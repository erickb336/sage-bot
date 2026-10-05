// T133: the guard hook (scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead (SAGE_ORIGIN=lead).
// The corpus cases go through decideText(), the function that the hook calls with its stdin; the hook's own protocol
// (stdout JSON, exit codes, the size limit, a crash) is tested by feeding the real hook JSON on stdin, as Claude Code does.
// Nothing runs: the commands are only text, and the paths in them are sample paths that do not exist. The guard reads no
// file; the tests make one scratch folder for the hook's stdin files and the crash test.
// SAMPLE DATA ONLY. No real `claude`, gh or git command runs, and no settings file changes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideText } from '../src/guard.js';

const HOOK = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));
const CORPUS = JSON.parse(readFileSync(new URL('./guard-corpus.json', import.meta.url), 'utf8'));

// Sample paths. The state tool has a name other than sage.mjs here, so that SAGE_TOOL itself is tested; a corpus case runs
// a copy named sage.mjs.
const F = { REPO: '/sample/repo', WT: '/sample/repo/wt', SCRATCH: '/sample/scratch', HOME: '/sample/home', TMPDIR: '/sample/tmp', TOOL: '/sample/plugin/state.mjs' };
const fill = (v) => JSON.parse(JSON.stringify(v).replace(/\{(\w+)\}/g, (m, k) => F[k] ?? m));
const LEAD = { SAGE_ORIGIN: 'lead', SAGE_TOOL: F.TOOL };
const text = (stdin) => (typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
const base = mkdtempSync(join(tmpdir(), 'sage-bot-guard-'));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
/**
 * Runs `node file` with `stdin` from a file. (With spawnSync's `input`, Node 26 under load sometimes never closed the pipe,
 * and the hook then waited for the end of its stdin forever. Claude Code closes it.)
 */
function run(file, stdin, env) {
  const path = join(base, `stdin-${n++}`);
  writeFileSync(path, stdin);
  const fd = openSync(path, 'r');
  try { return spawnSync(process.execPath, [file], { stdio: [fd, 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }); } finally { closeSync(fd); }
}

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
  const { status, stdout, stderr } = run(HOOK, text(stdin), env);
  const ms = Date.now() - t;
  if (status === 2) return { decision: 'deny', reason: stderr.trim(), status, ms };
  assert.equal(status, 0, stderr);
  if (!stdout.trim()) return { decision: 'allow', status, ms };
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, status, ms };
}
const tool = (tool_name, tool_input) => ({ session_id: 'aaaaaaaa-0000-4000-8000-000000000133', hook_event_name: 'PreToolUse', cwd: F.WT, tool_name, tool_input: fill(tool_input) });
const bash = (command) => tool('Bash', { command });
const MESSAGE = /^sage-bot guard: .+ is refused in a lead session\. (sage can do this instead: .+\.|This needs Erick; tell the sage-lead and stop this action\.)$/s;
const STATE = 'sage-bot guard: a call that may name the sage state tool (a lead session reaches the logbook only through sage-bot) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.';
const STOP = 'This needs Erick; tell the sage-lead and stop this action.';
const WILDCARD = 'sage can do this instead: name each file in full instead of a wildcard (for the tests: npm test, or node --test <file>).';
const BROKER = "sage can do this instead: sage-bot-github, the GitHub broker of step 6, for a fetch, an upload to the session's own branch and the session's own pull request (create, edit, view).";

test(`T133: the corpus holds Bash commands to refuse (${CORPUS.refuse.length}), for the broker (${CORPUS.broker.length}), to allow (${CORPUS.allow.length}), for the sandbox (${CORPUS.sandbox.length}), of the state tool (${CORPUS.state.length}) and of wildcards (${CORPUS.wildcard.length}), each once`, () => {
  assert.ok(CORPUS.refuse.length >= 250 && CORPUS.broker.length >= 50 && CORPUS.allow.length >= 80 && CORPUS.state.length >= 70 && CORPUS.wildcard.length >= 20 && CORPUS.tools.refuse.length >= 80 && CORPUS.tools.allow.length >= 45 && CORPUS.tools.state.length >= 6 && CORPUS.session.length >= 15);
  const all = [...CORPUS.refuse, ...CORPUS.broker, ...CORPUS.allow, ...CORPUS.sandbox, ...CORPUS.state, ...CORPUS.wildcard];
  assert.equal(new Set(all).size, all.length);
});

test('T133: with SAGE_ORIGIN unset or not "lead", the guard allows every corpus case (it is inert)', () => {
  const env = { ...LEAD };
  delete env.SAGE_ORIGIN;
  const all = [...CORPUS.refuse, ...CORPUS.broker, ...CORPUS.state, ...CORPUS.wildcard].map((c) => bash(c)).concat([...CORPUS.tools.refuse, ...CORPUS.tools.state].map(([n, i]) => tool(n, i)));
  assert.deepEqual(all.filter((x) => guard(x, env).decision !== 'allow'), []);
  for (const origin of ['owner', 'LEAD', '', 'lead ']) assert.equal(hook(bash(CORPUS.refuse[0]), { ...LEAD, SAGE_ORIGIN: origin }).decision, 'allow');
  assert.equal(hook('not json', {}).decision, 'allow');
  assert.equal(hook('x'.repeat(100_000), {}).decision, 'allow');
});

test('T133: in a lead session, every Bash command of the corpus that is not on the allow-list is refused, and the refusal says how to rephrase or that Erick approves', () => {
  const results = CORPUS.refuse.map((c) => [c, guard(bash(c))]);
  assert.deepEqual(results.filter(([, r]) => r.decision !== 'deny').map(([c]) => c), []);
  assert.deepEqual(results.filter(([, r]) => !MESSAGE.test(r.reason)).map(([c, r]) => [c, r.reason]), []);
});

test('T133: gh, git push and git fetch are refused with the hint to the broker, sage-bot-github', () => {
  assert.deepEqual(CORPUS.broker.map((c) => [c, guard(bash(c)).reason]).filter(([, why]) => !why?.endsWith(BROKER)), []);
  assert.equal(guard(bash('gh pr merge 12')).reason, `sage-bot guard: gh is refused in a lead session. ${BROKER}`);
});

test('T133: the sage state tool is refused in every form, with the stop ending (G30 A): its path, sage.mjs in any case or quoting, a variable in front, env, --, a wildcard, a copy, a script that imports it', () => {
  assert.deepEqual(CORPUS.state.map((c) => [c, guard(bash(c)).reason]).filter(([, why]) => why !== STATE), []);
  assert.deepEqual(CORPUS.tools.state.map(([n, i]) => [n, i, guard(tool(n, i)).reason]).filter(([, , why]) => why !== STATE), []);
  // The real hook gives the same message.
  assert.equal(hook(bash('node {TOOL} standing --project=x add y')).reason, STATE);
  // Another name that only ends like it, and a read with a wildcard, are not the state tool.
  assert.equal(guard(bash('node {SCRATCH}/message.mjs')).decision, 'allow');
  assert.equal(guard(bash('ls {SCRATCH}/copy/*')).decision, 'allow');
});

test('T133 (G44 A): a wildcard in a part that runs or writes that may match the state tool, and any [ there, are refused with the hint to name the files', () => {
  assert.deepEqual(CORPUS.wildcard.map((c) => [c, guard(bash(c)).reason]).filter(([, why]) => !why?.endsWith(WILDCARD)), []);
  assert.equal(guard(bash('git add scripts/*.mjs')).reason, `sage-bot guard: the wildcard scripts/*.mjs (it can match the sage state tool) is refused in a lead session. ${WILDCARD}`);
  assert.equal(guard(bash('cp {SCRATCH}/[ab].txt {SCRATCH}/c.txt')).reason, `sage-bot guard: the wildcard [ in /sample/scratch/[ab].txt (in a part that runs or writes) is refused in a lead session. ${WILDCARD}`);
  // A quoted [ is no wildcard, and a wildcard that cannot match the name passes.
  for (const c of ["git commit -m '[T133] x'", 'node --test {WT}/test/*.test.js', 'cp {SCRATCH}/*.txt {SCRATCH}/out', 'cp {SCRATCH}/a?.json {SCRATCH}/out']) assert.equal(guard(bash(c)).reason, undefined, c);
});

test('T133 (G44 A): in a part that runs or writes, and in a file tool path, a character that is not printable ASCII is refused with the stop ending', () => {
  const ascii = `sage-bot guard: a character that is not printable ASCII in a part that runs or writes is refused in a lead session. ${STOP}`;
  for (const c of ['cp "{SCRATCH}/caf\u00e9.txt" {SCRATCH}/x.txt', 'node "{SCRATCH}/x\u200b.mjs"', 'echo x > "{SCRATCH}/\u00e9.txt"', 'ls | tee "{SCRATCH}/\u00e9.txt"', 'git commit -m "x\ty"', 'git commit -m "a\nb"']) {
    assert.equal(guard(bash(c)).reason, ascii, c);
  }
  const path = `sage-bot guard: a file path with a character that is not printable ASCII is refused in a lead session. ${STOP}`;
  assert.equal(guard(tool('Write', { file_path: '{WT}/caf\u00e9.md', content: 'x' })).reason, path);
  assert.equal(guard(tool('NotebookEdit', { notebook_path: '{WT}/\u00e9.ipynb', new_source: 'x' })).reason, path);
  // A read runs nothing, and a file's text may hold any character.
  assert.equal(guard(bash('cat "{SCRATCH}/caf\u00e9.txt"')).decision, 'allow');
  assert.equal(guard(tool('Write', { file_path: '{WT}/notes.md', content: 'caf\u00e9 \u2014 x\n' })).decision, 'allow');
});

test('T133 (G44 A): every code point that folds to a letter of the name (NFKC, then lower case) still names the state tool in a file tool text', () => {
  const letters = new Set('sagemj');
  const found = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const forms = [ch.normalize('NFKC'), ch.toLowerCase(), ch.toUpperCase()].map((f) => f.toLowerCase());
    const letter = forms.find((f) => letters.has(f));
    if (letter) found.push([ch, 'sage.mjs'.replace(letter, ch)]);
  }
  // The long s (U+017F) and the full-width s are among them; each one is refused.
  assert.ok(found.some(([ch]) => ch === '\u017f') && found.some(([ch]) => ch === '\uff53') && found.length > 20, `${found.length}`);
  assert.deepEqual(found.filter(([, name]) => guard(tool('Write', { file_path: '{WT}/x.mjs', content: `import './${name}';` })).reason !== STATE), []);
});

test('T133 (G44 A): node never reads its script from stdin, and a broken input refuses with the stop ending', () => {
  const stdin = `sage-bot guard: node with no script file (code from stdin) is refused in a lead session. ${STOP}`;
  assert.equal(guard(bash('node - status < {SCRATCH}/x.mjs')).reason, stdin);
  assert.equal(guard(bash('node --test -')).reason, stdin);
  assert.equal(guard(bash('node {SCRATCH}/x.mjs -')).decision, 'allow');
  for (const input of [{}, { command: 42 }, { command: null }]) assert.equal(guard(tool('Bash', input)).reason, `sage-bot guard: a Bash call with no command text is refused in a lead session. ${STOP}`);
  for (const name of ['Agent', 'Write', 'Bash']) assert.equal(guard(tool(name, [])).reason, `sage-bot guard: a hook input that is not a tool call is refused in a lead session. ${STOP}`);
});

test('T133: an Agent or Task call with an isolation field is refused; one without it is allowed', () => {
  for (const name of ['Agent', 'Task']) {
    for (const isolation of ['remote', 'worktree']) {
      assert.equal(guard(tool(name, { prompt: 'x', isolation })).reason, `sage-bot guard: an agent with the isolation "${isolation}" is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.`);
    }
    assert.equal(guard(tool(name, { prompt: 'x' })).decision, 'allow');
  }
});

test('T133: WebFetch reaches only a global unicast address: each special-purpose range, multicast, 240/4, the broadcast address and IPv6 outside 2000::/3 are refused', () => {
  const fetch = (host) => guard(tool('WebFetch', { url: `https://${host}/`, prompt: 'x' })).reason ?? null;
  for (const host of ['198.18.0.1', '198.19.255.254', '192.0.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '0.1.2.3']) {
    assert.equal(fetch(host), `sage-bot guard: a fetch of ${host} (not a global unicast address) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.`);
  }
  for (const host of ['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '2001:db8::1', '2002:a00:1::1', '64:ff9b::7f00:1', '100::1']) assert.match(fetch(`[${host}]`), /\(not a global unicast address\)/, host);
  assert.equal(fetch('[::ffff:127.0.0.1]'), 'sage-bot guard: a fetch of ::ffff:7f00:1 (not a global unicast address) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  for (const host of ['8.8.8.8', '198.20.0.1', '223.255.254.1', '[2606:4700:4700::1111]', 'example.com']) assert.equal(fetch(host), null, host);
});

test('T133: in a lead session, every normal developer command of the corpus is allowed', () => {
  assert.deepEqual(CORPUS.allow.map((c) => [c, guard(bash(c)).reason]).filter(([, why]) => why), []);
});

test('T133: the guard reads no path: the commands and tool calls whose files and hosts the sandbox of step 6 holds are allowed', () => {
  assert.deepEqual(CORPUS.sandbox.map((c) => [c, guard(bash(c)).reason]).filter(([, why]) => why), []);
  assert.deepEqual(CORPUS.tools.sandbox.map(([n, i]) => [n, i, guard(tool(n, i)).reason]).filter(([, , why]) => why), []);
});

test('T133: the other tools: every corpus call to refuse is refused, every call to allow is allowed', () => {
  assert.deepEqual(CORPUS.tools.refuse.filter(([n, i]) => !MESSAGE.test(guard(tool(n, i)).reason)).map((x) => JSON.stringify(x)), []);
  assert.deepEqual(CORPUS.tools.allow.map(([n, i]) => [n, i, guard(tool(n, i)).reason]).filter(([, , why]) => why), []);
});

test('T133: a realistic sage session in a worktree under the scratch folder is allowed from start to end', () => {
  assert.deepEqual(CORPUS.session.map(([n, i]) => [n, i, guard(tool(n, i)).reason]).filter(([, , why]) => why), []);
});

test('T133: the reason names what is refused, and says how to rephrase when a safe form exists', () => {
  const why = (c) => guard(bash(c)).reason;
  // The usual commit form, a heredoc in $( ), stays refused, and the message says how to give the text instead.
  assert.match(why("git commit -m \"$(cat <<'EOF'\nT133\nEOF\n)\""), /cannot read \(a \$ inside double quotes\) is refused .* sage can do this instead: .*put long or special text in a file in the scratch folder and pass it with git commit -F <file>\.$/s);
  assert.equal(why('HOME={SCRATCH} git status'), 'sage-bot guard: a variable in front of git (git reads its config from HOME) is refused in a lead session. sage can do this instead: run git with no variable in front of it.');
  assert.equal(why('GH_TOKEN=x ls'), 'sage-bot guard: setting GH_TOKEN in front of a command is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  // Each option must be an entry of the command's table by its full spelling; the message lists the entries.
  assert.equal(why('grep --recur token src'), 'sage-bot guard: grep with the option --recur is refused in a lead session. sage can do this instead: give grep only the options -n -i -in -l -c -v -w -o -h -H -E -F -q -s -x -e -A -B -C -m --, each one spelled in full and alone.');
  assert.equal(why('pwd -L'), 'sage-bot guard: pwd with the option -L is refused in a lead session. sage can do this instead: give pwd no option.');
  assert.equal(why('node --test-reporter=x.mjs --test'), 'sage-bot guard: node --test-reporter x.mjs (only spec, tap, dot, junit) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('head -n'), 'sage-bot guard: head -n with no value is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('git merge feature'), 'sage-bot guard: git merge (only the listed subcommands; no global option but -C) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('git -C'), 'sage-bot guard: git -C with no folder is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('git stash clear'), 'sage-bot guard: git stash clear is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('git worktree remove x'), 'sage-bot guard: git worktree remove is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('git remote add x y'), 'sage-bot guard: git remote: a change of a remote is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('sh -c x'), 'sage-bot guard: the command sh is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('npm install x'), 'sage-bot guard: npm install (only ci, test, run, ls and outdated) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('npm run deploy'), 'sage-bot guard: npm run deploy (a deploy) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('node'), 'sage-bot guard: node with no script file (code from stdin) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(why('cd src'), 'sage-bot guard: cd other than as the first part of cd <folder> && <command> is refused in a lead session. sage can do this instead: cd <folder> && <command>, or name the full path in the command.');
  assert.match(why('cd src ; ls'), /cannot read \(the operator ; \(only && joins parts\)\) is refused .* instead: one command per call, or commands joined only by && /);
  assert.equal(why('ls | sh'), 'sage-bot guard: a | into sh is refused in a lead session. sage can do this instead: pipe only into head, tail, wc, sort or grep, or run the commands one by one.');
  assert.equal(why('rm -rf *'), 'sage-bot guard: the word * (a wildcard at its start can expand to an option) is refused in a lead session. sage can do this instead: start the word with a folder, for example ./*.');
  // In a part that runs or writes, a wildcard that can match the state tool gets the hint to name the files first.
  assert.equal(why('cp * {SCRATCH}'), `sage-bot guard: the wildcard * (it can match the sage state tool) is refused in a lead session. ${WILDCARD}`);
  assert.equal(why('cp ./* {SCRATCH}'), `sage-bot guard: the wildcard ./* (it can match the sage state tool) is refused in a lead session. ${WILDCARD}`);
  assert.equal(guard(tool('Grep', { pattern: 'x' })).reason, 'sage-bot guard: the Grep tool (the sandbox does not cover it) is refused in a lead session. sage can do this instead: search with rg in Bash, for example rg -n <pattern> <folder>.');
  assert.equal(guard(tool('WebFetch', { url: 'http://127.0.0.1/', prompt: 'x' })).reason, 'sage-bot guard: a fetch of 127.0.0.1 (not a global unicast address) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(guard(tool('WebFetch', { url: 'http://printer.local/', prompt: 'x' })).reason, 'sage-bot guard: a fetch of printer.local (this Mac or the local network) is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
  assert.equal(guard(tool('Monitor', { command: 'ls' })).reason, 'sage-bot guard: the tool Monitor is refused in a lead session. This needs Erick; tell the sage-lead and stop this action.');
});

test('T133: the hook answers allow with no output and deny with the PreToolUse JSON; a malformed stdin or a tool call with no input refuses (fail closed)', () => {
  const allowed = hook(bash('git status'));
  assert.deepEqual([allowed.decision, allowed.status, allowed.reason], ['allow', 0, undefined]);
  assert.match(hook(bash('gh pr merge 12')).reason, /^sage-bot guard: gh is refused/);
  for (const stdin of ['', 'not json', '[]', 'null', '{"tool_name":"Bash"}', JSON.stringify(tool('Bash', { command: 42 })), JSON.stringify(tool('Bash', {})), JSON.stringify(tool('Skill', 'x')), JSON.stringify({ tool_name: 'Skill' }), JSON.stringify({ tool_name: 42, tool_input: {} })]) {
    const r = hook(stdin);
    assert.equal(r.decision, 'deny', stdin);
    assert.match(r.reason, MESSAGE, stdin);
  }
});

test('T133: an input over 64 KB is refused before it is parsed, quickly; a large input under the limit is decided quickly too', () => {
  const over = JSON.stringify(bash(`echo ${'a'.repeat(64 * 1024)}`));
  const r = hook(over);
  assert.equal(r.reason, 'sage-bot guard: a tool call over 64 KB is refused in a lead session. sage can do this instead: write long text to a file in the scratch folder in parts of less than 64 KB, and pass the file.');
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
  const ok = JSON.stringify(bash('git status'));
  assert.equal(guard(`${ok}${' '.repeat(64 * 1024 - ok.length)}`).decision, 'allow');
  assert.equal(guard(`${ok}${' '.repeat(64 * 1024 - ok.length + 1)}`).decision, 'deny');
});

test('T133: a crash of the hook refuses in a lead session (exit code 2)', () => {
  // The rules module throws on load: a copy of the hook next to a broken src/guard.js.
  const dir = mkdtempSync(join(base, 'broken-'));
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'scripts', 'guard.mjs'), readFileSync(HOOK));
  writeFileSync(join(dir, 'src', 'guard.js'), 'throw new Error("sample crash");\n');
  const r = run(join(dir, 'scripts', 'guard.mjs'), JSON.stringify(bash('git status')), LEAD);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused, the guard could not decide \(sample crash\)\. This needs Erick; tell the sage-lead and stop this action\./);
  const inert = run(join(dir, 'scripts', 'guard.mjs'), '{}', {});
  assert.deepEqual([inert.status, inert.stdout], [0, '']);
});
