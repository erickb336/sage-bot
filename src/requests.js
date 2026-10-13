// The requests of the sage-leads (T72): a sage-lead asks for a feature, and the owner approves or declines it. An approved request
// becomes one sage task through the state tool (`addTask`), never by a write to the logbook. This file has the record and its
// transitions (pure: no I/O), and a thin I/O layer on the requests file. The terminal side is scripts/requests.mjs; Discord comes in
// T72 PR 3.
// The requests file is <statePath>.requests, beside the thread map and safe like it: 0600, written whole, read with no symlink, and
// every read-modify-write under withLock. `next` counts the ids up, and an id is never reused: no request ever leaves the file.
// The text of a request comes from Discord and is untrusted. sage reads only titleForSage and textForSage (forModel, made once at
// create); people read the title and the text through forTerminal here, and through the card cleaner on Discord.
import { forModel, forTerminal } from './clean.js';
import { alive, PROJECT_NAME, readOwn, startOf, withLock, writeWhole } from './state.js';

/** The requests file of a config: `<statePath>.requests`. */
export const requestsPathOf = ({ statePath }) => `${statePath}.requests`;

export const REQUEST_ID = /^RQ[1-9]\d{0,8}$/;
/** The lengths in characters, as the Discord form enforces them: title, text, and the reason of a decline. */
export const LIMITS = { title: [4, 70], text: [10, 500], reason: [0, 300] };
const SNOWFLAKE = /^\d{17,20}$/;
const STATUSES = ['pending', 'approving', 'approved', 'declined', 'withdrawn'];
const DECIDED = ['approved', 'declined', 'withdrawn'];
/** The keys of every record, in the order the file holds them. `claim` is set only while approving. */
const KEYS = ['id', 'project', 'folder', 'title', 'text', 'titleForSage', 'textForSage', 'designQuestions', 'requester', 'requesterName',
  'status', 'claim', 'createdAt', 'decidedAt', 'decidedBy', 'via', 'reason', 'task', 'channel', 'line', 'card', 'thread', 'shown'];

/** A refusal for a person: one line that ends "Nothing changed." The file is as it was. */
export class Refused extends Error {}
const refuse = (text) => { throw new Refused(text); };

const length = (s) => Array.from(s).length;
const when = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/**
 * A new request, and the file with it (pure). Refuses a field out of its limits, and a title or text with nothing that sage can read.
 * @param {{ next: number, requests: object[] }} file
 * @param {{ project: string, folder: string, title: string, text: string, designQuestions: 'team' | 'owner', requester: string,
 *   requesterName: string, channel?: string | null }} f
 * @param {number} at
 */
