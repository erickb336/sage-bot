// T156 (T134 PR 1): the lead policy. One resolver for every path and name of a lead session's containment, the settings made from it,
// the refusal of a session folder that overlaps a denied path, and the preflight's two "not ready" states. SAMPLE DATA ONLY: the paths
// are made up, the state tool and `claude` are dummies, and no model session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { LEAD_PATH, MODEL_KEY, launchOf, leadPolicy, preflight, settingsOf } from '../src/lead-policy.js';

const ROOT = join(import.meta.dirname, '..');
// Folders that do not exist on the host, so the resolver takes them as written.
const HOST = { env: {}, home: '/h', tmp: '/t', userTemp: '/u', shortTmp: '/st' };
const CONFIG = { statePath: '/s/state/gates.json' };

const DENIED = [
  '/s/state', // the state folder (F-T134-2)
  '/s/state/gates.json.leads.jsonl', '/s/state/gates.json.leads-off', // the lead log and the kill switch (F-T134-2)
  '/s/state/gates.json.sessions', '/s/state/gates.json.votes', '/s/state/gates.json.votes.leads', // the spool and the vote files
  '/h/.config/sage-bot', // the bridge's config folder (F-T134-2)
  '/h/.claude/plugins/cache/sage', '/h/.claude/plugins/marketplaces/sage', '/h/.claude/sage', // the sage plugin and root (F-T134-6, -12)
  '/t/sage-hooks', '/u/sage-hooks', '/h/.claude/sage/.hooks', // sage's hook state (F-T134-7, -12)
  '/h/.local/share/sage-bot/leads/claude', // the lead sessions' Claude Code config folder (F-T134-10)
];
const fileRules = (tool) => DENIED.flatMap((p) => [`${tool}(/${p})`, `${tool}(/${p}/**)`]);
// The git control paths of session s21 (F-T156-13): literal paths in its own .git, and every other .git below it, whole.
const S21 = '/h/.local/share/sage-bot/leads/sessions/s21';
const GIT_CONTROL = [
  `${S21}/.git/config`, `${S21}/.git/config.worktree`, `${S21}/.git/hooks`, `${S21}/.git/commondir`, `${S21}/.git/modules`,
  `${S21}/.git/info/attributes`, `${S21}/.git/worktrees`, `${S21}/*/**/.git`,
];
// The credential files (F-T156-5), git's global files that blockReadsOutsideWorkingDirectories re-opens, and the owner's Claude Code
// config folder (F-T156-15).
const CREDENTIALS = [...['.ssh', '.aws', '.config/gh', '.git-credentials', '.netrc', '.npmrc', '.gnupg', '.docker', '.kube', '.gitconfig', '.config/git'].map((f) => `/h/${f}`), '/h/.claude'];
/** A sage plugin cache with one version, v1, in a new Claude Code config folder below `root`; the state tool's path. */
function pluginCache(root, tool = "console.log('lead-sessions 1')") {
  const at = join(root, 'claude-config', 'plugins', 'cache', 'sage', 'sage', 'v1', 'skills', 'sage');
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'sage.mjs'), tool);
  return join(at, 'sage.mjs');
}

test('one resolver gives every path and name of a lead session', () => {
  assert.deepEqual(leadPolicy(CONFIG, 's21', HOST), {
    session: 's21',
    folder: '/h/.local/share/sage-bot/leads/sessions/s21',
    tmp: '/st/sage-lead-s21',
    home: '/h',
    credentialFiles: CREDENTIALS,
    hooksState: '/s/state/lead-hooks/s21',
    claudeDir: '/h/.local/share/sage-bot/leads/claude',
    denied: DENIED,
    hosts: [],
    deniedEnv: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'],
    maxUsd: 5,
    claude: 'claude', // no PATH on the host: the name as it is
    sageTool: null,
    pluginDir: null,
  });
});

