// Draws the README's graphics as SVG, each in a light and a dark version (docs/assets/<name>-light.svg, -dark.svg).
// Run `node scripts/graphics.mjs` after a change here. The look is sage's (scripts/sage-world.mjs): the misty mountain
// world, the toad sage, the ember tiles. sage-bot has its own mark, an ember arch (a bridge); the toad sage stands for sage.
// The Discord symbol (G77): only as a separate, labelled node of a flow, never inside or beside sage-bot's mark as one
// combined mark. Its path comes unchanged from Discord's own files in docs/assets/brand/: the Blurple file on light, the
// White file on dark. It is never recoloured, rotated or stretched (one uniform scale, aspect ratio kept).
// Every text is S (36) or more in a graphic 1100 wide, so it stays readable on a phone (about 10.5 px at 320 px wide; F-T90-9).
// So each graphic says little, and the text beside it in the README carries the detail. Cut words before you shrink a text.
// ALT holds each graphic's short description: the README's alt text and the SVG's aria-label are the same text (a test checks it).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, EMBER, text, rect, path, circle, f1, flow, backdrop, emblem, panel } from './sage-world.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/assets');
const S = 36;

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
const label = (t, x, y, s, o = {}) => text(x, y, s, { size: S, fill: o.fill ?? t.muted, anchor: o.anchor ?? 'middle', weight: o.weight, lh: 1.2 });
const heading = (t, x, y, s) => text(x, y, s, { size: S, weight: 800, fill: t.loop, ls: 2 });
const dot = (t, x, y, done) => done ? circle(x, y, 9, { fill: t.edge }) : circle(x, y, 9, { stroke: t.line, sw: 2.5 }) + path(`M${x - 5} ${y} L ${x + 5} ${y}`, { stroke: t.line, sw: 2.5 });
/** The height of a plaque of n lines. */
const plaqueH = (n) => 28 + n * S * 1.2;
/** A flat plaque with one or more lines, centred. kind: hot (an ember edge), wait (a dashed edge) or plain. */
function plaque(t, x, y, w, lines, kind = 'plain') {
  const box = rect(x, y, w, plaqueH([].concat(lines).length), { rx: 8, fill: t.tile, stroke: kind === 'hot' ? t.edge : t.line, sw: kind === 'hot' ? 2 : 1.5, dash: kind === 'wait' ? '6 5' : undefined });
  return box + text(f1(x + w / 2), f1(y + 14 + S * 0.85), lines, { size: S, weight: 700, fill: t.ink, anchor: 'middle', lh: 1.2 });
}

/** The three nodes of every flow: Discord, sage-bot and sage, each a tile 190 high with its own mark and a caption. */
function node(t, id, kind, x, y, w, sub) {
  const cx = x + w / 2;
  const box = rect(x, y, w, 190, { rx: 10, fill: t.tile, stroke: kind === 'bot' ? t.edge : t.line, sw: kind === 'bot' ? 2 : 1.5 });
  const mark = kind === 'discord' ? discordSymbol(t, f1(cx - symbolW(48) / 2), y + 20, 48)
    : kind === 'bot' ? botMark(t, id, cx, y + 46, 0.85)
    : emblem(cx, y + 50, 36, id);
  const name = { discord: 'Discord', bot: 'sage-bot', sage: 'sage' }[kind];
  return box + mark + text(cx, y + 124, name, { size: S, weight: 800, fill: t.ink, anchor: 'middle' }) + label(t, cx, y + 172, sub);
}

const ALT = {
  hero: "sage-bot: mention @sage-bot in Discord, and it answers from sage's logbook on the owner's Mac. A sage-apprentice reads and asks; a sage-lead also breaks ties and stops.",
  how: "How sage-bot works: a read ask gets its answer in a new thread, a team vote gives sage only the chosen option, and a sage-lead's talk goes only to the lead log.",
  threads: 'Sample data: each mention of @sage-bot in a registered channel opens its own thread, and a mention inside that thread continues it.',
  roles: 'The two roles: a sage-apprentice reads and asks; a sage-lead can also break ties, end votes early, unregister a channel and turn off the link to sage.',
  safety: 'The guardrails: five layers are on now for every ask; four more (the sandbox, the guard hook, the broker and a spend cap) come with bridge sessions.',
  'tip-mention': "The toad sage's tip: mention @sage-bot in a registered channel. Each mention opens its own thread. Mention it again there to go on.",
};

