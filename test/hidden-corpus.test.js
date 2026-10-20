// Standing order 16: the scope of the hidden-character and look-alike checks of the outbox is the corpus test/fixtures/hidden-corpus.json.
// This test sweeps every code point against its rules, for both readers: the card's Hidden count (people) and `literal` (a model).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { safeOf } from '../src/cards.js';
import { literal } from '../src/outbox.js';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/hidden-corpus.json', import.meta.url), 'utf8'));
/** A corpus text: each {U+XXXX} is that code point. */
const text = (t) => t.replace(/\{U\+([0-9A-F]{4,6})\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
const rule = (r) => new RegExp(`^${r}$`, 'v');
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
/** The card's reader: safeOf as the approval card calls it, with backticks shown (F-T247-30); `dropped` is the count of its dropped code points. */
const card = (t) => ({ dropped: safeOf(t, { backticks: true }).dropped.length });

test('the corpus says that reviews block only on its gaps, and names the classes of the brief', () => {
  assert.match(corpus.about, /A review blocks only on a gap in this corpus/);
  const named = corpus.card.drop.map((d) => d.class).join(' | ');
  for (const word of ['default-ignorable', 'tag', 'variation selector', 'bidi', 'zero-width', 'after punctuation', '4th', 'Braille', 'blank filler']) {
    assert.ok(named.includes(word), word);
  }
});

test('the card (people): over every code point, alone and on a letter with 0, 3 non-spacing or 4 spacing marks, safeOf drops and counts exactly what no keep rule of the corpus keeps', () => {
  const keep = corpus.card.keep.map((k) => ({ re: rule(k.rule), max: k.onLetter, joiner: k.joiner }));
  const joining = rule(corpus.card.joining);
  const always = corpus.card.drop.filter((d) => !d.where).map((d) => rule(d.rule));
  // Each prefix is empty (nothing to stand on) or a letter with its marks: none, 3 non-spacing (the last, U+0303, is 'joining'), 4 spacing.
  const prefixes = ['', 'a', 'a\u0301\u0302\u0303', 'a\u0903\u0903\u0903\u0903'];
  for (const p of prefixes) assert.equal(card(p).dropped, 0, JSON.stringify(p));
  // One code point at the end of the text: the joiner rule keeps it only after a 'joining' mark (there is no next code point).
  const kept = (p, ch) => keep.some(({ re, max, joiner }) => re.test(ch) && (joiner
    ? joining.test(p.slice(-1)) && /^\p{M}$/u.test(p.slice(-1))
    : !max || (p !== '' && Array.from(p).slice(1).filter((c) => re.test(c)).length < max)));
  let drops = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp);
    // The corpus agrees with itself: a drop class with no 'where' meets no keep rule but the joiner rule.
    if (always.some((re) => re.test(ch)) && keep.some(({ re, joiner }) => !joiner && re.test(ch))) assert.fail(`${hex(cp)} is in a drop class and a keep rule`);
    for (const p of prefixes) {
      const expected = kept(p, ch) ? 0 : 1;
      const { dropped } = card(p + ch);
      if (dropped !== expected) assert.fail(`${hex(cp)} after ${JSON.stringify(p)}: dropped ${dropped}, the corpus says ${expected}`);
      drops += dropped;
    }
  }
  assert.ok(drops > 1_000_000, `${drops} drops`);
  for (const d of corpus.card.drop) for (const e of d.examples) assert.equal(card(text(e)).dropped, 1, `${d.class}: ${e}`);
  for (const t of corpus.card.texts) assert.equal(card(text(t.text)).dropped, t.dropped, `${t.why}: ${t.text}`);
  for (const t of corpus.card.outOfScope.flatMap((o) => o.texts)) assert.equal(card(text(t)).dropped, 0, t);
});

test('the payload (a model): over every code point, alone and after a letter, literal keeps raw exactly what a keep rule of the corpus keeps and is not a look-alike, puts a backslash before " and \\, and writes every other code point as \\u{…}', () => {
  const keep = corpus.model.keep.map((k) => ({ re: rule(k.rule), onBase: k.onBase }));
  const lookalikes = new Set(corpus.model.lookalikes.map((l) => text(`{${l.char}}`)));
  const drop = corpus.model.drop.map((d) => rule(d.rule));
  let raw = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp);
    for (const p of ['', 'a']) {
      const stays = !lookalikes.has(ch) && !drop.some((re) => re.test(ch)) && keep.some(({ re, onBase }) => re.test(ch) && (!onBase || p !== ''));
      const expected = `"${p}${ch === '"' || ch === '\\' ? `\\${ch}` : stays ? ch : `\\u{${cp.toString(16).toUpperCase()}}`}"`;
      const out = literal(p + ch);
      if (out !== expected) assert.fail(`${hex(cp)} after ${JSON.stringify(p)}: ${out}, the corpus says ${expected}`);
      if (stays) raw++;
    }
  }
  assert.ok(raw > 280_000, `${raw} raw`);
  for (const d of corpus.model.drop) for (const e of d.examples) assert.ok(literal(text(e)).includes('\\u{'), `${d.class}: ${e}`);
  for (const t of corpus.model.texts) assert.equal(literal(text(t.text)), text(t.literal), t.text);
  for (const t of corpus.model.outOfScope.flatMap((o) => o.texts)) assert.equal(literal(text(t)), `"${text(t)}"`, t);
});

