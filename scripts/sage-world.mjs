// A copy of erickb336/sage scripts/graphics.mjs at commit b0af484 (MIT), lines 1 to 767, with three changes (T90): sage's own
// graphics (hero, loop, walkthrough, routes, lifecycle, arena, pstack) and the parts that only they use are removed; the
// gradient id that sage names after its session role is "-ember", because this repository says "sage" (T97); and this header and the export line are new.
// Every kept line is otherwise as at b0af484. It gives sage-bot the sage family look: the misty mountain world, the toad sage
// and the tiles. sage-bot draws its own graphics in scripts/graphics.mjs; run `node scripts/graphics.mjs` after a change.
//
// MIT License. Copyright (c) 2026 Erick Benitez-Ramos.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
// OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
// IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// The text below is sage's, at b0af484.
// Every graphic shows the same misty mountain world (see "The misty mountain world" below), with the hooded toad sage
// and its team as toad spirits in medallions. The look is inspired by Sage Mode in Naruto (orange markings, a toad-like
// eye, natural energy) with original shapes only: no characters, logos, clothing patterns or village symbols.
// Each text is 7 px or more on a phone, where a graphic is 324 px wide: `npm run check` checks it. So the smallest
// text is SMALL (24) in a graphic 1100 wide, and 28 in the hero, which is 1280 wide.

/** The two themes. The world is a night of misty peaks in dark, and pale paper with ink-wash peaks in light. */
const THEMES = {
  light: { dark: false, bg: "#FAF6F0", hill: "#8C7867", hillOp: 0.2, mistC: "#FFFFFF", mistOp: 0.7, moonOp: 0.4, moonDisc: 0.3, tile: "#FFFFFF", panel: "#FFF3E6", chip: "#F5EBDD", ink: "#1A0E07", muted: "#6B5242", line: "#A88B75", edge: "#E5600B", bad: "#C7361F", loop: "#B4470C", glowOp: 0.25, border: "#E8D9C6" },
  dark: { dark: true, bg: "#0C0806", hill: "#3A2B21", hillOp: 0.45, mistC: "#E9D6BC", mistOp: 0.08, moonOp: 0.3, moonDisc: 0.22, tile: "#17100C", panel: "#120C08", chip: "#241A13", ink: "#FFF3E6", muted: "#CDB6A0", line: "#8A705C", edge: "#FF6A0F", bad: "#FF6A55", loop: "#FFC93C", glowOp: 0.5, border: "#3A2414" },
};
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SMALL = 24;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}="${v}"`).join(" ");

/** Text, one tspan per line. */
function text(x, y, lines, { size = 16, weight = 400, fill, anchor = "start", mono = false, lh = 1.35, opacity, ls } = {}) {
  const ts = [].concat(lines).map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size * lh}">${esc(l)}</tspan>`).join("");
  return `<text ${attrs({ x, y, "font-family": mono ? MONO : SANS, "font-size": size, "font-weight": weight, fill, "text-anchor": anchor, opacity, "letter-spacing": ls })}>${ts}</text>`;
}
/** The width of a line of text, a little more than the widest of the system font and Arial measure. */
const tw = (s, size, bold) => Math.round(s.length * size * (bold ? 0.58 : 0.48));
const rect = (x, y, w, h, o = {}) => `<rect ${attrs({ x, y, width: w, height: h, rx: o.rx ?? 12, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, "stroke-dasharray": o.dash, opacity: o.opacity })}/>`;
const path = (d, o = {}) => `<path ${attrs({ d, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw ?? 2, "stroke-dasharray": o.dash, "stroke-linecap": "round", opacity: o.opacity })}/>`;
const circle = (cx, cy, r, o = {}) => `<circle ${attrs({ cx, cy, r, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, opacity: o.opacity })}/>`;
const ellipse = (cx, cy, rx, ry, o = {}) => `<ellipse ${attrs({ cx, cy, rx, ry, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, opacity: o.opacity })}/>`;


/* The misty mountain world of the hero and "How it works". An original drawing in the user's reference mood: a hooded
 * toad sage meditates at the centre, the team is a ring of glowing medallions on an arrowed loop, and behind them are
 * misty peaks, pagodas, waterfalls, a big moon and hanging scrolls, in charcoal and ember orange.
 * Grafted from the arena: the glaring toad eye and the burning wordmark (candidate 1), the 仙 strokes (candidate 3).
 * Every shape is in canvas coordinates (no transforms), so that the text checks test the right points. */
const f1 = (n) => +(+n).toFixed(1);
/** A seeded random generator, so that each run draws the same file. */
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
/** Maps a path in local units (absolute M, L, Q, C and Z only) onto the canvas: x → ox + x·s·flip, y → oy + y·s. */
const tp = (d, ox, oy, s, flip = 1) => { let i = 0; return d.replace(/-?\d*\.?\d+/g, (n) => String(f1(i++ % 2 === 0 ? ox + +n * s * flip : oy + +n * s))); };
const EMBER = { orange: "#FF6A0F", hot: "#FF8A2A", gold: "#FFC93C", pale: "#F4E6CC", deep: "#C2410C", void: "#050302", ink: "#FFF3E4", muted: "#D6C0A8", wood: "#C9A27A" };
const pulseCss = `<style>.pulse{animation:pulse 5s ease-in-out infinite}@keyframes pulse{50%{opacity:.55}}@media (prefers-reduced-motion:reduce){.pulse{animation:none}}</style>`;

