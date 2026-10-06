// T156, standing order 16: the path-shape corpus (test/path-shapes.json) applied to every path key of the lead policy. One rule holds
// every path (G48 A): it must be canonical (canonicalPath in src/sage.js). Each non-canonical shape is refused with one line; a canonical
// path is accepted, and a probe file written through it lands in the policy's denied (or own) path. The folder and pair rows check the
// folders that the lead sessions own. SAMPLE DATA ONLY: every path is in a new scratch folder or does not exist, and no session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { CLAUDE_TMP_MAX, leadPolicy } from '../src/lead-policy.js';
import { canonicalPath } from '../src/sage.js';

const CORPUS = JSON.parse(readFileSync(new URL('path-shapes.json', import.meta.url), 'utf8'));
const within = (inner, outer) => { const rel = relative(outer, inner); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const scratch = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'sage-bot-t156-shapes-')));
/** A folder of all temp folders that does not exist and is short: a scratch one is longer than CLAUDE_TMP_MAX allows (F-T156-35). */
const TEMPS = '/st/sage-lead';
/** The config, environment and host of one case below `root`, with nothing in a denied path; `set` puts one key's value in. */
function inputs(root, set = {}) {
  const config = { statePath: join(root, 's', 'state', 'gates.json') };
  const env = { CLAUDE_CONFIG_DIR: join(root, 'cc') };
  const host = { env, home: join(root, 'h'), tmp: join(root, 't'), userTemp: undefined, tempRoot: TEMPS, uid: process.getuid() };
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
    leadPolicy(spy('config', all), 's1', spy('host', { env, home: join(root, 'h'), tmp: join(root, 't'), userTemp: undefined, tempRoot: TEMPS, claude: 'claude', uid: process.getuid() }));
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const where of ['config', 'env', 'host']) {
    const keys = CORPUS.keys.filter((k) => k.in === where).map((k) => k.key);
    assert.deepEqual([...read[where]].filter((k) => !keys.includes(k) && !(k in (CORPUS.notPaths[where] ?? {}))), [], `${where}: a key that leadPolicy reads has no row in test/path-shapes.json`);
    assert.deepEqual(keys.filter((k) => !read[where].has(k)), [], `${where}: a row of test/path-shapes.json names a key that leadPolicy does not read`);
  }
});

test('F-T156-37, standing order 12: a sweep of every Unicode code point; only A-Z, a-z, 0-9, ".", "_", "-", a space (and "/", between parts) pass the path rule', () => {
  const passed = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp);
    try { canonicalPath('the sweep', `/sage-bot-t156-no-such-folder/a${ch}b`); passed.push(ch); } catch { /* refused */ }
  }
  assert.equal(passed.join(''), ' -./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz');
});

test('the path rule refuses each non-canonical form also where nothing of the path exists', () => {
  const none = '/sage-bot-t156-no-such-folder';
  for (const bad of ['', '/', 'a/b', `${none}/a `, `${none}/ a`, `${none}/a  b`, `${none}/`, `${none}//b`, `${none}/./b`, `${none}/../b`, '/System/Volumes/Data', '/System/Volumes/Data/private/tmp', undefined, 7]) {
    assert.throws(() => canonicalPath('the path', bad), (e) => e.message.startsWith(`the path ${CORPUS.says} (`) && e.message.endsWith(`), not ${JSON.stringify(bad ?? null)}. Nothing was started.`));
  }
  assert.equal(canonicalPath('the path', `${none}/a.b_c-1`), `${none}/a.b_c-1`);
});

