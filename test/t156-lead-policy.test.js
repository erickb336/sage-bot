// T156 (T134 PR 1): the lead policy. One resolver for every path and name of a lead session's containment, the settings made from it,
// the refusal of a session folder that overlaps a denied path, and the preflight's two "not ready" states. SAMPLE DATA ONLY: the paths
// are made up, the state tool and `claude` are dummies, and no model session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchOf, leadPolicy, preflight, settingsOf } from '../src/lead-policy.js';

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

test('one resolver gives every path and name of a lead session', () => {
  assert.deepEqual(leadPolicy(CONFIG, 's21', HOST), {
    session: 's21',
    folder: '/h/.local/share/sage-bot/leads/sessions/s21',
    tmp: '/st/sage-lead-s21',
    hooksState: '/s/state/lead-hooks/s21',
    claudeDir: '/h/.local/share/sage-bot/leads/claude',
    denied: DENIED,
    hosts: [],
    deniedEnv: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'],
    maxUsd: 5,
    claude: 'claude',
    sageTool: null,
  });
});

test('the configured paths: auditPath, killPath, leadsPath, SAGE_HOME and CLAUDE_CONFIG_DIR move what is denied', () => {
  const p = leadPolicy({ ...CONFIG, auditPath: '/a/leads.jsonl', killPath: '/k/off', leadsPath: '/l' }, 's2', { ...HOST, env: { CLAUDE_CONFIG_DIR: '/c' } });
  assert.equal(p.folder, '/l/sessions/s2');
  assert.ok(p.denied.includes('/a/leads.jsonl') && p.denied.includes('/k/off') && p.denied.includes('/c/sage') && p.denied.includes('/c/sage/.hooks') && p.denied.includes('/l/claude'));
  assert.ok(!p.denied.includes('/s/state/gates.json.leads.jsonl') && !p.denied.includes('/h/.claude/sage'));
  assert.ok(leadPolicy(CONFIG, 's2', { ...HOST, env: { SAGE_HOME: '/sh', CLAUDE_CONFIG_DIR: '/c' } }).denied.includes('/sh/.hooks'));
});

test('the settings snapshot: the sandbox, the file-tool rules, the host list, WebFetch and the credential variables', () => {
  assert.deepEqual(settingsOf(leadPolicy(CONFIG, 's21', HOST)), {
    permissions: {
      defaultMode: 'dontAsk',
      deny: [...fileRules('Read'), ...fileRules('Edit'), ...fileRules('Write'),
        'Edit(.claude/**)', 'Write(.claude/**)', 'Edit(.mcp.json)', 'Write(.mcp.json)', 'WebFetch'],
      allow: [],
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
      filesystem: { denyRead: DENIED, denyWrite: DENIED },
      credentials: { envVars: [
        { name: 'GH_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' },
        { name: 'GH_ENTERPRISE_TOKEN', mode: 'deny' }, { name: 'GITHUB_ENTERPRISE_TOKEN', mode: 'deny' },
      ] },
    },
  });
});

test('a host on the list: WebFetch only to it, and the sandbox reaches only it', () => {
  const s = settingsOf({ ...leadPolicy(CONFIG, 's21', HOST), hosts: ['registry.example.org'] });
  assert.deepEqual(s.permissions.allow, ['WebFetch(domain:registry.example.org)']);
  assert.ok(!s.permissions.deny.includes('WebFetch'));
  assert.deepEqual(s.sandbox.network.allowedDomains, ['registry.example.org']);
});

test('the launch: claude -p with the settings, sage-bot\'s settings only, strict MCP, sage the only plugin, the budget, and the session\'s own folders', () => {
  const policy = { ...leadPolicy(CONFIG, 's21', HOST), sageTool: '/h/.claude/plugins/cache/sage/sage/v1/skills/sage/sage.mjs' };
  const env = { PATH: '/bin', LANG: 'C', GH_TOKEN: 'sample-1', GITHUB_TOKEN: 'sample-2', GH_ENTERPRISE_TOKEN: 'sample-3', GITHUB_ENTERPRISE_TOKEN: 'sample-4', CLAUDE_CONFIG_DIR: '/h/.claude' };
  assert.deepEqual(launchOf(policy, env), {
    command: 'claude',
    args: ['-p', '--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', '--strict-mcp-config',
      '--plugin-dir', '/h/.claude/plugins/cache/sage/sage/v1', '--max-budget-usd', '5'],
    cwd: '/h/.local/share/sage-bot/leads/sessions/s21',
    env: { PATH: '/bin', LANG: 'C', SAGE_HOOKS_STATE: '/s/state/lead-hooks/s21', CLAUDE_CODE_TMPDIR: '/st/sage-lead-s21', CLAUDE_CONFIG_DIR: '/h/.local/share/sage-bot/leads/claude' },
  });
});

