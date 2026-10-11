// T157 (T134 PR 2a): the proof harness, with no key. The scratch world matches the policy, the probes tell a refusal from an error
// under a real kernel sandbox (a seatbelt profile, on macOS), the verdicts, and the keychain fixture's save and restore with a fake
// `security`. SAMPLE DATA ONLY: no model session, no network, and no real keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tempFolder } from './temp-folder.js';
import { launchOf, settingsOf } from '../src/lead-policy.js';
import { keychainPlan, keychainsOf, printable, withScratchKeychain } from '../scripts/proof/keychain.mjs';
import { didOf, probes, resultsOf } from '../scripts/proof/probe.mjs';
import { ROWS, out, prove, statusOf, verdict } from '../scripts/proof/run.mjs';
import { buildWorld, policyOf, removeTempRoots } from '../scripts/proof/world.mjs';
import { spawnSync } from './bridge-setup.js';

const PROBE = new URL('../scripts/proof/probe.mjs', import.meta.url).pathname;
const TAG = 'f00dfeedf00dfeed';
const scratch = () => realpathSync.native(tempFolder('sage-bot-t157-'));
/** A world in a new scratch folder, and the removal of both its folder and its temp root. */
function world() {
  const root = scratch(), w = buildWorld(join(root, 'w'), TAG);
  return { root, w, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(w.tempRoot, { recursive: true, force: true }); } };
}
const inside = (path, dir) => !relative(dir, path).startsWith('..');
const SBP = /^\/private\/tmp\/sbp-[A-Za-z0-9]{6}$/; // short and canonical (F-T156-35), never /private/tmp/sage-lead
/** The error that `fn` throws. */
const thrown = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('no error'); };
/** The world's session folder below `root`, where world.json is. */
const sessionFolder = (root) => join(root, 'home', '.local', 'share', 'sage-bot', 'leads', 'sessions', 's1');
/** The temp roots that the worlds under `root` name in their world.json, each of the sbp- shape. T174: a test checks only its own temp
 * roots, never every sbp-* name in the shared /private/tmp, which another proof run on the Mac fills at the same time. */
function tempRootsOf(root, worlds) {
  const roots = worlds.map((w) => JSON.parse(readFileSync(join(sessionFolder(join(root, w)), 'world.json'), 'utf8')).tempRoot);
  for (const d of roots) assert.match(d, SBP);
  return roots;
}

test('the world: every state file, plugin file and credential file that a probe refuses is in a denied path of the policy, never re-opened', () => {
  const { w, done } = world();
  try {
    const policy = policyOf(w);
    assert.equal(policy.folder, w.sessionFolder);
    assert.equal(policy.tmp, w.sessionTmp);
    assert.equal(policy.sageTool, w.tool); // the dummy state tool is the one that the policy finds
    assert.deepEqual(w.hookDirs, [join(w.userTemp, 'sage-hooks'), '/private/tmp/sage-hooks', join(w.sageRoot, '.hooks')]); // F-T156-40: never TMPDIR
    assert.match(w.tempRoot, SBP);
    assert.equal(lstatSync(w.tempRoot).mode & 0o777, 0o700);
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
  } finally { done(); }
});

test('F-T157-10: the temp roots in /private/tmp go at the end of a run, also when the world cannot be built', () => {
  const root = scratch();
  try {
    const w = buildWorld(join(root, 'w'), TAG);
    assert.ok(existsSync(w.tempRoot));
    removeTempRoots();
    assert.ok(!existsSync(w.tempRoot), `${w.tempRoot} is removed`);
    // A build that fails after it made its temp root (the folder is read-only, so the first file cannot be written) removes it. The
    // error names the root: no world.json is written before the failure.
    mkdirSync(join(root, 'ro'), { mode: 0o500 });
    const e = thrown(() => buildWorld(join(root, 'ro'), TAG));
    assert.equal(e.code, 'EACCES');
    assert.match(e.tempRoot, SBP);
    assert.ok(!existsSync(e.tempRoot), `${e.tempRoot} is removed`);
  } finally { chmodSync(join(root, 'ro'), 0o700); rmSync(root, { recursive: true, force: true }); }
});

