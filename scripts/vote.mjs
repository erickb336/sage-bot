// Marks sage gates as team votes (G13): the bridge posts only the gates in this list; every other gate stays at the terminal.
//   node scripts/vote.mjs [--config <config.json>] [--project <name>] <gate id> [<gate id> ...]   marks gates
//   node scripts/vote.mjs [--config <config.json>] [--project <name>] --leads <gate id>           marks one gate as leads only (T73)
//   node scripts/vote.mjs [--config <config.json>] [--project <name>] --unmark <gate id> [...]    unmarks gates (team votes and leads only)
//   node scripts/vote.mjs [--config <config.json>] --list                                        prints the lists
// The config is the bridge's (default ~/.config/sage-bot/config.json); the list is its `votesPath`, or `<statePath>.votes`.
// The gates are of the project `--project` names, one of the config's projects; without it, of the listed project whose folder holds the
// cwd (the deepest one). With neither, it refuses and changes nothing (G45 A, F-T132-22). The list holds each gate as its key,
// `<project>/<gate id>`, because every logbook has its own G1, and the folder of its project (loadProjects), because a name can later
// name another folder.
// A leads-only gate is the automatic-merge question (LEADS_QUESTION in src/bridge.js) with the options Yes|No. Only the sage-leads answer it,
// as a recommendation; the owner decides at the terminal. --leads reads the gate from the logbook of the project and refuses any other.
// Its list is `<votes list>.leads`. A gate is in one list at most: a mark moves it.
import { readFileSync } from 'node:fs';
import { notLeadsOnly } from '../src/bridge.js';
import { forTerminal } from '../src/clean.js';
import { loadProjects, pickProject, projectHere } from '../src/projects.js';
import { sageTool } from '../src/sage.js';
import { GATE_ID, keyOf, leadsPathOf, loadLeads, loadVotes, migrateMarks, saveVotes, votesPathOf, withLock } from '../src/state.js';
import { defaultConfigPath } from '../src/lead-policy.js';

const USAGE = 'usage: node scripts/vote.mjs [--config <config.json>] [--project <name>] <gate id> ... | --leads <gate id> | --unmark <gate id> ... | --list';

try {
  const args = process.argv.slice(2);
  let configPath = defaultConfigPath();
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  let name;
  if (args[0] === '--project') [, name] = args.splice(0, 2);
  const mode = ['--unmark', '--list', '--leads'].includes(args[0]) ? args.shift() : '--mark';
  if (!configPath || (mode === '--list') !== (args.length === 0)) throw new Error(USAGE);
  const bad = args.filter((id) => !GATE_ID.test(id));
  if (bad.length) throw new Error(`not a sage gate id (G and digits): ${bad.join(', ')}. Nothing changed.`);
  if (mode === '--leads' && args.length > 1) {
    throw new Error(`a leads-only question is one Yes or No question, never a batch: give one gate id to --leads, not ${args.length}. Nothing changed.`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const projects = loadProjects(config); // a config whose projects the bridge cannot serve is refused, and nothing changes (G43 A)
  // Without --project: the listed project whose folder holds the cwd, as the hook finds it; none outside them all (F-T132-22).
  const project = mode === '--list' && name === undefined ? undefined : projectHere(projects, name, process.cwd()); // --list marks nothing
  const path = votesPathOf(config);
  const leadsPath = leadsPathOf(config);
  // The lists before G45 A get the folder of each project, once; their bare gate ids (before T132) become keys of the own project.
  migrateMarks(config, pickProject(projects).name, new Map(projects.map((p) => [p.name, p.project])));
  if (mode === '--leads') {
    // A missing or wrong sagePath gives one line, never the child's stack (F-T73-7).
    const rows = await sageTool(project).gates().catch(() => {
      throw new Error(`could not read the gates of ${project.name} with the sage state tool ${project.sagePath}. Nothing changed.`);
    });
    const row = rows.find((r) => r.id === args[0]);
    const why = row ? notLeadsOnly(row) : `${args[0]} is not a gate of the sage project ${project.name}`;
    if (why) throw new Error(`${why}. Nothing changed.`);
  }
  if (mode !== '--list') {
    withLock(path, () => {
      const [votes, leads] = [loadVotes(path), loadLeads(leadsPath)];
      const before = leads.size;
      for (const id of args.map((x) => keyOf(project.name, x))) {
        if (mode === '--mark') votes.set(id, project.project); else votes.delete(id);
        if (mode === '--leads') leads.set(id, project.project); else leads.delete(id);
      }
      // The file that loses the gate is saved first. A read between the two saves can still find the gate in both; the bridge then reads again (F-T73-12).
      const saveLeads = () => { if (mode === '--leads' || leads.size !== before) saveVotes(leadsPath, leads); }; // no leads-only file until sage uses --leads
      if (mode === '--leads') { saveVotes(path, votes); saveLeads(); } else { saveLeads(); saveVotes(path, votes); }
    });
  }
  const ids = [...loadVotes(path).keys()];
  const leads = [...loadLeads(leadsPath).keys()];
  console.log(ids.length ? `team votes: ${ids.join(' ')}` : 'team votes: none');
  if (leads.length) console.log(`leads only: ${leads.join(' ')}`);
} catch (e) {
  console.error(`sage-bot vote: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
