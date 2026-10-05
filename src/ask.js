// The read commands of the registered channels (T71, G18 option A; T130): /sage board, task, gates and files, /sage unregister and
// /sage stop (the kill switch, T131) for a sage-lead, and the threads of @sage-bot mentions (T131, src/threads.js): a mention in a
// registered channel opens a thread, and a read ask gets its answer there.
// The bridge answers them itself, with no AI, from the tasks.tsv and gates.tsv of a listed project, read through `pick` (only safe
// columns). It never reads decisions.tsv, findings, briefs or reports. Every reply is public (G20: everyone can see the questions
// and the answers), goes through `safe` (the readers are people on Discord) and pings nobody. A member with neither sage role gets
// nothing. Discord comes in as plain objects (src/discord.js maps the real ones, src/fake-discord.js fakes them).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { cut, NO_MENTIONS, safe, stamp } from './cards.js';
import { forTerminal } from './clean.js';
import { sageTool } from './sage.js';
import { loadProjects, pickProject, TYPES } from './projects.js';
import { channelsPathOf, saveChannels } from './channels.js';
import { loadVotes, votesPathOf } from './state.js';
import { auditPathOf, entryOf, forLead, killPathOf, linkOff, openLog, quoted, setLinkOff } from './audit.js';
import { DRY_RUN, foreign, isTalk, LINK_OFF, loadThreads, noRight, readAsk, saveThreads, threadName, threadsPathOf } from './threads.js';

/** Asks per person in a rolling hour across all channels (G18 D5, G27): every /sage command and every mention of a role holder counts,
 * also a refused one; a mention that opens a thread counts once. A /sage stop of a sage-lead or Erick does not count: the kill switch always works. */
export const ASK_LIMIT = 10;
export const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The files that /sage files may attach: at most this many, of these types only, and at most MAX_BYTES in one reply, so also in one file.
 * 8 MiB stays under Discord's upload limit for a server with no boosts (10 MB a message) with room for the rest of the request. */
export const MAX_FILES = 10;
export const MAX_BYTES = 8 * 1024 * 1024;
const TASK_ID = /^T\d{1,9}$/;
const DONE = new Set(['merged', 'concluded', 'abandoned']);
const SNOWFLAKE = /^\d{17,20}$/;
/** A reply in place pings nobody, also not the person it answers. */
const QUIET = { ...NO_MENTIONS, repliedUser: false };
/** Discord's limit for the text of one message. */
const REPLY = 2000;

export const POINTER = 'I answer read asks here with no AI: mention me with board, gates, files or a task id such as T7, or use /sage. I do not answer free questions yet.';
export const BUILDS = 'Builds are for sage-leads: ask a lead.';
export const LEAD_BUILDS = 'Builds from Discord are not ready yet.';
/**
 * A mention that asks for a build: a sentence that starts with one of these verbs, also after "please" or "can you" (G18 D3). A word
 * list, not a model; the verb must start the sentence, so "any update?", "does that make sense?" and "is the merge done?" are no build.
 */
