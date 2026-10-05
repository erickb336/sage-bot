// Prints the launchd plist of the bridge. It never runs launchctl and writes no file: save the output yourself.
//   node scripts/launchd.mjs <config.json> > ~/Library/LaunchAgents/com.sage.bot.plist
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { plist } from '../src/launchd.js';

const [config] = process.argv.slice(2);
if (!config) {
  console.error('usage: node scripts/launchd.mjs <absolute path of the config file>');
  process.exit(1);
}
process.stdout.write(plist({
  node: process.execPath,
  script: fileURLToPath(new URL('./bridge.mjs', import.meta.url)),
  config: resolve(config),
  logDir: resolve(homedir(), 'Library/Logs'),
}));
