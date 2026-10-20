// The outbox on Discord (T247, issue 60 PR 7): the approval card of a crew member's message to sage, in the thread of the message, with
// Approve, Decline and Withdraw and the exact payload as payload.txt; the status line in the thread when the state changes; and the
// sync loop that posts each card and line that the outbox file holds and Discord does not show yet, and withdraws a waiting message whose
// thread or card is gone on Discord (F-T247-16), with one line in the home channel. Every rule of a message is in
// src/outbox.js; src/ask.js decides where a message goes (its thread) and calls `send`. Nothing here sends anything to a model.
// Who may do what (src/crew.js): only the owner (`ownerId`, by user id, never a role) approves or declines (R918 C1); only the sender
// withdraws, while the message waits. Anyone else gets notCrew, privately.
// A press is trusted only through the server side (R918 C2): its custom_id must parse (an allow-list), the message must be in the outbox,
// the button must be on the message's own card, and the status must still take the move, so a forged or replayed press does nothing.
// Who reads the card: people on Discord only. The text and the names show through `safe` and `cut`; the model reads only the payload.
import { MessageFlags } from 'discord.js';
import { forLead, forwarded, quoted, recorder } from './audit.js';
import { apiError } from './bridge.js';
import { button, cut, ephemeral, LIMIT, NO_MENTIONS, offline, safe, safeOf, stamp } from './cards.js';
import { CREW, isOwner, namesOf, notCrew, personName, placeOf } from './crew.js';
import { forTerminal } from './clean.js';
import { ActionRowBuilder, ButtonStyle } from 'discord.js';
import {
  addMessage, auditFields, CONTEXT, decide, find, GONE, SHUT_OUT, loadOutbox, MESSAGE_ID, outboxPathOf, Refused, refusalOf, setDiscord, short, windowOf, withNames,
} from './outbox.js';

const SNOWFLAKE = /^\d{17,20}$/;
/** Discord's codes for a place (Unknown Channel) or a message (Unknown Message) that is gone. */
const LOST = new Set([10003, 10008]);
/** Discord's codes for a place that sage-bot cannot see (Missing Access), or a locked thread. */
const SHUT = new Set([50001, 50083]);
/** LOST or SHUT: an edit or a post there can never work. */
const NO_EDIT = new Set([...LOST, ...SHUT]);
/** Discord's code for a right that sage-bot lacks in a place (Missing Permissions): for a card, most often Attach Files (F-T247-4). */
const NO_PERMISSION = 50013;
/** At most this many pages of 100 messages are read for the context of one message (bots and webhooks are skipped in them). */
export const PAGES = 3;
const COLOR = { pending: 0x6b4fd8, approved: 0x2e8b57, declined: 0xb33a3a, withdrawn: 0x8a8a8a };

/** The custom_id of a button of an approval card: `ob1:<action>:<message id>`. `ob1` is the version of this format. */
const ACTIONS = ['approve', 'decline', 'withdraw'];
export function outboxId(action, mid) {
  if (!ACTIONS.includes(action) || !MESSAGE_ID.test(mid)) throw new TypeError(`no outbox custom_id for ${action} ${mid}`);
  return `ob1:${action}:${mid}`;
}
/** The action and message id of an outbox custom_id, or null for anything else. */
export function parseOutboxId(text) {
  const m = /^ob1:([a-z]+):(M\d+)$/.exec(String(text));
  if (!m) return null;
  try { return outboxId(m[1], m[2]) === text ? { action: m[1], id: m[2] } : null; } catch { return null; }
}

