// The bridge's only way to sage: the state tool, run with execFile (no shell). It reads the gates and tasks of the
// logbook as sage wrote them, and records an answer with `sage gate answer`. It never writes a logbook file itself.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The form of `gate answer` that the bridge uses, named in the refusal of probeTool. */
const NEEDED = 'gate answer <G> --option <n> (sage plugin 6ea307ffa7b5 or later)';
const probed = new Map();
/**
 * Checks once that the sage state tool at `sagePath` takes the command forms that the bridge uses (T176): a dry run in a scratch
 * logbook (HOME and SAGE_HOME in a temp folder that goes at the end): init, task add, gate add, then `gate answer G1 --option 1`.
 * Rejects with one line that names the tool path and the needed form when the tool refuses it or records something else.
 * @param {string} sagePath  @param {NodeJS.ProcessEnv} [env]  @returns {Promise<void>}
 */
export function probeTool(sagePath, env = process.env) {
  if (!probed.has(sagePath)) probed.set(sagePath, probe(sagePath, env).catch((e) => { probed.delete(sagePath); throw e; }));
  return probed.get(sagePath);
}
async function probe(sagePath, env) {
  const root = await mkdtemp(join(tmpdir(), 'sage-bot-probe-'));
  try {
    const project = join(root, 'project');
    await mkdir(project);
    const home = join(root, 'home');
    const scratch = { PATH: env.PATH, HOME: home, SAGE_HOME: join(home, 'sage') };
    const sage = async (...args) => (await run(process.execPath, [sagePath, ...args, '--project', project], { env: scratch, encoding: 'utf8' })).stdout.trim();
    const refused = (what, detail) => new Error(`the sage state tool ${sagePath} ${what}; the bridge needs ${NEEDED}: ${detail}. Nothing was started.`);
    try {
      await sage('init');
      await sage('task', 'add', '--title', 'probe', '--size', 'tiny');
      await sage('gate', 'add', 'T1', '--question', 'Probe?', '--options', 'Yes|No', '--recommend', 'Yes');
    } catch (e) {
      throw refused('refused the probe of its gate commands', firstLine(e));
    }
    let said;
    try { said = await sage('gate', 'answer', 'G1', '--option', '1'); } catch (e) { throw refused('refused gate answer --option', firstLine(e)); }
    if (said !== 'G1 answered · Yes') throw refused('recorded gate answer --option 1 as something else', JSON.stringify(said));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const firstLine = (e) => String(e?.stderr || e?.message || e).split('\n').find(Boolean) ?? '';

/** A TSV table of the logbook as rows of { column: value }, by its header line, as sage reads it. */
function rows(text) {
  const [head, ...lines] = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const cols = (head ?? '').split('\t');
  return lines.map((line) => {
    const v = line.split('\t');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
}

/** What sage puts before the owner's own words in a gate's answer, so that they never pass for one of the options. */
export const OTHER = 'other: ';
/** The options of a gate row, as sage numbers them (1, 2, …) and as the bridge reads them (frame). */
export const optionsOf = (row) => row.options.split('|').map((o) => o.trim()).filter(Boolean);
/**
 * The arguments of `gate answer` for what gates.tsv is to hold (T176): the text of one of the row's options, as `--option <n>`,
 * or the owner's own words after OTHER, as `--other-hex` with their UTF-8 bytes in hex. sage takes no answer text in the command.
 * @param {{ id: string, options: string }} row  @param {string} text  @returns {string[]}
 */
export function answerArgs(row, text) {
  const n = optionsOf(row).indexOf(text) + 1;
  if (n) return ['--option', String(n)];
  if (text.startsWith(OTHER) && text.length > OTHER.length) return ['--other-hex', Buffer.from(text.slice(OTHER.length), 'utf8').toString('hex')];
  throw new Error(`${row.id}: ${JSON.stringify(text)} is not the text of one of its options and does not start with ${JSON.stringify(OTHER)}`);
}

/** The environment names that the state tool reads (sage.mjs and its core), for the broker's logbook verbs; LANG and LC_* too. */
const TOOL_ENV = ['PATH', 'HOME', 'SAGE_HOME', 'SAGE_WORKTREES', 'SAGE_BOARD_ROOTS', 'CLAUDE_CONFIG_DIR'];

/**
 * The sage state tool for one project.
 * @param {{ sagePath: string, project: string, env?: NodeJS.ProcessEnv }} o  `env` is for the tests: a scratch HOME or SAGE_HOME.
 */
export function sageTool({ sagePath, project, env = process.env }) {
  // The one caller of the state tool for this project: a fixed argv, no shell, `--project` last. `signal` kills the tool with SIGKILL
  // (execFile's own `signal` option sends SIGTERM, which a hung tool can ignore: T189). An error has the exit code as `code` and the
  // tool's refusal as `stderr`.
  const exec = (args, childEnv, { signal } = {}) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [sagePath, ...args, '--project', project], { env: childEnv, encoding: 'utf8' }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: err })) : resolve(out.trim())));
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  });
  // The broker's logbook verbs get only the names that the state tool reads (an allow-list, F-T195-2): never the bridge's token or
  // any other secret of its environment. CLAUDE_CONFIG_DIR is in it because the tool's default logbook root is under it.
  const brokerEnv = Object.fromEntries(Object.entries(env).filter(([k]) => TOOL_ENV.includes(k) || k === 'LANG' || k.startsWith('LC_')));
  const command = (args, o) => exec(args, brokerEnv, o);
  const sage = (...args) => exec(args, env);
  // One lookup of the logbook folder, kept as one promise, so that tables read at the same time share it (F-T71-2). A lookup that
  // fails is not kept: the next read tries again.
  let dir;
  const logbook = () => (dir ??= sage('logbook').catch((e) => { dir = undefined; throw e; }));
  const table = async (name) => rows(await readFile(join(await logbook(), `${name}.tsv`), 'utf8'));
  return {
    /** The folder of the project (loadProjects): the identity that the bridge saves with each card and mark (G45 A). */
    folder: project,
    /** One command of the state tool, as an argv, with the project fixed and the allow-listed environment: for the broker's logbook
     * verbs (T189), which fix the argv. */
    command,
    /** Every gate row: { id, task, question, options, recommendation, default, answer, at }. */
    gates: () => table('gates'),
    /** Every task row: { id, title, ... }. */
    tasks: () => table('tasks'),
    /** Every decision row, in the order sage wrote them: { at, task, decision, why }. */
    decisions: () => table('decisions'),
    /**
     * Adds one task (T72): a fixed argv with the title as one `--title=` argument, the allow-listed environment, no shell. `size` is
     * small or large. A title with a control character is refused: sage keeps it in a TSV row. Returns the new task id, as
     * `task add` prints it ("T74 framed · …"); throws for any other output.
     */
    addTask: async ({ title, size }) => {
      if (!['small', 'large'].includes(size)) throw new TypeError(`a task from a request is small or large, not ${JSON.stringify(size)}`);
      if (typeof title !== 'string' || !title.trim() || /\p{Cc}/u.test(title)) throw new TypeError('a task title is one line of text');
      const said = await command(['task', 'add', `--title=${title}`, `--size=${size}`]);
      return /^(T\d{1,9}) framed\b/.exec(said)?.[1] ?? (() => { throw new Error(`the sage state tool added no task: ${JSON.stringify(said.slice(0, 200))}`); })();
    },
    /** Records the answer of one gate: `text` is what gates.tsv is to hold (answerArgs). */
    answer: async (id, text) => {
      const row = (await table('gates')).find((r) => r.id === id) ?? (() => { throw new Error(`gate ${id} is not in gates.tsv`); })();
      return sage('gate', 'answer', id, ...answerArgs(row, text));
    },
  };
}

