// The rules of the guard hook (T133, scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead.
// decideText(stdin, env) gets the PreToolUse JSON of Claude Code and the hook's environment, and gives null (allow) or the
// message of a refusal. With SAGE_ORIGIN not "lead" the hook allows everything: the owner's own sessions are unaffected.
//
// In a lead session it allows only what it understands (an allow-list), and refuses the rest (fail closed):
// - An input over 64 KB is refused before it is parsed, so the hook always decides well inside its timeout.
// - Bash: a strict parser takes the command apart into simple commands joined only by && (or a | into a read-only filter).
//   Anything it does not parse (;, ||, a $, a backtick, parentheses, braces, a backslash, a newline outside quotes, a
//   heredoc, a non-ASCII character outside quotes) is refused. Each simple command must be on the allow-list (COMMANDS), and
//   each of its options must be an entry of that command's option table by its full spelling; the rest is refused. Every
//   operand that names a file must be inside the session's folders. Bash reads files only, never a folder by recursion.
// - The file tools: reads inside the worktree, the scratch folder and the repository; writes inside the worktree and the
//   scratch folder only. Paths are resolved through every symbolic link, as the system would, before the check.
// - A search or a copy of a folder is refused when the folder holds a file that can hold secrets. All the folder walks of one
//   tool call share one budget of entries.
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

// All the folder walks of one tool call share one budget of this many entries; when it runs out, the guard refuses. So the
// guard decides quickly, also when a call names one large folder many times.
const WALK_MAX = 20000;
/**
 * Why a content search, a copy or a move of the folder `path` is refused, or null: the folder holds a file that can hold
 * secrets, or a link that leads out of the session's folders (and, for a copy or a move, a file named HEAD). A worktree's
 * .git file (a pointer to its repository) is not counted. Folders named node_modules below the folder are not walked: npm
 * fills them from the lock file, and a move or a copy of a folder with secrets into them is refused here first.
 * Each entry counts against ctx.walk, the budget of the whole tool call.
 */
function folderRefusal(path, ctx, copy = false) {
  const root = physical(path, ctx.cwd);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (--ctx.walk.left < 0) return how(`a search or a copy of ${path} (more than ${WALK_MAX} files to check in one call)`, 'name fewer or smaller folders, one call for each');
      const p = join(dir, e.name);
      if (e.name === '.git' && e.isFile()) continue;
      const bad = SECRET.test(p) || (copy && /^head$/i.test(e.name)) || (e.isSymbolicLink() && readRefusal(p, ctx));
      if (bad) return how(`a search or a copy of ${path} (it holds ${p.slice(root.length + 1)}, a file that can hold secrets, a file named HEAD or a link out of the session's folders)`, 'name a folder or the files without it, or use the Grep tool with a glob such as **/*.js');
      if (e.isDirectory() && e.name !== 'node_modules') stack.push(p);
    }
  }
  return null;
}

// ---- Bash: the parser ---------------------------------------------------------------------------------------------------

/**
 * The command as parts: [{ pipe, words: [{ text, glob }], redirects: [{ op, target }] }], or a string: why it is refused.
 * Only && and | join parts (`pipe`: the part reads the output of the part before it); ;, ||, |& and & are refused.
 * Quoting is joined as the shell joins it (g"i"t is git). A word's `glob` says that it has an unquoted *, ? or [.
 */
