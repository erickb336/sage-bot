// The seventh repair of the B2 findings (F-T27-49, F-T27-50, owner gate G8): each test fails on the B2 head f8b167c and passes now.
// SAMPLE DATA: every id, name and reason here is a made-up sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { card, safe } from '../src/cards.js';
import { peopleOf } from '../src/handle.js';
import { openGate, step } from '../src/vote.js';

const T0 = Date.UTC(2026, 9, 4, 14, 31);
const ROLES = { driverRole: 'drv', leadRole: 'ld' };
const STEM = '\u{1D165}'; // MUSICAL SYMBOL COMBINING STEM, a spacing mark (Mc)
/** One batch of one part with these members and a reason from each; returns the card's embed. */
function build(names, reasons) {
  const members = names.map((name, i) => ({ id: `${i}`.padStart(18, '0'), name, roles: ['drv', ...(i === 0 ? ['ld'] : [])] }));
  const people = peopleOf(members, ROLES);
  const ask = { kind: 'batch', task: 'T1', title: 'x', parts: [{ question: 'Q?', why: 'because', recommended: 'A', options: { A: 'a', B: 'b' } }] };
  let gate = openGate({ id: 'B', kind: 'batch', parts: [['A', 'B']], askedBy: members[0].id, at: T0 });
  members.forEach((m, k) => { gate = step(gate, { type: 'press', by: m.id, part: 0, option: 'A', at: T0 + (k + 1) * 1000, via: 'discord', ...(reasons[k] !== undefined && { reason: reasons[k] }) }, people.holders, people.leads).gate; });
  return card(gate, ask, people).embeds[0];
}

test('F-T27-50: at most 4 spacing or enclosing marks on one letter, beside the 3 non-spacing marks; Burmese, Arabic, Hebrew, Bengali and Malayalam names stay whole', () => {
  // A display name of 31 characters (in Discord's 32): 14 stems that draw tall bars across the card. 4 stay.
  assert.equal(safe(`Mal${STEM.repeat(14)}`), `Mal${STEM.repeat(4)}`);
  for (const ring of ['҉', '⃝', '༿']) assert.equal(safe(`a${ring.repeat(50)} b`), `a${ring.repeat(4)} b`, ring);
  // The two caps count apart, and each letter starts both again.
  assert.equal(safe(`a${`́${STEM}`.repeat(10)}`), `á${STEM}́${STEM}́${STEM}${STEM}`);
  assert.equal(safe(`a${STEM.repeat(9)}b${STEM.repeat(9)}`), `a${STEM.repeat(4)}b${STEM.repeat(4)}`);
  for (const whole of ['ကျော်', 'ကျော်ဇင်', 'مُحَمَّد', 'שָׁלוֹם', 'র‍্য', 'ണ്‍']) assert.equal(safe(whole), whole, whole);
  // On the card: the voter list and the reason field show 4 stems; a reason that is one long grapheme of stems is capped, not cut at 200.
  const embed = build(['Maya', `Mal${STEM.repeat(14)}`], [undefined, `a${STEM.repeat(300)}`]);
  assert.match(embed.fields[0].value, new RegExp(`\\nVoted: Maya, Mal${STEM}{4} · Not voted: nobody\\n`, 'v'));
  assert.deepEqual(embed.fields[1], { name: `Mal${STEM.repeat(4)}, part 1`, value: `a${STEM.repeat(4)}` });
});

test('F-T27-49: the null notehead U+1D159 looks blank, so it goes; a name of only it falls back to "member …digits"', () => {
  assert.equal(safe('\u{1D159}'), '');
  assert.equal(safe('a\u{1D159}b \u{1D158}'), 'ab \u{1D158}'); // the visible notehead next to it stays
  const embed = build(['Maya', '\u{1D159}\u{1D159}\u{1D159}'], [undefined, '\u{1D159}']);
  assert.match(embed.fields[0].value, /\nVoted: Maya, member …0001 · Not voted: nobody\n/);
  assert.equal(embed.fields.length, 1); // a reason of only the blank symbol gets no field
});

test('F-T27-49, F-T27-50: the README states both mark caps and the six characters that look blank', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const line of ['at most 3 combining marks on a letter that pile on it (the non-spacing marks, Unicode `Mn`) and at most 4 spacing or enclosing marks (Unicode `Mc` and `Me`',
    'the six characters that look blank (the four Hangul fillers, the blank Braille cell U+2800 and the musical null notehead U+1D159)']) {
    assert.ok(readme.includes(line), line);
  }
  assert.ok(!readme.includes('the five characters that look blank'));
});
