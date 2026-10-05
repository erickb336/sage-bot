// The sixth repair of the B2 findings (F-T27-45 to F-T27-48 and the round-6 decisions on `<`, `>` and bare symbols): each test fails on the
// B2 head 33e9130 and passes now, except the last: it proves the README's claim on a batch of 5 parts (F-T27-38). SAMPLE DATA: every id, name and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { card, safe } from '../src/cards.js';
import { handle, peopleOf } from '../src/handle.js';
import { fakeInteraction } from '../src/fake-discord.js';
import { ballotsOf, openGate, step } from '../src/vote.js';

const T0 = Date.UTC(2026, 9, 4, 14, 31);
const ROLES = { driverRole: 'drv', leadRole: 'ld' };
/** One batch of one part with these members and a reason from each; returns the card's embed. */
function build(names, reasons) {
  const members = names.map((name, i) => ({ id: `${i}`.padStart(18, '0'), name, roles: ['drv', ...(i === 0 ? ['ld'] : [])] }));
  const people = peopleOf(members, ROLES);
  const ask = { kind: 'batch', task: 'T1', title: 'x', parts: [{ question: 'Q?', why: 'because', recommended: 'A', options: { A: 'a', B: 'b' } }] };
  let gate = openGate({ id: 'B', kind: 'batch', parts: [['A', 'B']], askedBy: members[0].id, at: T0 });
  members.forEach((m, k) => { gate = step(gate, { type: 'press', by: m.id, part: 0, option: 'A', at: T0 + (k + 1) * 1000, via: 'discord', ...(reasons[k] !== undefined && { reason: reasons[k] }) }, people.holders, people.leads).gate; });
  return card(gate, ask, people).embeds[0];
}

test('F-T27-46: only non-spacing marks count toward the cap of 3, so Burmese and Arabic names stay whole while a zalgo stack is still cut', () => {
  for (const whole of ['ကျော်', 'မြန်မာ ကျော်', 'အောင်ဆန်းစုကြည်', 'ခြောက်', 'اللَّٰهُ', 'مُحَمَّد', 'ก็ิ์', 'ক্ষ্মী', 'Nguyễn'.normalize('NFD')]) assert.equal(safe(whole), whole, whole);
  assert.equal(safe('بًٌٍّ'), 'بًٌٍ'); // 4 non-spacing marks on one letter: 3 stay
  assert.equal(safe(`a${'\u0301\u0302\u0303\u0304\u0305'.repeat(100)}`), 'a\u0301\u0302\u0303');
  assert.equal(safe(`a${'\u0301\u200d'.repeat(249)}`), 'a\u0301\u0301\u0301'); // a joiner does not reset the count
  assert.equal(safe(`क${'ा'.repeat(5)}`), `क${'ा'.repeat(4)}`); // a spacing mark does not count toward the 3, but has its own cap of 4 (F-T27-50)
  assert.equal(safe(`a${'\u20e3'.repeat(4)}`), `a${'\u20e3'.repeat(4)}`); // an enclosing mark does not count
  assert.equal(safe('\u0301\u093e\u20e3'), ''); // a mark on nothing still goes
  // On the card: the Burmese name is whole in the voter list and the reason field.
  const embed = build(['မြန်မာ ကျော်', 'Jon'], ['ကျော် agrees']);
  assert.match(embed.fields[0].value, /\nVoted: မြန်မာ ကျော်, Jon · Not voted: nobody\n/);
  assert.deepEqual(embed.fields[1], { name: 'မြန်မာ ကျော်, part 1', value: 'ကျော် agrees' });
});

test('round 6: `<` and `>` stay as escaped text, so comparisons keep their meaning and nothing renders as a mention, timestamp, emoji code or quote', () => {
  assert.equal(safe('A > B'), 'A \\> B');
  assert.equal(safe('A < B'), 'A \\< B');
  assert.equal(safe('x <= y and a -> b'), 'x \\<= y and a -\\> b');
  assert.equal(safe('cost < 5 €'), 'cost \\< 5 €');
  assert.equal(safe('use <b>bold</b>'), 'use \\<b\\>bold\\</b\\>');
  assert.equal(safe('<@123> <@!1> <@&9> <#4> <t:0:R> <:x:1> <a:x:1> </cmd:1>'), '\\<@123\\> \\<@!1\\> \\<@&9\\> \\<#4\\> \\<t:0:R\\> \\<:x:1\\> \\<a:x:1\\> \\</cmd:1\\>');
  assert.equal(safe('> quote'), '\\> quote');
  assert.equal(safe('>>> block'), '\\>\\>\\> block');
  assert.equal(safe('<https://evil.example>'), '\\<https:// evil.example\\>');
  assert.equal(safe('`code` and ```block```'), 'code and block'); // the backtick still goes
  assert.equal(safe('\\<'), '\\\\\\<'); // an input backslash is escaped first, so the `<` keeps its own escape
  const embed = build(['Maya', 'Jon'], ['2 > 1 and a < b']);
  assert.equal(embed.fields[1].value, '2 \\> 1 and a \\< b');
});