/** The gradients and filters of the world. id prefixes them, so that two graphics on one page never share an id. */
function worldDefs(id) {
  const markStops = `<stop offset="0" stop-color="#B83A0A"/><stop offset="0.55" stop-color="${EMBER.orange}"/><stop offset="1" stop-color="#FFB050"/>`;
  return `<linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080605"/><stop offset="0.45" stop-color="#1B120C"/><stop offset="0.72" stop-color="#22160E"/><stop offset="1" stop-color="#0A0706"/></linearGradient>
<radialGradient id="${id}-haze"><stop offset="0" stop-color="${EMBER.hot}" stop-opacity="0.6"/><stop offset="0.5" stop-color="${EMBER.orange}" stop-opacity="0.2"/><stop offset="1" stop-color="${EMBER.orange}" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}-moonglow"><stop offset="0.55" stop-color="#F2CD96" stop-opacity="0.5"/><stop offset="1" stop-color="#F2CD96" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}-moon" cx="0.4" cy="0.36" r="0.72"><stop offset="0" stop-color="#F8E7C6"/><stop offset="0.6" stop-color="#E4BC88"/><stop offset="1" stop-color="#B8844F"/></radialGradient>
<radialGradient id="${id}-iris" cx="0.51" cy="0.52" r="0.56"><stop offset="0" stop-color="#FFF4C2"/><stop offset="0.16" stop-color="#FFD54A"/><stop offset="0.4" stop-color="#FDB022"/><stop offset="0.66" stop-color="#EE7A0C"/><stop offset="0.86" stop-color="#A83E08"/><stop offset="1" stop-color="#4A1803"/></radialGradient>
<linearGradient id="${id}-lid" x1="0" y1="0.34" x2="0" y2="0.96"><stop offset="0" stop-color="#000" stop-opacity="0.85"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
<linearGradient id="${id}-markR" x1="0" y1="0.5" x2="1" y2="0.3">${markStops}</linearGradient>
<linearGradient id="${id}-markL" x1="1" y1="0.5" x2="0" y2="0.3">${markStops}</linearGradient>
<linearGradient id="${id}-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#040202"/><stop offset="0.32" stop-color="#1A110B"/><stop offset="0.6" stop-color="#33231A"/><stop offset="0.86" stop-color="#2C1E14"/><stop offset="1" stop-color="#3A2618"/></linearGradient>
<linearGradient id="${id}-robe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2018"/><stop offset="1" stop-color="#100B08"/></linearGradient>
<linearGradient id="${id}-bust" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2018"/><stop offset="1" stop-color="#0A0604"/></linearGradient>
<linearGradient id="${id}-hood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#382A1F"/><stop offset="1" stop-color="#18120D"/></linearGradient>
<linearGradient id="${id}-rock" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#33271D"/><stop offset="1" stop-color="#0D0907"/></linearGradient>
<radialGradient id="${id}-disc" cx="0.5" cy="0.42" r="0.62"><stop offset="0" stop-color="#3B2B1E"/><stop offset="1" stop-color="#100B08"/></radialGradient>
<radialGradient id="${id}-orb" cx="0.4" cy="0.38" r="0.65"><stop offset="0" stop-color="#FFF6D0"/><stop offset="0.45" stop-color="${EMBER.gold}"/><stop offset="1" stop-color="${EMBER.orange}"/></radialGradient>
<linearGradient id="${id}-fall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${EMBER.pale}" stop-opacity="0.95"/><stop offset="1" stop-color="${EMBER.pale}" stop-opacity="0"/></linearGradient>
<linearGradient id="${id}-word" x1="0" y1="0" x2="0" y2="1"><stop offset="0.2" stop-color="#FFF8EC"/><stop offset="0.5" stop-color="#FFD27A"/><stop offset="0.72" stop-color="${EMBER.hot}"/><stop offset="0.9" stop-color="#E2470A"/></linearGradient>
<linearGradient id="${id}-ember" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFA040"/><stop offset="1" stop-color="#F05A0A"/></linearGradient>
<filter id="${id}-wordglow" x="-10%" y="-20%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="10" result="b"/><feFlood flood-color="${EMBER.orange}" flood-opacity="0.7"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="${id}-mist" x="-30%" y="-200%" width="160%" height="500%"><feGaussianBlur stdDeviation="20"/></filter>`;
}

/** Karst peaks: a row of steep pillars with round tops, from base up by hMin..hMax, filled down to the bottom H. */
function ridge(r, W, H, base, hMin, hMax, wMin, wMax) {
  let x = -60, y = base, d = `M-60 ${H} L-60 ${base}`;
  const tops = [];
  while (x < W + 60) {
    const w = wMin + r() * (wMax - wMin), top = base - hMin - r() * (hMax - hMin), y1 = base - r() * 40;
    d += ` C${f1(x + w * 0.2)} ${f1(y - (y - top) * 0.55)} ${f1(x + w * 0.25)} ${f1(top)} ${f1(x + w * 0.5)} ${f1(top)}`;
    d += ` C${f1(x + w * 0.75)} ${f1(top)} ${f1(x + w * 0.8)} ${f1(y1 - (y1 - top) * 0.55)} ${f1(x + w)} ${f1(y1)}`;
    tops.push([f1(x + w * 0.5), f1(top)]);
    x += w;
    y = y1;
  }
  return { d: d + ` L${f1(x)} ${H} Z`, tops };
}

/** A pagoda silhouette with three tiers of upturned eaves and lit windows. (x, base) is the middle of its foot. */
function pagoda(x, base, s, fill, op, id) {
  const P = (d) => tp(d, x, base, s);
  const parts = [`<path d="${P("M-30 0 L30 0 L26 -6 L-26 -6 Z")}" fill="${fill}" opacity="${op}"/>`];
  [[-6, 34, 20], [-30, 28, 15], [-52, 22, 11]].forEach(([y0, rw, bw]) => {
    parts.push(`<path d="${P(`M${-bw} ${y0} L${bw} ${y0} L${bw} ${y0 - 14} L${-bw} ${y0 - 14} Z`)}" fill="${fill}" opacity="${op}"/>`);
    parts.push(`<path d="${P(`M${-rw} ${y0 - 18} Q${-rw * 0.55} ${y0 - 15} ${-rw * 0.32} ${y0 - 21} L0 ${y0 - 27} L${rw * 0.32} ${y0 - 21} Q${rw * 0.55} ${y0 - 15} ${rw} ${y0 - 18} Q${rw * 0.5} ${y0 - 11} 0 ${y0 - 12} Q${-rw * 0.5} ${y0 - 11} ${-rw} ${y0 - 18} Z`)}" fill="${fill}" opacity="${op}"/>`);
    parts.push(`<path d="${P(`M-4 ${y0 - 3} L4 ${y0 - 3} L4 ${y0 - 10} L-4 ${y0 - 10} Z`)}" fill="${EMBER.hot}" opacity="0.48" filter="url(#${id}-glow)"/>`);
  });
  parts.push(path(P("M0 -79 L0 -94"), { stroke: fill, sw: f1(2.4 * s), opacity: op }));
  return parts.join("");
}

