// Where the sage state tool is, for the demo (scripts/demo.mjs) and the bridge tests (test/bridge-setup.js). In this order:
// 1. SAGE_TOOL, when it is set;
// 2. the newest sage.mjs (by modification time) in the sage plugin's cache, $HOME/.claude/plugins/cache/sage/sage/<version>/skills/sage/;
// 3. else an error that names SAGE_TOOL.
// HOME is the real home folder from the user database (os.userInfo), not $HOME: the demo and the tests run with HOME set to a scratch folder.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/** @param {{ env?: NodeJS.ProcessEnv, home?: string }} [o] @returns {string} the path of sage.mjs */
export function sagePath({ env = process.env, home = userInfo().homedir } = {}) {
  if (env.SAGE_TOOL) {
    if (existsSync(env.SAGE_TOOL)) return env.SAGE_TOOL;
    throw new Error(`SAGE_TOOL is set to ${env.SAGE_TOOL}, but there is no file there. Set SAGE_TOOL to the sage plugin's sage.mjs.`);
  }
  const cache = join(home, '.claude', 'plugins', 'cache', 'sage', 'sage');
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .map((v) => join(cache, v, 'skills', 'sage', 'sage.mjs'))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, at: statSync(p).mtimeMs }))
    .sort((a, b) => b.at - a.at || (a.p < b.p ? -1 : 1));
  if (found.length) return found[0].p;
  throw new Error(`The sage state tool is not in the sage plugin's cache (${cache}). Install the sage plugin, or set SAGE_TOOL to its sage.mjs.`);
}
