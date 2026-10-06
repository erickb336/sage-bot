// The mutation check of the guard (T133): npm run check:guard-mutations.
// For each rule of src/guard.js (and of the hook's output in scripts/guard.mjs), it makes a copy of the guard with that one rule removed, and runs test/guard.test.js
// against the copy. Each removal must make at least one test fail; a removal that passes is a rule that no test pins.
// A removal must keep the guard working: the copy must load and still allow the known-good calls (pwd, a Read, git status, an
// Agent, a WebFetch to 8.8.8.8). A copy that does not is a broken mutation: its test failures prove nothing, so it is
// reported, not counted as a kill; nor is a run that does not end in 60 s. It prints one line for each surviving, broken,
// timed-out or stale mutation and the counts, and exits 1 when there is any (stale: the rule's text is not found exactly once in its file, so this list is out of date).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = { 'src/guard.js': readFileSync(join(ROOT, 'src', 'guard.js'), 'utf8'), 'scripts/guard.mjs': readFileSync(join(ROOT, 'scripts', 'guard.mjs'), 'utf8') };

// [rule, the text of the rule, what replaces it, the file (src/guard.js when there is none)]
const MUTATIONS = [
  // The Bash parser
  ['double quotes: $, backtick, \\ and !', "if (/[$`\\\\!]/.test(command[j])) throw `a ${command[j]} inside double quotes`;", ''],
  ['double quotes: control characters', "          if (/[\\0-\\x08\\x0b-\\x1f\\x7f]/.test(command[j])) throw 'a control character';\n", ''],
  ['single quotes: control characters', "if (/[\\0-\\x08\\x0b-\\x1f\\x7f]/.test(body)) throw 'a control character';", ''],
  ['only && and | join parts: ;, ||, |& and & are refused', "else if (c === ';' || c === '&' || c === '|') throw `the operator ${rest.match(/^(;+|\\|\\||\\|&|&)/)[0]} (only && joins parts)`;", "else if (c === ';' || c === '&' || c === '|') { endSegment(false); i += rest.match(/^(;+|\\|\\||\\|&|&)/)[0].length; }"],
  ['the redirects <<, <>, <&, >| and <(', " || /^(<<|<>|<&|>\\||<\\()/.test(rest)", ''],
  ['a redirect needs a file', "if (pendingRedirect) throw 'a redirect with no file';", ''],
  ['a redirect target is kept as a word', '(pendingRedirect ? seg.redirects : seg.words).push(word);', '(pendingRedirect ? [] : seg.words).push(word);'],
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
  ['git --pretty and --format in log: a value only with = (F-T133-43)', "'--format': EQ, '--pretty': EQ, '--graph'", "'--format': TEXT, '--pretty': TEXT, '--graph'"],
  ['git --pretty and --format in show: a value only with = (F-T133-43)', "'-s': FLAG, '--format': EQ, '--pretty': EQ })", "'-s': FLAG, '--format': TEXT, '--pretty': TEXT })"],
  ['an =value flag alone takes no value', ' || (kind === EQ && eq < 0)', ''],
  ['an option with a list takes only its values', 'if (Array.isArray(kind) && !kind.includes(value)) return', 'if (false) return'],
  // Commands
  ['grep: no recursive option', "'-x': FLAG, '-e': TEXT, '-A': TEXT", "'-x': FLAG, '-r': FLAG, '-e': TEXT, '-A': TEXT"],
  ['sort: no option that writes or runs a program', "'-rn': FLAG, '-k': TEXT", "'-rn': FLAG, '-o': TEXT, '--compress-program': TEXT, '-k': TEXT"],
  ['rg: no --pre', "'--files': FLAG, '--': FLAG }", "'--files': FLAG, '--pre': TEXT, '--': FLAG }"],
  ['find: no -exec or -delete', "'-empty': FLAG })", "'-empty': FLAG, '-exec': TEXT, '-delete': FLAG })"],
  ['npm: only the listed commands', 'if (!NPM_RUN.has(sub)) return', 'if (false) return'],
  ['gh goes to the broker', "gh: () => how('gh', BROKER),", ''],
  // F-T133-63: the old hint named a CLI that the guard itself refuses.
  ['the broker hint names the broker tools, no command (F-T133-63)', "const BROKER = 'the sage-bot broker tools of the session (fetch, open a pull request, upload your branch)';", "const BROKER = \"sage-bot-github, the GitHub broker of step 6, for a fetch, an upload to the session's own branch and the session's own pull request (create, edit, view)\";"],
  // F-T133-64: a read of some lines with sed or awk gets the safe form.
  ['the broker hint names fetch (F-T133-70)', '(fetch, open a pull request', '(open a pull request'],
  ['sed gets the line-read hint (F-T133-64)', "  sed: () => how('sed', LINES),\n", ''],
  ['awk gets the line-read hint (F-T133-64)', "  awk: () => how('awk', LINES),\n", ''],
  ['the line-read hint names head, tail and Read (F-T133-64)', ', tail -n +20 <file> | head -n 20, or the Read tool with offset and limit', ''],
  ['the sed hint names the Edit tool for a change (F-T133-69)', '; to change a file: the Edit tool', ''],
  ['only the listed commands', 'if (!Object.hasOwn(COMMANDS, name)) return `the command ${say(name)}`;', 'if (!Object.hasOwn(COMMANDS, name)) return null;'],
  ['no inherited name as a command', 'if (!Object.hasOwn(COMMANDS, name)) return', 'if (!COMMANDS[name]) return'],
  // git
  ['git push and git fetch go to the broker', "if (sub === 'push' || sub === 'fetch') return how(`git ${sub}`, BROKER);", ''],
  ['git fetch goes to the broker', " || sub === 'fetch') return how", ') return how'],
  ['git: only the listed subcommands', 'if (!rule) return `git ${say(sub', 'if (!rule) return null && `git ${say(sub'],
  ['git: no inherited name as a subcommand', "Object.hasOwn(GIT, sub ?? '') ? GIT[sub] : null", 'GIT[sub]'],
  ['git: the option table of each subcommand', "const gitCmd = (table) => cmd({ ...table, '--': FLAG });", 'const gitCmd = () => () => null;'],
  ['git commit: no --no-verify', "commit: cmd({ '-m': TEXT,", "commit: cmd({ '--no-verify': FLAG, '-m': TEXT,"],
  ['git branch: no -D', "branch: cmd({ '-a': FLAG,", "branch: cmd({ '-D': TEXT, '-a': FLAG,"],
  ['git stash: only the listed subcommands', "['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0])", 'true'],
  ['git stash <option> is git stash push <option> (F-T133-65)', "args[0]?.startsWith('-') ? STASH(args, env, name) : ", ''],
  ['git stash <option>: its first option is checked too (F-T133-65)', "? STASH(args, env, name) :", '? STASH(args.slice(1), env, name) :'],
  ['git stash: its option table', '? STASH(args.slice(1), env, name) :', '? null :'],
  ['git worktree: only add and list', ": `git worktree ${say(args[0] ?? '')}`.trim()),", ': null),'],
  ['git worktree add: its option table', "cmd({ '-b': TEXT })(args.slice(1), env, name)", 'null'],
  // node
  ['node and npm: the version takes nothing after it', "args.length === 1 && ['--version', '-v']", "['--version', '-v']"],
  ['node and npm: -v is the version too (F-T133-71)', "['--version', '-v'].includes(args[0])", "['--version'].includes(args[0])"],
  // F-T133-71: npm --version and npm -v alone; npm version can change package.json, so it gets the hint to npm --version.
  ['node: only the listed options', "if (typeof ops === 'string') return ops;\n  if (ops[0] === '-'", "if (typeof ops === 'string') return null;\n  if (ops[0] === '-'"],
  ['node: a script file is needed', "(!ops[0] && !args.includes('--test'))", 'false'],
  ['node: never the script - (stdin)', "ops[0] === '-' || ", ''],
  ['node --test needs no script', " && !args.includes('--test'))", ')'],
  // The sage state tool: refused in every form (G30 A)
  ['the state tool: the raw text', '  if (namesStateTool([command], env)) return STATE_TOOL;\n', ''],
  ['the state tool: the words, quotes joined', 'if (namesStateTool(parsed.flatMap((seg) => [...seg.words, ...seg.redirects]).map((w) => w.text), env)) return STATE_TOOL;', ''],
  ['the state tool: the redirect targets are words', '[...seg.words, ...seg.redirects]).map((w) => w.text), env)', '[...seg.words]).map((w) => w.text), env)'],
  ['the state tool: the name sage.mjs', "['sage.mjs', basename(env.SAGE_TOOL ?? '')]", "[basename(env.SAGE_TOOL ?? '')]"],
  ["the state tool: SAGE_TOOL's name", "['sage.mjs', basename(env.SAGE_TOOL ?? '')]", "['sage.mjs']"],
  ['the state tool: a name folded to lower case', "normalize('NFKC').toLowerCase()", "normalize('NFKC')"],
  ['the state tool: a name folded by NFKC (the long s)', ".normalize('NFKC').toLowerCase()", '.toLowerCase()'],
  ['the state tool: another name that only ends like it', '`(^|[^a-z0-9_.-])(', '`(^|)('],
  ['the state tool: a wildcard *', "if (g[i] === '*') { star = i++;", "if (false) { star = i++;"],
  ['the state tool: a wildcard ?', "g[i] === '?' || ", ''],
  // F-T133-62: the linear wildcard match (a regex with .* for each * backtracked for minutes).
  ['the state tool: a * takes more characters after a mismatch (F-T133-62)', ' else if (star >= 0) { i = star + 1; n = ++from; }', ''],
  ['the hook: a decision past the deadline is refused (F-T133-62)', "    setTimeout(() => answer(refusal(`a tool call that the guard did not decide in ${DEADLINE_MS / 1000} s`)), DEADLINE_MS);\n", '', 'scripts/guard.mjs'],
  ['the hook: past the deadline it writes a deny (F-T133-62)', 'answer(refusal(`a tool call that the guard did not decide in ${DEADLINE_MS / 1000} s`))', 'answer(null)', 'scripts/guard.mjs'],
  ['the hook: the deadline is 5 s (F-T133-62)', 'const DEADLINE_MS = 5000;', 'const DEADLINE_MS = 25000;', 'scripts/guard.mjs'],
  ['the hook: the worker streams stay off fd 1 (F-T133-62)', ', stdout: true, stderr: true }', ' }', 'scripts/guard.mjs'],
  ['the state tool: a wildcard gets the safe-form hint (F-T133-44)', '? how(`the wildcard ${say(text)} (it can match the sage state tool)`, WILDCARD) : null;', '? STATE_TOOL : null;'],
  ['the wildcard hint names the folder form (F-T133-55)', ', or add its folder (git add <folder>); for the tests:', ' (for the tests:'],
  ['no [ wildcard in a part that runs or writes', ": chars.includes('[') && ['['];", ': false;'],
  ['the wildcards of a part that runs or writes are checked', '    const why = wildcard(w.text, w.glob, env);', '    const why = null;'],
  // F-T133-46 (G46 A): git and node --test expand a pattern in an operand themselves, also a quoted one.
  ['a command rule gives its operands (F-T133-46)', 'rule(ops, env) ?? ops;', 'rule(ops, env);'],
  ['a pattern operand: no pattern character but * and ? (F-T133-46)', 'pattern ? text.match(/[^A-Za-z0-9 _\\-./,:=%~^*?]/) :', "pattern ? text.match(/\\[/) :"],
  // G47 A: a pattern character other than [ in such an operand has no safe form, so it gets the stop ending (F-T133-51).
  ['a pattern operand: a character with no safe form gets the stop ending (F-T133-51)', "  if (odd && odd[0] !== '[') return `the character ${odd[0]} in the operand ${say(text)} (git and node --test can read it as a pattern)`;\n", ''],
  ['git checkout --: the hint to git restore (F-T133-52)', "cmd({ '-b': TEXT }, undefined, 'git restore <file> to undo the changes of a file, or git checkout -b <branch>')", "cmd({ '-b': TEXT })"],
  // F-T133-47 (G46 A): a pipeline runs or writes as a whole.
  ['a pipeline is checked as a whole (F-T133-47)', '(seg.pipe ? pipelines.at(-1) : pipelines[pipelines.push([]) - 1]).push(seg);', 'pipelines[pipelines.push([]) - 1].push(seg);'],
  // F-T133-48 (G46 A): node runs no script from a path under /dev/.
  ['printable ASCII in a part that runs or writes', 'if (rw.some((w) => !ASCII.test(w.text))) return', 'if (false) return'],
  ['printable ASCII: no tab or newline', String.raw`const ASCII = /^[\x20-\x7e]*$/;`, String.raw`const ASCII = /^[\x09-\x7e]*$/;`],
  ['the redirect targets of a part that runs or writes', '.flat().flatMap((seg) => [...seg.words, ...seg.redirects]);', '.flat().flatMap((seg) => seg.words);'],
  ['the state tool: wildcards of node', "new Set(['node', 'npm',", "new Set(['npm',"],
  ['the state tool: wildcards of npm', "'node', 'npm', 'cp'", "'node', 'cp'"],
  ['the state tool: wildcards of cp', "'npm', 'cp', 'mv'", "'npm', 'mv'"],
  ['the state tool: wildcards of mv', "'cp', 'mv', 'git'", "'cp', 'git'"],
  ['the state tool: wildcards of a part with a redirect', ' || seg.redirects.length))\n', '))\n'],
  // F-T133-72: a write under a .claude folder, a second layer (T134 holds it: F-T134-4, F-T134-20).
  ['.claude: touch changes files (F-T133-72)', "new Set(['touch', ", 'new Set(['],
  ['.claude: mkdir changes files (F-T133-72)', "'touch', 'mkdir', ", "'touch', "],
  ['.claude: rm changes files (F-T133-72)', "'mkdir', 'rm', 'rmdir'", "'mkdir', 'rmdir'"],
  ['.claude: rmdir changes files (F-T133-72)', "'rm', 'rmdir']);", "'rm']);"],
  ['the stop ending', "const STOP = 'This needs Erick; tell the sage-lead and stop this action.';", "const STOP = 'Stop.';"],
  // Simple commands, cd and chains
  ['only the listed variables', 'if (!ENV.has(name)) return', 'if (false) return'],
  ['a variable needs a command after it', "if (!name) return 'a part with no command';", 'if (!name) return null;'],
  ['no variable in front of git', "if (i > 0 && name === 'git') return", 'if (false) return'],
  ['no word that starts with a wildcard', 'if (glob) return how(`the word', 'if (false) return how(`the word'],
  ['only a wildcard at the start of a word', 'w.glob && /^[*?[]/.test(w.text)', 'w.glob'],
  ['the command name is not checked for a wildcard', 'words.slice(i + 1).find(', 'words.slice(i).find('],
  ['a | only into a read-only filter', 'if (seg.pipe && !PIPE.has(into)) return', 'if (false) return'],
  ['a | into a file reader names its file form (G64 A)', '${READERS.has(into) ?', '${false ?'],
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
  ['a file tool: each string on its own (F-T133-42)', 'const all = strings(i);', "const all = [['', JSON.stringify(i)]];"],
  ['a file tool: the strings of nested objects are walked', 'for (const e of Object.entries(v)) stack.push(e);', 'if (v === input) for (const e of Object.entries(v)) stack.push(e);'],
  // The walk before F-T133-50: a recursion, which overflowed the stack at a nesting of about 3000.
  ['a file tool: the walk needs no stack depth (F-T133-50)', 'function strings(input) {\n', "function strings(input) {\n  if (input) return (function walk(v, key = '') { return typeof v === 'string' ? [[key, v]] : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => walk(x, k)) : []; })(input);\n"],
  ['a file tool: a path is printable ASCII', "if (all.some(([k, v]) => k.endsWith('path') && !ASCII.test(v))) return", 'if (false) return'],
  ['SendMessage is allowed', ' SendMessage: allow,', ''],
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
  ['an input that is not a tool call', "if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) {", 'if (!input) {'],
  ['an input that is not a tool call: an array (F-T133-45)', ' || Array.isArray(input.tool_input)', ''],
  ['a Bash call with no command text (F-T133-45)', "if (typeof command !== 'string') return 'a Bash call with no command text';", ''],
  ['only the listed tools', 'if (!rule) return refusal(`the tool ${say(input.tool_name)}`);', 'if (!rule) return null;'],
  ['no inherited name as a tool', 'Object.hasOwn(TOOLS, input.tool_name) ? TOOLS[input.tool_name] : null', 'TOOLS[input.tool_name]'],
  // F-T133-57 (G46 A, G47 A): the deny must reach Claude Code whole; a JSON cut at 64 KB does not parse, and the call runs.
  ['the hook writes the deny synchronously (F-T133-57)', 'for (let done = 0; done < out.length;) done += writeSync(1, out, done);', 'process.stdout.write(out);', 'scripts/guard.mjs'],
  // Rows of T133 whose rule text changed in T144
  ['npm: no deploy script', "if (/deploy|release|publish/i.test(script ?? '')) return", 'if (false) return'],
  ['npm: no option that changes its config', "'--prefer-offline': FLAG };", "'--prefer-offline': FLAG, '--prefix': TEXT, '--script-shell': TEXT };"],
  ['git -C needs a folder', "if (a[0] === '-C' && !a[1]) return null;", ''],
  ['git -C and its folder come before the subcommand', "a = a.slice(a[0] === '-C' ? 2 : 1);", 'a = a.slice(1);'],
  ['git remote: no change', "(args.every((x) => x === '-v' || x === 'origin' || x === 'get-url') ? null", '(true ? null'],
  ['git worktree list takes nothing more', "args[0] === 'list' && (args.length === 1 || (args.length === 2 && args[1] === '--porcelain')) ?", "args[0] === 'list' ?"],
  ['node --version and -v', "  if (version(args)) return null;\n  const ops = options('node'", "  const ops = options('node'"],
  ['npm --version and -v (F-T133-71)', "  if (version(args)) return null;\n  const k = args.indexOf('--');", "  const k = args.indexOf('--');"],
  ['npm version gets the hint to npm --version (F-T133-71)', "  if (sub === 'version') return how('npm version (it can change package.json)', 'npm --version, to print the version of npm');\n", ''],
  ['the state tool: a wildcard folded', 'const g = fold(glob);', 'const g = glob;'],
  ['the state tool: a * at the end matches nothing (F-T133-62)', "  while (g[i] === '*') i++;\n", ''],
  ['the hook: the rules run in a worker thread (F-T133-62)', "new Worker(new URL(import.meta.url), { workerData: Buffer.concat(chunks).toString('utf8'), stdout: true, stderr: true }).on('message', answer);", "import('../src/guard.js').then((m) => answer(m.decideText(Buffer.concat(chunks).toString('utf8'), process.env)));", 'scripts/guard.mjs'],
  ['the state tool: the wildcards are checked', 'return /[*?]/.test(chars) && mayMatchStateTool(text, env, pathspec) ?', 'return false ?'],
  ['git: its operands are patterns (F-T133-46)', "return typeof ops === 'string' ? ops : patterns(ops ?? [], env, true);", "return typeof ops === 'string' ? ops : null;"],
  ['node --test: its operands are patterns (F-T133-46)', 'const why = test ? patterns(ops, env, false) : null;', 'const why = null;'],
  ['a quoted * or ? in a pattern operand can match the state tool (F-T133-46)', 'const why = wildcard(op, op, env, true, pathspec);', "const why = wildcard(op, '', env, true, pathspec);"],
  ['the state tool: wildcards of git', "'mv', 'git', 'tee',", "'mv', 'tee',"],
  ['the state tool: wildcards of tee', "'git', 'tee', 'uniq']);", "'git', 'uniq']);"],
  ['the state tool: the Write tool', "Write: file('file_path'),", 'Write: allow,'],
  ['the state tool: the Edit tool', "Edit: file('file_path'), MultiEdit", 'Edit: allow, MultiEdit'],
  ['the state tool: the MultiEdit tool', "MultiEdit: file('file_path'),", 'MultiEdit: allow,'],
  ['the state tool: the NotebookEdit tool', "NotebookEdit: file('notebook_path'),", 'NotebookEdit: allow,'],
  ['a file tool without the name is allowed', 'if (namesStateTool(all.map(([, v]) => v), env)) return STATE_TOOL;', 'return STATE_TOOL;'],
  ['a file tool: the state tool is checked', '  if (namesStateTool(all.map(([, v]) => v), env)) return STATE_TOOL;\n', ''],
  ['EnterWorktree: no name is allowed (F-T144-L13)', 'EnterWorktree: (i) => (i.name === undefined || ', 'EnterWorktree: (i) => ('],
  ['a refusal cuts each word it echoes (F-T133-57)', 'text.slice(0, 200).replace(', 'text.replace('],
  // F-T134-5: the deadline runs while the hook reads stdin.
  ['the hook: the deadline starts before stdin is read (F-T134-5)', "    setTimeout(() => answer(refusal(`a tool call that the guard did not decide in ${DEADLINE_MS / 1000} s`)), DEADLINE_MS);\n    // stdin is read as a stream, so that the deadline above runs while it waits (a synchronous read blocked the timer).\n    const chunks = [];\n    process.stdin.on('data', (c) => chunks.push(c)).on('error', fail).on('end', () => {\n", "    const chunks = [];\n    process.stdin.on('data', (c) => chunks.push(c)).on('error', fail).on('end', () => {\n    setTimeout(() => answer(refusal(`a tool call that the guard did not decide in ${DEADLINE_MS / 1000} s`)), DEADLINE_MS);\n", 'scripts/guard.mjs'],
  ['the hook: stdin is read as a stream (F-T134-5)', "    process.stdin.on('data', (c) => chunks.push(c)).on('error', fail).on('end', () => {\n", "    chunks.push((await import('node:fs')).readFileSync(0)); (() => {\n", 'scripts/guard.mjs'],
  // F-T144-M1 (G63 b): the Keychain front ends.
  ['the Keychain front ends are refused (G63 b)', 'if (KEYCHAIN.has(basename(fold(name)))) return', 'if (false) return'],
  ['a Keychain front end by any path (G63 b)', 'KEYCHAIN.has(basename(fold(name)))', 'KEYCHAIN.has(fold(name))'],
  ['security is a Keychain front end (G63 b)', "new Set(['security', ", 'new Set(['],
  ['osascript is a Keychain front end (G63 b)', "'security', 'osascript', ", "'security', "],
  ['osacompile is a Keychain front end (G63 b)', ", 'osacompile']);", ']);'],
  // F-T144-5: dangerouslyDisableSandbox, git remote show, git branch -u, git reset.
  ['Bash: no dangerouslyDisableSandbox field (F-T144-5)', "(Object.hasOwn(i, 'dangerouslyDisableSandbox') ?", '(false ?'],
  ['git remote show gets the hint to git remote -v (F-T144-5)', "args[0] === 'show' ? how('git remote show (it asks the remote over the network)', 'git remote -v') : ", ''],
  ['git branch: no -u (F-T144-5)', "'--show-current': FLAG, '--contains': TEXT })", "'--show-current': FLAG, '-u': TEXT, '--set-upstream-to': TEXT, '--contains': TEXT })"],
  ['git reset gets the hint to git restore (F-T144-5)', "  reset: () => how('git reset',", "  reset_: () => how('git reset',"],
  ['git --version (F-T144-5)', "  if (version(args)) return null;\n  const a = gitArgs(args);", '  const a = gitArgs(args);'],
  // F-T144-6: the read options of rg, node --test, git diff, git log, find.
  ['a short option takes its text value joined (F-T144-6)', '    if (a.length > 2 && table[a.slice(0, 2)] === TEXT) continue;\n', ''],
  ['a joined value only for an option with a text value (F-T144-6)', 'table[a.slice(0, 2)] === TEXT) continue;', 'table[a.slice(0, 2)] !== undefined) continue;'],
  ['an option alone takes no joined value (F-T144-6)', 'if (a.length > 2 && table[a.slice(0, 2)]', 'if (table[a.slice(0, 2)]'],
  ['rg --hidden (F-T144-6)', "'--hidden': FLAG, ", ''],
  ['node --test-only (F-T144-6)', ", '--test-only': FLAG };", ' };'],
  ['git diff --word-diff (F-T144-6)', ", '--word-diff': FLAG }),", ' }),'],
  ['git log --all (F-T144-6)', "log: gitCmd({ '--all': FLAG, ", 'log: gitCmd({ '],
  ['find -size (F-T144-6)', "'-size': TEXT, ", ''],
  // F-T144-L1: a non-ASCII character gets the safe form.
  ['a non-ASCII character gets the hint to git commit -F (F-T144-L1)', "how('a character that is not printable ASCII in a part that runs or writes', ASCII_SAFE)", "'a character that is not printable ASCII in a part that runs or writes'"],
  // F-T144-L2, L3, L4: node runs only a script file; npm test -- goes to node --test.
  ['node: a script file ends in .js, .mjs or .cjs (F-T144-L2)', 'return odd === undefined ? ops :', 'return true ? ops :'],
  ['node: the extension ends the name (F-T144-L2)', '!/\\.[cm]?js$/.test(p)', '!/\\.[cm]?js/.test(p)'],
  ['node --test: each file ends in .js, .mjs or .cjs (F-T144-L2)', '(test ? ops : ops.slice(0, 1)).find((p) => !/', 'ops.slice(0, 1).find((p) => !/'],
  ['npm: the words after -- go to node --test (F-T144-L4)', "return k < 0 ? null : node(['--test', ...args.slice(k + 1)], env);", 'return null;'],
  // F-T144-L5: a git pathspec * crosses a /.
  ['a git pathspec * also matches a / (F-T144-L5)', 'patterns(ops ?? [], env, true)', 'patterns(ops ?? [], env, false)'],
  ['a git pathspec: its text after the last * ends the path (F-T144-L5)', ".slice(-name.length)}`, name)", '}`, name)'],
  // F-T144-L6: stash@{0}.
  ['a stash name is no pattern (F-T144-L6)', '    if (/^stash@\\{\\d+\\}$/.test(op)) continue;\n', ''],
  ['an unquoted stash name gets the quoted form (F-T144-L6)', '/(^|\\s)stash@\\{/.test(command) ? ', 'false ? '],
  // F-T144-L7: git grep, rev-list, merge-base, npm i, a file tool's text path.
  ['git grep gets the hint to rg (F-T144-L7)', "  grep: () => how('git grep', 'rg -n <pattern> <folder>'),\n", ''],
  ['git rev-list (F-T144-L7)', "  'rev-list': gitCmd(", "  'rev-list_': gitCmd("],
  ['git merge-base (F-T144-L7)', "  'merge-base': gitCmd(", "  'merge-base_': gitCmd("],
  ['npm: the subcommand is checked before the options (F-T144-L7)', "  const ops = options('npm', own, NPM);\n  if (typeof ops === 'string') return ops;\n", ''],
  ['a file tool names its file in its text path key (F-T144-L7)', "if (typeof i[key] !== 'string' || !i[key]) return", 'if (false) return'],
  ['a file tool: an empty path is no path (F-T144-L7)', " || !i[key]) return", ') return'],
  ['NotebookEdit: its path key is notebook_path (F-T144-L7)', "NotebookEdit: file('notebook_path')", "NotebookEdit: file('file_path')"],
  // F-T144-L8: /dev/tcp, --pretty "%h".
  ['a redirect under /dev/ only to /dev/null (F-T144-L8)', 'if (dev) return `a redirect to', 'if (false) return `a redirect to'],
  ['a redirect: /dev/null is allowed (F-T144-L8)', " && posix.normalize(fold(w.text)) !== '/dev/null'", ''],
  ['a redirect: /dev/ is folded and normalized (F-T144-L8)', 'DEV.test(posix.normalize(fold(w.text)))', 'DEV.test(w.text)'],
  ['a redirect: /dev/ reached with .. (F-T144-L8)', 'const DEV = /^(\\/|(\\.\\.\\/)+)dev(\\/|$)/;', 'const DEV = /^(\\/)dev(\\/|$)/;'],
  ['git --pretty with its value in the next word gets the = form (F-T144-L8)', "if (kind === EQ && eq < 0 && args[i + 1]?.includes('%')) return", 'if (false) return'],
  // F-T144-L9: git --no-pager.
  ['git --no-pager (F-T144-L9)', "while (a[0] === '-C' || a[0] === '--no-pager') {", "while (a[0] === '-C') {"],
  // F-T144-L10: grep -r, npx, the variables, stash -u, worktree list --porcelain, uniq, =word, settings by name.
  ['grep -r gets the hint to rg (F-T144-L10)', 'rg -n <pattern> <folder> to search a folder, or give grep', 'give grep'],
  ['npx gets the hint to npm run (F-T144-L10)', "  npx: () => how('npx (it runs any package)', 'npm run <script>, a script of package.json'),\n", ''],
  ['a variable in front gets the list of the allowed ones (F-T144-L10)', "return how(`setting ${say(name)} in front of a command`, `set only ${[...ENV].join(', ')} in front of a command`);", 'return `setting ${say(name)} in front of a command`;'],
  ['git stash -u (F-T144-L10)', ", '-u': FLAG, '--include-untracked': FLAG });", ' });'],
  ['git worktree list --porcelain (F-T144-L10)', " || (args.length === 2 && args[1] === '--porcelain')", ''],
  ['uniq writes (F-T144-L10)', "'tee', 'uniq']);", "'tee']);"],
  ['zsh =word (F-T144-L10)', "} else if (c === '=' && word === null) throw", '} else if (false) throw'],
  ['settings: .git (F-T144-L10)', "'.claude', '.git', ", "'.claude', "],
  ['settings: .mcp.json (F-T144-L10)', "'.git', '.mcp.json', ", "'.git', "],
  ['settings: .npmrc (F-T144-L10)', ", '.npmrc'];", '];'],
  ['settings: .claude (F-T133-72)', "const CONFIG_NAMES = ['.claude', ", 'const CONFIG_NAMES = ['],
  // F-T133-72 and F-T144-L14, L15, L16: the settings rule.
  ['a file tool: no write to a settings path (F-T133-72)', '  return dir ? CONFIG(dir[1]) : null;', '  return null;'],
  ['Bash: no write to a settings path (F-T133-72)', '  if (dir) return CONFIG(dir.text);\n', ''],
  ['settings: the redirect targets (F-T133-72)', 'const targets = [...parsed.flatMap((seg) => seg.redirects), ', 'const targets = ['],
  ['settings: the words of a part that writes (F-T133-72)', ', ...parsed.filter(writes).flatMap((seg) => seg.words)];', '];'],
  ['settings: touch, mkdir, rm and rmdir write (F-T133-72)', '(WRITES.has(name) || CHANGES.has(name))', 'WRITES.has(name)'],
  ['settings: the path is folded (.CLAUDE) (F-T133-72)', 'posix.normalize(fold(text))', 'posix.normalize(text)'],
  ['settings: the path is normalized (F-T144-L15)', 'posix.normalize(fold(text)).replace', 'fold(text).replace'],
  ['settings: only a path key of a file tool (F-T133-72)', "all.find(([k, v]) => k.endsWith('path') && configPath(", 'all.find(([k, v]) => configPath('],
  ['settings: a cd folder counts (F-T144-L14)', "...parsed.filter((seg) => seg.words[0]?.text === 'cd').flatMap((seg) => seg.words.slice(1)), ", ''],
  ['settings: a wildcard part that starts with . (F-T144-L14)', "(/[*?]/.test(p) && p.startsWith('.') ? matches(p, name) : p === name)", '(p === name)'],
  ['settings: a git read writes nothing (F-T144-L14)', " && !(name === 'git' && GIT_READS.has(gitArgs(args)?.[0]))", ''],
  ['settings: a worktree under .claude/worktrees is a work folder (F-T144-L15)', ".replace(WORKTREE, '$1w')", ''],
  ['settings: a part after an = (F-T144-L15)', '.split(/[/=]/);', ".split('/');"],
  ['settings: the session folder counts (F-T144-L16)', ", { text: String(cwd ?? '') });", ');'],
  ['settings: a relative path starts in the session folder (F-T144-L16)', "configPath(v.startsWith('/') ? v : `${cwd ?? ''}/${v}`)", 'configPath(v)'],
  // F-T144-L13: EnterWorktree, WebFetch, jq env, the zsh number range, the two-digit fd.
  ['EnterWorktree takes a plain name (F-T144-L13)', '/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(i.name)', '/^[A-Za-z0-9._/-]+$/.test(i.name)'],
  ['WebFetch takes a text URL (F-T144-L13)', "(typeof i.url === 'string' ? webRefusal(i.url) : 'a fetch with no text URL')", 'webRefusal(i.url)'],
  ['jq: no env (F-T144-L13)', "/(^|[^.\\w$])env\\b|\\$ENV\\b/.test(ops[0] ?? '') ?", 'false ?'],
  ['jq: a field named env is no env (F-T144-L13)', '/(^|[^.\\w$])env\\b|', '/\\benv\\b|'],
  ['npm help gets the hint to the npm docs (F-T144-L13)', "  if (sub === 'help') return how(", "  if (sub === 'help_') return how("],
  ['git shortlog (F-T144-L13)', '  shortlog: gitCmd(', '  shortlog_: gitCmd('],
  ['a zsh number range <n-m> (F-T144-5)', 'if (/^<\\d*-\\d*>/.test(command.slice(i, i + 42))) throw', 'if (false) throw'],
  ['a number of two digits before a redirect (F-T144-L13)', 'if (word && /^\\d\\d+$/.test(word.text)) throw', 'if (false) throw'],
  // F-T144-L17: an echoed word shows only printable ASCII.
  ['an echoed word: each character that is not printable ASCII as its escape (F-T144-L17)', ".replace(/[^\\x20-\\x7e]/g, (c) => `\\\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)", ''],
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

/** Runs a copy of the guard with `file` as `source`: 'broken' when it fails the known-good calls, else the tests' exit code. */
async function run(name, source, file = 'src/guard.js') {
  const dir = join(work, name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) + Math.random().toString(36).slice(2, 6));
  for (const f of ['package.json', 'test/guard.test.js', 'test/guard-corpus.json']) cpSync(join(ROOT, f), join(dir, f));
  for (const [f, text] of Object.entries({ ...SOURCES, [file]: source })) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  if (await node([join(work, 'check.mjs'), join(dir, 'src', 'guard.js')], dir) !== 0) return 'broken';
  return node(['--test', 'test/guard.test.js'], dir);
}

const stale = MUTATIONS.filter(([, from, , file = 'src/guard.js']) => SOURCES[file].split(from).length !== 2);
for (const [name, from, , file = 'src/guard.js'] of stale) console.log(`STALE  ${name}: its text is not in ${file} exactly once: ${JSON.stringify(from)}`);
const start = Date.now();
const unmutated = await run('unmutated', SOURCES['src/guard.js']);
if (unmutated !== 0) console.log(`FAIL   the unmutated guard: ${unmutated === 'broken' ? 'it refuses a known-good call' : 'its tests fail'}`);
const survivors = [];
const broken = [];
const timeouts = [];
const queue = MUTATIONS.filter((m) => !stale.includes(m));
await Promise.all(Array.from({ length: Math.max(2, availableParallelism() - 1) }, async () => {
  for (let m = queue.shift(); m; m = queue.shift()) {
    const [name, from, to, file = 'src/guard.js'] = m;
    // A function, so that a $ in the new text is taken as it is ($` and $& are patterns of replace).
    const result = await run(name, SOURCES[file].replace(from, () => to), file);
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