/** The target of a key below `base`, made: a file, or a folder; for SAGE_TOOL the state tool in a sage plugin cache. */
function target(key, kind, base) {
  const t = key === 'SAGE_TOOL' ? join(base, 'cc2', 'plugins', 'cache', 'sage', 'sage', 'v1', 'skills', 'sage', 'sage.mjs') : join(base, key, kind === 'file' ? 'f.json' : 'dir');
  mkdirSync(dirname(t), { recursive: true });
  if (kind === 'file') writeFileSync(t, ''); else mkdirSync(t);
  return t;
}
const leaf = (t) => t.split(sep).at(-1);
/** The path of one shape for target `t`, made in the new folder `x`; undefined when the scratch volume cannot have the shape. */
const SHAPES = {
  'canonical-outside-home': (t) => t,
  'canonical-inside-home': (t) => t,
  relative: (t) => relative(process.cwd(), t),
  tilde: (t) => `~/${leaf(t)}`,
  'dot-part': (t) => `${dirname(t)}/./${leaf(t)}`,
  'dotdot-part': (t) => { mkdirSync(join(dirname(t), 'sub')); return `${dirname(t)}/sub/../${leaf(t)}`; },
  'dotdot-after-link': (t, x) => { mkdirSync(join(x, 'other', 'a'), { recursive: true }); symlinkSync(join(x, 'other', 'a'), join(x, 'lnk')); return `${x}/lnk/../${leaf(t)}`; },
  'trailing-slash': (t) => `${t}/`,
  'doubled-slash': (t) => `${dirname(t)}//${leaf(t)}`,
  empty: () => '',
  'link-at-leaf': (t, x) => { symlinkSync(t, join(x, 'leaf')); return join(x, 'leaf'); },
  'link-at-parent': (t, x) => { symlinkSync(dirname(t), join(x, 'parent')); return join(x, 'parent', leaf(t)); },
  'dangling-link-at-leaf': (t, x) => { symlinkSync(join(x, 'nothing'), join(x, 'leaf')); return join(x, 'leaf'); },
  'dangling-link-at-parent': (t, x) => { symlinkSync(join(x, 'nothing'), join(x, 'parent')); return join(x, 'parent', leaf(t)); },
  'case-variant': (t) => { // the folder of the target in the other letter case
    const name = leaf(dirname(t)), other = name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase();
    const p = join(dirname(dirname(t)), other, leaf(t));
    return existsSync(p) ? p : undefined;
  },
  'glob-star': (t) => `${dirname(t)}/*`,
  'glob-question': (t) => `${dirname(t)}/${leaf(t).slice(0, -1)}?`,
  'glob-bracket': (t) => `${dirname(t)}/[${leaf(t)}]`,
  'canonical-with-space': (t) => t, // the target is in a folder "Application Support"
  'space-at-end': (t) => `${t} `,
  'space-at-start': (t) => `${dirname(t)}/ ${leaf(t)}`,
  'space-doubled': (t) => `${dirname(t)}/a  ${leaf(t)}`,
  'non-ascii': (t) => `${dirname(t)}/é${leaf(t)}`,
  'control-character': (t) => `${dirname(t)}/\u0001${leaf(t)}`,
  'data-volume': (t) => `/System/Volumes/Data${t}`,
  'system-link': (t) => (t.startsWith('/private/') ? t.slice('/private'.length) : undefined),
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
        const base = join(root, { 'canonical-inside-home': 'h', 'canonical-with-space': 'Application Support' }[shape.id] ?? 'out');
        const at = target(key, kind, base);
        const x = join(base, 'shape');
        mkdirSync(x, { recursive: true });
        const path = SHAPES[shape.id](at, x);
        if (path === undefined) return t.skip('the scratch volume cannot have this shape (case-sensitive, or not in /private)');
        const extra = key === 'SAGE_TOOL' ? { CLAUDE_CONFIG_DIR: join(base, 'cc2') } : {};
        const { config, host } = inputs(root, { ...extra, [key]: path });
        if (expect === 'refused') {
          assert.throws(() => leadPolicy(config, 's1', host), (e) => {
            assert.doesNotMatch(e.message, /\n/);
            assert.ok(e.message.startsWith(`${name} ${CORPUS.says} `), e.message);
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
        if (key === 'SAGE_TOOL') { // the file that the preflight runs, and the plugin folder
          assert.equal(policy.sageTool, path);
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

/** Makes `path` in the given form: a folder of the user (0700), a link, a file, or a folder that the group or other users can write. */
function make(path, form, root) {
  if (form === 'link') { mkdirSync(join(root, 'elsewhere'), { recursive: true }); symlinkSync(join(root, 'elsewhere'), path); return; }
  if (form === 'file') { writeFileSync(path, ''); return; }
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, { 'other-write': 0o757, 'group-write': 0o770 }[form] ?? 0o700);
}
/** The lead-owned folders below `root`: each with the folders that must be there before it (made as the user's own). */
const placesOf = (root) => {
  const leads = join(root, 'h', '.local', 'share', 'sage-bot', 'leads'), sessions = join(leads, 'sessions'), temps = join(root, 'st', 'sage-lead');
  return {
    leads, sessions, temps,
    'leads folder': [leads, []],
    'sessions folder': [sessions, [leads]],
    'session folder': [join(sessions, 's1'), [leads, sessions]],
    'other session folder': [join(sessions, 's2'), [leads, sessions]],
    'folder of all temp folders': [temps, []],
    'temp folder': [join(temps, 's1'), [temps]],
    'other temp folder': [join(temps, 's2'), [temps]],
  };
};

for (const row of CORPUS.folders) {
  test(`the ${row.folder}, ${row.make}: ${row.expect} (F-T156-29, F-T156-34)`, () => {
    const root = scratch();
    try {
      const places = placesOf(root);
      const [path, before] = places[row.folder];
      for (const p of [join(root, 'st'), dirname(places.leads)]) mkdirSync(p, { recursive: true });
      for (const p of before) mkdirSync(p, { mode: 0o700 });
      make(path, row.make, root);
      const { config, host } = inputs(root); // the leads folder by default: in the home folder
      host.tempRoot = places.temps;
      if (row.make === 'foreign') host.uid = process.getuid() + 1; // the folder is then another user's
      const what = row.folder.replace(/^other /, '');
      if (row.expect === 'ok') {
        const perUser = join(places.temps, 's1', `claude-${host.uid}`);
        if (Buffer.byteLength(perUser) > CLAUDE_TMP_MAX) { // a scratch temp root is long: every folder rule passed, the length rule refuses last
          assert.throws(() => leadPolicy(config, 's1', host), { message: new RegExp(`^the lead session's per-user temp folder ${perUser} is longer than ${CLAUDE_TMP_MAX} bytes`) });
          return;
        }
        const p = leadPolicy(config, 's1', host);
        assert.deepEqual([p.folder, p.tmp, p.tempRoot], [join(places.sessions, 's1'), join(places.temps, 's1'), places.temps]);
        return;
      }
      assert.throws(() => leadPolicy(config, 's1', host), { message: new RegExp(`^the lead session's ${what} ${path} is ${row.says}[^\\n]*: a session could reach another folder through it\\. Remove it\\. Nothing was started\\.$`) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

/** Each pair row: the folders and the config that put two of {sessions folder, folder of all temp folders, a denied path} in each other. */
const PAIRS = {
  'sessions-link-into-temp-folder': (p) => { mkdirSync(join(p.temps, 's1'), { recursive: true, mode: 0o700 }); mkdirSync(p.leads, { recursive: true, mode: 0o700 }); symlinkSync(join(p.temps, 's1'), p.sessions); return { session: 's2' }; },
  'sessions-in-temp-root': (p) => ({ leads: join(p.temps, 's1', 'l') }),
  'temp-root-in-sessions': (p) => ({ temps: join(p.sessions, 't') }),
  'sessions-equal-temp-root': (p) => ({ temps: p.sessions }),
  'sessions-in-denied': (p) => ({ leads: join(p.state, 'l') }),
  'denied-in-sessions': (p) => ({ statePath: join(p.sessions, 's1', 'state', 'gates.json'), state: join(p.sessions, 's1', 'state') }),
  'temp-root-in-denied': (p) => ({ temps: join(p.state, 'sage-lead') }),
  'denied-in-temp-root': (p) => ({ tmp: join(p.temps, 'x') }),
};
test('every pair row has its maker', () => assert.deepEqual(CORPUS.pairs.map((r) => r.id).sort(), Object.keys(PAIRS).sort()));

for (const row of CORPUS.pairs) {
  test(`the pair ${row.id}: refused (F-T156-31, F-T156-34)`, () => {
    const root = scratch();
    try {
      const base = placesOf(root);
      const p = { ...base, state: join(root, 's', 'state') };
      const o = PAIRS[row.id](p);
      const leads = o.leads ?? p.leads, temps = o.temps ?? p.temps, state = o.state ?? p.state;
      const { config, host } = inputs(root, { ...(o.leads && { leadSessionsPath: leads }), ...(o.statePath && { statePath: o.statePath }), ...(o.tmp && { tmp: o.tmp }) });
      host.tempRoot = temps;
      const says = row.says.replaceAll('{sessions}', join(leads, 'sessions')).replaceAll('{temps}', temps).replaceAll('{state}', state);
      assert.throws(() => leadPolicy(config, o.session ?? 's1', host), (e) => {
        assert.doesNotMatch(e.message, /\n/);
        assert.ok(e.message.startsWith(`${says}`), `${e.message}\nexpected the start: ${says}`);
        return true;
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
