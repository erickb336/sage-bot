// The mutation check of the guard (T133): npm run check:guard-mutations.
// For each rule of src/guard.js, it makes a copy of the guard with that one rule removed, and runs test/guard.test.js
// against the copy. Each removal must make at least one test fail; a removal that passes is a rule that no test pins.
// A removal must keep the guard working: the copy must load and still allow the known-good calls (pwd, a Read, git status, an
// Agent, a WebFetch to 8.8.8.8). A copy that does not is a broken mutation: its test failures prove nothing, so it is
// reported, not counted as a kill; nor is a run that does not end in 60 s. It prints one line for each surviving, broken,
// timed-out or stale mutation and the counts, and exits 1 when there is any (stale: the rule's text is not found exactly once in src/guard.js, so this list is out of date).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = readFileSync(join(ROOT, 'src', 'guard.js'), 'utf8');

// [rule, the text of the rule, what replaces it]
const MUTATIONS = [
  // The Bash parser
  ['double quotes: $, backtick, \\ and !', "if (/[$`\\\\!]/.test(command[j])) throw `a ${command[j]} inside double quotes`;", ''],
  ['double quotes: control characters', "          if (/[\\0-\\x08\\x0b-\\x1f\\x7f]/.test(command[j])) throw 'a control character';\n", ''],
  ['single quotes: control characters', "if (/[\\0-\\x08\\x0b-\\x1f\\x7f]/.test(body)) throw 'a control character';", ''],
  ['only && and | join parts: ;, ||, |& and & are refused', "else if (c === ';' || c === '&' || c === '|') throw `the operator ${rest.match(/^(;+|\\|\\||\\|&|&)/)[0]} (only && joins parts)`;", "else if (c === ';' || c === '&' || c === '|') { endSegment(false); i += rest.match(/^(;+|\\|\\||\\|&|&)/)[0].length; }"],
  ['the redirects <<, <>, <&, >| and <(', " || /^(<<|<>|<&|>\\||<\\()/.test(rest)", ''],
  ['a redirect needs a file', "if (pendingRedirect) throw 'a redirect with no file';", ''],
  ['a redirect target is not a word', 'if (pendingRedirect) { seg.redirects.push(pendingRedirect); pendingRedirect = null; } else seg.words.push(word);', 'seg.words.push(word);'],
  ['a wildcard is marked as one', 'add(c, true); i++;', 'add(c); i++;'],
  // The parser's main defence: every other character outside quotes ($, backtick, (, {, \, newline, non-ASCII) is refused.
  ['characters outside quotes', "else throw c === '\\n' || c === '\\r' ? 'a newline outside quotes' : `the character ${JSON.stringify(c)} outside quotes`;", 'else { add(c); i++; }'],
  // Options: each must be an entry of the table by its full spelling
  ['an option must be an entry of the table', 'if (kind === undefined || (kind === FLAG && eq >= 0)) {', 'if (false) {'],
  ['a flag takes no =value', ' || (kind === FLAG && eq >= 0)', ''],
  ['-- ends the options only when the table has it', "if (a === '--' && Object.hasOwn(table, '--'))", "if (a === '--')"],
  ['a number option only when the table has it', 'if (/^-\\d+$/.test(a) && Object.hasOwn(table, NUM))', 'if (/^-\\d+$/.test(a))'],
  ['node: the options end at the script', ' || (posix && ops.length)', ''],
  ['an option with a value takes the next word', 'const value = eq < 0 ? args[++i] : a.slice(eq + 1);', 'const value = eq < 0 ? args[i] : a.slice(eq + 1);'],
  ['an option with a value needs one', 'if (value === undefined) return', 'if (false) return'],
  ['an option with a list takes only its values', 'if (Array.isArray(kind) && !kind.includes(value)) return', 'if (false) return'],
  // Commands
  ['grep: no recursive option', "'-x': FLAG, '-e': TEXT, '-A': TEXT", "'-x': FLAG, '-r': FLAG, '-e': TEXT, '-A': TEXT"],
  ['sort: no option that writes or runs a program', "'-rn': FLAG, '-k': TEXT", "'-rn': FLAG, '-o': TEXT, '--compress-program': TEXT, '-k': TEXT"],
  ['rg: no --pre', "'--files': FLAG, '--': FLAG }", "'--files': FLAG, '--pre': TEXT, '--': FLAG }"],
  ['find: no -exec or -delete', "'-empty': FLAG })", "'-empty': FLAG, '-exec': TEXT, '-delete': FLAG })"],
  ['npm: only the listed commands', 'if (!NPM_RUN.has(sub)) return', 'if (false) return'],
  ['npm: no deploy script', "return /deploy|release|publish/i.test(script ?? '') ?", 'return false ?'],
  ['npm: no option that changes its config', "'--prefer-offline': FLAG, '--': FLAG }", "'--prefer-offline': FLAG, '--prefix': TEXT, '--script-shell': TEXT, '--': FLAG }"],
  ['gh goes to the broker', "gh: () => how('gh', BROKER),", ''],
  ['only the listed commands', 'if (!Object.hasOwn(COMMANDS, name)) return `the command ${name}`;', 'if (!Object.hasOwn(COMMANDS, name)) return null;'],
  ['no inherited name as a command', 'if (!Object.hasOwn(COMMANDS, name)) return', 'if (!COMMANDS[name]) return'],
  // git
  ['git -C needs a folder', "if (!a[1]) return 'git -C with no folder';", ''],
  ['git -C and its folder come before the subcommand', 'a = a.slice(2);', 'a = a.slice(1);'],
  ['git push and git fetch go to the broker', "if (sub === 'push' || sub === 'fetch') return how(`git ${sub}`, BROKER);", ''],
  ['git fetch goes to the broker', " || sub === 'fetch') return how", ') return how'],
  ['git: only the listed subcommands', 'if (!rule) return `git ${sub', 'if (!rule) return null && `git ${sub'],
  ['git: no inherited name as a subcommand', "Object.hasOwn(GIT, sub ?? '') ? GIT[sub] : null", 'GIT[sub]'],
  ['git: the option table of each subcommand', "const gitCmd = (table) => cmd({ ...table, '--': FLAG });", 'const gitCmd = () => () => null;'],
  ['git commit: no --no-verify', "commit: cmd({ '-m': TEXT,", "commit: cmd({ '--no-verify': FLAG, '-m': TEXT,"],
  ['git branch: no -D', "branch: cmd({ '-a': FLAG,", "branch: cmd({ '-D': TEXT, '-a': FLAG,"],
  ['git stash: only the listed subcommands', "(['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0])", '(true'],
  ['git stash: its option table', '? STASH(args.slice(1), env, name) :', '? null :'],
  ['git remote: no change', "(args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null", '(true ? null'],
  ['git worktree: only add and list', ": `git worktree ${args[0] ?? ''}`.trim()),", ': null),'],
  ['git worktree list takes nothing more', "args[0] === 'list' && args.length === 1 ?", "args[0] === 'list' ?"],
  ['git worktree add: its option table', "cmd({ '-b': TEXT })(args.slice(1), env, name)", 'null'],
  // node
  ['node --version and -v', "if (args.length === 1 && ['--version', '-v'].includes(args[0])) return null;", ''],
  ['node --version takes nothing after it', 'if (args.length === 1 && ', 'if ('],
  ['node: only the listed options', "if (typeof ops === 'string') return ops;\n  if (!ops[0])", "if (typeof ops === 'string') return null;\n  if (!ops[0])"],
  ['node: a script file is needed', "return args.includes('--test') ? null : 'node with no script file (code from stdin)';", 'return null;'],
  ['node --test needs no script', "return args.includes('--test') ? null :", 'return false ? null :'],
  // The sage state tool: refused in every form (G30 A)
  ['the state tool: the raw text', '  if (namesStateTool([String(command)], [], env)) return STATE_TOOL;\n', ''],
  ['the state tool: the words, quotes joined', "if (namesStateTool(parsed.flatMap((seg) => seg.words.map((w) => w.text)), globs, env)) return STATE_TOOL;", ''],
  ['the state tool: the name sage.mjs', "['sage.mjs', basename(env.SAGE_TOOL ?? '')]", "[basename(env.SAGE_TOOL ?? '')]"],
  ["the state tool: SAGE_TOOL's name", "['sage.mjs', basename(env.SAGE_TOOL ?? '')]", "['sage.mjs']"],
  ['the state tool: a name in any case', "join('|')})`, 'i');", "join('|')})`);"],
  ['the state tool: another name that only ends like it', '`(^|[^a-z0-9_.-])(', '`(^|)('],
  ['the state tool: a wildcard in any case', "join('')}$`, 'i');", "join('')}$`);"],
  ['the state tool: a wildcard *', "(p === '*' ? '.*' :", "(p === '*' ? '' :"],
  ['the state tool: a wildcard ?', "p === '?' || p.startsWith('[') ? '.'", "p.startsWith('[') ? '.'"],
  ['the state tool: a wildcard [...]', "|| p.startsWith('[') ? '.'", "? '.'"],
  ['the state tool: the wildcards are checked', 'globs.some((g) => names.some((n) => pattern(g).test(n)))', 'false'],
  ['the state tool: wildcards of node', "new Set(['node', 'npm',", "new Set(['npm',"],
  ['the state tool: wildcards of npm', "'node', 'npm', 'cp'", "'node', 'cp'"],
  ['the state tool: wildcards of cp', "'npm', 'cp', 'mv'", "'npm', 'mv'"],
  ['the state tool: wildcards of mv', "'cp', 'mv', 'git'", "'cp', 'git'"],
  ['the state tool: wildcards of git', "'mv', 'git']);", "'mv']);"],
  ['the state tool: wildcards of a part with a redirect', ' || seg.redirects.length)\n', ')\n'],
  ['the state tool: a word that starts with a wildcard gets its own hint', "w.glob && !/^[*?[]/.test(w.text)", 'w.glob'],
  ['the state tool: the Write tool', 'Write: file,', 'Write: allow,'],
  ['the state tool: the Edit tool', 'Edit: file, MultiEdit', 'Edit: allow, MultiEdit'],
  ['the state tool: the MultiEdit tool', 'MultiEdit: file,', 'MultiEdit: allow,'],
  ['the state tool: the NotebookEdit tool', 'NotebookEdit: file,', 'NotebookEdit: allow,'],
  ['the stop ending', "const STOP = 'This needs Erick; tell the sage-lead and stop this action.';", "const STOP = 'Stop.';"],
  // Simple commands, cd and chains
  ['only the listed variables', 'if (!ENV.has(name)) return', 'if (false) return'],
  ['a variable needs a command after it', "if (!name) return 'a part with no command';", 'if (!name) return null;'],
  ['no variable in front of git', "if (i > 0 && name === 'git') return", 'if (false) return'],
  ['no word that starts with a wildcard', 'if (glob) return how(', 'if (false) return how('],
  ['only a wildcard at the start of a word', 'w.glob && /^[*?[]/.test(w.text)', 'w.glob'],
  ['the command name is not checked for a wildcard', 'words.slice(i + 1).find(', 'words.slice(i).find('],
  ['a | only into a read-only filter', 'if (seg.pipe && !PIPE.has(commandOf(texts)[0])) return', 'if (false) return'],
  ['cd only as the first part', 'if (k !== 0 || parsed.length < 2', 'if (parsed.length < 2'],
  ['cd needs a part after it', 'k !== 0 || parsed.length < 2 || ', 'k !== 0 || '],
  ['cd: no | after it', ' || parsed[1].pipe', ''],
  ['cd: one folder', ' || texts.length !== 2', ''],
  ['cd: no option', " || texts[1].startsWith('-')", ''],
  ['cd: no redirect', " || seg.redirects.length) {\n        return how('cd", ") {\n        return how('cd"],
  ['each part is checked', '    const why = simple(seg, env);\n    if (why) return why;\n  }\n  return null;', '  }\n  return null;'],
  // The other tools
  ['the Grep tool is refused', "Grep: () => how('the Grep tool", "Grep: () => null && how('the Grep tool"],
  ['Skill is allowed', 'Skill: allow, ', ''],
  ['BashOutput is allowed', 'BashOutput: allow, ', ''],
  ['KillShell is allowed', 'KillShell: allow, ', ''],
  ['ExitPlanMode is allowed', 'ExitPlanMode: allow, ', ''],
  ['Write is allowed', '(namesStateTool([JSON.stringify(i)], [], env) ? STATE_TOOL : null)', 'STATE_TOOL'],
  ['SendMessage is allowed', ' SendMessage: allow,', ''],
  ['EnterWorktree is allowed', ' EnterWorktree: allow,', ''],
  ['TaskCreate is allowed', 'TaskCreate: allow, ', ''],
  ['Agent and Task: no isolation field', "(Object.hasOwn(i, 'isolation') ?", '(false ?'],
  ['Agent: the isolation rule', 'Agent: agent,', 'Agent: allow,'],
  ['Task: the isolation rule', 'Task: agent,', 'Task: allow,'],
  ['Glob is allowed', ', Glob: allow,', ','],
  ['WebFetch: http and https only', 'if (!/^https?:$/.test(u.protocol)) return', 'if (false) return'],
  ['WebFetch: a URL that parses', "try { u = new URL(String(url)); } catch { return 'a fetch of a URL that does not parse'; }", "try { u = new URL(String(url)); } catch { return null; }"],
  ['WebFetch: no host name without a dot', "if (!host.includes('.')) return", 'if (false) return'],
  ['WebFetch: no localhost, .local, .internal', "if (/(^|\\.)(localhost|local|internal|home\\.arpa)$/.test(host)) return", 'if (false) return'],
  ['WebFetch: an address is checked as one', 'if (type) return UNICAST', 'if (false) return UNICAST'],
  ['WebFetch: only the unicast space', 'UNICAST.check(host, type) && ', ''],
  ['WebFetch: IPv4 unicast ends at 223', "'223.255.255.255'", "'255.255.255.255'"],
  ['WebFetch: IPv4 unicast starts at 1', "addRange('1.0.0.0',", "addRange('0.0.0.0',"],
  ['WebFetch: IPv6 unicast is 2000::/3', "addSubnet('2000::', 3, 'ipv6')", "addSubnet('::', 0, 'ipv6')"],
  ['WebFetch: no special-purpose range', '!SPECIAL.check(host, type) ?', 'true ?'],
  ['WebFetch: no 10.0.0.0/8', "'10.0.0.0/8', ", ''],
  ['WebFetch: no 100.64.0.0/10', "'100.64.0.0/10', ", ''],
  ['WebFetch: no 127.0.0.0/8', "'127.0.0.0/8', ", ''],
  ['WebFetch: no 169.254.0.0/16', "'169.254.0.0/16', ", ''],
  ['WebFetch: no 172.16.0.0/12', "'172.16.0.0/12', ", ''],
  ['WebFetch: no 192.0.0.0/24', "'192.0.0.0/24', ", ''],
  ['WebFetch: no 192.0.2.0/24', "'192.0.2.0/24', ", ''],
  ['WebFetch: no 192.88.99.0/24', "'192.88.99.0/24', ", ''],
  ['WebFetch: no 192.168.0.0/16', "'192.168.0.0/16', ", ''],
  ['WebFetch: no 198.18.0.0/15', "'198.18.0.0/15', ", ''],
  ['WebFetch: no 198.51.100.0/24', "'198.51.100.0/24', ", ''],
  ['WebFetch: no 203.0.113.0/24', ", '203.0.113.0/24'", ''],
  ['WebFetch: no 2001::/23', "'2001::/23', ", ''],
  ['WebFetch: no 2001:db8::/32', "'2001:db8::/32', ", ''],
  ['WebFetch: no 2002::/16', "'2002::/16', ", ''],
  ['WebFetch: no 3fff::/20', ", '3fff::/20'", ''],
  ['WebFetch: IPv6 brackets', ".replace(/^\\[|\\]$/g, '')", ''],
  ['WebFetch: a trailing dot', ".replace(/\\.$/, '')", ''],
  // The hook input
  ['inert unless SAGE_ORIGIN is lead', "if (env.SAGE_ORIGIN !== 'lead') return null;", ''],
  ['an input over 64 KB', 'if (Buffer.byteLength(text) > MAX_INPUT) return', 'if (false) return'],
  ['an input that is not JSON', "try { input = JSON.parse(text); } catch { return refusal('a hook input that is not JSON'); }", 'try { input = JSON.parse(text); } catch { return null; }'],
  ['an input that is not a tool call', "if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object') {", 'if (!input) {'],
  ['only the listed tools', 'if (!rule) return refusal(`the tool ${input.tool_name}`);', 'if (!rule) return null;'],
  ['no inherited name as a tool', 'Object.hasOwn(TOOLS, input.tool_name) ? TOOLS[input.tool_name] : null', 'TOOLS[input.tool_name]'],
];

