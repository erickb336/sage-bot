// The rules of the guard hook (T133, scripts/guard.mjs) for a sage session that sage-bot starts for a sage-lead.
// decideText(stdin, env) gets the PreToolUse JSON of Claude Code and the hook's environment, and gives null (allow) or the
// message of a refusal. With SAGE_ORIGIN not "lead" the hook allows everything: the owner's own sessions are unaffected.
//
// The guard is a thin allow-list of text: which tools a lead session may use, and which commands, subcommands and options a
// Bash call may name. It reads no file and resolves no path. Where a program may read or write files, and which hosts it
// may reach, is the job of the Claude Code sandbox and the permission rules that step 6 (T134) sets: docs/reference.md.
// - An input over 64 KB is refused before it is parsed, so the hook always decides well inside its timeout.
// - Bash: a strict parser takes the command apart into simple commands joined only by && (or a | into a read-only filter).
//   Anything it does not parse (;, ||, a $, a backtick, parentheses, braces, a backslash, a newline outside quotes, a
//   heredoc, a non-ASCII character outside quotes) is refused. Each simple command must be on the allow-list (COMMANDS), and
//   each of its options must be an entry of that command's option table by its full spelling; the rest is refused.
// - GitHub (gh, git push, git fetch) goes through sage-bot's broker, sage-bot-github, which step 6 adds.
// - The sage state tool is refused in every form (G30 A): a lead session reaches the logbook only through sage-bot (T134).
// - The Grep tool, and an Agent or Task call with an isolation field, are refused. Any tool that is not in TOOLS is refused.
// - WebFetch reaches only a host name or a global unicast address.
//
// The environment (set by sage-bot, never by the session's model): SAGE_ORIGIN, and optionally SAGE_TOOL (the sage state
// tool, sage.mjs; a file named sage.mjs is the state tool too).
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { basename } from 'node:path';

/** The largest hook input that the guard reads, in bytes. */
export const MAX_INPUT = 64 * 1024;

const ASK = 'Erick must approve this at the terminal.';
// A rule can give its own ending after this mark: the safe way to do the same thing (how), or stop (stop).
const MARK = '\u0001';
const how = (why, safe) => `${why}${MARK}sage can do this instead: ${safe}.`;
const stop = (why) => `${why}${MARK}This needs Erick; tell the sage-lead and stop this action.`;
const refusal = (why) => {
  const k = why.lastIndexOf(MARK);
  return `sage-bot guard: ${k < 0 ? why : why.slice(0, k)} is refused in a lead session. ${k < 0 ? ASK : why.slice(k + 1)}`;
};

const BROKER = "sage-bot-github, the GitHub broker of step 6, for a fetch, an upload to the session's own branch and the session's own pull request (create, edit, view)";

// ---- Bash: the parser ---------------------------------------------------------------------------------------------------

/**
 * The command as parts: [{ pipe, words: [{ text, glob }], redirects: [op] }], or a string: why it is refused.
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
    if (pendingRedirect) { seg.redirects.push(pendingRedirect); pendingRedirect = null; } else seg.words.push(word);
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

// The kinds of an entry in an option table: a flag, an option with a value, or an array: the values allowed.
const FLAG = 0, TEXT = 1;
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
      return how(`${name} with the option ${a}`, safe ?? (list ? `give ${name} only the options ${list}, each one spelled in full and alone` : `give ${name} no option`));
    }
    if (kind === FLAG) continue;
    const value = eq < 0 ? args[++i] : a.slice(eq + 1);
    if (value === undefined) return `${name} ${opt} with no value`;
    if (Array.isArray(kind) && !kind.includes(value)) return `${name} ${opt} ${value} (only ${kind.join(', ')})`;
  }
  return ops;
}

/** A command's rule: its option table, then `rule(ops, env)` for its operands. */
const cmd = (table, rule = () => null) => (args, env, name) => {
  const ops = options(name, args, table);
  return typeof ops === 'string' ? ops : rule(ops, env);
};

