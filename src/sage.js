// The bridge's only way to sage: the state tool, run with execFile (no shell). It reads the gates and tasks of the
// logbook as sage wrote them, and records an answer with `sage gate answer`. It never writes a logbook file itself.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
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

/**
 * The Claude Code config folder: CLAUDE_CONFIG_DIR, else ~/.claude. The sage plugin and sage's root are in it. An empty CLAUDE_CONFIG_DIR
 * counts as not set; a relative one throws, because it would resolve against the working folder (F-T156-17).
 */
export function claudeDirOf({ env = process.env, home = userInfo().homedir } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  if (!isAbsolute(dir)) throw new TypeError(`CLAUDE_CONFIG_DIR must be an absolute path, not ${JSON.stringify(dir)}.`);
  return dir;
}

/** The sage plugin's two folders in a Claude Code config folder (claudeDirOf): its cache (each version) and its marketplace copy. */
export const sagePlugin = (claudeDir) => ({
  cache: join(claudeDir, 'plugins', 'cache', 'sage'),
  marketplace: join(claudeDir, 'plugins', 'marketplaces', 'sage'),
});

/**
 * Where the sage state tool is, for the demo, the bridge tests and the lead policy (src/lead-policy.js). In this order:
 * 1. SAGE_TOOL, when it is set;
 * 2. the newest sage.mjs (by modification time) in the sage plugin's cache, <cache>/sage/<version>/skills/sage/, in claudeDirOf;
 * 3. else an error that names SAGE_TOOL.
 * HOME is the real home folder from the user database (os.userInfo), not $HOME: the demo and the tests run with HOME set to a scratch folder.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [o] @returns {string} the path of sage.mjs
 */
export function sagePath({ env = process.env, home = userInfo().homedir } = {}) {
  if (env.SAGE_TOOL) {
    if (existsSync(env.SAGE_TOOL)) return env.SAGE_TOOL;
    throw new Error(`SAGE_TOOL is set to ${env.SAGE_TOOL}, but there is no file there. Set SAGE_TOOL to the sage plugin's sage.mjs.`);
  }
  const cache = join(sagePlugin(claudeDirOf({ env, home })).cache, 'sage');
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .map((v) => join(cache, v, 'skills', 'sage', 'sage.mjs'))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, at: statSync(p).mtimeMs }))
    .sort((a, b) => b.at - a.at || (a.p < b.p ? -1 : 1));
  if (found.length) return found[0].p;
  throw new Error(`The sage state tool is not in the sage plugin's cache (${cache}). Install the sage plugin, or set SAGE_TOOL to its sage.mjs.`);
}
