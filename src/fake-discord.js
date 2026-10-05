// A fake Discord interaction for the tests and the preview: the shape that `handle` reads, and a record of
// every reply. No Client, no login, no network, no token. SAMPLE DATA ONLY.
import { MessageFlags, MessageFlagsBitField } from 'discord.js';

/**
 * An interaction-like object. `replies` records each answer as `{ kind, ...payload }`,
 * with kind 'reply' (a message, private when its flags say so), 'update' (the message with the buttons) or 'modal'.
 * @param {{ user: string, customId: string, fields?: Record<string, string>, ephemeral?: boolean, refuse?: Error }} o
 *   `fields` are the modal's inputs by custom_id; a button press has none. `ephemeral` says that the pressed message
 *   was private (the lead's confirm), as discord.js shows it in `interaction.message.flags`. With `refuse`, every
 *   reply rejects with that error and records nothing, as Discord does for an unknown interaction (F-T27-20).
 */
export function fakeInteraction({ user, customId, fields, ephemeral = false, refuse }) {
  const replies = [];
  const record = (kind) => async (payload) => { if (refuse) throw refuse; replies.push(structuredClone({ kind, ...payload })); };
  return {
    user: { id: user },
    customId,
    message: { flags: new MessageFlagsBitField(ephemeral ? MessageFlags.Ephemeral : 0) },
    // Like discord.js: a missing field throws, and a button press has no `fields` at all.
    ...(fields && { fields: { getTextInputValue: (id) => {
      if (!(id in fields)) throw new TypeError(`Required field with custom id "${id}" not found.`);
      return fields[id];
    } } }),
    replies,
    reply: record('reply'),
    update: record('update'),
    showModal: record('modal'),
  };
}

/**
 * A fake channel, its threads and the guild for the bridge (src/bridge.js): the port `{ post, edit, startThread, threadFrom, setLocked, members }`
 * with a record of every message. `messages` maps a message id to its payloads, the first one posted and each edit after it; `posts`
 * lists the posted payloads in order, and `where` maps a message id to the channel or thread it was posted in. `threads` maps a thread
 * id to { from, name, archived, locked }, where `from` is the message the thread started from. Like Discord, a post or an edit in a
 * locked thread is refused, and so is an edit of a message in another place. `deleteThread` and `deleteMessage` do what a member's delete
 * in Discord does: a post, edit or lock in a deleted thread is refused with code 10003 (Unknown Channel), and a thread from a deleted
 * message with code 10008 (Unknown Message). With `{ keepOnLine: true }`, `deleteThread` does what Discord can do: the message keeps
 * the deleted thread, so a new thread from it is refused with code 160004, and a fetch of the thread with code 10003. `members` is the list that `members()` gives, as
 * src/discord.js maps it ({ id, name, roles, bot }). SAMPLE DATA ONLY.
 * @param {{ id: string, name: string, roles: string[], bot?: boolean }[]} members
 */
export function fakeDiscord(members) {
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
  const archived = (target) => {
    if (threads.get(target)?.locked) throw Object.assign(new Error('Thread is locked'), { code: 50083, status: 400 });
  };
  return {
    members: () => members,
    messages,
    posts,
    where,
    threads,
    /** The latest payload of a message. */
    latest: (id) => messages.get(id).at(-1),
    /** The ids of the messages posted in one channel or thread, in order. */
    in: (target) => [...where].filter(([, t]) => t === target).map(([id]) => id),
    deleteThread: (id, { keepOnLine = false } = {}) => {
      if (keepOnLine) kept.set(threads.get(id).from, id);
      threads.delete(id);
      deleted.add(id);
    },
    deleteMessage: (id) => { messages.delete(id); where.delete(id); },
    async post(target, payload) {
      gone(target);
      archived(target);
      const id = String(next++);
      messages.set(id, [structuredClone(payload)]);
      posts.push(structuredClone(payload));
      where.set(id, target);
      return id;
    },
    async edit(target, id, payload) {
      gone(target);
      if (where.get(id) !== target) throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
      archived(target);
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
    async setLocked(id, locked) {
      if (!threads.has(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
      Object.assign(threads.get(id), { archived: locked, locked });
    },
  };
}

/**
 * A fake /sage command, as src/discord.js maps a real one for src/ask.js: `{ user: { id, bot }, roles, channelId, sub, options, reply }`.
 * `replies` records each reply payload (files as their names and sizes). SAMPLE DATA ONLY.
 * @param {{ user: string, roles?: string[], bot?: boolean, channelId: string, sub: string, options?: { project?: string, id?: string } }} o
 */
export function fakeCommand({ user, roles = [], bot = false, channelId, sub, options = {} }) {
  const replies = [];
  const reply = async ({ files, ...payload }) => {
    replies.push({ ...structuredClone(payload), ...(files && { files: files.map((f) => ({ name: f.name, size: f.attachment.length })) }) });
  };
  return { user: { id: user, bot }, roles, channelId, sub, options, replies, reply };
}

/** A fake message that mentions the bot, as src/discord.js maps a real one: `{ user: { id, bot }, channelId, content, reply }`. SAMPLE DATA ONLY. */
export function fakeMention({ user, bot = false, channelId, content = '' }) {
  const replies = [];
  return { user: { id: user, bot }, channelId, content, replies, reply: async (payload) => { replies.push(structuredClone(payload)); } };
}
