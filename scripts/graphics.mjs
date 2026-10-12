// Draws the README's graphics as SVG, each in a light and a dark version (docs/assets/<name>-light.svg, -dark.svg).
// Run `node scripts/graphics.mjs` after a change here. The look is sage's (scripts/sage-world.mjs): the misty mountain
// world, the toad sage, the ember tiles. sage-bot has its own mark, an ember arch (a bridge); the toad sage stands for sage.
// The Discord symbol (G77): only as a separate, labelled node of a flow, never inside or beside sage-bot's mark as one
// combined mark. Its path comes unchanged from Discord's own files in docs/assets/brand/: the Blurple file on light, the
// White file on dark. It is never recoloured, rotated or stretched (one uniform scale, aspect ratio kept).
// Every text is S (40) or more in a graphic 1100 wide, so it stays readable on a phone: GitHub shows a graphic 309 px wide on a
// 375 px phone, so S is about 11 px there (F-T90-9, F-T187-1).
// So each graphic says little, and the text beside it in the README carries the detail. Cut words before you shrink a text.
// ALT holds each graphic's short description: the README's alt text and the SVG's aria-label are the same text (a test checks it).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, EMBER, text, rect, path, circle, f1, flow, backdrop, emblem, panel } from './sage-world.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/assets');
const S = 40;

/** Discord's symbol, read from its official file: the viewBox, the path and the fill, exactly as the file has them. */
function symbolOf(file) {
  const svg = readFileSync(join(OUT, 'brand', file), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(svg)[1];
  const d = /<path[^>]* d="([^"]+)"/.exec(svg)[1];
  const fill = /\.cls-1\{fill:([^;}]+);?\}/.exec(svg)[1];
  return { viewBox, d, fill };
}
const BLURPLE = symbolOf('Discord-Symbol-Blurple.svg');
const WHITE = symbolOf('Discord-Symbol-White.svg');
if (BLURPLE.d !== WHITE.d || BLURPLE.viewBox !== WHITE.viewBox) throw new Error('the two Discord symbol files differ in shape');
const [, , VW, VH] = BLURPLE.viewBox.split(/\s+/).map(Number);

/** The Discord symbol at (x, y), h high, its width from its own aspect ratio. Blurple on light, white on dark. */
function discordSymbol(t, x, y, h) {
  const s = t.dark ? WHITE : BLURPLE;
  return `<svg x="${x}" y="${y}" width="${f1((h * VW) / VH)}" height="${h}" viewBox="${s.viewBox}"><path d="${s.d}" fill="${s.fill}"/></svg>`;
}
const symbolW = (h) => f1((h * VW) / VH);

/** sage-bot's own mark: an ember arch over two piers, a bridge. Original shapes; no part of another product's mark. */
function botMark(t, id, cx, cy, s) {
  const X = (x) => f1(cx + x * s), Y = (y) => f1(cy + y * s), R = (n) => f1(n * s);
  return [
    `<g class="pulse">${circle(cx, cy, R(46), { fill: EMBER.orange, opacity: t.dark ? 0.3 : 0.16 })}</g>`,
    path(`M${X(-40)} ${Y(18)} C ${X(-30)} ${Y(-34)}, ${X(30)} ${Y(-34)}, ${X(40)} ${Y(18)}`, { stroke: `url(#${id}-ember)`, sw: R(9) }),
    path(`M${X(-40)} ${Y(18)} L ${X(40)} ${Y(18)}`, { stroke: t.dark ? EMBER.gold : EMBER.deep, sw: R(4) }),
    path(`M${X(-22)} ${Y(-6)} L ${X(-22)} ${Y(18)} M${X(0)} ${Y(-14)} L ${X(0)} ${Y(18)} M${X(22)} ${Y(-6)} L ${X(22)} ${Y(18)}`, { stroke: t.dark ? EMBER.gold : EMBER.deep, sw: R(3), opacity: 0.8 }),
    circle(X(-40), Y(24), R(7), { fill: EMBER.orange }), circle(X(40), Y(24), R(7), { fill: EMBER.orange }),
  ].join('');
}

const NOTICE = ['Discord is a trademark of Discord Inc.', 'sage-bot is not affiliated with Discord.'];
const heading = (t, x, y, s) => text(x, y, s, { size: S, weight: 800, fill: t.loop, ls: 2 });

