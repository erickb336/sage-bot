// The channel registry (T130): the Discord channels where sage-bot works, each mapped to one project of the config. /sage and
// mentions work in a registered channel and its threads. One entry is the home channel: the votes and cards post there (T29).
// The file is <statePath>.channels, beside the gate file, and it is safe like the gate file: 0600, replaced whole by a rename
// (writeWhole), read through readOwn (no symlink, this user's own file). Only the holder of the bridge lock writes it: the bridge
// (a lead's unregister) or scripts/channels.mjs (Erick, while the bridge is stopped). A bad file stops the bridge at start.
import { PermissionFlagsBits } from 'discord.js';
import { readOwn, writeWhole } from './state.js';

const SNOWFLAKE = /^\d{17,20}$/;
const shape = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().join() : null);

/** The registry file of a config: `<statePath>.channels`. */
export const channelsPathOf = ({ statePath }) => `${statePath}.channels`;

/** The permissions that sage-bot needs in a registered channel, with the names that Discord shows in the channel settings. */
export const NEEDED = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['ReadMessageHistory', 'Read Message History'],
  ['CreatePublicThreads', 'Create Public Threads'], ['SendMessagesInThreads', 'Send Messages in Threads'], ['ManageThreads', 'Manage Threads'],
  ['EmbedLinks', 'Embed Links']];

/**
 * The registry: a Map of channel id to `{ project, home? }`, in the order of the file; undefined when there is no file. Throws for a
 * file that is not this user's 0600 file, a symlink, bad JSON, an entry that the bridge did not write, or not exactly one home channel.
 * It does not check the projects: `staleOf` names the ones that the config does not list.
 */
export function loadChannels(path) {
  const text = readOwn(path, 'channel registry');
  if (text === undefined) return undefined;
  const bad = (why) => new TypeError(`the channel registry ${path} ${why}. Nothing was loaded.`);
  let data;
  try { data = JSON.parse(text); } catch { throw bad('is not JSON'); }
  if (shape(data) !== 'channels,version' || data.version !== 1 || shape(data.channels) === null) throw bad('is not a version 1 registry');
  const map = new Map();
  for (const [id, e] of Object.entries(data.channels)) {
    if (!SNOWFLAKE.test(id) || !(shape(e) === 'project' || (shape(e) === 'home,project' && e.home === true)) || typeof e.project !== 'string') {
      throw bad('has an entry that the bridge did not write');
    }
    map.set(id, e.home ? { project: e.project, home: true } : { project: e.project });
  }
  if ([...map.values()].filter((e) => e.home).length !== 1) throw bad('must have exactly one home channel (the channel of the votes and cards)');
  return map;
}

/** The ids of the channels whose project is not in `names` (a project removed from the config). */
export const staleOf = (map, names) => [...map].filter(([, e]) => !names.includes(e.project)).map(([id]) => id);

/** Replaces the registry file whole. */
export const saveChannels = (path, map) => writeWhole(path, `${JSON.stringify({ version: 1, channels: Object.fromEntries(map) }, null, 2)}\n`);

/** The id of the home channel. */
export const homeOf = (map) => [...map].find(([, e]) => e.home)[0];
/** The bridge config with its channelId set to the registry's home channel: the votes and cards post there (src/discord.js start). */
export const withHome = (config, map) => ({ ...config, channelId: homeOf(map) });

/** How Erick makes the first registry when the config has no channelId (the README, Channels). */
export const FIRST = 'node scripts/channels.mjs --config <config.json> register <channel id> <project> --home';

/**
 * A new registry made from the config of the time before T130, saved, so that an existing install keeps working: askChannelId (the old
 * #ask-sage) goes to the first project, and channelId (the old parent channel) becomes the home channel, for the bridge's own project.
 * Undefined, and nothing saved, when the config has no channelId. Call it only with the bridge lock held.
 */
export function migrate(config, projects, log = () => {}) {
  if (config.channelId === undefined) return undefined;
  for (const key of ['channelId', 'askChannelId']) {
    if (config[key] !== undefined && !SNOWFLAKE.test(config[key])) throw new TypeError(`the config: ${key} must be a Discord id (17 to 20 digits)`);
  }
  const path = channelsPathOf(config);
  const own = (projects.find((p) => p.project === config.project) ?? projects[0]).name;
  const map = new Map();
  if (config.askChannelId && config.askChannelId !== config.channelId) map.set(config.askChannelId, { project: projects[0].name });
  map.set(config.channelId, { project: config.askChannelId === config.channelId ? projects[0].name : own, home: true });
  saveChannels(path, map);
  log(`made the channel registry ${path} from the config: ${[...map].map(([id, e]) => `${id} -> ${e.project}${e.home ? ' (home)' : ''}`).join(', ')}`);
  return map;
}

