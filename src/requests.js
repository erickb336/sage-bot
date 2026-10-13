// The requests of the sage-leads (T72): a sage-lead asks for a feature, and Erick approves or declines it. An approved request
// becomes one sage task through the state tool (`addTask`), never by a write to the logbook. This file has the record and its
// transitions (pure: no I/O), and the I/O layer on the requests file that the terminal (scripts/requests.mjs) and the bridge (T72
// PR 3) both call: add, approve, decline, withdraw, the Discord fields, and the reconcile step. Each I/O function takes the config.
// The requests file is <statePath>.requests, beside the thread map and safe like it: 0600, written whole, read with no symlink, and
// every read-modify-write under withLock. `next` counts the ids up, and an id is never reused: no request ever leaves the file.
// Each new or changed record is checked as the loader checks it before it is saved (F-T72-20), so no write makes the file unreadable.
// The text of a request comes from Discord and is untrusted. sage reads only titleForSage and textForSage (forModel, made once at
// create); people read the title and the text through forTerminal at the terminal, and through the card cleaner on Discord.
import { killPathOf, linkOff } from './audit.js';
import { forModel, forTerminal } from './clean.js';
import { loadProjects } from './projects.js';
import { ADD_TASK_MS, sageTool } from './sage.js';
import { alive, PROJECT_NAME, readOwn, startOf, withLock, writeWhole } from './state.js';

/** The requests file of a config: `<statePath>.requests`. */
export const requestsPathOf = ({ statePath }) => `${statePath}.requests`;

