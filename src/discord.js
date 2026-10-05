// The real Discord side of the bridge: the bot token from the macOS Keychain, the discord.js Client, and the port that
// src/bridge.js uses. The tests never run `start`: it is the only code that connects to Discord.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, Events, GatewayIntentBits, ThreadAutoArchiveDuration } from 'discord.js';
import { apiError, createBridge, LOOP } from './bridge.js';
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

/**
 * Whether an interaction is the bridge's: a button or a form in the configured channel or in a thread of it (T29). A press in any
 * other channel is not, also on a message with the bridge's custom ids.
 */
export const accepts = (i, channelId) => (i.isButton() || i.isModalSubmit())
  && (i.channelId === channelId || (i.channel?.isThread() === true && i.channel.parentId === channelId));

/**
 * Starts the bridge: takes the lock on the gate file (one bridge at a time, F-T28-30), reads the token, logs in, and runs the loop every LOOP ms.
 * @param {{ guildId: string, channelId: string, ownerId: string, driverRole: string, leadRole: string,
 *   project: string, sagePath: string, statePath: string }} config
 */
export async function start(config) {
  lock(config.statePath);
  const token = await readToken();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${forTerminal(line)}\n`);
  client.on(Events.Error, (e) => log(`Discord error: ${apiError(e)}`));
  const ready = new Promise((done) => client.once(Events.ClientReady, done));
  await client.login(token);
  await ready;
  const guild = await client.guilds.fetch(config.guildId);
  await guild.members.fetch();
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
  client.on(Events.InteractionCreate, (i) => {
    if (accepts(i, config.channelId)) bridge.interaction(i);
  });
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
