// The lead policy of one lead session, for Erick at the terminal (T156). It starts no session.
//   node scripts/lead-policy.mjs [--config <config.json>] [--session s1] settings    prints the policy's paths, the Claude Code settings
//                                                                                   and the arguments of `claude -p`, as JSON
//   node scripts/lead-policy.mjs [--config <config.json>] [--session s1] preflight   prints the state: ready, waiting for sage T127, or
//                                                                                   no sandbox; it runs the state tool and `claude sandbox status`
// The config is the bridge's (default ~/.config/sage-bot/config.json). It prints no value of the environment except the three that
// the policy sets.
import { readFileSync } from 'node:fs';
import { forTerminal } from '../src/clean.js';
import { defaultConfigPath, launchOf, leadPolicy, preflight, settingsOf } from '../src/lead-policy.js';

const args = process.argv.slice(2);
const USAGE = 'usage: settings or preflight, with --config <config.json> and --session <s1> when needed';
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const [, value] = args.splice(at, 2);
  if (value === undefined || value.startsWith('--')) throw new TypeError(`${name} needs a value. ${USAGE}`); // F-T156-11
  return value;
};
try {
  const path = option('--config', defaultConfigPath());
  const session = option('--session', 's1');
  const policy = leadPolicy(JSON.parse(readFileSync(path, 'utf8')), session);
  if (args[0] === 'settings' && args.length === 1) {
    const { command, args: argv, cwd, env } = launchOf(policy, {});
    const { hosts, deniedEnv, maxUsd, ...paths } = policy;
    console.log(JSON.stringify({ policy: paths, settings: settingsOf(policy), launch: { command, args: argv.map((x, i) => (argv[i - 1] === '--settings' ? '(the settings above, as one JSON string)' : x)), cwd, env } }, null, 2));
  } else if (args[0] === 'preflight' && args.length === 1) {
    const { state, why } = await preflight(policy);
    console.log(forTerminal(`lead sessions: ${state} (${why})`));
    if (state !== 'ready') process.exitCode = 1;
  } else throw new TypeError(USAGE);
} catch (e) {
  console.error(`sage-bot lead-policy: ${forTerminal(e?.message ?? e)}`);
  process.exit(1);
}
