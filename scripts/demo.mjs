// The demo (T51): npm run demo [-- --out <page.html>] [--shot <page.png>]
// It plays one sage session end to end with the real sage state tool, the real hook (scripts/hook.mjs), the real team votes
// command (scripts/vote.mjs) and the real bridge on the fake Discord layer, then writes one HTML page of the parent channel line and
// the session thread. SAMPLE DATA ONLY: made-up people, Discord ids, tasks and questions, and a scripted clock.
// No Discord, no bot, no token, no network. Everything goes into one fresh scratch folder; HOME and SAGE_HOME of every child process
// are in it, so nothing touches the owner's home folder or real logbook. The page goes to --out, else to <TMPDIR>/sage-bot-demo.html.
process.env.TZ = 'UTC'; // the title of a thread has the host's date
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAsk } from '../src/ask.js';
import { createBridge, LOOP, SETTLE } from '../src/bridge.js';
import { openChannels } from '../src/channels.js';
import { fakeCommand, fakeDiscord, fakeInteraction } from '../src/fake-discord.js';
import { loadProjects } from '../src/projects.js';
import { createRequestFlow } from '../src/requestFlow.js';
import { loadRequests, requestsPathOf } from '../src/requests.js';
import { CREW } from '../src/crew.js';
import { sagePath, sageTool } from '../src/sage.js';
import { MINUTE } from '../src/vote.js';
import { CSS, esc, hhmm, md, message, modalHtml, noteHtml } from './render.mjs';

// ---- Sample data -------------------------------------------------------------------------------------------------------------
const [CREW_ROLE, CHANNEL, ASK] = ['300000000000000001', '400000000000000001', '400000000000000002']; // #sage and #ask-sage
const [ERICK, MAYA, JON, SAM] = ['100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004'];
const MEMBERS = [
  { id: ERICK, name: 'Erick', roles: [CREW] },
  { id: MAYA, name: 'Maya', roles: [CREW] },
  { id: JON, name: 'Jon', roles: [CREW] },
  { id: SAM, name: 'Sam', roles: [] },
  { id: '100000000000000005', name: 'sage bridge', roles: [CREW], bot: true },
];
const NAMES = new Map(MEMBERS.map((m) => [m.id, m.name]));
const CONFIG = { channelId: CHANNEL, ownerId: ERICK, ownerName: 'Erick' }; // ownerName as src/discord.js reads it at the start (T244)
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000051';
const T0 = Date.UTC(2026, 9, 4, 14, 0);

// ---- The scratch folder ------------------------------------------------------------------------------------------------------
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const fail = (text) => { console.error(`sage-bot demo: ${text}`); process.exit(1); };
// Both checks come before the run, so that a bad --out or a missing sage fails at once, with no scratch folder.
const outArg = arg('--out') && resolve(arg('--out'));
if (outArg) {
  try { mkdirSync(dirname(outArg), { recursive: true }); } catch (e) {
    fail(`cannot use --out ${outArg}: its folder ${dirname(outArg)} cannot be made (${e.code}). Give a page path in a folder.`);
  }
  if (statSync(outArg, { throwIfNoEntry: false })?.isDirectory()) fail(`--out ${outArg} is a folder. Give the path of the page, for example ${join(outArg, 'demo.html')}.`);
}
let SAGE;
try { SAGE = sagePath(); } catch (e) { fail(e.message); }
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-demo-'))); // the real path, as loadProjects names the project
process.on('exit', () => rmSync(root, { recursive: true, force: true })); // the scratch folder goes at the end, also after a failure (T57)
const out = outArg ?? join(tmpdir(), 'sage-bot-demo.html'); // with no --out, one fixed page outside the repo, overwritten on each run (F-T57-2)
const project = join(root, 'project');
const statePath = join(root, 'state', 'gates.json');
const configPath = join(root, 'config.json');
mkdirSync(project);
mkdirSync(join(root, 'home'));
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), SAGE_HOME: join(root, 'home', 'sage'), TZ: 'UTC' };
writeFileSync(configPath, JSON.stringify({ ...CONFIG, project, sagePath: SAGE, statePath }));
const node = (args, input) => execFileSync(process.execPath, args, { cwd: project, env, input, encoding: 'utf8' }).trim(); // sage runs in the project's folder
const sage = (...args) => node([SAGE, ...args, '--project', project]);
const script = (name) => new URL(name, import.meta.url).pathname;

