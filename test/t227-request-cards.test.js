// T72 PR 2: the Discord messages of /sage request (src/requestCards.js) and the marks of the confirm (sageMarks in src/clean.js).
// Pure functions: no Discord, no network, no file. SAMPLE DATA ONLY: every id, name and project is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedLength } from 'discord.js';
import { forModel, sageMarks } from '../src/clean.js';
import { newRequest, step } from '../src/requests.js';
import {
  confirmMessage, decidedPost, declineModal, expired, marked, parseRequestId, requestCard, requestId, requestLine, requestModal,
  requestNote, REQUEST_NOTES, requestThreadName, withdrawConfirm,
} from '../src/requestCards.js';

const OWNER_ID = '100000000000000001';
const JON = '100000000000000002';
const T0 = Date.UTC(2026, 9, 12, 14, 20);
const AT = T0 + 12 * 60_000;
const FIELDS = { project: 'reports-app', folder: '/sample/reports-app', title: 'Add CSV export to the reports page',
  text: 'Users need the monthly report as a CSV file (for Excel). Finance copies it by hand today.', designQuestions: 'team', requester: JON, requesterName: 'Jon' };
const CLAIM = { by: 'owner', via: 'discord', pid: 42, start: 'Mon Oct 12 14:00:00 2026', at: T0 + 60_000 };
/** A request in each status, as src/requests.js makes it. */
function states(fields = FIELDS, reason = 'We plan the export for the January release.') {
  const base = newRequest({ next: 3, requests: [] }, fields, T0).request;
  const approving = step(base, { type: 'claim', claim: CLAIM });
  return {
    pending: base,
    approving,
    approved: step(approving, { type: 'approve', claim: CLAIM, task: 'T74', at: AT }),
    declined: step(base, { type: 'decline', by: OWNER_ID, via: 'discord', at: AT, reason }),
    withdrawn: step(base, { type: 'withdraw', by: JON, at: AT }),
  };
}
const R = states();
const t = (ms) => `<t:${ms / 1000}:t>`;

/** Every code point, as a string; a surrogate code point is a lone surrogate. */
const ALL = Array.from({ length: 0x110000 }, (_, cp) => (cp >= 0xd800 && cp <= 0xdfff ? String.fromCharCode(cp) : String.fromCodePoint(cp)));
/** The property of sageMarks for one text: the parts are the text, their `sage` is forModel's text, and a part that is not kept reads at most a space. */
function agrees(text) {
  const { parts } = sageMarks(text);
  if (parts.map((p) => p.text).join('') !== String(text).toWellFormed()) return 'the parts are not the text';
  if (parts.map((p) => p.sage).join('') !== forModel(text)) return 'the parts do not read as forModel';
  if (parts.some((p) => p.kind !== 'kept' && !['', ' '].includes(p.sage))) return 'a part that is not kept reads more than a space';
  if (parts.some((p) => p.kind === 'hidden' && /[\p{L}\p{N}\p{P}\p{S}]/u.test(p.text.replace(/\p{Default_Ignorable_Code_Point}/gu, '')))) return 'a hidden part has a visible character';
  return null;
}

test('standing order 12: the sweep over every Unicode code point: the marks of sageMarks read exactly as forModel', () => {
  // In context too: after a letter, four in a row (marks past the third), after a control, and after a Hangul syllable and a
  // leading jamo, where NFKC of a compatibility jamo joins the cluster before it (가 + ㄳ is 갃).
  for (const make of [(c) => c, (c) => `a${c}b`, (c) => `a${c}${c}${c}${c}b`, (c) => `\n${c}\u0301 e`, (c) => `\uAC00${c}\u1100${c}`]) {
    const bad = ALL.find((c) => agrees(make(c)));
    assert.equal(bad, undefined, `U+${bad?.codePointAt(0).toString(16)}: ${bad && agrees(make(bad))}`);
  }
});

