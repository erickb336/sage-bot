// The lead policy (T156, T134 PR 1). One place resolves every path and name that the containment of a lead session depends on
// (leadPolicy), and everything else takes only its output: settingsOf makes the Claude Code sandbox and permission settings, launchOf
// the arguments and environment of `claude -p`, and preflight says whether a session can start. Only the sandbox guarantees a file or
// network boundary (standing order 14); the guard hook (T133) is a second layer. PR 2 of T134 proves each setting in a scratch HOME.
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { auditPathOf, killPathOf } from './audit.js';
import { canonicalPath, claudeDirOf, ownerHome, sagePath, sagePlugin, sageToolIn } from './sage.js';
import { sessionsPathOf } from './sessions.js';
import { leadsPathOf, votesPathOf } from './state.js';

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
 * ~/.config/git. The session's environment has no XDG_CONFIG_HOME, so ~/.config/git is the one git and Claude Code use there. Also
 * ~/.claude.json, the owner's Claude Code state file (MCP server configs, account data), which is outside the config folder (F-T157-11).
 */
export const CREDENTIAL_FILES = ['.ssh', '.aws', '.config/gh', '.git-credentials', '.netrc', '.npmrc', '.gnupg', '.docker', '.kube', '.gitconfig', '.config/git', '.claude.json'];
/** The GitHub credential variables that sandboxed commands never read; launchOf leaves them out of the environment too. */
export const DENIED_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
/** The variables of the model credential that Claude Code reads. Sandboxed commands never read either (F-T156-21, F-T157-8):
 * sandbox.credentials.envVars denies both, the one mechanism. A launch takes at most one, which its caller names and gives (launchOf):
 * production CLAUDE_CODE_OAUTH_TOKEN, the proof runner ANTHROPIC_API_KEY. ANTHROPIC_API_KEY outranks the OAuth token, so both at once
 * would change the billing without a word. The environment never sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: Claude Code 2.1.289 then forces
 * the permission mode to default (no dontAsk) and strips CLAUDE_CONFIG_DIR from hooks (F-T156-22). */
export const MODEL_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
/** The PATH of a lead session: fixed system and Homebrew folders, never the host's (F-T156-16). */
export const LEAD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
/** The state tool's capability command (sage T127, G59), and the line that says lead sessions are possible. */
export const CAPABILITY_ARGS = ['capabilities'];
export const CAPABILITY_LINE = 'lead-sessions 1';
/** A lead session's name, as the design shows it: s and its number (branch sage-lead/s21). */
const SESSION = /^s[1-9]\d{0,5}$/;
/** The paths of the config that the policy reads; each must be canonicalPath when it is set, statePath always (F-T156-10, F-T156-30). */
const CONFIG_PATHS = ['statePath', 'auditPath', 'killPath', 'sessionsPath', 'votesPath', 'leadSessionsPath'];
/** The folder of every lead session's temp folder (F-T134-13), short, in the real form of /tmp (a link to /private/tmp on macOS). */
export const TEMP_ROOT = '/private/tmp/sage-lead';
/**
 * The longest per-user temp folder `<CLAUDE_CODE_TMPDIR>/claude-<uid>`, in bytes, that Claude Code 2.1.289 gives to the commands of a
 * session. Above it, Claude Code gives them the shared /tmp/claude-<uid> of every session of the user (F-T156-35). Evidence, in the strings
 * of the 2.1.289 binary: `var elr=44`, and `function Sve(){... t=S(e); if(Buffer.byteLength(t)<=elr) return t; ... i=p("/tmp",R()) ...}`,
 * where S(e) is join(CLAUDE_CODE_TMPDIR, R()) and `R(){return `claude-${process.getuid?.()??0}`}`.
 */
export const CLAUDE_TMP_MAX = 44;

/** The bridge's config file: ~/.config/sage-bot/config.json. Every script reads its default config path here. */
export const defaultConfigPath = (home = homedir()) => join(home, '.config', 'sage-bot', 'config.json');

