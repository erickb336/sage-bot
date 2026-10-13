// T145 round 2 (R905): F-T145-10, a gate add from a session whose cwd is a link to a project outside git, and F-T145-9, a listed link to a
// submodule. SAMPLE DATA ONLY: scratch folders and logbooks, made-up ids. HOME and SAGE_HOME are in a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects } from '../src/projects.js';
import { record } from '../src/sessions.js';
import { execFileSync, SAGE, setup } from './bridge-setup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const S1 = 'eeeeeeee-0000-4000-8000-000000000905';
const git = (...args) => execFileSync('git', ['-c', 'user.name=Sample', '-c', 'user.email=sample@example.com', '-c', 'protocol.file.allow=always', ...args], { stdio: 'ignore' });
const gateAdd = (command, id) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: `${id} open · Q?\n`, stderr: '' } });

test('F-T145-10: a gate add from a cwd that is a link to a project outside git counts, with no --project and with a relative one, as sage writes it in that logbook', () => {
  const b = setup({ markAll: false });
  const plain = join(b.root, 'plain'); // a project folder outside git: its logbook is the folder itself
  mkdirSync(join(plain, 'sub'), { recursive: true });
  const link = join(b.root, 'plain-link');
  symlinkSync(plain, link);
  const dir = `${b.statePath}.sessions`;
  const projects = loadProjects({ project: plain, sagePath: SAGE, projects: [{ name: 'plain', project: plain }] });
  const at = (cwd, extra) => record({ session_id: S1, cwd, ...extra }, { projects, dir, pid: process.pid, now: b.now, home: b.root });
  assert.equal(at(link, { hook_event_name: 'SessionStart' }), `SessionStart ${S1}`);
  // sage runs in the real folder (its process.cwd()), so it writes each of these gates in the logbook of `plain`.
  assert.equal(at(link, gateAdd('node sage.mjs gate add T1', 'G1')), `PostToolUse ${S1}`);
  assert.equal(at(join(link, 'sub'), gateAdd('node sage.mjs gate add T1 --project ..', 'G2')), `PostToolUse ${S1}`);
  // The subfolder of a folder outside git has a logbook of its own, also through the link.
  assert.equal(at(join(link, 'sub'), gateAdd('node sage.mjs gate add T1', 'G3')), 'another project');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${S1}.json`), 'utf8')).gates, ['G1', 'G2']);
});

test('F-T145-9: a listed link to a submodule is refused at load, as sage keeps its logbook by the path as written; its real folder loads', () => {
  const b = setup({ markAll: false });
  const lib = join(b.root, 'lib');
  const sup = join(b.root, 'super');
  for (const repo of [lib, sup]) { git('init', '-q', repo); git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'sample'); }
  git('-C', sup, 'submodule', 'add', '-q', lib, 'one');
  const real = join(sup, 'one');
  const link = join(b.root, 'one-link');
  symlinkSync(real, link);
  const config = (path) => ({ project: b.project, sagePath: SAGE, projects: [{ name: 'project', project: b.project }, { name: 'one', project: path }] });
  assert.throws(() => loadProjects(config(link)), { message: `the path of project one (${link}) is a link to ${real}, and the folder is not a checkout of git, so the sage state tool keeps its logbook by the path as written. Write the real path in projects. Nothing changed.` });
  assert.deepEqual(loadProjects(config(real)).map((p) => p.project), [b.project, real]);
});

test('F-T145-9: the reference names the refusal of a link to a submodule, a --separate-git-dir repository or a bare repository, and its fix', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'reference.md'), 'utf8');
  assert.match(doc, /a link to a submodule, a repository with a `--separate-git-dir` or a bare repository is refused with the same line\. List the real folder, not the link \(F-T145-9\)\./);
});