test('refusal: a session folder in a denied path, or a denied path in the session folder, starts nothing', () => {
  assert.throws(() => leadPolicy({ ...CONFIG, leadsPath: '/s/state/leads' }, 's1', HOST),
    { message: 'the lead session\'s session folder /s/state/leads/sessions/s1 is in the denied path /s/state: the sandbox could not keep the session out. Change leadsPath or statePath. Nothing was started.' });
  assert.throws(() => leadPolicy({ statePath: '/l/sessions/s1/state/gates.json', leadsPath: '/l' }, 's1', HOST),
    { message: 'the lead session\'s session folder /l/sessions/s1 holds the denied path /l/sessions/s1/state: the sandbox could not keep the session out. Change leadsPath or statePath. Nothing was started.' });
  assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, shortTmp: '/s/state' }), { message: /temp folder \/s\/state\/sage-lead-s1 is in the denied path \/s\/state:/ });
  assert.equal(leadPolicy(CONFIG, 's1', HOST).folder, '/h/.local/share/sage-bot/leads/sessions/s1'); // the same config without the overlap is fine
});

test('refusal: through a link, a session folder in a denied path is seen by its real path', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    mkdirSync(join(root, 'state'));
    spawnSync('ln', ['-s', join(root, 'state'), join(root, 'link')]);
    assert.throws(() => leadPolicy({ statePath: join(root, 'state', 'gates.json'), leadsPath: join(root, 'link', 'leads') }, 's1', HOST), { message: /is in the denied path/ });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refusal: a session name that is not s and a number, and a leadsPath that is not absolute', () => {
  for (const bad of ['../x', 's0', 'S1', 's1/..', '', undefined]) assert.throws(() => leadPolicy(CONFIG, bad, HOST), { message: /a lead session's name is s and a number/ });
  assert.throws(() => leadPolicy({ ...CONFIG, leadsPath: 'leads' }, 's1', HOST), { message: 'the config: leadsPath must be an absolute path. Nothing was started.' });
});

/** A scratch folder with a dummy state tool and a dummy `claude`, each a sample. `tool` is the tool's body, `status` the JSON that claude prints. */
function host({ tool = "console.log('lead-sessions 1')", status = { supported: true, enabled: true, strictMode: true, unavailableReason: null }, claudeExit = 0 } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  writeFileSync(join(root, 'sage.mjs'), tool);
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "${root}/config-dir"\necho '${JSON.stringify(status)}'\nexit ${claudeExit}\n`);
  chmodSync(claude, 0o755);
  const env = { PATH: process.env.PATH, SAGE_TOOL: join(root, 'sage.mjs') };
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
    assert.deepEqual(out.settings.sandbox.filesystem.denyRead.slice(0, 2), [join(root, 'state'), join(root, 'state', 'gates.json.leads.jsonl')]);
    assert.ok(out.settings.sandbox.filesystem.denyRead.includes(join(root, 'home', '.config', 'sage-bot')));
    assert.deepEqual(Object.keys(out.launch.env), ['SAGE_HOOKS_STATE', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CONFIG_DIR']); // no value of the host's environment
    assert.ok(!s.stdout.includes('sample-secret'));
    const p = run('preflight'); // no sage plugin in the scratch HOME
    assert.equal(p.status, 1);
    assert.equal(p.stdout, 'lead sessions: waiting for sage T127 (the sage state tool is not installed)\n');
    assert.equal(run('start').stderr, 'sage-bot lead-policy: usage: settings or preflight, with --config <config.json> and --session <s1> when needed\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one resolver: no module but src/lead-policy.js (and sagePlugin in src/sage.js) names the paths it resolves; the mutation run is left out', () => {
  const out = spawnSync('grep', ['-rnE', "sage-hooks|'\\.hooks'|DARWIN_USER_TEMP_DIR|CLAUDE_CODE_TMPDIR|SAGE_HOOKS_STATE|'\\.config', 'sage-bot'|marketplaces|'plugins', 'cache'", '--exclude=lead-policy-mutations.mjs', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  const files = [...new Set(out.split('\n').filter(Boolean).map((l) => l.split(':')[0]))].sort();
  assert.deepEqual(files, ['src/lead-policy.js', 'src/sage.js']);
  assert.match(out, /src\/sage\.js:\d+:  cache: join\(home, '\.claude', 'plugins', 'cache', 'sage'\),/); // sagePlugin: one place for the plugin folders
});
