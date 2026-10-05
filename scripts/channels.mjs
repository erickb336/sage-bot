// Erick's terminal script for the channel registry (T130): the channels where sage-bot works, each for one project.
//   node scripts/channels.mjs [--config <config.json>] list
//   node scripts/channels.mjs [--config <config.json>] register <channel id> <project> [--home]
//   node scripts/channels.mjs [--config <config.json>] unregister <channel id>
// The config is the bridge's (default ~/.config/sage-bot/config.json); the registry is `<statePath>.channels`.
// The script changes the registry only while the bridge is stopped: it takes the bridge's own lock, so it refuses while a bridge
// runs, and a bridge cannot start while it works. It cannot see Discord: the bridge checks sage-bot's permissions in each registered
// channel at its next start and logs each missing one.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectsOf } from '../src/ask.js';
import { change, channelsPathOf, NEEDED, openChannels, saveChannels } from '../src/channels.js';
import { forTerminal } from '../src/clean.js';
import { lock } from '../src/state.js';

const say = (line) => console.log(forTerminal(line));
const args = process.argv.slice(2);
const at = args.indexOf('--config');
const path = at === -1 ? join(homedir(), '.config', 'sage-bot', 'config.json') : args.splice(at, 2)[1];
try {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const projects = projectsOf(config);
  try { lock(config.statePath); } catch (e) {
    throw new Error(`${e.message} Stop the bridge first (launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist), then run this again.`);
  }
  const channels = openChannels(config, projects, say);
  if (args[0] !== 'list') {
    say(change(channels, args, projects.map((p) => p.name)));
    saveChannels(channelsPathOf(config), channels);
    if (args[0] === 'register') say(`At its next start the bridge checks that sage-bot has these permissions there, and logs each missing one: ${NEEDED.map(([, n]) => n).join(', ')}.`);
  }
  for (const [id, e] of channels) say(`${id}  ${e.project}${e.home ? '  (home: votes and cards)' : ''}`);
} catch (e) {
  console.error(`sage-bot channels: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