test('the look-alikes of the corpus hold every letter or number that Unicode says looks like " or \\ (its NFKC, or its confusables target in src/confusables.json)', () => {
  const { extract } = JSON.parse(readFileSync(new URL('../src/confusables.json', import.meta.url), 'utf8'));
  const letterOrNumber = /^[\p{L}\p{N}]$/u;
  const fromUnicode = new Set([
    ...Object.entries(extract).filter(([, target]) => /0027 0027|005C/.test(target)).map(([source]) => String.fromCodePoint(parseInt(source.slice(2), 16))),
    ...Array.from({ length: 0x110000 }, (_, cp) => String.fromCodePoint(cp)).filter((ch) => /["\\]/.test(ch.normalize('NFKC'))),
  ].filter((ch) => letterOrNumber.test(ch)));
  const listed = new Set(corpus.model.lookalikes.map((l) => text(`{${l.char}}`)));
  assert.deepEqual([...fromUnicode].filter((ch) => !listed.has(ch)).map((ch) => hex(ch.codePointAt(0))), []);
  assert.ok(fromUnicode.size >= 3, `${fromUnicode.size} from Unicode`);
});

test('F-T247-35: over every code point beside a look-alike of \' (U+02B9), literal writes each look-alike of \' as \\u{…} exactly when the two make a run of the corpus\'s apostrophes or the ASCII \'', () => {
  const keep = corpus.model.keep.map((k) => ({ re: rule(k.rule), onBase: k.onBase }));
  const lookalikes = new Set(corpus.model.lookalikes.map((l) => text(`{${l.char}}`)));
  const drop = corpus.model.drop.map((d) => rule(d.rule));
  const apostrophes = new Set(corpus.model.apostrophes.map((a) => text(`{${a}}`)));
  const A = 'ʹ';
  /** One code point as the corpus writes it: after a kept letter, number or mark (`onBase`) or not, and `run`: it is an apostrophe in a run. */
  const one = (ch, onBase, run) => (ch === '"' || ch === '\\' ? `\\${ch}`
    : !run && !lookalikes.has(ch) && !drop.some((re) => re.test(ch)) && keep.some(({ re, onBase: needs }) => re.test(ch) && (!needs || onBase)) ? ch
      : `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`);
  let runs = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp);
    const run = ch === "'" || apostrophes.has(ch);
    // U+02B9 first: a mark after it stays when U+02B9 stays, as on any kept letter.
    const after = `"${one(A, false, run)}${one(ch, !run, apostrophes.has(ch))}"`;
    if (literal(A + ch) !== after) assert.fail(`U+02B9 then ${hex(cp)}: ${literal(A + ch)}, the corpus says ${after}`);
    const before = `"${one(ch, false, apostrophes.has(ch))}${one(A, false, run)}"`;
    if (literal(ch + A) !== before) assert.fail(`${hex(cp)} then U+02B9: ${literal(ch + A)}, the corpus says ${before}`);
    if (run) runs++;
  }
  assert.equal(runs, corpus.model.apostrophes.length + 1);
  assert.equal(literal(`x${A}y`), `"x${A}y"`); // one alone stays raw
});

test('F-T247-35: the apostrophes of the corpus are every kept letter, number or mark whose confusables target in src/confusables.json is only \', and the two that src/clean.js maps to \' by hand', () => {
  const { extract } = JSON.parse(readFileSync(new URL('../src/confusables.json', import.meta.url), 'utf8'));
  const kept = /^[[\p{L}\p{N}\p{M}]--\p{Default_Ignorable_Code_Point}]$/v;
  const fromUnicode = Object.entries(extract).filter(([source, target]) => /^0027( 0027)*$/.test(target) && kept.test(text(`{${source}}`))).map(([source]) => source);
  assert.equal(fromUnicode.length, 21);
  assert.deepEqual([...corpus.model.apostrophes].sort(), [...fromUnicode, 'U+02BF', 'U+0559'].sort());
});
