// The vote rules of the sage bridge, as data plus pure functions.
// No clock, no network, no Discord: every event carries its own time `at` (ms).
//
//   const gate = openGate({ id, kind: 'single', options, askedBy, at });
//   const gate = openGate({ id, kind: 'batch', parts: [options, options, ...], askedBy, at, limit });
//   ({ gate, effects } = step(gate, event, holders, ownerId));
//
// `holders` are the Discord user ids that may answer and vote (the crew), as any iterable of strings
// (an Array, a Set, or a Map's keys()); anything else counts as empty. `ownerId` is the bot owner's user id:
// only that id ends a vote early or breaks a tie, never a role (T232, C1). Anyone else counts for nothing.
// See the README for the full API.
// The bridge sends a tick at `gate.endsAt` so that a batch vote ends on time.
// A gate is deep-frozen plain JSON of a fixed depth: save it as it is, and check it with parseGate when you load it.
// Ballot reasons are stored as typed (cut to 500 code points): they are untrusted text for the bridge to clean.
import { isOwner } from './crew.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** The time limit of a batch vote in the home channel or a session thread, and of a gate saved before T245 (it has no `limit`). */
export const BATCH_LIMIT = 30 * MINUTE;
/** The time limit of a batch vote in a task thread (T245): the crew of the task decides fast. */
export const THREAD_LIMIT = 10 * MINUTE;
/** The time limits that a gate may store: an allow-list, so parseGate takes no other. */
const LIMITS = [THREAD_LIMIT, BATCH_LIMIT];
/** The time limit of a batch gate: its stored `limit`, or BATCH_LIMIT for a gate saved before T245. */
export const limitOf = (gate) => gate.limit ?? BATCH_LIMIT;
export const REMINDER_EVERY = 2 * HOUR;
export const REASON_MAX = 500;
/** The most options of a single gate or of one batch part: Discord holds 5 buttons in a row, and a card uses one row per part (F-T28-18). */
export const MAX_OPTIONS = 5;
/** The most ballots on one part: one per person, so a part never grows past this many voters, whatever the holder list holds (F-T28-11). */
export const MAX_BALLOTS = 1000;

