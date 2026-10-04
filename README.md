# sage-bot

sage-bot is the sage bridge. It is a Discord app that runs on the owner's Mac. It will post sage's gates as cards with buttons, check the voters' roles, record answers and votes, and give the final answers back to sage's logbook with `sage gate answer`.

This version has only the vote rules (task B1). It has no Discord connection yet. The Discord layer and the cards (B2), the bridge service (B3) and the threads (B5) come later.

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
| Terminal answer | The owner's answer at the terminal counts as the first answer on a single gate, and as one ballot in a batch. It counts only from a holder: the bridge always includes the owner in holders. |
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
| `bad-event` | The event is not an object, has an unknown type, or a field is missing or of the wrong type. |
| `bad-time` | `at` is not a safe integer. |
| `out-of-order` | `at` is earlier than the last applied event. |
| `not-holder` | `by` is not a holder. |
| `not-lead` | `by` is a holder but not a lead. |
| `lead-needs-discord` | A lead action came from the terminal. |
| `not-asker` | A withdraw from someone other than the asker. |
| `unknown-option` | The gate or part does not have this option. |
| `unknown-part` | The batch does not have this part. |
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

## Run the checks

You need Node 22 or later. There are no dependencies to install.

```sh
npm run check
```

The check runs `node --check` on every source file, then the tests in `test/`. A test runs the example above and checks that this README holds it. The tests use sample ids only.
