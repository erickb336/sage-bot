# Set up a live trial

**This is the full checklist to connect sage-bot to a real Discord server.** The [README](../README.md#set-up-a-live-trial) gives the short list. The [reference](reference.md) gives every rule, case and setting.

> **The live trial has not run yet.** Every command in it runs in the tests, except the ones that need Discord, the Keychain or launchctl.

The owner does each step by hand. sage-bot changes no settings file, and it never types a token.

**Contents:** [The checklist](#the-checklist) · [What the first live trial checks first](#what-the-first-live-trial-checks-first) · [Channels](#channels) · [Who is who](#who-is-who) · [A second owner joins the server](#a-second-owner-joins-the-server) · [The audit log and the kill switch](#the-audit-log-and-the-kill-switch)

## The checklist

- [ ] **1. Make a Discord app only for sage-bot, with your own Discord account.** In the Discord Developer Portal, make a new application with a bot user. Make it with your own account, not in a Developer Team, so that sage-bot knows you as its owner (step 3).
  - On the **Installation** page, keep only **Guild Install**: turn off **User Install**.
  - On the **Bot** page, turn off **Public Bot**, so that only you can add it to a server.
  - Turn on the **Server Members** intent. Leave the **Message Content** intent off.
  - Invite it to your server with the `bot` and `applications.commands` scopes and the permission integer `326417632256`. It includes Read Message History: after the Mac sleeps, sage-bot reads back the mentions that it missed (see [the catch-up](reference.md#the-catch-up)).
  - On the Bot page, choose **Reset Token**, and keep the token only for step 5.

  *Why:* the bridge reads the members' roles to know who is in the crew, and it adds the `/sage` command to your server at each start. Each person runs their own sage-bot, with their own app, on their own Mac. Do not reuse the Discord plugin's bot: then one token could do both jobs, and a press could reach sage's chat. sage-bot serves only the server of `guildId` in its config: at each start, and each time someone adds it to another server, it leaves that other server and logs one line. Public Bot off stops others from adding it at all; the leave is the second layer.
- [ ] **2. Make one role named exactly `sage-crew`.** Make it **mentionable**. Give it to each person who asks sage-bot and votes. If the server already has a `sage-crew` role (another person's sage-bot uses it), use that role: every sage-bot in a server shares it. You, the owner, need no role: sage-bot knows you by your user id (see [Who is who](#who-is-who)). To answer and vote on the cards in Discord, give yourself the role too.
  *Why:* sage-bot finds the crew by the role's name, at each start and each time a role changes, so the config holds no role id. A new card pings @sage-crew; a tie pings only you. If the role is not mentionable, its ping notifies nobody.
  **Warning:** anyone with the **Manage Roles** permission can give the role, or make another role with the same name. Give that permission only to people you trust. When two roles have the name, both count, and sage-bot posts one warning in #sage-audit.
- [ ] **3. Fill in the config.** Make a text channel `#ask-sage`. Copy the example, then put in the Discord ids: the server (`guildId`), the parent channel (`channelId`) and the #ask-sage channel (`askChannelId`). The example has no `ownerId`: the owner of the Discord app is the owner. Add `ownerId` with your own Discord user id only when a Developer Team owns the app (see [Who is who](#who-is-who)). The config has no role id. At its first start the bridge makes the [channel registry](#channels) from `channelId` (the home channel of the votes) and `askChannelId`; after that, register more channels with `scripts/channels.mjs`. You can also leave both ids out and register the home channel with the script (see [Channels](#channels)). Also set `project` (the sage project folder), `sagePath` (the sage plugin's `sage.mjs`) and `statePath` (the bridge's gate file).
  Then set `projects`, every project of the bridge: it posts the cards of each one, and `/sage` reads each one. Put the folder of `project` in it too, with a name. Each one has a `name` (lower-case letters, digits and dashes), its `project` folder, and optionally its own `sagePath`, its `files` and its `repo`. `files` lists the images and PDFs that `/sage files` may attach, as paths in the project such as `docs/*.svg` (`*` only in the file name; .png, .jpg, .svg or .pdf only). `repo` (`https://github.com/<owner>/<name>`) makes the pull request of a task a link. Without `projects`, the bridge works only for `project`, with no files. Remove the example's sample entry, or fill it in.
  Keep the folder of `statePath` at mode 0700 (only you can read and write it).
  *Why:* the bridge reads only this file. It refuses a gate file, team votes file or session file in a folder that other users can write, unless the folder is sticky. To copy an id, turn on Developer Mode in Discord, then right-click the item.

  <!-- check: skip, the test writes a filled-in sample config in its place -->
  ```sh
  mkdir -p ~/.config/sage-bot
  cp examples/config.example.json ~/.config/sage-bot/config.json
  ```

- [ ] **4a. Set the parent channel's permissions.** The parent channel holds the votes and the session threads. Nobody types or uses `/sage` there.

  | Who | Permissions in the parent channel |
  | --- | --- |
  | @everyone | Deny Send Messages, Send Messages in Threads, Create Public Threads, Create Private Threads and Use Application Commands. |
  | sage-crew | Deny the same five permissions. |
  | The sage-bot app | Allow View Channel, Send Messages, Embed Links, Read Message History, Create Public Threads, Send Messages in Threads and Manage Threads. |

  **Do not let the Discord plugin watch the parent channel.** Chat with sage in a separate channel.
  **The server owner and members with the Administrator permission ignore these denies.** Discord lets them type and use `/sage` in the parent channel and every session thread, so they must not.
  *Why:* a session thread holds the votes and sage-bot's posts only, so nobody types in it; the buttons and the reason forms work without send permissions. `/sage` is blocked in the parent channel on purpose: a `/sage board` there would put a public answer between the vote cards. Threads take their permissions from the parent channel, so this one deny covers every session thread. The team asks in #ask-sage (step 4b). You type `/sage stop` in #ask-sage or in any other channel where you can use slash commands. In the parent channel the deny hides it, as it hides every `/sage`. The "End vote now" button is not a slash command, so the deny does not affect it. A mention cannot open a thread, because nobody can send a message. The bridge needs Manage Threads to lock and unlock the threads.
- [ ] **4b. Set the permissions of #ask-sage**, and of each channel that you register later.

  | Who | Permissions in #ask-sage |
  | --- | --- |
  | @everyone | Allow View Channel. Deny Send Messages and Use Application Commands. |
  | sage-crew | Allow Send Messages and Use Application Commands. |
  | The sage-bot app | Allow View Channel, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links and Attach Files. The bridge checks the first seven at each start and logs each one that is missing. |

  **Do not let the Discord plugin watch #ask-sage.** If it does, an @sage message in any session thread reaches every running sage session, and its `fetch_messages` tool can read the tie posts.
  *Why:* the crew asks here with `/sage` or a mention, and everyone who can view the channel reads the questions and the answers. A `/sage request` here posts one line and opens its thread, where you approve or decline it. You and the crew type `/sage stop` here: it turns the link off at once. Only you turn it on again, at the terminal. sage-bot ignores everyone else. If you do not hold sage-crew, allow yourself Send Messages and Use Application Commands here too.
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

  Three lines of the log at the start need a fix from you; the bridge runs with each of them:

  - "no role of the server is named sage-crew": make a role named exactly `sage-crew` (the case counts) in the server, and give it to each crew member.
  - "the config has apprenticeRole" (or `leadRole`, `driverRole`): remove those keys from the config. They do nothing now (see [Who is who](#who-is-who)).
  - "the config's ownerId … is not the owner of the Discord application": check that `ownerId` is your own Discord user id. sage-bot takes the config's id as the owner.

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

  While it changes the list, `scripts/vote.mjs` holds a lock file next to the team votes file. If it says that another sage-bot run holds the lock, wait and run it again. If no sage-bot run is running, remove the lock file that the message names.

  Within a minute, a card appears in the session thread. Ask a crew member to press an option. To press it yourself, first give your own account the `sage-crew` role: without it, sage-bot answers that only a sage-crew member answers or votes, and the press does not count. The card shows the answer, and sage gets it in the logbook.

## What the first live trial checks first

1. The thread lock and unlock: a thread locks when its session ended and its questions are settled, and a resume opens it again.
2. The permission codes: what Discord answers when a permission is missing (for example 50001, Missing Access), and that the card then goes to the parent channel.
3. A press in a thread: it reaches the bridge, it counts, and the card changes.

## Channels

sage-bot works only in the channels that the owner registers. Each registered channel is for one project: `/sage` there reads that project when you leave out `project`. One channel is the home channel: the votes and cards post there. The list is the channel registry, the file `<statePath>.channels`.

**Make the registry once.** The commands below read the bridge's config at `~/.config/sage-bot/config.json`; add `--config <config.json>` for another file.

- If you used sage-bot before, you need to do nothing: at its first start the bridge makes the registry from `askChannelId` (for the first project) and `channelId` (the home channel), and `/sage` keeps working in #ask-sage. The home channel stays closed to `/sage` on purpose (step 4a).
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

**You can unregister a channel from Discord.** `/sage unregister` shows a confirm with two buttons, "Unregister this channel" and "Cancel". Your press of the first removes the channel, and the terminal log gives your name and id. The confirm works for 10 minutes. The crew cannot unregister a channel. Nobody can register a channel from Discord.

sage-bot does nothing for everyone who is neither in the crew nor you. A `/sage` command or a button press of theirs gets one private line, "Only the sage-crew role can use sage-bot." (with your bot's name), that only they see. A mention of theirs gets no reply at all. To hide `/sage` from these members, open Server Settings, Integrations, sage-bot, and allow `/sage` only for the sage-crew role and you.

## Who is who

sage-bot knows two kinds of people. It reads both at each start, in one place (`src/crew.js`).

| Who | How sage-bot knows them | What they can do |
| --- | --- | --- |
| The owner (you) | Your Discord user id: `ownerId` in the config, else the owner of the Discord app of step 1. Never a role. | Answer at the terminal (final), end a vote early, break a tie, approve or decline a request (on its card or at the terminal), `/sage stop`, `/sage unregister`, turn the link on again at the terminal, read with `/sage`. |
| The crew | Every member with a role named exactly `sage-crew` (the case counts). | Answer a single question, vote, read with `/sage` and mentions, request a feature with `/sage request` and withdraw it while it waits, `/sage stop` (the emergency stop: at once, with no approval). |

**How sage-bot finds the owner at start:**

1. When the config has `ownerId`, that id is the owner. When the Discord app has another owner, the log says so in one warning line, and sage-bot keeps the config's id.
2. Else, when the app belongs to your own account, your account is the owner.
3. Else, the app belongs to a Developer Team, and sage-bot cannot tell which member is the owner. It refuses to start with this line in `~/Library/Logs/sage-bot.log`:

   > the Discord application of sage-bot belongs to a Developer Team, so sage-bot cannot tell who its owner is. Add "ownerId" with your Discord user id to the config, then start sage-bot again. Nothing was started.

**Names in the messages.** The cards, buttons, notes and `/sage` descriptions name you by your own Discord name (your display name, else your user name; never a server nickname, which a moderator can change), and name the bot by its own name, for example "Waiting for Maya" and "If a button does not respond, Maya's sage is offline". sage-bot reads both names at each start. It keeps only letters, digits, marks on a letter, spaces and `. ' -`, at most 32 characters. When Discord gives no name, or nothing is left of it, the messages say "the owner" and "sage-bot". A new display name shows after the next start.

**A config from before.** A config with `apprenticeRole`, `leadRole` or the older `driverRole` still starts. The log says that sage-bot no longer reads them, and they do nothing. Remove them, and delete the old `sage-apprentice` and `sage-lead` roles when no other sage-bot uses them. This warning goes away in the next release, and then the keys are only unknown keys.

## A second owner joins the server

Several owners can each run their own sage-bot in one server. Each bot has its own owner, its own projects, its own cards and its own requests. One shared `sage-crew` role is the crew of every bot: a crew member can request a feature on each bot, and each owner approves the requests on their own bot only.

The second owner, for example Maya, does these steps:

1. Make her own Discord app and bot, as in [step 1](#the-checklist). Give the bot a name that says whose it is, for example "Maya's sage": the cards and notes show that name.
2. Invite it with the same permission integer `326417632256`. Keep **Guild Install** only and **Public Bot** off.
3. Use the `sage-crew` role that the server has already. Do not make a second one: sage-bot warns when two roles have that name.
4. Set her own channels in her own config, as in [Channels](#channels). Two bots can share a channel, but each card, thread and request belongs to the bot that posted it.
5. Run her own bridge on her own Mac, or under her own macOS user. Run one sage-bot for each macOS user: the launchd label `com.sage.bot`, the Keychain item `sage-bot` and the config folder `~/.config/sage-bot` are fixed names.

**How the bots stay apart.**

| What | Why it reaches only its own bot |
| --- | --- |
| A button or a form | Discord sends a press only to the app that posted the message. The vote and request buttons also check the message id that the bot keeps for each card, so a press from any other message changes nothing. |
| A mention | Discord tells each bot which users a message mentions. A bot answers only a mention of itself, so a mention of Maya's bot in Erick's thread is not Erick's bot's. |
| `/sage` | Each bot sets its own `/sage` in the server. Discord shows the bot's name beside each one, and the descriptions name its owner. |
| A thread | Each bot keeps its own thread map. In a thread of another bot, a bot only points to its own channel. |
| The files | Each bridge keeps its requests, thread map, audit log and votes beside its own `statePath`, on its own Mac. |

A mention of one bot in a thread of another bot gets only that pointer for now. A later pull request (PR 7) adds a move of the mention to the bot's own thread.

## The audit log and the kill switch

**#sage-audit.** Make a text channel `#sage-audit` that only you can see, where only sage-bot can post. Put its id in the config as `auditChannelId`. sage-bot posts a copy of each line of the audit log there, which pings nobody, and the warning when two roles are named `sage-crew`. Without `auditChannelId`, the bridge keeps the log only and says so at start.

The audit log is `<statePath>.leads.jsonl`, or `auditPath` in the config. (The file names keep the word "leads" from before.) Its folder must be 0700 and outside every project, and the file is 0600. The kill switch is the flag file `<statePath>.leads-off`, or `killPath` in the config; a flag that the bridge cannot check counts as set. The [reference](reference.md#mention-threads) tells what the hash chain shows and what it does not.

Check and change the link from Discord to sage at the terminal:

<!-- check: run, prints "the link from Discord to sage is on" -->
```sh
node scripts/leads.mjs status    # is the link on or off?
node scripts/leads.mjs stop      # turn the link off at the terminal
node scripts/leads.mjs restore   # turn the link on again (only the owner, at the terminal)
node scripts/leads.mjs verify    # check the hash chain of the audit log; exits 1 at a break
node scripts/leads.mjs read 20   # print the last 20 lines of the audit log; a line from a break on starts with UNVERIFIED
```
