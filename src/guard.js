// The rules of the guard hook (T133, scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead.
// decideText(stdin, env) gets the PreToolUse JSON of Claude Code and the hook's environment, and gives null (allow) or the
// message of a refusal. With SAGE_ORIGIN not "lead" the hook allows everything: the owner's own sessions are unaffected.
//
// In a lead session it allows only what it understands (an allow-list), and refuses the rest (fail closed):
// - An input over 64 KB is refused before it is parsed, so the hook always decides well inside its timeout.
// - Bash: a strict parser takes the command apart into simple commands joined by &&, ||, ; or |. Anything it does not parse
//   (a $, a backtick, parentheses, braces, a backslash, a newline outside quotes, a heredoc, a non-ASCII character outside
//   quotes) is refused. Each simple command must be on the allow-list (COMMANDS) and pass its own rule; every argument that
//   names a file must be inside the session's folders.
// - The file tools: reads inside the worktree, the scratch folder and the repository; writes inside the worktree and the
//   scratch folder only. Paths are resolved through every symbolic link, as the system would, before the check.
// - A content search or a copy of a folder is refused when the folder holds a file that can hold secrets.
// - Any other tool that is not in TOOLS is refused.
//
// The environment (set by sage-bot, never by the session's model): SAGE_ORIGIN, SAGE_WORKTREE, SAGE_SCRATCH, SAGE_BRANCH,
// and optionally SAGE_REPO (read only) and SAGE_TOOL (the sage state tool, sage.mjs).
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The largest hook input that the guard reads, in bytes. */
export const MAX_INPUT = 64 * 1024;

const ASK = 'Erick must approve this at the terminal.';
// A rule can add the safe way to do the same thing after this mark: how(why, safe).
const MARK = '\u0001';
const how = (why, safe) => `${why}${MARK}${safe}`;
const refusal = (why) => {
  const k = why.lastIndexOf(MARK);
  const [what, safe] = k < 0 ? [why, null] : [why.slice(0, k), why.slice(k + 1)];
  return `sage-bot guard: ${what} is refused in a lead session. ${safe ? `sage can do this instead: ${safe}.` : ASK}`;
};
const REPHRASE = 'one simple command per call, with no $, backtick, heredoc, (, {, \\ or newline; put long or special text in a file in the scratch folder and pass it with git commit -F <file> or gh pr create --body-file <file>';

// The hook's own files: no tool may write them.
const SELF = [fileURLToPath(import.meta.url), fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url))];

// Branches that a lead never pushes to, also when SAGE_BRANCH names one of them by mistake.
const PROTECTED = /^(main|master|trunk|develop|production|gh-pages|release([/-].*)?)$/i;
// Files that hold secrets, also inside the worktree (case does not matter: macOS file names ignore case). A name can follow a
// / or a revision's colon (git show HEAD:.env). git's own folder and config files are here too: a remote URL can hold a
// token, and a config can run programs. .env.example, .env.sample and .env.template are not secrets.
const SECRET = /(^|[/:])(\.env(?!\.(example|sample|template)(\/|$))(\.[^/]*)?|\.envrc|\.netrc|\.git|\.git-credentials|\.gitconfig|\.pgpass|id_[a-z0-9_]+|[^/]*\.(pem|key|p12|pfx)|credentials[^/]*|\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.config\/(gh|git|sage-bot))(\/|$)/i;
// Files that a lead never writes, also inside the worktree: Claude Code settings and MCP servers, sage's mode and autopilot
// state (the sage hook keeps it in $TMPDIR/sage-hooks), and a file named HEAD (git takes a folder with HEAD, objects and
// refs for a repository, and that repository's config can run programs).
const NO_WRITE = /(^|\/)(\.claude\/settings[^/]*\.json|\.mcp\.json|sage-hooks)(\/|$)|(^|\/)head$/i;

