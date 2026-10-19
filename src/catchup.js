// The catch-up (T241, R918 C9): when the Mac slept or the gateway dropped, Discord does not send the messages of that time again, so
// sage-bot reads them back at each gateway ready (the first ready, and each ready or resume after it: a sleep does not restart the process).
// For each place that it watches (each registered channel, each thread of the thread map, each thread of an open request), it reads the
// messages after the last one that it saw there, and gives each mention of the crew or the owner to the normal mention path, in order. A
// mention older than WINDOW gets one reply in place instead (OLD). A place where it picked something up gets one line that says so.
// The file is <statePath>.alive, beside the gate file and safe like it (0600, written whole, read with no symlink): the time of the
// last loop turn (the heartbeat) and the last message id seen in each place. Its only writer is this module, in the bridge's process.
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
/** A reply in place that pings nobody, also not the person it replies to. */
const QUIET = { ...NO_MENTIONS, repliedUser: false };
/** Discord gives at most this many messages per read. */
export const PAGE = 100;
const SNOWFLAKE = /^\d{17,20}$/;
const EPOCH = 1420070400000n; // Discord's epoch: a message id holds its time in ms since then, shifted 22 bits
/** The time of a Discord id, in ms. */
export const timeOf = (id) => Number((BigInt(id) >> 22n) + EPOCH);
/** The smallest Discord id at `ms`: a read "after" it starts at that time. */
export const idAt = (ms) => String((BigInt(Math.floor(ms)) - EPOCH) << 22n);
const newest = (a, b) => (a === undefined || BigInt(b) > BigInt(a) ? b : a);

/** The catch-up file of a config: `<statePath>.alive`. */
export const alivePathOf = ({ statePath }) => `${statePath}.alive`;

/**
 * The catch-up file: `{ at, seen }`, where `at` is the time of the last loop turn (null when there is none) and `seen` maps a place id to
 * the last message id seen there. Throws for a file that is not this user's 0600 file, a symlink or a file that the bridge did not write.
 */
export function loadAlive(path) {
  const text = readOwn(path, 'catch-up file');
  if (text === undefined) return { at: null, seen: new Map() };
  const bad = new TypeError(`the catch-up file ${path} is not a version 1 catch-up file that the bridge wrote. Delete it: the next catch-up then starts from now. Nothing was loaded.`);
  let data;
  try { data = JSON.parse(text); } catch { throw bad; }
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort().join() : '';
  if (keys !== 'at,seen,version' || data.version !== 1 || !(data.at === null || Number.isSafeInteger(data.at))
    || !data.seen || typeof data.seen !== 'object' || Array.isArray(data.seen)
    || !Object.entries(data.seen).every(([k, v]) => SNOWFLAKE.test(k) && SNOWFLAKE.test(v))) throw bad;
  return { at: data.at, seen: new Map(Object.entries(data.seen)) };
}

/**
 * The catch-up of one bridge. `config` has statePath and ownerId (as src/crew.js ownerOf resolved it). The port (src/discord.js, or
 * src/fake-discord.js for the tests); `alive` is the file as loadAlive read it (default: read here):
 * - `places()`: the ids of the watched places now;
 * - `fetch(place, after)`: at most PAGE messages of the place after the id `after`, in any order, each `{ id, forMe, user: { id }, roles,
 *   reply(payload), handle() }`: `forMe` when it mentions sage-bot and is not from a bot or a webhook, `roles` the NAMES of the author's
 *   roles, `handle` gives it to the normal mention path;
 * - `post(place, payload)`.
 * Returns:
 * - `beat()`: at each loop turn; a turn more than 2 loop turns after the last one starts a gap at the last one;
 * - `down()`: the gateway is gone; the gap starts at the last turn;
 * - `live(place, id, handle)`: each message that the gateway brings, with its handling; a message that the catch-up already handled
 *   is not handled again;
 * - `run()`: at each gateway ready; never rejects.
 */
