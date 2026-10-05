# sage-bot reference

This page is the full reference of sage-bot: the vote rules and their API, the cards, the bridge, the gate file, the session threads and the checks. The [README](../README.md) says what sage-bot is, how to try it and how to set up a live trial. Start there.

In this page, a "gate" is a sage gate: a question that sage parks for the owner. The README calls it a question.

**Contents:** [The demo](#the-demo) · [The vote rules](#the-vote-rules) · [The API](#the-api) · [The Discord layer](#the-discord-layer) · [The bridge service](#the-bridge-service) · [Sage sessions and their threads](#sage-sessions-and-their-threads) · [The guard for lead sessions](#the-guard-for-lead-sessions) · [Run the checks](#run-the-checks)

## The demo

The demo needs Node 22 or later, `npm ci` once, and the sage plugin. It finds the sage state tool in this order: `SAGE_TOOL` when it is set; else the newest `sage.mjs` in the plugin's cache, `~/.claude/plugins/cache/sage/sage/*/skills/sage/`; else it stops with a message that names `SAGE_TOOL`. The bridge tests use the same lookup.

The demo plays one sage session end to end with sample data and a scripted clock, then prints the path of one HTML page. The page opens with no network. It shows the session's line in the parent channel, first as posted ("running" with its counts) and then each edit with its time, up to "ended", and its whole thread: the cards at their final state, the private notes that each person sees, the answers in the logbook and the reasons for sage.

The session uses the real sage state tool, hook (`scripts/hook.mjs`), team votes command (`scripts/vote.mjs`) and bridge, on the fake Discord layer:

1. sage adds a single question (T1), a batch of 2 questions (T2) and one question that stays at the terminal (T3), and marks the team votes.
2. Maya answers the single question first: her answer is final. Sam has no role: the bridge ignores his press, so he gets no reply and the press does not count.
3. Maya and Jon vote on the batch with reasons. Part 2 is tied when the vote ends at 30 minutes; the tie post goes to the thread, and Jon (a sage-lead) breaks the tie.
4. In a second batch (T4), Erick answers part 1 at the terminal, and Jon ends the vote early.
5. The session ends: its line says "ended", and its thread locks because no question is open.

Everything goes into a new scratch folder (printed at the end), with `HOME` and `SAGE_HOME` of every child process in it, so the demo never touches your home folder or a real logbook. Options: `--out <page.html>` writes the page there instead (the demo checks this path before it starts, and stops with a message when it cannot make the folder or the path is a folder); `--shot <page.png>` also screenshots it with the local Chrome (playwright-core, channel `chrome`). Two runs give the same page bytes.

## The vote rules

`src/vote.js` holds the rules as data and pure functions. A gate and an event go in; the new gate and its effects come out. Each event carries its time, so the rules never read the clock.

| Case | Rule |
| --- | --- |
| Who counts | Only a holder: a Discord user id on the holder list that the bridge passes in with each event. The Discord admin gives and removes the role; there is no vote on it. Each id counts once. |
| Leads | A separate list of ids with the sage-lead role, which the admin gives. The bridge passes it in with each event. A lead action (end early, tie-break) counts only from a lead who is also a holder, and only from Discord, never from the terminal. The bridge makes every lead a holder (see `peopleOf`). |
| Kinds | Two only: single and batch. Any other kind is refused. |
| Single gate | One question with options, each option once. The first answer from a holder is final at once. A later press is ignored. A single answer has no reason. |
| Batch gate | The task's one batch of product questions, as parts, each with its own options (each option once in a part). It is a vote: every holder may vote on each part, and the last ballot of each person on each part counts. |
| Time limit | A batch vote ends 30 minutes after it opens (at 29:59.999 it is still open). Each part goes to the option with the most votes cast; people who did not vote do not count. The countdown keeps running while the owner's Mac sleeps: when the bridge wakes after the limit, its tick closes the vote with the votes cast so far. |
| Tie | A part with a tie, or with no votes, stays open. Only a lead decides it, by choosing one of the tied options (with no votes, every option is tied). While a part is tied, the batch is not closed: sage gets the answers only when every part is decided. |
| End early | A lead may end a batch vote at any time. The parts are then decided as at the time limit. |
| Holder list changes | A holder added to the list counts at once. A removed holder's ballot does not count at the time limit. Nothing is decided with no holders. |
| Reminder | A single gate with no answer: to the holders every 2 hours from opening. A batch with tied parts: to the leads every 2 hours after its vote ended, also when a lead ended it early. |
| Reason | Optional on a batch ballot, at most 500 characters (Unicode code points). A longer reason is cut to 500, with no error. The cut never splits an emoji or another character of two UTF-16 units; a lone surrogate becomes U+FFFD. An empty reason means no reason. B1 does not clean a reason in any other way (see below). |
| Terminal answer | The owner's answer at the terminal counts as the first answer on a single gate, and as one ballot in a batch. It counts only from a holder: the owner needs the sage-apprentice or the sage-lead role like everyone else. |
| Outcome | Single: open, answered (option, who, and via Discord or the terminal), or withdrawn. Batch: each part is open or decided (by votes or by a lead's tie-break); the batch closes when every part is decided. |
| Withdraw | The person who asked may withdraw the gate. A withdraw while any part is still open cancels the whole gate: no part of a withdrawn batch stays decided, also when the vote already decided it. A step that ends withdrawn gives only the `'closed'` effect, also when the time limit passed before it. Once a gate closes as decided, a withdraw has no effect. A withdraw at or after the time limit, with no tick before it, comes after the limit: the vote ends first, so the withdraw has no effect when the vote decided every part. |
| Odd input | `openGate` throws on a gate it refuses (also a time that is not a safe integer, or a duplicate option). `step` never throws for odd events; it throws a TypeError for a missing or wrong gate, as `nextReminderAt` and `parseGate` do. An odd event, a time that is not a safe integer (whole ms), or a time earlier than the last applied event is ignored, with the reason. A refused event does not move the gate's time. |

### Reasons are untrusted text

B1 stores reasons as typed. They are untrusted text. The bridge must clean and frame them before any reason reaches sage or a log. A reason can hold `<`, `>`, backticks, newlines, mentions and invisible characters. Cleaning belongs to B3, in one place where reasons leave the bridge.

## The API

Import the functions from `src/vote.js`. All times are whole milliseconds (safe integers) from the bridge's own clock.

It also exports these constants, all in ms except the last:

| Constant | Value |
| --- | --- |
| `MINUTE` | 60,000 |
| `HOUR` | 60 minutes |
| `BATCH_LIMIT` | 30 minutes: the time limit of a batch vote |
| `REMINDER_EVERY` | 2 hours |
| `REASON_MAX` | 500: the most characters (code points) in a ballot reason; a longer one is cut |
| `MAX_OPTIONS` | 5: the most options of a single gate or of one batch part (one row of Discord buttons) |
| `MAX_BALLOTS` | 1000: the most voters on one part; the next new voter gets `full` |

### openGate({ id, kind, options, parts, askedBy, at })

Makes a new gate.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | non-empty string | The gate's id in the logbook. |
| `kind` | `'single'` or `'batch'` | The kind of gate. |
| `options` | array of unique non-empty strings | Single only: the options. |
| `parts` | array of such arrays | Batch only: the options of each part. Parts count from 0. |
| `askedBy` | non-empty string | The id of the person who asked. Only this person may withdraw. |
| `at` | safe integer (ms) | The time the gate opens. A batch vote ends at `at + 30 minutes` (`gate.endsAt`). |

It throws:

- a RangeError for a kind other than `'single'` or `'batch'`, or for an `at` that is not a safe integer;
- a TypeError for a missing `id` or `askedBy`, or for empty or duplicate options or parts, or for more than `MAX_OPTIONS` (5) options in one list.

### step(gate, event, holders, leads)

Applies one event to a gate and returns `{ gate, effects }`. It does not change its input gate.

- `gate`: a gate from `openGate`, an earlier `step` or `parseGate`.
- `holders`: the ids that may answer and vote. `leads`: the ids with the sage-lead role. Each is any iterable of strings: an Array, a Set or a Map's `keys()`. Anything else, also a string, counts as empty. For long lists, pass a Set: `step` then uses it as it is.

`step` never throws for odd events: it ignores them, with the reason. It throws a TypeError for a missing or wrong gate.

**The bridge must send a tick at `gate.endsAt`.** The vote also ends at the first event at or after that time, before the event applies.

### The events

Every event has `type` and `at`. `via` is `'discord'` or `'terminal'`. `part` is the part's index, from 0.

| `type` | Fields | What it does |
| --- | --- | --- |
| `press` | `by`, `option`, `at`, `via`; batch: `part`, optional `reason` (string, stored as typed and cut to 500 characters) | Single: the answer. Batch: a ballot on one part. |
| `end` | `by`, `at`, `via` | A lead ends the batch vote early. Discord only. |
| `tiebreak` | `by`, `part`, `option`, `at`, `via` | A lead decides a tied part. Discord only, after the vote ended. |
| `withdraw` | `by`, `at` | The asker cancels the gate. |
| `tick` | `at` | The time moved on. The bridge sends one at `gate.endsAt`. |

### The effects

| Effect | When |
| --- | --- |
| `{ type: 'vote-ended', by }` | The batch vote ended. `by` is the lead's id, or `null` at the time limit. |
| `{ type: 'decided', part, option, how }` | A part is decided. `how` is `'votes'` or `'lead-tiebreak'`. |
| `{ type: 'closed', outcome }` | The gate closed with this outcome. |
| `{ type: 'ignored', by, why }` | The event did nothing. `by` is the event's `by`, or `null`. |

The bridge acts only on the `'closed'` effect: it gives the outcome to sage then. The other effects are for the card on Discord. A step that ends with the gate withdrawn gives no `'vote-ended'` or `'decided'` effect, only `'closed'` with `{ status: 'withdrawn' }`.

The `why` codes:

| `why` | Meaning |
| --- | --- |
| `bad-event` | The event is not an object, has an unknown type, or `by`, `via`, `option` or `reason` is missing or of the wrong type. |
| `bad-time` | `at` is missing or not a safe integer. |
| `out-of-order` | `at` is earlier than the last applied event. |
| `not-holder` | `by` is not a holder. |
| `not-lead` | `by` is a holder but not a lead. |
| `lead-needs-discord` | A lead action came from the terminal. |
| `not-asker` | A withdraw from someone other than the asker. |
| `unknown-option` | The gate or part does not have this option. |
| `unknown-part` | The batch does not have this part, or `part` is missing or not an integer. |
| `wrong-kind` | An `end` or `tiebreak` on a single gate. |
| `not-tied` | A tie-break while the vote is open, or on a decided part. |
| `not-tied-option` | A tie-break for an option that is not among the tied leaders of the part. |
| `closed` | The gate or the vote is already closed. |
| `full` | The part already has `MAX_BALLOTS` voters, and `by` is not one of them. |

### The gate and its outcome

| Field | Single | Batch |
| --- | --- | --- |
| `phase` | `'open'` or `'closed'` | `'voting'`, `'tied'` or `'closed'` |
| `outcome` | `{ status: 'open' }`, `{ status: 'answered', option, by, via }` or `{ status: 'withdrawn' }` | `{ status: 'open' }`, `{ status: 'decided' }` or `{ status: 'withdrawn' }` |
| `id`, `kind`, `askedBy` | as given to `openGate` | as given to `openGate` |
| `openedAt` | the `at` of `openGate` | the `at` of `openGate` |
| `lastAt` | the time of the last applied event (`openedAt` at first) | the same |
| other | `options` | `endsAt`, `votingEndedAt`, `endedBy` (after the vote ended), `parts` |

A batch also has `endedBy` once its vote ended: the id of the lead who ended it early, or `null` at the time limit. Each part of a batch has `options`, `outcome` (`{ status: 'open' }`, `{ status: 'decided', option, how: 'votes' }` or `{ status: 'decided', option, how: 'lead-tiebreak', by, at }`, with the lead's id and the time of the tie-break) and, after the vote ended with no single leader, `tied` (the tied options). The final answers of a decided batch are the parts' outcomes; the parts of a withdrawn batch show `{ status: 'open' }` and keep their ballots. A part also has `ballots`, stored as `[id, ballot]` pairs so that the gate stays plain JSON. Do not read `ballots` directly: call `ballotsOf(part)`. It returns a Map from id to `{ option, at, via, reason? }`, the last ballot of each person.

A gate from `openGate`, `step` or `parseGate` is frozen all through: its parts, arrays, outcomes and ballots. `step` shares the unchanged parts between the old and the new gate, so the freeze keeps a change to one gate from reaching another.

A gate is plain JSON: it keeps one ballot per person on each part, so its size grows with the people, not with the presses, and its depth stays the same.

### parseGate(value)

Checks a loaded gate, freezes it all through and returns it. **The bridge (B3) must call `parseGate` on each gate that it loads**, for example from JSON after a restart. It throws a TypeError, with the reason, for a value that `openGate` and `step` could not have made: unknown fields, a phase that does not match the outcomes, a tied part without its tied options, an option that the gate or part does not have, a ballot by an empty id or a second ballot by one person, more than `MAX_BALLOTS` ballots or `MAX_OPTIONS` options on a part, a reason that is empty, longer than 500 characters or has a lone surrogate, a time that is not a safe integer or is later than `lastAt`, a tie-break time before the end of the vote, or an `endedBy` that does not match the end (an id for an early end, `null` at the time limit). A gate saved before T39, without `endedBy` or a tie-break's `by` and `at`, still loads. `step` and `nextReminderAt` make the same check.

### nextReminderAt(gate, now)

Returns the next reminder strictly after `now`, as `{ at, to }`, or `null` when no reminder is due. `to` is `'holders'` for a single gate with no answer, and `'leads'` for a batch with tied parts. It returns `null` for a `now` that is not a safe integer, and throws a TypeError for a missing or wrong gate.

### An example

This is `examples/vote-example.mjs`. Run it with `node examples/vote-example.mjs`.

```js
// A batch vote with two parts, from opening to the final answers. Sample ids and times only.
import { openGate, step, MINUTE } from '../src/vote.js';

const holders = new Set(['maya', 'jon', 'ana']);
const leads = new Set(['jon']);
const t0 = 1_800_000_000_000; // the bridge's own clock, in ms

let gate = openGate({ id: 'g1', kind: 'batch', parts: [['x', 'y'], ['p', 'q']], askedBy: 'owner', at: t0 });
const send = (event) => {
  const out = step(gate, event, holders, leads);
  gate = out.gate;
  for (const effect of out.effects) console.log(JSON.stringify(effect));
};

send({ type: 'press', by: 'maya', part: 0, option: 'x', at: t0 + MINUTE, via: 'discord' });
send({ type: 'press', by: 'ana', part: 0, option: 'x', at: t0 + 2 * MINUTE, via: 'discord', reason: 'cheaper' });
send({ type: 'press', by: 'jon', part: 1, option: 'p', at: t0 + 3 * MINUTE, via: 'discord' });
send({ type: 'press', by: 'ana', part: 1, option: 'q', at: t0 + 4 * MINUTE, via: 'discord' });
send({ type: 'tick', at: gate.endsAt }); // part 0 goes to x; part 1 is tied, so the batch stays open
send({ type: 'tiebreak', by: 'jon', part: 1, option: 'q', at: gate.endsAt + MINUTE, via: 'discord' });
console.log(gate.phase, JSON.stringify(gate.outcome));
```

It prints:

```text
{"type":"vote-ended","by":null}
{"type":"decided","part":0,"option":"x","how":"votes"}
{"type":"decided","part":1,"option":"q","how":"lead-tiebreak"}
{"type":"closed","outcome":{"status":"decided"}}
closed {"status":"decided"}
```

## The Discord layer

`src/cards.js` and `src/handle.js` turn a gate into Discord JSON and a Discord interaction into an event for the vote rules. They use the builders of discord.js (pinned to one exact version) for the shapes, and nothing else of it: no Client, no login, no network. `src/fake-discord.js` makes an interaction-like object that records its replies, so the tests and the preview run with no Discord account.

### The ask

A card needs the gate and its ask: what sage asked, in words. B3 builds the ask from sage's logbook. `kind` and the option keys match the gate; the labels are only for the card.

```js
{ kind: 'batch', task: 'T7', title: 'CSV export for reports', parts: [
  { question: 'How do dates look in the file?', why: 'A sorts well.', recommended: 'A', options: { A: '2026-10-04 (ISO)', B: '04/10/2026' } },
] }
```

A single question has one part, with an optional `default`. `examples/sample.js` holds sample asks, members and a config, and `openAsk` opens the gate of an ask.

### peopleOf(members, config)

Builds `{ holders, leads, names }` from the guild members (`{ id, name, roles, bot }`, with `roles` a list of role ids and `bot` discord.js's `member.user.bot`) and the config `{ apprenticeRole, leadRole }`. The holders are exactly the members with the sage-apprentice or the sage-lead role, and the leads exactly the members with the sage-lead role, so every lead is a holder. A member with both roles is a lead: the owner is not added by default, and a bot is neither, whatever its roles. The bridge passes `holders` and `leads` to the vote rules, which also need a lead to be a holder.

### card(gate, ask, people)

The card of a gate as `{ embeds, components, allowedMentions }`. Times are Discord timestamps, so each viewer's Discord shows them in the viewer's own zone, and the 30-minute countdown runs live with no edit of the card.

| State | The card |
| --- | --- |
| Single, open | The question, the options with Recommended and Default, the rule, one button per option. |
| Single, answered | "Answered by Maya at 14:22: A. … Final." The buttons are off; the chosen one is green. |
| Batch, voting | "Vote on each part; change your vote until the vote ends. The work on the task goes on. Closes at 15:01 (in 18 minutes)". Per part: each option with its votes and voters ("Erick (terminal), Jon"), sage's recommendation, "Voted: … · Not voted: …", and "Ahead: A", "Even so far" or "No votes yet". Each reason as one line, cut to 200 characters; when the card is full, the oldest reasons go first and one line says "N more reasons; sage has them all"; a visibly empty reason (nothing but spaces, hidden characters or combining marks) shows no line. A button per option of each part, "Part 1, A: Only the columns visible in the table" (cut to 80 characters), and "End vote now (sage-lead only)". |
| Batch, tied | "Voting ended at 15:01. 1 part is tied: it waits for a sage-lead. The other parts are provisional, and T7 waits." (with every part tied: "2 parts are tied: they wait for a sage-lead. T7 waits."). After a lead's early end: "Ended early by Jon (sage-lead) at 15:28, with the votes so far." A tied part shows "Tied: A, B at 1 vote each. A sage-lead breaks the tie. sage-bot reminds @sage-lead every 2 h." (plain text: it pings nobody) and a button "Part 2, break the tie: A (sage-lead only)" for each tied option only (every option when nobody voted). Decided parts say "Provisional: A · 3 of 3 votes". |
| Batch, decided | "Voting ended at 15:01. Closed: every part is decided. T7 goes on." A part that a lead decided says "Decided: A · tie broken by Jon (sage-lead) at 17:05". Every button is off. |
| Withdrawn | "Withdrawn by Erick at 15:30. Closed: nothing is decided." Every button is off. |

The words "Voting ended at" are for the vote; "Closed" is only for a decided or withdrawn gate. The card names the lead who broke a tie or ended the vote early (owner decision G11), from the gate's `by` and `at` and its `endedBy`, through the same name lookup and `safe` as every other name. A gate saved before T39 does not have these fields: its card says "tie broken by a sage-lead" and "Ended early by a sage-lead at 15:28".

**Untrusted text.** A reason and a display name are text that a person reads on the card, and nothing else reads it: sage gets the reasons from the stored ballot, cleaned by B3's own allow-list. `safe` keeps only what a person needs: a whole RGI emoji (a family, a skin tone, a keycap, the Scotland flag), a letter, a number, punctuation, a symbol (also a bare pictograph such as ™, ©, ✔ or ⚠; a variation selector after it stays only when the pair is an RGI emoji), a space, at most 3 combining marks on a letter that pile on it (the non-spacing marks, Unicode `Mn`) and at most 4 spacing or enclosing marks (Unicode `Mc` and `Me`, such as a vowel sign, a musical stem or a ring; they do not count toward the 3, so Burmese ကျော် stays whole), and a joiner (U+200C, U+200D) after a letter or mark of a joining script (Arabic, Syriac, the Indic scripts, Myanmar or Khmer) when a letter or mark of one follows, or when the joiner follows a mark such as a final virama; never two joiners in a row. So a Persian word, a Hindi or Bengali conjunct and a Malayalam chillu stay whole, and a stack of marks is cut to 3 non-spacing and 4 spacing or enclosing marks on one letter. Everything else goes: the backtick (no code span), every format character, variation selector, control, private-use and unassigned code point, and the six characters that look blank (the four Hangul fillers, the blank Braille cell U+2800 and the musical null notehead U+1D159). Then `safe` escapes Discord markdown (discord.js `escapeMarkdown`), every `[`, `]`, `<` and `>` (no masked link, mention, timestamp, emoji code or quote; "A > B" and "x <= y" show as typed) and a leading `-#` (no subtext), breaks every `://` to `:// ` so that no URL is clickable (Discord does not link `www.` or a bare domain), and folds white space to one line. A text with nothing visible left gives `''`. Every message also carries `allowedMentions: { parse: [] }`, so nothing pings anyone. The reason form sets `max_length` to 500.

**Discord's limits.** One message holds 5 rows of buttons; an embed holds 25 fields and 6000 characters in all, a title of at most 256 characters, a description of at most 4096, and each field a name of at most 256 and a value of at most 1024; a button label holds 80 characters and a form title 45. A card uses one row per part, one more while the vote is open, and one field per part and per reason. B3 refuses an ask with more than 4 parts: `card` throws a RangeError for more than 5 rows, which a batch of 5 or more parts reaches while the vote is open; through `handle`, a press on such a batch still stores the ballot and shows the reason form (no card is built), and the form's submit then rejects and stores nothing. `card` never throws for a team of 2 to 5 with at most 4 parts, whatever the ask's texts hold: one budget builds the whole embed, measures every limit and shrinks it in a fixed order until all hold. First each text goes within its own limit (a field value in 1024), then the whole embed within 6000 characters and 25 fields. The budget drops the oldest reason fields (one at a time, for the whole embed only; the description then says "N more reasons; sage has them all", a line that never shrinks), then cuts the voter lists (to "and N more"), then the why, then the option labels, then the question in the field name; the title is cut to 256 and a button label to 80. The lead's private confirm is budgeted the same way: in its 2000 characters, the voter lists shrink to "and N more" for a team far larger than 5. The keys, the counts and "sage recommends A" never shrink. The single card shrinks the same way: the why, then the labels, then the question, so its description stays in 4096. B3 also keeps the texts of an ask reasonable, so that nothing is cut: with a team of 5, three labels of 80 characters and a why of 300 fit whole. The card shows each reason cut to 200 characters (the gate keeps the full 500), never through a flag or a family emoji, and the newest reasons that fit: how many depends on the names and on the ask's texts; a team of 5 with 4 parts, short questions and a 500-character reason from everyone shows most of the 20 reasons, and the description counts the rest. A randomized test of 2000 cards (a team of 2 to 5, 1 to 4 parts, 2 to 5 options, every gate state, questions to 1000 characters, labels to 500, a why to 4000, reasons to 500, names with markdown) proves that every limit holds. No field is ever empty, because Discord refuses an empty name or value: a reason that `safe` reduces to nothing gets no field, and a member whose name is missing or visibly empty shows as "member …6789" (the last 4 digits of an id of 4 or more digits) or "member" for any other id, everywhere, never as the raw id. `handle` builds its reply before it stores the new gate, so a card that cannot be built leaves the gate as it was.

### handle(interaction, { gates, people, clock })

Takes one interaction (a button press or the reason form) and answers it. `gates` is a Map from gate id to `{ gate, ask }`; the handler sets the new gate there. It returns `{ gate, effects, stored }`: the gate after the event (null for an unknown card), the vote rules' effects, and `stored`, true when the event changed the gate and the new gate is in `gates`. A batch press that counts gives `effects: []` and `stored: true`; an unknown card, a forged index, the end confirm, a cancel or an event that the vote rules ignored gives `stored: false` (also when the time limit passed inside the step: then the gate changed, and `stored` is true beside the `'ignored'` effect). `handle` rejects only for a programming error: a wrong `interaction` (no `user`, no `reply`) or `ctx` (no `gates`, `people` or `clock`), or `card`'s RangeError for an ask of more than 4 parts. It never rejects because Discord refused the reply (an unknown interaction, a network error): then it returns `{ gate, effects, stored, replyError }`, with the gate, the effects and `stored` as they are after the store. With `stored: false` nothing changed; with `stored: true` the gate changed (a ballot that Discord did not confirm is still stored). `replyError` is the error that Discord gave. B3 acts on the returned effects (a `closed` effect still reaches sage), then edits the card message with `card(...)`. Of `replyError` B3 logs only its `code`, `status` and `message`, never the whole error: it holds the interaction token.

| The interaction reads | What the handler does |
| --- | --- |
| `interaction.user.id` | `by`, always. |
| `interaction.customId` | The action, the gate id, and the part and option indexes. Never the option text. The option comes from the gate: a forged gate, part, index or option text gets a private note and no event. |
| `interaction.fields` | The reason of the form (input id `reason`), as typed; the vote rules cut it to 500 characters. A `reason:` id with no fields, or without that field, gets a private note and no event. |
| `interaction.message.flags` | Only for `end!:` and `cancel:`: they count only from the lead's private confirm (the Ephemeral flag). From any other message they are unknown buttons: a private note, and the card does not change. |
| The injected `clock()` | `at`, always. Not the interaction's data. |
| nothing | `via` is always `'discord'`. |

The custom_id grammar: `press:<gate>:<part>:<index>`, `reason:<gate>:<part>:<index>` (the form), `tiebreak:<gate>:<part>:<index>`, `end:<gate>` (the confirm), `end!:<gate>` (the confirmed end), `cancel:<gate>`. A single question uses part 0. In the bridge, `<gate>` is the gate's key, for example `your-project/G3+G4` (T132).

| Press | The reply |
| --- | --- |
| An option of a single question | The updated card. A later press: the private note "Already answered by Maya: A". |
| An option of a batch part | The vote counts at once; the reply is the reason form (optional, 500 characters; its title is "Your vote counts: A. Only the columns visible in the table" or, when that does not fit in 45 characters, the option alone, cut at a word). Its submit replaces the ballot with the reason and updates the card. A dismissed form sends nothing: the ballot stays, and B3 edits the card at its next chance. |
| End vote now | The end runs through the vote rules first, without a store. When they would refuse it (not a lead, a single question, the vote ended, closed or withdrawn, or past the time limit by the clock), the reply is that refusal's private note, so the confirm never shows false facts. Otherwise a private confirm: what each part gets with the votes so far ("Part 1 goes to A: 2 of 3 votes (Erick, Jon)."), with "Cancel" and "End vote now". The confirmed end runs through the vote rules; the reply updates the private confirm, so B3 edits the card. |
| A tie-break button, by a lead | The updated card. |
| Cancel, on the private confirm | The confirm becomes "Cancelled. The vote goes on." or, when the vote ended meanwhile, "The vote on B9 ended at 15:01 meanwhile. Nothing to cancel." (on a withdrawn gate: "B9 was withdrawn by Erick. Nothing to answer."). A `cancel:` press from any private message only answers and changes nothing: no event, no store. |
| Anything the vote rules ignore | A private note for its `why` code. Every code has one; a non-holder gets "Your press did not count. Only people with the sage-apprentice or sage-lead role can answer or vote. You can still read this thread." The running bridge never passes the press of a member with neither role to `handle`, so in Discord that member gets no reply (G20). |

Discord shows every button of a message to everyone, so a non-lead sees "End vote now" and the tie-break buttons too; a press gets the private note "Only a sage-lead can do this. Your votes on the parts count like everyone's." B3 must: call `parseGate` on each loaded gate; send the tick at `gate.endsAt` and the withdraw from sage through `step`; and edit the card message with `card(...)` whenever the gate changed but the reply was not the card (after a confirmed end, a dismissed form, a tick or a withdraw).

### The fake layer

`src/fake-discord.js` exports `fakeInteraction({ user, customId, fields, ephemeral, refuse })`: an interaction-like object for the tests and the preview, with the shape that `handle` reads and a `replies` list that records every answer as `{ kind, ...payload }` (kind `'reply'`, `'update'` or `'modal'`).

- `user`: the user id; `customId`: the button's or form's custom id.
- `fields`: the form's inputs by input id, only for a form submit; the reason form has one input, `'reason'`. A button press has no `fields`, as in discord.js, and `getTextInputValue('reason')` throws for a missing input, as in discord.js.
- `ephemeral`: true when the pressed message was private (the lead's confirm); it sets the Ephemeral flag of `message.flags`.
- `refuse`: an Error; every reply then rejects with it and records nothing, as Discord does for an unknown interaction.

For the read commands it also exports `fakeCommand({ user, roles, bot, channelId, parentId, sub, options, onDefer })` and `fakeMention({ user, roles, bot, channelId, parentId, content })`: a `/sage` command and a message that mentions the bot, in the shape that `src/discord.js` gives `src/ask.js`. `parentId` is the parent channel of a thread, else null. Each records its replies in `replies`. `fakeCommand` records its `defer` and `edit` calls in order as `{ kind, ...payload }`, an attached file as its name and size, and runs `onDefer` inside the defer, so that a test can change the project there.

### The preview

<!-- check: run, prints "with 11 moments" -->
```sh
node scripts/preview.mjs
```

This command renders the card JSON of the design's ten moments, plus a card of a team of 5 with 4 parts and 500-character reasons, to `design/b2/index.html` with sample data (or to the path after `--out <page.html>`), through `scripts/render.mjs` (the demo uses it too). With `--shots` it also screenshots each moment to `shots/` beside the page with the local Chrome (playwright-core, channel `chrome`); run it with `HOME` set to a scratch folder. Chrome runs with `--disable-gpu`, so the shots are byte-identical from one cold run to the next (the GPU raster path draws the rounded border corner by one shade differently in some runs).

## The bridge service

`src/bridge.js` is the bridge. It runs on the owner's Mac, as one process for one sage project and one Discord channel. Every 15 seconds it does one turn of its loop:

1. It notices a sleep of the Mac (two turns more than 75 seconds apart). When a gate is open, it posts: "The host was asleep from 22:10 to 08:05. Presses in that time did not count. Please press again on any open question." A press while the Mac slept never reached the bridge: Discord showed "This interaction failed".
2. It sends the tick at `gate.endsAt` to each batch vote at or after its limit, also after a sleep.
3. It sends each reminder that is due, once, also after a sleep: to the sage-apprentice and sage-lead roles for a single gate with no answer, and to the sage-lead role only for a batch with tied parts.
4. It reads the logbook (see below) and posts the new gates that sage marked as team votes.
5. It gives sage each final answer that sage does not have yet.

The roles come from the config: `apprenticeRole` and `leadRole`. A config from before the two roles, with `driverRole` and no `apprenticeRole`, stops the bridge with exit 1 before it takes the lock or reads the Keychain, and `scripts/launchd.mjs` refuses it the same way: "the config has driverRole: sage-driver is gone. Rename driverRole to apprenticeRole and give that role id to the sage-apprentice role." When a member has both roles, the bridge counts the member as a lead and logs one line with the name and id of each such member; it logs the line again only when that list changes.

Each event gets its time from the bridge's own clock: the wall clock (it runs on while the Mac sleeps), never earlier than its last value. No time comes from Discord data.

### The channel registry

The channel registry (T130, `src/channels.js`) lists the Discord channels where sage-bot works. Each entry maps one channel id to one project of the config's `projects`. `/sage` and @sage-bot mentions work in each registered channel and in its threads. Exactly one entry is the home channel: the votes and cards post there, as in the parent channel before T130.

The file is `<statePath>.channels`, beside the gate file and the team votes file. An example:

```json
{
  "version": 1,
  "channels": {
    "400000000000000002": { "project": "your-project" },
    "400000000000000001": { "project": "your-project", "home": true }
  }
}
```

**The file is safe like the gate file.** It is written whole: a new 0600 file beside it, synced, then renamed over it, in a folder of mode 0700 (`writeWhole`). It is read through `readOwn`: the open refuses a symlink (`O_NOFOLLOW`), and the open file must be a regular file of this user with mode 0600. The bridge stops at start, before it connects to Discord, for a symlink, a wrong mode, bad JSON, an entry that the bridge did not write, a project that is not in `projects`, or not exactly one home channel. The message names the file and the cause, and ends with the commands that repair it, for example "the channel registry …/gates.json.channels is not JSON. Nothing was loaded. Move it aside with: mv …/gates.json.channels …/gates.json.channels.bad, then register the home channel again with: node scripts/channels.mjs --config <config.json> register <channel id> <project> --home". For a wrong mode of this user's own file, the repair is "Fix it with: chmod 600 …/gates.json.channels". For every other cause (a symlink, a file of another user, bad JSON, an entry that the bridge did not write, a key that is not a Discord id, `"home": false`, no home channel or two), it is the move aside. After the move, the script works as on a new install: `register … --home` makes a new registry. The bridge never writes over a bad file. The same messages stop `list`, `register` and `unregister`.

**One writer at a time.** Only the holder of the bridge lock (`<statePath>.lock`) writes the file: the running bridge (a lead's unregister), or `scripts/channels.mjs` while the bridge is stopped. `register` and `unregister` take the same lock, so they refuse while a bridge runs, and a bridge cannot start while the script works. `list` only reads the file (through `readOwn`), so it takes no lock and works while the bridge runs. The launchd agent has `KeepAlive`, so a killed bridge starts again and takes the lock again. Stop it and start it around `register` and `unregister` with launchctl; the refusal prints the same lines. A bridge that Erick runs by hand stops with Ctrl+C.

```text
launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist
node scripts/channels.mjs register <channel id> <project>
launchctl load ~/Library/LaunchAgents/com.sage.bot.plist
```

**The migration.** When there is no registry file, the bridge makes it at its first start from the config of the time before T130:

- `askChannelId` (the old #ask-sage) goes to the first project of `projects`.
- `channelId` (the old parent channel) becomes the home channel, for the bridge's own `project`. `/sage` now works there too.
- When both are the same channel, it is one home entry for the first project.

The bridge logs one line with the entries. After that, the bridge reads only the file: `channelId` and `askChannelId` in the config change nothing. With no file and no `channelId` (a new install), the bridge stops and gives the command that makes the first registry: `node scripts/channels.mjs --config <config.json> register <channel id> <project> --home`.

**A project removed from the config.** When a channel of the registry has a project that is not in `projects`, the bridge stops at start. The message names each such channel and its project, and the repair: `register <channel id> <project>` for a listed project, or `unregister <channel id>`. The script still lists and unregisters such a channel; `list` marks it "not in the config".

**Erick registers channels at the terminal.** Only Erick registers a channel or changes its project (G24). The script cannot talk to Discord, because the bridge holds the only connection. So the script changes the file only while the bridge is stopped, and the bridge checks the permissions at its next start.

```text
node scripts/channels.mjs [--config <config.json>] list
node scripts/channels.mjs [--config <config.json>] register <channel id> <project> [--home]
node scripts/channels.mjs [--config <config.json>] unregister <channel id>
```

- `--config` defaults to `~/.config/sage-bot/config.json`.
- `register` adds a channel, or changes the project of a registered one; the home channel stays the home. With `--home`, the channel becomes the home channel, and the old home stays registered as a normal channel. A project that is not in `projects` is refused, and nothing changes.
- With no registry and no `channelId`, only `register <channel id> <project> --home` works: it makes the first registry.
- The home channel cannot move while a card of the gate file waits (its gate is not settled): the bridge takes presses only in the home channel and its threads, so those buttons would stop working. The refusal names the cards.
- `unregister` removes a channel. The home channel is refused: make another channel the home first.
- Each command prints its change, then the registry. A refusal prints the reason on stderr and exits 1. A wrong verb prints the usage line.

**The permissions.** At each start, after it connects, the bridge checks its permissions in each registered channel with `permissionsFor`: View Channel, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads and Embed Links. It logs one line for each channel that lacks one or more, with their names: "sage-bot lacks these permissions in the registered channel 400000000000000002 (your-project): Manage Threads, Embed Links. Give them to its role in that channel". For a channel that it cannot see, it logs "sage-bot cannot see the registered channel …". The channel stays registered, and the bridge keeps running.

**A sage-lead may only unregister a channel.** `/sage unregister` in a registered channel, or in a thread of it, gives a sage-lead a public confirm with two buttons, "Unregister this channel" and "Cancel".

- A press of a sage-lead removes the channel, saves the file, logs "the sage-lead <name> (<id>) unregistered the channel <id> (it was for the project <name>)" at the terminal, and replaces the confirm with the result. When the save fails, the channel stays registered and the reply says so.
- A lead's Cancel replaces the confirm with "Cancelled. Nothing changed." The confirm works for 10 minutes after Discord made it; a later press changes nothing and says to type `/sage unregister` again.
- A press whose button id does not end in a Discord id (or Cancel) gets nothing.
- A sage-apprentice gets "Only a sage-lead can unregister a channel. Ask a lead." for the command, and a reply of its own for a press, so the lead's confirm stays.
- A member with neither role gets nothing.
- The home channel cannot be unregistered from Discord. A lead cannot register a channel or change its project.

**A channel that is not registered.** sage-bot ignores `/sage` and mentions there, except one public pointer per person per UTC day, shared by `/sage` and mentions: "I answer /sage in #channel, so please ask there." It names the first channel of the registry. For an ignored `/sage`, the bridge removes its deferred reply, so nothing stays in the channel. The pointer does not count toward the limit.

### The read commands

`src/ask.js` answers `/sage` in each registered channel and its threads, with no AI (G18, option A). At start the bridge sets the `/sage` command for its guild only, with six subcommands: four read commands, `unregister` and `stop` (the kill switch, see [Mention threads](#mention-threads)). `project` is a choice of the listed projects; without it, the project of the channel answers. The option may name any listed project.

| Command | The public answer |
| --- | --- |
| `/sage board [project]` | The count of tasks by state, the tasks left (not merged, concluded or abandoned), "Time left is not estimated yet: the project's records have no estimate.", and each open question with its text and its options, without the team vote label and without the "Recommended" and "Default" line (that advice is in `/sage gates`). |
| `/sage task <id> [project]` | The task's id, title, size, state and pull request; the pull request is a link when the project has `repo`. |
| `/sage gates [project]` | Each open question in full (G20): its text, its options, then "Recommended: …" and "Default: …" from `gates.tsv` (a line or part is left out when the logbook has no text for it), and whether it is a team vote (in the team votes file of the bridge's own project) or answered at the terminal. |
| `/sage files [project]` | Up to 10 files from the project's `files`, sorted by path, and at most 8 MB in all (`MAX_BYTES`): Discord's upload limit for a server with no boosts is 10 MB a message. The files that do not fit, in order, are listed under "N more file(s) not attached: one reply holds at most 8 MB. Ask a lead for them." and a smaller file after them still comes. |

The rules, in the order the bridge applies them:

1. A bot and a member with neither role get nothing (G20): no defer, no reply, no log line, and the ask does not count. The roles come from the interaction's member, never from text or an option. Discord then shows that person "The application did not respond", only to them; an admin can hide `/sage` from them in Server Settings, Integrations.
2. Every other command is first deferred in public (Discord shows "sage-bot is thinking" in the channel), before any file or logbook work. Each answer below is an edit of that reply, so everyone in the channel sees it (G20), and it pings nobody. When Discord refuses the defer, the bridge logs it and does nothing more.
3. Every ask of a role holder counts: 10 per person in a rolling hour across all channels, shared with mentions, in memory (a restart clears the counts). The one exception is `/sage stop` of a sage-lead or Erick: it does not count, is never over the limit, and works in any channel, so the kill switch always works.
4. Over the limit, a member with a role gets "You asked 10 times in the last hour; that is the limit. Your next ask works at 15:12." with the time as a Discord timestamp.
5. A command in a channel that is not registered, or a thread of one, gets one pointer a day (see [The channel registry](#the-channel-registry)).
6. A project that is not in the list gets `I do not know a shared project called "payroll".`, which names no other project.

Each answer comes from the project's `tasks.tsv` and `gates.tsv`, which the bridge finds with one `sage logbook` per project (kept after the first lookup that works) and reads through `pick`: only the id, title, size, state and pull request of a task, and the id, task, question, options, recommendation and default of an open gate. It never reads `decisions.tsv`, findings, briefs, reports, an answer, a why or a branch. Every logbook text goes through `safe` (the readers are people on Discord), each reply is cut to 2000 characters (Discord's limit), and every reply has `allowedMentions: { parse: [] }`. `/sage gates` and `/sage board` never reach that cut: they show the open questions that fit whole, in logbook order, then one line "N more open question(s): G7, G8." with the escaped ids of the rest. When the ids do not fit either, the line holds only the count: "402 more open question(s)." A question is never cut, and an id is never cut in that line (F-T95-1).

A file of `/sage files` is attached only when it is a regular file (not a symlink, not a folder), its real path is inside the project, its name does not start with a dot, its type is .png, .jpg, .svg or .pdf, and it is at most 8 MB. An entry that cannot be checked, such as a dangling symlink, is skipped. The bridge then opens each file with `O_NOFOLLOW` and reads it through that open file only when it is still a regular file with the device and inode of the check, so a file swapped after the check is never sent. The name of an attachment keeps only A-Z, a-z, 0-9, dot, dash and underscore; any other character becomes `_` (the readers are people on Discord).

**A mention.** A message that mentions the bot comes with the GuildMessages intent; the bridge needs no Message Content intent, so it sees only messages that mention it. A mention in a registered channel opens a thread (see [Mention threads](#mention-threads)). A member with neither role gets nothing for a mention, anywhere: no reply, no log line, and the mention does not count (G20). A mention in a channel that is not registered gets "I answer in #channel, so everyone can find the answers. Please ask there." once per person per UTC day.

**The config.** `channelId` and `askChannelId` are optional Discord ids: the bridge reads them only to make the channel registry at its first start. `projects` is a list of 1 to 25 entries `{ name, project, sagePath?, files?, repo? }`; without it, the list is the bridge's own `project` with no files, named after its folder. When that folder name makes no valid name (for example `_scratch`, or more than 32 characters), the bridge stops with a message that says so: add a `projects` entry with a valid name. The bridge and `scripts/launchd.mjs` refuse at start a name that is not lower-case letters, digits and dashes (at most 32) or not unique, a `project` or `sagePath` that is not absolute, a `files` entry with `..`, a leading `/` or dot, a `*` in a folder, or another type, and a `repo` that is not `https://github.com/<owner>/<name>`.

### Which questions go to Discord

Only the questions that sage marks as team votes go to Discord. Every other gate stays at the terminal: it gets no card, and the bridge logs one line for it, "your-project/G5 stays at the terminal: sage did not mark it as a team vote". This is the owner's decision G13: most gates are questions for the owner alone, and the team votes only on the questions that sage chooses for it.

sage marks gates with `scripts/vote.mjs`:

<!-- check: run, prints "team votes: your-project/G4" -->
```sh
node scripts/vote.mjs --project your-project G4 G5          # mark G4 and G5 as team votes
node scripts/vote.mjs --project your-project --unmark G5    # unmark G5
node scripts/vote.mjs --list                                # print the list: "team votes: your-project/G4"
```

Each command takes `--config <config.json>` first; the default is `~/.config/sage-bot/config.json`. Then `--project <name>` may follow, for the gates of a project of `projects` (see [More than one project](#more-than-one-project)); without it, the gates are of the listed project whose folder holds the current folder (the deepest one, by real path, as for the hook). When no listed folder holds the current folder, the script refuses with one line that asks for `--project`, and nothing changes; `--list` needs no project. A name that is not in `projects` is refused, and nothing changes. The list is the team votes file: `votesPath` in the config, or `<statePath>.votes`. It is a JSON object of gate keys and the folders of their projects (`{"your-project/G4": "/Users/you/your-project"}`), mode 0600, written whole with a new file and a rename. A mark counts only while its project's name names that folder. The script refuses an id that is not a sage gate id (G and digits) and then changes nothing. The bridge reads the file at each turn of the loop, and refuses a file that another user owns, that others can read or write, or that is not such an object: then it posts nothing and logs why once. A list (the format before G45 A) becomes an object once, at the next start of the bridge or run of the script: each key takes the folder that its name names then, and a bare gate id (the format before T132) becomes a key of the bridge's own project (see [More than one project](#more-than-one-project)).

- Mark the gates of one batch with one command. Each rule below works on the marked gates only: two marked gates of one task, asked within 30 seconds, share a card; 5 marked gates asked together stay at the terminal.
- A gate marked after it was added is posted at the next turn of the loop. When its task's card is already out, it gets its own card.
- A marked question about a merge is still not posted, and the bridge logs "your-project/G5 stays at the terminal: it is about a merge, and a merge never goes to a vote".
- Unmarking a gate that has a card does not take the card back.

### More than one project

One bridge posts the cards of every project in the config's `projects` (T132). At start it makes one sage state tool per project, with the project's `sagePath` and folder, and at each turn of the loop it reads each logbook in turn. **One identity per project (G43 A).** `loadProjects` in `src/projects.js` reads the config's projects once, at load, and gives each one its identity: the real path of its folder, in the letter case of the disk (`realpathSync.native`). Every part names a project only by that identity: the bridge, the hook, `/sage`, `vote.mjs`, `reasons.mjs`, `launchd.mjs` and `channels.mjs`. The project of a folder (the cwd rule, the hook) is the deepest listed folder that holds the folder's real path. Each of them refuses the config at load with one line, and changes nothing, when:

- a listed folder does not exist: "the folder of project beta (…) does not exist. Fix its path in projects, or take the project out. Nothing changed.";
- a listed path differs from its folder on disk only in letter case: "the path of project beta (…/BETA) differs only in letter case from its folder on disk (…/beta). Write it as the disk spells it. Nothing changed.";
- two names are for one folder (also by a symlink or a trailing slash): "projects alpha (…) and beta (…) are the same folder (…). Keep one of them. Nothing changed.";
- a listed path goes through a symlink to a folder that is not in git: "the path of project beta (…) is a link to (…), and the folder is not in git, so the sage state tool keeps its logbook by the path as written. Write the real path in projects. Nothing changed." (F-T132-24). The sage state tool names a folder in git by its main checkout, and any other folder by its path as written, so the bridge would read another logbook. The check asks git as the state tool does (`git rev-parse --git-common-dir`);
- the config's `project`, or a listed path, is not an absolute path (a `~` too): "the config: project must be an absolute path" (F-T132-25), checked before anything reads the disk;
- the config's `project` is not listed (see below). A logbook that cannot be read at a loop (for example a sage state tool that fails) is logged ("beta: the bridge could not read the logbook; it tries again: …") and never stops the other projects.

Each logbook has its own G1, so the bridge names a gate by its key: the project name, a slash and the gate id, for example `beta/G1`, or `beta/G1+G2` for a batch. The key is in each place that names a gate:

| Place | Example |
| --- | --- |
| The gate file | each entry's `gate.id` |
| The team votes file and the leads-only file | `{"beta/G1": "/Users/you/beta", "your-project/G4": "/Users/you/your-project"}` |
| The card's buttons and forms | `press:beta/G1:0:1` |
| The card title | `Question beta/G1 · T1 …` |
| The ping above the card | `beta T1 needs one product answer. The first answer is final.` |
| The tie post, the reminders and the log | `beta/G1+G2 is tied after its vote.` |

- A press goes to the gate of its key, and the answer goes to that project's logbook only. A press on `beta/G1` never changes `your-project/G1`.
- A button whose id has no project, or a project that the config does not list, finds no gate: the person gets "I do not know this button or its question. Nothing changed." The one exception is a card of the time before T132 that still has its old buttons (see below).
- A card of a project that left `projects` takes no press: the person gets "This question's project is no longer served; Erick answers it at the terminal.", the log says it once per card, and sage of that project gets nothing from the bridge.
- The bridge reads no logbook of a project that left `projects`, so it cannot see Erick's answer there. Such an entry gets no post, tick, reminder or held message, and its questions do not count as open, so its session thread can lock (G15). The bridge closes each open card of such a project once in total: an edit takes the buttons off and adds the note "This question's project is no longer served; Erick answers it at the terminal.", and the body drops its rule, reminder and who-can-answer lines (the footer of a batch) for the line "**Closed:** this question's project is no longer served; Erick answers it at the terminal." (F-T132-20), and the log says "`beta/G1`: its project is no longer in the config, so the bridge closed its card; Erick answers it at the terminal". The entry gets the mark `shut` in the gate file, so a restart does not close it again. An edit that can never work (a locked thread, code 50083, or a message or channel that is gone, code 10008 or 10003) also sets the mark, and the log says so once. Any other refused edit is tried again at the next loop. A settled card stays as it is.
- When a project comes back to `projects`, each loop edits its cards with the mark `shut`, after it opens their session thread again, and the mark goes when Discord takes the edit: the card gets its buttons back and loses the note. Until then the card gets no reminder.
- **A project's name stays the name it had at its first start.** Every key, mark and thread title holds the name, and the bridge knows a project only by it: there is no rename. The name is in each card title (`Question sage-bot/G1`), each thread title and each key of the team votes file. At start, the bridge logs one line that names every entry of the gate file and every mark whose project is not in `projects`, for example "the gate file holds cards of project 'project', which is not in projects: G1, G2; the marks name gates of project 'project', which is not in projects: G1, G2, G3; keep a project's name as it was at its first start". After a rename anyway, a gate of the new name whose card is under an unlisted name (same gate id, task id and question) gets no second card, and the log says "`alpha/G1` stays at the terminal: its card is `project/G1`, of project 'project', which is not in projects; …". A gate with a mark only under an unlisted name logs "it has no mark of alpha; the mark is `project/G3`, …", never "sage did not mark it as a team vote". The repair is to put the old name back in `projects`.
- The owner's answer at the terminal is final in each project (G10): the bridge reads each project's own gate rows.
- A session of a project gets its line and thread in the home channel, as for one project, and the thread title names the project: "Session 3 · beta · Tue 4 Oct".
- `scripts/reasons.mjs` takes `--project <name>` too. Like `vote.mjs`, it refuses with one line that asks for `--project` when no listed folder holds the current folder (F-T132-22), and it reads only a card of the project's folder now.
- **A name and its folder (G45 A).** Each entry of the gate file (field `folder`) and each mark holds the identity of its project: the real path of its folder from `loadProjects`. A session's spool holds it as `cwd`. The buttons keep the key only (`press:beta/G1:0:1`), within Discord's 100 characters. When the owner points a name at another folder (or swaps two names), the old entries and marks are of a project that the config no longer serves: at the start, the bridge logs "the gate file holds cards of project 'beta', of the folder /Users/you/beta, which projects no longer give that name: G1; …", closes each open card once with the note above ("`beta/G1`: its project's name now names another folder than /Users/you/beta, so the bridge closed its card; …"), and never sends it an answer or shows an answer from the new folder on it. Its marks do not count for the new folder: such a gate logs "stays at the terminal: its mark is of the folder …, not of beta's folder now. Mark it again with scripts/vote.mjs". When the new folder's gate has the same key as an old card, only a press on the new card's own message counts; a press on the old card gets "This question's project is no longer served; …". Point the name back at its folder to serve the old cards again.

**The bridge's own project.** It is the listed project whose identity is the real path of the config's `project`: a trailing slash or a symlink names the same folder. If no listed project has that folder, the bridge (before the lock and Discord), the hook, `vote.mjs` and `reasons.mjs` stop with "the config's project (…) is not in its projects. Add it to projects, with a name. Nothing was started." They never take the first project instead.

**From one project to many.** The first start after T132 moves the gate file to version 3: each entry gets the key of the bridge's own `project`. Each entry with a card gets the mark `oldButtons`, kept in the gate file. Each loop edits every card with the mark, open or settled, and the mark goes only when Discord takes the edit; so a stop or a failed edit leaves it for the next loop. Until then, a press on an old button (a bare id) of that card counts on the card's key, and a press on a settled card gets the usual "Already answered" note. At the same start, under the lock of `vote.mjs`, the bare ids of the team votes file and the leads-only file become keys of the bridge's own project, once; `vote.mjs` does the same if it runs first. After that, a read refuses a bare id. Spool files with no project are of the bridge's own project and its folder; the hook never writes over a spool file that it cannot read or check (F-T132-23).

**The folder update (G45 A).** The first start after G45 A moves the gate file to version 4: each entry takes the folder that its project's name names at that start. Under the lock of `vote.mjs`, the team votes file and the leads-only file become objects of key and folder in the same way, once; `vote.mjs` does the same if it runs first. An entry or mark of a name that is not in `projects` then gets no folder (null) and is never served again. The start log says it once: "one-time update: each card and mark now holds the folder of its project (beta: /Users/you/beta, …); …".

### Leads-only questions

The owner's decision G18 (item 8): sage may ask whether to switch on its automatic-merge mode for a session. The sage-leads only recommend Yes or No, and the owner decides at the terminal. This is the only leads-only question. sage asks it as a normal sage gate with exactly this question and the options `Yes|No`, then marks it leads only:

```text
Switch the automatic-merge mode on for this session?
```

<!-- check: skip, it needs a sage logbook that holds the gate; test/t73-leads.test.js runs it -->
```sh
node scripts/vote.mjs --leads G6     # mark G6 as leads only
```

- The leads-only file is `<team votes file>.leads`, in the format of the team votes file, and the bridge refuses a bad one the same way: then it posts nothing and logs why once. A gate is in one of the two lists at most: a mark moves it, and `--unmark` clears it from both.
- `--leads` takes one gate id. Two or more ids are refused: "a leads-only question is one Yes or No question, never a batch". The bridge also posts a leads-only gate on its own card, never in a batch.
- `--leads` reads the gate from the logbook of the project (`--project`, or the bridge's own). It refuses, exits 1 and changes nothing when the gate is not in the logbook, when its question is not the text above word for word ("G6 is leads only, and a leads-only question must be the automatic-merge question, word for word: …"), or when its options are not Yes and No. The question is `LEADS_QUESTION` in `src/bridge.js`. So a lead never answers a merge of a pull request or any other decision of the owner.
- The bridge checks the same again for a file that someone edited by hand: it logs "not posted: G6 is leads only, and a leads-only question …" and the question stays at the terminal. So every text that the bridge writes about the answer comes from Yes and No.
- A gate id in both files is an error: the bridge posts no card for it and logs "your-project/G6 stays at the terminal: it is in both the team votes file and the leads-only file. Mark it again with scripts/vote.mjs". A mark saves the file that loses the gate first and then the file that gains it, so a read between the two saves can find it in both. When the bridge finds a gate in both, it reads the two files again; only a gate that is still in both gets the line and no card. So a mark during a read never gives the line, and the card comes on that loop or the next.
- The leads-only question names the automatic-merge mode, and it is posted: the merge guard is for team votes, and here the owner decides.
- The card is titled "Recommend for Erick: Question your-project/G6 · …". It pings the sage-lead role only, with "your-project T5 asks the sage-leads for a recommendation to Erick. The first sage-lead answer is the recommendation; Erick decides at the terminal." Its rule line says the same, and its 2-hour reminders ping sage-lead only.
- A press from a sage-apprentice gets the private note "Only a sage-lead can answer this. Erick decides." and does not count. A press from a member with neither role gets no reply and does not count (G20).
- The first lead's press closes the card: "Recommended by Jon (sage-lead) at 15:30: A. Yes. Erick decides at the terminal." The bridge gives sage "A. Yes (sage-leads recommend; the owner decides)" with `sage gate answer`, so the logbook shows the leads' advice and never the owner's decision. It posts "Recommendation recorded: Jon recommends Yes. Erick decides at the terminal." where the card is, and logs one line. For Yes: "G6: sage-leads recommend Yes. If you agree, switch the mode yourself at the terminal." For No: "G6: sage-leads recommend No. If you agree, do nothing; the mode stays off."
- A press after the recommendation gets the private note "Already recommended by Jon (sage-lead): A. Yes. A recommendation only; Erick decides at the terminal. Your press did not count." Erick also holds sage-lead, so Erick can press in Discord; that press is a recommendation like any lead's, never Erick's final answer. Erick decides only at the terminal.
- The leads-only texts name the owner "Erick", also when the owner is not in the server's member list (never "a member" or "member …0001").
- The owner's answer at the terminal is final (G10), before or after the leads' press, also when it is "A. Yes": only the marked text is the bridge's own, so the bridge never writes over the owner's answer. To switch the mode, the owner types the mode's own message at the terminal. sage-bot never switches a mode, never writes sage's hook state, and no text of sage-bot holds a mode's switch message.

### How a sage gate becomes a card

The bridge runs the sage state tool with `execFile` (no shell): `sage logbook` finds the logbook, and `sage gate answer <G> <answer>` records an answer. It reads `gates.tsv` and `tasks.tsv`, and never writes a logbook file itself.

| Case | What the bridge does |
| --- | --- |
| One open gate of a task | A single question. The options are sage's options (`a\|b`), as A to E. The recommendation and the default mark the option with the same text or letter. |
| 2 to 4 open gates that one task asked together | One batch vote, one part per gate, in the order of the logbook. "Together" means that sage's `at` of each gate is at most 30 seconds after the first one; gates further apart get their own cards, also after a restart. The card's id is the project name, a slash and the gate ids joined by `+`, for example `your-project/G3+G4`. The bridge waits 30 seconds after the newest gate of a task, so that sage's `gate add` commands of one batch land on one card. |
| 5 or more gates that one task asked together | Refused: no card. The terminal shows "not posted: T2 asked 5 questions together, and a batch holds at most 4 parts. Answer them at the terminal." once. They stay at the terminal until each one has an answer: the answered ones still count, so no later card takes the rest. |
| A gate that a task adds after its card was posted | Its own card, also within 30 seconds of the first. |
| A gate with no option or more than 5 | Refused the same way: one row of Discord buttons holds 5. |
| A marked gate whose question or options name a merge ("merge", "merges", "merged", "merging") | Not posted. Merges never go to a vote; they stay at the terminal. |
| A new card | The post mentions the sage-apprentice and sage-lead roles, and only those roles: "T7 has 3 product questions. Vote on each part within 30 minutes." or "T8 needs one product answer. The first answer is final." |
| The owner answers a posted gate in the chat, and sage records that answer with `sage gate answer` | Final, whatever the owner's roles. The card shows "Answered by Erick (terminal) at 14:05: B. text. Final." on that question, or on that part of a batch, and its buttons go grey. A press on it gets "Already answered by Erick at the terminal: … Your press did not count." The other parts of a batch keep voting, and the leads never get a tie for an answered part. The answer is no ballot. |
| An answer in the logbook that the bridge did not write | The owner's: sage recorded it with `sage gate answer`. The bridge reads the logbook before each press and again before each `sage gate answer`, and never gives sage an answer for a gate that the owner answered. |
| sage answers an open single gate with text that names no option | A withdraw by the asker (the owner): the card closes as withdrawn. A withdraw comes only from sage, never from Discord. On a part of a batch, such text is the owner's final answer to that part. |
| A single gate is answered in Discord | The bridge gives sage "B. Show a Session ended screen" (the letter and sage's option text). |
| A batch closes as decided | The bridge gives sage the answer of every part, the same way. It acts only on the `'closed'` effect, never on a part's `'decided'` effect, which is provisional while another part is tied. A withdrawn gate gives sage nothing. |
| A batch vote ends with tied parts | A post to the sage-lead role with each tied part and each voter's argument (the reason, made safe for the card and cut to 200 characters). The 2-hour reminders count from this post, so one loop never pings the leads twice, also after a sleep. |
| A member gets or loses the sage-apprentice or the sage-lead role | At the next turn of the loop the bridge redraws each open card, so the card counts the same votes as the tick. |
| A lead breaks a tie | A post that names the lead: "Jon (sage-lead) broke the tie on part 2 of G3+G4: A." No one is pinged. |
| The gate changed | The bridge edits the card with `card()`: after a ballot, a tick, an end, a tie-break, a terminal answer or a withdraw. A press after the time limit that the vote rules refuse still ends the vote first, so the bridge settles that too. |

Only a Discord id (17 to 20 digits) goes into an event's `by`. A press from any other user id gets "I do not know this account. Nothing changed." The holders and leads are Sets, read fresh from the guild members at each press and each turn. When `handle` throws (a card that cannot be built), the person gets "The bridge could not handle this press. Nothing changed. Please tell the owner." and the gate stays as it was.

### The gate file

The bridge keeps its gates, their asks, the owner's final answers and what it gave sage in one JSON file, `statePath` in the config. One bridge at a time: at start it takes `<statePath>.lock`, which holds its pid and its start time (from `/bin/ps`). It writes them to a temp file and links that file to the lock name, so the lock is never empty and only one of many starts gets it. When the lock belongs to a bridge that runs (a process with that pid and that start time), the new bridge stops with "another sage bridge (pid 4242) runs on …". It replaces a lock of a process that is gone, of another process that got the pid after a reboot, or with its own pid. A lock with no start time (empty, or written by an earlier version) counts as held for 10 s, then it is replaced; in that time a start stops with "a sage bridge may still be starting … Try again in 10 s, or remove <lock>". When `/bin/ps` fails for another reason than "no such process", the start stops with "could not check whether the bridge with pid N still runs" and leaves the lock: it never replaces the lock of a bridge that it could not check. A lock that the bridge cannot read (no read permission, or a folder) stops the start with a message that names the path. Only one start at a time removes a stale lock, under `<lock>.break`; a start that finds a break file of under 10 s stops and names it, and a later start removes an older one. A start also removes the temp files `<lock>.<pid>.tmp` of starts that crashed (their pid no longer runs). An exit removes the lock, also a stop by SIGTERM (launchd at logout or shutdown), SIGINT or SIGHUP. Only the bridge writes it: its folder is mode 0700 and the file 0600, and each save writes a new file and renames it over the old one, so a crash never leaves half a file. At start the bridge refuses a file that another user owns or that others can read or write, and it loads each gate with `parseGate` on the output of `JSON.parse`. It loads gates from this path only, never from Discord or a shared folder.

The file is version 3: each entry's gate id is its key (`your-project/G3+G4`, see [More than one project](#more-than-one-project)), each entry has its sage session (`session`, or null when none is known) and the channel or thread of its card (`channel`), and the file has the sessions that have a line (their number, thread title, line and thread ids, and whether the thread is locked). The bridge also loads a version 1 or 2 file: their gate ids get the key of the bridge's own `project`, and the bridge saves version 3 at once. A version 1 file has no sessions: each card stays in the parent channel with its tie posts and reminders, and the bridge still edits it there.

### Run it

The steps to set up the bridge are in the README: [Set up a live trial](../README.md#set-up-a-live-trial). These are the details behind them.

1. **The Discord app.** A Discord application with a bot user in your server, with the Server Members intent on (Message Content off), invited with the `bot` and `applications.commands` scopes, and the roles sage-apprentice and sage-lead. Each person has one of them, never both.
2. **The Keychain item.** Put the bot token in the macOS Keychain as a generic password with the service name `sage-bot`, with Keychain Access (File, New Password Item: name `sage-bot`). Do not type it in a command, because the shell history keeps it. At start the bridge reads it with `/usr/bin/security find-generic-password -s sage-bot -w`. It never writes the token to a file, a log or an error. When the item is missing, the bridge stops with: "no bot token: the macOS Keychain has no generic password with the service "sage-bot". Add it with Keychain Access, then start the bridge again."
3. **The config file.** Copy `examples/config.example.json` to a folder of your own, for example `~/.config/sage-bot/config.json`, and fill it in: the Discord ids of the guild, the owner and the two roles, and, for the first start, the home channel (`channelId`) and optionally a channel for `/sage` (`askChannelId`), see [The channel registry](#the-channel-registry); the projects that `/sage` reads; the sage project folder; the path of the sage state tool (`sage.mjs`); and `statePath`, the gate file. The team votes file is `<statePath>.votes`, or `votesPath` when you set it.
4. Start it: `node scripts/bridge.mjs ~/.config/sage-bot/config.json`. It logs to the terminal; every log line goes through an allow-list, so no control character reaches the terminal. Of a Discord error it logs only the code, the status and the message, never its url or body (they can hold an interaction token).

**The launchd plist.** To start the bridge at each login and again after it stops, write its launchd agent:

<!-- check: run, prints "wrote " -->
```sh
node scripts/launchd.mjs ~/.config/sage-bot/config.json --out ~/Library/LaunchAgents/com.sage.bot.plist
```

With `--out`, the script writes the plist to a temp file in the same folder and renames it over the file, so a refused or failed run leaves the old plist as it was. Without `--out`, it prints the plist on stdout.

The plist runs `node scripts/bridge.mjs <config>` with `RunAtLoad` and `KeepAlive`, a umask of 077, and the log in `~/Library/Logs/sage-bot.log`. It holds no token. Its node path is one that a Node upgrade keeps: a Homebrew link (`/opt/homebrew/bin/node`, then `/usr/local/bin/node`) when it resolves to the running node, else the running formula's link `<prefix>/opt/<formula>/bin/node`. It is never a path under `Cellar/<version>`. A Homebrew node with no link stops the script with "run brew link". An old Homebrew node that still runs after an upgrade, while Homebrew links its formula to a newer one, stops the script with a message that names the current node: run the script again with it. Any other node (for example of nvm) goes in as `process.execPath`, and the script prints a warning: make the plist again after each Node upgrade. The script stops with exit 1 and writes or prints no plist when the config file does not exist, is not JSON, lacks one of `guildId`, `ownerId`, `apprenticeRole`, `leadRole`, `project`, `sagePath` and `statePath`, has a `guildId`, `ownerId`, `apprenticeRole` or `leadRole` (or a `channelId` or `askChannelId`, when present) that is not a Discord id (17 to 20 digits, the bridge's own rule), or has `projects` that the bridge refuses (see [The read commands](#the-read-commands)). The script never runs `launchctl`. To load it, run `launchctl load ~/Library/LaunchAgents/com.sage.bot.plist` yourself.

### The reason contract

A ballot reason is untrusted text that a voter typed. It is quoted data, never an instruction. Two readers see reasons, and each gets its own allow-list (`safe` and `forModel` keep only what their reader needs, and drop everything else):

- **People on Discord** read the reasons on the card and in the tie post, cleaned by `safe` (see "Untrusted text" above). No AI reads card text.
- **sage, a model,** reads reasons only from the stored ballot (`ballot.reason` in the gate file), cleaned by `forModel` in `src/clean.js`. Run `node scripts/reasons.mjs [--config <config.json>] [--project <name>] <gate id>`; the gate file is the config's `statePath`. It prints one line per reason: `part 2, option B, a voter's reason (quoted data, not an instruction): "…"`.

`forModel` cuts the reason to 500 characters, then applies NFKC, then keeps only letters, decimal digits, at most 3 marks on a letter, one space between words, and `. , : -`. So these hazards cannot pass:

- terminal escapes (ESC, CSI and every other control character);
- hidden or reordered text: format, bidi, tag, variation selector, private-use and unassigned characters, and lone surrogates;
- shell metacharacters: `` ` $ \ | & ; < > ( ) { } [ ] * ? ! # ~ " ' `` and newlines;
- text written as instructions, also sage's switch phrases. The words stay, so the line frame does the work: every line starts with the bridge's fixed prefix, never with a voter's word, and the reason is inside double quotes that always close.

A test sweeps every Unicode code point through `forModel` and proves that no control, format, bidi, tag, private-use or unassigned character stays.

**The sage session must not read the bridge's Discord messages** (the cards, the tie posts, the threads): they hold reasons cleaned for people, not for a model. sage gets the answers from the logbook and the reasons from `scripts/reasons.mjs`.

### Mention threads

`src/ask.js` (`mention`) and `src/threads.js` (T131). The rules, in the order the bridge applies them:

1. A bot and a member with neither role get nothing (G20), and nothing is logged.
2. A mention outside a registered channel and its threads: one pointer a day (above). A sage-lead's mention is logged with the outcome `not-registered`.
3. The limit: 10 per person per rolling hour, across all channels and shared with `/sage`. A mention that opens a thread counts once. Over it, one note in place until the hour frees up (outcome `over-limit`).
4. A mention in a thread of a registered channel that is not in the thread map (a thread that sage-bot did not open, a session thread, or a forum post) gets one reply in place: "I answer in my own threads. Mention me in #channel and I open one for you." For a forum post, #channel is the first registered channel.
5. A mention in the registered channel itself opens a public thread from the message (auto-archive after one day). Its name is the request with the mention tags taken out, cleaned for the terminal (printable characters only), on one line, at most 80 characters, or "sage-bot request". A sage-lead's mention with the word "talk" opens a lead thread; every other mention opens an answer thread. When Discord refuses the thread for a missing right (codes 50001 and 50013), the reply in place names "Create Public Threads"; when it refuses the post in the thread, "Send Messages in Threads".
6. In the thread: a sage-lead's "talk", and every mention in a lead thread, is a would-be delivery to sage. The bridge checks the kill switch, writes the log line, and replies with the dry-run text ("Recorded in the lead log. Sessions with sage are not on yet, so nothing goes to sage. …") or, while the switch is set, the fixed text ("The link from Discord to sage is off. …"). A sage-lead's talk in an answer thread first turns it into a lead thread (G27): the bridge writes each held apprentice mention of that thread to the log, in order, as quoted data with the outcome `earlier`, then records the thread as `lead` in the thread map. A lead's read ask keeps it an answer thread. No sage session starts: no code in `src/` can start a `claude` process (a test checks that only `/bin/ps`, the Keychain tool and the sage state tool run as child processes).
7. Any other mention in a thread is a read ask: a task id (`T7`) gets `/sage task`; else the first of `board`, `gates` (or `questions`) and `files` gets that command; any other text gets the pointer to these words. A sage-lead's read ask is logged with the outcome `read-ask`. An apprentice's mention in an answer thread is not logged; the thread map holds it until a lead talks there. Every post pings nobody.

**The thread map** is `<statePath>.threads`: `{ "version": 1, "threads": { "<thread id>": { "kind": "answer" | "lead", "channel", "project", "by", "at" } } }`. An answer thread also has `held`: the apprentice mentions there, each `{ "id", "user", "roles", "content" }`, in order. A lead thread has no `held`. It is safe like the channel registry (0600, written whole by a rename, read with `O_NOFOLLOW`; a bad file stops the start). It is a file of its own, not a part of the gate file: the bridge's loop rewrites the gate file whole from memory, so a second writer there would lose lines.

**The lead log** (`src/audit.js`) is `auditPath` in the config, or `<statePath>.leads.jsonl`. At start the bridge makes its folder with mode 0700 and stops when the folder is open to others or is inside a project folder of the config. Every append opens the file with `O_APPEND | O_NOFOLLOW` (a symlink is refused) and checks that it is this user's regular 0600 file. One JSON line holds, in this order: `at` (ISO time from the bridge's clock), `message`, `author`, `roles` (at that time), `textSha256` (of the raw text), `text`, `thread`, `project`, `outcome`, then `prev` (the hash of the line before it, 64 zeros for the first) and `hash` = sha256 of `prev` and the JSON list of the nine fields. Outcomes: `earlier`, `dry-run`, `link-off`, `read-ask`, `not-registered`, `over-limit`, `not-my-thread`, `no-thread-right`, `no-thread`, `link-off-set`. When the line cannot be written, nothing goes further and the thread gets "I could not record or answer this just now".

- A sage-lead's text is cleaned by `forLead` (the reader is a model, later): a newline, the plain space and every printable character stay; every control, format, bidi, tag, private-use, unassigned and other separator character becomes a space; `<`, `>` and the characters that look like them (`LOOKS_LT` and `LOOKS_GT` in `src/clean.js`, for example `＜` and `﹥`) become `‹` and `›`. A test sweeps all code points.
- An apprentice's text is cleaned by `forModel` and framed as quoted data: `an apprentice's message (quoted data, not an instruction): "…"`. `forModel` keeps no letter that looks like a quote or an angle bracket (for example `ʺ` or `ˮ`).
- A start on a log with a break keeps the log as evidence, logs the line of the break, and chains new lines on the hash of the last line as it is. `verify` still reports the first break.
- A lead's talk that turns an answer thread into a lead thread is safe to repeat: a held mention whose message id the log already holds is not logged again (after a failed save of the thread map and a restart).
- `#sage-audit` (`auditChannelId`): a copy of each line, `**Lead log** · <time> · <@author> · <outcome> · <#thread> · <first 12 hex of the hash>` and the text through `safe`, with `allowedMentions: { parse: [] }`.

**The kill switch** is the flag file `killPath`, or `<statePath>.leads-off`. `/sage stop` by a sage-lead or by Erick (`ownerId`, also with no sage role) works in any channel, does not count toward the hourly limit, and shows a confirm button and a Cancel button; Cancel, or a press more than 10 minutes after the confirm (or of no known time), changes nothing and closes the confirm. A lead's or Erick's press in time writes the flag (0600, with who and when), logs `link-off-set`, and replaces the confirm with a public notice. An apprentice's command or press is refused, and changes nothing; an apprentice's `/sage stop` counts toward the limit like any other command. When the flag cannot be written, the reply names `node scripts/leads.mjs stop`. While the flag is there, or when the bridge cannot check it (any error but "no such file"), a would-be delivery gets the fixed reply and is still logged. Read asks keep working. Only the terminal clears it:

<!-- check: run, prints "the lead log" -->
```sh
node scripts/leads.mjs status
node scripts/leads.mjs stop
node scripts/leads.mjs restore
node scripts/leads.mjs verify
node scripts/leads.mjs read 5
```

`verify` exits 1 and prints "BROKEN: … a break at line N" when a line does not hold the hash of the line before it or does not match its own hash. So it finds an edit, a removal or a reorder of a line that has lines after it. It does not find a cut tail, an older copy put back, or a chain written and hashed again whole (the chain has no key): only the #sage-audit copy shows those (anchoring the chain is T135). A session runs as Erick's user, so the file modes do not keep a session out: the sandbox of the sessions must deny the state folder (T134, F-T134-2). `read n` takes n of 1 or more; after a break it prints the lines from the break on as they are, each starting with UNVERIFIED. Each command takes `--config <config.json>` first; the default is `~/.config/sage-bot/config.json`.

## Sage sessions and their threads

The parent channel (for example `#sage`) is read only for people. It has one line for each sage session that has a team vote, and the bridge edits that line in place. Each line starts a thread, and the session's cards go to that thread. The tie posts, reminders, tie-break notes and wake notes of a card go where the card is. There is no "New session" button: a session starts at the owner's terminal.

| Case | What the bridge does |
| --- | --- |
| A session | One Claude Code session id. A `/clear` starts a new session id, so it gets a new thread. A resume keeps the id, so it opens the old thread again. |
| A session with no team vote | No line and no thread. |
| The first team vote of a session | The bridge gives the session the next number of the project, posts its line, starts the thread from the line with the title "Session 14 · your-project · Tue 4 Oct" (the session's project, then the weekday and date of the session's start, in the Mac's time zone), and posts the card in the thread. Lines are posted in this order, so the newest is at the bottom. |
| The line | "**Session 14 · your-project · Tue 4 Oct**" and "running · 4 tasks · 2 open questions". The tasks are the session's tasks with a gate; the open questions are the questions of its cards that still wait for an answer. The bridge edits it when a number changes. |
| A gate that no hook saw | It goes to the newest running session of its project. With no running session it goes to the parent channel, as before T29 (for example before the owner adds the hooks). A card in the parent channel stays there with all its posts, also when a session starts later. |
| Two spool files list the same gate id (for example from an older logbook) | The gate goes to the session that started last before sage asked the gate. |
| Discord refuses the line or the thread (for example without Create Public Threads) | The card goes to the parent channel, and the log says the refusal once. The next card of the session tries again. When Discord made the thread but its answer was lost (code 160004 at the next try), the bridge takes the thread of the line. |
| A member deletes a session's thread, or the bot loses access to it (code 10003 or 50001) | The card goes to the parent channel in the same turn of the loop, and the log says it once. The next card of the session starts a new thread from the line. When the line is gone too, or Discord keeps the deleted thread on the line, that card posts a new line and starts the thread from it. The cards that were in the deleted thread are not posted again. |
| A session ends (SessionEnd, a `/clear`, or its Claude Code process is gone) | The line says "ended" and the time at once. The thread stays open while a question of the session waits: the team votes on there, and the reminders and tie posts go there. At the first turn of the loop after the last question is answered, decided or withdrawn, the bridge archives and locks the thread. A later card of the session opens the thread again. |
| A resume of an ended session | At the next turn of the loop the bridge opens the thread again (unarchives and unlocks it) before it posts or edits anything in it, and the line says "running" again. |
| A press in a thread of the parent channel | It counts, also when the thread is not in the bot's cache: the bridge then asks Discord for the thread. A press in another channel, or in a thread of another channel, is ignored. |

**The hook.** `scripts/hook.mjs` records the sessions. Claude Code runs it at SessionStart, at SessionEnd and after each Bash command (PostToolUse). It reads the hook's JSON on stdin and writes one spool file per session in the spool folder: `sessionsPath` in the config, or `<statePath>.sessions`. The folder is mode 0700, each file 0600, and each write is a new file renamed over the old one.

- SessionStart writes the session id, the folder, the start time and the pid of the Claude Code process. A resume takes away the end.
- After a Bash command that runs the sage state tool with `gate add` (`node <path>/sage.mjs gate add T7 …`), it reads the fixed line of its output ("G42 open · …"), and adds the gate id and the task id of the command to the session. Any other command is ignored, also when its output has such a line.
- SessionEnd writes the end. A session whose Claude Code process no longer runs also counts as ended.

The hook never blocks or fails a session: it always exits 0 and prints nothing on stdout. It refuses input that is not a hook's JSON, a session id that is not a UUID, a config whose `projects` the bridge refuses (or with no `project` when it has no `projects`), and a config whose `project` is not one of its `projects`; then it writes nothing and prints one line on stderr. It records an event in the folder of any project of `projects`, or in a folder inside it (a subfolder, a worktree in it, also through a link), and ignores the first event of a session in any other folder without a line. For project folders inside each other, the deepest one is the session's project. The spool file names the session's project (`project`). A session keeps the project it started in: once its spool exists, each later event (also a `gate add` or the end in a nested project's folder, or in a folder outside every project) is of the spool's project, not of the cwd's (G43 A, F-T132-19). It ignores a `gate add` whose `--project` names a folder outside the session's project. In `--project`, a leading `~`, `$HOME` or `${HOME}` is the hook's HOME; a `gate add` whose `--project` has any other `$` or a backtick is ignored, because only the shell knows that folder. A folder whose name starts with two dots (for example `..cache`) is a folder inside the project. Its config is `~/.config/sage-bot/config.json`, or the file after `--config`.

**What the owner adds.** The owner adds the hook lines, the Discord permissions and a deny rule for the Discord plugin's `fetch_messages` tool; the bridge changes no settings file. The README's [setup checklist](../README.md#set-up-a-live-trial) shows each one. The tie posts in a thread hold reasons cleaned for people, not for a model, so sage must not read them (see "The reason contract").

**The thread of a session.** `node scripts/session.mjs [--config <config.json>] thread <session id>` prints the thread id of a session, from the gate file. A session with no thread yet, or an id that is not a UUID, gives one line on stderr and exit code 1:

<!-- check: run, exit 1, prints "has no thread yet" -->
```sh
node scripts/session.mjs thread aaaaaaaa-0000-4000-8000-000000000052
```

## The guard for lead sessions

`scripts/guard.mjs` is a Claude Code PreToolUse hook for a sage session that sage-bot starts for a sage-lead (T133, step 5 of the T72 plan). Its rules are in `src/guard.js`. It is built and tested, and not installed anywhere yet.

**The split.** A hook sees only the text of one tool call. It cannot see what a program does with files once it runs, so the guard does not try. A text hook never guarantees a file or network boundary; only the sandbox does (G44 A). Four parts limit a lead session, and each holds only what it can see:

| Part | Holds | Built in |
| --- | --- | --- |
| The guard hook | A second layer, by the text of each call. It cannot see what a script that the session writes does when it runs. Which tools run; which commands, subcommands and options a Bash call names; one simple command per call, or allowed commands joined by `&&`; the rephrase hints; as a second layer, no call that names the sage state tool (the class rules below); no agent with an isolation field; WebFetch only to a URL whose host, as text, is a public name or a global unicast address (a name that resolves to a local address passes). | T133 (this hook) |
| The Claude Code sandbox | Every Bash command and every process that it starts (`node`, `npm` scripts, git hooks, subagents): it fails closed; reads only in the worktree and the session's own scratch folder (F-T134-13); the sage plugin folder and every logbook denied, which is the guarantee that a lead session cannot run or change the state tool (test F-T134-6 proves that each known bypass fails there; F-T134-12 denies each of those paths again where a wider rule opens it); secret files denied; a strict list of hosts, with no GitHub; the GitHub token variables removed (F-T134-1). Only the broker runs outside it (`excludedCommands`). The sage state tool must not be in `excludedCommands` for a lead session (G30 A, F-T134-6). | Step 6 (T134) |
| The permission rules | The Read, Edit and Write tools, which the sandbox does not cover: Read denied for secret files; Edit and Write only in the worktree and the scratch folder; the Grep tool denied. WebFetch has no permission rule yet, and the hook checks only the host text in the URL, so today nothing limits where WebFetch connects. T134 adds the WebFetch permission rule, an allow list of hosts (the policy module T156 generates it). | Step 6 (T134) |
| The broker `sage-bot-github` | GitHub: a fetch, an upload to the session's own branch, and the session's own pull request (create, edit, view). Nothing that merges (F-T134-1). | Step 6 (T134); owner question G28 is open, default A (the broker) |

`autoAllowBashIfSandboxed` makes permission allow rules useless as a Bash allow-list, so the hook keeps that job.

**How step 6 installs it.** sage-bot starts each lead session as `claude -p` in dontAsk mode, with a settings file of its own (`--settings`). That file holds this hook for every tool, with an explicit timeout in seconds, and turns the sandbox on so that it cannot fall back to running a command outside it:

```json
{
  "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "node /path/to/sage-bot/scripts/guard.mjs", "timeout": 30 } ] } ] },
  "sandbox": { "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false }
}
```

Step 6 adds the sandbox's folders, secret patterns, hosts and `excludedCommands`, and the permission rules, by the Claude Code documentation of the version it runs, and proves each one in a scratch `HOME`. Step 6 must also hold these, which the old guard held by path and this hook does not:

- The repository's `.git` folder: a worktree commit writes objects and refs there, but `.git/config` and `.git/hooks` must stay read-only. A hook script there runs in the owner's next commit, outside the sandbox. A worktree in the scratch folder, cloned from the repository, avoids the shared `.git` (F-T134-3).
- `.claude/settings*.json` and `.mcp.json` in the worktree: no write from Bash or from the Edit and Write tools (F-T134-4).
- sage's mode and autopilot state in `$TMPDIR/sage-hooks`: out of the sandbox's write folders (F-T134-7), and denied for reads (F-T134-12).
- No `excludedCommands` entry for the sage state tool, and no read or write of the logbooks (`~/.claude/sage`) in the sandbox or the permission rules. The hook refuses each call that names the state tool, but it cannot see a copy under another name or a script that builds the name (see below). A lead session reaches the logbook only through the few fixed broker verbs of T134, with the project fixed (F-T134-6).
- The sage-bot config, its token, the lead log and the kill-switch flag: outside the worktree and the scratch folder (F-T134-2).

The guard decides in well under a second: it reads no file, it refuses an input over 64 KB before it parses it, and its parser is linear. The timeout of 30 seconds leaves room for a slow start of `node`. A hook that runs past its timeout does not block the tool call (F-T134-13), so the timeout must stay far above the guard's time.

It reads these variables from the environment of the `claude` process. The hook inherits them, and the session's model cannot change them.

| Variable | Value |
| --- | --- |
| `SAGE_ORIGIN` | `lead`. With any other value, or with none, the hook allows everything and prints nothing: the owner's sessions are unaffected. |
| `SAGE_TOOL` | Optional: the sage state tool, `sage.mjs`. The hook refuses each call that names the file name of this path or `sage.mjs`. |

**What it answers.** No output and exit code 0 allows the tool call. A refusal prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`. The reason names the action. When a safe form of the same action exists, it ends with "sage can do this instead: …" and that form. Otherwise it ends with "This needs Erick; tell the sage-lead and stop this action." A malformed stdin, a tool call with no input, or a crash refuses too (a crash exits with code 2).

**How to rephrase.** These are the safe forms that the refusals give:

| Refused | Safe form |
| --- | --- |
| A command that the guard cannot read: `$`, a backtick, a heredoc, `(`, `{`, `\`, `;`, `\|\|`, a newline. For example `git commit -m "$(cat <<'EOF' …)"`. | Write the text to a file in the scratch folder, then `git commit -F <file>`. One simple command per call, or commands joined by `&&`. |
| `gh`, `git push`, `git fetch` | `sage-bot-github`, the broker of step 6 |
| The Grep tool | `rg` in Bash, for example `rg -n <pattern> <folder>` |
| `cd <folder>` alone, or a `cd` after the first part | `cd <folder> && <command>`, or the full path in the command |
| `HOME=… git …` | The same command with no variable in front of it |
| A word that starts with a wildcard (`rm -rf *`): it can expand to a file named like an option | Start the word with a folder: `./*` |
| A wildcard that can match the state tool's name in a part that runs or writes (`git add scripts/*.mjs`, `node --test test/*.mjs`, also in quotes for git and `node --test`), or any `[` wildcard there, also in a real file name (`git add 'app/[id]/page.tsx'`) | Name each file in full, or add its folder (`git add <folder>`); for the tests, `npm test` or `node --test <file>` |
| `git checkout -- <file>` | `git restore <file>` |
| An unknown option | The options that the message lists, each spelled in full |
| An input over 64 KB | The text in a file in the scratch folder, written in parts of less than 64 KB |

**Bash.** The hook reads the command with a strict parser, then checks each simple command against its allow-list.

- It refuses a command that it cannot read: a `$` (variables, `$(…)`), a backtick, parentheses, braces, a backslash, a `#`, `;`, `||`, a lone `&`, a heredoc, `<(…)`, `|&`, a newline outside quotes, a control character, or any non-ASCII character outside quotes (look-alike letters). In a part that runs or writes, it refuses any character that is not printable ASCII also inside quotes, with the stop ending: a tab, a newline or `é` in a `git commit -m` message too (use `git commit -F <file>`).
- Quotes are joined as the shell joins them, so `g"i"t` is `git`. Only `&&` joins parts, and a `|` only into `head`, `tail`, `wc`, `sort` or `grep`. `cd` is allowed only as the first part of `cd <folder> && …`.
- Each command must be on the allow-list, and each option must be an entry of that command's option table by its full spelling (no abbreviation, no unknown cluster of short options). Everything else is refused: a shell (`sh -c`, `eval`, `source`), `xargs`, `env`, `sudo`, `security`, `launchctl`, `claude`, `npx`, `curl`, `ssh`, Python, `sed`, `awk`, deploy tools, and a command given by a path (`/usr/bin/security`, `./deploy.sh`). This refusal by name is a second layer: a script that the session writes and runs with `node` can do what these commands do, and the sandbox of T134 holds it (no GitHub host and a strict host list: F-T134-1; the logbooks denied: F-T134-6), with the broker for GitHub.
- In front of a command, only `HOME`, `TMPDIR`, `NODE_ENV`, `CI`, `NO_COLOR` and `FORCE_COLOR` may be set; in front of `git`, nothing: git reads its config from `HOME`, and a config can run programs.

| Command | Allowed | Refused |
| --- | --- | --- |
| `git` | `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `blame`, `add`, `rm`, `mv`, `restore`, `commit` (`-m`, `-F`), `switch`, `checkout -b`, `branch` (list or create), `stash` (`list`, `push`, `pop`, `apply`, `show`), `remote -v`, `worktree add` and `list`; the global option `-C <folder>`; `--pretty=<value>` and `--format=<value>` (a value in the next word is an operand, not their value: the hook allows it and git then fails) | `push`, `fetch` (the broker), `merge`, `pull`, `rebase`, `reset`, `clean`, `tag`, `cherry-pick`, `config`, `credential`, `cat-file`, `branch -D` and `-d`, `stash clear` and `drop`, `remote add` and `set-url`, `worktree remove`; every global option but `-C` (`-c`, `--git-dir`, `--exec-path`); `--output`, `--ext-diff`, `--textconv`, `--no-index`, `commit --no-verify` |
| `node` | `node --version`; a script; `--test`, `--check` | `-e`, `-p`, `--eval`, `--require`, `--import`, a loader; no script or the script `-` (code from stdin); a script under `/dev/` |
| `npm` | `ci`, `test`, `run <script>`, `ls`, `outdated` | `publish`, `exec`, `install`, a script whose name has `deploy`, `release` or `publish`; `--prefix`, `--userconfig`, `--script-shell`, `--node-options`, `-g` |
| `rg` | `-n`, `-i`, `-l`, `-c`, `-w`, `-F`, `-e`, `-g`, `-t`, `-A`, `-B`, `-C`, `--files` | `--pre`, `-L`, every other option |
| `find` | names and tests | `-exec`, `-execdir`, `-ok`, `-delete`, `-fprint` |
| Files and text | `ls`, `cat`, `head`, `tail`, `wc`, `diff`, `cut`, `jq`, `sort`, `uniq`, `grep` (never recursive), `tr`, `file`, `stat`, `du`, `realpath`, `mkdir`, `touch`, `rmdir`, `cp`, `mv`, `rm`, `echo`, `printf`, `test`, `[` and a few more; `cut` only with `-d`, `-f` and `-c`, each alone with its value in the next word (`cut -f 1`) | `sort -o`, `sort --compress-program`, `grep -r` (search with `rg`); `cut` with a value joined to its option (`cut -f1`, `cut -d,`) |

**The sage state tool.** A lead session gets no direct state tool, with any command (G30 A). In T134 it reaches the logbook only through a few fixed broker verbs, with the project fixed.

The guarantee is the sandbox of T134: it denies the sage plugin folder and every logbook, so no form of a call can run or change the state tool (G44 A). Test F-T134-6 proves that each known bypass fails there. The hook is a second layer. It refuses the plain forms early with a clear message, by these class rules. A "part that runs or writes" is a part whose command is `node`, `npm`, `cp`, `mv`, `git` or `tee`, or a part with a redirect, and every other part of its pipeline (the parts joined by `|`): in `cat ./sag?.mjs | head > ./x.mjs`, the `cat` part writes too. A read (`ls dir/*`, `cat`, `ls dir/* | head`) runs nothing.

1. In a part that runs or writes, every word, also inside quotes, is printable ASCII. Anything else (the long s `ſ`, a full-width letter, a zero-width space, `é`, a tab) is refused with the stop ending.
2. `node` runs no script from stdin or from a device: no script, the script `-`, and a script path under `/dev/` (`/dev/stdin`, `/dev/fd/0`, also as `//dev/./stdin` or `../../dev/stdin`) are refused with the stop ending. `node --test` with no file finds its own test files; each file it is given is checked the same way. The rule reads the path as text: a relative path after a `cd` into `/dev` is not seen (the sandbox holds it: F-T134-6).
3. A redirect target is a word like any other: the checks of rules 1, 4 and 5 and of the name see it (`node - < ./sa""ge.mjs`).
4. In a part that runs or writes, a `[` wildcard is refused, with the hint to name the files. `*` and `?` go to rule 5. git (a pathspec) and `node --test` (a test file) expand a pattern in an operand themselves, also a quoted one: there, a quoted `*`, `?` or `[` is a wildcard too, and any other character than letters, digits, a space and `_ - . / , : = % ~ ^ * ?` (node's `{a,b}` and `@(…)`, git's `\` and `:(…)`) is refused with the stop ending. Such a character can also be part of a real file or revision name (`src/@types/x.d.ts`, `src/c++.js`, `stash@{0}`), so no hint can help (F-T133-51, G47 A); `git stash pop` with no operand takes `stash@{0}`. A quoted text that is not an operand (a `git commit -m` message, an argument of a script) is no pattern.
5. A word whose text, with its quotes joined, holds the file name `sage.mjs` or the file name of `SAGE_TOOL` is refused with the stop ending. The name is folded first (NFKC, then lower case), so `SAGE.MJS`, `sa'ge'.mjs` and `ſage.mjs` match; a name that only ends like it (`message.mjs`) is another name. A `*` or `?` wildcard that can match one of these names, in a part that runs or writes, is refused with the hint to name the files (`git add scripts/*.mjs`).
6. A Write, Edit, MultiEdit or NotebookEdit call: each string of its input is checked on its own by rule 5 (a tab before the name does not hide it), and each path is printable ASCII.
7. git takes the value of `--pretty` and `--format` only in the form `--pretty=<value>`; the next word is never their value.
8. A broken input (a tool input that is not an object, a Bash call whose command is missing or not text) is refused with the stop ending.

**The other tools.** Read, Write, Edit, MultiEdit, NotebookEdit and Glob are allowed (the file tools only by rule 6 above): the permission rules and the sandbox of step 6 hold their paths. The Grep tool is refused. An Agent or Task call with an `isolation` field (`remote`, `worktree`, any value) is refused: it moves the work out of this hook or the sandbox. WebFetch is checked by the host text in the URL, as a second layer. It is allowed for `http` and `https` to a host name or a global unicast address, by an allow-list: an IPv4 address from `1.0.0.0` to `223.255.255.255`, or an IPv6 address in `2000::/3`, and in neither case in a special-purpose range of the IANA registries (`10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `2001::/23`, `2001:db8::/32`, `2002::/16`, `3fff::/20`). So `0/8`, multicast, `240/4`, `255.255.255.255`, `::1`, `fe80::/10`, `fc00::/7`, `ff00::/8`, `::ffff:…` and `64:ff9b::/96` never pass. The URL parser gives the dotted form first, so `2130706433` and `0x7f.1` are `127.0.0.1`. It refuses the host names `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa` and a name with no dot. A name that resolves to a local address passes (`127.0.0.1.nip.io`, `localtest.me`); T134 adds the WebFetch permission rule (T156). WebSearch, TodoWrite, Task and Agent (with no isolation field), ToolSearch, Skill, ExitPlanMode, BashOutput, TaskOutput, KillShell, KillBash, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, SendMessage, EnterWorktree and ExitWorktree are allowed. A skill only loads instructions; each tool that it then uses comes through this hook. Every other tool is refused, also `Monitor` and each MCP tool.

**What neither the hook nor the sandbox holds.** These cases need GitHub's branch protection on `main`, the rules of the broker, or Erick:

- A secret that is committed to git: `git log -p`, `git show <commit>:<file>` and `git diff` read it from git's objects, not from the secret file, so the sandbox's secret patterns do not apply.
- A secret file whose name matches none of the sandbox's secret patterns.
- Damage inside the session's own folders: `rm -rf` of the worktree or the scratch folder, `git checkout` over uncommitted work.
- A host name on the sandbox's list that resolves to another address, and WebFetch to a host name that resolves to a local address (DNS rebinding): the hook checks the name in the URL, not the address. T134 adds the WebFetch permission rule (T156).
- What the broker uploads: the broker must allow only the session's own branch and pull request.
- A copy of the state tool under another name, made without its name (a `cp -r` of its folder, then a name that the hook does not know), a script that builds the name or reads it from a folder listing, and any other spelling that the class rules miss: the sandbox, which denies the sage plugin folder and the logbooks, holds them (F-T134-6).
- A hook that runs past its timeout: Claude Code then runs the tool call (F-T134-13). The input limit keeps the guard far below the timeout.

**The tests.** `test/guard.test.js` gives each case of `test/guard-corpus.json` to the guard. In a lead session, every command that is not on the allow-list must be refused with a message in the fixed form; `gh`, `git push` and `git fetch` must be refused with the broker hint; the normal developer commands, a realistic sage session in a worktree under the scratch folder, and the commands whose files the sandbox holds must be allowed; and all of them must be allowed when `SAGE_ORIGIN` is not `lead`. Other tests feed the real hook JSON on stdin, from a file: its answers, a crash, and the 64 KB limit with its time. Nothing runs: the commands are only text.

**The mutation check.** `npm run check:guard-mutations` removes each rule of `src/guard.js` in turn (163 rules) and runs the guard tests against each copy. Each removal must make a test fail. It prints each rule that survives, each copy that breaks a known-good call and each run that does not end in 60 seconds, and exits with 1 when there is one. It takes about 1 to 2 minutes (52 to 100 seconds on the owner's Mac, by the load) and starts many test processes at once, so it is not part of `npm run check`; run it after each change of a rule.

## Run the checks

You need Node 22 or later, and `npm ci` once (discord.js and playwright-core, both pinned to one exact version).

<!-- check: skip, the check runs this test itself -->
```sh
npm run check
```

The check runs `node --check` on every source file, then the tests in `test/`. A test runs the example above and checks that this page holds it. Another test (`test/readme.test.js`) runs the shell commands of the README and of this page in a scratch HOME, and checks every relative link. The tests use sample ids only. The bridge tests run the sage state tool (`SAGE_TOOL`, by default the sage plugin's `sage.mjs`) with `HOME` and `SAGE_HOME` in a new scratch folder, so they never touch a real logbook, and they use the fake Discord layer, so they never connect to Discord. One test runs npm itself from another folder with `HOME` set to a scratch folder, to prove the `.npmrc`: npm writes and deletes no log file anywhere (`logs-dir=/dev/null`, `logs-max=0`). For a debug log of one command: `npm --logs-dir=/tmp/npm-logs --logs-max=5 <command>`.
