// The bridge's gate file and the team votes file. The gate file is the only copy of the votes (F-T28-10, F-T28-12, F-T28-15). Only the bridge writes it: its folder
// is 0700 and the file 0600, it is replaced whole by a rename (never half written), and a load refuses a file that another
// user owns or that others may write. Every gate in it goes through parseGate on fresh JSON.parse output. The bridge loads
// it only from this path, never from Discord or a shared place.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseGate } from './vote.js';

const isText = (x) => typeof x === 'string';
const isTime = (x) => Number.isSafeInteger(x);
/** The owner's final answer from the terminal on a part of an ask, or none. */
const isFinal = (f, part) => f === undefined || (f && isText(f.by) && isTime(f.at) && isText(f.text)
  && (f.option === undefined || Object.hasOwn(part.options ?? {}, f.option)));

/** The keys of an object, sorted and joined, to compare its shape with the one the bridge writes. */
const shape = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().join() : null);
/**
 * A message held for a moved card (T65), exactly as the bridge makes it: a text in Discord's 2,000 characters that pings nobody, or one
 * role (F-T65-3). Discord would ping @everyone for a payload with no allowedMentions.
 */
const isHeld = (p) => shape(p) === 'allowedMentions,content' && isText(p.content) && p.content.length <= 2000
  && Array.isArray(p.allowedMentions.parse) && p.allowedMentions.parse.length === 0
  && (shape(p.allowedMentions) === 'parse' || (shape(p.allowedMentions) === 'parse,roles' && Array.isArray(p.allowedMentions.roles)
    && p.allowedMentions.roles.length === 1 && /^\d{17,20}$/.test(p.allowedMentions.roles[0])));

/** One entry as the bridge keeps it, checked: a refused entry throws, so the bridge never acts on a gate that it did not make. */
function entryOf(e) {
  const ok = e && Array.isArray(e.sage) && e.sage.every(isText) && e.ask && Array.isArray(e.ask.parts) && e.ask.parts.length === e.sage.length
    && e.ask.parts.every((p) => p && isFinal(p.final, p))
    && Array.isArray(e.texts) && e.texts.length === e.sage.length && e.texts.every((t) => Array.isArray(t) && t.every(isText))
    && (e.message === null || isText(e.message)) && isTime(e.remindedAt)
    && e.sent && typeof e.sent === 'object' && Object.values(e.sent).every(isText)
    // Version 2 (T29): the chief session of the entry (null: none known) and the channel or thread of its card (absent: the parent channel).
    && (e.session === undefined || e.session === null || SESSION_ID.test(e.session)) && (e.channel === undefined || isText(e.channel));
  if (!ok) throw new TypeError('the gate file has an entry that the bridge did not write');
  if (e.held !== undefined && !(Array.isArray(e.held) && e.held.every(isHeld))) {
    throw new TypeError('the gate file has an entry with held messages that the bridge did not write');
  }
  return { ...e, session: e.session ?? null, gate: parseGate(e.gate) };
}

/** One chief session as the bridge keeps it (T29): its number, the title of its thread, its line in the parent channel and its thread. */
function sessionOf(s) {
  const ok = s && SESSION_ID.test(s.id) && Number.isSafeInteger(s.n) && s.n > 0 && isText(s.title)
    && (s.line === null || isText(s.line)) && (s.thread === null || isText(s.thread)) && typeof s.closed === 'boolean'
    && (s.endedAt === undefined || isTime(s.endedAt));
  if (!ok) throw new TypeError('the gate file has a session that the bridge did not write');
  return s;
}

/**
 * The entries and the chief sessions of the gate file, both [] when there is none yet. Throws for a file that is not the bridge's own.
 * A version 1 file (before T29) has no sessions, and its entries have no session.
 * @returns {{ gate: import('./vote.js').Gate, ask: object, sage: string[], texts: string[][], message: string | null, remindedAt: number,
 *   sent: Record<string, string> }[]}  the owner's final answers from the terminal are in `ask.parts[i].final`
 */
