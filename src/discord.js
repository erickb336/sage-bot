// The real Discord side of the bridge: the bot token from the macOS Keychain, the discord.js Client, and the port that
// src/bridge.js uses. The tests never run `start`: it is the only code that connects to Discord.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, Events, GatewayIntentBits, ThreadAutoArchiveDuration } from 'discord.js';
import { apiError, createBridge, LOOP, refuseOldRoles } from './bridge.js';
import { askCommand, createAsk } from './ask.js';
import { sageTool } from './sage.js';
import { forTerminal } from './clean.js';
import { lock } from './state.js';

/** The Keychain item that holds the bot token: a generic password with this service name. */
export const KEYCHAIN_SERVICE = 'sage-bot';

/**
 * The bot token, read at start from the macOS Keychain with execFile (no shell). It is never written to a file or a log,
 * and an error never holds it: a missing item gives one fixed message. `security` is the tool's path, for the tests.
 */
export async function readToken(security = '/usr/bin/security') {
  try {
    const { stdout } = await promisify(execFile)(security, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' });
    const token = stdout.trim();
    if (token) return token;
  } catch { /* the message below says what to do; the error itself is not shown */ }
  throw new Error(`no bot token: the macOS Keychain has no generic password with the service "${KEYCHAIN_SERVICE}". Add it with Keychain Access, then start the bridge again.`);
}

/**
 * A discord.js GuildMember as the bridge needs it (F-T28-20): its id, its display name, its role ids and whether it is a bot.
 * @param {import('discord.js').GuildMember} m
 */
export const memberOf = (m) => ({ id: m.id, name: m.displayName, roles: [...m.roles.cache.keys()], bot: m.user.bot === true });

/** The role ids of an interaction's member: a GuildMember (roles.cache) or the raw API member (a list of ids). Roles come from Discord, never from text. */
export const rolesOf = (member) => (Array.isArray(member?.roles) ? [...member.roles] : [...(member?.roles?.cache?.keys() ?? [])]);

/**
 * The parent channel id when an interaction or a message is in a thread, else null. A thread that is not in the cache (`channel` is
 * null) comes from `fetch(x.channelId)`; a fetch that fails gives null, so it counts as another channel (F-T29-10).
 * @param {(id: string) => Promise<{ isThread(): boolean, parentId?: string }>} fetch
 */
export async function parentOf(x, fetch) {
  const channel = x.channel ?? await fetch(x.channelId).catch(() => null);
  return channel?.isThread() === true ? channel.parentId : null;
}

/** A /sage chat command as src/ask.js reads it. `parentId` is a promise: src/ask.js defers the reply before it waits for anything. */
export const commandOf = (i, fetch) => ({
  user: { id: i.user.id, bot: i.user.bot === true }, roles: rolesOf(i.member), channelId: i.channelId, parentId: parentOf(i, fetch),
  sub: i.options.getSubcommand(false), options: { project: i.options.getString('project'), id: i.options.getString('id') },
  defer: (payload) => i.deferReply(payload),
  edit: (payload) => i.editReply(payload),
});

/**
 * Whether an interaction is the bridge's: a button or a form in the configured channel or in a thread of it (T29). A press in any
 * other channel is not, also on a message with the bridge's custom ids.
 */
export async function accepts(i, channelId, fetch) {
  if (!(i.isButton() || i.isModalSubmit())) return false;
  return i.channelId === channelId || await parentOf(i, fetch) === channelId;
}

/**
 * The handlers of the Discord events, for one guild: `interaction` takes /sage to src/ask.js and the bridge's buttons and forms to
 * the bridge; `message` takes a message that mentions the bot (`botId`) and is not from a bot to src/ask.js. Anything from another
 * guild gets nothing. Each returns the promise of its work, or nothing.
 */
export const routes = ({ config, ask, bridge, fetch, botId }) => ({
  interaction(i) {
    if (i.guildId !== config.guildId) return undefined;
    if (i.isChatInputCommand()) return i.commandName === 'sage' ? ask.command(commandOf(i, fetch)) : undefined;
    return accepts(i, config.channelId, fetch).then((ok) => ok && bridge.interaction(i));
  },
  message(m) {
    if (m.guildId !== config.guildId || m.author.bot || !m.mentions.users.has(botId)) return undefined;
    return ask.mention({ user: { id: m.author.id, bot: false }, roles: rolesOf(m.member), channelId: m.channelId, parentId: parentOf(m, fetch),
      content: m.content, reply: (payload) => m.reply(payload) });
  },
});

/**
 * Starts the bridge: takes the lock on the gate file (one bridge at a time, F-T28-30), reads the token, logs in, and runs the loop every LOOP ms.
 * @param {{ guildId: string, channelId: string, ownerId: string, apprenticeRole: string, leadRole: string,
 *   project: string, sagePath: string, statePath: string }} config
 */
export async function start(config) {
  refuseOldRoles(config); // before the lock and the Keychain: an old config never reaches Discord
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${forTerminal(line)}\n`);
  const ask = createAsk({ config, log }); // the same: a config that is not safe stops here (T71)
  lock(config.statePath);
  const token = await readToken();
  // GuildMessages (not privileged) brings the messages that mention the bot, with their text; no MessageContent intent (PE R314).
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });
  client.on(Events.Error, (e) => log(`Discord error: ${apiError(e)}`));
  const ready = new Promise((done) => client.once(Events.ClientReady, done));
  await client.login(token);
  await ready;
  const guild = await client.guilds.fetch(config.guildId);
  await guild.members.fetch();
  await guild.commands.set([askCommand(ask.projects)]); // /sage, for this guild only
  const channel = await client.channels.fetch(config.channelId);
  const place = (id) => client.channels.fetch(id); // the channel or one of its threads, from the cache when it is there
  const bridge = createBridge({
    sage: sageTool(config),
    config,
    statePath: config.statePath,
    log,
    discord: {
      members: () => guild.members.cache.map(memberOf),
      post: async (target, payload) => (await (await place(target)).send(payload)).id,
      edit: async (target, id, payload) => (await (await place(target)).messages.fetch(id)).edit(payload),
      // A thread from the session's line in the parent channel. Discord archives a quiet thread after a week; a post opens it again.
      startThread: async (lineId, name) => (await (await channel.messages.fetch(lineId)).startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek })).id,
      // The thread that a message started has the message's id, so a fetch of that id finds it (code 160004, F-T29-2).
      threadFrom: async (lineId) => (await place(lineId)).id,
      setLocked: async (thread, locked) => (await place(thread)).edit({ archived: locked, locked }),
    },
  });
  const on = routes({ config, ask, bridge, fetch: place, botId: client.user.id });
  client.on(Events.InteractionCreate, (i) => { on.interaction(i); });
  client.on(Events.MessageCreate, (m) => { on.message(m); });
  let busy = false;
  const turn = async () => {
    if (busy) return;
    busy = true;
    try { await bridge.loop(); } catch (e) { log(`the loop failed: ${e?.message}`); } finally { busy = false; }
  };
  setInterval(turn, LOOP);
  await turn();
  log('the sage bridge runs');
}
