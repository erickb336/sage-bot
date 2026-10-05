// The rules of the guard hook (T133, scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead.
// decide(input, env) gets the PreToolUse JSON of Claude Code and the hook's environment, and gives null (allow) or the reason
// of a refusal. With SAGE_ORIGIN not "lead" it allows everything: the owner's own sessions are unaffected.
//
// In a lead session it allows only what it understands (an allow-list), and refuses the rest (fail closed):
// - Bash: a strict parser takes the command apart into simple commands joined by &&, ||, ; or |. Anything it does not parse
//   (a $, a backtick, parentheses, braces, a backslash, a newline outside quotes, a heredoc, a non-ASCII character outside
//   quotes) is refused. Each simple command must be on the allow-list (COMMANDS) and pass its own rule; every argument that
//   names a file must be inside the session's folders.
// - The file tools: reads inside the worktree, the scratch folder and the repository; writes inside the worktree and the
//   scratch folder only. Paths are resolved through every symbolic link, as the system would, before the check.
// - Any other tool that is not in TOOLS is refused.
//
// The environment (set by sage-bot, never by the session's model): SAGE_ORIGIN, SAGE_WORKTREE, SAGE_SCRATCH, and optionally
// SAGE_REPO (read only) and SAGE_TOOL (the sage state tool, sage.mjs).
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASK = 'Erick must approve this at the terminal.';
const refusal = (what) => `sage-bot guard: ${what} is refused in a lead session. ${ASK}`;

// The hook's own files: no tool may write them.
const SELF = [fileURLToPath(import.meta.url), fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url))];

// Branches that a lead never pushes to.
const PROTECTED = /^(main|master|trunk|develop|production|gh-pages|release([/-].*)?)$/i;
// Files that hold secrets, also inside the worktree (case does not matter: macOS file names ignore case).
const SECRET = /(^|\/)(\.env(\.[^/]*)?|\.envrc|\.netrc|\.git-credentials|\.pgpass|id_[a-z0-9_]+|[^/]*\.(pem|key|p12|pfx)|credentials[^/]*|\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.config\/(gh|sage-bot))(\/|$)/i;
// Files that a lead never writes, also inside the worktree: Claude Code settings and MCP servers, git's own folder (its
// config can run commands), and sage's mode and autopilot state (the sage hook keeps it in $TMPDIR/sage-hooks).
const NO_WRITE = /(^|\/)(\.claude\/settings[^/]*\.json|\.mcp\.json|\.git|sage-hooks)(\/|$)/i;

/** The path as the system resolves it: each existing part through its symbolic links, ".." against the real parent. */
export function physical(path, cwd) {
  let cur = '/';
  for (const part of (isAbsolute(path) ? path : `${cwd}/${path}`).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { cur = dirname(cur); continue; }
    const next = join(cur, part);
    try { cur = realpathSync.native(next); } catch { cur = next; }
  }
  return cur;
}

const within = (p, root) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/** The session's folders from the environment, each resolved; null when the worktree or the scratch folder is missing. */
function foldersOf(env) {
  const real = (p) => { try { return p && isAbsolute(p) ? realpathSync.native(p) : null; } catch { return null; } };
  const worktree = real(env.SAGE_WORKTREE);
  const scratch = real(env.SAGE_SCRATCH);
  if (!worktree || !scratch || worktree === '/' || scratch === '/') return null;
  return { worktree, scratch, repo: real(env.SAGE_REPO), tool: real(env.SAGE_TOOL), home: env.HOME || '/nonexistent', hooks: real(tmpdir()) };
}

/** Why a read of `path` is refused, or null. */
function readRefusal(path, ctx) {
  const p = physical(path, ctx.cwd);
  if (SECRET.test(p)) return `reading ${path} (a file that can hold secrets)`;
  const { worktree, scratch, repo } = ctx.folders;
  if (within(p, worktree) || within(p, scratch) || (repo && within(p, repo))) return null;
  return `reading ${path} (outside the worktree, the scratch folder and the repository)`;
}

/** Why a write of `path` is refused, or null. `strict`: the folder itself may not be the target (rm of the worktree). */
function writeRefusal(path, ctx, strict = false) {
  if (path === '/dev/null') return null;
  const p = physical(path, ctx.cwd);
  if (SECRET.test(p)) return `writing ${path} (a file that can hold secrets)`;
  if (NO_WRITE.test(p) || SELF.includes(p) || within(p, join(ctx.folders.hooks, 'sage-hooks'))) return `writing ${path} (settings, git or sage state, or this hook)`;
  const { worktree, scratch } = ctx.folders;
  if ([worktree, scratch].some((r) => within(p, r) && !(strict && p === r))) return null;
  return `writing ${path} (outside the worktree and the scratch folder${strict ? ', or one of the two folders itself' : ''})`;
}