/** A thin waterfall from (x, y0) to y1, with its spray. */
const waterfall = (x, y0, y1, w, id) =>
  rect(x - w / 2, y0, w, y1 - y0, { rx: w / 2, fill: `url(#${id}-fall)`, opacity: 0.42 }) +
  path(`M${x - w / 4} ${y0 + 4} L ${x - w / 4} ${y1 - 30} M${x + w / 5} ${y0 + 10} L ${x + w / 5} ${y1 - 50}`, { stroke: "#FFFFFF", sw: 1, opacity: 0.25 }) +
  `<ellipse cx="${x}" cy="${y1}" rx="${w * 3.5}" ry="${w * 1.2}" fill="${EMBER.pale}" opacity="0.16" filter="url(#${id}-mist)"/>`;

/** A band of mist: soft, wide ellipses. */
const mist = (y, id, r, op = 0.12, W = 1280) => Array.from({ length: 5 }, (_, i) => `<ellipse cx="${f1((i + r() * 0.6) * (W / 4.4))}" cy="${f1(y + (r() - 0.5) * 30)}" rx="${f1(160 + r() * 140)}" ry="${f1(18 + r() * 16)}" fill="#E9D6BC" opacity="${f1(op * (0.6 + r() * 0.6))}" filter="url(#${id}-mist)"/>`).join("");

/** Embers of natural energy: faint gold and orange dots between y0 and y1. */
const embers = (r, n, W, y0, y1) => Array.from({ length: n }, () => circle(f1(20 + r() * (W - 40)), f1(y0 + r() * (y1 - y0)), f1(0.8 + r() * 2.2), { fill: r() > 0.45 ? EMBER.gold : EMBER.hot, opacity: f1(0.18 + r() * 0.3) })).join("");

/** One glaring toad eye (candidate 1's design): a gold iris that fills the eye, a horizontal pupil, a heavy lid, and three
 *  orange blade markings that flick out to the temple. side 1 is the right eye; side -1 mirrors it for the left. */
const EYE = "M-150 22 C-104 -44 40 -86 152 -18 C116 60 -46 96 -150 22 Z";
function sageEye(cx, cy, s, side, id, n) {
  const P = (d) => tp(d, cx, cy, s, side);
  const box = (x, y, w, h, o) => rect(f1(side > 0 ? cx + x * s : cx - (x + w) * s), f1(cy + y * s), f1(w * s), f1(h * s), { ...o, rx: f1((o.rx ?? 0) * s) });
  const mark = (d) => `<path d="${P(d)}" fill="url(#${id}-mark${side > 0 ? "R" : "L"})" filter="url(#${id}-glow)"/>`;
  const veins = Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * 2 * Math.PI + 0.05; return `M${f1(4 + Math.cos(a) * 34)} ${f1(8 + Math.sin(a) * 18)} L${f1(4 + Math.cos(a) * 130)} ${f1(8 + Math.sin(a) * 90)}`; }).join(" ");
  return [
    `<defs><clipPath id="${id}-eye${n}"><path d="${P(EYE)}"/></clipPath></defs>`,
    mark("M-136 -58 C-56 -110 84 -146 248 -152 C104 -124 -16 -92 -136 -58 Z"),
    mark("M-158 18 C-108 -62 40 -110 162 -40 L242 -90 L188 -2 C60 40 -60 40 -150 22 Z"),
    mark("M-24 94 C72 98 162 68 244 28 C172 58 84 80 -24 94 Z"),
    `<path d="${P(EYE)}" fill="url(#${id}-iris)"/>`,
    `<g clip-path="url(#${id}-eye${n})">`,
    `<path d="${P(veins)}" fill="none" stroke="#7A3203" stroke-width="${f1(2 * s)}" opacity="0.3"/>`,
    `<g class="pulse">${box(-82, -19, 172, 54, { rx: 27, fill: "#FFF1A8", opacity: 0.5 })}</g>`,
    box(-68, -7, 144, 30, { rx: 15, fill: EMBER.void }),
    box(-160, -100, 330, 100, { fill: `url(#${id}-lid)` }),
    `</g>`,
    `<path d="${P(EYE)}" fill="none" stroke="${EMBER.void}" stroke-width="${f1(7 * s)}"/>`,
    `<path d="${P("M-146 2 C-96 -62 40 -106 160 -40")}" fill="none" stroke="${EMBER.void}" stroke-width="${f1(6 * s)}" stroke-linecap="round"/>`,
    ellipse(f1(cx - side * 30 * s), f1(cy - 20 * s), f1(11 * s), f1(5.5 * s), { fill: "#FFFFFF", opacity: 0.92 }),
    circle(f1(cx - side * 8 * s), f1(cy - 27 * s), f1(2.8 * s), { fill: "#FFFFFF", opacity: 0.8 }),
  ].join("");
}

