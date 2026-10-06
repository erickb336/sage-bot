// T157 (T134 PR 2a): the two lead-policy fixes. F-T157-8: the settings deny both model credential variables to commands, and a launch
// takes at most one, from its caller. F-T157-7: with HOME set to a scratch folder, commands still read nothing in the owner's real home
// folder. SAMPLE DATA ONLY: the values are made up, and no session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { launchOf, leadPolicy, settingsOf } from '../src/lead-policy.js';

const HOST = { env: {}, home: '/h', owner: '/h', tmp: '/t', userTemp: '/u', shortTmp: '/st' };
const CONFIG = { statePath: '/s/state/gates.json' };
const REFUSAL = 'a lead session takes one model credential variable, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, not';

test('F-T157-8: the settings deny both model credential variables to commands', () => {
  const names = settingsOf(leadPolicy(CONFIG, 's1', HOST)).sandbox.credentials.envVars.filter((v) => v.mode === 'deny').map((v) => v.name);
  assert.deepEqual(names.slice(-2), ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
});

test('F-T157-8: a launch takes the one model variable that its caller gives, never one from the host, and refuses two', () => {
  const policy = leadPolicy(CONFIG, 's1', HOST);
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t157-')));
  const saved = process.env.HOME;
  try {
    process.env.HOME = join(root, 'home'); // the defaults: home from $HOME, owner from the user database
    const policy = leadPolicy({ statePath: join(root, 'state', 'gates.json') }, 's1', { env: {}, tmp: join(root, 't'), userTemp: undefined, shortTmp: root });
    const owner = realpathSync.native(userInfo().homedir);
    assert.notEqual(owner, join(root, 'home'));
    assert.match(owner, /^\/(Users|home)\/[^/]+$/);
    const { denyRead, allowRead } = settingsOf(policy).sandbox.filesystem;
    assert.deepEqual(denyRead.slice(0, 2), [join(root, 'home'), owner]);
    assert.deepEqual(allowRead, [join(root, 'home', '.local', 'share', 'sage-bot', 'leads', 'sessions', 's1'), join(root, 'sage-lead', 's1')]);
    const files = settingsOf(policy).sandbox.credentials.files.map((f) => f.path);
    for (const home of [join(root, 'home'), owner]) for (const f of ['.ssh', '.gitconfig', '.config/git']) assert.ok(files.includes(join(home, f)), join(home, f));
    assert.equal(launchOf(policy, {}).env.HOME, join(root, 'home')); // the session's HOME is $HOME
  } finally {
    process.env.HOME = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
