// The vote rules of the sage bridge, as data plus pure functions.
// No clock, no network, no Discord: every event carries its own time `at` (ms).
//
//   const gate = openGate({ id, kind, options, askedBy, at });
//   ({ gate, effects } = step(gate, event, holders));
//
// `holders` is the current holder list (Discord user ids on the Mac's list).
// A press from anyone else counts for nothing.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const OBJECTION_WINDOW = 10 * MINUTE;
export const REMINDER_EVERY = 2 * HOUR;
export const REASON_MAX = 500;

/** The kinds of gate that need every holder to approve. One No rejects. */
export const CRITICAL_KINDS = new Set(['delete-data', 'publish', 'force-push']);
/** The kinds of gate where the first answer wins. Any other kind is refused: no case or space folding. */
export const NORMAL_KINDS = new Set(['question', 'merge', 'autopilot', 'deploy']);

/** The options of a critical gate. */
export const YES = 'yes';
export const NO = 'no';

const EVENT_TYPES = new Set(['press', 'object', 'withdraw', 'tick']);
const VIAS = new Set(['discord', 'terminal']);
const isId = (x) => typeof x === 'string' && x !== '';

/**
 * @typedef {{ option: string, at: number, via: 'discord' | 'terminal', reason?: string }} Ballot
 * @typedef {{ status: 'open' } | { status: 'approved', option: string } | { status: 'rejected' } | { status: 'withdrawn' }} Outcome
 * @typedef {{
 *   id: string, kind: string, critical: boolean, options: string[], askedBy: string, openedAt: number,
 *   lastAt: number,
 *   phase: 'waiting' | 'window' | 'vote' | 'closed',
 *   first: { by: string, option: string, at: number } | null,
 *   voteOpenedAt: number | null,
 *   ballots: Record<string, Ballot>,
 *   outcome: Outcome,
 * }} Gate
 * @typedef {{ type: 'press', by: string, option: string, at: number, via: 'discord' | 'terminal', reason?: string }
 *   | { type: 'object', by: string, at: number }
 *   | { type: 'withdraw', by: string, at: number }
 *   | { type: 'tick', at: number }} Event
 * @typedef {'not-holder' | 'terminal-on-critical' | 'not-asker' | 'unknown-option' | 'closed'
 *   | 'bad-event' | 'bad-time' | 'out-of-order'} Why
 * @typedef {{ type: 'answer', option: string, by: string }
 *   | { type: 'vote-opened', by: string }
 *   | { type: 'closed', outcome: Outcome }
 *   | { type: 'ignored', by: string | null, why: Why }} Effect
 */

/**
 * Open a gate. A critical gate is a vote from the start, with the options yes and no.
 * Throws on a gate it refuses: an unknown kind, no id or askedBy, a time that is not finite,
 * or a normal gate without options.
 * @returns {Gate}
 */
export function openGate({ id, kind, options, askedBy, at }) {
  const critical = CRITICAL_KINDS.has(kind);
  if (!critical && !NORMAL_KINDS.has(kind)) throw new RangeError('openGate: unknown gate kind');
  if (!isId(id) || !isId(askedBy)) throw new TypeError('openGate: a gate needs an id and askedBy');
  if (!Number.isFinite(at)) throw new RangeError('openGate: a gate needs a finite time');
  if (!critical && !(Array.isArray(options) && options.length > 0 && options.every(isId))) {
    throw new TypeError('openGate: a normal gate needs a non-empty list of options');
  }
  return {
    id, kind, critical, askedBy, openedAt: at, lastAt: at,
    options: critical ? [YES, NO] : [...options],
    phase: critical ? 'vote' : 'waiting',
    first: null,
    voteOpenedAt: critical ? at : null,
    ballots: {},
    outcome: { status: 'open' },
  };
}

/**
 * Apply one event to a gate. Never throws on an odd event: it is ignored, with the reason.
 * @param {Gate} gate
 * @param {Event} event
 * @param {string[]} holders
 * @returns {{ gate: Gate, effects: Effect[] }}
 */
export function step(gate, event, holders) {
  const why = refusal(gate, event);
  if (why) return { gate, effects: [ignored(event, why)] };
  const current = holderSet(holders);
  const settled = settle({ ...gate, lastAt: event.at }, current);
  if (settled.gate.phase === 'closed') {
    return event.type === 'tick' ? settled : { gate: settled.gate, effects: [...settled.effects, ignored(event, 'closed')] };
  }
  const next = apply(settled.gate, event, current);
  // The vote rule runs on every event, so a change of the holder list can close a vote.
  const decided = next.gate.phase === 'vote' ? withResult(next.gate, next.effects, current) : next;
  return { gate: decided.gate, effects: [...settled.effects, ...decided.effects] };
}

/** Why an event is refused before it touches the gate, or null. Time never goes back. */
function refusal(gate, event) {
  if (typeof event !== 'object' || event === null || !EVENT_TYPES.has(event.type)) return 'bad-event';
  if (!Number.isFinite(event.at)) return 'bad-time';
  if (event.at < gate.lastAt) return 'out-of-order';
  if (event.type === 'tick') return null;
  if (!isId(event.by)) return 'bad-event';
  if (event.type !== 'press') return null;
  const reasonOk = event.reason === undefined || typeof event.reason === 'string';
  return typeof event.option === 'string' && VIAS.has(event.via) && reasonOk ? null : 'bad-event';
}