test('the marks agree with forModel on random mixes of the hard cases: marks, jamo, controls, emoji, look-alikes, NFKC growth and the 500 cut', () => {
  const pool = ['a', 'é', 'e', '\u0301', '\u0316', '\u0345', ' ', '  ', '\n', '\r\n', '\t', '\u00A0', '\u200B', '\u200C', '\u200D', '\u202E', '\u{E0041}', '\uFE0F',
    '\u1100', '\u1161', '\u11A8', '\uAC00', '\u0B47', '\u0B3E', '\u0915', '\u094D', '\u0937', 'ﷺ', 'ﬁ', '①', '½', '\u02BC', '\u05F2', '"', "'", '(', '*', '-', '.', ':',
    '7', '٣', '😀', '👨‍👩‍👧', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '\uD800', '\uDC00', '\u0000', '\x1b', '\u2028', 'ㄱ', '\u3099', 'か', '\u3133', '\u314F', '\uFFA3', '\u0F73', '\u0F71', '\u0F72'];
  let seed = 227;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  for (let i = 0; i < 20_000; i++) {
    const n = i % 50 === 0 ? 400 + (next() % 300) : next() % 40;
    const text = Array.from({ length: n }, () => pool[next() % pool.length]).join('');
    assert.equal(agrees(text), null, JSON.stringify(text));
  }
});

test('the marks: kept, dropped and hidden parts, and the count of hidden characters', () => {
  const kinds = (text) => sageMarks(text).parts.map((p) => `${p.kind[0]}:${p.text}`).join('|');
  assert.equal(kinds("it's (ok)"), "k:i|k:t|d:'|k:s|k: |d:(|k:o|k:k|d:)");
  assert.equal(kinds('a\u200Bb'), 'k:a|h:\u200B|k:b');
  assert.deepEqual(sageMarks('a\u200Bb\u202Ec\u{E0041}').hidden, 3);
  // An emoji's joiners and its tag characters are part of what a person sees: no hidden character.
  assert.deepEqual([sageMarks('👨‍👩‍👧 🏴󠁧󠁢󠁥󠁮󠁧󠁿 ok').hidden, kinds('👨‍👩‍👧 ok')], [0, 'd:👨‍👩‍👧|k: |k:o|k:k']);
  // A ligature reads as its letters; past 500 characters nothing is read.
  assert.deepEqual(sageMarks('ﬁx').parts.map((p) => p.sage), ['fi', 'x']);
  // NFKC joins two clusters here: the syllable and the jamo after it are one part, which sage reads as one syllable.
  assert.deepEqual(sageMarks('가ㄳ a').parts, [{ text: '가ㄳ', kind: 'kept', sage: '갃' }, { text: ' ', kind: 'kept', sage: ' ' }, { text: 'a', kind: 'kept', sage: 'a' }]);
  assert.deepEqual(sageMarks(`${'a'.repeat(500)}b`).parts.at(-1), { text: 'b', kind: 'dropped', sage: '' });
});

test('marked: the text as typed, with what sage does not read struck through, made safe; a hidden character shows nothing', () => {
  assert.equal(marked("Add CSV export (for Excel) — it's *urgent*!"), "Add CSV export ~~(~~for Excel~~)~~ ~~—~~ it~~'~~s ~~\\*~~urgent~~\\*!~~");
  assert.equal(marked('a\u200Bb <@123> https://x.test'), 'ab ~~\\<@~~123~~\\>~~ https:~~//~~x.test');
  // sage never reads a '/', so ':' and '//' are always in two runs: Discord sees no "://" in the source, and no link.
  assert.equal(marked('plain words only'), 'plain words only');
});

test('custom_id: a round trip for every action, the version prefix, the id kinds and Discord\'s 100 characters', () => {
  for (const [action, id] of [['form', 'D1'], ['send-team', `D${'9'.repeat(20)}`], ['send-owner', 'D5'], ['edit', 'D5'], ['cancel', 'D5'],
    ['approve', 'RQ3'], ['decline', 'RQ3'], ['decline!', 'RQ999999999'], ['withdraw', 'RQ3'], ['withdraw!', 'RQ3'], ['keep', 'RQ3']]) {
    const custom = requestId(action, id);
    assert.ok(custom.startsWith('rq1:') && custom.length <= 100, custom);
    assert.deepEqual(parseRequestId(custom), { action, id });
  }
  assert.equal(requestId('withdraw!', 'RQ999999999'), 'rq1:withdraw!:RQ999999999');
  for (const bad of [['approve', 'D1'], ['send-team', 'RQ1'], ['merge', 'RQ1'], ['approve', 'RQ0'], ['edit', `D${'1'.repeat(21)}`]]) {
    assert.throws(() => requestId(...bad), TypeError);
  }
  for (const bad of ['rq2:approve:RQ1', 'rq1:approve:RQ1 ', 'rq1:approve:D1', 'press:G1:0:0', 'rq1:approve:RQ01', 'rq1:approve', '']) assert.equal(parseRequestId(bad), null, bad);
});

