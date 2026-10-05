// T63: the launchd plist survives a Node upgrade (no path under Cellar/<version>) and refuses a bad config path.
// SAMPLE DATA ONLY. HOME is a scratch folder; nothing writes into ~/Library or runs launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as launchdModule from '../src/launchd.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts/launchd.mjs');

function launchd(config) {
  const home = mkdtempSync(join(tmpdir(), 'sage-bot-t63-'));
  try {
    const path = config === undefined ? join(home, 'missing.json') : join(home, 'config.json');
    if (config !== undefined) writeFileSync(path, config);
    const r = spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    return { ...r, path };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const SAMPLE = readFileSync(join(ROOT, 'examples/config.example.json'), 'utf8');
const firstArgument = (text) => /<key>ProgramArguments<\/key>\n  <array>\n    <string>([^<]+)<\/string>/.exec(text)?.[1];

test('on this Mac, the plist node is not under Cellar/<version>, and it is the brew symlink when that symlink runs this node', () => {
  const r = launchd(SAMPLE);
  assert.equal(r.status, 0, r.stderr);
  const node = firstArgument(r.stdout);
  assert.doesNotMatch(node, /\/Cellar\/[^/]+\/[^/]+\//);
  const brew = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p) && realpathSync(p) === realpathSync(process.execPath));
  if (brew) assert.equal(node, brew);
});

// A fake file system: each link maps a path to its real path; a path not in it does not exist.
const fake = (links) => (p) => {
  if (!(p in links)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return links[p];
};
const CELLAR = '/opt/homebrew/Cellar/node/26.8.2/bin/node';

test('the node path rule, with a fake execPath and fake links', () => {
  const { stableNode } = launchdModule;
  // 1. The brew symlink that resolves to the running node.
  assert.deepEqual(stableNode(CELLAR, fake({ [CELLAR]: CELLAR, '/opt/homebrew/bin/node': CELLAR, '/opt/homebrew/opt/node/bin/node': CELLAR })), { node: '/opt/homebrew/bin/node' });
  assert.deepEqual(stableNode('/usr/local/Cellar/node/26.8.2/bin/node', fake({ '/usr/local/Cellar/node/26.8.2/bin/node': '/usr/local/Cellar/node/26.8.2/bin/node', '/usr/local/bin/node': '/usr/local/Cellar/node/26.8.2/bin/node' })), { node: '/usr/local/bin/node' });
  // 2. A brew symlink to another node (node@22 runs, node is linked): the opt link of the running formula.
  const n22 = '/opt/homebrew/Cellar/node@22/22.20.0/bin/node';
  assert.deepEqual(stableNode(n22, fake({ [n22]: n22, '/opt/homebrew/bin/node': CELLAR, '/opt/homebrew/opt/node@22/bin/node': n22 })), { node: '/opt/homebrew/opt/node@22/bin/node' });
  // 3. No stable link: the running node, with a warning.
  const nvm = '/Users/sample/.nvm/versions/node/v22.20.0/bin/node';
  const r = stableNode(nvm, fake({ [nvm]: nvm }));
  assert.equal(r.node, nvm);
  assert.match(r.warning, /make the plist again after each Node upgrade/);
  // 4. Never a path under Cellar/<version>: a Cellar node with no link is refused.
  assert.throws(() => stableNode(CELLAR, fake({ [CELLAR]: CELLAR })), /no stable link to \/opt\/homebrew\/Cellar\/node\/26\.8\.2\/bin\/node/);
});

test('a missing config, a non-JSON config and a config without the bridge fields exit 1 with a clear message and print no plist', () => {
  const missing = launchd(undefined);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, `sage-bot launchd: the config file ${missing.path} does not exist. No plist printed.\n`);

  const text = launchd('guildId = 1');
  assert.equal(text.status, 1);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /^sage-bot launchd: the config file .+config\.json is not JSON \(.+\)\. No plist printed\.\n$/);

  const partial = launchd(JSON.stringify({ guildId: '1', channelId: '2', ownerId: '3', apprenticeRole: '4', leadRole: '5', project: '/p', sagePath: '' }));
  assert.equal(partial.status, 1);
  assert.equal(partial.stdout, '');
  assert.match(partial.stderr, /^sage-bot launchd: the config file .+config\.json has no sagePath, statePath\. No plist printed\.\n$/);
});
