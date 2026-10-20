// The catch-up (T241, R918 C9): when the Mac slept or the gateway dropped, Discord does not send the messages of that time again, so
// sage-bot reads them back at each gateway ready (the first ready, and each ready or resume after it: a sleep does not restart the process).
// For each place that it watches (each registered channel, each thread of an open request, and each thread of the thread map that was
// active in the WINDOW before the gap: F-T241-12), it reads the messages after the last one that it saw there, and gives each mention of
// the crew or the owner to the normal mention path, in order. A mention older than WINDOW gets no answer: at most one reply in place
// (OLD) for each person in each place. A place where it picked something up gets one line that says so. A place that a run could not
// read waits: its mark moves only when a later run reads it, at a loop turn RETRY after the run (F-T241-9) or at the next ready.
// The file is <statePath>.alive, beside the gate file and safe like it (0600, written whole, read with no symlink): the time of the
// last loop turn (the heartbeat), the last message id seen in each place, and the messages handled while their place's mark waits
// (F-T241-11). Its only writer is this module, in the bridge's process.
import { apiError, LOOP } from './bridge.js';
import { NO_MENTIONS, stamp } from './cards.js';
import { placeOf } from './crew.js';
import { forTerminal } from './clean.js';
import { readOwn, writeWhole } from './state.js';
import { HOUR } from './vote.js';

/** A missed mention older than this gets OLD, not an answer (owner decision, R918 Q4). */
export const WINDOW = 24 * HOUR;
/** The one reply to a missed mention older than WINDOW. */
export const OLD = 'This is old, please ask again.';
/** The OLD reply pings the person it replies to, and nobody else (sage decision, F-T241-3). */
const AUTHOR_ONLY = { ...NO_MENTIONS, repliedUser: true };
/** A run that left a place unread is tried again at the first loop turn this long after it (F-T241-9). */
export const RETRY = 3 * 60_000;
/**
 * A pause of the loop (more than 2 turns) starts a gap only when a drop of the gateway or a ready follows within this time; else the
 * gateway stayed up, nothing was missed, and the pause is forgotten (F-T241-13).
 */
const PAUSE = 3 * 60_000;
/** Discord gives at most this many messages per read. */
export const PAGE = 100;
const SNOWFLAKE = /^\d{17,20}$/;
const EPOCH = 1420070400000n; // Discord's epoch: a message id holds its time in ms since then, shifted 22 bits
/** The time of a Discord id, in ms. */
export const timeOf = (id) => Number((BigInt(id) >> 22n) + EPOCH);
/** The smallest Discord id at `ms`: a read "after" it starts at that time. */
export const idAt = (ms) => String((BigInt(Math.floor(ms)) - EPOCH) << 22n);
/**
 * The line in a place where a run picked something up, with no ping: `answered` mentions went to the mention path, `old` were older than
 * WINDOW. The times show the date too (style f), since a gap can pass midnight or last days (F-T241-1).
 */
export const offlineLine = (from, to, answered, old) => {
  const n = (k) => `${k} message${k === 1 ? '' : 's'}`;
  const tooOld = `${old === 1 ? 'was' : 'were'} too old`;
  const got = answered && old ? `I picked up ${n(answered)}; ${old} ${tooOld}.` : answered ? `I picked up ${n(answered)}.` : `${n(old)} ${tooOld}.`;
  return `I was offline from ${stamp(from, 'f')} to ${stamp(to, 'f')}. ${got}`;
};
const newest = (a, b) => (a === undefined || BigInt(b) > BigInt(a) ? b : a);

/** The catch-up file of a config: `<statePath>.alive`. */
export const alivePathOf = ({ statePath }) => `${statePath}.alive`;

/**
 * The catch-up file: `{ at, seen, taken }`, where `at` is the time of the last loop turn (null when there is none), `seen` maps a place id
 * to the last message id seen there, and `taken` maps the id of a message handled while its place's mark waited to the place. A file of
 * before T243 has no `taken`. Throws for a file that is not this user's 0600 file, a symlink or a file that the bridge did not write.
 */
export function loadAlive(path) {
  const text = readOwn(path, 'catch-up file');
  if (text === undefined) return { at: null, seen: new Map(), taken: new Map() };
  const bad = new TypeError(`the catch-up file ${path} is not a version 1 catch-up file that the bridge wrote. Delete it: the next catch-up then starts from now. Nothing was loaded.`);
  let data;
  try { data = JSON.parse(text); } catch { throw bad; }
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort().join() : '';
  const ids = (x) => x && typeof x === 'object' && !Array.isArray(x) && Object.entries(x).every(([k, v]) => SNOWFLAKE.test(k) && SNOWFLAKE.test(v));
  const taken = keys === 'at,seen,version' ? {} : data.taken;
  if (!['at,seen,version', 'at,seen,taken,version'].includes(keys) || data.version !== 1 || !(data.at === null || Number.isSafeInteger(data.at))
    || !ids(data.seen) || !ids(taken)) throw bad;
  return { at: data.at, seen: new Map(Object.entries(data.seen)), taken: new Map(Object.entries(taken)) };
}

