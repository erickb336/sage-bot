// Marks sage gates as team votes (G13): the bridge posts only the gates in this list; every other gate stays at the terminal.
//   node scripts/vote.mjs [--config <config.json>] [--project <name>] <gate id> [<gate id> ...]   marks gates
//   node scripts/vote.mjs [--config <config.json>] [--project <name>] --leads <gate id>           marks one gate as leads only (T73)
//   node scripts/vote.mjs [--config <config.json>] [--project <name>] --unmark <gate id> [...]    unmarks gates (team votes and leads only)
//   node scripts/vote.mjs [--config <config.json>] --list                                        prints the lists
// The config is the bridge's (default ~/.config/sage-bot/config.json); the list is its `votesPath`, or `<statePath>.votes`.
// The gates are of the project `--project` names, one of the config's projects; without it, of the listed project whose folder holds the
// cwd (the deepest one), or of the bridge's own project when no listed folder holds it (T132, F-T132-13). The list
// holds each gate as its key, `<project>/<gate id>`, because every logbook has its own G1.
// A leads-only gate is the automatic-merge question (LEADS_QUESTION in src/bridge.js) with the options Yes|No. Only the sage-leads answer it,
// as a recommendation; the owner decides at the terminal. --leads reads the gate from the logbook of the project and refuses any other.
// Its list is `<votes list>.leads`. A gate is in one list at most: a mark moves it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectsOf } from '../src/ask.js';
import { notLeadsOnly } from '../src/bridge.js';
import { forTerminal } from '../src/clean.js';
import { projectAt } from '../src/sessions.js';
import { pickProject, refuseMissing, sageTool } from '../src/sage.js';
import { GATE_ID, keyOf, leadsPathOf, loadLeads, loadVotes, migrateMarks, saveVotes, votesPathOf, withLock } from '../src/state.js';

const USAGE = 'usage: node scripts/vote.mjs [--config <config.json>] [--project <name>] <gate id> ... | --leads <gate id> | --unmark <gate id> ... | --list';

try {
  const args = process.argv.slice(2);
  let configPath = join(homedir(), '.config', 'sage-bot', 'config.json');
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
  const projects = projectsOf(config);
  refuseMissing(projects); // a listed folder that does not exist is refused, and nothing changes (F-T132-14)
  // Without --project: the listed project whose folder holds the cwd, as the hook finds it; the own project outside them all (F-T132-13).
  const project = pickProject(config, projects, name ?? projectAt(process.cwd(), projects)?.name); // a name that the config does not list is refused
  const own = pickProject(config, projects).name;
  const path = votesPathOf(config);
  const leadsPath = leadsPathOf(config);
  migrateMarks(config, own); // the bare gate ids of the lists before T132 become keys of the own project, once
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
        votes[mode === '--mark' ? 'add' : 'delete'](id);
        leads[mode === '--leads' ? 'add' : 'delete'](id);
      }
      // The file that loses the gate is saved first. A read between the two saves can still find the gate in both; the bridge then reads again (F-T73-12).
      const saveLeads = () => { if (mode === '--leads' || leads.size !== before) saveVotes(leadsPath, leads); }; // no leads-only file until sage uses --leads
      if (mode === '--leads') { saveVotes(path, votes); saveLeads(); } else { saveLeads(); saveVotes(path, votes); }
    });
  }
  const ids = [...loadVotes(path)];
  const leads = [...loadLeads(leadsPath)];
  console.log(ids.length ? `team votes: ${ids.join(' ')}` : 'team votes: none');
  if (leads.length) console.log(`leads only: ${leads.join(' ')}`);
} catch (e) {
  console.error(`sage-bot vote: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
