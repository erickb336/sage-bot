// The sage bridge (B3): it reads the open gates of a sage logbook, posts them as cards, turns presses into vote events,
// and gives each final answer back to sage with `sage gate answer`. It also reminds, alerts the role and asks for a new
// press after the Mac slept. Discord comes in as a port (`post`, `edit`, `startThread`, `setLocked`, `members`): the real one is
// src/discord.js, the tests use src/fake-discord.js. Each chief session that has a team vote gets one line in the parent channel and
// one thread, started from that line; the cards go to the thread of their session, and every post about a card goes where the card is (T29, src/sessions.js). It posts only the gates that the chief marked as team votes (G13, src/state.js loadVotes). Every event time comes from the bridge's own clock, never from Discord (F-T28-2).
import { card, cut, ephemeral, NO_MENTIONS, parseCustomId, safe, settled, stamp, LEAD } from './cards.js';
import { forTerminal } from './clean.js';
import { handle, peopleOf } from './handle.js';
import { lineOf, readSpools, runs, sessionOf, sessionsPathOf, titleOf } from './sessions.js';
import { alive, leadsPathOf, load, loadLeads, loadVotes, save, votesPathOf } from './state.js';
import { MAX_OPTIONS, MINUTE, nextReminderAt, openGate, step } from './vote.js';

/** A Discord id: only these go into an event's `by` (F-T28-6). */
export const SNOWFLAKE = /^\d{17,20}$/;
/**
 * Stops a config of the time before T70 (two roles): it has the old role field and no apprenticeRole.
 * The bridge and scripts/launchd.mjs both call it, so the owner reads the same message from each.
 */
export function refuseOldRoles(config) {
  if (config?.driverRole !== undefined && config.apprenticeRole === undefined) {
    throw new Error('the config has driverRole: sage-driver is gone. Rename driverRole to apprenticeRole and give that role id to the sage-apprentice role.');
  }
}
/** The bridge looks at the clock, the logbook and the timers this often. */
export const LOOP = 15_000;
/** A gap between two loops longer than this means that the Mac slept. */
export const SLEPT = LOOP + MINUTE;
/** The open gates of one task, as they come with `sage gate add`, wait this long for the next one, so that a batch comes as one card. */
export const SETTLE = 30_000;
/** The gates of one task whose `at` (sage's time of `gate add`) are at most this far from the first one go on one card (G9, F-T28-29). */
export const ASKED_TOGETHER = 30_000;
/** A question about a merge in any form: merges never go to a vote, also when the chief marked one (F-T28-28, a second guard to G13). */
export const MERGE = /\bmerg(?:e|es|ed|ing)\b/i;
/** A card holds 5 rows of buttons, and a batch uses one row per part and one for "End vote now" (F-T28-19). */
export const MAX_PARTS = 4;
const KEYS = ['A', 'B', 'C', 'D', 'E'];

/** Discord's codes for a channel or thread that is gone or that the bot cannot see: Unknown Channel and Missing Access (F-T29-9). */
const GONE = new Set([10003, 50001]);
/** Discord's code for a message that is gone: Unknown Message. */
const UNKNOWN_MESSAGE = 10008;
/** Only the code, status and message of a Discord error: its url and body can hold the interaction token (F-T28-23). */
export const apiError = (e) => `code ${e?.code ?? '-'}, status ${e?.status ?? '-'}: ${e?.message ?? String(e)}`;
/** Untrusted text for a card: cut first, so that `safe` never works on a long input (F-T28-24), then made safe; '' falls back. */
const shown = (text, max, fallback = '') => safe(cut(String(text), max)) || fallback;
/** A member's name for the bridge's own messages: cut, made safe, then cut again to 32, so an escape never makes it longer (F-T28-21). */
const nameOf = (id, names) => cut(shown(names.get(id) ?? '', 100), 32) || 'a member';
/** A clock that never goes back: the wall clock (it runs on while the Mac sleeps), never earlier than its last value. */
export function monotonic(now, floor = 0) {
  let last = floor;
  return () => (last = Math.max(last, now()));
}

/**
 * The ask and the gate of a group of sage gate rows of one task: one row is a single question, 2 to 4 rows a batch.
 * Returns { refused } for a group that cannot be a card: more than 4 parts, or a question without 1 to 5 options.
 * With `leads` (T73) the one row is a leads-only question: its options must be Yes and No, so that every text that the bridge writes
 * about its answer comes from that allow-list.
 */
