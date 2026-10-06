// The bridge's only way to sage: the state tool, run with execFile (no shell). It reads the gates and tasks of the
// logbook as sage wrote them, and records an answer with `sage gate answer`. It never writes a logbook file itself.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A TSV table of the logbook as rows of { column: value }, by its header line, as sage reads it. */
function rows(text) {
  const [head, ...lines] = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const cols = (head ?? '').split('\t');
  return lines.map((line) => {
    const v = line.split('\t');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
}

/**
 * The sage state tool for one project.
 * @param {{ sagePath: string, project: string, env?: NodeJS.ProcessEnv }} o  `env` is for the tests: a scratch HOME or SAGE_HOME.
 */
export function sageTool({ sagePath, project, env = process.env }) {
  const sage = async (...args) => (await run(process.execPath, [sagePath, ...args, '--project', project], { env, encoding: 'utf8' })).stdout.trim();
  // One lookup of the logbook folder, kept as one promise, so that tables read at the same time share it (F-T71-2). A lookup that
  // fails is not kept: the next read tries again.
  let dir;
  const logbook = () => (dir ??= sage('logbook').catch((e) => { dir = undefined; throw e; }));
  const table = async (name) => rows(await readFile(join(await logbook(), `${name}.tsv`), 'utf8'));
  return {
    /** The folder of the project (loadProjects): the identity that the bridge saves with each card and mark (G45 A). */
    folder: project,
    /** Every gate row: { id, task, question, options, recommendation, default, answer, at }. */
    gates: () => table('gates'),
    /** Every task row: { id, title, ... }. */
    tasks: () => table('tasks'),
    /** Every decision row, in the order sage wrote them: { at, task, decision, why }. */
    decisions: () => table('decisions'),
    /** Records the answer of one gate. */
    answer: (id, text) => sage('gate', 'answer', id, text),
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
 * characters of PART (no glob character, "~", non-ASCII or control character, no space at either end: F-T156-37) and is not empty, "." or ".."; it is not
 * in the Data volume (F-T156-39); and the deepest part of it that exists is its own real path (`realpathSync.native`), so no part is a
 * link and the letter case is the disk's. The path then names one file by its text, and every rule made from it (a deny, an allow,
 * an overlap) is about that file. Links of the system are written in their real form: /private/tmp, not /tmp. The reader of the path
 * is the sandbox and the permission rules, so the allow-list is for them. Returns the path, else throws one line that names `what`.
 */
export function canonicalPath(what, path) {
  const parts = typeof path === 'string' ? path.split('/') : [];
  let real = path;
  if (parts.length > 1 && parts[0] === '' && parts.slice(1).every((p) => PART.test(p) && p !== '.' && p !== '..') && path !== DATA && !path.startsWith(`${DATA}/`)) {
    real = realOfDeepest(path);
    if (real === path) return path;
  }
  throw new TypeError(`${what} must be a canonical path (absolute; only A-Z, a-z, 0-9, ".", "_", "-" and a space between them; no empty, "." or ".." part; no link; the letter case of the disk), not ${JSON.stringify(path ?? null)}${typeof real === 'string' && real !== path ? `; its real path is ${JSON.stringify(real)}` : ''}. Nothing was started.`);
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
 * Where the sage state tool is, for the demo, the bridge tests and the lead policy (src/lead-policy.js). In this order:
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
