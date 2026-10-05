// The Discord thread of a chief session (T29): node scripts/session.mjs [--config <config.json>] thread <session id>.
// It prints the thread's id, from the bridge's gate file. A session gets a thread at its first team vote, so it may have none yet.
// The config is the bridge's (default ~/.config/sage-bot/config.json).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { forTerminal } from '../src/clean.js';
import { load, SESSION_ID } from '../src/state.js';

const USAGE = 'usage: node scripts/session.mjs [--config <config.json>] thread <session id>';

try {
  const args = process.argv.slice(2);
  let configPath = join(homedir(), '.config', 'sage-bot', 'config.json');
  if (args[0] === '--config') [, configPath] = args.splice(0, 2);
  const [command, id, ...more] = args;
  if (!configPath || command !== 'thread' || !id || more.length) throw new Error(USAGE);
  if (!SESSION_ID.test(id)) throw new Error('not a Claude Code session id (a UUID)');
  const { statePath } = JSON.parse(readFileSync(configPath, 'utf8'));
  const thread = load(statePath).sessions.find((s) => s.id === id)?.thread;
  if (!thread) throw new Error(`the session ${id} has no thread yet: it gets one at its first team vote`);
  console.log(thread);
} catch (e) {
  console.error(`sage-bot session: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
