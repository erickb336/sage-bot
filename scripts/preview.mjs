// Renders the card JSON of the design's moments to one static HTML page (design/b2/index.html) and, with --shots,
// screenshots each moment to design/b2/shots/ with the local Chrome (playwright-core, channel 'chrome').
// SAMPLE DATA ONLY: made-up people and questions, times in UTC. No Discord, no network.
//   node scripts/preview.mjs            the page only
//   HOME=/tmp/scratch node scripts/preview.mjs --shots   the page and the screenshots
import { mkdirSync, writeFileSync } from 'node:fs';
import { handle, peopleOf } from '../src/handle.js';
import { card } from '../src/cards.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { step } from '../src/vote.js';
import { embedLength } from 'discord.js';
import { ASKS, MEMBERS, CONFIG, ERICK, MAYA, JON, SAM, clock, openAsk } from '../examples/sample.js';
import { openGate } from '../src/vote.js';

const OUT = new URL('../design/b2/', import.meta.url);
const people = peopleOf(MEMBERS, CONFIG);
const gates = new Map();
const ctx = { gates, people, clock: () => ctx.now, now: 0 };
const open = (id, at) => gates.set(id, { gate: openAsk(id, at), ask: ASKS[id] });
const send = (id, event) => gates.set(id, { gate: step(gates.get(id).gate, event, people.holders, people.leads).gate, ask: ASKS[id] });
async function press(user, customId, at, fields, ephemeral) {
  ctx.now = at;
  const i = fakeInteraction({ user, customId, fields, ephemeral });
  await handle(i, ctx);
  return i.replies[0];
}
const cardOf = (id, ctx_ = ctx) => card(ctx_.gates.get(id).gate, ctx_.gates.get(id).ask, ctx_.people);
const moments = [];
const moment = (file, title, about, id, extra = {}) => moments.push({ file, title, about, now: ctx.now, card: cardOf(id), ...extra });