/** The holders as a list of unique, non-empty ids. */
function holderSet(holders) {
  return Array.isArray(holders) ? [...new Set(holders.filter(isId))] : [];
}

/** Close a normal gate whose objection window ended with no objection. Nothing closes approved with no holders. */
function settle(gate, holders) {
  if (gate.phase !== 'window' || holders.length === 0 || gate.lastAt < gate.first.at + OBJECTION_WINDOW) {
    return { gate, effects: [] };
  }
  return close(gate, { status: 'approved', option: gate.first.option });
}

function apply(gate, event, holders) {
  if (event.type === 'tick') return { gate, effects: [] };
  if (event.type === 'withdraw') {
    return event.by === gate.askedBy
      ? close(gate, { status: 'withdrawn' })
      : { gate, effects: [ignored(event, 'not-asker')] };
  }
  if (!holders.includes(event.by)) return { gate, effects: [ignored(event, 'not-holder')] };

  if (event.type === 'object') {
    return gate.phase === 'window' ? openVote(gate, event) : { gate, effects: [] };
  }

  // A press.
  if (gate.critical && event.via !== 'discord') return { gate, effects: [ignored(event, 'terminal-on-critical')] };
  if (!gate.options.includes(event.option)) return { gate, effects: [ignored(event, 'unknown-option')] };
  const ballot = { option: event.option, at: event.at, via: event.via };
  const reason = event.reason === undefined ? '' : cleanReason(event.reason);
  if (reason) ballot.reason = reason;
  const voted = { ...gate, ballots: { ...gate.ballots, [event.by]: ballot } };

  if (gate.phase === 'waiting') return answer(voted, event);
  if (gate.phase === 'window' && event.option !== gate.first.option) {
    // The first answerer may change their answer: it restarts the window. Anyone else objects.
    return event.by === gate.first.by ? answer(voted, event) : openVote(voted, event);
  }
  return { gate: voted, effects: [] };
}

function answer(gate, event) {
  const first = { by: event.by, option: event.option, at: event.at };
  return { gate: { ...gate, phase: 'window', first }, effects: [{ type: 'answer', option: event.option, by: event.by }] };
}

function openVote(gate, event) {
  return { gate: { ...gate, phase: 'vote', voteOpenedAt: event.at }, effects: [{ type: 'vote-opened', by: event.by }] };
}

/** Close the vote when its rule is met; otherwise keep it open. */
function withResult(gate, effects, holders) {
  const outcome = result(gate, holders);
  return outcome.status === 'open' ? { gate, effects } : close(gate, outcome, effects);
}

/**
 * The rule of an open vote, on the last ballot of each current holder.
 * Critical: every holder says yes to approve; one no rejects.
 * Normal: a strict majority of the holders on one option.
 * With no holders, nothing is approved.
 * @returns {Outcome}
 */
export function result(gate, holders) {
  const current = holderSet(holders);
  const counts = tally(gate, current);
  if (gate.critical) {
    if (counts[NO]) return { status: 'rejected' };
    return current.length > 0 && counts[YES] === current.length ? { status: 'approved', option: YES } : { status: 'open' };
  }
  for (const [option, count] of Object.entries(counts)) {
    if (count > current.length / 2) return { status: 'approved', option };
  }
  return { status: 'open' };
}

function close(gate, outcome, effects = []) {
  return { gate: { ...gate, phase: 'closed', outcome }, effects: [...effects, { type: 'closed', outcome }] };
}

/** Count of the last ballot of each current holder, by option. */
function tally(gate, holders) {
  const counts = new Map();
  for (const h of holders) {
    const option = Object.hasOwn(gate.ballots, h) ? gate.ballots[h].option : undefined;
    if (option !== undefined) counts.set(option, (counts.get(option) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

/**
 * What a card shows for a gate: the counts, and whether an open vote is tied
 * (two or more options share the top count). "Tied" is a view, not an outcome.
 */
export function view(gate, holders) {
  const counts = tally(gate, holderSet(holders));
  const top = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((o) => counts[o] === top);
  const tied = gate.phase === 'vote' && top > 0 && leaders.length > 1;
  return { phase: gate.phase, outcome: gate.outcome, counts, tied };
}

/**
 * When the next reminder is due, the first time after `now`: every 2 hours after a normal gate
 * opened while nobody has answered it, and every 2 hours after a vote opened.
 * A gate has no deadline. Null in the objection window and after the gate closes.
 */
export function nextReminderAt(gate, now) {
  const from = { waiting: gate.openedAt, vote: gate.voteOpenedAt }[gate.phase];
  if (from === undefined) return null;
  const done = Math.max(0, Math.floor((now - from) / REMINDER_EVERY));
  return from + (done + 1) * REMINDER_EVERY;
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

function ignored(event, why) {
  return { type: 'ignored', by: isId(event?.by) ? event.by : null, why };
}