/** The head of a column: a tile 190 high with its mark, a name and a caption. kind: discord, bot or sage. */
function node(t, id, kind, x, y, w, name, sub) {
  const cx = f1(x + w / 2);
  const box = rect(x, y, w, 190, { rx: 10, fill: t.tile, stroke: kind === 'bot' ? t.edge : t.line, sw: kind === 'bot' ? 2 : 1.5 });
  const mark = kind === 'discord' ? discordSymbol(t, f1(cx - symbolW(48) / 2), y + 20, 48)
    : kind === 'bot' ? botMark(t, id, cx, y + 46, 0.85)
    : emblem(cx, y + 50, 36, id);
  return box + mark + text(cx, y + 124, name, { size: S, weight: 800, fill: t.ink, anchor: 'middle' }) +
    text(cx, y + 172, sub, { size: S, fill: t.muted, anchor: 'middle' });
}

const ALT = {
  hero: 'sage-bot bridges Discord and Claude Code running sage: a sage-lead requests a feature, sage designs, the team votes, sage builds and shows the results.',
  'tip-mention': "The toad sage's tip: mention @sage-bot in a registered channel. Each mention opens its own thread. Mention it again there to go on.",
};

/* The loop of the hero, one step a card. lane: L (Discord, the team) or R (Claude Code, running sage).
 * now: true for a step that works today (a solid ember edge), false for one that comes with bridge sessions (a dashed edge),
 * null for the owner's own step. The first line is the step's title; the next lines say what happens. */
const LOOP = [
  { lane: 'L', now: false, lines: ['1 · sage-lead', 'requests a new feature', '“add CSV export”'] },
  { lane: 'R', now: false, lines: ['2 · sage designs', 'options and', 'a recommendation'] },
  { lane: 'L', now: true, lines: ['3 · design question', 'posted as a card'] },
  { lane: 'L', now: true, lines: ['4 · the team weighs in', 'asks, comments, votes'] },
  { lane: 'L', now: true, lines: ['5 · the choice', 'a sage-lead breaks ties'] },
  { lane: 'R', now: false, lines: ['6 · sage builds', 'reviews, tests, a PR'] },
  { lane: 'L', now: true, lines: ['7 · progress, results', 'board, screenshots,', 'the PR link'] },
  { lane: 'L', now: null, lines: ['8 · the team sees it', 'the owner merges'] },
];
const TODAY = ['Today: steps 3, 4, 5 and 7 work. Steps 1, 2 and 6', 'come with bridge sessions (T159).'];

/** The hero: sage-bot's name and the loop, with Discord (the team) on the left, Claude Code running sage on the right,
 * and sage-bot, the bridge, in the middle: every step that crosses from one side to the other goes over the bridge. */
function hero(t, id) {
  const W = 1100, LW = 470, LX = { L: 40, R: W - 40 - LW }, MID = W / 2, GAP = 56, LH = S * 1.2;
  // Place the cards: a card in the same lane goes under the one before it; a card in the other lane starts at the middle of the one before it.
  const cards = [], bottom = { L: 0, R: 0 };
  let y = 548;
  for (const [i, s] of LOOP.entries()) {
    const h = 28 + s.lines.length * LH, prev = cards[i - 1];
    if (prev) y = prev.lane === s.lane ? prev.y + prev.h + GAP : Math.max(prev.y + prev.h / 2, bottom[s.lane] + 40);
    cards.push({ ...s, x: LX[s.lane], y, h });
    bottom[s.lane] = y + h;
  }
  const end = Math.max(bottom.L, bottom.R), H = end + 330;
  const arrows = cards.slice(1).map((c, i) => {
    const p = cards[i], color = c.now === false ? t.line : t.edge, mk = c.now === false ? 'muted' : 'hot', o = c.now === false ? { dash: '8 7' } : {};
    if (p.lane === c.lane) { const x = p.x + LW / 2; return flow(id, `M${x} ${p.y + p.h + 6} L ${x} ${c.y - 8}`, color, mk, o); }
    const [from, to] = p.lane === 'L' ? [p.x + LW + 4, c.x - 8] : [p.x - 4, c.x + LW + 8];
    const py = f1(p.y + p.h / 2), cy = f1(c.y + c.h / 2);
    return flow(id, `M${from} ${py} L ${MID} ${py} L ${MID} ${cy} L ${to} ${cy}`, color, mk, o);
  });
  const card = (c) => rect(c.x, c.y, LW, c.h, { rx: 10, fill: t.tile, stroke: c.now ? t.edge : t.line, sw: c.now ? 2.5 : 1.5, dash: c.now === false ? '8 7' : undefined }) +
    text(c.x + 28, c.y + 14 + S * 0.85, c.lines[0], { size: S, weight: 800, fill: c.now === false ? t.ink : t.loop }) +
    text(c.x + 28, c.y + 14 + S * 0.85 + LH, c.lines.slice(1), { size: S, fill: t.ink, lh: 1.2 });
  const wordFill = t.dark ? `url(#${id}-word)` : t.loop;
  const body = [
    backdrop(t, id, W, H, { moon: [930, 120, 120], seeds: [12, 77, 8], far: [H - 120, 50, 170, 70, 140], near: [H - 40, 60, 200, 80, 170], pagodas: [[1000, H - 80, 0.9, 1.6]], mist: [80, 280, H - 120], mistK: 0.6, embersTo: H - 40 }),
    botMark(t, id, 112, 104, 1.25),
    `<text x="190" y="138" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="96" font-weight="900" letter-spacing="-3" fill="${wordFill}"${t.dark ? ` filter="url(#${id}-wordglow)"` : ''}>sage-bot</text>`,
    text(40, 214, 'Build software as a team, from Discord.', { size: 44, weight: 800, fill: t.ink }),
    text(40, 268, 'sage-bot is the bridge to Claude Code.', { size: S, fill: t.muted }),
    // The bridge: a band down the middle, under the arrows that cross it.
    rect(MID - 14, 500, 28, end - 500, { rx: 14, fill: EMBER.orange, opacity: t.dark ? 0.18 : 0.12 }),
    node(t, id, 'discord', 40, 310, 380, 'Discord', 'the team'),
    node(t, id, 'bot', MID - 120, 310, 240, 'sage-bot', 'the bridge'),
    node(t, id, 'sage', W - 420, 310, 380, 'Claude Code', 'running sage'),
    ...cards.map(card), ...arrows,
    text(40, end + 90, TODAY, { size: S, weight: 700, fill: t.ink, lh: 1.2 }),
    text(MID, end + 236, NOTICE, { size: S, fill: t.muted, anchor: 'middle', lh: 1.2 }),
  ].join('\n');
  return panel(t, id, W, H, body, ALT.hero);
}