/** The owner's home folder from the user database (os.userInfo), not $HOME: the demo, the tests and the proof run with HOME set to a
 * scratch folder. The one place that reads it (F-T157-7). */
export const ownerHome = () => userInfo().homedir;

/**
 * A part of a canonical path: only these characters (an allow-list, standing order 12), and never "." or "..". A space only between two
 * of them, as in the example config's "Application Support": a permission rule, like a gitignore pattern, drops a space at its end.
 */
const PART = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;
/** The macOS Data volume. A path in it names the same file as its short form, but the macOS sandbox matches only the short form (F-T156-39). */
const DATA = '/System/Volumes/Data';
/**
 * The one rule for a path that the config or the environment gives (G48 A): a canonical path. It is absolute; each part has only the
 * characters of PART (no glob character, "~", non-ASCII or control character, no space at either end: F-T156-37) and is not empty, "." or "..";
 * its first part does not start with "." (the kernel resolves /.nofollow, /.resolve and /.vol, which the sandbox does not: F-T156-43); it is not
 * in the Data volume (F-T156-39); and the deepest part of it that exists is its own real path (`realpathSync.native`), so no part is a
 * link and the letter case is the disk's. The path then names one file by its text, and every rule made from it (a deny, an allow,
 * an overlap) is about that file. Links of the system are written in their real form: /private/tmp, not /tmp. The reader of the path
 * is the sandbox and the permission rules, so the allow-list is for them. Returns the path, else throws one line that names `what`.
 */
