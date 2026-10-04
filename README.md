# sage-bot

sage-bot is the sage bridge. It is a Discord app that runs on the owner's Mac. It will post sage's gates as cards with buttons, check the voters' roles, record answers and votes, and give the final answers back to sage's logbook with `sage gate answer`.

This version has only the vote rules (task B1). It has no Discord connection yet. The Discord layer and the cards (B2), the bridge service (B3) and the threads (B5) come later.

## The vote rules

`src/vote.js` holds the rules as data and pure functions. A gate and an event go in; the new gate and its effects come out. Each event carries its time, so the rules never read the clock.

| Case | Rule |
| --- | --- |
| Who counts | Only a holder: a Discord user id on the holder list that the bridge passes in with each event. The Discord admin gives and removes the role; there is no vote on it. Each id counts once. |
| Leads | A separate list of ids with the sage-lead role, which the admin gives. The bridge passes it in with each event. A lead action counts only from Discord, never from the terminal. |
| Kinds | Two only: single and batch. Any other kind is refused. |
| Single gate | One question with options. The first answer from a holder is final at once. A later press is ignored. |
| Batch gate | The task's one batch of product questions, as parts, each with its own options. It is a vote: every holder may vote on each part, and the last ballot of each person on each part counts. |
| Time limit | A batch vote ends 30 minutes after it opens (at 29:59.999 it is still open). Each part goes to the option with the most votes cast; people who did not vote do not count. |
| Tie | A part with a tie, or with no votes, stays open. Only a lead decides it, by choosing one of its options. |
| End early | A lead may end a batch vote at any time. The parts are then decided as at the time limit. |
| Holder list changes | A holder added to the list counts at once. A removed holder's ballot does not count at the time limit. Nothing is decided with no holders. |
| Reminder | A single gate with no answer: to the holders every 2 hours from opening. A batch with tied parts: to the leads every 2 hours after its vote ended. |
| Reason | Optional on a batch ballot, at most 500 characters. Cleaning: NFKC; remove invisible format characters and variation selectors; a newline or control character becomes a space; remove `<`, `>`, backticks and their lookalikes. A reason that cleans to nothing is dropped. |
| Terminal answer | The owner's answer at the terminal counts as the first answer on a single gate, and as one ballot in a batch. |
| Outcome | Single: open, answered (option and who), or withdrawn. Batch: each part is open or decided (by votes or by a lead's tie-break); the batch closes when every part is decided. |
| Withdraw | The person who asked may withdraw the gate. |
| Odd input | `openGate` throws on a gate it refuses. `step` never throws: an odd event, a time that is not finite, or a time earlier than the last one is ignored, with the reason. |

## Run the checks

You need Node 22 or later. There are no dependencies to install.

```sh
npm run check
```

The check runs `node --check` on every source file, then the tests in `test/`. The tests use sample ids only.
