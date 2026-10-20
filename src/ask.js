// The read commands of the registered channels (T71, G18 option A; T130): /sage board, task, gates and files,
// /sage unregister for the owner, /sage stop (the kill switch, T131; the emergency stop of the crew and the owner, T232), and the threads of
// @sage-bot mentions (T131, src/threads.js): a mention in a registered channel opens a thread, and a read ask gets its answer there.
// Every other mention, and the "Send to sage" message command, is a message to sage (T247): it goes to the outbox (src/outboxFlow.js),
// whose approval card in the thread waits for the owner. A mention in a thread that sage-bot does not own moves to a thread of its own.
// The bridge answers them itself, with no AI, from the tasks.tsv and gates.tsv of a listed project, read through `pick` (only safe
// columns). It never reads decisions.tsv, findings, briefs or reports. Every reply is public (G20: everyone can see the questions
// and the answers), goes through `safe` (the readers are people on Discord) and pings nobody. Anyone but the crew and the owner
// (src/crew.js placeOf) gets one private line for a command or a press (notCrew, T239), and nothing for a mention. Discord comes in as plain objects (src/discord.js maps the real ones, src/fake-discord.js fakes them).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { ApplicationCommandType, ContextMenuCommandBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { cut, ephemeral, NO_MENTIONS, safe, stamp } from './cards.js';
import { CREW, mayStop, namesOf, notCrew, placeOf } from './crew.js';
import { forTerminal } from './clean.js';
import { sageTool } from './sage.js';
import { loadProjects, pickProject, TYPES } from './projects.js';
import { channelsPathOf, saveChannels } from './channels.js';
import { loadVotes, votesPathOf } from './state.js';
import { auditPathOf, killPathOf, linkOff, openLog, recorder, setLinkOff } from './audit.js';
import { Refused } from './outbox.js';
import { loadThreads, noRight, readAsk, threadName, threadsPathOf } from './threads.js';

/** Asks per person in a rolling hour across all channels (G18 D5, G27): every /sage command and every mention of the crew counts,
 * also a refused one; a mention that opens a thread counts once. A /sage stop does not count: the kill switch always works. */
export const ASK_LIMIT = 10;
export const HOUR = 3_600_000;
/** A burst limit per person, apart from ASK_LIMIT (F-T143-2, F-T143-5): at most BURST /sage stop of one person, and at most
 * BURST log lines of a crew member's mentions over ASK_LIMIT in an owner thread, in BURST_FOR. So neither floods #sage-audit or a channel. */
export const BURST = 3;
export const BURST_FOR = 10 * 60_000;
const DAY = 24 * HOUR;
/** The files that /sage files may attach: at most this many, of these types only, and at most MAX_BYTES in one reply, so also in one file.
 * 8 MiB stays under Discord's upload limit for a server with no boosts (10 MB a message) with room for the rest of the request. */
export const MAX_FILES = 10;
export const MAX_BYTES = 8 * 1024 * 1024;
const TASK_ID = /^T\d{1,9}$/;
const DONE = new Set(['merged', 'concluded', 'abandoned']);
const SNOWFLAKE = /^\d{17,20}$/;
/** The most open requests that /sage board lists one by one: each line has at most about 250 characters, so the head fits in one reply. */
export const BOARD_REQUESTS = 5;
/** A reply in place pings nobody, also not the person it answers. */
const QUIET = { ...NO_MENTIONS, repliedUser: false };
/** Discord's limit for the text of one message. */
const REPLY = 2000;

export const POINTER = 'I answer read asks here with no AI: mention me with board, gates, files or a task id such as T7, or use /sage.';
/** The line for a message to sage in a bridge with no outbox (createAsk's `outbox`): nothing is sent. */
export const NOT_ON = 'Messages to sage are not on in this bridge. Nothing was sent.';
/** The name of the message command that sends any message to sage (T247), as Discord shows it in the Apps menu of a message. */
export const SEND = 'Send to sage';
/** The "Send to sage" message command, for the guild's command list: in a server only. */
export const sendCommand = () => new ContextMenuCommandBuilder().setName(SEND).setType(ApplicationCommandType.Message)
  .setContexts(InteractionContextType.Guild).toJSON();
/** The name of an attached file, for the people who download it: only A-Z, a-z, 0-9, dot, dash and underscore; any other character becomes "_". */
export const attachmentName = (name) => name.replace(/[^A-Za-z0-9._-]/gu, '_');

/** Discord's limit for the description of a command or an option, in UTF-16 units. */
const DESCRIPTION = 100;
/**
 * The /sage command, for the guild's command list: its subcommands, the project as a choice of the listed projects. `us` is src/crew.js
 * namesOf: the descriptions name the owner (T244), so each sage-bot's /sage in a server says whose it is. A name can hold letters of
 * 2 UTF-16 units each, so each description with a name is cut to DESCRIPTION (F-T244-5). The project names are at most 32 characters.
 */