test('round 6: a bare pictograph symbol stays; a variation selector after it stays only when the pair is an RGI emoji', () => {
  for (const kept of ['™', '©', '®', '✔', '♥', '⚠', '↔', '☺', '✈', '☎', '✉', '❤', '‼', '☑', '© 2026 Acme ® ™ ★ ☆ ♥ ♠ ✓ ✔ ✗ ⚠ ☐ ☑ •']) assert.equal(safe(kept), kept, kept);
  assert.equal(safe('©\ufe0f ©'), '©\ufe0f ©');
  assert.equal(safe('✔\ufe0e ✔\ufe0f\ufe0f'), '✔ ✔\ufe0f');
  assert.equal(safe('™\u{E0100} ©\ufe00'), '™ ©');
  assert.equal(safe('\u2800 \u2800'), ''); // the blank Braille cell still goes
  assert.doesNotMatch(safe('♥'.repeat(500)), /\p{Variation_Selector}/v);
  assert.equal(build(['Maya', 'Jon'], ['✔ ship it ™']).fields[1].value, '✔ ship it ™');
});

test('F-T27-48: a joiner also sits between a letter and a mark of a joining script and after a final virama, still one at most', () => {
  for (const whole of ['র\u200d্য', 'বাংলা ভাষা ক্ষমা র\u200d্য ধন্যবাদ কৃষ্ণ', 'ണ്\u200d', 'മലയാളം ഭാഷ, നന്ദി, ക്ഷ, ന്\u200dറ, ണ്\u200d', 'ශ්\u200dරී', 'क्\u200dष']) assert.equal(safe(whole), whole, whole);
  assert.equal(safe('ണ്\u200d\u200d\u200c x'), 'ണ്\u200d x'); // one joiner at most
  assert.equal(safe('র\u200d\u200d্য'), 'র\u200d্য');
  assert.equal(safe('a\u200cb\u200dc'), 'abc'); // Latin letters still do not join
  assert.equal(safe('ب\u200d'), 'ب'); // after a letter with no letter or mark next: the joiner still goes
  assert.equal(safe('😀\u200d😀'), '😀😀');
  assert.equal(safe(`ب${'\u064e\u200d'.repeat(50)}`), 'ب\u064e\u200d\u064e\u200d\u064e\u200d'); // marks still cap at 3; each kept joiner follows a mark
  const embed = build(['র\u200d্য Roy', 'Jon'], ['ണ്\u200d ok']);
  assert.match(embed.fields[0].value, /\nVoted: র\u200d্য Roy, Jon · Not voted: nobody\n/);
  assert.deepEqual(embed.fields[1], { name: 'র\u200d্য Roy, part 1', value: 'ണ്\u200d ok' });
});

test('F-T27-45: a leading -# is escaped; a first grapheme longer than the cut is cut by code point, never through a surrogate pair', () => {
  assert.equal(safe('-# small grey text'), '\\-# small grey text');
  assert.equal(safe('  -# small'), '\\-# small');
  assert.equal(safe('-#x'), '\\-#x');
  assert.equal(safe('a -# b'), 'a -# b'); // only at the start of the line
  assert.equal(safe('- # heading in list'), '\\- \\# heading in list');
  assert.equal(build(['Maya', 'Jon'], ['-# tiny']).fields[1].value, '\\-# tiny');
  // One grapheme of 450 code units (a chain of conjuncts): the card shows its start, cut to 200, not "…" alone.
  const chain = 'क्\u200d'.repeat(150);
  const shown = build(['Maya', 'Jon'], [chain]).fields[1].value;
  assert.equal(shown.length, 200);
  assert.ok(shown.startsWith('क्\u200dक्') && shown.endsWith('…'), shown);
  // One grapheme with astral code points (a conjunct chain with a musical mark U+1D167 on each letter, a high surrogate at index 198):
  // the cut never leaves a lone surrogate. (A Kaithi letter with 150 spacing signs keeps only 4 since F-T27-50.)
  const astral = `क${'्\u{1D167}क'.repeat(80)}`;
  const cutAstral = build(['Maya', 'Jon'], [astral]).fields[1].value;
  assert.ok(cutAstral.isWellFormed() && cutAstral.length <= 200 && cutAstral.length >= 199, `${cutAstral.length}`);
  assert.ok(cutAstral.startsWith('क्\u{1D167}क') && cutAstral.endsWith('…'));
});