export const REQUEST_ID = /^RQ[1-9]\d{0,8}$/;
/** The lengths in characters, as the Discord form enforces them: title, text, and the reason of a decline. */
export const LIMITS = { title: [4, 70], text: [10, 500], reason: [0, 300] };
/** Each status of the file, and its word for people: at the terminal and on the card. */
export const STATUS_WORDS = { pending: 'waiting', approving: 'being approved', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn' };
const STATUSES = Object.keys(STATUS_WORDS);
const DECIDED = ['approved', 'declined', 'withdrawn'];
const SNOWFLAKE = /^\d{17,20}$/;
/** The keys of every record, in the order the file holds them. `claim` is set only while approving. */
const KEYS = ['id', 'project', 'folder', 'title', 'text', 'titleForSage', 'textForSage', 'designQuestions', 'requester', 'requesterName',
  'status', 'claim', 'createdAt', 'decidedAt', 'decidedBy', 'via', 'reason', 'task', 'channel', 'line', 'card', 'thread', 'shown'];
/** The Discord fields that the bridge sets with setDiscord. */
const DISCORD = ['line', 'card', 'thread', 'shown'];

/** A refusal for a person: one line that ends "Nothing changed." or with the next step. The file is as it was. */
export class Refused extends Error {}
const refuse = (text) => { throw new Refused(text); };

const length = (s) => Array.from(s).length;
const two = (n) => String(n).padStart(2, '0');
/** A time for a list: the local time of this computer (Erick's), to the minute, with its zone: "2026-10-12 21:26 EDT". */
export function whenLocal(at) {
  const d = new Date(at);
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName').value;
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} ${zone}`;
}
/**
 * A time for show and the errors: the local time with UTC beside it, "2026-10-12 21:26 EDT (01:26 UTC)"; with the UTC date too when
 * it is another day there, "2026-10-12 22:00 EDT (2026-10-13 02:00 UTC)"; one time when the zone is UTC.
 */
export function when(at) {
  const local = whenLocal(at);
  if (local.endsWith(' UTC')) return local;
  const utc = new Date(at).toISOString(); // 2026-10-13T02:00:00.000Z
  return `${local} (${local.startsWith(utc.slice(0, 10)) ? '' : `${utc.slice(0, 10)} `}${utc.slice(11, 16)} UTC)`;
}
/**
 * How long after its start a claim whose approve no longer runs may be released (F-T72-8): the state tool that the claim started can still
 * run after a lone kill of its process, up to ADD_TASK_MS, so a release before then can lead to a second task. 2 minutes in all.
 */
export const RETRY_AFTER = ADD_TASK_MS + 60_000;
/** Since when a claim runs, and when a person can approve again if its run crashed. */
export const claimed = (c) => `since ${when(c.at)}. If it crashed, run approve again after ${when(c.at + RETRY_AFTER)}.`;

/** Whether a record is one that this module writes: its keys, their types, and the fields that its status sets. */
function isRequest(r) {
  const text = (x) => typeof x === 'string';
  const time = (x) => Number.isSafeInteger(x) && Math.abs(x) <= 8.64e15; // the range of a Date
  const opt = (x, ok) => x === null || ok(x);
  const id = (x) => text(x) && SNOWFLAKE.test(x);
  const by = (x) => x === 'owner' || id(x); // Erick, or a Discord id
  if (!r || typeof r !== 'object' || Object.keys(r).join() !== KEYS.join()) return false;
  const decided = DECIDED.includes(r.status);
  const c = r.claim;
  return text(r.id) && REQUEST_ID.test(r.id) && text(r.project) && PROJECT_NAME.test(r.project) && text(r.folder) && r.folder.startsWith('/')
    && [r.title, r.text, r.titleForSage, r.textForSage, r.requesterName].every(text) && length(r.requesterName) >= 1 && length(r.requesterName) <= 100
    && ['team', 'owner'].includes(r.designQuestions) && id(r.requester) && STATUSES.includes(r.status) && time(r.createdAt)
    && (r.status === 'approving'
      ? !!c && Object.keys(c).sort().join() === 'at,by,pid,start,via' && by(c.by) && ['discord', 'terminal'].includes(c.via) && Number.isSafeInteger(c.pid) && text(c.start) && time(c.at)
      : c === null)
    && (decided ? time(r.decidedAt) && by(r.decidedBy) && ['discord', 'terminal'].includes(r.via) : r.decidedAt === null && r.decidedBy === null && r.via === null)
    && (r.status === 'approved' ? text(r.task) && /^T\d{1,9}$/.test(r.task) : r.task === null)
    && (r.status === 'declined' ? opt(r.reason, text) : r.reason === null)
    && [r.channel, r.line, r.card, r.thread].every((x) => opt(x, id)) && opt(r.shown, (s) => STATUSES.includes(s));
}
/** The record, when the loader takes it back; else a TypeError, before anything is written (F-T72-20). */
const checked = (r) => {
  if (!isRequest(r)) throw new TypeError(`the record of ${r?.id} has a field of the wrong kind, so it was not saved. Nothing changed.`);
  return r;
};

/**
 * A new request, and the file with it (pure). Refuses a field out of its limits, and a title or text with nothing that sage can read.
 * @param {{ next: number, requests: object[] }} file
 * @param {{ project: string, folder: string, title: string, text: string, designQuestions: 'team' | 'owner', requester: string,
 *   requesterName: string, channel?: string | null }} f
 * @param {number} at
 */
export function newRequest(file, f, at) {
  if (!REQUEST_ID.test(`RQ${file.next}`)) refuse(`the requests file has used every request id (RQ1 to RQ999999999). Nothing changed.`);
  for (const k of ['title', 'text']) {
    const [min, max] = LIMITS[k];
    if (typeof f[k] !== 'string' || length(f[k]) < min || length(f[k]) > max) refuse(`the ${k} must have ${min} to ${max} characters. Nothing changed.`);
  }
  const [titleForSage, textForSage] = [forModel(f.title), forModel(f.text)];
  if (!titleForSage) refuse('the title has nothing that sage can read: it needs letters or digits. Nothing changed.');
  if (!textForSage) refuse('the text has nothing that sage can read: it needs letters or digits. Nothing changed.');
  const request = checked({
    id: `RQ${file.next}`, project: f.project, folder: f.folder, title: f.title, text: f.text, titleForSage, textForSage,
    designQuestions: f.designQuestions, requester: f.requester, requesterName: f.requesterName, status: 'pending', claim: null,
    createdAt: at, decidedAt: null, decidedBy: null, via: null, reason: null, task: null,
    channel: f.channel ?? null, line: null, card: null, thread: null, shown: null,
  });
  return { file: { next: file.next + 1, requests: [...file.requests, request] }, request };
}

/** Which status each event leaves from, and the status it goes to. Every other pair is refused. */
const MOVES = {
  claim: ['pending', 'approving'], // step 1 of an approval: { claim: { by, via, pid, start, at } }
  approve: ['approving', 'approved'], // step 3: { claim, task, at }, with the claim of step 1
  release: ['approving', 'pending'], // the task was not added: { claim }
  decline: ['pending', 'declined'], // { by, via, at, reason }
  withdraw: ['pending', 'withdrawn'], // only the requester: { by, at }
};
const sameClaim = (a, b) => !!a && !!b && a.pid === b.pid && a.start === b.start && a.at === b.at;

/**
 * The request after one event (pure). Throws Refused, with the line for a person, for an event that the request's status does not take,
 * and a TypeError for an event whose fields the file cannot hold.
 * @param {object} r  @param {{ type: keyof MOVES } & Record<string, any>} e
 */
export function step(r, e) {
  const [from, to] = MOVES[e.type] ?? (() => { throw new TypeError(`no request event ${e.type}`); })();
  if (r.status !== from) {
    if (r.status === 'approving') refuse(`${r.id} is already being approved ${claimed(r.claim)} Nothing changed.`);
    if (DECIDED.includes(r.status)) refuse(`${r.id} was already ${r.status} at ${when(r.decidedAt)} (${r.via})${r.task ? `: sage task ${r.task}` : ''}. Nothing changed.`);
    refuse(`${r.id} is not being approved. Nothing changed.`);
  }
  if (from === 'approving' && !sameClaim(r.claim, e.claim)) refuse(`${r.id} is being approved by another run. Nothing changed.`);
  if (e.type === 'withdraw' && e.by !== r.requester) refuse(`only the sage-lead who sent ${r.id} can withdraw it. Nothing changed.`);
  if (e.type === 'claim') return checked({ ...r, status: to, claim: { ...e.claim } });
  if (e.type === 'release') return checked({ ...r, status: to, claim: null });
  if (e.type === 'approve') return checked({ ...r, status: to, claim: null, task: e.task, decidedAt: e.at, decidedBy: r.claim.by, via: r.claim.via });
  const reason = e.type === 'decline' ? (e.reason ?? '').trim() : '';
  if (length(reason) > LIMITS.reason[1]) refuse(`a reason has at most ${LIMITS.reason[1]} characters. Nothing changed.`);
  return checked({ ...r, status: to, decidedAt: e.at, decidedBy: e.by, via: e.type === 'withdraw' ? 'discord' : e.via, reason: reason || null });
}

/**
 * The requests file: { next, requests }, or { next: 1, requests: [] } when there is none. Throws for a file that is not this user's
 * 0600 file, a symlink, bad JSON, a record that this module did not write, two records with one id, or a `next` that an id has reached.
 */
export function loadRequests(path) {
  const text = readOwn(path, 'requests file');
  if (text === undefined) return { next: 1, requests: [] };
  const bad = new TypeError(`the requests file ${path} is not a version 1 requests file that sage-bot wrote. Nothing changed.`);
  let data;
  try { data = JSON.parse(text); } catch { throw bad; }
  if (!data || Object.keys(data).sort().join() !== 'next,requests,version' || data.version !== 1 || !Number.isSafeInteger(data.next) || data.next < 1
    || !Array.isArray(data.requests) || !data.requests.every(isRequest)) throw bad;
  const ids = data.requests.map((r) => Number(r.id.slice(2)));
  if (new Set(ids).size !== ids.length || ids.some((n) => n >= data.next)) throw bad;
  return { next: data.next, requests: data.requests };
}
const save = (path, file) => writeWhole(path, `${JSON.stringify({ version: 1, next: file.next, requests: file.requests })}\n`);

/** The request with this id, or a refusal that names the ids there are. */
export function find(file, id) {
  return file.requests.find((r) => r.id === id) ?? refuse(`there is no request ${id}${file.requests.length ? ` (the latest: ${file.requests.slice(-5).map((r) => r.id).join(', ')})` : ''}. Nothing changed.`);
}

/** Adds a request under the lock (newRequest), and returns it. */
export function addRequest(config, fields, at = Date.now()) {
  const path = requestsPathOf(config);
  return withLock(path, () => {
    const { file, request } = newRequest(loadRequests(path), fields, at);
    save(path, file);
    return request;
  });
}

/** Changes one request under the lock with `change` (a checked record), saves the file, and returns the request after it. */
const change = (path, id, how) => withLock(path, () => {
  const file = loadRequests(path);
  const r = how(find(file, id));
  save(path, { ...file, requests: file.requests.map((x) => (x.id === id ? r : x)) });
  return r;
});
const update = (path, id, event) => change(path, id, (r) => step(r, event));

/**
 * Sets the Discord fields of a request (line, card, thread, shown) under the lock; the status stays. Returns the request after it.
 * @param {{ line?: string | null, card?: string | null, thread?: string | null, shown?: string | null }} fields
 */
export function setDiscord(config, id, fields) {
  if (!Object.keys(fields).every((k) => DISCORD.includes(k))) throw new TypeError(`setDiscord sets only ${DISCORD.join(', ')}`);
  return change(requestsPathOf(config), id, (r) => checked({ ...r, ...fields }));
}

/**
 * The state tool of a request's project. A request names its project by name and folder (loadProjects), as a mark does (G45 A): a name
 * that names another folder now is not its project.
 */
export function toolOf(config, r) {
  let projects;
  try { projects = loadProjects(config); } catch (e) {
    refuse(`${String(e?.message ?? e).replace(/ Nothing (was started|changed)\.$/, '').replace(/\.$/, '')}. Nothing changed.`);
  }
  const p = projects.find((x) => x.name === r.project && x.project === r.folder);
  if (!p) refuse(`the project ${r.project} (${r.folder}) is not in the config. ${r.status === 'pending' ? `Add it back, or decline ${r.id}.` : 'Add it back, then run the command again.'}`);
  return sageTool(p);
}

/** The marker of a request's task: its title starts with it. */
const marker = (id) => `${id}: `;
/** The id of the task of a request in the logbook: the task whose title is exactly `<id>: <titleForSage>` (F-T72-9), or null. */
const taskOf = async (tool, r) => (await tool.tasks()).find((t) => t.title === `${marker(r.id)}${r.titleForSage}`)?.id ?? null;
/** The claims whose approve runs in this process now, by `<path> <id> <claim time>` (F-T72-24). */
const approving = new Set();
const claimKey = (path, r) => `${path} ${r.id} ${r.claim.at}`;
/**
 * Whether the approve of a claim still runs: in this process, only while its approve is in `approving` (a long-lived bridge outlives a
 * failed approve); in another, while that process lives, with the start time of the claim (a pid can be reused).
 */
const runs = (path, r) => (r.claim.pid === process.pid && r.claim.start === startOf(process.pid)
  ? approving.has(claimKey(path, r))
  : alive(r.claim.pid) && startOf(r.claim.pid) === r.claim.start);

/**
 * Ends one claim by what the logbook holds: a task of the request means approved with it; none means pending again, but only when
 * `release` is true. Otherwise the request stays as it is.
 */
async function settle(path, r, tool, at, release = true) {
  const task = await taskOf(tool, r);
  if (!task && !release) return r;
  return update(path, r.id, task ? { type: 'approve', claim: r.claim, task, at } : { type: 'release', claim: r.claim });
}

/**
 * The reconcile step: a request whose claim's approve no longer runs (runs) is settled by the logbook of its project. With no task there, it is
 * released only RETRY_AFTER after the claim: until then its state tool can still add the task. Any other request stays.
 * `tool` is the state tool, by default the one of the request's project (toolOf). When another run settled the claim first, the
 * request as that run left it. Returns the request as it is now.
 * @param {{ at?: number, tool?: { tasks: Function } }} [o]
 */
export async function reconcile(config, id, { at = Date.now(), tool } = {}) {
  const path = requestsPathOf(config);
  const r = find(loadRequests(path), id);
  if (r.status !== 'approving' || runs(path, r)) return r;
  const t = tool ?? toolOf(config, r);
  try {
    return await settle(path, r, t, at, at - r.claim.at > RETRY_AFTER);
  } catch (e) {
    if (e instanceof Refused) return find(loadRequests(path), id); // another run settled it (F-T72-11)
    throw e;
  }
}

/**
 * Approves a request in three steps, so that a crash at any point leaves a state that reconcile finishes, and never two tasks:
 * 1. under the lock, pending → approving with a claim of this process;
 * 2. with no lock, `task add --title=<id>: <titleForSage> --size=<size>` through the state tool, stopped after ADD_TASK_MS;
 * 3. under the lock, approving → approved with the task id.
 * Refused while the link from Discord to sage is off. Before step 1, a task whose title starts with "<id>: " refuses: it is not this
 * request's, or the file is not the one that made it. When step 2 fails, the logbook decides (settle): the tool can fail after it
 * wrote the task. When the logbook cannot be read either, the claim stays, and a run after RETRY_AFTER reconciles it.
 * @param {{ size?: 'small' | 'large', by: string, via: 'discord' | 'terminal', now?: () => number, tool?: { addTask: Function, tasks: Function },
 *   restore?: string }} o  `tool` is the state tool, by default toolOf; `restore` is the command that restores the link, for its refusal.
 */
export async function approve(config, id, { size = 'large', by, via, now = Date.now, tool, restore = 'node scripts/leads.mjs restore' }) {
  const refuseIfOff = () => { if (linkOff(killPathOf(config))) refuse(`the link from Discord to sage is off, so ${id} cannot be approved. Restore the link first: ${restore}. Nothing changed.`); };
  refuseIfOff();
  const path = requestsPathOf(config);
  const before = await reconcile(config, id, { at: now(), tool });
  tool ??= toolOf(config, before);
  if (before.status === 'pending') {
    const other = (await tool.tasks()).find((t) => t.title.startsWith(marker(id)));
    if (other) refuse(`sage task ${other.id} in ${before.project} already starts with "${marker(id)}". ${id} was not approved. Decline ${id}, or rename or remove ${other.id} in sage, then approve again.`);
  }
  const claim = { by, via, pid: process.pid, start: startOf(process.pid), at: now() };
  // The link again, under the lock of the claim: it can go off while the logbook is read.
  const r = change(path, id, (x) => (refuseIfOff(), step(x, { type: 'claim', claim })));
  approving.add(claimKey(path, r));
  try {
    return await addAndRecord(path, r, tool, size, now);
  } finally { approving.delete(claimKey(path, r)); }
}

/** Steps 2 and 3 of approve, for the claim of step 1 in `r`. */
async function addAndRecord(path, r, tool, size, now) {
  const { id, claim } = r;
  let task;
  try {
    task = await tool.addTask({ title: `${marker(id)}${r.titleForSage}`, size });
  } catch (e) {
    const why = forTerminal(e?.message ?? e);
    let after;
    try { after = await settle(path, r, tool, now()); } catch {
      throw new Error(`could not add the task of ${id} (${why}), and could not read the logbook. ${id} stays being approved ${claimed(claim)}`);
    }
    if (after.status === 'approved') return after;
    throw new Error(`could not add the task of ${id}: ${why}. ${id} still waits. Fix the cause, then run approve again.`);
  }
  try {
    return update(path, id, { type: 'approve', claim, task, at: now() });
  } catch (e) {
    throw new Error(`added sage task ${task} to ${r.project}, but could not record it (${forTerminal(e?.message ?? e).replace(/ Nothing changed\.$/, '')}). ${id} settles on the next command.`);
  }
}

/** Declines a request after the reconcile step. `reason` is for people only. Returns the request after it. */
export async function decline(config, id, { by, via, reason, at = Date.now() }) {
  if (reason != null && typeof reason !== 'string') throw new TypeError(`reason must be text, not ${typeof reason}. Nothing changed.`);
  await reconcile(config, id, { at });
  return update(requestsPathOf(config), id, { type: 'decline', by, via, at, reason });
}

/** Withdraws a request after the reconcile step: only its requester, on Discord. Returns the request after it. */
export async function withdraw(config, id, { by, at = Date.now() }) {
  await reconcile(config, id, { at });
  return update(requestsPathOf(config), id, { type: 'withdraw', by, at });
}
