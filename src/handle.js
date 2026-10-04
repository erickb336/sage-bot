// From a Discord interaction (a button press or a modal submit) through the vote rules to the reply.
// `by` is always the interaction's user id, `via` is always 'discord', and `at` comes from the injected clock:
// nothing in the interaction's data chooses them. The custom_id holds indexes only; the option is read from the gate.
import { step } from './vote.js';
import { card, confirmEnd, ephemeral, note, parseCustomId, reasonModal, stamp } from './cards.js';

/**
 * Who may answer and vote, from the guild members and the role ids of the config. The owner is always a holder.
 * @param {Iterable<{ id: string, name: string, roles: string[] }>} members
 * @param {{ driverRole: string, leadRole: string, ownerId: string }} config
 * @returns {{ holders: Set<string>, leads: Set<string>, names: Map<string, string> }}
 */
export function peopleOf(members, { driverRole, leadRole, ownerId }) {
  const holders = new Set([ownerId]);
  const leads = new Set();
  const names = new Map();
  for (const m of members) {
    names.set(m.id, m.name);
    if (m.roles.includes(driverRole)) holders.add(m.id);
    if (m.roles.includes(leadRole)) leads.add(m.id);
  }
  return { holders, leads, names };
}

/**
 * Handle one interaction. `gates` maps a gate id to `{ gate, ask }`; the handler sets the new gate there.
 * It answers the interaction (an updated card, a modal, a confirm or a private note) and returns `{ gate, effects }`:
 * `gate` is the gate after the event (null for an unknown gate) and `effects` are the vote rules' effects.
 * The caller (B3) acts on a `closed` effect, and edits the card message when the gate changed but the reply
 * was not the card: after "End vote now", or when a reason modal was dismissed.
 * @param {{ user: { id: string }, customId: string, fields?: { getTextInputValue(id: string): string },
 *   reply(o: object): Promise<unknown>, update(o: object): Promise<unknown>, showModal(o: object): Promise<unknown> }} interaction
 * @param {{ gates: Map<string, { gate: import('./vote.js').Gate, ask: object }>, people: ReturnType<typeof peopleOf>, clock: () => number }} ctx
 */
export async function handle(interaction, { gates, people, clock }) {
  const id = parseCustomId(interaction.customId);
  const entry = id && gates.get(id.gateId);
  if (!entry) {
    await interaction.reply(note('unknown-gate'));
    return { gate: null, effects: [] };
  }
  const { gate, ask } = entry;
  const by = interaction.user.id;
  const { action, part, index } = id;
  if (action === 'cancel') {
    await interaction.update({ ...ephemeral('Cancelled. The vote goes on.'), components: [] });
    return { gate, effects: [] };
  }
  if (action === 'end') {
    // The confirm is for a lead who is a holder; the vote rules check again when the lead confirms.
    const why = !people.holders.has(by) ? 'not-holder' : !people.leads.has(by) ? 'not-lead' : gate.kind !== 'batch' ? 'wrong-kind' : null;
    await interaction.reply(why ? note(why, gate, people.names) : confirmEnd(gate, people));
    return { gate, effects: [] };
  }
  // The option comes from the gate, never from the custom_id: a forged part or index is refused here.
  const options = part === undefined ? [] : gate.kind === 'single' ? (part === 0 ? gate.options : undefined) : gate.parts[part]?.options;
  const option = options?.[index];
  if (part !== undefined && option === undefined) {
    await interaction.reply(note(options ? 'unknown-option' : 'unknown-part', gate, people.names));
    return { gate, effects: [] };
  }
  const base = { by, at: clock(), via: 'discord' };
  const event = action === 'end!' ? { type: 'end', ...base }
    : action === 'tiebreak' ? { type: 'tiebreak', ...base, part, option }
    : { type: 'press', ...base, option, ...(gate.kind === 'batch' && { part }), ...(action === 'reason' && { reason: interaction.fields.getTextInputValue('reason') }) };
  const out = step(gate, event, people.holders, people.leads);
  gates.set(id.gateId, { gate: out.gate, ask });
  const refused = out.effects.find((e) => e.type === 'ignored');
  if (refused) await interaction.reply(note(refused.why, out.gate, people.names));
  else if (action === 'end!') await interaction.update({ ...ephemeral(`You ended the vote on ${gate.id} at ${stamp(base.at)}.`), components: [] });
  else if (action === 'press' && gate.kind === 'batch') await interaction.showModal(reasonModal(out.gate, ask, part, index)); // the vote counts already
  else await interaction.update(card(out.gate, ask, people));
  return { gate: out.gate, effects: out.effects };
}