test('the form: title 4 to 70, text 10 to 500, both required; Edit opens it with the words in it', () => {
  const m = requestModal('D7');
  assert.deepEqual([m.custom_id, m.title], ['rq1:form:D7', 'Request a feature']);
  assert.deepEqual(m.components.map(({ components: [i] }) => [i.custom_id, i.label, i.style, i.min_length, i.max_length, i.required, i.value]),
    [['title', 'Title', 1, 4, 70, true, undefined], ['text', 'What and why', 2, 10, 500, true, undefined]]);
  assert.deepEqual(requestModal('D7', { title: 'Add CSV', text: 'Some words here' }).components.map(({ components: [i] }) => i.value), ['Add CSV', 'Some words here']);
});

test('the confirm: the text as typed with the marks, what sage reads, the hidden count, and the two Send buttons', () => {
  const c = confirmMessage('D7', { project: 'reports-app', title: 'Add CSV export', text: 'Users need it (for Excel)\u200B now.' });
  assert.equal(c.flags, 64);
  assert.deepEqual(c.allowedMentions, { parse: [] });
  assert.match(c.content, /^\*\*Check your request\.\*\* It goes to Erick for approval\. sage reads only letters, digits and \. , : - so/);
  const [e] = c.embeds;
  assert.equal(e.title, 'Your request · reports-app');
  assert.equal(e.description, '**Title:** Add CSV export\n\n**What and why:** Users need it ~~(~~for Excel~~)~~ now.');
  assert.deepEqual(e.fields, [{ name: 'sage reads', value: 'Add CSV export\nUsers need it for Excel now.' }, { name: 'sage does not get', value: '( )' }]);
  assert.equal(e.footer.text, '1 hidden character in your request: nobody sees them, and sage does not read them. This confirm expires after 10 minutes. You can have 1 open request at a time.');
  assert.deepEqual(c.components[0].components.map((b) => [b.custom_id, b.label, b.style]), [
    ['rq1:send-team:D7', 'Send: the team votes on design questions', 3], ['rq1:send-owner:D7', 'Send: Erick decides design questions', 1],
    ['rq1:edit:D7', 'Edit', 2], ['rq1:cancel:D7', 'Cancel', 2]]);
  // With no hidden character, the footer says only the rules; with nothing dropped, there is no list.
  const plain = confirmMessage('D7', { project: 'p', title: 'Add CSV', text: 'Some words here' }).embeds[0];
  assert.deepEqual([plain.footer.text, plain.fields.map((f) => f.name)], ['This confirm expires after 10 minutes. You can have 1 open request at a time.', ['sage reads']]);
});

test('the confirm lists each character that sage drops once, in first-seen order, made safe, and cut with "…" when long', () => {
  const list = (title, text) => confirmMessage('D7', { project: 'p', title, text }).embeds[0].fields[1]?.value;
  assert.equal(list("Add CSV (it's)", "Export it! (now) 😀 <@123> see https://x.test *ok*"), "( ' ) ! 😀 \\< @ \\> / \\*");
  // A hidden character is counted in the footer, not listed; white space is never listed.
  assert.equal(list('Add CSV', 'a​b   c\n\td e'), undefined);
  // 500 distinct emoji: the list stops after the last whole one that fits in 1024, then " …".
  const many = Array.from({ length: 499 }, (_, i) => String.fromCodePoint(0x1f400 + i)).join('');
  const long = list('Add CSV', `a${many}`);
  assert.ok(long.length <= 1024 && long.endsWith(' …'), `${long.length}`);
  assert.equal(long.slice(0, -2), Array.from(many).slice(0, Array.from(long.slice(0, -2).split(' ')).length).join(' '));
});

