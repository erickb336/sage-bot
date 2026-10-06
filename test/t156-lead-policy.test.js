// T156 (T134 PR 1): the lead policy. One resolver for every path and name of a lead session's containment, the settings made from it,
// the refusal of a session folder that overlaps a denied path, and the preflight's two "not ready" states. SAMPLE DATA ONLY: the paths
// are made up, the state tool and `claude` are dummies, and no model session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './bridge-setup.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { CLAUDE_TMP_MAX, LEAD_PATH, MODEL_KEYS, TEMP_ROOT, launchOf, leadPolicy, preflight, settingsOf } from '../src/lead-policy.js';

const ROOT = join(import.meta.dirname, '..');
// Folders that do not exist on the host, so the resolver takes them as written.
const HOST = { env: {}, home: '/h', owner: '/h', userTemp: '/u', tempRoot: '/st/sage-lead' };
const CONFIG = { statePath: '/s/state/gates.json' };
/** The one-line refusal of a path that is not canonical (canonicalPath in src/sage.js); `real` when the path's real path differs. */
const notCanonical = (what, path, real) => `${what} must be a canonical path (absolute; only A-Z, a-z, 0-9, ".", "_", "-" and a space between them; no empty, "." or ".." part; no "." at the start of the first part; no link; the letter case of the disk), not ${JSON.stringify(path ?? null)}${real ? `; its real path is ${JSON.stringify(real)}` : ''}. Nothing was started.`;