/** The hero: sage-bot's name, its one-line pitch, the flow Discord → sage-bot → sage, and the two roles. */
function hero(t, id) {
  const W = 1100, H = 800;
  const wordFill = t.dark ? `url(#${id}-word)` : t.loop;
  const body = [
    backdrop(t, id, W, H, { moon: [930, 120, 120], seeds: [12, 77, 8], far: [H - 120, 50, 170, 70, 140], near: [H - 40, 60, 200, 80, 170], pagodas: [[1000, H - 80, 0.9, 1.6]], mist: [80, 280, H - 120], mistK: 0.6, embersTo: H - 40 }),
    botMark(t, id, 112, 104, 1.25),
    `<text x="190" y="138" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="96" font-weight="900" letter-spacing="-3" fill="${wordFill}"${t.dark ? ` filter="url(#${id}-wordglow)"` : ''}>sage-bot</text>`,
    text(40, 214, 'Ask sage from your team’s Discord.', { size: 44, weight: 800, fill: t.ink }),
    text(40, 262, 'Each mention of @sage-bot opens its own thread.', { size: S, fill: t.muted }),
    node(t, id, 'discord', 40, 296, 280, 'your server'),
    flow(id, 'M328 391 L 402 391', t.edge, 'hot'), label(t, 365, 374, 'ask'),
    node(t, id, 'bot', 410, 296, 280, 'owner’s Mac'),
    flow(id, 'M698 391 L 772 391', t.edge, 'hot'), label(t, 735, 374, 'read'),
    node(t, id, 'sage', 780, 296, 280, 'the logbook'),
    plaque(t, 40, 512, 1020, 'sage-apprentice · read and ask'),
    plaque(t, 40, 596, 1020, 'sage-lead · also break ties and stop', 'hot'),
    label(t, W / 2, 718, NOTICE),
  ].join('\n');
  return panel(t, id, W, H, body, ALT.hero);
}

/** How it works: three rows (a read ask, a team vote, a sage-lead's talk) across the three nodes. */
function how(t, id) {
  const W = 1100, H = 1220;
  const C = [190, 550, 910], PW = 330, PH = plaqueH(2);
  const p = (col, y, lines, kind = 'plain') => plaque(t, C[col] - PW / 2, y, PW, lines, kind);
  // The gaps between the plaques are too narrow for a label, so each plaque says what happens, and the arrows carry no text.
  const right = (a, b, y, color = t.edge, mk = 'hot', o) => flow(id, `M${C[a] + PW / 2 + 4} ${y} L ${C[b] - PW / 2 - 6} ${y}`, color, mk, o);
  const left = (a, b, y) => flow(id, `M${C[a] - PW / 2 - 4} ${y} L ${C[b] + PW / 2 + 6} ${y}`, t.edge, 'hot');
  const back = (a, b, y, s) => flow(id, `M${C[a]} ${y} C ${C[a]} ${y + 46}, ${C[b]} ${y + 46}, ${C[b]} ${y + 6}`, t.line, 'muted') + label(t, (C[a] + C[b]) / 2, y + 80, s);
  const row = (y) => [y + 20, y + 20 + PH / 2, y + 20 + PH]; // a row's heading at y: its plaques' top, middle and bottom
  const [a1, m1, b1] = row(270), [a2, m2, b2] = row(548), [a3, m3] = row(826);
  const body = [
    backdrop(t, id, W, H, { moon: [915, 120, 100], seeds: [12, 77, 8], far: [H - 80, 40, 160, 70, 140], near: [H + 30, 60, 200, 80, 170], mist: [80, 280, H - 140], mistK: 0.6, embersTo: H - 40 }),
    node(t, id, 'discord', C[0] - PW / 2, 30, PW, 'channels'),
    node(t, id, 'bot', C[1] - PW / 2, 30, PW, 'the bridge'),
    node(t, id, 'sage', C[2] - PW / 2, 30, PW, 'the logbook'),
    // 1. A read ask.
    heading(t, 40, 270, '1 · READ ASK'),
    p(0, a1, ['@sage-bot', 'board'], 'hot'), right(0, 1, m1),
    p(1, a1, ['checks role', 'and limit']), right(1, 2, m1),
    p(2, a1, ['reads the', 'logbook']),
    back(1, 0, b1, 'answer in a new thread'),
    // 2. A team vote.
    heading(t, 40, 548, '2 · TEAM VOTE'),
    p(2, a2, ['sage marks', 'a question'], 'hot'), left(2, 1, m2),
    p(1, a2, ['posts', 'a card']), left(1, 0, m2),
    p(0, a2, ['the team', 'presses']),
    back(0, 2, b2, 'only the choice goes back'),
    // 3. A sage-lead's talk.
    heading(t, 40, 826, '3 · SAGE-LEAD TALK'),
    p(0, a3, ['@sage-bot', 'talk'], 'hot'), right(0, 1, m3),
    p(1, a3, ['lead log,', '#sage-audit']), right(1, 2, m3, t.line, 'muted', { dash: '7 7' }),
    p(2, a3, ['bridge session', 'T159, not built'], 'wait'),
    text(W / 2, 1036, ['No Discord text reaches sage', 'as an instruction.'], { size: S, weight: 800, fill: t.loop, anchor: 'middle', lh: 1.2 }),
    label(t, W / 2, 1140, NOTICE),
  ].join('\n');
  return panel(t, id, W, H, body, ALT.how);
}

