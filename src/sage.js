// The bridge's only way to sage: the state tool, run with execFile (no shell). It reads the gates and tasks of the
// logbook as sage wrote them, and records an answer with `sage gate answer`. It never writes a logbook file itself.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
 * The project of the config named `name`, or the bridge's own project (the one whose folder is `project`, else the first) when `name` is
 * undefined (T132). Throws for a name that the config does not list.
 * @param {{ project?: string }} config @param {{ name: string, project: string, sagePath: string }[]} projects  src/ask.js projectsOf
 */
export function pickProject(config, projects, name) {
  const p = name === undefined ? projects.find((x) => x.project === config.project) ?? projects[0] : projects.find((x) => x.name === name);
  if (!p) throw new Error(`the project "${name}" is not in the config's projects (${projects.map((x) => x.name).join(', ')}). Nothing changed.`);
  return p;
}