export function parse(command) {
  if (typeof command !== 'string' || !command.trim()) return 'an empty command';
  const segments = [];
  let seg = { pipe: false, words: [], redirects: [] };
  let word = null;
  let pendingRedirect = null;
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) { seg.redirects.push({ op: pendingRedirect, target: word.text }); pendingRedirect = null; } else seg.words.push(word);
    word = null;
  };
  const endSegment = (pipe) => {
    endWord();
    if (pendingRedirect) throw 'a redirect with no file';
    segments.push(seg);
    seg = { pipe, words: [], redirects: [] };
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
      else if (rest.startsWith('&&')) { endSegment(false); i += 2; }
      else if (c === '|' && !/^\|[|&]/.test(rest)) { endSegment(true); i++; }
      else if (c === ';' || c === '&' || c === '|') throw `the operator ${rest.match(/^(;+|\|\||\|&|&)/)[0]} (only && joins parts)`;
      else if (c === '>' || c === '<') {
        const fd = word && /^\d$/.test(word.text) ? word.text : '';
        if (word && !fd) endWord();
        word = null;
        const m = rest.match(/^(>>|>&[12](?![^\s&|])|>|<)/);
        if (!m || /^(<<|<>|<&|>\||<\()/.test(rest)) throw `the redirect ${rest.slice(0, 2)}`;
        if (!m[1].startsWith('>&')) pendingRedirect = m[1];
        i += m[1].length;
      } else if (/[a-zA-Z0-9_\-./=:,+@%^\]]/.test(c)) { add(c); i++; }
      else if (c === '*' || c === '?' || c === '[') { add(c, true); i++; }
      else if (c === '~') {
        // At the start of a word: the home folder (~ or ~/x). Inside a word: only a revision (HEAD~1, main~), which the
        // shell never expands; never after = or :, where the shell does expand it.
        if (word !== null ? !/[A-Za-z0-9_]$/.test(word.text) || !/^~(\d|$|[\s&|])/.test(rest) : !/^~(\/|$|[\s&|])/.test(rest)) throw 'a ~ that the shell can expand';
        add(c); i++;
      } else throw c === '\n' || c === '\r' ? 'a newline outside quotes' : `the character ${JSON.stringify(c)} outside quotes`;
    }
    endSegment(false);
  } catch (why) {
    if (typeof why === 'string') return why;
    throw why;
  }
  return segments;
}

// ---- Bash: options and operands -----------------------------------------------------------------------------------------

// The kinds of an entry in an option table: a flag; or an option with a value that is text, a path that is read, or a body
// file (read, and only from the scratch folder); or an array: the values allowed.
const FLAG = 0, TEXT = 1, READ = 2, BODY = 3;
// The entry for a number option (head -20, git log -5).
const NUM = '-<number>';

const expandHome = (p, ctx) => (p === '~' ? ctx.folders.home : p.startsWith('~/') ? ctx.folders.home + p.slice(1) : p);

/** Why a body file (gh --body-file, -F) is refused, or null: it must be in the scratch folder. */
const bodyRefusal = (f, ctx) => (readRefusal(expandHome(f, ctx), ctx) || !within(physical(expandHome(f, ctx), ctx.cwd), ctx.folders.scratch)
  ? how(`the body file ${f}`, 'write the body to a file in the scratch folder and pass it with --body-file') : null);

/**
 * The options and operands of `args` by the option table of the command `name`: { opts: [[option, value]], ops }, or a
 * string: why it is refused. Each option must be an entry of the table by its full spelling: an abbreviation, an unknown
 * option, a cluster of short options that is not an entry, and a value given in another form are refused. A long option
 * with a value takes it as --opt=value or --opt value, a short one as -o value. `--` ends the options when the table has it.
 * `posix`: the options end at the first operand (node: the rest belongs to the script). `safe`: the rephrase of a refusal.
 */
function options(name, args, table, ctx, { posix = false, safe } = {}) {
  const opts = [];
  const ops = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' && Object.hasOwn(table, '--')) { ops.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-' || (posix && ops.length)) { ops.push(a); continue; }
    if (/^-\d+$/.test(a) && Object.hasOwn(table, NUM)) { opts.push([NUM, a]); continue; }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const opt = eq < 0 ? a : a.slice(0, eq);
    const kind = Object.hasOwn(table, opt) ? table[opt] : undefined;
    if (kind === undefined || (kind === FLAG && eq >= 0)) {
      const list = Object.keys(table).join(' ');
      return how(`${name} with the option ${a}`, safe ?? (list ? `give ${name} only the options ${list}, each one spelled in full and alone` : `give ${name} no option`));
    }
    if (kind === FLAG) { opts.push([opt]); continue; }
    const value = eq < 0 ? args[++i] : a.slice(eq + 1);
    if (value === undefined) return `${name} ${opt} with no value`;
    const why = Array.isArray(kind) ? (kind.includes(value) ? null : `${name} ${opt} ${value} (only ${kind.join(', ')})`)
      : kind === READ ? readRefusal(expandHome(value, ctx), ctx) : kind === BODY ? bodyRefusal(value, ctx) : null;
    if (why) return why;
    opts.push([opt, value]);
  }
  return { opts, ops };
}