const BUILD = /(?:^|[.!?\n]\s*)(?:please\s+|(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:add|build|change|create|delete|deploy|fix|implement|make|merge|refactor|remove|rename|update|write)\b/i;
const isBuild = (text) => BUILD.test(String(text ?? '').replace(/<[@#][!&]?\d+>/g, '').trim());
/** The name of an attached file, for the people who download it: only A-Z, a-z, 0-9, dot, dash and underscore; any other character becomes "_". */
export const attachmentName = (name) => name.replace(/[^A-Za-z0-9._-]/gu, '_');

/** The /sage command, for the guild's command list: four subcommands, the project as a choice of the listed projects. */
export function askCommand(projects) {
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
    .addSubcommand((s) => s.setName('unregister').setDescription('Stop sage-bot in this channel (sage-leads only)'))
    .addSubcommand((s) => s.setName('stop').setDescription('Turn off the link from Discord to sage (sage-leads and Erick)'))
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
 * The files of a project that its allow-list names: regular files inside the project, of an allowed type and size, sorted, at most
 * MAX_FILES, each with the device and inode that the check saw. An entry that cannot be checked (a dangling symlink) is left out (F-T71S-2).
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
      if (!st.isFile() || st.size > MAX_BYTES || !real.startsWith(root + sep) || !TYPES.includes(extname(name).slice(1))) continue;
      found.set(real, { path, name: real.slice(root.length + 1), dev: st.dev, ino: st.ino });
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, MAX_FILES);
}

/**
 * Reads the files that `sharedFiles` checked, each through one open file (F-T71S-1): opened with no symlink at the end, it must still be
 * a regular file with the device and inode of the check and at most MAX_BYTES, or it is left out. The files fill one reply up to MAX_BYTES
 * in all, in order; a file that does not fit is in `over`. Only the checked size is read, also when the file grows.
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
      if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino || st.size > MAX_BYTES) continue;
      if (total + st.size > MAX_BYTES) { over.push(f.name); continue; }
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
 * The read commands and the mention threads for one bridge. `config` is the bridge config (apprenticeRole, leadRole, ownerId, project,
 * sagePath, statePath, projects, and optionally auditPath and killPath). `channels` is the channel registry (src/channels.js
 * openChannels); `projects` are the bridge's (src/projects.js loadProjects). A lead's unregister changes it and saves it. `audit` posts a copy of each lead log line to #sage-audit (none: the
 * log only). `env` goes to the sage state tool (the tests give a scratch HOME). Throws for a config that is not safe, and for a
 * thread map or a lead log that is not safe.
 */
export function createAsk({ config, channels, projects = loadProjects(config), now = Date.now, log = (line) => process.stderr.write(`${line}\n`), env, audit }) {
  const threadsPath = threadsPathOf(config);
  const threads = loadThreads(threadsPath); // thread id → { kind, channel, project, by, at }
  const leadLog = openLog(auditPathOf(config), projects);
  const killPath = killPathOf(config);
  const byName = new Map(projects.map((p) => [p.name, { ...p, tool: sageTool({ sagePath: p.sagePath, project: p.project, ...(env && { env }) }) }]));
  const asks = new Map(); // person id → the times of their asks in the last hour; only in memory
  const warned = new Map(); // person id → until when a mention over the limit gets no second note
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

  /** Counts one ask of `id`. Returns null when it may go on, or the time when the next ask works. */
  function spend(id) {
    const t = now();
    const times = (asks.get(id) ?? []).filter((at) => at > t - HOUR);
    if (times.length >= ASK_LIMIT) { asks.set(id, times); return times[0] + HOUR; }
    asks.set(id, [...times, t]);
    return null;
  }
  const limited = (at) => `You asked ${ASK_LIMIT} times in the last hour; that is the limit. Your next ask works at ${stamp(at)}.`;
  const isHolder = (roles) => roles.includes(config.apprenticeRole) || roles.includes(config.leadRole);
  const isLead = (roles) => roles.includes(config.leadRole);
  if (leadLog.broken) say(`the lead log ${auditPathOf(config)} has a break at line ${leadLog.broken.line}: it ${leadLog.broken.why}. New lines chain on from its last line. Run: node scripts/leads.mjs verify`);
  /**
   * The registered channel of a place: the channel, or the parent of a thread (F-T71-5, as `accepts` does for the home channel), as its
   * id; null when neither is registered. `parentId` is a thread's parent, or a promise of it.
   */
  async function registered(channelId, parentId) {
    if (channels.has(channelId)) return channelId;
    const parent = await parentId;
    return channels.has(parent) ? parent : null;
  }
  const teamVotes = () => { // the keys of the team votes of every project (T132)
    try { return loadVotes(votesPathOf(config), pickProject(projects).name); } catch { return new Set(); }
  };

  /** The content (and files) of the answer to one /sage command in the registered channel `at` (or a thread of it). */
  async function answer({ user, roles, sub, options: o }, at) {
    if (sub === 'unregister') return unregisterAsk(roles, at);
    if (sub === 'stop') return stopAsk(user, roles);
    const p = o.project ? byName.get(o.project) : byName.get(channels.get(at).project);
    if (!p) return { content: `I do not know a shared project called "${shown(o.project, 40)}".` };
    if (sub === 'files') {
      const { attached, over } = readShared(sharedFiles(p));
      if (!attached.length && !over.length) return { content: `${p.name} shares no files.` };
      return { content: [`${attached.length} shared file(s) of ${p.name}:`, ...attached.map((f) => `- ${shown(f.name, 200)}`),
        ...(over.length ? [`${over.length} more file(s) not attached: one reply holds at most 8 MB. Ask a lead for them.`, ...over.map((name) => `- ${shown(name, 200)}`)] : [])].join('\n'),
        files: attached.map((f) => ({ attachment: f.data, name: attachmentName(basename(f.name)) })) };
    }
    let data;
    try { data = await pick(p.tool); } catch (e) {
      say(`/sage ${sub}: the logbook of ${p.name} could not be read: ${e?.message}`);
      return { content: `I could not read the records of ${p.name} just now. Nothing is lost. Please ask again in a minute.` };
    }
    if (sub === 'board') return { content: board(p, data) };
    if (sub === 'gates') return { content: gates(p, data) };
    if (sub === 'task') return { content: task(p, data, String(o.id ?? '').trim().toUpperCase()) };
    return { content: POINTER };
  }

  /** The answer to /sage unregister: a confirm button for a sage-lead, a refusal for anyone else and for the home channel. */
  function unregisterAsk(roles, at) {
    if (!roles.includes(config.leadRole)) return { content: 'Only a sage-lead can unregister a channel. Ask a lead.' };
    if (channels.get(at).home) return { content: `<#${at}> is the home channel of the votes and cards. Only Erick can change it, at the terminal.` };
    return { content: `Unregister <#${at}>? sage-bot then ignores /sage and mentions here and in its threads. Only Erick can register it again, at the terminal.`,
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Unregister this channel', custom_id: `${UNREGISTER}${at}` },
        { type: 2, style: 2, label: 'Cancel', custom_id: CANCEL }] }] };
  }

  /** The answer to /sage stop: a confirm button for a sage-lead or Erick, a refusal for anyone else. */
  function stopAsk(user, roles) {
    if (!isLead(roles) && user.id !== config.ownerId) return { content: 'Only a sage-lead or Erick can turn off the link from Discord to sage. Ask a lead.' };
    if (linkOff(killPath)) return { content: 'The link from Discord to sage is already off. Only Erick can turn it on again, at the terminal.' };
    return { content: 'Turn off the link from Discord to sage? Then nothing of a lead goes to sage until Erick turns it on again at the terminal. Read asks keep working.',
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Turn off the link', custom_id: STOP }, { type: 2, style: 2, label: 'Cancel', custom_id: STOP_CANCEL }] }] };
  }

  /**
   * Writes one line of the lead log for a message (or a /sage stop), then posts its copy to #sage-audit, which pings nobody. A lead's
   * text goes in cleaned by forLead; an apprentice's as quoted data. Throws when the log cannot be written: then nothing goes further.
   */
  function record(m, { thread = null, project = null, outcome }) {
    const raw = m.content ?? '';
    const line = leadLog.append(entryOf({ at: now(), message: m.id ?? null, author: m.user.id, roles: m.roles ?? [], raw,
      text: isLead(m.roles ?? []) ? forLead(raw) : quoted(raw), thread, project, outcome }));
    const copy = [`**Lead log** · ${stamp(Date.parse(line.at), 'f')} · <@${line.author}> · ${outcome}${thread ? ` · <#${thread}>` : ''} · ${line.hash.slice(0, 12)}`,
      shown(line.text, 1500)].join('\n');
    audit?.({ content: copy, allowedMentions: NO_MENTIONS }).catch((e) => say(`Discord refused the #sage-audit copy: code ${e?.code ?? '-'}: ${e?.message}`));
    return line;
  }

  /** Saves the thread map after a change to the thread `thread`; a failure only loses the change at the next restart. */
  function keep(thread) {
    try { saveThreads(threadsPath, threads); } catch (e) { say(`the thread map could not be saved, so the last change to ${thread} lasts only until the next restart: ${e?.message}`); }
  }

  /**
   * The reply to a mention in a thread of sage-bot: `t` is its entry in the thread map. A lead's talk, and every message in a lead
   * thread, would go to sage: it is logged (an apprentice's as quoted data) and gets the dry-run reply, or the fixed reply while the
   * kill switch is set. A lead's talk in an answer thread first turns it into a lead thread and logs its held apprentice mentions,
   * in order, as quoted data (G27). No session starts here (T131 is a dry run). Any other mention is a read ask; a lead's is logged
   * too, and an apprentice's in an answer thread is held in the thread map.
   */
  async function inThread(m, t, thread) {
    const lead = isLead(m.roles);
    if (t.kind === 'lead' || (lead && isTalk(m.content))) {
      const off = linkOff(killPath); // checked before each would-be delivery; a flag that cannot be checked counts as set
      if (t.kind === 'answer') { // a lead's talk turns an answer thread into a lead thread; its apprentices' text goes first, as quoted data (G27)
        // Safe to repeat (F-T131-13): a held mention that the log already holds (a failed save of the thread map, then a restart) is not logged again.
        for (const h of t.held) if (!leadLog.has(h.id)) record({ ...h, user: { id: h.user } }, { thread, project: t.project, outcome: 'earlier' });
        delete t.held;
        t.kind = 'lead';
        keep(thread);
      }
      record(m, { thread, project: t.project, outcome: off ? 'link-off' : 'dry-run' });
      return { content: off ? LINK_OFF : DRY_RUN };
    }
    if (lead) record(m, { thread, project: t.project, outcome: 'read-ask' });
    else { t.held.push({ id: m.id, user: m.user.id, roles: m.roles, content: m.content ?? '' }); keep(thread); }
    const ask = readAsk(m.content);
    if (ask) return answer({ ...m, ...ask }, t.channel);
    return { content: isBuild(m.content) ? `${POINTER} ${lead ? LEAD_BUILDS : BUILDS}` : POINTER };
  }

  /**
   * A press of the /sage stop confirm: a sage-lead or Erick sets the kill switch; Cancel, or a confirm older than CONFIRM_FOR (or of no
   * known time), changes nothing and closes the confirm (F-T131-2), so an old confirm cannot set the flag again after Erick's restore.
   * Anyone else changes nothing.
   */
  async function stopPress(b, roles) {
    const fail = (e) => say(`Discord refused the stop reply: code ${e?.code ?? '-'}: ${e?.message}`);
    if (!isLead(roles) && b.user.id !== config.ownerId) {
      await b.reply({ content: 'Only a sage-lead or Erick can turn off the link from Discord to sage. Nothing changed.', allowedMentions: NO_MENTIONS }).catch(fail);
      return;
    }
    let content;
    if (b.customId === STOP_CANCEL) content = 'Cancelled. Nothing changed.';
    else if (!(now() - b.sentAt <= CONFIRM_FOR)) content = 'This confirm expired after 10 minutes. Nothing changed. Type /sage stop again.';
    else try {
      setLinkOff(killPath, b.user.id, now());
      say(`${b.user.id} turned off the link from Discord to sage (the kill switch ${killPath}). Turn it on again with: node scripts/leads.mjs restore`);
      content = `<@${b.user.id}> turned off the link from Discord to sage. Nothing of a lead goes to sage until Erick turns it on again at the terminal. Read asks keep working.`;
      try { record({ ...b, roles, content: '/sage stop' }, { outcome: 'link-off-set' }); } catch (e) { say(`the lead log could not record the stop: ${e?.message}`); }
    } catch (e) {
      say(`the kill switch ${killPath} could not be set: ${e?.message}`);
      content = 'I could not turn off the link just now. Ask Erick to turn it off at the terminal with: node scripts/leads.mjs stop';
    }
    await b.update({ content, components: [], allowedMentions: NO_MENTIONS }).catch(fail);
  }

  function board(p, { tasks, open }) {
    const count = new Map();
    for (const t of tasks) count.set(t.state, (count.get(t.state) ?? 0) + 1);
    const left = tasks.filter((t) => !DONE.has(t.state)).length;
    return fitted([`**Board · ${p.name}**`,
      `${tasks.length} task(s)${[...count].map(([s, n]) => ` · ${shown(s, 20)} ${n}`).join('')}`,
      `${left} task(s) left. Time left is not estimated yet: the project's records have no estimate.`,
      `${open.length} open question(s)${open.length ? ':' : '.'}`], open, (g) => question(g));
  }
  function gates(p, { open }) {
    if (!open.length) return `${p.name} has no open questions.`;
    const votes = teamVotes();
    return fitted([`**Open questions · ${p.name}** (${open.length})`], open, (g) => [...question(g, votes.has(`${p.name}/${g.id}`) ? 'team vote' : 'answered at the terminal'), ...advice(g)]);
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
     * One /sage command: `{ user: { id, bot }, roles, channelId, parentId, sub, options: { project, id }, defer, edit }`. A bot and a
     * member with neither sage role get nothing, and nothing counts (G20). Every other ask is first deferred in public, before any file
     * or logbook work (F-T71-2), then gets its answer as an edit of that reply, which pings nobody. Never rejects.
     */
    async command(i) {
      if (i.user?.bot || !SNOWFLAKE.test(i.user?.id ?? '') || !(isHolder(i.roles ?? []) || i.user.id === config.ownerId)) return;
      try { await i.defer({}); } catch (e) {
        say(`Discord refused to defer a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`);
        return;
      }
      let payload;
      try {
        // The kill switch always works (F-T131-3): a /sage stop of a sage-lead or Erick skips the limit and works in any channel.
        const stop = i.sub === 'stop' && (isLead(i.roles ?? []) || i.user.id === config.ownerId);
        const at = stop ? null : await registered(i.channelId, i.parentId);
        const text = stop || at ? null : pointer(i.user.id, `I answer /sage in ${here()}, so please ask there.`);
        if (!stop && !at && !text) { // ignored: the deferred reply goes again, so nothing stays in the channel
          await i.remove().catch((e) => say(`Discord refused to remove a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`));
          return;
        }
        const next = at && spend(i.user.id);
        payload = stop ? stopAsk(i.user, i.roles) : !at ? { content: text } : next ? { content: limited(next) } : await answer(i, at);
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
     * update, reply }`, where `sentAt` is when Discord made the confirm. STOP and STOP_CANCEL go to the kill switch (stopPress). A sage-lead's press of
     * the unregister confirm removes the channel from the registry, saves it, logs it at the terminal with the lead's name and id, and
     * replaces the confirm with the result; Cancel, or a confirm older than CONFIRM_FOR, changes nothing and closes the confirm. An
     * apprentice's press changes nothing and gets a reply of its own, so the lead's confirm stays. A member with neither sage role, and a
     * custom_id that is not STOP, STOP_CANCEL, CANCEL or a channel id, get nothing. Never rejects.
     */
    async press(b) {
      const roles = b.roles ?? [];
      if (b.user?.bot || !SNOWFLAKE.test(b.user?.id ?? '') || !(isHolder(roles) || b.user.id === config.ownerId)) return;
      if (b.customId === STOP || b.customId === STOP_CANCEL) return stopPress(b, roles);
      const id = String(b.customId).slice(UNREGISTER.length);
      if (b.customId !== CANCEL && !SNOWFLAKE.test(id)) return;
      let content;
      if (!roles.includes(config.leadRole)) {
        await b.reply({ content: 'Only a sage-lead can unregister a channel. Nothing changed.', allowedMentions: NO_MENTIONS })
          .catch((e) => say(`Discord refused the unregister reply: code ${e?.code ?? '-'}: ${e?.message}`));
        return;
      }
      if (b.customId === CANCEL) content = 'Cancelled. Nothing changed.';
      else if (!(now() - b.sentAt <= CONFIRM_FOR)) content = 'This confirm expired after 10 minutes. Nothing changed. Type /sage unregister again.';
      else if (!channels.has(id)) content = `<#${id}> is not registered. Nothing changed.`;
      else if (channels.get(id).home) content = `<#${id}> is the home channel of the votes and cards. Only Erick can change it, at the terminal.`;
      else {
        const { project } = channels.get(id);
        const next = new Map(channels);
        next.delete(id);
        try { saveChannels(channelsPathOf(config), next); channels.delete(id); } catch (e) { // the registry in memory changes only after the save
          say(`the channel registry could not be saved, so ${id} stays registered: ${e?.message}`);
          content = 'I could not unregister this channel just now. Nothing changed. Please try again in a minute.';
        }
        if (!content) {
          say(`the sage-lead ${b.user.name} (${b.user.id}) unregistered the channel ${id} (it was for the project ${project})`);
          content = `<#${id}> is unregistered: sage-bot ignores /sage and mentions here now. Only Erick can register it again.`;
        }
      }
      try { await b.update({ content, components: [], allowedMentions: NO_MENTIONS }); } catch (e) {
        say(`Discord refused the unregister reply: code ${e?.code ?? '-'}: ${e?.message}`);
      }
    },
    /**
     * One message that mentions the bot: `{ id, user: { id, bot }, roles, channelId, parentId, forum, content, reply, startThread, post }`.
     * `parentId` is a thread's parent (or a promise of it), `forum` whether that parent is a forum; `reply` answers in place,
     * `startThread(name)` opens a public thread from the message and gives its id, `post(thread, payload)` posts in a thread.
     * - In a registered channel: opens a thread named from the request, and answers there (src/threads.js). A lead's talk opens a lead thread.
     * - In a thread that sage-bot opened: continues it. In another thread of a registered channel, or a forum post: one pointer in place.
     * - Elsewhere: one pointer to a registered channel per person per UTC day (shared with /sage).
     * Every message of a sage-lead, and of an apprentice in a lead thread, goes into the lead log first. The limit counts each mention
     * in a registered place once; over it, one note until the hour frees up. A bot and a member with neither sage role get nothing,
     * nothing counts and nothing is logged (G20). Never rejects.
     */
    async mention(m) {
      const roles = m.roles ?? [];
      if (m.user?.bot || !SNOWFLAKE.test(m.user?.id ?? '') || !isHolder(roles)) return;
      m = { ...m, roles };
      const id = m.user.id;
      const lead = isLead(roles);
      const where = async (target, payload, inPlace) => {
        try { await (inPlace ? m.reply(payload) : m.post(target, payload)); } catch (e) {
          say(`Discord refused a mention reply: code ${e?.code ?? '-'}: ${e?.message}`);
          if (!inPlace && NO_RIGHT.has(e?.code)) await where(null, { content: noRight('Send Messages in Threads'), allowedMentions: QUIET }, true);
        }
      };
      try {
        const parent = channels.has(m.channelId) ? null : await m.parentId;
        const at = parent === null ? (channels.has(m.channelId) ? m.channelId : null) : (channels.has(parent) ? parent : null);
        const project = at && channels.get(at).project;
        if (!at) {
          if (lead) record(m, { outcome: 'not-registered' });
          const text = pointer(id, `I answer in ${here()}, so everyone can find the answers. Please ask there.`);
          if (text) await where(null, { content: text, allowedMentions: QUIET }, true);
          return;
        }
        const next = spend(id);
        if (next) {
          if (lead) record(m, { thread: parent && m.channelId, project, outcome: 'over-limit' });
          if ((warned.get(id) ?? 0) <= now()) { warned.set(id, next); await where(null, { content: limited(next), allowedMentions: QUIET }, true); }
          return;
        }
        let thread = parent && m.channelId;
        let t = thread && threads.get(thread);
        if (thread && !t) { // a thread that sage-bot did not open, or a forum post
          if (lead) record(m, { thread, project, outcome: 'not-my-thread' });
          await where(null, { content: foreign(await m.forum ? channels.keys().next().value : at), allowedMentions: QUIET }, true);
          return;
        }
        if (!thread) {
          try { thread = await m.startThread(threadName(m.content)); } catch (e) {
            say(`Discord refused to open a thread for a mention in ${at}: code ${e?.code ?? '-'}: ${e?.message}`);
            if (lead) record(m, { project, outcome: NO_RIGHT.has(e?.code) ? 'no-thread-right' : 'no-thread' });
            await where(null, { content: NO_RIGHT.has(e?.code) ? noRight('Create Public Threads') : 'I could not open a thread just now. Nothing changed. Please ask again in a minute.', allowedMentions: QUIET }, true);
            return;
          }
          t = lead && isTalk(m.content) ? { kind: 'lead', channel: at, project, by: id, at: now() } : { kind: 'answer', channel: at, project, by: id, at: now(), held: [] };
          threads.set(thread, t);
          keep(thread);
        }
        let payload;
        try { payload = await inThread(m, t, thread); } catch (e) {
          say(`a mention in ${thread}: ${e?.message}`);
          payload = { content: 'I could not record or answer this just now, so nothing went further. Please ask again in a minute.' };
        }
        await where(thread, { ...payload, content: cut(payload.content, REPLY), allowedMentions: NO_MENTIONS }, false);
      } catch (e) {
        say(`a mention: ${e?.message}`);
      }
    },
  };
}