const TEST = { '-f': FLAG, '-d': FLAG, '-e': FLAG, '-s': FLAG, '-r': FLAG, '-w': FLAG, '-x': FLAG, '-n': FLAG, '-z': FLAG, '-L': FLAG };
const none = cmd({});
const NPM_RUN = new Set(['ci', 'test', 't', 'run', 'run-script', 'ls', 'outdated']);

// The allow-list of commands, each with its option table. A rule gives the reason of a refusal, or null.
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
  // npm: no option that changes its config, its prefix or its shell is in the table.
  npm: cmd({ '--silent': FLAG, '-s': FLAG, '--ignore-scripts': FLAG, '--no-audit': FLAG, '--no-fund': FLAG, '--prefer-offline': FLAG, '--': FLAG }, ([sub, script]) => {
    if (!NPM_RUN.has(sub)) return `npm ${sub ?? ''} (only ci, test, run, ls and outdated)`.trim();
    return /deploy|release|publish/i.test(script ?? '') ? `npm ${sub} ${script} (a deploy)` : null;
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
  if (!rule) return `git ${sub ?? ''} (only the listed subcommands; no global option but -C)`.trim();
  return rule(rest, env, `git ${sub}`);
}

const gitCmd = (table) => cmd({ ...table, '--': FLAG });
const STASH = cmd({ '-m': TEXT, '--message': TEXT, '-q': FLAG, '--quiet': FLAG, '-p': FLAG, '--patch': FLAG, '--stat': FLAG });
const GIT = {
  status: gitCmd({ '-s': FLAG, '--short': FLAG, '-b': FLAG, '--branch': FLAG, '-sb': FLAG, '--porcelain': FLAG }),
  diff: gitCmd({ '--stat': FLAG, '--cached': FLAG, '--staged': FLAG, '--name-only': FLAG, '--name-status': FLAG, '--shortstat': FLAG, '--check': FLAG }),
  log: gitCmd({ '--oneline': FLAG, '-p': FLAG, '--stat': FLAG, '-n': TEXT, [NUM]: FLAG, '--format': TEXT, '--pretty': TEXT, '--graph': FLAG, '--decorate': FLAG, '--name-only': FLAG, '--first-parent': FLAG }),
  show: gitCmd({ '--stat': FLAG, '--name-only': FLAG, '--name-status': FLAG, '--oneline': FLAG, '-s': FLAG, '--format': TEXT, '--pretty': TEXT }),
  'rev-parse': gitCmd({ '--show-toplevel': FLAG, '--abbrev-ref': FLAG, '--short': FLAG, '--verify': FLAG, '--is-inside-work-tree': FLAG }),
  'ls-files': gitCmd({ '-o': FLAG, '--others': FLAG, '--exclude-standard': FLAG, '-m': FLAG, '--modified': FLAG }),
  blame: gitCmd({ '-L': TEXT }),
  add: gitCmd({ '-A': FLAG, '--all': FLAG, '-u': FLAG, '--update': FLAG }),
  rm: gitCmd({ '--cached': FLAG, '-r': FLAG, '-q': FLAG }),
  mv: cmd({}),
  restore: gitCmd({ '--staged': FLAG, '-S': FLAG, '--worktree': FLAG, '-W': FLAG }),
  commit: cmd({ '-m': TEXT, '--message': TEXT, '-am': TEXT, '-a': FLAG, '--all': FLAG, '-F': TEXT, '--file': TEXT, '-q': FLAG, '--quiet': FLAG, '-s': FLAG, '--signoff': FLAG, '--allow-empty': FLAG, '-v': FLAG }),
  switch: cmd({ '-c': TEXT, '--create': TEXT }),
  checkout: cmd({ '-b': TEXT }),
  branch: cmd({ '-a': FLAG, '--all': FLAG, '-r': FLAG, '--remotes': FLAG, '-v': FLAG, '-vv': FLAG, '--list': FLAG, '--show-current': FLAG, '-u': TEXT, '--set-upstream-to': TEXT, '--contains': TEXT }),
  stash: (args, env, name) => (['list', 'push', 'pop', 'apply', 'show', undefined].includes(args[0]) ? STASH(args.slice(1), env, name) : `git stash ${args[0]}`),
  remote: (args) => (args.every((x) => x === '-v' || x === 'show' || x === 'origin' || x === 'get-url') ? null : 'git remote: a change of a remote'),
  worktree: (args, env, name) => (args[0] === 'list' && args.length === 1 ? null : args[0] === 'add' ? cmd({ '-b': TEXT })(args.slice(1), env, name) : `git worktree ${args[0] ?? ''}`.trim()),
};

const NODE = { '--test': FLAG, '--check': FLAG, '--no-warnings': FLAG, '--test-reporter': ['spec', 'tap', 'dot', 'junit'], '--test-name-pattern': TEXT, '--experimental-test-coverage': FLAG };

/** node: a script, never code from an option or from stdin. */
function node(args) {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return null;
  const ops = options('node', args, NODE, { posix: true });
  if (typeof ops === 'string') return ops;
  if (!ops[0]) return args.includes('--test') ? null : 'node with no script file (code from stdin)';
  return null;
}

// ---- The sage state tool ------------------------------------------------------------------------------------------------

const escape = (text) => text.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&');
/**
 * Whether a tool call may name the sage state tool, by its text: a file name sage.mjs or the name of SAGE_TOOL in any text
 * or word (in any case: the Mac's disk ignores it; message.mjs is another name), and a wildcard whose last part can match one.
 * The guard cannot see a copy under another name, or a script that builds the name: the sandbox holds those (docs/reference.md).
 */
function namesStateTool(texts, globs, env) {
  const names = ['sage.mjs', basename(env.SAGE_TOOL ?? '')].filter(Boolean);
  const named = new RegExp(`(^|[^a-z0-9_.-])(${names.map(escape).join('|')})`, 'i');
  // A wildcard as a pattern: each *, ? and [...] can stand for anything (refuse when in doubt).
  const pattern = (g) => new RegExp(`^${basename(g).split(/(\[[^\]]*\]?|[*?])/).map((p) => (p === '*' ? '.*' : p === '?' || p.startsWith('[') ? '.' : escape(p))).join('')}$`, 'i');
  return texts.some((t) => named.test(t)) || globs.some((g) => names.some((n) => pattern(g).test(n)));
}
const WRITES = new Set(['node', 'npm', 'cp', 'mv', 'git']);
const STATE_TOOL = stop('a call that may name the sage state tool (a lead session reaches the logbook only through sage-bot)');

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
    if (!ENV.has(name)) return `setting ${name} in front of a command`;
  }
  const [name, ...args] = texts.slice(i);
  if (!name) return 'a part with no command';
  if (i > 0 && name === 'git') return how('a variable in front of git (git reads its config from HOME)', 'run git with no variable in front of it');
  // A word that starts with a wildcard can expand to a file name that starts with -, an option that no table checked. The
  // command's own name is looked up as it is (a wildcard in it names no command; `[` is the test command).
  const glob = words.slice(i + 1).find((w) => w.glob && /^[*?[]/.test(w.text));
  if (glob) return how(`the word ${glob.text} (a wildcard at its start can expand to an option)`, `start the word with a folder, for example ./${glob.text}`);
  if (!Object.hasOwn(COMMANDS, name)) return `the command ${name}`;
  return COMMANDS[name](args, env, name);
}

