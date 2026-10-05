// The read commands of #ask-sage (T71, G18 option A): /sage board, task, gates and files, and one pointer for an @sage-bot mention.
// The bridge answers them itself, with no AI, from the tasks.tsv and gates.tsv of a listed project, read through `pick` (only safe
// columns). It never reads decisions.tsv, findings, briefs or reports. Every reply goes through `safe` (the readers are people on
// Discord) and pings nobody. Discord comes in as plain objects (src/discord.js maps the real ones, src/fake-discord.js fakes them).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { MessageFlags, SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { cut, NO_MENTIONS, safe, stamp } from './cards.js';
import { forTerminal } from './clean.js';
import { sageTool } from './sage.js';
import { loadVotes, votesPathOf } from './state.js';

/** Asks per person in a rolling hour (G18 D5); every ask counts, also a refused one. */
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

export const NO_ROLE = 'Only people with the sage-apprentice or sage-lead role can use /sage. You can still read the channels.';
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
    .toJSON();
}

/** Only the safe columns of the logbook: no recommendation, no default, no answer text, no branch, no findings, never decisions. */
async function pick(tool) {
  const [tasks, gates] = await Promise.all([tool.tasks(), tool.gates()]);
  return {
    tasks: tasks.map(({ id, title, size, state, pr }) => ({ id, title, size, state, pr })),
    open: gates.filter((g) => !g.answer).map(({ id, task, question, options }) => ({ id, task, question, options })),
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

/**
 * The read commands for one bridge. `config` is the bridge config (askChannelId, apprenticeRole, leadRole, project, sagePath, statePath,
 * projects). `env` goes to the sage state tool (the tests give a scratch HOME). Throws a TypeError for a config that is not safe.
 */
export function createAsk({ config, now = Date.now, log = (line) => process.stderr.write(`${line}\n`), env }) {
  if (!SNOWFLAKE.test(config.askChannelId ?? '')) throw new TypeError('the config needs askChannelId as a Discord id (17 to 20 digits): the id of #ask-sage');
  const projects = projectsOf(config);
  const byName = new Map(projects.map((p) => [p.name, { ...p, tool: sageTool({ sagePath: p.sagePath, project: p.project, ...(env && { env }) }) }]));
  const asks = new Map(); // person id → the times of their asks in the last hour; only in memory
  const warned = new Map(); // person id → until when a mention over the limit gets no second note
  const daily = new Map(); // person id → the UTC day of their last pointer outside #ask-sage
  const say = (line) => log(forTerminal(line));
  const here = `<#${config.askChannelId}>`;

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
  /** #ask-sage, or a thread of it (F-T71-5, as `accepts` does for the bridge channel). `parentId` is a thread's parent, or a promise of it. */
  const inAsk = async (channelId, parentId) => channelId === config.askChannelId || (await parentId) === config.askChannelId;
  const teamVotes = (p) => {
    if (p.project !== config.project) return new Set();
    try { return loadVotes(votesPathOf(config)); } catch { return new Set(); }
  };

  /** The content (and files) of the answer to one /sage command. */
  async function answer({ user, roles, channelId, parentId, sub, options: o }) {
    const next = spend(user.id);
    if (!isHolder(roles)) return { content: NO_ROLE }; // also over the limit: a member with no role can never use /sage (F-T71Q-3)
    if (next) return { content: limited(next) };
    if (!await inAsk(channelId, parentId)) return { content: `I answer /sage in ${here}, so please ask there.` };
    const p = o.project ? byName.get(o.project) : byName.get(projects[0].name);
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

  function board(p, { tasks, open }) {
    const count = new Map();
    for (const t of tasks) count.set(t.state, (count.get(t.state) ?? 0) + 1);
    const left = tasks.filter((t) => !DONE.has(t.state)).length;
    return [`**Board · ${p.name}**`,
      `${tasks.length} task(s)${[...count].map(([s, n]) => ` · ${shown(s, 20)} ${n}`).join('')}`,
      `${left} task(s) left. Time left is not estimated yet: the project's records have no estimate.`,
      `${open.length} open question(s)${open.length ? ':' : '.'}`,
      ...open.map((g) => `- ${shown(g.id, 12)} (${shown(g.task, 12)}): ${shown(g.question, 200)}`)].join('\n');
  }
  function gates(p, { open }) {
    if (!open.length) return `${p.name} has no open questions.`;
    const votes = teamVotes(p);
    return [`**Open questions · ${p.name}** (${open.length})`, ...open.flatMap((g) => [
      `- ${shown(g.id, 12)} (${shown(g.task, 12)}), ${votes.has(g.id) ? 'team vote' : 'answered at the terminal'}: ${shown(g.question, 300)}`,
      `  ${options(g.options)}`])].join('\n');
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
     * One /sage command: `{ user: { id, bot }, roles, channelId, parentId, sub, options: { project, id }, defer, edit }`. A bot gets
     * nothing. Every other ask is first deferred in private, before any file or logbook work (F-T71-2), then gets its answer as an
     * edit of that reply, which pings nobody. Never rejects.
     */
    async command(i) {
      if (i.user?.bot || !SNOWFLAKE.test(i.user?.id ?? '')) return;
      try { await i.defer({ flags: MessageFlags.Ephemeral }); } catch (e) {
        say(`Discord refused to defer a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`);
        return;
      }
      let payload;
      try { payload = await answer(i); } catch (e) {
        say(`/sage ${i.sub}: ${e?.message}`);
        payload = { content: 'I could not answer just now. Nothing changed. Please ask again in a minute.' };
      }
      try { await i.edit({ ...payload, content: cut(payload.content, 2000), allowedMentions: NO_MENTIONS }); } catch (e) {
        say(`Discord refused a /sage reply: code ${e?.code ?? '-'}: ${e?.message}`);
      }
    },
    /**
     * One message that mentions the bot: `{ user: { id, bot }, roles, channelId, parentId, content, reply }`. In #ask-sage or a thread
     * of it: one public reply in place with the pointer (and a build line for a build: for a lead, that builds are not ready), counted
     * like a command; over the limit, one note until the hour frees up (the role note for a member with no role). Elsewhere: one
     * pointer to #ask-sage per person per UTC day. A bot gets nothing. Never rejects.
     */
    async mention(m) {
      if (m.user?.bot || !SNOWFLAKE.test(m.user?.id ?? '')) return;
      const id = m.user.id;
      const roles = m.roles ?? [];
      let content = null;
      if (!await inAsk(m.channelId, m.parentId)) {
        const day = Math.floor(now() / DAY);
        if (daily.get(id) !== day) { daily.set(id, day); content = `I answer in ${here}, so everyone can find the answers. Please ask there.`; }
      } else {
        const next = spend(id);
        if (!next) content = isBuild(m.content) ? `${POINTER} ${roles.includes(config.leadRole) ? LEAD_BUILDS : BUILDS}` : POINTER;
        else if ((warned.get(id) ?? 0) <= now()) { warned.set(id, next); content = isHolder(roles) ? limited(next) : NO_ROLE; }
      }
      if (!content) return;
      try { await m.reply({ content, allowedMentions: { ...NO_MENTIONS, repliedUser: false } }); } catch (e) {
        say(`Discord refused a mention reply: code ${e?.code ?? '-'}: ${e?.message}`);
      }
    },
  };
}