/**
 * The catch-up of one bridge. `config` has statePath and ownerId (as src/crew.js ownerOf resolved it). The port (src/discord.js, or
 * src/fake-discord.js for the tests); `alive` is the file as loadAlive read it (default: read here):
 * - `places()`: `{ ids, threads, partial }`: `ids` the places that each run reads (the channels and the open request threads), `threads`
 *   the threads of the thread map, which a run reads only when one was made, or had a message, in the WINDOW before the gap (F-T241-12);
 *   `partial` when some places cannot be known now (the request file cannot be read): then no mark goes, and every mark waits until a run
 *   knows all the places;
 * - `fetch(place, after)`: at most PAGE messages of the place after the id `after`, in any order, each `{ id, forMe, user: { id },
 *   reply(payload), handle() }`: `forMe` when it mentions sage-bot and is not from a bot or a webhook, `handle` gives it to the normal
 *   mention path;
 * - `roles(user)`: the NAMES of the user's roles, read fresh from Discord (the crew may change while sage-bot is offline); null when the
 *   user is not a member now. The catch-up asks once for each author of a mention in a run; a failure leaves that place unread;
 * - `post(place, payload)`.
 * Returns:
 * - `beat()`: at each loop turn; a turn more than 2 loop turns after the last one starts a gap at the last one, unless no drop and no
 *   ready follows within PAUSE. While a place is unread, the first turn RETRY after the last run runs the catch-up again, and `beat`
 *   returns its promise;
 * - `down()`: the gateway is gone; the gap starts at the last turn, or at the start of a pause just before;
 * - `live(place, id, handle)`: each message that the gateway brings, with its handling; a message that the catch-up already handled
 *   is not handled again;
 * - `run()`: at each gateway ready; never rejects.
 */