test('the confirm refuses a title or a text with nothing that sage can read, and keeps Edit', () => {
  for (const [k, draft] of [['title', { project: 'p', title: '😀😀😀😀', text: 'Some words here' }], ['text', { project: 'p', title: 'Add CSV', text: '"<>" ** !! ??' }]]) {
    const c = confirmMessage('D7', draft);
    assert.equal(c.content, `Your ${k} has nothing that sage can read: it needs letters or digits. Nothing was sent.`);
    assert.deepEqual([c.embeds, c.components[0].components.map((b) => b.custom_id)], [undefined, ['rq1:edit:D7', 'rq1:cancel:D7']]);
  }
  assert.deepEqual(expired('D7').components[0].components.map((b) => b.label), ['Edit', 'Cancel']);
  assert.equal(expired('D7').content, 'This confirm expired after 10 minutes. Nothing was sent. Press Edit to check your text again.');
});

test('the channel line in every state, with no ping', () => {
  const line = (s, o) => requestLine(R[s], o).content;
  assert.equal(line('pending'), '**Jon (sage-lead) requests a feature:** Add CSV export to the reports page · RQ3 · waiting for Erick');
  assert.equal(line('pending', { linkOff: true }), '**Jon (sage-lead) requests a feature:** Add CSV export to the reports page · RQ3 · waiting for Erick · the link to sage is off');
  assert.match(line('approving'), / · RQ3 · being approved$/);
  assert.match(line('approved'), / · RQ3 · approved · sage task T74$/);
  assert.match(line('declined'), / · RQ3 · declined by Erick$/);
  assert.match(line('withdrawn'), / · RQ3 · withdrawn by Jon$/);
  for (const s of Object.keys(R)) assert.deepEqual(requestLine(R[s]).allowedMentions, { parse: [] });
  assert.equal(requestThreadName(R.pending), 'RQ3 · Add CSV export to the reports page');
});

test('the request card in every state: the status, the buttons, the colour, and one ping to Erick on the first post only', () => {
  const card = (s, o = {}) => requestCard(R[s], { ownerId: OWNER_ID, ...o });
  const first = card('pending', { ping: true });
  assert.equal(first.content, `<@${OWNER_ID}> a new request waits for you.`);
  assert.deepEqual(first.allowedMentions, { parse: [], users: [OWNER_ID] });
  const [e] = first.embeds;
  assert.deepEqual([e.title, e.description, e.color], ['Request RQ3 · Add CSV export to the reports page', 'Users need the monthly report as a CSV file (for Excel). Finance copies it by hand today.', 0x6b4fd8]);
  assert.deepEqual(e.fields, [
    { name: 'Requested by', value: `Jon (sage-lead) at ${t(T0)} · project reports-app` },
    { name: 'Design questions', value: 'When sage designs it, the team votes on them (sage-leads break ties).' },
    { name: 'Status', value: 'Waiting for Erick' }]);
  assert.equal(e.footer.text, 'Erick approves or declines, here or at the terminal · the sage-lead who sent it can withdraw it until then · Talk here goes to nobody but the people in this thread: sage does not read it.');
  const buttons = (c) => c.components.flatMap((r) => r.components.map((b) => `${b.label}${b.disabled ? ' (off)' : ''} ${b.custom_id}`));
  assert.deepEqual(buttons(first), ['Approve rq1:approve:RQ3', 'Decline rq1:decline:RQ3', 'Withdraw rq1:withdraw:RQ3']);
  // An edit pings nobody.
  assert.deepEqual([card('pending').content, card('pending').allowedMentions], ['', { parse: [] }]);
  // The link off: Approve is greyed, Decline and Withdraw work, the card says why, and no ping.
  const off = card('pending', { linkOff: true, ping: true });
  assert.deepEqual([off.content, off.allowedMentions, buttons(off)], ['', { parse: [] }, ['Approve (off) rq1:approve:RQ3', 'Decline rq1:decline:RQ3', 'Withdraw rq1:withdraw:RQ3']]);
  assert.deepEqual(off.embeds[0].fields.at(-1), { name: 'The link from Discord to sage is off',
    value: 'Approve waits until Erick turns the link on again at the terminal. Erick can still decline, and the sage-lead who sent it can still withdraw.' });
  assert.deepEqual(buttons(card('approving')), ['Approve (off) rq1:approve:RQ3', 'Decline (off) rq1:decline:RQ3', 'Withdraw (off) rq1:withdraw:RQ3']);
  assert.equal(card('approving').embeds[0].fields[2].value, 'Being approved by Erick');
  // Decided: the status, the colour, no buttons, no footer.
  const status = (s, o) => card(s, o).embeds[0].fields[2].value;
  assert.equal(status('approved'), `**Approved by Erick at ${t(AT)}. sage task T74 is in the sage logbook.**`);
  assert.equal(status('declined'), `**Declined by Erick at ${t(AT)}.**\nReason: We plan the export for the January release.`);
  assert.equal(requestCard(states(FIELDS, '   ').declined, { ownerId: OWNER_ID }).embeds[0].fields[2].value, `**Declined by Erick at ${t(AT)}.**\nNo reason given.`);
  assert.equal(status('withdrawn'), `**Withdrawn by Jon at ${t(AT)}.** Nothing goes to sage.`);
  for (const [s, color] of [['approved', 0x2e8b57], ['declined', 0xb33a3a], ['withdrawn', 0x8a8a8a]]) {
    const c = card(s, { ping: true });
    assert.deepEqual([c.embeds[0].color, c.components, c.embeds[0].footer, c.content, c.allowedMentions], [color, [], undefined, '', { parse: [] }]);
  }
  const terminal = step(R.pending, { type: 'decline', by: 'owner', via: 'terminal', at: AT, reason: null });
  assert.equal(requestCard(terminal, { ownerId: OWNER_ID }).embeds[0].fields[2].value, `**Declined by Erick (terminal) at ${t(AT)}.**\nNo reason given.`);
  assert.equal(requestCard({ ...R.pending, designQuestions: 'owner' }, { ownerId: OWNER_ID }).embeds[0].fields[1].value, 'When sage designs it, Erick decides them.');
});

