// T145 round 1 (F-T145-6, F-T145-7, standing order 15): sage-bot names a folder's logbook by one resolver, logbookOf in
// src/projects.js, a port of projectRoot in the pinned sage state tool. This test runs both over the same real git layouts in a scratch
// folder and asserts that they agree, and that each layout gets the logbook that the state tool gives it, so a drift fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logbookOf } from '../src/projects.js';
import { execFileSync, FIXTURE } from './bridge-setup.js';
import { tempFolder } from './temp-folder.js';

const { projectRoot } = await import(pathToFileURL(FIXTURE).href); // the pinned state tool's own resolver, unchanged

const git = (...args) => execFileSync('git', ['-c', 'user.name=Sample', '-c', 'user.email=sample@example.com', '-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', ...args], { stdio: 'ignore' });

/** The git layouts of the brief, each folder with the logbook that the state tool gives it (relative to the scratch root). */
function layouts() {
  const root = realpathSync.native(tempFolder('sage-bot-logbook-'));
  const at = (...parts) => join(root, ...parts);
  const repo = (path) => { git('init', '-q', path); git('-C', path, 'commit', '-q', '--allow-empty', '-m', 'sample'); };
  // A repository, its subfolder, and its linked worktrees inside and outside its folder.
  repo(at('mono'));
  mkdirSync(at('mono', 'app'));
  git('-C', at('mono'), 'worktree', 'add', '-q', at('mono', '.claude', 'worktrees', 'w'), '-b', 'w');
  git('-C', at('mono'), 'worktree', 'add', '-q', at('mono-out'), '-b', 'out');
  // Two separate repositories, and folders outside git.
  repo(at('alpha'));
  repo(at('beta'));
  mkdirSync(at('plain', 'sub'), { recursive: true });
  // A superproject with two submodules.
  repo(at('lib1'));
  repo(at('lib2'));
  repo(at('super'));
  git('-C', at('super'), 'submodule', 'add', '-q', at('lib1'), 'one');
  git('-C', at('super'), 'submodule', 'add', '-q', at('lib2'), 'two');
  mkdirSync(at('super', 'one', 'deep'));
  // Two repositories whose git folders (--separate-git-dir) sit in one folder.
  mkdirSync(at('gits'));
  git('init', '-q', '--separate-git-dir', at('gits', 'x.git'), at('sx'));
  git('init', '-q', '--separate-git-dir', at('gits', 'y.git'), at('sy'));
  // A bare repository in a folder of its own, with two linked worktrees.
  mkdirSync(at('bares'));
  git('clone', '-q', '--bare', at('alpha'), at('bares', 'b.git'));
  git('-C', at('bares', 'b.git'), 'worktree', 'add', '-q', at('bw1'), '-b', 'bw1');
  git('-C', at('bares', 'b.git'), 'worktree', 'add', '-q', at('bw2'), '-b', 'bw2');
  const expect = {
    mono: 'mono', 'mono/app': 'mono', 'mono/.claude/worktrees/w': 'mono', 'mono-out': 'mono',
    alpha: 'alpha', beta: 'beta', plain: 'plain', 'plain/sub': 'plain/sub',
    super: 'super', 'super/one': 'super/one', 'super/two': 'super/two', 'super/one/deep': 'super/one/deep',
    sx: 'sx', sy: 'sy', bares: 'bares', 'bares/b.git': 'bares/b.git', bw1: 'bares', bw2: 'bares',
  };
  return { root, expect };
}

test('F-T145-6, F-T145-7: logbookOf and the pinned state tool\'s projectRoot name the same logbook for every git layout', () => {
  const { root, expect } = layouts();
  const ours = {};
  for (const folder of Object.keys(expect)) {
    const path = join(root, folder);
    assert.equal(logbookOf(path), projectRoot(path), `the two resolvers differ for ${folder}`);
    ours[folder] = relative(root, logbookOf(path)) || '.';
  }
  assert.deepEqual(ours, expect);
});
