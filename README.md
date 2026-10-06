# sage-bot

**sage-bot lets your team answer sage's questions in Discord.** When [sage](https://github.com/erickb336/sage) asks a product question, sage can mark it as a team vote. A small service on the owner's Mac, the bridge, then posts the question as a card with buttons, counts the presses of the team, and gives the final answer back to sage. Nothing that the team types in Discord ever reaches sage as an instruction: only the chosen option goes back.

> **Status: built and tested on a fake Discord; the live trial has not run yet.** Every part below runs in the tests and in the demo, with no Discord account. The first trial on a real Discord server is the next step: see [Set up a live trial](#set-up-a-live-trial).

**Contents:** [Try it](#try-it) · [How it works](#how-it-works) · [Rules held in code](#rules-held-in-code) · [Set up a live trial](#set-up-a-live-trial) · [Concepts](#concepts) · [What to do](#what-to-do) · [FAQ](#faq) · [Under the hood](#under-the-hood) · [Licence](#licence)

## Try it

You need Node 22 or later and the [sage](https://github.com/erickb336/sage) plugin in Claude Code. You do not need a Discord account, an app or a token. In the sage-bot folder, run:

<!-- check: run, prints "Page: " -->
```sh
npm ci
npm run demo
```

The demo plays one sage session from start to end, with sample people and a scripted clock. It uses the real sage state tool, the real hook and the real bridge, on a fake Discord. It prints each step, the answers that sage got, and the path of one HTML page. Open the page to see:

- the session's line in the parent channel, from "running" to "ended";
- the session thread, with each card at its final state;
- the private notes that each person sees, for example "Your press did not count";
- the answers in the logbook, and the reasons that sage can read.

In the demo, Maya answers a single question first, so her answer is final. Sam has no role, so sage-bot ignores his press: he gets no reply, and the press does not count. A batch vote ends in a tie, and Jon, a sage-lead, breaks it. Erick, the owner, answers one question at the terminal, and that answer is final. When the session ends, its thread locks.

All files go into a new scratch folder, so the demo never touches your home folder or a real logbook. To write the page to a path of your own, run `npm run demo -- --out <page.html>`. More options are in the [reference](docs/reference.md#the-demo).

## How it works

### The flow of one question

![The flow of one question, in 9 numbered steps between five lanes: sage, the logbook, the bridge, the session thread and the team. 1, sage asks a question in the logbook. 2, sage marks it as a team vote. 3, the bridge reads it every 15 seconds. 4, the bridge posts a card in the session thread and pings sage-apprentice and sage-lead. 5, the team presses an option. 6, the thread sends the press to the bridge. 7, the bridge checks the role and the vote rules, and edits the card. 8, the bridge gives the final answer to the logbook. 9, sage reads it and goes on.](docs/flow.svg)

1. sage asks a question in the logbook, as usual. Most questions stay at the terminal for the owner.
2. When a question is for the team, sage marks it with `node scripts/vote.mjs G42`, in its project's folder. The script takes the project of that folder.
3. The bridge reads sage's logbook every 15 seconds. It finds the marked question.
4. It posts a card in the thread of sage's session, and pings the sage-apprentice and sage-lead roles.
5. A member of the team presses an option on the card.
6. The session thread sends the press to the bridge.
7. The bridge checks the person's role and applies the vote rules, then edits the card.
8. When the question is decided, the bridge gives sage the option's letter and text through the sage state tool.
9. sage reads the answer in the logbook and goes on with the work.

The bridge only reads the logbook and calls the sage state tool. It never writes a logbook file itself.

### A question's life

![A question's life. A single question starts as Open; a batch of 2 to 4 starts as Voting. Open goes to Decided at the first press of a holder (a sage-apprentice or a sage-lead). Voting goes to Decided when the 30 minutes end with a clear leader, or when a sage-lead ends the vote. Voting goes to Tied when the 30 minutes end with a tie or no votes, and Tied goes to Decided when a sage-lead breaks the tie. Open goes to Withdrawn when the owner withdraws it at the terminal. From Open, Voting or Tied, the owner can answer sage, and the question is Answered at the terminal, which is final. Decided: the bridge gives sage the answer. Answered: sage has it already. Withdrawn: sage gets nothing.](docs/states.svg)

| State | What it means | What the card shows |
| --- | --- | --- |
| Open | A single question waits for its first answer. | The options, sage's recommendation and the default, one button per option. |
| Voting | A question in a batch vote. The team votes for 30 minutes, and each person can change a vote. | The votes and voters so far, each reason, and the time when the vote closes. |
| Tied | The 30 minutes ended with a tie or no votes. The question waits for a sage-lead. | "Tied: A, B at 1 vote each", and a tie-break button for each tied option. |
| Decided | A press, the votes or a sage-lead decided it. | The answer, who gave it, and the time. For a tie-break or an early end, the name of the lead. |
| Answered at the terminal | The owner answered sage in the chat, at the terminal or through Remote Control, and sage recorded it. This answer is final. | "Answered by Erick (terminal)", and the buttons go grey. |
| Withdrawn | The owner withdraws it at the terminal. Nothing is decided. | "Withdrawn by Erick at 15:30. Closed: nothing is decided." |

A **batch** is 2 to 4 questions that one task asks within 30 seconds. They share one card, one part for each question. The batch closes and goes to sage only when every part is decided.

### Session threads

![Session threads. The parent channel, for example #sage, holds one line per sage session. The line of Session 14, Tue 4 Oct, says running, 4 tasks, 2 open questions; its thread holds the cards, tie posts, reminders and wake notes. The line of Session 15, Wed 5 Oct, says ended 18:02; its thread is locked.](docs/threads.svg)

- Each sage session that has a team vote gets one line in the parent channel and one thread.
- The thread is titled "Session N · project · weekday day month", for example "Session 14 · sage-bot · Tue 4 Oct". The project is the session's project in `projects`.
- The bridge edits the line when a count changes, and when the session ends.
- When the session ended and all its questions are settled, the bridge archives and locks the thread. A resume opens it again.
- When someone deletes a session thread, the bridge posts each open card of it again in the parent channel, with the votes so far. The team votes there, and the reminders and tie posts go there. A settled card is not posted again. (G17)
- When the session then needs a new line, the old line says "moved to a new line below".
- A session thread holds the votes and sage-bot's posts only: its cards, tie posts and reminders. To chat with sage, use a separate channel.

### A leads-only question

Some questions are for the sage-leads alone, and only as advice. The first one is the owner's decision G18 (item 8): sage may ask whether to switch on its automatic-merge mode for a session. The sage-leads recommend Yes or No; Erick decides at the terminal.

1. sage asks the question as a normal sage gate, with exactly the question "Switch the automatic-merge mode on for this session?" and the options `Yes|No`, and marks it with `node scripts/vote.mjs --leads G42`. One gate only: a batch is refused. Any other question is refused, so the leads never answer a merge of a pull request or another decision of Erick.
2. The bridge posts the card in the session thread (or the parent channel), titled "Recommend for Erick: Question your-project/G42 · …", and pings the sage-lead role only.
3. Only a sage-lead can press. A sage-apprentice gets the private note "Only a sage-lead can answer this. Erick decides." A member with neither role gets no reply.
4. The first lead's press is the leads' recommendation. The bridge gives it to sage marked as advice ("A. Yes (sage-leads recommend; the owner decides)"), posts "Recommendation recorded: Jon recommends Yes. Erick decides at the terminal." below the card, and prints one line in the bridge's log. For Yes it is "your-project/G42: sage-leads recommend Yes. If you agree, switch the mode yourself at the terminal." For No it is "your-project/G42: sage-leads recommend No. If you agree, do nothing; the mode stays off." A later press, also Erick's own press in Discord, gets the private note "Already recommended by Jon (sage-lead): A. Yes. A recommendation only; Erick decides at the terminal. Your press did not count."
5. Erick decides. To switch the mode, Erick types the mode's own message at the terminal; sage-bot never switches it, never writes sage's hook state, and never prints that message. Erick's own answer to sage is final, also after the leads' recommendation (G10).

The hook `scripts/hook.mjs` tells the bridge which session asked which question. Claude Code runs it at the start and end of each session, and after each Bash command.

### More than one project

One bridge posts the cards of every project in the config's `projects` (T132). Each project keeps its own sage logbook, and each logbook has its own G1. So the bridge names each question by its project and its id, for example `sage-bot/G1`.

| Where | What you see for G1 of the project `sage-bot` |
| --- | --- |
| The card title | `Question sage-bot/G1 · T5 …` |
| The ping above the card | `@sage-apprentice @sage-lead sage-bot T5 needs one product answer.` |
| The session thread | `Session 3 · sage-bot · Tue 4 Oct`, in the home channel, as for one project |
| The team votes list | `team votes: sage-bot/G1` (the file also holds the folder of each mark) |

- sage marks a question with `node scripts/vote.mjs G1` in the project's folder, or names the project with `--project <name>`: `node scripts/vote.mjs --project sage-bot G1`. Without `--project`, the question is of the listed project whose folder holds the folder that sage runs it in (the deepest one, as for the hook). In a folder that no listed project holds, `vote.mjs` and `reasons.mjs` stop with one line that asks for `--project`, and nothing changes. With one project, run them in its folder, or give `--project`.
- A press records the answer in the logbook of the card's project only. A press on G1 of one project never changes G1 of another project.
- Erick's answer at the terminal is final in every project (G10).
- A project that is not in the config's `projects` gets no cards. `vote.mjs` and `reasons.mjs` refuse its name, and refuse to guess a project from a folder outside every listed folder.
- Each card and each mark holds the folder of its project, not only its name. If you point a name at another folder (or swap two names), the old cards close once with the note below, and a press on them records nothing. An answer in the new folder never shows on an old card, and an old mark does not count for the new folder: mark the question again.
- The bridge's own `project` must be one of `projects`. A trailing slash or a symlink is the same folder. If no listed project has that folder, the bridge, the hook, `vote.mjs` and `reasons.mjs` stop with one line: add the project to `projects`, with a name.
- Each listed folder must exist, and each one is the folder of one project only. The bridge reads each path once, at the start, as the real path of its folder in the letter case of the disk, and names the project by that path everywhere. The bridge (at the start, before its lock and the Keychain), the hook, `vote.mjs`, `reasons.mjs`, `launchd.mjs` and `channels.mjs` stop with one line that names the project and its path when:
  - a listed folder does not exist: "the folder of project beta (/Users/you/beta) does not exist. Fix its path in projects, or take the project out. Nothing changed."
  - a listed path differs from its folder on disk only in letter case (`/Users/you/BETA` for the folder `beta`). Write it as the disk spells it.
  - two names are for one folder, also through a symlink or a trailing slash. Keep one of them.
  - a listed path goes through a symlink to a folder that is not in git: the sage state tool keeps the logbook of such a folder by the path as written. Write the real path.
  - the config's `project` or a listed path is not an absolute path, for example `~/beta`: "the config: project must be an absolute path".
- A card of a project that you take out of `projects` takes no more presses. At its next start, the bridge closes each open card of that project once, also across later restarts: the buttons go, and the card says "This question's project is no longer served; Erick answers it at the terminal." The card gets no reminders, and its thread can lock. A press on an old copy of the card gets the same note. The body of a closed card has no rule, reminder or who-can-answer line: it says "**Closed:** this question's project is no longer served; Erick answers it at the terminal." When you put the project back in `projects`, its closed cards get their normal body and their buttons back without the note, and then the reminders again.
- Keep each project's name as it was at its first start. The bridge knows a project only by its name, so a new name is a new project: the cards of the old name stop, and a question that sage marks again under the new name is not posted while its old card exists. To find the name, look at a card title or a thread title (`Question sage-bot/G1`, `Session 3 · sage-bot · Tue 4 Oct`), or at the keys in the team votes list. At each start, the bridge logs one line that names every card and mark of a project that is not in `projects`, for example "the gate file holds cards of project 'project', which is not in projects: G1, G2; keep a project's name as it was at its first start". If you see that line after a rename, put the old name back.
- With one project, you also see its name: in the card title, in the ping and in the thread title, as in the table above.
- At the first start after the update, the bridge moves its gate file, its team votes list and its leads-only list to the new names, once. Each card from before keeps its old buttons until the bridge edits it. Until then, an old button still counts on that card.

## Rules held in code

These are the owner's decisions. Each one is in code and has tests. The ids in brackets (G9 to G17) are the owner's decisions in the sage logbook.

| Rule | Why | Where |
| --- | --- | --- |
| Only the questions that sage marks with `scripts/vote.mjs` go to Discord. Every other question stays at the terminal. (G13) | Most questions are for the owner alone. sage chooses which ones the team votes on. | `src/bridge.js` |
| A question about a merge is never posted, also when it is marked as a team vote. Merges never go through a vote. | A merge is the owner's decision. | `src/bridge.js` |
| A leads-only question (`vote.mjs --leads`) is only the automatic-merge question, Yes or No, on its own card. Only sage-leads answer it, and sage gets the answer marked as a recommendation: the owner decides at the terminal. sage-bot never switches a mode of sage. (G18) | The leads advise; the owner keeps the decision. | `src/bridge.js`, `src/handle.js`, `src/cards.js` |
| One card holds the questions that one task asks within 30 seconds: 1 question, or a batch of 2 to 4. (G9) | Questions asked together belong together, so the team votes on them together. | `src/bridge.js` |
| A task that asks 5 or more questions within 30 seconds keeps them at the terminal. | One card holds at most 4 parts (Discord allows 5 rows of buttons). | `src/bridge.js` |
| Only members with the sage-apprentice or the sage-lead role answer or vote. The holders are exactly those members. Each person has one of the two roles; a member with both counts as a sage-lead, and the bridge logs a line with their name. | The Discord admin decides who is on the team, with no vote. | `src/handle.js`, `src/vote.js` |
| On a single question, the first answer from a holder is final. | One answer is enough, and the work goes on at once. | `src/vote.js` |
| A batch is a 30-minute team vote. The last ballot of each person counts. | The team can discuss and change their minds. | `src/vote.js` |
| A tie, or a part with no votes, waits for a sage-lead. A lead acts only in Discord. | A person, not a coin, breaks a tie. | `src/vote.js` |
| The card names the lead who broke a tie or ended a vote early. (G11) | The team sees who decided. | `src/cards.js` |
| Reminders go out every 2 hours: to sage-apprentice and sage-lead for an open single question, to sage-lead only for a tie. | A question must not wait in silence. | `src/vote.js`, `src/bridge.js` |
| The owner's answer at the terminal is final. A press never replaces it. (G10) | The owner has the last word. | `src/bridge.js` |
| Only the owner withdraws a question, and the owner withdraws it at the terminal. | Nobody in Discord can cancel sage's question. | `src/vote.js`, `src/bridge.js` |
| One thread per sage session, only for a session that runs sage mode and has a team vote, titled "Session N · weekday day month". It locks when the session ended and its questions are settled. (G14, G15) | Each session's questions stay together, and an old thread takes no more presses. | `src/sessions.js`, `src/bridge.js` |
| When a session thread is deleted while a vote in it is open, each open card is posted again in the parent channel, with its votes. Its reminders and tie posts go there too. (G17) | The team can still vote. | `src/bridge.js` |
| A session thread holds the votes and sage-bot's posts only (its cards, tie posts and reminders). Chat with sage is in a separate channel. (G16) | Votes stay readable, and no chat text goes near sage's answers. | Discord permissions, see [step 4](#set-up-a-live-trial) |
| No AI reads card text. sage gets reasons only from `scripts/reasons.mjs`, cleaned by an allow-list. | A reason is untrusted text. It must never become an instruction to a model. | `src/clean.js` |
| One bridge at a time for a gate file. | Two bridges would post every card twice. | `src/state.js` |
| `/sage board`, `task`, `gates` and `files` work only in the registered channels and their threads, only for a sage-apprentice or a sage-lead, and only for the projects in the config. The bridge answers them itself, with no AI, in a public reply that pings nobody. (G18, G20) | Everyone can see the questions and the answers. | `src/ask.js` |
| Only Erick registers a channel or changes its project, at the terminal. A sage-lead may only unregister a channel, with a confirm; a sage-apprentice may not. The home channel of the votes never goes from Discord. Every register and unregister is logged at the terminal. (G24) | Nobody in Discord can point sage-bot at a project. | `src/channels.js`, `scripts/channels.mjs`, `src/ask.js` |
| The channel registry is a 0600 file, written whole by the holder of the bridge lock only. A symlink, a wrong mode or bad JSON stops the bridge at start. | Nobody else can change which channel reads which project. | `src/channels.js` |
| sage-bot ignores every `/sage` command, @sage-bot mention and button press of a member with neither sage role: no reply, no note, and it does not count toward any limit or vote. A bot gets nothing too. (G20) | sage-bot acts only for the two roles; everyone else can still read. | `src/ask.js`, `src/bridge.js` |
| An answer shows only the id, title, size, state and pull request of a task, and of each open question its text and its options; `/sage gates` adds sage's recommendation and the default. A reply holds at most 2000 characters, so `/sage gates` and `/sage board` show the open questions that fit in full, then one line "2 more open question(s): G7, G8." (only the count when the ids do not fit either). No question is cut, and none is left out without that line. It never reads `decisions.tsv`, findings, briefs or reports. `/sage files` attaches only the existing images and PDFs that the config lists: at most 10 files and at most 8 MB in one reply, so that the reply stays under Discord's upload limit for a server with no boosts. The reply lists the files that do not fit as not attached. | The logbook also holds security details and the owner's words. | `src/ask.js` |
| In a sage session that sage-bot starts for a sage-lead, the guard hook allows only the tools, commands, subcommands and options on its allow-list, and says how to rephrase when a safe form exists. As a second layer, it refuses by name each merge, shell, deploy and GitHub command (GitHub goes through sage-bot's broker, coming in step 6), each agent with an isolation field, and each call that names the sage state tool (G30 A: a lead session reaches the logbook only through sage-bot, from T134). The hook reads only the text of a call, so it cannot see what a script that the session writes does when it runs. The sandbox of T134 holds that (G44 A): no GitHub host and a strict host list, so no script can reach GitHub or deploy (F-T134-1); the sage plugin folder and every logbook denied (test F-T134-6). T134 proves each sandbox setting with a test. The broker holds GitHub with its few verbs, none of which merges (F-T134-1). The permission rules of step 6 hold the Read, Edit and Write tools (F-T134-16; secret files: F-T134-15). The owner's own sessions are unaffected. (T133, the T72 plan) | Erick approves anything that he cannot undo, at the terminal. | `src/guard.js`, `scripts/guard.mjs` |
| Each sage-apprentice and sage-lead can ask 10 times in a rolling hour, across all channels; every `/sage` command and every mention counts, and a mention that opens a thread counts once. The limit note is public too. (G27) | The bridge runs on the owner's Mac; free questions come after the live trial. | `src/ask.js` |
| Every @sage-bot mention in a registered channel opens a public thread, named from the request, and the answer goes there. A mention in that thread continues it. A mention in a thread that sage-bot did not open, or in a forum post, gets one reply: mention me in the channel. The bridge answers read asks itself, with no AI. (G27) | Each request and its answer stay together, and the channel stays readable. | `src/ask.js`, `src/threads.js` |
| Every message of a sage-lead to sage-bot, and every message of an apprentice in a lead thread, goes into the lead log first: one line each, with a hash chain, in a 0600 file outside every project. A copy goes to #sage-audit and pings nobody. An apprentice's text is kept only as quoted data. (G22) | Erick and the leads can see everything that a lead sent toward sage. `verify` shows an edit, a removal or a reorder of a line that has lines after it; the #sage-audit copy shows the rest (see [the lead log](#mention-threads-the-lead-log-and-the-kill-switch)). | `src/audit.js` |
| A sage-lead or Erick can turn off the link from Discord to sage with `/sage stop` and a confirm, in any channel and also over the hourly limit. The confirm has a Cancel button and expires after 10 minutes. Erick can also turn it off at the terminal. Only Erick turns it on again, at the terminal. While it is off, read asks still work. A flag file that cannot be checked counts as off. No sage session starts from Discord yet: a lead's "talk" is recorded and gets the reply that sessions are not on yet. (G22, G27) | One press stops everything that a lead could send to sage. | `src/audit.js`, `src/ask.js`, `scripts/leads.mjs` |

### The guard for lead sessions

> **Status: built and tested; not installed yet.** Step 6 of the T72 plan (T134) installs it, together with the Claude Code sandbox and the permission rules, when sage-bot starts sage sessions for sage-leads.

sage-leads will talk to sage from Discord. sage-bot will start one headless `claude -p` session for each lead thread. Four layers limit that session. Each one holds only what it can see:

> **The guarantee is the sandbox.** A text hook never guarantees a file or network boundary; only the sandbox does (G44 A). A lead session cannot run or change the sage state tool because the sandbox of T134 denies the sage plugin folder and every logbook (G44 A; test F-T134-6 proves that each known bypass fails there; F-T134-12 denies each of those paths again where a wider rule opens it). The hook's refusal of the state tool is a second layer: it stops the plain forms early, with a clear message.

| Layer | What it holds |
| --- | --- |
| The guard hook `scripts/guard.mjs` (this task) | A second layer, by the text of each call: which tools the session may use, and which commands, subcommands and options a Bash call may name: one simple command, or allowed commands joined by `&&`. It refuses `gh`, `git push` and `git fetch` with the hint to the sage-bot broker tools of the session, which step 6 adds (MCP tools, T158); the hint names no command, because the guard refuses each GitHub command. As a second layer, it refuses each call that names the sage state tool, by class rules (for example: no character that is not printable ASCII, and no `[` wildcard, in a pipeline that runs or writes; a quoted pattern for git or `node --test` is a wildcard too; `node` runs no script under `/dev/`). It refuses a write under a `.claude` folder, where the settings, skills, agents and commands live (a second layer: T134 holds those folders, F-T134-4, F-T134-20). It refuses an Agent or Task call with an isolation field, the Grep tool (sage searches with `rg` in Bash), and WebFetch to a URL whose host, as text, is a local name or not a global unicast address (a name that resolves to a local address passes). It reads no file and resolves no path, so a script that the session writes and runs with `node` gets past it: the sandbox holds that script. |
| The Claude Code sandbox (step 6) | Every Bash command and every program that it starts (`node` and `npm` scripts too): reads only in the working folder and writes only in the worktree and the session's own scratch folder (F-T134-16, F-T134-13), git hooks and subagent commands too (F-T134-16), the sage plugin folder and every logbook denied (the guarantee for the state tool: F-T134-6, F-T134-12), secret files denied (F-T134-15), a strict list of hosts with no GitHub, no GitHub token in the environment (F-T134-1). |
| The permission rules (step 6) | The Read, Edit and Write tools, which the sandbox does not cover: Read denied for secret files (F-T134-15), Read and Glob denied on every denied path, Edit and Write only in the session folder and its scratch folder, the Grep tool denied (F-T134-16). WebFetch has no permission rule yet, and the hook checks only the host text in the URL, so today nothing limits where WebFetch connects. T134 adds the WebFetch permission rule (the policy module T156 generates it). |
| The broker: the sage-bot MCP tools of the session (step 6, T158) | GitHub: a fetch, an upload to the session's own branch, and the session's own pull request (create, edit, view); a few fixed logbook verbs, with the project fixed (F-T134-6). None of its verbs merges (F-T134-1). The tools run in the sage-bot process (Claude Agent SDK, G57 A), which holds the GitHub credential of a dedicated GitHub identity (G58 a). They are not a command, so no command of the session runs outside the sandbox (F-T134-16); the session has no GitHub host and no token. |

The hook refuses by name each command on its list of actions that Erick must approve, and tells the session: "This needs Erick; tell the sage-lead and stop this action." A lead session runs headless, so Erick is not at a terminal. When a safe form exists, it gives that form instead, for example "sage can do this instead: cd <folder> && <command>".

- It acts only when the session's environment has `SAGE_ORIGIN=lead`. In every other session it allows everything at once.
- It allows only what is on its allow-list. When it cannot parse a command, when the input is over 64 KB, or when it fails, it refuses.
- Some cases neither the hook nor the sandbox can see: what a commit holds, a host name that resolves to a local address, and what the broker does. The [reference](docs/reference.md#the-guard-for-lead-sessions) lists them, the allow-list, the safe forms, and the settings that step 6 must pass.

## Set up a live trial

> **The live trial has not run yet.** This checklist comes from the principal engineer's check (run R260) for tasks T53 and T54. Every command in it runs in the tests, except the ones that need Discord, the Keychain or launchctl.

The owner does each step by hand. sage-bot changes no settings file, and it never types a token.

- [ ] **1. Make a Discord app only for sage-bot.** In the Discord Developer Portal, make a new application with a bot user. Turn on the **Server Members** intent. Leave the **Message Content** intent off. Invite it to your server with the `bot` and `applications.commands` scopes. On the Bot page, choose **Reset Token**, and keep the token only for step 5.
  *Why:* the bridge reads the members' roles to know who may vote, and it adds the `/sage` command to your server at each start. Do not reuse the Discord plugin's bot: then one token could do both jobs, and a press could reach sage's chat.
- [ ] **2. Make two roles: `sage-apprentice` and `sage-lead`.** Make both roles **mentionable**. Give each person who votes exactly one of them: sage-lead to the people who also break ties, sage-apprentice to everyone else.
  *Why:* a new card pings @sage-apprentice and @sage-lead, and a tie pings @sage-lead. If a role is not mentionable, its ping notifies nobody. A lead has every right of an apprentice, so a lead needs no second role.
- [ ] **3. Fill in the config.** Make a text channel `#ask-sage`. Copy the example, then put in the 6 Discord ids: the server (`guildId`), the parent channel (`channelId`), the #ask-sage channel (`askChannelId`), the owner (`ownerId`) and the two roles (`apprenticeRole`, `leadRole`). At its first start the bridge makes the [channel registry](#channels) from `channelId` (the home channel of the votes) and `askChannelId`; after that, register more channels with `scripts/channels.mjs`. You can also leave both ids out and register the home channel with the script (see [Channels](#channels)). Also set `project` (the sage project folder), `sagePath` (the sage plugin's `sage.mjs`) and `statePath` (the bridge's gate file).
  Then set `projects`, every project of the bridge: it posts the cards of each one, and `/sage` reads each one. Put the folder of `project` in it too, with a name. Each one has a `name` (lower-case letters, digits and dashes), its `project` folder, and optionally its own `sagePath`, its `files` and its `repo`. `files` lists the images and PDFs that `/sage files` may attach, as paths in the project such as `docs/*.svg` (`*` only in the file name; .png, .jpg, .svg or .pdf only). `repo` (`https://github.com/<owner>/<name>`) makes the pull request of a task a link. Without `projects`, the bridge works only for `project`, with no files. Remove the example's sample entry, or fill it in.
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

  In #ask-sage, and in each channel that you register later:

  | Who | Permissions in #ask-sage |
  | --- | --- |
  | @everyone | Allow View Channel. Deny Send Messages and Use Application Commands. |
  | sage-apprentice and sage-lead | Allow Send Messages and Use Application Commands. |
  | The sage-bot app | Allow View Channel, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links and Attach Files. The bridge checks the first seven at each start and logs each one that is missing. |

  **Do not let the Discord plugin watch this parent channel.** Chat with sage in a separate channel.
  **The server owner and members with the Administrator permission ignore these denies.** Discord lets them type in every session thread, so they must not type there.
  *Why:* a session thread holds the votes and sage-bot's posts only (G16), so nobody types in it; the buttons and the reason forms work without send permissions. In #ask-sage the team asks with `/sage`, and everyone who can view the channel reads the questions and the answers. sage-bot ignores a member with neither role. Do not let the Discord plugin watch #ask-sage either. If the plugin watches the channel, an @sage message in any session thread reaches every running sage session, and its `fetch_messages` tool can read the tie posts. The bridge needs Manage Threads to lock and unlock the threads.
- [ ] **5. Put the token in the Keychain.** Open Keychain Access, choose File, New Password Item. Set the name to `sage-bot` and paste the token from step 1 as the password. Never type the token in a shell.
  *Why:* the shell history keeps what you type. The bridge reads the item at start and never writes the token to a file or a log.
- [ ] **6. Add the hook lines.** Put these lines in `.claude/settings.local.json` in the folder you set as `project` in step 3, and in the folder of each other project in `projects`. Use the absolute path of your sage-bot folder.

  ```json
  {
    "hooks": {
      "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/sage-bot/scripts/hook.mjs" }] }],
      "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/sage-bot/scripts/hook.mjs" }] }],
      "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/sage-bot/scripts/hook.mjs" }] }]
    }
  }
  ```

  *Why:* without the hook, the bridge does not know sage's sessions, and every card goes to the parent channel. The hook records a session in any project of `projects` and ignores every other folder.
- [ ] **7. Deny the Discord plugin's `fetch_messages` tool** in the same settings file. Its name is probably `mcp__plugin_discord_discord__fetch_messages`: confirm the exact name with `/mcp` first.

  ```json
  { "permissions": { "deny": ["mcp__plugin_discord_discord__fetch_messages"] } }
  ```

  *Why:* the tie posts hold reasons that are cleaned for people, not for a model. sage must not read them.
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

  The script refuses a config file that does not exist, is not JSON, lacks a field of step 3, has a Discord id that is not 17 to 20 digits, or has `projects` that the bridge refuses (for example a folder that does not exist). It then exits 1 and leaves the plist file as it was, so fix the config and run it again. It writes the new plist to a temp file first, so a refused run never empties a working plist.

  The plist runs node through a path that a Node upgrade keeps, such as `/opt/homebrew/bin/node`. When the script prints "warning: … make the plist again after each Node upgrade", your node has no such path: after each Node upgrade, run the command above again and load the new plist. When it says that your node is an old node, a node from before a Homebrew upgrade still runs: run the command again with the current node that the message names. To see the node path of the plist, read the first entry of `ProgramArguments`:

  <!-- check: run -->
  ```sh
  plutil -p ~/Library/LaunchAgents/com.sage.bot.plist
  ```

  *Why:* the first run by hand shows a setup error at once. The log of the launchd agent is `~/Library/Logs/sage-bot.log`. When the node path of the plist does not exist, launchd cannot start the bridge, and this log gets no line.
- [ ] **9. Do a smoke test.** First start a new Claude Code session in your `project` folder (the folder you set as `project` in step 3), and turn on sage mode.
  *Why:* Claude Code loads the hooks only when a session starts. In a session that started before step 6, the bridge does not know the session, and the first card goes to the parent channel.

  Then ask sage for one test question. Mark it with its id, for example G42, in a terminal in the sage-bot folder. Name the project with `--project`: the sage-bot folder is not the folder of a listed project.

  <!-- check: run, prints "team votes: your-project/G42" -->
  ```sh
  node scripts/vote.mjs --project your-project G42
  ```

  While it changes the list, `scripts/vote.mjs` holds a lock file next to the team votes file. If it says that another vote run holds the lock, wait and run it again. If no vote run is running, remove the lock file that the message names.

  Within a minute, a card appears in the session thread. Press an option. The card shows your answer, and sage gets it in the logbook.

**What the first live trial checks first:**

1. The thread lock and unlock: a thread locks when its session ended and its questions are settled, and a resume opens it again.
2. The permission codes: what Discord answers when a permission is missing (for example 50001, Missing Access), and that the card then goes to the parent channel.
3. A press in a thread: it reaches the bridge, it counts, and the card changes.

## Concepts

| Word | Meaning |
| --- | --- |
| **Question** | A sage gate: a question that sage parks for the owner, with options, a recommendation and a default. |
| **sage** | The Claude Code session in sage mode that frames the work and asks the questions. It changes no files. |
| **The owner** | The person who runs sage at the terminal. In the demo, Erick. |
| **The team** | The members of the Discord server with the sage-apprentice or the sage-lead role. |
| **sage-apprentice** | The role for the people who answer and vote. |
| **sage-lead** | The role for the people who answer and vote, and also break ties and end votes early. A person has sage-apprentice or sage-lead, not both. |
| **Team vote** | A question that sage marked with `scripts/vote.mjs`. Only these and the leads-only questions go to Discord. |
| **Leads-only question** | A Yes or No question that sage marked with `scripts/vote.mjs --leads`. Only a sage-lead answers it, as a recommendation to the owner. |
| **Card** | The Discord message of one question or one batch, with a button for each option. |
| **Batch** | 2 to 4 questions of one task, asked within 30 seconds, on one card. |
| **Session thread** | The Discord thread of one sage session. It holds that session's cards. |
| **Parent channel** | The channel that holds one line per sage session. People only read it. |
| **The bridge** | The service on the owner's Mac: `scripts/bridge.mjs`. |
| **Holder** | A member with the sage-apprentice or the sage-lead role. Only holders count. |
| **Answer thread** | A thread that sage-bot opens for a mention. It answers read asks there, with no AI. |
| **Lead thread** | A thread that a sage-lead's "talk" opens. Each message there goes into the lead log. |
| **Lead log** | The append-only record of every message that a sage-lead sends to sage-bot, with a hash chain. |
| **Kill switch** | `/sage stop`: it turns off the link from Discord to sage until Erick turns it on at the terminal. |

## What to do

Run each command in the sage-bot folder.

- `vote.mjs`, `reasons.mjs` and `session.mjs` read `~/.config/sage-bot/config.json`, unless you give `--config <file>` as the first argument.
- `vote.mjs` and `reasons.mjs` take `--project <name>` next, for a question of a project in `projects`. Without it, the question is of the listed project whose folder holds the folder that sage runs it in (the deepest one, as for the hook). In any other folder they stop with one line that asks for `--project`, and nothing changes.
- `bridge.mjs` and `launchd.mjs` take the path of the config file as their only argument.

| You want to | Do this |
| --- | --- |
| Send a question to the team | `node scripts/vote.mjs G42` in the project's folder (several ids in one command for one batch) |
| Send a question of a named project to the team, from any folder | `node scripts/vote.mjs --project <name> G42` |
| Ask the sage-leads for a recommendation, as sage | `node scripts/vote.mjs --leads G42` (one Yes or No question) |
| Take a question back to the terminal | `node scripts/vote.mjs --unmark G42`, before the card is posted |
| See the marked questions | `node scripts/vote.mjs --list` |
| Answer a question yourself | Answer sage in the chat as usual; that answer is final. (G10) |
| Withdraw a single question | Tell sage to withdraw it. sage records an answer that names no option, and the card shows the question as withdrawn. |
| Read the team's reasons, as sage | `node scripts/reasons.mjs G42`, or `node scripts/reasons.mjs --project <name> G42` |
| Find a session's thread | `node scripts/session.mjs thread <session id>` |
| Check the launchd plist | `plutil -p ~/Library/LaunchAgents/com.sage.bot.plist`: the first entry of `ProgramArguments` is the node path |

In a registered channel, or a thread of it, a sage-apprentice or a sage-lead types one of these. The answer is public: everyone in the channel sees it, and it pings nobody. Leave out `project` for the project of the channel.

| You want to | Type this in a registered channel |
| --- | --- |
| See the tasks by state, the tasks left and the open questions with their options | `/sage board [project]` |
| See one task: its title, size, state and pull request | `/sage task <id> [project]`, for example `/sage task T7` |
| See the open questions with their options, sage's recommendation, the default, and which ones are team votes | `/sage gates [project]` |
| Get the shared images and PDFs of a project | `/sage files [project]` |
| Stop sage-bot in this channel (sage-leads only; a button confirms it) | `/sage unregister` |
| Turn off the link from Discord to sage (sage-leads and Erick; a button confirms it) | `/sage stop` |
| Ask in a thread of its own | `@sage-bot board`, `@sage-bot gates`, `@sage-bot files` or `@sage-bot T7` |

Time left is not estimated yet: the board shows the count of tasks left. In a channel that is not registered, sage-bot ignores `/sage` and mentions, except one pointer to a registered channel per person per day, and the `/sage stop` of a sage-lead or Erick. See [Mention threads](#mention-threads-the-lead-log-and-the-kill-switch) for what a mention does.

### Channels

sage-bot works only in the channels that Erick registers. Each registered channel is for one project: `/sage` there reads that project when you leave out `project`. One channel is the home channel: the votes and cards post there. The list is the channel registry, the file `<statePath>.channels`.

**Make the registry once.** The commands below read the bridge's config at `~/.config/sage-bot/config.json`; add `--config <config.json>` for another file.

- If you used sage-bot before, you need to do nothing: at its first start the bridge makes the registry from `askChannelId` (for the first project) and `channelId` (the home channel), and `/sage` keeps working in #ask-sage. `/sage` now also works in the home channel.
- On a new install, you can leave `channelId` and `askChannelId` out of the config. Then register the home channel first, while the bridge is stopped (see the next step). Until you do, the bridge does not start, and its message gives this command.

<!-- check: run, prints "registered the channel 400000000000000001 for the project your-project (home channel of the votes and cards)" -->
```sh
node scripts/channels.mjs register 400000000000000001 your-project --home   # the home channel: the votes and cards post there
```

**Register or unregister a channel at the terminal.** Stop the bridge first: `register` and `unregister` refuse while the bridge runs, because only one of them may change the registry. `list` only reads, so it works at any time. To copy a channel id, right-click the channel with Developer Mode on.

The launchd agent starts the bridge again when it stops, so stop it with launchctl, and start it again after your changes. If you run the bridge by hand, stop it with Ctrl+C instead.

<!-- check: skip, changes the Mac's login items; the test never runs launchctl -->
```sh
launchctl unload ~/Library/LaunchAgents/com.sage.bot.plist   # stop the bridge before register or unregister
launchctl load ~/Library/LaunchAgents/com.sage.bot.plist     # start it again after them
```

<!-- check: run, prints "registered the channel 400000000000000003 for the project your-project" -->
```sh
node scripts/channels.mjs register 400000000000000003 your-project   # /sage works in that channel, for your-project
node scripts/channels.mjs unregister 400000000000000003              # sage-bot ignores that channel again
node scripts/channels.mjs list                                       # print the registry
```

- A project that is not in the config's `projects` is refused.
- `register <id> <project> --home` makes that channel the home channel. The old home stays registered as a normal channel.
- The home channel cannot move while a card waits for votes in the old home or its threads: their buttons would stop working. Wait until they are settled, or answer them at the terminal.
- The home channel cannot be unregistered: make another channel the home first.
- When you remove a project from the config, the bridge does not start while a channel still has it. `list` marks each such channel "not in the config". Register it again for a listed project, or unregister it.
- When the registry file is broken (for example bad JSON, a wrong mode or a symlink), the bridge and the script stop, and the message gives the command that repairs it. For a wrong mode, it is `chmod 600 <file>`. For everything else, move the file aside with `mv <file> <file>.bad`, then register the home channel again with `register <channel id> <project> --home`, and then each other channel.
- Then start the bridge again. At start it checks its permissions in each registered channel and logs each missing one, by name, in `~/Library/Logs/sage-bot.log`.

**A sage-lead can unregister a channel from Discord.** `/sage unregister` shows a confirm with two buttons, "Unregister this channel" and "Cancel". A lead's press of the first removes the channel, and the terminal log gives the lead's name and id. The confirm works for 10 minutes. A sage-apprentice cannot unregister a channel. Nobody can register a channel from Discord.

sage-bot ignores a member with neither sage role: a `/sage` command, a mention or a button press gets no reply. For a `/sage` command or a button, Discord itself then shows that person "The application did not respond" or "This interaction failed", only to them. To hide `/sage` from these members, open Server Settings, Integrations, sage-bot, and allow `/sage` only for the two roles.

### Mention threads, the lead log and the kill switch

**A mention opens a thread.** Mention @sage-bot in a registered channel, and sage-bot opens a public thread from your message, named from your request. The answer goes into the thread. To ask again, mention @sage-bot in that thread: sage-bot cannot read a message that does not mention it.

| Thread | Who opens it | What sage-bot does there |
| --- | --- | --- |
| Answer thread | A sage-apprentice, or a sage-lead with a read ask | Answers a mention that names `board`, `gates` (or `questions`), `files` or a task id such as `T7`, like the `/sage` command. Any other mention gets a pointer to these words. No AI. |
| Lead thread | A sage-lead whose mention holds the word "talk" | Records each message in the lead log and replies that sessions with sage are not on yet. No sage session starts: that comes in a later step. An apprentice may write there too; the log keeps their text only as quoted data. When a sage-lead talks in an answer thread, it becomes a lead thread: the apprentice's earlier mentions there go into the lead log first, in order, as quoted data. A lead's read ask keeps it an answer thread. |

- A mention in a thread that sage-bot did not open, or in a forum post, gets one reply: mention me in the channel.
- When sage-bot lacks a right for its thread, it replies once in place and names the right: "Create Public Threads" or "Send Messages in Threads".
- The threads are in `<statePath>.threads` (0600), so a thread continues after a restart.

**The lead log.** Every message of a sage-lead to sage-bot, a `/sage stop`, and every message of an apprentice in a lead thread, goes into the lead log before anything else. Each line holds the time, the message id, the author id, their roles at that time, the sha256 of the raw text, the cleaned text, the thread, the project and the outcome. Each line also holds the hash of the line before it. The log is `<statePath>.leads.jsonl`, or `auditPath` in the config. Its folder must be 0700 and outside every project, and the file is 0600.

What the hash chain shows, and what it does not:

| A change to the log | `leads.mjs verify` | Only the #sage-audit copy shows it |
| --- | --- | --- |
| An edit, a removal or a reorder of a line that has lines after it | A break at that line | |
| The last lines cut off | Intact | Yes: the copy has lines that the log has not |
| An older copy of the log put back | Intact | Yes |
| Every line written and hashed again | Intact | Yes: the hashes in the copy differ |

The chain has no key, so anyone who can write the file can make a new chain that verifies. Anchoring the chain outside the Mac is follow-up task T135.

The 0700 folder and the 0600 file keep other users out, but not a session: a sage session runs as Erick's user, so it could change the log or remove the kill switch flag. When sessions start from Discord (a later step), their sandbox must deny the state folder (T134, F-T134-2). Until then, no session starts from Discord.

**#sage-audit.** Make a text channel `#sage-audit` that only the sage-leads and you can see, where only sage-bot can post. Put its id in the config as `auditChannelId`. sage-bot posts a copy of each log line there, which pings nobody. Without `auditChannelId`, the bridge keeps the log only and says so at start.

**The kill switch.** A sage-lead or Erick types `/sage stop`, in any channel, and presses the button within 10 minutes. `/sage stop` does not count toward the hourly limit. Cancel, or a press after 10 minutes, changes nothing. sage-bot then posts a public notice, and nothing of a lead goes to sage until Erick turns the link on again at the terminal. Read asks keep working. The switch is the flag file `<statePath>.leads-off` (or `killPath` in the config); a flag that the bridge cannot check counts as set.

<!-- check: run, prints "the link from Discord to sage is on" -->
```sh
node scripts/leads.mjs status    # is the link on or off?
node scripts/leads.mjs stop      # turn the link off at the terminal
node scripts/leads.mjs restore   # turn the link on again (only Erick, at the terminal)
node scripts/leads.mjs verify    # check the hash chain of the lead log; exits 1 at a break
node scripts/leads.mjs read 20   # print the last 20 lines of the lead log; a line from a break on starts with UNVERIFIED
```

## FAQ

**Does a Discord message ever reach sage?** No. The bridge gives sage only the final answer: the option's letter and sage's own option text. sage reads the reasons only through `scripts/reasons.mjs`, which keeps only letters, digits, spaces and `. , : -`, and frames each reason as quoted data. Two settings of the owner keep Discord text away from sage too: the Discord plugin does not watch the parent channel ([step 4](#set-up-a-live-trial)), and its `fetch_messages` tool is denied ([step 7](#set-up-a-live-trial)). Those two are settings, not code.

**Can a teammate start work?** No. A session starts only at the owner's terminal: there is no "New session" button. A press can only answer or vote on a question that sage marked. Chat with sage happens in a separate channel, through the Discord plugin and its own settings, not through sage-bot.

**What if the Mac sleeps?** The bridge stops while the Mac sleeps, so a press in that time fails in Discord ("This interaction failed"). The 30-minute clock keeps running. When the Mac wakes, the bridge ends each vote that passed its limit with the votes cast, sends each due reminder once, and posts "The host was asleep from 22:10 to 08:05. Presses in that time did not count. Please press again on any open question." With launchd, the bridge also starts again after a crash or a restart.

**What if two people press at once?** The bridge is one process, and it decides each press in one step before it takes the next one. On a single question, the first press that reaches the bridge is final. The second person gets the private note "Already answered by Maya: A". In a batch, both votes count, and each person's last vote counts.

**How do I take a question back to the terminal?** Before the card is posted, unmark it: `node scripts/vote.mjs --unmark G42`. After the card is posted, unmarking does not take the card back. Then answer sage in the chat as usual; that answer is final, the card shows "Answered by Erick (terminal)", and its buttons go grey. To cancel a single question, tell sage to withdraw it: sage records an answer that names no option, and the card shows the question as withdrawn.

**What if the owner answers at the terminal while the team votes?** The owner's answer wins (G10). The bridge reads the logbook before each press and before each answer that it gives sage, so it never replaces the owner's answer. If sage records the owner's answer at the same moment that the bridge records a Discord answer, the bridge puts the owner's answer back and logs one line.

**Who sees a reason?** People see it on the card, cleaned for a person to read. sage, a model, sees it only through `scripts/reasons.mjs`, cleaned by a separate allow-list for a model. No AI reads card text.

## Under the hood

| Path | What it is |
| --- | --- |
| `src/vote.js` | The vote rules: pure functions, no clock and no Discord. |
| `src/cards.js`, `src/handle.js` | The cards, the reason form, the private notes, and the handler of a press. |
| `src/bridge.js`, `src/discord.js` | The bridge's loop, and the only code that connects to Discord. |
| `src/ask.js` | The `/sage` read commands of the registered channels, `/sage unregister`, the answer to an @sage-bot mention, and the rate limit. |
| `src/channels.js` | The channel registry: its safe file, the migration, Erick's changes and the permission check. |
| `src/state.js`, `src/sessions.js`, `src/sage.js` | The gate file and its lock, the session threads, and the calls to the sage state tool. |
| `src/clean.js` | The allow-lists for the terminal and for sage. |
| `src/guard.js`, `scripts/guard.mjs` | The guard hook for lead sessions and its rules (installed by step 6). |
| `src/fake-discord.js` | The fake Discord for the tests and the demo. |
| `scripts/` | The commands: `bridge`, `channels`, `vote`, `reasons`, `session`, `hook`, `launchd`, `demo` and `preview`. |
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
