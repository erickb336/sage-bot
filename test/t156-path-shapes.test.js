// T156, standing order 16: the path-shape corpus (test/path-shapes.json) applied to every path key of the lead policy. For each key and
// shape the policy either refuses with one line, or the path that it denies (or gives the session) is the path that the OS really
// writes: each check writes a probe file through the configured path in a scratch folder and compares the probe's real path. SAMPLE
// DATA ONLY: every path is in a new scratch folder, and no session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { leadPolicy } from '../src/lead-policy.js';

const CORPUS = JSON.parse(readFileSync(new URL('path-shapes.json', import.meta.url), 'utf8'));
const within = (inner, outer) => { const rel = relative(outer, inner); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const scratch = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-shapes-')));
/** The config, environment and host of one case below `root`, with nothing in a denied path; `set` puts one key's value in. */
function inputs(root, set = {}) {
  const config = { statePath: join(root, 's', 'state', 'gates.json') };
  const env = { CLAUDE_CONFIG_DIR: join(root, 'cc') };
  const host = { env, home: join(root, 'h'), tmp: join(root, 't'), userTemp: undefined, shortTmp: join(root, 'st'), uid: process.getuid() };
  for (const [key, value] of Object.entries(set)) {
    const { in: where } = CORPUS.keys.find((k) => k.key === key);
    (where === 'config' ? config : where === 'env' ? env : host)[key] = value;
  }
  return { config, host };
}

test('the corpus covers every key that leadPolicy reads: each is a path key with its rows, or named as no path', () => {
  const read = { config: new Set(), env: new Set(), host: new Set() };
  const spy = (where, target) => new Proxy(target, {
    get: (t, k) => { if (typeof k === 'string') read[where].add(k); return t[k]; },
    has: (t, k) => { if (typeof k === 'string') read[where].add(k); return k in t; },
  });
  const root = scratch();
  try {
    const all = { statePath: join(root, 's', 'gates.json'), auditPath: join(root, 'a'), killPath: join(root, 'k'), sessionsPath: join(root, 'sp'), votesPath: join(root, 'v'), leadSessionsPath: join(root, 'l') };
    const env = spy('env', { CLAUDE_CONFIG_DIR: join(root, 'cc'), SAGE_HOME: join(root, 'sh'), PATH: '/bin' });
    leadPolicy(spy('config', all), 's1', spy('host', { env, home: join(root, 'h'), tmp: join(root, 't'), userTemp: undefined, shortTmp: join(root, 'st'), claude: 'claude', uid: process.getuid() }));
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const where of ['config', 'env', 'host']) {
    const keys = CORPUS.keys.filter((k) => k.in === where).map((k) => k.key);
    assert.deepEqual([...read[where]].filter((k) => !keys.includes(k) && !(k in (CORPUS.notPaths[where] ?? {}))), [], `${where}: a key that leadPolicy reads has no row in test/path-shapes.json`);
    assert.deepEqual(keys.filter((k) => !read[where].has(k)), [], `${where}: a row of test/path-shapes.json names a key that leadPolicy does not read`);
  }
});

/** The target of a key below `base`, made: a file, or a folder; for SAGE_TOOL the state tool in a sage plugin cache. */
function target(key, kind, base) {
  const t = key === 'SAGE_TOOL' ? join(base, 'cc2', 'plugins', 'cache', 'sage', 'sage', 'v1', 'skills', 'sage', 'sage.mjs') : join(base, key, kind === 'file' ? 'f.json' : 'dir');
  mkdirSync(dirname(t), { recursive: true });
  if (kind === 'file') writeFileSync(t, ''); else mkdirSync(t);
  return t;
}
/** The path of one shape for target `t`, made in the new folder `x`. */
const SHAPES = {
  'plain-outside-home': (t) => t,
  'plain-inside-home': (t) => t,
  relative: (t) => relative(process.cwd(), t),
  tilde: (t) => `~/${t.split(sep).at(-1)}`,
  'dot-part': (t) => `${dirname(t)}/./${t.split(sep).at(-1)}`,
  'dotdot-part': (t) => { mkdirSync(join(dirname(t), 'sub')); return `${dirname(t)}/sub/../${t.split(sep).at(-1)}`; },
  'dotdot-after-link': (t, x) => { mkdirSync(join(x, 'other', 'a'), { recursive: true }); symlinkSync(join(x, 'other', 'a'), join(x, 'lnk')); return `${x}/lnk/../${t.split(sep).at(-1)}`; },
  'trailing-slash': (t) => `${t}/`,
  'doubled-slash': (t) => `${dirname(t)}//${t.split(sep).at(-1)}`,
  empty: () => '',
  'link-at-leaf': (t, x) => { symlinkSync(t, join(x, 'leaf')); return join(x, 'leaf'); },
  'link-at-parent': (t, x) => { symlinkSync(dirname(t), join(x, 'parent')); return join(x, 'parent', t.split(sep).at(-1)); },
  'dangling-link-at-leaf': (t, x) => { symlinkSync(join(x, 'nothing'), join(x, 'leaf')); return join(x, 'leaf'); },
  'dangling-link-at-parent': (t, x) => { symlinkSync(join(x, 'nothing'), join(x, 'parent')); return join(x, 'parent', t.split(sep).at(-1)); },
  'case-variant': (t) => join(dirname(dirname(t)), dirname(t).split(sep).at(-1).toUpperCase(), t.split(sep).at(-1)),
};
/** The probes of a key: each a file that the bridge or sage writes through the path `p`, and the policy's folders that must hold it. */
const PROBES = {
  statePath: (p, q) => [[p, q.denied], [join(dirname(p), 'threads.json'), q.denied]],
  auditPath: (p, q) => [[p, q.denied]],
  killPath: (p, q) => [[p, q.denied]],
  sessionsPath: (p, q) => [[join(p, 'probe.json'), q.denied]],
  votesPath: (p, q) => [[p, q.denied], [`${p}.leads`, q.denied]],
  leadSessionsPath: (p, q) => [[join(p, 'sessions', 's1', 'probe'), [q.folder]], [join(p, 'claude', 'probe'), q.denied]],
  SAGE_HOME: (p, q) => [[join(p, 'probe'), q.denied], [join(p, '.hooks', 'probe'), q.denied]],
  CLAUDE_CONFIG_DIR: (p, q) => [[join(p, 'sage', 'probe'), q.denied], [join(p, 'plugins', 'cache', 'sage', 'probe'), q.denied], [join(p, 'plugins', 'marketplaces', 'sage', 'probe'), q.denied], [join(p, 'probe'), q.credentialFiles]],
  home: (p, q) => [[join(p, 'probe'), [q.home]], [join(p, '.config', 'sage-bot', 'probe'), q.denied], [join(p, '.ssh', 'probe'), q.credentialFiles]],
  tmp: (p, q) => [[join(p, 'sage-hooks', 'probe'), q.denied]],
};

test('every shape has its maker, every key its probes', () => {
  assert.deepEqual(CORPUS.shapes.map((s) => s.id).sort(), Object.keys(SHAPES).sort());
  assert.deepEqual(CORPUS.keys.map((k) => k.key).filter((k) => k !== 'SAGE_TOOL').sort(), Object.keys(PROBES).sort());
});

for (const { key, in: where, name, kind } of CORPUS.keys) {
  for (const shape of CORPUS.shapes) {
    const expect = where === 'env' ? shape.expectEnv ?? shape.expect : shape.expect;
    test(`${key}, ${shape.id}: ${expect}`, (t) => {
      const root = scratch();
      try {
        const base = join(root, shape.id === 'plain-inside-home' ? 'h' : 'out');
        const at = target(key, kind, base);
        const x = join(base, 'shape');
        mkdirSync(x, { recursive: true });
        if (shape.id === 'case-variant' && !existsSync(dirname(at).toUpperCase())) return t.skip('the scratch volume is case-sensitive');
        const path = SHAPES[shape.id](at, x);
        const extra = key === 'SAGE_TOOL' ? { CLAUDE_CONFIG_DIR: join(base, 'cc2') } : {};
        const { config, host } = inputs(root, { ...extra, [key]: path });
        if (expect === 'refused') {
          assert.throws(() => leadPolicy(config, 's1', host), (e) => {
            assert.doesNotMatch(e.message, /\n/);
            assert.match(e.message, new RegExp(shape.says));
            if (shape.says.startsWith('must')) assert.ok(e.message.startsWith(`${name} must be an absolute path`), e.message);
            return true;
          });
          return;
        }
        const policy = leadPolicy(config, 's1', host);
        if (expect === 'unset') {
          const without = inputs(root, extra);
          delete (where === 'env' ? without.host.env : without.config)[key];
          assert.deepEqual(policy, leadPolicy(without.config, 's1', without.host));
          return;
        }
        if (key === 'SAGE_TOOL') { // the file that the preflight runs, and the plugin folder, are the real ones
          assert.equal(policy.sageTool, realpathSync.native(path));
          assert.equal(policy.pluginDir, join(base, 'cc2', 'plugins', 'cache', 'sage', 'sage', 'v1'));
          return;
        }
        for (const [probe, folders] of PROBES[key](path, policy)) {
          mkdirSync(dirname(probe), { recursive: true });
          writeFileSync(probe, 'probe');
          const written = realpathSync.native(probe);
          assert.ok(folders.some((f) => within(written, f)), `${probe} writes ${written}, in none of ${folders.join(', ')}`);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

/** Makes `path` in the given form: a folder of the user (0700), a link, a file, or a folder that other users can write. */
function make(path, form, root) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (form === 'link') { mkdirSync(join(root, 'elsewhere')); symlinkSync(join(root, 'elsewhere'), path); return; }
  if (form === 'file') { writeFileSync(path, ''); return; }
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, { 'other-write': 0o757, 'group-write': 0o770 }[form] ?? 0o700);
}

for (const row of CORPUS.folders) {
  test(`the ${row.folder}, ${row.make}: ${row.expect} (F-T156-29)`, () => {
    const root = scratch();
    try {
      const { config, host } = inputs(root, { leadSessionsPath: join(root, 'l') });
      const tempRoot = join(root, 'st', 'sage-lead');
      const path = { 'session folder': join(root, 'l', 'sessions', 's1'), 'folder of all temp folders': tempRoot, 'temp folder': join(tempRoot, 's1') }[row.folder];
      if (row.folder === 'temp folder') make(tempRoot, 'own', root);
      make(path, row.make, root);
      if (row.make === 'foreign') host.uid = process.getuid() + 1; // the folder is then another user's
      if (row.expect === 'ok') {
        const p = leadPolicy(config, 's1', host);
        assert.deepEqual([p.folder, p.tmp, p.tempRoot], [join(root, 'l', 'sessions', 's1'), join(tempRoot, 's1'), tempRoot]);
        return;
      }
      assert.throws(() => leadPolicy(config, 's1', host), { message: new RegExp(`^the lead session's ${row.folder} ${path} is ${row.says}[^\\n]*: a session could reach another folder through it\\. Remove it\\. Nothing was started\\.$`) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
