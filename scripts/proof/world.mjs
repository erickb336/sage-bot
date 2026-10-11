// The scratch world of the proof (T157): one lead session's home folder, state files, sage plugin and session folder, a second
// session's folders and transcript (T165), all below one scratch folder, and its temp root, a short new folder in /private/tmp (the policy's 44-byte limit, F-T156-35). SAMPLE DATA ONLY: every credential file and variable holds an obviously fake value that ends in the world's tag, so a
// probe or the report can say whether one appeared without printing it. Nothing here writes outside `root` and the temp root (`root` is
// a new folder: the run refuses one that is not empty, F-T157-23), and every temp root is recorded, so that the run removes it at its end
// (removeTempRoots), also when it fails or is stopped (F-T157-10).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { leadPolicy } from '../../src/lead-policy.js';
import { claudeDirOf, sagePlugin, sageToolIn } from '../../src/sage.js';
import { ACCOUNT, keychainIdOf, keychainPlan } from './keychain.mjs';

/** The session of the proof, the other session of its world (F-T156-31: a write to its folders must be refused), and the version
 * folder of the dummy sage plugin. */
export const SESSION = 's1';
export const OTHER_SESSION = 's2';
const VERSION = 'proof1';

/**
 * The folder in which a world makes its temp root. It is canonical, and short: `<temp root>/s1/claude-<uid>` must fit in
 * CLAUDE_TMP_MAX bytes (F-T156-35), which no folder below a scratch TMPDIR does. Never TEMP_ROOT, the real sessions' one.
 */
const SHORT_TMP = '/private/tmp/sbp-';
/** The temp roots that this process made and has not removed yet. */
const tempRoots = new Set();
/** Removes every temp root that this process made (F-T157-10). Safe to call twice, and after a world was removed by hand. */
export function removeTempRoots() {
  for (const d of tempRoots) { rmSync(d, { recursive: true, force: true }); tempRoots.delete(d); }
}
/** The lead policy of a world: the one resolver of its paths (src/lead-policy.js), with the world's home and temp folders. The
 * owner's home folder is the real one (ownerHome): the proof checks that it stays denied with the world's HOME (F-T157-7). */
export const policyOf = (w) => leadPolicy({ statePath: w.statePath }, SESSION, { env: { PATH: process.env.PATH }, home: w.home, userTemp: w.userTemp, tempRoot: w.tempRoot });
/** The variables that a session must never show to a command: GitHub (F-T134-1) and the model (F-T157-4). */
export const SAMPLE_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
/** The obviously fake value of a sample variable or file. */
export const sample = (name, tag) => `sample-fake-${name.replace(/[^\w.-]/g, '_')}-${tag}`;

/**
 * Builds the world below `root` (a new folder) and a new temp root (w.tempRoot, recorded for removeTempRoots; a failure here removes
 * it at once), and returns its description, also written to <session folder>/world.json, where a probe in the session can read it. The
 * description holds paths and the tag, never a sample value.
 * The world also names the run's scratch keychain (scripts/proof/keychain.mjs): `<the folder above root>/keychain/proof.keychain-db`,
 * one for both worlds of a run, with its service name and account; the live run makes it, and the Keychain probes name it by that path.
 * @param {string} root @param {string} tag  random letters and digits; every sample value ends in it
 */
