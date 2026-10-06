// T157 (T134 PR 2a): the proof harness, with no key. The scratch world matches the policy, the probes tell a refusal from an error
// under a real kernel sandbox (a seatbelt profile, on macOS), the verdicts, and the keychain fixture's save and restore with a fake
// `security`. SAMPLE DATA ONLY: no model session, no network, and no real keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { launchOf, settingsOf } from '../src/lead-policy.js';
import { keychainPlan, keychainsOf, printable, withScratchKeychain } from '../scripts/proof/keychain.mjs';
import { didOf, probes } from '../scripts/proof/probe.mjs';
import { ROWS, statusOf, verdict } from '../scripts/proof/run.mjs';
import { buildWorld, policyOf } from '../scripts/proof/world.mjs';
import { spawnSync } from './bridge-setup.js';

const PROBE = new URL('../scripts/proof/probe.mjs', import.meta.url).pathname;
const TAG = 'f00dfeedf00dfeed';
const scratch = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t157-')));
const inside = (path, dir) => !relative(dir, path).startsWith('..');

test('the world: every state file, plugin file and credential file that a probe refuses is in a denied path of the policy, never re-opened', () => {
  const root = scratch();
  try {
    const w = buildWorld(join(root, 'w'), TAG);
    const policy = policyOf(w);
    assert.equal(policy.folder, w.sessionFolder);
    assert.equal(policy.tmp, w.sessionTmp);
    assert.equal(policy.sageTool, w.tool); // the dummy state tool is the one that the policy finds
    assert.equal(w.hookDirs.length, 3); // sage-hooks in the two temp folders, .hooks in sage's root
    const { denyRead, allowRead } = settingsOf(policy).sandbox.filesystem;
    const targets = [w.statePath, `${w.statePath}.leads.jsonl`, `${w.statePath}.leads-off`, `${w.statePath}.votes`, w.config, w.tool, w.logbook, w.marketplace, ...Object.values(w.credentials)];
    for (const path of targets) {
      assert.ok(existsSync(path), path);
      assert.ok(denyRead.some((d) => inside(path, d)), `${path} is denied`);
      assert.ok(!allowRead.some((a) => inside(path, a)), `${path} is not re-opened`);
    }
    // Samples only by their tag: the description holds none, and each credential file holds one.
    assert.ok(!readFileSync(join(w.sessionFolder, 'world.json'), 'utf8').includes('sample-fake-'));
    assert.match(readFileSync(w.credentials.ssh, 'utf8'), /^sample-fake-ssh-f00dfeedf00dfeed\n$/);
    assert.equal(spawnSync('git', ['log', '--format=%s'], { cwd: w.sessionFolder, encoding: 'utf8' }).stdout, 'sample\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('didOf: worked, refused (EPERM, or any failure for a network call or a test), or cannot tell', () => {
  const r = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });
  assert.equal(didOf({}, r(0)), true);
  assert.equal(didOf({}, r(1, '', 'cat: /x: Operation not permitted')), false);
  assert.equal(didOf({}, r(1, '', 'cat: /x: No such file or directory')), null); // a missing file proves nothing
  assert.equal(didOf({ refusedAs: /Cannot find module/ }, r(1, '', "Error: Cannot find module '/x'")), false); // node hides the EPERM
  assert.equal(didOf({ refusedAs: /Cannot find module/ }, r(1, '', 'SyntaxError: x')), null);
  assert.equal(didOf({ anyFail: true }, r(6, '', 'curl: (6) Could not resolve host')), false);
  assert.equal(didOf({ anyFail: true }, { status: null, error: new Error('ETIMEDOUT') }), false);
  assert.equal(didOf({}, { status: null, error: new Error('ETIMEDOUT') }), null);
  const see = { see: ['GH_TOKEN'] };
  assert.equal(didOf(see, r(0, 'PATH=\nGH_TOKEN=\n')), true);
  assert.equal(didOf(see, r(0, 'node probe.mjs PATH=/bin GH_TOKEN=x')), true); // ps output
  assert.equal(didOf(see, r(0, 'PATH=\nXGH_TOKEN=\n')), false);
  assert.equal(didOf(see, r(1, '', 'ps: Operation not permitted')), false);
});

