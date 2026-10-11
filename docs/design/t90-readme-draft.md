<!-- T90 draft (run R721). This file is the proposed README.md. Its links and image paths are written for the repository root,
     so some do not resolve from docs/design/. Each TODO-VERIFY tag marks a claim that the run could not check against origin/main. -->

<a href="docs/assets/hero-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <img alt="sage-bot: ask sage from your team's Discord. Mention @sage-bot, and each mention opens its own thread. A flow of three nodes: Discord, your server, sends an ask to sage-bot on the owner's Mac, which reads sage's logbook. Two roles: sage-apprentice reads and asks; sage-lead also decides and stops. Discord is a trademark of Discord Inc. sage-bot is not affiliated with Discord." src="docs/assets/hero-light.svg" width="100%">
</picture>
</a>

**sage-bot is a bridge between [sage](https://github.com/erickb336/sage) and Discord that lets a small team read and answer sage's work from a Discord server.** Mention @sage-bot in a channel, and it answers in a thread of its own. Nobody on the team needs a terminal, and no Discord text reaches sage as an instruction.

<p align="center">
  <!-- TODO-VERIFY: no CI workflow exists on origin/main, so no checks badge is true yet. See QUESTIONS in the T90 report. -->
  <img alt="licence: private (UNLICENSED)" src="https://img.shields.io/badge/licence-private-555">
  <img alt="Node 22 or later" src="https://img.shields.io/badge/node-%E2%89%A522-555">
</p>

**Contents:** [Quick start](#quick-start) · [How it works](#how-it-works) · [Roles](#roles) · [What to say](#what-to-say) · [Safety](#safety) · [Set up a live trial](#set-up-a-live-trial) · [Concepts](#concepts) · [FAQ](#faq) · [Under the hood](#under-the-hood) · [Credits](#credits)

> **Status: built and tested on a fake Discord; the live trial has not run yet.** Read asks, team votes, the lead log and the kill switch run in the tests and in the demo. Lead sessions (a sage-lead who talks to sage, writes and starts build sessions) are not built: they wait on T159. <!-- TODO-VERIFY: T159 is the task id from the brief; origin/main does not name it. -->

## Quick start

You need Node 22 or later and the [sage](https://github.com/erickb336/sage) plugin in Claude Code. You do not need a Discord account, an app or a token for the demo.

**1. Install** (in the sage-bot folder):

```sh
npm ci
```

**2. Play the demo:**

```sh
npm run demo
```

The demo plays one sage session from start to end, with sample people and a scripted clock, on a fake Discord. It uses the real sage state tool, the real hook and the real bridge. It prints each step and the path of one HTML page.

**3. Open the page.** It shows the session's thread, each card at its final state, the private notes that each person sees, and the answers that sage got. The page is `sage-bot-demo.html` in your temp folder.

<a href="docs/assets/tip-mention-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-mention-dark.svg">
  <img alt="The toad sage's tip: mention @sage-bot in a registered channel. Each mention opens its own thread. Mention it again inside the thread to go on." src="docs/assets/tip-mention-light.svg" width="100%">
</picture>
</a>

To connect a real Discord server, follow [Set up a live trial](#set-up-a-live-trial).

## How it works

<a href="docs/assets/how-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-dark.svg">
  <img alt="How sage-bot works, in three rows across Discord, sage-bot (the bridge on the owner's Mac) and sage. 1, a read ask: a mention such as @sage-bot board goes to the bridge, which checks the role and the hourly limit and reads sage's logbook, read only; the answer goes into a new thread. 2, a team vote: sage marks a question, the bridge posts a card, the team presses, and only the chosen option goes back to sage. 3, a lead's talk: the bridge records it in the lead log and #sage-audit; a lead session with sage is not built yet (T159). No Discord text reaches sage as an instruction." src="docs/assets/how-light.svg" width="100%">
</picture>
</a>

sage-bot is one small service, the bridge, on the owner's Mac. It does three jobs:

1. **It answers read asks.** A member mentions @sage-bot, or types `/sage`. The bridge checks the member's role and the hourly limit, reads sage's logbook, and answers. Code writes the answer, with no AI.
2. **It runs team votes.** sage marks a product question for the team. The bridge posts it as a card with a button for each option. When the question is decided, the bridge gives sage only the chosen option.
3. **It records a lead's talk.** A sage-lead's mention with the word "talk" opens a lead thread. The bridge writes each message to the lead log and to #sage-audit. It does not go to sage yet: lead sessions wait on T159.

The bridge only reads the logbook, and it changes it only through the sage state tool. The owner's answer at the terminal is always final.

### A mention opens a thread

<a href="docs/assets/threads-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/threads-dark.svg">
  <img alt="A mention opens a thread, with sample data. In the registered channel #ask-sage, Maya, an apprentice, writes @sage-bot board, and sage-bot opens a public thread named board with the answer. Inside the thread she writes @sage-bot T7 and gets that task. Jon, a lead, writes @sage-bot talk; that opens a lead thread, where sage-bot replies that his message is recorded in the lead log and that sessions with sage are not on yet." src="docs/assets/threads-light.svg" width="100%">
</picture>
</a>

- Each mention in a registered channel opens a public thread, named from the request. The answer goes into the thread.
- A mention inside that thread continues it. sage-bot cannot read a message that does not mention it.
- A mention in a thread that sage-bot did not open, or in a forum post, gets one reply: mention me in the channel.
- The threads survive a restart of the bridge.

## Roles

<a href="docs/assets/roles-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/roles-dark.svg">
  <img alt="The two roles. sage-apprentice reads and asks: the board, one task, the open questions, the shared graphics and PDFs, and answers and votes on team questions. Time left is not estimated yet. sage-lead can do everything an apprentice can, plus: break a tie or end a vote early; recommend on the autopilot question, where the owner decides; unregister a channel; and turn off the link from Discord to sage. Talking to sage, write operations and build sessions are not built yet (T159). A member with no role gets no answer." src="docs/assets/roles-light.svg" width="100%">
</picture>
</a>

The Discord admin gives each person on the team one of two roles. A member with both counts as a sage-lead.

| | sage-apprentice | sage-lead |
| --- | --- | --- |
| Read the board, a task, the open questions and the shared files | Yes | Yes |
| Answer a single question, and vote on a batch | Yes | Yes |
| Break a tie, or end a vote early | No | Yes |
| Recommend on the autopilot question (the owner decides) | No | Yes |
| Unregister a channel | No | Yes |
| Turn off the link from Discord to sage (`/sage stop`) | No | Yes |
| Talk to sage, write, and start build sessions | No | Not built: waits on T159 |
| Asks in a rolling hour | 10 | 10 |

A member with neither role gets no reply, and nothing they do counts. Only the owner registers a channel, and only the owner turns the link to sage on again, both at the terminal.

## What to say

Each answer is public in its thread, and it pings nobody. Leave out `project` for the project of the channel. The examples use sample ids.

**As a sage-apprentice or a sage-lead:**

| You want to | Say this |
| --- | --- |
| See the tasks by state, the tasks left and the open questions | `@sage-bot board` or `/sage board [project]` |
| See one task: its title, size, state and pull request | `@sage-bot T7` or `/sage task T7 [project]` |
| See the open questions, sage's recommendation and the default | `@sage-bot gates` (or `questions`), or `/sage gates [project]` |
| Get the project's shared graphics and PDFs | `@sage-bot files` or `/sage files [project]` |
| Answer or vote on a team question | Press an option on its card |

A mention that names none of these words gets a reply that lists them.

**As a sage-lead, also:**

| You want to | Say this |
| --- | --- |
| Break a tie | Press a tie-break button on the card |
| Recommend on the autopilot question | Press Yes or No on its card. The owner decides at the terminal. |
| Stop sage-bot in this channel | `/sage unregister`, then the confirm button |
| Turn off the link from Discord to sage | `/sage stop`, then the confirm button within 10 minutes |
| Talk to sage | `@sage-bot talk …`: recorded in the lead log only, until T159 |

**As the owner, at the terminal** (in the sage-bot folder):

| You want to | Run this |
| --- | --- |
| Send a question to the team | `node scripts/vote.mjs G42` in the project's folder |
| Register a channel for a project | `node scripts/channels.mjs register <channel id> <project>` |
| See if the link from Discord to sage is on | `node scripts/leads.mjs status` |
| Turn the link on again | `node scripts/leads.mjs restore` |
| Check the lead log | `node scripts/leads.mjs verify` |

Time left is not estimated yet: the board shows the count of tasks left.

## Safety

<a href="docs/assets/safety-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/safety-dark.svg">
  <img alt="The guardrails. On now, for every ask: roles and registered channels; an hourly limit of 10 asks for each person; no AI reads Discord text; the lead log, hash-chained and copied to #sage-audit; and the kill switch, which only the owner turns back on. For lead sessions, not on yet (T159): the sandbox settings, built, which are the guarantee; the guard hook, built, and the broker, coming in T158, whose verbs never merge; and a spend cap, built, of 5 dollars of model use for each lead session." src="docs/assets/safety-light.svg" width="100%">
</picture>
</a>

**On now, for every ask:**

- **Roles and registered channels.** sage-bot works only in the channels that the owner registers, and only for the two roles.
- **An hourly limit.** Each person can ask 10 times in a rolling hour, across all channels.
- **No AI reads Discord text.** Code answers each read ask. A vote gives sage only the option's letter and sage's own option text. sage reads a reason only through `scripts/reasons.mjs`, cleaned by an allow-list.
- **The answer shows little.** It shows a task's id, title, size, state and pull request, and the open questions. It never reads findings, briefs, reports or `decisions.tsv`.
- **The lead log.** Each message of a sage-lead to sage-bot goes into an append-only log first, with a hash chain, and a copy goes to #sage-audit.
- **The kill switch.** A sage-lead or the owner types `/sage stop` and confirms. Nothing of a lead then goes to sage until the owner turns the link on again at the terminal. Read asks keep working.

**For lead sessions, not on yet (T159):**

A lead session will be a headless `claude -p` session that sage-bot starts for one lead thread. Four layers will limit it:

- **The sandbox settings** (built and tested) are the guarantee. They allow no GitHub host, and they deny the sage plugin folder, every logbook and the secret files.
- **The guard hook** (built and tested) is a second layer. It allows only the commands on its allow-list.
- **The broker** (not built: T158) will give the session a few GitHub verbs: a fetch, an upload to its own branch, and its own pull request. None of them merges.
- **A spend cap** (built): the lead policy starts each session with `--max-budget-usd 5`.

A text hook never guarantees a file or network boundary; only the sandbox does. `npm run proof` checks the sandbox settings, and `npm run proof:live` runs the probes in real sessions. The [reference](docs/reference.md#the-proof-of-the-sandbox) lists each row.

## Set up a live trial

> **The live trial has not run yet.** The owner does each step by hand. sage-bot changes no settings file, and it never types a token. <!-- TODO-VERIFY: this condensed list drops the detail and the "Why" lines of the current README. Decide where the full checklist lives (see QUESTIONS). -->

1. **Make a Discord app only for sage-bot.** Turn on the Server Members intent, and leave the Message Content intent off. Invite it with the `bot` and `applications.commands` scopes.
2. **Make two mentionable roles:** `sage-apprentice` and `sage-lead`.
3. **Fill in the config.** Copy the example to `~/.config/sage-bot/config.json`, and put in the Discord ids and the projects.
4. **Set the channel permissions,** so that only the two roles can ask, and sage-bot can open and lock threads.
5. **Put the token in the Keychain** as the item `sage-bot`. Never type the token in a shell.
6. **Add the hook lines** to `.claude/settings.local.json` in each project.
7. **Deny the Discord plugin's `fetch_messages` tool** in the same settings file.
8. **Start the bridge** by hand once, then with launchd.
9. **Do a smoke test:** mark one test question, and press an option on its card.

The commands for step 3:

```sh
mkdir -p ~/.config/sage-bot
```

```sh
cp examples/config.example.json ~/.config/sage-bot/config.json
```

The command for step 8, after the bridge works by hand:

```sh
node scripts/launchd.mjs ~/.config/sage-bot/config.json --out ~/Library/LaunchAgents/com.sage.bot.plist
```

## Concepts

| Word | Meaning |
| --- | --- |
| **sage** | The Claude Code plugin that runs a session as your chief of staff. It frames the work and asks the questions. |
| **The owner** | The person who runs sage at the terminal. The owner's answer is always final. |
| **The bridge** | sage-bot's service on the owner's Mac: `scripts/bridge.mjs`. |
| **sage-apprentice** | The Discord role that reads and asks, and answers and votes. |
| **sage-lead** | The Discord role that can do everything an apprentice can, and also decides ties and stops the link. |
| **Registered channel** | A channel where sage-bot works, for one project. Only the owner registers one. |
| **Answer thread** | A thread that a mention opens. sage-bot answers read asks there. |
| **Lead thread** | A thread that a sage-lead's "talk" opens. Each message there goes into the lead log. |
| **Question** | A sage gate: a question that sage parks for the owner, with options, a recommendation and a default. |
| **Team vote** | A question that sage marks for the team with `scripts/vote.mjs`. |
| **Card** | The Discord message of one question or one batch, with a button for each option. |
| **Lead log** | The append-only record of every message that a sage-lead sends to sage-bot, with a hash chain. |
| **Kill switch** | `/sage stop`: it turns off the link from Discord to sage until the owner turns it on at the terminal. |
| **Lead session** | Not built (T159). A sage session that sage-bot will start for one lead thread, inside the sandbox. |

## FAQ

**Does a Discord message ever reach sage?** No. A read ask only reads the logbook. A vote gives sage only the chosen option. A lead's talk goes only into the lead log until lead sessions come with T159.

**Can a teammate start work?** Not yet. A session starts only at the owner's terminal. Lead sessions, which will let a sage-lead start build sessions, wait on T159.

**Who decides the autopilot question?** The owner. The sage-leads only recommend Yes or No. sage-bot never switches a mode of sage.

**What if the Mac sleeps?** The bridge stops while the Mac sleeps, so Discord shows "This interaction failed" for a press. When the Mac wakes, the bridge ends each vote that passed its limit and asks the team to press again.

**What does a person with no role see?** Nothing from sage-bot. For a `/sage` command or a button, Discord itself shows "The application did not respond" to that person only.

**Why does every mention open a thread?** Each request and its answer stay together, and the channel stays readable.

## Under the hood

| Path | What it is |
| --- | --- |
| `src/ask.js`, `src/threads.js` | The read asks, the mention threads, `/sage unregister`, `/sage stop` and the hourly limit. |
| `src/vote.js`, `src/cards.js`, `src/handle.js` | The vote rules, the cards and the handler of a press. |
| `src/bridge.js`, `src/discord.js` | The bridge's loop, and the only code that connects to Discord. |
| `src/audit.js` | The lead log and the kill switch. |
| `src/guard.js`, `src/lead-policy.js` | The guard hook and the sandbox settings for lead sessions (not on yet). |
| `scripts/` | The commands, the demo, and `graphics.mjs`, which draws the README's graphics. |
| `docs/reference.md` | **The full reference:** every rule, case and setting. |

To run the checks:

```sh
npm run check
```

The check runs every test with sample data and a fake Discord. No test connects to Discord or reads the Keychain.

## Credits

- sage-bot is built for, and follows the rules of, [sage](https://github.com/erickb336/sage). Its graphics reuse sage's look and its toad sage (MIT).
- It uses [discord.js](https://discord.js.org) for the shapes of Discord messages, and [playwright-core](https://playwright.dev) for the screenshots.
- The Discord symbol in the diagrams is Discord's own file, unchanged, used to name the service in a flow. Discord is a trademark of Discord Inc. sage-bot is not affiliated with Discord.

## Licence

Private, not licensed for use by others (`UNLICENSED` in `package.json`).