// ---- The story: what the page shows, in order ---------------------------------------------------------------------------------
let now = T0;
const story = []; // { kind: 'post', id } | { kind: 'terminal', at, text } | { kind: 'press', at, who, text, replies, form }
const steps = [];
const step = (text) => { steps.push(text); console.log(`${String(steps.length).padStart(2)}. ${text}`); };
const terminal = (text) => story.push({ kind: 'terminal', at: now, text });

const fake = fakeDiscord(MEMBERS, [{ id: CREW_ROLE, name: CREW }]);
const postedAt = new Map();
const editedAt = new Map(); // message id -> the time of each edit, in order: fake.messages has the payloads
const discord = { ...fake, async post(target, payload) {
  const id = await fake.post(target, payload);
  postedAt.set(id, now);
  story.push({ kind: 'post', id });
  return id;
}, async edit(target, id, payload) {
  await fake.edit(target, id, payload);
  editedAt.set(id, [...editedAt.get(id) ?? [], now]);
} };
const log = [];
const bridge = createBridge({ sages: new Map([['project', sageTool({ sagePath: SAGE, project, env })]]), own: 'project', discord, config: CONFIG, statePath, now: () => now, log: (l) => log.push(l) });
const loop = () => bridge.loop();
/** Moves the clock on by `ms`, with a loop of the bridge every LOOP, as the running bridge does (a longer gap is a sleep of the Mac). */
async function advance(ms) {
  for (const to = now + ms; now < to;) { now = Math.min(to, now + LOOP); await loop(); }
}
/** One press in Discord by a sample person, with its private replies. */
async function press(who, text, customId, { fields, ephemeral, form } = {}) {
  const i = fakeInteraction({ user: who, customId, fields, ephemeral });
  story.push({ kind: 'press', at: now, who: NAMES.get(who), text, replies: i.replies, form }); // before the posts that the press causes
  await bridge.interaction(i);
}
/** The hook, as Claude Code runs it, at the demo's clock: the real scripts/hook.mjs with only Date.now set to the scripted time. */
const hook = (event, extra = {}) => node([`--import=data:text/javascript,Date.now=()=>${now}`, script('hook.mjs'), '--config', configPath],
  JSON.stringify({ session_id: SESSION, cwd: project, hook_event_name: event, ...extra }));
/** `sage gate add` as sage runs it, then the PostToolUse hook with its real output. Returns the gate id. */
function gateAdd(task, question, options, recommend) {
  const args = ['gate', 'add', task, '--question', question, '--options', options, '--recommend', recommend];
  const said = sage(...args);
  hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: `node ${SAGE} ${args.slice(0, 3).join(' ')} --question "${question}" --project ${project}` },
    tool_response: { stdout: `${said}\n`, stderr: '' } });
  return said.split(' ')[0];
}

// 1. The scratch project.
sage('init');
for (const [title, size] of [['Sign-in page copy', 'tiny'], ['CSV export for reports', 'small'], ['Release notes', 'tiny'], ['Empty state for the reports page', 'small']]) {
  sage('task', 'add', '--title', title, '--size', size);
}
step('sage init: a scratch project with 4 sample tasks (T1 to T4)');

// 2. The sage session starts.
hook('SessionStart', { source: 'startup' });
terminal('The sage session starts. The SessionStart hook records it.');
step(`SessionStart hook for session ${SESSION}`);

// 3. sage adds 3 gates: a single question, a batch of 2, and one that stays at the terminal.
await advance(MINUTE);
const g1 = gateAdd('T1', 'What does the sign-in button say?', 'Sign in|Continue|Log in', 'Sign in');
const g2 = gateAdd('T2', 'Which columns go in the export?', 'Only the visible columns|All fields, also the hidden ones', 'Only the visible columns');
const g3 = gateAdd('T2', 'How do dates look in the file?', '2026-10-04 (ISO)|04/10/2026 (the user locale)', '2026-10-04 (ISO)');
const g4 = gateAdd('T3', 'Which version number do the release notes use?', '1.4.0|2.0.0', '1.4.0');
terminal(`sage adds 4 gates with sage gate add: ${g1} (T1), ${g2} and ${g3} (T2, asked together), ${g4} (T3).`);
step(`gate add: ${g1} single (T1), ${g2}+${g3} batch (T2), ${g4} unmarked (T3); PostToolUse hook for each`);

