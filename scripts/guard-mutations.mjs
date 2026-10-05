// The mutation check of the guard (T133): npm run check:guard-mutations.
// For each rule of src/guard.js, it makes a copy of the guard with that one rule removed, and runs test/guard.test.js
// against the copy. Each removal must make at least one test fail; a removal that passes is a rule that no test pins.
// It prints one line for each surviving rule and the count, and exits 1 when any rule survives or when a rule's text is not
// found exactly once in src/guard.js (then this list is out of date).
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
  ['the redirects <<, <>, <&, >| and <(', " || /^(<<|<>|<&|>\\||<\\()/.test(rest)", ''],
  ['a redirect needs a file', "if (pendingRedirect) throw 'a redirect with no file';", ''],
  ['a wildcard is marked as one', 'add(c, true); i++;', 'add(c); i++;'],
  ['~ inside a word: after a letter or digit', "!/[A-Za-z0-9_]$/.test(word.text) || ", ''],
  ['~ inside a word: before a digit or the end', " || !/^~(\\d|$|[\\s;&|])/.test(rest)", ''],
  ['~ at the start of a word: ~ or ~/ only', ": !/^~(\\/|$|[\\s;&|])/.test(rest)) throw", ': false) throw'],
  ['characters outside quotes', "} else throw c === '\\n'", "} else { add(c); i++; continue; } throw c === '\\n'"],
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
  // The folder walk
  ['the walk stops after WALK_MAX entries', 'if (++n > WALK_MAX) return', 'if (++n < 0) return'],
  ["the walk skips a worktree's .git file", "if (e.name === '.git' && e.isFile()) continue;", ''],
  ['the walk finds secret files', 'const bad = SECRET.test(p) ||', 'const bad = false ||'],
  ['the walk of a copy finds a file named HEAD', '(copy && /^head$/i.test(e.name)) || ', ''],
  ['the walk finds links out of the folders', ' || (e.isSymbolicLink() && readRefusal(p, ctx))', ''],
  ['the walk skips node_modules', " && e.name !== 'node_modules') stack.push(p);", ') stack.push(p);'],
  ['the walk goes into subfolders', "if (e.isDirectory() && e.name !== 'node_modules') stack.push(p);", ''],
  // Arguments
  ['--flag=value is a path', "if (arg.includes('=')) return [arg.slice(arg.indexOf('=') + 1)];", ''],
  ['-fVALUE with a / or ~ is a path', 'return at > 0 ? [arg.slice(at)] : [];', 'return [];'],
  ['~ is the home folder', "p === '~' ? ctx.folders.home : ", ''],
  ['~/x is in the home folder', "p.startsWith('~/') ? ctx.folders.home + p.slice(1) : p", 'p'],
  ['a content read walks a folder', 'readsOf(args, ctx) ?? args.flatMap(pathsIn).map((p) => folderRefusal(', 'readsOf(args, ctx) ?? [].map((p) => folderRefusal('],
  ['a content read checks each path', 'const contentOf = (args, ctx) => readsOf(args, ctx) ??', 'const contentOf = (args, ctx) => null ??'],
  // git
  ['git -C only into a folder of the session', 'if (why) return `git -C: ${why}`;', ''],
  ['git: only the listed subcommands', 'if (!rule) return `git ${sub', 'if (!rule) return null && `git ${sub'],
  ['git: no inherited name as a subcommand', "Object.hasOwn(GIT, sub ?? '') ? GIT[sub] : null", 'GIT[sub]'],
  ['git read commands: --output, --ext-diff, --textconv, --no-index', 'args.some((x) => /^--(output|ext-diff|textconv|no-index)/.test(x))', 'false'],
  ['git read commands: each path is a read', "'an option that writes a file, runs a program or reads outside git' : readsOf(args, ctx))", "'an option that writes a file, runs a program or reads outside git' : null)"],
  ['git add: each path is a write', 'add: (args, ctx) => writesOf(args, ctx) ??', 'add: (args, ctx) => null ??'],
  ['git add -A walks the worktree', '(args.some((x) => /^(-A|--all|--no-ignore-removal)$/.test(x)) ? folderRefusal(topOf(ctx.cwd), ctx) : null) ?? ', ''],
  ['git add of a folder walks it', '?? operands(args).map((p) => folderRefusal(p, ctx)).find(Boolean) ?? null,\n  rm:', '?? null,\n  rm:'],
  ['git rm: each path is a write', 'rm: (args, ctx) => writesOf(args, ctx),\n  mv:', 'rm: () => null,\n  mv:'],
  ['git mv: each path is a write', 'mv: (args, ctx) => writesOf(args, ctx) ?? operands', 'mv: (args, ctx) => null ?? operands'],
  ['git mv of a folder walks it', '?? operands(args).map((p) => folderRefusal(p, ctx, true)).find(Boolean) ?? null,\n  restore', '?? null,\n  restore'],
  ['git restore: each path is a write', 'restore: (args, ctx) => writesOf(args, ctx),', 'restore: () => null,'],
  ['git commit: only the listed options', "only(['-m', '--message', '-a', '--all', '-F', '--file', '-q', '--quiet', '-s', '--signoff', '--allow-empty', '-v'])(args) ?? ", ''],
  ['git commit -F: the file is a read', "readsOf(args.filter((x, i) => ['-F', '--file'].includes(args[i - 1])), ctx)", 'null'],
  ['git fetch: only the listed options', "fetch: (args) => only(['-q', '--quiet', '--prune', '-p'])(args) ??", 'fetch: (args) =>'],
  ['git fetch: only from origin', "operands(args)[0] === 'origin' && ", ''],
  ['git fetch: branch names only', " && operands(args).slice(1).every((r) => /^[A-Za-z0-9._/-]+$/.test(r))", ''],
  ['git switch: only -c', "switch: (args) => only(['-c', '--create'])(args),", 'switch: () => null,'],
  ['git checkout: only -b', "checkout: (args) => only(['-b'])(args),", 'checkout: () => null,'],
  ['git branch: only the listed options', "branch: (args) => only(['-a'", "branch: (args) => (() => () => null)(['-a'"],
  ['git stash: only the listed subcommands', "(['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0])", '(true'],
  ['git stash: only the listed options', "? only(['-m', '--message', '-q', '--quiet', '-p', '--patch', '--stat'])(args) :", '? null :'],
  ['git remote: no change', "(args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null", '(true ? null'],
  ['git worktree: only add and list', "if (args[0] !== 'add') return `worktree", 'if (false) return `worktree'],
  ['git worktree add: only -b', "return only(['-b'])(rest) ?? writesOf(rest", 'return writesOf(rest'],
  ['git worktree add: the path is a write', "?? writesOf(rest.filter((x, i) => !flag(x) && rest[i - 1] !== '-b'), ctx);", '?? null;'],
  ['git push: needs SAGE_BRANCH', "if (!mine || PROTECTED.test(mine)", 'if (PROTECTED.test(mine)'],
  ['git push: SAGE_BRANCH is not protected', '|| PROTECTED.test(mine) ', ''],
  ['git push: SAGE_BRANCH is a plain name', ' || !/^[A-Za-z0-9._/-]+$/.test(mine)) return', ') return'],
  ['git push: only -u, -q and -v', 'if (bad) return how(`the option ${bad} (force', 'if (false) return how(`the option ${bad} (force'],
  ['git push: only to origin', "remote !== 'origin' || ", ''],
  ['git push: one target only', 'more.length || ', ''],
  ['git push: only the own branch', '![mine, `HEAD:${mine}`].includes(ref)) return', 'false) return'],
  // gh
  ['gh: only the listed commands', "if (!GH.has(sub) || words[0] !== args[0] || words[1] !== args[1]) return", 'if (false) return'],
  ['gh: no option before the command', ' || words[0] !== args[0] || words[1] !== args[1]', ''],
  ['gh: no --hostname or --web', "if (args.some((x) => /^--(hostname|web)$/.test(x) || x === '-w')) return", 'if (false) return'],
  ['gh pr edit: only title and body', "const why = only(['--title', '-t', '--body', '-b', '--body-file', '-F'])(args.slice(2));", 'const why = null;'],
  ['gh: a body file is checked', 'return outside ? how(', 'return false ? how('],
  ['gh: a body file only from scratch', ' || !within(physical(expandHome(f, ctx), ctx.cwd), ctx.folders.scratch)', ''],
  ['gh: --body-file=FILE is a body file', ': /^--body-file=/.test(x) ? [x.slice(12)] : []', ': []'],
  // node, npm, find, grep, rg and the others
  ['node --version and -v', "if (args.length === 1 && ['--version', '-v'].includes(args[0])) return null;", ''],
  ['node --version takes nothing after it', 'if (args.length === 1 && ', 'if ('],
  ['node: only the listed options', 'if (bad) return `node ${bad}', 'if (false) return `node ${bad}'],
  ['node: a script file is needed', "return opts.includes('--test') ? null : 'node with no script file (code from stdin)';", 'return null;'],
  ['the sage state tool: only the listed commands', 'SAGE_TOOL.has(rest[0]) && ', ''],
  ['the sage state tool: no standing add', " && !(rest[0] === 'standing' && rest[1] === 'add')", ''],
  ['node: only .js, .mjs and .cjs', "if (!/\\.(m|c)?js$/.test(script) && !opts.includes('--test')) return", 'if (false) return'],
  ['node: the script is a read', "return readsOf(opts.includes('--test') ? args.slice(i) : [script], ctx);", 'return null;'],
  ['npm: only the listed commands', 'if (!NPM_RUN.has(sub)) return', 'if (false) return'],
  ['npm: no deploy script', "if (/deploy|release|publish/i.test(operands(args)[1] ?? '')) return", 'if (false) return'],
  ['npm: no --prefix, --userconfig, --script-shell, --node-options or -g', "return args.some((x) => /^--(prefix|userconfig|globalconfig|global|script-shell|node-options)/.test(x) || x === '-g') ? 'an npm option that changes its config or shell' : null;", 'return null;'],
  ['find: no -exec, -ok, -delete or -fprint', 'args.some((x) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(x)) ?', 'false ?'],
  ['find: each path is a read', ': readsOf(args.filter((x) => !flag(x) && !/^[!()]$/.test(x)), ctx));', ': null);'],
  ['grep and rg: each path is a read', 'return readsOf(args, ctx) ?? (recursive', 'return null ?? (recursive'],
  ['grep -r and rg walk each folder', '(recursive ? folders.map(', '(false ? folders.map('],
  ['grep -r and rg with no folder walk the current folder', 'recursive && ops.slice(1).length === 0 ? [...ops, ctx.cwd] : ops', 'ops'],
  ['grep: -r, -R and --recursive are recursive', 'args.some((x) => /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|--directories=recurse|-d)$/.test(x))', 'false'],
  ['rg: no --pre', "(args.some((x) => /^--pre/.test(x)) ? 'rg --pre", "(false ? 'rg --pre"],
  ['sort: no -o or --compress-program', "(args.some((x) => /^(-o|--output|--compress-program)/.test(x)) ? 'sort", "(false ? 'sort"],
  ['uniq: no output file', "(operands(args).length > 1 ? 'uniq", "(false ? 'uniq"],
  ['ls: each path is a read', 'ls: (args, ctx) => readsOf(args, ctx), cat', 'ls: () => null, cat'],
  ['mkdir, touch, rmdir: each path is a write', 'const writes = (args, ctx) => writesOf(args, ctx);', 'const writes = () => null;'],
  ['cp and mv: each path is a write', 'const copies = (args, ctx) => writesOf(args, ctx) ??', 'const copies = (args, ctx) => null ??'],
  ['cp and mv of a folder walk it', '?? operands(args).map((p) => folderRefusal(expandHome(p, ctx), ctx, true)).find(Boolean) ?? null;\nconst COMMANDS', '?? null;\nconst COMMANDS'],
  ['rm: the folder itself is not a target', 'rm: (args, ctx) => writesOf(args, ctx, true),', 'rm: (args, ctx) => writesOf(args, ctx),'],
  ['only the listed commands', 'if (!Object.hasOwn(COMMANDS, cmd)) return `the command ${cmd}`;', 'if (!Object.hasOwn(COMMANDS, cmd)) return null;'],
  // Simple commands and chains
  ['redirects are reads and writes', '    if (why) return why;\n  }\n  const texts', '  }\n  const texts'],
  ['HOME and TMPDIR only to a folder of the session', 'const why = writeRefusal(value, ctx); if (why) return `${name}=: ${why}`;', ''],
  ['only the listed variables', 'else if (!ENV_ANY.has(name)) return', 'else if (false) return'],
  ['no variable in front of git or gh', "if (i > 0 && (cmd === 'git' || cmd === 'gh')) return", 'if (false) return'],
  ['no wildcard in a write command, nor after a dot', 'if (globs.some((w) =>', 'if (false && globs.some((w) =>'],
  ['no wildcard after a dot', '/(^|\\/)\\.[^/]*[*?[]/.test(w.text) || ', ''],
  ['no wildcard in a write command', "['rm', 'mv', 'cp', 'mkdir', 'touch', 'rmdir'].includes(cmd)))", 'false))'],
  ['a wildcard of a content read walks its folder', 'return globbed ?? COMMANDS[cmd](args, ctx);', 'return COMMANDS[cmd](args, ctx);'],
  ['cd: only into a folder that can be read', 'if (why) return `cd: ${why}`;', ''],
  ['cd: no options', "if (args.length > 1 || flag(to)) return 'cd with options';", ''],
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
  ['Grep: the path is a read', "?? readRefusal(i.path ?? ctx.cwd, ctx) ?? ((i.glob", '?? ((i.glob'],
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
// The 20001-file folder of the walk test, made once for every run.
const big = join(work, 'big');
mkdirSync(big);
for (let i = 0; i < 20001; i++) writeFileSync(join(big, `f${i}.txt`), '');

