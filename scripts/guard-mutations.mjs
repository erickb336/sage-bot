// The mutation check of the guard (T133): npm run check:guard-mutations.
// For each rule of src/guard.js, it makes a copy of the guard with that one rule removed, and runs test/guard.test.js
// against the copy. Each removal must make at least one test fail; a removal that passes is a rule that no test pins.
// A removal must keep the guard working: the copy must load and still allow the known-good calls (pwd, a Read of a worktree
// file, git status). A copy that does not is a broken mutation: its test failures prove nothing, so it is reported, not
// counted as a kill. It prints one line for each surviving, broken or stale mutation and the counts, and exits 1 when there
// is any (stale: the rule's text is not found exactly once in src/guard.js, so this list is out of date).
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
  ['a wildcard is marked as one', 'add(c, true); i++;', 'add(c); i++;'],
  ['~ inside a word: after a letter or digit', "!/[A-Za-z0-9_]$/.test(word.text) || ", ''],
  ['~ inside a word: before a digit or the end', " || !/^~(\\d|$|[\\s&|])/.test(rest)", ''],
  ['~ at the start of a word: ~ or ~/ only', ": !/^~(\\/|$|[\\s&|])/.test(rest)) throw", ': false) throw'],
  // The parser's main defence: every other character outside quotes ($, backtick, (, {, \, newline, non-ASCII) is refused.
  ['characters outside quotes', "} else throw c === '\\n' || c === '\\r' ? 'a newline outside quotes' : `the character ${JSON.stringify(c)} outside quotes`;", '} else { add(c); i++; }'],
  // Paths
  ['secret names after a revision colon', '(^|[/:])(\\.env', '(^|[/])(\\.env'],
  ['.env.example, .sample, .template are not secrets', '(?!\\.(example|sample|template)(\\/|$))', ''],
  ['.git is secret', '|\\.git|\\.git-credentials', '|\\.git-credentials'],
  ['.gitconfig is secret', '|\\.gitconfig', ''],
  ['.config/git is secret', '\\.config\\/(gh|git|sage-bot)', '\\.config\\/(gh|sage-bot)'],
  ['no write: a file named HEAD', '|(^|\\/)head$/i', '/i'],
  ['no write: sage-hooks', '|\\.mcp\\.json|sage-hooks)', '|\\.mcp\\.json)'],
  ['no write: Claude Code settings', '(\\.claude\\/settings[^/]*\\.json|', '('],
  ["no write: the hook's own files", ' || SELF.includes(p)', ''],
  ['a read of a secret', 'if (SECRET.test(p)) return `reading', 'if (false) return `reading'],
  ['a write of a secret', 'if (SECRET.test(p)) return `writing', 'if (false) return `writing'],
  ['reads only in the three folders', 'if (within(p, worktree) || within(p, scratch) || (repo && within(p, repo))) return null;', 'return null;'],
  ['writes only in the two folders', 'if ([worktree, scratch].some((r) => within(p, r) && !(strict && p === r))) return null;', 'return null;'],
  ['rm never removes a folder itself', ' && !(strict && p === r)', ''],
  ['/dev/null is a write that is allowed', "if (path === '/dev/null') return null;", ''],
  ['the worktree and scratch must not be /', " || worktree === '/' || scratch === '/'", ''],
  ['~ is the home folder', "p === '~' ? ctx.folders.home : ", ''],
  ['~/x is in the home folder', "p.startsWith('~/') ? ctx.folders.home + p.slice(1) : p", 'p'],
  // The folder walk
  ['the walk stops when the budget runs out', 'if (--ctx.walk.left < 0) return', 'if (--ctx.walk.left < -1e9) return'],
  ['one budget for all the walks of a call', 'const root = physical(path, ctx.cwd);\n  const stack', 'const root = physical(path, ctx.cwd); ctx.walk.left = WALK_MAX;\n  const stack'],
  ["the walk skips a worktree's .git file", "if (e.name === '.git' && e.isFile()) continue;", ''],
  ['the walk finds secret files', 'const bad = SECRET.test(p) ||', 'const bad = false ||'],
  ['the walk of a copy finds a file named HEAD', '(copy && /^head$/i.test(e.name)) || ', ''],
  ['the walk finds links out of the folders', ' || (e.isSymbolicLink() && readRefusal(p, ctx))', ''],
  ['the walk skips node_modules', " && e.name !== 'node_modules') stack.push(p);", ') stack.push(p);'],
  ['the walk goes into subfolders', "if (e.isDirectory() && e.name !== 'node_modules') stack.push(p);", ''],
  ['the checks stop at the first refusal', 'const first = (list, check) => { for (const x of list) { const why = check(x); if (why) return why; } return null; };', 'const first = (list, check) => list.map(check).find(Boolean) ?? null;'],
  // Options: each must be an entry of its command's table by its full spelling
  ['an option must be an entry of the table', 'if (kind === undefined || (kind === FLAG && eq >= 0)) {', 'if (false) {'],
  ['a flag takes no =value', ' || (kind === FLAG && eq >= 0)', ''],
  ['-- ends the options only when the table has it', "if (a === '--' && Object.hasOwn(table, '--'))", "if (a === '--')"],
  ['a number option only when the table has it', 'if (/^-\\d+$/.test(a) && Object.hasOwn(table, NUM))', 'if (/^-\\d+$/.test(a))'],
  ['node: the options end at the script', ' || (posix && ops.length)', ''],
  ['an option with a value needs one', 'if (value === undefined) return', 'if (false) return'],
  ['an option with a list takes only its values', '(kind.includes(value) ? null :', '(true ? null :'],
  ['an option value that is a path is a read', 'kind === READ ? readRefusal(expandHome(value, ctx), ctx)', 'kind === READ ? null'],
  ['an option value that is a body file is checked', 'kind === BODY ? bodyRefusal(value, ctx)', 'kind === BODY ? null'],
  ['a body file is a read', 'const bodyRefusal = (f, ctx) => (readRefusal(expandHome(f, ctx), ctx) || ', 'const bodyRefusal = (f, ctx) => ('],
  ['a body file only from scratch', ' || !within(physical(expandHome(f, ctx), ctx.cwd), ctx.folders.scratch)', ''],
  // Operands of the commands
  ['a content read takes no folder', '(folder === undefined ? null : how(', '(true ? null : how('],
  ['a content read checks each path', 'return reads(ops, ctx) ?? (folder', 'return null ?? (folder'],
  ['grep and rg: -e gives the pattern', "(opts.some(([o]) => o === '-e') ? ops : ops.slice(1))", 'ops.slice(1)'],
  ['rg: at least one file', 'return named.length && named.every(', 'return named.every('],
  ['rg: only existing files', " && named.every((p) => kindOf(p, ctx) === 'file') ?", ' ?'],
  ['ls: each path is a read', "'-t': FLAG, '-F': FLAG }, reads),", "'-t': FLAG, '-F': FLAG }),"],
  ['cat: each file is a content read', "cat: cmd({ '-n': FLAG }, files),", "cat: cmd({ '-n': FLAG }),"],
  ['head: each file is a content read', "head: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }, files),", "head: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }),"],
  ['tail: each file is a content read', "tail: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }, files),", "tail: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }),"],
  ['wc: each file is a content read', "'-m': FLAG }, files),", "'-m': FLAG }),"],
  ['diff: each file is a content read', "diff: cmd({ '-u': FLAG, '-q': FLAG }, files),", "diff: cmd({ '-u': FLAG, '-q': FLAG }),"],
  ['cut: each file is a content read', "'-c': TEXT }, files),", "'-c': TEXT }),"],
  ['jq: each file is a content read', '(ops, ctx) => files(ops.slice(1), ctx)),', '() => null),'],
  ['sort: each file is a content read', "'-k': TEXT, '-t': TEXT }, files),", "'-k': TEXT, '-t': TEXT }),"],
  ['uniq: no output file', "(ops.length > 1 ? 'uniq", "(false ? 'uniq"],
  ['uniq: the file is a content read', ': files(ops, ctx))),\n  // grep', ': null)),\n  // grep'],
  ['grep: each file is a content read', '(ops, ctx, opts) => files(searched(ops, opts), ctx)),', '() => null),'],
  ['file: each path is a read', 'file: cmd({}, reads)', 'file: cmd({})'],
  ['stat: each path is a read', 'stat: cmd({}, reads)', 'stat: cmd({})'],
  ['du: each path is a read', "'-sh': FLAG }, reads)", "'-sh': FLAG })"],
  ['realpath: each path is a read', 'realpath: cmd({}, reads)', 'realpath: cmd({})'],
  ['test: each path is a read', 'test: cmd(TEST, reads)', 'test: cmd(TEST)'],
  ['[: each path is a read', "'[': cmd(TEST, reads)", "'[': cmd(TEST)"],
  ['mkdir: each path is a write', "mkdir: cmd({ '-p': FLAG }, writes)", "mkdir: cmd({ '-p': FLAG })"],
  ['touch: each path is a write', 'touch: cmd({}, writes)', 'touch: cmd({})'],
  ['rmdir: each path is a write', 'rmdir: cmd({}, writes)', 'rmdir: cmd({})'],
  ['cp: each path is a write', "'-p': FLAG }, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),", "'-p': FLAG }, (ops, ctx) => walks(ops, ctx, true)),"],
  ['cp of a folder walks it', "'-p': FLAG }, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),", "'-p': FLAG }, (ops, ctx) => writes(ops, ctx)),"],
  ['mv: each path is a write', "mv: cmd({}, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),\n  rm: cmd({ '-r'", "mv: cmd({}, (ops, ctx) => walks(ops, ctx, true)),\n  rm: cmd({ '-r'"],
  ['mv of a folder walks it', "mv: cmd({}, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),\n  rm: cmd({ '-r'", "mv: cmd({}, (ops, ctx) => writes(ops, ctx)),\n  rm: cmd({ '-r'"],
  ['rm: each path is a write', '(ops, ctx) => writes(ops, ctx, true)),', '() => null),'],
  ['rm: the folder itself is not a target', '(ops, ctx) => writes(ops, ctx, true)),', '(ops, ctx) => writes(ops, ctx)),'],
  ['find: each path is a read', "'-empty': FLAG }, reads),", "'-empty': FLAG }),"],
  ['npm: only the listed commands', 'if (!NPM_RUN.has(sub)) return', 'if (false) return'],
  ['npm: no deploy script', "return /deploy|release|publish/i.test(script ?? '') ?", 'return false ?'],
  // git
  ['git -C only into a folder of the session', 'if (why) return `git -C: ${why}`;', ''],
  ['git: only the listed subcommands', 'if (!rule) return `git ${sub', 'if (!rule) return null && `git ${sub'],
  ['git: no inherited name as a subcommand', "Object.hasOwn(GIT, sub ?? '') ? GIT[sub] : null", 'GIT[sub]'],
  ['git read commands: each path is a read', "const gitRead = (table) => cmd({ ...table, '--': FLAG }, reads);", "const gitRead = (table) => cmd({ ...table, '--': FLAG });"],
  ['git add: only after -- and with file names', "if (args[0] !== '--' || args.length < 2) return how(", 'if (false) return how('],
  ['git add: no pattern character', 'if (/[*?[\\]\\\\:]/.test(f)) return', 'if (false) return'],
  ['git add: each path is a write', 'if (why) return `git add: ${why}`;', ''],
  ['git add: only existing files', "if (kindOf(f, ctx) !== 'file') return how(`git add of", 'if (false) return how(`git add of'],
  ['git rm: each path is a write', "rm: cmd({ '--cached': FLAG, '-r': FLAG, '-q': FLAG, '--': FLAG }, writes),", "rm: cmd({ '--cached': FLAG, '-r': FLAG, '-q': FLAG, '--': FLAG }),"],
  ['git mv: each path is a write', 'mv: cmd({}, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),\n  restore', 'mv: cmd({}, (ops, ctx) => walks(ops, ctx, true)),\n  restore'],
  ['git mv of a folder walks it', 'mv: cmd({}, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),\n  restore', 'mv: cmd({}, (ops, ctx) => writes(ops, ctx)),\n  restore'],
  ['git restore: each path is a write', "'-W': FLAG, '--': FLAG }, writes),", "'-W': FLAG, '--': FLAG }),"],
  ['git commit: no file names', "(ops) => (ops.length ? how('git commit with file names", "(ops) => (false ? how('git commit with file names"],
  ['git fetch: only from origin', "ops[0] === 'origin' && ", ''],
  ['git fetch: branch names only', ' && ops.slice(1).every((r) => /^[A-Za-z0-9._/-]+$/.test(r))', ''],
  ['git checkout: each path is a write', "checkout: cmd({ '-b': TEXT }, writes),", "checkout: cmd({ '-b': TEXT }),"],
  ['git stash: only the listed subcommands', "(['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0])", '(true'],
  ['git remote: no change', "(args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null", '(true ? null'],
  ['git worktree: only add and list', ': `git worktree ${args[0]', ': null && `git worktree ${args[0]'],
  ['git worktree add: the path is a write', "cmd({ '-b': TEXT }, writes)(args.slice(1)", "cmd({ '-b': TEXT })(args.slice(1)"],
  ['git push: needs SAGE_BRANCH', 'if (!mine || PROTECTED.test(mine)', 'if (PROTECTED.test(mine)'],
  ['git push: SAGE_BRANCH is not protected', '|| PROTECTED.test(mine) ', ''],
  ['git push: SAGE_BRANCH is a plain name', ' || !/^[A-Za-z0-9._/-]+$/.test(mine)) return', ') return'],
  ['git push: only to origin', "remote !== 'origin' || ", ''],
  ['git push: one target only', 'more.length || ', ''],
  ['git push: only the own branch', '![mine, `HEAD:${mine}`].includes(ref)) return', 'false) return'],
  // gh
  ['gh: only the listed commands', 'if (!Object.hasOwn(GH, sub)) return `gh ${sub}`.trim();', 'if (!Object.hasOwn(GH, sub)) return null;'],
  ['gh: the options of each command', "return typeof r === 'string' ? r : null;\n}", 'return null;\n}'],
  // node
  ['node --version and -v', "if (args.length === 1 && ['--version', '-v'].includes(args[0])) return null;", ''],
  ['node --version takes nothing after it', 'if (args.length === 1 && ', 'if ('],
  ['node: only the listed options', "if (typeof r === 'string') return r;\n  const test", "if (typeof r === 'string') return null;\n  const test"],
  ['node: a script file is needed', "return test ? null : 'node with no script file (code from stdin)';", 'return null;'],
  ['the sage state tool: only the listed commands', 'SAGE_TOOL.has(rest[0]) && ', ''],
  ['the sage state tool: no standing add', " && !(rest[0] === 'standing' && rest[1] === 'add')", ''],
  ['node: only .js, .mjs and .cjs', 'if (!/\\.(m|c)?js$/.test(script) && !test) return', 'if (false) return'],
  ['node: the script is a read', 'return reads(test ? r.ops : [script], ctx);', 'return null;'],
  // Simple commands, cd and chains
  ['redirects are reads and writes', '    if (why) return why;\n  }\n  const texts', '  }\n  const texts'],
  ['HOME and TMPDIR only to a folder of the session', 'const why = writeRefusal(value, ctx); if (why) return `${name}=: ${why}`;', ''],
  ['only the listed variables', 'else if (!ENV_ANY.has(name)) return', 'else if (false) return'],
  ['no variable in front of git or gh', "if (i > 0 && (cmd === 'git' || cmd === 'gh')) return", 'if (false) return'],
  ['the command name is not a wildcard', 'words.slice(i + 1).filter((w) => w.glob)', 'words.slice(i).filter((w) => w.glob)'],
  ['a wildcard only for the listed commands', '(!GLOBS.has(cmd) || globs.some(', '(false || globs.some('],
  ['no wildcard after a dot', ' || globs.some((w) => /(^|\\/)\\.[^/]*[*?[]/.test(w.text))', ''],
  ['a wildcard of a content read walks its folder', 'return walked ?? COMMANDS[cmd](args, ctx, cmd);', 'return COMMANDS[cmd](args, ctx, cmd);'],
  ['ls with a wildcard walks nothing', "cmd === 'ls' ? null : walks(", 'walks('],
  ['only the listed commands', 'if (!Object.hasOwn(COMMANDS, cmd)) return `the command ${cmd}`;', 'if (!Object.hasOwn(COMMANDS, cmd)) return null;'],
  ['cd: one folder, no option', "if (args.length !== 1) return how('cd with no folder", "if (false) return how('cd with no folder"],
  ['cd: only into an existing folder', "if (kindOf(to, ctx) !== 'folder' || ", 'if ('],
  ['cd: only into the worktree or scratch', ' || ![ctx.folders.worktree, ctx.folders.scratch].some((r) => within(to, r))', ''],
  ['a | only into a read-only filter', 'if (seg.pipe && !PIPE.has(commandOf(texts)[0])) return', 'if (false) return'],
  ['a part that changes files ends the chain', 'if (k < parsed.length - 1 && changesFiles(', 'if (false && changesFiles('],
  ['cp and mv change files', "if (cmd === 'cp' || cmd === 'mv') return true;", ''],
  ['git stash changes files', " || (a[0] === 'stash' && !['list', 'show'].includes(a[1]))", ''],
  ['git -C before a change of files', "while (a[0] === '-C') a = a.slice(2);", ''],
  // The other tools
  ['Grep: a glob or a type narrows the search', '(i.glob && narrow(i.glob)) || TYPES.has(i.type) ? null :', 'false ? null :'],
  ['Grep: a narrowing type', ' || TYPES.has(i.type)', ''],
  ['Grep: a narrow glob ends with an extension', '/\\.[A-Za-z0-9]+$/.test(g) && ', ''],
  ['Grep: a narrow glob names no secret', " && !SECRET.test(g.replaceAll('*', ''))", ''],
  ['Grep: a glob with braces is each of its names', "const all = alts.length === 3 ? alts[1].split(',').map((x) => alts[0] + x + alts[2]) : [glob];", 'const all = [glob];'],
  ['Glob: the pattern is checked', 'Glob: (i, ctx) => globRefusal(i.pattern) ??', 'Glob: (i, ctx) =>'],
  ['Glob: the path is a read', 'globRefusal(i.pattern) ?? readRefusal(i.path ?? ctx.cwd, ctx),', 'globRefusal(i.pattern),'],
  ['Grep: the glob is checked', "Grep: (i, ctx) => globRefusal(i.glob ?? '') ??", 'Grep: (i, ctx) =>'],
  ['Grep: the path is a read', '?? readRefusal(i.path ?? ctx.cwd, ctx) ?? ((i.glob', '?? ((i.glob'],
  ['a pattern from / or ~, with .. or .*', 'if (/^[/~]|(^|\\/)\\.\\.(\\/|$)|\\.\\*/.test(pattern)) return', 'if (false) return'],
  ['a pattern that names secrets', 'return SECRET.test(pattern) ? `the pattern', 'return false ? `the pattern'],
  ['Read is a read', 'Read: (i, ctx) => readRefusal(i.file_path, ctx),', 'Read: () => null,'],
  ['Write is a write', 'Write: (i, ctx) => writeRefusal(i.file_path, ctx),', 'Write: () => null,'],
  ['Edit is a write', 'Edit: (i, ctx) => writeRefusal(i.file_path, ctx),\n  Multi', 'Edit: () => null,\n  Multi'],
  ['NotebookEdit is a write', 'NotebookEdit: (i, ctx) => writeRefusal(i.notebook_path, ctx),', 'NotebookEdit: () => null,'],
  ['Skill is allowed', 'Skill: () => null, ', ''],
  ['BashOutput is allowed', 'BashOutput: () => null, ', ''],
  ['KillShell is allowed', 'KillShell: () => null, ', ''],
  ['ExitPlanMode is allowed', 'ExitPlanMode: () => null, ', ''],
  ['WebFetch: http and https only', 'if (!/^https?:$/.test(u.protocol)) return', 'if (false) return'],
  ['WebFetch: no host name without a dot', "if (!host.includes('.') && !ip6) return", 'if (false) return'],
  ['WebFetch: no localhost, .local, .internal', '/(^|\\.)(localhost|local|internal|home\\.arpa)$/.test(host) || ', ''],
  ['WebFetch: no private IPv4 address', ' || private4.test(host)) return', ') return'],
  ['WebFetch: no local IPv6 address', 'if (ip6 && (', 'if (false && ('],
  ['WebFetch: IPv6 brackets', ".replace(/^\\[|\\]$/g, '')", ''],
  ['WebFetch: a trailing dot', ".replace(/\\.$/, '')", ''],
  // The hook input
  ['inert unless SAGE_ORIGIN is lead', "if (env.SAGE_ORIGIN !== 'lead') return null;", ''],
  ['an input over 64 KB', 'if (Buffer.byteLength(text) > MAX_INPUT) return', 'if (false) return'],
  ['an input that is not a tool call', "if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object') {", 'if (!input) {'],
  ['missing folders', 'if (!folders) return refusal(', 'if (false) return refusal('],
  ['only the listed tools', 'if (!rule) return refusal(`the tool ${input.tool_name}`);', 'if (!rule) return null;'],
  ['the input cwd is used', "typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : folders.worktree", 'folders.worktree'],
];