// 1 to 2: a single question, answered first by Maya; Jon presses one second later.
open('G5', clock(14, 20)); ctx.now = clock(14, 21);
moment('01-single-open', 'A single question', 'The first answer of a sage-driver is final.', 'G5');
await press(MAYA, 'press:G5:0:0', clock(14, 22));
const late = await press(JON, 'press:G5:0:1', clock(14, 22, 1));
moment('02-already-answered', 'Maya answered first; Jon presses one second later', 'Only Jon sees the private note.', 'G5', { note: late });
// 3 to 6: the batch vote of T7, with reasons, the time limit, a tie and the lead's tie-break.
open('B7', clock(14, 31));
send('B7', { type: 'press', by: ERICK, part: 0, option: 'A', at: clock(14, 33), via: 'terminal' });
await press(JON, 'press:B7:0:0', clock(14, 35)); // Jon dismisses the reason modal: the vote still counts
send('B7', { type: 'press', by: ERICK, part: 1, option: 'A', at: clock(14, 36), via: 'terminal' });
await press(JON, 'press:B7:1:1', clock(14, 38));
await press(JON, 'reason:B7:1:1', clock(14, 38, 30), { reason: 'Our EU customers read day/month first.' });
send('B7', { type: 'press', by: ERICK, part: 2, option: 'A', at: clock(14, 39), via: 'terminal' });
await press(JON, 'press:B7:2:1', clock(14, 40));
ctx.now = clock(14, 43);
moment('03-batch-open', 'The batch vote of a task', '18 minutes left; Erick voted at his terminal; Jon gave a reason.', 'B7');
const modal = await press(MAYA, 'press:B7:1:2', clock(14, 44));
moment('04-reason-modal', 'Maya votes C on part 2 and may add a reason', 'Her vote counts already; the form is optional.', 'B7', { modal });
await press(MAYA, 'reason:B7:1:2', clock(14, 44, 30), { reason: 'Finance imports ISO dates; sales wants the local format. Both serve them.' });
await press(MAYA, 'press:B7:0:0', clock(14, 45)); await press(MAYA, 'press:B7:2:0', clock(14, 46));
send('B7', { type: 'tick', at: clock(15, 1) }); ctx.now = clock(15, 1);
moment('05-tie-at-limit', 'At 30 minutes the vote ends; part 2 is tied 1-1-1', 'Parts 1 and 3 are provisional; the tie-break buttons show the tied options only.', 'B7');
await press(JON, 'tiebreak:B7:1:0', clock(17, 5));
moment('06-lead-tie-break', 'Jon, a lead, breaks the tie: the batch is decided', 'Every part is decided; T7 goes on.', 'B7');
// 7 to 11: the batch vote of T9: a lead ends it early; a non-lead and a person with no role press; then a withdraw.
open('B9', clock(15, 10));
for (const [who, option] of [[ERICK, 0], [JON, 0], [MAYA, 1]]) await press(who, `press:B9:0:${option}`, clock(15, 15));
const confirm = await press(JON, 'end:B9', clock(15, 28));
moment('07-end-early-confirm', 'Jon, a lead, presses End vote now', 'The private confirm says what each part gets with the votes so far.', 'B9', { confirm });
const notLead = await press(MAYA, 'end:B9', clock(15, 28, 10));
moment('08-not-a-lead', 'Maya is not a lead and presses End vote now', 'Discord shows every button to everyone; only a lead can end the vote.', 'B9', { note: notLead });
const noRole = await press(SAM, 'press:B9:0:0', clock(15, 29));
moment('09-no-role-note', 'Sam has no role and presses a button', 'The tally does not change; only Sam sees the note.', 'B9', { note: noRole });
const ended = await press(JON, 'end!:B9', clock(15, 28, 20), undefined, true); // from the private confirm
moment('10-ended-early', 'Jon confirms: the vote ended early', 'Part 1 is provisional; part 2 had no votes and waits for a lead.', 'B9', { note: ended });
send('B9', { type: 'withdraw', by: ERICK, at: clock(15, 30) }); ctx.now = clock(15, 30);
moment('11-withdrawn', 'Erick withdraws B9', 'Nothing is decided; every button is off.', 'B9');
// 12: the largest card of a team of 5: 4 parts, every holder with a 500-character reason on each part (F-T27-9), and display names
// at Discord's 32-character limit, so that the budget drops the oldest reasons and the description counts them (F-T27-35).
{
  const names = ['Erick Alexander Benitez-Castillo', 'Maya Lindqvist-Oyelaran Nkemelu', 'Jon Kristoffer Vandenbroucke Jr', 'Ana Lucía Fernández de la Vega', 'Lea Marguerite Schönberg-Dubois'];
  const members = Array.from({ length: 5 }, (_, i) => ({ id: `sample-h${i}`, name: names[i], roles: [CONFIG.driverRole] }));
  const parts = Array.from({ length: 4 }, () => ['A', 'B', 'C']);
  const ask = { kind: 'batch', task: 'T12', title: 'Four questions, every reason at 500 characters', parts: parts.map((_, i) => ({
    question: `Question ${i + 1} of the batch?`, why: 'A is the smallest change.', recommended: 'A', options: { A: 'Option A', B: 'Option B', C: 'Option C' } })) };
  const big = { gates: new Map([['B12', { gate: openGate({ id: 'B12', kind: 'batch', parts, askedBy: members[0].id, at: clock(16, 0) }), ask }]]),
    people: peopleOf(members, CONFIG), clock: () => big.now, now: clock(16, 0) };
  const words = 'The reason text of one holder on one part, 500 characters long, as the form allows at most. ';
  for (let p = 0; p < 4; p++) for (const [h, m] of members.entries()) {
    big.now = clock(16, 1 + p * 5 + h);
    await handle(fakeInteraction({ user: m.id, customId: `reason:B12:${p}:${h % 3}`, fields: { reason: `${m.name}, part ${p + 1}: ${words.repeat(6)}`.slice(0, 500) } }), big);
  }
  ctx.now = clock(16, 21);
  const c = cardOf('B12', big);
  moments.push({ file: '12-five-by-four-limits', title: 'A team of 5 with 32-character names, 4 parts, a 500-character reason from everyone on every part',
    about: `Each reason shows cut to 200 characters; the gate keeps the full text. The oldest reasons go first, and the description counts them. ${c.embeds[0].fields.length} fields of 25; ${embedLength(c.embeds[0])} characters of 6000.`,
    now: ctx.now, card: c });
}