/** A command's rule: its option table, then `rule(ops, ctx, opts)` for its operands. */
const cmd = (table, rule = () => null) => (args, ctx, name) => {
  const r = options(name, args, table, ctx);
  return typeof r === 'string' ? r : rule(r.ops, ctx, r.opts);
};

/** What the path names now: 'folder', 'file', 'other' or 'none'. */
const kindOf = (p, ctx) => {
  try { const s = statSync(physical(expandHome(p, ctx), ctx.cwd)); return s.isDirectory() ? 'folder' : s.isFile() ? 'file' : 'other'; } catch { return 'none'; }
};
/** The first refusal of `check` over `list`, or null; it stops there, so no later path is resolved or walked. */
const first = (list, check) => { for (const x of list) { const why = check(x); if (why) return why; } return null; };
/** Why the reads of the paths `ops` are refused, or null. */
const reads = (ops, ctx) => first(ops, (p) => readRefusal(expandHome(p, ctx), ctx));
/** Why the writes of the paths `ops` are refused, or null. `strict`: the worktree or the scratch folder itself is refused. */
const writes = (ops, ctx, strict = false) => first(ops, (p) => writeRefusal(expandHome(p, ctx), ctx, strict));
/** Why the walks of the folders `ops` are refused, or null (`copy`: a copy or a move). */
const walks = (ops, ctx, copy = false) => first(ops, (p) => folderRefusal(expandHome(p, ctx), ctx, copy));
/** Why a content read of the files `ops` is refused, or null: each is a read, and none is a folder (no recursion). */
const files = (ops, ctx) => {
  const folder = ops.find((p) => kindOf(p, ctx) === 'folder');
  return reads(ops, ctx) ?? (folder === undefined ? null : how(`${folder} as an operand (a folder: this command takes files only)`, 'name the files, or search a folder with the Grep tool'));
};
/** grep and rg: the first operand is the pattern, unless -e gives it. */
const searched = (ops, opts) => (opts.some(([o]) => o === '-e') ? ops : ops.slice(1));

const TEST = { '-f': FLAG, '-d': FLAG, '-e': FLAG, '-s': FLAG, '-r': FLAG, '-w': FLAG, '-x': FLAG, '-n': FLAG, '-z': FLAG, '-L': FLAG };
const none = cmd({});
const NPM_RUN = new Set(['ci', 'test', 't', 'run', 'run-script', 'ls', 'outdated']);

