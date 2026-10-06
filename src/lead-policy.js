// The lead policy (T156, T134 PR 1). One place resolves every path and name that the containment of a lead session depends on
// (leadPolicy), and everything else takes only its output: settingsOf makes the Claude Code sandbox and permission settings, launchOf
// the arguments and environment of `claude -p`, and preflight says whether a session can start. Only the sandbox guarantees a file or
// network boundary (standing order 14); the guard hook (T133) is a second layer. PR 2 of T134 proves each setting in a scratch HOME.
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { auditPathOf, killPathOf } from './audit.js';
import { claudeDirOf, sagePath, sagePlugin } from './sage.js';
import { sessionsPathOf } from './sessions.js';
import { leadsPathOf, votesPathOf } from './state.js';

const run = promisify(execFile);

/** The most a lead session may spend on the model, in USD (G60). */
export const MAX_USD = 5;
/** The strict host list of a lead session, for the sandbox and WebFetch: no GitHub host. Empty: a session reaches no host. */
export const LEAD_HOSTS = [];
/** The credential files and folders in the home folder that sandboxed commands never read, also if the home deny goes (F-T156-5). */
export const CREDENTIAL_FILES = ['.ssh', '.aws', '.config/gh', '.git-credentials', '.netrc', '.npmrc', '.gnupg', '.docker', '.kube'];
/** The GitHub credential variables that a lead session never gets. */
export const DENIED_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
/** The state tool's capability command (sage T127, G59), and the line that says lead sessions are possible. */
export const CAPABILITY_ARGS = ['capabilities'];
export const CAPABILITY_LINE = 'lead-sessions 1';
/** A lead session's name, as the design shows it: s and its number (branch sage-lead/s21). */
const SESSION = /^s[1-9]\d{0,5}$/;

/** The bridge's config file: ~/.config/sage-bot/config.json. Every script reads its default config path here. */
export const defaultConfigPath = (home = homedir()) => join(home, '.config', 'sage-bot', 'config.json');

