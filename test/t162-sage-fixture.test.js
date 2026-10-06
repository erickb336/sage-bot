// T162: the tests run a pinned copy of the sage state tool (test/fixtures/sage/), never the sage plugin in the owner's home
// folder. SAMPLE DATA ONLY: the projects are scratch folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { FIXTURE, SAGE, testSage } from './bridge-setup.js';

test('with SAGE_TOOL unset, the tests use the pinned copy, and it is the version that its README names', () => {
  assert.equal(testSage({}), FIXTURE);
  assert.equal(testSage({ SAGE_TOOL: '' }), FIXTURE);
  assert.match(FIXTURE, /\/test\/fixtures\/sage\/39e9bf767a1f\/sage\.mjs$/);
  if (!process.env.SAGE_TOOL) assert.equal(SAGE, FIXTURE);
  const sha = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
  const readme = readFileSync(new URL('fixtures/sage/README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(`version \`39e9bf767a1f\``) && readme.includes(`SHA-256: \`${sha}\``), `the README names the pin and ${sha}`);
});

test('the pinned copy runs in a scratch HOME and SAGE_HOME and writes its logbook only there', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t162-')));
  const project = join(root, 'project');
  mkdirSync(project);
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), SAGE_HOME: join(root, 'home', 'sage') };
  const out = execFileSync(process.execPath, [FIXTURE, 'init', '--project', project], { env, encoding: 'utf8' });
  assert.match(out, new RegExp(`^logbook ${join(root, 'home', 'sage', 'project-')}[0-9a-f]{6}\n$`));
  assert.deepEqual(readdirSync(root).sort(), ['home', 'project']);
});

test('SAGE_TOOL in the owner\'s real ~/.claude, such as the sage plugin cache, is refused; a copy elsewhere is used', () => {
  const owner = join(realpathSync.native(userInfo().homedir), '.claude');
  const cached = join(owner, 'plugins', 'cache', 'sage', 'sage', '39e9bf767a1f', 'skills', 'sage', 'sage.mjs');
  assert.throws(() => testSage({ SAGE_TOOL: cached }), {
    message: `SAGE_TOOL is ${cached}, in the owner's ${owner}/: the tests use the pinned copy ${FIXTURE}, or a copy outside it.` });
  const copy = join(mkdtempSync(join(tmpdir(), 'sage-bot-t162-tool-')), 'sage.mjs');
  copyFileSync(FIXTURE, copy);
  assert.equal(testSage({ SAGE_TOOL: copy }), copy);
});
