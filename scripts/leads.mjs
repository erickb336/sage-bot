// Erick's terminal script for the lead log and the kill switch (T131).
//   node scripts/leads.mjs [--config <config.json>] status      whether the link from Discord to sage is on or off
//   node scripts/leads.mjs [--config <config.json>] stop        turns the link off (sets the kill switch flag), as /sage stop does
//   node scripts/leads.mjs [--config <config.json>] restore     turns the link on again (removes the kill switch flag)
//   node scripts/leads.mjs [--config <config.json>] verify      checks the hash chain of the lead log; exits 1 at a break
//   node scripts/leads.mjs [--config <config.json>] read [n]    prints the last n lines of the lead log (default 20, 1 or more);
//                                                               a line from a break on starts with UNVERIFIED and shows as it is
// The config is the bridge's (default ~/.config/sage-bot/config.json). Only Erick runs this: only the terminal turns the link on.
// It needs no stop of the bridge: the bridge checks the flag before each would-be delivery, and only appends to the log.
import { readFileSync } from 'node:fs';
import { auditPathOf, killPathOf, linkOff, restoreLink, setLinkOff, verifyLog } from '../src/audit.js';
import { forTerminal } from '../src/clean.js';
import { defaultConfigPath } from '../src/lead-policy.js';

const say = (line) => console.log(forTerminal(line));
const args = process.argv.slice(2);
const at = args.indexOf('--config');
const path = at === -1 ? defaultConfigPath() : args.splice(at, 2)[1];
try {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const [verb, n = '20'] = args;
  const kill = killPathOf(config);
  const log = auditPathOf(config);
  if (verb === 'status') say(linkOff(kill) ? `the link from Discord to sage is OFF (${kill}). Turn it on with: node scripts/leads.mjs restore` : 'the link from Discord to sage is on');
  else if (verb === 'stop') {
    if (linkOff(kill)) say('the link from Discord to sage was already off');
    else { setLinkOff(kill, 'terminal', Date.now()); say(`the link from Discord to sage is OFF (${kill}). Turn it on with: node scripts/leads.mjs restore`); }
  } else if (verb === 'restore') say(restoreLink(kill) ? `the link from Discord to sage is on again (removed ${kill})` : 'the link from Discord to sage was already on');
  else if (verb === 'verify' || verb === 'read') {
    const { lines, broken, rest } = verifyLog(log);
    if (verb === 'read') {
      if (!/^[1-9]\d{0,5}$/.test(n)) throw new TypeError('read takes a count of lines of 1 or more, for example: read 20');
      const shown = [...lines.map((x) => `${x.at}  ${x.author}  [${x.roles.join(',')}]  ${x.outcome}  thread ${x.thread ?? '-'}  ${x.project ?? '-'}  ${x.text.replace(/\n/g, ' / ')}`),
        ...rest.map((r) => `UNVERIFIED  ${r}`)];
      for (const line of shown.slice(-Number(n))) say(line);
    }
    if (broken) {
      say(`BROKEN: the lead log ${log} has a break at line ${broken.line}: it ${broken.why}. The ${lines.length} line(s) before it are intact.`);
      process.exit(1);
    }
    say(`the lead log ${log} is intact: ${lines.length} line(s), each with the hash of the line before it`);
  } else throw new TypeError('usage: status, stop, restore, verify, or read [n]');
} catch (e) {
  console.error(`sage-bot leads: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
