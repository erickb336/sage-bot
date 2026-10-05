// T62: launchd.mjs --out never empties a working plist, refuses ids that the bridge refuses, and names the current node
// for an old Cellar node; preview.mjs --out writes the page outside the repo.
// SAMPLE DATA ONLY. Every file is in a scratch folder; nothing writes into ~/Library or runs launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableNode } from '../src/launchd.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SAMPLE = JSON.parse(readFileSync(join(ROOT, 'examples/config.example.json'), 'utf8'));
const OLD = '<plist>the working plist</plist>\n';

/** Runs launchd.mjs with a config and --out <dir>/com.sage.bot.plist, where that file holds OLD at the start. */
function launchd(config, t) {
  const home = mkdtempSync(join(tmpdir(), 'sage-bot-t62-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'config.json');
  const out = join(home, 'com.sage.bot.plist');
  writeFileSync(path, JSON.stringify(config));
  writeFileSync(out, OLD);
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/launchd.mjs'), path, '--out', out], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  return { ...r, path, out, plist: readFileSync(out, 'utf8'), files: readdirSync(home).sort() };
}

test('--out replaces the plist with the new one, prints no plist, and leaves no temp file', (t) => {
  const r = launchd(SAMPLE, t);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `wrote ${r.out}\n`);
  assert.match(r.plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(r.plist, new RegExp(`<string>${r.path}</string>`));
  assert.deepEqual(r.files, ['com.sage.bot.plist', 'config.json']);
});

test('a refused config with --out leaves the working plist as it was', (t) => {
  const r = launchd({ ...SAMPLE, statePath: '' }, t);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `sage-bot launchd: the config file ${r.path} has no statePath. No plist written: ${r.out} is unchanged.\n`);
  assert.equal(r.plist, OLD);
  assert.deepEqual(r.files, ['com.sage.bot.plist', 'config.json']);
});

test('a Discord id field that is not 17 to 20 digits is refused, as the bridge refuses it', (t) => {
  const r = launchd({ ...SAMPLE, guildId: '2000', ownerId: '1000000000000000001x', leadRole: '3'.repeat(21) }, t);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `sage-bot launchd: in the config file ${r.path}, guildId, ownerId, leadRole must each be a Discord id (17 to 20 digits). No plist written: ${r.out} is unchanged.\n`);
  assert.equal(r.plist, OLD);
  // The edges: 17 and 20 digits pass.
  const ok = launchd({ ...SAMPLE, guildId: '1'.repeat(17), leadRole: '9'.repeat(20) }, t);
  assert.equal(ok.status, 0, ok.stderr);
});

test('without --out, the plist goes to stdout as before', () => {
  const home = mkdtempSync(join(tmpdir(), 'sage-bot-t62-'));
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify(SAMPLE));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/launchd.mjs'), join(home, 'config.json')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^<\?xml version="1\.0"[\s\S]*<key>Label<\/key>\n  <string>com\.sage\.bot<\/string>[\s\S]*<\/plist>\n$/);
    assert.deepEqual(readdirSync(home), ['config.json']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an old Cellar node after an upgrade: the message names the current node, not brew link', () => {
  const old = '/opt/homebrew/Cellar/node/26.8.1/bin/node';
  const now = '/opt/homebrew/Cellar/node/26.8.2/bin/node';
  const links = { [old]: old, '/opt/homebrew/bin/node': now, '/opt/homebrew/opt/node/bin/node': now };
  const realpath = (p) => { if (!(p in links)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return links[p]; };
  assert.throws(() => stableNode(old, realpath), {
    message: `${old} is an old node: Homebrew now links /opt/homebrew/opt/node/bin/node to ${now}. Run the script again with the current node (/opt/homebrew/opt/node/bin/node)`,
  });
});

test('preview.mjs --out writes the page there and leaves design/b2 in the repo as it was', () => {
  const home = mkdtempSync(join(tmpdir(), 'sage-bot-t62-'));
  const repoPage = join(ROOT, 'design/b2/index.html');
  const before = statSync(repoPage).mtimeMs;
  try {
    const out = join(home, 'page', 'index.html');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/preview.mjs'), '--out', out], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `wrote ${out} with 11 moments\n`);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(repoPage, 'utf8'));
    assert.equal(statSync(repoPage).mtimeMs, before);
    assert.equal(existsSync(join(home, 'page', 'shots')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
