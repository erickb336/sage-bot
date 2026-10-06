// T162: the tests run a pinned copy of the sage state tool (test/fixtures/sage/), never the sage plugin in the owner's home
// folder. SAMPLE DATA ONLY: the projects are scratch folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync, FIXTURE, SAGE, spawnSync, testSage } from './bridge-setup.js';

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

test('SAGE_TOOL in the owner\'s real ~/.claude, such as the sage plugin cache, is refused by its given path, in any case; a copy elsewhere is used', () => {
  const owner = join(userInfo().homedir, '.claude');
  const cached = join(owner, 'plugins', 'cache', 'sage', 'sage', 'no-such-version', 'skills', 'sage', 'sage.mjs');
  for (const path of [cached, cached.replace('/.claude/', '/.Claude/'), owner]) {
    assert.throws(() => testSage({ SAGE_TOOL: path }), {
      message: `SAGE_TOOL is ${path}, in the owner's ${owner}/: the tests use the pinned copy ${FIXTURE}, or a copy outside it.` });
  }
  const copy = join(mkdtempSync(join(tmpdir(), 'sage-bot-t162-tool-')), 'sage.mjs');
  copyFileSync(FIXTURE, copy);
  assert.equal(testSage({ SAGE_TOOL: copy }), copy);
});

test('F-T162-2: each child process of a test gets SAGE_TOOL, unless the test names its own', () => {
  const printed = (env) => spawnSync('/bin/sh', ['-c', 'printf %s "$SAGE_TOOL"'], { env, encoding: 'utf8' }).stdout;
  assert.equal(printed({ PATH: process.env.PATH }), SAGE);
  assert.equal(printed(undefined), SAGE);
  assert.equal(printed({ PATH: process.env.PATH, SAGE_TOOL: '' }), SAGE);
  assert.equal(printed({ PATH: process.env.PATH, SAGE_TOOL: '/sample/tool.mjs' }), '/sample/tool.mjs');
  assert.equal(execFileSync('/bin/sh', ['-c', 'printf %s "$SAGE_TOOL"'], { env: {}, encoding: 'utf8' }), SAGE);
});

test('F-T162-2: no test file but bridge-setup.js imports node:child_process, so that no child process misses SAGE_TOOL', () => {
  const dir = new URL('.', import.meta.url).pathname;
  // The file's own imports: the lines before its first line of code (an import inside a string is a child's script, which inherits).
  const head = (f) => { const lines = readFileSync(join(dir, f), 'utf8').split('\n'); return lines.slice(0, lines.findIndex((l) => !/^(import |\/\/|$)/.test(l))); };
  const imports = (f) => head(f).some((l) => /node:child_process/.test(l));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 40);
  assert.deepEqual(files.filter((f) => imports(f)), ['bridge-setup.js']);
});
