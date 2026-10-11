// T157 (T134 PR 2a): the two session-policy fixes. F-T157-8: the settings deny both model credential variables to commands, and a launch
// takes at most one, from its caller. F-T157-7: with HOME set to a scratch folder, commands still read nothing in the owner's real home
// folder. F-T157-11: the owner's ~/.claude.json is a credential file. SAMPLE DATA ONLY: the values are made up, and no session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { tempFolder } from './temp-folder.js';
import { launchOf, sessionPolicy, settingsOf } from '../src/session-policy.js';

const HOST = { env: {}, home: '/h', owner: '/h', userTemp: '/u', tempRoot: '/st/sage-lead' };
const CONFIG = { statePath: '/s/state/gates.json' };
const REFUSAL = 'a bridge session takes one model credential variable, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, not';

test('F-T157-8: the settings deny both model credential variables to commands', () => {
  const names = settingsOf(sessionPolicy(CONFIG, 's1', HOST)).sandbox.credentials.envVars.filter((v) => v.mode === 'deny').map((v) => v.name);
  assert.deepEqual(names.slice(-2), ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
});

test('F-T157-8: a launch takes the one model variable that its caller gives, never one from the host, and refuses two', () => {
  const policy = sessionPolicy(CONFIG, 's1', HOST);
  const host = { LANG: 'C', ANTHROPIC_API_KEY: 'sample-host-1', CLAUDE_CODE_OAUTH_TOKEN: 'sample-host-2' };
  const model = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => k === 'ANTHROPIC_API_KEY' || k === 'CLAUDE_CODE_OAUTH_TOKEN'));
  assert.deepEqual(model(launchOf(policy, host).env), {});
  assert.deepEqual(model(launchOf(policy, host, { CLAUDE_CODE_OAUTH_TOKEN: 'sample-caller-1' }).env), { CLAUDE_CODE_OAUTH_TOKEN: 'sample-caller-1' });
  assert.deepEqual(model(launchOf(policy, host, { ANTHROPIC_API_KEY: 'sample-caller-2' }).env), { ANTHROPIC_API_KEY: 'sample-caller-2' });
  assert.equal(launchOf(policy, host, { ANTHROPIC_API_KEY: 'sample-caller-2' }).env.LANG, 'C');
  assert.throws(() => launchOf(policy, {}, { CLAUDE_CODE_OAUTH_TOKEN: 'sample-1', ANTHROPIC_API_KEY: 'sample-2' }),
    { message: `${REFUSAL} CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY: ANTHROPIC_API_KEY outranks the OAuth token and would change the billing. Nothing was started.` });
  assert.throws(() => launchOf(policy, {}, { GH_TOKEN: 'sample-3' }), { message: new RegExp(`^${REFUSAL} GH_TOKEN:`) });
});

test('F-T157-7: with HOME set to a scratch folder, commands still read nothing in the owner\'s real home folder (from the user database)', () => {
  const root = realpathSync.native(tempFolder('sage-bot-t157-'));
  const saved = process.env.HOME;
  try {
    process.env.HOME = join(root, 'home'); // the defaults: home from $HOME, owner from the user database
    const policy = sessionPolicy({ statePath: join(root, 'state', 'gates.json') }, 's1', { env: {}, userTemp: join(root, 'u'), tempRoot: '/st/sage-lead' });
    const owner = userInfo().homedir; // canonical, or the policy refuses it
    assert.notEqual(owner, join(root, 'home'));
    assert.match(owner, /^\/(Users|home)\/[^/]+$/);
    const { denyRead, allowRead } = settingsOf(policy).sandbox.filesystem;
    assert.deepEqual(denyRead.slice(0, 2), [join(root, 'home'), owner]);
    assert.deepEqual(allowRead, [join(root, 'home', '.local', 'share', 'sage-bot', 'leads', 'sessions', 's1'), '/st/sage-lead/s1']);
    const files = settingsOf(policy).sandbox.credentials.files.map((f) => f.path);
    for (const home of [join(root, 'home'), owner]) for (const f of ['.ssh', '.gitconfig', '.config/git']) assert.ok(files.includes(join(home, f)), join(home, f));
    assert.equal(launchOf(policy, {}).env.HOME, join(root, 'home')); // the session's HOME is $HOME
  } finally {
    process.env.HOME = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F-T157-20: with a scratch HOME, the owner\'s real ~/.claude (plugin cache, sage root, logbooks) is a credential file and a denied path', () => {
  const settings = settingsOf(sessionPolicy(CONFIG, 's1', { ...HOST, owner: '/o' }));
  assert.ok(settings.sandbox.credentials.files.some((f) => f.path === '/o/.claude' && f.mode === 'deny'));
  assert.ok(settings.sandbox.credentials.files.some((f) => f.path === '/h/.claude' && f.mode === 'deny'));
  for (const list of [settings.sandbox.filesystem.denyRead, settings.sandbox.filesystem.denyWrite]) assert.ok(list.includes('/o/.claude') && list.includes('/h/.claude'), list.join(' '));
  for (const rule of ['Read(//o/.claude)', 'Read(//o/.claude/**)', 'Edit(//o/.claude)', 'Edit(//o/.claude/**)']) assert.ok(settings.permissions.deny.includes(rule), rule);
  assert.ok(!settings.sandbox.filesystem.allowRead.some((a) => a.startsWith('/o/')));
});

test('F-T173-1: the bridge sessions\' shared Claude config folder (every session\'s CLAUDE_CONFIG_DIR, with their transcripts) is a credential file and a denied path', () => {
  const settings = settingsOf(sessionPolicy(CONFIG, 's1', HOST));
  const claudeDir = '/h/.local/share/sage-bot/leads/claude';
  assert.ok(settings.sandbox.credentials.files.some((f) => f.path === claudeDir && f.mode === 'deny'), settings.sandbox.credentials.files.map((f) => f.path).join(' '));
  for (const list of [settings.sandbox.filesystem.denyRead, settings.sandbox.filesystem.denyWrite]) assert.ok(list.includes(claudeDir), list.join(' '));
  for (const rule of [`Read(/${claudeDir})`, `Read(/${claudeDir}/**)`]) assert.ok(settings.permissions.deny.includes(rule), rule);
  assert.equal(launchOf(sessionPolicy(CONFIG, 's1', HOST), {}).env.CLAUDE_CONFIG_DIR, claudeDir); // the folder that the credential deny names is the one every session uses
});

test('F-T157-11: the owner\'s ~/.claude.json (MCP configs, account data) is a credential file, in $HOME and in the owner\'s home folder', () => {
  const policy = sessionPolicy(CONFIG, 's1', { ...HOST, owner: '/o' });
  const files = settingsOf(policy).sandbox.credentials.files;
  assert.deepEqual(files.filter((f) => f.path.endsWith('/.claude.json')), [{ path: '/h/.claude.json', mode: 'deny' }, { path: '/o/.claude.json', mode: 'deny' }]);
});
