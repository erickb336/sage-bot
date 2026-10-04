// The vote rules of the sage bridge, as data plus pure functions.
// No clock, no network, no Discord: every event carries its own time `at` (ms).
//
//   const gate = openGate({ id, kind: 'single', options, askedBy, at });
//   const gate = openGate({ id, kind: 'batch', parts: [options, options, ...], askedBy, at });
//   ({ gate, effects } = step(gate, event, holders, leads));
//
// `holders` are the Discord user ids that may answer and vote; `leads` are the ids with the
// sage-lead role. The bridge passes both in with each event. Anyone else counts for nothing.
// The bridge sends a tick at `gate.endsAt` so that a batch vote ends on time.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const BATCH_LIMIT = 30 * MINUTE;
export const REMINDER_EVERY = 2 * HOUR;
export const REASON_MAX = 500;

const KINDS = new Set(['single', 'batch']);
const EVENT_TYPES = new Set(['press', 'end', 'tiebreak', 'withdraw', 'tick']);
const VIAS = new Set(['discord', 'terminal']);
const OPEN = { status: 'open' };
const isId = (x) => typeof x === 'string' && x !== '';
const isOptions = (x) => Array.isArray(x) && x.length > 0 && x.every(isId);

/**
 * @typedef {{ option: string, at: number, via: 'discord' | 'terminal', reason?: string }} Ballot
 * @typedef {{ status: 'open' } | { status: 'decided', option: string, how: 'votes' | 'lead-tiebreak' }} PartOutcome
 * @typedef {{ options: string[], ballots: Record<string, Ballot>, outcome: PartOutcome }} Part
 * @typedef {{ id: string, kind: 'single', askedBy: string, openedAt: number, lastAt: number,
 *   phase: 'open' | 'closed', options: string[],
 *   outcome: { status: 'open' } | { status: 'answered', option: string, by: string } | { status: 'withdrawn' } }} SingleGate
 * @typedef {{ id: string, kind: 'batch', askedBy: string, openedAt: number, lastAt: number,
 *   phase: 'voting' | 'tied' | 'closed', endsAt: number, votingEndedAt: number | null, parts: Part[],
 *   outcome: { status: 'open' } | { status: 'decided' } | { status: 'withdrawn' } }} BatchGate
 * @typedef {SingleGate | BatchGate} Gate
 * @typedef {{ type: 'press', by: string, option: string, part?: number, at: number, via: 'discord' | 'terminal', reason?: string }
 *   | { type: 'end', by: string, at: number, via: 'discord' | 'terminal' }
 *   | { type: 'tiebreak', by: string, part: number, option: string, at: number, via: 'discord' | 'terminal' }
 *   | { type: 'withdraw', by: string, at: number }
 *   | { type: 'tick', at: number }} Event
 * @typedef {'not-holder' | 'not-lead' | 'lead-needs-discord' | 'not-asker' | 'unknown-option' | 'unknown-part'
 *   | 'wrong-kind' | 'not-tied' | 'no-holders' | 'closed' | 'bad-event' | 'bad-time' | 'out-of-order'} Why
 * @typedef {{ type: 'vote-ended', by: string | null }
 *   | { type: 'decided', part: number, option: string, how: 'votes' | 'lead-tiebreak' }
 *   | { type: 'closed', outcome: Gate['outcome'] }
 *   | { type: 'ignored', by: string | null, why: Why }} Effect
 */

/**
 * Open a gate. A single gate has one list of options; a batch has parts, each a list of options.
 * Throws on a gate it refuses: a kind other than single or batch, no id or askedBy,
 * a time that is not finite, or empty options or parts.
 * @returns {Gate}
 */
export function openGate({ id, kind, options, parts, askedBy, at }) {
  if (!KINDS.has(kind)) throw new RangeError('openGate: unknown gate kind');
  if (!isId(id) || !isId(askedBy)) throw new TypeError('openGate: a gate needs an id and askedBy');
  if (!Number.isFinite(at)) throw new RangeError('openGate: a gate needs a finite time');
  const base = { id, kind, askedBy, openedAt: at, lastAt: at, outcome: OPEN };
  if (kind === 'single') {
    if (!isOptions(options)) throw new TypeError('openGate: a single gate needs a non-empty list of options');
    return { ...base, phase: 'open', options: [...options] };
  }
  if (!(Array.isArray(parts) && parts.length > 0 && parts.every(isOptions))) {
    throw new TypeError('openGate: a batch needs a non-empty list of parts, each with a non-empty list of options');
  }
  return {
    ...base, phase: 'voting', endsAt: at + BATCH_LIMIT, votingEndedAt: null,
    parts: parts.map((opts) => ({ options: [...opts], ballots: {}, outcome: OPEN })),
  };
}

