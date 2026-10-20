// The real Discord side of the bridge: the bot token from the macOS Keychain, the discord.js Client, and the port that
// src/bridge.js uses. The tests never run `start`: it is the only code that connects to Discord.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChannelType, Client, Events, GatewayIntentBits, MessageReferenceType, PermissionFlagsBits, ThreadAutoArchiveDuration } from 'discord.js';
import { apiError, createBridge, LOOP } from './bridge.js';
import { askCommand, createAsk, openAskFiles, SEND, sendCommand, STOP, STOP_CANCEL, UNREGISTER } from './ask.js';
import { createOutboxFlow, parseOutboxId } from './outboxFlow.js';
import { parseRequestId } from './requestCards.js';
import { createRequestFlow } from './requestFlow.js';
import { checkChannels, openChannels, withHome } from './channels.js';
import { probeTool, sageTool } from './sage.js';
import { loadProjects, pickProject } from './projects.js';
import { forTerminal } from './clean.js';
import { NO_MENTIONS } from './cards.js';
import { CREW, crewRoleIds, crewWarning, namesOf, oldRoleKeys, ownerOf } from './crew.js';
import { lock } from './state.js';
import { isLiveTask } from './threads.js';
import { alivePathOf, createCatchUp, loadAlive, PAGE } from './catchup.js';
import { notDiscordIds } from './launchd.js';

/**
 * The options of the discord.js Client. GuildMessages (not privileged) brings the messages of the server; MessageContent (privileged, R918
 * C6, owner decision) gives their text, so that a message to sage can take the messages before it as its context ("implement what we
 * discussed above", T247). With it off in the Developer Portal, Discord refuses the login (close code 4014). `allowedMentions` (C5): a message that sets no allowedMentions of its own pings nobody, so a missed
 * NO_MENTIONS can never ping @everyone, a role or a person. A message that sets its own (the owner's ping on a request card, the
 * crew alert) keeps it: discord.js takes the message's allowedMentions in place of the client's.
 */
export const CLIENT_OPTIONS = {
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [] },
};

/**
 * One sage-bot serves one server (C4): it leaves each server that is not `guildId`, the ones it is in at the start and each one it is
 * added to later (GuildCreate), with one log line each. The owner keeps Public Bot off in the Developer Portal (docs/setup.md), so only
 * the owner can add it to a server; this is the second layer. A refused leave is logged, and the bot ignores that server all the same.
 * Returns the promise of the leaves at the start. When the bot is not in `guildId` (a wrong config), it leaves nothing and the promise
 * rejects with one line that names guildId, so the start stops (F-T244-1).
 */
export async function keepToGuild(client, guildId, log) {
  if (!client.guilds.cache.has(guildId)) {
    throw new Error(`sage-bot is not in the server ${guildId} of its config, so it left no server. Check guildId in the config, or add sage-bot to that server, then start it again.`);
  }
  const leave = (g) => {
    if (g.id === guildId) return undefined;
    log(`sage-bot left the server ${g.id} (${g.name}): it serves only the server ${guildId} of its config`);
    return g.leave().catch((e) => log(`Discord refused to let sage-bot leave the server ${g.id}; it ignores that server all the same: ${apiError(e)}`));
  };
  client.on(Events.GuildCreate, leave);
  return Promise.all([...client.guilds.cache.values()].map(leave));
}

/**
 * The owner's name for the copy (T244), raw: their own Discord name (the global display name, else the user name), which only they can
 * change; never a server nickname, which a moderator can change (F-T244-6). Undefined when Discord gives no user (src/crew.js namesOf
 * then says "the owner"). namesOf cleans it; nothing else reads it.
 */
export async function ownerNameOf(client, ownerId) {
  try {
    const user = await client.users.fetch(ownerId);
    return user.globalName ?? user.username;
  } catch { return undefined; }
}

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
 * A discord.js GuildMember as the bridge needs it (F-T28-20): its id, its display name, the NAMES of its roles (T232: src/crew.js reads
 * the crew by name) and whether it is a bot.
 * @param {import('discord.js').GuildMember} m
 */