/** The label of a place for the payload and the card: 'owner', 'crew' or 'not crew' (src/crew.js placeOf). */
export const placeLabel = (p) => (p.owner ? 'owner' : p.crew ? 'crew' : 'not crew');
/** A Discord name for the record: src/crew.js personName, else "member" and the last 4 digits of the id (never the raw id). */
export const nameFor = (name, user) => personName(name) || `member ${String(user).slice(-4)}`;
/** The sender as the card shows it, with the person whose message they send when it is not theirs. */
const fromLine = (r) => `${safe(r.name)} (${r.place})${r.quote ? `, sending the message of ${safe(r.quote.name)} (${r.quote.place})` : ''}`;
const kb = (r) => (Buffer.byteLength(r.payload) / 1024).toFixed(1);
const earlier = (n) => `${n} earlier message${n === 1 ? '' : 's'}`;
/** The context as the card counts it, with the messages of people outside the crew (F-T247-2): the risk the owner judges on a phone. */
const contextLine = (r) => {
  const outside = r.context.filter((c) => c.place === 'not crew').length;
  return `with ${earlier(r.context.length)}${outside ? ` (${outside} from not crew)` : ''}, ${kb(r)} KB, see payload.txt`;
};
/** A text as the card shows it: `safeOf` with backticks shown escaped, so that a code span hides nothing (F-T247-30). */
const shownOf = (text) => safeOf(text, { backticks: true });
/**
 * The text of a message as the card shows it to people: its mentions as names (src/outbox.js withNames, F-T247-3), then `shownOf`: the
 * text and the code points that it drops. The payload keeps the raw text.
 */
const cardText = (r) => shownOf(withNames(r));
/** At most this many different hidden code points are named for one message, and this many messages on the Hidden field (F-T247-36). */
const NAMED = { codes: 8, messages: 4 };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const codeOf = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
/**
 * The hidden characters of a message (F-T247-25, F-T247-29, F-T247-32, F-T247-36): exactly the code points that the card drops, by the
 * allow-list of `safe`, from the card text and from each context text (the card shows no context text, but sage reads it). One line
 * for each message that has any, with whose words they are and each different code point by name: "1 hidden character in Sam's message
 * (not crew): U+200B". The text of a forwarded message is its writer's. A field when there is one or more.
 */
const hiddenField = (r, shown) => {
  const found = [[r.quote ?? r, shown.dropped], ...r.context.map((c) => [c, shownOf(c.text).dropped])].filter(([, d]) => d.length);
  if (!found.length) return [];
  const line = ([who, d]) => {
    const codes = [...new Set(d.map(codeOf))];
    const more = codes.length > NAMED.codes ? ` and ${codes.length - NAMED.codes} more` : '';
    return `${plural(d.length, 'hidden character')} in ${safe(who.name)}'s message (${who.place}): ${codes.slice(0, NAMED.codes).join(', ')}${more}`;
  };
  const rest = found.length - NAMED.messages;
  const lines = [...found.slice(0, NAMED.messages).map(line), ...(rest > 0 ? [`and hidden characters in ${plural(rest, 'more message')}`] : [])];
  return [{ name: 'Hidden', value: cut(lines.join('\n'), LIMIT.value) }];
};
/** The exact payload as a file of the card. */
const payloadFile = (r) => ({ attachment: Buffer.from(r.payload, 'utf8'), name: 'payload.txt' });

/**
 * The approval card of a message, in its thread. While it waits: Approve, Decline and Withdraw, and the first post pings the owner once
 * (`ping`); decided: no buttons. The payload goes once, as payload.txt, with the first post; an edit keeps it (discord.js keeps the
 * attachments of a message that an edit does not name).
 * @param {object} r  a record of src/outbox.js  @param {{ ownerId: string, us: { owner: string, Owner: string, bot: string }, ping?: boolean }} o
 */
export function outboxCard(r, { ownerId, us, ping = false }) {
  const open = r.status === 'pending';
  const status = {
    pending: `Waiting for ${us.owner}`,
    approved: `**Approved by ${us.owner} at ${stamp(r.decidedAt)}.** It waits for sage sessions (T159).`,
    declined: `**Declined by ${us.owner} at ${stamp(r.decidedAt)}.**${reasonOf(r)} Nothing goes to sage.`,
    withdrawn: `**Withdrawn by ${decider(r, us)} at ${stamp(r.decidedAt)}.**${reasonOf(r)} Nothing goes to sage.`,
  }[r.status];
  const shown = cardText(r);
  const embed = {
    title: cut(`Message ${r.id} to sage · ${r.task ? `${r.kind} of ${r.task}` : r.kind} · ${safe(r.project)}`, LIMIT.title),
    description: cut(shown.text || '(no visible text: see payload.txt)', 1000),
    fields: [
      { name: 'From', value: cut(fromLine(r), LIMIT.value) },
      ...hiddenField(r, shown),
      { name: 'Context', value: contextLine(r) },
      { name: 'sha256 of payload.txt', value: short(r.payloadSha256) },
      { name: 'Status', value: status },
    ],
    ...(open && { footer: { text: `Only ${us.owner} approves or declines. The sender can withdraw it while it waits. sage gets payload.txt exactly, `
      + `after one line that says who approved it. ${offline(us)}` } }),
    color: COLOR[r.status],
  };
  const components = open ? [new ActionRowBuilder().addComponents(
    button(outboxId('approve', r.id), 'Approve', ButtonStyle.Success), button(outboxId('decline', r.id), 'Decline', ButtonStyle.Danger),
    button(outboxId('withdraw', r.id), 'Withdraw', ButtonStyle.Secondary)).toJSON()] : [];
  const pinged = ping && open;
  return {
    content: pinged ? `<@${ownerId}> a message to sage waits for you.` : '',
    embeds: [embed], components,
    allowedMentions: pinged ? { parse: [], users: [ownerId] } : NO_MENTIONS,
  };
}

