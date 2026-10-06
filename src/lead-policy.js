// The lead policy (T156, T134 PR 1). One place resolves every path and name that the containment of a lead session depends on
// (leadPolicy), and everything else takes only its output: settingsOf makes the Claude Code sandbox and permission settings, launchOf
// the arguments and environment of `claude -p`, and preflight says whether a session can start. Only the sandbox guarantees a file or
// network boundary (standing order 14); the guard hook (T133) is a second layer. PR 2 of T134 proves each setting in a scratch HOME.
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { auditPathOf, killPathOf } from './audit.js';
import { claudeDirOf, exactPath, sagePath, sagePlugin, sageToolIn } from './sage.js';
import { sessionsPathOf } from './sessions.js';
import { leadsPathOf, votesPathOf } from './state.js';

const run = promisify(execFile);

/** The most a lead session may spend on the model, in USD (G60). */
export const MAX_USD = 5;
/**
 * The strict host list of a lead session, for the sandbox and WebFetch: no GitHub host. The sandbox proxy refuses every other host
 * only with both settings: `allowedDomains` (this list) and `strictAllowlist: true`; without it, Claude Code decides an unlisted host
 * by the permission mode (F-T156-20). Empty, with dontAsk, a sandboxed command reaches no host; T157 proves it (F-T134-1).
 */
export const LEAD_HOSTS = [];
/**
 * The credential files and folders in the home folder that sandboxed commands never read, also if the home deny goes (F-T156-5), and
 * also where blockReadsOutsideWorkingDirectories re-opens git's global files to commands (F-T156-15): ~/.gitconfig and the whole
 * ~/.config/git. The session's environment has no XDG_CONFIG_HOME, so ~/.config/git is the one git and Claude Code use there.
 */
export const CREDENTIAL_FILES = ['.ssh', '.aws', '.config/gh', '.git-credentials', '.netrc', '.npmrc', '.gnupg', '.docker', '.kube', '.gitconfig', '.config/git'];
/** The GitHub credential variables that sandboxed commands never read; launchOf leaves them out of the environment too. */
export const DENIED_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
/** The variable of the model credential that Claude Code needs: the one value besides the locale and TERM that a session takes from the host.
 * Sandboxed commands never read it (F-T156-21): sandbox.credentials.envVars denies it, the one mechanism. The environment never sets
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: Claude Code 2.1.289 then forces the permission mode to default (no dontAsk) and strips CLAUDE_CONFIG_DIR
 * from hooks (F-T156-22). */
export const MODEL_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The PATH of a lead session: fixed system and Homebrew folders, never the host's (F-T156-16). */
export const LEAD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
/** The state tool's capability command (sage T127, G59), and the line that says lead sessions are possible. */
export const CAPABILITY_ARGS = ['capabilities'];
export const CAPABILITY_LINE = 'lead-sessions 1';
/** A lead session's name, as the design shows it: s and its number (branch sage-lead/s21). */
const SESSION = /^s[1-9]\d{0,5}$/;
/** The paths of the config that the policy reads; each must pass exactPath when it is set, statePath always (F-T156-10, F-T156-30). */
const CONFIG_PATHS = ['statePath', 'auditPath', 'killPath', 'sessionsPath', 'votesPath', 'leadSessionsPath'];

/** The bridge's config file: ~/.config/sage-bot/config.json. Every script reads its default config path here. */
export const defaultConfigPath = (home = homedir()) => join(home, '.config', 'sage-bot', 'config.json');

/**
 * The real path of `path`, an absolute path with no "." or ".." part (exactPath checks each source): the links of its deepest folder
 * that exists resolved by the OS, the rest as written. It never reads the path as text first, so a ".." cannot skip a link (F-T156-28).
 * Throws when a part of it exists but has no real path, such as a link to a path that is not made yet: that path could be made later in
 * a denied path (F-T156-17).
 */
function real(path) {
  const rest = [];
  for (let at = path; ; at = dirname(at)) {
    try { return join(realpathSync.native(at), ...rest.reverse()); } catch {
      if (lstatSync(at, { throwIfNoEntry: false })) throw new Error(`${at} is a link to a path that does not exist (or a loop), so its real path is unknown: the sandbox could not keep the session out. Nothing was started.`);
      if (at === dirname(at)) return path;
    }
    rest.push(basename(at));
  }
}
/**
 * `path`, a folder that one session gets as its own, or the folder of all its temp folders. Refused when it is there and is a link, not
 * a folder, not the user's, or writable by other users: the session, or another user of the Mac, could point it at any folder, and
 * the next session would read and write there (F-T156-29). Not there yet is fine; the launcher makes it.
 */
