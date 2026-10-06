// The rules of the guard hook (T133, scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead.
// decideText(stdin, env) gets the PreToolUse JSON of Claude Code and the hook's environment, and gives null (allow) or the
// message of a refusal. With SAGE_ORIGIN not "lead" the hook allows everything: the owner's own sessions are unaffected.
//
// The guard is a thin allow-list of text: which tools a lead session may use, and which commands, subcommands and options a
// Bash call may name. It reads no file and resolves no path. Where a program may read or write files, and which hosts it
// may reach, is the job of the Claude Code sandbox and the permission rules that step 6 (T134) sets (F-T134-1, F-T134-6,
// F-T134-15, F-T134-16): docs/reference.md.
// - An input over 64 KB is refused before it is parsed. scripts/guard.mjs refuses when the rules do not decide in 5 s (F-T133-62).
// - Bash: a strict parser takes the command apart into simple commands joined only by && (or a | into a read-only filter).
//   Anything it does not parse (;, ||, a $, a backtick, parentheses, braces, a backslash, a newline outside quotes, a
//   heredoc, a non-ASCII character outside quotes) is refused. Each simple command must be on the allow-list (COMMANDS), and
//   each of its options must be an entry of that command's option table by its full spelling; the rest is refused.
// - GitHub (gh, git push, git fetch) goes through the sage-bot broker tools of the session: in-process MCP tools of the Agent
//   SDK (G57 A, T158), which T134 adds to TOOLS. The hint names no command: the guard refuses each GitHub command (F-T133-63).
// - The sage state tool is refused by its name (G30 A): a lead session reaches the logbook only through sage-bot (T134).
//   The guarantee is the sandbox of T134, which denies the sage plugin folder and every logbook (G44 A, F-T134-6); this check is a
//   second layer. Its class rules: in a pipeline that runs or writes, every word is printable ASCII and has no [ wildcard; a
//   redirect target is a word like any other; node runs no script from stdin (-) or from a path under /dev/ (a device); an
//   operand that git or node --test expands as a pattern is a wildcard also inside quotes; a file tool's strings are
//   checked one by one, and its paths are printable ASCII.
// - The Grep tool, and an Agent or Task call with an isolation field, are refused. Any tool that is not in TOOLS is refused.
// - WebFetch is checked by the host text in the URL, as a second layer: a name that resolves to a local address passes;
//   T134 adds the WebFetch permission rule (T156).
//
// The environment (set by sage-bot, never by the session's model): SAGE_ORIGIN, and optionally SAGE_TOOL (the sage state
// tool, sage.mjs; a file named sage.mjs is the state tool too).
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { basename, posix } from 'node:path';

/** The largest hook input that the guard reads, in bytes. */
export const MAX_INPUT = 64 * 1024;

/** The ending of a refusal with no safe form (R442 Q1 B): a lead session runs headless, so Erick is not at a terminal. */
const STOP = 'This needs Erick; tell the sage-lead and stop this action.';
// A rule can give the safe way to do the same thing (how) after this mark; that text replaces STOP.
const MARK = '\u0001';
const how = (why, safe) => `${why}${MARK}sage can do this instead: ${safe}.`;
export const refusal = (why) => {
  const k = why.lastIndexOf(MARK);
  return `sage-bot guard: ${k < 0 ? why : why.slice(0, k)} is refused in a lead session. ${k < 0 ? STOP : why.slice(k + 1)}`;
};

// A word of the call as a refusal shows it: at most 200 characters, then an ellipsis (F-T133-57). A refusal can echo a word
// twice, and the hook's whole output must stay far below the 64 KB that a pipe holds.
const say = (text) => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

const BROKER = 'the sage-bot broker tools of the session (open a pull request, upload your branch)';
// sed and awk stay refused (F-T133-64); a read of some lines of a file has a safe form.
const LINES = 'to read lines of a file: head -n 40 <file>, tail -n +20 <file> | head -n 20, or the Read tool with offset and limit';

// ---- Bash: the parser ---------------------------------------------------------------------------------------------------

