// The scratch logbook and the bridge on the fake Discord layer, for the bridge tests. SAMPLE DATA ONLY: every id and name is made up.
// The sage state tool runs with HOME and SAGE_HOME in a scratch folder, so no test touches a real logbook.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, SETTLE } from '../src/bridge.js';
import { fakeDiscord, fakeInteraction } from '../src/fake-discord.js';
import { sageTool } from '../src/sage.js';
import { loadVotes, saveVotes } from '../src/state.js';

export const SAGE = process.env.SAGE_TOOL ?? '/Users/erickb336/.claude/plugins/cache/sage/sage/39e9bf767a1f/skills/sage/sage.mjs';
export const DRIVER = '300000000000000001';
export const LEADR = '300000000000000002';
export const [OWNER, MAYA, JON, SAM, BOT] = ['100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004', '100000000000000005'];
export const MEMBERS = [
  { id: OWNER, name: 'Erick', roles: [DRIVER, LEADR] },
  { id: MAYA, name: 'Maya', roles: [DRIVER] },
  { id: JON, name: 'Jon', roles: [DRIVER, LEADR] },
  { id: SAM, name: 'Sam', roles: [] },
  { id: BOT, name: 'sage bridge', roles: [DRIVER, LEADR], bot: true },
];
export const CONFIG = { ownerId: OWNER, driverRole: DRIVER, leadRole: LEADR };
export const T0 = Date.UTC(2026, 9, 4, 14, 0);

/**
 * A scratch project with a sage logbook, and a bridge on it with the fake Discord layer and a clock that the test moves.
 * With `markAll` (the default, for the tests of the rules before G13) each `gate add` also marks the new gate as a team vote;
 * the G13 tests pass `markAll: false` and mark gates with `b.mark`.
 */
export function setup({ members = MEMBERS, markAll = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sage-bot-b3-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), SAGE_HOME: join(root, 'home', 'sage') };
  const run = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', project], { env, encoding: 'utf8' }).trim();
  const statePath = join(root, 'state', 'gates.json');
  const sh = (...args) => {
    const out = run(...args);
    if (markAll && args[0] === 'gate' && args[1] === 'add') b.mark(...table(b, 'gates').map((r) => r.id));
    return out;
  };
  sh('init');
  const discord = fakeDiscord(members);
  const lines = [];
  const b = { root, project, sh, discord, lines, now: T0, statePath };
  /** Marks sage gates as team votes, as scripts/vote.mjs does. */
  b.mark = (...ids) => saveVotes(`${statePath}.votes`, new Set([...loadVotes(`${statePath}.votes`), ...ids]));
  b.sage = sageTool({ sagePath: SAGE, project, env });
  b.make = () => createBridge({ sage: b.sage, discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => lines.push(l) });
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
/** The rows of a logbook table, as { column: value }. */
export function table(b, name) {
  const [head, ...lines] = readFileSync(join(b.sh('logbook'), `${name}.tsv`), 'utf8').split('\n').filter(Boolean);
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
