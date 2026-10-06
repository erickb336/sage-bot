// The mutation run of the lead policy (T156): each mutation removes or weakens one rule of src/lead-policy.js (or, where it says so, of
// src/sage.js or scripts/lead-policy.mjs), and the tests of
// test/t156-lead-policy.test.js, test/t156-git-control.test.js and test/t156-path-shapes.test.js must fail for each. It mutates a copy of src, scripts and test in
// new temp folders (one for each of WORKERS runs at the same time), never the worktree: a mutation in place leaked into a review's `lead-policy.mjs settings` that ran at the same time (F-T156-7).
// A mutation is KILLED only when the mutated file still parses and at least one test fails. A mutation that breaks the syntax, or a
// run that fails with no failing test (a test file or the runner crashed, and nothing else failed), is INVALID: it proves nothing
// about the tests (F-T156-23). A test file that crashes at load because the policy changed is not a test that failed.
//   node scripts/lead-policy-mutations.mjs     prints KILLED, SURVIVED or INVALID for each mutation; exits 1 unless all are killed
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** How many mutations run at the same time, each in its own copy: half the CPUs, 2 to 6. */
const WORKERS = Math.min(6, Math.max(2, Math.floor(availableParallelism() / 2)));
const FILES = ['test/t156-lead-policy.test.js', 'test/t156-git-control.test.js', 'test/t156-path-shapes.test.js'];

/**
 * The verdict of one mutation from its run of `node --test --test-reporter=tap` on test files. A failure named after a test file is
 * that file not loading, not a failing test. INVALID when the mutated file does not parse, or the run failed with no failing test;
 * else KILLED when a test fails, SURVIVED when none does.
 * @param {{ status: number | null, stdout: string }} run @param {string[]} files @param {boolean} parses  whether `node --check` passes
 * @returns {{ verdict: string, failed: number }}  failed: the failing tests
 */
export function verdictOf({ status, stdout }, files, parses) {
  const failed = [...stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]).filter((name) => !files.includes(name)).length;
  if (!parses || (status !== 0 && !failed)) return { verdict: 'INVALID', failed };
  return { verdict: failed ? 'KILLED' : 'SURVIVED', failed };
}

