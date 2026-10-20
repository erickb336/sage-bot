// T249: the README's hero graphic, "Round trip", in light and dark. Run: node scripts/hero.mjs
// It writes docs/assets/hero-light.svg and docs/assets/hero-dark.svg; test/t249-hero.test.js checks that they match.
// The names and the planned steps are sample data, and the graphic labels them so.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;

const THEMES = {
  light: {
    bg0: '#FCFDFE', bg1: '#EEF2F7', edge: '#DCE3EB', glowA: 0.16, glowB: 0.14,
    card: '#FFFFFF', cardEdge: '#E2E8F0', ink: '#0F1729', mute: '#5A6676', faint: '#8A95A5',
    blurple: '#5865F2', blurple2: '#7983F5', amber: '#D08A12', amber2: '#E9A93A', green: '#1F9D63', green2: '#35B97C', shadow: 0.10,
  },
  dark: {
    bg0: '#0E131C', bg1: '#080B11', edge: '#232C3A', glowA: 0.30, glowB: 0.24,
    card: '#141B26', cardEdge: '#2A3546', ink: '#E8EDF4', mute: '#9AA6B6', faint: '#6E7A8B',
    blurple: '#7C86FF', blurple2: '#5865F2', amber: '#F0B54A', amber2: '#D08A12', green: '#3DD08F', green2: '#1F9D63', shadow: 0.45,
  },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, size, fill, s, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;

// Glyphs drawn in a 64x64 box, white on a coloured tile.
const GLYPH = {
  approve: `<path d="M32 12l17 6v12c0 11-7.5 19-17 22-9.5-3-17-11-17-22V18z" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><path d="M24 32l6 6 11-12" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
  build: `<rect x="12" y="16" width="40" height="32" rx="6" fill="none" stroke="#fff" stroke-width="3.5"/><path d="M20 27l6 5-6 5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 38h12" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>`,
};

/** The hero SVG for one theme ('light' or 'dark'), as a string. */
export function hero(theme) {
  const t = THEMES[theme], id = `b${theme[0]}`, W = 1200, H = 520;
  const glows = [['g1', t.blurple, t.glowA + 0.04], ['g2', t.amber, t.glowB], ['g3', t.green, t.glowA + 0.04]];
  let body = `<defs>
<linearGradient id="${id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bg0}"/><stop offset="1" stop-color="${t.bg1}"/></linearGradient>
${glows.map(([n, c, o]) => `<radialGradient id="${id}${n}"><stop offset="0" stop-color="${c}" stop-opacity="${o}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('\n')}
<filter id="${id}sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="${t.shadow}"/></filter>
<linearGradient id="${id}gb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.blurple2}"/><stop offset="1" stop-color="${t.blurple}"/></linearGradient>
<linearGradient id="${id}ga" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.amber2}"/><stop offset="1" stop-color="${t.amber}"/></linearGradient>
<linearGradient id="${id}gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.green2}"/><stop offset="1" stop-color="${t.green}"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" rx="28" fill="url(#${id}bg)"/>
<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="27.5" fill="none" stroke="${t.edge}" stroke-width="1.5"/>`;
  const glow = (n, cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${id}${n})"/>`;
  body += glow('g1', 210, 270, 300, 230) + glow('g2', 600, 120, 220, 120) + glow('g3', 990, 270, 300, 230);
  body += `<g font-family="${SANS}">`;
  // The two end cards: the team and sage.
  const node = (x, title, sub1, sub2, inner) => {
    const w = 300, h = 236, y = 150;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="${t.card}" stroke="${t.cardEdge}" filter="url(#${id}sh)"/>` + inner(x, y) +
      text(x + w / 2, y + 150, 36, t.ink, title, `text-anchor="middle" font-weight="700" letter-spacing="-0.5"`) +
      text(x + w / 2, y + 188, 24, t.mute, sub1, `text-anchor="middle"`) + text(x + w / 2, y + 218, 24, t.mute, sub2, `text-anchor="middle"`);
  };
  const avatars = (x, y) => {
    const cols = [t.blurple, '#C2569B', '#2C8FB8'], init = ['M', 'J', 'A'];
    return cols.map((c, i) => `<circle cx="${x + 150 - 44 + i * 44}" cy="${y + 68}" r="30" fill="${c}" stroke="${t.card}" stroke-width="5"/>` +
      text(x + 150 - 44 + i * 44, y + 77, 24, '#fff', init[i], `text-anchor="middle" font-weight="700"`)).join('');
  };
  const tile = (x, y, s, fill, glyph) =>
    `<g transform="translate(${x} ${y})"><rect width="${s}" height="${s}" rx="${s * 0.28}" fill="${fill}"/><g transform="scale(${s / 64})">${GLYPH[glyph]}</g></g>`;
  body += node(60, 'The team', 'posts in a', 'Discord thread', avatars);
  body += node(840, 'sage', 'builds the project', 'in Claude Code', (x, y) => tile(x + 118, y + 32, 64, `url(#${id}gg)`, 'build'));
  // Top arc: team to the owner's card (built), then on to sage (planned, T159: dotted).
  body += `<path d="M210 150 C 210 84, 400 64, 556 64" fill="none" stroke="${t.blurple}" stroke-width="4" stroke-linecap="round"/>`;
  body += `<path d="M644 64 C 800 64, 990 84, 990 146" fill="none" stroke="${t.green}" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 9"/>`;
  body += `<path d="M979 134l11 14 11-14" fill="none" stroke="${t.green}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  body += `<circle cx="600" cy="64" r="44" fill="url(#${id}ga)" filter="url(#${id}sh)"/>`;
  body += `<g transform="translate(568 32)">${GLYPH.approve}</g>`;
  body += text(600, 142, 26, t.ink, 'The owner approves', `text-anchor="middle" font-weight="650"`);
  body += text(600, 174, 23, t.mute, 'each message on a card', `text-anchor="middle"`);
  // Bottom arc: sage back to the team (planned, T160: dotted).
  body += `<path d="M990 386 C 990 470, 780 476, 600 476 C 420 476, 210 470, 210 392" fill="none" stroke="${t.faint}" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 9"/>`;
  body += `<path d="M199 402l11-14 11 14" fill="none" stroke="${t.faint}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  body += text(600, 438, 26, t.ink, 'Results come back to the thread', `text-anchor="middle" font-weight="650"`);
  body += text(600, 272, 25, t.mute, 'Nothing from Discord', `text-anchor="middle"`);
  body += text(600, 304, 25, t.mute, 'reaches sage without', `text-anchor="middle"`);
  body += text(600, 336, 25, t.mute, 'the owner’s Approve.', `text-anchor="middle"`);
  body += text(W - 32, H - 22, 19, t.faint, 'Sample. Dotted: planned (T159, T160).', `text-anchor="end"`);
  body += '</g>';
  const label = 'The round trip: the team messages sage from a Discord thread, the owner approves each message on a card, sage builds the project in Claude Code, and results come back to the thread. Delivery to sage and the replies are planned.';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${body}</svg>\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const theme of ['light', 'dark']) {
    const file = new URL(`../docs/assets/hero-${theme}.svg`, import.meta.url);
    writeFileSync(file, hero(theme));
    console.log(`written: ${fileURLToPath(file)}`);
  }
}