/** Runs test/guard.test.js against a copy of the guard with `source` as src/guard.js; resolves with the exit code. */
function run(name, source) {
  const dir = join(work, name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) + Math.random().toString(36).slice(2, 6));
  for (const f of ['package.json', 'scripts/guard.mjs', 'test/guard.test.js', 'test/guard-corpus.json']) cpSync(join(ROOT, f), join(dir, f));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'guard.js'), source);
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--test', 'test/guard.test.js'], { cwd: dir, env: { ...process.env, GUARD_TEST_BIG: big }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => { clearTimeout(timer); done(code); });
  });
}

const stale = MUTATIONS.filter(([, from]) => SOURCE.split(from).length !== 2);
for (const [name, from] of stale) console.log(`STALE  ${name}: its text is not in src/guard.js exactly once: ${JSON.stringify(from)}`);
const start = Date.now();
const unmutated = await run('unmutated', SOURCE);
if (unmutated !== 0) console.log('FAIL   the tests fail on the unmutated guard');
const survivors = [];
const queue = MUTATIONS.filter((m) => !stale.includes(m));
await Promise.all(Array.from({ length: Math.max(2, availableParallelism() - 1) }, async () => {
  for (let m = queue.shift(); m; m = queue.shift()) {
    const [name, from, to] = m;
    if (await run(name, SOURCE.replace(from, to)) === 0) survivors.push(name);
  }
}));
for (const name of survivors) console.log(`SURVIVES  ${name}: no test fails without this rule`);
console.log(`guard mutations: ${MUTATIONS.length - stale.length - survivors.length} of ${MUTATIONS.length} rule removals fail a test; ${survivors.length} survive; ${stale.length} stale; ${Math.round((Date.now() - start) / 1000)} s`);
rmSync(work, { recursive: true, force: true });
process.exit(survivors.length || stale.length || unmutated !== 0 ? 1 : 0);