test('verdict: INVALID without a working control, SKIPPED with no live result, else PASS or FAIL by the expectation', () => {
  const t = { did: true }, f = { did: false }, n = { did: null };
  assert.deepEqual([verdict('refused', f), verdict('refused', n), verdict('refused', undefined)], ['INVALID', 'INVALID', 'INVALID']);
  assert.equal(verdict('refused', t), 'SKIPPED');
  assert.deepEqual([verdict('refused', t, f), verdict('refused', t, t), verdict('refused', t, n)], ['PASS', 'FAIL', 'INVALID']);
  assert.deepEqual([verdict('allowed', t, t), verdict('allowed', t, f)], ['PASS', 'FAIL']);
  assert.deepEqual([statusOf(['PASS', 'SKIPPED']), statusOf(['PASS', 'INVALID', 'SKIPPED']), statusOf(['FAIL', 'INVALID']), statusOf(['PASS'])], ['SKIPPED', 'INVALID', 'FAIL', 'PASS']);
});

test('the rows: each L1 row has probes and each probe has an L1 row; L2 and L3 rows carry what T165 asks the session', () => {
  const root = scratch();
  const w = buildWorld(join(root, 'w'), TAG);
  rmSync(root, { recursive: true, force: true });
  const L1 = ROWS.filter((r) => r.group === 'L1').map((r) => r.row);
  const probed = [...new Set(probes(w).map((p) => p.row))];
  assert.deepEqual(probed.toSorted(), L1.toSorted());
  assert.ok(probes(w).length >= 40);
  assert.equal(new Set(probes(w).map((p) => p.id)).size, probes(w).length);
  for (const r of ROWS.filter((x) => x.group === 'L2' || x.group === 'L3')) assert.ok(r.ask, r.row);
});