export const memberOf = (m) => ({ id: m.id, name: m.displayName, roles: rolesOf(m), bot: m.user.bot === true });

/**
 * The role NAMES of a member: a GuildMember (roles.cache), or the raw API member (a list of ids) with the guild's roles `guildRoles`
 * (a Map of id → Role). The names are read at each call, so a role created, renamed or deleted counts at once: discord.js keeps its
 * cache of roles up to date from Discord's role events (the Guilds intent). Roles come from Discord, never from text.
 */
export const rolesOf = (member, guildRoles) => (Array.isArray(member?.roles)
  ? member.roles.map((id) => guildRoles?.get(id)?.name).filter((name) => typeof name === 'string')
  : [...(member?.roles?.cache?.values() ?? [])].map((r) => r.name));

/**
 * The bot's Discord application as src/crew.js ownerOf reads it: an application of one user has that user as `owner`; an application of
 * a Developer Team has a discord.js Team as its owner (with `members`), and gives only the team's owner.
 * @param {import('discord.js').ClientApplication} a
 */
export const appOf = (a) => (a.owner && 'members' in a.owner
  ? { owner: null, team: { ownerId: a.owner.ownerId ?? null } }
  : { owner: a.owner ? { id: a.owner.id } : null, team: null });

/**
 * The parent channel id when an interaction or a message is in a thread, else null. A thread that is not in the cache (`channel` is
 * null) comes from `fetch(x.channelId)`; a fetch that fails gives null, so it counts as another channel (F-T29-10).
 * @param {(id: string) => Promise<{ isThread(): boolean, parentId?: string }>} fetch
 */
export async function parentOf(x, fetch) {
  const channel = x.channel ?? await fetch(x.channelId).catch(() => null);
  return channel?.isThread() === true ? channel.parentId : null;
}

/**
 * A discord.js Message as the context of a message to sage reads it (src/outboxFlow.js): its id, author, the author's name as the server
 * shows it and the NAMES of their roles (from the member cache, which the GuildMembers intent keeps; none for a person who left), whether a
 * bot, a system message or a webhook wrote it, its time and its text.
 * @param {import('discord.js').Message} m
 */
export const rawOf = (m, guildRoles) => ({
  id: m.id, user: m.author.id, name: m.member?.displayName ?? m.author.globalName ?? m.author.username, roles: rolesOf(m.member, guildRoles),
  bot: m.author.bot === true || m.system === true, webhook: !!m.webhookId, at: m.createdTimestamp, text: m.content ?? '',
});

/**
 * Whether a thread is public (F-T247-11, F-T247-26): not a private thread, and its parent channel lets @everyone view it and read its
 * history. Only a public thread moves
 * to the home channel (src/ask.js placeOfMessage), because a move posts its context there. Anything that cannot be read counts as not public.
 * @param {import('discord.js').Channel | null} t  the thread, with `parent` (or `parentId` and `fetch` for a parent not in the cache)
 * @param {(id: string) => Promise<import('discord.js').Channel>} fetch
 */
export async function publicThread(t, fetch) {
  if (t?.isThread?.() !== true || t.type === ChannelType.PrivateThread) return false;
  const parent = t.parent ?? await fetch(t.parentId).catch(() => null);
  const everyone = parent?.permissionsFor?.(t.guild.roles.everyone);
  return everyone?.has(PermissionFlagsBits.ViewChannel) === true && everyone.has(PermissionFlagsBits.ReadMessageHistory) === true;
}

/** The display names of the people that a message mentions (user id → name), for its card (F-T247-3). */
export const mentionNames = (m) => Object.fromEntries([...(m.mentions?.users?.values() ?? [])]
  .map((u) => [u.id, m.mentions.members?.get(u.id)?.displayName ?? u.globalName ?? u.username]));

/**
 * The context port of a message `m` in its place (src/ask.js mention and send): `history(before)` reads the 100 messages of the place
 * before the id `before`, newest first (Get Channel Messages, which needs Read Message History); `replied()` the message that `m` replies
 * to, or null: only a reply in the same place, never a forward, whose source can be a channel that the place's readers cannot see
 * (F-T247-19); `open(channel, payload, name)` posts a line in a channel and opens a public thread from it (the move of R918 C7); `post`;
 * `channel(id)` fetches a channel or thread; `isPublic()` whether the place is a public thread (publicThread); `mentions` the names of
 * the people that `m` mentions.
 */
