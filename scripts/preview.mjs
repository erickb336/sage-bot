// Renders the card JSON of the design's moments to one static HTML page (design/b2/index.html, or --out) and, with --shots,
// screenshots each moment to shots/ beside the page with the local Chrome (playwright-core, channel 'chrome').
// SAMPLE DATA ONLY: made-up people and questions, times in UTC. No Discord, no network.
//   node scripts/preview.mjs            the page only
//   HOME=/tmp/scratch node scripts/preview.mjs --shots   the page and the screenshots
//   node scripts/preview.mjs --out <page.html>          the page at another path (the shots go to shots/ beside it)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { handle, peopleOf } from '../src/handle.js';
import { card } from '../src/cards.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { step } from '../src/vote.js';
import { embedLength } from 'discord.js';
import { ASKS, MEMBERS, CONFIG, ERICK, MAYA, JON, clock, openAsk } from '../examples/sample.js';
import { openGate } from '../src/vote.js';
import { CSS, esc, message, modalHtml, noteHtml } from './render.mjs';

const at = process.argv.indexOf('--out');
if (at !== -1 && !process.argv[at + 1]) throw new Error('usage: node scripts/preview.mjs [--shots] [--out <page.html>]');
const PAGE = at === -1 ? new URL('../design/b2/index.html', import.meta.url) : pathToFileURL(resolve(process.argv[at + 1]));
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
moment('01-single-open', 'A single question', 'The first answer of a sage-apprentice or sage-lead is final.', 'G5');
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
// 7 to 10: the batch vote of T9: a lead ends it early; a non-lead presses End vote now; then a withdraw.
open('B9', clock(15, 10));
for (const [who, option] of [[ERICK, 0], [JON, 0], [MAYA, 1]]) await press(who, `press:B9:0:${option}`, clock(15, 15));
const confirm = await press(JON, 'end:B9', clock(15, 28));
moment('07-end-early-confirm', 'Jon, a lead, presses End vote now', 'The private confirm says what each part gets with the votes so far.', 'B9', { confirm });
const notLead = await press(MAYA, 'end:B9', clock(15, 28, 10));
moment('08-not-a-lead', 'Maya is not a lead and presses End vote now', 'Discord shows every button to everyone; only a lead can end the vote.', 'B9', { note: notLead });
const ended = await press(JON, 'end!:B9', clock(15, 28, 20), undefined, true); // from the private confirm
moment('09-ended-early', 'Jon confirms: the vote ended early', 'Part 1 is provisional; part 2 had no votes and waits for a lead.', 'B9', { note: ended });
send('B9', { type: 'withdraw', by: ERICK, at: clock(15, 30) }); ctx.now = clock(15, 30);
moment('10-withdrawn', 'Erick withdraws B9', 'Nothing is decided; every button is off.', 'B9');
// 11: the largest card of a team of 5: 4 parts, every holder with a 500-character reason on each part (F-T27-9), and display names
// at Discord's 32-character limit, so that the budget drops the oldest reasons and the description counts them (F-T27-35).
{
  const names = ['Erick Alexander Benitez-Castillo', 'Maya Lindqvist-Oyelaran Nkemelu', 'Jon Kristoffer Vandenbroucke Jr', 'Ana Lucía Fernández de la Vega', 'Lea Marguerite Schönberg-Dubois'];
  const members = Array.from({ length: 5 }, (_, i) => ({ id: `sample-h${i}`, name: names[i], roles: [CONFIG.apprenticeRole] }));
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
  moments.push({ file: '11-five-by-four-limits', title: 'A team of 5 with 32-character names, 4 parts, a 500-character reason from everyone on every part',
    about: `Each reason shows cut to 200 characters; the gate keeps the full text. The oldest reasons go first, and the description counts them. ${c.embeds[0].fields.length} fields of 25; ${embedLength(c.embeds[0])} characters of 6000.`,
    now: ctx.now, card: c });
}

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>sage-bot B2: the cards (sample data)</title><style>${CSS}</style></head><body><div class="banner">SAMPLE DATA · the card JSON of sage-bot B2 rendered to HTML: made-up people and questions, times in UTC, no Discord, no network.</div>
${moments.map((m, i) => `<section id="m${i + 1}"><h2>${i + 1}. ${esc(m.title)}</h2><p class="about">${esc(m.about)}</p>${message(m.card, m.now)}
${m.note ? noteHtml(m.note, m.now) : ''}${m.confirm ? noteHtml(m.confirm, m.now) : ''}${m.modal ? modalHtml(m.modal) : ''}</section>`).join('\n')}
</body></html>`;
mkdirSync(new URL('.', PAGE), { recursive: true });
writeFileSync(PAGE, page);
console.log(`wrote ${fileURLToPath(PAGE)} with ${moments.length} moments`);

if (process.argv.includes('--shots')) {
  const { chromium } = await import('playwright-core');
  // --disable-gpu: the software raster path draws the rounded corner of the embed border the same on every cold start;
  // the GPU path moved 2 pixels of shot 01 by one shade in 1 run of 12, so the shots were not byte-identical (F-T27-22).
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] });
  const pg = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  mkdirSync(new URL('shots/', PAGE), { recursive: true });
  await pg.goto(PAGE.href);
  for (const [i, m] of moments.entries()) {
    const path = fileURLToPath(new URL(`shots/${m.file}.png`, PAGE));
    await pg.locator(`#m${i + 1}`).screenshot({ path });
    console.log(path);
  }
  await browser.close();
}
