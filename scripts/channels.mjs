// Erick's terminal script for the channel registry (T130): the channels where sage-bot works, each for one project.
//   node scripts/channels.mjs [--config <config.json>] list
//   node scripts/channels.mjs [--config <config.json>] register <channel id> <project> [--home]
//   node scripts/channels.mjs [--config <config.json>] unregister <channel id>
// The config is the bridge's (default ~/.config/sage-bot/config.json); the registry is `<statePath>.channels`.
// `list` only reads, so it works while the bridge runs. `register` and `unregister` change the registry only while the bridge is
// stopped: they take the bridge's own lock, so they refuse while a bridge runs (and print the launchctl lines that stop and start
// it), and a bridge cannot start while they work. With no
// registry and no channelId in the config, `register <id> <project> --home` makes the first one. The script cannot see Discord: the
// bridge checks sage-bot's permissions in each registered channel at its next start and logs each missing one.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectsOf } from '../src/ask.js';
import { settled } from '../src/cards.js';
import { change, channelsPathOf, FIRST, homeOf, loadChannels, migrate, NEEDED, saveChannels, staleOf } from '../src/channels.js';
import { forTerminal } from '../src/clean.js';
import { load, lock } from '../src/state.js';

const USAGE = 'usage: node scripts/channels.mjs [--config <config.json>] list | register <channel id> <project> [--home] | unregister <channel id>';
// The bridge of the README runs under launchd with KeepAlive: a killed bridge starts again and takes the lock again (F-T130-14).
const STOP = 'launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist (or Ctrl-C where you run it by hand)';
const START = 'launchctl load ~/Library/LaunchAgents/com.sage.bot.plist';
const say = (line) => console.log(forTerminal(line));
const args = process.argv.slice(2);
try {
  const at = args.indexOf('--config');
  const path = at === -1 ? join(homedir(), '.config', 'sage-bot', 'config.json') : args.splice(at, 2)[1];
  if (!path || path.startsWith('--')) throw new Error(`--config needs the path of the bridge's config file. ${USAGE}`);
  const [verb] = args;
  if (!['list', 'register', 'unregister'].includes(verb) || (verb === 'list' && args.length > 1)) throw new Error(USAGE);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    throw new Error(`cannot read the config ${path} (${e.code ?? e.message}). Give the bridge's config with --config <config.json>.`);
  }
  const config = JSON.parse(text);
  const projects = projectsOf(config);
  const names = projects.map((p) => p.name);
  const file = channelsPathOf(config);
  const print = (channels) => {
    for (const [id, e] of channels) say(`${id}  ${e.project}${e.home ? '  (home: votes and cards)' : ''}${names.includes(e.project) ? '' : '  (not in the config: register it again or unregister it)'}`);
  };
  if (verb === 'list') { // read-only: no lock, so it works while the bridge runs
    const channels = loadChannels(file);
    if (!channels) say(`there is no channel registry ${file} yet. The bridge makes it from channelId at its first start; with no channelId, register the home channel with: ${FIRST}`);
    else print(channels);
  } else {
    try { lock(config.statePath); } catch (e) {
      if (!/^(another sage bridge|a sage bridge may still be starting)/.test(e.message)) throw e;
      throw new Error(`a sage bridge runs on ${config.statePath}, and only one of the two may change the channel registry. Stop the bridge with: ${STOP}, run this again, then start the bridge with: ${START}. list works while it runs. If no bridge runs, remove ${config.statePath}.lock. Nothing was changed.`);
    }
    const home = verb === 'register' && args[3] === '--home';
    const channels = loadChannels(file) ?? migrate(config, projects, say) ?? new Map();
    if (home && channels.size && homeOf(channels) !== args[1]) {
      // The bridge accepts presses only in the home channel and its threads (src/discord.js accepts): a card that waits in the old home would get no votes.
      const waiting = load(config.statePath).entries.filter((e) => !settled(e.gate, e.ask)).map((e) => e.gate.id);
      if (waiting.length) {
        throw new Error(`the home channel cannot move while ${waiting.length} card(s) wait in the old home channel ${homeOf(channels)} or its threads (${waiting.join(', ')}): their buttons would stop working. Wait until they are settled, or answer them at the terminal, then run this again. Nothing was changed.`);
      }
    }
    say(change(channels, args, names));
    saveChannels(file, channels);
    if (verb === 'register') say(`At its next start the bridge checks that sage-bot has these permissions there, and logs each missing one: ${NEEDED.map(([, n]) => n).join(', ')}.`);
    print(channels);
    if (staleOf(channels, names).length) say('The bridge does not start while a channel has a project that is not in the config.');
  }
} catch (e) {
  console.error(`sage-bot channels: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
