// Draws the README's graphics as SVG, each in a light and a dark version (docs/assets/<name>-light.svg, -dark.svg).
// Run `node scripts/graphics.mjs` after a change here. The look is sage's (scripts/sage-world.mjs): the misty mountain
// world, the toad sage, the ember tiles. sage-bot has its own mark, an ember arch (a bridge); the toad sage stands for sage.
// The Discord symbol (G77): only as a separate, labelled node of a flow, never inside or beside sage-bot's mark as one
// combined mark. Its path comes unchanged from Discord's own files in docs/assets/brand/: the Blurple file on light, the
// White file on dark. It is never recoloured, rotated or stretched (one uniform scale, aspect ratio kept).
// Every text is 24 px or more in a graphic 1100 wide, so it stays readable on a phone (about 7 px at 324 px wide).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, SMALL, EMBER, text, tw, rect, path, circle, f1, flow, tile, pill, heading, backdrop, emblem, panel, tip } from './sage-world.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/assets');

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
    path(`M${X(-40)} ${Y(18)} C ${X(-30)} ${Y(-34)}, ${X(30)} ${Y(-34)}, ${X(40)} ${Y(18)}`, { stroke: `url(#${id}-chief)`, sw: R(9) }),
    path(`M${X(-40)} ${Y(18)} L ${X(40)} ${Y(18)}`, { stroke: t.dark ? EMBER.gold : EMBER.deep, sw: R(4) }),
    path(`M${X(-22)} ${Y(-6)} L ${X(-22)} ${Y(18)} M${X(0)} ${Y(-14)} L ${X(0)} ${Y(18)} M${X(22)} ${Y(-6)} L ${X(22)} ${Y(18)}`, { stroke: t.dark ? EMBER.gold : EMBER.deep, sw: R(3), opacity: 0.8 }),
    circle(X(-40), Y(24), R(7), { fill: EMBER.orange }), circle(X(40), Y(24), R(7), { fill: EMBER.orange }),
  ].join('');
}

const NOTICE = 'Discord is a trademark of Discord Inc. sage-bot is not affiliated with Discord.';
const label = (t, x, y, s, o = {}) => text(x, y, s, { size: o.size ?? SMALL, fill: o.fill ?? t.muted, anchor: o.anchor ?? 'middle', weight: o.weight, lh: 1.2 });
const dot = (t, x, y, done) => done ? circle(x, y, 7, { fill: t.edge }) : circle(x, y, 7, { stroke: t.line, sw: 2 }) + path(`M${x - 4} ${y} L ${x + 4} ${y}`, { stroke: t.line, sw: 2 });

/** The three nodes of every flow: Discord, sage-bot and sage, each a tile with its own mark and a caption. */
function node(t, id, kind, x, y, w, h, sub) {
  const cx = x + w / 2;
  const box = rect(x, y, w, h, { rx: 10, fill: t.tile, stroke: kind === 'bot' ? t.edge : t.line, sw: kind === 'bot' ? 2 : 1.5 });
  const mark = kind === 'discord' ? discordSymbol(t, f1(cx - symbolW(52) / 2), y + 22, 52)
    : kind === 'bot' ? botMark(t, id, cx, y + 50, 0.9)
    : emblem(cx, y + 54, 40, id);
  const name = { discord: 'Discord', bot: 'sage-bot', sage: 'sage' }[kind];
  return box + mark + text(cx, y + 128, name, { size: 30, weight: 800, fill: t.ink, anchor: 'middle' }) + label(t, cx, y + 160, sub);
}

