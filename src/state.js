// The bridge's gate file and the team votes file. The gate file is the only copy of the votes (F-T28-10, F-T28-12, F-T28-15). Only the bridge writes it: its folder
// is 0700 and the file 0600, it is replaced whole by a rename (never half written), and a load refuses a file that another
// user owns or that others may write. Every gate in it goes through parseGate on fresh JSON.parse output. The bridge loads
// it only from this path, never from Discord or a shared place.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseGate } from './vote.js';

const isText = (x) => typeof x === 'string';
const isTime = (x) => Number.isSafeInteger(x);
/** The owner's final answer from the terminal on a part of an ask, or none. */
const isFinal = (f, part) => f === undefined || (f && isText(f.by) && isTime(f.at) && isText(f.text)
  && (f.option === undefined || Object.hasOwn(part.options ?? {}, f.option)));

/** One entry as the bridge keeps it, checked: a refused entry throws, so the bridge never acts on a gate that it did not make. */
function entryOf(e) {
  const ok = e && Array.isArray(e.sage) && e.sage.every(isText) && e.ask && Array.isArray(e.ask.parts) && e.ask.parts.length === e.sage.length
    && e.ask.parts.every((p) => p && isFinal(p.final, p))
    && Array.isArray(e.texts) && e.texts.length === e.sage.length && e.texts.every((t) => Array.isArray(t) && t.every(isText))
    && (e.message === null || isText(e.message)) && isTime(e.remindedAt)
    && e.sent && typeof e.sent === 'object' && Object.values(e.sent).every(isText);
  if (!ok) throw new TypeError('the gate file has an entry that the bridge did not write');
  return { ...e, gate: parseGate(e.gate) };
}

/**
 * The entries of the gate file, or [] when there is none yet. Throws for a file that is not the bridge's own.
 * @returns {{ gate: import('./vote.js').Gate, ask: object, sage: string[], texts: string[][], message: string | null, remindedAt: number,
 *   sent: Record<string, string> }[]}  the owner's final answers from the terminal are in `ask.parts[i].final`
 */
export function load(path) {
  const text = readOwn(path, 'gate file');
  if (text === undefined) return [];
  const data = JSON.parse(text);
  if (data?.version !== 1 || !Array.isArray(data.entries)) throw new TypeError(`the gate file ${path} is not version 1`);
  return data.entries.map(entryOf);
}

/** The text of a file that only this user may read and write, or undefined when there is none. Throws for any other file. */
function readOwn(path, what) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
    throw new Error(`the ${what} ${path} must be a regular file of this user with mode 0600. Nothing was loaded.`);
  }
  return readFileSync(path, 'utf8');
}

/** Replaces the gate file whole. */
export const save = (path, entries) => writeWhole(path, JSON.stringify({ version: 1, entries }));

/** A sage gate id, as sage writes it: G and digits. Only these go in the team votes file. */
export const GATE_ID = /^G\d{1,9}$/;

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
function writeWhole(path, text) {
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
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Makes this process the only bridge on the gate file (F-T28-30): it creates `<path>.lock` with O_EXCL and its pid in it. A lock of a
 * process that runs refuses the start; a lock of a process that is gone (a crash, a reboot) is replaced. The lock goes at a normal exit.
 * Two bridges on one gate file would post every card twice and save over each other's ballots.
 */
export function lock(path) {
  const file = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 3; tries++) {
    let fd;
    try { fd = openSync(file, 'wx', 0o600); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== undefined) {
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      process.once('exit', () => {
        try { if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file); } catch { /* already gone */ }
      });
      return file;
    }
    const held = readFileSync(file, 'utf8');
    if (alive(Number(held))) {
      throw new Error(`another sage bridge (pid ${held}) runs on ${path}. This one stops: two bridges would post each card twice. If no bridge runs, remove ${file}.`);
    }
    if (readFileSync(file, 'utf8') === held) rmSync(file, { force: true }); // the lock of a process that is gone
  }
  throw new Error(`the bridge could not take the lock ${file}. Nothing was started.`);
}