const contextPort = (m, fetch, guildRoles) => ({
  isPublic: async () => publicThread(await fetch(m.channelId).catch(() => null), fetch),
  mentions: mentionNames(m),
  history: async (before) => [...(await (await fetch(m.channelId)).messages.fetch({ before, limit: 100, cache: false })).values()]
    .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1)).map((x) => rawOf(x, guildRoles)),
  replied: async () => (m.reference?.messageId && m.reference.type === MessageReferenceType.Default && m.reference.channelId === m.channelId
    ? m.fetchReference().then((x) => rawOf(x, guildRoles), () => null) : null),
  channel: (id) => fetch(id),
  open: async (channel, payload, name) => (await (await (await fetch(channel)).send(payload)).startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay })).id,
  post: async (place, payload) => (await (await fetch(place)).send(payload)).id,
  startThread: async (name) => (await m.startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay })).id,
});

/** The name of the person of an interaction, as the server shows it. */
const nameOf = (i) => i.member?.displayName ?? i.user.globalName ?? i.user.username;

/**
 * A /sage chat command as src/ask.js reads it. `parentId` is a promise: src/ask.js defers the reply before it waits for anything. `reply`
 * is a private note (T239) and `showModal` the form of /sage request, each as Discord's first answer.
 */
export const commandOf = (i, fetch, guildRoles) => ({
  user: { id: i.user.id, bot: i.user.bot === true }, name: nameOf(i), roles: rolesOf(i.member, guildRoles), channelId: i.channelId, parentId: parentOf(i, fetch),
  sub: i.options.getSubcommand(false), options: { project: i.options.getString('project'), id: i.options.getString('id') },
  defer: (payload) => i.deferReply(payload),
  edit: (payload) => i.editReply(payload),
  remove: () => i.deleteReply(),
  reply: (payload) => i.reply(payload),
  showModal: (payload) => i.showModal(payload),
});

/**
 * The "Send to sage" message command (T247) as src/ask.js send reads it: the sender, the target message (rawOf) and its context port, and
 * the private answers of Discord.
 */
export const sendOf = (i, fetch, guildRoles) => {
  const target = rawOf(i.targetMessage, guildRoles);
  return {
    user: { id: i.user.id, bot: i.user.bot === true }, name: nameOf(i), roles: rolesOf(i.member, guildRoles), channelId: i.channelId, parentId: parentOf(i, fetch),
    target: { ...target, user: { id: target.user }, content: target.text },
    defer: (payload) => i.deferReply(payload), edit: (payload) => i.editReply(payload), reply: (payload) => i.reply(payload),
    ...contextPort(i.targetMessage, fetch, guildRoles),
  };
};

/**
 * A press of an approval card (a custom_id `ob1:…`) as src/outboxFlow.js reads it: the person, the NAMES of their roles, the message with
 * the button, and the answers of Discord.
 */
export const outboxPressOf = (i, guildRoles) => ({
  user: { id: i.user.id, bot: i.user.bot === true }, roles: rolesOf(i.member, guildRoles), customId: i.customId,
  message: i.message ? { id: i.message.id } : null,
  reply: (payload) => i.reply(payload), deferReply: (payload) => i.deferReply(payload), editReply: (payload) => i.editReply(payload),
});

/**
 * A press or a form of a request (a custom_id `rq1:…`) as src/requestFlow.js reads it: the person, the NAMES of their roles, the message
 * with the button (null for the form of the command), and the answers of Discord.
 */
export const requestPressOf = (i, guildRoles) => ({
  user: { id: i.user.id, bot: i.user.bot === true }, roles: rolesOf(i.member, guildRoles), customId: i.customId,
  message: i.message ? { id: i.message.id, createdTimestamp: i.message.createdTimestamp } : null,
  fields: i.isModalSubmit() ? i.fields : undefined,
  reply: (payload) => i.reply(payload),
  update: (payload) => i.update(payload),
  showModal: (payload) => i.showModal(payload),
  deferReply: (payload) => i.deferReply(payload),
  deferUpdate: () => i.deferUpdate(),
  editReply: (payload) => i.editReply(payload),
});

