<a href="docs/assets/hero-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <img alt="sage-bot bridges Discord and Claude Code running sage: a crew member requests a feature, sage designs, the crew votes, sage builds and shows the results on request." src="docs/assets/hero-light.svg" width="100%">
</picture>
</a>

**sage-bot lets a small team build software together from a Discord server.** It is a bridge between Discord and a Claude Code session that runs [sage](https://github.com/erickb336/sage). The graphic shows the goal. A crew member requests a new feature in a thread. sage designs it and posts its design questions back as cards. The crew asks and votes, and the owner breaks ties. sage builds, with reviews and tests, and shows its progress and results on request: the board, screenshots and the link to the pull request. The owner merges. Nobody on the team needs a terminal.

**Today:** design questions as vote cards, team votes, the owner's tie-break or early end, read asks (the board, a task, the open questions and the shared files) and the kill switch work. A request from Discord does not reach a live Claude Code session yet: no Discord text reaches sage as an instruction. Bridge sessions add steps 1, 2 and 6 of the graphic; they wait on T159.

Ids such as T159 are sage task ids in this project's logbook. A G-id, such as G42, is a gate: a question that sage parks for the owner. The [reference](docs/reference.md) gives the gates and findings behind each rule.

<p align="center">
  <a href="https://github.com/erickb336/sage-bot/actions/workflows/check.yml"><img alt="check" src="https://github.com/erickb336/sage-bot/actions/workflows/check.yml/badge.svg"></a>
</p>

**Contents:** [Quick start](#quick-start) · [How it works](#how-it-works) · [Who is who](#who-is-who) · [What to say](#what-to-say) · [Safety](#safety) · [Set up a live trial](#set-up-a-live-trial) · [Concepts](#concepts) · [FAQ](#faq) · [Under the hood](#under-the-hood) · [Credits](#credits)

> **Status: built and tested on a fake Discord; the live trial has not run yet.** Read asks, team votes, the audit log and the kill switch run in the tests and in the demo. Bridge sessions (the owner, or the crew with the owner's approval, instructs sage and starts build sessions) are not built: they wait on T159.

## Quick start

You need Node 24 or later and the [sage](https://github.com/erickb336/sage) plugin in Claude Code. You do not need a Discord account, an app or a token for the demo.

**1. Get the code:**

<!-- check: skip, the test runs in a copy of this folder -->
```sh
git clone https://github.com/erickb336/sage-bot.git
cd sage-bot
```

**2. Install** (in the sage-bot folder):

<!-- check: run -->
```sh
npm ci
```

**3. Play the demo:**

<!-- check: run, prints "Page: " -->
```sh
npm run demo
```

The demo plays one sage session from start to end, with sample people and a scripted clock, on a fake Discord. It uses the real sage state tool, the real hook and the real bridge. It prints each step and the path of one HTML page.

**4. Open the page.** Open the path that the demo prints after `Page:`. The page shows the session's thread, each card at its final state, the private notes that each person sees, and the answers that sage got. The [reference](docs/reference.md#the-demo) gives the demo's options.

<a href="docs/assets/tip-mention-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-mention-dark.svg">
  <img alt="The toad sage's tip: mention @sage-bot in a registered channel. Each mention opens its own thread. Mention it again there to go on." src="docs/assets/tip-mention-light.svg" width="100%">
</picture>
</a>

To connect a real Discord server, follow [Set up a live trial](#set-up-a-live-trial).

## How it works

sage-bot is one small service, the bridge, on the owner's Mac. The graphic at the top shows the loop that it is for. Today it does three jobs:

1. **It answers read asks.** A member mentions @sage-bot, or types `/sage`. The bridge checks that the member is in the crew (or is the owner) and the hourly limit, reads sage's logbook, and answers. Code writes the answer, with no AI.
2. **It runs team votes.** sage marks a product question for the team. The bridge posts it as a card with a button for each option. When the question is decided, the bridge gives sage only the chosen option. A question of a task that came from an approved request goes to that request's thread, the task thread, as a vote of 10 minutes (see below).
3. **It keeps the messages to sage.** A crew member mentions @sage-bot (or uses "Send to sage" on any message) with an instruction, such as "implement what we discussed above". The bridge takes the earlier messages of the thread as context, and posts an approval card with the exact payload. The owner approves or declines each one; the owner's own message is approved at once. An approved message waits until bridge sessions (T159) give it to sage.

The bridge only reads the logbook, and it changes it only through the sage state tool. The owner's answer at the terminal is always final.

### A mention opens a thread

- Each mention in a registered channel opens a public thread, named from the request. The answer goes into the thread.
- A mention inside that thread continues it. sage-bot cannot read a message that does not mention it.
- A mention in a thread that sage-bot did not open, or in a forum post, gets one reply: mention me in the channel.
- The threads survive a restart of the bridge.

### A request thread becomes the task thread

- After the owner approves a request, its thread becomes the thread of the new sage task.
- When sage marks a design question of that task as a team vote, it appears there as a card. Every sage-crew member votes, within 10 minutes.
- A design question that sage does not mark as a team vote stays with the owner at the terminal.
- At 10 minutes the votes decide. A tie waits for the owner, and only the owner breaks it or ends the vote early.
- Other questions stay in the home channel, with 30 minutes, as before.

## Who is who

Each person runs their own sage-bot, with their own Discord app and their own Mac. Two kinds of people use it:

- **The owner** is the person who runs this sage-bot. sage-bot knows the owner by Discord user id: `ownerId` in the config, else the owner of the Discord app. A role never makes anyone the owner.
- **The crew** is every member with the role named exactly `sage-crew`. Every sage-bot in a server shares that one role.

| | The crew | The owner |
| --- | --- | --- |
| Read the board, a task, the open questions and the shared files | Yes | Yes |
| Answer a single question, and vote on a batch | Yes | Only with the sage-crew role; the owner's answer at the terminal is final |
| Break a tie, or end a vote early | No | Yes |
| Recommend on the autopilot question (the owner decides) | Yes | Only with the sage-crew role |
| Request a feature (`/sage request`), and withdraw it while it waits | Yes | Yes |
| Approve or decline a request | No | Yes |
| Unregister a channel | No | Yes |
| Turn off the link from Discord to sage (`/sage stop`), at once | Yes | Yes |
| Turn the link on again (at the terminal) | No | Yes |
| Send a message to sage (a mention or "Send to sage") | Yes: it waits for the owner's Approve | Yes: approved at once |
| Approve or decline a message to sage | No | Yes |
| Start build sessions | Not built: waits on T159 | Not built: waits on T159 |
| Asks in a rolling hour | 10 | 10 |

Anyone else gets one private line for a `/sage` command or a button, "Only the sage-crew role can use sage-bot.", and no reply to a mention. Nothing they do counts. Only the owner registers a channel, and only the owner turns the link to sage on again, both at the terminal.

## What to say

Each answer is public and pings nobody. The answer to a mention goes into its thread. Leave out `project` for the project of the channel. The examples use sample ids.

**As a crew member:**

| You want to | Say this |
| --- | --- |
| See the tasks by state, the tasks left and the open questions | `@sage-bot board` or `/sage board [project]` |
| See one task: its title, size, state and pull request | `@sage-bot T7` or `/sage task T7 [project]` |
| See the open questions, sage's recommendation and the default | `@sage-bot gates` (or `questions`), or `/sage gates [project]` |
| Get the project's shared graphics and PDFs | `@sage-bot files` or `/sage files [project]` |
| Request a feature | `/sage request [project]`, fill in the form, check it, then press Send. The request gets its own thread, and the owner approves or declines it there. You can withdraw it there while it waits. |
| Answer or vote on a team question | Press an option on its card |
| Recommend on the autopilot question | Press Yes or No on its card. The owner decides at the terminal. |
| Stop the link from Discord to sage at once, in an emergency | `/sage stop`, then the confirm button within 10 minutes. No approval is needed. Only the owner turns the link on again, at the terminal. |

A mention that names none of these words gets a reply that lists them.

**As the owner, in Discord:**

| You want to | Say this |
| --- | --- |
| Break a tie | Press a tie-break button on the card |
| Approve or decline a request | Press Approve or Decline on its card. Approve adds the sage task. You can also do it at the terminal: `node scripts/requests.mjs approve RQ1` |
| Stop sage-bot in this channel | `/sage unregister`, then the confirm button within 10 minutes |
| Turn off the link from Discord to sage, as any crew member can | `/sage stop`, then the confirm button within 10 minutes |
| Send a message to sage | `@sage-bot implement what we discussed above`, or "Send to sage" in the Apps menu of a message. The owner approves it on its card; it waits for bridge sessions (T159) |
| See the messages to sage (owner, terminal) | `node scripts/outbox.mjs list`, `node scripts/outbox.mjs show M1` |

**As the owner, at the terminal** (in the sage-bot folder). These commands read the bridge's config, `~/.config/sage-bot/config.json`: make it first with the [setup guide](docs/setup.md#the-checklist), step 3.

| You want to | Run this |
| --- | --- |
| Send a question to the team | `node scripts/vote.mjs --project <project> G42` |
| Register a channel for a project (stop the bridge first) | `node scripts/channels.mjs register <channel id> <project>` |
| See if the link from Discord to sage is on | `node scripts/leads.mjs status` |
| Turn the link on again | `node scripts/leads.mjs restore` |
| Check the audit log | `node scripts/leads.mjs verify` |

Time left is not estimated yet: the board shows the count of tasks left. The [setup guide](docs/setup.md#channels) tells how to register a channel, and the [reference](docs/reference.md#the-bridge-service) gives every command and option.

## Safety

**On now, for every ask:**

- **The crew, the owner and registered channels.** sage-bot works only in the channels that the owner registers, and only for the crew and the owner.
- **An hourly limit.** Each person can ask 10 times in a rolling hour, across all channels.
- **No AI reads Discord text today.** Code answers each read ask. A message to sage reaches sage only after the owner approves its exact payload, in an escaped data block, and only when bridge sessions come (T159). A vote gives sage only the option's letter and sage's own option text. sage reads a reason only through `scripts/reasons.mjs`, cleaned by an allow-list.
- **The answer shows little.** It shows a task's id, title, size, state and pull request, and the open questions. It never reads findings, briefs, reports or `decisions.tsv`.
- **The audit log.** Each message to sage, each decision on it and each read ask of the owner goes into an append-only log with a hash chain before it is kept, with the sha256 of the payload, and a copy goes to #sage-audit.
- **The kill switch.** Any crew member or the owner types `/sage stop` and confirms. The link goes off at once, with no approval. No message from Discord then goes to sage until the owner turns the link on again at the terminal. Read asks keep working.

**For bridge sessions, not on yet (T159):**

A bridge session will be a headless `claude -p` session that sage-bot starts for one thread, so that it delivers the approved messages to sage. Four layers will limit it:

- **The sandbox settings** (built and tested) hold the file and network boundary. They allow no GitHub host, and they deny the sage plugin folder, every logbook and the secret files.
- **The guard hook** (built and tested) is a second layer. It allows only the commands on its allow-list.
- **The broker** (built, not used by a session until T159) will give the session a few GitHub verbs: a fetch, an upload to its own branch, and its own pull request. None of them merges.
- **A spend cap** (built): the bridge policy starts each session with `--max-budget-usd 5`.

A text hook is only a second layer: the sandbox holds each file and network boundary. `npm run proof` checks the sandbox settings (it needs the `claude` command on PATH), and `npm run proof:live` runs the probes in real sessions. The [reference](docs/reference.md#the-guard-for-bridge-sessions) gives each layer and the findings behind it, and [the proof](docs/reference.md#the-proof-of-the-sandbox) lists each row.

## Set up a live trial

> **The live trial has not run yet.** The owner does each step by hand. sage-bot changes no settings file, and it never types a token.

The [setup guide](docs/setup.md) has the full checklist: each command, the permissions table and the reason for each step. In short:

1. **Make a Discord app only for sage-bot, with your own account.** Guild Install only, Public Bot off. Turn on the Server Members and Message Content intents.
2. **Make one mentionable role named `sage-crew`,** or use the one that the server has already.
3. **Fill in the config** in `~/.config/sage-bot/config.json`, from `examples/config.example.json`.
4. **Set the channel permissions,** so that only the crew can ask, and sage-bot can open and lock threads.
5. **Put the token in the Keychain** as the item `sage-bot`. Never type the token in a shell.
6. **Add the hook lines** to `.claude/settings.local.json` in each project.
7. **Deny the Discord plugin's `fetch_messages` tool** in the same settings file.
8. **Start the bridge** by hand once, then with launchd.
9. **Do a smoke test:** mark one test question, and press an option on its card.

## Concepts

| Word | Meaning |
| --- | --- |
| **sage** | The Claude Code plugin whose session frames the work and asks the questions. |
| **The owner** | The person who runs sage at the terminal and this sage-bot, known by Discord user id. The owner's answer is always final. Only the owner breaks ties, ends votes early and turns the link on again; the crew and the owner can stop it. |
| **The bridge** | sage-bot's service on the owner's Mac: `scripts/bridge.mjs`. |
| **The crew** | Every member with the Discord role named `sage-crew`: they read and ask, answer and vote, and can stop the link from Discord to sage at once. |
| **Registered channel** | A channel where sage-bot works, for one project. Only the owner registers one. |
| **Answer thread** | A thread that a mention opens. sage-bot answers read asks there. |
| **Message to sage** | A mention or a "Send to sage" with its context, kept in the outbox. The owner approves each crew message on its approval card. |
| **Task thread** | The thread of a request that the owner approved. The design questions of its sage task go there, as votes of 10 minutes. |
| **Question** | A sage gate: a question that sage parks for the owner, with options, a recommendation and a default. |
| **Team vote** | A question that sage marks for the team with `scripts/vote.mjs`. |
| **Card** | The Discord message of one question or one batch, with a button for each option. |
| **Audit log** | The append-only record of every message to sage and every decision on it, with a hash chain. |
| **Kill switch** | `/sage stop`: it turns off the link from Discord to sage until the owner turns it on at the terminal. |
| **Bridge session** | Not built (T159). A sage session that sage-bot will start for one thread, to deliver the approved messages to sage, inside the sandbox, the guard hook and the $5 cap. |

## FAQ

**Does a Discord message ever reach sage?** Not today. A read ask only reads the logbook. A vote gives sage only the chosen option. A message to sage waits in the outbox, approved by the owner, until bridge sessions come with T159.

**Can a teammate start work?** Not yet. A session starts only at the owner's terminal. Bridge sessions, which will let the crew ask for build sessions that the owner approves, wait on T159.

**Who decides the autopilot question?** The owner. The crew only recommends Yes or No. sage-bot never switches a mode of sage.

**What if the Mac sleeps?** The bridge stops while the Mac sleeps, so Discord shows "This interaction failed" for a press. When the Mac wakes, the bridge ends each vote that passed its limit and asks the team to press again.

**What does a person outside the crew see?** Nothing from sage-bot. Discord itself shows "The application did not respond" for a `/sage` command, or "This interaction failed" for a button, to that person only.

**Why does every mention open a thread?** Each request and its answer stay together, and the channel stays readable.

## Under the hood

| Path | What it is |
| --- | --- |
| `src/ask.js` | Read asks, `/sage` and the limit |
| `src/threads.js` | Mention threads |
| `src/vote.js` | The vote rules |
| `src/cards.js` | The cards |
| `src/handle.js` | A press of a button |
| `src/bridge.js` | The bridge's loop |
| `src/discord.js` | The only link to Discord |
| `src/crew.js` | Who is the crew and who is the owner |
| `src/audit.js` | Audit log, kill switch |
| `src/guard.js` | Guard hook (not on yet) |
| `src/session-policy.js` | Sandbox (not on yet) |
| `scripts/` | Commands, demo, graphics |
| `docs/setup.md` | The live trial checklist |
| `docs/reference.md` | **Every rule and setting** |

To run the checks:

<!-- check: skip, the check runs this test itself -->
```sh
npm run check
```

The check runs every test with sample data and a fake Discord. No test connects to Discord or reads the Keychain. The [check workflow](.github/workflows/check.yml) runs it on each push to main and on each pull request.

## Credits

- sage-bot is built for, and follows the rules of, [sage](https://github.com/erickb336/sage). Its graphics reuse sage's look and its toad sage: `scripts/sage-world.mjs` is a copy of sage's graphics code at commit `b0af484`, under the MIT licence.
- It uses [discord.js](https://discord.js.org) for the shapes of Discord messages, and [playwright-core](https://playwright.dev) for the screenshots.
- The Discord symbol in the diagrams is Discord's own file, unchanged, used to name the service in a flow. Discord is a trademark of Discord Inc. sage-bot is not affiliated with Discord.

## Licence

sage-bot is open source under the MIT licence: see [LICENSE](LICENSE).
