# sage-bot

sage-bot is the sage bridge. It is a Discord app that runs on the owner's Mac. It will post sage's gates as cards with buttons, check the voters' roles, record answers and votes, and give the final answers back to sage's logbook with `sage gate answer`.

This version has the vote rules (task B1) and the Discord layer: the cards, the reason form and the private notes (task B2). It has no Discord connection yet: no Client, no login, no token. The bridge service (B3) and the threads (B5) come later.

## The vote rules

`src/vote.js` holds the rules as data and pure functions. A gate and an event go in; the new gate and its effects come out. Each event carries its time, so the rules never read the clock.

| Case | Rule |
| --- | --- |
| Who counts | Only a holder: a Discord user id on the holder list that the bridge passes in with each event. The Discord admin gives and removes the role; there is no vote on it. Each id counts once. |
| Leads | A separate list of ids with the sage-lead role, which the admin gives. The bridge passes it in with each event. A lead action (end early, tie-break) counts only from a lead who is also a holder, and only from Discord, never from the terminal. |
| Kinds | Two only: single and batch. Any other kind is refused. |
| Single gate | One question with options, each option once. The first answer from a holder is final at once. A later press is ignored. A single answer has no reason. |
| Batch gate | The task's one batch of product questions, as parts, each with its own options (each option once in a part). It is a vote: every holder may vote on each part, and the last ballot of each person on each part counts. |
| Time limit | A batch vote ends 30 minutes after it opens (at 29:59.999 it is still open). Each part goes to the option with the most votes cast; people who did not vote do not count. The countdown keeps running while the owner's Mac sleeps: when the bridge wakes after the limit, its tick closes the vote with the votes cast so far. |
| Tie | A part with a tie, or with no votes, stays open. Only a lead decides it, by choosing one of the tied options (with no votes, every option is tied). While a part is tied, the batch is not closed: sage gets the answers only when every part is decided. |
| End early | A lead may end a batch vote at any time. The parts are then decided as at the time limit. |
| Holder list changes | A holder added to the list counts at once. A removed holder's ballot does not count at the time limit. Nothing is decided with no holders. |
| Reminder | A single gate with no answer: to the holders every 2 hours from opening. A batch with tied parts: to the leads every 2 hours after its vote ended, also when a lead ended it early. |
| Reason | Optional on a batch ballot, at most 500 characters (Unicode code points). A longer reason is cut to 500, with no error. The cut never splits an emoji or another character of two UTF-16 units; a lone surrogate becomes U+FFFD. An empty reason means no reason. B1 does not clean a reason in any other way (see below). |
| Terminal answer | The owner's answer at the terminal counts as the first answer on a single gate, and as one ballot in a batch. It counts only from a holder: the owner needs the sage-driver role like everyone else. |
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
- a TypeError for a missing `id` or `askedBy`, or for empty or duplicate options or parts.

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

### The gate and its outcome

| Field | Single | Batch |
| --- | --- | --- |
| `phase` | `'open'` or `'closed'` | `'voting'`, `'tied'` or `'closed'` |
| `outcome` | `{ status: 'open' }`, `{ status: 'answered', option, by, via }` or `{ status: 'withdrawn' }` | `{ status: 'open' }`, `{ status: 'decided' }` or `{ status: 'withdrawn' }` |
| `id`, `kind`, `askedBy` | as given to `openGate` | as given to `openGate` |
| `openedAt` | the `at` of `openGate` | the `at` of `openGate` |
| `lastAt` | the time of the last applied event (`openedAt` at first) | the same |
| other | `options` | `endsAt`, `votingEndedAt`, `parts` |

Each part of a batch has `options`, `outcome` (`{ status: 'open' }` or `{ status: 'decided', option, how }`) and, after the vote ended with no single leader, `tied` (the tied options). The final answers of a decided batch are the parts' outcomes; the parts of a withdrawn batch show `{ status: 'open' }` and keep their ballots. A part also has `ballots`, stored as `[id, ballot]` pairs so that the gate stays plain JSON. Do not read `ballots` directly: call `ballotsOf(part)`. It returns a Map from id to `{ option, at, via, reason? }`, the last ballot of each person.

A gate from `openGate`, `step` or `parseGate` is frozen all through: its parts, arrays, outcomes and ballots. `step` shares the unchanged parts between the old and the new gate, so the freeze keeps a change to one gate from reaching another.

A gate is plain JSON: it keeps one ballot per person on each part, so its size grows with the people, not with the presses, and its depth stays the same.

### parseGate(value)