/**
 * Apply one event to a gate. Never throws on an odd event: it is ignored, with the reason.
 * @param {Gate} gate
 * @param {Event} event
 * @param {string[]} holders
 * @param {string[]} leads
 * @returns {{ gate: Gate, effects: Effect[] }}
 */
export function step(gate, event, holders, leads) {
  const why = refusal(gate, event);
  if (why) return { gate, effects: [ignored(event, why)] };
  const people = { holders: idSet(holders), leads: idSet(leads) };
  const timed = { ...gate, lastAt: event.at };
  // A batch vote ends at its time limit, before the event that reaches it applies.
  const settled = timed.phase === 'voting' && event.at >= timed.endsAt
    ? endVoting(timed, null, people.holders, timed.endsAt)
    : { gate: timed, effects: [] };
  if (event.type === 'tick') return settled;
  const next = settled.gate.phase === 'closed'
    ? ignore(settled.gate, event, 'closed')
    : apply(settled.gate, event, people);
  return { gate: next.gate, effects: [...settled.effects, ...next.effects] };
}

/** Why an event is refused before it touches the gate, or null. Time never goes back. */
function refusal(gate, event) {
  if (typeof event !== 'object' || event === null || !EVENT_TYPES.has(event.type)) return 'bad-event';
  if (!Number.isFinite(event.at)) return 'bad-time';
  if (event.at < gate.lastAt) return 'out-of-order';
  if (event.type === 'tick') return null;
  if (!isId(event.by)) return 'bad-event';
  if (event.type === 'withdraw') return null;
  if (!VIAS.has(event.via)) return 'bad-event';
  if (event.type === 'end') return null;
  const reasonOk = event.reason === undefined || typeof event.reason === 'string';
  return typeof event.option === 'string' && reasonOk ? null : 'bad-event';
}

/** A list of ids as a set of unique, non-empty strings. */
function idSet(ids) {
  return new Set(Array.isArray(ids) ? ids.filter(isId) : []);
}

function apply(gate, event, { holders, leads }) {
  if (event.type === 'withdraw') {
    return event.by === gate.askedBy ? close(gate, { status: 'withdrawn' }) : ignore(gate, event, 'not-asker');
  }
  if (event.type === 'press') return gate.kind === 'single' ? answer(gate, event, holders) : vote(gate, event, holders);
  // A lead action: end or tiebreak. Only on a batch, only from Discord, only from a lead.
  if (gate.kind !== 'batch') return ignore(gate, event, 'wrong-kind');
  if (event.via !== 'discord') return ignore(gate, event, 'lead-needs-discord');
  if (!leads.has(event.by)) return ignore(gate, event, 'not-lead');
  if (event.type === 'end') {
    return gate.phase === 'voting' ? endVoting(gate, event.by, holders, event.at) : ignore(gate, event, 'closed');
  }
  return tiebreak(gate, event, holders);
}

/** A single gate: the first answer from a holder is final. */
function answer(gate, event, holders) {
  if (!holders.has(event.by)) return ignore(gate, event, 'not-holder');
  if (!gate.options.includes(event.option)) return ignore(gate, event, 'unknown-option');
  return close(gate, { status: 'answered', option: event.option, by: event.by });
}

/** A batch ballot: the last ballot of each holder on each part counts. */
function vote(gate, event, holders) {
  if (gate.phase !== 'voting') return ignore(gate, event, 'closed');
  if (!holders.has(event.by)) return ignore(gate, event, 'not-holder');
  const part = Number.isInteger(event.part) ? gate.parts[event.part] : undefined;
  if (!part) return ignore(gate, event, 'unknown-part');
  if (!part.options.includes(event.option)) return ignore(gate, event, 'unknown-option');
  const ballot = { option: event.option, at: event.at, via: event.via };
  const reason = event.reason === undefined ? '' : cleanReason(event.reason);
  if (reason) ballot.reason = reason;
  const parts = gate.parts.with(event.part, { ...part, ballots: { ...part.ballots, [event.by]: ballot } });
  return { gate: { ...gate, parts }, effects: [] };
}

