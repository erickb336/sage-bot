// The Discord messages of /sage request (T72 PR 2), as the JSON that Discord takes: the form, the private confirm, the line in the
// channel that starts the request's thread, the request card in its states, the decline form and the private notes. Pure functions of
// a request record (src/requests.js) or a draft: no Client, no network. The bridge wires them in T72 PR 3.
// Who reads the cleaned text: people only, on Discord. The title, the text, the requester's name and the reason are untrusted, and each
// one shows as typed through `safe` (an allow-list, then every markdown, link and mention character escaped) and `cut` to Discord's limits.
// No model reads these messages: sage gets the raw text of the request record, escaped as quoted data by the outbox (a later PR).
// Every message has allowedMentions { parse: [] }, except the first post of the request card, which pings Erick (ownerId) once.
import { ActionRowBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { button, cut, ephemeral, LIMIT, NO_MENTIONS, OWNER, safe, stamp } from './cards.js';
import { forModel } from './clean.js';
import { CREW } from './crew.js';
import { LIMITS, REQUEST_ID, STATUS_WORDS } from './requests.js';
import { threadName } from './threads.js';

const COLOR = { open: 0x6b4fd8, approved: 0x2e8b57, declined: 0xb33a3a, withdrawn: 0x8a8a8a };
const DESIGN = { team: `the crew votes on them (${OWNER} breaks ties)`, owner: `${OWNER} decides them` };
/** The one sentence on each confirm and open card that says what sage gets of a request (owner decision, issue 60). */
const SAGE_GETS = 'sage gets this text exactly, as quoted data.';

/**
 * The custom_id of a button or form of a request: `rq1:<action>:<id>`. `rq1` is the version of this format. A draft action takes the
 * draft's key (`D` and digits; the bridge keeps the draft), a request action the request id. The longest is 36 characters (Discord: 100).
 * The design-question choice travels in the action: send-team or send-owner.
 */
const ACTIONS = { draft: ['form', 'send-team', 'send-owner', 'edit', 'cancel'], request: ['approve', 'decline', 'decline!', 'withdraw', 'withdraw!', 'keep'] };
const DRAFT = /^D\d{1,20}$/;
export function requestId(action, id) {
  if (!(ACTIONS.draft.includes(action) && DRAFT.test(id)) && !(ACTIONS.request.includes(action) && REQUEST_ID.test(id))) {
    throw new TypeError(`no request custom_id for ${action} ${id}`);
  }
  return `rq1:${action}:${id}`;
}
/** The action and id of a request custom_id, or null for anything else. */
export function parseRequestId(text) {
  const m = /^rq1:([a-z!-]+):([A-Z0-9]+)$/.exec(String(text));
  if (!m) return null;
  try { return requestId(m[1], m[2]) === text ? { action: m[1], id: m[2] } : null; } catch { return null; }
}

/** The requester's name for people, or "a sage-crew member" when nothing visible is left of it. */
const nameOf = (r) => safe(r.requesterName) || `a ${CREW} member`;

/**
 * The form of /sage request: a title of 4 to 70 characters and a text of 10 to 500 (Discord enforces both). `draft` holds the text
 * of an Edit, so the form opens with the person's words in it.
 * @param {string} key  the draft's key  @param {{ title?: string, text?: string }} [draft]
 */
export function requestModal(key, { title, text } = {}) {
  const input = (id, label, style, [min, max], placeholder, value) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMinLength(min).setMaxLength(max)
      .setRequired(true).setPlaceholder(placeholder);
    if (value) t.setValue(value);
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder().setCustomId(requestId('form', key)).setTitle('Request a feature').addComponents(
    input('title', 'Title', TextInputStyle.Short, LIMITS.title, 'Add CSV export to the reports page', title),
    input('text', 'What and why', TextInputStyle.Paragraph, LIMITS.text, 'What should it do, for whom, and why now?', text),
  ).toJSON();
}

const editRow = (key) => new ActionRowBuilder().addComponents(
  button(requestId('edit', key), 'Edit', ButtonStyle.Primary), button(requestId('cancel', key), 'Cancel', ButtonStyle.Secondary)).toJSON();

/**
 * The private confirm after the form: the title and the text as typed (made safe), the sentence on what sage gets, then Send (the crew
 * votes, or Erick decides the design questions), Edit and Cancel. When the title or the text has no letter or digit, the refusal of
 * newRequest (src/requests.js) with Edit and Cancel instead: the task title in sage is the title's letters and digits (forModel).
 * @param {string} key  the draft's key  @param {{ project: string, title: string, text: string }} draft
 */
export function confirmMessage(key, { project, title, text }) {
  for (const [k, v] of [['title', title], ['text', text]]) {
    if (!forModel(v)) return { ...ephemeral(`Your ${k} has nothing that sage can read: it needs letters or digits. Nothing was sent.`), components: [editRow(key)] };
  }
  const embed = {
    title: cut(`Your request · ${safe(project)}`, LIMIT.title),
    description: cut(`**Title:** ${safe(title)}\n\n**What and why:** ${safe(text)}`, LIMIT.description),
    footer: { text: `${SAGE_GETS} This confirm expires after 10 minutes. You can have 1 open request at a time.` },
    color: COLOR.open,
  };
  const row = new ActionRowBuilder().addComponents(
    button(requestId('send-team', key), 'Send: the crew votes on design questions', ButtonStyle.Success),
    button(requestId('send-owner', key), `Send: ${OWNER} decides design questions`, ButtonStyle.Primary),
    button(requestId('edit', key), 'Edit', ButtonStyle.Secondary),
    button(requestId('cancel', key), 'Cancel', ButtonStyle.Secondary));
  return {
    ...ephemeral(`**Check your request.** It goes to ${OWNER} for approval. ${SAGE_GETS} Pick who decides the design questions when sage designs it, then send.`),
    embeds: [embed], components: [row.toJSON()],
  };
}

/** The status of a request for its line and card: pending with the link off is still pending, with the note. */
const decided = (r) => ({
  approved: `approved · sage task ${r.task}`,
  declined: `declined by ${OWNER}`,
  withdrawn: `withdrawn by ${nameOf(r)}`,
})[r.status];

/** The name of the request's thread: printable text on one line, at most 80 characters (threads.js). */
export const requestThreadName = (r) => threadName(`${r.id} · ${r.title}`);

/** The line in the channel that starts the request's thread. Its end changes with the status. No ping. */
export function requestLine(r, { linkOff = false } = {}) {
  const status = r.status === 'pending' ? `waiting for ${OWNER}${linkOff ? ' · the link to sage is off' : ''}` : decided(r) ?? STATUS_WORDS[r.status];
  return { content: cut(`**${nameOf(r)} (${CREW}) requests a feature:** ${safe(r.title)} · ${r.id} · ${status}`, LIMIT.content), allowedMentions: NO_MENTIONS };
}

/**
 * The request card, the first post of its thread. While it waits: Approve, Decline and Withdraw; with the link from Discord to sage off,
 * Approve is greyed and the card says why. Being approved: the buttons are greyed. Decided: no buttons. `ping`: the first post pings
 * Erick (`ownerId`) once; an edit of the card pings nobody.
 * @param {object} r  a request record  @param {{ ownerId: string, linkOff?: boolean, ping?: boolean }} o
 */
export function requestCard(r, { ownerId, linkOff = false, ping = false }) {
  const open = r.status === 'pending' || r.status === 'approving';
  const status = {
    pending: `Waiting for ${OWNER}`,
    approving: `Being approved by ${OWNER}`,
    approved: `**Approved by ${OWNER}${r.via === 'terminal' ? ' (terminal)' : ''} at ${stamp(r.decidedAt)}. sage task ${r.task} is in the sage logbook.**`,
    declined: `**Declined by ${OWNER}${r.via === 'terminal' ? ' (terminal)' : ''} at ${stamp(r.decidedAt)}.**\n${r.reason && safe(r.reason) ? `Reason: ${safe(r.reason)}` : 'No reason given.'}`,
    withdrawn: `**Withdrawn by ${nameOf(r)} at ${stamp(r.decidedAt)}.** Nothing goes to sage.`,
  }[r.status];
  const off = linkOff && r.status === 'pending';
  const embed = {
    title: cut(`Request ${r.id} · ${safe(r.title)}`, LIMIT.title),
    description: cut(safe(r.text), LIMIT.description),
    fields: [
      { name: 'Requested by', value: `${nameOf(r)} (${CREW}) at ${stamp(r.createdAt)} · project ${safe(r.project)}` },
      { name: 'Design questions', value: `When sage designs it, ${DESIGN[r.designQuestions]}.` },
      { name: 'Status', value: status },
      ...(off ? [{ name: 'The link from Discord to sage is off', value: `Approve waits until ${OWNER} turns the link on again at the terminal. ${OWNER} can still decline, and the ${CREW} member who sent it can still withdraw.` }] : []),
    ],
    ...(open && { footer: { text: `${SAGE_GETS} ${OWNER} approves or declines, here or at the terminal · the ${CREW} member who sent it can withdraw it until then · `
      + 'Talk here goes to nobody but the people in this thread: sage does not read it.' } }),
    color: open ? COLOR.open : COLOR[r.status],
  };
  const busy = r.status === 'approving';
  const components = open ? [new ActionRowBuilder().addComponents(
    button(requestId('approve', r.id), 'Approve', ButtonStyle.Success, { disabled: busy || off }),
    button(requestId('decline', r.id), 'Decline', ButtonStyle.Danger, { disabled: busy }),
    button(requestId('withdraw', r.id), 'Withdraw', ButtonStyle.Secondary, { disabled: busy })).toJSON()] : [];
  const pinged = ping && r.status === 'pending' && !linkOff;
  return {
    content: pinged ? `<@${ownerId}> a new request waits for you.` : '',
    embeds: [embed], components,
    allowedMentions: pinged ? { parse: [], users: [ownerId] } : NO_MENTIONS,
  };
}

/** The decline form: one optional reason of at most 300 characters, for people only. */
export function declineModal(r) {
  const input = new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph)
    .setMaxLength(LIMITS.reason[1]).setRequired(false).setPlaceholder(`The ${CREW} member and the crew see it in the thread. sage does not read it.`);
  return new ModalBuilder().setCustomId(requestId('decline!', r.id)).setTitle(`Decline ${r.id}`)
    .addComponents(new ActionRowBuilder().addComponents(input)).toJSON();
}

