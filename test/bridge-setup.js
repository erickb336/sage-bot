// The scratch logbook and the bridge on the fake Discord layer, for the bridge tests. SAMPLE DATA ONLY: every id and name is made up.
// The sage state tool is the pinned copy in test/fixtures/sage/ (or SAGE_TOOL), and it runs with HOME and SAGE_HOME in a scratch
// folder, so no test reads the owner's sage plugin or touches a real logbook.
// This is the one test module that imports node:child_process: every test starts its child processes with spawn, spawnSync and
// execFileSync from here, which give each child SAGE_TOOL (testEnv), so that a script that looks for sage (scripts/demo.mjs) gets the
// tests' copy and never the owner's plugin cache (F-T162-2). t162-sage-fixture.test.js checks that no other test file imports it.
import * as cp from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { tempFolder } from './temp-folder.js';
import { createBridge, SETTLE } from '../src/bridge.js';
import { fakeDiscord, fakeInteraction } from '../src/fake-discord.js';
import { answerArgs, optionsOf, OTHER, sagePath, sageTool } from '../src/sage.js';
import { loadVotes, saveVotes } from '../src/state.js';

const KEYS = ['A', 'B', 'C', 'D', 'E'];

/** The pinned copy of the sage state tool (test/fixtures/sage/README.md). */
export const FIXTURE = new URL('fixtures/sage/6ea307ffa7b5/skills/sage/sage.mjs', import.meta.url).pathname;
/**
 * The sage state tool of the tests: SAGE_TOOL when it is set, else the pinned copy. It refuses a path in the owner's real
 * ~/.claude (os.userInfo, not $HOME), for example the sage plugin's cache, so that no test depends on it.
 * @param {NodeJS.ProcessEnv} [env] @returns {string}
 */
export function testSage(env = process.env) {
  const path = resolve(env.SAGE_TOOL || FIXTURE);
  const home = userInfo().homedir;
  const owner = join(home, '.claude') + sep;
  const inside = (p) => (p + sep).toLowerCase().startsWith(owner.toLowerCase()); // the Mac's disk ignores case
  // The path as given first, with no file system call, so that a path in ~/.claude is refused before any read of it (F-T162-3);
  // then the home folder and the path through their links.
  const real = () => {
    const realOwner = join(realpathSync.native(home), '.claude') + sep;
    return [path, existsSync(path) ? realpathSync.native(path) : path].some((p) => (p + sep).toLowerCase().startsWith(realOwner.toLowerCase()));
  };
  if (inside(path) || real()) {
    throw new Error(`SAGE_TOOL is ${path}, in the owner's ${owner}: the tests use the pinned copy ${FIXTURE}, or a copy outside it.`);
  }
  return sagePath({ env: { SAGE_TOOL: path } });
}
export const SAGE = testSage();
/** A scratch copy of the pinned sage whose `gate answer` writes decision rows with another why text, as a newer sage may (F-T45-2). */
export function changedSage() {
  const root = join(dirname(FIXTURE), '..', '..');
  // The real path: sage runs its command only when its argv[1] is its own real path, and TMPDIR may be a link (/var on macOS).
  const copy = join(realpathSync.native(tempFolder('sage-bot-why-')), 'sage');
  cpSync(root, copy, { recursive: true });
  const state = join(copy, 'core', 'state.mjs');
  const before = readFileSync(state, 'utf8');
  const after = before.replace(`"the user's answer" : "the user's own words"`, `"the owner's answer" : "the owner's own words"`);
  assert.notEqual(after, before, 'the copy changes the why text');
  writeFileSync(state, after);
  return join(copy, 'skills', 'sage', 'sage.mjs');
}
/** The environment of each child process of the tests: `env` (default process.env) with SAGE_TOOL, unless `env` names its own. */
export const testEnv = (env = process.env) => ({ ...env, SAGE_TOOL: env.SAGE_TOOL || SAGE });
const withEnv = (start) => (file, args = [], options = {}) => start(file, args, { ...options, env: testEnv(options.env) });
export const spawn = withEnv(cp.spawn);
export const spawnSync = withEnv(cp.spawnSync);
export const execFileSync = withEnv(cp.execFileSync);
export const APPRENTICE = '300000000000000001';
export const LEADR = '300000000000000002';
export const CHANNEL = '400000000000000001';
export const [OWNER, MAYA, JON, SAM, BOT] = ['100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004', '100000000000000005'];
export const MEMBERS = [
  { id: OWNER, name: 'Erick', roles: [LEADR] },
  { id: MAYA, name: 'Maya', roles: [APPRENTICE] },
  { id: JON, name: 'Jon', roles: [LEADR] },
  { id: SAM, name: 'Sam', roles: [] },
  { id: BOT, name: 'sage bridge', roles: [APPRENTICE, LEADR], bot: true },
];
export const GUILD = '500000000000000001';
export const CONFIG = { guildId: GUILD, channelId: CHANNEL, ownerId: OWNER, apprenticeRole: APPRENTICE, leadRole: LEADR };
export const T0 = Date.UTC(2026, 9, 4, 14, 0);
/** The name of the scratch project: its folder is `project`, so a config with no projects names it so (src/ask.js projectsOf). */
export const NAME = 'project';
/** The key of a gate of the scratch project, as the bridge names it (T132). */
export const key = (id) => `${NAME}/${id}`;

