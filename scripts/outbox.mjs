// The messages to sage at the terminal (T247). Approved messages wait here until the bridge sessions (T159) deliver them.
//   node scripts/outbox.mjs [--config <config.json>] list                                the messages: waiting first, then approved, then the rest, newest first
//   node scripts/outbox.mjs [--config <config.json>] show <M id>                         every field of one message, and its exact payload
//   node scripts/outbox.mjs [--config <config.json>] decline <M id> [--reason <text>]    the owner declines a waiting message (F-T247-16)
//   node scripts/outbox.mjs [--config <config.json>] withdraw <M id>                     the owner withdraws a waiting message, for example one whose card is gone
//   node scripts/outbox.mjs --help                                                       prints the usage
// The config is the bridge's (default ~/.config/sage-bot/config.json); the file is <statePath>.outbox. Every rule is in src/outbox.js.
// A decline or a withdraw is under the outbox's lock, and its audit log line is written first (src/outbox.js decide); the bridge shows it
// on Discord at its next turn (src/outboxFlow.js). Approve is only on the card, where the owner sees the message and its context.
// Who reads this: the owner, at a terminal. Each untrusted text goes through forTerminal, in double quotes that always close.
import { readFileSync } from 'node:fs';
import { forTerminal } from '../src/clean.js';
import { auditPathOf, openLog, recorder } from '../src/audit.js';
import { namesOf } from '../src/crew.js';
import { auditFields, decide, find, headerOf, loadOutbox, MESSAGE_ID, outboxPathOf, REASON_MAX, STATUS_WORDS, withNames } from '../src/outbox.js';
import { loadProjects } from '../src/projects.js';
import { when, whenLocal } from '../src/requests.js';
import { defaultConfigPath } from '../src/session-policy.js';

const USAGE = 'usage: node scripts/outbox.mjs [--config <config.json>] list | show <M id> | decline <M id> [--reason <text>] | withdraw <M id> | --help';
const say = (line) => console.log(forTerminal(line));
/** Untrusted text as quoted data for a person: printable, one line, in double quotes that always close. */
const quoted = (text) => JSON.stringify(forTerminal(text));

try {
  const args = process.argv.slice(2);
  let configPath = defaultConfigPath();
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  const [verb, id, ...rest] = args;
  // The options of the verb, each once and with a value, as in scripts/requests.mjs: --reason for decline.
  const takes = { list: [], show: [], decline: ['--reason'], withdraw: [] }[verb];
  const names = rest.filter((_, i) => i % 2 === 0);
  if ([verb, id, ...names].includes('--help')) {
    say(USAGE);
    process.exit(0);
  }
  if (!configPath || !takes || (verb === 'list') !== (id === undefined) || rest.length % 2 || !names.every((n) => takes.includes(n)) || new Set(names).size !== names.length) throw new Error(`${USAGE}. Nothing changed.`);
  if (id !== undefined && !MESSAGE_ID.test(id)) throw new Error(`not a message id (M and digits): ${quoted(id)}. Nothing changed.`);
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) {
    throw new Error(`could not read the config ${configPath} (${e.code ?? 'not JSON'}). Nothing changed.`);
  }
  const file = loadOutbox(outboxPathOf(config));
  const by = (r) => `${quoted(r.name)} (${r.place})`;
  if (verb === 'decline' || verb === 'withdraw') {
    // The reason is for people (the card, the status line, the audit log): printable text on one line (forTerminal, an allow-list).
    const reason = rest.length ? forTerminal(rest[1]).replace(/\s+/g, ' ').trim() || null : null;
    if (reason && Array.from(reason).length > REASON_MAX) throw new Error(`a reason has at most ${REASON_MAX} characters. Nothing changed.`);
    const record = recorder({ auditLog: openLog(auditPathOf(config), loadProjects(config)), now: Date.now, say: (line) => console.error(forTerminal(line)) });
    const r = decide(config, id, { type: verb, by: 'terminal', at: Date.now(), reason }, (x) => record(auditFields(x, 'terminal', { owner: true, crew: false })));
    say(`${r.id} ${r.status}. Nothing goes to sage. The bridge shows it on Discord at its next turn.`);
  } else if (verb === 'list') {
    const order = Object.keys(STATUS_WORDS);
    const all = [...file.messages].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.at - a.at);
    if (!all.length) say('no messages');
    for (const r of all) {
      say([r.id, r.project, r.task ?? 'question', STATUS_WORDS[r.status], by(r), whenLocal(r.at), `${r.context.length} earlier`, `sha256 ${r.payloadSha256.slice(0, 12)}`, quoted(withNames(r))].join('  '));
    }
  } else {
    const r = find(file, id);
    for (const line of [
      `${r.id} · ${r.project} · ${r.task ? `${r.kind} of ${r.task}` : r.kind} · ${STATUS_WORDS[r.status]}`,
      `from ${by(r)} (${r.author})${r.quote ? `, sending the message of ${quoted(r.quote.name)} (${r.quote.place}, ${r.quote.user})` : ''} at ${when(r.at)}`,
      ...(r.decidedAt !== null ? [`${r.status} by ${r.decidedBy} at ${when(r.decidedAt)}${r.reason ? ` (${quoted(r.reason)})` : ''}`] : []),
      `discord: message ${r.message} in ${r.where} · thread ${r.thread} · card ${r.card ?? '-'}`,
      `sha256 of the payload: ${r.payloadSha256}`,
      ...(r.status === 'approved' ? ['sage gets this line, then the payload:', headerOf(r, namesOf(config).owner)] : ['the payload:']),
      ...r.payload.split('\n'),
    ]) say(line);
  }
} catch (e) {
  console.error(`sage-bot outbox: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