/** The two roles, one card above the other: what each one can do now, and what is coming. */
function roles(t, id) {
  const W = 1100, H = 1030;
  const card = (y, title, sub, hot, rows) => {
    const h = 150 + rows.length * 52;
    const out = [rect(40, y, 1020, h, { rx: 10, fill: t.tile, stroke: hot ? t.edge : t.line, sw: hot ? 2 : 1.5 }),
      text(70, y + 56, title, { size: 40, weight: 800, fill: t.ink }), text(70, y + 102, sub, { size: S, fill: t.muted })];
    rows.forEach(([done, line], i) => out.push(dot(t, 84, y + 160 + i * 52 - 12, done), text(110, y + 160 + i * 52, line, { size: S, fill: done ? t.ink : t.muted })));
    return out.join('');
  };
  const body = [
    backdrop(t, id, W, H, { moon: [960, 120, 90], seeds: [31, 47, 5], far: [H - 60, 30, 100, 60, 120], near: [H + 30, 40, 120, 80, 150], mist: [80, 280, H - 80], mistK: 0.6, embersTo: H - 20 }),
    card(30, 'sage-apprentice', 'Read and ask.', false, [
      [true, 'The board: tasks by state, open questions'],
      [true, 'One task, for example T7'],
      [true, 'The open questions and their options'],
      [true, 'The shared graphics and PDFs'],
      [true, 'Answer and vote on team questions'],
      [false, 'Time left: not estimated yet'],
    ]),
    card(522, 'sage-lead', 'All that an apprentice can do, plus:', true, [
      [true, 'Break a tie, or end a vote early'],
      [true, 'Recommend on autopilot; the owner decides'],
      [true, 'Unregister a channel'],
      [true, '/sage stop: turn off the link to sage'],
      [false, 'Instruct sage and start builds (T159)'],
    ]),
    dot(t, 60, 978, true), label(t, 80, 990, 'built', { anchor: 'start' }),
    dot(t, 200, 978, false), label(t, 220, 990, 'not built yet', { anchor: 'start' }),
    label(t, 1060, 990, 'No role: no answer.', { anchor: 'end' }),
  ].join('\n');
  return panel(t, id, W, H, body, ALT.roles);
}