/** Who withdrew a message, for people: its sender, sage-bot (its thread or card is gone), or the owner at the terminal (F-T247-16). */
const decider = (r, us) => (r.decidedBy === r.author ? safe(r.name) : r.decidedBy === 'sage-bot' ? us.bot : us.owner);
/** The reason of a decision, for people, as " (reason)"; none when there is none. */
const reasonOf = (r) => (r.reason ? ` (${safe(r.reason)})` : '');

/**
 * The status line after a change, in the thread. No ping. The owner's own message, approved at once, has no card: its line has
 * payload.txt. `home`: the line goes to the home channel (its thread is gone, or sage-bot withdrew it), so it names the sender too.
 */
export function statusLine(r, us, home = false) {
  const own = r.status === 'approved' && !r.card;
  const it = home ? `${r.id} from ${safe(r.name)}` : r.id;
  const content = own ? `**${r.id} from ${us.owner} is recorded** with ${earlier(r.context.length)}. It waits for sage sessions (T159). sha256 ${short(r.payloadSha256)}`
    : {
      approved: `**${it} approved** by ${us.owner}. It waits for sage sessions (T159). sha256 ${short(r.payloadSha256)}`,
      declined: `**${it} declined** by ${us.owner}${reasonOf(r)}. Nothing goes to sage.`,
      withdrawn: `**${it} withdrawn** by ${decider(r, us)}${reasonOf(r)}. Nothing goes to sage.`,
    }[r.status];
  return { content, allowedMentions: NO_MENTIONS, ...(own && { files: [payloadFile(r)] }) };
}

/** The private notes of the outbox, each a function of `us` and the message. */
export const OUTBOX_NOTES = {
  notCard: (us, r) => `This button is not on the card of ${r.id}. Nothing changed.`,
  notOwner: (us) => `Only ${us.owner} approves or declines a message to sage. Nothing changed.`,
  notSender: (us, r) => `Only ${safe(r.name)}, who sent ${r.id}, can withdraw it. Nothing changed.`,
  late: (us, r) => `${r.id} was already ${r.status} at ${stamp(r.decidedAt)}. Nothing changed.`,
  approved: (us, r) => `You approved ${r.id}. It waits for sage sessions (T159).`,
  declined: (us, r) => `You declined ${r.id}. Nothing goes to sage.`,
  withdrawn: (us, r) => `You withdrew ${r.id}. Nothing goes to sage.`,
  broken: (us) => `Something went wrong on the bridge, so I could not do this. ${us.Owner} sees the details at the terminal.`,
};
const note = (why, us, r) => ephemeral(OUTBOX_NOTES[why](us, r));
/** The rights that a card or a status line needs in its thread (src/channels.js NEEDED checks them at start). */
const RIGHTS = 'Send Messages in Threads, Embed Links and Attach Files';

/**
 * The outbox side of one bridge. `config` has ownerId (as src/crew.js ownerOf resolved it), statePath and channelId (the home channel).
 * `discord` is the port `{ post(target, payload) → id, edit(target, id, payload), unarchive(thread), locked(thread) → boolean, seen(target, id) }`, where `seen`
 * resolves when the message is there (src/discord.js, or src/fake-discord.js for the tests).
 * `files` are src/ask.js openAskFiles (the audit log); `audit` posts the #sage-audit copy of each audit log line. `newMarker` makes the
 * marker of each payload: src/outbox.js newMarker (random) by default; the demo gives fixed ones, so that two runs give the same page.
 */