function ownFolder(what, path, uid) {
  const s = lstatSync(path, { throwIfNoEntry: false });
  const why = !s ? '' : s.isSymbolicLink() ? 'a link' : !s.isDirectory() ? 'not a folder' : s.uid !== uid ? `owned by the user ${s.uid}, not ${uid}` : s.mode & 0o022 ? 'writable by other users' : '';
  if (why) throw new Error(`the lead session's ${what} ${path} is ${why}: a session could reach another folder through it. Remove it. Nothing was started.`);
  return path;
}
/** The command `name` by its absolute path: the first executable file of that name in `PATH`, else `name` as it is. */
function which(name, PATH = '') {
  if (isAbsolute(name)) return name;
  for (const dir of PATH.split(delimiter).filter(isAbsolute)) {
    try { accessSync(join(dir, name), constants.X_OK); if (statSync(join(dir, name)).isFile()) return join(dir, name); } catch { /* not here */ }
  }
  return name;
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
 * not s and a number; a path of the config (CONFIG_PATHS), HOME, TMPDIR, SAGE_HOME, SAGE_TOOL or CLAUDE_CONFIG_DIR that fails exactPath
 * (an empty variable counts as not set); a path that is a link to nothing; a session folder, temp folder or folder of all temp folders
 * that is a link or not the user's own (F-T156-29); a session or temp folder that is in a denied path or holds one, by its real path (a
 * link in a parent does not hide an overlap); or a state tool (SAGE_TOOL) that is not in the sage plugin's cache, the one folder that
 * the session loads sage from (F-T156-14).
 * @param {object} config  the bridge's config: statePath, and optionally auditPath, killPath, sessionsPath, votesPath, leadSessionsPath
 * @param {string} session  the session's name, for example s21
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, tmp?: string, userTemp?: string, shortTmp?: string, claude?: string, uid?: number }} [host]
 *   the host's values, for the tests; by default the real ones. `claude` is found in the host's PATH: the session's PATH is fixed.
 */
export function leadPolicy(config, session, host = {}) {
  if (!SESSION.test(session ?? '')) throw new TypeError(`a lead session's name is s and a number, such as s21, not ${JSON.stringify(session)}. Nothing was started.`);
  for (const key of CONFIG_PATHS) if (config[key] !== undefined || key === 'statePath') exactPath(`the config: ${key}`, config[key]);
  const { env = process.env, home = homedir(), tmp = tmpdir(), shortTmp = '/tmp', claude = 'claude', uid = process.getuid() } = host;
  exactPath('HOME', home); exactPath('TMPDIR', tmp); // homedir() and tmpdir() are $HOME and $TMPDIR when they are set
  for (const key of ['SAGE_HOME', 'SAGE_TOOL']) if (env[key]) exactPath(key, env[key]); // CLAUDE_CONFIG_DIR: claudeDirOf
  const leads = real(config.leadSessionsPath ?? join(home, '.local', 'share', 'sage-bot', 'leads'));
  const stateDir = real(dirname(config.statePath));
  const claudeConfig = claudeDirOf({ env, home }); // F-T156-11: the plugin and sage's root from one config folder
  const plugin = sagePlugin(claudeConfig);
  const cache = real(plugin.cache);
  const tool = (() => { try { return sagePath({ env, home }); } catch (e) { if (env.SAGE_TOOL) throw e; return null; } })(); // a SAGE_TOOL that is no file is refused
  const sageTool = tool && real(tool);
  const version = sageTool && (relative(cache, sageTool).split(sep)[1] ?? ''); // F-T156-24: exactly sage/<version>/skills/sage/sage.mjs
  if (sageTool && sageTool !== sageToolIn(cache, version)) throw new Error(`the sage state tool ${sageTool} is not ${sageToolIn(cache, '<version>')}, the sage plugin of the sage marketplace, the only place that a lead session loads sage from. Unset SAGE_TOOL, or set it to that sage.mjs. Nothing was started.`);
  const sageRoot = real(env.SAGE_HOME || join(claudeConfig, 'sage'));
  const temps = [tmp, 'userTemp' in host ? host.userTemp : userTemp()].filter(Boolean);
  const claudeDir = join(leads, 'claude');
  const sessions = real(join(leads, 'sessions')), tempRoot = ownFolder('folder of all temp folders', join(real(shortTmp), 'sage-lead'), uid);
  const denied = [...new Set([
    stateDir, real(config.statePath), ...[auditPathOf, killPathOf, sessionsPathOf, votesPathOf, leadsPathOf].map((of) => of(config)), // F-T134-2
    dirname(defaultConfigPath(home)), // F-T134-2
    cache, plugin.marketplace, sageRoot, // F-T134-6, F-T134-12
    ...temps.map((t) => join(t, 'sage-hooks')), join(sageRoot, '.hooks'), // F-T134-7, F-T134-12
    claudeDir, // F-T134-10
  ].map(real))];
  const policy = {
    session,
    folder: ownFolder('session folder', join(sessions, session), uid), // F-T156-6: a link at sessions counts by its target; F-T156-29
    tmp: ownFolder('temp folder', join(tempRoot, session), uid), // F-T134-13, F-T156-29
    sessions, tempRoot, // F-T156-31: every session's folder and every session's temp folder, denied to the others
    home: real(home), // F-T156-5: sandboxed commands read nothing in it but the session's own folders
    credentialFiles: [...CREDENTIAL_FILES.map((f) => join(real(home), f)), real(claudeConfig)], // F-T156-15: the owner's Claude config folder
    hooksState: join(stateDir, 'lead-hooks', session),
    claudeDir,
    denied,
    hosts: LEAD_HOSTS,
    deniedEnv: DENIED_ENV,
    maxUsd: MAX_USD,
    claude: which(claude, env.PATH),
    sageTool,
    pluginDir: sageTool && join(cache, 'sage', version), // F-T156-14: the version folder of the denied cache, sage's one identity
  };
  for (const [what, path] of [['session folder', policy.folder], ['temp folder', policy.tmp]]) {
    const clash = denied.find((d) => within(d, path) || within(path, d));
    if (clash) throw new Error(`the lead session's ${what} ${path} ${within(path, clash) ? 'is in' : 'holds'} the denied path ${clash}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.`);
  }
  return policy;
}