export function askCommand(projects, us) {
  const named = (s, text) => s.setDescription(cut(text, DESCRIPTION));
  const project = (o) => o.setName('project').setDescription('A shared project (the first one when you leave it out)')
    .addChoices(...projects.map((p) => ({ name: p.name, value: p.name })));
  return new SlashCommandBuilder().setName('sage').setDescription('Read the sage board, a task, the open questions or shared files')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('board').setDescription('Tasks by state, tasks left and the open questions').addStringOption(project))
    .addSubcommand((s) => s.setName('task').setDescription('One task: its title, size, state and pull request')
      .addStringOption((o) => o.setName('id').setDescription('The task id, for example T7').setRequired(true).setMaxLength(12))
      .addStringOption(project))
    .addSubcommand((s) => s.setName('gates').setDescription('The open questions with their options').addStringOption(project))
    .addSubcommand((s) => s.setName('files').setDescription('The shared images and PDFs of a project').addStringOption(project))
    .addSubcommand((s) => named(s.setName('request'), `Request a feature: ${us.owner} approves or declines it`).addStringOption(project))
    .addSubcommand((s) => named(s.setName('unregister'), `Stop ${us.bot} in this channel (${us.owner} only)`))
    .addSubcommand((s) => named(s.setName('stop'), `Turn off the link from Discord to sage at once (the crew and ${us.owner})`))
    .toJSON();
}

/** Only the safe columns of the logbook: an open question in full (G20), but no answer text, no branch, no why, no findings, never decisions. */
async function pick(tool) {
  const [tasks, gates] = await Promise.all([tool.tasks(), tool.gates()]);
  return {
    tasks: tasks.map(({ id, title, size, state, pr }) => ({ id, title, size, state, pr })),
    open: gates.filter((g) => !g.answer).map(({ id, task, question, options, recommendation, default: byDefault }) => ({ id, task, question, options, recommendation, byDefault })),
  };
}

/** Untrusted text for a person on Discord: cut first, then made safe (as in src/bridge.js). */
const shown = (text, max) => safe(cut(String(text ?? ''), max));
const options = (text) => String(text).split('|').map((o) => o.trim()).filter(Boolean).map((o, i) => `${'ABCDE'[i] ?? i + 1}. ${shown(o, 100)}`).join(' · ');

/**
 * The files of a project that its allow-list names: regular files inside the project with one link, of an allowed type and size, sorted,
 * each with the device and inode that the check saw and the real path of its folder. An entry that cannot be checked (a dangling symlink)
 * is left out (F-T71S-2). The one link is checked here, before the open, because a second link removed between the open and the fstat
 * is gone when `readShared` looks (F-T93-6).
 */
