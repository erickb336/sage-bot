// The read commands of the registered channels (T71, G18 option A; T130): /sage board, task, gates and files, one pointer for an
// @sage-bot mention, and /sage unregister for a sage-lead.
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
import { channelsPathOf, saveChannels } from './channels.js';
import { loadVotes, votesPathOf } from './state.js';

/** Asks per person in a rolling hour (G18 D5); every ask of a role holder counts, also a refused one. */
export const ASK_LIMIT = 10;
export const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The files that /sage files may attach: at most this many, of these types only, and at most MAX_BYTES in one reply, so also in one file.
 * 8 MiB stays under Discord's upload limit for a server with no boosts (10 MB a message) with room for the rest of the request. */
export const MAX_FILES = 10;
export const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = ['png', 'jpg', 'svg', 'pdf'];
/** A project name: also the value of the slash command's project choice. */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** One allow-listed file or glob, relative to the project: folders and a file name of safe characters, `*` only in the file name. */
const DIR_PART = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const FILE_PART = new RegExp(`^[A-Za-z0-9_*-][A-Za-z0-9_.*-]*\\.(?:${TYPES.join('|')})$`);
/** A GitHub repository, for the link of a pull request. */
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const TASK_ID = /^T\d{1,9}$/;
const DONE = new Set(['merged', 'concluded', 'abandoned']);
const SNOWFLAKE = /^\d{17,20}$/;
/** Discord's limit for the text of one message. */
const REPLY = 2000;

export const POINTER = "I do not answer free questions yet. Use /sage board, task, gates or files to read the project's records, or ask a lead.";
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

/**
 * The projects that /sage reads, from the config: `projects`, or else the bridge's own project with no files. Throws a TypeError that
 * names the field for a config that is not safe: a name that is not lower-case letters, digits and dashes, a path that is not absolute,
 * a file entry that leaves the project or is not a .png, .jpg, .svg or .pdf.
 * @returns {{ name: string, project: string, sagePath: string, files: string[], repo?: string }[]}
 */
export function projectsOf(config) {
  const fallback = config.projects === undefined;
  if (fallback) {
    // No projects: the bridge's own project, named after its folder. A folder name that makes no valid name says what to add (F-T71Q-5).
    if (typeof config.project !== 'string' || !isAbsolute(config.project)) throw new TypeError('the config: project must be an absolute path');
    const folder = basename(config.project);
    const name = folder.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!NAME.test(name)) {
      throw new TypeError(`the config has no projects, and the folder name of project (${JSON.stringify(forTerminal(folder))}) makes no valid project name: add a projects entry with a name of lower-case letters, digits and dashes (at most 32)`);
    }
    config = { ...config, projects: [{ name, project: config.project, files: [] }] };
  }
  const list = config.projects;
  if (!Array.isArray(list) || list.length < 1 || list.length > 25) throw new TypeError('the config needs projects as a list of 1 to 25 projects');
  const names = new Set();
  return list.map((p, n) => {
    const at = fallback ? 'the config: ' : `projects[${n}].`; // with no projects, a message names the field that the owner wrote
    const sagePath = p.sagePath ?? config.sagePath;
    if (!NAME.test(p.name ?? '') || names.has(p.name)) throw new TypeError(`${at}name must be a new name of lower-case letters, digits and dashes (at most 32)`);
    names.add(p.name);
    for (const [key, path] of [['project', p.project], ['sagePath', sagePath]]) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`${at}${key} must be an absolute path`);
    }
    const files = p.files ?? [];
    if (!Array.isArray(files)) throw new TypeError(`${at}files must be a list`);
    for (const f of files) {
      const parts = String(f).split('/');
      if (typeof f !== 'string' || !parts.slice(0, -1).every((d) => DIR_PART.test(d) && !d.includes('*')) || !FILE_PART.test(parts.at(-1))) {
        throw new TypeError(`${at}files: ${JSON.stringify(f)} must be a path in the project, such as "docs/*.svg", with no "..", and end in .${TYPES.join(', .')}`);
      }
    }
    if (p.repo !== undefined && !REPO.test(p.repo)) throw new TypeError(`${at}repo must be https://github.com/<owner>/<name>`);
    return { name: p.name, project: p.project, sagePath, files, ...(p.repo && { repo: p.repo }) };
  });
}

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
/** How long the confirm of /sage unregister works after Discord made it. */
export const CONFIRM_FOR = 10 * 60_000;

/**
 * The read commands for one bridge. `config` is the bridge config (apprenticeRole, leadRole, project, sagePath, statePath, projects).
 * `channels` is the channel registry (src/channels.js openChannels); a lead's unregister changes it and saves it. `env` goes to the
 * sage state tool (the tests give a scratch HOME). Throws a TypeError for a config that is not safe.
 */