/** The private confirm of a withdraw: one more press, as for /sage stop. */
export function withdrawConfirm(r) {
  const row = new ActionRowBuilder().addComponents(
    button(requestId('withdraw!', r.id), `Withdraw ${r.id}`, ButtonStyle.Danger), button(requestId('keep', r.id), 'Keep it', ButtonStyle.Secondary));
  return { ...ephemeral(`Withdraw ${r.id}? ${OWNER} then cannot approve it, and nothing goes to sage. You can send a new request at once.`), components: [row.toJSON()] };
}

/** The post in the thread after a decision. No ping. */
export function decidedPost(r) {
  const text = {
    approved: `**Approved.** sage task ${r.task} is in the sage logbook. sage starts work on it when bridge sessions are on (T159). `
      + `Until then, ${OWNER} can start it at the terminal. Follow it with /sage task ${r.task}.`,
    declined: `**Declined.** Nothing goes to sage. ${nameOf(r)} can send a new request with /sage request.`,
    withdrawn: `**Withdrawn.** Nothing goes to sage. ${nameOf(r)} can send a new request with /sage request.`,
  }[r.status];
  return { content: text, allowedMentions: NO_MENTIONS };
}

/**
 * The private notes of /sage request, each a function of what it names. A refusal before the form opens nothing; the hourly limit
 * is the reply of every ask (src/ask.js), so it is not here.
 */
