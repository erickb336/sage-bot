// A fake Discord interaction for the tests and the preview: the shape that `handle` reads, and a record of
// every reply. No Client, no login, no network, no token. SAMPLE DATA ONLY.
import { MessageFlags, MessageFlagsBitField } from 'discord.js';

/**
 * An interaction-like object. `replies` records each answer as `{ kind, ...payload }`,
 * with kind 'reply' (a message, private when its flags say so), 'update' (the message with the buttons) or 'modal'.
 * @param {{ user: string, customId: string, fields?: Record<string, string>, ephemeral?: boolean }} o
 *   `fields` are the modal's inputs by custom_id; a button press has none. `ephemeral` says that the pressed message
 *   was private (the lead's confirm), as discord.js shows it in `interaction.message.flags`.
 */
export function fakeInteraction({ user, customId, fields, ephemeral = false }) {
  const replies = [];
  const record = (kind) => async (payload) => { replies.push(structuredClone({ kind, ...payload })); };
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
