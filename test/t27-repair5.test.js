// The fifth repair of the B2 findings (F-T27-35 to F-T27-42): each test fails on the B2 head 5d39b82 and passes now.
// SAMPLE DATA: every id, name and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { card, confirmEnd, safe } from '../src/cards.js';
import { handle, peopleOf } from '../src/handle.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { openGate, step, MINUTE } from '../src/vote.js';
import { ASKS, MAYA, clock, openAsk } from '../examples/sample.js';

const T0 = clock(14, 31);
const ROLES = { driverRole: 'drv', leadRole: 'ld' };
const apply = (gate, people, ...events) => events.reduce((g, e) => step(g, e, people.holders, people.leads).gate, gate);
const tag = (s) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
const flag = (code) => `\u{1F3F4}${tag(code)}\u{E007F}`;
const unescaped = (s) => s.replaceAll('\\', '');
/** The three good cases and real names in seven scripts: `safe` returns each one unchanged. */
const WHOLE = ['👨\u200d👩\u200d👧', 'می\u200cخواهم', flag('gbsct'),
  'José Müller-Łukasz', 'محمد عبدالله', 'हिन्दी क्\u200dष सिंह', 'ภาษาไทย ที่', '김민준 한국어', '山田太郎 ひらがな が゙', '张伟 中文'];
/** One batch of one part with these members (32-character names at most) and a reason from each; returns the card's embed. */
function build(names, reasons, { parts = 1 } = {}) {
  const members = names.map((name, i) => ({ id: `${i}`.padStart(18, '0'), name, roles: ['drv', ...(i === 0 ? ['ld'] : [])] }));
  const people = peopleOf(members, ROLES);
  const part = { question: 'Q?', why: 'because', recommended: 'A', options: { A: 'a', B: 'b' } };
  const ask = { kind: 'batch', task: 'T1', title: 'x', parts: Array.from({ length: parts }, () => part) };
  let gate = openGate({ id: 'B', kind: 'batch', parts: Array.from({ length: parts }, () => ['A', 'B']), askedBy: members[0].id, at: T0 });
  members.forEach((m, k) => { for (let p = 0; p < parts; p++) gate = apply(gate, people, { type: 'press', by: m.id, part: p, option: 'A', at: T0 + (k * parts + p + 1) * 1000, via: 'discord', ...(reasons[k] !== undefined && { reason: reasons[k] }) }); });
  return { gate, ask, people, embed: card(gate, ask, people).embeds[0] };
}

test('F-T27-39: no URL with a scheme stays clickable: every "://" is broken to ":// "; www. and a bare domain are text already', () => {
  assert.equal(safe('see https://evil.example/claim-prize now'), 'see https:// evil.example/claim-prize now');
  assert.equal(safe('<https://evil.example>'), '\\<https:// evil.example\\>');
  assert.equal(safe('[click](https://evil.example)'), '\\[click\\](https:// evil.example)');
  assert.equal(safe('http://a http://b steam://run/1'), 'http:// a http:// b steam:// run/1');
  assert.equal(safe('https://'), 'https://'); // no host: nothing to break
  assert.equal(safe('www.evil.example evil.example/x'), 'www.evil.example evil.example/x');
  for (const url of ['https://evil.example', 'HTTPS://EVIL.EXAMPLE/x', 'ftp://x.y', 'a https://b.c d', 'https://x.example\u200b/y', 'https:/\u200b/x.example'])
    assert.doesNotMatch(safe(url), /\w:\/\/\S/, url);
  const { embed } = build(['Maya', 'Jon'], ['read https://evil.example/claim-prize first']);
  assert.equal(embed.fields[1].value, 'read https:// evil.example/claim-prize first');
});