// The kernel check of the probes: probe.mjs runs, as in a session, under a seatbelt profile that denies the world's denied paths, the
// git control files, the session's settings files and the network. Each probe that expects a refusal must see one by its EPERM (false),
// not an error (null); the allowed ones must work. No claude process is there, so the ps probes cannot tell (null).
const sb = (s) => JSON.stringify(s);
const seatbelt = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', 'true']).status === 0;
test('seatbelt: each probe sees a refusal as refused, not as an error, and the allowed ones work', { skip: !seatbelt && 'sandbox-exec is not available here' }, () => {
  const root = scratch();
  try {
    const w = buildWorld(join(root, 'w'), TAG);
    const f = w.sessionFolder;
    const deny = [w.home, join(root, 'w', 'state'), ...w.hookDirs, w.marker];
    const denyWrite = ['config', 'hooks', 'commondir', 'info/attributes'].map((p) => join(f, '.git', p)).concat([join(f, 'sub'), join(f, '.claude'), join(f, '.mcp.json'), `/tmp/claude-${process.getuid()}`, `/private/tmp/claude-${process.getuid()}/sage-bot-proof-s1`]);
    const profile = ['(version 1)', '(allow default)', '(deny network*)',
      ...deny.map((d) => `(deny file-read* file-write* (subpath ${sb(d)}))`),
      `(allow file-read* file-write* (subpath ${sb(f)}))`,
      ...denyWrite.map((d) => `(deny file-write* (subpath ${sb(d)}))`)].join('\n');
    writeFileSync(join(root, 'lead.sb'), profile);
    const policy = policyOf(w);
    const r = spawnSync('sandbox-exec', ['-f', join(root, 'lead.sb'), process.execPath, PROBE, join(f, 'world.json')],
      { cwd: f, encoding: 'utf8', env: launchOf(policy, {}).env }); // the session's environment
    assert.equal(r.status, 0, r.stderr);
    const results = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const wrong = results.filter((p) => (p.id.startsWith('model-key-ps') ? p.did !== null : p.did !== (p.expect === 'allowed')));
    assert.deepEqual(wrong, []);
    assert.ok(results.length >= 40);
    assert.ok(!r.stdout.includes(TAG) && !r.stdout.includes('sample-fake-'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * A fake `security` in a new folder: it keeps the user search list and the keychains in a JSON file, logs each call, and fails the verb
 * in FAKE_FAIL. The real `security` is never on its PATH.
 */
function fakeSecurity(root, { list = ['/Users/sample/Library/Keychains/login.keychain-db'], fail } = {}) {
  const bin = join(root, 'bin'), state = join(root, 'state.json'), log = join(root, 'calls.log');
  mkdirSync(bin);
  writeFileSync(state, JSON.stringify({ list, keychains: [] }));
  writeFileSync(join(root, 'fake.mjs'), `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [verb, ...args] = process.argv.slice(2), s = JSON.parse(readFileSync(${sb(state)}, 'utf8'));
appendFileSync(${sb(log)}, JSON.stringify([verb, ...args]) + '\\n');
if (verb === process.env.FAKE_FAIL) { console.error('fake failure'); process.exit(1); }
if (verb === 'list-keychains') { if (args[2] === '-s') s.list = args.slice(3); else console.log(s.list.map((p) => '    "' + p + '"').join('\\n')); }
if (verb === 'create-keychain') { s.keychains.push(args.at(-1)); s.list.push(args.at(-1)); }
if (verb === 'add-generic-password' && !s.keychains.includes(args.at(-1))) process.exit(1);
if (verb === 'delete-keychain') { s.keychains = s.keychains.filter((k) => k !== args[0]); s.list = s.list.filter((k) => k !== args[0]); }
writeFileSync(${sb(state)}, JSON.stringify(s));
`);
  writeFileSync(join(bin, 'security'), `#!/bin/sh\nexec ${sb(process.execPath)} ${sb(join(root, 'fake.mjs'))} "$@"\n`);
  chmodSync(join(bin, 'security'), 0o755);
  return {
    env: { PATH: bin, ...(fail && { FAKE_FAIL: fail }) },
    state: () => JSON.parse(readFileSync(state, 'utf8')),
    verbs: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)[0]),
  };
}

test('keychain fixture: it saves the search list, makes the scratch keychain, and puts the list back as it was after', async () => {
  const root = scratch();
  try {
    const fake = fakeSecurity(root, { list: ['/Users/sample/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain'] });
    let during;
    const got = await withScratchKeychain(join(root, 'kc'), (plan) => { during = fake.state(); return plan.service; }, { env: fake.env, id: 'abc123' });
    assert.equal(got, 'sage-bot-proof-sample-abc123');
    assert.deepEqual(during.list, ['/Users/sample/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain', join(root, 'kc', 'proof.keychain-db')]);
    assert.deepEqual(fake.state(), { list: ['/Users/sample/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain'], keychains: [] });
    assert.deepEqual(fake.verbs(), ['list-keychains', 'create-keychain', 'add-generic-password', 'delete-keychain', 'list-keychains', 'list-keychains']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('keychain fixture: the list goes back also when the probes throw, or a command of the fixture fails', async () => {
  for (const [fail, message] of [[undefined, 'probe failed'], ['add-generic-password', /fake failure/], ['create-keychain', /fake failure/]]) {
    const root = scratch();
    try {
      const fake = fakeSecurity(root, { fail });
      await assert.rejects(withScratchKeychain(join(root, 'kc'), () => { throw new Error('probe failed'); }, { env: fake.env }), { message });
      assert.deepEqual(fake.state().list, ['/Users/sample/Library/Keychains/login.keychain-db'], String(fail));
      assert.equal(fake.verbs().at(-2), 'list-keychains'); // the restore, then its check
      assert.equal(fake.verbs().includes('delete-keychain'), fail !== 'create-keychain'); // only a keychain that it made
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('keychain fixture: an empty or unreadable search list changes nothing; the printed commands hide each sample value', async () => {
  const root = scratch();
  try {
    const fake = fakeSecurity(root, { list: [] });
    await assert.rejects(withScratchKeychain(join(root, 'kc'), () => 1, { env: fake.env }), { message: 'the keychain search list is empty or could not be read: nothing was changed.' });
    assert.deepEqual(fake.verbs(), ['list-keychains']);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(keychainsOf('    "/a/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'), ['/a/login.keychain-db', '/Library/Keychains/System.keychain']);
  const plan = keychainPlan('/k', 'abc123');
  assert.deepEqual(printable(plan), [
    'security list-keychains -d user',
    'security create-keychain -p <sample> /k/proof.keychain-db',
    'security add-generic-password -a sage-bot-proof -s sage-bot-proof-sample-abc123 -w <sample> /k/proof.keychain-db',
    'security find-generic-password -a sage-bot-proof -s sage-bot-proof-sample-abc123 /k/proof.keychain-db',
    'security delete-keychain /k/proof.keychain-db',
    'security list-keychains -d user -s <each keychain of the saved list>',
    'security list-keychains -d user',
  ]);
});