Checks a loaded gate, freezes it all through and returns it. **The bridge (B3) must call `parseGate` on each gate that it loads**, for example from JSON after a restart. It throws a TypeError, with the reason, for a value that `openGate` and `step` could not have made: unknown fields, a phase that does not match the outcomes, a tied part without its tied options, an option that the gate or part does not have, a ballot by an empty id or a second ballot by one person, a reason that is empty, longer than 500 characters or has a lone surrogate, or a time that is not a safe integer or is later than `lastAt`. `step` and `nextReminderAt` make the same check.

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

Builds `{ holders, leads, names }` from the guild members (`{ id, name, roles, bot }`, with `roles` a list of role ids and `bot` discord.js's `member.user.bot`) and the config `{ driverRole, leadRole }`. The holders are exactly the members with the sage-driver role, and the leads exactly the members with the sage-lead role: the owner is not added by default, and a bot is neither, whatever its roles. The bridge passes `holders` and `leads` to the vote rules, which also need a lead to be a holder.

### card(gate, ask, people)

The card of a gate as `{ embeds, components, allowedMentions }`. Times are Discord timestamps, so each viewer's Discord shows them in the viewer's own zone, and the 30-minute countdown runs live with no edit of the card.

| State | The card |
| --- | --- |
| Single, open | The question, the options with Recommended and Default, the rule, one button per option. |
| Single, answered | "Answered by Maya at 14:22: A. … Final." The buttons are off; the chosen one is green. |
| Batch, voting | "Closes at 15:01 (in 18 minutes)". Per part: each option with its votes and voters ("Erick (terminal), Jon"), the chief's recommendation, "Voted: … · Not voted: …", and "Ahead: A", "Even so far" or "No votes yet". Each reason as one line, cut to 200 characters; when the card is full, the oldest reasons go first and one line says "N more reasons; the chief has them all"; a visibly empty reason (nothing but spaces, hidden characters or combining marks) shows no line. A button per option of each part, "Part 1, A: Only the columns visible in the table" (cut to 80 characters), and "End vote now (sage-lead only)". |
| Batch, tied | "Voting ended at 15:01. 1 part is tied: it waits for a sage-lead. The other parts are provisional, and T7 waits." (with every part tied: "2 parts are tied: they wait for a sage-lead. T7 waits."). After a lead's early end: "Ended early at 15:28 by a sage-lead, with the votes so far." A tied part shows "Tied: A, B at 1 vote each." and a button "Part 2, break the tie: A (sage-lead only)" for each tied option only (every option when nobody voted). Decided parts say "Provisional: A · 3 of 3 votes". |
| Batch, decided | "Voting ended at 15:01. Closed: every part is decided. T7 goes on." Every button is off. |
| Withdrawn | "Withdrawn by Erick at 15:30. Closed: nothing is decided." Every button is off. |

The words "Voting ended at" are for the vote; "Closed" is only for a decided or withdrawn gate. The card says "tie broken by a sage-lead" without the name, because the gate does not store it; the chief's message in the thread names the lead (B3, from the `tiebreak` event).

**Untrusted text.** A reason and a display name are text that a person reads on the card, and nothing else reads it: the chief gets the reasons from the stored ballot, cleaned by B3's own allow-list. `safe` keeps only what a person needs: a whole RGI emoji (a family, a skin tone, a keycap, the Scotland flag), a letter, a number, punctuation, a symbol that is not a pictograph, a space, at most 3 combining marks on a letter, and a joiner (U+200C, U+200D) between a letter (or its mark, such as a virama) and a letter of a joining script (Arabic, Syriac, the Indic scripts, Myanmar or Khmer), so that a Persian word and a Hindi conjunct stay whole. Everything else goes: `<`, `>` and the backtick (so no mention, timestamp, emoji code, code span or quote forms), every format character, variation selector, control, private-use and unassigned code point, and the five letters that look blank. Then `safe` escapes Discord markdown (discord.js `escapeMarkdown`) and every `[` and `]` (no masked link), breaks every `://` to `:// ` so that no URL is clickable (Discord does not link `www.` or a bare domain), and folds white space to one line. A text with nothing visible left gives `''`. Every message also carries `allowedMentions: { parse: [] }`, so nothing pings anyone. The reason form sets `max_length` to 500.

**Discord's limits.** One message holds 5 rows of buttons; an embed holds 25 fields and 6000 characters in all, a title of at most 256 characters, a description of at most 4096, and each field a name of at most 256 and a value of at most 1024; a button label holds 80 characters and a form title 45. A card uses one row per part, one more while the vote is open, and one field per part and per reason. B3 refuses an ask with more than 4 parts: `card` throws a RangeError for more than 5 rows, which a batch of 5 or more parts reaches while the vote is open; through `handle`, a press on such a batch still stores the ballot and shows the reason form (no card is built), and the form's submit then rejects and stores nothing. `card` never throws for a team of 2 to 5 with at most 4 parts, whatever the ask's texts hold: one budget builds the whole embed, measures every limit and shrinks it in a fixed order until all hold. First each text goes within its own limit (a field value in 1024), then the whole embed within 6000 characters and 25 fields. The budget drops the oldest reason fields (one at a time, for the whole embed only; the description then says "N more reasons; the chief has them all", a line that never shrinks), then cuts the voter lists (to "and N more"), then the why, then the option labels, then the question in the field name; the title is cut to 256 and a button label to 80. The lead's private confirm is budgeted the same way: in its 2000 characters, the voter lists shrink to "and N more" for a team far larger than 5. The keys, the counts and "The chief recommends A" never shrink. The single card shrinks the same way: the why, then the labels, then the question, so its description stays in 4096. B3 also keeps the texts of an ask reasonable, so that nothing is cut: with a team of 5, three labels of 80 characters and a why of 300 fit whole. The card shows each reason cut to 200 characters (the gate keeps the full 500), never through a flag or a family emoji, and the newest reasons that fit: a team of 5 with 4 parts and a 500-character reason from everyone shows the 19 newest of the 20 reasons with 15-character names (fewer with 32-character names). A randomized test of 2000 cards (a team of 2 to 5, 1 to 4 parts, 2 to 5 options, every gate state, questions to 1000 characters, labels to 500, a why to 4000, reasons to 500, names with markdown) proves that every limit holds. No field is ever empty, because Discord refuses an empty name or value: a reason that `safe` reduces to nothing gets no field, and a member whose name is missing or visibly empty shows as "member …6789" (the last 4 digits of an id of 4 or more digits) or "member" for any other id, everywhere, never as the raw id. `handle` builds its reply before it stores the new gate, so a card that cannot be built leaves the gate as it was.

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
| Anything the vote rules ignore | A private note for its `why` code. Every code has one; a non-holder gets "Your press did not count. Only people with the sage-driver role can answer or vote. You can still read this thread." |

Discord shows every button of a message to everyone, so a non-lead sees "End vote now" and the tie-break buttons too; a press gets the private note "Only a sage-lead can do this. Your votes on the parts count like everyone's." B3 must: call `parseGate` on each loaded gate; send the tick at `gate.endsAt` and the withdraw from sage through `step`; and edit the card message with `card(...)` whenever the gate changed but the reply was not the card (after a confirmed end, a dismissed form, a tick or a withdraw).

### The fake layer

`src/fake-discord.js` exports `fakeInteraction({ user, customId, fields, ephemeral, refuse })`: an interaction-like object for the tests and the preview, with the shape that `handle` reads and a `replies` list that records every answer as `{ kind, ...payload }` (kind `'reply'`, `'update'` or `'modal'`).

- `user`: the user id; `customId`: the button's or form's custom id.
- `fields`: the form's inputs by input id, only for a form submit; the reason form has one input, `'reason'`. A button press has no `fields`, as in discord.js, and `getTextInputValue('reason')` throws for a missing input, as in discord.js.
- `ephemeral`: true when the pressed message was private (the lead's confirm); it sets the Ephemeral flag of `message.flags`.
- `refuse`: an Error; every reply then rejects with it and records nothing, as Discord does for an unknown interaction.

### The preview

`node scripts/preview.mjs` renders the card JSON of the design's eleven moments, plus a card of a team of 5 with 4 parts and 500-character reasons, to `design/b2/index.html` with sample data. With `--shots` it also screenshots each moment to `design/b2/shots/` with the local Chrome (playwright-core, channel `chrome`); run it with `HOME` set to a scratch folder. Chrome runs with `--disable-gpu`, so the shots are byte-identical from one cold run to the next (the GPU raster path draws the rounded border corner by one shade differently in some runs).

## Run the checks

You need Node 22 or later, and `npm install` once (discord.js and playwright-core, both pinned to one exact version).

```sh
npm run check
```

The check runs `node --check` on every source file, then the tests in `test/`. A test runs the example above and checks that this README holds it. The tests use sample ids only. One test runs npm itself from another folder with `HOME` set to a scratch folder, to prove the `.npmrc`: npm writes and deletes no log file anywhere (`logs-dir=/dev/null`, `logs-max=0`). For a debug log of one command: `npm --logs-dir=/tmp/npm-logs --logs-max=5 <command>`.
