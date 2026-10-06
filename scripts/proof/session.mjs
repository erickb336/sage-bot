// The start command of a proof session (T165): the preflight, then `claude -p` with the policy's launch (src/lead-policy.js) and a
// prompt, in a process group of its own that a timeout kills whole. It refuses to start when the preflight is not ready (F-T134-15c).
// It holds the model credential only in the child's environment, and it never prints or writes that environment.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchOf, preflight } from '../../src/lead-policy.js';

const DUMMY = fileURLToPath(new URL('dummy-claude.mjs', import.meta.url));
/** The model of a proof session (G68 a), and its budget in USD (sage: 1 USD a session). */
export const MODEL = 'claude-haiku-4-5';
export const BUDGET_USD = 1;

/**
 * A wrapper script `<dir>/claude-<mode>` that runs the dummy claude (scripts/proof/dummy-claude.mjs) in that mode, for a policy's `claude`.
 * @param {string} dir @param {'ok' | 'unavailable'} mode @returns {string}  the wrapper's path
 */
export function dummyClaude(dir, mode) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `claude-${mode}`);
  const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(path, `#!/bin/sh\nexec ${q(process.execPath)} ${q(DUMMY)} ${mode} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Starts one session: the preflight, then claude with the prompt. Resolves to `{ refused }` when the preflight is not ready (nothing
 * started), else to the session's stream (`--output-format stream-json --verbose`, one JSON object a line in `stdout`), `stderr`, exit
 * `status`, and `timedOut`. At `timeout` ms the whole process group gets SIGKILL.
 * @param {ReturnType<typeof import('../../src/lead-policy.js').leadPolicy>} policy @param {NodeJS.ProcessEnv} env  the host's environment
 * @param {Record<string, string>} model  the model credential for launchOf: `{ ANTHROPIC_API_KEY: key }`, or `{}` for a dummy claude
 * @param {string} prompt @param {{ timeout?: number }} [o]
 * @returns {Promise<{ refused: { state: string, why: string } } | { stdout: string, stderr: string, status: number | null, timedOut: boolean }>}
 */
export async function startSession(policy, env, model, prompt, { timeout = 15 * 60_000 } = {}) {
  const ready = await preflight(policy, env);
  if (ready.state !== 'ready') return { refused: ready };
  const launch = launchOf({ ...policy, maxUsd: BUDGET_USD }, env, model);
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.args, '--model', MODEL, '--output-format', 'stream-json', '--verbose', prompt],
      { cwd: launch.cwd, env: launch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ } }, timeout);
    child.on('error', (e) => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}${e.message}`, status: null, timedOut }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ stdout, stderr, status, timedOut }); });
  });
}