// The allow-list of commands, each with its option table. A rule gives the reason of a refusal, or null.
const COMMANDS = {
  ls: cmd({ '-l': FLAG, '-a': FLAG, '-la': FLAG, '-al': FLAG, '-A': FLAG, '-1': FLAG, '-h': FLAG, '-lh': FLAG, '-lah': FLAG, '-d': FLAG, '-t': FLAG, '-F': FLAG }, reads),
  cat: cmd({ '-n': FLAG }, files),
  head: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }, files),
  tail: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }, files),
  wc: cmd({ '-l': FLAG, '-w': FLAG, '-c': FLAG, '-m': FLAG }, files),
  diff: cmd({ '-u': FLAG, '-q': FLAG }, files),
  cut: cmd({ '-d': TEXT, '-f': TEXT, '-c': TEXT }, files),
  jq: cmd({ '-r': FLAG, '-c': FLAG, '-e': FLAG, '-S': FLAG, '-n': FLAG }, (ops, ctx) => files(ops.slice(1), ctx)),
  // sort: no option that writes a file (-o) or runs a program is in the table.
  sort: cmd({ '-n': FLAG, '-r': FLAG, '-u': FLAG, '-nr': FLAG, '-rn': FLAG, '-k': TEXT, '-t': TEXT }, files),
  uniq: cmd({ '-c': FLAG, '-d': FLAG, '-u': FLAG }, (ops, ctx) => (ops.length > 1 ? 'uniq with an output file' : files(ops, ctx))),
  // grep is never recursive: no option for it is in the table, and a folder is refused as an operand.
  grep: cmd({ '-n': FLAG, '-i': FLAG, '-in': FLAG, '-l': FLAG, '-c': FLAG, '-v': FLAG, '-w': FLAG, '-o': FLAG, '-h': FLAG, '-H': FLAG, '-E': FLAG, '-F': FLAG, '-q': FLAG, '-s': FLAG, '-x': FLAG, '-e': TEXT, '-A': TEXT, '-B': TEXT, '-C': TEXT, '-m': TEXT, '--': FLAG },
    (ops, ctx, opts) => files(searched(ops, opts), ctx)),
  // rg searches a folder (and the current folder, when it names none) by recursion: it takes existing files only.
  rg: cmd({ '-n': FLAG, '-i': FLAG, '-l': FLAG, '-c': FLAG, '-w': FLAG, '-F': FLAG, '-e': TEXT, '--': FLAG }, (ops, ctx, opts) => {
    const named = searched(ops, opts);
    return named.length && named.every((p) => kindOf(p, ctx) === 'file') ? files(named, ctx)
      : how('rg with no file, or with a path that is not an existing file (rg searches a folder by recursion)', 'name existing files, or search a folder with the Grep tool');
  }),
  tr: cmd({ '-d': FLAG, '-s': FLAG }),
  file: cmd({}, reads), stat: cmd({}, reads), du: cmd({ '-s': FLAG, '-h': FLAG, '-sh': FLAG }, reads), realpath: cmd({}, reads),
  basename: none, dirname: none, pwd: none, printf: none, true: none, false: none, sleep: none, which: none,
  echo: cmd({ '-n': FLAG }), date: cmd({ '-u': FLAG }),
  test: cmd(TEST, reads), '[': cmd(TEST, reads),
  mkdir: cmd({ '-p': FLAG }, writes), touch: cmd({}, writes), rmdir: cmd({}, writes),
  cp: cmd({ '-r': FLAG, '-R': FLAG, '-p': FLAG }, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),
  mv: cmd({}, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),
  rm: cmd({ '-r': FLAG, '-f': FLAG, '-rf': FLAG, '-fr': FLAG, '-R': FLAG, '-Rf': FLAG, '--': FLAG }, (ops, ctx) => writes(ops, ctx, true)),
  // find: names and tests only; no option that runs a command, deletes or writes a file is in the table.
  find: cmd({ '-name': TEXT, '-iname': TEXT, '-type': TEXT, '-path': TEXT, '-maxdepth': TEXT, '-mindepth': TEXT, '-newer': READ, '-not': FLAG, '-print': FLAG, '-o': FLAG, '-a': FLAG, '-empty': FLAG }, reads),
  git, gh, node,
  // npm: no option that changes its config, its prefix or its shell is in the table.
  npm: cmd({ '--silent': FLAG, '-s': FLAG, '--ignore-scripts': FLAG, '--no-audit': FLAG, '--no-fund': FLAG, '--prefer-offline': FLAG, '--': FLAG }, ([sub, script]) => {
    if (!NPM_RUN.has(sub)) return `npm ${sub ?? ''} (only ci, test, run, ls and outdated)`.trim();
    return /deploy|release|publish/i.test(script ?? '') ? `npm ${sub} ${script} (a deploy)` : null;
  }),
};
// The commands that may read the output of the part before them through a |: read-only filters, never a shell.
const PIPE = new Set(['head', 'tail', 'wc', 'sort', 'grep']);
// The commands that may take a wildcard. For all but ls (names only), the wildcard's folder is walked first.
const GLOBS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'sort', 'cut', 'diff', 'file', 'jq', 'uniq']);

// ---- Bash: git, gh and node ---------------------------------------------------------------------------------------------

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
  return rule(rest, ctx, `git ${sub}`);
}

/**
 * git add: only `git add -- <file> ...`, each an existing file (not a folder) by its literal name. git reads each name as a
 * pattern (a wildcard, and magic such as :(glob) after a colon), so a name with *, ?, [, ], \ or : is refused.
 */
function add(args, ctx) {
  const safe = 'git add -- <file> <file>, each file by its full name (git rm -- <file> for a deleted file)';
  if (args[0] !== '--' || args.length < 2) return how('git add without -- and file names (an option, a folder or a pattern)', safe);
  for (const f of args.slice(1)) {
    if (/[*?[\]\\:]/.test(f)) return how(`git add of ${f} (git reads it as a pattern)`, safe);
    const why = writeRefusal(expandHome(f, ctx), ctx);
    if (why) return `git add: ${why}`;
    if (kindOf(f, ctx) !== 'file') return how(`git add of ${f} (a folder, or not an existing file)`, safe);
  }
  return null;
}

