// The cards, the reason modal, the end-vote confirm and the private notes of the sage bridge,
// as the JSON that Discord takes (discord.js builders). Pure functions of a gate, its ask and the people.
// No Client, no network. The names and the ballot reasons are untrusted text: `safe` makes them inert.
// Times are Discord timestamps (<t:…:t>), so each viewer's Discord shows them in the viewer's own zone,
// and the 30-minute countdown (<t:…:R>) runs live with no edit of the card.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder,
  TextInputBuilder, TextInputStyle, embedLength, escapeMarkdown,
} from 'discord.js';
import { ballotsOf, REASON_MAX } from './vote.js';

export const DRIVER = 'sage-driver';
export const LEAD = 'sage-lead';
/** On every message: no mention pings anyone, whatever a reason or a name holds. */
export const NO_MENTIONS = { parse: [] };
const COLOR = { open: 0x6b4fd8, tied: 0xc77700, decided: 0x2e8b57, withdrawn: 0x8a8a8a };
// Not `maskedLink`: it escapes only the first link. `safe` escapes every `[` and `]` itself (F-T27-8).
const ESCAPE_ALL = Object.fromEntries(['codeBlock', 'inlineCode', 'bold', 'italic', 'underline', 'strikethrough', 'spoiler',
  'codeBlockContent', 'inlineCodeContent', 'escape', 'heading', 'bulletedList', 'numberedList'].map((k) => [k, true]));
/** Discord's limits on one embed. A reason shows on the card cut to REASON_ON_CARD characters; the gate keeps the full text. */
const EMBED_MAX = 6000;
const FIELDS_MAX = 25;
const REASON_ON_CARD = 200;

/**
 * Untrusted text as one inert line: format characters (zero-width, bidi controls) removed (F-T27-11), markdown and
 * every `[` and `]` escaped (no masked link), `<` escaped (no mention, timestamp or emoji code), whitespace folded.
 */
export const safe = (text) => escapeMarkdown(String(text).replace(/\p{Cf}/gu, ''), ESCAPE_ALL)
  .replace(/[<[\]]/g, '\\$&').replace(/\s+/g, ' ').trim();