// Rendering: a Discord-like look, enough to judge the copy and the states.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);
const relative = (sec, now) => {
  const min = Math.round((sec * 1000 - now) / 60_000);
  const n = Math.abs(min);
  const text = n < 60 ? `${n} minute${n === 1 ? '' : 's'}` : `${Math.round(n / 60)} hour${Math.round(n / 60) === 1 ? '' : 's'}`;
  return min >= 0 ? `in ${text}` : `${text} ago`;
};
/** Discord markdown, as far as the cards use it: escapes, bold and timestamps. Mentions stay as text, as in an embed. */
const md = (text, now) => esc(text)
  .replace(/\\(&lt;|&gt;|&amp;|.)/g, (_, c) => `&#${c.startsWith('&') ? { '&lt;': 60, '&gt;': 62, '&amp;': 38 }[c] : c.codePointAt(0)};`)
  .replace(/&lt;t:(\d+):t&gt;/g, (_, s) => `<time>${hhmm(s)}</time>`)
  .replace(/&lt;t:(\d+):R&gt;/g, (_, s) => `<time>${relative(s, now)}</time>`)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const STYLE = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger' };
const rows = (components) => components.map((r) => `<div class="row">${r.components.map((b) =>
  `<button class="${STYLE[b.style]}"${b.disabled ? ' disabled' : ''} title="${esc(b.custom_id)}">${esc(b.label)}</button>`).join('')}</div>`).join('');
const embed = ({ embeds: [e], components }, now) => `<div class="msg"><span class="av">sb</span><div class="body"><div class="meta"><b>sage bridge</b> <span class="app">APP</span> · ${hhmm(now / 1000)}</div>
  <div class="embed" style="border-color:#${e.color.toString(16).padStart(6, '0')}"><div class="title">${esc(e.title)}</div><div class="desc">${md(e.description, now)}</div>
  ${(e.fields ?? []).map((f) => `<div class="field"><div class="fname">${esc(f.name)}</div><div class="fvalue">${md(f.value, now)}</div></div>`).join('')}
  ${e.footer ? `<div class="footer">${esc(e.footer.text)}</div>` : ''}</div>${rows(components)}</div></div>`;
const noteHtml = (n, now) => `<div class="msg eph"><span class="av">sb</span><div class="body"><div class="meta"><b>sage bridge</b> <span class="app">APP</span> · ${hhmm(now / 1000)}</div>
  <div class="ephnote">Only you can see this · Dismiss message</div><div>${md(n.content, now)}</div>${rows(n.components ?? [])}</div></div>`;