test('the decline form, the withdraw confirm, the posts after a decision and the private notes', () => {
  const d = declineModal(R.pending);
  assert.deepEqual([d.custom_id, d.title], ['rq1:decline!:RQ3', 'Decline RQ3']);
  assert.deepEqual(d.components.map(({ components: [i] }) => [i.custom_id, i.label, i.max_length, i.required]), [['reason', 'Reason (optional)', 300, false]]);
  const w = withdrawConfirm(R.pending);
  assert.equal(w.content, 'Withdraw RQ3? Erick then cannot approve it, and nothing goes to sage. You can send a new request at once.');
  assert.deepEqual(w.components[0].components.map((b) => [b.custom_id, b.label, b.style]), [['rq1:withdraw!:RQ3', 'Withdraw RQ3', 4], ['rq1:keep:RQ3', 'Keep it', 2]]);
  assert.equal(decidedPost(R.approved).content, '**Approved.** sage task T74 is in the sage logbook. sage starts work on it when bridge sessions are on (T159). Until then, Erick can start it at the terminal. Follow it with /sage task T74.');
  assert.equal(decidedPost(R.declined).content, '**Declined.** Nothing goes to sage. Jon can send a new request with /sage request.');
  assert.equal(decidedPost(R.withdrawn).content, '**Withdrawn.** Nothing goes to sage. Jon can send a new request with /sage request.');
  const note = (why, r) => requestNote(why, r).content;
  assert.equal(note('apprentice'), 'Only a sage-lead can request a feature. Ask a sage-lead.');
  assert.equal(note('linkOff'), 'The link from Discord to sage is off, so I cannot take a request. Nothing was sent. Only Erick can turn it on again, at the terminal. Read asks still work.');
  assert.equal(note('open', { ...R.pending, thread: '100000000000000009' }), `You have an open request: RQ3 · Add CSV export to the reports page, waiting for Erick since ${t(T0)} in <#100000000000000009>. A sage-lead can have 1 open request at a time. Withdraw it in its thread, or wait for Erick's answer.`);
  assert.equal(note('sent', { ...R.pending, thread: '100000000000000009' }), 'Sent to Erick as RQ3. Its thread is <#100000000000000009>. You can withdraw it there until Erick decides.');
  assert.equal(note('notOwner'), 'Only Erick approves or declines a request. Nothing changed.');
  assert.equal(note('notRequester', R.pending), 'Only Jon, who sent RQ3, can withdraw it. Nothing changed.');
  assert.equal(note('late', R.approved), `RQ3 was approved at ${t(AT)} meanwhile. Nothing changed.`);
  assert.equal(note('approved', R.approved), 'You approved RQ3. sage task T74 is added to reports-app.');
  assert.equal(note('cancelled'), 'Cancelled. Nothing was sent.');
  for (const why of Object.keys(REQUEST_NOTES)) assert.deepEqual([requestNote(why, R.approved).flags, requestNote(why, R.approved).allowedMentions], [64, { parse: [] }]);
});

