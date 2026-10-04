// The bridge's gate file: the only copy of the votes (F-T28-10, F-T28-12, F-T28-15). Only the bridge writes it: its folder
// is 0700 and the file 0600, it is replaced whole by a rename (never half written), and a load refuses a file that another
// user owns or that others may write. Every gate in it goes through parseGate on fresh JSON.parse output. The bridge loads
// it only from this path, never from Discord or a shared place.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseGate } from './vote.js';

const isText = (x) => typeof x === 'string';
const isTime = (x) => Number.isSafeInteger(x);

/** One entry as the bridge keeps it, checked: a refused entry throws, so the bridge never acts on a gate that it did not make. */
function entryOf(e) {
  const ok = e && Array.isArray(e.sage) && e.sage.every(isText) && e.ask && Array.isArray(e.ask.parts)
    && Array.isArray(e.texts) && e.texts.length === e.sage.length && e.texts.every((t) => Array.isArray(t) && t.every(isText))
    && (e.message === null || isText(e.message)) && isTime(e.remindedAt)
    && e.sent && typeof e.sent === 'object' && Object.values(e.sent).every(isText)
    && e.seen && typeof e.seen === 'object' && Object.values(e.seen).every(isText);
  if (!ok) throw new TypeError('the gate file has an entry that the bridge did not write');
  return { ...e, gate: parseGate(e.gate) };
}

/**
 * The entries of the gate file, or [] when there is none yet. Throws for a file that is not the bridge's own.
 * @returns {{ gate: import('./vote.js').Gate, ask: object, sage: string[], texts: string[][], message: string | null, remindedAt: number,
 *   sent: Record<string, string>, seen: Record<string, string> }[]}
 */
export function load(path) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
    throw new Error(`the gate file ${path} must be a regular file of this user with mode 0600. Nothing was loaded.`);
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.entries)) throw new TypeError(`the gate file ${path} is not version 1`);
  return data.entries.map(entryOf);
}

/** Replaces the gate file whole: a new 0600 file beside it, synced, then renamed over it. */
export function save(path, entries) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // a temp file left by a crash; 'wx' then makes a new one with mode 0600
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify({ version: 1, entries }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