const work = mkdtempSync(join(tmpdir(), 'sage-bot-guard-mutations-'));
// The folders of the walk tests, made once for every run: big/ (20001 empty files) and half/ (10001).
const walk = join(work, 'walk');
for (const [name, n] of [['big', 20001], ['half', 10001]]) {
  mkdirSync(join(walk, name), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(walk, name, `f${i}.txt`), '');
}
// The known-good calls that every mutation must still allow: pwd, a Read of a worktree file, git status.
const sane = join(work, 'sane');
mkdirSync(join(sane, 'wt'), { recursive: true });
mkdirSync(join(sane, 'scratch'));
writeFileSync(join(sane, 'wt', 'README.md'), 'sample\n');
writeFileSync(join(sane, 'check.mjs'), `
const { decide } = await import(process.argv[2]);
const wt = ${JSON.stringify(join(sane, 'wt'))};
const env = { SAGE_ORIGIN: 'lead', SAGE_WORKTREE: wt, SAGE_SCRATCH: ${JSON.stringify(join(sane, 'scratch'))}, HOME: wt };
const calls = [['Bash', { command: 'pwd' }], ['Read', { file_path: wt + '/README.md' }], ['Bash', { command: 'git status' }]];
process.exit(calls.every(([tool_name, tool_input]) => decide({ tool_name, tool_input, cwd: wt }, env) === null) ? 0 : 1);
`);

