// /sage request on Discord (T72 PR 3, T228; T229 folded in): the form, the private confirm, the line in the channel with one thread per
// request, the card with Approve, Decline and Withdraw, and the sync loop that keeps each line and card as the requests file says.
// Every rule of a request is in src/requests.js, every message in src/requestCards.js; this file only wires them to Discord.
// Who may do what (src/crew.js): the crew and the owner request; only the owner (`ownerId`, by user id, never a role) approves or
// declines; only the requester withdraws, while the request waits. Anyone else gets notCrew, privately.
// A press is trusted only through the server side (R918 C2): its custom_id must parse (an allow-list), the request must be in the file,
// a card button must be on the request's own card message, and the status must still take the move, so a forged or replayed id does
// nothing. A draft lives only in memory, for its own person, and goes at its send or cancel: single use.
import { randomInt } from 'node:crypto';
import { MessageFlags } from 'discord.js';
import { apiError } from './bridge.js';
import { cut, ephemeral, LIMIT, safe } from './cards.js';
import { namesOf, notCrew, placeOf } from './crew.js';
import { forTerminal } from './clean.js';
import { killPathOf, linkOff } from './audit.js';
import {
  confirmMessage, decidedPost, declineModal, expired, parseRequestId, requestCard, requestLine, requestModal, requestNote,
  requestThreadName, withdrawConfirm,
} from './requestCards.js';
import { addRequest, approve, decline, find, loadRequests, MAX_NAME, reconcile, Refused, requestsPathOf, setDiscord, withdraw } from './requests.js';

const SNOWFLAKE = /^\d{17,20}$/;
/** How long a draft's confirm works after the form, and a withdraw confirm after its press. */
export const CONFIRM_FOR = 10 * 60_000;
const OPEN = ['pending', 'approving'];
/** Discord's codes for a place or a message that is gone, or a locked thread: an edit there can never work. */
const NO_EDIT = new Set([10003, 10008, 50001, 50083]);
/** A private message as the new content of a private message (an update keeps the flags of the message). */
const plain = ({ flags, ...payload }) => ({ components: [], embeds: [], ...payload });

/**
 * The request side of one bridge. `config` has ownerId (as src/crew.js ownerOf resolved it) and statePath; `channels` is the registry;
 * `projects` are the bridge's (loadProjects). `discord` is the port `{ post(target, payload) → id, edit(target, id, payload),
 * startThread(channel, lineId, name) → id, threadFrom(channel, lineId) → id, unarchive(thread) }` (src/discord.js, or src/fake-discord.js for the tests).
 * `tool(r)` gives the state tool of a request (default: its project's, src/requests.js toolOf); the tests give one with a scratch HOME.
 * `newKey` makes the key of a draft: a random one by default, so a key is hard to guess; the demo gives fixed ones.
 */