// The toad sage, in local units: the origin is between the eyes; the hero draws it at 1 unit = 1 px.
const SAGE = {
  robe: "M-132 92 C-168 100 -206 118 -222 170 C-236 222 -242 300 -256 364 C-262 396 -246 414 -206 420 C-110 432 110 432 206 420 C246 414 262 396 256 364 C242 300 236 222 222 170 C206 118 168 100 132 92 Z",
  bust: "M-132 92 C-168 100 -206 118 -222 170 L-230 236 L230 236 L222 170 C206 118 168 100 132 92 Z",
  lap: "M-282 384 C-266 338 -150 324 0 336 C150 324 266 338 282 384 C290 414 258 432 216 434 L-216 434 C-258 432 -290 414 -282 384 Z",
  hood: "M0 -178 C26 -168 94 -142 124 -64 C142 -18 148 40 154 98 C122 116 70 124 0 124 C-70 124 -122 116 -154 98 C-148 40 -142 -18 -124 -64 C-94 -142 -26 -168 0 -178 Z",
  hoodRim: "M-150 70 C-146 20 -140 -20 -124 -64 C-94 -142 -26 -168 0 -178 C26 -168 94 -142 124 -64 C140 -20 146 20 150 70",
  opening: "M0 -102 C58 -102 98 -62 106 -12 C112 34 108 84 98 112 C70 128 -70 128 -98 112 C-108 84 -112 34 -106 -12 C-98 -62 -58 -102 0 -102 Z",
  openingRim: "M-98 112 C-108 84 -112 34 -106 -12 C-98 -62 -58 -102 0 -102 C58 -102 98 -62 106 -12 C112 34 108 84 98 112",
  face: "M-100 -28 C-108 10 -106 52 -90 82 C-68 112 -30 122 0 122 C30 122 68 112 90 82 C106 52 108 10 100 -28 C80 -66 -80 -66 -100 -28 Z",
  brow: "M-108 -40 C-84 -46 -48 -36 -6 -8 C-40 -20 -76 -26 -108 -24 Z",
  browLight: "M-104 -43 C-80 -47 -48 -38 -12 -14",
  mouth: "M-102 72 C-72 58 -34 56 0 58 C34 56 72 58 102 72",
  lip: "M-90 77 C-64 67 -32 65 0 67 C32 65 64 67 90 77",
  corner: "M-102 72 C-105 78 -104 86 -99 93",
  sleeve: "M-214 172 C-242 236 -242 304 -208 326 C-170 344 -118 312 -80 284 L-80 222 C-112 232 -146 238 -168 224 C-184 212 -190 194 -188 172 Z",
  sleeveLight: "M-212 176 C-238 238 -238 300 -206 320",
  cuff: "M-80 284 C-96 272 -96 236 -80 222 C-64 232 -64 270 -80 284 Z",
  foot: [["M-70 418 C-84 424 -98 428 -110 430", -110, 430, 6], ["M-66 422 C-74 430 -82 436 -88 440", -88, 440, 6], ["M-58 424 C-60 432 -62 438 -64 444", -64, 444, 5.5]],
  palm: "M-68 254 C-74 228 -62 200 -42 192 C-28 196 -20 212 -18 230 C-24 248 -44 260 -68 254 Z",
  fingers: [["M-58 222 C-58 210 -56 200 -52 190", -52, 190, 5], ["M-52 212 C-48 198 -44 186 -38 174", -38, 174, 5.6], ["M-46 204 C-40 186 -32 170 -22 155", -22, 155, 6], ["M-40 198 C-30 176 -18 156 -6 140", -6, 140, 6.5]],
  thumb: ["M-28 232 C-20 230 -12 228 -4 226", -4, 226, 6],
};

/** The toad sage: a stern toad in a dark hooded robe, seated and meditating, its toad hands joined in a triangle.
 *  Under the hood: two glowing gold toad eyes with horizontal pupils and orange sage markings. Original shapes.
 *  (cx, cy) is the point between the eyes. bust draws only the hood, the face and the shoulders. */