/** Every Discord limit that a payload can break; [] when it fits. */
function overLimits(p) {
  const bad = [];
  const max = (what, s, n) => { if ((s?.length ?? 0) > n) bad.push(`${what} ${s.length} > ${n}`); };
  max('content', p.content, 2000);
  max('modal title', p.title, 45);
  for (const e of p.embeds ?? []) {
    max('embed title', e.title, 256); max('description', e.description, 4096); max('footer', e.footer?.text, 2048);
    for (const f of e.fields ?? []) { max('field name', f.name, 256); max('field value', f.value, 1024); if (!f.value) bad.push('an empty field'); }
    if (embedLength(e) > 6000) bad.push(`embed ${embedLength(e)} > 6000`);
  }
  max('custom_id', p.custom_id, 100);
  if ((p.components ?? []).length > 5) bad.push('more than 5 rows');
  for (const row of p.components ?? []) {
    if (row.components.length > 5) bad.push('more than 5 in a row');
    for (const c of row.components) {
      max('label', c.label, c.type === 4 ? 45 : 80); max('custom_id', c.custom_id, 100); max('placeholder', c.placeholder, 100);
      // A prefilled value counts in code points, as the form's own limits do (src/requests.js LIMITS).
      if (c.value !== undefined && Array.from(c.value).length > c.max_length) bad.push('value over max_length');
    }
  }
  return bad;
}

test('worst cases: every payload in every state stays in Discord\'s limits with the longest text that safe escapes most', () => {
  const words = (unit, n) => Array.from({ length: n }, (_, i) => unit[i % unit.length]).join('');
  const worst = ['*', '[', 'a(', 'a😀', '://a', '\\', 'a\u0301\u0301\u0301\u0301', '-#', '~|_`', '@everyone ',
    // 500 distinct symbols that safe escapes or that take two UTF-16 units: the longest list of what sage does not get.
    `a${Array.from({ length: 250 }, (_, i) => String.fromCodePoint(0x1f400 + i)).join('')}${'*[]<>_~|\\#'.repeat(25)}`];
  for (const unit of worst) {
    const title = words(Array.from(unit), 70);
    const text = words(Array.from(unit), 500);
    const fields = { ...FIELDS, title: forModel(title) ? title : `a${title.slice(1)}`, text: forModel(text) ? text : `a${text.slice(1)}`, requesterName: words(Array.from(unit), 100) };
    const S = states(fields, words(Array.from(unit), 300));
    const payloads = [requestModal('D99999999999999999999', fields), confirmMessage('D99999999999999999999', { project: 'a'.repeat(100), ...fields }), expired('D1')];
    for (const r of Object.values(S).map((x) => ({ ...x, id: 'RQ999999999', task: x.task && 'T999999999', thread: '99999999999999999999' }))) {
      payloads.push(requestLine(r), requestLine(r, { linkOff: true }), requestCard(r, { ownerId: OWNER_ID, ping: true }), requestCard(r, { ownerId: OWNER_ID, linkOff: true }),
        declineModal(r), withdrawConfirm(r), ...Object.keys(REQUEST_NOTES).map((why) => requestNote(why, r)));
      if (decidedPost(r).content) payloads.push(decidedPost(r));
    }
    for (const p of payloads) assert.deepEqual(overLimits(p), [], `${JSON.stringify(unit)}: ${JSON.stringify(p).slice(0, 200)}`);
  }
  // The mention text of a name or a title never pings: every payload but the first card post has no user to ping.
  const r = states({ ...FIELDS, title: '@everyone <@100000000000000002>', requesterName: '@here' }).pending;
  assert.match(requestLine(r).content, /^\*\*@here \(sage-lead\) requests a feature:\*\* @everyone \\<@100000000000000002\\>/);
  assert.deepEqual(requestCard(r, { ownerId: OWNER_ID, ping: true }).allowedMentions, { parse: [], users: [OWNER_ID] });
});