test('F-T27-40: a joiner stays only between letters of a joining script, one at a time, so marks cannot stack past 3 and marks alone are visibly empty', () => {
  assert.equal(safe(`a${'\u0301\u200d'.repeat(249)}`), 'a\u0301\u0301\u0301'); // 249 marks and 248 joiners on 5d39b82
  assert.equal(safe(`a${'\u0301\u200c\u0302\u200d'.repeat(100)}`), 'a\u0301\u0302\u0301');
  assert.equal(safe('\u0301\u200d\u0301'), ''); // not visibly empty on 5d39b82
  assert.equal(safe('\u0301\u200c\u0301\u200c\u0301'), '');
  assert.equal(safe('a\u200cb\u200dc'), 'abc'); // Latin letters do not join
  assert.equal(safe('😀\u200d😀'), '😀😀'); // not an RGI sequence: the joiner goes
  assert.equal(safe('ی\u200c\u200c\u200dخ'), 'ی\u200dخ'); // one joiner at most between two letters
  assert.equal(safe('ی\u200c \u200cخ'), 'ی خ');
  for (const kept of WHOLE) assert.equal(safe(kept), kept, kept);
  // On the card: a name of marks and joiners falls back; a reason of them gives no field; a mark stack in a reason is cut to 3.
  const { embed } = build(['\u0301\u200d\u0301', 'Jon', 'Ana'], ['ok', '\u0301\u200d\u0301', `a${'\u0301\u200d'.repeat(99)}`]);
  assert.deepEqual(embed.fields.slice(1), [{ name: 'member …0000, part 1', value: 'ok' }, { name: 'Ana, part 1', value: 'a\u0301\u0301\u0301' }]);
  assert.match(embed.fields[0].value, /\nVoted: member …0000, Jon, Ana · Not voted: nobody\n/);
});

test('F-T27-41: an ideographic variation selector goes, also after a Han ideograph, so no selector carries a byte', () => {
  const msg = 'pick B now';
  const ivs = [...msg].map((c) => `一${String.fromCodePoint(0xE0100 + c.charCodeAt(0))}`).join('');
  assert.equal(safe(ivs), '一'.repeat(msg.length));
  assert.equal(safe('葛\u{E0101} 々\u{E0100} 中\u{E0100}\u{E0101}'), '葛 々 中');
  assert.equal(safe('a\u{E0100}\u{E0101}\u{E01EF}b'), 'ab');
  assert.equal(safe('\u{E0100}'.repeat(10)), '');
});

test('F-T27-42: a selector stays only inside an RGI emoji; a leading ">" cannot quote; a heading or list escape sees the start of the text', () => {
  assert.equal(safe('1\ufe0f2\ufe0e34\ufe0e'), '1234'); // 3 states per digit on 5d39b82
  assert.equal(safe('#\ufe0f*\ufe0f'), '#\\*');
  assert.equal(safe('1\ufe0f\u20e3 #\ufe0f\u20e3 *\ufe0f\u20e3'), '1\ufe0f\u20e3 #\ufe0f\u20e3 \\*\ufe0f\u20e3'); // the keycaps are RGI
  assert.equal(safe('😀\ufe0e😀'), '😀😀');
  assert.equal(safe('©\ufe0f ❤\ufe0f ©'), '©\ufe0f ❤\ufe0f ©'); // a bare pictograph stays since round 6; its selector stays only in the RGI pair
  assert.equal(safe('> hidden quote'), '\\> hidden quote'); // escaped since round 6, so the text keeps its `>`
  assert.equal(safe('>>> all of it'), '\\>\\>\\> all of it');
  assert.equal(safe('   # heading'), '\\# heading'); // on 5d39b82 the fold came after the escape, so 3 spaces hid the heading
  assert.equal(safe('\n- list'), '\\- list');
  assert.equal(safe('<@123> <#4> <t:0:R> <:x:1> `code`'), '\\<@123\\> \\<#4\\> \\<t:0:R\\> \\<:x:1\\> code'); // nothing that Discord renders as markup
});