const modalHtml = (m) => `<div class="modal"><h3>${esc(m.title)}</h3>${m.components.map(({ components: [i] }) =>
  `<label>${esc(i.label)}<textarea placeholder="${esc(i.placeholder)}" maxlength="${i.max_length}"></textarea></label>`).join('')}<div class="mbtns"><span>Cancel</span><button class="primary">Submit</button></div></div>`;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>sage-bot B2: the cards (sample data)</title><style>
  body { margin: 0; background: #313338; color: #dbdee1; font: 15px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  .banner { background: #f0b232; color: #1e1f22; font-weight: 600; padding: 6px 16px; font-size: 13px; }
  section { padding: 16px 24px 20px; border-bottom: 1px solid #1e1f22; max-width: 860px; }
  h2 { font-size: 15px; margin: 0 0 2px; color: #f2f3f5; } .about { color: #949ba4; font-size: 13px; margin: 0 0 12px; }
  .msg { display: flex; gap: 12px; margin-top: 10px; } .av { flex: none; width: 40px; height: 40px; border-radius: 50%; background: #5865f2; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
  .body { min-width: 0; flex: 1; } .meta { color: #949ba4; font-size: 12px; margin-bottom: 4px; } .meta b { color: #f2f3f5; font-size: 15px; }
  .app { background: #5865f2; color: #fff; font-size: 10px; border-radius: 3px; padding: 0 4px; vertical-align: middle; }
  .embed { background: #2b2d31; border-left: 4px solid; border-radius: 4px; padding: 10px 14px 10px 12px; max-width: 560px; }
  .title { font-weight: 600; color: #f2f3f5; margin-bottom: 6px; } .desc { font-size: 14px; white-space: pre-wrap; }
  .field { margin-top: 10px; } .fname { font-weight: 600; color: #f2f3f5; font-size: 14px; } .fvalue { font-size: 14px; white-space: pre-wrap; }
  .footer { color: #949ba4; font-size: 12px; margin-top: 10px; } time { background: #404249; border-radius: 3px; padding: 0 2px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; } button { border: 0; border-radius: 3px; padding: 6px 14px; font: inherit; font-size: 14px; color: #fff; }
  button:disabled { opacity: .5; } .primary { background: #5865f2; } .secondary { background: #4e5058; } .success { background: #248046; } .danger { background: #da373c; }
  .eph { background: rgba(88,101,242,.08); border-left: 2px solid #5865f2; padding: 6px 8px; } .ephnote { color: #949ba4; font-size: 12px; margin-bottom: 4px; }
  .modal { background: #313338; border: 1px solid #1e1f22; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 16px; max-width: 440px; margin-top: 12px; }
  .modal h3 { margin: 0 0 12px; color: #f2f3f5; font-size: 18px; } label { display: block; font-size: 12px; font-weight: 600; color: #b5bac1; text-transform: uppercase; }
  textarea { display: block; width: 100%; box-sizing: border-box; min-height: 72px; margin-top: 6px; background: #1e1f22; color: #dbdee1; border: 0; border-radius: 3px; padding: 8px; font: inherit; font-size: 14px; text-transform: none; }
  .mbtns { display: flex; justify-content: flex-end; gap: 16px; align-items: center; margin-top: 14px; color: #dbdee1; }
</style></head><body><div class="banner">SAMPLE DATA · the card JSON of sage-bot B2 rendered to HTML: made-up people and questions, times in UTC, no Discord, no network.</div>
${moments.map((m, i) => `<section id="m${i + 1}"><h2>${i + 1}. ${esc(m.title)}</h2><p class="about">${esc(m.about)}</p>${embed(m.card, m.now)}
${m.note ? noteHtml(m.note, m.now) : ''}${m.confirm ? noteHtml(m.confirm, m.now) : ''}${m.modal ? modalHtml(m.modal) : ''}</section>`).join('\n')}
</body></html>`;
mkdirSync(new URL('shots/', OUT), { recursive: true });
writeFileSync(new URL('index.html', OUT), page);
console.log(`wrote ${new URL('index.html', OUT).pathname} with ${moments.length} moments`);

if (process.argv.includes('--shots')) {
  const { chromium } = await import('playwright-core');
  // --disable-gpu: the software raster path draws the rounded corner of the embed border the same on every cold start;
  // the GPU path moved 2 pixels of shot 01 by one shade in 1 run of 12, so the shots were not byte-identical (F-T27-22).
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] });
  const pg = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await pg.goto(new URL('index.html', OUT).href);
  for (const [i, m] of moments.entries()) {
    const path = new URL(`shots/${m.file}.png`, OUT).pathname;
    await pg.locator(`#m${i + 1}`).screenshot({ path });
    console.log(path);
  }
  await browser.close();
}
