// F-T27-2: npm, run from another folder with --prefix on this project, writes and deletes no log file anywhere.
// It runs npm with HOME set to a scratch folder, never the real home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from './bridge-setup.js';

const PROJECT = new URL('..', import.meta.url).pathname;

test('F-T27-2, F-T27-15: planted npm logs survive an npm run from another folder, and npm writes no log in its cache either', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sage-bot-npmrc-'));
  const home = join(scratch, 'home');
  const elsewhere = join(scratch, 'elsewhere');
  const planted = ['2026-01-01T00_00_00_000Z-debug-0.log', '2026-01-02T00_00_00_000Z-debug-0.log', '2026-01-03T00_00_00_000Z-debug-0.log'];
  for (const dir of [join(elsewhere, '.npm-logs'), join(home, '.npm', '_logs')]) {
    mkdirSync(dir, { recursive: true });
    for (const f of planted) writeFileSync(join(dir, f), 'planted\n');
  }
  // `npm run` on a script that only prints: a real npm run (config, log file, cleanup) from the other folder.
  const out = execFileSync('npm', ['--prefix', PROJECT, 'run', 'check:npmrc-probe', '--silent'], {
    cwd: elsewhere, encoding: 'utf8', env: { ...process.env, HOME: home, npm_config_cache: join(scratch, 'npm-cache'), DO_NOT_TRACK: '1' },
  });
  assert.equal(out.trim(), 'probe');
  assert.deepEqual(readdirSync(join(elsewhere, '.npm-logs')).sort(), planted);
  assert.deepEqual(readdirSync(join(home, '.npm', '_logs')).sort(), planted);
  assert.deepEqual(readdirSync(elsewhere), ['.npm-logs']); // npm made no folder there
  // Without the .npmrc, npm writes its debug log to <cache>/_logs: its absence proves that the settings are in effect (F-T27-15).
  assert.equal(existsSync(join(scratch, 'npm-cache', '_logs')), false);
});
