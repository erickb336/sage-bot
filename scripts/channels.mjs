// Erick's terminal script for the channel registry (T130): the channels where sage-bot works, each for one project.
//   node scripts/channels.mjs [--config <config.json>] list
//   node scripts/channels.mjs [--config <config.json>] register <channel id> <project> [--home]
//   node scripts/channels.mjs [--config <config.json>] unregister <channel id>
// The config is the bridge's (default ~/.config/sage-bot/config.json); the registry is `<statePath>.channels`.
// `list` only reads, so it works while the bridge runs. `register` and `unregister` change the registry only while the bridge is
// stopped: they take the bridge's own lock, so they refuse while a bridge runs (and print the launchctl lines that stop and start
// it), and a bridge cannot start while they work. With no registry, `register <id> <project> --home` makes a new one with only that
// channel; the other verbs make it from the config's channelId and askChannelId (migrate). The home channel moves only when no card
// waits and no sage session has an open thread outside the new home. The script cannot see Discord: the bridge checks sage-bot's
// permissions in each registered channel at its next start and logs each missing one.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadProjects } from '../src/projects.js';
import { settled } from '../src/cards.js';
import { change, channelsPathOf, FIRST, homeOf, loadChannels, madeLine, migrate, NEEDED, saveChannels, staleOf, word } from '../src/channels.js';
import { forTerminal } from '../src/clean.js';
import { load, lock } from '../src/state.js';
import { defaultConfigPath } from '../src/session-policy.js';

const USAGE = 'usage: node scripts/channels.mjs [--config <config.json>] list | register <channel id> <project> [--home] | unregister <channel id>';
// The bridge of the README runs under launchd with KeepAlive: a killed bridge starts again and takes the lock again (F-T130-14).
const STOP = 'launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist (or Ctrl-C where you run it by hand)';
const START = 'launchctl load ~/Library/LaunchAgents/com.sage.bot.plist';
const say = (line) => console.log(forTerminal(line));
const args = process.argv.slice(2);

/**
 * Throws when the home channel may not move, by the gate file `statePath`, from `old` (null: unknown, there is no registry) to `to`. The bridge accepts presses only
 * in the home channel and its threads (src/discord.js accepts), so a card that waits outside the new home would get no votes (F-T130-8),
 * also with no registry (F-T136-8), and a sage session with an open thread there would post its next card there (F-T136-1). A session's
 * thread is open until the bridge locks it: after the session ends and its cards are settled.
 */
function refuseMove(statePath, old, to) {
  const { entries, sessions } = load(statePath);
  const where = old ? `the old home channel ${old} or its threads` : `a channel or thread that may not be ${to}: with no channel registry, nothing says where the home was`;
  const waiting = entries.filter((e) => !settled(e.gate, e.ask) && e.channel !== to).map((e) => e.gate.id);
  if (waiting.length) {
    throw new Error(`the home channel cannot move while ${waiting.length} card(s) wait in ${where} (${waiting.join(', ')}): their buttons would stop working. `
      + 'Wait until they are settled. Or answer them at the terminal, then start the bridge for one loop, because only the bridge copies '
      + `the answers into the gate file: start it with: ${START}, wait until its log shows the answers, stop it with: ${STOP}, and run this again. Nothing was changed.`);
  }
  const open = sessions.filter((x) => x.thread && (!x.closed || x.endedAt === undefined));
  if (open.length) {
    throw new Error(`the home channel cannot move while ${open.length} sage session(s) have an open thread in ${where} (${open.map((x) => `${x.title}: thread ${x.thread}`).join(', ')}): `
      + 'their next card would post there, where presses stop working. End each session in Claude Code and settle its cards. Then start the bridge '
      + `with: ${START}, wait until its log or the session's line says that it ended and the thread is locked, stop it with: ${STOP}, and run this again. Nothing was changed.`);
  }
}

try {
  const at = args.indexOf('--config');
  const path = at === -1 ? defaultConfigPath() : args.splice(at, 2)[1];
  if (!path || path.startsWith('--')) throw new Error(`--config needs the path of the bridge's config file. ${USAGE}`);
  const [verb] = args;
  if (!['list', 'register', 'unregister'].includes(verb) || (verb === 'list' && args.length > 1)) throw new Error(USAGE);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    throw new Error(`cannot read the config ${path} (${e.code ?? e.message}). Give the bridge's config with --config <config.json>.`);
  }
  // Each refusal of the config names the file (F-T136-3).
  let config;
  try { config = JSON.parse(text); } catch (e) { throw new Error(`the config ${path} is not JSON (${e.message}). Nothing was changed.`); }
  if (typeof config?.statePath !== 'string' || !isAbsolute(config.statePath)) {
    throw new Error(`the config ${path} has no statePath: the absolute path of the bridge's gate file. The registry is <statePath>.channels. Nothing was changed.`);
  }
  let projects;
  try { projects = loadProjects(config); } catch (e) { throw new Error(`the config ${path} is refused: ${e.message}`); }
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
      throw new Error(`a sage bridge runs on ${config.statePath}, and only one of the two may change the channel registry. Stop the bridge with: ${STOP}, run this again, then start the bridge with: ${START}. list works while it runs. If no bridge runs, remove ${word(`${config.statePath}.lock`)}. Nothing was changed.`);
    }
    const home = verb === 'register' && args[3] === '--home';
    // With no registry, --home makes a new one with only that channel: a migration would bring back an askChannelId channel that Erick
    // unregistered before he moved a bad registry aside (F-T136-6). Nothing is saved before every check passes (F-T136-2).
    const found = loadChannels(file);
    const made = !found && !home && migrate(config, projects);
    const channels = found ?? (made || new Map());
    const old = channels.size ? homeOf(channels) : null; // null: no registry says where the home was
    if (home && old !== args[1]) refuseMove(config.statePath, old, args[1]);
    const lines = [made && madeLine(file, made), change(channels, args, names)].filter(Boolean);
    saveChannels(file, channels);
    lines.forEach(say);
    if (verb === 'register') say(`At its next start the bridge checks that sage-bot has these permissions there, and logs each missing one: ${NEEDED.map(([, n]) => n).join(', ')}.`);
    print(channels);
    if (staleOf(channels, names).length) say('The bridge does not start while a channel has a project that is not in the config.');
  }
} catch (e) {
  console.error(`sage-bot channels: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