// 4. sage marks the team votes.
const marked = node([script('vote.mjs'), '--config', configPath, g1, g2, g3]);
terminal(`sage marks ${g1}, ${g2} and ${g3} as team votes (scripts/vote.mjs). ${g4} stays at the terminal.`);
step(`vote.mjs: ${marked}`);

// 5. The bridge on the fake Discord layer.
await loop();
await advance(SETTLE);
// The bridge names each gate by its key: the project name (here the folder name, project), a slash and the sage gate ids (T132).
const single = `project/${g1}`;
const batch = `project/${g2}+${g3}`;
step(`bridge: the session line and its thread, the card of ${single} and the card of ${batch}`);
await advance(MINUTE);
await press(MAYA, 'Maya presses A.', `press:${single}:0:0`);
step(`Maya answers ${single}: final`);
await advance(20_000);
await press(JON, 'Jon presses B, 20 seconds later.', `press:${single}:0:1`);
await advance(MINUTE);
await press(SAM, 'Sam has no role and presses part 1, A. The press does not count: Sam gets one private line, and the vote does not change.', `press:${batch}:0:0`);
step('Sam presses: no sage role, so the press does not count and Sam gets one private line');
await advance(MINUTE);
const vote = async (who, name, part, option, reason, form = false) => {
  await press(who, `${name} votes ${'AB'[option]} on part ${part + 1}; the reason form opens.`, `press:${batch}:${part}:${option}`, { form });
  await press(who, `${name} adds a reason.`, `reason:${batch}:${part}:${option}`, { fields: { reason } });
  await advance(MINUTE);
};
await vote(MAYA, 'Maya', 0, 0, 'Hidden fields hold internal ids. Customers should not see them.', true);
await vote(MAYA, 'Maya', 1, 0, 'Every spreadsheet sorts ISO dates.');
await vote(JON, 'Jon', 0, 0, 'Same as Maya: export what the table shows.');
await vote(JON, 'Jon', 1, 1, 'Our EU customers read day/month first.');
step(`Maya and Jon vote on ${batch} with reasons: part 2 is tied 1-1`);
await advance(bridge.entry(batch).gate.endsAt - now);
step(`the vote ends at 30 minutes: part 1 goes to A, part 2 is tied; the tie post goes to the thread`);
await advance(5 * MINUTE);
await press(ERICK, 'Erick, the owner, breaks the tie on part 2: B.', `tiebreak:${batch}:1:1`);
step('Erick breaks the tie; the bridge gives sage the answers');

// The owner answers one part of a second small batch at the terminal: the owner's answer at the terminal is final.
await advance(MINUTE);
const g5 = gateAdd('T4', 'What does the empty reports page show?', 'An example report and a Create button|Only a Create button', 'An example report and a Create button');
const g6 = gateAdd('T4', 'Does the empty page link to the help article?', 'Yes, under the button|No', 'Yes, under the button');
node([script('vote.mjs'), '--config', configPath, g5, g6]);
terminal(`sage adds ${g5} and ${g6} (T4, asked together) and marks both as team votes.`);
await loop();
await advance(SETTLE);
const second = `project/${g5}+${g6}`;
step(`gate add ${g5}+${g6} (T4): a second batch card in the thread`);
await advance(MINUTE);
sage('gate', 'answer', g5, '--option', '1');
terminal(`Erick, the owner, answers ${g5} at the terminal: option 1. The owner's answer at the terminal is final.`);
await loop();
step(`Erick answers ${g5} at the terminal: the card shows it as final`);
await advance(MINUTE);
await press(JON, 'Jon presses part 1, B.', `press:${second}:0:1`);
await advance(MINUTE);
await press(MAYA, 'Maya votes A on part 2 and closes the reason form without a reason.', `press:${second}:1:0`);
await advance(MINUTE);
await press(ERICK, 'Erick, the owner, presses End vote now.', `end:${second}`);
await press(ERICK, 'Erick confirms in his private note.', `end!:${second}`, { ephemeral: true });
await loop();
step(`Erick ends the vote on ${second} early: part 2 goes to A`);