const work = mkdtempSync(join(tmpdir(), 'sage-bot-guard-mutations-'));
// The known-good calls that every mutation must still allow: pwd, a Read, git status, an Agent, a WebFetch to 8.8.8.8.
writeFileSync(join(work, 'check.mjs'), `
const { decide } = await import(process.argv[2]);
const env = { SAGE_ORIGIN: 'lead', SAGE_TOOL: '/sample/state.mjs' };
const calls = [['Bash', { command: 'pwd' }], ['Read', { file_path: '/sample/README.md' }], ['Bash', { command: 'git status' }], ['Agent', { prompt: 'x' }], ['WebFetch', { url: 'https://8.8.8.8/' }]];
process.exit(calls.every(([tool_name, tool_input]) => decide({ tool_name, tool_input }, env) === null) ? 0 : 1);
`);

/** Resolves with the exit code of `node args` in `cwd`, or 'timeout' when it is killed after 60 s (a hang is not a kill). */
const node = (args, cwd) => new Promise((done) => {
  const child = spawn(process.execPath, args, { cwd, stdio: 'ignore' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
  child.on('close', (code) => { clearTimeout(timer); done(timedOut ? 'timeout' : code); });
});

/** Runs a copy of the guard with `source` as src/guard.js: 'broken' when it fails the known-good calls, else the tests' exit code. */
async function run(name, source) {
  const dir = join(work, name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) + Math.random().toString(36).slice(2, 6));
  for (const f of ['package.json', 'scripts/guard.mjs', 'test/guard.test.js', 'test/guard-corpus.json']) cpSync(join(ROOT, f), join(dir, f));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'guard.js'), source);
  if (await node([join(work, 'check.mjs'), join(dir, 'src', 'guard.js')], dir) !== 0) return 'broken';
  return node(['--test', 'test/guard.test.js'], dir);
}

