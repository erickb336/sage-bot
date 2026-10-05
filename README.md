# sage-bot

**sage-bot lets your team answer the chief's questions in Discord.** When a [sage](https://github.com/erickb336/sage) chief asks a product question, the chief can mark it as a team vote. A small service on the owner's Mac, the bridge, then posts the question as a card with buttons, counts the presses of the team, and gives the final answer back to sage. Nothing that the team types in Discord ever reaches the chief as an instruction: only the chosen option goes back.

> **Status: built and tested on a fake Discord; the live trial has not run yet.** Every part below runs in the tests and in the demo, with no Discord account. The first trial on a real Discord server is the next step: see [Set up a live trial](#set-up-a-live-trial).

**Contents:** [Try it](#try-it) · [How it works](#how-it-works) · [Rules held in code](#rules-held-in-code) · [Set up a live trial](#set-up-a-live-trial) · [Concepts](#concepts) · [What to do](#what-to-do) · [FAQ](#faq) · [Under the hood](#under-the-hood) · [Licence](#licence)

## Try it

You need Node 22 or later and the [sage](https://github.com/erickb336/sage) plugin in Claude Code. You do not need a Discord account, an app or a token. In the sage-bot folder, run:

<!-- check: run, prints "Page: " -->
```sh
npm ci
npm run demo
```

The demo plays one chief session from start to end, with sample people and a scripted clock. It uses the real sage state tool, the real hook and the real bridge, on a fake Discord. It prints each step, the answers that sage got, and the path of one HTML page. Open the page to see:

- the session's line in the parent channel, from "running" to "ended";
- the session thread, with each card at its final state;
- the private notes that each person sees, for example "Your press did not count";
- the answers in sage, and the reasons that the chief can read.

In the demo, Maya answers a single question first, so her answer is final. Sam has no role, so his press does not count. A batch vote ends in a tie, and Jon, a sage-lead, breaks it. Erick, the owner, answers one question at the terminal, and that answer is final. When the session ends, its thread locks.

All files go into a new scratch folder, so the demo never touches your home folder or a real logbook. To write the page to a path of your own, run `npm run demo -- --out <page.html>`. More options are in the [reference](docs/reference.md#the-demo).

## How it works

### The flow of one question

![The flow of one question, in 9 numbered steps between five lanes: the chief, the sage logbook, the bridge, the session thread and the team. 1, the chief asks a question in the logbook. 2, the chief marks it as a team vote. 3, the bridge reads it every 15 seconds. 4, the bridge posts a card in the session thread and pings sage-apprentice and sage-lead. 5, the team presses an option. 6, the thread sends the press to the bridge. 7, the bridge checks the role and the vote rules, and edits the card. 8, the bridge gives the final answer to the logbook. 9, the chief reads it and goes on.](docs/flow.svg)

1. The chief asks a question in sage, as usual. Most questions stay at the terminal for the owner.
2. When a question is for the team, the chief marks it with `node scripts/vote.mjs G42`.
3. The bridge reads sage's logbook every 15 seconds. It finds the marked question.
4. It posts a card in the thread of the chief's session, and pings the sage-apprentice and sage-lead roles.
5. A member of the team presses an option on the card.
6. The session thread sends the press to the bridge.
7. The bridge checks the person's role and applies the vote rules, then edits the card.
8. When the question is decided, the bridge gives sage the option's letter and text through the sage state tool.
9. The chief reads the answer in the logbook and goes on with the work.

The bridge only reads the logbook and calls the sage state tool. It never writes a logbook file itself.

### A question's life

![A question's life. A single question starts as Open; a batch of 2 to 4 starts as Voting. Open goes to Decided at the first press of a holder (a sage-apprentice or a sage-lead). Voting goes to Decided when the 30 minutes end with a clear leader, or when a sage-lead ends the vote. Voting goes to Tied when the 30 minutes end with a tie or no votes, and Tied goes to Decided when a sage-lead breaks the tie. Open goes to Withdrawn when the owner withdraws it at the terminal. From Open, Voting or Tied, the owner can answer the chief, and the question is Answered at the terminal, which is final. Decided: the bridge gives sage the answer. Answered: sage has it already. Withdrawn: sage gets nothing.](docs/states.svg)

| State | What it means | What the card shows |
| --- | --- | --- |
| Open | A single question waits for its first answer. | The options, the chief's recommendation and the default, one button per option. |
| Voting | A question in a batch vote. The team votes for 30 minutes, and each person can change a vote. | The votes and voters so far, each reason, and the time when the vote closes. |
| Tied | The 30 minutes ended with a tie or no votes. The question waits for a sage-lead. | "Tied: A, B at 1 vote each", and a tie-break button for each tied option. |
| Decided | A press, the votes or a sage-lead decided it. | The answer, who gave it, and the time. For a tie-break or an early end, the name of the lead. |
| Answered at the terminal | The owner answered the chief in the chat, at the terminal or through Remote Control, and the chief recorded it. This answer is final. | "Answered by Erick (terminal)", and the buttons go grey. |
| Withdrawn | The owner withdraws it at the terminal. Nothing is decided. | "Withdrawn by Erick at 15:30. Closed: nothing is decided." |

A **batch** is 2 to 4 questions that one task asks within 30 seconds. They share one card, one part for each question. The batch closes and goes to sage only when every part is decided.

### Session threads

![Session threads. The parent channel, for example #sage-chief, holds one line per chief session. The line of Session 14, Tue 4 Oct, says running, 4 tasks, 2 open questions; its thread holds the cards, tie posts, reminders and wake notes. The line of Session 15, Wed 5 Oct, says ended 18:02; its thread is locked.](docs/threads.svg)

- Each chief session that has a team vote gets one line in the parent channel and one thread.
- The thread is titled "Session N · weekday day month", for example "Session 14 · Tue 4 Oct".
- The bridge edits the line when a count changes, and when the session ends.
- When the session ended and all its questions are settled, the bridge archives and locks the thread. A resume opens it again.
- When someone deletes a session thread, the bridge posts each open card of it again in the parent channel, with the votes so far. The team votes there, and the reminders and tie posts go there. A settled card is not posted again. (G17)
- When the session then needs a new line, the old line says "moved to a new line below".
- A session thread holds the votes and the chief's posts only. To chat with the chief, use a separate channel.

The hook `scripts/hook.mjs` tells the bridge which session asked which question. Claude Code runs it at the start and end of each session, and after each Bash command.

## Rules held in code

These are the owner's decisions. Each one is in code and has tests. The ids in brackets (G9 to G17) are the owner's decisions in the sage logbook.

| Rule | Why | Where |
| --- | --- | --- |
| Only the questions that the chief marks with `scripts/vote.mjs` go to Discord. Every other question stays at the terminal. (G13) | Most questions are for the owner alone. The chief chooses which ones the team votes on. | `src/bridge.js` |
| A question about a merge is never posted, also when it is marked. Merges never go through a vote. | A merge is the owner's decision. | `src/bridge.js` |
| One card holds the questions that one task asks within 30 seconds: 1 question, or a batch of 2 to 4. (G9) | Questions asked together belong together, so the team votes on them together. | `src/bridge.js` |
| A task that asks 5 or more questions within 30 seconds keeps them at the terminal. | One card holds at most 4 parts (Discord allows 5 rows of buttons). | `src/bridge.js` |
| Only members with the sage-apprentice or the sage-lead role answer or vote. The holders are exactly those members. Each person has one of the two roles; a member with both counts as a sage-lead, and the bridge logs a line with their name. | The Discord admin decides who is on the team, with no vote. | `src/handle.js`, `src/vote.js` |
| On a single question, the first answer from a holder is final. | One answer is enough, and the work goes on at once. | `src/vote.js` |
| A batch is a 30-minute team vote. The last ballot of each person counts. | The team can discuss and change their minds. | `src/vote.js` |
| A tie, or a part with no votes, waits for a sage-lead. A lead acts only in Discord. | A person, not a coin, breaks a tie. | `src/vote.js` |
| The card names the lead who broke a tie or ended a vote early. (G11) | The team sees who decided. | `src/cards.js` |
| Reminders go out every 2 hours: to sage-apprentice and sage-lead for an open single question, to sage-lead only for a tie. | A question must not wait in silence. | `src/vote.js`, `src/bridge.js` |
| The owner's answer at the terminal is final. A press never replaces it. (G10) | The owner has the last word. | `src/bridge.js` |
| Only the owner withdraws a question, and the owner withdraws it at the terminal. | Nobody in Discord can cancel the chief's question. | `src/vote.js`, `src/bridge.js` |
| One thread per chief session, only for a session that acts as chief and has a team vote, titled "Session N · weekday day month". It locks when the session ended and its questions are settled. (G14, G15) | Each session's questions stay together, and an old thread takes no more presses. | `src/sessions.js`, `src/bridge.js` |
| When a session thread is deleted while a vote in it is open, each open card is posted again in the parent channel, with its votes. Its reminders and tie posts go there too. (G17) | The team can still vote. | `src/bridge.js` |
| A session thread holds the votes and the chief's posts only. Chat with the chief is in a separate channel. (G16) | Votes stay readable, and no chat text goes near the chief's answers. | Discord permissions, see [step 4](#set-up-a-live-trial) |
| No AI reads card text. The chief gets reasons only from `scripts/reasons.mjs`, cleaned by an allow-list. | A reason is untrusted text. It must never become an instruction to a model. | `src/clean.js` |
| One bridge at a time for a gate file. | Two bridges would post every card twice. | `src/state.js` |

## Set up a live trial

> **The live trial has not run yet.** This checklist comes from the principal engineer's check (run R260) for tasks T53 and T54. Every command in it runs in the tests, except the ones that need Discord, the Keychain or launchctl.

The owner does each step by hand. sage-bot changes no settings file, and it never types a token.

- [ ] **1. Make a Discord app only for sage-bot.** In the Discord Developer Portal, make a new application with a bot user. Turn on the **Server Members** intent. Invite it to your server with the `bot` scope. On the Bot page, choose **Reset Token**, and keep the token only for step 5.
  *Why:* the bridge reads the members' roles to know who may vote. Do not reuse the Discord plugin's bot: then one token could do both jobs, and a press could reach the chief's chat.
- [ ] **2. Make two roles: `sage-apprentice` and `sage-lead`.** Make both roles **mentionable**. Give each person who votes exactly one of them: sage-lead to the people who also break ties, sage-apprentice to everyone else.
  *Why:* a new card pings @sage-apprentice and @sage-lead, and a tie pings @sage-lead. If a role is not mentionable, its ping notifies nobody. A lead has every right of an apprentice, so a lead needs no second role.
- [ ] **3. Fill in the config.** Copy the example, then put in the 5 Discord ids: the server (`guildId`), the parent channel (`channelId`), the owner (`ownerId`) and the two roles (`apprenticeRole`, `leadRole`). Also set `project` (the sage project folder), `sagePath` (the sage plugin's `sage.mjs`) and `statePath` (the bridge's gate file).
  Keep the folder of `statePath` at mode 0700 (only you can read and write it).
  *Why:* the bridge reads only this file. It refuses a gate file, team votes file or session file in a folder that other users can write, unless the folder is sticky. To copy an id, turn on Developer Mode in Discord, then right-click the item.

  <!-- check: skip, the test writes a filled-in sample config in its place -->
  ```sh
  mkdir -p ~/.config/sage-bot
  cp examples/config.example.json ~/.config/sage-bot/config.json
  ```

- [ ] **4. Set the parent channel's permissions.**

  | Who | Permissions in the parent channel |
  | --- | --- |
  | @everyone | Deny Send Messages, Send Messages in Threads, Create Public Threads and Create Private Threads. |
  | sage-apprentice | Deny the same four permissions. |
  | sage-lead | Deny the same four permissions. |
  | The sage-bot app | Allow View Channel, Send Messages, Embed Links, Read Message History, Create Public Threads, Send Messages in Threads and Manage Threads. |

  **Do not let the Discord plugin watch this parent channel.** Chat with the chief in a separate channel.
  **The server owner and members with the Administrator permission ignore these denies.** Discord lets them type in every session thread, so they must not type there.
  *Why:* a session thread holds the votes and the chief's posts only (G16), so nobody types in it; the buttons and the reason forms work without send permissions. If the plugin watches the channel, an @sage message in any session thread reaches every running chief, and its `fetch_messages` tool can read the tie posts. The bridge needs Manage Threads to lock and unlock the threads.
- [ ] **5. Put the token in the Keychain.** Open Keychain Access, choose File, New Password Item. Set the name to `sage-bot` and paste the token from step 1 as the password. Never type the token in a shell.
  *Why:* the shell history keeps what you type. The bridge reads the item at start and never writes the token to a file or a log.
- [ ] **6. Add the hook lines.** Put these lines in `.claude/settings.local.json` in the folder you set as `project` in step 3. Use the absolute path of your sage-bot folder.

  ```json
  {
    "hooks": {
      "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/sage-bot/scripts/hook.mjs" }] }],
      "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/sage-bot/scripts/hook.mjs" }] }],
      "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/sage-bot/scripts/hook.mjs" }] }]
    }
  }
  ```

  *Why:* without the hook, the bridge does not know the chief's sessions, and every card goes to the parent channel.
- [ ] **7. Deny the Discord plugin's `fetch_messages` tool** in the same settings file. Its name is probably `mcp__plugin_discord_discord__fetch_messages`: confirm the exact name with `/mcp` first.

  ```json
  { "permissions": { "deny": ["mcp__plugin_discord_discord__fetch_messages"] } }
  ```

  *Why:* the tie posts hold reasons that are cleaned for people, not for a model. The chief must not read them.
- [ ] **8. Start the bridge by hand once, then with launchd.** First run it in a terminal and read its log:

  <!-- check: skip, needs Discord and the Keychain -->
  ```sh
  node scripts/bridge.mjs ~/.config/sage-bot/config.json
  ```

  When it works, stop it with Ctrl+C. Then write its launchd agent, so that it starts at each login and again after it stops:

  <!-- check: run, prints "wrote " -->
  ```sh
  node scripts/launchd.mjs ~/.config/sage-bot/config.json --out ~/Library/LaunchAgents/com.sage.bot.plist
  ```

  The script only writes the plist. You load it yourself:

  <!-- check: skip, changes the Mac's login items; the test never runs launchctl -->
  ```sh
  launchctl load ~/Library/LaunchAgents/com.sage.bot.plist
  ```

  The script refuses a config file that does not exist, is not JSON, lacks a field of step 3, or has a Discord id that is not 17 to 20 digits. It then exits 1 and leaves the plist file as it was, so fix the config and run it again. It writes the new plist to a temp file first, so a refused run never empties a working plist.

  The plist runs node through a path that a Node upgrade keeps, such as `/opt/homebrew/bin/node`. When the script prints "warning: … make the plist again after each Node upgrade", your node has no such path: after each Node upgrade, run the command above again and load the new plist. When it says that your node is an old node, a node from before a Homebrew upgrade still runs: run the command again with the current node that the message names. To see the node path of the plist, read the first entry of `ProgramArguments`:

  <!-- check: run -->
  ```sh
  plutil -p ~/Library/LaunchAgents/com.sage.bot.plist
  ```

  *Why:* the first run by hand shows a setup error at once. The log of the launchd agent is `~/Library/Logs/sage-bot.log`. When the node path of the plist does not exist, launchd cannot start the bridge, and this log gets no line.
- [ ] **9. Do a smoke test.** First start a new Claude Code session in your `project` folder (the folder you set as `project` in step 3), and turn on sage mode.
  *Why:* Claude Code loads the hooks only when a session starts. In a session that started before step 6, the bridge does not know the session, and the first card goes to the parent channel.

  Then ask the chief for one test question. Mark it with its id, for example G42, in a terminal in the sage-bot folder:

  <!-- check: run, prints "team votes: G42" -->
  ```sh
  node scripts/vote.mjs G42
  ```

  While it changes the list, `scripts/vote.mjs` holds a lock file next to the team votes file. If it says that another vote run holds the lock, wait and run it again. If no vote run is running, remove the lock file that the message names.

  Within a minute, a card appears in the session thread. Press an option. The card shows your answer, and the chief gets it in sage.

**What the first live trial checks first:**

1. The thread lock and unlock: a thread locks when its session ended and its questions are settled, and a resume opens it again.
2. The permission codes: what Discord answers when a permission is missing (for example 50001, Missing Access), and that the card then goes to the parent channel.
3. A press in a thread: it reaches the bridge, it counts, and the card changes.

## Concepts

| Word | Meaning |
| --- | --- |
| **Question** | A sage gate: a question that the chief parks for the owner, with options, a recommendation and a default. |
| **The chief** | The sage session that frames the work and asks the questions. It changes no files. |
| **The owner** | The person who runs sage at the terminal. In the demo, Erick. |
| **The team** | The members of the Discord server with the sage-apprentice or the sage-lead role. |
| **sage-apprentice** | The role for the people who answer and vote. |
| **sage-lead** | The role for the people who answer and vote, and also break ties and end votes early. A person has sage-apprentice or sage-lead, not both. |
| **Team vote** | A question that the chief marked with `scripts/vote.mjs`. Only these go to Discord. |
| **Card** | The Discord message of one question or one batch, with a button for each option. |
| **Batch** | 2 to 4 questions of one task, asked within 30 seconds, on one card. |
| **Session thread** | The Discord thread of one chief session. It holds that session's cards. |
| **Parent channel** | The channel that holds one line per chief session. People only read it. |
| **The bridge** | The service on the owner's Mac: `scripts/bridge.mjs`. |
| **Holder** | A member with the sage-apprentice or the sage-lead role. Only holders count. |

## What to do

Run each command in the sage-bot folder.

- `vote.mjs` and `session.mjs` read `~/.config/sage-bot/config.json`, unless you give `--config <file>` as the first argument.
- `bridge.mjs` and `launchd.mjs` take the path of the config file as their only argument.
- `reasons.mjs` takes the gate file (the `statePath` of the config) and a gate id.

| You want to | Do this |
| --- | --- |
| Send a question to the team | `node scripts/vote.mjs G42` (several ids in one command for one batch) |
| Take a question back to the terminal | `node scripts/vote.mjs --unmark G42`, before the card is posted |
| See the marked questions | `node scripts/vote.mjs --list` |
| Answer a question yourself | Answer the chief in the chat as usual; that answer is final. (G10) |
| Withdraw a single question | Tell the chief to withdraw it. The chief records an answer that names no option, and the card shows the question as withdrawn. |
| Read the team's reasons, as the chief | `node scripts/reasons.mjs <gate file> <gate id>` |
| Find a session's thread | `node scripts/session.mjs thread <session id>` |
| Check the launchd plist | `plutil -p ~/Library/LaunchAgents/com.sage.bot.plist`: the first entry of `ProgramArguments` is the node path |

## FAQ

**Does a Discord message ever reach the chief?** No. The bridge gives sage only the final answer: the option's letter and sage's own option text. The chief reads the reasons only through `scripts/reasons.mjs`, which keeps only letters, digits, spaces and `. , : -`, and frames each reason as quoted data. Two settings of the owner keep Discord text away from the chief too: the Discord plugin does not watch the parent channel ([step 4](#set-up-a-live-trial)), and its `fetch_messages` tool is denied ([step 7](#set-up-a-live-trial)). Those two are settings, not code.

**Can a teammate start work?** No. A session starts only at the owner's terminal: there is no "New session" button. A press can only answer or vote on a question that the chief marked. Chat with the chief happens in a separate channel, through the Discord plugin and its own settings, not through sage-bot.

**What if the Mac sleeps?** The bridge stops while the Mac sleeps, so a press in that time fails in Discord ("This interaction failed"). The 30-minute clock keeps running. When the Mac wakes, the bridge ends each vote that passed its limit with the votes cast, sends each due reminder once, and posts "The host was asleep from 22:10 to 08:05. Presses in that time did not count. Please press again on any open question." With launchd, the bridge also starts again after a crash or a restart.

**What if two people press at once?** The bridge is one process, and it decides each press in one step before it takes the next one. On a single question, the first press that reaches the bridge is final. The second person gets the private note "Already answered by Maya: A". In a batch, both votes count, and each person's last vote counts.

**How do I take a question back to the terminal?** Before the card is posted, unmark it: `node scripts/vote.mjs --unmark G42`. After the card is posted, unmarking does not take the card back. Then answer the chief in the chat as usual; that answer is final, the card shows "Answered by Erick (terminal)", and its buttons go grey. To cancel a single question, tell the chief to withdraw it: the chief records an answer that names no option, and the card shows the question as withdrawn.

**What if the owner answers at the terminal while the team votes?** The owner's answer wins (G10). The bridge reads the logbook before each press and before each answer that it gives sage, so it never replaces the owner's answer. If the chief records the owner's answer at the same moment that the bridge records a Discord answer, the bridge puts the owner's answer back and logs one line.

**Who sees a reason?** People see it on the card, cleaned for a person to read. The chief, a model, sees it only through `scripts/reasons.mjs`, cleaned by a separate allow-list for a model. No AI reads card text.

## Under the hood

| Path | What it is |
| --- | --- |
| `src/vote.js` | The vote rules: pure functions, no clock and no Discord. |
| `src/cards.js`, `src/handle.js` | The cards, the reason form, the private notes, and the handler of a press. |
| `src/bridge.js`, `src/discord.js` | The bridge's loop, and the only code that connects to Discord. |
| `src/state.js`, `src/sessions.js`, `src/sage.js` | The gate file and its lock, the session threads, and the calls to the sage state tool. |
| `src/clean.js` | The allow-lists for the terminal and for the chief. |
| `src/fake-discord.js` | The fake Discord for the tests and the demo. |
| `scripts/` | The commands: `bridge`, `vote`, `reasons`, `session`, `hook`, `launchd`, `demo` and `preview`. |
| `design/b2/` | The card design: one page and its screenshots, made by `node scripts/preview.mjs`. |
| `docs/reference.md` | **The full reference:** the vote rules and their API, the card states, every bridge case, the gate file, the hook and the checks. |

To run the checks:

<!-- check: skip, the check runs this test itself -->
```sh
npm run check
```

The check runs every test with sample data and a fake Discord. No test connects to Discord or reads the Keychain. `test/readme.test.js` runs the shell commands of this README and of the reference in a scratch home folder, and checks every relative link and image.

## Licence

Private, not licensed for use by others (`UNLICENSED` in `package.json`). sage-bot uses [discord.js](https://discord.js.org) for the shapes of Discord messages and [playwright-core](https://playwright.dev) for the screenshots. It is built for, and follows the rules of, [sage](https://github.com/erickb336/sage).