test('the configured paths: auditPath, killPath, leadSessionsPath, SAGE_HOME and CLAUDE_CONFIG_DIR move what is denied', () => {
  const p = leadPolicy({ ...CONFIG, auditPath: '/a/leads.jsonl', killPath: '/k/off', leadSessionsPath: '/l' }, 's2', { ...HOST, env: { CLAUDE_CONFIG_DIR: '/c' } });
  assert.equal(p.folder, '/l/sessions/s2');
  for (const d of ['/a/leads.jsonl', '/k/off', '/c/sage', '/c/sage/.hooks', '/l/claude', '/c/plugins/cache/sage', '/c/plugins/marketplaces/sage']) assert.ok(p.denied.includes(d), d);
  for (const d of ['/s/state/gates.json.leads.jsonl', '/h/.claude/sage', '/h/.claude/plugins/cache/sage', '/h/.claude/plugins/marketplaces/sage']) assert.ok(!p.denied.includes(d), d);
  assert.ok(leadPolicy(CONFIG, 's2', { ...HOST, env: { SAGE_HOME: '/sh', CLAUDE_CONFIG_DIR: '/c' } }).denied.includes('/sh/.hooks'));
});

test('the settings snapshot: the sandbox, the file-tool rules, the host list, WebFetch and the credential variables', () => {
  assert.deepEqual(settingsOf(leadPolicy(CONFIG, 's21', HOST)), {
    permissions: {
      defaultMode: 'dontAsk',
      deny: [...fileRules('Read'), ...fileRules('Edit'), ...GIT_CONTROL.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`]), 'Edit(.claude/**)', 'Edit(.mcp.json)', 'Grep', 'WebFetch'],
      allow: ['Edit(//h/.local/share/sage-bot/leads/sessions/s21)', 'Edit(//h/.local/share/sage-bot/leads/sessions/s21/**)', 'Edit(//st/sage-lead-s21)', 'Edit(//st/sage-lead-s21/**)'],
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: ['/h', ...DENIED],
        allowRead: ['/h/.local/share/sage-bot/leads/sessions/s21', '/st/sage-lead-s21'],
        denyWrite: [...DENIED, ...GIT_CONTROL],
      },
      credentials: { files: CREDENTIALS.map((path) => ({ path, mode: 'deny' })), envVars: [
        { name: 'GH_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' },
        { name: 'GH_ENTERPRISE_TOKEN', mode: 'deny' }, { name: 'GITHUB_ENTERPRISE_TOKEN', mode: 'deny' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' }, // F-T156-21
      ] },
    },
  });
});

test('a host on the list: WebFetch only to it, and the sandbox reaches only it', () => {
  const s = settingsOf({ ...leadPolicy(CONFIG, 's21', HOST), hosts: ['registry.example.org'] });
  assert.deepEqual(s.permissions.allow.slice(4), ['WebFetch(domain:registry.example.org)']);
  assert.ok(!s.permissions.deny.includes('WebFetch'));
  assert.deepEqual(s.sandbox.network.allowedDomains, ['registry.example.org']);
});

test('the launch: claude -p with the settings, sage-bot\'s settings only, strict MCP, sage the only plugin, the budget, and the session\'s own folders', () => {
  const policy = { ...leadPolicy(CONFIG, 's21', HOST), pluginDir: '/h/.claude/plugins/cache/sage/sage/v1' };
  // F-T156-16: an allow-list. A sample secret, the GitHub variables and every other host variable stay out. SAMPLE VALUES ONLY.
  const env = { PATH: '/bin', HOME: '/elsewhere', LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm', [MODEL_KEY]: 'sample-not-a-key', SAMPLE_SECRET: 'sample-secret',
    AWS_SECRET_ACCESS_KEY: 'sample-5', ANTHROPIC_API_KEY: 'sample-6', GH_TOKEN: 'sample-1', GITHUB_TOKEN: 'sample-2', GH_ENTERPRISE_TOKEN: 'sample-3', GITHUB_ENTERPRISE_TOKEN: 'sample-4',
    CLAUDE_CONFIG_DIR: '/h/.claude', SAGE_TOOL: '/x/sage.mjs', SAGE_HOME: '/h/.claude/sage', XDG_CONFIG_HOME: '/x', GIT_DIR: '/x', NODE_OPTIONS: '--require /x', LC_: 'x', TERM_PROGRAM: 'x' };
  assert.deepEqual(launchOf(policy, env), {
    command: 'claude',
    args: ['-p', '--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', '--strict-mcp-config',
      '--plugin-dir', '/h/.claude/plugins/cache/sage/sage/v1', '--max-budget-usd', '5'],
    cwd: '/h/.local/share/sage-bot/leads/sessions/s21',
    env: { LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm', [MODEL_KEY]: 'sample-not-a-key',
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/h', TMPDIR: '/st/sage-lead-s21', CLAUDE_CODE_TMPDIR: '/st/sage-lead-s21',
      CLAUDE_CONFIG_DIR: '/h/.local/share/sage-bot/leads/claude', SAGE_HOOKS_STATE: '/s/state/lead-hooks/s21',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
  // F-T156-22: the scrub forces the permission mode to default (no dontAsk) and strips CLAUDE_CONFIG_DIR from hooks; set on the host or not, it stays out
  assert.ok(!('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in launchOf(policy, env).env));
  assert.ok(!('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in launchOf(policy, { ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }).env));
  assert.equal(MODEL_KEY, 'CLAUDE_CODE_OAUTH_TOKEN'); // the one model credential variable, by name
  assert.deepEqual(Object.keys(launchOf(policy, {}).env), ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CONFIG_DIR', 'SAGE_HOOKS_STATE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']);
  assert.ok(!launchOf({ ...policy, pluginDir: null }, env).args.includes('--plugin-dir')); // no state tool: no plugin
});

test('sage, the only plugin: --plugin-dir is the version folder of the denied plugin cache; a state tool outside that cache is refused (F-T156-14)', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const tool = pluginCache(root), config = join(root, 'claude-config'), cache = join(config, 'plugins', 'cache', 'sage');
    const h = (env) => ({ ...HOST, home: join(root, 'h'), env: { CLAUDE_CONFIG_DIR: config, ...env } });
    for (const env of [{}, { SAGE_TOOL: tool }]) { // found in the cache, or named by SAGE_TOOL in it
      const p = leadPolicy(CONFIG, 's1', h(env));
      assert.equal(p.pluginDir, join(cache, 'sage', 'v1'));
      assert.ok(p.denied.includes(cache));
      assert.deepEqual(launchOf(p, {}).args.slice(6, 8), ['--plugin-dir', join(cache, 'sage', 'v1')]);
    }
    mkdirSync(join(root, 'scratch'));
    writeFileSync(join(root, 'scratch', 'sage.mjs'), '');
    symlinkSync(join(root, 'scratch'), join(cache, 'sage', 'v2'));
    writeFileSync(join(cache, 'sage.mjs'), '');
    for (const [bad, real] of [[join(root, 'scratch', 'sage.mjs')], [join(cache, 'sage', 'v2', 'sage.mjs'), join(root, 'scratch', 'sage.mjs')], [join(cache, 'sage.mjs')]]) {
      assert.throws(() => leadPolicy(CONFIG, 's1', h({ SAGE_TOOL: bad })), { message: `the sage state tool ${real ?? bad} is not in a version folder of the sage plugin's cache ${cache}, the only folder that a lead session loads sage from. Unset SAGE_TOOL, or set it to a sage.mjs in that cache. Nothing was started.` });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the claude command is found in the host\'s PATH, because the session\'s PATH is fixed', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    for (const d of ['a', 'b', 'c/claude']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'a', 'claude'), ''); // not executable
    writeFileSync(join(root, 'b', 'claude'), '#!/bin/sh\n');
    chmodSync(join(root, 'b', 'claude'), 0o755);
    const PATH = [relative(process.cwd(), join(root, 'b')), join(root, 'c'), join(root, 'a'), join(root, 'b')].join(':'); // a relative folder is skipped; c/claude is a folder
    assert.equal(leadPolicy(CONFIG, 's1', { ...HOST, env: { PATH } }).claude, join(root, 'b', 'claude'));
    assert.equal(leadPolicy(CONFIG, 's1', { ...HOST, env: { PATH }, claude: '/opt/claude' }).claude, '/opt/claude');
    assert.ok(!LEAD_PATH.split(':').includes(join(root, 'b')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLAUDE_CONFIG_DIR: empty counts as not set; a relative one is refused (F-T156-17)', () => {
  assert.ok(leadPolicy(CONFIG, 's1', { ...HOST, env: { CLAUDE_CONFIG_DIR: '' } }).denied.includes('/h/.claude/plugins/cache/sage'));
  for (const bad of ['claude', './c', '~/.claude']) {
    assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, env: { CLAUDE_CONFIG_DIR: bad } }), { message: `CLAUDE_CONFIG_DIR must be an absolute path, not ${JSON.stringify(bad)}.` });
  }
});

test('refusal: a link to a path that is not made yet, at sessions or at the temp folder (F-T156-17)', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const state = join(root, 'state'), c = { statePath: join(state, 'gates.json') };
    for (const d of [state, join(root, 'l'), join(root, 'st'), join(root, 'ok')]) mkdirSync(d);
    const h = { ...HOST, home: join(root, 'h'), shortTmp: join(root, 'st') };
    const message = (at) => `${at} is a link to a path that does not exist (or a loop), so its real path is unknown: the sandbox could not keep the session out. Nothing was started.`;
    symlinkSync(join(state, 'later'), join(root, 'l', 'sessions')); // into the denied state folder, not made yet
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l') }, 's1', h), { message: message(join(root, 'l', 'sessions')) });
    symlinkSync(join(state, 'later-tmp'), join(root, 'st', 'sage-lead-s1'));
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'ok') }, 's1', h), { message: message(join(root, 'st', 'sage-lead-s1')) });
    assert.equal(leadPolicy({ ...c, leadSessionsPath: join(root, 'ok') }, 's2', h).folder, join(root, 'ok', 'sessions', 's2')); // no link: fine
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refusal: a session folder in a denied path, or a denied path in the session folder, starts nothing', () => {
  assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: '/s/state/leads' }, 's1', HOST),
    { message: 'the lead session\'s session folder /s/state/leads/sessions/s1 is in the denied path /s/state: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.' });
  assert.throws(() => leadPolicy({ statePath: '/l/sessions/s1/state/gates.json', leadSessionsPath: '/l' }, 's1', HOST),
    { message: 'the lead session\'s session folder /l/sessions/s1 holds the denied path /l/sessions/s1/state: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.' });
  assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, shortTmp: '/s/state' }), { message: /temp folder \/s\/state\/sage-lead-s1 is in the denied path \/s\/state:/ });
  assert.equal(leadPolicy(CONFIG, 's1', HOST).folder, '/h/.local/share/sage-bot/leads/sessions/s1'); // the same config without the overlap is fine
});

