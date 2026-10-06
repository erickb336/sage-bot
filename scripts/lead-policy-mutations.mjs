// The mutation run of the lead policy (T156): each mutation removes or weakens one rule of src/lead-policy.js, and the tests of
// test/t156-lead-policy.test.js and test/t156-git-control.test.js must fail for each. It mutates a copy of src, scripts and test in
// a new temp folder, never the worktree: a mutation in place leaked into a review's `lead-policy.mjs settings` that ran at the same time (F-T156-7).
//   node scripts/lead-policy-mutations.mjs     prints KILLED or SURVIVED for each mutation; exits 1 when one survives
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = join(import.meta.dirname, '..'), W = mkdtempSync(join(tmpdir(), 'sage-bot-mutations-'));
for (const d of ['src', 'scripts', 'test', 'package.json']) cpSync(join(ROOT, d), join(W, d), { recursive: true });
symlinkSync(join(ROOT, 'node_modules'), join(W, 'node_modules'));
const F = `${W}/src/lead-policy.js`, orig = readFileSync(F, 'utf8');
const GIT_CONTROL = ['config', 'config.worktree', 'hooks', 'commondir', 'modules', 'info/attributes', 'worktrees'];
const LIST = `[${GIT_CONTROL.map((n) => `'${n}'`).join(', ')}]`;
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
  ['no network list', 'network: { allowedDomains: policy.hosts },', ''],
  ['no denyRead of the denied paths', 'denyRead: [policy.home, ...policy.denied]', 'denyRead: [policy.home]'],
  ['home not denied for reads', 'denyRead: [policy.home, ...policy.denied]', 'denyRead: [...policy.denied]'],
  ['session folder not re-opened', 'allowRead: [policy.folder, policy.tmp]', 'allowRead: [policy.tmp]'],
  ['temp folder not re-opened', 'allowRead: [policy.folder, policy.tmp]', 'allowRead: [policy.folder]'],
  ['home re-opened', 'allowRead: [policy.folder, policy.tmp]', 'allowRead: [policy.home]'],
  ['home not resolved by its real path', 'home: real(home),', 'home,'],
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
  ['no credential variables', "        envVars: policy.deniedEnv.map((name) => ({ name, mode: 'deny' })),\n", ''],
  ['GitHub on the host list', 'export const LEAD_HOSTS = [];', "export const LEAD_HOSTS = ['github.com'];"],
  ['GH_TOKEN not denied', "['GH_TOKEN', 'GITHUB_TOKEN',", "['GITHUB_TOKEN',"],
  ['budget 10', 'export const MAX_USD = 5;', 'export const MAX_USD = 10;'],
  ['state folder not denied', '    stateDir, ...[auditPathOf', '    ...[auditPathOf'],
  ['lead log not denied', '[auditPathOf, killPathOf,', '[killPathOf,'],
  ['kill switch not denied', '[auditPathOf, killPathOf,', '[auditPathOf,'],
  ['spool and votes not denied', ', sessionsPathOf, votesPathOf, leadsPathOf]', ']'],
  ['statePath not checked', "if ((path !== undefined || key === 'statePath') && !(typeof path === 'string' && isAbsolute(path)))", "if (path !== undefined && typeof path === 'string' && !isAbsolute(path))"],
  ['leadSessionsPath not checked', "for (const key of ['statePath', 'leadSessionsPath'])", "for (const key of ['statePath'])"],
  ['leadsPath key back', 'config.leadSessionsPath ??', 'config.leadsPath ??'],
  ['plugin from the home folder, not the config folder', 'const plugin = sagePlugin(claudeConfig);', "const plugin = sagePlugin(join(home, '.claude'));"],
  ['session folder link not resolved', "folder: real(join(leads, 'sessions', session)),", "folder: join(leads, 'sessions', session),"],
  ['temp folder link not resolved', 'tmp: real(join(shortTmp, `sage-lead-${session}`)),', 'tmp: join(real(shortTmp), `sage-lead-${session}`),'],
  ['git reads the global config', ", GIT_CONFIG_GLOBAL: '/dev/null' }", ' }'],
  ['preflight timeout without SIGKILL', "killSignal: 'SIGKILL', ", ''],
  ['config folder not denied', '    dirname(defaultConfigPath(home)), // F-T134-2\n', ''],
  ['plugin cache not denied', 'plugin.cache, plugin.marketplace, sageRoot,', 'plugin.marketplace, sageRoot,'],
  ['plugin marketplace not denied', 'plugin.cache, plugin.marketplace, sageRoot,', 'plugin.cache, sageRoot,'],
  ['sage root not denied', 'plugin.cache, plugin.marketplace, sageRoot,', 'plugin.cache, plugin.marketplace,'],
  ['SAGE_HOME ignored', 'env.SAGE_HOME ?? ', ''],
  ['TMPDIR sage-hooks not denied', '...temps.map((t) => join(t, \'sage-hooks\')), ', ''],
  ['DARWIN_USER_TEMP_DIR not used', "const temps = [tmp, 'userTemp' in host ? host.userTemp : userTemp()]", 'const temps = [tmp]'],
  ['sageRoot/.hooks not denied', "join(sageRoot, '.hooks'), // F-T134-7", '// F-T134-7'],
  ['lead claude dir not denied', '    claudeDir, // F-T134-10\n', ''],
  ['refusal removed', 'if (clash) throw', 'if (false) throw'],
  ['refusal: only "in", not "holds"', 'within(d, path) || within(path, d)', 'within(path, d)'],
  ['refusal: only "holds", not "in"', 'within(d, path) || within(path, d)', 'within(d, path)'],
  ['temp folder not checked', ", ['temp folder', policy.tmp]]", ']'],
  ['no real paths', 'function real(path) {\n', 'function real(path) {\n  return resolve(path);\n'],
  ['session name not checked', "if (!SESSION.test(session ?? ''))", 'if (false)'],
  ['hook state outside the denied area', "hooksState: join(stateDir, 'lead-hooks', session)", "hooksState: join(leads, 'lead-hooks', session)"],
  ['shared temp folder', 'tmp: real(join(shortTmp, `sage-lead-${session}`))', 'tmp: real(shortTmp)'],
  ['credential vars kept in the env', '.filter(([k]) => !policy.deniedEnv.includes(k))', ''],
  ['no SAGE_HOOKS_STATE', 'SAGE_HOOKS_STATE: policy.hooksState, ', ''],
  ['no CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_TMPDIR: policy.tmp, ', ''],
  ['owner CLAUDE_CONFIG_DIR', ', CLAUDE_CONFIG_DIR: policy.claudeDir,', ','],
  ['all setting sources', "'--setting-sources', '', '--strict-mcp-config',", "'--strict-mcp-config',"],
  ['no strict MCP', "'--setting-sources', '', '--strict-mcp-config',", "'--setting-sources', '',"],
  ['no plugin dir', "...(policy.sageTool ? ['--plugin-dir'", "...(false ? ['--plugin-dir'"],
  ['no budget', "      '--max-budget-usd', String(policy.maxUsd)],", '      ],'],
  ['T127 line not checked', 'if (!lines.includes(CAPABILITY_LINE))', 'if (false)'],
  ['T127 line by substring', 'if (!lines.includes(CAPABILITY_LINE))', "if (!lines.join('\\n').includes(CAPABILITY_LINE))"],
  ['T127 failure counts as ready', "return { state: 'waiting for sage T127', why: `the state tool's", "if (false) return { state: 'waiting for sage T127', why: `the state tool's"],
  ['missing tool counts as ready', "if (!policy.sageTool) return", 'if (false) return'],
  ['preflight without the settings', "['--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', 'sandbox', 'status']", "['sandbox', 'status']"],
  ['preflight with the owner config dir', '{ env: launch.env }', '{ env }'],
  ['supported not checked', 'status?.supported === true && ', ''],
  ['enabled not checked', 'status.enabled === true && ', ''],
  ['strictMode not checked', 'status.strictMode === true && ', ''],
  ['unavailableReason not checked', ' && !status.unavailableReason', ''],
  ['claude failure counts as ready', "return { state: 'no sandbox', why: `claude sandbox status failed", "status = {}; if (false) return { state: 'no sandbox', why: `claude sandbox status failed"],
];
const rows = [];
try {
  for (const [name, a, b] of M) {
    if (!orig.includes(a)) { rows.push(`NOT APPLIED  ${name}`); continue; }
    writeFileSync(F, orig.replace(a, b));
    const r = spawnSync(process.execPath, ['--test', 'test/t156-lead-policy.test.js', 'test/t156-git-control.test.js'], { cwd: W, encoding: 'utf8' });
    const failed = (/ℹ fail (\d+)/.exec(r.stdout) ?? [])[1];
    rows.push(`${r.status !== 0 ? 'KILLED' : 'SURVIVED'}  ${name}  (failing tests: ${failed ?? '?'})`);
  }
} finally { rmSync(W, { recursive: true, force: true }); }
console.log(rows.join('\n'));
const killed = rows.filter((r) => r.startsWith('KILLED')).length;
console.log(`${killed} of ${M.length} killed`);
if (killed !== M.length) process.exitCode = 1;