// ---- Bash ---------------------------------------------------------------------------------------------------------------

const OPERATORS = ['&&', '||', ';', '|'];

/**
 * The command as simple commands: [{ words: [{ text, glob }], redirects: [{ op, target }] }], or a string: why it is refused.
 * Quoting is joined as the shell joins it (g"i"t is git). A word's `glob` says that it has an unquoted *, ? or [.
 */
export function parse(command) {
  if (typeof command !== 'string' || !command.trim()) return 'an empty command';
  const segments = [];
  let seg = { words: [], redirects: [] };
  let word = null;
  let pendingRedirect = null;
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) { seg.redirects.push({ op: pendingRedirect, target: word.text }); pendingRedirect = null; } else seg.words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (pendingRedirect) throw 'a redirect with no file';
    if (!seg.words.length) throw 'an empty part of a command';
    segments.push(seg);
    seg = { words: [], redirects: [] };
  };
  const add = (ch, glob = false) => { word ??= { text: '', glob: false }; word.text += ch; word.glob ||= glob; };
  try {
    let i = 0;
    while (i < command.length) {
      const c = command[i];
      const rest = command.slice(i);
      if (c === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) throw 'an open quote';
        const body = command.slice(i + 1, end);
        if (/[\0-\x08\x0b-\x1f\x7f]/.test(body)) throw 'a control character';
        word ??= { text: '', glob: false };
        word.text += body;
        i = end + 1;
      } else if (c === '"') {
        let j = i + 1;
        word ??= { text: '', glob: false };
        for (; j < command.length && command[j] !== '"'; j++) {
          if (/[$`\\!]/.test(command[j])) throw `a ${command[j]} inside double quotes`;
          if (/[\0-\x08\x0b-\x1f\x7f]/.test(command[j])) throw 'a control character';
          word.text += command[j];
        }
        if (j >= command.length) throw 'an open quote';
        i = j + 1;
      } else if (c === ' ' || c === '\t') { endWord(); i++; }
      else if (OPERATORS.some((op) => rest.startsWith(op))) {
        const op = OPERATORS.find((o) => rest.startsWith(o));
        if (rest.startsWith('|&') || rest.startsWith(';;')) throw `the operator ${rest.slice(0, 2)}`;
        endSegment();
        i += op.length;
      } else if (c === '>' || c === '<') {
        const fd = word && /^\d$/.test(word.text) ? word.text : '';
        if (word && !fd) endWord();
        word = null;
        const m = rest.match(/^(>>|>&[12](?![^\s;&|])|>|<)/);
        if (!m || /^(<<|<>|<&|>\||<\()/.test(rest)) throw `the redirect ${rest.slice(0, 2)}`;
        if (m[1].startsWith('>&')) { if (!fd) throw 'the redirect >&'; } else pendingRedirect = m[1];
        i += m[1].length;
      } else if (/[a-zA-Z0-9_\-./=:,+@%^]/.test(c)) { add(c); i++; }
      else if (c === '*' || c === '?' || c === '[' || c === ']') { add(c, true); i++; }
      else if (c === '~') {
        if (word !== null) throw 'a ~ inside a word';
        if (!/^~(\/|$|[\s;&|])/.test(rest)) throw 'a ~user path';
        add(c); i++;
      } else throw c === '\n' || c === '\r' ? 'a newline outside quotes (one command per call)' : `the character ${JSON.stringify(c)} outside quotes`;
    }
    endSegment();
  } catch (why) {
    if (typeof why === 'string') return why;
    throw why;
  }
  return segments;
}

const flag = (w) => w.startsWith('-');
const operands = (args) => args.filter((a) => !flag(a));

/** The paths inside one argument: the argument, or the value of a --flag=value or -fVALUE that holds a / or a ~. */
function pathsIn(arg) {
  if (!flag(arg)) return [arg];
  if (arg.includes('=')) return [arg.slice(arg.indexOf('=') + 1)];
  const at = arg.search(/[/~]/);
  return at > 0 ? [arg.slice(at)] : [];
}

const expandHome = (p, ctx) => (p === '~' ? ctx.folders.home : p.startsWith('~/') ? ctx.folders.home + p.slice(1) : p);

/** Why the reads of every argument are refused, or null. */
const readsOf = (args, ctx) => args.flatMap(pathsIn).map((p) => readRefusal(expandHome(p, ctx), ctx)).find(Boolean) ?? null;
/** Why the writes of every argument are refused, or null. */
const writesOf = (args, ctx, strict) => args.flatMap(pathsIn).map((p) => writeRefusal(expandHome(p, ctx), ctx, strict)).find(Boolean) ?? null;

const only = (allowed) => (args) => {
  const bad = args.filter(flag).find((a) => !allowed.some((f) => a === f || a.startsWith(`${f}=`)));
  return bad ? `the option ${bad}` : null;
};

/** git: global options only -C <folder in the worktree or scratch>; each subcommand on the allow-list with its own rule. */
function git(args, ctx) {
  let a = [...args];
  while (a[0] === '-C') {
    if (!a[1]) return 'git -C with no folder';
    const why = writeRefusal(expandHome(a[1], ctx), ctx);
    if (why) return `git -C: ${why}`;
    ctx = { ...ctx, cwd: physical(expandHome(a[1], ctx), ctx.cwd) };
    a = a.slice(2);
  }
  const [sub, ...rest] = a;
  if (!sub || flag(sub)) return `git ${sub ?? ''} (git options other than -C, such as -c, --git-dir or --exec-path)`.trim();
  const rule = GIT[sub];
  if (!rule) return `git ${sub}`;
  const why = rule(rest, ctx);
  return why && `git ${sub}: ${why}`;
}

const readOnlyGit = (args, ctx) => (args.some((x) => /^--(output|ext-diff|textconv)/.test(x)) ? 'an option that writes a file or runs a program' : readsOf(args, ctx));
const GIT = {
  status: readOnlyGit, diff: readOnlyGit, log: readOnlyGit, show: readOnlyGit, 'rev-parse': readOnlyGit, 'ls-files': readOnlyGit, blame: readOnlyGit,
  add: (args, ctx) => writesOf(args, ctx),
  rm: (args, ctx) => writesOf(args, ctx),
  mv: (args, ctx) => writesOf(args, ctx),
  restore: (args, ctx) => writesOf(args, ctx),
  commit: (args, ctx) => only(['-m', '--message', '-a', '--all', '-F', '--file', '-q', '--quiet', '-s', '--signoff', '--allow-empty', '-v'])(args) ?? readsOf(args.filter((x, i) => ['-F', '--file'].includes(args[i - 1])), ctx),
  fetch: only(['origin', '-q', '--quiet', '--prune', '-p']),
  switch: (args) => only(['-c', '--create'])(args),
  checkout: (args) => only(['-b'])(args),
  branch: (args) => only(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '--show-current', '-u', '--set-upstream-to', '--contains'])(args),
  stash: (args) => (['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0]) ? null : `stash ${args[0]}`),
  remote: (args) => (args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null : 'a change of a remote'),
  worktree: (args, ctx) => {
    if (args[0] === 'list') return null;
    if (args[0] !== 'add') return `worktree ${args[0] ?? ''}`.trim();
    const rest = args.slice(1);
    return only(['-b'])(rest) ?? writesOf(rest.filter((x, i) => !flag(x) && rest[i - 1] !== '-b'), ctx);
  },
  push,
};

/** git push: only `git push [-u] origin <branch>` or `<src>:<branch>`, to a branch that is not protected; no force, no delete. */
function push(args) {
  const bad = args.filter(flag).find((x) => !['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose'].includes(x));
  if (bad) return `the option ${bad} (force, delete, tags, mirror or another option)`;
  const [remote, ...refs] = operands(args);
  if (remote !== 'origin') return remote ? `the remote ${remote} (only origin)` : 'a push with no branch (name the branch)';
  if (refs.length !== 1) return 'a push of anything but one named branch';
  const ref = refs[0];
  if (ref.startsWith('+')) return 'a forced refspec';
  const [src, dst = src, more] = ref.split(':');
  if (more !== undefined || !src) return 'a deletion of a remote branch';
  const branch = dst.replace(/^refs\/heads\//, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('refs/') || branch === 'HEAD' || branch.startsWith('-')) return `the target ${dst} (a tag, a ref or HEAD)`;
  if (PROTECTED.test(branch)) return `a push to the protected branch ${branch}`;
  return null;
}

/** gh: only these read commands and gh pr create. Never merge, api, secret, auth, release, workflow, alias or extension. */
const GH = new Set(['pr create', 'pr view', 'pr list', 'pr diff', 'pr checks', 'pr status', 'issue view', 'issue list', 'run view', 'run list', 'repo view']);
function gh(args, ctx) {
  const words = operands(args);
  const sub = words.slice(0, 2).join(' ');
  if (!GH.has(sub) || words[0] !== args[0] || words[1] !== args[1]) return `gh ${sub || args.join(' ')}`.trim();
  if (args.some((x) => /^--(hostname|web)$/.test(x) || x === '-w')) return `gh ${sub} with --hostname or --web`;
  return readsOf(args.slice(2).filter((x, i, all) => ['-F', '--body-file'].includes(all[i - 1]) || /^--body-file=/.test(x)), ctx);
}

/** node: a script file in the session's folders (or the sage state tool), never code from an option or from stdin. */
function node(args, ctx) {
  const opts = [];
  let i = 0;
  for (; i < args.length && flag(args[i]); i++) opts.push(args[i]);
  const bad = opts.find((x) => !['--test', '--check', '--no-warnings', '--test-reporter', '--test-name-pattern', '--experimental-test-coverage'].some((f) => x === f || x.startsWith(`${f}=`)));
  if (bad) return `node ${bad} (code from an option, a preload or a loader)`;
  const [script, ...rest] = args.slice(i);
  if (!script) return opts.includes('--test') ? null : 'node with no script file (code from stdin)';
  if (ctx.folders.tool && physical(expandHome(script, ctx), ctx.cwd) === ctx.folders.tool) {
    return rest[0] === 'config' ? 'the sage state tool config (it changes how sage merges)' : null;
  }
  if (!/\.(m|c)?js$/.test(script) && !opts.includes('--test')) return `node ${script} (not a .js, .mjs or .cjs file)`;
  return readsOf(opts.includes('--test') ? args.slice(i) : [script], ctx);
}

const NPM_RUN = new Set(['ci', 'test', 't', 'run', 'run-script', 'ls', 'outdated']);
const npm = (args) => {
  const sub = operands(args)[0];
  if (!NPM_RUN.has(sub)) return `npm ${sub ?? ''} (only ci, test, run, ls and outdated)`.trim();
  if (/deploy|release|publish/i.test(operands(args)[1] ?? '')) return `npm ${sub} ${operands(args)[1]} (a deploy)`;
  return args.some((x) => /^--(prefix|userconfig|globalconfig|global|script-shell|node-options)/.test(x) || x === '-g') ? 'an npm option that changes its config or shell' : null;
};

/** find: no option that runs a command, deletes or writes a file. */
const find = (args, ctx) => (args.some((x) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(x)) ? 'find with -exec, -ok, -delete or -fprint' : readsOf(args.filter((x) => !flag(x) && !/^[!()]$/.test(x)), ctx));

// The allow-list of commands. A rule gives the reason of a refusal, or null.
const reads = (args, ctx) => readsOf(args, ctx);
const writes = (args, ctx) => writesOf(args, ctx);
const COMMANDS = {
  ls: reads, cat: reads, head: reads, tail: reads, wc: reads, grep: reads, rg: (args, ctx) => (args.some((x) => /^--pre/.test(x)) ? 'rg --pre (it runs a program)' : readsOf(args, ctx)),
  diff: reads, sort: (args, ctx) => (args.some((x) => /^(-o|--output|--compress-program)/.test(x)) ? 'sort -o or --compress-program' : readsOf(args, ctx)),
  uniq: (args, ctx) => (operands(args).length > 1 ? 'uniq with an output file' : readsOf(args, ctx)),
  cut: reads, tr: () => null, jq: reads, file: reads, stat: reads, du: reads, basename: () => null, dirname: () => null, realpath: reads,
  pwd: () => null, echo: () => null, printf: () => null, true: () => null, false: () => null, date: () => null, sleep: () => null,
  test: reads, '[': reads, which: () => null,
  mkdir: writes, touch: writes, cp: writes, mv: writes, rmdir: writes,
  rm: (args, ctx) => writesOf(args, ctx, true),
  find, git, gh, node, npm,
};

// Environment variables that a simple command may set in front of it. HOME and TMPDIR only to a folder of the session.
const ENV_ANY = new Set(['NODE_ENV', 'CI', 'NO_COLOR', 'FORCE_COLOR']);
const ENV_PATH = new Set(['HOME', 'TMPDIR']);

/** Why the simple command is refused, or null. `ctx.cwd` changes after a cd, for the commands that follow it. */
function simple({ words, redirects }, ctx) {
  for (const r of redirects) {
    const why = r.op === '<' ? readRefusal(expandHome(r.target, ctx), ctx) : writeRefusal(expandHome(r.target, ctx), ctx);
    if (why) return why;
  }
  const texts = words.map((w) => w.text);
  let i = 0;
  for (; i < texts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(texts[i]); i++) {
    const [name, value] = [texts[i].slice(0, texts[i].indexOf('=')), texts[i].slice(texts[i].indexOf('=') + 1)];
    if (ENV_PATH.has(name)) { const why = writeRefusal(value, ctx); if (why) return `${name}=: ${why}`; } else if (!ENV_ANY.has(name)) return `setting ${name} in front of a command`;
  }
  const [cmd, ...args] = texts.slice(i);
  if (!cmd) return 'a command that only sets variables';
  if (words.slice(i).some((w, k) => w.glob && (k === 0 || /(^|\/)\.[^/]*[*?[]/.test(w.text) || ['rm', 'mv', 'cp', 'mkdir', 'touch', 'rmdir'].includes(cmd)))) {
    return 'a wildcard here (it can reach .. or another file)';
  }
  if (cmd === 'cd') {
    const to = expandHome(args[0] ?? '~', ctx);
    if (args.length > 1 || flag(to)) return 'cd with options';
    const why = readRefusal(to, ctx);
    if (why) return `cd: ${why}`;
    ctx.cwd = physical(to, ctx.cwd);
    return null;
  }
  if (!Object.hasOwn(COMMANDS, cmd)) return `the command ${cmd}`;
  return COMMANDS[cmd](args, ctx);
}

/** Why the Bash command is refused, or null. */
export function bashRefusal(command, ctx) {
  const parsed = parse(command);
  if (typeof parsed === 'string') return `a command the guard cannot read (${parsed})`;
  const local = { ...ctx };
  for (const seg of parsed) {
    const why = simple(seg, local);
    if (why) return why;
  }
  return null;
}

// ---- Other tools --------------------------------------------------------------------------------------------------------

const TOOLS = {
  Bash: (i, ctx) => bashRefusal(i.command, ctx),
  Read: (i, ctx) => readRefusal(i.file_path, ctx),
  Write: (i, ctx) => writeRefusal(i.file_path, ctx),
  Edit: (i, ctx) => writeRefusal(i.file_path, ctx),
  MultiEdit: (i, ctx) => writeRefusal(i.file_path, ctx),
  NotebookEdit: (i, ctx) => writeRefusal(i.notebook_path, ctx),
  Glob: (i, ctx) => globRefusal(i.pattern, ctx) ?? readRefusal(i.path ?? ctx.cwd, ctx),
  Grep: (i, ctx) => globRefusal(i.glob ?? '', ctx) ?? readRefusal(i.path ?? ctx.cwd, ctx),
  WebFetch: (i) => (/^https?:\/\//i.test(String(i.url)) ? null : 'a fetch of a URL that is not http or https'),
  WebSearch: () => null, TodoWrite: () => null, Task: () => null, Agent: () => null, ToolSearch: () => null,
};

const globRefusal = (pattern, ctx) => {
  if (typeof pattern !== 'string') return 'a pattern that is not text';
  if (/^[/~]|(^|\/)\.\.(\/|$)|\.\*/.test(pattern)) return `the pattern ${pattern} (it can reach outside the folder)`;
  return SECRET.test(pattern) ? `the pattern ${pattern} (files that can hold secrets)` : null;
};

/**
 * The guard's decision for one PreToolUse input: null to allow, or the refusal message for the lead.
 * @param {unknown} input the hook's JSON (tool_name, tool_input, cwd)
 * @param {Record<string, string | undefined>} env the hook's environment
 */
export function decide(input, env) {
  if (env.SAGE_ORIGIN !== 'lead') return null;
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object') {
    return refusal('a hook input that is not a tool call');
  }
  const folders = foldersOf(env);
  if (!folders) return refusal('every tool (SAGE_WORKTREE or SAGE_SCRATCH is not an existing folder)');
  const rule = Object.hasOwn(TOOLS, input.tool_name) ? TOOLS[input.tool_name] : null;
  if (!rule) return refusal(`the tool ${input.tool_name}`);
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : folders.worktree;
  for (const [k, v] of Object.entries(input.tool_input)) {
    if (/path$/.test(k) && typeof v !== 'string') return refusal(`a ${k} that is not text`);
  }
  const why = rule(input.tool_input, { folders, cwd: physical(cwd, '/') });
  return why ? refusal(why) : null;
}