export function createCatchUp({ config, places, fetch, post, now = Date.now, log = (line) => process.stderr.write(`${line}\n`),
  alive = loadAlive(alivePathOf(config)) }) {
  const path = alivePathOf(config);
  let { at } = alive;
  const { seen } = alive;
  let gapFrom = null; // the last turn before a gap that no run has caught up yet
  let runs = 0; // the runs that are queued or running
  let held = true; // the marks wait for a run: from the start, and from each drop of the gateway
  let chain = Promise.resolve();
  const taken = new Map(); // message id → its place: the messages that the gateway brought while a run waits or runs
  const say = (line) => log(forTerminal(line));
  const said = new Set();
  const sayOnce = (line) => { if (!said.has(line)) { said.add(line); say(line); } };
  const save = () => {
    try { writeWhole(path, `${JSON.stringify({ version: 1, at, seen: Object.fromEntries(seen) })}\n`); } catch (e) {
      sayOnce(`the catch-up file ${path} could not be saved, so the next catch-up may answer a mention again: ${e?.message}`);
    }
  };
  /** Records `id` as seen in `place`; the mark never goes back. */
  const mark = (place, id) => { seen.set(place, newest(seen.get(place), id)); save(); };
  const handled = (place, id) => taken.has(id) || (seen.has(place) && BigInt(id) <= BigInt(seen.get(place)));
  const crew = (m) => { const p = placeOf(m.user.id, m.roles ?? [], config.ownerId); return p.crew || p.owner; };

  /** Reads every message of `place` after `after`, oldest first; null when Discord refused (logged once). */
  async function read(place, after) {
    const all = [];
    try {
      for (let page; !page || page.length === PAGE; after = all.at(-1).id) {
        page = [...await fetch(place, after)].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        all.push(...page);
      }
    } catch (e) {
      sayOnce(`the catch-up could not read the messages of ${place}${e?.code === 50001 || e?.code === 50013 ? ': sage-bot needs View Channel and Read Message History there' : ''}: ${apiError(e)}`);
      return null;
    }
    return all;
  }

  async function catchUp(from, to) {
    const watched = new Set(places());
    for (const place of seen.keys()) if (!watched.has(place)) seen.delete(place); // a place that is gone, or not watched now
    for (const place of watched) {
      // With no mark, nothing older than the gap: a place that is new, or the first run (no heartbeat: from now).
      const got = await read(place, seen.get(place) ?? idAt(from ?? to));
      if (!got?.length) continue;
      const picked = got.filter((m) => m.forMe && crew(m) && !handled(place, m.id)); // anyone else: nothing, as in the mention path
      if (picked.length) {
        const n = picked.length;
        await post(place, { content: `I was offline from ${stamp(from ?? to)} to ${stamp(to)}. I picked up ${n} message${n === 1 ? '' : 's'}.`, allowedMentions: NO_MENTIONS })
          .catch((e) => say(`Discord refused the catch-up line in ${place}: ${apiError(e)}`));
      }
      for (const m of picked) {
        if (handled(place, m.id)) continue; // the gateway brought it meanwhile
        taken.set(m.id, place);
        if (timeOf(m.id) < to - WINDOW) await m.reply({ content: OLD, allowedMentions: QUIET }).catch((e) => say(`Discord refused the reply to an old mention in ${place}: ${apiError(e)}`));
        else await m.handle();
        mark(place, m.id); // so a later run skips it, also after a crash
      }
      mark(place, got.at(-1).id);
    }
  }

  return {
    beat() {
      const t = now();
      if (at !== null && t - at > 2 * LOOP) gapFrom ??= at;
      at = t;
      save();
    },
    down() { gapFrom ??= at; held = true; },
    async live(place, id, handle) {
      if (handled(place, id)) return;
      taken.set(id, place);
      await handle();
      // From a drop to the end of the next run, the mark waits: a mark past a message that the run has still to read would skip it.
      if (!runs && !held) { taken.delete(id); mark(place, id); }
    },
    run() {
      runs++;
      held = false;
      const from = gapFrom ?? at;
      gapFrom = null;
      const to = now();
      at = to; // this run covers the gap up to now, so a turn just after it starts none
      save();
      chain = chain.then(() => catchUp(from, to)).catch((e) => say(`the catch-up failed; it runs again at the next gateway ready: ${e?.message}`)).finally(() => {
        if (--runs || held) return; // a drop during the run: the next run reads the gap, and the marks wait for it
        for (const [id, place] of taken) mark(place, id);
        taken.clear();
      });
      return chain;
    },
  };
}