/**
 * A scratch project with a sage logbook, and a bridge on it with the fake Discord layer and a clock that the test moves.
 * With `markAll` (the default, for the tests of the rules before G13) each `gate add` also marks the new gate as a team vote;
 * the G13 tests pass `markAll: false` and mark gates with `b.mark`. `tool` is the sage state tool (default SAGE), for a test on a changed copy.
 */
export function setup({ members = MEMBERS, markAll = true, tool = SAGE } = {}) {
  const root = realpathSync.native(tempFolder('sage-bot-b3-')); // the folder as the disk spells it, as loadProjects resolves it
  const project = join(root, 'project');
  mkdirSync(project);
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), SAGE_HOME: join(root, 'home', 'sage') };
  const statePath = join(root, 'state', 'gates.json');
  const discord = fakeDiscord(members);
  const lines = [];
  const b = { root, project, env, discord, lines, now: T0, statePath, sagePath: tool };
  const run = toolOf(b, project);
  const sh = (...args) => {
    const out = run(...args);
    if (markAll && args[0] === 'gate' && args[1] === 'add') b.mark(...table(b, 'gates').map((r) => r.id));
    return out;
  };
  b.sh = sh;
  sh('init');
  /** Marks sage gates of the project as team votes, as scripts/vote.mjs does: by their keys, with the folder of the project (G45 A). */
  b.mark = (...ids) => saveVotes(`${statePath}.votes`, new Map([...loadVotes(`${statePath}.votes`), ...ids.map((id) => [`${NAME}/${id}`, project])]));
  b.sage = sageTool({ sagePath: tool, project, env });
  b.make = () => createBridge({ sages: new Map([[NAME, b.sage]]), own: NAME, discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => lines.push(l) });
  b.bridge = b.make();
  b.gates = () => readFileSync(join(sh('logbook'), 'gates.tsv'), 'utf8');
  b.answerOf = (id) => b.gates().split('\n').find((l) => l.startsWith(`${id}\t`)).split('\t')[6];
  b.press = async (user, customId, fields) => {
    const i = fakeInteraction({ user, customId, fields });
    await b.bridge.interaction(i);
    return i.replies;
  };
  /** Two loops SETTLE apart: the first sees the new gates, the second posts them. */
  b.post = async () => { await b.bridge.loop(); b.now += SETTLE; await b.bridge.loop(); };
  return b;
}
/**
 * The state tool on `folder`, a project in `b.root`, as the owner runs it at the terminal. A `gate answer <G> <text>` is what the
 * owner types since T176: a key ("A"), "A. text" or the option's text is `--option <n>`; any other words are `--other-hex`, and
 * sage keeps them as "other: <words>".
 */
export function toolOf(b, folder) {
  const run = (...args) => execFileSync(process.execPath, [b.sagePath ?? SAGE, ...args, '--project', folder], { env: b.env, encoding: 'utf8' }).trim();
  const typed = (id, text) => {
    const row = rowsOf(run('logbook'), 'gates').find((r) => r.id === id);
    const options = optionsOf(row);
    const m = /^([A-E])(?:\. (.*))?$/.exec(text);
    const named = m ? options[KEYS.indexOf(m[1])] : undefined;
    const picked = named !== undefined && (m[2] === undefined || m[2] === named) ? named : options.includes(text) ? text : `${OTHER}${text}`;
    return answerArgs(row, picked);
  };
  return (...args) => run(...(args[0] === 'gate' && args[1] === 'answer' && args.length === 4 ? [...args.slice(0, 3), ...typed(args[2], args[3])] : args));
}
/** The rows of a logbook table, as { column: value }. */
export const table = (b, name) => rowsOf(b.sh('logbook'), name);
function rowsOf(dir, name) {
  const [head, ...lines] = readFileSync(join(dir, `${name}.tsv`), 'utf8').split('\n').filter(Boolean);
  const cols = head.split('\t');
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
}

/** Sets the `at` of sage gate rows (sage writes the wall clock of `gate add`), so that a test can place questions in time. */
export function setAt(b, at) {
  const path = join(b.sh('logbook'), 'gates.tsv');
  const [head, ...lines] = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const col = head.split('\t').indexOf('at');
  const out = lines.map((l) => {
    const v = l.split('\t');
    if (v[0] in at) v[col] = at[v[0]];
    return v.join('\t');
  });
  writeFileSync(path, `${[head, ...out].join('\n')}\n`);
}