const RUN = new URL('../scripts/proof/run.mjs', import.meta.url).pathname;
const sh = (cmd, cwd) => spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8' });
const commonDir = (cwd) => spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).stdout.trim();

test('F-T157-23: the git-commondir probe names a folder inside the world that is never made, and its control puts the repository back', () => {
  const { w, done } = world();
  try {
    const p = probes(w).find((x) => x.id === 'git-commondir');
    const payload = p.cmd.match(/^echo '([^']*)' > \.git\/commondir$/)?.[1];
    assert.equal(payload, join(w.sessionTmp, 'no-such-commondir'));
    assert.ok(!existsSync(payload));
    assert.equal(sh(p.cmd, w.sessionFolder).status, 0); // the probe itself, unsandboxed: it points git inside the world, never at /tmp
    assert.equal(readFileSync(join(w.sessionFolder, '.git', 'commondir'), 'utf8'), `${payload}\n`);
    assert.equal(commonDir(w.sessionFolder), ''); // git refuses a common dir that is not there: it reads nothing outside the world
    assert.equal(sh(p.control, w.sessionFolder).status, 0); // the control: the write works, and the file goes away again
    assert.ok(!existsSync(join(w.sessionFolder, '.git', 'commondir')));
    assert.equal(commonDir(w.sessionFolder), '.git');
  } finally { done(); }
});

