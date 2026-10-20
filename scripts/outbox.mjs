// The messages to sage at the terminal (T247): the outbox, read only. Approved messages wait here until the bridge sessions (T159) deliver them.
//   node scripts/outbox.mjs [--config <config.json>] list          the messages: waiting first, then approved, then the rest, newest first
//   node scripts/outbox.mjs [--config <config.json>] show <M id>   every field of one message, and its exact payload
//   node scripts/outbox.mjs --help                                 prints the usage
// The config is the bridge's (default ~/.config/sage-bot/config.json); the file is <statePath>.outbox. Every rule is in src/outbox.js.
// Who reads this: the owner, at a terminal. Each untrusted text goes through forTerminal, in double quotes that always close.
import { readFileSync } from 'node:fs';
import { forTerminal } from '../src/clean.js';
import { namesOf } from '../src/crew.js';
import { find, headerOf, loadOutbox, MESSAGE_ID, outboxPathOf, STATUS_WORDS } from '../src/outbox.js';
import { when, whenLocal } from '../src/requests.js';
import { defaultConfigPath } from '../src/session-policy.js';

const USAGE = 'usage: node scripts/outbox.mjs [--config <config.json>] list | show <M id> | --help';
const say = (line) => console.log(forTerminal(line));
/** Untrusted text as quoted data for a person: printable, one line, in double quotes that always close. */
const quoted = (text) => JSON.stringify(forTerminal(text));

try {
  const args = process.argv.slice(2);
  let configPath = defaultConfigPath();
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  const [verb, id, ...rest] = args;
  if ([verb, id].includes('--help')) {
    say(USAGE);
    process.exit(0);
  }
  if (!configPath || !['list', 'show'].includes(verb) || (verb === 'list') !== (id === undefined) || rest.length) throw new Error(`${USAGE}. Nothing changed.`);
  if (id !== undefined && !MESSAGE_ID.test(id)) throw new Error(`not a message id (M and digits): ${quoted(id)}. Nothing changed.`);
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) {
    throw new Error(`could not read the config ${configPath} (${e.code ?? 'not JSON'}). Nothing changed.`);
  }
  const file = loadOutbox(outboxPathOf(config));
  const by = (r) => `${quoted(r.name)} (${r.place})`;
  if (verb === 'list') {
    const order = Object.keys(STATUS_WORDS);
    const all = [...file.messages].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.at - a.at);
    if (!all.length) say('no messages');
    for (const r of all) {
      say([r.id, r.project, r.task ?? 'question', STATUS_WORDS[r.status], by(r), whenLocal(r.at), `${r.context.length} earlier`, `sha256 ${r.payloadSha256.slice(0, 12)}`, quoted(r.text)].join('  '));
    }
  } else {
    const r = find(file, id);
    for (const line of [
      `${r.id} · ${r.project} · ${r.task ? `${r.kind} of ${r.task}` : r.kind} · ${STATUS_WORDS[r.status]}`,
      `from ${by(r)} (${r.author})${r.quote ? `, sending the message of ${quoted(r.quote.name)} (${r.quote.place}, ${r.quote.user})` : ''} at ${when(r.at)}`,
      ...(r.decidedAt !== null ? [`${r.status} by ${r.decidedBy} at ${when(r.decidedAt)}`] : []),
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