/** Whether a source file parses (`node --check`). @param {string} file */
export const parses = (file) => spawnSync(process.execPath, ['--check', file]).status === 0;

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
const ROOT = join(import.meta.dirname, '..');
/** A new copy of src, scripts and test in a temp folder: one for each run at the same time (WORKERS), so mutations run in parallel. */
const copy = () => {
  const W = mkdtempSync(join(tmpdir(), 'sage-bot-mutations-'));
  for (const d of ['src', 'scripts', 'test', 'package.json']) cpSync(join(ROOT, d), join(W, d), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(W, 'node_modules'));
  return W;
};
const POLICY = 'src/lead-policy.js', SAGE = 'src/sage.js', SCRIPT = 'scripts/lead-policy.mjs';
const GIT_CONTROL = ['config', 'config.worktree', 'hooks', 'commondir', 'modules', 'info/attributes', 'worktrees'];
const LIST = `[${GIT_CONTROL.map((n) => `'${n}'`).join(', ')}]`;
const CONFIG_PATHS = ['statePath', 'auditPath', 'killPath', 'sessionsPath', 'votesPath', 'leadSessionsPath'];
const M = [
  ['sandbox.enabled false', 'enabled: true,', 'enabled: false,'],
  ['failIfUnavailable false', 'failIfUnavailable: true', 'failIfUnavailable: false'],
  ['allowUnsandboxedCommands true', 'allowUnsandboxedCommands: false', 'allowUnsandboxedCommands: true'],
  ['blockReadsOutsideWorkingDirectories removed', '      blockReadsOutsideWorkingDirectories: true,\n', ''],
  ['defaultMode not dontAsk', "defaultMode: 'dontAsk'", "defaultMode: 'default'"],
  ['no Read rules', "['Read', 'Edit']", "['Edit']"],
  ['no Edit rules', "['Read', 'Edit']", "['Read']"],
  ['Write path rules back (never consulted)', "['Read', 'Edit']", "['Read', 'Edit', 'Write']"],
  ['no folder form of a file rule', "`${tool}(/${p})`, `${tool}(/${p}/**)`", "`${tool}(/${p})`"],
  ['no .claude rule', "'Edit(.claude/**)', ", ''],
  ['no .mcp.json rule', "'Edit(.mcp.json)', // F-T134-4", '// F-T134-4'],
  ['no Grep deny', "        'Grep', // F-T134-16", '        // F-T134-16'],
  ['no WebFetch deny', "...(policy.hosts.length ? [] : ['WebFetch'])", '...[]'],
  ['no WebFetch allow per host', "policy.hosts.map((h) => `WebFetch(domain:${h})`)", '[]'],
  ['no network list', 'network: { allowedDomains: policy.hosts, strictAllowlist: true },', ''],
  ['strictAllowlist removed', 'allowedDomains: policy.hosts, strictAllowlist: true }', 'allowedDomains: policy.hosts }'],
  ['strictAllowlist false', 'strictAllowlist: true }', 'strictAllowlist: false }'],
  ['no denyRead of the denied paths', 'policy.tempRoot, ...policy.denied]', 'policy.tempRoot]'],
  ['home not denied for reads', 'denyRead: [policy.home, policy.sessions', 'denyRead: [policy.sessions'],
  ['session folder not re-opened', 'allowRead: [policy.folder, policy.tmp]', 'allowRead: [policy.tmp]'],
  ['temp folder not re-opened', 'allowRead: [policy.folder, policy.tmp]', 'allowRead: [policy.folder]'],
  ['home re-opened', 'allowRead: [policy.folder, policy.tmp]', 'allowRead: [policy.home]'],
  ['no denyWrite of the denied paths', 'denyWrite: [...policy.denied, ', 'denyWrite: ['],
  ['no git control denyWrite', ', ...gitControl(policy.folder)]', ']'],
  ...GIT_CONTROL.map((name) => [`no .git/${name} denyWrite`, LIST, LIST.replace(`'${name}', `, '').replace(`, '${name}'`, '')]),
  ['no nested .git denyWrite', "\n  `${folder}/*/**/.git`,\n", '\n'],
  ['the nested .git glob takes the folder\'s own .git too', "`${folder}/*/**/.git`", "`${folder}/**/.git`"],
  ['globs, not literal paths, in the folder\'s own .git', "(p) => `${folder}/.git/${p}`", "(p) => `${folder}/**/.git/${p}`"],
  ['no Edit rules for the git control paths', "        ...rules('Edit', gitControl(policy.folder)),", '        //'],
  ['no credential files', "        files: policy.credentialFiles.map((path) => ({ path, mode: 'deny' })),\n", ''],
  ['~/.ssh not a credential file', "['.ssh', '.aws',", "['.aws',"],
  ['~/.config/gh not a credential file', "'.aws', '.config/gh',", "'.aws',"],
  ['no credential variables', "        envVars: [...policy.deniedEnv, MODEL_KEY].map((name) => ({ name, mode: 'deny' })),", '        //'],
  ['model credential not denied to commands (F-T156-21)', '[...policy.deniedEnv, MODEL_KEY].map', 'policy.deniedEnv.map'],
  ['GitHub on the host list', 'export const LEAD_HOSTS = [];', "export const LEAD_HOSTS = ['github.com'];"],
  ['GH_TOKEN not denied', "['GH_TOKEN', 'GITHUB_TOKEN',", "['GITHUB_TOKEN',"],
  ['budget 10', 'export const MAX_USD = 5;', 'export const MAX_USD = 10;'],
  ['state folder not denied', '    stateDir, config.statePath, ...[auditPathOf', '    config.statePath, ...[auditPathOf'],
  ['lead log not denied', '[auditPathOf, killPathOf,', '[killPathOf,'],
  ['kill switch not denied', '[auditPathOf, killPathOf,', '[auditPathOf,'],
  ['spool and votes not denied', ', sessionsPathOf, votesPathOf, leadsPathOf]', ']'],
  ['statePath not checked when not set', "if (config[key] !== undefined || key === 'statePath') canonicalPath", "if (config[key] !== undefined) canonicalPath"],
  ...CONFIG_PATHS.map((key) => [`${key} not checked (F-T156-30)`, `const CONFIG_PATHS = [${CONFIG_PATHS.map((k) => `'${k}'`).join(', ')}];`, `const CONFIG_PATHS = [${CONFIG_PATHS.filter((k) => k !== key).map((k) => `'${k}'`).join(', ')}];`]),
  ['HOME not checked', "canonicalPath('HOME', home); ", ''],
  ['TMPDIR not checked', "canonicalPath('TMPDIR', tmp);", ''],
  ['SAGE_HOME not checked', "for (const key of ['SAGE_HOME', 'SAGE_TOOL'])", "for (const key of ['SAGE_TOOL'])"],
  ['SAGE_TOOL not checked', "for (const key of ['SAGE_HOME', 'SAGE_TOOL'])", "for (const key of ['SAGE_HOME'])"],
  ['a SAGE_TOOL that is no file counts as not installed', 'if (env.SAGE_TOOL) throw e; ', ''],
  ['empty SAGE_HOME counts as set', 'env.SAGE_HOME || join', 'env.SAGE_HOME ?? join'],
  // F-T156-28: the one rule, exactPath in src/sage.js, and real() that never reads a path as text first
  ['the state file not denied', '    stateDir, config.statePath, ...[auditPathOf', '    stateDir, ...[auditPathOf'],
  // F-T156-29: the session folder and the temp folders are the user's own folders, never a link
  ['the folder of all temp folders not checked', "temps = own('folder of all temp folders', tempRoot);", 'temps = tempRoot;'],
  ['a link is an own folder', "s.isSymbolicLink() ? 'a link' : ", ''],
  ['a file is an own folder', "!s.isDirectory() ? 'not a folder' : ", ''],
  ['another user\'s folder is an own folder', 's.uid !== uid ? `owned by the user ${s.uid}, not ${uid}` : ', ''],
  ['a folder that others can write is an own folder', "s.mode & 0o022 ? 'writable by other users' : ", ''],
  ['group write allowed', 's.mode & 0o022', 's.mode & 0o002'],
  ['the uid of the host ignored', "uid = process.getuid() } = host;", "} = host; const uid = process.getuid();"],
  // F-T156-31: every session's folders denied for reads; the session's own re-opened
  ['the sessions folder not denied for reads (F-T156-31)', 'denyRead: [policy.home, policy.sessions, policy.tempRoot, ', 'denyRead: [policy.home, policy.tempRoot, '],
  ['the temp folders not denied for reads (F-T156-31)', 'denyRead: [policy.home, policy.sessions, policy.tempRoot, ', 'denyRead: [policy.home, policy.sessions, '],
  ['leadsPath key back', 'config.leadSessionsPath ??', 'config.leadsPath ??'],
  ['plugin from the home folder, not the config folder', 'const plugin = sagePlugin(claudeConfig);', "const plugin = sagePlugin(join(home, '.claude'));"],
  ['the sessions folder not checked (F-T156-34)', "const sessions = own('sessions folder', join(leads, 'sessions')),", "const sessions = join(leads, 'sessions'),"],
  ['the leads folder not checked', "const leads = own('leads folder', config.leadSessionsPath ?? join(home, '.local', 'share', 'sage-bot', 'leads'));", "const leads = config.leadSessionsPath ?? join(home, '.local', 'share', 'sage-bot', 'leads');"],
  ['git reads the global config', "GIT_CONFIG_GLOBAL: '/dev/null', ", ''],
  ['the group gets SIGTERM, not SIGKILL', "process.kill(-child.pid, 'SIGKILL')", "process.kill(-child.pid, 'SIGTERM')"],
  ['the state tool without its timeout (F-T156-25)', '{ env, timeout: tool }', '{ env }'],
  ['claude without its timeout (F-T156-25)', ', CLAUDE_CODE_TMPDIR: scratch }, timeout: claude }', ', CLAUDE_CODE_TMPDIR: scratch } }'],
  ['config folder not denied', '    dirname(defaultConfigPath(home)), // F-T134-2\n', ''],
  ['plugin cache not denied', 'cache, plugin.marketplace, sageRoot,', 'plugin.marketplace, sageRoot,'],
  ['plugin marketplace not denied', 'cache, plugin.marketplace, sageRoot,', 'cache, sageRoot,'],
  ['sage root not denied', 'cache, plugin.marketplace, sageRoot,', 'cache, plugin.marketplace,'],
  ['SAGE_HOME ignored', 'env.SAGE_HOME || ', ''],
  ['TMPDIR sage-hooks not denied', "...hookTemps.map((t) => join(t, 'sage-hooks')), ", ''],
  ['DARWIN_USER_TEMP_DIR not used', "const hookTemps = [tmp, 'userTemp' in host ? host.userTemp : userTemp()]", 'const hookTemps = [tmp]'],
  ['sageRoot/.hooks not denied', "join(sageRoot, '.hooks'), // F-T134-7", '// F-T134-7'],
  ['lead claude dir not denied', '    claudeDir, // F-T134-10\n', ''],
  ['no overlap refusal (F-T156-34)', 'if (i !== j && (within(path, d) || within(d, path))) throw', 'if (false) throw'],
  ['overlap: only "in", not "holds"', 'if (i !== j && (within(path, d) || within(d, path)))', 'if (i !== j && (within(path, d)))'],
  ['overlap: only "holds", not "in"', 'if (i !== j && (within(path, d) || within(d, path)))', 'if (i !== j && (within(d, path)))'],
  ['overlap: the denied paths left out', "const all = [...owned, ...denied.map((d) => ['denied path', d])];", 'const all = [...owned];'],
  ['overlap: the temp root left out', "const owned = [['sessions folder', sessions], ['folder of all temp folders', temps]];", "const owned = [['sessions folder', sessions]];"],
  ['session name not checked', "if (!SESSION.test(session ?? ''))", 'if (false)'],
  ['hook state outside the denied area', "hooksState: join(stateDir, 'lead-hooks', session)", "hooksState: join(leads, 'lead-hooks', session)"],
  ['shared temp folder', 'const tmpOwn = join(temps, session),', 'const tmpOwn = temps,'],
  ['no SAGE_HOOKS_STATE', 'SAGE_HOOKS_STATE: policy.hooksState, ', ''],
  ['no CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_TMPDIR: policy.tmp, ', ''],
  ['owner CLAUDE_CONFIG_DIR', ', CLAUDE_CONFIG_DIR: policy.claudeDir,', ','],
  ['all setting sources', "'--setting-sources', '', '--strict-mcp-config',", "'--strict-mcp-config',"],
  ['no strict MCP', "'--setting-sources', '', '--strict-mcp-config',", "'--setting-sources', '',"],
  ['no plugin dir', "...(policy.pluginDir ? ['--plugin-dir'", "...(false ? ['--plugin-dir'"],
  // F-T156-14: sage's one identity is the version folder of the denied plugin cache
  ['a state tool outside the plugin layout not refused', 'if (sageTool && sageTool !== sageToolIn(plugin.cache, version))', 'if (false)'],
  ['the layout without the sage plugin folder (F-T156-24)', "(cache, version) => join(cache, 'sage', version,", "(cache, version) => join(cache, version,", SAGE],
  ['the layout without skills/sage (F-T156-24)', "join(cache, 'sage', version, 'skills', 'sage', 'sage.mjs')", "join(cache, 'sage', version, 'sage.mjs')", SAGE],
  ['the state tool not canonical', "const sageTool = tool && canonicalPath('the sage state tool', tool);", 'const sageTool = tool;'],
  ['plugin dir not the version folder', "pluginDir: sageTool && join(plugin.cache, 'sage', version),", "pluginDir: sageTool && join(plugin.cache, 'sage'),"],
  // F-T156-15: git's global files and the Claude config folder, which blockReadsOutsideWorkingDirectories re-opens
  ['~/.gitconfig not a credential file', "'.kube', '.gitconfig', '.config/git']", "'.kube', '.config/git']"],
  ['~/.config/git not a credential file', "'.kube', '.gitconfig', '.config/git']", "'.kube', '.gitconfig']"],
  ['Claude config folder not a credential file', '[...CREDENTIAL_FILES.map((f) => join(home, f)), claudeConfig]', 'CREDENTIAL_FILES.map((f) => join(home, f))'],
  // F-T156-16: the environment is an allow-list
  ['the host environment kept', '...kept, PATH', '...env, PATH'],
  ['the host PATH', 'PATH: LEAD_PATH, ', 'PATH: env.PATH, '],
  ['no HOME', 'HOME: policy.home, ', ''],
  ['no TMPDIR', 'HOME: policy.home, TMPDIR: policy.tmp, ', 'HOME: policy.home, '],
  ['git reads the system config', "GIT_CONFIG_NOSYSTEM: '1', ", ''],
  ['subprocess scrub back (F-T156-22)', "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',\n", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',\n"],
  ['nonessential traffic on', "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',", ''],
  ['no model credential', 'k === MODEL_KEY || ', ''],
  ['no LANG', "k === 'LANG' || ", ''],
  ['no TERM', "k === 'TERM' || ", ''],
  ['no LC_*', ' || /^LC_[A-Z]+$/.test(k)', ''],
  ['any LC_ name', '/^LC_[A-Z]+$/', '/^LC_/'],
  ['claude not found in the host PATH', 'claude: which(claude, env.PATH),', 'claude,'],
  ['claude: a file that is not executable', 'accessSync(join(dir, name), constants.X_OK); ', ''],
  ['claude: a folder', 'if (statSync(join(dir, name)).isFile()) return', 'return'],
  ['claude: a relative PATH folder', 'PATH.split(delimiter).filter(isAbsolute)', 'PATH.split(delimiter)'],
  // F-T156-17
  ['no Edit allow for the session folder', "rules('Edit', [policy.folder, policy.tmp])", "rules('Edit', [policy.tmp])"],
  ['no Edit allow for the temp folder', "rules('Edit', [policy.folder, policy.tmp])", "rules('Edit', [policy.folder])"],
  ['a link to nothing is canonical', 'catch { return null; } } // "/" is always there', 'catch { return path; } }', SAGE],
  ['empty CLAUDE_CONFIG_DIR kept', "return env.CLAUDE_CONFIG_DIR ? canonicalPath", "return env.CLAUDE_CONFIG_DIR !== undefined ? canonicalPath", SAGE],
  ['CLAUDE_CONFIG_DIR not checked', "canonicalPath('CLAUDE_CONFIG_DIR', env.CLAUDE_CONFIG_DIR)", 'env.CLAUDE_CONFIG_DIR', SAGE],
  ['config parse error without the file name', 'throw new Error(`the config ${path}: ${e.message}`);', 'throw e;', SCRIPT],
  ['no budget', "      '--max-budget-usd', String(policy.maxUsd)],", '      ],'],
  ['T127 line not checked', 'if (!lines.includes(CAPABILITY_LINE))', 'if (false)'],
  ['T127 line by substring', 'if (!lines.includes(CAPABILITY_LINE))', "if (!lines.join('\\n').includes(CAPABILITY_LINE))"],
  ['T127 failure counts as ready', "return { state: 'waiting for sage T127', why: `the state tool's", "if (false) return { state: 'waiting for sage T127', why: `the state tool's"],
  ['missing tool counts as ready', "if (!policy.sageTool) return", 'if (false) return'],
  ['preflight without the settings', "['--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', 'sandbox', 'status']", "['sandbox', 'status']"],
  ['preflight with the owner config dir', '{ env: { ...launch.env, TMPDIR: scratch', '{ env: { ...env, TMPDIR: scratch'],
  ['supported not checked', 'status?.supported === true && ', ''],
  ['enabled not checked', 'status.enabled === true && ', ''],
  ['strictMode not checked', 'status.strictMode === true && ', ''],
  ['unavailableReason not checked', ' && !status.unavailableReason', ''],
  ['claude failure counts as ready', "return { state: 'no sandbox', why: `claude sandbox status failed", "status = {}; if (false) return { state: 'no sandbox', why: `claude sandbox status failed"],
  // G48 A: canonicalPath in src/sage.js, the one rule for every configured and environment path (F-T156-37, F-T156-39)
  ['any character in a part', 'const PART = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;', 'const PART = /^[^/]+$/;', SAGE],
  ['a space anywhere in a part', 'const PART = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;', 'const PART = /^[A-Za-z0-9._ -]+$/;', SAGE],
  ['a space at the end of a part', 'const PART = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;', 'const PART = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]*)*$/;', SAGE],
  ['no space in a part', 'const PART = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;', 'const PART = /^[A-Za-z0-9._-]+$/;', SAGE],
  ['a .. part is canonical', " && p !== '..')", ')', SAGE],
  ['a . part is canonical', " && p !== '.' && ", ' && ', SAGE],
  ['the Data volume is canonical (F-T156-39)', " && path !== DATA && !path.startsWith(`${DATA}/`)", '', SAGE],
  ['the Data volume folder itself is canonical', ' && path !== DATA && ', ' && ', SAGE],
  ['a link is canonical', 'if (real === path) return path;', 'return path;', SAGE],
  ['the denied paths not checked', ".map((d) => canonicalPath('the denied path', d)))];", '.map((d) => d))];'],
  ['the default TMPDIR /tmp', "tmp = env.TMPDIR || '/private/tmp',", "tmp = env.TMPDIR || '/tmp',"],
  ['DARWIN_USER_TEMP_DIR by its text', "return realpathSync.native(execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim());", "return execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();"],
  // F-T156-29, F-T156-34: the folders that the lead sessions own
  ['an own folder by any letter case', "  return canonicalPath(`the lead session's ${what}`, path);\n}", '  return path;\n}'],
  ['other session folders not checked', "for (const name of namesIn(sessions)) own(", 'for (const name of []) own('],
  ['other temp folders not checked', "for (const name of namesIn(temps)) own(", 'for (const name of []) own('],
  ['the temp root /tmp', "export const TEMP_ROOT = '/private/tmp/sage-lead';", "export const TEMP_ROOT = '/tmp/sage-lead';"],
  // F-T156-35: the per-user temp folder
  ['no per-user temp length check', 'if (Buffer.byteLength(perUser) > CLAUDE_TMP_MAX) throw', 'if (false) throw'],
  ['per-user temp limit 45', 'export const CLAUDE_TMP_MAX = 44;', 'export const CLAUDE_TMP_MAX = 45;'],
  ['the uid not counted', 'perUser = join(tmpOwn, `claude-${uid}`);', "perUser = join(tmpOwn, 'claude-');"],
  // F-T156-36: the process group; F-T156-38: the private temp folder of the status check
  ['no new process group', 'execFile(NEW_GROUP[0], [...NEW_GROUP.slice(1), file, ...args],', 'execFile(file, args,'],
  ['only the direct child killed', "process.kill(-child.pid, 'SIGKILL')", "process.kill(child.pid, 'SIGKILL')"],
  ['output after the timeout counts', 'if (e || late) reject', 'if (e) reject'],
  ['status check in the session\'s temp folder (F-T156-38)', '{ env: { ...launch.env, TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch },', '{ env: launch.env,'],
  ['status temp folder not removed (F-T156-38)', '} finally { rmSync(scratch, { recursive: true, force: true }); }', '} finally { /* kept */ }'],
];
const rows = [], copies = Array.from({ length: WORKERS }, copy);
/** The tests of one copy, as `node --test` with the tap reporter; resolves { status, stdout }. */
const tests = (W) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...FILES], { cwd: W, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.on('close', (status) => resolve({ status, stdout }));
});
let next = 0;
const worker = async (W) => {
  for (let i = next++; i < M.length; i = next++) {
    const [name, a, b, file = POLICY] = M[i];
    const F = join(W, file), orig = readFileSync(F, 'utf8');
    if (orig.split(a).length !== 2) { rows[i] = `NOT APPLIED  ${name}`; continue; } // the text must be there exactly once
    writeFileSync(F, orig.replace(a, b));
    const ok = parses(F);
    const r = await tests(W);
    writeFileSync(F, orig);
    const { verdict, failed } = verdictOf(r, FILES, ok);
    rows[i] = `${verdict}  ${name}  (failing tests: ${failed})`;
  }
};
try { await Promise.all(copies.map(worker)); } finally { for (const W of copies) rmSync(W, { recursive: true, force: true }); }
console.log(rows.join('\n'));
const count = (v) => rows.filter((r) => r.startsWith(v)).length;
console.log(`${count('KILLED')} of ${M.length} killed, ${count('INVALID')} invalid`);
if (count('KILLED') !== M.length) process.exitCode = 1;
}