/**
 * Whether an interaction is the bridge's: a button or a form in the configured channel, in a thread of it (T29), or in a task thread of
 * the thread map `threads` (T245, F3 of R917) whose channel the registry `channels` holds now (isLiveTask). A press in any other channel
 * or thread is not, also on a message with the bridge's custom ids.
 */
export async function accepts(i, channelId, fetch, threads, channels) {
  if (!(i.isButton() || i.isModalSubmit())) return false;
  return i.channelId === channelId || isLiveTask(threads.get(i.channelId), channels) || await parentOf(i, fetch) === channelId;
}

/** Whether a message goes to the mention path: in the guild `guildId`, not from a bot or a webhook, and it mentions the bot `botId`. */
export const forMe = (m, guildId, botId) => m.guildId === guildId && !m.author.bot && !m.webhookId && m.mentions.users.has(botId);

/**
 * The gateway events of the catch-up (T241): `ready` at each new session (shardReady) and each resume (shardResume), so also after a
 * sleep, which does not restart the process; `down` when the connection goes (shardDisconnect, shardReconnecting).
 */
export function watchGateway(client, { ready, down }) {
  for (const event of [Events.ShardReady, Events.ShardResume]) client.on(event, () => { ready(); });
  for (const event of [Events.ShardDisconnect, Events.ShardReconnecting]) client.on(event, () => { down(); });
}

/**
 * The handlers of the Discord events, for one guild: `interaction` takes /sage and the "Send to sage" message command to src/ask.js, the
 * buttons and forms of a request (in any registered channel and its threads: the request route, T228) to src/requestFlow.js, the buttons of
 * an approval card (T247) to src/outboxFlow.js, and the bridge's buttons and forms to the bridge; `message` takes a message that mentions
 * the bot (`botId`) and is not from a bot or a webhook (forMe) to src/ask.js. Anything from another guild gets nothing.
 * Each returns the promise of its work, or nothing. `guildRoles` is the guild's Map of roles (rolesOf); `threads` the thread map and
 * `channels` the channel registry (accepts).
 */
export const routes = ({ config, ask, bridge, requests, outbox, fetch, botId, guildRoles, threads = new Map(), channels = new Map() }) => ({
  interaction(i) {
    if (i.guildId !== config.guildId) return undefined;
    if (i.isChatInputCommand()) return i.commandName === 'sage' ? ask.command(commandOf(i, fetch, guildRoles)) : undefined;
    if (i.isMessageContextMenuCommand()) return i.commandName === SEND ? ask.send(sendOf(i, fetch, guildRoles)) : undefined;
    // The request's own record decides who may press (src/requestFlow.js), so the place of the press does not; so does a message's (T247).
    if ((i.isButton() || i.isModalSubmit()) && parseRequestId(i.customId)) return requests.interaction(requestPressOf(i, guildRoles));
    if (i.isButton() && parseOutboxId(i.customId)) return outbox.interaction(outboxPressOf(i, guildRoles));
    if (i.isButton() && (i.customId.startsWith(UNREGISTER) || i.customId === STOP || i.customId.startsWith(STOP_CANCEL))) {
      return ask.press({ user: { id: i.user.id, name: i.member?.displayName ?? i.user.globalName ?? i.user.username, bot: i.user.bot === true }, roles: rolesOf(i.member, guildRoles),
        customId: i.customId, sentAt: i.message?.createdTimestamp, update: (payload) => i.update(payload), reply: (payload) => i.reply(payload) });
    }
    return accepts(i, config.channelId, fetch, threads, channels).then((ok) => ok && bridge.interaction(i));
  },
  message(m) {
    if (!forMe(m, config.guildId, botId)) return undefined;
    // A public thread from the message (T131, contextPort). Discord archives a quiet thread after a day; a mention in it opens it again.
    return ask.mention({ id: m.id, user: { id: m.author.id, bot: false }, name: m.member?.displayName ?? m.author.globalName ?? m.author.username,
      roles: rolesOf(m.member, guildRoles), channelId: m.channelId, parentId: parentOf(m, fetch), content: m.content, reply: (payload) => m.reply(payload),
      ...contextPort(m, fetch, guildRoles) });
  },
});