export function frame(rows, title, ownerId, at, leads = false) {
  if (rows.length > MAX_PARTS) return { refused: `${rows[0].task} asked ${rows.length} questions together, and a batch holds at most ${MAX_PARTS} parts` };
  const texts = rows.map((r) => r.options.split('|').map((o) => o.trim()).filter(Boolean));
  const bad = rows.find((r, i) => texts[i].length === 0 || texts[i].length > MAX_OPTIONS || new Set(texts[i]).size !== texts[i].length);
  if (bad) return { refused: `${bad.id} needs 1 to ${MAX_OPTIONS} different options` };
  if (leads && texts[0].map((o) => o.toLowerCase()).sort().join('|') !== 'no|yes') return { refused: `${rows[0].id} is leads only, and a leads-only question needs the options Yes|No` };
  const parts = rows.map((r, i) => {
    const keys = KEYS.slice(0, texts[i].length);
    const match = (said) => keys.find((k, j) => [k, texts[i][j], `${k}. ${texts[i][j]}`].some((t) => t.toLowerCase() === said.trim().toLowerCase()));
    return {
      question: shown(r.question, 1000, r.id),
      why: shown(r.recommendation, 1000, 'no reason given'),
      recommended: match(r.recommendation) ?? 'none',
      ...(match(r.default) && { default: match(r.default) }),
      options: Object.fromEntries(keys.map((k, j) => [k, shown(texts[i][j], 500, k)])),
    };
  });
  const kind = rows.length === 1 ? 'single' : 'batch';
  const id = rows.map((r) => r.id).join('+');
  const keys = parts.map((p) => Object.keys(p.options));
  const gate = openGate(kind === 'single' ? { id, kind, options: keys[0], askedBy: ownerId, at } : { id, kind, parts: keys, askedBy: ownerId, at });
  return { gate, ask: { kind, task: shown(rows[0].task, 40, 'a task'), title: shown(title, 300), parts, ...(leads && { leads }) }, texts };
}

/** The option key that an answer typed at the terminal names ("A", the option's text, or "A. text"), or undefined. */
function optionOf(said, texts) {
  const s = said.trim().toLowerCase();
  return KEYS.slice(0, texts.length).find((k, j) => [k, texts[j], `${k}. ${texts[j]}`].some((t) => t.toLowerCase() === s));
}

/**
 * The gate rows of one task in groups of the questions that the task asked together: sorted by `at`, a group starts at its first row
 * and holds every row up to ASKED_TOGETHER after it (G9). A restart groups the same rows the same way (F-T28-29).
 */
export function askedTogether(rows) {
  const sorted = rows.map((r) => [Date.parse(r.at), r]).sort((a, b) => a[0] - b[0]);
  const groups = [];
  for (const [at, r] of sorted) {
    const last = groups.at(-1);
    if (last && at - last.start <= ASKED_TOGETHER) last.rows.push(r);
    else groups.push({ start: at, rows: [r] });
  }
  return groups.map((g) => g.rows);
}

/**
 * The bridge for one sage project and one Discord channel.
 * @param {{ sage: ReturnType<import('./sage.js').sageTool>,
 *   discord: { post(target: string, p: object): Promise<string>, edit(target: string, id: string, p: object): Promise<unknown>,
 *     startThread(lineId: string, name: string): Promise<string>, threadFrom(lineId: string): Promise<string>,
 *     setLocked(thread: string, locked: boolean): Promise<unknown>,
 *     members(): Promise<Iterable<object>> | Iterable<object> },
 *   config: { channelId: string, ownerId: string, apprenticeRole: string, leadRole: string, votesPath?: string, sessionsPath?: string },
 *   statePath: string, now?: () => number, log?: (line: string) => void }} o
 *   A `target` is the parent channel or a thread, by its Discord id.
 */