/**
 * `path`, a folder that a lead session uses: the leads folder, the sessions folder, the folder of all temp folders, and this session's
 * folder and temp folder. Other entries of the two roots are not looked at (F-T156-41): each session checks its own two. Refused when it is there and is a link, not a folder, not the user's, or writable by the group or other users:
 * the session, or another user of the Mac, could point it at any folder, and the next session would read and write there (F-T156-29,
 * F-T156-34). ACLs are not checked. Not there yet is fine; the launcher makes it. Then it must be canonicalPath (its letter case).
 */
function ownFolder(what, path, uid) {
  const s = lstatSync(path, { throwIfNoEntry: false });
  const why = !s ? '' : s.isSymbolicLink() ? 'a link' : !s.isDirectory() ? 'not a folder' : s.uid !== uid ? `owned by the user ${s.uid}, not ${uid}` : s.mode & 0o022 ? 'writable by other users' : '';
  if (why) throw new Error(`the lead session's ${what} ${path} is ${why}: a session could reach another folder through it. Remove it. Nothing was started.`);
  return canonicalPath(`the lead session's ${what}`, path);
}
/** The command `name` by its absolute path: the first executable file of that name in `PATH`, else `name` as it is. */
function which(name, PATH = '') {
  if (isAbsolute(name)) return name;
  for (const dir of PATH.split(delimiter).filter(isAbsolute)) {
    try { accessSync(join(dir, name), constants.X_OK); if (statSync(join(dir, name)).isFile()) return join(dir, name); } catch { /* not here */ }
  }
  return name;
}
/** Whether `inner` is `outer` or inside it, in any letter case: APFS and the sandbox ignore it, also for parts that do not exist yet (F-T156-44). */
const within = (inner, outer) => { const rel = relative(outer.toLowerCase(), inner.toLowerCase()); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }; // "" (equal) is within

/**
 * The macOS per-user temp folder (getconf DARWIN_USER_TEMP_DIR, run with no shell) by its real path (/private/var/folders/.../T): the
 * folder that the owner's Terminal and the launchd bridge have in TMPDIR (F-T156-40). No rule of the policy comes from TMPDIR. Throws one
 * line when getconf fails.
 */
