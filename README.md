# sage-bot

sage-bot is the sage bridge. It is a Discord app that runs on the owner's Mac. It will post sage's gates as cards with buttons, check the voters' roles, record answers and votes, and give the final answers back to sage's logbook with `sage gate answer`.

This version has only the vote rules (task B1). It has no Discord connection yet. The Discord layer and the cards (B2), the bridge service (B3) and the threads (B5) come later.

## The vote rules

`src/vote.js` holds the rules as data and pure functions. A gate and an event go in; the new gate and its effects come out. Each event carries its time, so the rules never read the clock.

| Case | Rule |
| --- | --- |
| Who counts | Only a holder: a Discord user id on the holder list on the Mac. The Discord role alone does not count until a role-change vote passes. |
| Normal gate | The first answer wins. For 10 minutes any holder may object (Object, or a different press). An objection makes a vote, which closes at a strict majority of the holders. |
| Critical gate | deploy, delete-data, publish, force-push, role-change. Every holder must say yes. One No rejects it. |
| Tie | Never acts and never takes a default. The vote has no deadline. A reminder is due every 2 hours. |
| Changed vote | The last ballot of each person counts. |
| Reason | Optional, at most 500 characters, without control characters, newlines, `<`, `>` or backticks. |
| Terminal answer | The owner's answer at the terminal counts as one press on a normal gate. It is refused on a critical gate. |
| Withdraw | The person who asked may withdraw the gate. |

## Run the checks

You need Node 22 or later. There are no dependencies to install.

```sh
npm run check
```

The check runs `node --check` on every source file, then the tests in `test/`. The tests use sample ids only.