const DENIED = [
  '/s/state', '/s/state/gates.json', // the state folder (F-T134-2), and the state file by its real path (a link at it counts by its target)
  '/s/state/gates.json.leads.jsonl', '/s/state/gates.json.leads-off', // the lead log and the kill switch (F-T134-2)
  '/s/state/gates.json.sessions', '/s/state/gates.json.votes', '/s/state/gates.json.votes.leads', // the spool and the vote files
  '/h/.config/sage-bot', // the bridge's config folder (F-T134-2)
  '/h/.claude/plugins/cache/sage', '/h/.claude/plugins/marketplaces/sage', '/h/.claude/sage', // the sage plugin and root (F-T134-6, -12)
  '/u/sage-hooks', '/private/tmp/sage-hooks', '/h/.claude/sage/.hooks', // sage's hook state (F-T134-7, F-T156-40, -12)
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
    tmp: '/st/sage-lead/s21',
    sessions: '/h/.local/share/sage-bot/leads/sessions',
    tempRoot: '/st/sage-lead',
    home: '/h',
    homes: ['/h'],
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
      allow: ['Edit(//h/.local/share/sage-bot/leads/sessions/s21)', 'Edit(//h/.local/share/sage-bot/leads/sessions/s21/**)', 'Edit(//st/sage-lead/s21)', 'Edit(//st/sage-lead/s21/**)'],
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: ['/h', '/h/.local/share/sage-bot/leads/sessions', '/st/sage-lead', ...DENIED], // F-T156-31: every session's folders
        allowRead: ['/h/.local/share/sage-bot/leads/sessions/s21', '/st/sage-lead/s21'],
        denyWrite: [...DENIED, ...GIT_CONTROL],
      },
      credentials: { files: CREDENTIALS.map((path) => ({ path, mode: 'deny' })), envVars: [
        { name: 'GH_TOKEN', mode: 'deny' }, { name: 'GITHUB_TOKEN', mode: 'deny' },
        { name: 'GH_ENTERPRISE_TOKEN', mode: 'deny' }, { name: 'GITHUB_ENTERPRISE_TOKEN', mode: 'deny' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' }, { name: 'ANTHROPIC_API_KEY', mode: 'deny' }, // F-T156-21, F-T157-8
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
  const env = { PATH: '/bin', HOME: '/elsewhere', LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm', CLAUDE_CODE_OAUTH_TOKEN: 'sample-not-a-key', SAMPLE_SECRET: 'sample-secret',
    AWS_SECRET_ACCESS_KEY: 'sample-5', ANTHROPIC_API_KEY: 'sample-6', GH_TOKEN: 'sample-1', GITHUB_TOKEN: 'sample-2', GH_ENTERPRISE_TOKEN: 'sample-3', GITHUB_ENTERPRISE_TOKEN: 'sample-4',
    CLAUDE_CONFIG_DIR: '/h/.claude', SAGE_TOOL: '/x/sage.mjs', SAGE_HOME: '/h/.claude/sage', XDG_CONFIG_HOME: '/x', GIT_DIR: '/x', NODE_OPTIONS: '--require /x', LC_: 'x', TERM_PROGRAM: 'x' };
  const model = { CLAUDE_CODE_OAUTH_TOKEN: 'sample-from-the-caller' }; // F-T157-8: the caller names and gives it; the host's is not taken
  assert.deepEqual(launchOf(policy, env, model), {
    command: 'claude',
    args: ['-p', '--settings', JSON.stringify(settingsOf(policy)), '--setting-sources', '', '--strict-mcp-config',
      '--plugin-dir', '/h/.claude/plugins/cache/sage/sage/v1', '--max-budget-usd', '5'],
    cwd: '/h/.local/share/sage-bot/leads/sessions/s21',
    env: { LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm', CLAUDE_CODE_OAUTH_TOKEN: 'sample-from-the-caller',
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/h', TMPDIR: '/st/sage-lead/s21', CLAUDE_CODE_TMPDIR: '/st/sage-lead/s21',
      CLAUDE_CONFIG_DIR: '/h/.local/share/sage-bot/leads/claude', SAGE_HOOKS_STATE: '/s/state/lead-hooks/s21',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
  // F-T156-22: the scrub forces the permission mode to default (no dontAsk) and strips CLAUDE_CONFIG_DIR from hooks; set on the host or not, it stays out
  assert.ok(!('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in launchOf(policy, env).env));
  assert.ok(!('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in launchOf(policy, { ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }).env));
  assert.deepEqual(Object.keys(launchOf(policy, env).env).filter((k) => MODEL_KEYS.includes(k)), []); // F-T157-8: none from the host by name
  assert.deepEqual(Object.keys(launchOf(policy, {}).env), ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CONFIG_DIR', 'SAGE_HOOKS_STATE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']);
  assert.ok(!launchOf({ ...policy, pluginDir: null }, env).args.includes('--plugin-dir')); // no state tool: no plugin
});

test('sage, the only plugin: --plugin-dir is the version folder of the denied plugin cache; a state tool outside that cache, or not at sage/<version>/skills/sage/sage.mjs in it, is refused (F-T156-14, F-T156-24)', () => {
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
    mkdirSync(join(root, 'scratch', 'skills', 'sage'), { recursive: true });
    writeFileSync(join(root, 'scratch', 'sage.mjs'), '');
    writeFileSync(join(root, 'scratch', 'skills', 'sage', 'sage.mjs'), '');
    symlinkSync(join(root, 'scratch'), join(cache, 'sage', 'v2'));
    // F-T156-24: anything but exactly sage/<version>/skills/sage/sage.mjs in the cache, with sage.mjs files at the other places.
    const other = ['sage.mjs', 'sage/v1/sage.mjs', 'sage/v1/x/y/sage.mjs', 'other/v1/skills/sage/sage.mjs', 'x/sage/v1/skills/sage/sage.mjs', 'sage/v1/skills/other/sage.mjs', 'sage/v1/skills/sage/other.mjs'];
    for (const f of other) { mkdirSync(dirname(join(cache, f)), { recursive: true }); writeFileSync(join(cache, f), ''); }
    assert.throws(() => leadPolicy(CONFIG, 's1', h({ SAGE_TOOL: join(cache, 'sage', 'v2', 'sage.mjs') })), { message: notCanonical('SAGE_TOOL', join(cache, 'sage', 'v2', 'sage.mjs'), join(root, 'scratch', 'sage.mjs')) });
    utimesSync(join(root, 'scratch', 'sage.mjs'), new Date(), new Date(Date.now() + 60_000)); // v2, a link, is the newest version
    assert.throws(() => leadPolicy(CONFIG, 's1', h({})), { message: notCanonical('the sage state tool', join(cache, 'sage', 'v2', 'skills', 'sage', 'sage.mjs'), join(root, 'scratch', 'skills', 'sage', 'sage.mjs')) });
    for (const bad of [join(root, 'scratch', 'sage.mjs'), ...other.map((f) => join(cache, f))]) {
      assert.throws(() => leadPolicy(CONFIG, 's1', h({ SAGE_TOOL: bad })), { message: `the sage state tool ${bad} is not ${cache}/sage/<version>/skills/sage/sage.mjs, the sage plugin of the sage marketplace, the only place that a lead session loads sage from. Unset SAGE_TOOL, or set it to that sage.mjs. Nothing was started.` });
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
    // A SAGE_TOOL with no file at its canonical path is refused, not taken as "not installed".
    assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, env: { SAGE_TOOL: join(root, 'none.mjs') } }), { message: `SAGE_TOOL is set to ${join(root, 'none.mjs')}, but there is no file there. Set SAGE_TOOL to the sage plugin's sage.mjs.` });
    assert.ok(!LEAD_PATH.split(':').includes(join(root, 'b')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLAUDE_CONFIG_DIR: empty counts as not set; a relative one is refused (F-T156-17)', () => {
  assert.ok(leadPolicy(CONFIG, 's1', { ...HOST, env: { CLAUDE_CONFIG_DIR: '' } }).denied.includes('/h/.claude/plugins/cache/sage'));
  for (const bad of ['claude', './c', '~/.claude', '/c/../d']) {
    assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, env: { CLAUDE_CONFIG_DIR: bad } }), { message: notCanonical('CLAUDE_CONFIG_DIR', bad) });
  }
});

test('refusal: a link to a path that is not made yet, at the state file or at sessions (F-T156-17)', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const state = join(root, 'state');
    for (const d of [state, join(root, 'l')]) mkdirSync(d);
    symlinkSync(join(state, 'later'), join(root, 'l', 'sessions')); // into the denied state folder, not made yet
    assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: join(root, 'l') }, 's1', HOST), { message: `the lead session's sessions folder ${join(root, 'l', 'sessions')} is a link: a session could reach another folder through it. Remove it. Nothing was started.` });
    symlinkSync(join(root, 'nothing'), join(state, 'gates.json')); // the state file: a link to nothing has no real path
    assert.throws(() => leadPolicy({ statePath: join(state, 'gates.json') }, 's1', HOST), { message: notCanonical('the config: statePath', join(state, 'gates.json')) });
    symlinkSync(join(root, 'l'), join(state, 'g.json.leads.jsonl')); // a denied path that the config does not name: the lead log
    assert.throws(() => leadPolicy({ statePath: join(state, 'g.json') }, 's1', HOST), { message: notCanonical('the denied path', join(state, 'g.json.leads.jsonl'), join(root, 'l')) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refusal: a session folder in a denied path, or a denied path in the session folder, starts nothing', () => {
  assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: '/s/state/leads' }, 's1', HOST),
    { message: 'the lead session\'s sessions folder /s/state/leads/sessions is in the denied path /s/state: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.' });
  assert.throws(() => leadPolicy({ statePath: '/l/sessions/s1/state/gates.json', leadSessionsPath: '/l' }, 's1', HOST),
    { message: 'the lead session\'s sessions folder /l/sessions holds the denied path /l/sessions/s1/state: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.' });
  assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, tempRoot: '/s/state/sage-lead' }), { message: /folder of all temp folders \/s\/state\/sage-lead is in the denied path \/s\/state:/ });
  assert.equal(leadPolicy(CONFIG, 's1', HOST).folder, '/h/.local/share/sage-bot/leads/sessions/s1'); // the same config without the overlap is fine
});