// SessionEnd: the line says "ended", and the thread locks because nothing is open.
await advance(MINUTE);
sage('gate', 'answer', g4, '--option', '1');
terminal(`Erick answers ${g4} at the terminal: option 1. It was never on Discord.`);
hook('SessionEnd', { reason: 'logout' });
terminal('The sage session ends. The SessionEnd hook records it.');
await advance(MINUTE);
await loop();
const [threadId, thread] = [...fake.threads][0];
step(`SessionEnd: the line says ended; the thread is ${thread.locked ? 'locked' : 'NOT locked'}`);

// ---- A request (T228): a crew member asks for a feature in the channel, and the owner approves it -------------------------------
const split = story.length; // the events of the request come after this one
const rconfig = { ...CONFIG, askChannelId: ASK, project, sagePath: SAGE, statePath }; // the crew requests in #ask-sage (docs/setup.md)
const projects = loadProjects(rconfig);
const channels = openChannels(rconfig, projects);
let drafts = 0;
const requests = createRequestFlow({ config: rconfig, channels, projects, now: () => now, log: (l) => log.push(l), tool: () => sageTool({ sagePath: SAGE, project, env }),
  newKey: () => `D${++drafts}`, // fixed keys, so that two runs give the same page
  discord: { post: discord.post, edit: discord.edit, startThread: (at, line, name) => discord.startThread(line, name), threadFrom: (at, line) => discord.threadFrom(line), unarchive: discord.unarchive } });
const ask = createAsk({ config: rconfig, channels, projects, now: () => now, log: (l) => log.push(l), env, requests });
const roleNames = new Map(MEMBERS.map((m) => [m.id, m.roles]));
/** One request press (or form) by a sample person, with its private replies, as src/discord.js maps it. */
async function ask1(who, text, customId, { fields, message: on, form } = {}) {
  const i = fakeInteraction({ user: who, customId, fields, message: on, sentAt: now, roles: roleNames.get(who) });
  story.push({ kind: 'press', at: now, who: NAMES.get(who), text, replies: i.replies, form });
  await requests.interaction(i);
  return i.replies;
}
await advance(MINUTE);
const typed = fakeCommand({ user: JON, name: 'Jon', roles: roleNames.get(JON), channelId: ASK, sub: 'request' });
story.push({ kind: 'press', at: now, who: 'Jon', text: 'Jon types /sage request in #ask-sage. The form opens.', replies: typed.replies, form: true });
await ask.command(typed);
const key = /^rq1:form:(D\d+)$/.exec(typed.replies[0].custom_id)[1];
await ask1(JON, 'Jon fills in the form and submits it. Only Jon sees the confirm.', `rq1:form:${key}`,
  { fields: { title: 'Add CSV export', text: 'Finance copies the monthly report into a spreadsheet by hand. A CSV download saves them an hour each month.' } });
await ask1(JON, 'Jon presses "Send: the crew votes on design questions".', `rq1:send-team:${key}`);
const rq = loadRequests(requestsPathOf(rconfig)).requests[0];
step(`Jon requests a feature: ${rq.id}, one line in #ask-sage, one thread and one card that pings Erick once`);
await advance(MINUTE);
await ask1(MAYA, 'Maya presses Approve on the card.', `rq1:approve:${rq.id}`, { message: rq.card });
await ask1(SAM, 'Sam has no role and presses Approve.', `rq1:approve:${rq.id}`, { message: rq.card });
await advance(MINUTE);
await ask1(ERICK, 'Erick, the owner, presses Approve.', `rq1:approve:${rq.id}`, { message: rq.card });
await advance(LOOP);
step(`Erick approves ${rq.id}: sage task ${loadRequests(requestsPathOf(rconfig)).requests[0].task} is in the logbook; Maya and Sam cannot approve`);

