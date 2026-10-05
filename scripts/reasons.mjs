// The ballot reasons of one bridge gate for sage: node scripts/reasons.mjs [--config <config.json>] [--project <name>] <gate id>.
// The gate is of the project `--project` names, one of the config's projects; without it, of the bridge's own project (T132). The gate
// file is the config's `statePath`; the config is the bridge's (default ~/.config/sage-bot/config.json).
// sage reads reasons only here, never from Discord. Each line is quoted data, cleaned for a model reader (src/clean.js).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectsOf } from '../src/ask.js';
import { forTerminal, reasonLines } from '../src/clean.js';
import { pickProject } from '../src/sage.js';
import { keyOf, load, projectOfKey } from '../src/state.js';

const USAGE = 'usage: node scripts/reasons.mjs [--config <config.json>] [--project <name>] <gate id>';

try {
  const args = process.argv.slice(2);
  let configPath = join(homedir(), '.config', 'sage-bot', 'config.json');
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  let name;
  if (args[0] === '--project') [, name] = args.splice(0, 2);
  const [id, ...more] = args;
  if (!configPath || !id || more.length) throw new Error(USAGE);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const projects = projectsOf(config);
  const project = pickProject(config, projects, name).name; // a project that the config does not list is refused
  const { entries } = load(config.statePath, pickProject(config, projects).name);
  // A bridge gate id (G1+G2) or one sage gate id of it, always of this project: G1 of another project is another gate.
  const entry = entries.find((e) => e.gate.id === keyOf(project, id) || (projectOfKey(e.gate.id) === project && e.sage.includes(id)));
  if (!entry) throw new Error(`no bridge gate ${keyOf(project, id)}. ${USAGE}`);
  const lines = reasonLines(entry);
  console.log(lines.length ? lines.join('\n') : 'no reasons');
} catch (e) {
  console.error(`sage-bot reasons: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