export function createRequestFlow({ config, channels, projects, discord, now = Date.now, log = (line) => process.stderr.write(`${line}\n`), tool,
  newKey = () => `D${randomInt(1, 2 ** 47)}` }) {
  const path = requestsPathOf(config);
  const killPath = killPathOf(config);
  const toolOf = (r) => tool?.(r);
  const say = (line) => log(forTerminal(line));
  const said = new Set();
  const sayOnce = (line) => { if (!said.has(line)) { said.add(line); say(line); } };
  const place = (x) => placeOf(x.user.id, x.roles ?? [], config.ownerId);
  const us = namesOf(config); // the names of the owner and of this bot in the copy (T244)
  const drafts = new Map(); // draft key → { key, user, name, project, channel, title, text, at }; only in memory
  /** What each open card last showed: its status, and whether the link was off. Only in memory, so a restart draws each open card once. */
  const drawn = new Map();
  const view = (r, off) => `${r.status}${off && r.status === 'pending' ? ' off' : ''}`;
  const load = () => loadRequests(path);
  const mine = (user) => load().requests.find((r) => r.requester === user && OPEN.includes(r.status));
  const tooLong = (name) => !Array.from(name).length || Array.from(name).length > MAX_NAME;

  // ---- Drawing: the line, the thread and the card of one request, as the file says. One draw at a time, so the loop and a press
  // never post two lines or two cards for one request. ----
  // A failed draw is logged here once (a refusal of Discord in `call`), and the loop draws it again at its next turn.
  let chain = Promise.resolve();
  const draw = (id) => {
    const run = chain.then(() => drawNow(id)).catch((e) => {
      if (!logged.has(e)) sayOnce(`${id} is not on Discord as the requests file says yet; the loop tries again: ${e?.message ?? e}`);
      throw e;
    });
    chain = run.catch(() => {});
    return run;
  };
  const logged = new WeakSet(); // the errors that `call` logged
  /** A call to Discord; an error is logged once with its code (never the token: apiError) and thrown, unless `done` takes its code. */
  async function call(what, fn, done = () => false) {
    try { return await fn(); } catch (e) {
      sayOnce(`Discord refused ${what}: ${apiError(e)}`);
      if (done(e?.code)) return null;
      if (Object(e) === e) logged.add(e);
      throw e;
    }
  }
  /**
   * Each post once, also when the file or Discord fails right after it (F-T228-6, F-T228-4). A post whose id the file has not taken yet
   * stays in `unsaved`, so the next draw only writes it again; and Discord gives back the message of a nonce that it took in the last few
   * minutes, so a post whose reply was lost, or that a restart cut off from its write, is not posted again.
   */
  const unsaved = new Map(); // `<id>:<what>` → the id that Discord gave; only in memory
  async function once(key, post, write) {
    if (!unsaved.has(key)) unsaved.set(key, await post(key));
    const r = write(unsaved.get(key));
    unsaved.delete(key);
    return r;
  }
  const send = (what, target, payload, nonce, done) => call(what, () => discord.post(target, { ...payload, nonce, enforceNonce: true }), done);
  /** An edit. Discord refuses an edit in a thread that it archived after a quiet week (50083, F-T228-8): the thread opens again first. */
  const edit = (what, target, message, payload) => call(`the edit of ${what}`, () => discord.edit(target, message, payload).catch(async (e) => {
    if (e?.code !== 50083) throw e;
    try { await discord.unarchive(target); } catch { throw e; } // a locked thread stays as it is
    return discord.edit(target, message, payload);
  }), (c) => NO_EDIT.has(c));
  async function drawNow(id) {
    let r = find(load(), id);
    if (!r.channel) return r;
    const off = linkOff(killPath);
    if (!r.line) r = await once(`${id}:line`, (n) => send(`the line of ${id}`, r.channel, requestLine(r, { us, linkOff: off }), n), (line) => setDiscord(config, id, { line }));
    if (!r.thread) {
      // Code 160004: the line has its thread already, but the reply that named it was lost.
      r = await once(`${id}:thread`, () => call(`the thread of ${id}`, () => discord.startThread(r.channel, r.line, requestThreadName(r)).catch((e) => {
        if (e?.code === 160004) return discord.threadFrom(r.channel, r.line);
        throw e;
      })), (thread) => setDiscord(config, id, { thread }));
    }
    if (!r.card) {
      // The first post of the card pings the owner once (only while it waits and the link is on: requestCard).
      r = await once(`${id}:card`, (n) => send(`the card of ${id}`, r.thread, requestCard(r, { ownerId: config.ownerId, us, linkOff: off, ping: true }), n),
        (card) => setDiscord(config, id, { card, ...(OPEN.includes(r.status) && { shown: r.status }) }));
      drawn.set(id, view(r, off));
    }
    if (drawn.get(id) === view(r, off) && r.shown === r.status) return r;
    await edit(`the line of ${id}`, r.channel, r.line, requestLine(r, { us, linkOff: off }));
    await edit(`the card of ${id}`, r.thread, r.card, requestCard(r, { ownerId: config.ownerId, us, linkOff: off }));
    const shown = () => setDiscord(config, id, { shown: r.status });
    if (!OPEN.includes(r.status) && r.shown !== r.status) {
      r = await once(`${id}:${r.status}`, (n) => send(`the post after the decision of ${id}`, r.thread, decidedPost(r, us), n, (c) => NO_EDIT.has(c)), shown);
    } else if (r.shown !== r.status) r = shown();
    drawn.set(id, view(r, off));
    return r;
  }

  // ---- The presses ----
  /** Answers a press with a private note; a refusal of Discord is logged. */
  const answer = (i, payload, how = 'reply') => i[how](payload).catch((e) => say(`Discord refused a request reply: ${apiError(e)}`));
  /** The note for a Refused of src/requests.js; any other error is logged and gets a fixed line, so no path reaches Discord (F-T228-5). */
  const failed = (e, id) => {
    if (e instanceof Refused) return ephemeral(cut(forTerminal(e.message), LIMIT.content));
    say(`${id}: ${e?.message ?? e}`);
    return requestNote('broken', us);
  };

  async function draftPress(i, { action, id: key }) {
    const d = drafts.get(key);
    if (!d || d.user !== i.user.id) return answer(i, requestNote('gone', us));
    if (action === 'edit') return answer(i, requestModal(key, d), 'showModal');
    if (action === 'cancel') { drafts.delete(key); return answer(i, plain(requestNote('cancelled', us)), 'update'); }
    if (action === 'form') {
      Object.assign(d, { title: String(i.fields?.getTextInputValue('title') ?? ''), text: String(i.fields?.getTextInputValue('text') ?? ''), at: now() });
      // The form of an Edit came from the confirm: the confirm changes in place. The first form came from the command: a new reply.
      return i.message?.id ? answer(i, plain(confirmMessage(key, d, us)), 'update') : answer(i, confirmMessage(key, d, us));
    }
    // Send: the crew votes on the design questions, or the owner decides them.
    if (d.title === undefined || !(now() - d.at <= CONFIRM_FOR)) return answer(i, plain(expired(key)), 'update');
    try { await i.deferUpdate(); } catch (e) { say(`Discord refused to defer a request send: ${apiError(e)}`); return; }
    let out;
    try {
      const open = mine(d.user);
      const p = projects.find((x) => x.name === d.project);
      if (linkOff(killPath)) out = requestNote('linkOff', us);
      else if (open) out = requestNote('open', us, open);
      else if (tooLong(d.name)) out = requestNote('name', us, { requesterName: d.name });
      else if (!p) out = ephemeral(`The project ${d.project} is no longer served here. Nothing was sent.`);
      else {
        const r = addRequest(config, { project: p.name, folder: p.project, title: d.title, text: d.text, designQuestions: action === 'send-team' ? 'team' : 'owner',
          requester: d.user, requesterName: d.name, channel: d.channel }, now());
        drafts.delete(key);
        say(`${r.id}: ${d.user} requested a feature in ${p.name}; it waits for the owner (node scripts/requests.mjs show ${r.id})`);
        let shown = r;
        try { shown = await draw(r.id); } catch { /* the loop draws it again */ }
        out = requestNote('sent', us, shown);
      }
    } catch (e) { out = failed(e, key); }
    await answer(i, plain(out), 'editReply');
  }

  async function requestPress(i, { action, id }, me) {
    let r;
    try { r = find(load(), id); } catch (e) { return answer(i, failed(e, id)); }
    // A button of the card counts only on the card's own message (R918 C2); the decline form comes from that button.
    if (['approve', 'decline', 'withdraw', 'decline!'].includes(action) && (!r.card || i.message?.id !== r.card)) return answer(i, requestNote('notCard', us, r));
    if (['approve', 'decline', 'decline!'].includes(action) && !me.owner) return answer(i, requestNote('notOwner', us, r));
    if (['withdraw', 'withdraw!', 'keep'].includes(action) && i.user.id !== r.requester) return answer(i, requestNote('notRequester', us, r));
    if (action === 'keep') return answer(i, plain(requestNote('kept', us, r)), 'update');
    if (r.status !== 'pending') {
      const note = requestNote('late', us, r);
      return action === 'withdraw!' ? answer(i, plain(note), 'update') : answer(i, note);
    }
    if (action === 'decline') return answer(i, declineModal(r), 'showModal');
    if (action === 'withdraw') return answer(i, withdrawConfirm(r, us));
    if (action === 'withdraw!' && !(now() - i.message?.createdTimestamp <= CONFIRM_FOR)) {
      return answer(i, plain(ephemeral(`This confirm expired after 10 minutes. Nothing changed. Press Withdraw on the card again.`)), 'update');
    }
    // approve, decline! and withdraw! change the file and can take long (approve runs the state tool): first the defer, within 3 s.
    const update = action === 'withdraw!';
    try { await (update ? i.deferUpdate() : i.deferReply({ flags: MessageFlags.Ephemeral })); } catch (e) {
      say(`Discord refused to defer a request press: ${apiError(e)}`);
      return;
    }
    let out;
    try {
      const by = i.user.id;
      const after = action === 'approve' ? await approve(config, id, { by, via: 'discord', tool: toolOf(r), now })
        : action === 'decline!' ? await decline(config, id, { by, via: 'discord', reason: String(i.fields?.getTextInputValue('reason') ?? ''), at: now() })
        : await withdraw(config, id, { by, at: now() });
      out = requestNote({ approve: 'approved', 'decline!': 'declined', 'withdraw!': 'withdrawn' }[action], us, after);
    } catch (e) {
      // A move that the status no longer takes (another press or the terminal came first): the late note, with the time.
      let latest = null;
      try { latest = find(load(), id); } catch { /* the note below */ }
      out = e instanceof Refused && latest && latest.status !== 'pending' ? requestNote('late', us, latest) : failed(e, id);
    }
    try { await draw(id); } catch { /* the loop draws it again */ }
    await answer(i, plain(out), 'editReply'); // an edit keeps the message private: it takes no flags
  }

  return {
    /**
     * /sage request in the registered channel `at` (or a thread of it): `{ user: { id }, name, roles, options: { project }, reply, showModal }`.
     * The caller (src/ask.js) has checked the crew and the hourly limit. The form opens at once, with no defer: Discord takes a form only
     * as the first answer. Refused while the link is off, while the person has an open request, and for a name that the file cannot keep.
     */
    async command(i, at) {
      const project = i.options?.project ?? channels.get(at)?.project;
      const open = (() => { try { return mine(i.user.id); } catch (e) { say(`the requests file: ${e?.message}`); return null; } })();
      const note = linkOff(killPath) ? requestNote('linkOff', us)
        : !projects.some((p) => p.name === project) ? ephemeral(`I do not know a shared project called "${safe(cut(String(project), 40))}". Nothing was sent.`)
        : open ? requestNote('open', us, open)
        : tooLong(i.name ?? '') ? requestNote('name', us, { requesterName: i.name ?? '' }) : null;
      if (note) return answer(i, note);
      for (const [k, d] of drafts) if (d.user === i.user.id || !(now() - d.at <= CONFIRM_FOR)) drafts.delete(k); // one draft each
      const key = newKey();
      drafts.set(key, { key, user: i.user.id, name: i.name, project, channel: at, at: now() });
      return answer(i, requestModal(key), 'showModal');
    },
    /**
     * A press or a form of a request (a custom_id `rq1:…`): `{ user: { id, bot }, roles, customId, message: { id, createdTimestamp } | null,
     * fields, reply, update, showModal, deferReply, deferUpdate, editReply }`. Anything else, and a bot, get nothing. Never rejects.
     */
    async interaction(i) {
      const pressed = parseRequestId(i.customId);
      if (!pressed || i.user?.bot || !SNOWFLAKE.test(i.user?.id ?? '')) return;
      const me = place(i);
      if (!me.crew && !me.owner) return answer(i, ephemeral(notCrew(us)));
      try {
        await (/^D/.test(pressed.id) ? draftPress(i, pressed) : requestPress(i, pressed, me));
      } catch (e) { say(`a request press: ${e?.message}`); }
    },
    /**
     * One turn of the sync loop (T229): settles each claim whose approve no longer runs (also this bridge's own failed approve, and a
     * claim of the process before a restart: src/requests.js reconcile), then draws each request whose line or card is not as the file
     * says: a decision at the terminal, a new status, the link turned off or on. Never rejects.
     */
    async loop() {
      let file;
      try { file = load(); } catch (e) { sayOnce(`the requests file cannot be read, so no request is shown: ${e?.message}`); return; }
      for (const r of file.requests.filter((x) => x.status === 'approving')) {
        try { await reconcile(config, r.id, { at: now(), tool: toolOf(r) }); } catch (e) { sayOnce(`${r.id}: its claim cannot be settled yet: ${e?.message}`); }
      }
      const off = linkOff(killPath);
      for (const r of load().requests) {
        const due = r.channel && (!r.card || r.shown !== r.status || (OPEN.includes(r.status) && drawn.get(r.id) !== view(r, off)));
        if (due) await draw(r.id).catch(() => {}); // logged in `draw`; tried again at the next turn
      }
    },
    /** The threads of the open requests, for the catch-up (T241); null while the file cannot be read (the loop logs why): unknown, not none. */
    threads: () => { try { return load().requests.filter((r) => OPEN.includes(r.status) && r.thread).map((r) => r.thread); } catch { return null; } },
    /** The open requests of a project (its name and folder), oldest first, for /sage board. */
    waiting: (p) => load().requests.filter((r) => r.project === p.name && r.folder === p.project && OPEN.includes(r.status)),
  };
}