test('refusal: a link at the leads folder, at sessions, at sessions/<name> or at the temp folder is seen by its real path (F-T156-6)', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const state = join(root, 'state'), home = join(root, 'home'), config = join(home, '.config', 'sage-bot');
    for (const d of [state, config, join(root, 'l2'), join(root, 'l3', 'sessions'), join(root, 'st')]) mkdirSync(d, { recursive: true });
    const c = { statePath: join(state, 'gates.json') };
    const h = { ...HOST, home, shortTmp: join(root, 'st') };
    symlinkSync(state, join(root, 'l1')); // the leads folder
    symlinkSync(config, join(root, 'l2', 'sessions')); // sessions, into the bridge's config folder
    symlinkSync(state, join(root, 'l3', 'sessions', 's1')); // sessions/s1
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l1', 'leads') }, 's1', h), { message: `the lead session's session folder ${state}/leads/sessions/s1 is in the denied path ${state}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.` });
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l2') }, 's1', h), { message: `the lead session's session folder ${config}/s1 is in the denied path ${config}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.` });
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l3') }, 's1', h), { message: `the lead session's session folder ${state} is in the denied path ${state}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.` });
    assert.equal(leadPolicy({ ...c, leadSessionsPath: join(root, 'l3') }, 's2', h).folder, join(root, 'l3', 'sessions', 's2')); // s2 is no link
    symlinkSync(state, join(root, 'st', 'sage-lead-s1')); // the temp folder
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'leads') }, 's1', h), { message: `the lead session's temp folder ${state} is in the denied path ${state}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.` });
    assert.equal(leadPolicy({ ...c, leadSessionsPath: join(root, 'leads') }, 's2', h).tmp, join(root, 'st', 'sage-lead-s2'));
    symlinkSync(home, join(root, 'home-link')); // the home folder that the sandbox denies is the real one
    assert.equal(leadPolicy({ ...c, leadSessionsPath: join(root, 'leads') }, 's2', { ...h, home: join(root, 'home-link') }).home, home);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refusal: a session name that is not s and a number, and a statePath or leadSessionsPath that is not absolute (F-T156-10)', () => {
  for (const bad of ['../x', 's0', 'S1', 's1/..', '', undefined]) assert.throws(() => leadPolicy(CONFIG, bad, HOST), { message: /a lead session's name is s and a number/ });
  assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: 'leads' }, 's1', HOST), { message: 'the config: leadSessionsPath must be an absolute path, not "leads". Nothing was started.' });
  for (const [bad, shown] of [['~/state/gates.json', '"~/state/gates.json"'], ['state/gates.json', '"state/gates.json"'], [null, 'null'], [undefined, 'null'], [7, '7']]) {
    assert.throws(() => leadPolicy({ statePath: bad }, 's1', HOST), { message: `the config: statePath must be an absolute path, not ${shown}. Nothing was started.` });
  }
});