export function buildWorld(root, tag) {
  mkdirSync(root, { recursive: true });
  root = realpathSync.native(root);
  const tempRoot = mkdtempSync(SHORT_TMP); // mkdtemp: the user's own folder, 0700 (F-T156-29)
  tempRoots.add(tempRoot);
  try { return fill(root, tag, tempRoot); } catch (e) { rmSync(tempRoot, { recursive: true, force: true }); tempRoots.delete(tempRoot); throw Object.assign(e, { tempRoot }); } // the error names the root, so a test can check that it went (T174)
}
function fill(root, tag, tempRoot) {
  const home = join(root, 'home'), claudeConfig = claudeDirOf({ env: {}, home }), statePath = join(root, 'state', 'gates.json');
  const { cache, marketplace } = sagePlugin(claudeConfig);
  const sageRoot = join(claudeConfig, 'sage');
  const kc = keychainPlan(join(dirname(root), 'keychain'), keychainIdOf(tag));
  const w = {
    root, tag, session: SESSION, home, claudeConfig, statePath, cache, marketplace, sageRoot,
    keychain: { path: kc.path, service: kc.service, account: ACCOUNT, id: keychainIdOf(tag) }, // F-T165-2
    ghConfig: join(home, '.config', 'gh'), ghTokenId: keychainIdOf(tag), // F-T165-10: a gh config with a sample token that ends in this id, for the control
    tool: sageToolIn(cache, VERSION),
    logbook: join(sageRoot, 'proof-000000', 'tasks.tsv'),
    userTemp: join(root, 'utmp'), tempRoot,
    marker: join(root, 'marker-session-start'),
    credentials: {
      ssh: join(home, '.ssh', 'id_ed25519'), aws: join(home, '.aws', 'credentials'), netrc: join(home, '.netrc'),
      gitconfig: join(home, '.gitconfig'), gitXdg: join(home, '.config', 'git', 'config'), claude: join(claudeConfig, 'settings.json'),
      claudeJson: join(home, '.claude.json'), // F-T157-11: the owner's Claude Code state file, outside the config folder
    },
  };
  const file = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  file(w.tool, "console.log('lead-sessions 1');\n"); // the dummy sage plugin (F-T134-6): its state tool prints the capability line
  file(join(cache, 'sage', VERSION, '.claude-plugin', 'plugin.json'), '{"name":"sage"}\n'); // a plugin that --plugin-dir loads (T165)
  // The rest from the policy: the bridge's config file, the session's folders, and sage's hook-state folders (the denied paths in the
  // per-user temp folder, in /private/tmp and in sage's root; the one in /private/tmp is the host's own, and only a probe's control reads it).
  const policy = policyOf(w);
  Object.assign(w, {
    config: join(policy.denied.find((d) => dirname(d) === join(home, '.config')), 'config.json'),
    sessionFolder: policy.folder, sessionTmp: policy.tmp, hooksState: policy.hooksState,
    launchd: { plist: join(policy.folder, 'sage-bot-proof.plist'), label: `sage-bot-proof-${keychainIdOf(tag)}` }, // F-T165-24: a no-op job (/usr/bin/true, not run at load), one label a run
    hookDirs: policy.denied.filter((d) => [w.userTemp, '/private/tmp', sageRoot].includes(dirname(d))),
    // The other session's folder and temp folder (F-T156-31, F-T156-34), and a transcript of its own in the lead sessions' Claude Code
    // config folder (F-T173-1): a session reads and writes none of them.
    other: { session: OTHER_SESSION, folder: join(policy.sessions, OTHER_SESSION), tmp: join(policy.tempRoot, OTHER_SESSION) },
    claudeDir: policy.claudeDir,
    transcript: join(policy.claudeDir, 'projects', `-sessions-${OTHER_SESSION}`, 'sample-transcript.jsonl'),
  });
  const sessionFolder = w.sessionFolder;
  // The session's folders as the user's own, writable by no other user, which the policy requires (F-T156-29), whatever the umask.
  for (const d of [sessionFolder, w.sessionTmp, w.other.folder, w.other.tmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
  file(join(w.other.folder, 'README.md'), 'sample folder of the other session\n');
  file(w.transcript, `${JSON.stringify({ type: 'user', text: sample('transcript', tag) })}\n`);
  // The bridge's files (F-T134-2): sample config, gate file, lead log, kill flag, spool and votes.
  file(w.config, `${JSON.stringify({ statePath, channelId: '400000000000000001', ownerId: '100000000000000001', apprenticeRole: '300000000000000001', leadRole: '300000000000000002' }, null, 2)}\n`);
  file(statePath, `${JSON.stringify({ gates: [], sample: sample('gates', tag) })}\n`); // a sample value: a Read that works shows it (F-T165-22)
  file(`${statePath}.leads.jsonl`, '{"at":0,"event":"sample"}\n');
  file(`${statePath}.leads-off`, 'off\n');
  file(join(`${statePath}.sessions`, 'sample.json'), '{}\n');
  file(`${statePath}.votes`, '{}\n');
  file(`${statePath}.votes.leads`, '{}\n');
  file(join(w.marketplace, 'README.md'), 'sample marketplace copy\n');
  file(w.logbook, 'id\ttitle\nT1\tsample task\n');
  for (const d of w.hookDirs.filter((d) => dirname(d) === sageRoot)) mkdirSync(d, { recursive: true });
  // The credential files (F-T134-15a), with fake values.
  file(w.credentials.ssh, `${sample('ssh', tag)}\n`);
  file(w.credentials.aws, `[default]\naws_secret_access_key = ${sample('aws', tag)}\n`);
  file(w.credentials.netrc, `machine example.invalid login sample password ${sample('netrc', tag)}\n`);
  file(w.credentials.gitconfig, `[user]\n\tname = sample\n[sample]\n\tvalue = ${sample('gitconfig', tag)}\n`);
  file(w.credentials.gitXdg, `[sample]\n\tvalue = ${sample('git-xdg', tag)}\n`);
  file(w.credentials.claude, `${JSON.stringify({ sample: sample('claude', tag) })}\n`);
  file(join(w.ghConfig, 'hosts.yml'), `github.com:\n    oauth_token: sample-fake-gh-token-${w.ghTokenId}\n    user: sample\n    git_protocol: https\n`);
  file(w.credentials.claudeJson, `${JSON.stringify({ mcpServers: { sample: { env: { SAMPLE: sample('claude-json', tag) } } } })}\n`);
  mkdirSync(w.userTemp, { recursive: true });
  // The session folder: a git repository with one commit, and project settings that must not apply (F-T134-10): a SessionStart hook
  // that makes the marker file, and an Edit rule that would open everything.
  file(join(sessionFolder, 'README.md'), 'sample session folder\n');
  file(w.launchd.plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${w.launchd.label}</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array><key>RunAtLoad</key><false/></dict></plist>\n`);
  file(join(sessionFolder, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${w.marker}'` }] }] },
    permissions: { allow: ['Edit(//**)', 'Read(//**)'] },
  }, null, 2)}\n`);
  const git = (...args) => { // F-T157-23: git's own error line reaches the run's error line
    const r = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'init.defaultBranch=main', ...args],
      { cwd: sessionFolder, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${sessionFolder}: ${(r.stderr || r.error?.message || `exit ${r.status}`).split('\n').find(Boolean)}`);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'sample');
  file(join(sessionFolder, 'world.json'), `${JSON.stringify(w, null, 2)}\n`);
  return w;
}