export function createAsk({ config, channels, now = Date.now, log = (line) => process.stderr.write(`${line}\n`), env }) {
  const projects = projectsOf(config);
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
  /**
   * The registered channel of a place: the channel, or the parent of a thread (F-T71-5, as `accepts` does for the home channel), as its
   * id; null when neither is registered. `parentId` is a thread's parent, or a promise of it.
   */
  async function registered(channelId, parentId) {
    if (channels.has(channelId)) return channelId;
    const parent = await parentId;
    return channels.has(parent) ? parent : null;
  }
  const teamVotes = (p) => {
    if (p.project !== config.project) return new Set();
    try { return loadVotes(votesPathOf(config)); } catch { return new Set(); }
  };

  /** The content (and files) of the answer to one /sage command in the registered channel `at` (or a thread of it). */
  async function answer({ user, roles, sub, options: o }, at) {
    const next = spend(user.id);
    if (next) return { content: limited(next) };
    if (sub === 'unregister') return unregisterAsk(roles, at);
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
    const votes = teamVotes(p);
    return fitted([`**Open questions · ${p.name}** (${open.length})`], open, (g) => [...question(g, votes.has(g.id) ? 'team vote' : 'answered at the terminal'), ...advice(g)]);
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
      if (i.user?.bot || !SNOWFLAKE.test(i.user?.id ?? '') || !isHolder(i.roles ?? [])) return;
      try { await i.defer({}); } catch (e) {
        say(`Discord refused to defer a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`);
        return;
      }
      let payload;
      try {
        const at = await registered(i.channelId, i.parentId);
        const text = at ? null : pointer(i.user.id, `I answer /sage in ${here()}, so please ask there.`);
        if (!at && !text) { // ignored: the deferred reply goes again, so nothing stays in the channel
          await i.remove().catch((e) => say(`Discord refused to remove a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`));
          return;
        }
        payload = at ? await answer(i, at) : { content: text };
      } catch (e) {
        say(`/sage ${i.sub}: ${e?.message}`);
        payload = { content: 'I could not answer just now. Nothing changed. Please ask again in a minute.' };
      }
      try { await i.edit({ ...payload, content: cut(payload.content, REPLY), allowedMentions: NO_MENTIONS }); } catch (e) {
        say(`Discord refused a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`);
      }
    },
    /**
     * A press of a button of the /sage unregister confirm: `{ user: { id, name, bot }, roles, customId, sentAt, update, reply }`, where
     * `sentAt` is when Discord made the confirm. A sage-lead's press of the confirm removes the channel from the registry, saves it, logs
     * it at the terminal with the lead's name and id, and replaces the confirm with the result; Cancel, or a confirm older than
     * CONFIRM_FOR, changes nothing and closes the confirm. An apprentice's press changes nothing and gets a reply of its own, so the
     * lead's confirm stays. A member with neither sage role, and a custom_id that is not CANCEL or a channel id, get nothing. Never rejects.
     */
    async press(b) {
      const roles = b.roles ?? [];
      if (b.user?.bot || !SNOWFLAKE.test(b.user?.id ?? '') || !isHolder(roles)) return;
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
     * One message that mentions the bot: `{ user: { id, bot }, roles, channelId, parentId, content, reply }`. In a registered channel or a thread
     * of it: one public reply in place with the pointer (and a build line for a build: for a lead, that builds are not ready), counted
     * like a command; over the limit, one note until the hour frees up. Elsewhere: one pointer to a registered channel per person per UTC day (shared with /sage).
     * A bot and a member with neither sage role get nothing, and nothing counts (G20). Never rejects.
     */
    async mention(m) {
      const roles = m.roles ?? [];
      if (m.user?.bot || !SNOWFLAKE.test(m.user?.id ?? '') || !isHolder(roles)) return;
      const id = m.user.id;
      let content = null;
      if (!await registered(m.channelId, m.parentId)) {
        content = pointer(id, `I answer in ${here()}, so everyone can find the answers. Please ask there.`);
      } else {
        const next = spend(id);
        if (!next) content = isBuild(m.content) ? `${POINTER} ${roles.includes(config.leadRole) ? LEAD_BUILDS : BUILDS}` : POINTER;
        else if ((warned.get(id) ?? 0) <= now()) { warned.set(id, next); content = limited(next); }
      }
      if (!content) return;
      try { await m.reply({ content, allowedMentions: { ...NO_MENTIONS, repliedUser: false } }); } catch (e) {
        say(`Discord refused a mention reply: code ${e?.code ?? '-'}: ${e?.message}`);
      }
    },
  };
}