function userTemp() {
  try { return realpathSync.native(execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (e) {
    throw new Error(`getconf DARWIN_USER_TEMP_DIR gave no folder (${String(e.message).split('\n')[0]}): the policy cannot deny sage's hook state in it. Nothing was started.`);
  }
}

/**
 * Every path and name of one lead session's containment. Every path is canonicalPath, so each rule made from it is about the file that
 * its text names. Throws one line when the session cannot be contained:
 * - a session name that is not s and a number;
 * - getconf DARWIN_USER_TEMP_DIR that fails;
 * - a path of the config (CONFIG_PATHS), HOME, the owner's home folder, DARWIN_USER_TEMP_DIR (its real path), SAGE_HOME, SAGE_TOOL or CLAUDE_CONFIG_DIR that is not canonical (an empty variable
 *   counts as not set), or a denied path or a state tool that is not (for example a link at the state file);
 * - a folder that the lead sessions use (ownFolder: the two roots, this session's folder and its temp folder; other entries of the
 *   roots are not looked at, F-T156-41) that is a link, not a folder, not the user's, or writable by others (F-T156-29);
 * - the sessions folder or the folder of all temp folders equal to, in, or holding the other or a denied path (F-T156-34);
 * - a per-user temp folder longer than CLAUDE_TMP_MAX (F-T156-35);
 * - a state tool (SAGE_TOOL) that is not in the sage plugin's cache, the one folder that the session loads sage from (F-T156-14).
 * @param {object} config  the bridge's config: statePath, and optionally auditPath, killPath, sessionsPath, votesPath, leadSessionsPath
 * @param {string} session  the session's name, for example s21
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, owner?: string, userTemp?: string, tempRoot?: string, claude?: string, uid?: number }} [host]
 *   the host's values, for the tests; by default the real ones. `tempRoot` is TEMP_ROOT, which the tests move to a scratch folder.
 *   `home` is $HOME, the session's HOME; `owner` the owner's home folder from the user database (ownerHome). Commands read neither:
 *   with a scratch HOME, the owner's real home folder stays denied too (F-T157-7).
 *   `claude` is found in the host's PATH: the session's PATH is fixed.
 */
export function leadPolicy(config, session, host = {}) {
  if (!SESSION.test(session ?? '')) throw new TypeError(`a lead session's name is s and a number, such as s21, not ${JSON.stringify(session)}. Nothing was started.`);
  for (const key of CONFIG_PATHS) if (config[key] !== undefined || key === 'statePath') canonicalPath(`the config: ${key}`, config[key]);
  const { env = process.env, home = homedir(), owner = ownerHome(), tempRoot = TEMP_ROOT, claude = 'claude', uid = process.getuid() } = host;
  canonicalPath('HOME', home);
  canonicalPath('the owner\'s home folder', owner); // F-T157-7
  const userTempDir = canonicalPath('DARWIN_USER_TEMP_DIR', 'userTemp' in host ? host.userTemp : userTemp()); // F-T156-40: never TMPDIR
  for (const key of ['SAGE_HOME', 'SAGE_TOOL']) if (env[key]) canonicalPath(key, env[key]); // CLAUDE_CONFIG_DIR: claudeDirOf
  const own = (what, path) => ownFolder(what, path, uid);
  const leads = own('leads folder', config.leadSessionsPath ?? join(home, '.local', 'share', 'sage-bot', 'leads'));
  const sessions = own('sessions folder', join(leads, 'sessions')), temps = own('folder of all temp folders', tempRoot);
  own('session folder', join(sessions, session)); own('temp folder', join(temps, session)); // F-T156-41: only this session's; a .DS_Store is no matter
  const stateDir = dirname(config.statePath);
  const claudeConfig = claudeDirOf({ env, home }); // F-T156-11: the plugin and sage's root from one config folder
  const plugin = sagePlugin(claudeConfig);
  const tool = (() => { try { return sagePath({ env, home }); } catch (e) { if (env.SAGE_TOOL) throw e; return null; } })(); // a SAGE_TOOL that is no file is refused
  const sageTool = tool && canonicalPath('the sage state tool', tool);
  const version = sageTool && (relative(plugin.cache, sageTool).split(sep)[1] ?? ''); // F-T156-24: exactly sage/<version>/skills/sage/sage.mjs
  if (sageTool && sageTool !== sageToolIn(plugin.cache, version)) throw new Error(`the sage state tool ${sageTool} is not ${sageToolIn(plugin.cache, '<version>')}, the sage plugin of the sage marketplace, the only place that a lead session loads sage from. Unset SAGE_TOOL, or set it to that sage.mjs. Nothing was started.`);
  const sageRoot = env.SAGE_HOME || join(claudeConfig, 'sage');
  const claudeDir = join(leads, 'claude');
  const denied = [...new Set([
    stateDir, config.statePath, ...[auditPathOf, killPathOf, sessionsPathOf, votesPathOf, leadsPathOf].map((of) => of(config)), // F-T134-2
    dirname(defaultConfigPath(home)), // F-T134-2
    plugin.cache, plugin.marketplace, sageRoot, // F-T134-6, F-T134-12
    join(userTempDir, 'sage-hooks'), '/private/tmp/sage-hooks', join(sageRoot, '.hooks'), // F-T134-7, F-T156-40, F-T134-12
    claudeDir, // F-T134-10
  ].map((d) => canonicalPath('the denied path', d)))];
  // F-T156-31, F-T156-34: the two folders of all sessions' folders apart from each other and from every denied path. Their folders are
  // own folders (no link), so each session's folder is in its sessions folder and its temp folder in the folder of all temp folders.
  const owned = [['sessions folder', sessions], ['folder of all temp folders', temps]];
  const all = [...owned, ...denied.map((d) => ['denied path', d])];
  for (const [i, [what, path]] of owned.entries()) {
    for (const [j, [other, d]] of all.entries()) {
      if (i !== j && (within(path, d) || within(d, path))) throw new Error(`the lead session's ${what} ${path} ${within(path, d) ? 'is in' : 'holds'} the ${other} ${d}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.`);
    }
  }
  const tmpOwn = join(temps, session), perUser = join(tmpOwn, `claude-${uid}`);
  if (Buffer.byteLength(perUser) > CLAUDE_TMP_MAX) throw new Error(`the lead session's per-user temp folder ${perUser} is longer than ${CLAUDE_TMP_MAX} bytes: Claude Code would give its commands the shared /tmp/claude-${uid} (F-T156-35). Nothing was started.`);
  const homes = [...new Set([home, owner])]; // F-T157-7
  return {
    session,
    folder: join(sessions, session), // F-T156-6, F-T156-29
    tmp: tmpOwn, // F-T134-13, F-T156-29
    sessions, tempRoot: temps, // F-T156-31: every session's folder and every session's temp folder, denied to the others
    home, // the session's HOME
    homes, // F-T156-5, F-T157-7: $HOME and the owner's home folder; sandboxed commands read nothing in them but the session's own folders
    credentialFiles: [...homes.flatMap((h) => CREDENTIAL_FILES.map((f) => join(h, f))), claudeConfig], // F-T156-15: the owner's Claude config folder
    hooksState: join(stateDir, 'lead-hooks', session),
    claudeDir,
    denied,
    hosts: LEAD_HOSTS,
    deniedEnv: DENIED_ENV,
    maxUsd: MAX_USD,
    claude: which(claude, env.PATH),
    sageTool,
    pluginDir: sageTool && join(plugin.cache, 'sage', version), // F-T156-14: the version folder of the denied cache, sage's one identity
  };
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
        denyRead: [...policy.homes, policy.sessions, policy.tempRoot, ...policy.denied], // F-T156-5, F-T156-31, F-T157-7; the narrower allowRead re-opens
        allowRead: [policy.folder, policy.tmp], // only the session's own folders
        denyWrite: [...policy.denied, ...gitControl(policy.folder)],
      },
      credentials: {
        files: policy.credentialFiles.map((path) => ({ path, mode: 'deny' })),
        envVars: [...policy.deniedEnv, ...MODEL_KEYS].map((name) => ({ name, mode: 'deny' })), // F-T156-21, F-T157-8: Claude Code keeps the model key for its own calls
      },
    },
  };
}

