# sage-bot reference

This page is the full reference of sage-bot: the vote rules and their API, the cards, the bridge, the gate file, the session threads and the checks. The [README](../README.md) says what sage-bot is, how to try it and how to set up a live trial. Start there.

In this page, a "gate" is a sage gate: a question that the chief parks for the owner. The README calls it a question.

**Contents:** [The demo](#the-demo) · [The vote rules](#the-vote-rules) · [The API](#the-api) · [The Discord layer](#the-discord-layer) · [The bridge service](#the-bridge-service) · [Chief sessions and their threads](#chief-sessions-and-their-threads) · [Run the checks](#run-the-checks)

## The demo

The demo needs Node 22 or later, `npm ci` once, and the sage plugin. It finds the sage state tool in this order: `SAGE_TOOL` when it is set; else the newest `sage.mjs` in the plugin's cache, `~/.claude/plugins/cache/sage/sage/*/skills/sage/`; else it stops with a message that names `SAGE_TOOL`. The bridge tests use the same lookup.

The demo plays one chief session end to end with sample data and a scripted clock, then prints the path of one HTML page. The page opens with no network. It shows the session's line in the parent channel, first as posted ("running" with its counts) and then each edit with its time, up to "ended", and its whole thread: the cards at their final state, the private notes that each person sees, the answers in sage and the reasons for the chief.

The session uses the real sage state tool, hook (`scripts/hook.mjs`), team votes command (`scripts/vote.mjs`) and bridge, on the fake Discord layer:

1. The chief adds a single question (T1), a batch of 2 questions (T2) and one question that stays at the terminal (T3), and marks the team votes.
2. Maya answers the single question first: her answer is final. Sam has no role: his press does not count.
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

B1 stores reasons as typed. They are untrusted text. The bridge must clean and frame them before any reason reaches the chief or a log. A reason can hold `<`, `>`, backticks, newlines, mentions and invisible characters. Cleaning belongs to B3, in one place where reasons leave the bridge.

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
| `id` | non-empty string | The gate's id in sage. |
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
| Batch, voting | "Vote on each part; change your vote until the vote ends. The work on the task goes on. Closes at 15:01 (in 18 minutes)". Per part: each option with its votes and voters ("Erick (terminal), Jon"), the chief's recommendation, "Voted: … · Not voted: …", and "Ahead: A", "Even so far" or "No votes yet". Each reason as one line, cut to 200 characters; when the card is full, the oldest reasons go first and one line says "N more reasons; the chief has them all"; a visibly empty reason (nothing but spaces, hidden characters or combining marks) shows no line. A button per option of each part, "Part 1, A: Only the columns visible in the table" (cut to 80 characters), and "End vote now (sage-lead only)". |
| Batch, tied | "Voting ended at 15:01. 1 part is tied: it waits for a sage-lead. The other parts are provisional, and T7 waits." (with every part tied: "2 parts are tied: they wait for a sage-lead. T7 waits."). After a lead's early end: "Ended early by Jon (sage-lead) at 15:28, with the votes so far." A tied part shows "Tied: A, B at 1 vote each. A sage-lead breaks the tie. The chief reminds @sage-lead every 2 h." (plain text: it pings nobody) and a button "Part 2, break the tie: A (sage-lead only)" for each tied option only (every option when nobody voted). Decided parts say "Provisional: A · 3 of 3 votes". |
| Batch, decided | "Voting ended at 15:01. Closed: every part is decided. T7 goes on." A part that a lead decided says "Decided: A · tie broken by Jon (sage-lead) at 17:05". Every button is off. |
| Withdrawn | "Withdrawn by Erick at 15:30. Closed: nothing is decided." Every button is off. |

The words "Voting ended at" are for the vote; "Closed" is only for a decided or withdrawn gate. The card names the lead who broke a tie or ended the vote early (owner decision G11), from the gate's `by` and `at` and its `endedBy`, through the same name lookup and `safe` as every other name. A gate saved before T39 does not have these fields: its card says "tie broken by a sage-lead" and "Ended early by a sage-lead at 15:28".

**Untrusted text.** A reason and a display name are text that a person reads on the card, and nothing else reads it: the chief gets the reasons from the stored ballot, cleaned by B3's own allow-list. `safe` keeps only what a person needs: a whole RGI emoji (a family, a skin tone, a keycap, the Scotland flag), a letter, a number, punctuation, a symbol (also a bare pictograph such as ™, ©, ✔ or ⚠; a variation selector after it stays only when the pair is an RGI emoji), a space, at most 3 combining marks on a letter that pile on it (the non-spacing marks, Unicode `Mn`) and at most 4 spacing or enclosing marks (Unicode `Mc` and `Me`, such as a vowel sign, a musical stem or a ring; they do not count toward the 3, so Burmese ကျော် stays whole), and a joiner (U+200C, U+200D) after a letter or mark of a joining script (Arabic, Syriac, the Indic scripts, Myanmar or Khmer) when a letter or mark of one follows, or when the joiner follows a mark such as a final virama; never two joiners in a row. So a Persian word, a Hindi or Bengali conjunct and a Malayalam chillu stay whole, and a stack of marks is cut to 3 non-spacing and 4 spacing or enclosing marks on one letter. Everything else goes: the backtick (no code span), every format character, variation selector, control, private-use and unassigned code point, and the six characters that look blank (the four Hangul fillers, the blank Braille cell U+2800 and the musical null notehead U+1D159). Then `safe` escapes Discord markdown (discord.js `escapeMarkdown`), every `[`, `]`, `<` and `>` (no masked link, mention, timestamp, emoji code or quote; "A > B" and "x <= y" show as typed) and a leading `-#` (no subtext), breaks every `://` to `:// ` so that no URL is clickable (Discord does not link `www.` or a bare domain), and folds white space to one line. A text with nothing visible left gives `''`. Every message also carries `allowedMentions: { parse: [] }`, so nothing pings anyone. The reason form sets `max_length` to 500.

**Discord's limits.** One message holds 5 rows of buttons; an embed holds 25 fields and 6000 characters in all, a title of at most 256 characters, a description of at most 4096, and each field a name of at most 256 and a value of at most 1024; a button label holds 80 characters and a form title 45. A card uses one row per part, one more while the vote is open, and one field per part and per reason. B3 refuses an ask with more than 4 parts: `card` throws a RangeError for more than 5 rows, which a batch of 5 or more parts reaches while the vote is open; through `handle`, a press on such a batch still stores the ballot and shows the reason form (no card is built), and the form's submit then rejects and stores nothing. `card` never throws for a team of 2 to 5 with at most 4 parts, whatever the ask's texts hold: one budget builds the whole embed, measures every limit and shrinks it in a fixed order until all hold. First each text goes within its own limit (a field value in 1024), then the whole embed within 6000 characters and 25 fields. The budget drops the oldest reason fields (one at a time, for the whole embed only; the description then says "N more reasons; the chief has them all", a line that never shrinks), then cuts the voter lists (to "and N more"), then the why, then the option labels, then the question in the field name; the title is cut to 256 and a button label to 80. The lead's private confirm is budgeted the same way: in its 2000 characters, the voter lists shrink to "and N more" for a team far larger than 5. The keys, the counts and "The chief recommends A" never shrink. The single card shrinks the same way: the why, then the labels, then the question, so its description stays in 4096. B3 also keeps the texts of an ask reasonable, so that nothing is cut: with a team of 5, three labels of 80 characters and a why of 300 fit whole. The card shows each reason cut to 200 characters (the gate keeps the full 500), never through a flag or a family emoji, and the newest reasons that fit: how many depends on the names and on the ask's texts; a team of 5 with 4 parts, short questions and a 500-character reason from everyone shows most of the 20 reasons, and the description counts the rest. A randomized test of 2000 cards (a team of 2 to 5, 1 to 4 parts, 2 to 5 options, every gate state, questions to 1000 characters, labels to 500, a why to 4000, reasons to 500, names with markdown) proves that every limit holds. No field is ever empty, because Discord refuses an empty name or value: a reason that `safe` reduces to nothing gets no field, and a member whose name is missing or visibly empty shows as "member …6789" (the last 4 digits of an id of 4 or more digits) or "member" for any other id, everywhere, never as the raw id. `handle` builds its reply before it stores the new gate, so a card that cannot be built leaves the gate as it was.

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

The custom_id grammar: `press:<gate>:<part>:<index>`, `reason:<gate>:<part>:<index>` (the form), `tiebreak:<gate>:<part>:<index>`, `end:<gate>` (the confirm), `end!:<gate>` (the confirmed end), `cancel:<gate>`. A single question uses part 0.

| Press | The reply |
| --- | --- |
| An option of a single question | The updated card. A later press: the private note "Already answered by Maya: A". |
| An option of a batch part | The vote counts at once; the reply is the reason form (optional, 500 characters; its title is "Your vote counts: A. Only the columns visible in the table" or, when that does not fit in 45 characters, the option alone, cut at a word). Its submit replaces the ballot with the reason and updates the card. A dismissed form sends nothing: the ballot stays, and B3 edits the card at its next chance. |
| End vote now | The end runs through the vote rules first, without a store. When they would refuse it (not a lead, a single question, the vote ended, closed or withdrawn, or past the time limit by the clock), the reply is that refusal's private note, so the confirm never shows false facts. Otherwise a private confirm: what each part gets with the votes so far ("Part 1 goes to A: 2 of 3 votes (Erick, Jon)."), with "Cancel" and "End vote now". The confirmed end runs through the vote rules; the reply updates the private confirm, so B3 edits the card. |
| A tie-break button, by a lead | The updated card. |
| Cancel, on the private confirm | The confirm becomes "Cancelled. The vote goes on." or, when the vote ended meanwhile, "The vote on B9 ended at 15:01 meanwhile. Nothing to cancel." (on a withdrawn gate: "B9 was withdrawn by Erick. Nothing to answer."). A `cancel:` press from any private message only answers and changes nothing: no event, no store. |
| Anything the vote rules ignore | A private note for its `why` code. Every code has one; a non-holder gets "Your press did not count. Only people with the sage-apprentice or sage-lead role can answer or vote. You can still read this thread." |

Discord shows every button of a message to everyone, so a non-lead sees "End vote now" and the tie-break buttons too; a press gets the private note "Only a sage-lead can do this. Your votes on the parts count like everyone's." B3 must: call `parseGate` on each loaded gate; send the tick at `gate.endsAt` and the withdraw from sage through `step`; and edit the card message with `card(...)` whenever the gate changed but the reply was not the card (after a confirmed end, a dismissed form, a tick or a withdraw).

### The fake layer

`src/fake-discord.js` exports `fakeInteraction({ user, customId, fields, ephemeral, refuse })`: an interaction-like object for the tests and the preview, with the shape that `handle` reads and a `replies` list that records every answer as `{ kind, ...payload }` (kind `'reply'`, `'update'` or `'modal'`).

- `user`: the user id; `customId`: the button's or form's custom id.
- `fields`: the form's inputs by input id, only for a form submit; the reason form has one input, `'reason'`. A button press has no `fields`, as in discord.js, and `getTextInputValue('reason')` throws for a missing input, as in discord.js.
- `ephemeral`: true when the pressed message was private (the lead's confirm); it sets the Ephemeral flag of `message.flags`.
- `refuse`: an Error; every reply then rejects with it and records nothing, as Discord does for an unknown interaction.

For the read commands it also exports `fakeCommand({ user, roles, bot, channelId, parentId, sub, options, onDefer })` and `fakeMention({ user, roles, bot, channelId, parentId, content })`: a `/sage` command and a message that mentions the bot, in the shape that `src/discord.js` gives `src/ask.js`. `parentId` is the parent channel of a thread, else null. Each records its replies in `replies`. `fakeCommand` records its `defer` and `edit` calls in order as `{ kind, ...payload }`, an attached file as its name and size, and runs `onDefer` inside the defer, so that a test can change the project there.

### The preview

<!-- check: run, prints "with 12 moments" -->
```sh
node scripts/preview.mjs
```

This command renders the card JSON of the design's eleven moments, plus a card of a team of 5 with 4 parts and 500-character reasons, to `design/b2/index.html` with sample data (or to the path after `--out <page.html>`), through `scripts/render.mjs` (the demo uses it too). With `--shots` it also screenshots each moment to `shots/` beside the page with the local Chrome (playwright-core, channel `chrome`); run it with `HOME` set to a scratch folder. Chrome runs with `--disable-gpu`, so the shots are byte-identical from one cold run to the next (the GPU raster path draws the rounded border corner by one shade differently in some runs).

## The bridge service

`src/bridge.js` is the bridge. It runs on the owner's Mac, as one process for one sage project and one Discord channel. Every 15 seconds it does one turn of its loop:

1. It notices a sleep of the Mac (two turns more than 75 seconds apart). When a gate is open, it posts: "The host was asleep from 22:10 to 08:05. Presses in that time did not count. Please press again on any open question." A press while the Mac slept never reached the bridge: Discord showed "This interaction failed".
2. It sends the tick at `gate.endsAt` to each batch vote at or after its limit, also after a sleep.
3. It sends each reminder that is due, once, also after a sleep: to the sage-apprentice and sage-lead roles for a single gate with no answer, and to the sage-lead role only for a batch with tied parts.
4. It reads the logbook (see below) and posts the new gates that the chief marked as team votes.
5. It gives sage each final answer that sage does not have yet.

The roles come from the config: `apprenticeRole` and `leadRole`. A config from before the two roles, with `driverRole` and no `apprenticeRole`, stops the bridge with exit 1 before it takes the lock or reads the Keychain, and `scripts/launchd.mjs` refuses it the same way: "the config has driverRole: sage-driver is gone. Rename driverRole to apprenticeRole and give that role id to the sage-apprentice role." When a member has both roles, the bridge counts the member as a lead and logs one line with the name and id of each such member; it logs the line again only when that list changes.

Each event gets its time from the bridge's own clock: the wall clock (it runs on while the Mac sleeps), never earlier than its last value. No time comes from Discord data.

### The read commands of #ask-sage

`src/ask.js` answers `/sage` in the #ask-sage channel (`askChannelId`), with no AI (G18, option A). At start the bridge sets the `/sage` command for its guild only, with four subcommands. `project` is a choice of the listed projects; without it, the first project answers.

| Command | The private answer |
| --- | --- |
| `/sage board [project]` | The count of tasks by state, the tasks left (not merged, concluded or abandoned), "Time left is not estimated yet: the project's records have no estimate.", and each open question with its id, task and text. |
| `/sage task <id> [project]` | The task's id, title, size, state and pull request; the pull request is a link when the project has `repo`. |
| `/sage gates [project]` | Each open question with its options, and whether it is a team vote (in the team votes file of the bridge's own project) or answered at the terminal. |
| `/sage files [project]` | Up to 10 files from the project's `files`, sorted by path, and at most 8 MB in all (`MAX_BYTES`): Discord's upload limit for a server with no boosts is 10 MB a message. The files that do not fit, in order, are listed under "N more file(s) not attached: one reply holds at most 8 MB. Ask a lead for them." and a smaller file after them still comes. |

The rules, in the order the bridge applies them:

1. A bot gets nothing.
2. Every other command is first deferred in private (Discord shows "sage-bot is thinking", only to the person), before any file or logbook work. Each answer below is an edit of that reply. When Discord refuses the defer, the bridge logs it and does nothing more.
3. Every ask counts: 10 per person in a rolling hour, in memory (a restart clears the counts).
4. A member with neither role gets "Only people with the sage-apprentice or sage-lead role can use /sage. You can still read the channels.", also over the limit. The roles come from the interaction's member, never from text or an option.
5. Over the limit, a member with a role gets "You asked 10 times in the last hour; that is the limit. Your next ask works at 15:12." with the time as a Discord timestamp.
6. A command outside #ask-sage and its threads gets a pointer to it.
7. A project that is not in the list gets `I do not know a shared project called "payroll".`, which names no other project.

Each answer comes from the project's `tasks.tsv` and `gates.tsv`, which the bridge finds with one `sage logbook` per project (kept after the first lookup that works) and reads through `pick`: only the id, title, size, state and pull request of a task, and the id, task, question and options of an open gate. It never reads `decisions.tsv`, findings, briefs, reports, a recommendation or a branch. Every logbook text goes through `safe` (the readers are people on Discord), each reply is cut to 2000 characters, and every reply has `allowedMentions: { parse: [] }`.

A file of `/sage files` is attached only when it is a regular file (not a symlink, not a folder), its real path is inside the project, its name does not start with a dot, its type is .png, .jpg, .svg or .pdf, and it is at most 8 MB. An entry that cannot be checked, such as a dangling symlink, is skipped. The bridge then opens each file with `O_NOFOLLOW` and reads it through that open file only when it is still a regular file with the device and inode of the check, so a file swapped after the check is never sent. The name of an attachment keeps only A-Z, a-z, 0-9, dot, dash and underscore; any other character becomes `_` (the readers are people on Discord).

**A mention.** A message that mentions the bot comes with the GuildMessages intent; the bridge needs no Message Content intent. Each mention in #ask-sage or a thread of it counts like a command and gets one public reply in place, which pings nobody: "I do not answer free questions yet. Use /sage board, task, gates or files to read the project's records, or ask a lead." A mention with a sentence that starts with a build verb (add, build, change, create, delete, deploy, fix, implement, make, merge, refactor, remove, rename, update, write), also after "please" or "can you", also gets "Builds are for sage-leads: ask a lead.", or for a lead "Builds from Discord are not ready yet." So "any update?", "does that make sense?" and "is the merge done?" are no build. Over the limit, a person gets one note until the hour frees up, then nothing; for a member with no role, that note is the role note. A mention in another channel gets "I answer in #ask-sage, so everyone can find the answers. Please ask there." once per person per UTC day.

**The config.** `askChannelId` is a Discord id. `projects` is a list of 1 to 25 entries `{ name, project, sagePath?, files?, repo? }`; without it, the list is the bridge's own `project` with no files, named after its folder. When that folder name makes no valid name (for example `_scratch`, or more than 32 characters), the bridge stops with a message that says so: add a `projects` entry with a valid name. The bridge and `scripts/launchd.mjs` refuse at start a name that is not lower-case letters, digits and dashes (at most 32) or not unique, a `project` or `sagePath` that is not absolute, a `files` entry with `..`, a leading `/` or dot, a `*` in a folder, or another type, and a `repo` that is not `https://github.com/<owner>/<name>`.

### Which questions go to Discord

Only the questions that the chief marks as team votes go to Discord. Every other gate stays at the terminal: it gets no card, and the bridge logs one line for it, "G5 stays at the terminal: the chief did not mark it as a team vote". This is the owner's decision G13: most gates are questions for the owner alone, and the team votes only on the questions that the chief chooses for it.

The chief marks gates with `scripts/vote.mjs`:

<!-- check: run, prints "team votes: G4" -->
```sh
node scripts/vote.mjs G4 G5          # mark G4 and G5 as team votes
node scripts/vote.mjs --unmark G5    # unmark G5
node scripts/vote.mjs --list         # print the list: "team votes: G4"
```

Each command takes `--config <config.json>` first; the default is `~/.config/sage-bot/config.json`. The list is the team votes file: `votesPath` in the config, or `<statePath>.votes`. It is a JSON list of gate ids, mode 0600, written whole with a new file and a rename. The script refuses an id that is not a sage gate id (G and digits) and then changes nothing. The bridge reads the file at each turn of the loop, and refuses a file that another user owns, that others can read or write, or that is not a list of gate ids: then it posts nothing and logs why once.

- Mark the gates of one batch with one command. Each rule below works on the marked gates only: two marked gates of one task, asked within 30 seconds, share a card; 5 marked gates asked together stay at the terminal.
- A gate marked after it was added is posted at the next turn of the loop. When its task's card is already out, it gets its own card.
- A marked question about a merge is still not posted, and the bridge logs "G5 stays at the terminal: it is about a merge, and a merge never goes to a vote".
- Unmarking a gate that has a card does not take the card back.

### Leads-only questions

The owner's decision G18 (item 8): sage may ask whether to switch on its automatic-merge mode for a session. The sage-leads only recommend Yes or No, and the owner decides at the terminal. This is the only leads-only question. The chief asks it as a normal sage gate with exactly this question and the options `Yes|No`, then marks it leads only:

```text
Switch the automatic-merge mode on for this session?
```

<!-- check: skip, it needs a sage logbook that holds the gate; test/t73-leads.test.js runs it -->
```sh
node scripts/vote.mjs --leads G6     # mark G6 as leads only
```

- The leads-only file is `<team votes file>.leads`, in the format of the team votes file, and the bridge refuses a bad one the same way: then it posts nothing and logs why once. A gate is in one of the two lists at most: a mark moves it, and `--unmark` clears it from both.
- `--leads` takes one gate id. Two or more ids are refused: "a leads-only question is one Yes or No question, never a batch". The bridge also posts a leads-only gate on its own card, never in a batch.
- `--leads` reads the gate from sage, with `sagePath` and `project` of the config. It refuses, exits 1 and changes nothing when the gate is not in the logbook, when its question is not the text above word for word ("G6 is leads only, and a leads-only question must be the automatic-merge question, word for word: …"), or when its options are not Yes and No. The question is `LEADS_QUESTION` in `src/bridge.js`. So a lead never answers a merge of a pull request or any other decision of the owner.
- The bridge checks the same again for a file that someone edited by hand: it logs "not posted: G6 is leads only, and a leads-only question …" and the question stays at the terminal. So every text that the bridge writes about the answer comes from Yes and No.
- A gate id in both files is an error: the bridge posts no card for it and logs "G6 stays at the terminal: it is in both the team votes file and the leads-only file. Mark it again with scripts/vote.mjs". A mark saves the file that loses the gate first and then the file that gains it, so a read between the two saves can find it in both. When the bridge finds a gate in both, it reads the two files again; only a gate that is still in both gets the line and no card. So a mark during a read never gives the line, and the card comes on that loop or the next.
- The leads-only question names the automatic-merge mode, and it is posted: the merge guard is for team votes, and here the owner decides.
- The card is titled "Recommend for Erick: Question G6 · …". It pings the sage-lead role only, with "T5 asks the sage-leads for a recommendation to Erick. The first sage-lead answer is the recommendation; Erick decides at the terminal." Its rule line says the same, and its 2-hour reminders ping sage-lead only.
- A press from a sage-apprentice or a member with no role gets the private note "Only a sage-lead can answer this. Erick decides." and does not count.
- The first lead's press closes the card: "Recommended by Jon (sage-lead) at 15:30: A. Yes. Erick decides at the terminal." The bridge gives sage "A. Yes (sage-leads recommend; the owner decides)" with `sage gate answer`, so the logbook shows the leads' advice and never the owner's decision. It posts "Recommendation recorded: Jon recommends Yes. Erick decides at the terminal." where the card is, and logs one line. For Yes: "G6: sage-leads recommend Yes. If you agree, switch the mode yourself at the terminal." For No: "G6: sage-leads recommend No. If you agree, do nothing; the mode stays off."
- A press after the recommendation gets the private note "Already recommended by Jon (sage-lead): A. Yes. A recommendation only; Erick decides at the terminal. Your press did not count." Erick also holds sage-lead, so Erick can press in Discord; that press is a recommendation like any lead's, never Erick's final answer. Erick decides only at the terminal.
- The leads-only texts name the owner "Erick", also when the owner is not in the server's member list (never "a member" or "member …0001").
- The owner's answer at the terminal is final (G10), before or after the leads' press, also when it is "A. Yes": only the marked text is the bridge's own, so the bridge never writes over the owner's answer. To switch the mode, the owner types the mode's own message at the terminal. sage-bot never switches a mode, never writes sage's hook state, and no text of sage-bot holds a mode's switch message.

### How a sage gate becomes a card

The bridge runs the sage state tool with `execFile` (no shell): `sage logbook` finds the logbook, and `sage gate answer <G> <answer>` records an answer. It reads `gates.tsv` and `tasks.tsv`, and never writes a logbook file itself.

| Case | What the bridge does |
| --- | --- |
| One open gate of a task | A single question. The options are sage's options (`a\|b`), as A to E. The recommendation and the default mark the option with the same text or letter. |
| 2 to 4 open gates that one task asked together | One batch vote, one part per gate, in the order of the logbook. "Together" means that sage's `at` of each gate is at most 30 seconds after the first one; gates further apart get their own cards, also after a restart. The card's id is the gate ids joined by `+`, for example `G3+G4`. The bridge waits 30 seconds after the newest gate of a task, so that the chief's `gate add` commands of one batch land on one card. |
| 5 or more gates that one task asked together | Refused: no card. The terminal shows "not posted: T2 asked 5 questions together, and a batch holds at most 4 parts. Answer them at the terminal." once. They stay at the terminal until each one has an answer: the answered ones still count, so no later card takes the rest. |
| A gate that a task adds after its card was posted | Its own card, also within 30 seconds of the first. |
| A gate with no option or more than 5 | Refused the same way: one row of Discord buttons holds 5. |
| A marked gate whose question or options name a merge ("merge", "merges", "merged", "merging") | Not posted. Merges never go to a vote; they stay at the terminal. |
| A new card | The post mentions the sage-apprentice and sage-lead roles, and only those roles: "T7 has 3 product questions. Vote on each part within 30 minutes." or "T8 needs one product answer. The first answer is final." |
| The owner answers a posted gate in the chat, and the chief records that answer with `sage gate answer` | Final, whatever the owner's roles. The card shows "Answered by Erick (terminal) at 14:05: B. text. Final." on that question, or on that part of a batch, and its buttons go grey. A press on it gets "Already answered by Erick at the terminal: … Your press did not count." The other parts of a batch keep voting, and the leads never get a tie for an answered part. The answer is no ballot. |
| An answer in sage that the bridge did not write | The owner's: the chief recorded it with `sage gate answer`. The bridge reads the logbook before each press and again before each `sage gate answer`, and never gives sage an answer for a gate that the owner answered. |
| The chief answers an open single gate with text that names no option | A withdraw by the asker (the owner): the card closes as withdrawn. A withdraw comes only from sage, never from Discord. On a part of a batch, such text is the owner's final answer to that part. |
| A single gate is answered in Discord | The bridge gives sage "B. Show a Session ended screen" (the letter and sage's option text). |
| A batch closes as decided | The bridge gives sage the answer of every part, the same way. It acts only on the `'closed'` effect, never on a part's `'decided'` effect, which is provisional while another part is tied. A withdrawn gate gives sage nothing. |
| A batch vote ends with tied parts | A post to the sage-lead role with each tied part and each voter's argument (the reason, made safe for the card and cut to 200 characters). The 2-hour reminders count from this post, so one loop never pings the leads twice, also after a sleep. |
| A member gets or loses the sage-apprentice or the sage-lead role | At the next turn of the loop the bridge redraws each open card, so the card counts the same votes as the tick. |
| A lead breaks a tie | A post that names the lead: "Jon (sage-lead) broke the tie on part 2 of G3+G4: A." No one is pinged. |
| The gate changed | The bridge edits the card with `card()`: after a ballot, a tick, an end, a tie-break, a terminal answer or a withdraw. A press after the time limit that the vote rules refuse still ends the vote first, so the bridge settles that too. |

Only a Discord id (17 to 20 digits) goes into an event's `by`. A press from any other user id gets "I do not know this account. Nothing changed." The holders and leads are Sets, read fresh from the guild members at each press and each turn. When `handle` throws (a card that cannot be built), the person gets "The bridge could not handle this press. Nothing changed. Please tell the owner." and the gate stays as it was.

### The gate file

The bridge keeps its gates, their asks, the owner's final answers and what it gave sage in one JSON file, `statePath` in the config. One bridge at a time: at start it takes `<statePath>.lock`, which holds its pid and its start time (from `/bin/ps`). It writes them to a temp file and links that file to the lock name, so the lock is never empty and only one of many starts gets it. When the lock belongs to a bridge that runs (a process with that pid and that start time), the new bridge stops with "another sage bridge (pid 4242) runs on …". It replaces a lock of a process that is gone, of another process that got the pid after a reboot, or with its own pid. A lock with no start time (empty, or written by an earlier version) counts as held for 10 s, then it is replaced; in that time a start stops with "a sage bridge may still be starting … Try again in 10 s, or remove <lock>". When `/bin/ps` fails for another reason than "no such process", the start stops with "could not check whether the bridge with pid N still runs" and leaves the lock: it never replaces the lock of a bridge that it could not check. A lock that the bridge cannot read (no read permission, or a folder) stops the start with a message that names the path. Only one start at a time removes a stale lock, under `<lock>.break`; a start that finds a break file of under 10 s stops and names it, and a later start removes an older one. A start also removes the temp files `<lock>.<pid>.tmp` of starts that crashed (their pid no longer runs). An exit removes the lock, also a stop by SIGTERM (launchd at logout or shutdown), SIGINT or SIGHUP. Only the bridge writes it: its folder is mode 0700 and the file 0600, and each save writes a new file and renames it over the old one, so a crash never leaves half a file. At start the bridge refuses a file that another user owns or that others can read or write, and it loads each gate with `parseGate` on the output of `JSON.parse`. It loads gates from this path only, never from Discord or a shared folder.

The file is version 2: each entry has its chief session (`session`, or null when none is known) and the channel or thread of its card (`channel`), and the file has the sessions that have a line (their number, thread title, line and thread ids, and whether the thread is locked). The bridge also loads a version 1 file: its entries have no session. Each card stays in the parent channel with its tie posts and reminders, and the bridge still edits it there. The next save writes version 2.

### Run it

The steps to set up the bridge are in the README: [Set up a live trial](../README.md#set-up-a-live-trial). These are the details behind them.

1. **The Discord app.** A Discord application with a bot user in your server, with the Server Members intent on (Message Content off), invited with the `bot` and `applications.commands` scopes, and the roles sage-apprentice and sage-lead. Each person has one of them, never both.
2. **The Keychain item.** Put the bot token in the macOS Keychain as a generic password with the service name `sage-bot`, with Keychain Access (File, New Password Item: name `sage-bot`). Do not type it in a command, because the shell history keeps it. At start the bridge reads it with `/usr/bin/security find-generic-password -s sage-bot -w`. It never writes the token to a file, a log or an error. When the item is missing, the bridge stops with: "no bot token: the macOS Keychain has no generic password with the service "sage-bot". Add it with Keychain Access, then start the bridge again."
3. **The config file.** Copy `examples/config.example.json` to a folder of your own, for example `~/.config/sage-bot/config.json`, and fill it in: the Discord ids of the guild, the channel, the #ask-sage channel, the owner and the two roles; the projects that `/sage` reads; the sage project folder; the path of the sage state tool (`sage.mjs`); and `statePath`, the gate file. The team votes file is `<statePath>.votes`, or `votesPath` when you set it.
4. Start it: `node scripts/bridge.mjs ~/.config/sage-bot/config.json`. It logs to the terminal; every log line goes through an allow-list, so no control character reaches the terminal. Of a Discord error it logs only the code, the status and the message, never its url or body (they can hold an interaction token).

**The launchd plist.** To start the bridge at each login and again after it stops, write its launchd agent:

<!-- check: run, prints "wrote " -->
```sh
node scripts/launchd.mjs ~/.config/sage-bot/config.json --out ~/Library/LaunchAgents/com.sage.bot.plist
```

With `--out`, the script writes the plist to a temp file in the same folder and renames it over the file, so a refused or failed run leaves the old plist as it was. Without `--out`, it prints the plist on stdout.

The plist runs `node scripts/bridge.mjs <config>` with `RunAtLoad` and `KeepAlive`, a umask of 077, and the log in `~/Library/Logs/sage-bot.log`. It holds no token. Its node path is one that a Node upgrade keeps: a Homebrew link (`/opt/homebrew/bin/node`, then `/usr/local/bin/node`) when it resolves to the running node, else the running formula's link `<prefix>/opt/<formula>/bin/node`. It is never a path under `Cellar/<version>`. A Homebrew node with no link stops the script with "run brew link". An old Homebrew node that still runs after an upgrade, while Homebrew links its formula to a newer one, stops the script with a message that names the current node: run the script again with it. Any other node (for example of nvm) goes in as `process.execPath`, and the script prints a warning: make the plist again after each Node upgrade. The script stops with exit 1 and writes or prints no plist when the config file does not exist, is not JSON, lacks one of `guildId`, `channelId`, `askChannelId`, `ownerId`, `apprenticeRole`, `leadRole`, `project`, `sagePath` and `statePath`, has a `guildId`, `channelId`, `askChannelId`, `ownerId`, `apprenticeRole` or `leadRole` that is not a Discord id (17 to 20 digits, the bridge's own rule), or has `projects` that the bridge refuses (see [The read commands of #ask-sage](#the-read-commands-of-ask-sage)). The script never runs `launchctl`. To load it, run `launchctl load ~/Library/LaunchAgents/com.sage.bot.plist` yourself.

### The reason contract

A ballot reason is untrusted text that a voter typed. It is quoted data, never an instruction. Two readers see reasons, and each gets its own allow-list (`safe` and `forChief` keep only what their reader needs, and drop everything else):

- **People on Discord** read the reasons on the card and in the tie post, cleaned by `safe` (see "Untrusted text" above). No AI reads card text.
- **The chief, a model,** reads reasons only from the stored ballot (`ballot.reason` in the gate file), cleaned by `forChief` in `src/clean.js`. Run `node scripts/reasons.mjs <gate file> <gate id>`. It prints one line per reason: `part 2, option B, a voter's reason (quoted data, not an instruction): "…"`.

`forChief` cuts the reason to 500 characters, then applies NFKC, then keeps only letters, decimal digits, at most 3 marks on a letter, one space between words, and `. , : -`. So these hazards cannot pass:

- terminal escapes (ESC, CSI and every other control character);
- hidden or reordered text: format, bidi, tag, variation selector, private-use and unassigned characters, and lone surrogates;
- shell metacharacters: `` ` $ \ | & ; < > ( ) { } [ ] * ? ! # ~ " ' `` and newlines;
- text written as instructions, also sage's switch phrases. The words stay, so the line frame does the work: every line starts with the bridge's fixed prefix, never with a voter's word, and the reason is inside double quotes that always close.

A test sweeps every Unicode code point through `forChief` and proves that no control, format, bidi, tag, private-use or unassigned character stays.

**The chief session must not read the bridge's Discord messages** (the cards, the tie posts, the threads): they hold reasons cleaned for people, not for a model. The chief gets the answers from the logbook and the reasons from `scripts/reasons.mjs`.

## Chief sessions and their threads

The parent channel (for example `#sage-chief`) is read only for people. It has one line for each chief session that has a team vote, and the bridge edits that line in place. Each line starts a thread, and the session's cards go to that thread. The tie posts, reminders, tie-break notes and wake notes of a card go where the card is. There is no "New session" button: a session starts at the owner's terminal.

| Case | What the bridge does |
| --- | --- |
| A session | One Claude Code session id. A `/clear` starts a new session id, so it gets a new thread. A resume keeps the id, so it opens the old thread again. |
| A session with no team vote | No line and no thread. |
| The first team vote of a session | The bridge gives the session the next number of the project, posts its line, starts the thread from the line with the title "Session 14 · Tue 4 Oct" (the weekday and date of the session's start, in the Mac's time zone), and posts the card in the thread. Lines are posted in this order, so the newest is at the bottom. |
| The line | "**Session 14 · Tue 4 Oct**" and "running · 4 tasks · 2 open questions". The tasks are the session's tasks with a gate; the open questions are the questions of its cards that still wait for an answer. The bridge edits it when a number changes. |
| A gate that no hook saw | It goes to the newest running session. With no running session it goes to the parent channel, as before T29 (for example before the owner adds the hooks). A card in the parent channel stays there with all its posts, also when a session starts later. |
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

The hook never blocks or fails a session: it always exits 0 and prints nothing on stdout. It refuses input that is not a hook's JSON, a session id that is not a UUID, and a config with no `project`; then it writes nothing and prints one line on stderr. It records an event in the config's `project` folder or in a folder inside it (a subfolder, a worktree in it, also through a link), and ignores an event in any other folder without a line. It ignores a `gate add` whose `--project` names a folder outside the project. In `--project`, a leading `~`, `$HOME` or `${HOME}` is the hook's HOME; a `gate add` whose `--project` has any other `$` or a backtick is ignored, because only the shell knows that folder. A folder whose name starts with two dots (for example `..cache`) is a folder inside the project. Its config is `~/.config/sage-bot/config.json`, or the file after `--config`.

**What the owner adds.** The owner adds the hook lines, the Discord permissions and a deny rule for the Discord plugin's `fetch_messages` tool; the bridge changes no settings file. The README's [setup checklist](../README.md#set-up-a-live-trial) shows each one. The tie posts in a thread hold reasons cleaned for people, not for a model, so the chief must not read them (see "The reason contract").

**The thread of a session.** `node scripts/session.mjs [--config <config.json>] thread <session id>` prints the thread id of a session, from the gate file. A session with no thread yet, or an id that is not a UUID, gives one line on stderr and exit code 1:

<!-- check: run, exit 1, prints "has no thread yet" -->
```sh
node scripts/session.mjs thread aaaaaaaa-0000-4000-8000-000000000052
```

## Run the checks

You need Node 22 or later, and `npm ci` once (discord.js and playwright-core, both pinned to one exact version).

<!-- check: skip, the check runs this test itself -->
```sh
npm run check
```

The check runs `node --check` on every source file, then the tests in `test/`. A test runs the example above and checks that this page holds it. Another test (`test/readme.test.js`) runs the shell commands of the README and of this page in a scratch HOME, and checks every relative link. The tests use sample ids only. The bridge tests run the sage state tool (`SAGE_TOOL`, by default the sage plugin's `sage.mjs`) with `HOME` and `SAGE_HOME` in a new scratch folder, so they never touch a real logbook, and they use the fake Discord layer, so they never connect to Discord. One test runs npm itself from another folder with `HOME` set to a scratch folder, to prove the `.npmrc`: npm writes and deletes no log file anywhere (`logs-dir=/dev/null`, `logs-max=0`). For a debug log of one command: `npm --logs-dir=/tmp/npm-logs --logs-max=5 <command>`.
