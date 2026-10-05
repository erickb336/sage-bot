// T132 repair round 4 (G43 A): each listed project has one identity, resolved once at config load (src/projects.js loadProjects).
// A listed path in the wrong letter case (F-T132-18) and two names for one folder stop every caller at load; a session keeps the project
// of its spool (F-T132-19); a closed card's body agrees with its note (F-T132-20). SAMPLE DATA ONLY: scratch logbooks, made-up ids,
// the fake Discord layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { card } from '../src/cards.js';
import { prepare } from '../src/discord.js';
import { sageTool } from '../src/sage.js';
import { openGate } from '../src/vote.js';
import { CONFIG, OWNER, SAGE, setup, T0 } from './bridge-setup.js';

const SCRIPT = (name) => new URL(`../scripts/${name}`, import.meta.url).pathname;
const S1 = 'eeeeeeee-0000-4000-8000-000000000134';
const NOTE = 'This question\'s project is no longer served; Erick answers it at the terminal.';
const CLOSED_LINE = '**Closed:** this question\'s project is no longer served; Erick answers it at the terminal.';

/** Runs a script with the config file, in `cwd`, with a scratch HOME. Returns [status, stdout, stderr], trimmed. */
const run = (script, config, cwd, args = [], input = '') => {
  const r = spawnSync(process.execPath, [SCRIPT(script), '--config', config, ...args], { cwd, input, env: { PATH: process.env.PATH, HOME: join(cwd, 'no-home') }, encoding: 'utf8' });
  return [r.status, r.stdout.trim(), r.stderr.trim()];
};

/** Each caller stops at load with `line`: the bridge before the lock, vote.mjs and reasons.mjs with no mark, the hook with no spool. */
function refusedEverywhere(b, projects, line, cwd) {
  const file = { ...CONFIG, guildId: '200000000000000001', project: b.project, sagePath: SAGE, statePath: b.statePath, projects };
  assert.throws(() => prepare(file, () => {}), { message: line });
  assert.deepEqual([existsSync(`${b.statePath}.lock`), existsSync(`${b.statePath}.channels`)], [false, false]);
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify(file));
  assert.deepEqual(run('vote.mjs', config, cwd, ['G7']), [1, '', `sage-bot vote: ${line}`]);
  assert.equal(existsSync(`${b.statePath}.votes`), false);
  assert.deepEqual(run('reasons.mjs', config, cwd, ['G7']), [1, '', `sage-bot reasons: ${line}`]);
  const hook = run('hook.mjs', config, cwd, [], JSON.stringify({ session_id: S1, cwd, hook_event_name: 'SessionStart' }));
  assert.deepEqual(hook, [0, '', `sage-bot hook: nothing recorded: ${line}`]);
  assert.equal(existsSync(`${b.statePath}.sessions`), false);
  const plist = spawnSync(process.execPath, [SCRIPT('launchd.mjs'), config], { cwd, env: { PATH: process.env.PATH, HOME: join(cwd, 'no-home') }, encoding: 'utf8' });
  assert.deepEqual([plist.status, plist.stdout, plist.stderr.trim()], [1, '', `sage-bot launchd: in the config file ${config}, ${line.replace(/ Nothing changed\.$/, '')} No plist printed.`]); // F-T145-L1
}

test('F-T132-18: a listed path that differs from its folder on disk only in letter case stops every caller at load; own/G7 is never marked', () => {
  const b = setup({ markAll: false });
  const beta = join(b.root, 'beta');
  mkdirSync(beta);
  const upper = join(b.root, 'BETA'); // the same folder on this Mac's file system, which ignores letter case
  const line = `the path of project beta (${upper}) differs only in letter case from its folder on disk (${beta}). Write it as the disk spells it. Nothing changed.`;
  refusedEverywhere(b, [{ name: 'project', project: b.project }, { name: 'beta', project: upper }], line, beta);
});

test('G43 A: two names for one folder, also by a symlink, stop every caller at load with one line', () => {
  const b = setup({ markAll: false });
  const line = (path) => `projects project (${b.project}) and twin (${path}) are the same folder (${b.project}). Keep one of them. Nothing changed.`;
  refusedEverywhere(b, [{ name: 'project', project: b.project }, { name: 'twin', project: `${b.project}/` }], line(`${b.project}/`), b.project);
  const link = join(b.root, 'link');
  symlinkSync(b.project, link);
  refusedEverywhere(b, [{ name: 'project', project: b.project }, { name: 'twin', project: link }], line(link), b.project);
});

