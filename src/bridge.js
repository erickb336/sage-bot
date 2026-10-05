// The sage bridge (B3): it reads the open gates of a sage logbook, posts them as cards, turns presses into vote events,
// and gives each final answer back to sage with `sage gate answer`. It also reminds, alerts the role and asks for a new
// press after the Mac slept. Discord comes in as a port (`post`, `edit`, `members`): the real one is src/discord.js, the
// tests use src/fake-discord.js. It posts only the gates that the chief marked as team votes (G13, src/state.js loadVotes). Every event time comes from the bridge's own clock, never from Discord (F-T28-2).
import { card, cut, ephemeral, NO_MENTIONS, parseCustomId, safe, settled, stamp, LEAD } from './cards.js';
import { forTerminal } from './clean.js';
import { handle, peopleOf } from './handle.js';
import { load, loadVotes, save, votesPathOf } from './state.js';
import { MAX_OPTIONS, MINUTE, nextReminderAt, openGate, step } from './vote.js';

/** A Discord id: only these go into an event's `by` (F-T28-6). */
export const SNOWFLAKE = /^\d{17,20}$/;
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
 */
export function frame(rows, title, ownerId, at) {
  if (rows.length > MAX_PARTS) return { refused: `${rows[0].task} asked ${rows.length} questions together, and a batch holds at most ${MAX_PARTS} parts` };
  const texts = rows.map((r) => r.options.split('|').map((o) => o.trim()).filter(Boolean));
  const bad = rows.find((r, i) => texts[i].length === 0 || texts[i].length > MAX_OPTIONS || new Set(texts[i]).size !== texts[i].length);
  if (bad) return { refused: `${bad.id} needs 1 to ${MAX_OPTIONS} different options` };
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
  return { gate, ask: { kind, task: shown(rows[0].task, 40, 'a task'), title: shown(title, 300), parts }, texts };
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
 *   discord: { post(p: object): Promise<string>, edit(id: string, p: object): Promise<unknown>, members(): Promise<Iterable<object>> | Iterable<object> },
 *   config: { ownerId: string, driverRole: string, leadRole: string, votesPath?: string }, statePath: string, now?: () => number, log?: (line: string) => void }} o
 */
