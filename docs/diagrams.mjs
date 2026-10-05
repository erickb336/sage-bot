// Draws the README's three diagrams as SVG files: docs/flow.svg, docs/states.svg and docs/threads.svg.
// Run `node docs/diagrams.mjs` after a change here; test/readme.test.js fails when a committed file differs from this output.
// Each diagram is 1000 units wide with text of 19 units or more, so the text stays about 11 px or more where GitHub shows
// the image 600 px wide (a 700 px window). The background is a light card, so the diagram reads in GitHub's dark mode too.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const C = { bg: '#FFFFFF', edge: '#D0D7DE', box: '#F6F8FA', ink: '#1F2328', muted: '#59636E', accent: '#0969DA', end: '#DDF4E4', endEdge: '#4AC26B' };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const W = 1000;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Text, one line per entry of `lines`. */
function text(x, y, lines, { size = 20, bold = false, fill = C.ink, anchor = 'start', halo = false } = {}) {
  const spans = [].concat(lines).map((l, i) => `<tspan x="${x}" dy="${i ? Math.round(size * 1.3) : 0}">${esc(l)}</tspan>`).join('');
  return `<text x="${x}" y="${y}" font-size="${size}"${bold ? ' font-weight="600"' : ''} fill="${fill}" text-anchor="${anchor}"${halo ? ` stroke="${C.bg}" stroke-width="6" stroke-linejoin="round" paint-order="stroke"` : ''}>${spans}</text>`;
}
/** A box with a bold title and lines under it, centred. */
function box(x, y, w, h, title, lines = [], { fill = C.box, stroke = C.edge, dash } = {}) {
  const n = 1 + lines.length;
  const top = y + h / 2 - ((n - 1) * 26) / 2 + 7;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2"${dash ? ' stroke-dasharray="8 6"' : ''}/>`
    + (title ? text(x + w / 2, top, title, { bold: true, anchor: 'middle' }) : '')
    + (lines.length ? text(x + w / 2, top + 26, lines, { size: 19, fill: C.muted, anchor: 'middle' }) : '');
}
/** A line with an arrow head at its end. */
const arrow = (d, { stroke = C.accent, dash } = {}) => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.5"${dash ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#head)"/>`;
const dot = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="9" fill="${C.ink}"/>`;