const REPHRASE = 'one command per call, or commands joined only by && (a | only into head, tail, wc, sort or grep), with no ;, ||, $, backtick, heredoc, (, {, \\ or newline; put long or special text in a file in the scratch folder and pass it with git commit -F <file>';

/** Why the Bash command is refused, or null. */
export function bashRefusal(command, env) {
  if (namesStateTool([String(command)], [], env)) return STATE_TOOL;
  const parsed = parse(command);
  if (typeof parsed === 'string') return how(`a command the guard cannot read (${parsed})`, REPHRASE);
  // The wildcards of a part that runs a script or writes a file (a renamed copy): a read (ls dir/*) runs nothing. A word that
  // starts with a wildcard is refused below anyway, with the hint ./* (which this check then sees).
  const globs = parsed.filter((seg) => WRITES.has(commandOf(seg.words.map((w) => w.text))[0]) || seg.redirects.length)
    .flatMap((seg) => seg.words.filter((w) => w.glob && !/^[*?[]/.test(w.text)).map((w) => w.text));
  if (namesStateTool(parsed.flatMap((seg) => seg.words.map((w) => w.text)), globs, env)) return STATE_TOOL;
  for (const [k, seg] of parsed.entries()) {
    const texts = seg.words.map((w) => w.text);
    if (seg.pipe && !PIPE.has(commandOf(texts)[0])) return how(`a | into ${commandOf(texts)[0] ?? 'nothing'}`, 'pipe only into head, tail, wc, sort or grep, or run the commands one by one');
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
// Read, Write, Edit, MultiEdit, NotebookEdit and Glob: the permission rules and the sandbox of step 6 hold their paths. A file
// tool may not name the state tool: a script that imports it, or a copy of it, is written through one.
const file = (i, env) => (namesStateTool([JSON.stringify(i)], [], env) ? STATE_TOOL : null);
// An isolation field moves the agent's work into another worktree or off this Mac, out of this hook and the sandbox.
const agent = (i) => (Object.hasOwn(i, 'isolation') ? `an agent with the isolation ${JSON.stringify(i.isolation)}` : null);
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

// WebFetch reaches an address only in the global unicast space (IPv4 1 to 223, IPv6 2000::/3) and not in a special-purpose
// range inside it (the IANA registries): an allow-list, so 0/8, multicast, 240/4, the broadcast address and every IPv6
// address outside 2000::/3 (::1, fe80::/10, fc00::/7, ff00::/8, ::ffff:0:0/96, 64:ff9b::/96) never pass.
const UNICAST = new BlockList();
UNICAST.addRange('1.0.0.0', '223.255.255.255', 'ipv4');
UNICAST.addSubnet('2000::', 3, 'ipv6');
const SPECIAL = new BlockList();
for (const range of ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24']) {
  SPECIAL.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv4');
}
// IETF protocol assignments with Teredo, documentation, 6to4 (it holds an IPv4 address), documentation.
for (const range of ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20']) SPECIAL.addSubnet(range.split('/')[0], Number(range.split('/')[1]), 'ipv6');

/** WebFetch: http or https to a public host name or a global unicast address; never this Mac, the local network or a .local name. */
function webRefusal(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'a fetch of a URL that does not parse'; }
  if (!/^https?:$/.test(u.protocol)) return 'a fetch of a URL that is not http or https';
  // The URL parser gives an IPv4 address in its dotted form (127.1 and 2130706433 are 127.0.0.1), an IPv6 one in [].
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const type = isIPv4(host) ? 'ipv4' : isIPv6(host) ? 'ipv6' : null;
  if (type) return UNICAST.check(host, type) && !SPECIAL.check(host, type) ? null : `a fetch of ${host} (not a global unicast address)`;
  if (!host.includes('.')) return `a fetch of ${host} (a local host name)`;
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)) return `a fetch of ${host} (this Mac or the local network)`;
  return null;
}

/**
 * The guard's decision for one PreToolUse input: null to allow, or the refusal message for the session.
 * @param {unknown} input the hook's JSON (tool_name, tool_input)
 * @param {Record<string, string | undefined>} env the hook's environment
 */
export function decide(input, env) {
  if (env.SAGE_ORIGIN !== 'lead') return null;
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object') {
    return refusal('a hook input that is not a tool call');
  }
  const rule = Object.hasOwn(TOOLS, input.tool_name) ? TOOLS[input.tool_name] : null;
  if (!rule) return refusal(`the tool ${input.tool_name}`);
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