test('F-T157-23, F-T167-1: a scratch folder that is not empty is refused with one line and exit 2, before any world or temp root is made', async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, 'report.json'), '{}\n');
    await assert.rejects(prove(root), { exitCode: 2, message: `the scratch folder ${root} is not empty: give --out a new folder, or none for a new one in TMPDIR. Nothing was made.` });
    // No world folder in the scratch folder means no temp root: a world makes its folder before its temp root (buildWorld).
    assert.deepEqual(readdirSync(root), ['report.json']);
    const r = spawnSync(process.execPath, [RUN, '--out', root], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(root, 'no-home') } });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `proof: the scratch folder ${root} is not empty: give --out a new folder, or none for a new one in TMPDIR. Nothing was made.\n`);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(root), ['report.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-T157-21: a TMPDIR that is no folder gives one line and exit 1, no stack', () => {
  const r = spawnSync(process.execPath, [RUN], { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: '/nonexistent' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^proof: ENOENT: no such file or directory, mkdtemp '\/nonexistent\/sage-bot-proof-\w+'\n$/);
  assert.equal(r.stdout, '');
});

test('F-T157-23: a git error of the world reaches the error line, and the temp root goes', () => {
  const root = scratch();
  try {
    const folder = sessionFolder(join(root, 'w'));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, '.git'), 'not a gitfile\n');
    const e = thrown(() => buildWorld(join(root, 'w'), TAG));
    assert.equal(e.message, `git init -q in ${folder}: fatal: invalid gitfile format: ${join(folder, '.git')}`);
    assert.match(e.tempRoot, SBP);
    assert.ok(!existsSync(e.tempRoot), `${e.tempRoot} is removed`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-T157-30: a claude that is not on PATH gives one line with the cause and exit 1; the caller\'s shell lives and no temp root stays', () => {
  const root = scratch();
  try {
    const PATH = process.env.PATH.split(':').filter((d) => !existsSync(join(d, 'claude'))).join(':'); // the real PATH, minus every claude
    // A shell of its own group, as a user's shell: without the fix, the run kills its own group (pid 0), and the shell with it.
    const r = spawnSync('/bin/sh', ['-c', `'${process.execPath}' '${RUN}' --out '${join(root, 'out')}'; echo "shell alive, exit $?" >&2`],
      { encoding: 'utf8', detached: true, env: { PATH, HOME: join(root, 'no-home') } });
    assert.equal(r.signal, null);
    assert.equal(r.stderr, 'proof: the claude command is not on PATH (ENOENT)\nshell alive, exit 1\n');
    assert.equal(r.stdout, '');
    for (const d of tempRootsOf(join(root, 'out'), ['control', 'live'])) assert.ok(!existsSync(d), `${d} is removed`); // both worlds were built before the claude error
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-T157-22: a claude that hangs is killed with its whole process group at the timeout: no child of it stays', () => {
  const root = scratch();
  try {
    const pidFile = join(root, 'child.pid');
    writeFileSync(join(root, 'claude'), `#!/bin/sh\nsleep 300 &\necho $! > '${pidFile}'\nsleep 300\n`, { mode: 0o755 });
    const before = Date.now();
    assert.equal(out(join(root, 'claude'), ['--version'], { timeout: 500 }), null);
    assert.ok(Date.now() - before < 5000);
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(child > 1);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(child); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // launchd reaps it within a moment
    assert.ok(!alive(child), `the grandchild sleep ${child} is gone`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('didOf: worked, refused (EPERM, or any failure of the command itself for a network call or a test), or cannot tell', () => {
  const r = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });
  assert.equal(didOf({}, r(0)), true);
  assert.equal(didOf({}, r(1, '', 'cat: /x: Operation not permitted')), false);
  assert.equal(didOf({}, r(1, '', 'open /x: operation not permitted')), false); // Go and Python spell it in lower case
  assert.equal(didOf({}, r(1, '', 'cat: /x: No such file or directory')), null); // a missing file proves nothing
  assert.equal(didOf({ refusedAs: /Cannot find module/ }, r(1, '', "Error: Cannot find module '/x'")), false); // node hides the EPERM
  assert.equal(didOf({ refusedAs: /Cannot find module/ }, r(1, '', 'SyntaxError: x')), null);
  assert.equal(didOf({ anyFail: true }, r(6, '', 'curl: (6) Could not resolve host')), false);
  // F-T165-22: a network call that ran out of time (curl's own -m, the node probe's timeout) proves nothing, not a refusal.
  assert.equal(didOf({ anyFail: true }, r(28, '', 'curl: (28) Connection timed out after 15001 milliseconds')), null);
  assert.equal(didOf({ anyFail: true }, r(1, '', 'timeout')), null);
  assert.equal(didOf({ anyFail: true }, r(1, '', 'ETIMEDOUT')), null);
  assert.equal(didOf({ anyFail: true }, r(1, '', 'ECONNREFUSED')), false);
  // F-T165-17: no command ran (the shell's 127, its message, the xcode-select stub), a timeout or a spawn error: nothing, never refused
  assert.equal(didOf({ anyFail: true }, r(127, '', 'sh: curl: command not found')), null);
  assert.equal(didOf({ anyFail: true }, r(1, '', 'xcode-select: note: No developer tools were found, requesting install.')), null);
  assert.equal(didOf({ anyFail: true }, { status: null, error: new Error('ETIMEDOUT') }), null);
  assert.equal(didOf({}, { status: null, error: new Error('ETIMEDOUT') }), null);
  assert.equal(didOf({}, r(127, '', 'sh: jq: command not found')), null);
  // F-T165-19: a probe that shows a value: worked only with the value, refused only with an EPERM; a prompt that timed out, a missing
  // security, a locked keychain or a missing item proves nothing
  const shows = { shows: 'sample-item-abc' };
  assert.equal(didOf(shows, r(0, 'sample-item-abc\n')), true);
  assert.equal(didOf(shows, r(1, 'sample-item-abc\n', 'warning')), true);
  assert.equal(didOf(shows, r(1, '', 'security: SecKeychainOpen: Operation not permitted')), false);
  assert.equal(didOf(shows, r(0, '')), null);
  assert.equal(didOf(shows, r(44, '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.')), null);
  assert.equal(didOf(shows, r(36, '', 'security: SecKeychainUnlock: User interaction is not allowed.')), null);
  assert.equal(didOf(shows, { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') }), null);
  assert.equal(didOf(shows, r(127, '', 'sh: security: command not found')), null);
  const see = { see: ['GH_TOKEN'], sentinel: /^PATH=$/m };
  assert.equal(didOf(see, r(0, 'PATH=\nGH_TOKEN=\n')), true);
  assert.equal(didOf({ see: ['GH_TOKEN'], sentinel: /^\s*42\s/ }, r(0, '   42 node probe.mjs PATH=/bin GH_TOKEN=x')), true); // ps output, the pid first
  assert.equal(didOf(see, r(0, 'PATH=\nXGH_TOKEN=\n')), false);
  assert.equal(didOf(see, r(1, '', 'ps: Operation not permitted')), false);
  // F-T157-29: exit 0 with nothing printed, or without the sentinel line, is "cannot tell", never refused
  assert.equal(didOf(see, r(0, '')), null);
  assert.equal(didOf(see, r(0, 'HOME=\n')), null);
  assert.equal(didOf({ see: ['GH_TOKEN'], sentinel: /^\s*42\s/ }, r(0, '')), null);
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
  const { w, done } = world();
  done();
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
  const { root, w, done } = world();
  try {
    const f = w.sessionFolder;
    const deny = [w.home, join(root, 'w', 'state'), ...w.hookDirs, w.marker, w.other.tmp]; // the other session's folder and transcript are in the home
    const denyWrite = ['config', 'hooks', 'commondir', 'info/attributes'].map((p) => join(f, '.git', p)).concat([join(f, 'sub'), join(f, '.claude'), join(f, '.mcp.json'), `/tmp/claude-${process.getuid()}`, `/private/tmp/claude-${process.getuid()}/sage-bot-proof-s1`]);
    const profile = ['(version 1)', '(allow default)', '(deny network*)',
      '(deny mach-lookup (global-name-regex "^com.apple.xpc.launchd"))', // launchd: `launchctl load` prints "Load failed: 5: Input/output error" (F-T165-24)
      '(deny file-read* file-write* (subpath "/private/var/at"))', // the cron tabs: `crontab` is refused at its exec with "Operation not permitted"
      ...deny.map((d) => `(deny file-read* file-write* (subpath ${sb(d)}))`),
      `(allow file-read* file-write* (subpath ${sb(f)}))`,
      ...denyWrite.map((d) => `(deny file-write* (subpath ${sb(d)}))`)].join('\n');
    writeFileSync(join(root, 'lead.sb'), profile);
    const policy = policyOf(w);
    const r = spawnSync('sandbox-exec', ['-f', join(root, 'lead.sb'), process.execPath, PROBE, join(f, 'world.json')],
      { cwd: f, encoding: 'utf8', env: launchOf(policy, {}).env }); // the session's environment
    assert.equal(r.status, 0, r.stderr);
    const results = [...resultsOf(r.stdout).results.values()];
    const wrong = results.filter((p) => (p.id.startsWith('model-key-ps') || p.needs === 'keychain' ? p.did !== null : p.did !== (p.expect === 'allowed'))); // no claude process and no scratch keychain here: those cannot tell
    assert.deepEqual(wrong, []);
    assert.ok(results.length >= 40);
    assert.ok(!r.stdout.includes(TAG) && !r.stdout.includes('sample-fake-'));
  } finally { done(); }
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
    assert.equal(readFileSync(join(root, 'kc', 'search-list-before.txt'), 'utf8'), '/Users/sample/Library/Keychains/login.keychain-db\n/Library/Keychains/System.keychain\n'); // the baseline on disk, for a crash
    assert.deepEqual(during.list, ['/Users/sample/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain', join(root, 'kc', 'proof.keychain-db')]);
    assert.deepEqual(fake.state(), { list: ['/Users/sample/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain'], keychains: [] });
    assert.deepEqual(fake.verbs(), ['list-keychains', 'create-keychain', 'set-keychain-settings', 'add-generic-password', 'delete-keychain', 'list-keychains', 'list-keychains']); // set-keychain-settings with no option: no lock timeout (F-T165-19)
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
    'security set-keychain-settings /k/proof.keychain-db',
    'security add-generic-password -a sage-bot-proof -s sage-bot-proof-sample-abc123 -w <sample> /k/proof.keychain-db',
    'security find-generic-password -a sage-bot-proof -s sage-bot-proof-sample-abc123 /k/proof.keychain-db',
    'security delete-keychain /k/proof.keychain-db',
    'security list-keychains -d user -s <each keychain of the saved list>',
    'security list-keychains -d user',
  ]);
});
