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
export const CRITICAL_KINDS = new Set(['deploy', 'delete-data', 'publish', 'force-push', 'role-change']);

/** The options of a critical gate. */
export const YES = 'yes';
export const NO = 'no';

/**
 * @typedef {{ option: string, at: number, via: 'discord' | 'terminal', reason?: string }} Ballot
 * @typedef {{ status: 'open' } | { status: 'approved', option: string } | { status: 'rejected' } | { status: 'withdrawn' }} Outcome
 * @typedef {{
 *   id: string, kind: string, critical: boolean, options: string[], askedBy: string, openedAt: number,
 *   phase: 'waiting' | 'window' | 'vote' | 'closed',
 *   first: { by: string, option: string, at: number } | null,
 *   voteOpenedAt: number | null,
 *   ballots: Record<string, Ballot>,
 *   change: { add?: string, remove?: string } | null,
 *   outcome: Outcome,
 * }} Gate
 * @typedef {{ type: 'press', by: string, option: string, at: number, via?: 'discord' | 'terminal', reason?: string }
 *   | { type: 'object', by: string, at: number }
 *   | { type: 'withdraw', by: string, at: number }
 *   | { type: 'tick', at: number }} Event
 * @typedef {{ type: 'answer', option: string, by: string }
 *   | { type: 'vote-opened', by: string }
 *   | { type: 'closed', outcome: Outcome }
 *   | { type: 'holders', holders: string[] }
 *   | { type: 'ignored', by: string, why: 'not-holder' | 'terminal-on-critical' | 'not-asker' | 'unknown-option' | 'closed' }} Effect
 */

/**
 * Open a gate. A critical gate is a vote from the start, with the options yes and no.
 * A role-change gate carries the change: { add: id } or { remove: id }.
 * @returns {Gate}
 */
export function openGate({ id, kind, options, askedBy, at, change = null }) {
  const critical = CRITICAL_KINDS.has(kind);
  return {
    id, kind, critical, askedBy, openedAt: at, change,
    options: critical ? [YES, NO] : options,
    phase: critical ? 'vote' : 'waiting',
    first: null,
    voteOpenedAt: critical ? at : null,
    ballots: {},
    outcome: { status: 'open' },
  };
}

/**
 * Apply one event to a gate.
 * @param {Gate} gate
 * @param {Event} event
 * @param {string[]} holders
 * @returns {{ gate: Gate, effects: Effect[] }}
 */
export function step(gate, event, holders) {
  const settled = settle(gate, event.at);
  if (settled.gate.phase === 'closed') {
    return event.type === 'tick' ? settled : { gate: settled.gate, effects: [...settled.effects, ignored(event, 'closed')] };
  }
  const next = apply(settled.gate, event, holders);
  return { gate: next.gate, effects: [...settled.effects, ...next.effects] };
}

/** Close a normal gate whose objection window ended with no objection. */
function settle(gate, at) {
  if (gate.phase !== 'window' || at < gate.first.at + OBJECTION_WINDOW) return { gate, effects: [] };
  return close(gate, { status: 'approved', option: gate.first.option }, []);
}

function apply(gate, event, holders) {
  if (event.type === 'tick') return { gate, effects: [] };
  if (event.type === 'withdraw') {
    return event.by === gate.askedBy
      ? close(gate, { status: 'withdrawn' }, holders)
      : { gate, effects: [ignored(event, 'not-asker')] };
  }
  if (!holders.includes(event.by)) return { gate, effects: [ignored(event, 'not-holder')] };

  if (event.type === 'object') {
    return gate.phase === 'window' ? openVote(gate, event) : { gate, effects: [] };
  }

  // A press.
  if (event.via === 'terminal' && gate.critical) return { gate, effects: [ignored(event, 'terminal-on-critical')] };
  if (!gate.options.includes(event.option)) return { gate, effects: [ignored(event, 'unknown-option')] };
  const ballot = { option: event.option, at: event.at, via: event.via ?? 'discord' };
  if (event.reason !== undefined) ballot.reason = cleanReason(event.reason);
  const voted = { ...gate, ballots: { ...gate.ballots, [event.by]: ballot } };

  if (gate.phase === 'waiting') {
    const first = { by: event.by, option: event.option, at: event.at };
    return { gate: { ...voted, phase: 'window', first }, effects: [{ type: 'answer', option: event.option, by: event.by }] };
  }
  if (gate.phase === 'window') {
    if (event.option === gate.first.option) return { gate: voted, effects: [] };
    const opened = openVote(voted, event);
    return withResult(opened.gate, opened.effects, holders);
  }
  return withResult(voted, [], holders);
}