export function canonicalPath(what, path) {
  const parts = typeof path === 'string' ? path.split('/') : [];
  let real = path;
  if (parts.length > 1 && parts[0] === '' && !parts[1].startsWith('.') && parts.slice(1).every((p) => PART.test(p) && p !== '.' && p !== '..') && path !== DATA && !path.startsWith(`${DATA}/`)) {
    real = realOfDeepest(path);
    if (real === path) return path;
  }
  throw new TypeError(`${what} must be a canonical path (absolute; only A-Z, a-z, 0-9, ".", "_", "-" and a space between them; no empty, "." or ".." part; no "." at the start of the first part; no link; the letter case of the disk), not ${JSON.stringify(path ?? null)}${typeof real === 'string' && real !== path ? `; its real path is ${JSON.stringify(real)}` : ''}. Nothing was started.`);
}
/** `path` with its deepest part that exists replaced by that part's real path; null when that part has no real path (a link to nothing, a loop) or cannot be read. */
function realOfDeepest(path) {
  for (let at = path; ; at = dirname(at)) {
    let s;
    try { s = lstatSync(at, { throwIfNoEntry: false }); } catch (e) { if (e.code !== 'ENOTDIR') return null; } // a part below a file: not there
    if (s) { try { return realpathSync.native(at) + path.slice(at.length); } catch { return null; } } // "/" is always there
  }
}

/**
 * The Claude Code config folder: CLAUDE_CONFIG_DIR, else ~/.claude. The sage plugin and sage's root are in it. An empty CLAUDE_CONFIG_DIR
 * counts as not set; any other must be canonicalPath (F-T156-17, F-T156-28).
 */
export function claudeDirOf({ env = process.env, home = ownerHome() } = {}) {
  return env.CLAUDE_CONFIG_DIR ? canonicalPath('CLAUDE_CONFIG_DIR', env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
}

/** The sage plugin's two folders in a Claude Code config folder (claudeDirOf): its cache (each version) and its marketplace copy. */
export const sagePlugin = (claudeDir) => ({
  cache: join(claudeDir, 'plugins', 'cache', 'sage'),
  marketplace: join(claudeDir, 'plugins', 'marketplaces', 'sage'),
});

/** The state tool of one version in the sage plugin's cache (sagePlugin(...).cache): the sage plugin of the sage marketplace. */
export const sageToolIn = (cache, version) => join(cache, 'sage', version, 'skills', 'sage', 'sage.mjs');

/**
 * Where the sage state tool is, for the demo, the bridge tests and the session policy (src/session-policy.js). In this order:
 * 1. SAGE_TOOL, when it is set;
 * 2. the newest sage.mjs (by modification time) in the sage plugin's cache, <cache>/sage/<version>/skills/sage/, in claudeDirOf;
 * 3. else an error that names SAGE_TOOL.
 * HOME is the real home folder from the user database (os.userInfo), not $HOME: the demo and the tests run with HOME set to a scratch folder.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [o] @returns {string} the path of sage.mjs
 */
export function sagePath({ env = process.env, home = ownerHome() } = {}) {
  if (env.SAGE_TOOL) {
    if (existsSync(env.SAGE_TOOL)) return env.SAGE_TOOL;
    throw new Error(`SAGE_TOOL is set to ${env.SAGE_TOOL}, but there is no file there. Set SAGE_TOOL to the sage plugin's sage.mjs.`);
  }
  const { cache } = sagePlugin(claudeDirOf({ env, home }));
  const versions = join(cache, 'sage');
  const found = (existsSync(versions) ? readdirSync(versions) : [])
    .map((v) => sageToolIn(cache, v))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, at: statSync(p).mtimeMs }))
    .sort((a, b) => b.at - a.at || (a.p < b.p ? -1 : 1));
  if (found.length) return found[0].p;
  throw new Error(`The sage state tool is not in the sage plugin's cache (${versions}). Install the sage plugin, or set SAGE_TOOL to its sage.mjs.`);
}
