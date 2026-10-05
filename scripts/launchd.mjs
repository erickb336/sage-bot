// Prints the launchd plist of the bridge. It never runs launchctl and writes no file: save the output yourself.
//   node scripts/launchd.mjs <config.json> > ~/Library/LaunchAgents/com.sage.bot.plist
// It refuses a config that the bridge cannot start with, and prints no plist then.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import { CONFIG_FIELDS, plist, stableNode } from '../src/launchd.js';
import { forTerminal } from '../src/clean.js';

const stop = (message) => {
  console.error(`sage-bot launchd: ${forTerminal(message)}`);
  process.exit(1);
};

const [arg] = process.argv.slice(2);
if (!arg) stop('usage: node scripts/launchd.mjs <absolute path of the config file>');
const config = resolve(arg);
let text;
try {
  text = readFileSync(config, 'utf8');
} catch (e) {
  stop(`the config file ${config} ${e.code === 'ENOENT' ? 'does not exist' : `cannot be read (${e.code})`}. No plist printed.`);
}
let fields;
try {
  fields = JSON.parse(text);
} catch (e) {
  stop(`the config file ${config} is not JSON (${e.message}). No plist printed.`);
}
const missing = CONFIG_FIELDS.filter((k) => typeof fields?.[k] !== 'string' || !fields[k]);
if (missing.length) stop(`the config file ${config} has no ${missing.join(', ')}. No plist printed.`);

let node;
try {
  const r = stableNode(process.execPath, realpathSync);
  if (r.warning) console.error(`sage-bot launchd: warning: ${r.warning}`);
  node = r.node;
} catch (e) {
  stop(`${e.message}. No plist printed.`);
}
process.stdout.write(plist({
  node,
  script: fileURLToPath(new URL('./bridge.mjs', import.meta.url)),
  config,
  logDir: resolve(homedir(), 'Library/Logs'),
}));