/**
 * The Discord side of the catch-up (src/catchup.js): `fetch`, `roles` and `post` on the guild `guild`, with `place(id)` the channel or
 * thread and `on` the routes. `roles` reads the member fresh from Discord (force), never the cache: a role that changed while sage-bot was
 * offline counts as now (F-T241-4). The fetch also puts the fresh member in the cache, so the mention path (on.message, through
 * `Message.member`) reads the same roles. A user who is not a member now (Unknown Member or Unknown User) gets null.
 */
export const catchUpPort = ({ guild, place, botId, on }) => ({
  fetch: async (at, after) => [...(await (await place(at)).messages.fetch({ after, limit: PAGE, cache: false })).values()].map((m) => ({
    id: m.id, forMe: forMe(m, guild.id, botId), user: { id: m.author.id }, reply: (payload) => m.reply(payload), handle: () => on.message(m) })),
  roles: async (user) => {
    try { return rolesOf(await guild.members.fetch({ user, force: true }), guild.roles.cache); } catch (e) {
      if (e?.code === 10007 || e?.code === 10013) return null;
      throw e;
    }
  },
  post: async (at, payload) => (await place(at)).send(payload),
});

/**
 * The start before Discord: checks the config's ids, the projects and their folders, takes the lock on the gate file (one bridge at a time,
 * F-T28-30) and opens the channel registry (T130: made from channelId and askChannelId when there is none). A config that is not safe,
 * or a bad registry, stops here, before the Keychain. Then it opens the thread map and the audit log (src/ask.js openAskFiles): a file
 * that is not safe stops here too (F-T232-3). A config with the role keys of before T232 starts, and the log says that they do
 * nothing. `fetchChannel(id)` gives a Discord channel after the login: the #sage-audit copy of each audit log line goes through it. The returned
 * config has the registry's home channel as its channelId: the votes and cards go there. `audit` posts to #sage-audit (none: no
 * auditChannelId). The read commands (createAsk, on `files`) start after the login, when the owner is known (C12).
 */
export function prepare(file, log, fetchChannel) {
  const old = oldRoleKeys(file);
  if (old) log(old);
  const notIds = notDiscordIds(file); // the same check as scripts/launchd.mjs (F-T143-13)
  if (notIds.length) throw new Error(`in the config, ${notIds.join(', ')} must each be a Discord id (17 to 20 digits). Nothing was started.`);
  const projects = loadProjects(file); // a config whose projects the bridge cannot serve stops here, before the lock (G43 A)
  const own = pickProject(projects).name;
  lock(file.statePath);
  const channels = openChannels(file, projects, log);
  const config = withHome(file, channels);
  const files = { ...openAskFiles(config, projects), alive: loadAlive(alivePathOf(config)) }; // the catch-up file too (T241)
  // #sage-audit (T131): a copy of each audit log line. Without auditChannelId, the audit log only, and the start says so.
  let auditChannel = null;
  const audit = config.auditChannelId ? async (payload) => { auditChannel ??= await fetchChannel(config.auditChannelId); await auditChannel.send(payload); } : undefined;
  if (!audit) log('no auditChannelId in the config: messages to sage go to the audit log only, with no copy in #sage-audit');
  return { config, channels, projects, own, audit, files };
}

/**
 * The crew check (T232) at the start and after each role event of the guild: a line when no role is named sage-crew, and one warning
 * line (in the log and #sage-audit) each time two or more roles come to share the name. Returns the function for the role events.
 */
