// A fake Discord interaction for the tests and the preview: the shape that `handle` reads, and a record of
// every reply. No Client, no login, no network, no token. SAMPLE DATA ONLY.
import { EventEmitter } from 'node:events';
import { Events, MessageFlags, MessageFlagsBitField } from 'discord.js';
import { idAt, timeOf } from './catchup.js';
import { parseCustomId } from './cards.js';

/**
 * An interaction-like object. `replies` records each answer as `{ kind, ...payload }`,
 * with kind 'reply' (a message, private when its flags say so), 'update' (the message with the buttons) or 'modal'.
 * @param {{ user: string, customId: string, fields?: Record<string, string>, ephemeral?: boolean, refuse?: Error, message?: string,
 *   sentAt?: number, roles?: string[] }} o
 *   `fields` are the modal's inputs by custom_id; a button press has none. `ephemeral` says that the pressed message
 *   was private (the owner's confirm), as discord.js shows it in `interaction.message.flags`. With `refuse`, every
 *   reply rejects with that error and records nothing, as Discord does for an unknown interaction (F-T27-20). `message` is the id of
 *   the message with the button, as discord.js shows it in `interaction.message.id`, and `sentAt` its `createdTimestamp`. `roles` are
 *   the NAMES of the member's roles, as src/discord.js maps them for a request press. The kinds 'defer' (deferReply), 'deferUpdate' and
 *   'editReply' are the replies of a press that takes long (src/requestFlow.js).
 */
export function fakeInteraction({ user, customId, fields, ephemeral = false, refuse, message, sentAt, roles }) {
  const replies = [];
  const record = (kind) => async (payload = {}) => { if (refuse) throw refuse; replies.push(structuredClone({ kind, ...payload })); };
  return {
    user: { id: user },
    customId,
    ...(roles && { roles }),
    message: { id: message, createdTimestamp: sentAt, flags: new MessageFlagsBitField(ephemeral ? MessageFlags.Ephemeral : 0) },
    // Like discord.js: a missing field throws, and a button press has no `fields` at all.
    ...(fields && { fields: { getTextInputValue: (id) => {
      if (!(id in fields)) throw new TypeError(`Required field with custom id "${id}" not found.`);
      return fields[id];
    } } }),
    replies,
    reply: record('reply'),
    update: record('update'),
    showModal: record('modal'),
    deferReply: record('defer'),
    deferUpdate: record('deferUpdate'),
    editReply: record('editReply'),
  };
}

/**
 * A fake channel, its threads and the guild for the bridge (src/bridge.js): the port `{ post, edit, startThread, threadFrom, unarchive, setLocked, members, roles }`
 * with a record of every message. `messages` maps a message id to its payloads, the first one posted and each edit after it; `posts`
 * lists the posted payloads in order, and `where` maps a message id to the channel or thread it was posted in. `threads` maps a thread
 * id to { from, name, archived, locked }, where `from` is the message the thread started from. Like Discord, a post or an edit in a
 * locked thread is refused, and so is an edit of a message in another place. `archive` does what Discord does to a quiet thread: an edit
 * there is refused with code 50083 until `unarchive` (refused for a locked thread), and a post opens the thread again. A post with
 * `enforceNonce` and a `nonce` that this place already took from the same author (`by`, the third argument of `post`: one bot by default) gives back that message's id and posts nothing, as Discord does for a few minutes. `deleteThread` and `deleteMessage` do what a member's delete
 * in Discord does: a post, edit or lock in a deleted thread is refused with code 10003 (Unknown Channel), and a thread from a deleted
 * message with code 10008 (Unknown Message). With `{ keepOnLine: true }`, `deleteThread` does what Discord can do: the message keeps
 * the deleted thread, so a new thread from it is refused with code 160004, and a fetch of the thread with code 10003. `members` is the list that `members()` gives, as
 * src/discord.js maps it ({ id, name, roles, bot }, with role NAMES), and `roles` the guild's roles that `roles()` gives ({ id, name }).
 * SAMPLE DATA ONLY.
 * @param {{ id: string, name: string, roles: string[], bot?: boolean }[]} members
 * @param {{ id: string, name: string }[]} [roles]
 */
