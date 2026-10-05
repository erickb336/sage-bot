// Marks sage gates as team votes (G13): the bridge posts only the gates in this list; every other gate stays at the terminal.
//   node scripts/vote.mjs [--config <config.json>] <gate id> [<gate id> ...]   marks gates
//   node scripts/vote.mjs [--config <config.json>] --unmark <gate id> [...]    unmarks gates
//   node scripts/vote.mjs [--config <config.json>] --list                      prints the list
// The config is the bridge's (default ~/.config/sage-bot/config.json); the list is its `votesPath`, or `<statePath>.votes`.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { forTerminal } from '../src/clean.js';
import { GATE_ID, loadVotes, saveVotes, votesPathOf } from '../src/state.js';

const USAGE = 'usage: node scripts/vote.mjs [--config <config.json>] <gate id> ... | --unmark <gate id> ... | --list';

try {
  const args = process.argv.slice(2);
  let configPath = join(homedir(), '.config', 'sage-bot', 'config.json');
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  const mode = ['--unmark', '--list'].includes(args[0]) ? args.shift() : '--mark';
  if (!configPath || (mode === '--list') !== (args.length === 0)) throw new Error(USAGE);
  const bad = args.filter((id) => !GATE_ID.test(id));
  if (bad.length) throw new Error(`not a sage gate id (G and digits): ${bad.join(', ')}. Nothing changed.`);
  const path = votesPathOf(JSON.parse(readFileSync(configPath, 'utf8')));
  const votes = loadVotes(path);
  if (mode === '--mark') for (const id of args) votes.add(id);
  if (mode === '--unmark') for (const id of args) votes.delete(id);
  if (mode !== '--list') saveVotes(path, votes);
  const ids = [...loadVotes(path)];
  console.log(ids.length ? `team votes: ${ids.join(' ')}` : 'team votes: none');
} catch (e) {
  console.error(`sage-bot vote: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