function svg(h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" font-family="${FONT}">
<title>${esc(title)}</title>
<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.accent}"/></marker></defs>
<rect x="1" y="1" width="${W - 2}" height="${h - 2}" rx="14" fill="${C.bg}" stroke="${C.edge}" stroke-width="2"/>
${body}
</svg>
`;
}

/** The flow of one question: five lanes, nine numbered messages from top to bottom. */
function flow() {
  const lanes = [['sage', 'at the terminal'], ['The logbook', "sage's record"], ['The bridge', "on the owner's Mac"], ['The session', 'thread (Discord)'], ['The team', 'both roles']];
  const x = (i) => 100 + i * 200;
  const top = 30, head = 90, first = 190, step = 78;
  const n = 9, bottom = first + (n - 1) * step + 40;
  let body = lanes.map(([a, b], i) => box(x(i) - 90, top, 180, head, a, [b])
    + `<line x1="${x(i)}" y1="${top + head}" x2="${x(i)}" y2="${bottom}" stroke="${C.edge}" stroke-width="2" stroke-dasharray="4 6"/>`).join('');
  const msgs = [
    [0, 1, 'asks a question'],
    [0, 2, 'marks it as a team vote (vote.mjs)'],
    [2, 1, 'reads it, every 15 s'],
    [2, 3, 'posts a card, pings both roles'],
    [4, 3, 'presses an option'],
    [3, 2, 'sends the press'],
    [2, 2, ['checks the role and the', 'vote rules, edits the card']],
    [2, 1, 'gives the final answer'],
    [1, 0, 'sage reads it, goes on'],
  ];
  msgs.forEach(([from, to, label], k) => {
    const y = first + k * step;
    const num = `${k + 1}  `;
    if (from === to) {
      body += arrow(`M${x(from)} ${y - 10} h60 v24 h-52`);
      body += text(x(from) + 72, y - 4, [`${num}${label[0]}`, `     ${label[1]}`], { size: 19, halo: true });
      return;
    }
    const [a, b] = from < to ? [x(from) + 6, x(to) - 8] : [x(from) - 6, x(to) + 8];
    body += arrow(`M${a} ${y} H${b}`);
    body += text(Math.min(x(from), x(to)) + 14, y - 12, `${num}${label}`, { size: 19, halo: true });
  });
  return svg(bottom + 20, 'The flow of one question', body);
}

/** A question's life: the three waiting states on the left, the three end states around them. */
function states() {
  let body = '';
  body += box(100, 30, 260, 80, 'Withdrawn', ['sage gets nothing'], { fill: C.end, stroke: C.endEdge });
  body += `<rect x="20" y="180" width="360" height="490" rx="14" fill="none" stroke="${C.edge}" stroke-width="2" stroke-dasharray="8 6"/>`;
  body += box(100, 200, 260, 80, 'Open', ['a single question']);
  body += box(100, 360, 260, 80, 'Voting', ['a batch of 2 to 4']);
  body += box(100, 520, 260, 80, 'Tied', ['waits for a sage-lead']);
  body += text(40, 628, ['The owner can answer', 'in each of these.'], { size: 19, fill: C.muted });
  body += dot(50, 240) + arrow('M60 240 H92') + dot(50, 400) + arrow('M60 400 H92');
  body += arrow('M230 200 V118') + text(244, 152, ['the owner withdraws it', 'at the terminal'], { size: 19 });
  body += arrow('M230 440 V512') + text(244, 470, ['30 min end:', 'a tie or no votes'], { size: 19 });
  body += box(720, 200, 260, 400, 'Decided', ['the bridge gives', 'sage the answer'], { fill: C.end, stroke: C.endEdge });
  body += arrow('M360 240 H712') + text(396, 228, 'first press of a holder', { size: 19 });
  body += arrow('M360 400 H712') + text(396, 366, ['30 min end with a clear leader,', 'or a sage-lead ends the vote'], { size: 19 });
  body += arrow('M360 560 H712') + text(396, 548, 'a sage-lead breaks the tie', { size: 19 });
  body += arrow('M230 670 V742') + text(244, 712, 'the owner answers sage', { size: 19 });
  body += box(100, 750, 420, 80, 'Answered at the terminal', ['final: sage has it already'], { fill: C.end, stroke: C.endEdge });
  return svg(860, "A question's life", body);
}

/** Session threads: the parent channel, one line per session, one thread per line. */
function threads() {
  let body = '';
  body += box(30, 120, 280, 140, 'The parent channel', ['for example #sage', 'one line per session']);
  body += box(370, 40, 280, 140, 'Session 14 · Tue 4 Oct', ['running · 4 tasks', '2 open questions']);
  body += box(370, 220, 280, 120, 'Session 15 · Wed 5 Oct', ['ended 18:02']);
  body += box(710, 40, 260, 140, 'Its thread', ['the cards, tie posts,', 'reminders, wake notes']);
  body += box(710, 220, 260, 120, 'Its thread', ['locked']);
  body += arrow('M310 170 L362 110') + arrow('M310 210 L362 280');
  body += arrow('M650 110 H702') + arrow('M650 280 H702');
  return svg(370, 'Session threads', body);
}

export const DIAGRAMS = { 'flow.svg': flow(), 'states.svg': states(), 'threads.svg': threads() };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const [name, content] of Object.entries(DIAGRAMS)) writeFileSync(join(dir, name), content);
  console.log(`wrote ${Object.keys(DIAGRAMS).map((n) => `docs/${n}`).join(', ')}`);
}