test('F-T132-19: a session that starts in a project keeps it: its gate add and its end in a nested project\'s folder go to its spool', () => {
  const b = setup({ markAll: false });
  const sub = join(b.project, 'b');
  mkdirSync(sub);
  const config = join(b.root, 'config.json');
  writeFileSync(config, JSON.stringify({ project: b.project, sagePath: SAGE, statePath: b.statePath, projects: [{ name: 'project', project: b.project }, { name: 'sub', project: sub }] }));
  const hook = (cwd, event, extra = {}) => run('hook.mjs', config, cwd, [], JSON.stringify({ session_id: S1, cwd, hook_event_name: event, ...extra }));
  assert.deepEqual(hook(b.project, 'SessionStart'), [0, '', '']);
  const gateAdd = { tool_name: 'Bash', tool_input: { command: 'node sage.mjs gate add T3 --question "Q?"' }, tool_response: { stdout: 'G5 open · Q?\n' } };
  assert.deepEqual(hook(sub, 'PostToolUse', gateAdd), [0, '', '']);
  assert.deepEqual(hook(sub, 'SessionEnd'), [0, '', '']);
  const spool = JSON.parse(readFileSync(join(`${b.statePath}.sessions`, `${S1}.json`), 'utf8'));
  assert.deepEqual([spool.project, spool.cwd, spool.gates, spool.tasks, typeof spool.endedAt], ['project', b.project, ['G5'], ['T3'], 'number']);
});

test('F-T132-20: a closed card\'s body says the vote is closed, as its note does; the card of a project that returns gets its normal body back', async () => {
  const b = setup({ markAll: false });
  const beta = join(b.root, 'beta');
  mkdirSync(beta);
  const env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  const shBeta = (...args) => execFileSync(process.execPath, [SAGE, ...args, '--project', beta], { env, encoding: 'utf8' }).trim();
  shBeta('init');
  shBeta('task', 'add', '--title', 'Beta colours', '--size', 'small');
  shBeta('gate', 'add', 'T1', '--question', 'Which colour?', '--options', 'Red|Blue', '--recommend', 'Red');
  writeFileSync(`${b.statePath}.votes`, '["beta/G1"]', { mode: 0o600 });
  const sages = (...names) => new Map([['project', b.sage], ['beta', sageTool({ sagePath: SAGE, project: beta, env })]].filter(([n]) => names.includes(n)));
  const bridge = (...names) => createBridge({ sages: sages(...names), own: 'project', discord: b.discord, config: CONFIG, statePath: b.statePath, now: () => b.now, log: (l) => b.lines.push(l) });
  b.bridge = bridge('project', 'beta');
  await b.post();
  const [id] = b.discord.messages.keys();
  const description = () => b.discord.latest(id).embeds[0].description;
  const rules = (text) => text.split('\n').filter((l) => /^\*\*(Rule|Who can answer|Closed):\*\*/.test(l));
  const normal = ['**Rule:** the first answer is final · reminder every 2 h until answered', '**Who can answer:** every sage-apprentice or sage-lead'];
  assert.deepEqual(rules(description()), normal);
  b.bridge = bridge('project'); // beta leaves the config
  await b.bridge.loop();
  assert.deepEqual([b.discord.latest(id).content, rules(description())], [NOTE, [CLOSED_LINE]]);
  b.bridge = bridge('project', 'beta'); // beta returns
  await b.bridge.loop();
  assert.deepEqual([b.discord.latest(id).content, rules(description())], ['', normal]);
});

test('F-T132-20: a closed batch card has no rule footer and no reminder line, only the closed line', () => {
  const gate = openGate({ id: 'beta/G1+G2', kind: 'batch', parts: [['A', 'B'], ['A', 'B']], askedBy: OWNER, at: T0 });
  const ask = { kind: 'batch', task: 'T1', title: 'Beta colours', parts: gate.parts.map(() => ({ question: 'Which?', why: 'w', recommended: 'A', options: { A: 'Red', B: 'Blue' } })) };
  const ppl = { holders: new Set(), names: new Map() };
  const open = card(gate, ask, ppl).embeds[0];
  assert.match(open.footer.text, /^Rule: 30 minutes/);
  const shut = card(gate, ask, ppl, { shut: true }).embeds[0];
  assert.deepEqual([shut.description, shut.footer, JSON.stringify(shut).includes('every 2 h')], [CLOSED_LINE, undefined, false]);
});
