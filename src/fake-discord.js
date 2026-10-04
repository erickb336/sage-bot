// A fake Discord interaction for the tests and the preview: the shape that `handle` reads, and a record of
// every reply. No Client, no login, no network, no token. SAMPLE DATA ONLY.

/**
 * An interaction-like object. `replies` records each answer as `{ kind, ...payload }`,
 * with kind 'reply' (a message, private when its flags say so), 'update' (the message with the buttons) or 'modal'.
 * @param {{ user: string, customId: string, fields?: Record<string, string> }} o  `fields` are the modal's inputs by custom_id.
 */
export function fakeInteraction({ user, customId, fields = {} }) {
  const replies = [];
  const record = (kind) => async (payload) => { replies.push(structuredClone({ kind, ...payload })); };
  return {
    user: { id: user },
    customId,
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    replies,
    reply: record('reply'),
    update: record('update'),
    showModal: record('modal'),
  };
}