const stale = MUTATIONS.filter(([, from]) => SOURCE.split(from).length !== 2);
for (const [name, from] of stale) console.log(`STALE  ${name}: its text is not in src/guard.js exactly once: ${JSON.stringify(from)}`);
const start = Date.now();
const unmutated = await run('unmutated', SOURCE);
if (unmutated !== 0) console.log(`FAIL   the unmutated guard: ${unmutated === 'broken' ? 'it refuses a known-good call' : 'its tests fail'}`);
const survivors = [];
const broken = [];
const timeouts = [];
const queue = MUTATIONS.filter((m) => !stale.includes(m));
await Promise.all(Array.from({ length: Math.max(2, availableParallelism() - 1) }, async () => {
  for (let m = queue.shift(); m; m = queue.shift()) {
    const [name, from, to] = m;
    // A function, so that a $ in the new text is taken as it is ($` and $& are patterns of replace).
    const result = await run(name, SOURCE.replace(from, () => to));
    if (result === 'broken') broken.push(name);
    else if (result === 'timeout') timeouts.push(name);
    else if (result === 0) survivors.push(name);
  }
}));
for (const name of broken) console.log(`BROKEN    ${name}: the copy does not load or refuses a known-good call, so its failures prove nothing`);
for (const name of survivors) console.log(`SURVIVES  ${name}: no test fails without this rule`);
for (const name of timeouts) console.log(`TIMEOUT   ${name}: the tests did not end in 60 s, so they prove nothing`);
const killed = MUTATIONS.length - stale.length - survivors.length - broken.length - timeouts.length;
console.log(`guard mutations: ${killed} of ${MUTATIONS.length} rule removals fail a test; ${survivors.length} survive; ${broken.length} broken; ${timeouts.length} time out; ${stale.length} stale; ${Math.round((Date.now() - start) / 1000)} s`);
rmSync(work, { recursive: true, force: true });
process.exit(survivors.length || broken.length || timeouts.length || stale.length || unmutated !== 0 ? 1 : 0);