/** The real path of `path`: the links of its deepest folder that exists resolved, the rest as written. */
function real(path) {
  const rest = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try { return join(realpathSync.native(at), ...rest.reverse()); } catch { if (at === dirname(at)) return resolve(path); }
    rest.push(basename(at));
  }
}
/** Whether `inner` is `outer` or inside it. */
const within = (inner, outer) => { const rel = relative(outer, inner); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

/** The macOS per-user temp folder (getconf DARWIN_USER_TEMP_DIR), the one that os.tmpdir() gives when TMPDIR is not set. */
function userTemp() {
  if (platform() !== 'darwin') return undefined;
  try { return execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}

/**
 * Every path and name of one lead session's containment. Throws one line when the session cannot be contained: a session name that is
 * not s and a number, a `statePath` or `leadSessionsPath` that is not an absolute path, or a session or temp folder that is in a denied
 * path or holds one, by its real path (a link does not hide an overlap).
 * @param {object} config  the bridge's config: statePath, and optionally auditPath, killPath, sessionsPath, votesPath, leadSessionsPath
 * @param {string} session  the session's name, for example s21
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, tmp?: string, userTemp?: string, shortTmp?: string, claude?: string }} [host]
 *   the host's values, for the tests; by default the real ones
 */
export function leadPolicy(config, session, host = {}) {
  if (!SESSION.test(session ?? '')) throw new TypeError(`a lead session's name is s and a number, such as s21, not ${JSON.stringify(session)}. Nothing was started.`);
  for (const key of ['statePath', 'leadSessionsPath']) { // F-T156-10: a relative or ~ path would resolve against the cwd
    const path = config[key];
    if ((path !== undefined || key === 'statePath') && !(typeof path === 'string' && isAbsolute(path))) throw new TypeError(`the config: ${key} must be an absolute path, not ${JSON.stringify(path ?? null)}. Nothing was started.`);
  }
  const { env = process.env, home = homedir(), tmp = tmpdir(), shortTmp = '/tmp', claude = 'claude' } = host;
  const leads = real(config.leadSessionsPath ?? join(home, '.local', 'share', 'sage-bot', 'leads'));
  const stateDir = real(dirname(config.statePath));
  const claudeConfig = claudeDirOf({ env, home }); // F-T156-11: the plugin and sage's root from one config folder
  const plugin = sagePlugin(claudeConfig);
  const sageRoot = real(env.SAGE_HOME ?? join(claudeConfig, 'sage'));
  const temps = [tmp, 'userTemp' in host ? host.userTemp : userTemp()].filter(Boolean);
  const claudeDir = join(leads, 'claude');
  const denied = [...new Set([
    stateDir, ...[auditPathOf, killPathOf, sessionsPathOf, votesPathOf, leadsPathOf].map((of) => of(config)), // F-T134-2
    dirname(defaultConfigPath(home)), // F-T134-2
    plugin.cache, plugin.marketplace, sageRoot, // F-T134-6, F-T134-12
    ...temps.map((t) => join(t, 'sage-hooks')), join(sageRoot, '.hooks'), // F-T134-7, F-T134-12
    claudeDir, // F-T134-10
  ].map(real))];
  const policy = {
    session,
    folder: real(join(leads, 'sessions', session)), // F-T156-6: a link at sessions or sessions/<name> counts by its target
    tmp: real(join(shortTmp, `sage-lead-${session}`)), // F-T134-13, F-T156-6
    home: real(home), // F-T156-5: sandboxed commands read nothing in it but the session's own folders
    credentialFiles: CREDENTIAL_FILES.map((f) => join(real(home), f)),
    hooksState: join(stateDir, 'lead-hooks', session),
    claudeDir,
    denied,
    hosts: LEAD_HOSTS,
    deniedEnv: DENIED_ENV,
    maxUsd: MAX_USD,
    claude,
    sageTool: (() => { try { return sagePath({ env, home }); } catch { return null; } })(),
  };
  for (const [what, path] of [['session folder', policy.folder], ['temp folder', policy.tmp]]) {
    const clash = denied.find((d) => within(d, path) || within(path, d));
    if (clash) throw new Error(`the lead session's ${what} ${path} ${within(path, clash) ? 'is in' : 'holds'} the denied path ${clash}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.`);
  }
  return policy;
}

/** The absolute form of a permission rule's path (two slashes), and the rules of one tool for a list of paths. */
const rules = (tool, paths) => paths.flatMap((p) => [`${tool}(/${p})`, `${tool}(/${p}/**)`]);
/** Where git keeps code that runs, or settings that name code, in any repository below a folder (F-T134-3, F-T156-9). */
const nestedGit = (folder) => [`${folder}/**/.git/hooks`, `${folder}/**/.git/config`];

/**
 * The Claude Code settings of a lead session (`--settings`), from the policy only.
 * @param {ReturnType<typeof leadPolicy>} policy
 */
export function settingsOf(policy) {
  return {
    permissions: {
      defaultMode: 'dontAsk',
      deny: [
        ...['Read', 'Edit'].flatMap((tool) => rules(tool, policy.denied)), // the file tools: the sandbox covers Bash only; Edit covers Write
        'Edit(.claude/**)', 'Edit(.mcp.json)', // F-T134-4
        'Grep', // F-T134-16, F-T156-8: Read rules reach Grep only best-effort
        ...(policy.hosts.length ? [] : ['WebFetch']), // no host on the list: no WebFetch at all
      ],
      allow: policy.hosts.map((h) => `WebFetch(domain:${h})`),
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: policy.hosts },
      filesystem: {
        denyRead: [policy.home, ...policy.denied], // F-T156-5: the whole home folder; the narrower allowRead below re-opens
        allowRead: [policy.folder, policy.tmp], // only the session's own folders
        denyWrite: [...policy.denied, ...nestedGit(policy.folder)],
      },
      credentials: {
        files: policy.credentialFiles.map((path) => ({ path, mode: 'deny' })),
        envVars: policy.deniedEnv.map((name) => ({ name, mode: 'deny' })),
      },
    },
  };
}

/**
 * The command of a lead session: `claude` and its arguments, its working folder and its environment, from the policy only. The
 * environment is the host's without the GitHub credential variables, with the session's own temp, config and hook-state folders, and
 * no global git config (GIT_CONFIG_GLOBAL=/dev/null): git reads ~/.gitconfig at each start, and the sandbox denies the home folder.
 * @param {ReturnType<typeof leadPolicy>} policy @param {NodeJS.ProcessEnv} [env]  the host's environment
 */
export function launchOf(policy, env = process.env) {
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => !policy.deniedEnv.includes(k)));
  return {
    command: policy.claude,
    args: ['-p', '--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', '--strict-mcp-config',
      ...(policy.sageTool ? ['--plugin-dir', dirname(dirname(dirname(policy.sageTool)))] : []), // sage, the only plugin
      '--max-budget-usd', String(policy.maxUsd)],
    cwd: policy.folder,
    env: { ...kept, SAGE_HOOKS_STATE: policy.hooksState, CLAUDE_CODE_TMPDIR: policy.tmp, CLAUDE_CONFIG_DIR: policy.claudeDir, GIT_CONFIG_GLOBAL: '/dev/null' },
  };
}