export function createOutboxFlow({ config, discord, files, audit, now = Date.now, log = (line) => process.stderr.write(`${line}\n`), newMarker }) {
  const path = outboxPathOf(config);
  const say = (line) => log(forTerminal(line));
  const said = new Set();
  const sayOnce = (line) => { if (!said.has(line)) { said.add(line); say(line); } };
  const us = namesOf(config);
  const place = (user, roles) => placeOf(user, roles ?? [], config.ownerId);
  const record = recorder({ auditLog: files.auditLog, audit, now, say });
  const load = () => loadOutbox(path);

  // ---- Drawing: the card and the status line of one message, as the file says; one draw at a time (as src/requestFlow.js). ----
  let chain = Promise.resolve();
  const logged = new WeakSet();
  const draw = (mid) => {
    const run = chain.then(() => drawNow(mid)).catch((e) => {
      if (!logged.has(e)) sayOnce(`${mid} is not on Discord as the outbox says yet; the loop tries again: ${e?.message ?? e}`);
      throw e;
    });
    chain = run.catch(() => {});
    return run;
  };
  /** A call to Discord; an error is logged once with its code and thrown, unless `done` takes its code (then null). */
  async function call(what, fn, done = () => false) {
    try { return await fn(); } catch (e) {
      sayOnce(`Discord refused ${what}: ${apiError(e)}${e?.code === NO_PERMISSION ? `. ${us.bot} lacks a right there: a card needs ${RIGHTS}` : ''}`);
      if (done(e?.code)) return null;
      if (Object(e) === e) logged.add(e);
      throw e;
    }
  }
  /** Each post once (as src/requestFlow.js): an id that the file has not taken yet waits in `unsaved`, and Discord's nonce drops a repost. */
  const unsaved = new Map();
  async function once(key, post, write) {
    if (!unsaved.has(key)) unsaved.set(key, await post(key));
    const r = write(unsaved.get(key));
    unsaved.delete(key);
    return r;
  }
  const send = (what, target, payload, nonce, done = NO_EDIT) => call(what, () => discord.post(target, { ...payload, nonce, enforceNonce: true }), (c) => done.has(c));
  /**
   * An edit. Discord refuses an edit in a thread that it archived (50083): the thread opens again first. A thread that a moderator locked
   * stays as it is (F-T242-out, as src/requestFlow.js in T242): Discord would open it for sage-bot, so the lock is read first.
   */
  const edit = (what, target, message, payload) => call(`the edit of ${what}`, () => discord.edit(target, message, payload).catch(async (e) => {
    if (e?.code !== 50083 || await discord.locked(target)) throw e;
    await discord.unarchive(target);
    return discord.edit(target, message, payload);
  }), (c) => NO_EDIT.has(c));
  const lost = (e) => LOST.has(e?.code);
  /**
   * sage-bot withdraws a waiting message whose thread or card Discord says is gone (F-T247-16), or whose first card Discord refuses
   * because its thread is locked or hidden from sage-bot (`SHUT_OUT`, F-T247-23), so it frees its sender's place; it is in the audit
   * log, and its status line goes to the home channel. A decision that came first stays. Returns the message after it.
   */
  function withdrawLost(r, reason = GONE) {
    try {
      return decide(config, r.id, { type: 'withdraw', by: 'sage-bot', at: now(), reason }, (x) => audited(x, 'sage-bot', place('sage-bot'), false));
    } catch (e) {
      if (e instanceof Refused) return find(load(), r.id);
      throw e;
    }
  }
  /**
   * The status line of a message: in its thread, or in the home channel when sage-bot withdrew it or its thread is gone, so that the
   * line names the sender. Each line once (`nonce`), wherever it goes.
   */
  async function line(r, nonce) {
    const what = `the status line of ${r.id}`;
    if (r.decidedBy !== 'sage-bot') {
      try { return await send(what, r.thread, statusLine(r, us), nonce, SHUT); } catch (e) { if (!lost(e)) throw e; }
    }
    return send(what, config.channelId, statusLine(r, us, true), nonce);
  }
  async function drawNow(mid) {
    let r = find(load(), mid);
    if (r.status === 'pending') {
      try {
        if (!r.card) {
          const posted = { ...outboxCard(r, { ownerId: config.ownerId, us, ping: true }), files: [payloadFile(r)] };
          r = await once(`${mid}:card`, (n) => send(`the card of ${mid}`, r.thread, posted, n, SHUT),
            (card) => (card ? setDiscord(config, mid, { card, shown: 'pending' }) : withdrawLost(r, SHUT_OUT))); // SHUT: no card, ever (F-T247-23)
        } else if (r.shown === 'pending') await call(`the read of the card of ${mid}`, () => discord.seen(r.thread, r.card)).catch((e) => { if (lost(e)) throw e; });
      } catch (e) {
        if (!lost(e)) throw e;
        r = withdrawLost(r);
      }
    }
    if (r.shown === r.status) return r;
    if (r.card) await edit(`the card of ${mid}`, r.thread, r.card, outboxCard(r, { ownerId: config.ownerId, us }));
    return once(`${mid}:${r.status}`, (n) => line(r, n), () => setDiscord(config, mid, { shown: r.status }));
  }

  /**
   * One audit log line for a new message (`fresh`) or a decision by `who` (src/crew.js placeOf `p`), src/outbox.js auditFields. A
   * forwarded message keeps its writer and place apart from `who`.
   */
  const freshText = (r, p) => (r.quote ? forwarded(r.quote, r.where, r.text) : p.owner ? forLead(r.text) : quoted(r.text));
  const audited = (r, who, p, fresh) => record(auditFields(r, who, p, fresh ? freshText(r, p) : undefined));

  /**
   * The context of a message from its place: the pages of `history(before)` (newest first, at most 100 each, up to PAGES), read until
   * the window of src/outbox.js windowOf is full or `since` is reached, and `replied()`. Each message as `{ id, user, name, roles, bot,
   * webhook, at, text }` from the port; here it gets its place and a clean name.
   */
  async function contextOf(before, history, replied, since) {
    const as = (m) => m && { ...m, name: nameFor(m.name, m.user), place: placeLabel(place(m.user, m.roles)) };
    const newest = [];
    for (let page = 0, at = before; page < PAGES; page++) {
      const got = (await history(at)).map(as);
      newest.push(...got);
      const kept = windowOf(newest, since, null);
      const ended = got.length < 100 || (since && got.some((m) => BigInt(m.id) <= BigInt(since)));
      if (ended || kept.length === CONTEXT.messages || kept.reduce((n, m) => n + Array.from(m.text).length, 0) >= CONTEXT.chars) break;
      at = got.at(-1).id;
    }
    return windowOf(newest, since, as(await replied()));
  }

  return {
    /**
     * Why `user` cannot send the Discord message `message` to sage now (src/outbox.js refusalOf: sent already, or PENDING_MAX waiting;
     * the owner has no cap), else null; a line too while the outbox cannot be read. The record checks it again under the lock.
     */
    full(user, message) {
      try { return refusalOf(load(), user, message, !isOwner(user, config.ownerId)); } catch (e) {
        sayOnce(`the outbox cannot be read, so no message to sage can be added: ${e?.message}`);
        return `I cannot record messages to sage just now. Nothing was sent. ${us.Owner} sees the details at the terminal.`;
      }
    },
    /**
     * Records one message to sage and draws its card (or, for the owner's own message, its status line) in `thread`. `s`:
     * `{ message, where, thread, entry, author: { id, name, roles }, quote: { user, name, roles } | null, text, mentions, history, replied,
     * tell }`, where `mentions` are the names of the people that `text` mentions (user id → Discord name), `tell(text)` answers the sender, and
     * `message` is the Discord message whose text is `text`, `where` its place, `entry` the thread map entry of `thread` (a task thread
     * makes a steer of its task), and `history` and `replied` the port that reads the context. Its audit log line comes first: when the
     * log cannot be written, nothing is recorded. Returns the record, or throws Refused with the line for the sender (PENDING_MAX
     * waiting), or another error (the context, the file or the audit log could not be read or written).
     */
    async send(s) {
      const me = place(s.author.id, s.author.roles);
      const quote = s.quote && s.quote.user !== s.author.id
        ? { user: s.quote.user, name: nameFor(s.quote.name, s.quote.user), place: placeLabel(place(s.quote.user, s.quote.roles)) } : null;
      const r = await addMessage(config, {
        message: s.message, where: s.where, thread: s.thread, project: s.entry.project, task: s.entry.kind === 'task' ? s.entry.task : null,
        author: s.author.id, name: personName(s.author.name) || `a ${CREW} member`,
        place: me.owner ? 'owner' : 'crew', quote, text: s.text,
        mentions: Object.fromEntries(Object.entries(s.mentions ?? {}).map(([id, n]) => [id, nameFor(n, id)])),
      }, { ownerId: config.ownerId, at: now(), context: (since) => contextOf(s.message, s.history, s.replied, since), audit: (x) => audited(x, s.author.id, me, true), ...(newMarker && { marker: newMarker() }) });
      say(`${r.id}: ${s.author.id} sent a message to sage in ${r.thread}; it is ${r.status} (sha256 ${r.payloadSha256}; node scripts/outbox.mjs show ${r.id})`);
      try { await draw(r.id); } catch (e) { // the loop draws it again; a missing right needs the owner, so the sender hears it (F-T247-4)
        if (e?.code === NO_PERMISSION) await s.tell?.(`${r.id} is recorded, but I cannot post it in this thread: ${us.bot} lacks a right here (${RIGHTS}). It shows here once ${us.owner} gives the right to ${us.bot}'s role.`);
      }
      let after = r;
      try { after = find(load(), r.id); } catch { /* the loop reads it again */ }
      if (after.reason === SHUT_OUT) await s.tell?.(`I could not post the card of ${r.id} in <#${r.thread}>: the thread is locked, or ${us.bot} cannot see it. ${us.bot} withdrew ${r.id}, so nothing goes to sage.`);
      return r;
    },
    /**
     * A press of an approval card (a custom_id `ob1:…`): `{ user: { id, bot }, roles, customId, message: { id } | null, reply,
     * deferReply, editReply }`. Anything else, and a bot, get nothing. Never rejects.
     */
    async interaction(i) {
      const pressed = parseOutboxId(i.customId);
      if (!pressed || i.user?.bot || !SNOWFLAKE.test(i.user?.id ?? '')) return;
      const answer = (payload, how = 'reply') => i[how](payload).catch((e) => say(`Discord refused an outbox reply: ${apiError(e)}`));
      const me = place(i.user.id, i.roles);
      if (!me.crew && !me.owner) return answer(ephemeral(notCrew(us)));
      try {
        const { action, id } = pressed;
        let r;
        try { r = find(load(), id); } catch (e) { return answer(e instanceof Refused ? ephemeral(e.message) : note('broken', us)); }
        if (!r.card || i.message?.id !== r.card) return answer(note('notCard', us, r));
        if (action !== 'withdraw' && !me.owner) return answer(note('notOwner', us, r));
        if (action === 'withdraw' && i.user.id !== r.author) return answer(note('notSender', us, r));
        if (r.status !== 'pending') return answer(note('late', us, r));
        try { await i.deferReply({ flags: MessageFlags.Ephemeral }); } catch (e) { say(`Discord refused to defer an outbox press: ${apiError(e)}`); return; }
        let out;
        try {
          const after = decide(config, id, { type: action, by: i.user.id, at: now() }, (x) => audited(x, i.user.id, me, false));
          out = note(after.status, us, after);
        } catch (e) {
          if (!(e instanceof Refused)) say(`${id}: ${e?.message ?? e}`);
          out = e instanceof Refused ? ephemeral(cut(forTerminal(e.message), LIMIT.content)) : note('broken', us);
        }
        try { await draw(id); } catch { /* the loop draws it again */ }
        await answer({ content: out.content, allowedMentions: NO_MENTIONS }, 'editReply');
      } catch (e) { say(`an outbox press: ${e?.message}`); }
    },
    /**
     * One turn of the sync loop: draws each message whose card or status line Discord does not show yet, and reads the card of each
     * waiting message, which sage-bot withdraws when Discord says that its thread or card is gone (F-T247-16). Never rejects.
     */
    async loop() {
      let file;
      try { file = load(); } catch (e) { sayOnce(`the outbox cannot be read, so no message is shown: ${e?.message}`); return; }
      for (const r of file.messages) {
        if (r.status === 'pending' || r.shown !== r.status) await draw(r.id).catch(() => {});
      }
    },
  };
}
