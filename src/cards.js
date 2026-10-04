// The cards, the reason modal, the end-vote confirm and the private notes of the sage bridge,
// as the JSON that Discord takes (discord.js builders). Pure functions of a gate, its ask and the people.
// No Client, no network. The names and the ballot reasons are untrusted text: `safe` makes them inert.
// Times are Discord timestamps (<t:…:t>), so each viewer's Discord shows them in the viewer's own zone,
// and the 30-minute countdown (<t:…:R>) runs live with no edit of the card.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder,
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
/** Discord's limits on one message, in characters (fields: a count). A reason shows on the card cut to REASON_ON_CARD characters; the gate keeps the full text. */
const LIMIT = { embed: 6000, fields: 25, title: 256, description: 4096, footer: 2048, name: 256, value: 1024, button: 80, modal: 45 };
const REASON_ON_CARD = 200;

/**
 * The characters that `safe` removes, by Unicode rule, not by list (F-T27-24): every format character (\p{Cf}: bidi controls,
 * zero-width space, BOM, soft hyphen, word joiner, tag characters, …), every control (\p{Cc}) that is not whitespace, every lone
 * surrogate (\p{Cs}), the five letters that look blank (the Hangul fillers, the half-width filler and the empty braille cell),
 * every variation selector (U+FE00 to U+FE0F, U+E0100 to U+E01EF) and the combining grapheme joiner U+034F (F-T27-32).
 * Group 1 is kept: the three subdivision flags of the emoji list (England, Scotland and Wales: U+1F3F4, the tag letters gbeng, gbsct or
 * gbwls, U+E007F; any other tag sequence goes, F-T27-31), a joiner (U+200C, U+200D) between two visible characters (a letter, a mark,
 * a pictograph or a skin tone), the emoji selectors U+FE0E and U+FE0F directly after a pictograph or a keycap base (a digit, # or *), and an
 * ideographic selector directly after a Han ideograph. So a family emoji, a Persian word, a red heart, a keycap and the Scotland flag stay
 * whole, while tag characters and selectors anywhere else cannot carry hidden text.
 */