/** The hero: sage-bot's name, its one-line pitch, and the flow Discord → sage-bot → sage. */
function hero(t, id) {
  const W = 1100, H = 640;
  const wordFill = t.dark ? `url(#${id}-word)` : t.loop;
  const body = [
    backdrop(t, id, W, H, { moon: [930, 120, 120], seeds: [12, 77, 8], far: [520, 50, 170, 70, 140], near: [660, 60, 200, 80, 170], pagodas: [[1000, 560, 0.9, 1.6]], mist: [80, 280, 520], mistK: 0.6, embersTo: 600 }),
    botMark(t, id, 112, 104, 1.25),
    `<text x="190" y="138" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="96" font-weight="900" letter-spacing="-3" fill="${wordFill}"${t.dark ? ` filter="url(#${id}-wordglow)"` : ''}>sage-bot</text>`,
    text(64, 214, 'Ask sage from your team’s Discord.', { size: 40, weight: 800, fill: t.ink }),
    text(64, 256, 'Mention @sage-bot. Each mention opens its own thread.', { size: 26, fill: t.muted }),
    node(t, id, 'discord', 64, 300, 270, 190, 'your server'),
    flow(id, 'M342 395 L 404 395', t.edge, 'hot'), label(t, 373, 380, 'ask'),
    node(t, id, 'bot', 415, 300, 270, 190, 'on the owner’s Mac'),
    flow(id, 'M693 395 L 755 395', t.edge, 'hot'), label(t, 724, 380, 'read'),
    node(t, id, 'sage', 766, 300, 270, 190, 'the logbook'),
    pill(t, id, 64, 516, 470, 48, 'sage-apprentice · read and ask', 'plain'),
    pill(t, id, 566, 516, 470, 48, 'sage-lead · also decide and stop', 'hot'),
    label(t, W / 2, 610, NOTICE, { anchor: 'middle' }),
  ].join('\n');
  return panel(t, id, W, H, body, `sage-bot: ask sage from your team's Discord. Mention @sage-bot, and each mention opens its own thread. The flow: Discord, your server, sends an ask to sage-bot on the owner's Mac, which reads sage's logbook. Two roles: sage-apprentice reads and asks; sage-lead also decides and stops. ${NOTICE}`);
}

/** The plain hero, the alternative: no Discord symbol, only sage-bot's mark, the toad sage and the pitch. */
function heroPlain(t, id) {
  const W = 1100, H = 420;
  const wordFill = t.dark ? `url(#${id}-word)` : t.loop;
  const body = [
    backdrop(t, id, W, H, { moon: [880, 200, 150], seeds: [12, 77, 8], far: [330, 40, 140, 70, 140], near: [440, 50, 160, 80, 170], mist: [80, 280, 330], mistK: 0.6, embersTo: 400 }),
    emblem(880, 200, 120, id),
    botMark(t, id, 112, 124, 1.25),
    `<text x="190" y="158" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="96" font-weight="900" letter-spacing="-3" fill="${wordFill}"${t.dark ? ` filter="url(#${id}-wordglow)"` : ''}>sage-bot</text>`,
    text(64, 236, ['Ask sage from', 'your team’s chat.'], { size: 40, weight: 800, fill: t.ink, lh: 1.15 }),
    text(64, 350, ['Mention @sage-bot. Each mention', 'opens its own thread.'], { size: 26, fill: t.muted, lh: 1.25 }),
  ].join('\n');
  return panel(t, id, W, H, body, 'sage-bot: ask sage from your team\'s chat. Mention @sage-bot, and each mention opens its own thread. sage-bot\'s ember arch mark beside the hooded toad sage.');
}