export function watchCrew(roles, { log, audit }) {
  let last = null;
  const check = () => {
    const warning = crewWarning(roles());
    if (warning && warning !== last) {
      log(warning);
      audit?.({ content: warning, allowedMentions: NO_MENTIONS }).catch((e) => log(`Discord refused the #sage-audit warning: ${apiError(e)}`));
    }
    last = warning;
  };
  if (!crewRoleIds(roles()).length) log(`no role of the server is named ${CREW}: only the owner can use sage-bot until a role has that name. Make a role named exactly ${CREW} (the case counts) and give it to each crew member.`);
  check();
  return check;
}

/**
 * The start after the login: fetches the guild and its members, sets /sage for this guild only (a refusal is logged, and the start
 * goes on), and logs each permission that sage-bot lacks in a registered channel. Returns the guild.
 */
export async function enter(client, { config, channels, ask, log }) {
  const guild = await client.guilds.fetch(config.guildId);
  await guild.members.fetch();
  // A refused /sage stops only /sage: the votes and cards start all the same (F-T93-4). The build of /sage is inside the guard too:
  // discord.js refuses a command that Discord would refuse (F-T244-5).
  await Promise.try(() => guild.commands.set([askCommand(ask.projects, namesOf(config)), sendCommand()])).catch((e) => log(`Discord refused to set /sage and ${SEND}, so they keep the commands of the last start that worked, or there are none; the votes and cards work: ${apiError(e)}`));
  for (const line of await checkChannels(channels, async (id) => (await client.channels.fetch(id))?.permissionsFor(client.user) ?? null)) log(line);
  return guild;
}

/**
 * Starts the bridge: `prepare`, then reads the token, logs in, finds the owner (C12), `enter`, and runs the loop every LOOP ms.
 * @param {{ guildId: string, channelId?: string, askChannelId?: string, ownerId?: string,
 *   project: string, sagePath: string, statePath: string }} file
 */