export function load(path) {
  const text = readOwn(path, 'gate file');
  if (text === undefined) return { entries: [], sessions: [] };
  const data = JSON.parse(text);
  const sessions = data?.version === 1 ? [] : data?.sessions;
  if (![1, 2].includes(data?.version) || !Array.isArray(data.entries) || !Array.isArray(sessions)) throw new TypeError(`the gate file ${path} is not version 1 or 2`);
  return { entries: data.entries.map(entryOf), sessions: sessions.map(sessionOf) };
}

/**
 * The text of a file that only this user may read and write, or undefined when there is none. Throws for any other file (F-T47-1).
 * The checks are on the open file, not on its name, so a file swapped in after a check is never read: the open refuses a link, and
 * the read is from the same descriptor that fstat checked. A folder that other users may write, without the sticky bit, is refused:
 * they could replace the file there.
 */
export function readOwn(path, what) {
  const dir = statSync(dirname(path), { throwIfNoEntry: false });
  if (!dir) return undefined;
  if ((dir.mode & 0o022) !== 0 && (dir.mode & 0o1000) === 0) {
    throw new Error(`the ${what} ${path} is in a folder that other users may write. Make the folder 0700. Nothing was loaded.`);
  }
  const refuse = () => new Error(`the ${what} ${path} must be a regular file of this user with mode 0600. Nothing was loaded.`);
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e.code === 'ELOOP' ? refuse() : e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw refuse();
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/** Replaces the gate file whole. */
export const save = (path, entries, sessions = []) => writeWhole(path, JSON.stringify({ version: 2, entries, sessions }));

/** A sage gate id, as sage writes it: G and digits. Only these go in the team votes file. */
export const GATE_ID = /^G\d{1,9}$/;
/** A Claude Code session id: a UUID, in lower case as Claude Code writes it. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The team votes file (G13): the sage gate ids that the chief marked as team votes. The bridge posts only these.
 * It is `votesPath` in the config, or `<statePath>.votes`; scripts/vote.mjs writes it.
 */
export function votesPathOf({ votesPath, statePath }) {
  const path = votesPath ?? (typeof statePath === 'string' ? `${statePath}.votes` : undefined);
  if (typeof path !== 'string' || !path) throw new TypeError('the config needs statePath (or votesPath) to find the team votes file');
  return path;
}

/** The marked gate ids, as a Set; an empty Set when there is no file. Throws for a file that is not this user's 0600 file, or not a list of gate ids. */
export function loadVotes(path) {
  const text = readOwn(path, 'team votes file');
  if (text === undefined) return new Set();
  const ids = JSON.parse(text);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && GATE_ID.test(id))) {
    throw new TypeError(`the team votes file ${path} must be a JSON list of sage gate ids (G and digits). Nothing was loaded.`);
  }
  return new Set(ids);
}

/** Replaces the team votes file whole, sorted by number. */
export const saveVotes = (path, ids) => writeWhole(path, JSON.stringify([...ids].sort((a, b) => a.slice(1) - b.slice(1))));

/** Replaces a file whole: a new 0600 file beside it, synced, then renamed over it, in a folder of mode 0700. */
export function writeWhole(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // a temp file left by a crash; 'wx' then makes a new one with mode 0600
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Whether a process with this pid runs (EPERM: it runs as another user). */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** How long a lock that names no holder (an empty file, or the pid-only lock of add8820) counts as held: a bridge may be writing it. */
const GRACE = 10_000;

/**
 * The start time of the process with this pid, as ps prints it ('' when no process has it). The fixed locale and time zone make the
 * text the same for every reader, so a bridge under launchd and one from a shell compare equal. Throws when ps fails for another
 * reason (EAGAIN, ENOMEM, a signal): an unknown answer must never make the lock of a live bridge stale (F-T40-4).
 */
export function startOf(pid) {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    if (e.status === 1 && !e.stdout?.trim()) return ''; // ps exits 1 and prints nothing when no process has the pid
    throw new Error(`could not check whether the bridge with pid ${pid} still runs: ${e.message}. Nothing was started.`);
  }
}

