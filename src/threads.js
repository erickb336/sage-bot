// The threads that sage-bot opens for a mention (T131): each @sage-bot mention in a registered channel opens a public thread from the
// message, and the request and its answer live there. In such a thread (kind 'answer') a read ask gets its answer from the bridge, with
// no AI, and any other mention is a message to sage that waits for the owner (T247, src/outboxFlow.js). A mention in a thread that
// sage-bot does not own opens one of these threads from a line in the home channel (R918 C7).
// No sage session starts from this code, and no code here can start one: it has no process port at all.
// A task thread (kind 'task', T245) is the thread of a request that the owner approved: the bridge posts the design questions of its
// task there, as votes of 10 minutes.
// The thread map is <statePath>.threads, beside the gate file and safe like it (0600, written whole, read with no symlink), so that a
// thread continues after a restart. It is a file of its own: the bridge's loop rewrites the gate file whole from memory, and a second
// writer of that file would lose lines. One process holds one ThreadMap: /sage and the mentions (src/ask.js), the requests
// (src/requestFlow.js) and the bridge share it, and its `save` is the file's one writer (F4 of R917).
import { forTerminal } from './clean.js';
import { REQUEST_ID } from './requests.js';
import { readOwn, writeWhole } from './state.js';

const SNOWFLAKE = /^\d{17,20}$/;
const TASK_ID = /^T\d{1,9}$/;
const shape = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().join() : null);

/** The thread map file of a config: `<statePath>.threads`. */
export const threadsPathOf = ({ statePath }) => `${statePath}.threads`;

/** The thread map of one process: a Map of the entries, and `save`, the one writer of its file. */
class ThreadMap extends Map {
  #path;
  constructor(path, entries) { super(entries); this.#path = path; }
  /** Replaces the thread map file whole, as version 2. Throws when the file cannot be written; the map in memory stays as it is. */
  save() { writeWhole(this.#path, `${JSON.stringify({ version: 2, threads: Object.fromEntries(this) })}\n`); }
}

/**
 * The thread map, as a ThreadMap: thread id → { kind: 'answer', channel, project, by, at } for a mention's thread (with `origin`, the
 * thread that sage-bot does not own, for a thread that a move opened: R918 C7), or { kind: 'task', task,
 * request, project, folder, channel } for a task thread (T245): the sage task id, the request id, the project's name and folder (G45 A) and
 * the registered channel of the thread. A file of before T247 loads too: its owner threads (kind 'lead') load as answer threads, and the
 * held mentions of an answer thread are dropped (the outbox takes the context of a message from Discord now); the next save writes the
 * entries as they load. A version 1 file (before T245) has no task threads. An empty map when there is no file. Throws, and the bridge
 * stops, for a file that is not this user's 0600 file, a symlink, bad JSON or an entry that the bridge did not write.
 */
export function loadThreads(path) {
  const text = readOwn(path, 'thread map');
  if (text === undefined) return new ThreadMap(path);
  const bad = new TypeError(`the thread map ${path} is not a version 1 or 2 thread map that the bridge wrote. Nothing was loaded.`);
  let data;
  try { data = JSON.parse(text); } catch { throw bad; }
  if (shape(data) !== 'threads,version' || ![1, 2].includes(data.version) || shape(data.threads) === null) throw bad;
  // `roles`: the role NAMES of the member since T232 (Discord allows 1 to 100 characters, counted as code points, so 100 emoji are 200
  // UTF-16 units: F-T232-2), role ids before it. They only go to the audit log.
  const isHeld = (h) => shape(h) === 'content,id,roles,user' && SNOWFLAKE.test(h.id) && SNOWFLAKE.test(h.user) && typeof h.content === 'string'
    && Array.isArray(h.roles) && h.roles.every((r) => typeof r === 'string' && r !== '' && Array.from(r).length <= 100);
  const isTask = (t) => TASK_ID.test(t.task) && REQUEST_ID.test(t.request) && typeof t.folder === 'string' && t.folder.startsWith('/');
  const isMention = (t) => SNOWFLAKE.test(t.by) && Number.isSafeInteger(t.at) && (t.held === undefined || (Array.isArray(t.held) && t.held.every(isHeld)))
    && (t.origin === undefined || SNOWFLAKE.test(t.origin));
  const kinds = { answer: ['at,by,channel,kind,project', 'at,by,channel,kind,origin,project', 'at,by,channel,held,kind,project'], lead: ['at,by,channel,kind,project'],
    ...(data.version === 2 && { task: ['channel,folder,kind,project,request,task'] }) };
  for (const [id, t] of Object.entries(data.threads)) {
    if (!SNOWFLAKE.test(id) || !kinds[t?.kind]?.includes(shape(t)) || !SNOWFLAKE.test(t.channel) || typeof t.project !== 'string'
      || !(t.kind === 'task' ? isTask(t) : isMention(t))) throw bad;
  }
  const now = (t) => (t.kind === 'task' ? t : { kind: 'answer', channel: t.channel, project: t.project, by: t.by, at: t.at, ...(t.origin && { origin: t.origin }) });
  return new ThreadMap(path, Object.entries(data.threads).map(([id, t]) => [id, now(t)]));
}

/**
 * The task thread of a request that the owner approved (T245): its own thread, as the entry that loadThreads takes back. `r` is a record of
 * src/requests.js with status 'approved', a task and a thread.
 */
export const taskThread = (r) => ({ kind: 'task', task: r.task, request: r.id, project: r.project, folder: r.folder, channel: r.channel });

/**
 * Whether the thread map entry `t` is a task thread of a channel that the registry `channels` (src/channels.js) holds now for the task's
 * own project (F-T245-3, F-T245-7): the one check of the registry for a task thread. A task thread of a channel that the owner unregistered,
 * or that Erick registered to another project, takes no card and no press, and an approve there makes none; its entry stays in the map, so
 * a channel that Erick registers again for that project at the terminal gets its task threads back.
 */
export const isLiveTask = (t, channels) => t?.kind === 'task' && channels.get(t.channel)?.project === t.project;

/** The words of a mention, with every Discord mention, role and channel tag taken out. */
const words = (text) => String(text ?? '').replace(/<(?:@[!&]?|#)\d+>/g, ' ').replace(/\s+/g, ' ').trim();

/** The name of a new thread, from the request: printable text on one line, at most 80 characters; a fixed name when nothing is left. */
export function threadName(text) {
  const name = Array.from(forTerminal(words(text)).replace(/\s+/g, ' ').trim()).slice(0, 80).join('').trim();
  return name || 'sage-bot request';
}

/**
 * The read ask in a mention (owner decision, F-T247-1), as a /sage subcommand and its options: the text without its mentions is only one
 * read word (board, gates, questions or files) or one task id (T7), with at most a closing "?", "." or "!". Anything longer is a message
 * to sage (null), also when it names a task or a read word: "for T5 use ; between the columns" is a steer.
 */
export function readAsk(text) {
  const w = /^(T\d{1,9}|board|gates|questions|files)[?.!]?$/i.exec(words(text))?.[1]?.toLowerCase();
  if (!w) return null;
  if (w.startsWith('t')) return { sub: 'task', options: { id: w.toUpperCase() } };
  return { sub: w === 'questions' ? 'gates' : w, options: {} };
}

/** The reply in place when sage-bot lacks a right for its thread. `us` is src/crew.js namesOf (T244). */
export const noRight = (right, us) => `I cannot answer in a thread here: ${us.bot} lacks the right "${right}" in this channel. Ask ${us.owner} to give it to ${us.bot}'s role.`;
