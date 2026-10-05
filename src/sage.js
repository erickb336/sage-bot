// The bridge's only way to sage: the state tool, run with execFile (no shell). It reads the gates and tasks of the
// logbook as sage wrote them, and records an answer with `sage gate answer`. It never writes a logbook file itself.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { real } from './sessions.js';

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
 * The project of the config named `name`, or the bridge's own project when `name` is undefined (T132): the listed project whose folder is
 * the config's `project`, by their real paths (a trailing slash or a symlink names the same folder). Throws for a name that the config
 * does not list, and for a `project` that no listed project has: the bridge, the hook, vote.mjs and reasons.mjs then refuse to start,
 * and never take another project's gates for their own (F-T132-1).
 * @param {{ project?: string }} config @param {{ name: string, project: string, sagePath: string }[]} projects  src/ask.js projectsOf
 */
export function pickProject(config, projects, name) {
  if (name === undefined) {
    const at = typeof config.project === 'string' ? real(config.project) : undefined;
    const p = projects.find((x) => real(x.project) === at);
    if (!p) throw new Error(`the config's project (${config.project ?? 'missing'}) is not in its projects. Add it to projects, with a name. Nothing was started.`);
    return p;
  }
  const p = projects.find((x) => x.name === name);
  if (!p) throw new Error(`the project "${name}" is not in the config's projects (${projects.map((x) => x.name).join(', ')}). Nothing changed.`);
  return p;
}

/**
 * Throws for a listed project whose folder does not exist (F-T132-14). The bridge, vote.mjs and reasons.mjs call it first, so they stop
 * before the lock, the Keychain or a mark, with one line that names the project and its path.
 * @param {{ name: string, project: string }[]} projects  src/ask.js projectsOf
 */
export function refuseMissing(projects) {
  const p = projects.find((x) => !statSync(x.project, { throwIfNoEntry: false })?.isDirectory());
  if (p) throw new Error(`the folder of project ${p.name} (${p.project}) does not exist. Fix its path in projects, or take the project out. Nothing changed.`);
}
