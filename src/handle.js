// From a Discord interaction (a button press or a modal submit) through the vote rules to the reply.
// `by` is always the interaction's user id, `via` is always 'discord', and `at` comes from the injected clock:
// nothing in the interaction's data chooses them. The custom_id holds indexes only; the option is read from the gate.
import { MessageFlags } from 'discord.js';
import { step } from './vote.js';
import { card, confirmEnd, ephemeral, note, parseCustomId, reasonModal, stamp } from './cards.js';

/**
 * Who may answer and vote, from the guild members and the role ids of the config. A holder has the sage-driver role
 * and a lead the sage-lead role; nobody else, also not the owner (F-T27-12). A bot (discord.js `member.user.bot`) is neither.
 * @param {Iterable<{ id: string, name: string, roles: string[], bot?: boolean }>} members
 * @param {{ driverRole: string, leadRole: string }} config
 * @returns {{ holders: Set<string>, leads: Set<string>, names: Map<string, string> }}
 */
export function peopleOf(members, { driverRole, leadRole }) {
  const holders = new Set();
  const leads = new Set();
  const names = new Map();
  for (const m of members) {
    names.set(m.id, m.name);
    if (m.bot) continue;
    if (m.roles.includes(driverRole)) holders.add(m.id);
    if (m.roles.includes(leadRole)) leads.add(m.id);
  }
  return { holders, leads, names };
}

/** The text of a modal field, or undefined when the interaction has no fields or no such field (discord.js throws then). */
function fieldOf(interaction, id) {
  try { return interaction.fields.getTextInputValue(id); } catch { return undefined; }
}

/**
 * Handle one interaction. `gates` maps a gate id to `{ gate, ask }`; the handler sets the new gate there.
 * It answers the interaction (an updated card, a modal, a confirm or a private note) and returns `{ gate, effects }`:
 * `gate` is the gate after the event (null for an unknown gate) and `effects` are the vote rules' effects.
 * The caller (B3) acts on a `closed` effect, and edits the card message when the gate changed but the reply
 * was not the card: after "End vote now", or when a reason modal was dismissed.
 * The reply is built before the new gate is stored, so a reply that cannot be built leaves the gate as it was.
 * @param {{ user: { id: string }, customId: string, message?: { flags: { has(flag: number): boolean } },
 *   fields?: { getTextInputValue(id: string): string },
 *   reply(o: object): Promise<unknown>, update(o: object): Promise<unknown>, showModal(o: object): Promise<unknown> }} interaction
 * @param {{ gates: Map<string, { gate: import('./vote.js').Gate, ask: object }>, people: ReturnType<typeof peopleOf>, clock: () => number }} ctx
 */
export async function handle(interaction, { gates, people, clock }) {
  const id = parseCustomId(interaction.customId);
  const entry = id && gates.get(id.gateId);
  const { action, part, index } = id ?? {};
  // "End vote now" and "Cancel" exist only on the lead's private confirm: a press from any other message is unknown (F-T27-14).
  const fromConfirm = interaction.message?.flags.has(MessageFlags.Ephemeral) === true;
  if (!entry || ((action === 'end!' || action === 'cancel') && !fromConfirm)) {
    await interaction.reply(note('unknown-gate'));
    return { gate: entry?.gate ?? null, effects: [] };
  }
  const { gate, ask } = entry;
  const by = interaction.user.id;
  if (action === 'cancel') {
    await interaction.update({ ...ephemeral('Cancelled. The vote goes on.'), components: [] });
    return { gate, effects: [] };
  }
  // The option comes from the gate, never from the custom_id: a forged part or index is refused here.
  const options = part === undefined ? [] : gate.kind === 'single' ? (part === 0 ? gate.options : undefined) : gate.parts[part]?.options;
  const option = options?.[index];
  if (part !== undefined && option === undefined) {
    await interaction.reply(note(options ? 'unknown-option' : 'unknown-part', gate, people.names));
    return { gate, effects: [] };
  }
  const reason = action === 'reason' ? fieldOf(interaction, 'reason') : undefined;
  if (action === 'reason' && reason === undefined) {
    await interaction.reply(note('bad-event', gate, people.names));
    return { gate, effects: [] };
  }
  const base = { by, at: clock(), via: 'discord' };
  const event = action === 'end' || action === 'end!' ? { type: 'end', ...base }
    : action === 'tiebreak' ? { type: 'tiebreak', ...base, part, option }
    : { type: 'press', ...base, option, ...(gate.kind === 'batch' && { part }), ...(reason !== undefined && { reason }) };
  const out = step(gate, event, people.holders, people.leads);
  const refused = out.effects.find((e) => e.type === 'ignored');
  // "End vote now" asks first: the end runs through the vote rules only to find a refusal (not a lead, ended, closed, withdrawn,
  // or past the time limit by the clock), and the confirm shows only when the end would count (F-T27-13).
  if (action === 'end' && !refused) {
    await interaction.reply(confirmEnd(gate, people));
    return { gate, effects: [] };
  }
  const [send, payload] = refused ? [interaction.reply, note(refused.why, out.gate, people.names)]
    : action === 'end!' ? [interaction.update, { ...ephemeral(`You ended the vote on ${gate.id} at ${stamp(base.at)}.`), components: [] }]
    : action === 'press' && gate.kind === 'batch' ? [interaction.showModal, reasonModal(out.gate, ask, part, index)] // the vote counts already
    : [interaction.update, card(out.gate, ask, people)];
  gates.set(id.gateId, { gate: out.gate, ask });
  await send.call(interaction, payload);
  return { gate: out.gate, effects: out.effects };
}
