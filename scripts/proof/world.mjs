// The scratch world of the proof (T157): one lead session's home folder, state files, sage plugin and session folder, all below one
// scratch folder. SAMPLE DATA ONLY: every credential file and variable holds an obviously fake value that ends in the world's tag, so a
// probe or the report can say whether one appeared without printing it. Nothing here reads or writes outside `root`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { leadPolicy } from '../../src/lead-policy.js';
import { claudeDirOf, sagePlugin, sageToolIn } from '../../src/sage.js';

/** The session of the proof, and the version folder of the dummy sage plugin. */
export const SESSION = 's1';
const VERSION = 'proof1';

/** The lead policy of a world: the one resolver of its paths (src/lead-policy.js), with the world's home and temp folders. */
export const policyOf = (w) => leadPolicy({ statePath: w.statePath }, SESSION, { env: { PATH: process.env.PATH }, home: w.home, tmp: w.hostTmp, userTemp: w.userTemp, shortTmp: w.shortTmp });
/** The variables that a session must never show to a command: GitHub (F-T134-1) and the model (F-T157-4). */
export const SAMPLE_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
/** The obviously fake value of a sample variable or file. */
export const sample = (name, tag) => `sample-fake-${name.replace(/[^\w.-]/g, '_')}-${tag}`;

/**
 * Builds the world below `root` (a new folder) and returns its description, also written to <session folder>/world.json, where a
 * probe in the session can read it. The description holds paths and the tag, never a sample value.
 * @param {string} root @param {string} tag  random letters and digits; every sample value ends in it
 */
export function buildWorld(root, tag) {
  mkdirSync(root, { recursive: true });
  root = realpathSync.native(root);
  const home = join(root, 'home'), claudeConfig = claudeDirOf({ env: {}, home }), statePath = join(root, 'state', 'gates.json');
  const { cache, marketplace } = sagePlugin(claudeConfig);
  const sageRoot = join(claudeConfig, 'sage');
  const w = {
    root, tag, session: SESSION, home, claudeConfig, statePath, cache, marketplace, sageRoot,
    tool: sageToolIn(cache, VERSION),
    logbook: join(sageRoot, 'proof-000000', 'tasks.tsv'),
    hostTmp: join(root, 'tmp'), userTemp: join(root, 'utmp'), shortTmp: join(root, 'st'),
    marker: join(root, 'marker-session-start'),
    credentials: {
      ssh: join(home, '.ssh', 'id_ed25519'), aws: join(home, '.aws', 'credentials'), netrc: join(home, '.netrc'),
      gitconfig: join(home, '.gitconfig'), gitXdg: join(home, '.config', 'git', 'config'), claude: join(claudeConfig, 'settings.json'),
    },
  };
  const file = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  file(w.tool, "console.log('lead-sessions 1');\n"); // the dummy sage plugin (F-T134-6): its state tool prints the capability line
  // The rest from the policy: the bridge's config file, the session's folders, and sage's hook-state folders (the denied paths in the
  // two temp folders and in sage's root).
  const policy = policyOf(w);
  Object.assign(w, {
    config: join(policy.denied.find((d) => dirname(d) === join(home, '.config')), 'config.json'),
    sessionFolder: policy.folder, sessionTmp: policy.tmp, hooksState: policy.hooksState,
    hookDirs: policy.denied.filter((d) => [w.hostTmp, w.userTemp, sageRoot].includes(dirname(d))),
  });
  const sessionFolder = w.sessionFolder;
  // The session's folders as the user's own, writable by no other user, which the policy requires (F-T156-29), whatever the umask.
  for (const d of [sessionFolder, policy.tempRoot, w.sessionTmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // The bridge's files (F-T134-2): sample config, gate file, lead log, kill flag, spool and votes.
  file(w.config, `${JSON.stringify({ statePath, channelId: '400000000000000001', ownerId: '100000000000000001', apprenticeRole: '300000000000000001', leadRole: '300000000000000002' }, null, 2)}\n`);
  file(statePath, '{"gates":[]}\n');
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
  for (const d of [w.hostTmp, w.userTemp]) mkdirSync(d, { recursive: true });
  // The session folder: a git repository with one commit, and project settings that must not apply (F-T134-10): a SessionStart hook
  // that makes the marker file, and an Edit rule that would open everything.
  file(join(sessionFolder, 'README.md'), 'sample session folder\n');
  file(join(sessionFolder, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${w.marker}'` }] }] },
    permissions: { allow: ['Edit(//**)', 'Read(//**)'] },
  }, null, 2)}\n`);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'init.defaultBranch=main', ...args],
    { cwd: sessionFolder, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'sample');
  file(join(sessionFolder, 'world.json'), `${JSON.stringify(w, null, 2)}\n`);
  return w;
}
