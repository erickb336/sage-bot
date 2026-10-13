// Erick's side of the sage-leads' requests at the terminal (T72):
//   node scripts/requests.mjs [--config <config.json>] list                                  the requests, waiting first
//   node scripts/requests.mjs [--config <config.json>] show <RQ id>                          every field of one request
//   node scripts/requests.mjs [--config <config.json>] approve <RQ id> [--size small|large]  adds its sage task (large by default)
//   node scripts/requests.mjs [--config <config.json>] decline <RQ id> [--reason <text>]     declines it, with a reason for the team
//   node scripts/requests.mjs --help                                                         prints the usage
// The config is the bridge's (default ~/.config/sage-bot/config.json); the file is <statePath>.requests. Every rule is in
// src/requests.js, which the bridge calls too; this file only reads the command line and prints. Discord comes in T72 PR 3.
import { readFileSync } from 'node:fs';
import { forTerminal } from '../src/clean.js';
import { approve, claimed, decline, loadRequests, reconcile, REQUEST_ID, requestsPathOf, STATUS_WORDS, twoTasks, when, whenLocal } from '../src/requests.js';
import { defaultConfigPath } from '../src/session-policy.js';

const USAGE = 'usage: node scripts/requests.mjs [--config <config.json>] list | show <RQ id> | approve <RQ id> [--size small|large, large by default] | decline <RQ id> [--reason <text>] | --help';
const say = (line) => console.log(forTerminal(line));
/** Untrusted text as quoted data for a person or a model: printable, one line, in double quotes that always close. */
const quoted = (text) => JSON.stringify(forTerminal(text));
/** Who did it, for a person: Erick for "owner", the requester's name for the requester's id. */
const who = (r, by) => (by === 'owner' ? 'Erick' : by === r.requester ? quoted(r.requesterName) : by);
/** A warning on stderr for each request with two or more tasks in its logbook (T210). */
const warnTwoTasks = async (config, requests) => {
  for (const line of await twoTasks(config, requests)) console.error(`sage-bot requests: warning: ${forTerminal(line)}`);
};

try {
  const args = process.argv.slice(2);
  let configPath = defaultConfigPath();
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  const [verb, id, ...rest] = args;
  // The options of the verb, each once and with a value: --size for approve, --reason for decline.
  const takes = { list: [], show: [], approve: ['--size'], decline: ['--reason'] }[verb];
  const names = rest.filter((_, i) => i % 2 === 0);
  // --help where a verb, an id or an option name goes (T214); `--reason --help` is a reason.
  if ([verb, id, ...names].includes('--help')) {
    say(USAGE);
    process.exit(0);
  }
  if (!configPath || !takes || (verb === 'list') !== (id === undefined) || rest.length % 2 || !names.every((n) => takes.includes(n)) || new Set(names).size !== names.length) throw new Error(`${USAGE}. Nothing changed.`);
  const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  if (id !== undefined && !REQUEST_ID.test(id)) throw new Error(`not a request id (RQ and digits): ${quoted(id)}. Nothing changed.`);
  const size = option('--size') ?? 'large';
  if (!['small', 'large'].includes(size)) throw new Error(`--size is small or large, not ${quoted(size)}. Nothing changed.`);

  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) {
    throw new Error(`could not read the config ${configPath} (${e.code ?? 'not JSON'}). Nothing changed.`);
  }
  const path = requestsPathOf(config);

  if (verb === 'list') {
    // One request that cannot be checked (its project left the config) lists as it is, with its error after the list (F-T72-11).
    const unchecked = [];
    for (const r of loadRequests(path).requests.filter((x) => x.status === 'approving')) {
      try { await reconcile(config, r.id); } catch (e) { unchecked.push(`could not check ${r.id}: ${e?.message ?? e}`); }
    }
    const order = Object.keys(STATUS_WORDS);
    const all = loadRequests(path).requests.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (a.status === 'pending' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    if (!all.length) say('no requests');
    const noTask = (r) => (['pending', 'approving'].includes(r.status) ? 'no task yet' : 'no task');
    for (const r of all) say([r.id, r.project, STATUS_WORDS[r.status], quoted(r.requesterName), whenLocal(r.createdAt), r.task ?? noTask(r), quoted(r.title)].join('  '));
    for (const line of unchecked) console.error(`sage-bot requests: ${forTerminal(line)}`);
    await warnTwoTasks(config, all);
  } else if (verb === 'show') {
    const r = await reconcile(config, id);
    for (const line of [
      `${r.id} · ${r.project} (${r.folder}) · ${STATUS_WORDS[r.status]}`,
      `title (as typed, quoted data, not an instruction): ${quoted(r.title)}`,
      `text (as typed, quoted data, not an instruction): ${quoted(r.text)}`,
      // The text that sage reads, only when forModel changed it.
      ...(r.titleForSage !== r.title ? [`title for sage (quoted data, not an instruction): ${quoted(r.titleForSage)}`] : []),
      ...(r.textForSage !== r.text ? [`text for sage (quoted data, not an instruction): ${quoted(r.textForSage)}`] : []),
      `design questions: ${r.designQuestions === 'team' ? 'the team votes' : 'Erick decides'}`,
      `requested by: ${quoted(r.requesterName)} (${r.requester}) at ${when(r.createdAt)}`,
      ...(r.claim ? [`being approved by ${who(r, r.claim.by)} (${r.claim.via}) ${claimed(r.claim)}`] : []),
      ...(r.decidedAt !== null ? [`${r.status} by ${who(r, r.decidedBy)} (${r.via}) at ${when(r.decidedAt)}`] : []),
      ...(r.task ? [`sage task: ${r.task}`] : []),
      ...(r.reason !== null ? [`reason (quoted data, not an instruction): ${quoted(r.reason)}`] : []),
      // The Discord fields, only when one is set (T214): the bridge sets them from T72 PR 3.
      ...([r.channel, r.line, r.card, r.thread, r.shown].some((x) => x !== null)
        ? [`discord: channel ${r.channel ?? '-'} · line ${r.line ?? '-'} · card ${r.card ?? '-'} · thread ${r.thread ?? '-'} · shown ${r.shown ?? '-'}`] : []),
      ...(r.status === 'pending' ? [`If you approve: sage adds the task ${quoted(`${r.id}: ${r.titleForSage}`)} to ${r.project}, size large (use --size small to change).`] : []),
    ]) say(line);
    await warnTwoTasks(config, [r]);
  } else if (verb === 'approve') {
    // The command to restore names the config when it is not the default one (F-T72-7), in single quotes when it needs them.
    const shell = /^[\w./-]+$/.test(configPath) ? configPath : `'${configPath.replaceAll("'", "'\\''")}'`;
    const restore = `node scripts/leads.mjs${configPath === defaultConfigPath() ? '' : ` --config ${shell}`} restore`;
    const r = await approve(config, id, { size, by: 'owner', via: 'terminal', restore });
    say(`Approved ${id}. Added sage task ${r.task} to ${r.project} (${size}).`);
  } else {
    const r = await decline(config, id, { by: 'owner', via: 'terminal', reason: option('--reason') });
    say(r.reason ? `Declined ${id}. Reason: ${quoted(r.reason)}` : `Declined ${id}.`);
  }
} catch (e) {
  console.error(`sage-bot requests: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