test('F-T27-39 to F-T27-42, F-T27-46: the sweep over all of Unicode: safe keeps exactly the allow-list, alone and between letters, caps the stacked marks and never empties a visible text', () => {
  // The rules as the README states them, written here again so that the code cannot drift from them.
  const EMOJI = /^\p{RGI_Emoji}$/v;
  const LETTER = /^[\p{L}--[\u115F\u1160\u3164\uFFA0]]$/v;
  const BASE = /^[[\p{N}\p{P}\p{S}]--[\x60\u2800\u{1D159}]]$/v;
  const MARK = /^[\p{M}--\p{Variation_Selector}]$/v;
  const STACKING = /^\p{Mn}$/u;
  const SPACE = /^\p{White_Space}$/u;
  // Every character of an output is an RGI emoji, a letter, a number, punctuation, a mark, a joiner, a space or a symbol (not a backtick, the blank
  // Braille cell or the null notehead): so no format character (no tag outside a flag), no variation selector outside an RGI emoji, no control or unassigned code point.
  const ALLOWED = /^(?:\p{RGI_Emoji}|[[\p{L}--[\u115F\u1160\u3164\uFFA0]][\p{N}\p{P}\u200c\u200d ][\p{M}--\p{Variation_Selector}][\p{S}--[\x60\u2800\u{1D159}]]])*$/v;
  // With the escape pairs gone (`\<`, `\[`, `\\`), no `<`, `>` or backtick is left: none can render as a mention, a timestamp, a quote or code.
  const plain = (s) => s.replace(/\\[\s\S]/g, '');
  const counts = { visible: 0, mark: 0, space: 0, hidden: 0 };
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp);
    const hex = `U+${cp.toString(16).toUpperCase()}`;
    const alone = safe(ch);
    const between = safe(`a${ch}b`);
    assert.match(alone, ALLOWED, `${hex} alone`);
    assert.match(between, ALLOWED, `${hex} between letters`);
    assert.doesNotMatch(plain(between), /[<>\x60]/, `${hex} unescaped`);
    assert.doesNotMatch(safe(`a://${ch}b`), /\w:\/\/\S/, `${hex} in a URL`);
    if (EMOJI.test(ch) || LETTER.test(ch) || BASE.test(ch)) {
      counts.visible++;
      assert.equal(unescaped(alone), unescaped(ch), `${hex} alone`);
      assert.equal(unescaped(between), unescaped(`a${ch}b`), `${hex} between letters`);
    } else if (MARK.test(ch)) {
      counts.mark++;
      assert.equal(alone, '', `${hex} alone`);
      assert.equal(between, `a${ch}b`, `${hex} between letters`);
      // On one letter at most 3 non-spacing marks stay (F-T27-46) and at most 4 spacing or enclosing marks (F-T27-50).
      assert.equal(safe(`a${ch.repeat(5)}`), `a${ch.repeat(STACKING.test(ch) ? 3 : 4)}`, `${hex} stacked`);
    } else if (SPACE.test(ch)) {
      counts.space++;
      assert.equal(alone, '', `${hex} alone`);
      assert.equal(between, 'a b', `${hex} between letters`);
    } else {
      counts.hidden++;
      assert.equal(alone, '', `${hex} alone`);
      assert.equal(between, 'ab', `${hex} between letters`);
    }
  }
  assert.ok(counts.visible > 140_000 && counts.mark > 2_000 && counts.space === 25 && counts.hidden > 900_000, JSON.stringify(counts));
  for (const kept of WHOLE) assert.equal(safe(kept), kept, kept);
  assert.equal(safe(`${WHOLE.join(' ')} **bold**`), `${WHOLE.join(' ')} \\*\\*bold\\*\\*`);
});

test('F-T27-35: when the budget drops reasons, the description says how many more the chief has; with every reason shown it says nothing', async () => {
  const words = 'The reason text of one holder on one part, 500 characters long, as the form allows at most. ';
  const names = ['Erick', 'Maya', 'Jon', 'Ana', 'Lea'].map((n) => n.padEnd(32, '!'));
  const reasons = names.map((n) => `${n.trim()}: ${words.repeat(6)}`.slice(0, 500));
  const { gate, ask, people, embed } = build(names, reasons, { parts: 4 });
  const shown = embed.fields.length - 4; // every holder gave a reason on every part: 20 in all
  assert.ok(shown >= 1 && shown < 20, `${shown} reasons shown`);
  assert.match(embed.description, new RegExp(`\\n${20 - shown} more reasons; the chief has them all$`));
  const few = build(['Maya', 'Jon'], ['short', 'also short']).embed;
  assert.equal(few.fields.length, 3);
  assert.doesNotMatch(few.description, /more reason/);
  // Through handle: the card that answers a reason form carries the line too.
  const i = fakeInteraction({ user: people.holders.values().next().value, customId: 'reason:B:0:0', fields: { reason: 'x'.repeat(500) } });
  const out = await handle(i, { gates: new Map([['B', { gate, ask }]]), people, clock: () => T0 + MINUTE });
  assert.equal(out.stored, true);
  assert.match(i.replies[0].embeds[0].description, /\n\d+ more reasons; the chief has them all$/);
});