const KINDS = new Set(['single', 'batch']);
const EVENT_TYPES = new Set(['press', 'end', 'tiebreak', 'withdraw', 'tick']);
const VIAS = new Set(['discord', 'terminal']);
const OPEN = { status: 'open' };
const isId = (x) => typeof x === 'string' && x !== '';
/** Freeze a value and everything in it; a frozen part is skipped, as it is frozen all through. */
const freeze = (x) => {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
/** A ballot reason as B1 stores it: lone surrogates become U+FFFD, then a cut to REASON_MAX code points. */
const reasonOf = (text) => Array.from(text.toWellFormed()).slice(0, REASON_MAX).join('');
const isOptions = (x) => Array.isArray(x) && x.length > 0 && x.length <= MAX_OPTIONS && x.every(isId) && new Set(x).size === x.length;

/**
 * @typedef {{ option: string, at: number, via: 'discord' | 'terminal', reason?: string }} Ballot
 * @typedef {{ status: 'open' } | { status: 'decided', option: string, how: 'votes' }
 *   | { status: 'decided', option: string, how: 'lead-tiebreak', by?: string, at?: number }} PartOutcome
 *   how 'lead-tiebreak': a tie broken on Discord (the name is kept for the saved gates); by and at: who broke it and when (missing in a gate saved before T39)
 * @typedef {{ options: string[], ballots: [string, Ballot][], outcome: PartOutcome, tied?: string[] }} Part  read ballots with ballotsOf
 * @typedef {{ id: string, kind: 'single', askedBy: string, openedAt: number, lastAt: number,
 *   phase: 'open' | 'closed', options: string[],
 *   outcome: { status: 'open' } | { status: 'answered', option: string, by: string, via: 'discord' | 'terminal' }
 *     | { status: 'withdrawn' } }} SingleGate
 * @typedef {{ id: string, kind: 'batch', askedBy: string, openedAt: number, lastAt: number,
 *   phase: 'voting' | 'tied' | 'closed', limit?: number, endsAt: number, votingEndedAt: number | null,
 *   endedBy?: string | null, parts: Part[],
 *   outcome: { status: 'open' } | { status: 'decided' } | { status: 'withdrawn' } }} BatchGate  endedBy: after the vote ended, the person who
 *   ended it early, or null at the time limit (missing in a gate saved before T39); limit: THREAD_LIMIT or BATCH_LIMIT (missing in a
 *   gate saved before T245: then BATCH_LIMIT), and endsAt is openedAt + limit
 * @typedef {SingleGate | BatchGate} Gate
 * @typedef {{ type: 'press', by: string, option: string, part?: number, at: number, via: 'discord' | 'terminal', reason?: string }
 *   | { type: 'end', by: string, at: number, via: 'discord' | 'terminal' }
 *   | { type: 'tiebreak', by: string, part: number, option: string, at: number, via: 'discord' | 'terminal' }
 *   | { type: 'withdraw', by: string, at: number }
 *   | { type: 'tick', at: number }} Event
 * @typedef {'not-holder' | 'not-owner' | 'owner-needs-discord' | 'not-asker' | 'unknown-option' | 'unknown-part'
 *   | 'wrong-kind' | 'not-tied' | 'not-tied-option' | 'closed' | 'full' | 'bad-event' | 'bad-time' | 'out-of-order'} Why
 * @typedef {{ type: 'vote-ended', by: string | null }
 *   | { type: 'decided', part: number, option: string, how: 'votes' | 'lead-tiebreak' }
 *   | { type: 'closed', outcome: Gate['outcome'] }
 *   | { type: 'ignored', by: string | null, why: Why }} Effect
 */

/**
 * Open a gate. A single gate has one list of options; a batch has parts, each a list of options.
 * Throws on a gate it refuses: a kind other than single or batch, no id or askedBy,
 * a time that is not a safe integer (ms), a batch whose end (`at` + `limit`) is not a safe integer, a batch `limit` other than
 * THREAD_LIMIT or BATCH_LIMIT (the default), or empty or duplicate options or parts, or more than MAX_OPTIONS options in one list.
 * @returns {Gate}
 */
export function openGate({ id, kind, options, parts, askedBy, at, limit = BATCH_LIMIT }) {
  if (!KINDS.has(kind)) throw new RangeError('openGate: unknown gate kind');
  if (!isId(id) || !isId(askedBy)) throw new TypeError('openGate: a gate needs an id and askedBy');
  if (!Number.isSafeInteger(at)) throw new RangeError('openGate: a gate needs a time in whole ms');
  const base = { id, kind, askedBy, openedAt: at, lastAt: at, outcome: OPEN };
  if (kind === 'single') {
    if (!isOptions(options)) throw new TypeError('openGate: a single gate needs a non-empty list of unique options');
    return freeze({ ...base, phase: 'open', options: [...options] });
  }
  if (!LIMITS.includes(limit)) throw new RangeError('openGate: a batch limit is THREAD_LIMIT or BATCH_LIMIT');
  if (!Number.isSafeInteger(at + limit)) throw new RangeError(`openGate: a batch needs a time whose end, ${limit / MINUTE} minutes later, is in whole ms`);
  if (!(Array.isArray(parts) && parts.length > 0 && parts.every(isOptions))) {
    throw new TypeError('openGate: a batch needs a non-empty list of parts, each with a non-empty list of unique options');
  }
  return freeze({
    ...base, phase: 'voting', limit, endsAt: at + limit, votingEndedAt: null,
    parts: parts.map((opts) => ({ options: [...opts], ballots: [], outcome: OPEN })),
  });
}

/**
 * Apply one event to a gate. Never throws for an odd event: it is ignored, with the reason.
 * Throws a TypeError for a missing or wrong gate (see parseGate).
 * @param {Gate} gate
 * @param {Event} event
 * @param {Iterable<string>} holders
 * @param {string} ownerId
 * @returns {{ gate: Gate, effects: Effect[] }}
 */
export function step(gate, event, holders, ownerId) {
  checkGate(gate, 'step');
  const why = refusal(gate, event);
  if (why) return { gate, effects: [ignored(event, why)] };
  const people = { holders: idSet(holders), ownerId };
  // A batch vote ends at its time limit, before the event that reaches it applies (also a withdraw).
  const settled = gate.phase === 'voting' && event.at >= gate.endsAt
    ? endVoting({ ...gate, lastAt: gate.endsAt }, null, people.holders, gate.endsAt)
    : { gate, effects: [] };
  const next = event.type === 'tick' ? { gate: settled.gate, effects: [] } : apply(settled.gate, event, people);
  // The gate's time moves on only with an event that applies; a refused event leaves it as it was.
  const applied = !next.effects.some((e) => e.type === 'ignored');
  // A step that ends withdrawn reports only its close: nothing that the time limit settled on the way counts.
  const withdrawn = next.gate.outcome.status === 'withdrawn';
  return {
    gate: freeze(applied ? { ...next.gate, lastAt: event.at } : next.gate),
    effects: withdrawn ? next.effects : [...settled.effects, ...next.effects],
  };
}

/** Why an event is refused before it touches the gate, or null. Time never goes back. */
function refusal(gate, event) {
  if (typeof event !== 'object' || event === null || !EVENT_TYPES.has(event.type)) return 'bad-event';
  if (!Number.isSafeInteger(event.at)) return 'bad-time';
  if (event.at < gate.lastAt) return 'out-of-order';
  if (event.type === 'tick') return null;
  if (!isId(event.by)) return 'bad-event';
  if (event.type === 'withdraw') return null;
  if (!VIAS.has(event.via)) return 'bad-event';
  if (event.type === 'end') return null;
  const reasonOk = event.reason === undefined || typeof event.reason === 'string';
  return typeof event.option === 'string' && reasonOk ? null : 'bad-event';
}

/** Any iterable of ids as a set; a Set is used as it is. A string or a non-iterable counts as empty. */
function idSet(ids) {
  if (ids instanceof Set) return ids;
  return typeof ids !== 'string' && typeof ids?.[Symbol.iterator] === 'function' ? new Set(ids) : new Set();
}

function apply(gate, event, { holders, ownerId }) {
  // An answer or a vote needs the crew, whatever the phase; an end or a tie-break needs the owner's id, with or without the role
  // (C1); a withdraw needs only the asker.
  if (event.type === 'press' && !holders.has(event.by)) return ignore(gate, event, 'not-holder');
  if ((event.type === 'end' || event.type === 'tiebreak') && !isOwner(event.by, ownerId)) return ignore(gate, event, 'not-owner');
  if (gate.phase === 'closed') return ignore(gate, event, 'closed');
  if (event.type === 'withdraw') {
    return event.by === gate.askedBy ? withdraw(gate) : ignore(gate, event, 'not-asker');
  }
  if (event.type === 'press') return gate.kind === 'single' ? answer(gate, event) : vote(gate, event);
  // An owner action: end or tiebreak. Only on a batch, only from Discord (at the terminal the owner answers instead).
  if (gate.kind !== 'batch') return ignore(gate, event, 'wrong-kind');
  if (event.via !== 'discord') return ignore(gate, event, 'owner-needs-discord');
  if (event.type === 'end') {
    return gate.phase === 'voting' ? endVoting(gate, event.by, holders, event.at) : ignore(gate, event, 'closed');
  }
  return tiebreak(gate, event);
}

/** A single gate: the first answer from a holder is final. */
function answer(gate, event) {
  if (!gate.options.includes(event.option)) return ignore(gate, event, 'unknown-option');
  return close(gate, { status: 'answered', option: event.option, by: event.by, via: event.via });
}

/** A batch ballot: the last ballot of each holder on each part counts. */
function vote(gate, event) {
  if (gate.phase !== 'voting') return ignore(gate, event, 'closed');
  const part = Number.isInteger(event.part) ? gate.parts[event.part] : undefined;
  if (!part) return ignore(gate, event, 'unknown-part');
  if (!part.options.includes(event.option)) return ignore(gate, event, 'unknown-option');
  if (part.ballots.length >= MAX_BALLOTS && !part.ballots.some(([by]) => by === event.by)) return ignore(gate, event, 'full');
  const reason = event.reason === undefined ? '' : reasonOf(event.reason);
  const ballot = { option: event.option, at: event.at, via: event.via, ...(reason && { reason }) };
  // One ballot per person: the new one replaces the person's earlier one.
  const ballots = [...part.ballots.filter(([by]) => by !== event.by), [event.by, ballot]];
  const parts = gate.parts.with(event.part, { ...part, ballots });
  return { gate: { ...gate, parts }, effects: [] };
}

/** End the batch vote: each part goes to the option with the most votes cast; a tie, or no votes, stays open. */
function endVoting(gate, by, holders, at) {
  const effects = [{ type: 'vote-ended', by }];
  const parts = gate.parts.map((part, i) => {
    const { top, tied } = leaders(part, holders);
    // With zero votes, every option is tied, also the only option of a part.
    if (top === 0 || tied.length !== 1) return { ...part, tied };
    const [option] = tied;
    effects.push({ type: 'decided', part: i, option, how: 'votes' });
    return { ...part, outcome: { status: 'decided', option, how: 'votes' } };
  });
  return finish({ ...gate, phase: 'tied', votingEndedAt: at, endedBy: by, parts }, effects);
}

/** The owner picks one option of an open part after the vote ended. */
function tiebreak(gate, event) {
  const part = Number.isInteger(event.part) ? gate.parts[event.part] : undefined;
  if (!part) return ignore(gate, event, 'unknown-part');
  if (gate.phase !== 'tied' || part.outcome.status !== 'open') return ignore(gate, event, 'not-tied');
  if (!part.options.includes(event.option)) return ignore(gate, event, 'unknown-option');
  if (!part.tied.includes(event.option)) return ignore(gate, event, 'not-tied-option');
  const parts = gate.parts.with(event.part, { ...part, outcome: { status: 'decided', option: event.option, how: 'lead-tiebreak', by: event.by, at: event.at } });
  return finish({ ...gate, parts }, [{ type: 'decided', part: event.part, option: event.option, how: 'lead-tiebreak' }]);
}

/** Close the batch when every part is decided. */
function finish(gate, effects) {
  return gate.parts.every((p) => p.outcome.status === 'decided')
    ? close(gate, { status: 'decided' }, effects)
    : { gate, effects };
}

/** The most ballots of current holders on one option, and the options with that many. */
function leaders(part, holders) {
  const counts = new Map(part.options.map((o) => [o, 0]));
  for (const [by, { option }] of ballotsOf(part)) if (holders.has(by)) counts.set(option, counts.get(option) + 1);
  const top = Math.max(...counts.values());
  return { top, tied: part.options.filter((o) => counts.get(o) === top) };
}

/**
 * The ballots that count on a part of a batch: the last ballot of each person, as a Map from id to Ballot.
 * @param {Part} part
 * @returns {Map<string, Ballot>}
 */
export function ballotsOf(part) {
  return new Map(part.ballots);
}

/** The asker cancels the gate: it closes as withdrawn, and no part of a batch stays decided. */
function withdraw(gate) {
  const parts = gate.parts?.map((part) => ({ ...part, outcome: OPEN }));
  return close(parts ? { ...gate, parts } : gate, { status: 'withdrawn' });
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
 * Check a loaded gate (for example from JSON after a restart), deep-freeze it and return it.
 * Throws a TypeError, with the reason, for anything that openGate and step could not have made.
 * @param {unknown} value
 * @returns {Gate}
 */
export function parseGate(value) {
  return freeze(checkGate(value, 'parseGate'));
}

function checkGate(gate, fn) {
  const problem = gateProblem(gate);
  if (problem) throw new TypeError(`${fn}: the first argument must be a gate from openGate or step: ${problem}`);
  return gate;
}

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
/** An object with all the `need` keys, and no keys other than those and the `may` keys. */
const keysAre = (x, need, may = []) => isObject(x) && need.every((k) => Object.hasOwn(x, k))
  && Object.keys(x).every((k) => need.includes(k) || may.includes(k));
const SINGLE_KEYS = ['id', 'kind', 'askedBy', 'openedAt', 'lastAt', 'phase', 'outcome', 'options'];
const BATCH_KEYS = [...SINGLE_KEYS.slice(0, -1), 'endsAt', 'votingEndedAt', 'parts'];

/** What is wrong with a gate, or '' when it is a gate that openGate and step could make. */
function gateProblem(g) {
  // A batch saved before T39 has no endedBy, and one saved before T245 no limit: it still loads, with the person who ended it unknown and
  // the limit BATCH_LIMIT.
  if (!keysAre(g, ...(g?.kind === 'batch' ? [BATCH_KEYS, ['endedBy', 'limit']] : [SINGLE_KEYS])) || !KINDS.has(g.kind)) return 'unknown fields or kind';
  if (!isId(g.id) || !isId(g.askedBy)) return 'no id or askedBy';
  const inTime = (t) => Number.isSafeInteger(t) && t >= g.openedAt && t <= g.lastAt;
  if (!Number.isSafeInteger(g.openedAt) || !inTime(g.lastAt)) return 'openedAt or lastAt is not a time';
  const o = g.outcome;
  const status = keysAre(o, ['status']) ? o.status : undefined;
  if (g.kind === 'single') {
    if (!isOptions(g.options)) return 'bad options';
    const answered = keysAre(o, ['status', 'option', 'by', 'via']) && o.status === 'answered'
      && g.options.includes(o.option) && isId(o.by) && VIAS.has(o.via);
    const ok = g.phase === 'open' ? status === 'open' : g.phase === 'closed' && (status === 'withdrawn' || answered);
    return ok ? '' : 'the phase and the outcome do not match';
  }
  if (g.limit !== undefined && !LIMITS.includes(g.limit)) return 'limit is not THREAD_LIMIT or BATCH_LIMIT';
  if (!Number.isSafeInteger(g.endsAt) || g.endsAt !== g.openedAt + limitOf(g)) return 'endsAt is not the limit after openedAt';
  const ended = g.votingEndedAt;
  if (ended !== null && !(inTime(ended) && ended <= g.endsAt)) return 'votingEndedAt is not a time';
  // The owner ends the vote only before the time limit; at the limit nobody ends it.
  const by = g.endedBy;
  if (by !== undefined && !(ended !== null && (ended < g.endsAt ? isId(by) : by === null))) return 'endedBy does not match votingEndedAt';
  if (!Array.isArray(g.parts) || g.parts.length === 0) return 'no parts';
  // Every ballot comes before the time limit: a ballot at or after it ends the vote first.
  const ballotTime = (t) => inTime(t) && t < g.endsAt;
  for (const part of g.parts) {
    // A tie-break comes after the vote ended, at or before the last event.
    const problem = partProblem(part, ballotTime, (t) => inTime(t) && ended !== null && t >= ended);
    if (problem) return problem;
  }
  // After the end of the vote the vote rules take no ballot (F-T35-1).
  if (ended !== null && g.parts.some((p) => p.ballots.some(([, b]) => b.at > ended))) return 'a ballot comes after the end of the vote';
  const open = g.parts.filter((p) => p.outcome.status === 'open');
  const all = open.length === g.parts.length;
  // A voting gate has seen no event at or after its time limit: such an event ends the vote.
  const ok = g.phase === 'voting' ? status === 'open' && ended === null && g.lastAt < g.endsAt && all && open.every((p) => !p.tied)
    : g.phase === 'tied' ? status === 'open' && ended !== null && open.length > 0 && open.every((p) => p.tied)
    : g.phase === 'closed' && (status === 'withdrawn' ? all : status === 'decided' && ended !== null && open.length === 0);
  return ok ? '' : 'the phase and the outcomes do not match';
}

function partProblem(part, inTime, breakTime) {
  if (!keysAre(part, ['options', 'ballots', 'outcome'], ['tied']) || !isOptions(part.options)) return 'a part is not options, ballots and outcome';
  const among = (option) => part.options.includes(option);
  if (part.tied !== undefined && !(isOptions(part.tied) && part.tied.every(among))) return 'a part has tied options that it does not have';
  // A tie is two or more options, or every option of a part with no votes: one option alone of several is a win, never a tie (F-T35-1).
  if (part.tied?.length === 1 && part.options.length > 1) return 'a part has one tied option of several';
  const o = part.outcome;
  // A part that the votes decide has one leader, so the vote rules never give it tied options (F-T35-1).
  if (o?.how === 'votes' && part.tied !== undefined) return 'a part decided by votes has tied options';
  // A tie-break saved before T39 has no by and at: it still loads, with the person unknown.
  const plain = keysAre(o, ['status', 'option', 'how']);
  const named = keysAre(o, ['status', 'option', 'how', 'by', 'at']) && isId(o.by) && breakTime(o.at);
  const decided = (plain || named) && o.status === 'decided' && among(o.option)
    && (o.how === 'votes' ? plain : o.how === 'lead-tiebreak' && part.tied?.includes(o.option));
  if (!decided && !(keysAre(o, ['status']) && o.status === 'open')) return 'a part has no valid outcome';
  if (!Array.isArray(part.ballots)) return 'a part has no ballots';
  if (part.ballots.length > MAX_BALLOTS) return 'a part has more ballots than MAX_BALLOTS';
  const seen = new Set();
  for (const entry of part.ballots) {
    const [by, b] = Array.isArray(entry) && entry.length === 2 ? entry : [];
    const reasonOk = b?.reason === undefined || (typeof b.reason === 'string' && b.reason !== '' && reasonOf(b.reason) === b.reason);
    if (!isId(by) || seen.has(by) || !keysAre(b, ['option', 'at', 'via'], ['reason']) || !among(b.option) || !inTime(b.at)
      || !VIAS.has(b.via) || !reasonOk) return 'a ballot is not one valid ballot per person';
    seen.add(by);
  }
  return '';
}

/**
 * The next reminder after `now`, or null (also for a `now` that is not a safe integer):
 * a single gate with no answer reminds the holders every 2 hours from opening;
 * a batch with tied parts after its vote ended reminds the owner every 2 hours from that end.
 * Throws a TypeError for a missing or wrong gate, as step does.
 * @returns {{ at: number, to: 'holders' | 'owner' } | null}
 */
export function nextReminderAt(gate, now) {
  let from, to;
  checkGate(gate, 'nextReminderAt');
  if (!Number.isSafeInteger(now)) return null;
  if (gate.phase === 'open') [from, to] = [gate.openedAt, 'holders'];
  else if (gate.phase === 'tied') [from, to] = [gate.votingEndedAt, 'owner'];
  else return null;
  const done = Math.max(0, Math.floor((now - from) / REMINDER_EVERY));
  return { at: from + (done + 1) * REMINDER_EVERY, to };
}