/** A mention opens a thread: the channel on top, its two threads below. Sample data. */
function threads(t, id) {
  const W = 1100, H = 1500;
  const msg = (x, y, who, s, bot = false) => (bot ? botMark(t, id, x + 24, y + 4, 0.4) : circle(x + 24, y, 22, { fill: t.chip, stroke: t.line, sw: 1.5 })) +
    text(x + 62, y - 6, who, { size: S, weight: 800, fill: bot ? t.edge : t.ink }) + text(x + 62, y + 38, s, { size: S, fill: t.ink, lh: 1.2 });
  const body = [
    backdrop(t, id, W, H, { moon: [960, 110, 90], seeds: [31, 47, 5], far: [H - 60, 30, 100, 60, 120], near: [H + 30, 40, 120, 80, 150], mist: [80, 280, H - 100], mistK: 0.6, embersTo: H - 20 }),
    // The channel.
    rect(40, 30, 1020, 440, { rx: 10, fill: t.tile, stroke: t.line, sw: 1.5 }),
    text(70, 88, '# ask-sage', { size: 40, weight: 800, fill: t.ink }),
    label(t, 1030, 88, 'a registered channel', { anchor: 'end' }),
    msg(66, 160, 'Maya · apprentice', '@sage-bot board'),
    flow(id, 'M430 186 L 582 186', t.edge, 'hot'),
    plaque(t, 590, 150, 440, 'Thread: board', 'hot'),
    msg(66, 290, 'Jon · sage-lead', ['@sage-bot talk: is', 'the release ready?']),
    flow(id, 'M470 316 L 582 316', t.line, 'muted'),
    plaque(t, 590, 280, 440, 'Lead thread', 'wait'),
    label(t, 70, 440, 'Each mention opens its own thread.', { anchor: 'start', fill: t.ink, weight: 700 }),
    // The answer thread.
    rect(40, 500, 1020, 510, { rx: 10, fill: t.tile, stroke: t.edge, sw: 2 }),
    text(70, 558, 'Thread: board', { size: 40, weight: 800, fill: t.ink }),
    msg(66, 630, 'sage-bot', ['Building 2 · framed 5 · merged 9', 'Open questions: G7 (A or B)'], true),
    msg(66, 790, 'Maya · apprentice', '@sage-bot T7'),
    msg(66, 900, 'sage-bot', ['T7 · Share the board · small', 'building · no pull request yet'], true),
    // The lead thread.
    rect(40, 1040, 1020, 260, { rx: 10, fill: t.tile, stroke: t.line, sw: 1.5, dash: '7 6' }),
    text(70, 1098, 'Lead thread', { size: 40, weight: 800, fill: t.ink }),
    msg(66, 1170, 'sage-bot', ['Recorded in the lead log.', 'Sessions with sage are not on yet.'], true),
    label(t, W / 2, 1360, 'Sample data. Mention it again in its thread.'),
    label(t, W / 2, 1420, NOTICE),
  ].join('\n');
  return panel(t, id, W, H, body, ALT.threads);
}

/** The guardrails: the layers that are on now, and the ones that come with bridge sessions. */
function safety(t, id) {
  const W = 1100, H = 1220;
  const bar = (y, title, sub, on) => rect(40, y, W - 80, 104, { rx: 8, fill: t.tile, stroke: on ? t.edge : t.line, sw: 1.5, dash: on ? undefined : '7 6' }) +
    dot(t, 72, y + 32, on) + text(100, y + 44, title, { size: S, weight: 800, fill: t.ink }) + text(100, y + 88, sub, { size: S, fill: t.muted });
  const at = (y0, i) => y0 + i * 116;
  const body = [
    backdrop(t, id, W, H, { moon: [980, 90, 80], seeds: [31, 47, 5], far: [H - 60, 30, 100, 60, 120], near: [H + 30, 40, 120, 80, 150], mist: [80, 280, H - 80], mistK: 0.6, embersTo: H - 20 }),
    heading(t, 40, 60, 'ON NOW · FOR EVERY ASK'),
    bar(at(80, 0), 'Roles and registered channels', 'No role: no reply. The owner registers channels.', true),
    bar(at(80, 1), 'An hourly limit', '10 asks for each person in a rolling hour.', true),
    bar(at(80, 2), 'No AI reads Discord text', 'Code answers. A vote gives sage only the option.', true),
    bar(at(80, 3), 'The lead log', 'Hash-chained, with a copy in #sage-audit.', true),
    bar(at(80, 4), 'The kill switch', '/sage stop. Only the owner turns it on again.', true),
    heading(t, 40, 712, 'BRIDGE SESSIONS · NOT ON YET (T159)'),
    bar(at(732, 0), 'The sandbox: the guarantee · built', 'No GitHub host. Logbooks, sage, secrets denied.', false),
    bar(at(732, 1), 'The guard hook · built', 'Only the commands on its allow-list.', false),
    bar(at(732, 2), 'The broker · T158', 'A few GitHub verbs. None of them merges.', false),
    bar(at(732, 3), 'A spend cap · built', 'At most $5 of model use for each session.', false),
  ].join('\n');
  return panel(t, id, W, H, body, ALT.safety);
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
  hero, how, roles, threads, safety,
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
