// Runs the sage bridge: node scripts/bridge.mjs <config.json>. It connects to Discord with the token from the Keychain.
import { readFileSync } from 'node:fs';
import { start } from '../src/discord.js';
import { forTerminal } from '../src/clean.js';

const [path] = process.argv.slice(2);
try {
  if (!path) throw new Error('usage: node scripts/bridge.mjs <config.json>');
  await start(JSON.parse(readFileSync(path, 'utf8')));
} catch (e) {
  console.error(`sage-bot stopped: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