export function createCatchUp({ config, places, fetch, roles, post, now = Date.now, log = (line) => process.stderr.write(`${line}\n`),
  alive = loadAlive(alivePathOf(config)) }) {
  const path = alivePathOf(config);
  let { at } = alive;
  // `taken`: message id → its place, the messages handled while their place's mark waits (a run waits or runs, or the place is unread).
  // It is in the file, so a restart does not answer them again (F-T241-11).
  const { seen, taken } = alive;
  let gapFrom = null; // the last turn before a gap that no run has caught up yet
  let pausedAt = null; // the turn that found a pause, while the pause may still become a gap (PAUSE)
  let runs = 0; // the runs that are queued or running
  let held = true; // the marks wait for a run: from the start, and from each drop of the gateway
  let chain = Promise.resolve();
  let unread = new Set(); // the places that the last run did not read (Discord refused, or the run failed first): their marks wait
  let behind = null; // while a run left places unread: the start of the earliest gap that it covered
  let tried = 0; // the time of the last run
  const say = (line) => log(forTerminal(line));
  const said = new Set();
  const sayOnce = (line) => { if (!said.has(line)) { said.add(line); say(line); } };
  const save = () => {
    try { writeWhole(path, `${JSON.stringify({ version: 1, at, seen: Object.fromEntries(seen), taken: Object.fromEntries(taken) })}\n`); } catch (e) {
      sayOnce(`the catch-up file ${path} could not be saved, so the next catch-up may answer a mention again: ${e?.message}`);
    }
  };
  /** Records that `id` of `place` is handled now, before its handling: a crash after this never answers it twice. */
  const take = (id, place) => { taken.set(id, place); save(); };
  /** Records `id` as seen in `place`; the mark never goes back. */
  const mark = (place, id) => { seen.set(place, newest(seen.get(place), id)); save(); };
  const handled = (place, id) => taken.has(id) || (seen.has(place) && BigInt(id) <= BigInt(seen.get(place)));

  /** Reads every message of `place` after `after`, oldest first; null when Discord refused (logged once). */
  async function read(place, after) {
    const all = [];
    try {
      for (;;) {
        const page = [...await fetch(place, after)].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        all.push(...page);
        if (page.length < PAGE) return all;
        after = page.at(-1).id;
      }
    } catch (e) {
      sayOnce(`the catch-up could not read the messages of ${place}${e?.code === 50001 || e?.code === 50013 ? ': sage-bot needs View Channel and Read Message History there' : ''}: ${apiError(e)}`);
      return null;
    }
  }

  async function catchUp(from, to) {
    unread = new Set(seen.keys()); // until the places are known, every mark waits
    const { ids, threads = [], partial } = places();
    // A thread of the map is read when it was made, or had a message seen, in the WINDOW before the gap; a quiet one loses its mark.
    const active = (t) => timeOf(newest(t, seen.get(t) ?? t)) >= from - WINDOW;
    const watched = new Set([...ids, ...threads.filter(active)]);
    // A place that is gone, or not watched now, loses its mark; while some places cannot be known, every mark stays and waits.
    if (!partial) for (const place of seen.keys()) if (!watched.has(place)) { seen.delete(place); unread.delete(place); }
    // With no mark, nothing older than the gap: a place that is new, or the first run (no heartbeat: from now). That start becomes the
    // mark at once, so a run after a refused read, or after this run failed, still starts there.
    for (const place of watched) {
      unread.add(place);
      if (!seen.has(place)) mark(place, idAt(from));
    }
    // Each author's roles, read fresh once in this run: a member that the crew lost or gained while sage-bot was offline counts as now.
    const rolesNow = new Map();
    const crew = async (id) => {
      if (!rolesNow.has(id)) rolesNow.set(id, roles(id));
      const names = await rolesNow.get(id);
      if (names === null) return false; // not a member now: nothing, with no word
      const p = placeOf(id, names, config.ownerId);
      return p.crew || p.owner;
    };
    for (const place of watched) {
      const got = await read(place, seen.get(place));
      if (got === null) continue; // it stays unread: its mark waits for a run that reads it
      const picked = [];
      try {
        for (const m of got) if (m.forMe && !handled(place, m.id) && await crew(m.user.id)) picked.push(m); // anyone else: nothing, as in the mention path
      } catch (e) { // as a refused read: this place waits, the others go on (F-T241-10)
        sayOnce(`the catch-up could not read the roles of a member in ${place}; it tries again in ${RETRY / 60_000} minutes: ${apiError(e)}`);
        continue;
      }
      const old = new Set(picked.filter((m) => timeOf(m.id) < to - WINDOW));
      if (picked.length) {
        await post(place, { content: offlineLine(from, to, picked.length - old.size, old.size), allowedMentions: NO_MENTIONS })
          .catch((e) => say(`Discord refused the catch-up line in ${place}: ${apiError(e)}`));
      }
      const told = new Set(); // the people who got OLD in this place in this run
      for (const m of picked) {
        if (handled(place, m.id)) continue; // the gateway brought it meanwhile
        take(m.id, place);
        if (!old.has(m)) await m.handle();
        else if (!told.has(m.user.id)) {
          told.add(m.user.id);
          await m.reply({ content: OLD, allowedMentions: AUTHOR_ONLY }).catch((e) => say(`Discord refused the reply to an old mention in ${place}: ${apiError(e)}`));
        }
        mark(place, m.id); // so a later run skips it, also after a crash
      }
      if (got.length) mark(place, got.at(-1).id);
      unread.delete(place);
    }
  }

  /** Runs the catch-up of the gap from `from` to now, after the runs before it. Never rejects. */
  function start(from) {
    runs++;
    held = false;
    const to = now();
    tried = to;
    at = to; // this run covers the gap up to now, so a turn just after it starts none
    save();
    chain = chain.then(() => catchUp(from, to)).then(() => !unread.size, (e) => {
      say(`the catch-up failed; it tries again in ${RETRY / 60_000} minutes: ${e?.message}`);
      return false;
    }).then((done) => {
      behind = done ? null : Math.min(behind ?? from, from);
      if (--runs || held) return; // a drop during the run: the next run reads the gap, and the marks wait for it
      for (const [id, place] of taken) if (!unread.has(place)) { taken.delete(id); mark(place, id); }
    });
    return chain;
  }

  return {
    beat() {
      const t = now();
      if (at !== null && t - at > 2 * LOOP) { gapFrom ??= at; pausedAt = t; }
      else if (!held && pausedAt !== null && t - pausedAt > PAUSE) gapFrom = pausedAt = null; // the gateway stayed up: nothing was missed
      at = t;
      save();
      return behind !== null && !runs && !held && t - tried >= RETRY ? start(behind) : undefined;
    },
    down() { gapFrom ??= at; held = true; },
    async live(place, id, handle) {
      if (handled(place, id)) return;
      take(id, place);
      await handle();
      // From a drop to the end of the next run, and in a place that no run has read since, the mark waits: a mark past a message that
      // a run has still to read would skip it.
      if (!runs && !held && !unread.has(place)) { taken.delete(id); mark(place, id); }
    },
    run() {
      const from = gapFrom ?? at ?? now();
      gapFrom = pausedAt = null;
      return start(from);
    },
  };
}