function toadSage(cx, cy, s, id, { bust = false } = {}) {
  const P = (d, flip = 1) => tp(d, cx, cy, s, flip);
  const X = (x) => f1(cx + x * s), Y = (y) => f1(cy + y * s), R = (n) => f1(n * s);
  const both = (d, attrs) => [-1, 1].map((fl) => `<path d="${P(d, -fl)}" ${attrs}/>`).join("");
  const r = seeded(11);
  const out = [];
  out.push(`<g class="pulse"><ellipse cx="${X(0)}" cy="${Y(bust ? 20 : 90)}" rx="${R(bust ? 210 : 300)}" ry="${R(bust ? 160 : 280)}" fill="url(#${id}-haze)" opacity="0.48"/></g>`);
  if (!bust) {
    const strands = [];
    for (let i = 0; i < 16; i++) {
      const u = i / 15, x = -230 + 460 * u + (r() - 0.5) * 30, ax = Math.abs(x), y0 = 8 + (ax <= 124 ? -178 + 114 * (ax / 124) ** 2 : ax <= 154 ? -64 + (ax - 124) * 5.4 : 98 + (ax - 154) * 0.9), h = 70 + r() * 120, w = 10 + r() * 18;
      strands.push(`<path d="M${X(x)} ${Y(y0)} C${X(x - w)} ${Y(y0 - h * 0.35)} ${X(x + w)} ${Y(y0 - h * 0.65)} ${X(x + (r() - 0.5) * 16)} ${Y(y0 - h)}" fill="none" stroke="${i % 3 ? EMBER.orange : EMBER.gold}" stroke-width="${R(1.4 + r() * 2.2)}" stroke-linecap="round" opacity="${f1(0.18 + r() * 0.26)}"/>`);
    }
    out.push(`<g class="pulse" filter="url(#${id}-glow)">${strands.join("")}</g>`);
  }
  if (bust) out.push(`<path d="${P(SAGE.bust)}" fill="url(#${id}-bust)"/>`);
  else {
    out.push(`<path d="${P(SAGE.robe)}" fill="url(#${id}-robe)"/>`);
    out.push(both("M-200 206 C-212 262 -216 322 -228 374", `fill="none" stroke="#3A2C21" stroke-width="${R(3)}" stroke-linecap="round"`));
    out.push(`<path d="${P(SAGE.lap)}" fill="url(#${id}-robe)" stroke="#0A0705" stroke-width="${R(1.5)}"/>`);
    out.push(both("M-262 398 C-200 372 -120 366 -40 380", `fill="none" stroke="#3A2C21" stroke-width="${R(3)}" stroke-linecap="round"`));
    out.push(path(P("M-36 392 C-14 406 14 406 36 392"), { stroke: "#3A2C21", sw: R(2.5) }));
  }
  out.push(both("M-150 96 C-178 104 -208 122 -222 172", `fill="none" stroke="#F2C88C" stroke-width="${R(2.2)}" opacity="0.45" stroke-linecap="round"`));
  // The lapels, with an ember trim, and the prayer beads.
  out.push(both("M-120 104 C-92 132 -60 170 -26 226", `fill="none" stroke="${EMBER.deep}" stroke-width="${R(3.2)}" opacity="0.8" stroke-linecap="round"`));
  if (!bust) for (let i = 0; i <= 14; i++) {
    const u = i / 14, bx = -86 + 172 * u, by = 112 + 38 * Math.sin(Math.PI * u);
    out.push(circle(X(bx), Y(by), R(6.4), { fill: i === 7 ? EMBER.deep : "#3B2B1F", stroke: "#0A0705", sw: R(1) }) + circle(X(bx - 2), Y(by - 2), R(2), { fill: "#9A7A5C", opacity: 0.45 }));
  }
  // The hood: a dark cowl with a moonlit rim and folds, and a deep shadow inside.
  out.push(`<path d="${P(SAGE.hood)}" fill="url(#${id}-hood)"/>`);
  out.push(both("M-62 -148 C-92 -112 -114 -62 -124 0", `fill="none" stroke="#4A392B" stroke-width="${R(2.5)}" opacity="0.8" stroke-linecap="round"`));
  out.push(path(P("M0 -178 C3 -152 2 -128 0 -106"), { stroke: "#4A392B", sw: R(2.5), opacity: 0.8 }));
  out.push(`<path d="${P(SAGE.hoodRim)}" fill="none" stroke="#F2C88C" stroke-width="${R(2.6)}" opacity="0.6" filter="url(#${id}-glow)"/>`);
  out.push(`<path d="${P(SAGE.opening)}" fill="#040202"/>`, `<path d="${P(SAGE.openingRim)}" fill="none" stroke="#3E2F23" stroke-width="${R(7)}"/>`);
  // The face: a wide toad head, dark under the hood, lit from below by its eyes.
  out.push(`<path d="${P(SAGE.face)}" fill="url(#${id}-skin)"/>`);
  out.push([-1, 1].map((sd) => ellipse(X(sd * 88), Y(38), R(14), R(26), { fill: "#3A291C", opacity: 0.85 }) + path(P(`M${sd * 76} 16 C${sd * 72} 34 ${sd * 74} 54 ${sd * 82} 64`), { stroke: "#120C08", sw: R(1.6), opacity: 0.7 }) + [[0, 26], [-5, 40], [4, 50], [-2, 56]].map(([dx, dy]) => circle(X(sd * (88 + dx)), Y(dy + 4), R(2.6), { fill: "#1D130C" })).join("")).join(""));
  const mouthY = (x) => 58 + 12 * (x / 98) ** 2;
  for (let i = 0; i < 90; i++) {
    const x = (r() * 2 - 1) * 100, y = 6 + r() * 112, rr = 1.5 + r() * 2.8;
    const inFace = (x / 100) ** 2 + ((y - 44) / 76) ** 2 < 0.9;
    if (!inFace || (Math.abs(Math.abs(x) - 46) < 36 && y < 26) || Math.abs(y - mouthY(x)) < 8 || (Math.abs(x) < 22 && Math.abs(y - 34) < 9)) continue;
    out.push(circle(X(x), Y(y), R(rr), { fill: "#1D130C", opacity: 0.85 }) + circle(X(x - rr * 0.3), Y(y - rr * 0.35), R(rr * 0.45), { fill: "#9A7050", opacity: 0.5 }));
  }
  out.push(both(SAGE.brow, `fill="#120B07"`));
  out.push(both(SAGE.browLight, `fill="none" stroke="${EMBER.hot}" stroke-width="${R(1.6)}" opacity="0.6" stroke-linecap="round"`));
  out.push(`<g class="pulse">${[-1, 1].map((sd) => `<ellipse cx="${X(sd * 50)}" cy="${Y(2)}" rx="${R(46)}" ry="${R(22)}" fill="${EMBER.orange}" opacity="0.45" filter="url(#${id}-blur)"/>`).join("")}</g>`);
  out.push(sageEye(X(-46), Y(2), 0.17 * s, -1, id, 1), sageEye(X(46), Y(2), 0.17 * s, 1, id, 2));
  out.push([-1, 1].map((sd) => ellipse(X(sd * 11), Y(34), R(3.6), R(2.2), { fill: "#070403" })).join(""));
  out.push(path(P(SAGE.lip), { stroke: "#8A6242", sw: R(1.6), opacity: 0.55 }));
  out.push(path(P(SAGE.mouth), { stroke: EMBER.void, sw: R(4.5) }));
  out.push(both(SAGE.corner, `fill="none" stroke="${EMBER.void}" stroke-width="${R(3.2)}" stroke-linecap="round"`));
  if (bust) return out.join("");
  // The sleeves, and the toad hands joined in a triangle around a seed of natural energy. The hands are drawn
  // 1.2 times larger, about the middle of the triangle (0, 196).
  out.push(both(SAGE.sleeve, `fill="url(#${id}-hood)" stroke="#080504" stroke-width="${R(2)}"`));
  out.push(both(SAGE.sleeveLight, `fill="none" stroke="#F2C88C" stroke-width="${R(2)}" opacity="0.35" stroke-linecap="round"`));
  out.push(both("M-200 304 C-166 306 -124 290 -92 270 M-178 250 C-150 256 -120 250 -96 240", `fill="none" stroke="#120C08" stroke-width="${R(2.5)}" opacity="0.8" stroke-linecap="round"`));
  out.push(both(SAGE.cuff, `fill="#070504" stroke="#4A392B" stroke-width="${R(1.5)}"`));
  out.push(`<g class="pulse"><ellipse cx="${X(0)}" cy="${Y(190)}" rx="${R(36)}" ry="${R(48)}" fill="${EMBER.hot}" opacity="0.48" filter="url(#${id}-blur)"/></g>`);
  out.push(circle(X(0), Y(194), R(6), { fill: "#FFE3A6", opacity: 0.9 }), circle(X(0), Y(194), R(13), { fill: EMBER.gold, opacity: 0.3 }));
  const k = 1.2 * s, hy = cy + 196 * s * (1 - 1.2);
  const HX = (x) => f1(cx + x * k), HY = (y) => f1(hy + y * k), HR = (n) => f1(n * k);
  const digit = (Q, sd) => ([d, tx, ty, pr]) =>
    `<path d="${Q(d)}" fill="none" stroke="#0E0906" stroke-width="${HR(12)}" stroke-linecap="round"/><path d="${Q(d)}" fill="none" stroke="#6A4A31" stroke-width="${HR(8)}" stroke-linecap="round"/>` +
    circle(HX(sd * tx), HY(ty), HR(pr), { fill: "#9A7048", stroke: "#0E0906", sw: HR(1.5) }) + circle(HX(sd * (tx - 1.4)), HY(ty - 1.8), HR(pr * 0.42), { fill: "#E2B888", opacity: 0.75 });
  for (const sd of [-1, 1]) {
    const Q = (d) => tp(d, cx, hy, k, sd);
    out.push(SAGE.fingers.map(digit(Q, sd)).join(""));
    out.push(`<path d="${Q(SAGE.palm)}" fill="#5A3F29" stroke="#0E0906" stroke-width="${HR(1.6)}"/>`);
    out.push(path(Q("M-62 222 C-56 208 -48 199 -38 195"), { stroke: "#B08458", sw: HR(1.8), opacity: 0.7 }));
    out.push(digit(Q, sd)(SAGE.thumb));
    out.push([[-50, 236, 2.4], [-38, 214, 2], [-58, 244, 1.8], [-30, 226, 1.6]].map(([wx, wy, wr]) => circle(HX(sd * wx), HY(wy), HR(wr), { fill: "#2A1C12", opacity: 0.8 })).join(""));
  }
  // The toad feet under the robe, on the rock.
  for (const sd of [-1, 1]) out.push(SAGE.foot.map(([d, tx, ty, pr]) =>
    `<path d="${P(d, sd)}" fill="none" stroke="#0E0906" stroke-width="${R(11)}" stroke-linecap="round"/><path d="${P(d, sd)}" fill="none" stroke="#6A4A31" stroke-width="${R(7.5)}" stroke-linecap="round"/>` +
    circle(X(sd * tx), Y(ty), R(pr), { fill: "#9A7048", stroke: "#0E0906", sw: R(1.4) })).join(""));
  return out.join("");
}