const gitRead = (table) => cmd({ ...table, '--': FLAG }, reads);
const STASH = cmd({ '-m': TEXT, '--message': TEXT, '-q': FLAG, '--quiet': FLAG, '-p': FLAG, '--patch': FLAG, '--stat': FLAG });
const GIT = {
  status: gitRead({ '-s': FLAG, '--short': FLAG, '-b': FLAG, '--branch': FLAG, '-sb': FLAG, '--porcelain': FLAG }),
  diff: gitRead({ '--stat': FLAG, '--cached': FLAG, '--staged': FLAG, '--name-only': FLAG, '--name-status': FLAG, '--shortstat': FLAG, '--check': FLAG }),
  log: gitRead({ '--oneline': FLAG, '-p': FLAG, '--stat': FLAG, '-n': TEXT, [NUM]: FLAG, '--format': TEXT, '--pretty': TEXT, '--graph': FLAG, '--decorate': FLAG, '--name-only': FLAG, '--first-parent': FLAG }),
  show: gitRead({ '--stat': FLAG, '--name-only': FLAG, '--name-status': FLAG, '--oneline': FLAG, '-s': FLAG, '--format': TEXT, '--pretty': TEXT }),
  'rev-parse': gitRead({ '--show-toplevel': FLAG, '--abbrev-ref': FLAG, '--short': FLAG, '--verify': FLAG, '--is-inside-work-tree': FLAG }),
  'ls-files': gitRead({ '-o': FLAG, '--others': FLAG, '--exclude-standard': FLAG, '-m': FLAG, '--modified': FLAG }),
  blame: gitRead({ '-L': TEXT }),
  add,
  rm: cmd({ '--cached': FLAG, '-r': FLAG, '-q': FLAG, '--': FLAG }, writes),
  mv: cmd({}, (ops, ctx) => writes(ops, ctx) ?? walks(ops, ctx, true)),
  restore: cmd({ '--staged': FLAG, '-S': FLAG, '--worktree': FLAG, '-W': FLAG, '--': FLAG }, writes),
  commit: cmd({ '-m': TEXT, '--message': TEXT, '-am': TEXT, '-a': FLAG, '--all': FLAG, '-F': READ, '--file': READ, '-q': FLAG, '--quiet': FLAG, '-s': FLAG, '--signoff': FLAG, '--allow-empty': FLAG, '-v': FLAG },
    (ops) => (ops.length ? how('git commit with file names (git reads them as patterns)', 'git add -- <file>, then git commit -F <file>') : null)),
  fetch: cmd({ '-q': FLAG, '--quiet': FLAG, '--prune': FLAG, '-p': FLAG },
    (ops) => (ops[0] === 'origin' && ops.slice(1).every((r) => /^[A-Za-z0-9._/-]+$/.test(r)) ? null : how('git fetch from a remote other than origin, or of a refspec', 'git fetch origin'))),
  switch: cmd({ '-c': TEXT, '--create': TEXT }),
  checkout: cmd({ '-b': TEXT }, writes),
  branch: cmd({ '-a': FLAG, '--all': FLAG, '-r': FLAG, '--remotes': FLAG, '-v': FLAG, '-vv': FLAG, '--list': FLAG, '--show-current': FLAG, '-u': TEXT, '--set-upstream-to': TEXT, '--contains': TEXT }),
  stash: (args, ctx, name) => (['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0]) ? STASH(args.slice(1), ctx, name) : `git stash ${args[0]}`),
  remote: (args) => (args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null : 'git remote: a change of a remote'),
  worktree: (args, ctx, name) => (args[0] === 'list' && args.length === 1 ? null : args[0] === 'add' ? cmd({ '-b': TEXT }, writes)(args.slice(1), ctx, name) : `git worktree ${args[0] ?? ''}`.trim()),
  push,
};

/** git push: only `git push [-u] origin <SAGE_BRANCH>` (or HEAD:<SAGE_BRANCH>), the session's own branch by its name. */
function push(args, ctx, name) {
  const mine = ctx.folders.branch;
  if (!mine || PROTECTED.test(mine) || !/^[A-Za-z0-9._/-]+$/.test(mine)) return 'git push (the session has no branch of its own in SAGE_BRANCH)';
  const safe = `git push origin ${mine}`;
  const r = options(name, args, { '-u': FLAG, '--set-upstream': FLAG, '-q': FLAG, '--quiet': FLAG, '-v': FLAG, '--verbose': FLAG }, ctx, { safe });
  if (typeof r === 'string') return r;
  const [remote, ref, ...more] = r.ops;
  if (remote !== 'origin' || more.length || ![mine, `HEAD:${mine}`].includes(ref)) return how(`git push to anything but origin ${mine}, the session's own branch`, safe);
  return null;
}

/** gh: only these commands, each with its option table. Never merge, api, secret, auth, release, workflow, alias or extension. */
const GH_BODY = { '--title': TEXT, '-t': TEXT, '--body': TEXT, '-b': TEXT, '--body-file': BODY, '-F': BODY };
const GH = {
  'pr create': { ...GH_BODY, '--base': TEXT, '-B': TEXT, '--head': TEXT, '-H': TEXT, '--draft': FLAG, '-d': FLAG, '--fill': FLAG },
  'pr edit': GH_BODY,
  'pr view': { '--json': TEXT, '--jq': TEXT, '-q': TEXT, '--comments': FLAG, '-c': FLAG },
  'pr list': { '--state': TEXT, '-s': TEXT, '--limit': TEXT, '-L': TEXT, '--json': TEXT, '--jq': TEXT, '--head': TEXT, '-H': TEXT, '--base': TEXT, '-B': TEXT, '--author': TEXT },
  'pr diff': { '--name-only': FLAG, '--patch': FLAG },
  'pr checks': { '--required': FLAG, '--watch': FLAG, '--json': TEXT },
  'pr status': {},
  'issue view': { '--json': TEXT, '--comments': FLAG },
  'issue list': { '--state': TEXT, '--limit': TEXT, '-L': TEXT, '--json': TEXT, '--label': TEXT },
  'run view': { '--log': FLAG, '--log-failed': FLAG, '--json': TEXT, '--job': TEXT },
  'run list': { '--limit': TEXT, '-L': TEXT, '--json': TEXT, '--branch': TEXT, '-b': TEXT },
  'repo view': { '--json': TEXT },
};
function gh(args, ctx) {
  const sub = args.slice(0, 2).join(' ');
  if (!Object.hasOwn(GH, sub)) return `gh ${sub}`.trim();
  const r = options(`gh ${sub}`, args.slice(2), GH[sub], ctx, sub === 'pr edit' ? { safe: 'gh pr edit <number> --title <title> --body-file <file in the scratch folder>' } : {});
  return typeof r === 'string' ? r : null;
}

// The sage state tool's commands that a lead session may run: the reads, and the records of its own work.
const SAGE_TOOL = new Set(['status', 'logbook', 'merge-check', 'standing', 'task', 'run', 'finding', 'verdict']);
const NODE = { '--test': FLAG, '--check': FLAG, '--no-warnings': FLAG, '--test-reporter': ['spec', 'tap', 'dot', 'junit'], '--test-name-pattern': TEXT, '--experimental-test-coverage': FLAG };

/** node: a script file in the session's folders (or the sage state tool), never code from an option or from stdin. */
function node(args, ctx) {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return null;
  const r = options('node', args, NODE, ctx, { posix: true });
  if (typeof r === 'string') return r;
  const test = r.opts.some(([o]) => o === '--test');
  const [script, ...rest] = r.ops;
  if (!script) return test ? null : 'node with no script file (code from stdin)';
  if (ctx.folders.tool && physical(expandHome(script, ctx), ctx.cwd) === ctx.folders.tool) {
    return SAGE_TOOL.has(rest[0]) && !(rest[0] === 'standing' && rest[1] === 'add') ? null : `the sage state tool command ${rest.slice(0, 2).join(' ')} (only status, logbook, merge-check, standing, task, run, finding and verdict)`;
  }
  if (!/\.(m|c)?js$/.test(script) && !test) return `node ${script} (not a .js, .mjs or .cjs file)`;
  return reads(test ? r.ops : [script], ctx);
}

// ---- Bash: parts and chains ---------------------------------------------------------------------------------------------

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

/**
 * cd: only into a folder that exists now and that the system resolves (through every link) inside the worktree or the
 * scratch folder. Then the shell moves exactly where the checks of the later parts look; if the cd fails anyway, && stops.
 */
function cd(args, ctx) {
  const safe = 'cd <a folder in the worktree or the scratch folder> && <command>, or name the full path in the command';
  if (args.length !== 1) return how('cd with no folder, with options or with more than one folder', safe);
  const p = expandHome(args[0], ctx);
  let to;
  try { to = realpathSync.native(isAbsolute(p) ? p : `${ctx.cwd}/${p}`); } catch { return how(`cd ${args[0]} (not an existing folder)`, safe); }
  if (kindOf(to, ctx) !== 'folder' || readRefusal(to, ctx) || ![ctx.folders.worktree, ctx.folders.scratch].some((r) => within(to, r))) {
    return how(`cd ${args[0]} (only into a folder in the worktree or the scratch folder)`, safe);
  }
  ctx.cwd = to;
  return null;
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
  if (!cmd) return 'a part with no command';
  if (i > 0 && (cmd === 'git' || cmd === 'gh')) return how(`a variable in front of ${cmd} (${cmd} reads its config from HOME)`, `run ${cmd} with no variable in front of it`);
  // The command's own name is looked up as it is (a wildcard in it names no command); `[` is the test command.
  const globs = words.slice(i + 1).filter((w) => w.glob);
  if (globs.length && (!GLOBS.has(cmd) || globs.some((w) => /(^|\/)\.[^/]*[*?[]/.test(w.text)))) {
    return how(`a wildcard in ${cmd} (it can reach .. or a file that the check did not see)`, 'name each file');
  }
  if (cmd === 'cd') return cd(args, ctx);
  if (!Object.hasOwn(COMMANDS, cmd)) return `the command ${cmd}`;
  // A wildcard of a content read reads every file of its folder: that folder must hold no secret.
  const walked = cmd === 'ls' ? null : walks(globs.map((w) => dirname(`${w.text.split(/[*?[]/)[0]}x`)), ctx);
  return walked ?? COMMANDS[cmd](args, ctx, cmd);
}

const REPHRASE = 'one command per call, or commands joined only by && (a | only into head, tail, wc, sort or grep), with no ;, ||, $, backtick, heredoc, (, {, \\ or newline; put long or special text in a file in the scratch folder and pass it with git commit -F <file> or gh pr create --body-file <file>';

/** Why the Bash command is refused, or null. */
export function bashRefusal(command, ctx) {
  const parsed = parse(command);
  if (typeof parsed === 'string') return how(`a command the guard cannot read (${parsed})`, REPHRASE);
  const local = { ...ctx };
  for (const [k, seg] of parsed.entries()) {
    const texts = seg.words.map((w) => w.text);
    if (seg.pipe && !PIPE.has(commandOf(texts)[0])) return how(`a | into ${commandOf(texts)[0] ?? 'nothing'}`, 'pipe only into head, tail, wc, sort or grep, or run the commands one by one');
    if (k < parsed.length - 1 && changesFiles(texts)) {
      return how(`${commandOf(texts).slice(0, 2).join(' ')} with another command after it (it changes files that the later checks saw)`, 'run it as a call of its own, then the rest');
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
  const why = rule(input.tool_input, { folders, cwd: physical(cwd, '/'), walk: { left: WALK_MAX } });
  return why ? refusal(why) : null;
}

/** decide() for the hook's raw stdin in a lead session: an input over MAX_INPUT bytes, or one that is not JSON, is refused before parsing. */
export function decideText(text, env) {
  if (Buffer.byteLength(text) > MAX_INPUT) return refusal(how(`a tool call over ${MAX_INPUT / 1024} KB`, 'write long text to a file in the scratch folder in parts of less than 64 KB, and pass the file'));
  let input;
  try { input = JSON.parse(text); } catch { return refusal('a hook input that is not JSON'); }
  return decide(input, env);
}