/** The text and the age of a file, or undefined when there is none. */
function read(file) {
  try { return { text: readFileSync(file, 'utf8'), age: Date.now() - statSync(file).mtimeMs }; } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw new Error(`the bridge cannot read ${file} (${e.code}). If no bridge runs, remove ${file}. Nothing was started.`);
  }
}

/**
 * Makes this process the only bridge on the gate file (F-T28-30, T40). The lock `<path>.lock` holds the pid and the start time of its
 * bridge. It is written to a temp file first and linked to its name, so it never exists empty, and only one of many starts gets it.
 * A lock is the holder's while a process with that pid and that start time runs. A lock of a process that is gone, of a process that
 * reuses the pid after a reboot, or with this process's own pid, is stale and replaced. A lock that names no holder counts as held for
 * GRACE ms. The lock goes at the exit, also at a stop by SIGTERM (launchd), SIGINT or SIGHUP.
 * Two bridges on one gate file would post every card twice and save over each other's ballots.
 */
export function lock(path) {
  const file = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const start = startOf(process.pid);
  if (!start) throw new Error(`/bin/ps gave no start time for this process, so the bridge cannot take the lock ${file}. Nothing was started.`);
  const mine = `${process.pid} ${start}`;
  const tmp = `${file}.${process.pid}.tmp`;
  for (const name of readdirSync(dirname(file))) { // the temp files of crashed starts, and an old one of this pid
    const pid = name.startsWith(`${basename(file)}.`) && /^\.(\d+)\.tmp$/.exec(name.slice(basename(file).length))?.[1];
    if (pid && (Number(pid) === process.pid || !alive(Number(pid)))) rmSync(join(dirname(file), name), { force: true });
  }
  writeFileSync(tmp, mine, { mode: 0o600, flag: 'wx' });
  try {
    for (let tries = 0; tries < 20; tries++) {
      try {
        linkSync(tmp, file);
        process.once('exit', () => { if (read(file)?.text === mine) rmSync(file, { force: true }); });
        for (const [signal, n] of [['SIGHUP', 1], ['SIGINT', 2], ['SIGTERM', 15]]) process.once(signal, () => process.exit(128 + n));
        return file;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const held = read(file);
      if (!held) continue; // its holder just removed it
      const [, pid, since] = /^(\d+)(?: (.+))?$/s.exec(held.text) ?? [];
      const stale = Number(pid) === process.pid || (since ? startOf(pid) !== since : held.age > GRACE);
      if (!stale && !since) throw new Error(`a sage bridge may still be starting on ${path} (pid ${pid ?? 'unknown'}). Try again in 10 s, or remove ${file}.`);
      if (!stale) {
        throw new Error(`another sage bridge (pid ${pid}) runs on ${path}. This one stops: two bridges would post each card twice. If no bridge runs, remove ${file}.`);
      }
      unlock(file, held.text);
    }
  } finally { rmSync(tmp, { force: true }); }
  const guard = existsSync(`${file}.break`) ? `: another start holds ${file}.break. That file clears itself after 10 s: try again then` : '';
  throw new Error(`the bridge could not take the lock ${file}${guard}. Nothing was started.`);
}

/**
 * Removes a stale lock when it still has this text. Only one start at a time does this, under `<lock>.break`: a check and a remove are
 * two steps, and without it a slow start could remove the new lock of a faster one. A break file of a crash goes after GRACE ms.
 */
export function unlock(file, text) {
  const guard = `${file}.break`;
  try { closeSync(openSync(guard, 'wx', 0o600)); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if ((read(guard)?.age ?? 0) > GRACE) rmSync(guard, { force: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // another start removes it now
    return;
  }
  try { if (read(file)?.text === text) rmSync(file, { force: true }); } finally { rmSync(guard, { force: true }); }
}