test('refusal: a link at the leads folder, at sessions, at any session folder or at the home folder (F-T156-6, F-T156-29, G48 A)', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const state = join(root, 'state'), home = join(root, 'home');
    for (const d of [state, home, join(root, 'l2'), join(root, 'l3', 'sessions')]) mkdirSync(d, { recursive: true });
    const c = { statePath: join(state, 'gates.json') };
    const link = (what, path) => ({ message: `the lead session's ${what} ${path} is a link: a session could reach another folder through it. Remove it. Nothing was started.` });
    symlinkSync(state, join(root, 'l1')); // the leads folder
    symlinkSync(home, join(root, 'l2', 'sessions')); // sessions
    symlinkSync(state, join(root, 'l3', 'sessions', 's1')); // sessions/s1
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l1') }, 's1', HOST), { message: notCanonical('the config: leadSessionsPath', join(root, 'l1'), state) });
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l2') }, 's1', HOST), link('sessions folder', join(root, 'l2', 'sessions')));
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l3') }, 's1', HOST), link('session folder', join(root, 'l3', 'sessions', 's1')));
    assert.equal(leadPolicy({ ...c, leadSessionsPath: join(root, 'l3') }, 's2', HOST).folder, join(root, 'l3', 'sessions', 's2')); // s1's link is s1's to refuse (F-T156-41)
    assert.equal(leadPolicy({ ...c, leadSessionsPath: join(root, 'l4') }, 's2', HOST).folder, join(root, 'l4', 'sessions', 's2')); // no link: fine
    mkdirSync(join(root, 'l5', 'Sessions'), { recursive: true }); // on the case-insensitive volume, "sessions" names this folder
    if (existsSync(join(root, 'l5', 'sessions'))) assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l5') }, 's2', HOST), { message: notCanonical('the lead session\'s sessions folder', join(root, 'l5', 'sessions'), join(root, 'l5', 'Sessions')) });
    symlinkSync(home, join(root, 'home-link'));
    assert.throws(() => leadPolicy({ ...c, leadSessionsPath: join(root, 'l4') }, 's2', { ...HOST, home: join(root, 'home-link') }), { message: notCanonical('HOME', join(root, 'home-link'), home) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refusal: a session name that is not s and a number, and a statePath or leadSessionsPath that is not absolute (F-T156-10)', () => {
  for (const bad of ['../x', 's0', 'S1', 's1/..', '', undefined]) assert.throws(() => leadPolicy(CONFIG, bad, HOST), { message: /a lead session's name is s and a number/ });
  assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: 'leads' }, 's1', HOST), { message: notCanonical('the config: leadSessionsPath', 'leads') });
  for (const bad of ['~/state/gates.json', 'state/gates.json', null, undefined, 7]) {
    assert.throws(() => leadPolicy({ statePath: bad }, 's1', HOST), { message: notCanonical('the config: statePath', bad) });
  }
});