// Where the spirit's hand goes for each tool, in medallion units (the medallion has a radius of 50).
const HANDS = { scroll: [10, 6], square: [13, 6], anvil: [8, 2], scales: [12, 10], lens: [9, 7], shield: [12, 6], mirror: [19, 16], orb: [18, 11] };

/** A pale, glowing toad spirit with its tool, in a medallion of radius 50·s centred on (cx, cy). */
function spirit(cx, cy, s, tool, id) {
  const P = (d) => tp(d, cx, cy, s);
  const X = (x) => f1(cx + x * s), Y = (y) => f1(cy + y * s), R = (n) => f1(n * s);
  const pale = EMBER.pale, dark = "#2E2016";
  const st = (d, w, c = pale, op) => path(P(d), { stroke: c, sw: R(w), opacity: op });
  const fl = (d, c = pale, op) => `<path d="${P(d)}" fill="${c}"${op ? ` opacity="${op}"` : ""}/>`;
  const [hx, hy] = HANDS[tool];
  // A stern spirit: slit eyes under slanted brows, a flat mouth, and a wisp of a tail.
  const toad = [
    st("M-29 16 C-40 12 -43 2 -37 -4 C-33 -8 -28 -5 -31 -1", 2.4, pale, 0.55),
    ellipse(X(-25), Y(28), R(12), R(7.5), { fill: pale, opacity: 0.9 }),
    ellipse(X(5), Y(28), R(12), R(7.5), { fill: pale, opacity: 0.9 }),
    ellipse(X(-10), Y(14), R(21), R(16), { fill: pale, opacity: 0.9 }),
    ellipse(X(-10), Y(-5), R(19.5), R(12.5), { fill: pale }),
    circle(X(-20), Y(-14), R(6.4), { fill: pale }),
    circle(X(0), Y(-14), R(6.4), { fill: pale }),
    ellipse(X(-20), Y(-13), R(3.8), R(1.9), { fill: EMBER.orange }),
    ellipse(X(0), Y(-13), R(3.8), R(1.9), { fill: EMBER.orange }),
    rect(X(-22.4), Y(-13.6), R(4.8), R(1.2), { rx: 0, fill: dark }),
    rect(X(-2.4), Y(-13.6), R(4.8), R(1.2), { rx: 0, fill: dark }),
    st("M-27 -19 L-14 -16 M7 -19 L-6 -16", 1.8, dark),
    st("M-27 0 C-16 1 -4 1 7 0 M-27 0 L-28 3 M7 0 L8 3", 1.4, dark),
    st("M-22 -24 L-17 -21 M2 -24 L-3 -21", 1.2, EMBER.deep),
    st("M-26 10 C-30 16 -30 22 -26 28", 1.3, dark, 0.5),
    st(`M2 6 C6 8 ${hx - 4} ${hy} ${hx} ${hy}`, 5.2),
    circle(X(hx + 2), Y(hy - 2), R(1.9), { fill: pale }),
    circle(X(hx + 2.6), Y(hy + 1.2), R(1.9), { fill: pale }),
  ];
  const tools = {
    scroll: [st("M14 -25 L42 -25", 3.6, EMBER.wood), fl("M17 -25 L39 -25 L39 17 L17 17 Z", pale, 0.92), st("M23 -16 C26 -12 25 -6 22 -1", 2.4, EMBER.deep), st("M31 -15 L31 4", 2, "#5A3E2A"), st("M23 7 C27 5 31 7 34 11", 2.2, EMBER.orange), st("M14 17 L42 17", 3.6, EMBER.wood), st("M4 12 L16 -4", 2.6, EMBER.wood), fl("M15 -2 C16 -7 19 -10 21 -12 C21 -8 19 -4 17 -1 Z", "#1A120C")],
    square: [`<path d="${P("M14 26 L44 26 L14 -20 Z")}" fill="${pale}" fill-opacity="0.18" stroke="${pale}" stroke-width="${R(3.2)}" stroke-linejoin="round"/>`, `<path d="${P("M19 21 L32 21 L19 1 Z")}" fill="none" stroke="${pale}" stroke-width="${R(1.6)}" stroke-linejoin="round"/>`, st("M22 26 L22 23 M28 26 L28 23.5 M34 26 L34 23 M40 26 L40 23.5", 1.1, dark), st("M14 -10 L17 -10 M14 -2 L17 -2 M14 6 L17 6", 1.1, dark)],
    anvil: [fl("M12 10 L36 10 C40 10 44 9 46 7 C44 13 40 16 34 16 L30 16 L30 22 L36 28 L14 28 L20 22 L20 16 L16 16 C13 16 12 13 12 10 Z", pale, 0.92), st("M6 2 L18 -14", 2.8, EMBER.wood), st("M12 -19 L24 -10", 6.5), `<g filter="url(#${id}-glow)">${st("M28 6 L34 -4", 1.6, EMBER.gold)}${st("M24 5 L21 -6", 1.6, EMBER.gold)}${st("M32 7 L42 0", 1.6, EMBER.hot)}${st("M30 5 L38 -9", 1.2, EMBER.orange)}${circle(X(36), Y(-9), R(1.4), { fill: EMBER.gold })}${circle(X(43), Y(-3), R(1.2), { fill: EMBER.gold })}${circle(X(19), Y(-5), R(1.2), { fill: EMBER.hot })}</g>`],
    scales: [st("M25 -27 L25 24", 2.6), st("M17 26 L33 26", 3.6), circle(X(25), Y(-28), R(2.8), { fill: pale }), st("M11 -18 L39 -18", 2.4), st("M11 -18 L5 0 M11 -18 L17 0 M39 -18 L33 0 M39 -18 L45 0", 1.1), fl("M3 0 L19 0 C17 6 5 6 3 0 Z"), fl("M31 0 L47 0 C45 6 33 6 31 0 Z"), circle(X(39), Y(-3), R(2.2), { fill: EMBER.gold })],
    lens: [st("M9 7 L18 -2", 3.8, EMBER.wood), circle(X(25), Y(-10), R(10.5), { fill: pale, opacity: 0.2 }), circle(X(25), Y(-10), R(10.5), { stroke: pale, sw: R(3) }), st("M19 -14 C20 -16 23 -17 25 -17", 1.4, "#FFFFFF")],
    shield: [fl("M28 -24 C34 -20 40 -20 44 -20 C44 -2 40 14 28 24 C16 14 12 -2 12 -20 C16 -20 22 -20 28 -24 Z", pale, 0.92), `<path d="${P("M28 -18 C32 -15 36 -15 39 -15 C39 -2 36 10 28 17 C20 10 17 -2 17 -15 C20 -15 24 -15 28 -18 Z")}" fill="none" stroke="${dark}" stroke-width="${R(1)}" opacity="0.5"/>`, circle(X(28), Y(-5), R(3.6), { fill: EMBER.orange }), fl("M26.4 -3 L29.6 -3 L31 7 L25 7 Z", EMBER.orange)],
    mirror: [st("M27 5 L22 21", 4, EMBER.wood), circle(X(21.6), Y(23), R(2.6), { fill: EMBER.gold }), `<ellipse cx="${X(28)}" cy="${Y(-10)}" rx="${R(11)}" ry="${R(14)}" fill="#3A4650" stroke="${EMBER.gold}" stroke-width="${R(3.4)}"/>`, circle(X(28), Y(-25.5), R(2.4), { fill: EMBER.gold }), st("M22 -16 L31 -3", 2, "#FFFFFF", 0.75), st("M27 -19 L33 -11", 1.3, "#FFFFFF", 0.55), ellipse(X(31), Y(-6), R(3), R(2), { fill: EMBER.orange, opacity: 0.8 })],
    orb: [`<circle cx="${X(25)}" cy="${Y(0)}" r="${R(16)}" fill="${EMBER.orange}" opacity="0.4" filter="url(#${id}-glow)"/>`, circle(X(25), Y(0), R(9.5), { fill: `url(#${id}-orb)` }), circle(X(22), Y(-3), R(2.6), { fill: "#FFFFFF", opacity: 0.8 })],
  };
  return toad.join("") + tools[tool].join("");
}