/**
 * The command as parts: [{ pipe, words: [{ text, glob }], redirects: [{ text, glob }] }], or a string: why it is refused.
 * Only && and | join parts (`pipe`: the part reads the output of the part before it); ;, ||, |& and & are refused.
 * Quoting is joined as the shell joins it (g"i"t is git). A word's `glob` holds its unquoted *, ? and [ characters.
 * A redirect's target is kept as a word, so that every check of a word sees it.
 */
export function parse(command) {
  if (typeof command !== 'string' || !command.trim()) return 'an empty command';
  const segments = [];
  let seg = { pipe: false, words: [], redirects: [] };
  let word = null;
  let pendingRedirect = null;
  const endWord = () => {
    if (word === null) return;
    (pendingRedirect ? seg.redirects : seg.words).push(word);
    pendingRedirect = null;
    word = null;
  };
  const endSegment = (pipe) => {
    endWord();
    if (pendingRedirect) throw 'a redirect with no file';
    segments.push(seg);
    seg = { pipe, words: [], redirects: [] };
  };
  const add = (ch, glob = false) => { word ??= { text: '', glob: '' }; word.text += ch; if (glob) word.glob += ch; };
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
        word ??= { text: '', glob: '' };
        word.text += body;
        i = end + 1;
      } else if (c === '"') {
        let j = i + 1;
        word ??= { text: '', glob: '' };
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
        if (!m[1].startsWith('>&')) pendingRedirect = true;
        i += m[1].length;
      } else if (/[a-zA-Z0-9_\-./=:,+@%^~\]]/.test(c)) { add(c); i++; }
      else if (c === '*' || c === '?' || c === '[') { add(c, true); i++; }
      else throw c === '\n' || c === '\r' ? 'a newline outside quotes' : `the character ${JSON.stringify(c)} outside quotes`;
    }
    endSegment(false);
  } catch (why) {
    if (typeof why === 'string') return why;
    throw why;
  }
  return segments;
}

// ---- Bash: options ------------------------------------------------------------------------------------------------------

// The kinds of an entry in an option table: a flag, an option with a value, a flag that takes a value only as --opt=value
// (git --pretty), or an array: the values allowed.
const FLAG = 0, TEXT = 1, EQ = 2;
// The entry for a number option (head -20, git log -5).
const NUM = '-<number>';

/**
 * The operands of `args` by the option table of the command `name`, or a string: why it is refused. Each option must be an
 * entry of the table by its full spelling: an abbreviation, an unknown option, a cluster of short options that is not an
 * entry, and a value given in another form are refused. A long option with a value takes it as --opt=value or --opt value,
 * a short one as -o value. `--` ends the options when the table has it. `posix`: the options end at the first operand
 * (node: the rest belongs to the script). `safe`: the rephrase of a refusal.
 */
function options(name, args, table, { posix = false, safe } = {}) {
  const ops = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' && Object.hasOwn(table, '--')) { ops.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-' || (posix && ops.length)) { ops.push(a); continue; }
    if (/^-\d+$/.test(a) && Object.hasOwn(table, NUM)) continue;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const opt = eq < 0 ? a : a.slice(0, eq);
    const kind = Object.hasOwn(table, opt) ? table[opt] : undefined;
    if (kind === undefined || (kind === FLAG && eq >= 0)) {
      const list = Object.keys(table).join(' ');
      return how(`${name} with the option ${say(a)}`, safe ?? (list ? `give ${name} only the options ${list}, each one spelled in full and alone` : `give ${name} no option`));
    }
    if (kind === FLAG || (kind === EQ && eq < 0)) continue;
    const value = eq < 0 ? args[++i] : a.slice(eq + 1);
    if (value === undefined) return `${name} ${opt} with no value`;
    if (Array.isArray(kind) && !kind.includes(value)) return `${name} ${opt} ${say(value)} (only ${kind.join(', ')})`;
  }
  return ops;
}