/** A scratch folder with a dummy state tool and a dummy `claude`, each a sample. `tool` is the tool's body, `status` the JSON that claude prints. */
function host({ tool = "console.log('lead-sessions 1')", status = { supported: true, enabled: true, strictMode: true, unavailableReason: null }, claudeExit = 0 } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  pluginCache(root, tool);
  const claude = join(root, 'claude');
  // It records its arguments, its CLAUDE_CONFIG_DIR, and its two temp variables with whether that folder is there.
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "${root}/config-dir"\n` +
    `printf '%s\\n%s\\n' "$TMPDIR" "$CLAUDE_CODE_TMPDIR" > "${root}/tmp-vars"\ntest -d "$CLAUDE_CODE_TMPDIR" && echo there >> "${root}/tmp-vars"\necho '${JSON.stringify(status)}'\nexit ${claudeExit}\n`);
  chmodSync(claude, 0o755);
  const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(root, 'claude-config') };
  const policy = leadPolicy({ statePath: join(root, 'state', 'gates.json') }, 's1', { env, home: join(root, 'home'), userTemp: join(root, 'tmp'), tempRoot: '/st/sage-lead', claude });
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
    // A state tool in the scratch plugin cache that prints no capability line: the tests' spawnSync gives every child SAGE_TOOL (T162).
    // TMPDIR through a link, as macOS's /var/folders/<x>/T is (F-T156-40): the policy does not read it.
    mkdirSync(join(root, 'private-var', 'T'), { recursive: true }); symlinkSync(join(root, 'private-var'), join(root, 'var'));
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'var', 'T'), GH_TOKEN: 'sample-secret', CLAUDE_CONFIG_DIR: join(root, 'claude-config'), SAGE_TOOL: pluginCache(root, '') };
    const run = (...a) => spawnSync(process.execPath, ['scripts/lead-policy.mjs', '--config', config, ...a], { cwd: ROOT, encoding: 'utf8', env });
    const s = run('--session', 's7', 'settings');
    assert.equal(s.status, 0, s.stderr);
    const out = JSON.parse(s.stdout);
    assert.equal(out.policy.folder, join(root, 'home', '.local', 'share', 'sage-bot', 'leads', 'sessions', 's7'));
    assert.deepEqual(out.settings.sandbox.filesystem.denyRead.slice(1, 2), [userInfo().homedir]); // F-T157-7
    assert.deepEqual(out.settings.sandbox.filesystem.denyRead.slice(4, 7), [join(root, 'state'), join(root, 'state', 'gates.json'), join(root, 'state', 'gates.json.leads.jsonl')]);
    assert.ok(out.settings.sandbox.filesystem.denyRead.includes(join(root, 'home', '.config', 'sage-bot')));
    assert.deepEqual(Object.keys(out.launch.env), ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CONFIG_DIR', 'SAGE_HOOKS_STATE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']); // no value of the host's environment
    assert.deepEqual(out.settings.sandbox.filesystem.allowRead, [out.policy.folder, out.policy.tmp]);
    assert.equal(out.settings.sandbox.filesystem.denyRead[0], join(root, 'home'));
    assert.ok(!s.stdout.includes('sample-secret'));
    assert.equal(out.policy.pluginDir, join(root, 'claude-config', 'plugins', 'cache', 'sage', 'sage', 'v1'));
    assert.equal(out.policy.tempRoot, '/private/tmp/sage-lead'); // the fixed temp root, in its real form
    const userTemp = realpathSync.native(spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim());
    for (const d of [join(userTemp, 'sage-hooks'), '/private/tmp/sage-hooks']) assert.ok(out.settings.sandbox.filesystem.denyWrite.includes(d), d); // F-T156-40
    const p = run('preflight');
    assert.equal(p.status, 1);
    assert.equal(p.stdout, 'lead sessions: waiting for sage T127 (the state tool does not print "lead-sessions 1")\n');
    const usage = 'usage: settings or preflight, with --config <config.json> and --session <s1> when needed';
    assert.equal(run('start').stderr, `sage-bot lead-policy: ${usage}\n`);
    const bare = (...a) => spawnSync(process.execPath, ['scripts/lead-policy.mjs', ...a], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(bare('settings', '--config').stderr, `sage-bot lead-policy: --config needs a value. ${usage}\n`); // F-T156-11
    assert.equal(bare('--config', '--session', 's1', 'settings').stderr, `sage-bot lead-policy: --config needs a value. ${usage}\n`);
    writeFileSync(config, JSON.stringify({ statePath: null }));
    assert.equal(run('settings').stderr, `sage-bot lead-policy: ${notCanonical('the config: statePath', null)}\n`);
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
    const policy = leadPolicy({ statePath: join(root, 'state', 'gates.json') }, 's1', { env, home: env.HOME, userTemp: env.TMPDIR, tempRoot: '/st/sage-lead' });
    assert.deepEqual(await preflight(policy, env), { state: 'ready', why: 'the state tool prints the line, and the sandbox is supported, enabled and strict' });
    const loose = settingsOf(policy); loose.sandbox.allowUnsandboxedCommands = true;
    const status = JSON.parse(spawnSync(policy.claude, ['--settings', JSON.stringify(loose), '--setting-sources', '', 'sandbox', 'status'], { encoding: 'utf8', env: { ...launchOf(policy, env).env, TMPDIR: env.TMPDIR, CLAUDE_CODE_TMPDIR: env.TMPDIR } }).stdout);
    assert.deepEqual([status.enabled, status.strictMode, status.strictModeSource], [true, false, 'policy']); // the cause of F-T156-7
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight: a claude that ignores SIGTERM is killed at the timeout, and the state is "no sandbox"', async () => {
  const h = host();
  try {
    writeFileSync(h.policy.claude, "#!/bin/sh\ntrap '' TERM\nexec sleep 5\n");
    const start = Date.now();
    const r = await preflight(h.policy, h.env, { claude: 300 }); // F-T156-25: the state tool keeps its normal timeout under load
    assert.equal(r.state, 'no sandbox');
    assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  } finally { h.done(); }
});

test('preflight: a state tool that ignores SIGTERM is killed at its own timeout, and the state is "waiting for sage T127" (F-T156-25)', async () => {
  const h = host({ tool: "process.on('SIGTERM', () => {}); setTimeout(() => {}, 5000);" });
  try {
    const start = Date.now();
    const r = await preflight(h.policy, h.env, { tool: 300 });
    assert.deepEqual(r, { state: 'waiting for sage T127', why: "the state tool's capabilities failed: Command failed: " + `${process.execPath} ${h.policy.sageTool} capabilities` });
    assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  } finally { h.done(); }
});

test('F-T156-28: a ".." after a link is refused in every configured and environment path, because the OS follows the link first', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const h = join(root, 'h'), other = join(root, 'p', 'other', 'a');
    for (const d of [h, other]) mkdirSync(d, { recursive: true });
    symlinkSync(other, join(h, 'lnk2'));
    const path = join(h, 'lnk2') + '/../state.json';
    writeFileSync(path, 'x'); // what the bridge would do: the OS writes p/other/state.json, not h/state.json
    assert.equal(readFileSync(join(root, 'p', 'other', 'state.json'), 'utf8'), 'x');
    const why = (what) => ({ message: notCanonical(what, path) });
    for (const key of ['statePath', 'auditPath', 'killPath', 'sessionsPath', 'votesPath', 'leadSessionsPath']) {
      assert.throws(() => leadPolicy({ ...CONFIG, [key]: path }, 's1', HOST), why(`the config: ${key}`));
    }
    for (const key of ['SAGE_HOME', 'CLAUDE_CONFIG_DIR', 'SAGE_TOOL']) assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, env: { [key]: path } }), why(key));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-T156-30: a relative auditPath, killPath, sessionsPath or votesPath is refused, as statePath is', () => {
  for (const key of ['auditPath', 'killPath', 'sessionsPath', 'votesPath']) {
    for (const bad of ['leads.jsonl', './off', '~/votes', '']) {
      assert.throws(() => leadPolicy({ ...CONFIG, [key]: bad }, 's1', HOST), { message: notCanonical(`the config: ${key}`, bad) });
    }
  }
});

test('F-T156-31: with the leads folder outside the home folder, commands of one session read no other session\'s folder or temp folder', () => {
  const s1 = settingsOf(leadPolicy({ ...CONFIG, leadSessionsPath: '/l' }, 's1', HOST)).sandbox.filesystem;
  assert.deepEqual(s1.denyRead.slice(0, 3), ['/h', '/l/sessions', '/st/sage-lead']);
  assert.deepEqual(s1.allowRead, ['/l/sessions/s1', '/st/sage-lead/s1']);
  // s2's folders: in a denied path, and in no path that s1 re-opens
  for (const other of ['/l/sessions/s2', '/st/sage-lead/s2']) {
    assert.ok(s1.denyRead.some((d) => other.startsWith(`${d}/`)), other);
    assert.ok(!s1.allowRead.some((a) => other === a || other.startsWith(`${a}/`)), other);
  }
});

test('F-T156-31, F-T156-34: the sessions folder as a link into a temp folder, or in the folder of all temp folders, or holding it, is refused', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const temps = join(root, 'st', 'sage-lead'), leads = join(root, 'l');
    for (const d of [join(temps, 's1'), leads]) mkdirSync(d, { recursive: true, mode: 0o700 });
    symlinkSync(join(temps, 's1'), join(leads, 'sessions')); // s2's folder would be in s1's temp folder, which s1 writes
    assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: leads }, 's2', { ...HOST, tempRoot: temps }), { message: `the lead session's sessions folder ${join(leads, 'sessions')} is a link: a session could reach another folder through it. Remove it. Nothing was started.` });
  } finally { rmSync(root, { recursive: true, force: true }); }
  const nested = (what, path, how, other, d) => ({ message: `the lead session's ${what} ${path} ${how} the ${other} ${d}: the sandbox could not keep the session out. Change leadSessionsPath or statePath. Nothing was started.` });
  assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: '/st/sage-lead/s1' }, 's2', HOST), nested('sessions folder', '/st/sage-lead/s1/sessions', 'is in', 'folder of all temp folders', '/st/sage-lead'));
  assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: '/l' }, 's2', { ...HOST, tempRoot: '/l/sessions/t' }), nested('sessions folder', '/l/sessions', 'holds', 'folder of all temp folders', '/l/sessions/t'));
  assert.throws(() => leadPolicy({ ...CONFIG, leadSessionsPath: '/l' }, 's2', { ...HOST, tempRoot: '/l/sessions' }), nested('sessions folder', '/l/sessions', 'is in', 'folder of all temp folders', '/l/sessions'));
  assert.throws(() => leadPolicy(CONFIG, 's2', { ...HOST, tempRoot: '/h/.config' }), nested('folder of all temp folders', '/h/.config', 'holds', 'denied path', '/h/.config/sage-bot'));
  assert.equal(leadPolicy({ ...CONFIG, leadSessionsPath: '/l' }, 's2', HOST).folder, '/l/sessions/s2'); // apart: fine
});