export function sharedFiles(p) {
  const root = realpathSync(p.project);
  const found = new Map();
  for (const entry of p.files) {
    const dir = join(p.project, dirname(entry));
    const match = new RegExp(`^${basename(entry).replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
    let names;
    try { names = readdirSync(dir); } catch { continue; } // a folder that is not there shares nothing
    for (const name of names.filter((n) => match.test(n) && !n.startsWith('.'))) {
      const path = join(dir, name);
      let st, real;
      try { st = lstatSync(path); real = realpathSync(path); } catch { continue; }
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES || !real.startsWith(root + sep) || !TYPES.includes(extname(name).slice(1))) continue;
      found.set(real, { path, name: real.slice(root.length + 1), dev: st.dev, ino: st.ino, folder: dirname(real) });
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Reads the files that `sharedFiles` checked, each through one open file (F-T71S-1). Opened with no symlink at the end and with no wait
 * (a FIFO), it must still be a regular file with the device and inode of the check, one link (another link can be a name outside the
 * project: F-T93-1) and at most MAX_BYTES, and after the open its folder must still have the real path of the check (F-T91-1), or it is
 * left out. Node has no openat, so one window stays (F-T93-7): two folder swaps, each swapped back in time, one around the lstat of the
 * check (so the device and inode are of the outside file) and one around the open. It can send a file of any folder that the bridge can
 * read, with one link, of an allowed type and size, and with the name of a file in that folder of the project. A link removed after the
 * open is no race: the check refused the file with two links (F-T93-6). The files fill one reply up to MAX_FILES and MAX_BYTES, in order;
 * a checked file that does not fit is in `over` (F-T93-2). Only the checked size is read, also when the file grows.
 * @returns {{ attached: { name: string, data: Buffer }[], over: string[] }}
 */
export function readShared(files) {
  const attached = [];
  const over = [];
  let total = 0;
  for (const f of files) {
    let fd;
    try {
      fd = openSync(f.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino || st.nlink !== 1 || st.size > MAX_BYTES) continue;
      if (realpathSync(dirname(f.path)) !== f.folder) continue;
      if (attached.length === MAX_FILES || total + st.size > MAX_BYTES) { over.push(f.name); continue; }
      const data = Buffer.alloc(st.size);
      let n = 0;
      for (let got; n < st.size && (got = readSync(fd, data, n, st.size - n, n)) > 0;) n += got;
      total += n;
      attached.push({ name: f.name, data: data.subarray(0, n) });
    } catch { continue; } finally { if (fd !== undefined) closeSync(fd); }
  }
  return { attached, over };
}

/** The custom_id of the confirm button of /sage unregister: this prefix and the channel id. Its Cancel button is CANCEL. */
export const UNREGISTER = 'channel-unregister:';
export const CANCEL = `${UNREGISTER}cancel`;
/** How long the confirm of /sage unregister or /sage stop works after Discord made it. */
export const CONFIRM_FOR = 10 * 60_000;
/** The custom_ids of the confirm button of /sage stop (the kill switch) and of its Cancel button. */
export const STOP = 'leads-stop';
export const STOP_CANCEL = 'leads-stop:cancel';
/** Discord's codes for a right that sage-bot lacks: Missing Access and Missing Permissions. */
const NO_RIGHT = new Set([50001, 50013]);

/**
 * The files of createAsk, opened and checked: the thread map (thread id → { kind, channel, project, by, at }) and the audit log. Throws for
 * a thread map or an audit log that is not safe. src/discord.js prepare opens them before the Keychain and the login (F-T232-3).
 */
export const openAskFiles = (config, projects) => ({ threads: loadThreads(threadsPathOf(config)), auditLog: openLog(auditPathOf(config), projects) });

/**
 * The read commands and the mention threads for one bridge. `config` is the bridge config (ownerId as src/crew.js ownerOf resolved it,
 * project, sagePath, statePath, projects, and optionally auditPath and killPath). `channels` is the channel registry (src/channels.js
 * openChannels); `projects` are the bridge's (src/projects.js loadProjects). The owner's unregister changes it and saves it. `audit` posts a
 * copy of each audit log line to #sage-audit (none: the log only). `env` goes to the sage state tool (the tests give a scratch HOME).
 * `files` are from openAskFiles (default: opened here). `outbox` is the outbox side (src/outboxFlow.js createOutboxFlow): with none, a message
 * to sage gets one line that says so. Throws for a config that is not safe, and for a thread map or an audit log that is not safe.
 */
export function createAsk({ config, channels, projects = loadProjects(config), now = Date.now, log = (line) => process.stderr.write(`${line}\n`), env, audit,
  files = openAskFiles(config, projects), requests, outbox }) {
  const { threads, auditLog } = files;
  const killPath = killPathOf(config);
  const byName = new Map(projects.map((p) => [p.name, { ...p, tool: sageTool({ sagePath: p.sagePath, project: p.project, ...(env && { env }) }) }]));
  const asks = new Map(); // person id → the times of their asks in the last hour; only in memory
  const warned = new Map(); // person id → until when a mention over the limit gets no second note
  const stops = new Map(); // person id → the times of their /sage stop in the last BURST_FOR
  const stopWarned = new Map(); // person id → until when a /sage stop over BURST gets no second note
  const overLines = new Map(); // person id → the times of a crew member's over-limit log lines in an owner thread
  const daily = new Map(); // person id → the UTC day of their last pointer in a channel that is not registered
  const say = (line) => log(forTerminal(line));
  /** The registered channel that a pointer names: the first one of the registry. */
  const here = () => `<#${channels.keys().next().value}>`;
  /** One pointer per person per UTC day in a channel that is not registered, else null. */
  function pointer(id, text) {
    const day = Math.floor(now() / DAY);
    if (daily.get(id) === day) return null;
    daily.set(id, day);
    return text;
  }

  /** Counts one ask of `id` in `kind`, at most `max` in `span`. Returns null when it may go on, or the time when the next one works. */
  function spend(id, kind = asks, max = ASK_LIMIT, span = HOUR) {
    const t = now();
    const times = (kind.get(id) ?? []).filter((at) => at > t - span);
    if (times.length >= max) { kind.set(id, times); return times[0] + span; }
    kind.set(id, [...times, t]);
    return null;
  }
  const limited = (at) => `You asked ${ASK_LIMIT} times in the last hour; that is the limit. Your next ask works at ${stamp(at)}.`;
  /** Where the person of a command, press or mention is (src/crew.js): the one read of the crew and the owner here. */
  const place = (x) => placeOf(x.user.id, x.roles ?? [], config.ownerId);
  const us = namesOf(config); // the names of the owner and of this bot in the copy (T244)
  if (auditLog.broken) say(`the audit log ${auditPathOf(config)} has a break at line ${auditLog.broken.line}: it ${auditLog.broken.why}. New lines chain on from its last line. Run: node scripts/leads.mjs verify`);
  /**
   * The registered channel of a place: the channel, or the parent of a thread (F-T71-5, as `accepts` does for the home channel), as its
   * id; null when neither is registered. `parentId` is a thread's parent, or a promise of it.
   */
  async function registered(channelId, parentId) {
    if (channels.has(channelId)) return channelId;
    const parent = await parentId;
    return channels.has(parent) ? parent : null;
  }
  const teamVotes = () => { // the team votes of every project (T132): gate key → the folder of its project (G45 A)
    try { return loadVotes(votesPathOf(config)); } catch { return new Map(); }
  };

  /** The content (and files) of the answer to one /sage command in the registered channel `at` (or a thread of it). */
  async function answer(i, at) {
    const { sub, options: o } = i;
    if (sub === 'unregister') return unregisterAsk(place(i), at);
    const p = o.project ? byName.get(o.project) : byName.get(channels.get(at).project);
    if (!p) return { content: `I do not know a shared project called "${shown(o.project, 40)}".` };
    if (sub === 'files') {
      const { attached, over } = readShared(sharedFiles(p));
      if (!attached.length && !over.length) return { content: `${p.name} shares no files.` };
      return { content: [`${attached.length} shared file(s) of ${p.name}:`, ...attached.map((f) => `- ${shown(f.name, 200)}`),
        ...(over.length ? [`${over.length} more file(s) not attached: one reply holds at most ${MAX_FILES} files and 8 MB. Ask ${us.owner} for them.`, ...over.map((name) => `- ${shown(name, 200)}`)] : [])].join('\n'),
        files: attached.map((f) => ({ attachment: f.data, name: attachmentName(basename(f.name)) })) };
    }
    let data;
    try { data = await pick(p.tool); } catch (e) {
      say(`/sage ${sub}: the logbook of ${p.name} could not be read: ${e?.message}`);
      return { content: `I could not read the records of ${p.name} just now. Nothing is lost. Please ask again in a minute.` };
    }
    if (sub === 'board') return { content: board(p, data, waiting(p)) };
    if (sub === 'gates') return { content: gates(p, data) };
    if (sub === 'task') return { content: task(p, data, String(o.id ?? '').trim().toUpperCase()) };
    return { content: POINTER };
  }

  /** The answer to /sage unregister: a confirm button for the owner, a refusal for anyone else and for the home channel. */
  function unregisterAsk(p, at) {
    if (!p.owner) return { content: `Only ${us.owner} can unregister a channel. Ask ${us.owner}.` };
    if (channels.get(at).home) return { content: `<#${at}> is the home channel of the votes and cards. Only ${us.owner} can change it, at the terminal.` };
    return { content: `Unregister <#${at}>? ${us.bot} then ignores /sage and mentions here and in its threads. Only ${us.owner} can register it again, at the terminal.`,
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Unregister this channel', custom_id: `${UNREGISTER}${at}` },
        { type: 2, style: 2, label: 'Cancel', custom_id: CANCEL }] }] };
  }

  /**
   * The answer to /sage stop of a crew member or the owner (src/crew.js mayStop): a confirm button. Its Cancel names the person who asked
   * (`asker`), so that only they or the owner cancel it (F-T232-11).
   */
  function stopAsk(asker) {
    if (linkOff(killPath)) return { content: `The link from Discord to sage is already off. Only ${us.owner} can turn it on again, at the terminal.` };
    return { content: `Turn off the link from Discord to sage? Then no message from Discord goes to sage until ${us.owner} turns it on again at the terminal. Read asks keep working.`,
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Turn off the link', custom_id: STOP }, { type: 2, style: 2, label: 'Cancel', custom_id: `${STOP_CANCEL}:${asker}` }] }] };
  }

  /**
   * Writes one line of the audit log for a message of the owner or a /sage stop (src/audit.js recorder, which src/outboxFlow.js shares),
   * then posts its copy to #sage-audit. Throws when the log cannot be written: then nothing goes further.
   */
  const writeLine = recorder({ auditLog, audit, now, say });
  const record = (m, { thread = null, project = null, outcome }) => writeLine({ message: m.id ?? null, author: m.user.id, place: place(m),
    raw: m.content ?? '', thread, project, outcome });

  /** Saves the thread map after a change to the thread `thread`; a failure only loses the change at the next restart. */
  function keep(thread) {
    try { threads.save(); } catch (e) { say(`the thread map could not be saved, so the last change to ${thread} lasts only until the next restart: ${e?.message}`); }
  }

  /**
   * Where a message to sage goes (T247): the registered channel `at` of its place (null: none), whether the place is a thread, and the
   * thread map entry of that thread (`own`). A thread that sage-bot does not own (another bot's thread, a forum post, or a thread of a
   * channel that is not registered) `moves` (R918 C7), to the thread of sage-bot that an earlier move from it opened (`moved`: its id and
   * entry, the entry whose `origin` is that thread), else to a new one.
   * @param {{ channelId: string, parentId: Promise<string | null> | string | null }} x
   */
  async function placeOfMessage(x) {
    const parent = channels.has(x.channelId) ? null : await x.parentId;
    const at = parent === null ? (channels.has(x.channelId) ? x.channelId : null) : (channels.has(parent) ? parent : null);
    const own = parent !== null ? threads.get(x.channelId) ?? null : null;
    const moves = parent !== null && !own;
    return { at, own, moves, inThread: parent !== null, moved: moves ? [...threads].find(([, t]) => t.origin === x.channelId) ?? null : null };
  }

  /**
   * The thread of a message `x` of `who` (the sender), as `{ thread, t }`, or null after `tell(text)` said why not. In a thread of
   * sage-bot: that thread. In a registered channel: a new thread from the message (`x.startThread`). In a thread that sage-bot does not
   * own (`moves`): the thread that the first move from there opened, else a line in the home channel, "From <link> in <#thread>", and a
   * new thread from that line (`x.open`), with the old thread as its `origin`; either way one line in the old thread that pings nobody:
   * "Moved to <bot>: <#new thread>" (`x.post`).
   */
  async function threadFor(x, who, { at, own, moves, moved }, tell) {
    if (own) return { thread: x.channelId, t: own };
    const home = config.channelId;
    const told = (thread) => x.post(x.channelId, { content: `Moved to ${us.bot}: <#${thread}>`, allowedMentions: NO_MENTIONS })
      .catch((e) => say(`Discord refused the moved line in ${x.channelId}: code ${e?.code ?? '-'}: ${e?.message}`));
    if (moved) { await told(moved[0]); return { thread: moved[0], t: moved[1] }; }
    let thread;
    try {
      thread = moves
        ? await x.open(home, { content: `From https://discord.com/channels/${config.guildId}/${x.channelId}/${x.id} in <#${x.channelId}>`, allowedMentions: NO_MENTIONS }, threadName(x.content))
        : await x.startThread(threadName(x.content));
    } catch (e) {
      say(`Discord refused to open a thread for a message in ${moves ? home : at}: code ${e?.code ?? '-'}: ${e?.message}`);
      if (place(who).owner) record({ ...x, user: who.user }, { project: channels.get(at ?? home)?.project ?? null, outcome: NO_RIGHT.has(e?.code) ? 'no-thread-right' : 'no-thread' });
      await tell(NO_RIGHT.has(e?.code) ? noRight('Create Public Threads', us)
        : e?.code === 160004 ? 'This message has a thread already. Mention me in that thread. Nothing was sent.'
          : 'I could not open a thread just now. Nothing changed. Please ask again in a minute.');
      return null;
    }
    const channel = moves ? home : at;
    const t = { kind: 'answer', channel, project: channels.get(channel).project, by: who.user.id, at: now(), ...(moves && { origin: x.channelId }) };
    threads.set(thread, t);
    keep(thread);
    if (moves) await told(thread);
    return { thread, t };
  }

  /**
   * Gives the message `x` (its `id` and `content`, by `x.user`) of the sender `who` to the outbox, for the thread `at` (threadFor). Returns
   * the record, or null after `tell(text)` said why it was not sent: PENDING_MAX messages waiting, or the context or the outbox could not
   * be read or written.
   */
  async function toOutbox(x, who, { thread, t }, tell) {
    try {
      return await outbox.send({ message: x.id, where: x.channelId, thread, entry: t, author: { id: who.user.id, name: who.name, roles: who.roles },
        quote: { user: x.user.id, name: x.name, roles: x.roles }, text: x.content ?? '', history: x.history, replied: x.replied });
    } catch (e) {
      if (e instanceof Refused) { await tell(e.message); return null; }
      say(`a message to sage in ${thread}: code ${e?.code ?? '-'}: ${e?.message}`);
      await tell(NO_RIGHT.has(e?.code) ? `I could not read the messages before yours: ${us.bot} lacks the right "Read Message History" here. Nothing was sent. Ask ${us.owner} to give it to ${us.bot}'s role.`
        : 'I could not read the messages before yours, or record yours, just now. Nothing was sent. Please try again in a minute.');
      return null;
    }
  }

  /**
   * A press of the /sage stop confirm by a crew member or the owner (press() passes on no one else: src/crew.js mayStop) sets the kill
   * switch at once, with no approval. Cancel, or a confirm older than CONFIRM_FOR (or of no known time), changes nothing and closes the
   * confirm (F-T131-2), so an old confirm cannot set the flag again after the owner's restore. Only the person who asked (the id in the
   * Cancel's custom_id) or the owner cancels: anyone else gets a private reply, and the confirm stays (F-T232-11).
   */
  async function stopPress(b, roles) {
    const fail = (e) => say(`Discord refused the stop reply: code ${e?.code ?? '-'}: ${e?.message}`);
    let content;
    if (b.customId !== STOP && b.customId !== `${STOP_CANCEL}:${b.user.id}` && !place(b).owner) {
      await b.reply(ephemeral(`Only the person who typed /sage stop, or ${us.owner}, can cancel it. Nothing changed.`)).catch(fail);
      return;
    }
    if (b.customId !== STOP) content = 'Cancelled. Nothing changed.';
    else if (!(now() - b.sentAt <= CONFIRM_FOR)) content = 'This confirm expired after 10 minutes. Nothing changed. Type /sage stop again.';
    else if (linkOff(killPath)) content = 'The link from Discord to sage is already off. Nothing changed.'; // F-T143-2: no write, no log line
    else try {
      setLinkOff(killPath, b.user.id, now());
      say(`${b.user.id} turned off the link from Discord to sage (the kill switch ${killPath}). Turn it on again with: node scripts/leads.mjs restore`);
      content = `<@${b.user.id}> turned off the link from Discord to sage. No message from Discord goes to sage until ${us.owner} turns it on again at the terminal. Read asks keep working.`;
      try { record({ ...b, roles, content: '/sage stop' }, { outcome: 'link-off-set' }); } catch (e) { say(`the audit log could not record the stop: ${e?.message}`); }
    } catch (e) {
      say(`the kill switch ${killPath} could not be set: ${e?.message}`);
      content = 'I could not turn off the link just now. Turn it off at the terminal with: node scripts/leads.mjs stop';
    }
    await b.update({ content, components: [], allowedMentions: NO_MENTIONS }).catch(fail);
  }

  /**
   * /sage request of a crew member or the owner (T228): no defer, because the form must be Discord's first answer (src/requestFlow.js).
   * It counts toward the hourly limit; over it, or outside a registered channel, one private note.
   */
  async function requestAsk(i) {
    const fail = (e) => say(`Discord refused a /sage request reply: code ${e?.code ?? '-'}: ${e?.message}`);
    try {
      const at = await registered(i.channelId, i.parentId);
      if (!at) return await i.reply(ephemeral(`I take requests in ${here()} and the other channels of ${us.bot}, so please ask there.`)).catch(fail);
      const next = spend(i.user.id);
      if (next) return await i.reply(ephemeral(limited(next))).catch(fail);
      if (!requests) return await i.reply(ephemeral('Requests are not on in this bridge. Nothing was sent.')).catch(fail);
      await requests.command(i, at);
    } catch (e) { say(`/sage request: ${e?.message}`); }
  }
  /** The open requests of a project for the board (T229), oldest first; null when the requests file cannot be read. */
  function waiting(p) {
    if (!requests) return [];
    try { return requests.waiting(p); } catch (e) { say(`/sage board: the requests file could not be read: ${e?.message}`); return null; }
  }
  function board(p, { tasks, open }, asked) {
    const count = new Map();
    for (const t of tasks) count.set(t.state, (count.get(t.state) ?? 0) + 1);
    const left = tasks.filter((t) => !DONE.has(t.state)).length;
    return fitted([`**Board · ${p.name}**`,
      `${tasks.length} task(s)${[...count].map(([s, n]) => ` · ${shown(s, 20)} ${n}`).join('')}`,
      `${left} task(s) left. Time left is not estimated yet: the project's records have no estimate.`,
      ...requestLines(asked),
      `${open.length} open question(s)${open.length ? ':' : '.'}`], open, (g) => question(g));
  }
  /**
   * The lines of the open requests on the board: a count, then at most BOARD_REQUESTS of them, oldest first, each with its id, title,
   * requester, status word and thread; "N more" for the rest. Each line is cut, so the head of the board always fits in one reply.
   */
  function requestLines(asked) {
    if (asked === null) return ['The requests could not be read just now.'];
    if (!asked.length) return [];
    const line = (r) => `- ${r.id} · ${shown(r.title, 70)} · by ${shown(r.requesterName, 32) || `a ${CREW} member`} · `
      + `${r.status === 'pending' ? `waiting for ${us.owner}` : 'being approved'}${r.thread ? ` · <#${r.thread}>` : ''}`;
    return [`${asked.length} open request(s):`, ...asked.slice(0, BOARD_REQUESTS).map(line),
      ...(asked.length > BOARD_REQUESTS ? [`${asked.length - BOARD_REQUESTS} more open request(s): ${us.owner} sees them all with node scripts/requests.mjs list.`] : [])];
  }
  function gates(p, { open }) {
    if (!open.length) return `${p.name} has no open questions.`;
    const votes = teamVotes();
    return fitted([`**Open questions · ${p.name}** (${open.length})`], open, (g) => [...question(g, votes.get(`${p.name}/${g.id}`) === p.project ? 'team vote' : 'answered at the terminal'), ...advice(g)]);
  }
  /** One open question in full (G20): its text and its options. */
  const question = (g, how) => [`- ${shown(g.id, 12)} (${shown(g.task, 12)})${how ? `, ${how}` : ''}: ${shown(g.question, 300)}`, `  ${options(g.options)}`];
  /** sage's recommendation and the default of an open question, as one line; none when the logbook has neither (only /sage gates shows it). */
  function advice(g) {
    const parts = [['Recommended', g.recommendation], ['Default', g.byDefault]].map(([name, text]) => [name, shown(text, 200)]).filter(([, text]) => text);
    return parts.length ? [`  ${parts.map(([name, text]) => `${name}: ${text}`).join(' · ')}`] : [];
  }
  /**
   * `head`, then as many whole open questions as fit in one reply of REPLY characters, then "N more open question(s): G7, G8." with
   * the ids of the rest, or only the count when the ids do not fit either (F-T95-1). So no question is cut, and none is left out unsaid.
   */
  function fitted(head, open, block) {
    const blocks = open.map((g) => block(g).join('\n'));
    const ids = open.map((g) => shown(g.id, 12));
    for (let k = open.length; ; k--) {
      const text = [...head, ...blocks.slice(0, k)].join('\n');
      if (k === open.length) { if (text.length <= REPLY) return text; continue; }
      const more = `${open.length - k} more open question(s)`;
      for (const line of [`${more}: ${ids.slice(k).join(', ')}.`, `${more}.`]) {
        if (text.length + 1 + line.length <= REPLY) return `${text}\n${line}`;
      }
    }
  }
  function task(p, { tasks }, id) {
    const t = TASK_ID.test(id) && tasks.find((x) => x.id === id);
    if (!t) return `${p.name} has no task ${shown(id, 12)}.`;
    const pr = !/^\d+$/.test(t.pr) ? 'no pull request' : p.repo ? `pull request [#${t.pr}](<${p.repo}/pull/${t.pr}>)` : `pull request #${t.pr}`;
    return `**${t.id} · ${shown(t.title, 300)}**\n${shown(t.size, 20)} · ${shown(t.state, 20)} · ${pr}`;
  }

  return {
    projects,
    /**
     * One /sage command: `{ user: { id, bot }, name, roles, channelId, parentId, sub, options: { project, id }, defer, edit, reply, showModal }`,
     * with the NAMES of the member's roles. A bot gets nothing; anyone but the crew and the owner gets notCrew privately (T239), and nothing
     * counts. /sage request opens its form with no defer (requestAsk). Every other ask is first deferred in public, before any file
     * or logbook work (F-T71-2), then gets its answer as an edit of that reply, which pings nobody. Never rejects.
     */
    async command(i) {
      if (i.user?.bot || !SNOWFLAKE.test(i.user?.id ?? '')) return;
      if (!(place(i).crew || place(i).owner)) { // T239: one private line, within Discord's 3 s; nothing counts
        await i.reply(ephemeral(notCrew(us))).catch((e) => say(`Discord refused the reply to a /sage of someone not in the crew: code ${e?.code ?? '-'}: ${e?.message}`));
        return;
      }
      if (i.sub === 'request') return requestAsk(i);
      try { await i.defer({}); } catch (e) {
        say(`Discord refused to defer a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`);
        return;
      }
      let payload;
      try {
        // The kill switch always works (F-T131-3, T232): a /sage stop of the crew or the owner skips the limit and works in any channel. It has
        // its own burst limit (F-T143-2): over BURST in BURST_FOR, one note, then nothing until the burst frees up.
        const stop = i.sub === 'stop' && mayStop(place(i));
        const burst = stop && spend(i.user.id, stops, BURST, BURST_FOR);
        const quiet = burst && (stopWarned.get(i.user.id) ?? 0) > now();
        if (burst && !quiet) stopWarned.set(i.user.id, burst);
        const at = stop ? null : await registered(i.channelId, i.parentId);
        const text = stop || at ? null : pointer(i.user.id, `I answer /sage in ${here()}, so please ask there.`);
        if ((!stop && !at && !text) || quiet) { // ignored: the deferred reply goes again, so nothing stays in the channel
          await i.remove().catch((e) => say(`Discord refused to remove a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`));
          return;
        }
        const next = at && spend(i.user.id);
        payload = burst ? { content: `You used /sage stop ${BURST} times in the last 10 minutes; that is the limit. Your next /sage stop works at ${stamp(burst)}. ${us.Owner} can still turn the link off at the terminal.` }
          : stop ? stopAsk(i.user.id) : !at ? { content: text } : next ? { content: limited(next) } : await answer(i, at);
      } catch (e) {
        say(`/sage ${i.sub}: ${e?.message}`);
        payload = { content: 'I could not answer just now. Nothing changed. Please ask again in a minute.' };
      }
      try { await i.edit({ ...payload, content: cut(payload.content, REPLY), allowedMentions: NO_MENTIONS }); } catch (e) {
        say(`Discord refused a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`);
      }
    },
    /**
     * A press of a button of the /sage unregister confirm or the /sage stop confirm: `{ user: { id, name, bot }, roles, customId, sentAt,
     * update, reply }`, where `sentAt` is when Discord made the confirm. STOP and STOP_CANCEL (with the asker's id) go to the kill switch (stopPress). The owner's press of
     * the unregister confirm removes the channel from the registry, saves it, logs it at the terminal with the owner's name and id, and
     * replaces the confirm with the result; Cancel, or a confirm older than CONFIRM_FOR, changes nothing and closes the confirm. A crew
     * member's press of the unregister confirm changes nothing and gets a private reply of its own, so the owner's confirm stays. Anyone else gets notCrew privately
     * (T239); a custom_id that is not STOP, STOP_CANCEL, CANCEL or a channel id gets nothing. Never rejects.
     */
    async press(b) {
      const roles = b.roles ?? [];
      if (b.user?.bot || !SNOWFLAKE.test(b.user?.id ?? '')) return;
      if (!(place(b).crew || place(b).owner)) { // T239
        await b.reply(ephemeral(notCrew(us))).catch((e) => say(`Discord refused the reply to a press of someone not in the crew: code ${e?.code ?? '-'}: ${e?.message}`));
        return;
      }
      if (b.customId === STOP || String(b.customId).startsWith(STOP_CANCEL)) return stopPress(b, roles);
      const id = String(b.customId).slice(UNREGISTER.length);
      if (b.customId !== CANCEL && !SNOWFLAKE.test(id)) return;
      let content;
      if (!place(b).owner) {
        await b.reply(ephemeral(`Only ${us.owner} can unregister a channel. Nothing changed.`)) // only they see it, so presses add nothing to the channel (F-T136-9)
          .catch((e) => say(`Discord refused the unregister reply: code ${e?.code ?? '-'}: ${e?.message}`));
        return;
      }
      if (b.customId === CANCEL) content = 'Cancelled. Nothing changed.';
      else if (!(now() - b.sentAt <= CONFIRM_FOR)) content = 'This confirm expired after 10 minutes. Nothing changed. Type /sage unregister again.';
      else if (!channels.has(id)) content = `<#${id}> is not registered. Nothing changed.`;
      else if (channels.get(id).home) content = `<#${id}> is the home channel of the votes and cards. Only ${us.owner} can change it, at the terminal.`;
      else {
        const { project } = channels.get(id);
        const next = new Map(channels);
        next.delete(id);
        try { saveChannels(channelsPathOf(config), next); channels.delete(id); } catch (e) { // the registry in memory changes only after the save
          say(`the channel registry could not be saved, so ${id} stays registered: ${e?.message}`);
          content = 'I could not unregister this channel just now. Nothing changed. Please try again in a minute.';
        }
        if (!content) {
          say(`the owner ${b.user.name} (${b.user.id}) unregistered the channel ${id} (it was for the project ${project})`);
          content = `<#${id}> is unregistered: ${us.bot} ignores /sage and mentions here now. Only ${us.owner} can register it again.`;
        }
      }
      try { await b.update({ content, components: [], allowedMentions: NO_MENTIONS }); } catch (e) {
        say(`Discord refused the unregister reply: code ${e?.code ?? '-'}: ${e?.message}`);
      }
    },
    /**
     * One message that mentions the bot: `{ id, user: { id, bot }, name, roles, channelId, parentId, content, reply, startThread, post, open,
     * history, replied }`. `parentId` is a thread's parent (or a promise of it); `reply` answers in place; `startThread(name)` opens a public
     * thread from the message and gives its id; `post(place, payload)` posts in a channel or thread; `open(channel, payload, name)` posts a
     * line in a channel and opens a thread from it; `history(before)` and `replied()` read the context (src/outboxFlow.js send).
     * - In a registered channel: opens a thread named from the message (src/threads.js).
     * - In a thread that sage-bot opened: continues it. In any other thread, or a forum post: moves to a new thread of sage-bot (threadFor).
     * - Elsewhere: one pointer to a registered channel per person per UTC day (shared with /sage).
     * In the thread, a read ask gets its answer; any other mention is a message to sage (toOutbox): a crew member's waits for the owner
     * on its approval card, the owner's own is approved at once. The owner's mentions on a side path go into the audit log, and every
     * message to sage does (src/outboxFlow.js). The limit counts each mention in a registered place, or that moves, once; over it, one
     * note until the hour frees up. A bot and anyone but the crew and the owner get nothing, nothing counts and nothing is logged (G20).
     * Never rejects.
     */
    async mention(m) {
      const roles = m.roles ?? [];
      if (m.user?.bot || !SNOWFLAKE.test(m.user?.id ?? '') || !(place(m).crew || place(m).owner)) return;
      m = { ...m, roles };
      const id = m.user.id;
      const lead = place(m).owner;
      const inPlace = async (content) => { try { await m.reply({ content, allowedMentions: QUIET }); } catch (e) { say(`Discord refused a mention reply: code ${e?.code ?? '-'}: ${e?.message}`); } };
      try {
        const where = await placeOfMessage(m);
        if (!where.at && !where.moves) {
          if (lead) record(m, { outcome: 'not-registered' });
          const text = pointer(id, `I answer in ${here()}, so everyone can find the answers. Please ask there.`);
          if (text) await inPlace(text);
          return;
        }
        const project = channels.get(where.at ?? config.channelId)?.project ?? null;
        const next = spend(id);
        if (next) {
          if (lead) record(m, { thread: where.inThread ? m.channelId : null, project, outcome: 'over-limit' });
          if ((warned.get(id) ?? 0) <= now()) { warned.set(id, next); await inPlace(limited(next)); }
          return;
        }
        const ask = readAsk(m.content);
        const refused = ask ? null : outbox ? outbox.full(id) : NOT_ON;
        if (refused) return await inPlace(refused); // before a thread opens for it
        const opened = await threadFor(m, m, where, inPlace);
        if (!opened) return;
        if (!ask) { await toOutbox(m, m, opened, inPlace); return; } // its card or status line is the answer, in the thread
        let payload;
        try {
          if (lead) record(m, { thread: opened.thread, project: opened.t.project, outcome: 'read-ask' });
          payload = await answer({ ...m, ...ask }, opened.t.channel);
        } catch (e) {
          say(`a mention in ${opened.thread}: ${e?.message}`);
          payload = { content: 'I could not record or answer this just now, so nothing went further. Please ask again in a minute.' };
        }
        try { await m.post(opened.thread, { ...payload, content: cut(payload.content, REPLY), allowedMentions: NO_MENTIONS }); } catch (e) {
          say(`Discord refused a mention reply: code ${e?.code ?? '-'}: ${e?.message}`);
          if (NO_RIGHT.has(e?.code)) await inPlace(noRight('Send Messages in Threads', us));
        }
      } catch (e) {
        say(`a mention: ${e?.message}`);
      }
    },
    /**
     * The "Send to sage" message command (T247) on the message `target`: `{ user: { id, bot }, name, roles, channelId, parentId, target:
     * { id, user: { id }, name, roles, bot, webhook, content }, defer, edit, reply, startThread, post, open, history, replied }`, where
     * `startThread`, `history` and `replied` work on the target as the mention's do on the mention. The sender sends the target's text,
     * with its context, as their own message to sage, whoever wrote it; the payload names its writer when that is someone else. The answer
     * is private: notCrew for anyone but the crew and the owner (nothing counts), else a deferred reply that says what happened. The
     * thread is found as for a mention. Never rejects.
     */
    async send(c) {
      if (c.user?.bot || !SNOWFLAKE.test(c.user?.id ?? '')) return;
      const fail = (e) => say(`Discord refused a ${SEND} reply: code ${e?.code ?? '-'}: ${e?.message}`);
      if (!(place(c).crew || place(c).owner)) return void await c.reply(ephemeral(notCrew(us))).catch(fail);
      try { await c.defer({ flags: MessageFlags.Ephemeral }); } catch (e) { fail(e); return; }
      const tell = (content) => c.edit({ content: cut(content, REPLY), allowedMentions: NO_MENTIONS }).catch(fail);
      try {
        const w = c.target;
        if (w.bot || w.webhook) return void await tell(`I send only the messages of people to sage, not of bots or webhooks. Nothing was sent.`);
        const x = { ...w, channelId: c.channelId, startThread: c.startThread, open: c.open, post: c.post, history: c.history, replied: c.replied };
        const where = await placeOfMessage(c);
        if (!where.at && !where.moves) return void await tell(`I take messages to sage in ${here()} and the other channels of ${us.bot}. Nothing was sent.`);
        const next = spend(c.user.id);
        if (next) return void await tell(limited(next));
        const refused = outbox ? outbox.full(c.user.id) : NOT_ON;
        if (refused) return void await tell(refused);
        const opened = await threadFor(x, c, where, tell);
        if (!opened) return;
        const r = await toOutbox(x, c, opened, tell);
        if (r) await tell(r.status === 'pending' ? `Sent to ${us.owner} as ${r.id}. Its card is in <#${opened.thread}>; you can withdraw it there until ${us.owner} decides.`
          : `Recorded as ${r.id} in <#${opened.thread}>. It waits for sage sessions (T159).`);
      } catch (e) {
        say(`${SEND}: ${e?.message}`);
        await tell('I could not do this just now. Nothing was sent. Please try again in a minute.');
      }
    },
  };
}