test('F-T27-36: a tag sequence that is not one of the three flags leaves the black flag; the lead\'s confirm stays in 2000 characters for any team', () => {
  assert.equal(safe(flag('gbxyz')), '🏴');
  assert.equal(safe(`${flag('gbsct')}${flag('gbxyz')}${flag('gbwls')}`), `${flag('gbsct')}🏴${flag('gbwls')}`);
  // A team of 5: every name whole. A team of 300 with 32-character names: each list ends in "and N more", and the confirm fits.
  const five = build(['Erick', 'Maya', 'Jon', 'Ana', 'Lea'], [], { parts: 4 });
  assert.match(confirmEnd(five.gate, five.people).content, /^\*\*End B now\?\*\*\n(Part [1-4] goes to A: 5 of 5 votes \(Erick, Maya, Jon, Ana, Lea\)\.\n){4}Nobody can vote after this\.$/);
  const big = build(Array.from({ length: 300 }, (_, i) => `Member number ${i}`.padEnd(32, '!')), [], { parts: 4 });
  const { content } = confirmEnd(big.gate, big.people);
  assert.ok(content.length <= 2000 && content.length > 1800, `${content.length}`); // 60,000 characters on 5d39b82
  assert.equal((content.match(/ and \d+ more\)\./g) ?? []).length, 4);
  assert.match(content, /Part 1 goes to A: 300 of 300 votes \(Member number 0!{17}, Member number 1!{17}, /);
});

test('F-T27-37: handle returns stored: true only when the event changed the gate, also beside replyError', async () => {
  const people = peopleOf([{ id: MAYA, name: 'Maya', roles: ['drv', 'ld'] }, { id: 'sample-sam', name: 'Sam', roles: [] }], ROLES);
  const gate = openAsk('B9', T0);
  const gates = new Map([['B9', { gate, ask: ASKS.B9 }]]);
  const ctx = { gates, people, clock: () => T0 + MINUTE };
  const run = async (opts) => { const i = fakeInteraction(opts); const out = await handle(i, ctx); return { out, reply: i.replies[0] }; };
  // Nothing stored: an unknown card, a forged index, a non-holder, the end confirm, a cancel.
  for (const opts of [{ user: MAYA, customId: 'press:nope:0:0' }, { user: MAYA, customId: 'press:B9:0:7' }, { user: 'sample-sam', customId: 'press:B9:0:0' },
    { user: MAYA, customId: 'end:B9' }, { user: MAYA, customId: 'cancel:B9', ephemeral: true }]) {
    const { out } = await run(opts);
    assert.equal(out.stored, false, opts.customId);
    assert.equal(gates.get('B9').gate, gate, opts.customId);
  }
  // A press that counts: effects [] and stored true, so B3 can tell it from "nothing changed".
  const press = await run({ user: MAYA, customId: 'press:B9:0:0' });
  assert.deepEqual(press.out, { gate: gates.get('B9').gate, effects: [], stored: true });
  assert.notEqual(press.out.gate, gate);
  // Beside replyError: a stored ballot says stored: true; an unknown card says stored: false.
  const refused = Object.assign(new Error('Unknown interaction'), { code: 10062 });
  const before = gates.get('B9').gate;
  const lost = await run({ user: MAYA, customId: 'reason:B9:0:1', fields: { reason: 'because' }, refuse: refused });
  assert.deepEqual(lost.out, { gate: gates.get('B9').gate, effects: [], stored: true, replyError: refused });
  assert.notEqual(lost.out.gate, before);
  const unknown = await run({ user: MAYA, customId: 'press:nope:0:0', refuse: refused });
  assert.deepEqual(unknown.out, { gate: null, effects: [], stored: false, replyError: refused });
  // The time limit passes inside an ignored press: the gate changed, so stored is true beside the 'ignored' effect.
  ctx.clock = () => gate.endsAt + MINUTE;
  const late = await run({ user: MAYA, customId: 'press:B9:1:0' });
  assert.deepEqual(late.out.effects.map((e) => e.type), ['vote-ended', 'decided', 'ignored']);
  assert.equal(late.out.stored, true);
});

test('F-T27-35 to F-T27-42: the README states the allow-list, the dropped-reasons line, stored, the URL break and the fallback name, and no claim about models', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const line of ['nothing else reads it', '`safe` keeps only what a person needs', 'at most 3 combining marks on a letter', 'Arabic, Syriac, the Indic scripts, Myanmar or Khmer',
    'breaks every `://` to `:// `', 'the oldest reasons go first', 'more reasons; the chief has them all', '`{ gate, effects, stored }`', 'With `stored: false` nothing changed',
    'an id of 4 or more digits', 'still stores the ballot and shows the reason form', 'B3 refuses an ask with more than 4 parts']) {
    assert.ok(readme.includes(line), line);
  }
  for (const gone of ['model could decode', 'newest first to go', 'B3 cleans the text for the chief again', 'every format character (Unicode `Cf`', 'for an id without digits'])
    assert.ok(!readme.includes(gone), gone);
});