export const REQUEST_NOTES = {
  notCrew: () => `Only a ${CREW} member can request a feature. Nothing was sent.`,
  linkOff: () => `The link from Discord to sage is off, so I cannot take a request. Nothing was sent. Only ${OWNER} can turn it on again, at the terminal. Read asks still work.`,
  open: (r) => `You have an open request: ${r.id} · ${safe(r.title)}, waiting for ${OWNER} since ${stamp(r.createdAt)}${r.thread ? ` in <#${r.thread}>` : ''}. `
    + `A ${CREW} member can have 1 open request at a time. Withdraw it in its thread, or wait for ${OWNER}'s answer.`,
  cancelled: () => 'Cancelled. Nothing was sent.',
  sent: (r) => `Sent to ${OWNER} as ${r.id}.${r.thread ? ` Its thread is <#${r.thread}>.` : ''} You can withdraw it there until ${OWNER} decides.`,
  notOwner: () => `Only ${OWNER} approves or declines a request. Nothing changed.`,
  notRequester: (r) => `Only ${nameOf(r)}, who sent ${r.id}, can withdraw it. Nothing changed.`,
  late: (r) => `${r.id} was ${STATUS_WORDS[r.status]} at ${stamp(r.decidedAt)} meanwhile. Nothing changed.`,
  approved: (r) => `You approved ${r.id}. sage task ${r.task} is added to ${safe(r.project)}.`,
};
/** A private note of REQUEST_NOTES, with no ping. */
export const requestNote = (why, r) => ephemeral(REQUEST_NOTES[why](r));
/** The note of a confirm that expired: Edit still brings the draft back. */
export const expired = (key) => ({ ...ephemeral('This confirm expired after 10 minutes. Nothing was sent. Press Edit to check your text again.'), components: [editRow(key)] });