/** How it works: three rows (a read ask, a team vote, a lead's talk) across the three nodes. */
function how(t, id) {
  const W = 1100, H = 900;
  const C = [185, 550, 915], PW = 300, PH = 64;
  const p = (col, y, s, kind = 'plain') => pill(t, id, C[col] - PW / 2, y, PW, PH, s, kind);
  // The gaps between the pills are too narrow for a label at 24 px, so each pill says what happens, and the arrows carry no text.
  const right = (a, b, y, _s, color = t.edge, mk = 'hot', o) => flow(id, `M${C[a] + PW / 2 + 6} ${y} L ${C[b] - PW / 2 - 8} ${y}`, color, mk, o);
  const left = (a, b, y, _s, color = t.edge, mk = 'hot') => flow(id, `M${C[a] - PW / 2 - 6} ${y} L ${C[b] + PW / 2 + 8} ${y}`, color, mk);
  const back = (a, b, y, s) => flow(id, `M${C[a]} ${y} C ${C[a]} ${y + 46}, ${C[b]} ${y + 46}, ${C[b]} ${y + 6}`, t.line, 'muted') + label(t, (C[a] + C[b]) / 2, y + 66, s);
  const body = [
    backdrop(t, id, W, H, { moon: [915, 120, 100], seeds: [12, 77, 8], far: [820, 40, 160, 70, 140], near: [930, 60, 200, 80, 170], mist: [80, 280, 760], mistK: 0.6, embersTo: 860 }),
    node(t, id, 'discord', 40, 30, 290, 190, 'registered channels'),
    node(t, id, 'bot', 405, 30, 290, 190, 'the bridge, on the Mac'),
    node(t, id, 'sage', 770, 30, 290, 190, 'logbook · state tool'),
    // 1. A read ask.
    heading(t, 40, 270, '1 · READ ASK'),
    p(0, 288, '@sage-bot board', 'hot'), right(0, 1, 320, 'mention'),
    p(1, 288, 'role · limit · read'), right(1, 2, 320, 'read only'),
    p(2, 288, 'logbook, read only'),
    back(1, 0, 352, 'the answer, in a new thread'),
    // 2. A team vote.
    heading(t, 40, 476, '2 · TEAM VOTE'),
    p(2, 494, 'sage marks a question', 'hot'), left(2, 1, 526, 'marked'),
    p(1, 494, 'posts a card'), left(1, 0, 526, 'card'),
    p(0, 494, 'the team presses'),
    back(0, 2, 558, 'only the chosen option goes back'),
    // 3. A lead's talk.
    heading(t, 40, 682, '3 · LEAD TALK'),
    p(0, 700, '@sage-bot talk', 'hot'), right(0, 1, 732, 'mention'),
    p(1, 700, 'lead log · #sage-audit'), right(1, 2, 732, 'not yet', t.line, 'muted', { dash: '7 7' }),
    p(2, 700, 'lead session · T159', 'wait'),
    text(W / 2, 820, 'No Discord text reaches sage as an instruction.', { size: 28, weight: 800, fill: t.loop, anchor: 'middle' }),
    label(t, W / 2, 866, NOTICE),
  ].join('\n');
  return panel(t, id, W, H, body, `How sage-bot works, in three rows across Discord, sage-bot (the bridge on the owner's Mac) and sage. 1, a read ask: a mention such as @sage-bot board goes to the bridge, which checks the role and the hourly limit and reads sage's logbook, read only; the answer goes into a new thread. 2, a team vote: sage marks a question, the bridge posts a card, the team presses, and only the chosen option goes back to sage. 3, a lead's talk: the bridge records it in the lead log and #sage-audit; a lead session with sage is not built yet (T159). No Discord text reaches sage as an instruction. ${NOTICE}`);
}

/** The two roles side by side: what each one can do now, and what is coming. */
function roles(t, id) {
  const W = 1100, H = 680;
  const card = (x, w, title, sub, hot, rows) => {
    const out = [rect(x, 30, w, 560, { rx: 10, fill: t.tile, stroke: hot ? t.edge : t.line, sw: hot ? 2 : 1.5 }),
      text(x + 30, 82, title, { size: 34, weight: 800, fill: t.ink }), text(x + 30, 118, sub, { size: SMALL, fill: t.muted })];
    let y = 176;
    for (const [done, lines] of rows) {
      out.push(dot(t, x + 40, y - 8, done), text(x + 62, y, lines, { size: SMALL, fill: done ? t.ink : t.muted, lh: 1.25 }));
      y += 34 * [].concat(lines).length + 22;
    }
    return out.join('');
  };
  const body = [
    backdrop(t, id, W, H, { moon: [550, 620, 90], seeds: [31, 47, 5], far: [620, 30, 100, 60, 120], near: [710, 40, 120, 80, 150], mist: [80, 280, 610], mistK: 0.6, embersTo: 660 }),
    card(40, 500, 'sage-apprentice', 'Read and ask.', false, [
      [true, ['The board: tasks by state, tasks', 'left and the open questions']],
      [true, 'One task, for example T7'],
      [true, 'The open questions and options'],
      [true, ['The project’s shared graphics', 'and PDFs']],
      [true, 'Answer and vote on team questions'],
      [false, ['Time left: not estimated yet;', 'the board counts the tasks left']],
    ]),
    card(560, 500, 'sage-lead', 'Everything an apprentice can do, plus:', true, [
      [true, 'Break a tie, or end a vote early'],
      [true, ['Recommend on the autopilot', 'question; the owner decides']],
      [true, 'Unregister a channel'],
      [true, ['/sage stop: turn off the link', 'from Discord to sage']],
      [false, ['Talk to sage, write, start build', 'sessions: not built (T159)']],
    ]),
    dot(t, 60, 630, true), label(t, 78, 638, 'built', { anchor: 'start' }),
    dot(t, 180, 630, false), label(t, 198, 638, 'not built yet', { anchor: 'start' }),
    label(t, 1060, 638, 'No role: sage-bot does not answer you.', { anchor: 'end' }),
  ].join('\n');
  return panel(t, id, W, H, body, 'The two roles. sage-apprentice reads and asks: the board with tasks by state, tasks left and the open questions; one task such as T7; the open questions and their options; the shared graphics and PDFs; and answers and votes on team questions. Time left is not estimated yet. sage-lead can do everything an apprentice can, plus: break a tie or end a vote early; recommend on the autopilot question, where the owner decides; unregister a channel; and turn off the link from Discord to sage with /sage stop. Talking to sage, write operations and build sessions are not built yet (T159). A member with no role gets no answer.');
}

