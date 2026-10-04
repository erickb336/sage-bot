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
 * A fake channel and guild for the bridge (src/bridge.js): the port `{ post, edit, members }` with a record of every message.
 * `messages` maps a message id to its payloads, the first one posted and each edit after it; `posts` lists the posted payloads
 * in order. `members` is the list that `members()` gives, as src/discord.js maps it ({ id, name, roles, bot }). SAMPLE DATA ONLY.
 * @param {{ id: string, name: string, roles: string[], bot?: boolean }[]} members
 */
export function fakeDiscord(members) {
  const messages = new Map();
  const posts = [];
  let next = 900000000000000000n;
  return {
    members: () => members,
    messages,
    posts,
    /** The latest payload of a message. */
    latest: (id) => messages.get(id).at(-1),
    async post(payload) {
      const id = String(next++);
      messages.set(id, [structuredClone(payload)]);
      posts.push(structuredClone(payload));
      return id;
    },
    async edit(id, payload) {
      if (!messages.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
      messages.get(id).push(structuredClone(payload));
    },
  };
}