const HIDDEN = /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}|(?<=[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}])[\u200c\u200d](?=[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}])|(?<=[\p{Extended_Pictographic}0-9#*])[\ufe0e\ufe0f]|(?<=\p{Script=Han})[\u{E0100}-\u{E01EF}])|\p{Cf}|(?!\s)\p{Cc}|\p{Cs}|[\u115f\u1160\u3164\uffa0\u2800\u034f\ufe00-\ufe0f\u{E0100}-\u{E01EF}]/gu;
/** A combining mark after three on one base character: a stack of marks is cut to 3 (F-T27-32). */
const MARK_OVERFLOW = /(?<=\p{M}{3})\p{M}/gu;
/** Text with nothing visible: only combining marks and spaces (the hidden characters are already removed). */
const VISIBLY_EMPTY = /^[\p{M} ]*$/u;
/**
 * Untrusted text as one inert line: hidden characters removed (HIDDEN), markdown and every `[` and `]` escaped (no masked link),
 * `<` escaped (no mention, timestamp or emoji code), whitespace folded. A visibly empty text gives '' (F-T27-25): a reason of ''
 * gets no field, because Discord refuses an empty field value (F-T27-19), and a name of '' falls back (see `who`).
 */
export function safe(text) {
  const line = escapeMarkdown(String(text).replace(HIDDEN, (m, keep) => keep ?? '').replace(MARK_OVERFLOW, ''), ESCAPE_ALL)
    .replace(/[<[\]]/g, '\\$&').replace(/\s+/g, ' ').trim();
  return VISIBLY_EMPTY.test(line) ? '' : line;
}
const GRAPHEMES = new Intl.Segmenter();
/** `text` cut to at most `max` characters, the last one "…"; the cut never splits a grapheme cluster: a flag or a family emoji is kept whole or dropped whole (F-T27-28). */
function cut(text, max) {
  if (text.length <= max) return text;
  let end = 0;
  for (const { index, segment } of GRAPHEMES.segment(text)) {
    if (index + segment.length > max - 1) break;
    end = index + segment.length;
  }
  return `${text.slice(0, end)}…`;
}
/** `text` cut at the last space before `max` characters, then "…", so no word is cut in half; one long word is cut like `cut` (F-T27-23). */
const cutAtWord = (text, max) => {
  if (text.length <= max) return text;
  const space = text.lastIndexOf(' ', max - 2);
  return space > max / 2 ? `${text.slice(0, space)}…` : cut(text, max);
};
/** A Discord timestamp: `t` shows hh:mm in the viewer's zone; `R` shows a live countdown ("in 18 minutes"). */
export const stamp = (ms, style = 't') => `<t:${Math.floor(ms / 1000)}:${style}>`;
/** A person's name made safe; when it is missing or visibly empty, "member …6789" (the last 4 digits of a Discord id) or "member" for any other id, never the raw id (F-T27-29, F-T27-33). */
const who = (id, names) => safe(names.get(id) ?? '') || (/^\d{4,}$/.test(id) ? `member …${id.slice(-4)}` : 'member');
const label = (p, key) => p.options[key] ?? key;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** `items` joined with ', ' within `cap` characters, the rest as "and N more"; the first item always shows. */
function list(items, cap) {
  let out = items[0];
  let i = 1;
  while (i < items.length && `${out}, ${items[i]}`.length <= cap) out = `${out}, ${items[i++]}`;
  return i < items.length ? `${out} and ${items.length - i} more` : out;
}
/**
 * How far the plain embed `e` is over Discord's limits: the sum of every overshoot in characters, 0 when every limit holds.
 * `whole` adds the limits of the embed as a whole (6000 characters, 25 fields) to those of each text (title, description, footer, field names and values).
 */
function over(e, whole) {
  const fields = e.fields ?? [];
  const texts = [[e.title, LIMIT.title], [e.description, LIMIT.description], [e.footer?.text, LIMIT.footer],
    ...fields.flatMap((f) => [[f.name, LIMIT.name], [f.value, LIMIT.value]])];
  return texts.reduce((sum, [t, max]) => sum + Math.max(0, (t?.length ?? 0) - max),
    whole ? Math.max(0, fields.length - LIMIT.fields) + Math.max(0, embedLength(e) - LIMIT.embed) : 0);
}
/** The knobs of a plan in the order that `budget` turns them, with the floor of each: no reason field; one character ("…") of each text. */
const KNOBS = { reasons: 0, voters: 1, why: 1, label: 1, question: 1 };
/**
 * The embed `build(plan)` shrunk until every limit holds (F-T27-30). First each text goes within its own limit (a field value in 1024, the
 * single card's description in 4096), then the whole embed within 6000 characters and 25 fields. Both times the knobs of `plan` turn in
 * a fixed order, each down to its floor before the next: the oldest reason fields go (one at a time, and only for the whole), then the
 * voter lists shrink (to "and N more"), then the why, then the option labels, then the question. A cap falls by the overshoot spread over
 * the `n` texts that it cuts. The keys ("A."), the counts and "The chief recommends A" never shrink. At every floor a card of a team of 5
 * with 4 parts is far under the limits, so the result always fits: the property test of test/t27-repair4.test.js proves it.
 */
function budget(build, plan, n) {
  let e = build(plan);
  for (const whole of [false, true]) {
    for (const [knob, floor] of Object.entries(KNOBS).slice(whole ? 0 : 1)) { // a reason field is whole or gone: it only counts for the whole
      for (let o = over(e, whole); o > 0 && plan[knob] > floor; o = over(e, whole)) {
        e = build(plan = { ...plan, [knob]: Math.max(floor, plan[knob] - Math.max(1, Math.ceil(o / n[knob]))) });
      }
    }
  }
  return e;
}
/** The caps that a plan starts from: the longest why, label and question of the ask, so that the first step of `budget` cuts something. */
const caps = (ask) => ({
  why: Math.max(1, ...ask.parts.map((p) => p.why.length)),
  label: Math.max(1, ...ask.parts.flatMap((p) => Object.values(p.options).map((l) => l.length))),
  question: Math.max(1, ...ask.parts.map((p) => p.question.length)),
});

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
 * The card of a gate: `{ embeds, components, allowedMentions }`. The embed is plain data, not an EmbedBuilder: the builder's setters
 * throw at the first text over a limit, and `budget` has to measure the whole embed first and shrink it until it fits (F-T27-30, F-T27-33).
 * @param {import('./vote.js').Gate} gate
 * @param {{ task: string, title: string, parts: { question: string, why: string, recommended: string, default?: string, options: Record<string, string> }[] }} ask
 * @param {{ holders: Set<string>, names: Map<string, string> }} people
 */
export function card(gate, ask, { holders, names }) {
  const closed = gate.phase === 'closed';
  const withdrawn = gate.outcome.status === 'withdrawn';
  const { embed, rows } = gate.kind === 'single' ? single(gate, ask, names) : batch(gate, ask, holders, names);
  const color = withdrawn ? COLOR.withdrawn : closed ? COLOR.decided : gate.phase === 'tied' ? COLOR.tied : COLOR.open;
  if (rows.length > 5) throw new RangeError('card: Discord allows 5 rows of buttons on one message');
  return { embeds: [{ ...embed, color }], components: rows.map((r) => r.toJSON()), allowedMentions: NO_MENTIONS };
}

const button = (id, text, style, { chosen = false, disabled = false } = {}) => new ButtonBuilder().setCustomId(id)
  .setLabel(cut(text, LIMIT.button)).setStyle(chosen ? ButtonStyle.Success : style).setDisabled(disabled);
const optionLine = (p, key, extra, cap) => `**${key}.** ${cutAtWord(label(p, key), cap)}${key === p.recommended ? ' · Recommended' : ''}${extra}`;

function single(gate, ask, names) {
  const [p] = ask.parts;
  const o = gate.outcome;
  const build = ({ why, label: cap, question }) => ({
    title: cut(`Question ${gate.id} · ${ask.task} ${ask.title}`, LIMIT.title),
    description: [
      `**${cutAtWord(p.question, question)}**`, '',
      ...gate.options.map((k) => optionLine(p, k, k === p.default ? ' · Default' : '', cap)), '',
      `**Why recommended:** ${cutAtWord(p.why, why)}`,
      ...(p.default ? [`**Default:** ${cutAtWord(label(p, p.default), cap)}, but no time-out applies it`] : []),
      '**Rule:** the first answer is final · reminder every 2 h until answered',
      `**Who can answer:** every ${DRIVER}`,
      ...(o.status === 'answered' ? ['', `**Answered by ${who(o.by, names)}${o.via === 'terminal' ? ' (terminal)' : ''} at ${stamp(gate.lastAt)}: ${o.option}. ${cutAtWord(label(p, o.option), cap)}. Final.**`]
        : o.status === 'withdrawn' ? ['', `**Withdrawn by ${who(gate.askedBy, names)} at ${stamp(gate.lastAt)}.** Nothing to answer.`] : []),
    ].join('\n'),
  });
  const row = new ActionRowBuilder().addComponents(gate.options.map((k, i) => button(customId('press', gate.id, 0, i), `${k}. ${label(p, k)}`,
    k === p.recommended ? ButtonStyle.Primary : ButtonStyle.Secondary, { chosen: o.option === k, disabled: gate.phase === 'closed' })));
  return { embed: budget(build, caps(ask), { why: 1, label: gate.options.length, question: 1 }), rows: [row] };
}

function batch(gate, ask, holders, names) {
  const voting = gate.phase === 'voting';
  const withdrawn = gate.outcome.status === 'withdrawn';
  const tiedParts = gate.phase === 'tied' ? gate.parts.filter((part) => part.outcome.status === 'open').length : 0;
  const rows = [];
  const reasons = [];
  const parts = gate.parts.map((part, i) => {
    const p = ask.parts[i];
    const n = i + 1;
    const counts = tally(part, holders);
    const { top, tied } = leaders(counts);
    const ballots = ballotsOf(part);
    const voted = [...ballots].filter(([id]) => holders.has(id)).map(([id]) => id);
    for (const id of voted) {
      // A reason that is only spaces or hiding characters gives no field: Discord refuses an empty field value (F-T27-19).
      const { reason, at } = ballots.get(id);
      const value = reason && safe(reason);
      if (value) reasons.push({ name: `${who(id, names)}, part ${n}`, value: cut(value, REASON_ON_CARD), at });
    }
    const notYet = [...holders].filter((id) => !ballots.has(id));
    const o = part.outcome;
    const state = withdrawn ? ''
      : o.status === 'decided' ? `**${tiedParts ? 'Provisional' : 'Decided'}: ${o.option}** · ${o.how === 'votes' ? `${counts.get(o.option).length} of ${plural(holders.size, 'vote')}` : `tie broken by a ${LEAD}`}`
      : !voting ? `**Tied: ${top ? `${part.tied.join(', ')} at ${plural(top, 'vote')} each` : 'no votes'}.** A ${LEAD} breaks the tie.`
      : top === 0 ? 'No votes yet' : tied.length === 1 ? `Ahead: ${tied[0]}` : 'Even so far';
    const breakable = !voting && !withdrawn && o.status === 'open';
    rows.push(new ActionRowBuilder().addComponents(part.options.map((k, j) => breakable
      ? (part.tied.includes(k) ? button(customId('tiebreak', gate.id, i, j), `Part ${n}, break the tie: ${k} (${LEAD} only)`, ButtonStyle.Danger) : null)
      : button(customId('press', gate.id, i, j), `Part ${n}, ${k}: ${label(p, k)}`, k === p.recommended ? ButtonStyle.Primary : ButtonStyle.Secondary,
        { chosen: o.status === 'decided' && o.option === k, disabled: !voting })).filter(Boolean)));
    /** The field of the part under the caps of a plan: the voter lists, the why, the labels and the question shrink; the keys and the counts never. */
    return ({ voters, why, label: cap, question }) => {
      const named = (ids) => list(ids.map((id) => who(id, names) + (ballots.get(id)?.via === 'terminal' ? ' (terminal)' : '')), voters);
      return {
        name: cutAtWord(`Part ${n} · ${cutAtWord(p.question, question)}`, LIMIT.name),
        value: [
          ...part.options.map((k) => optionLine(p, k, ` · ${plural(counts.get(k).length, 'vote')}${counts.get(k).length ? ` (${named(counts.get(k))})` : ''}`, cap)),
          `The chief recommends ${p.recommended}: ${cutAtWord(p.why, why)}`,
          `Voted: ${voted.length ? named(voted) : 'nobody yet'} · Not voted: ${notYet.length ? named(notYet) : 'nobody'}`,
          ...(state ? [state] : []),
        ].join('\n'),
      };
    };
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
  const footer = { text: `Rule: 30 minutes, then each part goes to the option with the most votes · a tied part waits for a ${LEAD} · ` +
    `Who votes: every ${DRIVER}, one vote per part · Reason: optional, after a press` };
  reasons.sort((a, b) => a.at - b.at); // oldest first: `budget` drops from the front and shows the newest
  const build = (plan) => ({
    title: cut(`Batch vote ${gate.id} · ${ask.task} ${ask.title}`, LIMIT.title),
    description,
    fields: [...parts.map((field) => field(plan)), ...reasons.slice(reasons.length - plan.reasons).map(({ name, value }) => ({ name, value }))],
    footer,
  });
  // The voter cap starts at the longest list that the holders can make, so that the first step cuts a list.
  const plan = { reasons: reasons.length, voters: [...holders].reduce((sum, id) => sum + who(id, names).length + 13, 0), ...caps(ask) };
  const options = gate.parts.reduce((sum, part) => sum + part.options.length, 0);
  return { embed: budget(build, plan, { reasons: Infinity, voters: options + 2 * gate.parts.length, why: gate.parts.length, label: options, question: gate.parts.length }), rows };
}

/** The form title, 45 characters at most: "Your vote counts: A. …"; when that does not fit, the option alone, cut at a word (F-T27-29). */
const title = (option) => `Your vote counts: ${option}`.length <= LIMIT.modal ? `Your vote counts: ${option}` : cutAtWord(option, LIMIT.modal);
/** The form after a batch press: an optional reason of at most REASON_MAX characters. */
export function reasonModal(gate, ask, part, index) {
  const key = gate.parts[part].options[index];
  const input = new TextInputBuilder().setCustomId('reason').setLabel(`Reason for part ${part + 1} (optional)`)
    .setStyle(TextInputStyle.Paragraph).setMaxLength(REASON_MAX).setRequired(false)
    .setPlaceholder('Everyone sees it on the card. The chief gets it as quoted text and sums up the arguments.');
  return new ModalBuilder().setCustomId(customId('reason', gate.id, part, index)).setTitle(title(`${key}. ${label(ask.parts[part], key)}`))
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