/** The toad sage's tip: its emblem on the left, and the tip on a hanging scroll to the right (as sage-world's tip, at size S). */
const tip = (lines) => (t, id) => {
  const W = 1100, lh = 1.3, sx = 222, sy = 32, sw = W - 36 - sx;
  const sh = 40 + S + 16 + lines.length * S * lh + 24, H = sh + 64, ty = sy + 40 + S * 0.8;
  const body = [
    backdrop(t, id, W, H, { moon: [120, H / 2, 96], seeds: [31, 47, 5], far: [H - 30, 30, 90, 60, 120], near: [H + 50, 40, 110, 80, 150], mist: [80, 280, H - 80], mistK: 0.6, embersTo: H - 20 }),
    emblem(120, H / 2, 74, id),
    `<rect x="${sx}" y="${sy}" width="${sw}" height="${f1(sh)}" rx="4" fill="${t.edge}" opacity="${t.glowOp}" filter="url(#${id}-glow)"/>`,
    rect(sx, sy, sw, f1(sh), { rx: 4, fill: t.tile, stroke: t.edge, sw: 1.5 }),
    rect(sx + 9, sy + 9, sw - 18, f1(sh - 18), { rx: 2, stroke: t.line, sw: 1, opacity: 0.6 }),
    rect(sx - 9, sy - 10, 14, f1(sh + 20), { rx: 7, fill: '#3D2D21', stroke: '#120C08', sw: 1 }),
    rect(sx + sw - 5, sy - 10, 14, f1(sh + 20), { rx: 7, fill: '#3D2D21', stroke: '#120C08', sw: 1 }),
    rect(sx + sw - 50, f1(sy + sh - 48), 20, 20, { rx: 2, fill: EMBER.deep, opacity: 0.85 }),
    heading(t, sx + 40, f1(ty), 'TIP'),
    text(sx + 40, f1(ty + 16 + S * lh), lines, { size: S, weight: 600, fill: t.ink, lh }),
  ].join('\n');
  return panel(t, id, W, f1(H), body, ALT['tip-mention']);
};

const GRAPHICS = {
  hero,
  'tip-mention': tip(['Mention @sage-bot in a channel', 'that the owner registered.', 'Each mention opens its own thread.', 'Mention it again there to go on.']),
};

/** Every graphic in both themes, as [file name, SVG]. Each file's ids start with its own name and theme. */
export const files = () => Object.entries(GRAPHICS).flatMap(([name, draw]) => Object.entries(THEMES).map(([theme, t]) => [`${name}-${theme}.svg`, draw(t, `${name}-${theme[0]}`)]));

// `node scripts/graphics.mjs` writes into docs/assets; `--out <folder>` writes into another folder (the check redraws into a temp folder).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const out = at === -1 ? OUT : process.argv[at + 1];
  mkdirSync(out, { recursive: true });
  const all = files();
  for (const [file, svg] of all) writeFileSync(join(out, file), svg);
  console.log(`drew ${all.length} files in ${at === -1 ? 'docs/assets' : out}`);
}