export function createBridge({ sage, discord, config, statePath, now = Date.now, log = (line) => process.stderr.write(`${line}\n`) }) {
  for (const key of ['ownerId', 'driverRole', 'leadRole']) {
    if (!SNOWFLAKE.test(config[key] ?? '')) throw new TypeError(`the config needs ${key} as a Discord id (17 to 20 digits)`);
  }
  const say = (line) => log(forTerminal(line)); // every line for the terminal goes through the allow-list (F-T28-22)
  // `gates` is the map that `handle` reads and writes; `meta` holds the rest of each entry, by the same gate id.
  const gates = new Map();
  const meta = new Map();
  for (const { gate, ask, ...rest } of load(statePath)) {
    gates.set(gate.id, { gate, ask });
    meta.set(gate.id, rest);
  }
  const clock = monotonic(now, Math.max(0, ...[...gates.values()].map((e) => e.gate.lastAt)));
  const firstSeen = new Map(); // sage gate id → when the bridge first saw it open; only in memory
  const refused = new Set(); // groups already refused, so that the log says it once
  const kept = new Set(); // sage gate ids already logged as kept at the terminal (not marked, or about a merge), so that the log says it once
  const votesPath = votesPathOf({ statePath, votesPath: config.votesPath });
  let votesError = null; // the last refusal of the team votes file, so that the log says it once
  let lastLoop = null;
  let lastHolders = null; // the holders at the last loop, to redraw the open cards when they change (F-T28-31)

  const persist = () => save(statePath, [...gates].map(([id, { gate, ask }]) => ({ gate, ask, ...meta.get(id) })));
  const people = async () => peopleOf(await discord.members(), config); // Sets of ids (F-T28-7)
  /** Whether the entry of `id` still waits for something: its gate is not closed, and not every part is decided or final. */
  const waits = (id) => !settled(gates.get(id).gate, gates.get(id).ask);
  /** A message that pings one role and nobody else; the text is the bridge's own, with untrusted parts made safe. */
  const alert = (role, text) => ({ content: `<@&${role}> ${text}`, allowedMentions: { parse: [], roles: [role] } });
  const post = async (payload) => {
    try { return await discord.post(payload); } catch (e) { say(`Discord refused a post: ${apiError(e)}`); return null; }
  };

  /** Edits the card of a gate with `card()`, from the gate as it is now (F-T28-17). */
  async function redraw(id, ppl) {
    const { gate, ask } = gates.get(id);
    const { message } = meta.get(id);
    if (!message) return;
    try { await discord.edit(message, card(gate, ask, ppl)); } catch (e) { say(`Discord refused the edit of ${id}: ${apiError(e)}`); }
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
    return alert(config.leadRole, cut([head, ...lines].join('\n'), 1900));
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
        if (!said || said === m.sent[sageId] || ask.parts[i].final || gate.outcome.status === 'withdrawn') continue;
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
      for (const [sageId, text] of answersOf(id)) {
        if (m.sent[sageId] === text) continue;
        // The row again, just before the answer: an answer that the owner typed meanwhile is final, and the bridge skips it (G10).
        await readOwner(await sage.gates());
        if (!new Map(answersOf(id)).has(sageId) || m.sent[sageId] === text) continue;
        try {
          await sage.answer(sageId, text);
          m.sent[sageId] = text;
          persist();
          say(`sage gate ${sageId} answered: ${text}`);
        } catch (e) {
          say(`sage did not record the answer of ${sageId}; the bridge tries again: ${e.message}`);
        }
      }
    }
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
      await post(tieMessage(gate, ask, ppl));
    }
    for (const e of effects.filter((x) => x.type === 'decided' && x.how === 'lead-tiebreak')) {
      // The card cannot name the lead; the message in the thread does (F-T28-16).
      await post({ content: `${nameOf(by, ppl.names)} (${LEAD}) broke the tie on part ${e.part + 1} of ${gate.id}: ${e.option}.`, allowedMentions: NO_MENTIONS });
    }
    await flush();
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

  /** The gate ids in the team votes file. A refused file counts as empty, so nothing is posted; the log says why once. */
  function teamVotes() {
    try {
      const votes = loadVotes(votesPath);
      votesError = null;
      return votes;
    } catch (e) {
      if (e.message !== votesError) say(`no gate is posted: ${e.message}`);
      votesError = e.message;
      return new Set();
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
    // Only the gates that the chief marked as team votes go to Discord (G13); every rule below sees only these.
    const votes = teamVotes();
    const fresh = untracked.filter((r) => {
      const why = !votes.has(r.id) ? 'the chief did not mark it as a team vote'
        : MERGE.test(`${r.question} ${r.options}`) ? 'it is about a merge, and a merge never goes to a vote' : null;
      if (why && !r.answer && !kept.has(r.id)) { kept.add(r.id); say(`${r.id} stays at the terminal: ${why}`); }
      return !why;
    });
    const tasks = new Map();
    for (const r of fresh) tasks.set(r.task, [...(tasks.get(r.task) ?? []), r]);
    const groups = [...tasks.values()].flatMap(askedTogether);
    const open = groups.map((g) => g.filter((r) => !r.answer));
    const titles = open.some((g) => g.length) ? new Map((await sage.tasks()).map((x) => [x.id, x.title])) : new Map();
    for (const [n, group] of groups.entries()) {
      const rowsOpen = open[n];
      // A group waits SETTLE after its newest gate, so that a batch comes whole.
      if (!rowsOpen.length || t - Math.max(...rowsOpen.map((r) => firstSeen.get(r.id))) < SETTLE) continue;
      // A task that asked 5 or more together stays at the terminal until each of those questions has an answer (G10 b): the answered
      // ones count too, so no later card takes the rest.
      const framed = frame(group.length > MAX_PARTS ? group : rowsOpen, titles.get(group[0].task) ?? '', config.ownerId, t);
      const key = group.map((r) => r.id).join('+');
      if (framed.refused) {
        if (!refused.has(key)) say(`not posted: ${framed.refused}. Answer them at the terminal.`);
        refused.add(key);
        continue;
      }
      const { gate, ask, texts } = framed;
      gates.set(gate.id, { gate, ask });
      meta.set(gate.id, { sage: rowsOpen.map((r) => r.id), texts, message: null, remindedAt: gate.openedAt, sent: {} });
      persist(); // the entry is saved before the post, so a crash in between posts it again instead of losing it
    }
    // Post every entry that has no card yet, with the role alert.
    for (const [id, m] of meta) {
      if (m.message) continue;
      const { gate, ask } = gates.get(id);
      const text = gate.kind === 'single' ? `${ask.task} needs one product answer. The first answer is final.`
        : `${ask.task} has ${gate.parts.length} product questions. Vote on each part within 30 minutes.`;
      m.message = await post({ ...card(gate, ask, ppl), ...alert(config.driverRole, text) });
      if (m.message) persist();
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
      await post(due.to === 'holders'
        ? alert(config.driverRole, `reminder: ${g.id} waits for an answer since ${stamp(g.openedAt)}. ${ask.task} waits.`)
        : alert(config.leadRole, `reminder: ${tiedParts(g, ask).map((i) => `part ${i + 1}`).join(', ')} of ${g.id} still tied since ${stamp(g.votingEndedAt)}. ${ask.task} waits.`));
    }
  }

  return {
    clock,
    /** The gate of a bridge id and its ask, as `handle` keeps them. */
    entry: (id) => gates.get(id),
    /** One turn of the loop: notices a sleep, redraws the open cards when the holders changed, sends the due ticks and reminders,
     * reads the logbook, gives sage its answers. */
    async loop() {
      const ppl = await people();
      const wall = now();
      // A press while the Mac slept never reached the bridge: Discord said that the interaction failed (F-T28-1).
      if (lastLoop !== null && wall - lastLoop > SLEPT && [...gates.keys()].some(waits)) {
        await post({ content: `The host was asleep from ${stamp(lastLoop)} to ${stamp(wall)}. Presses in that time did not count. Please press again on any open question.`, allowedMentions: NO_MENTIONS });
      }
      lastLoop = wall;
      // A card counts only the votes of the holders: when a role changed, each open card shows the count that the tick will use.
      const holders = [...ppl.holders].sort().join();
      if (lastHolders !== null && holders !== lastHolders) for (const id of gates.keys()) if (waits(id)) await redraw(id, ppl);
      lastHolders = holders;
      await timers(ppl);
      await sync(ppl);
      await flush();
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