/** A scratch folder with a dummy state tool and a dummy `claude`, each a sample. `tool` is the tool's body, `status` the JSON that claude prints. */
function host({ tool = "console.log('lead-sessions 1')", status = { supported: true, enabled: true, strictMode: true, unavailableReason: null }, claudeExit = 0 } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  pluginCache(root, tool);
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "${root}/config-dir"\necho '${JSON.stringify(status)}'\nexit ${claudeExit}\n`);
  chmodSync(claude, 0o755);
  const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(root, 'claude-config') };
  const policy = leadPolicy({ statePath: join(root, 'state', 'gates.json') }, 's1', { env, home: join(root, 'home'), tmp: join(root, 'tmp'), userTemp: undefined, shortTmp: root, claude });
  return { root, env, policy, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('preflight: ready when the state tool prints the line and claude says supported, enabled and strict, with the session\'s settings', async () => {
  const h = host();
  try {
    assert.deepEqual(await preflight(h.policy, h.env), { state: 'ready', why: 'the state tool prints the line, and the sandbox is supported, enabled and strict' });
    assert.deepEqual(readFileSync(join(h.root, 'argv'), 'utf8').split('\n').slice(0, -1), ['--settings', JSON.stringify(settingsOf(h.policy)), '--setting-sources', '', 'sandbox', 'status']);
    assert.equal(readFileSync(join(h.root, 'config-dir'), 'utf8'), h.policy.claudeDir);
  } finally { h.done(); }
});

test('preflight: "waiting for sage T127" when the state tool omits the line, fails, or is not there; claude is not asked', async () => {
  const cases = [
    [{ tool: "console.log('lead-sessions 0'); console.log('other 1')" }, 'the state tool does not print "lead-sessions 1"'],
    [{ tool: "console.log(' lead-sessions 1 x')" }, 'the state tool does not print "lead-sessions 1"'],
    [{ tool: "console.error('unknown command: capabilities'); process.exit(1)" }, /^the state tool's capabilities failed: .*unknown command: capabilities/],
  ];
  for (const [o, why] of cases) {
    const h = host(o);
    try {
      const r = await preflight(h.policy, h.env);
      assert.equal(r.state, 'waiting for sage T127');
      if (typeof why === 'string') assert.equal(r.why, why); else assert.match(r.why, why);
      assert.throws(() => readFileSync(join(h.root, 'argv')), { code: 'ENOENT' }); // claude did not run
    } finally { h.done(); }
  }
  const h = host();
  try {
    assert.deepEqual(await preflight({ ...h.policy, sageTool: null }, h.env), { state: 'waiting for sage T127', why: 'the sage state tool is not installed' });
  } finally { h.done(); }
});

test('preflight: "no sandbox" when claude says not enabled, not strict, not supported, unavailable, or fails', async () => {
  const ok = { supported: true, enabled: true, strictMode: true, unavailableReason: null };
  const cases = [
    [{ status: { ...ok, enabled: false } }, 'claude sandbox status: supported true, enabled false, strict true'],
    [{ status: { ...ok, strictMode: false } }, 'claude sandbox status: supported true, enabled true, strict false'],
    [{ status: { ...ok, supported: false } }, 'claude sandbox status: supported false, enabled true, strict true'],
    [{ status: { ...ok, unavailableReason: 'bubblewrap is not installed' } }, 'claude sandbox status: supported true, enabled true, strict true, bubblewrap is not installed'],
    [{ claudeExit: 1 }, /^claude sandbox status failed: /],
  ];
  for (const [o, why] of cases) {
    const h = host(o);
    try {
      const r = await preflight(h.policy, h.env);
      assert.equal(r.state, 'no sandbox');
      if (typeof why === 'string') assert.equal(r.why, why); else assert.match(r.why, why);
    } finally { h.done(); }
  }
});

test('the script prints the settings of a sample config, and the preflight state, with sample paths only', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify({ statePath: join(root, 'state', 'gates.json') }));
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), GH_TOKEN: 'sample-secret' };
    const run = (...a) => spawnSync(process.execPath, ['scripts/lead-policy.mjs', '--config', config, ...a], { cwd: ROOT, encoding: 'utf8', env });
    const s = run('--session', 's7', 'settings');
    assert.equal(s.status, 0, s.stderr);
    const out = JSON.parse(s.stdout);
    assert.equal(out.policy.folder, join(root, 'home', '.local', 'share', 'sage-bot', 'leads', 'sessions', 's7'));
    assert.deepEqual(out.settings.sandbox.filesystem.denyRead.slice(1, 3), [join(root, 'state'), join(root, 'state', 'gates.json.leads.jsonl')]);
    assert.ok(out.settings.sandbox.filesystem.denyRead.includes(join(root, 'home', '.config', 'sage-bot')));
    assert.deepEqual(Object.keys(out.launch.env), ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CONFIG_DIR', 'SAGE_HOOKS_STATE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']); // no value of the host's environment
    assert.deepEqual(out.settings.sandbox.filesystem.allowRead, [out.policy.folder, out.policy.tmp]);
    assert.equal(out.settings.sandbox.filesystem.denyRead[0], join(root, 'home'));
    assert.ok(!s.stdout.includes('sample-secret'));
    const p = run('preflight'); // no sage plugin in the scratch HOME
    assert.equal(p.status, 1);
    assert.equal(p.stdout, 'lead sessions: waiting for sage T127 (the sage state tool is not installed)\n');
    const usage = 'usage: settings or preflight, with --config <config.json> and --session <s1> when needed';
    assert.equal(run('start').stderr, `sage-bot lead-policy: ${usage}\n`);
    const bare = (...a) => spawnSync(process.execPath, ['scripts/lead-policy.mjs', ...a], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(bare('settings', '--config').stderr, `sage-bot lead-policy: --config needs a value. ${usage}\n`); // F-T156-11
    assert.equal(bare('--config', '--session', 's1', 'settings').stderr, `sage-bot lead-policy: --config needs a value. ${usage}\n`);
    writeFileSync(config, JSON.stringify({ statePath: null }));
    assert.equal(run('settings').stderr, 'sage-bot lead-policy: the config: statePath must be an absolute path, not null. Nothing was started.\n');
    writeFileSync(config, '{ "statePath": '); // F-T156-17: a parse error names the file
    assert.match(run('settings').stderr, new RegExp(`^sage-bot lead-policy: the config ${config}: .*JSON.*\n$`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one resolver: no module but src/lead-policy.js (and sagePlugin in src/sage.js) names the paths it resolves; the mutation run is left out', () => {
  const out = spawnSync('grep', ['-rnE', "sage-hooks|'\\.hooks'|DARWIN_USER_TEMP_DIR|CLAUDE_CODE_TMPDIR|SAGE_HOOKS_STATE|'\\.config', 'sage-bot'|marketplaces|'plugins', 'cache'", '--exclude=lead-policy-mutations.mjs', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  const files = [...new Set(out.split('\n').filter(Boolean).map((l) => l.split(':')[0]))].sort();
  assert.deepEqual(files, ['src/lead-policy.js', 'src/sage.js']);
  assert.match(out, /src\/sage\.js:\d+:  cache: join\(claudeDir, 'plugins', 'cache', 'sage'\),/); // sagePlugin: one place for the plugin folders
});

// F-T156-7: the real claude binary, when it is installed, with a scratch HOME and a dummy state tool. It runs only `claude --version`
// and `claude ... sandbox status`; no model session starts. Claude Code 2.1.289 reports strictMode true exactly when a settings source
// sets sandbox.allowUnsandboxedCommands to false, and strictModeSource "policy" when --settings has the key, whatever its value.
const versionHome = mkdtempSync(join(tmpdir(), 'sage-bot-t156-v-'));
const realClaude = spawnSync('claude', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: versionHome, DISABLE_TELEMETRY: '1' } });
rmSync(versionHome, { recursive: true, force: true });
test('preflight with the real claude: "ready" with the generated settings, and only scratch folders used', { skip: realClaude.status !== 0 && 'claude is not installed' }, async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    pluginCache(root);
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), CLAUDE_CONFIG_DIR: join(root, 'claude-config'), DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    mkdirSync(env.TMPDIR);
    const policy = leadPolicy({ statePath: join(root, 'state', 'gates.json') }, 's1', { env, home: env.HOME, tmp: env.TMPDIR, userTemp: undefined, shortTmp: root });
    assert.deepEqual(await preflight(policy, env), { state: 'ready', why: 'the state tool prints the line, and the sandbox is supported, enabled and strict' });
    const loose = settingsOf(policy); loose.sandbox.allowUnsandboxedCommands = true;
    const status = JSON.parse(spawnSync(policy.claude, ['--settings', JSON.stringify(loose), '--setting-sources', '', 'sandbox', 'status'], { encoding: 'utf8', env: launchOf(policy, env).env }).stdout);
    assert.deepEqual([status.enabled, status.strictMode, status.strictModeSource], [true, false, 'policy']); // the cause of F-T156-7
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight: a claude that ignores SIGTERM is killed at the timeout, and the state is "no sandbox"', async () => {
  const h = host();
  try {
    writeFileSync(h.policy.claude, "#!/bin/sh\ntrap '' TERM\nexec sleep 5\n");
    const start = Date.now();
    const r = await preflight(h.policy, h.env, 300);
    assert.equal(r.state, 'no sandbox');
    assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  } finally { h.done(); }
});