/** A dark world panel: the defs, the slow glow (off for readers who ask for less motion), and a rounded frame. */
function worldSvg(w, h, id, defs, body, label, o = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
${pulseCss}
<defs>
${defs}
<clipPath id="${id}-frame"><rect width="${w}" height="${h}" rx="${o.rx ?? 28}"/></clipPath>
</defs>
<g clip-path="url(#${id}-frame)">
<rect width="${w}" height="${h}" rx="${o.rx ?? 28}" fill="${o.bg ?? `url(#${id}-sky)`}"/>
${body}
</g>
${o.border ? `<rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="${(o.rx ?? 28) - 0.75}" fill="none" stroke="${o.border}" stroke-width="1.5"/>` : ""}
</svg>
`;
}

/** The arrowheads of a world graphic: hot (the main flow), muted, bad (back to the build) and loop. */
const markers = (id, t) => [["hot", t.edge], ["muted", t.line], ["bad", t.bad], ["loop", t.loop]].map(([name, color]) => `<marker id="${id}-${name}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L12 6 L0 12 L3 6 z" fill="${color}"/></marker>`).join("\n");

/** A line with an arrowhead at its end: marker is hot, muted, bad or loop (see markers). */
const flow = (id, d, color, marker, o = {}) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.sw ?? 2.5}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""} stroke-linecap="round" stroke-linejoin="round"${marker ? ` marker-end="url(#${id}-${marker})"` : ""}/>`;

/** A tile with a title and a smaller line or two under it. A hot tile has a glowing ember edge. */
function tile(t, id, x, y, w, h, title, sub, hot, { titleY = 40, size = 26, subSize = SMALL, gap = 34, fill = t.tile, ink = t.ink, subInk = t.muted } = {}) {
  return (hot ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="none" stroke="${t.edge}" stroke-width="4" opacity="${t.glowOp}" filter="url(#${id}-glow)"/>` : "") +
    rect(x, y, w, h, { rx: 8, fill, stroke: hot ? t.edge : t.line, sw: hot ? 2 : 1.5 }) +
    text(x + w / 2, y + titleY, title, { size, weight: 800, fill: ink, anchor: "middle" }) +
    text(x + w / 2, y + titleY + gap, sub, { size: subSize, fill: subInk, anchor: "middle", lh: 1.25 });
}
/** A flat plaque with one label. kind: "you" (an ember fill: a step for you), "hot" (an ember edge), "bad" (a red edge),
 *  "wait" (a dashed edge), or "plain". */
function pill(t, id, x, y, w, h, label, kind = "plain", size = SMALL) {
  const box = kind === "you" ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="url(#${id}-ember)"/>`
    : rect(x, y, w, h, { rx: 8, fill: t.tile, stroke: { hot: t.edge, bad: t.bad }[kind] ?? t.line, sw: kind === "hot" || kind === "bad" ? 2 : 1.5, dash: kind === "wait" ? "6 5" : undefined });
  return box + text(f1(x + w / 2), f1(y + h / 2 + size * 0.35), label, { size, weight: 700, fill: kind === "you" ? "#160902" : t.ink, anchor: "middle" });
}

/** A label in capitals, the heading inside a graphic. */
const heading = (t, x, y, s) => text(x, y, s, { size: SMALL, weight: 800, fill: t.loop, ls: 2 });

/** The world behind a graphic: a moon, two rows of misty peaks with pagodas and waterfalls, mist, and embers at night.
 *  Draw it first, so that every label sits on top of it. seeds: the far peaks, the near peaks, the mist and embers.
 *  far and near: a ridge's base, its lowest and highest peak, and its narrowest and widest peak. mistK scales the mist;
 *  under text, keep it at 0.6, so that the mist stays a soft glow and never reads as a shape behind a label. */
function backdrop(t, id, W, H, { moon: [mx, my, mr], seeds: [s1, s2, s3], far, near, pagodas = [], falls = [], mist: [x0, step, y], mistK = 1, embersTo = H }) {
  const r = seeded(s3);
  return [
    `<circle cx="${mx}" cy="${my}" r="${f1((mr * 250) / 186)}" fill="url(#${id}-moonglow)" opacity="${t.moonOp}"/>`,
    `<circle cx="${mx}" cy="${my}" r="${mr}" fill="url(#${id}-moon)" opacity="${t.moonDisc}"/>`,
    `<path d="${ridge(seeded(s1), W, H, ...far).d}" fill="${t.hill}" opacity="${f1(t.hillOp * 0.7)}"/>`,
    ...pagodas.map(([x, base, s, k]) => pagoda(x, base, s, t.hill, f1(t.hillOp * k), id)),
    ...falls.map(([x, y0, y1, w]) => waterfall(x, y0, y1, w, id)),
    `<path d="${ridge(seeded(s2), W, H, ...near).d}" fill="${t.hill}" opacity="${t.hillOp}"/>`,
    Array.from({ length: 4 }, (_, i) => `<ellipse cx="${f1(x0 + i * step + r() * 60)}" cy="${f1(y + r() * 60)}" rx="${f1(200 + r() * 80)}" ry="26" fill="${t.mistC}" opacity="${f1(t.mistOp * mistK * (0.7 + r() * 0.4))}" filter="url(#${id}-mist)"/>`).join(""),
    t.dark ? embers(r, 40, W, 20, embersTo) : "",
  ].join("\n");
}

/** The toad sage's emblem: its hooded bust in a gold-rimmed medallion of radius r. One per graphic: its clip ids are fixed. */
function emblem(cx, cy, r, id) {
  return [
    `<g class="pulse"><circle cx="${cx}" cy="${cy}" r="${f1(r + 14)}" fill="${EMBER.orange}" opacity="0.34" filter="url(#${id}-blur)"/></g>`,
    circle(cx, cy, r + 8, { stroke: EMBER.gold, sw: 1, opacity: 0.45 }),
    `<defs><clipPath id="${id}-emblem"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>`,
    circle(cx, cy, r, { fill: "#0A0604" }),
    `<g clip-path="url(#${id}-emblem)">${toadSage(cx, f1(cy - r * 0.08), r / 190, id, { bust: true })}</g>`,
    circle(cx, cy, r, { stroke: EMBER.gold, sw: 3.2 }),
    circle(cx, cy, r - 6, { stroke: EMBER.orange, sw: 1.2, opacity: 0.75 }),
  ].join("");
}

/** A world panel in the reader's theme, with the world's defs and arrowheads. */
const panel = (t, id, W, H, body, label) => worldSvg(W, H, id, [worldDefs(id), markers(id, t)].join("\n"), body, label, { rx: 24, bg: t.bg, border: t.border });

/** A tip from the toad sage: its emblem on the left, and the tip on a hanging scroll to the right. */
const tip = (lines, label) => (t, id) => {
  const W = 1100, H = 230 + Math.max(0, lines.length - 3) * 34, size = 24, lh = 1.4;
  const sx = 222, sy = 32, sw = W - 36 - sx, sh = H - 64;
  const ty = f1(sy + (sh - (34 + (lines.length - 1) * size * lh + size)) / 2 + 22);
  const body = [
    backdrop(t, id, W, H, { moon: [120, H / 2, 96], seeds: [31, 47, 5], far: [H - 30, 30, 90, 60, 120], near: [H + 50, 40, 110, 80, 150], mist: [80, 280, H - 80], mistK: 0.6, embersTo: H - 20 }),
    emblem(120, H / 2, 74, id),
    `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="4" fill="${t.edge}" opacity="${t.glowOp}" filter="url(#${id}-glow)"/>`,
    rect(sx, sy, sw, sh, { rx: 4, fill: t.tile, stroke: t.edge, sw: 1.5 }),
    rect(sx + 9, sy + 9, sw - 18, sh - 18, { rx: 2, stroke: t.line, sw: 1, opacity: 0.6 }),
    rect(sx - 9, sy - 10, 14, sh + 20, { rx: 7, fill: "#3D2D21", stroke: "#120C08", sw: 1 }),
    rect(sx + sw - 5, sy - 10, 14, sh + 20, { rx: 7, fill: "#3D2D21", stroke: "#120C08", sw: 1 }),
    rect(sx + sw - 50, sy + sh - 48, 20, 20, { rx: 2, fill: EMBER.deep, opacity: 0.85 }),
    text(sx + 40, ty, "TIP", { size: SMALL, weight: 800, fill: t.loop, ls: 2 }),
    text(sx + 40, ty + 36, lines, { size, weight: 600, fill: t.ink, lh }),
  ].join("\n");
  return panel(t, id, W, H, body, label);
};

export { THEMES, SANS, MONO, SMALL, EMBER, esc, text, tw, rect, path, circle, ellipse, f1, seeded, worldDefs, worldSvg, markers, flow, tile, pill, heading, backdrop, emblem, toadSage, panel, tip };