/** The path as the system resolves it: each existing part through its symbolic links, ".." against the real parent (join). */
export function physical(path, cwd) {
  let cur = '/';
  for (const part of (isAbsolute(path) ? path : `${cwd}/${path}`).split('/')) {
    if (!part || part === '.') continue;
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
  return { worktree, scratch, repo: real(env.SAGE_REPO), tool: real(env.SAGE_TOOL), home: env.HOME || '/nonexistent', branch: env.SAGE_BRANCH || null };
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
  if (NO_WRITE.test(p) || SELF.includes(p)) return `writing ${path} (settings, sage state, a file named HEAD, or this hook)`;
  const { worktree, scratch } = ctx.folders;
  if ([worktree, scratch].some((r) => within(p, r) && !(strict && p === r))) return null;
  return `writing ${path} (outside the worktree and the scratch folder${strict ? ', or one of the two folders itself' : ''})`;
}

// A folder walk stops after this many entries and refuses: the hook must decide quickly.
const WALK_MAX = 20000;
/**
 * Why a content search, a copy or a move of the folder `path` is refused, or null: the folder holds a file that can hold
 * secrets, or a link that leads out of the session's folders (and, for a copy or a move, a file named HEAD). A worktree's
 * .git file (a pointer to its repository) is not counted. Folders named node_modules below the folder are not walked: npm
 * fills them from the lock file, and a move or a copy of a folder with secrets into them is refused here first.
 */
function folderRefusal(path, ctx, copy = false) {
  const root = physical(path, ctx.cwd);
  const stack = [root];
  let n = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++n > WALK_MAX) return how(`a search or a copy of ${path} (more than ${WALK_MAX} files to check)`, 'name a smaller folder');
      const p = join(dir, e.name);
      if (e.name === '.git' && e.isFile()) continue;
      const bad = SECRET.test(p) || (copy && /^head$/i.test(e.name)) || (e.isSymbolicLink() && readRefusal(p, ctx));
      if (bad) return how(`a search or a copy of ${path} (it holds ${p.slice(root.length + 1)}, a file that can hold secrets, a file named HEAD or a link out of the session's folders)`, 'name a folder or the files without it, or use the Grep tool with a glob such as **/*.js');
      if (e.isDirectory() && e.name !== 'node_modules') stack.push(p);
    }
  }
  return null;
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
    segments.push(seg);
    seg = { words: [], redirects: [] };
  };
  const add = (ch, glob = false) => { word ??= { text: '', glob: false }; word.text += ch; word.glob ||= glob; };
  try {
    let i = 0;
    while (i < command.length) {
      const c = command[i];
      // The next 4 characters: every rule below looks at most that far. (A slice to the end made long input quadratic.)
      const rest = command.slice(i, i + 4);
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
        endSegment();
        i += op.length;
      } else if (c === '>' || c === '<') {
        const fd = word && /^\d$/.test(word.text) ? word.text : '';
        if (word && !fd) endWord();
        word = null;
        const m = rest.match(/^(>>|>&[12](?![^\s;&|])|>|<)/);
        if (!m || /^(<<|<>|<&|>\||<\()/.test(rest)) throw `the redirect ${rest.slice(0, 2)}`;
        if (!m[1].startsWith('>&')) pendingRedirect = m[1];
        i += m[1].length;
      } else if (/[a-zA-Z0-9_\-./=:,+@%^]/.test(c)) { add(c); i++; }
      else if (c === '*' || c === '?' || c === '[' || c === ']') { add(c, true); i++; }
      else if (c === '~') {
        // At the start of a word: the home folder (~ or ~/x). Inside a word: only a revision (HEAD~1, main~), which the
        // shell never expands; never after = or :, where the shell does expand it.
        if (word !== null ? !/[A-Za-z0-9_]$/.test(word.text) || !/^~(\d|$|[\s;&|])/.test(rest) : !/^~(\/|$|[\s;&|])/.test(rest)) throw 'a ~ that the shell can expand';
        add(c); i++;
      } else throw c === '\n' || c === '\r' ? 'a newline outside quotes' : `the character ${JSON.stringify(c)} outside quotes`;
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
/** Why a content read of every argument is refused, or null: each file is read, and each folder is walked. */
const contentOf = (args, ctx) => readsOf(args, ctx) ?? args.flatMap(pathsIn).map((p) => folderRefusal(expandHome(p, ctx), ctx)).find(Boolean) ?? null;

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
  // Object.hasOwn: a plain lookup finds Object.prototype's functions (git hasOwnProperty), which refuse only by a crash.
  const rule = Object.hasOwn(GIT, sub ?? '') ? GIT[sub] : null;
  if (!rule) return `git ${sub ?? ''} (only the listed subcommands; no global option but -C)`.trim();
  const why = rule(rest, ctx);
  return why && `git ${sub}: ${why}`;
}

/** The top folder of the git worktree that holds `cwd`: the first folder upward with a .git entry. */
function topOf(cwd) {
  for (let d = cwd; ; d = dirname(d)) {
    try { statSync(join(d, '.git')); return d; } catch { if (d === '/') return cwd; }
  }
}

const readOnlyGit = (args, ctx) => (args.some((x) => /^--(output|ext-diff|textconv|no-index)/.test(x)) ? 'an option that writes a file, runs a program or reads outside git' : readsOf(args, ctx));
const GIT = {
  status: readOnlyGit, diff: readOnlyGit, log: readOnlyGit, show: readOnlyGit, 'rev-parse': readOnlyGit, 'ls-files': readOnlyGit, blame: readOnlyGit,
  // git add of a folder (or of everything) reads the files in it into git, where git diff --cached shows them.
  add: (args, ctx) => writesOf(args, ctx) ?? (args.some((x) => /^(-A|--all|--no-ignore-removal)$/.test(x)) ? folderRefusal(topOf(ctx.cwd), ctx) : null) ?? operands(args).map((p) => folderRefusal(p, ctx)).find(Boolean) ?? null,
  rm: (args, ctx) => writesOf(args, ctx),
  mv: (args, ctx) => writesOf(args, ctx) ?? operands(args).map((p) => folderRefusal(p, ctx, true)).find(Boolean) ?? null,
  restore: (args, ctx) => writesOf(args, ctx),
  commit: (args, ctx) => only(['-m', '--message', '-a', '--all', '-F', '--file', '-q', '--quiet', '-s', '--signoff', '--allow-empty', '-v'])(args) ?? readsOf(args.filter((x, i) => ['-F', '--file'].includes(args[i - 1])), ctx),
  fetch: (args) => only(['-q', '--quiet', '--prune', '-p'])(args) ?? (operands(args)[0] === 'origin' && operands(args).slice(1).every((r) => /^[A-Za-z0-9._/-]+$/.test(r)) ? null : how('a fetch from a remote other than origin, or of a refspec', 'git fetch origin')),
  switch: (args) => only(['-c', '--create'])(args),
  checkout: (args) => only(['-b'])(args),
  branch: (args) => only(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '--show-current', '-u', '--set-upstream-to', '--contains'])(args),
  stash: (args) => (['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0]) ? only(['-m', '--message', '-q', '--quiet', '-p', '--patch', '--stat'])(args) : `stash ${args[0]}`),
  remote: (args) => (args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null : 'a change of a remote'),
  worktree: (args, ctx) => {
    if (args[0] === 'list') return null;
    if (args[0] !== 'add') return `worktree ${args[0] ?? ''}`.trim();
    const rest = args.slice(1);
    return only(['-b'])(rest) ?? writesOf(rest.filter((x, i) => !flag(x) && rest[i - 1] !== '-b'), ctx);
  },
  push,
};

/** git push: only `git push [-u] origin <SAGE_BRANCH>` (or HEAD:<SAGE_BRANCH>), the session's own branch by its name. */
function push(args, ctx) {
  const mine = ctx.folders.branch;
  if (!mine || PROTECTED.test(mine) || !/^[A-Za-z0-9._/-]+$/.test(mine)) return 'a push (the session has no branch of its own in SAGE_BRANCH)';
  const safe = `git push origin ${mine}`;
  const bad = args.filter(flag).find((x) => !['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose'].includes(x));
  if (bad) return how(`the option ${bad} (force, delete, tags, mirror or another option)`, safe);
  const [remote, ref, ...more] = operands(args);
  if (remote !== 'origin' || more.length || ![mine, `HEAD:${mine}`].includes(ref)) return how(`a push to anything but origin ${mine}, the session's own branch`, safe);
  return null;
}

/** gh: only these read commands, gh pr create and gh pr edit. Never merge, api, secret, auth, release, workflow, alias or extension. */
const GH = new Set(['pr create', 'pr edit', 'pr view', 'pr list', 'pr diff', 'pr checks', 'pr status', 'issue view', 'issue list', 'run view', 'run list', 'repo view']);
function gh(args, ctx) {
  const words = operands(args);
  const sub = words.slice(0, 2).join(' ');
  if (!GH.has(sub) || words[0] !== args[0] || words[1] !== args[1]) return `gh ${sub || args.join(' ')}`.trim();
  if (args.some((x) => /^--(hostname|web)$/.test(x) || x === '-w')) return `gh ${sub} with --hostname or --web`;
  if (sub === 'pr edit') {
    const why = only(['--title', '-t', '--body', '-b', '--body-file', '-F'])(args.slice(2));
    if (why) return how(`gh pr edit with ${why}`, 'gh pr edit <number> --title <title> --body-file <file in the scratch folder>');
  }
  const files = args.slice(2).flatMap((x, i, all) => (['-F', '--body-file'].includes(all[i - 1]) ? [x] : /^--body-file=/.test(x) ? [x.slice(12)] : []));
  const outside = files.find((f) => f !== '-' && (readRefusal(expandHome(f, ctx), ctx) || !within(physical(expandHome(f, ctx), ctx.cwd), ctx.folders.scratch)));
  return outside ? how(`gh ${sub} with the body file ${outside}`, 'write the body to a file in the scratch folder and pass it with --body-file') : null;
}

// The sage state tool's commands that a lead session may run: the reads, and the records of its own work.
const SAGE_TOOL = new Set(['status', 'logbook', 'merge-check', 'standing', 'task', 'run', 'finding', 'verdict']);

/** node: a script file in the session's folders (or the sage state tool), never code from an option or from stdin. */
function node(args, ctx) {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return null;
  const opts = [];
  let i = 0;
  for (; i < args.length && flag(args[i]); i++) opts.push(args[i]);
  const bad = opts.find((x) => !['--test', '--check', '--no-warnings', '--test-reporter', '--test-name-pattern', '--experimental-test-coverage'].some((f) => x === f || x.startsWith(`${f}=`)));
  if (bad) return `node ${bad} (code from an option, a preload or a loader)`;
  const [script, ...rest] = args.slice(i);
  if (!script) return opts.includes('--test') ? null : 'node with no script file (code from stdin)';
  if (ctx.folders.tool && physical(expandHome(script, ctx), ctx.cwd) === ctx.folders.tool) {
    return SAGE_TOOL.has(rest[0]) && !(rest[0] === 'standing' && rest[1] === 'add') ? null : `the sage state tool command ${rest.slice(0, 2).join(' ')} (only status, logbook, merge-check, standing, task, run, finding and verdict)`;
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

/** grep and rg: a recursive search walks each folder it searches, or the current folder when it names none. */
const search = (args, ctx, recursive) => {
  const ops = operands(args);
  const folders = recursive && ops.slice(1).length === 0 ? [...ops, ctx.cwd] : ops;
  return readsOf(args, ctx) ?? (recursive ? folders.map((p) => folderRefusal(expandHome(p, ctx), ctx)).find(Boolean) ?? null : null);
};

// The allow-list of commands. A rule gives the reason of a refusal, or null.
const content = (args, ctx) => contentOf(args, ctx);
const writes = (args, ctx) => writesOf(args, ctx);
const copies = (args, ctx) => writesOf(args, ctx) ?? operands(args).map((p) => folderRefusal(expandHome(p, ctx), ctx, true)).find(Boolean) ?? null;
const COMMANDS = {
  ls: (args, ctx) => readsOf(args, ctx), cat: content, head: content, tail: content, wc: content, diff: content, cut: content, jq: content,
  grep: (args, ctx) => search(args, ctx, args.some((x) => /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|--directories=recurse|-d)$/.test(x))),
  rg: (args, ctx) => (args.some((x) => /^--pre/.test(x)) ? 'rg --pre (it runs a program)' : search(args, ctx, true)),
  sort: (args, ctx) => (args.some((x) => /^(-o|--output|--compress-program)/.test(x)) ? 'sort -o or --compress-program' : contentOf(args, ctx)),
  uniq: (args, ctx) => (operands(args).length > 1 ? 'uniq with an output file' : contentOf(args, ctx)),
  tr: () => null, file: content, stat: (args, ctx) => readsOf(args, ctx), du: (args, ctx) => readsOf(args, ctx), basename: () => null, dirname: () => null, realpath: (args, ctx) => readsOf(args, ctx),
  pwd: () => null, echo: () => null, printf: () => null, true: () => null, false: () => null, date: () => null, sleep: () => null,
  test: (args, ctx) => readsOf(args, ctx), '[': (args, ctx) => readsOf(args, ctx), which: () => null,
  mkdir: writes, touch: writes, cp: copies, mv: copies, rmdir: writes,
  rm: (args, ctx) => writesOf(args, ctx, true),
  find, git, gh, node, npm,
};

// Environment variables that a simple command may set in front of it. HOME and TMPDIR only to a folder of the session, and
// never in front of git or gh: both read their config (which can run programs) from HOME.
const ENV_ANY = new Set(['NODE_ENV', 'CI', 'NO_COLOR', 'FORCE_COLOR']);
const ENV_PATH = new Set(['HOME', 'TMPDIR']);

/** The command name and its arguments after the variables in front of it. */
const commandOf = (texts) => texts.slice(texts.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)));

/** Whether a simple command changes files in a way that can change what the checks of the parts after it saw. */
function changesFiles(texts) {
  const [cmd, ...args] = commandOf(texts);
  if (cmd === 'cp' || cmd === 'mv') return true;
  if (cmd !== 'git') return false;
  let a = args;
  while (a[0] === '-C') a = a.slice(2);
  return ['checkout', 'switch', 'restore', 'mv', 'worktree'].includes(a[0]) || (a[0] === 'stash' && !['list', 'show'].includes(a[1]));
}

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
  if (i > 0 && (cmd === 'git' || cmd === 'gh')) return how(`a variable in front of ${cmd} (${cmd} reads its config from HOME)`, `run ${cmd} with no variable in front of it`);
  const globs = words.slice(i).filter((w) => w.glob);
  if (globs.some((w) => /(^|\/)\.[^/]*[*?[]/.test(w.text) || ['rm', 'mv', 'cp', 'mkdir', 'touch', 'rmdir'].includes(cmd))) {
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
  // A wildcard reads every file of its folder: that folder must hold no secret.
  const globbed = COMMANDS[cmd] === content || ['grep', 'rg', 'sort', 'uniq'].includes(cmd) ? globs.map((w) => folderRefusal(dirname(`${w.text.split(/[*?[]/)[0]}x`), ctx)).find(Boolean) : null;
  return globbed ?? COMMANDS[cmd](args, ctx);
}

/** Why the Bash command is refused, or null. */
export function bashRefusal(command, ctx) {
  const parsed = parse(command);
  if (typeof parsed === 'string') return how(`a command the guard cannot read (${parsed})`, REPHRASE);
  const local = { ...ctx };
  for (const [k, seg] of parsed.entries()) {
    if (k < parsed.length - 1 && changesFiles(seg.words.map((w) => w.text))) {
      return how(`${commandOf(seg.words.map((w) => w.text)).slice(0, 2).join(' ')} with another command after it (it changes files that the later checks saw)`, 'run it as a call of its own, then the rest');
    }
    const why = simple(seg, local);
    if (why) return why;
  }
  return null;
}

// ---- Other tools --------------------------------------------------------------------------------------------------------

// Grep searches every file under its path, unless a glob or a type narrows it to file names that are never secrets.
const TYPES = new Set(['js', 'ts', 'json', 'md', 'css', 'html', 'py', 'go', 'rust', 'java', 'sh', 'yaml', 'toml']);
const narrow = (glob) => {
  const alts = glob.replace(/\{([^{}]*)\}/, (m, list) => `\u0002${list}\u0002`).split('\u0002');
  const all = alts.length === 3 ? alts[1].split(',').map((x) => alts[0] + x + alts[2]) : [glob];
  return all.every((g) => /\.[A-Za-z0-9]+$/.test(g) && !SECRET.test(g.replaceAll('*', '')));
};

const TOOLS = {
  Bash: (i, ctx) => bashRefusal(i.command, ctx),
  Read: (i, ctx) => readRefusal(i.file_path, ctx),
  Write: (i, ctx) => writeRefusal(i.file_path, ctx),
  Edit: (i, ctx) => writeRefusal(i.file_path, ctx),
  MultiEdit: (i, ctx) => writeRefusal(i.file_path, ctx),
  NotebookEdit: (i, ctx) => writeRefusal(i.notebook_path, ctx),
  Glob: (i, ctx) => globRefusal(i.pattern) ?? readRefusal(i.path ?? ctx.cwd, ctx),
  Grep: (i, ctx) => globRefusal(i.glob ?? '') ?? readRefusal(i.path ?? ctx.cwd, ctx) ?? ((i.glob && narrow(i.glob)) || TYPES.has(i.type) ? null : folderRefusal(i.path ?? ctx.cwd, ctx)),
  WebFetch: (i) => webRefusal(i.url),
  WebSearch: () => null, TodoWrite: () => null, Task: () => null, Agent: () => null, ToolSearch: () => null,
  // A skill only loads instructions: the tools it then uses come through this hook too.
  Skill: () => null, ExitPlanMode: () => null, BashOutput: () => null, TaskOutput: () => null, KillShell: () => null, KillBash: () => null, TaskStop: () => null,
};

const globRefusal = (pattern) => {
  if (typeof pattern !== 'string') return 'a pattern that is not text';
  if (/^[/~]|(^|\/)\.\.(\/|$)|\.\*/.test(pattern)) return `the pattern ${pattern} (it can reach outside the folder)`;
  return SECRET.test(pattern) ? `the pattern ${pattern} (files that can hold secrets)` : null;
};

/** WebFetch: http or https to a public host name or address; never this Mac, the local network or a .local name. */
function webRefusal(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'a fetch of a URL that does not parse'; }
  if (!/^https?:$/.test(u.protocol)) return 'a fetch of a URL that is not http or https';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const private4 = /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
  const ip6 = host.includes(':');
  if (!host.includes('.') && !ip6) return `a fetch of ${host} (a local host name)`;
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/.test(host) || private4.test(host)) return `a fetch of ${host} (this Mac or the local network)`;
  if (ip6 && (/^(::1?|fe[89ab][0-9a-f]:.*|f[cd][0-9a-f]{2}:.*)$/.test(host) || /^::ffff:/.test(host))) return `a fetch of ${host} (this Mac or the local network)`;
  return null;
}

/**
 * The guard's decision for one PreToolUse input: null to allow, or the refusal message for the session.
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
  // A path that is not text makes node:path throw, and the hook refuses a throw (exit code 2).
  const why = rule(input.tool_input, { folders, cwd: physical(cwd, '/') });
  return why ? refusal(why) : null;
}

/** decide() for the hook's raw stdin in a lead session: an input over MAX_INPUT bytes, or one that is not JSON, is refused before parsing. */
export function decideText(text, env) {
  if (Buffer.byteLength(text) > MAX_INPUT) return refusal(how(`a tool call over ${MAX_INPUT / 1024} KB`, 'write long text to a file in the scratch folder in parts of less than 64 KB, and pass the file'));
  let input;
  try { input = JSON.parse(text); } catch { return refusal('a hook input that is not JSON'); }
  return decide(input, env);
}