/** Resolves with the exit code of `node args` in `cwd` (killed after 120 s). */
const node = (args, cwd) => new Promise((done) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, GUARD_TEST_WALK: walk }, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill(), 120_000);
  child.on('close', (code) => { clearTimeout(timer); done(code); });
});

/** Runs a copy of the guard with `source` as src/guard.js: 'broken' when it fails the known-good calls, else the tests' exit code. */
async function run(name, source) {
  const dir = join(work, name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) + Math.random().toString(36).slice(2, 6));
  for (const f of ['package.json', 'scripts/guard.mjs', 'test/guard.test.js', 'test/guard-corpus.json']) cpSync(join(ROOT, f), join(dir, f));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'guard.js'), source);
  if (await node([join(sane, 'check.mjs'), join(dir, 'src', 'guard.js')], dir) !== 0) return 'broken';
  return node(['--test', 'test/guard.test.js'], dir);
}

const stale = MUTATIONS.filter(([, from]) => SOURCE.split(from).length !== 2);
for (const [name, from] of stale) console.log(`STALE  ${name}: its text is not in src/guard.js exactly once: ${JSON.stringify(from)}`);
const start = Date.now();
const unmutated = await run('unmutated', SOURCE);
if (unmutated !== 0) console.log(`FAIL   the unmutated guard: ${unmutated === 'broken' ? 'it refuses a known-good call' : 'its tests fail'}`);
const survivors = [];
const broken = [];
const queue = MUTATIONS.filter((m) => !stale.includes(m));
await Promise.all(Array.from({ length: Math.max(2, availableParallelism() - 1) }, async () => {
  for (let m = queue.shift(); m; m = queue.shift()) {
    const [name, from, to] = m;
    const result = await run(name, SOURCE.replace(from, to));
    if (result === 'broken') broken.push(name);
    else if (result === 0) survivors.push(name);
  }
}));
for (const name of broken) console.log(`BROKEN    ${name}: the copy does not load or refuses a known-good call, so its failures prove nothing`);
for (const name of survivors) console.log(`SURVIVES  ${name}: no test fails without this rule`);
const killed = MUTATIONS.length - stale.length - survivors.length - broken.length;
console.log(`guard mutations: ${killed} of ${MUTATIONS.length} rule removals fail a test; ${survivors.length} survive; ${broken.length} broken; ${stale.length} stale; ${Math.round((Date.now() - start) / 1000)} s`);
rmSync(work, { recursive: true, force: true });
process.exit(survivors.length || broken.length || stale.length || unmutated !== 0 ? 1 : 0);