/** A command's rule: its option table, then `rule(ops, env)` for its operands. It gives a refusal, or the operands. `safe`: see options(). */
const cmd = (table, rule = () => null, safe = undefined) => (args, env, name) => {
  const ops = options(name, args, table, { safe });
  return typeof ops === 'string' ? ops : rule(ops, env) ?? ops;
};

const TEST = { '-f': FLAG, '-d': FLAG, '-e': FLAG, '-s': FLAG, '-r': FLAG, '-w': FLAG, '-x': FLAG, '-n': FLAG, '-z': FLAG, '-L': FLAG };
const none = cmd({});
const NPM_RUN = new Set(['ci', 'test', 't', 'run', 'run-script', 'ls', 'outdated']);

// The allow-list of commands, each with its option table. A rule gives the reason of a refusal, or null or its operands.
const COMMANDS = {
  ls: cmd({ '-l': FLAG, '-a': FLAG, '-la': FLAG, '-al': FLAG, '-A': FLAG, '-1': FLAG, '-h': FLAG, '-lh': FLAG, '-lah': FLAG, '-d': FLAG, '-t': FLAG, '-F': FLAG }),
  cat: cmd({ '-n': FLAG }),
  head: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }),
  tail: cmd({ '-n': TEXT, '-c': TEXT, [NUM]: FLAG }),
  wc: cmd({ '-l': FLAG, '-w': FLAG, '-c': FLAG, '-m': FLAG }),
  diff: cmd({ '-u': FLAG, '-q': FLAG }),
  cut: cmd({ '-d': TEXT, '-f': TEXT, '-c': TEXT }),
  jq: cmd({ '-r': FLAG, '-c': FLAG, '-e': FLAG, '-S': FLAG, '-n': FLAG }),
  // sort: no option that writes a file (-o) or runs a program is in the table.
  sort: cmd({ '-n': FLAG, '-r': FLAG, '-u': FLAG, '-nr': FLAG, '-rn': FLAG, '-k': TEXT, '-t': TEXT }),
  uniq: cmd({ '-c': FLAG, '-d': FLAG, '-u': FLAG }),
  // grep is never recursive (no option for it is in the table): rg is the search.
  grep: cmd({ '-n': FLAG, '-i': FLAG, '-in': FLAG, '-l': FLAG, '-c': FLAG, '-v': FLAG, '-w': FLAG, '-o': FLAG, '-h': FLAG, '-H': FLAG, '-E': FLAG, '-F': FLAG, '-q': FLAG, '-s': FLAG, '-x': FLAG, '-e': TEXT, '-A': TEXT, '-B': TEXT, '-C': TEXT, '-m': TEXT, '--': FLAG }),
  // rg: no option that runs a program (--pre) or follows links out (-L) is in the table.
  rg: cmd({ '-n': FLAG, '-i': FLAG, '-l': FLAG, '-c': FLAG, '-w': FLAG, '-F': FLAG, '-e': TEXT, '-g': TEXT, '--glob': TEXT, '-t': TEXT, '--type': TEXT, '-A': TEXT, '-B': TEXT, '-C': TEXT, '--files': FLAG, '--': FLAG }),
  tr: cmd({ '-d': FLAG, '-s': FLAG }),
  file: none, stat: none, du: cmd({ '-s': FLAG, '-h': FLAG, '-sh': FLAG }), realpath: none,
  basename: none, dirname: none, pwd: none, printf: none, true: none, false: none, sleep: none, which: none,
  echo: cmd({ '-n': FLAG }), date: cmd({ '-u': FLAG }),
  test: cmd(TEST), '[': cmd(TEST),
  mkdir: cmd({ '-p': FLAG }), touch: none, rmdir: none,
  cp: cmd({ '-r': FLAG, '-R': FLAG, '-p': FLAG }), mv: none,
  rm: cmd({ '-r': FLAG, '-f': FLAG, '-rf': FLAG, '-fr': FLAG, '-R': FLAG, '-Rf': FLAG, '--': FLAG }),
  // find: names and tests only; no option that runs a command, deletes or writes a file is in the table.
  find: cmd({ '-name': TEXT, '-iname': TEXT, '-type': TEXT, '-path': TEXT, '-maxdepth': TEXT, '-mindepth': TEXT, '-newer': TEXT, '-not': FLAG, '-print': FLAG, '-o': FLAG, '-a': FLAG, '-empty': FLAG }),
  git, node,
  gh: () => how('gh', BROKER),
  sed: () => how('sed', LINES),
  awk: () => how('awk', LINES),
  // npm: no option that changes its config, its prefix or its shell is in the table.
  npm: cmd({ '--silent': FLAG, '-s': FLAG, '--ignore-scripts': FLAG, '--no-audit': FLAG, '--no-fund': FLAG, '--prefer-offline': FLAG, '--': FLAG }, ([sub, script]) => {
    if (!NPM_RUN.has(sub)) return `npm ${say(sub ?? '')} (only ci, test, run, ls and outdated)`.trim();
    return /deploy|release|publish/i.test(script ?? '') ? `npm ${sub} ${say(script)} (a deploy)` : null;
  }),
};
// The commands that may read the output of the part before them through a |: read-only filters, never a shell.
const PIPE = new Set(['head', 'tail', 'wc', 'sort', 'grep']);