/** End the batch vote: each part goes to the option with the most votes cast; a tie stays open. */
function endVoting(gate, by, holders, at) {
  const effects = [{ type: 'vote-ended', by }];
  const parts = gate.parts.map((part, i) => {
    const option = leader(part, holders);
    if (option === null) return part;
    effects.push({ type: 'decided', part: i, option, how: 'votes' });
    return { ...part, outcome: { status: 'decided', option, how: 'votes' } };
  });
  return finish({ ...gate, phase: 'tied', votingEndedAt: at, parts }, effects);
}

/** A lead picks one option of an open part after the vote ended. Nothing is decided with no holders. */
function tiebreak(gate, event, holders) {
  const part = Number.isInteger(event.part) ? gate.parts[event.part] : undefined;
  if (!part) return ignore(gate, event, 'unknown-part');
  if (gate.phase !== 'tied' || part.outcome.status !== 'open') return ignore(gate, event, 'not-tied');
  if (!part.options.includes(event.option)) return ignore(gate, event, 'unknown-option');
  if (holders.size === 0) return ignore(gate, event, 'no-holders');
  const parts = gate.parts.with(event.part, { ...part, outcome: { status: 'decided', option: event.option, how: 'lead-tiebreak' } });
  return finish({ ...gate, parts }, [{ type: 'decided', part: event.part, option: event.option, how: 'lead-tiebreak' }]);
}

/** Close the batch when every part is decided. */
function finish(gate, effects) {
  return gate.parts.every((p) => p.outcome.status === 'decided')
    ? close(gate, { status: 'decided' }, effects)
    : { gate, effects };
}

/** The option with the most ballots of current holders, or null on a tie (zero ballots is a tie). */
function leader(part, holders) {
  const counts = new Map();
  for (const h of holders) {
    if (Object.hasOwn(part.ballots, h)) counts.set(part.ballots[h].option, (counts.get(part.ballots[h].option) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  const leaders = [...counts].filter(([, n]) => n === top);
  return leaders.length === 1 ? leaders[0][0] : null;
}

function close(gate, outcome, effects = []) {
  return { gate: { ...gate, phase: 'closed', outcome }, effects: [...effects, { type: 'closed', outcome }] };
}

function ignore(gate, event, why) {
  return { gate, effects: [ignored(event, why)] };
}

function ignored(event, why) {
  return { type: 'ignored', by: isId(event?.by) ? event.by : null, why };
}

/**
 * The next reminder after `now`, or null:
 * a single gate with no answer reminds the holders every 2 hours from opening;
 * a batch with tied parts after its vote ended reminds the leads every 2 hours from that end.
 * @returns {{ at: number, to: 'holders' | 'leads' } | null}
 */
export function nextReminderAt(gate, now) {
  let from, to;
  if (gate.phase === 'open') [from, to] = [gate.openedAt, 'holders'];
  else if (gate.phase === 'tied') [from, to] = [gate.votingEndedAt, 'leads'];
  else return null;
  const done = Math.max(0, Math.floor((now - from) / REMINDER_EVERY));
  return { at: from + (done + 1) * REMINDER_EVERY, to };
}

/** Characters that look like < > or a backtick and that NFKC does not map to them. */
const LOOKALIKES = '‹›〈〉⟨⟩⟪⟫《》〈〉'
  + '❬❭❮❯❰❱⧼⧽˂˃ᐸᐳˋ‵';

/**
 * Clean a ballot reason, in this order:
 * NFKC; remove format characters (zero-width, bidi, U+FEFF, tags), variation selectors and lone surrogates;
 * map control characters, line and paragraph separators and newlines (CRLF as one) to a space;
 * remove < > ` and their lookalikes; collapse spaces; trim; cut to 500 characters (code points).
 * @param {string} text
 */
export function cleanReason(text) {
  const clean = text.normalize('NFKC')
    .replace(/[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\p{Cs}]/gu, '')
    .replace(/\r\n|[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(new RegExp(`[<>\`${LOOKALIKES}]`, 'gu'), '')
    .replace(/ {2,}/g, ' ')
    .trim();
  return Array.from(clean).slice(0, REASON_MAX).join('');
}