/** `text` cut to `max` characters, the last one "…"; a cut never leaves half of a surrogate pair. */
const cut = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '')}…`;
/** A Discord timestamp: `t` shows hh:mm in the viewer's zone; `R` shows a live countdown ("in 18 minutes"). */
export const stamp = (ms, style = 't') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const who = (id, names) => safe(names.get(id) ?? id);
const label = (p, key) => p.options[key] ?? key;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The custom_id of a button or modal: the action, the gate id and, for an option, the part and option indexes. Never the option text. */
export const customId = (action, gateId, part, index) => [action, gateId, part, index].filter((x) => x !== undefined).join(':');
/** The parts of a custom_id, or null for anything else. A gate id may hold ':'; the indexes are digits only. */
export function parseCustomId(text) {
  const m = /^(press|reason|tiebreak):(.+):(\d+):(\d+)$/.exec(text) ?? /^(end|end!|cancel):(.+)$/.exec(text);
  return m ? { action: m[1], gateId: m[2], ...(m[3] !== undefined && { part: Number(m[3]), index: Number(m[4]) }) } : null;
}

/** A private note to the person who pressed. */
export const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });

/** The ballots that count on a part, by option: option → the holder ids that chose it. */
function tally(part, holders) {
  const by = new Map(part.options.map((o) => [o, []]));
  for (const [id, b] of ballotsOf(part)) if (holders.has(id)) by.get(b.option).push(id);
  return by;
}
const leaders = (counts) => {
  const top = Math.max(...[...counts.values()].map((ids) => ids.length));
  return { top, tied: [...counts].filter(([, ids]) => ids.length === top).map(([o]) => o) };
};

/**
 * The card of a gate: `{ embeds, components, allowedMentions }`.
 * @param {import('./vote.js').Gate} gate
 * @param {{ task: string, title: string, parts: { question: string, why: string, recommended: string, default?: string, options: Record<string, string> }[] }} ask
 * @param {{ holders: Set<string>, names: Map<string, string> }} people
 */
export function card(gate, ask, { holders, names }) {
  const closed = gate.phase === 'closed';
  const withdrawn = gate.outcome.status === 'withdrawn';
  const built = gate.kind === 'single' ? single(gate, ask, names) : batch(gate, ask, holders, names);
  const color = withdrawn ? COLOR.withdrawn : closed ? COLOR.decided : gate.phase === 'tied' ? COLOR.tied : COLOR.open;
  if (built.rows.length > 5) throw new RangeError('card: Discord allows 5 rows of buttons on one message');
  return { embeds: [built.embed.setColor(color).toJSON()], components: built.rows.map((r) => r.toJSON()), allowedMentions: NO_MENTIONS };
}

const button = (id, text, style, { chosen = false, disabled = false } = {}) => new ButtonBuilder().setCustomId(id)
  .setLabel(cut(text, 80)).setStyle(chosen ? ButtonStyle.Success : style).setDisabled(disabled);
const optionLine = (p, key, extra) => `**${key}.** ${label(p, key)}${key === p.recommended ? ' · Recommended' : ''}${extra}`;

function single(gate, ask, names) {
  const [p] = ask.parts;
  const o = gate.outcome;
  const status = o.status === 'answered'
    ? `**Answered by ${who(o.by, names)}${o.via === 'terminal' ? ' (terminal)' : ''} at ${stamp(gate.lastAt)}: ${o.option}. ${label(p, o.option)}. Final.**`
    : o.status === 'withdrawn' ? `**Withdrawn by ${who(gate.askedBy, names)} at ${stamp(gate.lastAt)}.** Nothing to answer.` : '';
  const embed = new EmbedBuilder().setTitle(`Question ${gate.id} · ${ask.task} ${ask.title}`).setDescription([
    `**${p.question}**`, '',
    ...gate.options.map((k) => optionLine(p, k, k === p.default ? ' · Default' : '')), '',
    `**Why recommended:** ${p.why}`,
    ...(p.default ? [`**Default:** ${label(p, p.default)}, but no time-out applies it`] : []),
    '**Rule:** the first answer is final · reminder every 2 h until answered',
    `**Who can answer:** every ${DRIVER}`,
    ...(status ? ['', status] : []),
  ].join('\n'));
  const row = new ActionRowBuilder().addComponents(gate.options.map((k, i) => button(customId('press', gate.id, 0, i), `${k}. ${label(p, k)}`,
    k === p.recommended ? ButtonStyle.Primary : ButtonStyle.Secondary, { chosen: o.option === k, disabled: gate.phase === 'closed' })));
  return { embed, rows: [row] };
}

function batch(gate, ask, holders, names) {
  const voting = gate.phase === 'voting';
  const withdrawn = gate.outcome.status === 'withdrawn';
  const tiedParts = gate.phase === 'tied' ? gate.parts.filter((part) => part.outcome.status === 'open').length : 0;
  const rows = [];
  const reasons = [];
  const fields = gate.parts.map((part, i) => {
    const p = ask.parts[i];
    const n = i + 1;
    const counts = tally(part, holders);
    const { top, tied } = leaders(counts);
    const ballots = ballotsOf(part);
    const voted = [...ballots].filter(([id]) => holders.has(id));
    for (const [id, b] of voted) if (b.reason) reasons.push({ name: `${who(id, names)}, part ${n}`, value: safe(b.reason), at: b.at });
    const named = (ids) => ids.map((id) => who(id, names) + (ballots.get(id)?.via === 'terminal' ? ' (terminal)' : '')).join(', ');
    const notYet = [...holders].filter((id) => !ballots.has(id));
    const o = part.outcome;
    const state = withdrawn ? ''
      : o.status === 'decided' ? `**${tiedParts ? 'Provisional' : 'Decided'}: ${o.option}** · ${o.how === 'votes' ? `${counts.get(o.option).length} of ${plural(holders.size, 'vote')}` : `tie broken by a ${LEAD}`}`
      : !voting ? `**Tied: ${top ? `${part.tied.join(', ')} at ${plural(top, 'vote')} each` : 'no votes'}.** A ${LEAD} breaks the tie.`
      : top === 0 ? 'No votes yet' : tied.length === 1 ? `Ahead: ${tied[0]}` : 'Even so far';
    const value = [
      ...part.options.map((k) => optionLine(p, k, ` · ${plural(counts.get(k).length, 'vote')}${counts.get(k).length ? ` (${named(counts.get(k))})` : ''}`)),
      `The chief recommends ${p.recommended}: ${p.why}`,
      `Voted: ${voted.length ? named(voted.map(([id]) => id)) : 'nobody yet'} · Not voted: ${notYet.length ? named(notYet) : 'nobody'}`,
      ...(state ? [state] : []),
    ].join('\n');
    const breakable = !voting && !withdrawn && o.status === 'open';
    rows.push(new ActionRowBuilder().addComponents(part.options.map((k, j) => breakable
      ? (part.tied.includes(k) ? button(customId('tiebreak', gate.id, i, j), `Part ${n}, break the tie: ${k} (${LEAD} only)`, ButtonStyle.Danger) : null)
      : button(customId('press', gate.id, i, j), `Part ${n}, ${k}: ${label(p, k)}`, k === p.recommended ? ButtonStyle.Primary : ButtonStyle.Secondary,
        { chosen: o.status === 'decided' && o.option === k, disabled: !voting })).filter(Boolean)));
    return { name: `Part ${n} · ${p.question}`, value };
  });
  if (voting) rows.push(new ActionRowBuilder().addComponents(button(customId('end', gate.id), `End vote now (${LEAD} only)`, ButtonStyle.Danger)));
  const ended = gate.votingEndedAt === null ? ''
    : gate.votingEndedAt < gate.endsAt ? `Ended early at ${stamp(gate.votingEndedAt)} by a ${LEAD}, with the votes so far. `
    : `Voting ended at ${stamp(gate.votingEndedAt)}. `;
  const description = withdrawn ? `**Withdrawn by ${who(gate.askedBy, names)} at ${stamp(gate.lastAt)}.** Closed: nothing is decided.`
    : voting ? `${plural(gate.parts.length, 'product question')} of ${ask.task}. Vote on each part; change your vote until the vote ends. ` +
      `Closes at ${stamp(gate.endsAt)} (${stamp(gate.endsAt, 'R')}).`
    : tiedParts ? `${ended}${tiedParts === 1 ? '1 part is tied: it waits' : `${tiedParts} parts are tied: they wait`} for a ${LEAD}. ` +
      `${tiedParts < gate.parts.length ? 'The other parts are provisional, and ' : ''}${ask.task} waits.`
    : `${ended}Closed: every part is decided. ${ask.task} goes on.`;
  // The newest reasons that fit in 25 fields, each cut to REASON_ON_CARD; the cut shrinks until the embed is under 6000.
  const shown = reasons.sort((a, b) => a.at - b.at).slice(Math.max(0, reasons.length - (FIELDS_MAX - fields.length)));
  const build = (cap) => new EmbedBuilder().setTitle(`Batch vote ${gate.id} · ${ask.task} ${ask.title}`).setDescription(description)
    .addFields(...fields, ...shown.map(({ name, value }) => ({ name, value: cut(value, cap) })))
    .setFooter({ text: `Rule: 30 minutes, then each part goes to the option with the most votes · a tied part waits for a ${LEAD} · ` +
      `Who votes: every ${DRIVER}, one vote per part · Reason: optional, after a press` });
  let cap = REASON_ON_CARD;
  let embed = build(cap);
  for (let over = embedLength(embed.data) - EMBED_MAX; over > 0 && cap > 1 && shown.length; over = embedLength(embed.data) - EMBED_MAX) {
    cap = Math.max(1, cap - Math.ceil(over / shown.length));
    embed = build(cap);
  }
  return { embed, rows };
}

/** The form after a batch press: an optional reason of at most REASON_MAX characters. */
export function reasonModal(gate, ask, part, index) {
  const key = gate.parts[part].options[index];
  const input = new TextInputBuilder().setCustomId('reason').setLabel(`Reason for part ${part + 1} (optional)`)
    .setStyle(TextInputStyle.Paragraph).setMaxLength(REASON_MAX).setRequired(false)
    .setPlaceholder('Everyone sees it on the card. The chief gets it as quoted text and sums up the arguments.');
  return new ModalBuilder().setCustomId(customId('reason', gate.id, part, index)).setTitle(cut(`Your vote counts: ${key}. ${label(ask.parts[part], key)}`, 45))
    .addComponents(new ActionRowBuilder().addComponents(input)).toJSON();
}

/** The private confirm before a lead ends a batch vote: what each part gets with the votes so far. */
export function confirmEnd(gate, { holders, names }) {
  const lines = gate.parts.map((part, i) => {
    const counts = tally(part, holders);
    const { top, tied } = leaders(counts);
    return top === 0 ? `Part ${i + 1} has no votes. It stays open until a ${LEAD} breaks the tie.`
      : tied.length === 1 ? `Part ${i + 1} goes to ${tied[0]}: ${top} of ${plural(holders.size, 'vote')} (${counts.get(tied[0]).map((id) => who(id, names)).join(', ')}).`
      : `Part ${i + 1} is tied ${tied.join(', ')} at ${plural(top, 'vote')} each. It stays open until a ${LEAD} breaks the tie.`;
  });
  const row = new ActionRowBuilder().addComponents(
    button(customId('cancel', gate.id), 'Cancel', ButtonStyle.Secondary), button(customId('end!', gate.id), 'End vote now', ButtonStyle.Danger));
  return { ...ephemeral([`**End ${gate.id} now?**`, ...lines, 'Nobody can vote after this.'].join('\n')), components: [row.toJSON()] };
}

/** The private note for a `why` code of the vote rules (or the bridge's own `unknown-gate`). */
export function note(why, gate, names) {
  const text = NOTES[why] ?? NOTES['bad-event'];
  return ephemeral(text(gate, names));
}
const NOTES = {
  'unknown-gate': () => 'I do not know this button or its question. Nothing changed.',
  'bad-event': () => 'This press is not one I understand. Nothing changed.',
  'bad-time': () => 'The bridge clock gave a bad time, so nothing changed. Please press again.',
  'out-of-order': () => 'The bridge clock went back, so nothing changed. Please press again.',
  'not-holder': () => `Your press did not count. Only people with the ${DRIVER} role can answer or vote. You can still read this thread.`,
  'not-lead': () => `Only a ${LEAD} can do this. Your votes on the parts count like everyone's.`,
  'lead-needs-discord': () => `A ${LEAD} action works only here in Discord, not at the terminal.`,
  'not-asker': (g, names) => `Only ${who(g.askedBy, names)}, who asked ${g.id}, can withdraw it.`,
  'unknown-option': () => 'This option is not on the card. Nothing changed.',
  'unknown-part': () => 'This part is not on the card. Nothing changed.',
  'wrong-kind': () => 'This is a single question, not a vote: there is nothing to end and no tie to break.',
  'not-tied': () => 'This part is not tied, so there is no tie to break.',
  'not-tied-option': () => 'Only one of the tied options can break the tie.',
  closed: (g, names) => g.outcome.status === 'answered' ? `Already answered by ${who(g.outcome.by, names)}: ${g.outcome.option}`
    : g.outcome.status === 'withdrawn' ? `${g.id} was withdrawn by ${who(g.askedBy, names)}. Nothing to answer.`
    : `The vote on ${g.id} ended at ${stamp(g.votingEndedAt)}. Your press did not count.`,
};