// ---- Bash: git and node -------------------------------------------------------------------------------------------------

/** git: the global option -C <folder> only; each subcommand on the allow-list with its option table. */
function git(args, env) {
  let a = args;
  while (a[0] === '-C') {
    if (!a[1]) return 'git -C with no folder';
    a = a.slice(2);
  }
  const [sub, ...rest] = a;
  if (sub === 'push' || sub === 'fetch') return how(`git ${sub}`, BROKER);
  // Object.hasOwn: a plain lookup finds Object.prototype's functions (git hasOwnProperty), which refuse only by a crash.
  const rule = Object.hasOwn(GIT, sub ?? '') ? GIT[sub] : null;
  if (!rule) return `git ${say(sub ?? '')} (only the listed subcommands; no global option but -C)`.trim();
  return rule(rest, env, `git ${sub}`);
}

const gitCmd = (table) => cmd({ ...table, '--': FLAG });
const STASH = cmd({ '-m': TEXT, '--message': TEXT, '-q': FLAG, '--quiet': FLAG, '-p': FLAG, '--patch': FLAG, '--stat': FLAG });
const GIT = {
  status: gitCmd({ '-s': FLAG, '--short': FLAG, '-b': FLAG, '--branch': FLAG, '-sb': FLAG, '--porcelain': FLAG }),
  diff: gitCmd({ '--stat': FLAG, '--cached': FLAG, '--staged': FLAG, '--name-only': FLAG, '--name-status': FLAG, '--shortstat': FLAG, '--check': FLAG }),
  log: gitCmd({ '--oneline': FLAG, '-p': FLAG, '--stat': FLAG, '-n': TEXT, [NUM]: FLAG, '--format': EQ, '--pretty': EQ, '--graph': FLAG, '--decorate': FLAG, '--name-only': FLAG, '--first-parent': FLAG }),
  show: gitCmd({ '--stat': FLAG, '--name-only': FLAG, '--name-status': FLAG, '--oneline': FLAG, '-s': FLAG, '--format': EQ, '--pretty': EQ }),
  'rev-parse': gitCmd({ '--show-toplevel': FLAG, '--abbrev-ref': FLAG, '--short': FLAG, '--verify': FLAG, '--is-inside-work-tree': FLAG }),
  'ls-files': gitCmd({ '-o': FLAG, '--others': FLAG, '--exclude-standard': FLAG, '-m': FLAG, '--modified': FLAG }),
  blame: gitCmd({ '-L': TEXT }),
  add: gitCmd({ '-A': FLAG, '--all': FLAG, '-u': FLAG, '--update': FLAG }),
  rm: gitCmd({ '--cached': FLAG, '-r': FLAG, '-q': FLAG }),
  mv: cmd({}),
  restore: gitCmd({ '--staged': FLAG, '-S': FLAG, '--worktree': FLAG, '-W': FLAG }),
  commit: cmd({ '-m': TEXT, '--message': TEXT, '-am': TEXT, '-a': FLAG, '--all': FLAG, '-F': TEXT, '--file': TEXT, '-q': FLAG, '--quiet': FLAG, '-s': FLAG, '--signoff': FLAG, '--allow-empty': FLAG, '-v': FLAG }),
  switch: cmd({ '-c': TEXT, '--create': TEXT }),
  checkout: cmd({ '-b': TEXT }, undefined, 'git restore <file> to undo the changes of a file, or git checkout -b <branch>'),
  branch: cmd({ '-a': FLAG, '--all': FLAG, '-r': FLAG, '--remotes': FLAG, '-v': FLAG, '-vv': FLAG, '--list': FLAG, '--show-current': FLAG, '-u': TEXT, '--set-upstream-to': TEXT, '--contains': TEXT }),
  // git takes a bare git stash with an option as git stash push (git stash -m wip): its options are checked as push's (F-T133-65).
  stash: (args, env, name) => (args[0]?.startsWith('-') ? STASH(args, env, name) : ['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0]) ? STASH(args.slice(1), env, name) : `git stash ${say(args[0])}`),
  remote: (args) => (args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null : 'git remote: a change of a remote'),
  worktree: (args, env, name) => (args[0] === 'list' && args.length === 1 ? null : args[0] === 'add' ? cmd({ '-b': TEXT })(args.slice(1), env, name) : `git worktree ${say(args[0] ?? '')}`.trim()),
};

const NODE = { '--test': FLAG, '--check': FLAG, '--no-warnings': FLAG, '--test-reporter': ['spec', 'tap', 'dot', 'junit'], '--test-name-pattern': TEXT, '--experimental-test-coverage': FLAG };

// A path under /dev/ as text (/dev/stdin, //dev/fd/0, ../../dev/stdin): a device, never a script file.
const DEV = /^(\/|(\.\.\/)+)dev(\/|$)/;
/**
 * node: a script file, never code from an option, from stdin (no script, or the script -) or from a device (a path under
 * /dev/: stdin, a file descriptor). node --test finds its own files, or takes files and patterns, each checked like a script.
 */
function node(args) {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return null;
  const ops = options('node', args, NODE, { posix: true });
  if (typeof ops === 'string') return ops;
  if (ops[0] === '-' || (!ops[0] && !args.includes('--test'))) return 'node with no script file (code from stdin)';
  const dev = (args.includes('--test') ? ops : ops.slice(0, 1)).find((p) => DEV.test(posix.normalize(p)));
  return dev ? `node with the script ${say(dev)} (a device under /dev/, such as stdin)` : ops;
}

// ---- The sage state tool ------------------------------------------------------------------------------------------------

const escape = (text) => text.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&');
// A name as the Mac's disk compares it, and wider: NFKC (the long s and full-width letters become ASCII), then lower case.
const fold = (text) => text.normalize('NFKC').toLowerCase();
const stateNames = (env) => ['sage.mjs', basename(env.SAGE_TOOL ?? '')].filter(Boolean).map(fold);
/**
 * Whether one of the texts holds the file name sage.mjs or the name of SAGE_TOOL, folded (message.mjs is another name).
 * The guard cannot see a copy under another name, or a script that builds the name: the sandbox holds those (F-T134-6).
 */
function namesStateTool(texts, env) {
  const named = new RegExp(`(^|[^a-z0-9_.-])(${stateNames(env).map(escape).join('|')})`);
  return texts.some((t) => named.test(fold(t)));
}
/**
 * Whether a wildcard word (only * and ?: a [ is refused before) can match the state tool's name in its last part.
 * A greedy match that returns only to the last * (F-T133-62): its steps are at most the word's length times the name's, so
 * 64 KB of stars decides in milliseconds. A regex with .* for each * backtracked, and 48 stars took 84 s.
 */
function mayMatchStateTool(glob, env) {
  const g = basename(fold(glob));
  return stateNames(env).some((name) => {
    let i = 0;
    let n = 0;
    let star = -1;
    let from = 0;
    while (n < name.length) {
      if (g[i] === '*') { star = i++; from = n; } else if (g[i] === '?' || g[i] === name[n]) { i++; n++; } else if (star >= 0) { i = star + 1; n = ++from; } else return false;
    }
    while (g[i] === '*') i++;
    return i === g.length;
  });
}
// The commands that run a script or write a file. With the parts that have a redirect, they are the parts that run or write.
const WRITES = new Set(['node', 'npm', 'cp', 'mv', 'git', 'tee']);
const STATE_TOOL = 'a call that may name the sage state tool (a lead session reaches the logbook only through sage-bot)';
const ASCII = /^[\x20-\x7e]*$/;
const WILDCARD = 'name each file in full instead of a wildcard, or add its folder (git add <folder>); for the tests: npm test, or node --test <file>';

/**
 * Why a wildcard is refused, or null: a [ (or, in a `pattern` operand, any pattern character but * and ?), or a * or ? that
 * can match the state tool. `chars`: the word's wildcard characters.
 */
function wildcard(text, chars, env, pattern = false) {
  const odd = pattern ? text.match(/[^A-Za-z0-9 _\-./,:=%~^*?]/) : chars.includes('[') && ['['];
  // Any other character than [ in a pattern operand (@, +, (, {, \) has no safe form: a file or revision may hold it (F-T133-51).
  if (odd && odd[0] !== '[') return `the character ${odd[0]} in the operand ${say(text)} (git and node --test can read it as a pattern)`;
  if (odd) return how(`the wildcard ${odd[0]} in ${say(text)} (in a part that runs or writes)`, WILDCARD);
  return /[*?]/.test(chars) && mayMatchStateTool(text, env) ? how(`the wildcard ${say(text)} (it can match the sage state tool)`, WILDCARD) : null;
}

// ---- Bash: parts and chains ---------------------------------------------------------------------------------------------

// Environment variables that a simple command may set in front of it; never in front of git, which reads its config
// (that can run programs) from HOME.
const ENV = new Set(['NODE_ENV', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'HOME', 'TMPDIR']);
const VAR = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The command name and its arguments after the variables in front of it. */
const commandOf = (texts) => texts.slice(texts.findIndex((t) => !VAR.test(t)));

/** Why the simple command is refused, or null. */
function simple({ words }, env) {
  const texts = words.map((w) => w.text);
  let i = 0;
  for (; i < texts.length && VAR.test(texts[i]); i++) {
    const name = texts[i].slice(0, texts[i].indexOf('='));
    if (!ENV.has(name)) return `setting ${say(name)} in front of a command`;
  }
  const [name, ...args] = texts.slice(i);
  if (!name) return 'a part with no command';
  if (i > 0 && name === 'git') return how('a variable in front of git (git reads its config from HOME)', 'run git with no variable in front of it');
  // A word that starts with a wildcard can expand to a file name that starts with -, an option that no table checked. The
  // command's own name is looked up as it is (a wildcard in it names no command; `[` is the test command).
  const glob = words.slice(i + 1).find((w) => w.glob && /^[*?[]/.test(w.text));
  if (glob) return how(`the word ${say(glob.text)} (a wildcard at its start can expand to an option)`, `start the word with a folder, for example ./${say(glob.text)}`);
  if (!Object.hasOwn(COMMANDS, name)) return `the command ${say(name)}`;
  const ops = COMMANDS[name](args, env, name);
  if (typeof ops === 'string') return ops;
  // git (a pathspec) and node --test (a test file) expand a pattern in an operand themselves, also a quoted one; the only
  // pattern characters they may get are * and ?, which must not match the state tool.
  if (name !== 'git' && !(name === 'node' && args.includes('--test'))) return null;
  for (const op of ops ?? []) {
    const why = wildcard(op, op, env, true);
    if (why) return why;
  }
  return null;
}

const REPHRASE = 'one command per call, or commands joined only by && (a | only into head, tail, wc, sort or grep), with no ;, ||, $, backtick, heredoc, (, {, \\ or newline; put long or special text in a file in the scratch folder and pass it with git commit -F <file>';

/** Why the Bash command is refused, or null. */
export function bashRefusal(command, env) {
  if (typeof command !== 'string') return 'a Bash call with no command text';
  if (namesStateTool([command], env)) return STATE_TOOL;
  const parsed = parse(command);
  if (typeof parsed === 'string') return how(`a command the guard cannot read (${parsed})`, REPHRASE);
  if (namesStateTool(parsed.flatMap((seg) => [...seg.words, ...seg.redirects]).map((w) => w.text), env)) return STATE_TOOL;
  // A pipeline is the parts joined by |. It runs or writes as a whole when one of its parts runs a script or writes a file (a
  // renamed copy): cat x | head > y writes what cat reads. Its words are then checked with their redirect targets. A read
  // (ls dir/*, cat é.txt) runs nothing.
  const pipelines = [];
  for (const seg of parsed) (seg.pipe ? pipelines.at(-1) : pipelines[pipelines.push([]) - 1]).push(seg);
  const rw = pipelines.filter((p) => p.some((seg) => WRITES.has(commandOf(seg.words.map((w) => w.text))[0]) || seg.redirects.length))
    .flat().flatMap((seg) => [...seg.words, ...seg.redirects]);
  if (rw.some((w) => !ASCII.test(w.text))) return 'a character that is not printable ASCII in a part that runs or writes';
  for (const w of rw) {
    const why = wildcard(w.text, w.glob, env);
    if (why) return why;
  }
  for (const [k, seg] of parsed.entries()) {
    const texts = seg.words.map((w) => w.text);
    if (seg.pipe && !PIPE.has(commandOf(texts)[0])) return how(`a | into ${say(commandOf(texts)[0] ?? 'nothing')}`, 'pipe only into head, tail, wc, sort or grep, or run the commands one by one');
    // cd only as the first part of a chain: the shell of the Bash tool keeps its folder, so a cd of its own moves the session.
    if (texts[0] === 'cd') {
      if (k !== 0 || parsed.length < 2 || parsed[1].pipe || texts.length !== 2 || texts[1].startsWith('-') || seg.redirects.length) {
        return how('cd other than as the first part of cd <folder> && <command>', 'cd <folder> && <command>, or name the full path in the command');
      }
      continue;
    }
    const why = simple(seg, env);
    if (why) return why;
  }
  return null;
}

// ---- Other tools --------------------------------------------------------------------------------------------------------

const allow = () => null;
// Read, Write, Edit, MultiEdit, NotebookEdit and Glob: the permission rules of step 6 hold their paths (Edit and Write only in
// the session folder and its scratch folder, Read and Glob denied on every denied path: F-T134-16; secret files: F-T134-15). A file
// tool may not name the state tool: a script that imports it, or a copy of it, is written through one. Each string of its
// input is checked on its own (in JSON text, a tab is \t and hides the name), and each path is printable ASCII.
/** Each string of a tool input with its key. An explicit stack: a recursive walk overflowed at a nesting of about 3000 (F-T133-50). */
function strings(input) {
  const all = [];
  const stack = [['', input]];
  while (stack.length) {
    const [key, v] = stack.pop();
    if (typeof v === 'string') all.push([key, v]);
    else if (v && typeof v === 'object') for (const e of Object.entries(v)) stack.push(e);
  }
  return all;
}
function file(i, env) {
  const all = strings(i);
  if (all.some(([k, v]) => k.endsWith('path') && !ASCII.test(v))) return 'a file path with a character that is not printable ASCII';
  return namesStateTool(all.map(([, v]) => v), env) ? STATE_TOOL : null;
}
// An isolation field moves the agent's work into another worktree or off this Mac, out of this hook and the sandbox.
const agent = (i) => (Object.hasOwn(i, 'isolation') ? `an agent with the isolation ${say(String(JSON.stringify(i.isolation)))}` : null);
const TOOLS = {
  Bash: (i, env) => bashRefusal(i.command, env),
  Grep: () => how('the Grep tool (the sandbox does not cover it)', 'search with rg in Bash, for example rg -n <pattern> <folder>'),
  WebFetch: (i) => webRefusal(i.url),
  Read: allow, Write: file, Edit: file, MultiEdit: file, NotebookEdit: file, Glob: allow,
  WebSearch: allow, TodoWrite: allow, Task: agent, Agent: agent, ToolSearch: allow, SendMessage: allow,
  TaskCreate: allow, TaskGet: allow, TaskList: allow, TaskUpdate: allow, EnterWorktree: allow, ExitWorktree: allow,
  // A skill only loads instructions: the tools it then uses come through this hook too.
  Skill: allow, ExitPlanMode: allow, BashOutput: allow, TaskOutput: allow, KillShell: allow, KillBash: allow, TaskStop: allow,
};

// WebFetch is checked by the host text in the URL, as a second layer; a name that resolves to a local address passes; T134
// adds the WebFetch permission rule (T156). An address in the URL must be in the global unicast space (IPv4 1 to 223, IPv6
// 2000::/3) and not in a special-purpose range inside it (the IANA registries): an allow-list, so 0/8, multicast, 240/4, the
// broadcast address and every IPv6 address outside 2000::/3 (::1, fe80::/10, fc00::/7, ff00::/8, 64:ff9b::/96) never pass.
// BlockList checks an IPv4-mapped address (::ffff:0:0/96) as its IPv4 address: ::ffff:8.8.8.8 passes, ::ffff:127.0.0.1 not (F-T133-59).
const UNICAST = new BlockList();
UNICAST.addRange('1.0.0.0', '223.255.255.255', 'ipv4');
UNICAST.addSubnet('2000::', 3, 'ipv6');
const SPECIAL = new BlockList();
for (const range of ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24']) {
  SPECIAL.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv4');
}
// IETF protocol assignments with Teredo, documentation, 6to4 (it holds an IPv4 address), documentation.
for (const range of ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20']) SPECIAL.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv6');

/** WebFetch, by the host text in the URL, as a second layer: http or https to a name that is not local, or to a global unicast address. A name that resolves to a local address passes; T134 adds the WebFetch permission rule (T156). */
function webRefusal(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'a fetch of a URL that does not parse'; }
  if (!/^https?:$/.test(u.protocol)) return 'a fetch of a URL that is not http or https';
  // The URL parser gives an IPv4 address in its dotted form (127.1 and 2130706433 are 127.0.0.1), an IPv6 one in [].
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const type = isIPv4(host) ? 'ipv4' : isIPv6(host) ? 'ipv6' : null;
  if (type) return UNICAST.check(host, type) && !SPECIAL.check(host, type) ? null : `a fetch of ${say(host)} (not a global unicast address)`;
  if (!host.includes('.')) return `a fetch of ${say(host)} (a local host name)`;
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)) return `a fetch of ${say(host)} (this Mac or the local network)`;
  return null;
}

/**
 * The guard's decision for one PreToolUse input: null to allow, or the refusal message for the session.
 * @param {unknown} input the hook's JSON (tool_name, tool_input)
 * @param {Record<string, string | undefined>} env the hook's environment
 */
export function decide(input, env) {
  if (env.SAGE_ORIGIN !== 'lead') return null;
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) {
    return refusal('a hook input that is not a tool call');
  }
  const rule = Object.hasOwn(TOOLS, input.tool_name) ? TOOLS[input.tool_name] : null;
  if (!rule) return refusal(`the tool ${say(input.tool_name)}`);
  const why = rule(input.tool_input, env);
  return why ? refusal(why) : null;
}

/** decide() for the hook's raw stdin in a lead session: an input over MAX_INPUT bytes, or one that is not JSON, is refused before parsing. */
export function decideText(text, env) {
  if (Buffer.byteLength(text) > MAX_INPUT) return refusal(how(`a tool call over ${MAX_INPUT / 1024} KB`, 'write long text to a file in the scratch folder in parts of less than 64 KB, and pass the file'));
  let input;
  try { input = JSON.parse(text); } catch { return refusal('a hook input that is not JSON'); }
  return decide(input, env);
}