/** The absolute form of a permission rule's path (two slashes), and the rules of one tool for a list of paths. */
const rules = (tool, paths) => paths.flatMap((p) => [`${tool}(/${p})`, `${tool}(/${p}/**)`]);
/**
 * Every git control path below a session folder: each file that can change where git reads its config or its hooks (F-T134-3, F-T156-9,
 * F-T156-13). The folder's own .git gets literal paths, because Claude Code also denies creating or removing each parent of a literal
 * denyWrite path: `.git`, `.git/info` and `.git/worktrees` cannot be renamed away, changed and renamed back. Every other .git below the
 * folder, a gitlink file or a nested repository, is denied whole. Objects, refs, the index and HEAD stay writable, so commits work. Host
 * git must still never run in a session folder (docs/reference.md, "Git in a session folder").
 */
const gitControl = (folder) => [
  ...['config', 'config.worktree', 'hooks', 'commondir', 'modules', 'info/attributes', 'worktrees'].map((p) => `${folder}/.git/${p}`),
  `${folder}/*/**/.git`,
];

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
        ...rules('Edit', gitControl(policy.folder)), // F-T156-13: the file tools write past the sandbox
        'Edit(.claude/**)', 'Edit(.mcp.json)', // F-T134-4
        'Grep', // F-T134-16, F-T156-8: Read rules reach Grep only best-effort
        ...(policy.hosts.length ? [] : ['WebFetch']), // no host on the list: no WebFetch at all
      ],
      allow: [...rules('Edit', [policy.folder, policy.tmp]), ...policy.hosts.map((h) => `WebFetch(domain:${h})`)], // F-T156-17: also the sandbox's allowWrite
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: policy.hosts, strictAllowlist: true }, // F-T156-20
      filesystem: {
        denyRead: [policy.home, policy.sessions, policy.tempRoot, ...policy.denied], // F-T156-5, F-T156-31; the narrower allowRead re-opens
        allowRead: [policy.folder, policy.tmp], // only the session's own folders
        denyWrite: [...policy.denied, ...gitControl(policy.folder)],
      },
      credentials: {
        files: policy.credentialFiles.map((path) => ({ path, mode: 'deny' })),
        envVars: [...policy.deniedEnv, MODEL_KEY].map((name) => ({ name, mode: 'deny' })), // F-T156-21: Claude Code keeps MODEL_KEY for its own calls
      },
    },
  };
}