export function fakeDiscord(members, roles = []) {
  const messages = new Map();
  const posts = [];
  const where = new Map();
  const threads = new Map();
  const deleted = new Set();
  const kept = new Map(); // message id → the deleted thread that Discord keeps on it
  const gone = (target) => {
    if (deleted.has(target)) throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
  };
  let next = 900000000000000000n;
  const history = []; // the members' messages (said), for fetchAfter and fetchBefore
  const asRaw = (m) => ({ id: m.id, user: m.user, name: m.name, roles: m.roles, bot: m.bot, webhook: m.webhook, at: timeOf(m.id), text: m.content });
  const reads = [];
  const noHistory = new Map(); // place → the code of a refused read
  let seq = 0;
  const nonces = new Map(); // `<author> <place> <nonce>` → the id of the message that took it: Discord keeps a nonce per author (T244)
  const archived = (target, { edit = false } = {}) => {
    const t = threads.get(target);
    if (t?.locked || (edit && t?.archived)) throw Object.assign(new Error(t.locked ? 'Thread is locked' : 'Thread is archived'), { code: 50083, status: 400 });
    if (t) t.archived = false; // a post opens a quiet thread again
  };
  return {
    members: () => members,
    roles: () => roles,
    messages,
    posts,
    where,
    threads,
    /** The latest payload of a message. */
    latest: (id) => messages.get(id).at(-1),
    /** The id of the last message whose latest payload has a button of the gate `gateId` (a vote card), else undefined. */
    cardOf: (gateId) => [...messages].findLast(([, p]) => p.at(-1).components?.some((row) => row.components?.some((c) => parseCustomId(c.custom_id ?? '')?.gateId === gateId)))?.[0],
    /** The ids of the messages posted in one channel or thread, in order. */
    in: (target) => [...where].filter(([, t]) => t === target).map(([id]) => id),
    deleteThread: (id, { keepOnLine = false } = {}) => {
      if (keepOnLine) kept.set(threads.get(id).from, id);
      threads.delete(id);
      deleted.add(id);
    },
    deleteMessage: (id) => { messages.delete(id); where.delete(id); },
    /**
     * A message of a member at the time `at` (T241), with an id that holds that time as Discord's ids do: `{ user, name, roles, bot, webhook,
     * mentions, content, reply }`, where `mentions` says that it mentions sage-bot and `reply` is the id of the message it replies to. It
     * goes into `history`; nothing tells the bridge.
     */
    said: (place, { at, user, name = 'Sample member', roles = [], bot = false, webhook = false, mentions = true, content = '', reply = null }) => {
      const id = String(BigInt(idAt(at)) + BigInt(seq++));
      messages.set(id, [{ content }]);
      where.set(id, place);
      history.push({ id, place, user, name, roles, bot, webhook, mentions, content, reply });
      return id;
    },
    /** Edits the text of a message that `said` made, as its author can on Discord. */
    change: (id, content) => { history.find((m) => m.id === id).content = content; messages.get(id).push({ content }); },
    /**
     * Get Channel Messages with `before` (T247): at most `limit` (100) of the members' messages of `place` right before the id `before`,
     * newest first, as the context port of src/discord.js gives them: `{ id, user, name, roles, bot, webhook, at, text }`.
     */
    async fetchBefore(place, before, limit = 100) {
      gone(place);
      if (noHistory.has(place)) throw Object.assign(new Error('Missing Access'), { code: noHistory.get(place), status: 403 });
      return history.filter((m) => m.place === place && BigInt(m.id) < BigInt(before)).sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
        .slice(0, limit).map(asRaw);
    },
    /** The message that `said` made with this id, as the context port gives it, or null. */
    raw: (id) => { const m = history.find((x) => x.id === id); return m ? asRaw(m) : null; },
    /** The message that the message `id` replies to (its `reply` in `said`), as the context port gives it, or null. */
    repliedTo: (id) => { const to = history.find((x) => x.id === id)?.reply; const m = to && history.find((x) => x.id === to); return m ? asRaw(m) : null; },
    /** Makes each read of the history of `place` refuse with `code` (null: read again). */
    refuseHistory: (place, code) => { if (code === null) noHistory.delete(place); else noHistory.set(place, code); },
    /** The reads of history, each [place, after]. */
    reads,
    /**
     * Get Channel Messages with `after`: at most `limit` (100) of the members' messages of `place` right after the id `after`, newest
     * first, as Discord gives them.
     */
    async fetchAfter(place, after, limit = 100) {
      reads.push([place, after]);
      gone(place);
      if (noHistory.has(place)) throw Object.assign(new Error('Missing Access'), { code: noHistory.get(place), status: 403 });
      return history.filter((m) => m.place === place && BigInt(m.id) > BigInt(after)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .slice(0, limit).reverse().map((m) => ({ ...m }));
    },
    archive: (id) => { threads.get(id).archived = true; },
    async post(target, payload, by = 'sage-bot') {
      gone(target);
      archived(target);
      const once = payload.enforceNonce && payload.nonce !== undefined ? `${by} ${target} ${payload.nonce}` : null;
      if (nonces.has(once)) return nonces.get(once);
      const id = String(next++);
      if (once) nonces.set(once, id);
      messages.set(id, [structuredClone(payload)]);
      posts.push(structuredClone(payload));
      where.set(id, target);
      return id;
    },
    async edit(target, id, payload) {
      gone(target);
      if (where.get(id) !== target) throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
      archived(target, { edit: true });
      messages.get(id).push(structuredClone(payload));
    },
    async startThread(from, name) {
      if (!messages.has(from)) throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
      if (kept.has(from) || [...threads.values()].some((t) => t.from === from)) throw Object.assign(new Error('Cannot start a thread here'), { code: 160004, status: 400 });
      const id = String(next++);
      threads.set(id, { from, name, archived: false, locked: false });
      return id;
    },
    async threadFrom(from) {
      const found = [...threads].find(([, t]) => t.from === from);
      if (!found) throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
      return found[0];
    },
    async unarchive(id) {
      if (!threads.has(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
      if (threads.get(id).locked) throw Object.assign(new Error('Thread is locked'), { code: 50083, status: 400 });
      threads.get(id).archived = false;
    },
    async setLocked(id, locked) {
      if (!threads.has(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
      Object.assign(threads.get(id), { archived: locked, locked });
    },
  };
}

/**
 * A fake /sage command, as src/discord.js maps a real one for src/ask.js: `{ user: { id, bot }, roles, channelId, parentId, sub, options,
 * defer, edit }`. `parentId` is the parent channel of a thread, else null. `replies` records each call in order as `{ kind, ...payload }`,
 * kind 'defer', 'edit' (files as their names and sizes), 'remove', 'reply' (a private reply) or 'modal' (/sage request). `onDefer` runs
 * inside the defer, before it resolves: a test changes the project there to see that no work came before it. `name` is the member's
 * display name. SAMPLE DATA ONLY.
 * @param {{ user: string, name?: string, roles?: string[], bot?: boolean, channelId: string, parentId?: string | null, sub: string,
 *   options?: { project?: string, id?: string }, onDefer?: () => void }} o
 */
export function fakeCommand({ user, name = 'Sample member', roles = [], bot = false, channelId, parentId = null, sub, options = {}, onDefer }) {
  const replies = [];
  const record = (kind) => async ({ files, ...payload }) => {
    replies.push({ kind, ...structuredClone(payload), ...(files && { files: files.map((f) => ({ name: f.name, size: f.attachment.length })) }) });
    if (kind === 'defer') await onDefer?.();
  };
  return { user: { id: user, bot }, name, roles, channelId, parentId, sub, options, replies, defer: record('defer'), edit: record('edit'),
    remove: async () => { replies.push({ kind: 'remove' }); }, reply: record('reply'), showModal: record('modal') };
}

/**
 * The context port of a message `id` in `channelId` on the fake Discord `place`, as src/discord.js contextPort gives it: `history`,
 * `replied` (the message that it replies to: its `reply` in `said`), `open`, `post` and `startThread`. `refuse` makes Discord refuse one call with a code, for example `{ startThread: 50013 }`
 * (Missing Permissions) or `{ history: 50001 }`.
 */
function fakePort(place, id, channelId, refuse) {
  const no = (call) => { if (refuse[call]) throw Object.assign(new Error('Missing Permissions'), { code: refuse[call], status: 403 }); };
  return {
    history: async (before) => { no('history'); return place.fetchBefore(channelId, before); },
    replied: async () => place.repliedTo(id),
    open: async (channel, payload, name) => { no('open'); return place.startThread(await place.post(channel, payload), name); },
    post: async (at, payload) => { no('post'); return place.post(at, payload); },
    startThread: async (name) => { no('startThread'); return place.startThread(id, name); },
  };
}

/**
 * A fake message that mentions the bot, as src/discord.js maps a real one: `{ id, user: { id, bot }, name, roles, channelId, parentId,
 * content, reply, startThread, post, open, history, replied }`. `replies` records the replies in place. The threads and their posts go to
 * `place`, a fakeDiscord (a new one when none is given): the message is posted in its channel there first, so `startThread` opens a thread
 * from it. `refuse` makes Discord refuse one call with a code (fakePort). `id` is a message that `said` made in `place` already (the
 * catch-up gives it to the mention path; its `reply` is the message that `replied` gives). SAMPLE DATA ONLY.
 */
export function fakeMention({ user, name = 'Sample member', roles = [], bot = false, channelId, parentId = null, content = '', place = fakeDiscord([]), refuse = {}, id: had }) {
  const replies = [];
  const id = had ?? String(800000000000000000n + BigInt(place.messages.size));
  if (!had) {
    place.messages.set(id, [{ content }]);
    place.where.set(id, channelId);
  }
  return { id, user: { id: user, bot }, name, roles, channelId, parentId, content, replies, place,
    ...fakePort(place, id, channelId, refuse),
    reply: async (payload) => { if (refuse.reply) throw Object.assign(new Error('Missing Permissions'), { code: refuse.reply, status: 403 }); replies.push(structuredClone(payload)); } };
}

/**
 * A fake "Send to sage" message command (T247) on the message `target` that `said` made in `place`, as src/discord.js sendOf maps a real
 * one: `{ user, name, roles, channelId, parentId, target, defer, edit, reply }` and the context port of the target. `replies` records each
 * answer as `{ kind, ...payload }`, kind 'reply', 'defer' or 'edit'. SAMPLE DATA ONLY.
 */
export function fakeSend({ user, name = 'Sample member', roles = [], bot = false, channelId, parentId = null, target, place, refuse = {} }) {
  const replies = [];
  const record = (kind) => async (payload = {}) => { replies.push(structuredClone({ kind, ...payload })); };
  const t = place.raw(target);
  return { user: { id: user, bot }, name, roles, channelId, parentId, replies,
    target: { ...t, user: { id: t.user }, content: t.text },
    defer: record('defer'), edit: record('edit'), reply: record('reply'),
    ...fakePort(place, target, channelId, refuse) };
}

/**
 * A fake discord.js Client for the servers of a bot (C4): `guilds.cache` holds the servers that it is in at the start (`ids`), and
 * `join(id)` adds one and emits GuildCreate, as Discord does when someone adds the bot. Each server's `leave()` takes it out of the
 * cache and records it in `left`; with `refuse` (a code), the leave of that server is refused. SAMPLE DATA ONLY.
 */
export function fakeGuilds(ids, { refuse = {} } = {}) {
  const client = new EventEmitter();
  const left = [];
  const guild = (id) => ({ id, name: `server ${id.slice(-2)}`, leave: async () => {
    if (refuse[id]) throw Object.assign(new Error('Missing Access'), { code: refuse[id], status: 403 });
    client.guilds.cache.delete(id);
    left.push(id);
  } });
  return Object.assign(client, {
    guilds: { cache: new Map(ids.map((id) => [id, guild(id)])) },
    left,
    join: (id) => { const g = guild(id); client.guilds.cache.set(id, g); client.emit(Events.GuildCreate, g); },
  });
}

/**
 * A fake gateway (T241): an EventEmitter that emits the discord.js events of a connection: `drop()` (shardDisconnect), `reconnecting()`,
 * `ready()` (shardReady: a new session) and `resume()` (shardResume: the old session goes on, with no restart). SAMPLE DATA ONLY.
 */
export function fakeGateway() {
  const g = new EventEmitter();
  return Object.assign(g, {
    drop: () => g.emit(Events.ShardDisconnect, { code: 1006 }, 0),
    reconnecting: () => g.emit(Events.ShardReconnecting, 0),
    ready: () => g.emit(Events.ShardReady, 0, new Set()),
    resume: () => g.emit(Events.ShardResume, 0, 3),
  });
}