function openVote(gate, event) {
  return { gate: { ...gate, phase: 'vote', voteOpenedAt: event.at }, effects: [{ type: 'vote-opened', by: event.by }] };
}

/** Close the vote when its rule is met; otherwise keep it open. */
function withResult(gate, effects, holders) {
  const outcome = result(gate, holders);
  return outcome.status === 'open' ? { gate, effects } : close(gate, outcome, holders, effects);
}

/**
 * The rule of an open vote, on the last ballot of each current holder.
 * Critical: every holder says yes to approve; one no rejects.
 * Normal: a strict majority of the holders on one option.
 * @returns {Outcome}
 */
export function result(gate, holders) {
  const options = holders.map((h) => gate.ballots[h]?.option).filter(Boolean);
  if (gate.critical) {
    if (options.includes(NO)) return { status: 'rejected' };
    return options.length === holders.length ? { status: 'approved', option: YES } : { status: 'open' };
  }
  for (const [option, count] of Object.entries(tally(gate, holders))) {
    if (count > holders.length / 2) return { status: 'approved', option };
  }
  return { status: 'open' };
}

function close(gate, outcome, holders, effects = []) {
  const out = [...effects, { type: 'closed', outcome }];
  if (gate.kind === 'role-change' && outcome.status === 'approved') {
    out.push({ type: 'holders', holders: changeHolders(holders, gate.change) });
  }
  return { gate: { ...gate, phase: 'closed', outcome }, effects: out };
}

/** The holder list after an approved role change. */
function changeHolders(holders, { add, remove } = {}) {
  const kept = holders.filter((h) => h !== remove);
  return add && !kept.includes(add) ? [...kept, add] : kept;
}

/** Count of the last ballot of each current holder, by option. */
function tally(gate, holders) {
  const counts = {};
  for (const h of holders) {
    const option = gate.ballots[h]?.option;
    if (option) counts[option] = (counts[option] ?? 0) + 1;
  }
  return counts;
}

/**
 * What a card shows for a gate: the counts, and whether an open vote is tied
 * (two or more options share the top count). "Tied" is a view, not an outcome.
 */
export function view(gate, holders) {
  const counts = tally(gate, holders);
  const top = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((o) => counts[o] === top);
  const tied = gate.phase === 'vote' && top > 0 && leaders.length > 1;
  return { phase: gate.phase, outcome: gate.outcome, counts, tied };
}

/**
 * When the next reminder is due for an open vote: every 2 hours after the vote opened,
 * the first time after `now`. A vote has no deadline. Null when no vote is open.
 */
export function nextReminderAt(gate, now) {
  if (gate.phase !== 'vote') return null;
  const done = Math.max(0, Math.floor((now - gate.voteOpenedAt) / REMINDER_EVERY));
  return gate.voteOpenedAt + (done + 1) * REMINDER_EVERY;
}

/**
 * Clean a ballot reason: remove control characters, newlines, text-direction marks and < > `,
 * then cut to 500 characters (code points, so no emoji is split).
 */
export function cleanReason(text) {
  const clean = String(text).replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069<>`]/gu, '');
  return Array.from(clean).slice(0, REASON_MAX).join('');
}

function ignored(event, why) {
  return { type: 'ignored', by: event.by, why };
}