export function newRequest(file, f, at) {
  for (const k of ['title', 'text']) {
    const [min, max] = LIMITS[k];
    if (typeof f[k] !== 'string' || length(f[k]) < min || length(f[k]) > max) refuse(`the ${k} must have ${min} to ${max} characters. Nothing changed.`);
  }
  if (!PROJECT_NAME.test(f.project ?? '') || typeof f.folder !== 'string' || !f.folder.startsWith('/')) throw new TypeError('a request needs a project name and its folder');
  if (!['team', 'owner'].includes(f.designQuestions)) throw new TypeError('designQuestions is team or owner');
  if (!SNOWFLAKE.test(f.requester ?? '') || typeof f.requesterName !== 'string') throw new TypeError('a request needs the Discord id and the name of its requester');
  const [titleForSage, textForSage] = [forModel(f.title), forModel(f.text)];
  if (!titleForSage) refuse('the title has nothing that sage can read: it needs letters or digits. Nothing changed.');
  if (!textForSage) refuse('the text has nothing that sage can read: it needs letters or digits. Nothing changed.');
  const request = {
    id: `RQ${file.next}`, project: f.project, folder: f.folder, title: f.title, text: f.text, titleForSage, textForSage,
    designQuestions: f.designQuestions, requester: f.requester, requesterName: f.requesterName, status: 'pending', claim: null,
    createdAt: at, decidedAt: null, decidedBy: null, via: null, reason: null, task: null,
    channel: f.channel ?? null, line: null, card: null, thread: null, shown: null,
  };
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
 * The request after one event (pure). Throws Refused, with the line for a person, for an event that the request's status does not take.
 * @param {object} r  @param {{ type: keyof MOVES } & Record<string, any>} e
 */
export function step(r, e) {
  const [from, to] = MOVES[e.type] ?? (() => { throw new TypeError(`no request event ${e.type}`); })();
  if (r.status !== from) {
    if (r.status === 'approving') refuse(`${r.id} is already being approved (since ${when(r.claim.at)}). Nothing changed.`);
    if (DECIDED.includes(r.status)) refuse(`${r.id} was already ${r.status} at ${when(r.decidedAt)} (${r.via}). Nothing changed.`);
    refuse(`${r.id} is not being approved. Nothing changed.`);
  }
  if (from === 'approving' && !sameClaim(r.claim, e.claim)) refuse(`${r.id} is being approved by another run. Nothing changed.`);
  if (e.type === 'withdraw' && e.by !== r.requester) refuse(`only the sage-lead who sent ${r.id} can withdraw it. Nothing changed.`);
  if (e.type === 'claim') return { ...r, status: to, claim: { ...e.claim } };
  if (e.type === 'release') return { ...r, status: to, claim: null };
  if (e.type === 'approve') return { ...r, status: to, claim: null, task: e.task, decidedAt: e.at, decidedBy: r.claim.by, via: r.claim.via };
  const reason = e.type === 'decline' ? (e.reason ?? '').trim() : '';
  if (length(reason) > LIMITS.reason[1]) refuse(`a reason has at most ${LIMITS.reason[1]} characters. Nothing changed.`);
  return { ...r, status: to, decidedAt: e.at, decidedBy: e.by, via: e.type === 'withdraw' ? 'discord' : e.via, reason: reason || null };
}

/** Whether a record is one that this module wrote: its keys, their types, and the fields that its status sets. */
function isRequest(r) {
  const text = (x) => typeof x === 'string';
  const time = (x) => Number.isSafeInteger(x);
  const opt = (x, ok) => x === null || ok(x);
  const id = (x) => SNOWFLAKE.test(x);
  if (!r || typeof r !== 'object' || Object.keys(r).join() !== KEYS.join()) return false;
  const decided = DECIDED.includes(r.status);
  const c = r.claim;
  return REQUEST_ID.test(r.id) && PROJECT_NAME.test(r.project) && text(r.folder) && [r.title, r.text, r.titleForSage, r.textForSage, r.requesterName].every(text)
    && ['team', 'owner'].includes(r.designQuestions) && id(r.requester) && STATUSES.includes(r.status) && time(r.createdAt)
    && (r.status === 'approving'
      ? !!c && Object.keys(c).sort().join() === 'at,by,pid,start,via' && text(c.by) && ['discord', 'terminal'].includes(c.via) && Number.isSafeInteger(c.pid) && text(c.start) && time(c.at)
      : c === null)
    && (decided ? time(r.decidedAt) && text(r.decidedBy) && ['discord', 'terminal'].includes(r.via) : r.decidedAt === null && r.decidedBy === null && r.via === null)
    && (r.status === 'approved' ? /^T\d{1,9}$/.test(r.task) : r.task === null)
    && (r.status === 'declined' ? opt(r.reason, text) : r.reason === null)
    && [r.channel, r.line, r.card, r.thread].every((x) => opt(x, id)) && opt(r.shown, (s) => STATUSES.includes(s));
}

/**
 * The requests file: { next, requests }, or { next: 1, requests: [] } when there is none. Throws for a file that is not this user's
 * 0600 file, a symlink, bad JSON, a record that this module did not write, two records with one id, or a `next` that an id has reached.
 */
export function loadRequests(path) {
  const text = readOwn(path, 'requests file');
  if (text === undefined) return { next: 1, requests: [] };
  const bad = new TypeError(`the requests file ${path} is not a version 1 requests file that sage-bot wrote. Nothing was loaded.`);
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
export const addRequest = (path, fields, at = Date.now()) => withLock(path, () => {
  const { file, request } = newRequest(loadRequests(path), fields, at);
  save(path, file);
  return request;
});

/** Applies one event (step) to one request under the lock, saves the file, and returns the request after it. */
export const update = (path, id, event) => withLock(path, () => {
  const file = loadRequests(path);
  const r = step(find(file, id), event);
  save(path, { ...file, requests: file.requests.map((x) => (x.id === id ? r : x)) });
  return r;
});

/** The id of the task of a request in the logbook: the first task whose title starts with "<id>:", or null. */
const taskOf = async (tool, id) => (await tool.tasks()).find((t) => t.title.startsWith(`${id}:`))?.id ?? null;
/** Whether the process of a claim still runs: its pid, with the start time of the claim (a pid can be reused). */
const runs = (c) => alive(c.pid) && startOf(c.pid) === c.start;

/** Ends one claim by what the logbook holds: a task of the request means approved with it; none means pending again. */
async function settle(path, r, tool, at) {
  const task = await taskOf(tool, r.id);
  return update(path, r.id, task ? { type: 'approve', claim: r.claim, task, at } : { type: 'release', claim: r.claim });
}

/**
 * The reconcile step: a request whose claim's process is gone is settled by the logbook of its project. Any other request stays.
 * `toolOf(request)` gives the state tool of its project. Returns the request as it is now.
 */
export async function reconcile(path, id, toolOf, at = Date.now()) {
  const r = find(loadRequests(path), id);
  if (r.status !== 'approving' || runs(r.claim)) return r;
  return settle(path, r, toolOf(r), at);
}

/**
 * Approves a request in three steps, so that a crash at any point leaves a state that reconcile finishes, and never two tasks:
 * 1. under the lock, pending → approving with a claim of this process;
 * 2. with no lock, `task add --title=<id>: <titleForSage> --size=<size>` through the state tool;
 * 3. under the lock, approving → approved with the task id.
 * When step 2 fails, the logbook decides (settle): the tool can fail after it wrote the task. When the logbook cannot be read either,
 * the claim stays, and the next run reconciles it once this process is gone.
 * @param {{ tool: { addTask: Function, tasks: Function }, size?: 'small' | 'large', by: string, via: 'discord' | 'terminal', now?: () => number }} o
 */
export async function approve(path, id, { tool, size = 'large', by, via, now = Date.now }) {
  await reconcile(path, id, () => tool, now());
  const claim = { by, via, pid: process.pid, start: startOf(process.pid), at: now() };
  const r = update(path, id, { type: 'claim', claim });
  let task;
  try {
    task = await tool.addTask({ title: `${id}: ${r.titleForSage}`, size });
  } catch (e) {
    const why = forTerminal(String(e?.stderr || e?.message || e).split('\n').find(Boolean) ?? '');
    let after;
    try { after = await settle(path, r, tool, now()); } catch {
      throw new Error(`could not add the task of ${id} (${why}), and could not read the logbook. ${id} shows as being approved until the next run of this command. Nothing else changed.`);
    }
    if (after.status === 'approved') return after;
    throw new Error(`could not add the task of ${id}: ${why}. ${id} waits again. Nothing changed.`);
  }
  return update(path, id, { type: 'approve', claim, task, at: now() });
}