/**
 * Whether a lead session can start, from the policy only. Fails closed, in this order:
 * - "waiting for sage T127": the state tool, run outside the sandbox, does not print the line CAPABILITY_LINE, or fails;
 * - "no sandbox": `claude sandbox status` with the session's settings does not say supported, enabled and strict. Claude Code 2.1.289
 *   reports strictMode true exactly when a settings source sets sandbox.allowUnsandboxedCommands to false; strictModeSource "policy"
 *   means that the key is in --settings (or managed settings), whatever its value (F-T156-7);
 * - else "ready". Sessions still need Erick's switch at the terminal (G50 a): sage-bot never turns them on by itself.
 * Each command gets `timeout` ms, then SIGKILL: a command that ignores SIGTERM cannot hold the preflight.
 * @param {ReturnType<typeof leadPolicy>} policy @param {NodeJS.ProcessEnv} [env]  the host's environment @param {number} [timeout]
 * @returns {Promise<{ state: 'ready' | 'waiting for sage T127' | 'no sandbox', why: string }>}
 */
export async function preflight(policy, env = process.env, timeout = 30_000) {
  const out = async (file, args, o = {}) => (await run(file, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', ...o })).stdout;
  const short = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
  if (!policy.sageTool) return { state: 'waiting for sage T127', why: 'the sage state tool is not installed' };
  try {
    const lines = (await out(process.execPath, [policy.sageTool, ...CAPABILITY_ARGS], { env })).split(/\r?\n/);
    if (!lines.includes(CAPABILITY_LINE)) return { state: 'waiting for sage T127', why: `the state tool does not print "${CAPABILITY_LINE}"` };
  } catch (e) {
    return { state: 'waiting for sage T127', why: `the state tool's ${CAPABILITY_ARGS.join(' ')} failed: ${short(e)}` };
  }
  const launch = launchOf(policy, env);
  let status;
  try {
    status = JSON.parse(await out(launch.command, ['--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', 'sandbox', 'status'], { env: launch.env }));
  } catch (e) {
    return { state: 'no sandbox', why: `claude sandbox status failed: ${short(e)}` };
  }
  const ok = status?.supported === true && status.enabled === true && status.strictMode === true && !status.unavailableReason;
  if (!ok) return { state: 'no sandbox', why: `claude sandbox status: supported ${status?.supported}, enabled ${status?.enabled}, strict ${status?.strictMode}${status?.unavailableReason ? `, ${status.unavailableReason}` : ''}` };
  return { state: 'ready', why: 'the state tool prints the line, and the sandbox is supported, enabled and strict' };
}
