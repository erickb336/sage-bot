// Chief sessions (T29). A session is one Claude Code session id. scripts/hook.mjs writes one spool file per session from three
// hooks (SessionStart, PostToolUse on Bash, SessionEnd); the bridge reads the spool folder at each loop. The rest of this file is
// pure functions that turn spool files and gate rows into sessions, the title of a thread and the line in the parent channel.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { GATE_ID, readOwn, SESSION_ID, writeWhole } from './state.js';
import { stamp } from './cards.js';

/** A sage task id, as sage writes it: T and digits. */
export const TASK_ID = /^T\d{1,9}$/;
/** The fixed first line that `sage gate add` prints: "G12 open · <question>". */
const GATE_OPEN = /^(G\d{1,9}) open · /m;
/** The task of a `gate add` command: `… gate add T7 --question …`. */
const GATE_ADD = /\bgate\s+add\s+(T\d{1,9})\b/;
/** The folder after `--project` (or `--project=`) in a command, as one shell word: in double or single quotes, or up to a space or ;&|. */
const PROJECT = /--project(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;

/** A path with its links resolved; a path that does not exist stays as it is. */
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** Whether `path` is the project folder or a folder inside it (a subfolder, a worktree in it), by their real paths (F-T29-5). */
export function inside(path, project) {
  const rel = relative(real(project), real(path));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** The spool folder: `sessionsPath` in the config, or `<statePath>.sessions`. */
export function sessionsPathOf({ sessionsPath, statePath }) {
  const path = sessionsPath ?? (typeof statePath === 'string' ? `${statePath}.sessions` : undefined);
  if (typeof path !== 'string' || !path) throw new TypeError('the config needs statePath (or sessionsPath) to find the session spool');
  return path;
}

const isTime = (x) => Number.isSafeInteger(x) && x >= 0;
/**
 * One spool file, checked: { id, cwd, startedAt, pid, endedAt?, gates, tasks }. Throws for anything that the hook did not write.
 * @returns {{ id: string, cwd: string, startedAt: number, pid: number, endedAt?: number, gates: string[], tasks: string[] }}
 */
export function parseSpool(s) {
  const ok = s && SESSION_ID.test(s.id) && typeof s.cwd === 'string' && isTime(s.startedAt) && Number.isSafeInteger(s.pid) && s.pid > 0
    && (s.endedAt === undefined || isTime(s.endedAt))
    && Array.isArray(s.gates) && s.gates.every((g) => GATE_ID.test(g)) && Array.isArray(s.tasks) && s.tasks.every((t) => TASK_ID.test(t));
  if (!ok) throw new TypeError('not a spool file of the sage-bot hook');
  return s;
}

const spoolPath = (dir, id) => join(dir, `${id}.json`);

/** Every spool file of the folder, by session id, and one line for each file that was refused. The folder may not exist yet. */
export function readSpools(dir) {
  const spools = new Map();
  const refused = [];
  let names = [];
  try { names = readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') refused.push(`the session spool ${dir}: ${e.message}`); }
  for (const name of names.filter((n) => /\.json$/.test(n)).sort()) {
    try {
      const s = parseSpool(JSON.parse(readOwn(join(dir, name), 'spool file')));
      if (name !== `${s.id}.json`) throw new TypeError('its name is not its session id');
      spools.set(s.id, s);
    } catch (e) {
      refused.push(`the spool file ${name} is refused: ${e.message}`);
    }
  }
  return { spools, refused };
}

/** Whether a session runs: it has no end, and its Claude Code process runs. */
export const runs = (s, alive) => s.endedAt === undefined && alive(s.pid);

/**
 * The session of a group of sage gate rows: of the spools that list one of the gates and started before sage asked it (its `at`, to the
 * second), the one that started last; else the newest running session; else null. A spool can list a gate id of an older logbook (F-T29-3).
 * @param {{ id: string, at: string }[]} rows @param {Map<string, ReturnType<typeof parseSpool>>} spools @param {(pid: number) => boolean} alive
 */
export function sessionOf(rows, spools, alive) {
  const all = [...spools.values()].sort((a, b) => b.startedAt - a.startedAt);
  const startedBy = (s, at) => Math.floor(s.startedAt / 1000) * 1000 <= Date.parse(at);
  const known = all.find((s) => rows.some((r) => s.gates.includes(r.id) && startedBy(s, r.at)));
  return (known ?? all.find((s) => runs(s, alive)))?.id ?? null;
}

/** The title of a session's thread: the bridge's number of the session, then the weekday and the date of its start, in the host's time zone. */
export function titleOf(n, at) {
  const d = new Date(at);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `Session ${n} · ${day} ${date}`;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The line of a session in the parent channel: "**Session 14 · Tue 4 Oct**" and "running · 4 tasks · 2 open questions", or "ended <time> · …". */
export function lineOf({ title, endedAt }, { tasks, open }) {
  const state = endedAt === undefined ? 'running' : `ended ${stamp(endedAt, 'f')}`;
  return `**${title}**\n${state} · ${count(tasks, 'task', 'tasks')} · ${open ? count(open, 'open question', 'open questions') : 'no open questions'}`;
}

/** Takes the lock of one spool file (O_EXCL), so that two hooks of one session never write over each other. A lock older than 5 s is a crash's. */
function locked(file, work) {
  const lock = `${file}.lock`;
  for (let tries = 0; tries < 100; tries++) {
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== undefined) {
      closeSync(fd);
      try { return work(); } finally { rmSync(lock, { force: true }); }
    }
    const st = lstatSync(lock, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > 5000) rmSync(lock, { force: true });
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`the spool file ${file} stays locked`);
}

/**
 * Records one Claude Code hook event in the spool (scripts/hook.mjs). Throws for input that it refuses; then it writes nothing.
 * An event in a folder outside the project, and a `gate add` with `--project` outside it, are not refused: they are not this project's.
 * - SessionStart: { id, cwd, startedAt, pid }; a resume or a compaction keeps the gates and tasks and takes away the end.
 * - PostToolUse on Bash: the gate id of `sage gate add`'s output line, and the task of its command.
 * - SessionEnd: the end.
 * @param {object} input  the hook's JSON from Claude Code
 * @param {{ project: string, dir: string, pid: number, now: number }} o
 * @returns {string} what it did, for the tests
 */
export function record(input, { project, dir, pid, now }) {
  const id = input?.session_id;
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new TypeError('the session_id is not a UUID');
  if (typeof project !== 'string') throw new TypeError('the config has no project');
  if (typeof input.cwd !== 'string') throw new TypeError('the cwd is not a path');
  if (!inside(input.cwd, project)) return 'outside the project';
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('the pid is not a whole number');
  const event = input.hook_event_name;
  let gate;
  let task;
  if (event === 'PostToolUse') {
    if (input.tool_name !== 'Bash') return 'not a Bash tool';
    gate = String(input.tool_response?.stdout ?? '').match(GATE_OPEN)?.[1];
    if (!gate) return 'no gate add';
    const command = String(input.tool_input?.command ?? '');
    const named = command.match(PROJECT)?.slice(1).find((x) => x !== undefined);
    if (named !== undefined && !inside(resolve(input.cwd, named), project)) return 'another project';
    task = command.match(GATE_ADD)?.[1];
  } else if (event !== 'SessionStart' && event !== 'SessionEnd') {
    throw new TypeError('not a hook event of the sage bridge');
  }
  const file = spoolPath(dir, id);
  if (event === 'SessionEnd' && !existsSync(file)) return 'no session';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return locked(file, () => {
    let old;
    try { old = parseSpool(JSON.parse(readOwn(file, 'spool file') ?? 'null')); } catch { old = undefined; }
    if (event === 'SessionEnd' && !old) return 'no session';
    const s = old ?? { id, cwd: resolve(project), startedAt: now, pid, gates: [], tasks: [] };
    if (event === 'SessionStart') { s.pid = pid; delete s.endedAt; }
    if (event === 'SessionEnd') s.endedAt = now;
    if (gate && !s.gates.includes(gate)) s.gates.push(gate);
    if (task && !s.tasks.includes(task)) s.tasks.push(task);
    writeWhole(file, JSON.stringify(s));
    return `${event} ${id}`;
  });
}