/**
 * The command of a lead session: `claude` and its arguments, its working folder and its environment, from the policy only. The
 * environment is an allow-list (F-T156-16): from the host only MODEL_KEY, LANG, LC_* and TERM; the rest is fixed: LEAD_PATH, the real
 * HOME (its reads stay denied), the session's own temp, config and hook-state folders, no global or system git config, and no
 * nonessential traffic. Every other variable of the host, a secret or not, stays out; CLAUDE_CODE_SUBPROCESS_ENV_SCRUB too (F-T156-22).
 * @param {ReturnType<typeof leadPolicy>} policy @param {NodeJS.ProcessEnv} [env]  the host's environment
 */
export function launchOf(policy, env = process.env) {
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => k === MODEL_KEY || k === 'LANG' || k === 'TERM' || /^LC_[A-Z]+$/.test(k)));
  return {
    command: policy.claude,
    args: ['-p', '--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', '--strict-mcp-config',
      ...(policy.pluginDir ? ['--plugin-dir', policy.pluginDir] : []), // sage, the only plugin
      '--max-budget-usd', String(policy.maxUsd)],
    cwd: policy.folder,
    env: {
      ...kept, PATH: LEAD_PATH, HOME: policy.home, TMPDIR: policy.tmp, CLAUDE_CODE_TMPDIR: policy.tmp, CLAUDE_CONFIG_DIR: policy.claudeDir,
      SAGE_HOOKS_STATE: policy.hooksState, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
}

/**
 * Whether a lead session can start, from the policy only. Fails closed, in this order:
 * - "waiting for sage T127": the state tool, run outside the sandbox, does not print the line CAPABILITY_LINE, or fails;
 * - "no sandbox": `claude sandbox status` with the session's settings does not say supported, enabled and strict. Claude Code 2.1.289
 *   reports strictMode true exactly when a settings source sets sandbox.allowUnsandboxedCommands to false; strictModeSource "policy"
 *   means that the key is in --settings (or managed settings), whatever its value (F-T156-7);
 * - else "ready". Sessions still need Erick's switch at the terminal (G50 a): sage-bot never turns them on by itself.
 * Each command gets its own timeout in ms (`tool` for the state tool, `claude` for claude; 30 s each), then SIGKILL: a command that
 * ignores SIGTERM cannot hold the preflight. The two are apart so that a test can give one command a short timeout (F-T156-25).
 * @param {ReturnType<typeof leadPolicy>} policy @param {NodeJS.ProcessEnv} [env]  the host's environment
 * @param {{ tool?: number, claude?: number }} [timeouts]
 * @returns {Promise<{ state: 'ready' | 'waiting for sage T127' | 'no sandbox', why: string }>}
 */
export async function preflight(policy, env = process.env, { tool = 30_000, claude = 30_000 } = {}) {
  const out = async (file, args, o) => (await run(file, args, { encoding: 'utf8', killSignal: 'SIGKILL', ...o })).stdout;
  const short = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
  if (!policy.sageTool) return { state: 'waiting for sage T127', why: 'the sage state tool is not installed' };
  try {
    const lines = (await out(process.execPath, [policy.sageTool, ...CAPABILITY_ARGS], { env, timeout: tool })).split(/\r?\n/);
    if (!lines.includes(CAPABILITY_LINE)) return { state: 'waiting for sage T127', why: `the state tool does not print "${CAPABILITY_LINE}"` };
  } catch (e) {
    return { state: 'waiting for sage T127', why: `the state tool's ${CAPABILITY_ARGS.join(' ')} failed: ${short(e)}` };
  }
  const launch = launchOf(policy, env);
  let status;
  try {
    status = JSON.parse(await out(launch.command, ['--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', 'sandbox', 'status'], { env: launch.env, timeout: claude }));
  } catch (e) {
    return { state: 'no sandbox', why: `claude sandbox status failed: ${short(e)}` };
  }
  const ok = status?.supported === true && status.enabled === true && status.strictMode === true && !status.unavailableReason;
  if (!ok) return { state: 'no sandbox', why: `claude sandbox status: supported ${status?.supported}, enabled ${status?.enabled}, strict ${status?.strictMode}${status?.unavailableReason ? `, ${status.unavailableReason}` : ''}` };
  return { state: 'ready', why: 'the state tool prints the line, and the sandbox is supported, enabled and strict' };
}