// ---- The answers in sage and the reasons for sage -------------------------------------------------------------------------
const [head, ...rowsTsv] = readFileSync(join(sage('logbook'), 'gates.tsv'), 'utf8').split('\n').filter(Boolean);
const cols = head.split('\t');
const gates = rowsTsv.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
const reasons = [`${g2}+${g3}`, `${g5}+${g6}`].map((id) => [id, node([script('reasons.mjs'), '--config', configPath, id])]);

// ---- The page ------------------------------------------------------------------------------------------------------------------
/** The mentions as Discord shows them: the role, Erick, and a channel or a thread by its name (F-T228-2). */
const roles = (text) => text.replaceAll(`<@&${CREW_ROLE}>`, `@${CREW}`).replaceAll(`<@${ERICK}>`, '@Erick')
  .replace(/<#(\d+)>/g, (m, id) => (fake.threads.has(id) ? `#${fake.threads.get(id).name}` : { [CHANNEL]: '#sage', [ASK]: '#ask-sage' }[id] ?? m));
/** A message as Discord shows it: an edit replaces only the fields that it has, so a card keeps the text of its first post. */
const show = (p) => (p.content ? { ...p, content: roles(p.content) } : p);
const latest = (id) => show(Object.assign({}, ...fake.messages.get(id)));
/** Each state of a message that looks different, with its time: the first post, then each edit that changed what people see. */
function states(id) {
  const all = fake.messages.get(id).map((_, i, ps) => ({ p: show(Object.assign({}, ...ps.slice(0, i + 1))), at: i ? editedAt.get(id)[i - 1] : postedAt.get(id) }));
  return all.filter((s, i) => !i || message(s.p, s.at) !== message(all[i - 1].p, s.at));
}
const lineId = thread.from;
/**
 * The events in one thread, in order: its posts as they are now, the terminal lines and each press with its private replies. A request
 * press answers privately also by an edit of its deferred reply (editReply) or of its private confirm (update).
 */
const render = (events, thread, privateEdits = false) => events.map((e) => {
  if (e.kind === 'post') return fake.where.get(e.id) !== thread ? '' : !privateEdits ? message(latest(e.id), postedAt.get(e.id))
    : states(e.id).map((s, i) => (i ? `<div class="edited"><span class="when">edited · ${hhmm(s.at / 1000)}</span>${message(s.p, s.at)}</div>` : message(s.p, s.at))).join('\n');
  if (e.kind === 'terminal') return `<div class="term"><b>Terminal</b> · ${hhmm(e.at / 1000)} · ${esc(e.text)}</div>`;
  const notes = e.replies.flatMap((r) => (r.kind === 'modal' ? (e.form ? [modalHtml(r)] : [])
    : r.kind !== 'defer' && (r.flags || (privateEdits && ['editReply', 'update'].includes(r.kind))) ? [noteHtml(show(r), e.at).replace('Only you can see this', `Only ${esc(e.who)} can see this`)] : []));
  return `<div class="act"><b>${esc(e.who)}</b> · ${hhmm(e.at / 1000)} · ${esc(e.text)}</div>${notes.join('\n')}`;
}).filter(Boolean);
const shown = render(story.slice(0, split), threadId);
const request = loadRequests(requestsPathOf(rconfig)).requests[0];
const requestThread = fake.threads.get(request.thread);
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sage-bot demo</title><style>${CSS}
  .chan { color: #949ba4; font-size: 13px; font-weight: 600; margin: 0 0 4px; } .chan b { color: #f2f3f5; }
  .tag { display: inline-block; background: #404249; border-radius: 3px; padding: 0 6px; font-size: 12px; color: #dbdee1; margin-left: 6px; }
  .term { margin-top: 10px; color: #b5bac1; font: 13px/1.4 ui-monospace, Menlo, monospace; background: #1e1f22; border-radius: 4px; padding: 6px 10px; }
  .edited { margin: 6px 0 0 52px; border-left: 2px solid #404249; padding-left: 10px; font-size: 14px; } .when { color: #949ba4; font-size: 12px; }
  .act { margin-top: 14px; color: #949ba4; font-size: 13px; } .act b { color: #f2f3f5; }
  table { border-collapse: collapse; font-size: 13px; } td, th { text-align: left; padding: 4px 10px 4px 0; vertical-align: top; } th { color: #949ba4; }
  pre { white-space: pre-wrap; font: 12px/1.5 ui-monospace, Menlo, monospace; background: #1e1f22; border-radius: 4px; padding: 8px 10px; margin: 6px 0 12px; }
  @media (max-width: 600px) { section { padding: 12px 16px; } }
</style></head><body><div class="banner">Sample data. Fake Discord. No bot, no token.</div>
<section><h2>The sage-bot demo: one sage session</h2><p class="about">npm run demo played this session with the real sage state tool, the real hook,
the real team votes command and the real bridge, on the fake Discord layer with a scripted clock. The people (Erick: the owner, in the crew;
Maya and Jon: sage-crew; Sam: no role), the tasks and the questions are made up. Times are in UTC.</p></section>
<section id="channel"><p class="chan"># <b>sage</b> · the parent channel. The bridge edits the session's line as the session goes on: first as posted, then each edit.</p>
${states(lineId).map((s, i) => (i ? `<div class="edited"><span class="when">edited · ${hhmm(s.at / 1000)}</span><div>${md(s.p.content, s.at)}</div></div>` : message(s.p, s.at))).join('\n')}
<p class="about">Thread: <b>${esc(thread.name)}</b><span class="tag">${thread.locked ? 'locked' : 'open'}</span><span class="tag">${thread.archived ? 'archived' : 'active'}</span>
<span class="tag">${fake.in(threadId).length} messages</span></p></section>
<section id="thread"><p class="chan">Thread <b>${esc(thread.name)}</b> · the session thread, in order. Each card shows its final state; the grey lines say what people and the terminal did.</p>
${shown.join('\n')}
<div class="term"><b>Thread</b> · ${thread.locked ? 'locked and archived: the session ended and no question is open' : 'still open'}.</div></section>
<section id="request"><h2>A request: Jon asks for a feature, and Erick approves it</h2><p class="about">Any sage-crew member can type /sage request. The request gets one line in the channel
and one thread, and its card pings Erick once. Only Erick approves or declines; only Jon can withdraw it while it waits. The line in #ask-sage, first as posted, then each edit:</p>
${states(request.line).map((s, i) => (i ? `<div class="edited"><span class="when">edited · ${hhmm(s.at / 1000)}</span><div>${md(s.p.content, s.at)}</div></div>` : message(s.p, s.at))).join('\n')}
<p class="chan">Thread <b>${esc(requestThread.name)}</b> · the request thread, in order, with the private notes of each press.</p>
${render(story.slice(split), request.thread, true).join('\n')}</section>
<section id="answers"><h2>The answers in sage (gates.tsv)</h2><table><tr><th>id</th><th>task</th><th>question</th><th>answer</th></tr>
${gates.map((g) => `<tr><td>${esc(g.id)}</td><td>${esc(g.task)}</td><td>${esc(g.question)}</td><td>${esc(g.answer || '(open)')}</td></tr>`).join('\n')}</table>
<h2 style="margin-top:14px">The reasons for sage (scripts/reasons.mjs)</h2>
${reasons.map(([id, text]) => `<p class="about">node scripts/reasons.mjs --config &lt;config.json&gt; ${esc(id)}</p><pre>${esc(text)}</pre>`).join('\n')}</section>
</body></html>
`;
writeFileSync(out, page);
step(`page written`);

console.log('\nThe answers in sage (gates.tsv):');
for (const g of gates) console.log(`  ${g.id}  ${g.task}  ${g.answer || '(open)'}  · ${g.question}`);
console.log('\nThe bridge log:');
for (const l of log) console.log(`  ${l}`);
console.log(`\nPage: ${out}`);

const shot = arg('--shot');
if (shot) {
  const { chromium } = await import('playwright-core');
  // --disable-gpu, as in scripts/preview.mjs: the software raster path draws the same pixels on every cold start.
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] });
  const pg = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await pg.goto(new URL(`file://${out}`).href);
  await pg.screenshot({ path: resolve(shot), fullPage: true });
  await browser.close();
  console.log(`Screenshot: ${resolve(shot)}`);
}