/**
 * The command of a lead session: `claude` and its arguments, its working folder and its environment, from the policy only. The
 * environment is an allow-list (F-T156-16): from the host only LANG, LC_* and TERM; the model credential only from the caller, at most one
 * variable of MODEL_KEYS (F-T157-8); the rest is fixed: LEAD_PATH, HOME (its reads stay denied), the session's own temp, config and
 * hook-state folders, no global or system git config, and no nonessential traffic. Every other variable of the host, a secret or not,
 * stays out; CLAUDE_CODE_SUBPROCESS_ENV_SCRUB too (F-T156-22).
 * @param {ReturnType<typeof leadPolicy>} policy @param {NodeJS.ProcessEnv} [env]  the host's environment
 * @param {Record<string, string>} [model]  the model credential, for example { CLAUDE_CODE_OAUTH_TOKEN: token }; none for a command
 *   that calls no model, such as `sandbox status`. Throws for two variables, or for a name that is not in MODEL_KEYS.
 */
export function launchOf(policy, env = process.env, model = {}) {
  const names = Object.keys(model);
  if (names.length > 1 || names.some((n) => !MODEL_KEYS.includes(n))) throw new TypeError(`a lead session takes one model credential variable, ${MODEL_KEYS.join(' or ')}, not ${names.join(' and ')}: ANTHROPIC_API_KEY outranks the OAuth token and would change the billing. Nothing was started.`);
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => k === 'LANG' || k === 'TERM' || /^LC_[A-Z]+$/.test(k)));
  return {
    command: policy.claude,
    args: ['-p', '--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', '--strict-mcp-config',
      ...(policy.pluginDir ? ['--plugin-dir', policy.pluginDir] : []), // sage, the only plugin
      '--max-budget-usd', String(policy.maxUsd)],
    cwd: policy.folder,
    env: {
      ...kept, ...model, PATH: LEAD_PATH, HOME: policy.home, TMPDIR: policy.tmp, CLAUDE_CODE_TMPDIR: policy.tmp, CLAUDE_CONFIG_DIR: policy.claudeDir,
      SAGE_HOOKS_STATE: policy.hooksState, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
}

/**
 * The macOS perl that starts a command in a new process group of its own, then runs it in its place (same pid), with no shell.
 * execFile does not pass `detached` on to the OS (Node 22), and src/ starts its processes with execFile only (test/t131-threads.test.js).
 */
const NEW_GROUP = ['/usr/bin/perl', '-e', 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\\n"'];
/**
 * The output of the command `file args`, with no shell. The command runs in a process group of its own (NEW_GROUP), and at `timeout` ms
 * the whole group gets SIGKILL, so that no child or grandchild of a hung command stays (F-T156-36); a command that ignores SIGTERM
 * cannot hold the preflight. Rejects when the command fails, is killed, or still holds its output at the timeout.
 * @param {string} file @param {string[]} args @param {{ env: NodeJS.ProcessEnv, timeout: number }} o @returns {Promise<string>}
 */
function out(file, args, { env, timeout }) {
  return new Promise((resolve, reject) => {
    let late = false;
    const child = execFile(NEW_GROUP[0], [...NEW_GROUP.slice(1), file, ...args], { env, encoding: 'utf8' }, (e, stdout, stderr) => {
      clearTimeout(timer);
      if (e || late) reject(Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}`), { stderr })); else resolve(stdout);
    });
    const timer = setTimeout(() => { late = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ } }, timeout);
  });
}

/**
 * Whether a lead session can start, from the policy only. Fails closed, in this order:
 * - "waiting for sage T127": the state tool, run outside the sandbox, does not print the line CAPABILITY_LINE, or fails;
 * - "no sandbox": `claude sandbox status` with the session's settings does not say supported, enabled and strict. Claude Code 2.1.289
 *   reports strictMode true exactly when a settings source sets sandbox.allowUnsandboxedCommands to false; strictModeSource "policy"
 *   means that the key is in --settings (or managed settings), whatever its value (F-T156-7). It runs with a new private temp folder of
 *   its own, removed after, so the preflight makes nothing in the folder of all temp folders (F-T156-38);
 * - else "ready". Sessions still need Erick's switch at the terminal (G50 a): sage-bot never turns them on by itself.
 * Each command gets its own timeout in ms (`tool` for the state tool, `claude` for claude; 30 s each), then SIGKILL to its whole process
 * group (out). The two are apart so that a test can give one command a short timeout (F-T156-25).
 * @param {ReturnType<typeof leadPolicy>} policy @param {NodeJS.ProcessEnv} [env]  the host's environment
 * @param {{ tool?: number, claude?: number }} [timeouts]
 * @returns {Promise<{ state: 'ready' | 'waiting for sage T127' | 'no sandbox', why: string }>}
 */
export async function preflight(policy, env = process.env, { tool = 30_000, claude = 30_000 } = {}) {
  const short = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
  if (!policy.sageTool) return { state: 'waiting for sage T127', why: 'the sage state tool is not installed' };
  try {
    const lines = (await out(process.execPath, [policy.sageTool, ...CAPABILITY_ARGS], { env, timeout: tool })).split(/\r?\n/);
    if (!lines.includes(CAPABILITY_LINE)) return { state: 'waiting for sage T127', why: `the state tool does not print "${CAPABILITY_LINE}"` };
  } catch (e) {
    return { state: 'waiting for sage T127', why: `the state tool's ${CAPABILITY_ARGS.join(' ')} failed: ${short(e)}` };
  }
  const launch = launchOf(policy, env);
  const scratch = mkdtempSync(join(tmpdir(), 'sage-bot-preflight-'));
  let status;
  try {
    status = JSON.parse(await out(launch.command, ['--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', 'sandbox', 'status'], { env: { ...launch.env, TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch }, timeout: claude }));
  } catch (e) {
    return { state: 'no sandbox', why: `claude sandbox status failed: ${short(e)}` };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const ok = status?.supported === true && status.enabled === true && status.strictMode === true && !status.unavailableReason;
  if (!ok) return { state: 'no sandbox', why: `claude sandbox status: supported ${status?.supported}, enabled ${status?.enabled}, strict ${status?.strictMode}${status?.unavailableReason ? `, ${status.unavailableReason}` : ''}` };
  return { state: 'ready', why: 'the state tool prints the line, and the sandbox is supported, enabled and strict' };
}