test('F-T156-40: no rule of the policy comes from TMPDIR; it denies sage-hooks in the real DARWIN_USER_TEMP_DIR and in /private/tmp', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    // A stand-in of macOS's /var/folders/<x>/T, a link to /private/var/folders/<x>/T: the TMPDIR of the owner's Terminal and of launchd.
    const T = join(root, 'private', 'var', 'folders', 'x', 'T'), linked = join(root, 'var', 'folders', 'x', 'T');
    mkdirSync(T, { recursive: true });
    symlinkSync(join(root, 'private', 'var'), join(root, 'var'));
    const p = leadPolicy(CONFIG, 's1', { ...HOST, env: { TMPDIR: linked }, userTemp: T });
    const s = settingsOf(p);
    for (const d of [join(T, 'sage-hooks'), '/private/tmp/sage-hooks']) {
      assert.ok(p.denied.includes(d), d);
      assert.ok(s.sandbox.filesystem.denyWrite.includes(d), d);
      assert.ok(s.permissions.deny.includes(`Read(/${d}/**)`), d);
    }
    assert.ok(!JSON.stringify(s).includes(linked)); // TMPDIR's text is in no rule
    assert.deepEqual(leadPolicy(CONFIG, 's1', { ...HOST, env: { TMPDIR: 'not a path' } }), leadPolicy(CONFIG, 's1', HOST)); // TMPDIR changes nothing
    // the folder from getconf goes through the one path rule: by its link it is refused, with its real path
    assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, userTemp: linked }), { message: notCanonical('DARWIN_USER_TEMP_DIR', linked, T) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-T156-40: by default the policy runs getconf DARWIN_USER_TEMP_DIR and takes its real path; when getconf fails, it refuses with one line', () => {
  const { userTemp: _, ...host } = HOST;
  const real = realpathSync.native(spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim());
  assert.match(real, /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/);
  assert.ok(leadPolicy(CONFIG, 's1', host).denied.includes(join(real, 'sage-hooks')));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const policy = (getconf) => {
      writeFileSync(join(root, 'getconf'), `#!/bin/sh\n${getconf}\n`, { mode: 0o755 });
      const code = `import { leadPolicy } from ${JSON.stringify(join(ROOT, 'src', 'lead-policy.js'))};\ntry { leadPolicy(${JSON.stringify(CONFIG)}, 's1', ${JSON.stringify(host)}); console.log('started'); } catch (e) { console.log(e.message); }`;
      return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: `${root}:/usr/bin:/bin` } }).stdout;
    };
    assert.equal(policy('exit 1'), 'getconf DARWIN_USER_TEMP_DIR gave no folder (Command failed: getconf DARWIN_USER_TEMP_DIR): the policy cannot deny sage\'s hook state in it. Nothing was started.\n');
    assert.equal(policy('exit 0'), 'getconf DARWIN_USER_TEMP_DIR gave no folder (ENOENT: no such file or directory, realpath \'\'): the policy cannot deny sage\'s hook state in it. Nothing was started.\n');
    assert.equal(policy(`echo ${root}/`), 'started\n'); // the same run with a getconf that gives a folder
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-T156-41: a .DS_Store in the sessions folder or the temp root is no refusal; a link or a bad folder that this session uses still is', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-')));
  try {
    const leads = join(root, 'leads'), sessions = join(leads, 'sessions'), temps = join(root, 'tt');
    for (const d of [leads, sessions, temps]) mkdirSync(d, { mode: 0o700 });
    for (const d of [sessions, temps]) writeFileSync(join(d, '.DS_Store'), 'Finder');
    const config = { ...CONFIG, leadSessionsPath: leads };
    assert.equal(leadPolicy(config, 's1', HOST).folder, join(sessions, 's1'));
    // every folder rule passes with the temp root here; the scratch root is too long for the per-user temp rule, which comes last
    const long = { message: new RegExp(`^the lead session's per-user temp folder ${temps}/s1/claude-\\d+ is longer than 44 bytes`) };
    assert.throws(() => leadPolicy(config, 's1', { ...HOST, tempRoot: temps }), long);
    const bad = (what, path, why) => ({ message: `the lead session's ${what} ${path} is ${why}: a session could reach another folder through it. Remove it. Nothing was started.` });
    symlinkSync(root, join(sessions, 's1'));
    assert.throws(() => leadPolicy(config, 's1', HOST), bad('session folder', join(sessions, 's1'), 'a link'));
    writeFileSync(join(temps, 's1'), '');
    assert.throws(() => leadPolicy({ ...config, leadSessionsPath: join(root, 'l2') }, 's1', { ...HOST, tempRoot: temps }), bad('temp folder', join(temps, 's1'), 'not a folder'));
    assert.throws(() => leadPolicy(config, 's2', { ...HOST, uid: process.getuid() + 1 }), bad('leads folder', leads, `owned by the user ${process.getuid()}, not ${process.getuid() + 1}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-T156-35: the per-user temp folder <temp folder>/claude-<uid> is at most CLAUDE_TMP_MAX bytes, else Claude Code would use the shared /tmp/claude-<uid>', () => {
  const at = (n) => `/${'x'.repeat(n - 1)}`; // a temp root of n bytes; the per-user folder is 14 bytes more: /s1/claude-501
  assert.equal(leadPolicy(CONFIG, 's1', { ...HOST, uid: 501, tempRoot: at(30) }).tmp, `${at(30)}/s1`); // 44 bytes: fine
  assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, uid: 501, tempRoot: at(31) }), { message: `the lead session's per-user temp folder ${at(31)}/s1/claude-501 is longer than 44 bytes: Claude Code would give its commands the shared /tmp/claude-501 (F-T156-35). Nothing was started.` });
  assert.throws(() => leadPolicy(CONFIG, 's12', { ...HOST, uid: 501, tempRoot: at(30) }), { message: /per-user temp folder .* is longer than 44 bytes/ }); // the name counts
  assert.throws(() => leadPolicy(CONFIG, 's1', { ...HOST, uid: 5012, tempRoot: at(30) }), { message: /per-user temp folder .* is longer than 44 bytes/ }); // the uid counts
  // The fixed temp root fits the longest session name with a five-digit uid.
  assert.ok(Buffer.byteLength(join(TEMP_ROOT, 's999999', 'claude-99999')) <= CLAUDE_TMP_MAX);
});

test('F-T156-36: at the timeout, preflight kills the whole process group of claude, also a grandchild that ignores SIGTERM', async () => {
  const h = host();
  let pid;
  try {
    writeFileSync(h.policy.claude, `#!/bin/sh\ntrap '' TERM\n/bin/sleep 30 > /dev/null 2>&1 &\necho $! > "${h.root}/pid"\nwait\n`);
    const r = await preflight(h.policy, h.env, { claude: 500 });
    assert.equal(r.state, 'no sandbox');
    pid = Number(readFileSync(join(h.root, 'pid'), 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(), false, `the grandchild ${pid} is still running`);
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } h.done(); }
});

test('F-T156-36: a claude that exits but leaves a process holding its output past the timeout counts as failed, and that process is killed', async () => {
  const h = host();
  let pid;
  try {
    writeFileSync(h.policy.claude, `#!/bin/sh\n/bin/sleep 30 &\necho $! > "${h.root}/pid"\necho '${JSON.stringify({ supported: true, enabled: true, strictMode: true, unavailableReason: null })}'\n`);
    assert.deepEqual(await preflight(h.policy, h.env, { claude: 500 }), { state: 'no sandbox', why: `claude sandbox status failed: Command failed: ${h.policy.claude} --settings ${JSON.stringify(settingsOf(h.policy))} --setting-sources  sandbox status` });
    pid = Number(readFileSync(join(h.root, 'pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } h.done(); }
});

test('F-T156-38: preflight runs claude sandbox status with a private temp folder that it removes, and makes nothing in the folder of all temp folders', async () => {
  const h = host();
  try {
    assert.equal((await preflight(h.policy, h.env)).state, 'ready');
    const [tmp, claudeTmp, there] = readFileSync(join(h.root, 'tmp-vars'), 'utf8').split('\n');
    assert.equal(tmp, claudeTmp);
    assert.equal(there, 'there'); // the folder was there while claude ran
    assert.ok(!claudeTmp.startsWith(`${h.policy.tempRoot}/`), claudeTmp);
    assert.throws(() => lstatSync(claudeTmp), { code: 'ENOENT' }); // and is removed after
  } finally { h.done(); }
});