/**
 * The registry of the bridge at its start: the file, or a new one made by `migrate`. Throws, and the bridge stops before Discord, when
 * there is neither, or when a channel's project is not in the config; each message names the command that repairs it.
 * @param {{ name: string, project: string }[]} projects  the checked projects of the config (src/ask.js projectsOf)
 */
export function openChannels(config, projects, log = () => {}) {
  const path = channelsPathOf(config);
  const map = loadChannels(path) ?? migrate(config, projects, log);
  if (!map) throw new TypeError(`there is no channel registry ${path}, and the config has no channelId to make one from. Register the home channel with: ${FIRST}`);
  const names = projects.map((p) => p.name);
  const stale = staleOf(map, names);
  if (stale.length) {
    throw new TypeError(`the channel registry ${path} maps ${stale.map((id) => `the channel ${id} to the project "${map.get(id).project}"`).join(', ')}, which is not in the config's projects (${names.join(', ')}). `
      + 'Give the channel a listed project with: node scripts/channels.mjs --config <config.json> register <channel id> <project>, or remove it with: unregister <channel id>. Nothing was loaded.');
  }
  return map;
}

/**
 * Erick's change of the registry at the terminal (scripts/channels.mjs). Changes `map` and returns the line for the terminal, or throws
 * with the reason. `register <id> <project> [--home]` adds a channel or changes its project (with --home it becomes the home channel);
 * `unregister <id>` removes one, but never the home channel.
 */
export function change(map, [verb, id, project, ...rest], names) {
  if (!SNOWFLAKE.test(id ?? '')) throw new TypeError('the channel must be a Discord id (17 to 20 digits)');
  if (map.size === 0 && !(verb === 'register' && rest[0] === '--home')) {
    throw new TypeError(`there is no channel registry yet: register the home channel first, with: ${FIRST}. Nothing was changed`);
  }
  if (verb === 'register') {
    const home = rest[0] === '--home';
    if (rest.length > (home ? 1 : 0)) throw new TypeError(`unknown option ${rest.at(-1)}`);
    if (!names.includes(project)) throw new TypeError(`the project "${project ?? ''}" is not in the config's projects (${names.join(', ')}). Nothing was changed`);
    const keepHome = map.get(id)?.home && !home;
    if (home) for (const e of map.values()) delete e.home;
    map.set(id, home || keepHome ? { project, home: true } : { project });
    return `registered the channel ${id} for the project ${project}${home || keepHome ? ' (home channel of the votes and cards)' : ''}`;
  }
  if (verb === 'unregister' && project === undefined) {
    if (!map.has(id)) throw new TypeError(`the channel ${id} is not registered. Nothing was changed`);
    if (map.get(id).home) throw new TypeError(`the channel ${id} is the home channel of the votes and cards. Make another channel the home first (register <id> <project> --home). Nothing was changed`);
    const { project: was } = map.get(id);
    map.delete(id);
    return `unregistered the channel ${id} (it was for the project ${was})`;
  }
  throw new TypeError('usage: register <channel id> <project> [--home], or unregister <channel id>');
}

/**
 * The lines that name each permission that sage-bot lacks in a registered channel, for the terminal; [] when it has them all.
 * `permissionsOf(id)` gives the bot's permissions there (discord.js permissionsFor), or null when the bot cannot see the channel.
 */
export async function checkChannels(map, permissionsOf) {
  const lines = [];
  for (const [id, e] of map) {
    let perms = null;
    try { perms = await permissionsOf(id); } catch { /* the line below says it */ }
    if (!perms) { lines.push(`sage-bot cannot see the registered channel ${id} (${e.project}): add it to the channel, or unregister the channel`); continue; }
    const missing = NEEDED.filter(([flag]) => !perms.has(PermissionFlagsBits[flag])).map(([, name]) => name);
    if (missing.length) lines.push(`sage-bot lacks these permissions in the registered channel ${id} (${e.project}): ${missing.join(', ')}. Give them to its role in that channel`);
  }
  return lines;
}