/** A mention opens a thread: a channel on the left, its thread on the right. Sample data. */
function threads(t, id) {
  const W = 1100, H = 700;
  const msg = (x, y, who, s, bot = false) => (bot ? botMark(t, id, x + 22, y + 4, 0.34) : circle(x + 22, y, 18, { fill: t.chip, stroke: t.line, sw: 1.5 })) +
    text(x + 54, y - 6, who, { size: SMALL, weight: 800, fill: bot ? t.edge : t.ink }) + text(x + 54, y + 26, s, { size: SMALL, fill: t.ink, lh: 1.25 });
  const body = [
    backdrop(t, id, W, H, { moon: [960, 110, 90], seeds: [31, 47, 5], far: [640, 30, 100, 60, 120], near: [730, 40, 120, 80, 150], mist: [80, 280, 620], mistK: 0.6, embersTo: 680 }),
    // The channel.
    rect(40, 30, 440, 560, { rx: 10, fill: t.tile, stroke: t.line, sw: 1.5 }),
    text(70, 76, '# ask-sage', { size: 30, weight: 800, fill: t.ink }),
    label(t, 70, 108, 'a registered channel', { anchor: 'start' }),
    msg(66, 166, 'Maya · apprentice', '@sage-bot board'),
    pill(t, id, 120, 216, 300, 48, 'thread: board', 'hot'),
    msg(66, 336, 'Jon · lead', ['@sage-bot talk: is the', 'release ready?']),
    pill(t, id, 120, 420, 300, 48, 'lead thread', 'wait'),
    label(t, 70, 520, ['Each mention in the channel', 'opens its own public thread.'], { anchor: 'start' }),
    flow(id, 'M428 240 L 556 240', t.edge, 'hot'),
    flow(id, 'M428 444 C 500 444, 500 520, 556 520', t.line, 'muted'),
    // The thread.
    rect(566, 30, 494, 400, { rx: 10, fill: t.tile, stroke: t.edge, sw: 2 }),
    text(596, 76, 'Thread: board', { size: 30, weight: 800, fill: t.ink }),
    msg(592, 134, 'sage-bot', ['Building 2 · framed 5 · merged 9', 'Open questions: G7 (A or B)']),
    msg(592, 244, 'Maya · apprentice', '@sage-bot T7'),
    msg(592, 334, 'sage-bot', ['T7 · Share the board · small', 'building · no pull request yet']),
    rect(566, 450, 494, 140, { rx: 10, fill: t.tile, stroke: t.line, sw: 1.5, dash: '7 6' }),
    msg(592, 500, 'sage-bot', ['Recorded in the lead log. Sessions', 'with sage are not on yet.']),
    label(t, W / 2, 636, 'Mention @sage-bot again inside its thread to go on. Sample data.'),
    label(t, W / 2, 674, NOTICE),
  ].join('\n');
  return panel(t, id, W, H, body, `A mention opens a thread, with sample data. In the registered channel #ask-sage, Maya, an apprentice, writes @sage-bot board, and sage-bot opens a public thread named board with the answer: building 2, framed 5, merged 9, and the open question G7. Inside the thread she writes @sage-bot T7 and gets that task. Jon, a lead, writes @sage-bot talk; that opens a lead thread, where sage-bot replies that his message is recorded in the lead log and that sessions with sage are not on yet. ${NOTICE}`);
}

