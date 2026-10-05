// Makes the launchd plist of the bridge. It never runs launchctl.
//   node scripts/launchd.mjs <config.json> --out ~/Library/LaunchAgents/com.sage.bot.plist   writes the plist
//   node scripts/launchd.mjs <config.json>                                                 prints the plist
// It refuses a config that the bridge cannot start with. Then it prints nothing and leaves the --out file as it was:
// it writes a temp file in the same folder and renames it over the --out file only when the plist is complete.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { refuseOldRoles, SNOWFLAKE } from '../src/bridge.js';
import { projectsOf } from '../src/ask.js';
import { CONFIG_FIELDS, DISCORD_IDS, plist, stableNode } from '../src/launchd.js';
import { forTerminal } from '../src/clean.js';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at === -1 ? null : args.splice(at, 2)[1];
const nothing = out ? `No plist written: ${resolve(out)} is unchanged.` : 'No plist printed.';
const stop = (message) => {
  console.error(`sage-bot launchd: ${forTerminal(message)}`);
  process.exit(1);
};

if (args.length !== 1 || (at !== -1 && !out)) stop('usage: node scripts/launchd.mjs <config file> [--out <plist file>]');
const config = resolve(args[0]);
let raw;
try {
  raw = readFileSync(config, 'utf8');
} catch (e) {
  stop(`the config file ${config} ${e.code === 'ENOENT' ? 'does not exist' : `cannot be read (${e.code})`}. ${nothing}`);
}
let fields;
try {
  fields = JSON.parse(raw);
} catch (e) {
  stop(`the config file ${config} is not JSON (${e.message}). ${nothing}`);
}
try {
  refuseOldRoles(fields);
} catch (e) {
  stop(`${e.message} ${nothing}`);
}
const missing = CONFIG_FIELDS.filter((k) => typeof fields?.[k] !== 'string' || !fields[k]);
if (missing.length) stop(`the config file ${config} has no ${missing.join(', ')}. ${nothing}`);
const notIds = DISCORD_IDS.filter((k) => (CONFIG_FIELDS.includes(k) || fields[k] !== undefined) && !SNOWFLAKE.test(fields[k]));
if (notIds.length) stop(`in the config file ${config}, ${notIds.join(', ')} must each be a Discord id (17 to 20 digits). ${nothing}`);
try {
  projectsOf(fields); // the projects of /sage, checked as the bridge checks them at start (T71)
} catch (e) {
  stop(`in the config file ${config}, ${e.message}. ${nothing}`);
}

let node;
try {
  const r = stableNode(process.execPath, realpathSync);
  if (r.warning) console.error(`sage-bot launchd: warning: ${r.warning}`);
  node = r.node;
} catch (e) {
  stop(`${e.message}. ${nothing}`);
}
const text = plist({
  node,
  script: fileURLToPath(new URL('./bridge.mjs', import.meta.url)),
  config,
  logDir: resolve(homedir(), 'Library/Logs'),
});
if (!out) {
  process.stdout.write(text);
} else {
  const target = resolve(out);
  const temp = resolve(dirname(target), `.com.sage.bot.${process.pid}.tmp`);
  try {
    writeFileSync(temp, text);
    renameSync(temp, target);
  } catch (e) {
    rmSync(temp, { force: true });
    stop(`could not write ${target} (${e.code}). ${nothing}`);
  }
  console.log(forTerminal(`wrote ${target}`));
}
