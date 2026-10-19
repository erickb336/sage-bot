// The threads that sage-bot opens for a mention (T131): each @sage-bot mention in a registered channel opens a public thread from the
// message, and the request and its answer live there. An answer thread holds read asks: the bridge answers them itself, with no AI. An
// owner thread (kind 'lead') is the owner's "talk": in this step it only records each message in the audit log and says that sessions are not on yet.
// No sage session starts from this code, and no code here can start one: it has no process port at all.
// The thread map is <statePath>.threads, beside the gate file and safe like it (0600, written whole, read with no symlink), so that a
// thread continues after a restart. It is a file of its own: the bridge's loop rewrites the gate file whole from memory, and a second
// writer of that file would lose lines.
import { forTerminal } from './clean.js';
import { readOwn, writeWhole } from './state.js';

const SNOWFLAKE = /^\d{17,20}$/;
const shape = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().join() : null);

/** The thread map file of a config: `<statePath>.threads`. */
export const threadsPathOf = ({ statePath }) => `${statePath}.threads`;

/**
 * The thread map: thread id → { kind: 'answer' | 'lead', channel, project, by, at }, and for an answer thread `held`: the mentions of
 * the crew there, each { id, user, roles, content }, in order. When the owner talks in an answer thread, it becomes an owner thread ('lead',
 * the name from before T232) and its held mentions go into the audit log as quoted data (G27). An empty Map when there is no file. Throws, and
 * the bridge stops, for a file that is not this user's 0600 file, a symlink, bad JSON or an entry that the bridge did not write.
 */
export function loadThreads(path) {
  const text = readOwn(path, 'thread map');
  if (text === undefined) return new Map();
  const bad = new TypeError(`the thread map ${path} is not a version 1 thread map that the bridge wrote. Nothing was loaded.`);
  let data;
  try { data = JSON.parse(text); } catch { throw bad; }
  if (shape(data) !== 'threads,version' || data.version !== 1 || shape(data.threads) === null) throw bad;
  // `roles`: the role NAMES of the member since T232 (Discord allows 1 to 100 characters, counted as code points, so 100 emoji are 200
  // UTF-16 units: F-T232-2), role ids before it. They only go to the audit log.
  const isHeld = (h) => shape(h) === 'content,id,roles,user' && SNOWFLAKE.test(h.id) && SNOWFLAKE.test(h.user) && typeof h.content === 'string'
    && Array.isArray(h.roles) && h.roles.every((r) => typeof r === 'string' && r !== '' && Array.from(r).length <= 100);
  for (const [id, t] of Object.entries(data.threads)) {
    if (!SNOWFLAKE.test(id) || shape(t) !== { answer: 'at,by,channel,held,kind,project', lead: 'at,by,channel,kind,project' }[t?.kind]
      || !SNOWFLAKE.test(t.channel) || !SNOWFLAKE.test(t.by) || typeof t.project !== 'string' || !Number.isSafeInteger(t.at)
      || (t.kind === 'answer' && !(Array.isArray(t.held) && t.held.every(isHeld)))) throw bad;
  }
  return new Map(Object.entries(data.threads));
}
/** Replaces the thread map file whole. */
export const saveThreads = (path, map) => writeWhole(path, `${JSON.stringify({ version: 1, threads: Object.fromEntries(map) })}\n`);

/** The words of a mention, with every Discord mention, role and channel tag taken out. */
const words = (text) => String(text ?? '').replace(/<(?:@[!&]?|#)\d+>/g, ' ').replace(/\s+/g, ' ').trim();

/** The name of a new thread, from the request: printable text on one line, at most 80 characters; a fixed name when nothing is left. */
export function threadName(text) {
  const name = Array.from(forTerminal(words(text)).replace(/\s+/g, ' ').trim()).slice(0, 80).join('').trim();
  return name || 'sage-bot request';
}

/** Whether a mention asks to talk to sage: it holds the word "talk". Only the owner's talk opens an owner thread. */
export const isTalk = (text) => /\btalk\b/i.test(words(text));

/**
 * The read ask in a mention, as a /sage subcommand and its options: a task id (T7) asks for that task; else the first of the words
 * board, gates (or questions) and files; null when it names none of them.
 */
export function readAsk(text) {
  const w = words(text);
  const id = /\bT\d{1,9}\b/i.exec(w)?.[0];
  if (id) return { sub: 'task', options: { id: id.toUpperCase() } };
  const word = /\b(board|gates|questions|files)\b/i.exec(w)?.[1]?.toLowerCase();
  if (!word) return null;
  return { sub: word === 'questions' ? 'gates' : word, options: {} };
}

/** The reply to the owner's talk while sessions are not on (this step is a dry run). */
export const DRY_RUN = 'Recorded in the audit log. Sessions with sage are not on yet, so nothing goes to sage. Use /sage board, gates, task or files to read the records.';
/** The reply to a talk while the kill switch is set. */
export const LINK_OFF = 'The link from Discord to sage is off. Your message is recorded in the audit log, and nothing goes to sage. Only Erick can turn the link on again, at the terminal. Read asks still work.';
/** The reply in a thread that sage-bot did not open, or in a forum post. */
export const foreign = (channel) => `I answer in my own threads. Mention me in <#${channel}> and I open one for you.`;
/** The reply in place when sage-bot lacks a right for its thread. */
export const noRight = (right) => `I cannot answer in a thread here: sage-bot lacks the right "${right}" in this channel. Ask Erick to give it to sage-bot's role.`;