/** The guardrails: the layers that are on now, and the ones that come with lead sessions. */
function safety(t, id) {
  const W = 1100, H = 860;
  const bar = (y, title, sub, on) => (on ? rect(40, y, W - 80, 76, { rx: 8, fill: t.tile, stroke: t.edge, sw: 1.5 }) : rect(40, y, W - 80, 76, { rx: 8, fill: t.tile, stroke: t.line, sw: 1.5, dash: '7 6' })) +
    dot(t, 72, y + 38, on) + text(100, y + 32, title, { size: 26, weight: 800, fill: t.ink }) + text(100, y + 62, sub, { size: SMALL, fill: t.muted });
  const body = [
    backdrop(t, id, W, H, { moon: [980, 90, 80], seeds: [31, 47, 5], far: [800, 30, 100, 60, 120], near: [890, 40, 120, 80, 150], mist: [80, 280, 780], mistK: 0.6, embersTo: 840 }),
    heading(t, 40, 52, 'ON NOW · FOR EVERY ASK'),
    bar(70, 'Roles and registered channels', 'No sage role: no reply. Only the owner registers a channel.', true),
    bar(156, 'An hourly limit', '10 asks for each person in a rolling hour.', true),
    bar(242, 'No AI reads Discord text', 'Code answers read asks. A vote gives sage only the option.', true),
    bar(328, 'The lead log', 'Each lead message, hash-chained, copied to #sage-audit.', true),
    bar(414, 'The kill switch', '/sage stop turns the link off. Only the owner turns it on.', true),
    heading(t, 40, 548, 'FOR LEAD SESSIONS · NOT ON YET (T159)'),
    bar(566, 'The sandbox: the guarantee · built', 'No GitHub host. Logbooks, sage and secrets denied.', false),
    bar(652, 'The guard hook · built · the broker · T158', 'An allow-list of commands. No broker verb merges.', false),
    bar(738, 'A spend cap · built', 'At most $5 of model use for each lead session.', false),
  ].join('\n');
  return panel(t, id, W, H, body, 'The guardrails. On now, for every ask: roles and registered channels, so a member with no sage role gets no reply and only the owner registers a channel; an hourly limit of 10 asks for each person; no AI reads Discord text, because code answers read asks and a vote gives sage only the option; the lead log, hash-chained and copied to #sage-audit; and the kill switch, /sage stop, which only the owner turns back on. For lead sessions, not on yet (T159): the sandbox settings, built, which are the guarantee, with no GitHub host and the logbooks, sage and secrets denied; the guard hook, built, and the broker, coming in T158, whose verbs never merge; and a spend cap, built, of 5 dollars of model use for each lead session.');
}

const GRAPHICS = {
  hero, 'hero-plain': heroPlain, how, roles, threads, safety,
  'tip-mention': tip(['Mention @sage-bot in a registered channel.', 'Each mention opens its own thread.', 'Mention it again inside the thread to go on.'], 'The toad sage\'s tip: mention @sage-bot in a registered channel. Each mention opens its own thread. Mention it again inside the thread to go on.'),
};

/** Every graphic in both themes, as [file name, SVG]. Each file's ids start with its own name and theme. */
export const files = () => Object.entries(GRAPHICS).flatMap(([name, draw]) => Object.entries(THEMES).map(([theme, t]) => [`${name}-${theme}.svg`, draw(t, `${name}-${theme[0]}`)]));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  const all = files();
  for (const [file, svg] of all) writeFileSync(join(OUT, file), svg);
  console.log(`drew ${all.length} files in docs/assets`);
}