test('F-T27-45: the joiner check is linear: 4 times the text costs about 4 times the CPU time, not 16 or more', () => {
  // CPU time of this process, not the wall clock, so that other processes on a busy machine do not count; the least of 5 runs at each size
  // and a ratio, so that a slow machine does not count either. Linear gives about 4; the joiner check of 33e9130, which read the growing output, gives over 30.
  const KB = 65_536;
  for (const unit of ['क्\u200d', 'ب\u200d']) {
    const text = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    const [small, large] = [text(KB), text(4 * KB)];
    const best = [Infinity, Infinity];
    for (let run = 0; run < 5; run++) {
      [small, large].forEach((s, k) => {
        const t = process.cpuUsage();
        const out = safe(s);
        const { user, system } = process.cpuUsage(t);
        best[k] = Math.min(best[k], (user + system) / 1000);
        assert.equal(out.length, s.length - (unit === 'ب\u200d' ? 1 : 0)); // a final joiner after a bare letter goes
      });
    }
    const ratio = best[1] / best[0];
    assert.ok(ratio < 8, `${JSON.stringify(unit)}: ${best.map((ms) => ms.toFixed(1)).join(' ms, ')} ms, ratio ${ratio.toFixed(1)}`);
  }
});

test('F-T27-47, F-T27-38: the README states the `<` and `>` escape, the kept symbols, the mark rule and no fixed count of shown reasons; the premise stays', () => {
  const readme = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
  for (const line of ['a person reads on the card, and nothing else reads it', 'every `[`, `]`, `<` and `>` (no masked link, mention, timestamp, emoji code or quote',
    'a bare pictograph such as ™, ©, ✔ or ⚠', 'they do not count toward the 3, so Burmese ကျော် stays whole', 'a leading `-#` (no subtext)',
    'how many depends on the names and on the ask\'s texts', 'or when the joiner follows a mark such as a final virama']) {
    assert.ok(readme.includes(line), line);
  }
  for (const gone of ['19 newest of the 20', 'a symbol that is not a pictograph', 'Everything else goes: `<`, `>`']) assert.ok(!readme.includes(gone), gone);
});

test('F-T27-38: on a batch of 5 parts (over Discord\'s 5 rows), a press stores the ballot and shows the form; only the reason submit rejects', async () => {
  const people = peopleOf([{ id: 'h0', name: 'Maya', roles: ['drv', 'ld'] }, { id: 'h1', name: 'Jon', roles: ['drv'] }], ROLES);
  const parts = Array.from({ length: 5 }, () => ['A', 'B']);
  const ask = { kind: 'batch', task: 'T1', title: 'x', parts: parts.map(() => ({ question: 'Q?', why: 'w', recommended: 'A', options: { A: 'a', B: 'b' } })) };
  const gates = new Map([['B5', { gate: openGate({ id: 'B5', kind: 'batch', parts, askedBy: 'h0', at: T0 }), ask }]]);
  const ctx = { gates, people, clock: () => T0 + 1000 };
  const press = fakeInteraction({ user: 'h1', customId: 'press:B5:0:1' });
  const out = await handle(press, ctx);
  assert.equal(out.stored, true);
  assert.equal(ballotsOf(gates.get('B5').gate.parts[0]).get('h1').option, 'B');
  assert.deepEqual(press.replies.map((r) => r.kind), ['modal']);
  const before = gates.get('B5').gate;
  const submit = fakeInteraction({ user: 'h1', customId: 'reason:B5:0:1', fields: { reason: 'why not' } });
  await assert.rejects(handle(submit, ctx), RangeError);
  assert.equal(gates.get('B5').gate, before);
  assert.deepEqual(submit.replies, []);
});