export async function start(file) {
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${forTerminal(line)}\n`);
  const prepared = prepare(file, log, (id) => client.channels.fetch(id)); // `client` exists before any audit log line
  const { channels, projects, own, audit, files } = prepared;
  // Before the token is read: a sage tool that does not take the bridge's `gate answer` form refuses the start with one line (T176).
  for (const sagePath of new Set(projects.map((p) => p.sagePath))) await probeTool(sagePath);
  const token = await readToken();
  const client = new Client(CLIENT_OPTIONS);
  client.on(Events.Error, (e) => log(`Discord error: ${apiError(e)}`));
  const ready = new Promise((done) => client.once(Events.ClientReady, done));
  // Any failure of the start from the login on closes the connection to Discord, so the process ends (F-T232-3).
  try {
    await client.login(token);
    await ready;
    await keepToGuild(client, prepared.config.guildId, log); // C4: before any other work, so no other server sees a reply
    // The owner (C12): the config's ownerId, else the owner of this Discord application. The one read of the owner: every check of the
    // crew and the owner goes through src/crew.js with this id.
    const owner = ownerOf(prepared.config.ownerId, appOf(await client.application.fetch()));
    if (owner.warning) log(owner.warning);
    // The names in the copy (T244): the owner's and the bot's own Discord names, raw, never a server nickname (F-T244-6); src/crew.js
    // namesOf is their one reader.
    const ownerName = await ownerNameOf(client, owner.ownerId);
    if (ownerName === undefined) log(`Discord did not give the name of the owner ${owner.ownerId}: the copy says "the owner"`);
    const config = { ...prepared.config, ownerId: owner.ownerId, ownerName, botName: client.user.globalName ?? client.user.username };
    const place = (id) => client.channels.fetch(id); // the channel or one of its threads, from the cache when it is there
    // The requests (T228): a line in the request's channel, a thread from it, and the card in the thread. Discord archives a quiet
    // thread after a week; a post opens it again.
    // The one thread map of the process (F4 of R917): the requests write its task threads, src/ask.js its mention threads, and the bridge
    // and the routes read it.
    const requests = createRequestFlow({ config, channels, projects, log, threads: files.threads, discord: {
      post: async (target, payload) => (await (await place(target)).send(payload)).id,
      edit: async (target, id, payload) => (await (await place(target)).messages.fetch(id)).edit(payload),
      startThread: async (at, lineId, name) => (await (await (await place(at)).messages.fetch(lineId)).startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek })).id,
      threadFrom: async (at, lineId) => (await place(lineId)).id, // the thread that a message started has the message's id
      unarchive: async (thread) => { await (await place(thread)).setArchived(false); },
    } });
    // The outbox (T247): the approval cards of the messages to sage, in their threads.
    const outbox = createOutboxFlow({ config, files, audit, log, discord: {
      post: async (target, payload) => (await (await place(target)).send(payload)).id,
      edit: async (target, id, payload) => (await (await place(target)).messages.fetch(id)).edit(payload),
      unarchive: async (thread) => { await (await place(thread)).setArchived(false); },
      // Get Channel Message, never from the cache, so a card that a member deleted shows as gone (code 10008, F-T247-16).
      seen: async (target, id) => { await (await place(target)).messages.fetch({ message: id, force: true }); },
    } });
    const ask = createAsk({ config, channels, projects, log, audit, files, requests, outbox });
    const guild = await enter(client, { config, channels, ask, log });
    const roles = () => guild.roles.cache.values();
    const crewCheck = watchCrew(roles, { log, audit });
    for (const event of [Events.GuildRoleCreate, Events.GuildRoleUpdate, Events.GuildRoleDelete]) {
      client.on(event, (...r) => { if (r[0]?.guild?.id === config.guildId) crewCheck(); });
    }
    const channel = await client.channels.fetch(config.channelId);
    const bridge = createBridge({
      sages: new Map(projects.map((p) => [p.name, sageTool(p)])), // one sage tool per project of the config (T132)
      own,
      config,
      statePath: config.statePath,
      threads: files.threads,
      channels,
      log,
      discord: {
        members: () => guild.members.cache.map(memberOf),
        roles: () => [...roles()].map((r) => ({ id: r.id, name: r.name })),
        post: async (target, payload) => (await (await place(target)).send(payload)).id,
        edit: async (target, id, payload) => (await (await place(target)).messages.fetch(id)).edit(payload),
        // A thread from the session's line in the parent channel. Discord archives a quiet thread after a week; a post opens it again.
        startThread: async (lineId, name) => (await (await channel.messages.fetch(lineId)).startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek })).id,
        // The thread that a message started has the message's id, so a fetch of that id finds it (code 160004, F-T29-2).
        threadFrom: async (lineId) => (await place(lineId)).id,
        setLocked: async (thread, locked) => (await place(thread)).edit({ archived: locked, locked }),
      },
    });
    const on = routes({ config, ask, bridge, requests, outbox, fetch: place, botId: client.user.id, guildRoles: guild.roles.cache, threads: files.threads, channels });
    client.on(Events.InteractionCreate, (i) => { on.interaction(i); });
    // The catch-up (T241): at each gateway ready, the messages of the watched places that the bridge did not see.
    const catchUp = createCatchUp({ config, log, alive: files.alive, ...catchUpPort({ guild, place, botId: client.user.id, on }),
      places: () => {
        const open = requests.threads(); // null while the request file cannot be read: those threads are unknown, not gone
        return { ids: [...channels.keys(), ...files.threads.keys(), ...(open ?? [])], partial: open === null };
      } });
    client.on(Events.MessageCreate, (m) => { if (m.guildId === config.guildId) catchUp.live(m.channelId, m.id, () => on.message(m)); });
    let busy = false;
    const turn = async () => {
      catchUp.beat(); // the heartbeat, also while a long turn runs
      if (busy) return;
      busy = true;
      try {
        await bridge.loop().catch((e) => log(`the loop failed: ${e?.message}`));
        await requests.loop(); // never rejects
        await outbox.loop(); // never rejects
      } finally { busy = false; }
    };
    // The requests and the sessions reconcile, and the cards redraw, in the turn at each ready too.
    watchGateway(client, { ready: () => { catchUp.run(); turn(); }, down: () => catchUp.down() });
    catchUp.run(); // the first ready came during the login
    setInterval(turn, LOOP);
    await turn();
  } catch (e) {
    await client.destroy();
    throw e;
  }
  log('the sage bridge runs');
}