export function createBridge({ sage, discord, config, statePath, now = Date.now, log = (line) => process.stderr.write(`${line}\n`) }) {
  refuseOldRoles(config);
  for (const key of ['channelId', 'ownerId', 'apprenticeRole', 'leadRole']) {
    if (!SNOWFLAKE.test(config[key] ?? '')) throw new TypeError(`the config needs ${key} as a Discord id (17 to 20 digits)`);
  }
  const say = (line) => log(forTerminal(line)); // every line for the terminal goes through the allow-list (F-T28-22)
  // `gates` is the map that `handle` reads and writes; `meta` holds the rest of each entry, by the same gate id.
  const gates = new Map();
  const meta = new Map();
  const loaded = load(statePath);
  for (const { gate, ask, ...rest } of loaded.entries) {
    gates.set(gate.id, { gate, ask });
    meta.set(gate.id, rest);
  }
  // The chief sessions that have a line and a thread, by session id; `spools` is the spool folder as the last loop read it.
  const sessions = new Map(loaded.sessions.map((x) => [x.id, x]));
  const spoolDir = sessionsPathOf({ statePath, sessionsPath: config.sessionsPath });
  let spools = new Map();
  const lines = new Map(); // session id → the text of its line as last posted or edited; only in memory
  const said = new Set(); // the lines that the log says only once (a refused spool file, a refused thread)
  const sayOnce = (line) => { if (!said.has(line)) { said.add(line); say(line); } };
  const clock = monotonic(now, Math.max(0, ...[...gates.values()].map((e) => e.gate.lastAt)));
  const firstSeen = new Map(); // sage gate id → when the bridge first saw it open; only in memory
  const refused = new Set(); // groups already refused, so that the log says it once
  const kept = new Set(); // sage gate ids already logged as kept at the terminal (not marked, or about a merge), so that the log says it once
  const votesPath = votesPathOf({ statePath, votesPath: config.votesPath });
  const leadsPath = leadsPathOf({ statePath, votesPath: config.votesPath });
  let votesError = null; // the last refusal of the team votes file, so that the log says it once
  let lastLoop = null;
  let lastHolders = null; // the holders at the last loop, to redraw the open cards when they change (F-T28-31)

  const persist = () => save(statePath, [...gates].map(([id, { gate, ask }]) => ({ gate, ask, ...meta.get(id) })), [...sessions.values()]);
  const people = async () => { // Sets of ids (F-T28-7)
    const members = [...await discord.members()];
    const both = members.filter((m) => !m.bot && m.roles.includes(config.apprenticeRole) && m.roles.includes(config.leadRole));
    if (both.length) sayOnce(`these members have both sage-apprentice and sage-lead, so each counts as a sage-lead: ${both.map((m) => `${m.name} (${m.id})`).join(', ')}. Give each person one of the two roles.`);
    return peopleOf(members, config);
  };
  /** Whether the entry of `id` still waits for something: its gate is not closed, and not every part is decided or final. */
  const waits = (id) => !settled(gates.get(id).gate, gates.get(id).ask);
  /** A message that pings these roles and nobody else; the text is the bridge's own, with untrusted parts made safe. */
  const alert = (roles, text) => ({ content: `${roles.map((r) => `<@&${r}> `).join('')}${text}`, allowedMentions: { parse: [], roles } });
  /** The roles of the holders: a new card and a single gate's reminder ping both (T70), or only sage-lead for a leads-only question (T73). */
  const holderRoles = (ask) => (ask.leads ? [config.leadRole] : [config.apprenticeRole, config.leadRole]);
  /** The session whose thread `target` is, when Discord's error `e` says that the thread is gone. */
  const goneThread = (target, e) => GONE.has(e?.code) && [...sessions.values()].find((y) => y.thread === target);
  const post = async (target, payload) => {
    // A payload with no allowedMentions would ping every mention in its text: the bridge's default pings nobody (F-T65-3).
    try { return await discord.post(target, { allowedMentions: NO_MENTIONS, ...payload }); } catch (e) {
      const x = goneThread(target, e);
      if (x) lost(x, e); else say(`Discord refused a post: ${apiError(e)}`);
      return null;
    }
  };
  /**
   * A session thread that Discord says is gone (deleted, or the bot lost access): the session forgets it, and its next card makes a new
   * one (F-T29-9). Each card of the thread that still waits loses its message and gets the parent channel as its place, in the same save:
   * sync posts it there as it is now, also after a failure or a restart in between, and every later post about it goes there (G17,
   * F-T55-3). The votes stay in the gate, so the new card shows them. A settled card is not posted again.
   */
  const lost = (x, e) => {
    const thread = x.thread;
    sayOnce(`the thread ${thread} of ${x.title} is gone from Discord, so its cards go to the parent channel until the next card makes a new thread: ${apiError(e)}`);
    Object.assign(x, { thread: null, closed: false });
    const moving = [...meta].filter(([id, m]) => m.message && m.channel === thread && waits(id));
    for (const [, m] of moving) Object.assign(m, { message: null, channel: config.channelId });
    persist();
    for (const [id] of moving) say(`${id}: its card moves to the parent channel, because the thread of ${x.title} is gone (G17)`);
  };
  const edit = async (target, message, payload, what) => {
    try { await discord.edit(target, message, payload); } catch (e) {
      const x = goneThread(target, e);
      if (x) lost(x, e); else say(`Discord refused the edit of ${what}: ${apiError(e)}`);
    }
  };
  const setLocked = async (x, locked) => {
    try { await discord.setLocked(x.thread, locked); x.closed = locked; persist(); return true; } catch (e) {
      if (GONE.has(e?.code)) lost(x, e); else sayOnce(`Discord refused to ${locked ? 'lock' : 'open'} the thread of ${x.title}: ${apiError(e)}`);
      return false;
    }
  };
  const running = (sid) => spools.has(sid) && runs(spools.get(sid), alive);

  /**
   * The place of a new card of a chief session: its thread, made at the session's first card (G14 1) as a line in the parent channel and
   * a thread started from it. A locked thread opens again, because the new card is a question to settle in it (G15). When Discord refuses
   * the line, the thread or the unlock, the card goes to the parent channel, and the next card of the session tries again (F-T29-2).
   * A thread that is gone was forgotten (`lost`): the next card starts a new thread from the line, or from a new line when the line is
   * gone too or Discord keeps the dead thread on it (F-T29-9).
   * Only sync calls this, and only the loop runs sync, so two calls never make two lines or threads for one session (F-T29-6).
   */
  async function placeOf(sid) {
    if (!sid) return config.channelId;
    let x = sessions.get(sid);
    if (!x) {
      const n = Math.max(0, ...[...sessions.values()].map((y) => y.n)) + 1;
      x = { id: sid, n, title: titleOf(n, spools.get(sid)?.startedAt ?? clock()), line: null, thread: null, closed: false };
      sessions.set(sid, x);
      persist();
    }
    for (let tries = 0; !x.thread; tries++) {
      if (!x.line) {
        const text = lineText(x);
        x.line = await post(config.channelId, { content: text, allowedMentions: NO_MENTIONS });
        if (!x.line) return config.channelId;
        lines.set(sid, text);
        persist();
      }
      let thread;
      try { thread = await startThread(x); } catch (e) {
        sayOnce(`Discord refused the thread of ${x.title}, so its cards go to the parent channel until a later card makes it: ${apiError(e)}`);
        return config.channelId;
      }
      if (!thread && tries > 0) return config.channelId;
      if (!thread) {
        sayOnce(`the line ${x.line} of ${x.title} is gone or keeps a deleted thread, so the session gets a new line`);
        // The old line stays in the parent channel with its history, so it says where the session went (F-T55-1).
        await edit(config.channelId, x.line, { content: `**${x.title}**\nmoved to a new line below`, allowedMentions: NO_MENTIONS }, `the old line of ${x.title}`);
      }
      Object.assign(x, thread ? { thread } : { line: null });
      persist();
    }
    if (x.closed && !(await setLocked(x, false))) return config.channelId;
    return x.thread;
  }
  /**
   * Starts the thread of a session from its line. Code 160004: the line has a thread, but its reply was lost, so take that thread (F-T29-2).
   * Null when the line can start no thread: the line is gone, or its thread is deleted and Discord keeps it on the line (F-T29-9).
   */
  async function startThread(x) {
    try { return await discord.startThread(x.line, x.title); } catch (e) {
      if (e?.code === UNKNOWN_MESSAGE) return null;
      if (e?.code !== 160004) throw e;
    }
    try { return await discord.threadFrom(x.line); } catch (e) { if (GONE.has(e?.code)) return null; throw e; }
  }

  /** Whether the card of `id` moved to the parent channel (G17) and waits for its new post. */
  const moved = (m) => m.channel && !m.message;
  /**
   * Posts a message about the card of `id` where the card is (F-T29-4); nothing before the card is first posted. A card that moved (G17)
   * holds the message in its entry, also when this post finds the thread gone: sync posts it after the new card, also after a restart (T65).
   * While messages wait in `held`, a new one goes after them, so they keep their order (F-T65-4).
   */
  const postAbout = async (id, payload) => {
    const m = meta.get(id);
    await postHeld(id);
    if (!m.held?.length && m.message && (await post(m.channel ?? config.channelId, payload))) return;
    if ((moved(m) || m.held?.length) && waits(id)) { m.held = [...(m.held ?? []), payload]; persist(); }
  };
  /**
   * Posts the messages held for the card of `id` below it, in order, while the card waits for them. A settled card drops them: a tie
   * alert or a reminder after the answer would call the team for nothing (F-T65-4).
   */
  async function postHeld(id) {
    const m = meta.get(id);
    if (!m.held?.length) return;
    if (!waits(id)) {
      say(`${id}: it is settled, so the bridge drops the ${m.held.length} message(s) that waited for its card`);
      delete m.held;
      persist();
      return;
    }
    while (m.message && m.held.length && (await post(m.channel, m.held[0]))) { m.held.shift(); persist(); }
  }

  /**
   * Posts the card of `id` with the role alert at `at`, and keeps its place. A card with a place and no message lost its thread (G17),
   * and its alert says so; its 2-hour reminders count from this post (T65). When the session's thread is gone, the card goes to the
   * parent channel in this loop (F-T29-9). Returns the message id or null.
   */
  async function postCard(id, ppl, at) {
    const m = meta.get(id);
    const { gate, ask } = gates.get(id);
    const owner = nameOf(config.ownerId, ppl.names);
    const text = (ask.leads ? `${ask.task} asks the ${LEAD}s for a recommendation to ${owner}. The first ${LEAD} answer is the recommendation; ${owner} decides at the terminal.`
      : gate.kind === 'single' ? `${ask.task} needs one product answer. The first answer is final.`
      : `${ask.task} has ${gate.parts.length} product questions. Vote on each part within 30 minutes.`)
      + (m.channel ? ' Its session thread was deleted, so the card is here now, with the votes so far.' : '');
    const payload = { ...card(gate, ask, ppl), ...alert(holderRoles(ask), text) };
    let message = await post(at, payload);
    if (!message && at !== config.channelId && !sessions.get(m.session)?.thread) message = await post((at = config.channelId), payload);
    if (message) { Object.assign(m, { message, channel: at }, moved(m) && { remindedAt: clock() }); persist(); }
    return message;
  }

  /** The questions of the gate of `id` that still wait for an answer: none on a closed gate, one per open single gate or open part. */
  const openQuestions = (id) => {
    const { gate, ask } = gates.get(id);
    return gate.phase === 'closed' ? 0 : (gate.parts ?? [gate]).filter((p, i) => p.outcome.status === 'open' && !ask.parts[i].final).length;
  };
  /** The line of a session in the parent channel, from its spool and its gates. */
  function lineText(x) {
    const ids = [...meta].filter(([, m]) => m.session === x.id).map(([id]) => id);
    const tasks = new Set([...(spools.get(x.id)?.tasks ?? []), ...ids.map((id) => gates.get(id).ask.task)]);
    return lineOf(x, { tasks: tasks.size, open: openOf(x.id) });
  }
  /** The questions of a session that still wait for an answer, on its cards and on the gates that wait for their card. */
  const openOf = (sid) => [...meta].reduce((n, [id, m]) => n + (m.session === sid ? openQuestions(id) : 0), 0);

  /** Edits the card of a gate with `card()`, from the gate as it is now (F-T28-17). */
  async function redraw(id, ppl) {
    const { gate, ask } = gates.get(id);
    const { message, channel } = meta.get(id);
    if (message) await edit(channel ?? config.channelId, message, card(gate, ask, ppl), id);
  }

  /** The parts of a batch that wait for a lead: tied after the vote, with no final answer from the terminal. */
  const tiedParts = (gate, ask) => gate.parts.flatMap((part, i) => (part.outcome.status === 'open' && !ask.parts[i].final ? [i] : []));

  /** The tied parts of a batch whose vote ended, with each voter's argument, for the leads (F-T28-13). */
  function tieMessage(gate, ask, { holders, names }) {
    const lines = tiedParts(gate, ask).flatMap((i) => {
      const part = gate.parts[i];
      const args = part.ballots.filter(([by, b]) => holders.has(by) && b.reason)
        .map(([by, b]) => `- ${nameOf(by, names)}, for ${b.option}: ${cut(shown(b.reason, 500), 200) || '(no visible text)'}`);
      return [`Part ${i + 1} is tied: ${part.tied.join(', ')}.${args.length ? ' The arguments:' : ' Nobody gave a reason.'}`, ...args];
    });
    const head = `${gate.id} is tied after its vote. ${ask.task} waits: please break the tie with the buttons on the card.`;
    return alert([config.leadRole], cut([head, ...lines].join('\n'), 1900));
  }

  /** The answers that the bridge gives sage for a settled gate: one per sage gate, as "A. option text", never for a part with a final answer. */
  function answersOf(id) {
    const { gate, ask } = gates.get(id);
    const { sage: ids, texts } = meta.get(id);
    if (!settled(gate, ask) || gate.outcome.status === 'withdrawn') return [];
    const keyText = (i, key) => `${key}. ${texts[i][KEYS.indexOf(key)]}`;
    const keys = gate.kind === 'single' ? [gate.outcome.option] : gate.parts.map((p) => p.outcome.option);
    return keys.flatMap((key, i) => (key && !ask.parts[i].final ? [[ids[i], keyText(i, key)]] : []));
  }

  /**
   * Reads the answers in sage that the bridge did not write: they are the owner's, typed at the terminal, and final whatever the
   * owner's roles (G10). Each one closes its part on the card, so no press and no answer of the bridge replaces it. An answer that
   * names no option on an open single gate is a withdraw instead: those gate ids come back, for the caller to apply.
   */
  async function readOwner(rows) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const withdraws = [];
    for (const [id, m] of meta) {
      const own = new Map(answersOf(id)); // what the bridge gives sage; the same text in sage is the bridge's (a crash before its save)
      for (const [i, sageId] of m.sage.entries()) {
        const { gate, ask } = gates.get(id);
        const said = byId.get(sageId)?.answer ?? '';
        // A gate with an open check of the trail waits for it: the answer in sage may be the bridge's write back of an older owner answer.
        if (!said || said === m.sent[sageId] || ask.parts[i].final || gate.outcome.status === 'withdrawn' || m.restore?.[sageId]) continue;
        if (said === own.get(sageId)) { m.sent[sageId] = said; persist(); continue; }
        const option = optionOf(said, m.texts[i]);
        if (!option && gate.kind === 'single' && gate.phase === 'open') { withdraws.push(id); continue; }
        const text = option ? shown(`${option}. ${m.texts[i][KEYS.indexOf(option)]}`, 500, option) : shown(said, 500, '(no visible text)');
        const final = { by: config.ownerId, at: clock(), ...(option && { option }), text };
        gates.set(id, { gate, ask: { ...ask, parts: ask.parts.with(i, { ...ask.parts[i], final }) } });
        persist();
        say(`${sageId} was answered at the terminal: the card shows it as final`);
        await redraw(id, await people());
      }
    }
    return withdraws;
  }

  /** Gives sage each final answer that it does not have yet. Only a settled gate has any (R142).
   * One flush at a time: a press and the loop never send the same answer twice. */
  let flushing = Promise.resolve();
  const flush = () => (flushing = flushing.then(sendAnswers).catch((e) => say(`the answers to sage failed: ${e?.message}`)));
  async function sendAnswers() {
    for (const [id, m] of meta) {
      // One gate at a time: an error in the answers of one gate never stops the answers of the other gates (F-T43-7).
      try {
        await sendGate(id, m);
      } catch (e) {
        say(`the answers of ${id} to sage failed; the bridge tries again: ${e?.message}`);
      }
    }
  }

  async function sendGate(id, m) {
    for (const sageId of Object.keys(m.restore ?? {})) await keepOwner(id, sageId); // a check that a failure or a stop left open
    for (const [sageId, text] of answersOf(id)) {
      if (m.sent[sageId] === text || m.restore?.[sageId]) continue;
      // The decisions before the gate rows: an answer that the read of the rows misses is after `mark` in the trail (F-T43-1).
      const mark = (await sage.decisions()).length;
      // The row again, just before the answer: an answer that the owner typed meanwhile is final, and the bridge skips it (G10).
      await readOwner(await sage.gates());
      if (!new Map(answersOf(id)).has(sageId) || m.sent[sageId] === text) continue;
      // Saved before the write, so that the check of the trail survives a failed write back and a stop of the bridge (F-T43-5).
      (m.restore ??= {})[sageId] = { mark, wrote: text, from: 0 };
      persist();
      try {
        await sage.answer(sageId, text);
      } catch (e) {
        say(`sage did not record the answer of ${sageId}; the bridge tries again: ${e.message}`);
        continue;
      }
      m.sent[sageId] = text;
      persist();
      say(`sage gate ${sageId} answered: ${text}`);
      await keepOwner(id, sageId);
    }
  }

  /**
   * Writes back an answer that the owner typed between the bridge's last read and its own write, which sage replaced (F-T43-1).
   * gates.tsv keeps only the last write, but decisions.tsv keeps each answer in the order of the writes. `m.restore[sageId]` is the
   * bridge's last write (or try) of the gate: `wrote`, in the answers of the gate after `mark` from index `from` on. An answer of the
   * gate in that window just before `wrote` is the owner's, and final (G10 a): the bridge saves it as its next write, then writes it back.
   * An answer after `wrote` stands (the owner's later answer). The marker is in the gate file until a check finds nothing to write back,
   * so a write back that sage refused, or a stop of the bridge, is done again at the next flush (F-T43-5). Then the card shows the
   * answer in sage as final in the same turn (F-T43-6). `m.sent` keeps the bridge's text, so the bridge never sends again.
   */
  async function keepOwner(id, sageId) {
    const m = meta.get(id);
    /** Ends the check without a write: the logbook no longer has what the marker counts on (F-T43-7, F-T43-8). */
    const stop = (why) => {
      delete m.restore[sageId];
      persist();
      say(`${sageId}: ${why}; the bridge stops its check of the owner's answer and writes nothing back`);
    };
    const row = (await sage.gates()).find((r) => r.id === sageId);
    if (!row) return stop('the gate is not in gates.tsv any more');
    const head = `${row.question} → `;
    for (let wrote = false; ; wrote = true) {
      const { mark, wrote: text, from } = m.restore[sageId];
      const trail = await sage.decisions();
      const all = trail.slice(mark).filter((d) => d.task === row.task && d.decision.startsWith(head)).map((d) => d.decision.slice(head.length));
      if (trail.length < mark || all.length < from) { stop('the decisions trail is shorter than at the last check'); break; }
      const said = all.slice(from);
      const mine = said.lastIndexOf(text);
      if (mine === -1 && from > 0 && said.length === 0) {
        // a write back that did not land, and no answer after it: write it again, but never twice in one flush
        if (wrote) { stop('the decisions trail does not show the write back'); break; }
      } else if (mine <= 0 || mine < said.length - 1) {
        // no answer between the reads and the write, a write of the bridge that did not land, or a later answer that stands
        delete m.restore[sageId];
        persist();
        break;
      } else {
        m.restore[sageId] = { mark, wrote: said[mine - 1], from: from + mine + 1 };
        persist();
      }
      try {
        await sage.answer(sageId, m.restore[sageId].wrote);
      } catch (e) {
        say(`sage did not record the owner's answer of ${sageId} again; the bridge tries again: ${e.message}`);
        return;
      }
      say(`${sageId}: the owner answered at the terminal just before the bridge; the bridge wrote the owner's answer back: ${m.restore[sageId].wrote}`);
    }
    await readOwner(await sage.gates());
  }

  /** After the gate of `id` changed: save it, edit the card, and post what the effects call for. `by` is who caused it. */
  async function after(id, effects, ppl, by) {
    persist();
    await redraw(id, ppl);
    const { gate, ask } = gates.get(id);
    if (effects.some((e) => e.type === 'vote-ended') && gate.phase === 'tied' && waits(id)) {
      // The tie post is the leads' ping for this event: the 2-hour reminders count from it, so one loop never pings twice (F-T28-32).
      meta.get(id).remindedAt = clock();
      persist();
      await postAbout(id, tieMessage(gate, ask, ppl));
    }
    for (const e of effects.filter((x) => x.type === 'decided' && x.how === 'lead-tiebreak')) {
      // The card cannot name the lead; the message in the thread does (F-T28-16).
      await postAbout(id, { content: `${nameOf(by, ppl.names)} (${LEAD}) broke the tie on part ${e.part + 1} of ${gate.id}: ${e.option}.`, allowedMentions: NO_MENTIONS });
    }
    await flush();
    const answered = effects.find((e) => e.type === 'closed' && e.outcome.status === 'answered');
    if (ask.leads && answered) {
      // T73: the leads only recommend. sage gets the answer as usual, and the owner decides at the terminal (G10). The bridge never
      // switches a mode of sage, and its texts name the switch only in words.
      const owner = nameOf(config.ownerId, ppl.names);
      const { sage: [sageId], texts: [texts] } = meta.get(id);
      await postAbout(id, { content: `Recommendation recorded: ${nameOf(by, ppl.names)} recommends ${ask.parts[0].options[answered.outcome.option]}. ${owner} decides at the terminal.`, allowedMentions: NO_MENTIONS });
      say(`${sageId}: sage-leads recommend ${texts[KEYS.indexOf(answered.outcome.option)]}. If you agree, switch the mode yourself at the terminal.`);
    }
  }

  /** Applies one event of the bridge's own (a tick or a withdraw) to the gate of `id`. */
  async function apply(id, event, ppl) {
    const { gate, ask } = gates.get(id);
    const out = step(gate, event, ppl.holders, ppl.leads);
    for (const e of out.effects.filter((x) => x.type === 'ignored')) say(`${id}: the vote rules ignored a ${event.type} (${e.why})`);
    if (out.gate === gate) return;
    gates.set(id, { gate: out.gate, ask });
    await after(id, out.effects, ppl, event.by);
  }

  /** Takes in the owner's answers at the terminal from the gate rows: the final answers, and the withdraws. */
  async function takeOwner(rows, ppl) {
    for (const id of await readOwner(rows)) await apply(id, { type: 'withdraw', by: config.ownerId, at: clock() }, ppl);
  }

  /**
   * The gate ids in the team votes file and in the leads-only file (T73). A refused file counts as both empty, so nothing is posted;
   * the log says why once.
   */
  function teamVotes() {
    try {
      const marks = { votes: loadVotes(votesPath), leads: loadLeads(leadsPath) };
      votesError = null;
      return marks;
    } catch (e) {
      if (e.message !== votesError) say(`no gate is posted: ${e.message}`);
      votesError = e.message;
      return { votes: new Set(), leads: new Set() };
    }
  }

  /** Reads the logbook: takes in the owner's answers at the terminal, then posts the new open gates. */
  async function sync(ppl) {
    const rows = await sage.gates();
    await takeOwner(rows, ppl);
    // New gates, by task and then by the time sage asked them (G9). A question added after its task's card has its own card (G10 c).
    const tracked = new Set([...meta.values()].flatMap((m) => m.sage));
    const untracked = rows.filter((r) => !tracked.has(r.id));
    const t = clock();
    // The time a gate was first seen counts also before the chief marks it: a gate marked later posts at the next loop.
    for (const r of untracked) if (!r.answer && !firstSeen.has(r.id)) firstSeen.set(r.id, t);
    // Only the gates that the chief marked as team votes or leads only go to Discord (G13, T73); every rule below sees only these.
    // A leads-only question may be about a merge: the leads only recommend, and the owner decides at the terminal (G18).
    const { votes, leads } = teamVotes();
    const fresh = untracked.filter((r) => {
      const why = leads.has(r.id) ? null : !votes.has(r.id) ? 'the chief did not mark it as a team vote'
        : MERGE.test(`${r.question} ${r.options}`) ? 'it is about a merge, and a merge never goes to a vote' : null;
      if (why && !r.answer && !kept.has(r.id)) { kept.add(r.id); say(`${r.id} stays at the terminal: ${why}`); }
      return !why;
    });
    const tasks = new Map();
    for (const r of fresh.filter((x) => !leads.has(x.id))) tasks.set(r.task, [...(tasks.get(r.task) ?? []), r]);
    // A leads-only question is always one question on its own card, never part of a batch (T73).
    const groups = [...[...tasks.values()].flatMap(askedTogether), ...fresh.filter((x) => leads.has(x.id)).map((x) => [x])];
    const open = groups.map((g) => g.filter((r) => !r.answer));
    const titles = open.some((g) => g.length) ? new Map((await sage.tasks()).map((x) => [x.id, x.title])) : new Map();
    for (const [n, group] of groups.entries()) {
      const rowsOpen = open[n];
      // A group waits SETTLE after its newest gate, so that a batch comes whole.
      if (!rowsOpen.length || t - Math.max(...rowsOpen.map((r) => firstSeen.get(r.id))) < SETTLE) continue;
      // A task that asked 5 or more together stays at the terminal until each of those questions has an answer (G10 b): the answered
      // ones count too, so no later card takes the rest.
      const framed = frame(group.length > MAX_PARTS ? group : rowsOpen, titles.get(group[0].task) ?? '', config.ownerId, t, leads.has(group[0].id));
      const key = group.map((r) => r.id).join('+');
      if (framed.refused) {
        if (!refused.has(key)) say(`not posted: ${framed.refused}. Answer them at the terminal.`);
        refused.add(key);
        continue;
      }
      const { gate, ask, texts } = framed;
      const sage = rowsOpen.map((r) => r.id);
      gates.set(gate.id, { gate, ask });
      meta.set(gate.id, { sage, texts, message: null, remindedAt: gate.openedAt, sent: {}, session: sessionOf(rowsOpen, spools, alive) });
      persist(); // the entry is saved before the post, so a crash in between posts it again instead of losing it
    }
    // Post every entry that has no card yet, with the role alert: a new card, or a card that moved to the parent channel (G17) and still
    // waits; a settled card is not posted again (F-T65-1). Then the messages held for a moved card, below it, or dropped when it is
    // settled (T65, F-T65-4). An error on one card never stops the posts of the others (F-T55-3).
    for (const [id, m] of meta) {
      try {
        if (!m.message && (waits(id) || !moved(m))) await postCard(id, ppl, m.channel ?? await placeOf(m.session));
        await postHeld(id);
      } catch (e) { say(`${id}: the bridge could not post its card; it tries again: ${e?.message}`); }
    }
  }

  /** The timers: the tick at gate.endsAt (also after a sleep) and the reminders every 2 hours. */
  async function timers(ppl) {
    for (const id of gates.keys()) {
      const { gate } = gates.get(id);
      if (gate.phase === 'voting' && clock() >= gate.endsAt) await apply(id, { type: 'tick', at: clock() }, ppl);
      const { gate: g, ask } = gates.get(id);
      const m = meta.get(id);
      const due = waits(id) && nextReminderAt(g, m.remindedAt);
      if (!due || due.at > clock() || !m.message) continue;
      m.remindedAt = clock();
      persist();
      await postAbout(id, due.to === 'holders'
        ? alert(holderRoles(ask), `reminder: ${g.id} waits for an answer since ${stamp(g.openedAt)}. ${ask.task} waits.`)
        : alert([config.leadRole], `reminder: ${tiedParts(g, ask).map((i) => `part ${i + 1}`).join(', ')} of ${g.id} still tied since ${stamp(g.votingEndedAt)}. ${ask.task} waits.`));
    }
  }

  /** Reads the spool folder. */
  function readSessions() {
    const read = readSpools(spoolDir);
    spools = read.spools;
    read.refused.forEach(sayOnce);
  }

  /**
   * Keeps each session's line up to date, and locks the thread of an ended session when every question of the session is settled (G15):
   * until then the team votes on in the thread. A resume opens the thread again (G14 3).
   */
  async function reconcile() {
    for (const x of sessions.values()) {
      if (!x.line) continue;
      const on = running(x.id);
      const endedAt = on ? undefined : x.endedAt ?? spools.get(x.id)?.endedAt ?? clock();
      if (endedAt !== x.endedAt) {
        if (on) delete x.endedAt; else x.endedAt = endedAt;
        persist();
      }
      const lock = !on && openOf(x.id) === 0;
      if (x.thread && x.closed !== lock) await setLocked(x, lock);
      const text = lineText(x);
      if (lines.get(x.id) === text) continue;
      await edit(config.channelId, x.line, { content: text, allowedMentions: NO_MENTIONS }, `the line of ${x.title}`);
      lines.set(x.id, text);
    }
  }

  return {
    clock,
    /** The thread of a chief session, or undefined when it has none (scripts/session.mjs reads the same from the gate file). */
    threadOf: (sid) => sessions.get(sid)?.thread ?? undefined,
    /** The gate of a bridge id and its ask, as `handle` keeps them. */
    entry: (id) => gates.get(id),
    /** One turn of the loop: notices a sleep, redraws the open cards when the holders changed, sends the due ticks and reminders,
     * reads the logbook, gives sage its answers. */
    async loop() {
      const ppl = await people();
      const wall = now();
      readSessions();
      await reconcile(); // first, so that a resumed session's thread is open before anything is posted in it (G14 3)
      // A press while the Mac slept never reached the bridge: Discord said that the interaction failed (F-T28-1). One note in each
      // place that has an open question.
      if (lastLoop !== null && wall - lastLoop > SLEPT) {
        const places = new Set();
        for (const [id, m] of meta) if (m.message && waits(id)) places.add(m.channel ?? config.channelId);
        for (const at of places) await post(at, { content: `The host was asleep from ${stamp(lastLoop)} to ${stamp(wall)}. Presses in that time did not count. Please press again on any open question.`, allowedMentions: NO_MENTIONS });
      }
      lastLoop = wall;
      // A card counts only the votes of the holders: when a role changed, each open card shows the count that the tick will use.
      const holders = [...ppl.holders].sort().join();
      if (lastHolders !== null && holders !== lastHolders) for (const id of gates.keys()) if (waits(id)) await redraw(id, ppl);
      lastHolders = holders;
      await timers(ppl);
      await sync(ppl);
      await flush();
      await reconcile(); // again, for the lines of the sessions that got a card or an answer in this loop
    },
    /** One Discord interaction (a button or the reason form). Never rejects. */
    async interaction(i) {
      const by = i?.user?.id;
      try {
        if (!SNOWFLAKE.test(by ?? '')) { await i.reply(ephemeral('I do not know this account. Nothing changed.')); return; }
        const ppl = await people();
        // The owner's answers at the terminal come first: a press never counts on a part that has one (G10).
        await takeOwner(await sage.gates(), ppl);
        const pressed = parseCustomId(i.customId);
        const target = pressed && gates.get(pressed.gateId);
        const final = target?.ask.parts[target.gate.kind === 'single' ? 0 : pressed.part]?.final;
        if (final || (target && target.gate.phase !== 'closed' && !waits(pressed.gateId))) {
          const text = final ? `Already answered by ${nameOf(final.by, ppl.names)} at the terminal: ${final.text}. Your press did not count.`
            : `Every part of ${pressed.gateId} is decided or answered at the terminal. Your press did not count.`;
          await i.reply(ephemeral(text));
          return;
        }
        const out = await handle(i, { gates, people: ppl, clock });
        if (out.replyError) say(`Discord refused a reply: ${apiError(out.replyError)}`);
        // The gate changed: also when the event was refused at the time limit, the vote ended first, so settle it (F-T28-4).
        if (out.stored) await after(pressed.gateId, out.effects, ppl, by);
      } catch (e) {
        // A throw from handle (a card that cannot be built) leaves the gate as it was; the person gets a note (F-T28-21).
        say(`the bridge could not handle a press: ${e?.message}`);
        try { await i.reply(ephemeral('The bridge could not handle this press. Nothing changed. Please tell the owner.')); } catch (r) { say(`Discord refused a reply: ${apiError(r)}`); }
      }
    },
  };
}
