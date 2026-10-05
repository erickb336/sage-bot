// From a Discord interaction (a button press or a modal submit) through the vote rules to the reply.
// `by` is always the interaction's user id, `via` is always 'discord', and `at` comes from the injected clock:
// nothing in the interaction's data chooses them. The custom_id holds indexes only; the option is read from the gate.
import { MessageFlags } from 'discord.js';
import { step } from './vote.js';
import { card, confirmEnd, ephemeral, note, parseCustomId, reasonModal, stamp } from './cards.js';

/**
 * Who may answer and vote, from the guild members and the role ids of the config. A holder has the sage-apprentice or the
 * sage-lead role, and a lead the sage-lead role, so a lead is always a holder (T70). Nobody else counts, also not the owner
 * (F-T27-12). A bot (discord.js `member.user.bot`) is neither.
 * @param {Iterable<{ id: string, name: string, roles: string[], bot?: boolean }>} members
 * @param {{ apprenticeRole: string, leadRole: string }} config
 * @returns {{ holders: Set<string>, leads: Set<string>, names: Map<string, string> }}
 */
export function peopleOf(members, { apprenticeRole, leadRole }) {
  const holders = new Set();
  const leads = new Set();
  const names = new Map();
  for (const m of members) {
    names.set(m.id, m.name);
    if (m.bot) continue;
    const lead = m.roles.includes(leadRole);
    if (lead) leads.add(m.id);
    if (lead || m.roles.includes(apprenticeRole)) holders.add(m.id);
  }
  return { holders, leads, names };
}

/** The text of a modal field, or undefined when the interaction has no fields or no such field (discord.js throws then). */
function fieldOf(interaction, id) {
  try { return interaction.fields.getTextInputValue(id); } catch { return undefined; }
}

/**
 * Handle one interaction. `gates` maps a gate id to `{ gate, ask }`; the handler sets the new gate there.
 * It answers the interaction (an updated card, a modal, a confirm or a private note) and returns `{ gate, effects, stored }`:
 * `gate` is the gate after the event (null for an unknown gate), `effects` are the vote rules' effects, and `stored` is true
 * when the event changed the gate and the new gate is in `gates` (a press that counts gives `effects: []` and `stored: true`).
 * The caller (B3) acts on a `closed` effect, and edits the card message when the gate changed but the reply
 * was not the card: after "End vote now", or when a reason modal was dismissed.
 * The reply is built before the new gate is stored, so a reply that cannot be built leaves the gate as it was.
 * When Discord refuses the reply (an unknown interaction, a network error), `handle` never rejects: the result also has
 * `replyError`, beside the gate, the effects and `stored` as they are after the store (F-T27-20, F-T27-28, F-T27-37). With
 * `stored: false` nothing changed. `handle` rejects only for a programming error: a wrong `interaction`
 * (no `user`, no `reply`) or `ctx` (no `gates`, `people` or `clock`), or `card`'s RangeError for an ask of more than 4 parts.
 * @param {{ user: { id: string }, customId: string, message?: { flags: { has(flag: number): boolean } },
 *   fields?: { getTextInputValue(id: string): string },
 *   reply(o: object): Promise<unknown>, update(o: object): Promise<unknown>, showModal(o: object): Promise<unknown> }} interaction
 * @param {{ gates: Map<string, { gate: import('./vote.js').Gate, ask: object }>, people: ReturnType<typeof peopleOf>, clock: () => number }} ctx
 */
export async function handle(interaction, ctx) {
  const { send, payload, ...result } = decide(interaction, ctx);
  try { await send.call(interaction, payload); } catch (replyError) { return { ...result, replyError }; }
  return result;
}

/** The reply to one interaction (`send` and its `payload`) and the result of `handle` (`gate`, `effects`, `stored`), with the new gate stored in `gates`. */
function decide(interaction, { gates, people, clock }) {
  const reply = (payload, gate, effects = []) => ({ send: interaction.reply, payload, gate, effects, stored: false });
  const update = (payload, gate, effects = []) => ({ send: interaction.update, payload, gate, effects, stored: false });
  const id = parseCustomId(interaction.customId);
  const entry = id && gates.get(id.gateId);
  const { action, part, index } = id ?? {};
  // "End vote now" and "Cancel" exist only on the lead's private confirm: a press from any other message is unknown (F-T27-14).
  const fromConfirm = interaction.message?.flags.has(MessageFlags.Ephemeral) === true;
  if (!entry || ((action === 'end!' || action === 'cancel') && !fromConfirm)) return reply(note('unknown-gate'), entry?.gate ?? null);
  const { gate, ask } = entry;
  const by = interaction.user.id;
  if (action === 'cancel') {
    // A confirm exists only for a batch vote; after the vote ended, the cancel says so instead of "The vote goes on" (F-T27-21, F-T27-29).
    const text = gate.kind === 'single' ? note('wrong-kind') : gate.phase === 'voting' ? ephemeral('Cancelled. The vote goes on.')
      : gate.outcome.status === 'withdrawn' ? note('closed', gate, people.names)
      : ephemeral(`The vote on ${gate.id} ended at ${stamp(gate.votingEndedAt)} meanwhile. Nothing to cancel.`);
    return update({ ...text, components: [] }, gate);
  }
  // The option comes from the gate, never from the custom_id: a forged part or index is refused here.
  const options = part === undefined ? [] : gate.kind === 'single' ? (part === 0 ? gate.options : undefined) : gate.parts[part]?.options;
  const option = options?.[index];
  if (part !== undefined && option === undefined) return reply(note(options ? 'unknown-option' : 'unknown-part', gate, people.names), gate);
  const reason = action === 'reason' ? fieldOf(interaction, 'reason') : undefined;
  if (action === 'reason' && reason === undefined) return reply(note('bad-event', gate, people.names), gate);
  const base = { by, at: clock(), via: 'discord' };
  const event = action === 'end' || action === 'end!' ? { type: 'end', ...base }
    : action === 'tiebreak' ? { type: 'tiebreak', ...base, part, option }
    : { type: 'press', ...base, option, ...(gate.kind === 'batch' && { part }), ...(reason !== undefined && { reason }) };
  // A leads-only question (T73) has the sage-leads as its only holders: anyone else gets the leads-only note.
  const out = step(gate, event, ask.leads ? people.leads : people.holders, people.leads);
  const refused = out.effects.find((e) => e.type === 'ignored');
  // "End vote now" asks first: the end runs through the vote rules only to find a refusal (not a lead, ended, closed, withdrawn,
  // or past the time limit by the clock), and the confirm shows only when the end would count (F-T27-13).
  if (action === 'end' && !refused) return reply(confirmEnd(gate, people), gate);
  const result = refused ? reply(note(refused.why === 'not-holder' && ask.leads ? 'leads-only' : refused.why, out.gate, people.names), out.gate, out.effects)
    : action === 'end!' ? update({ ...ephemeral(`You ended the vote on ${gate.id} at ${stamp(base.at)}.`), components: [] }, out.gate, out.effects)
    : action === 'press' && gate.kind === 'batch' ? { send: interaction.showModal, payload: reasonModal(out.gate, ask, part, index), gate: out.gate, effects: out.effects } // the vote counts already
    : update(card(out.gate, ask, people), out.gate, out.effects);
  // `stored`: the vote rules changed the gate and the new gate is in `gates` (F-T27-37). An ignored event leaves the same gate.
  gates.set(id.gateId, { gate: out.gate, ask });
  return { ...result, stored: out.gate !== gate };
}
