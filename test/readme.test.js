// T52: every shell command of the README and the reference runs, and every relative link points to a file that exists.
// Each ```sh block carries a mark on the line before it:
//   <!-- check: run -->                      each line runs and exits 0
//   <!-- check: run, exit 1, prints "…" -->  each line exits 1; the block's output holds each "…"
//   <!-- check: skip, <reason> -->           the block needs Discord, the Keychain or launchctl, or runs this test itself
// The commands run with HOME and TMPDIR in a new scratch folder (one per document), with a filled-in sample config in
// ~/.config/sage-bot/config.json. SAMPLE DATA ONLY. Nothing connects to Discord, reads the Keychain or runs launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = ['README.md', 'docs/reference.md'];
// Lines of a runnable block that the test does not run itself, with the reason.
const NOT_HERE = { 'npm ci': 'the test runs inside the installed tree: npm ci would remove node_modules under it; the check runs after npm ci' };

/** The ```sh blocks of a document, each with its mark: { line, mark, commands }. */
function shellBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```sh') continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === '```');
    const before = lines.slice(0, i).reverse().find((l) => l.trim() !== '')?.trim() ?? '';
    const mark = /^<!-- check: (run|skip)(?:, (.+))? -->$/.exec(before);
    const commands = lines.slice(i + 1, end).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    blocks.push({ line: i + 1, mark, commands });
    i = end;
  }
  return blocks;
}

/** A scratch home folder like an owner's after setup step 3: a filled-in config with sample ids. */
function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), 'sage-bot-readme-'));
  const config = JSON.parse(readFileSync(join(ROOT, 'examples/config.example.json'), 'utf8'));
  Object.assign(config, { project: join(home, 'project'), sagePath: join(home, 'sage.mjs'), statePath: join(home, 'state', 'gates.json') });
  mkdirSync(join(home, '.config', 'sage-bot'), { recursive: true });
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(home, 'tmp'));
  writeFileSync(join(home, '.config', 'sage-bot', 'config.json'), JSON.stringify(config));
  return home;
}

for (const doc of DOCS) {
  test(`${doc}: every shell block has a check mark, and each runnable command runs`, (t) => {
    const blocks = shellBlocks(readFileSync(join(ROOT, doc), 'utf8'));
    assert.ok(blocks.length > 0, `${doc} has no sh block`);
    const home = scratchHome();
    try {
      for (const { line, mark, commands } of blocks) {
        assert.ok(mark, `${doc}:${line}: the sh block has no <!-- check: run --> or <!-- check: skip, <reason> --> on the line before it`);
        const [, kind, rest = ''] = mark;
        if (kind === 'skip') {
          assert.ok(rest.trim(), `${doc}:${line}: a skipped block needs its reason`);
          for (const c of commands) t.diagnostic(`skipped: ${c} (${rest})`);
          continue;
        }
        const exit = Number(/exit (\d+)/.exec(rest)?.[1] ?? 0);
        const prints = [...rest.matchAll(/prints "([^"]+)"/g)].map((m) => m[1]);
        let output = '';
        for (const command of commands) {
          if (NOT_HERE[command]) { t.diagnostic(`skipped: ${command} (${NOT_HERE[command]})`); continue; }
          assert.doesNotMatch(command, /<[a-z][a-z ]*>/, `${doc}:${line}: a runnable command holds a placeholder: ${command}`);
          const run = command === 'npm run demo' ? `npm run demo -- --out ${join(home, 'demo.html')}` : command;
          const r = spawnSync('/bin/sh', ['-c', run], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOME: home, TMPDIR: join(home, 'tmp') } });
          assert.equal(r.status, exit, `${doc}:${line}: ${run} exited ${r.status}, not ${exit}\n${r.stdout}\n${r.stderr}`);
          output += r.stdout + r.stderr;
          t.diagnostic(`ran: ${run} (exit ${r.status})`);
        }
        for (const p of prints) assert.ok(output.includes(p), `${doc}:${line}: the output does not hold "${p}":\n${output}`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${doc}: every relative link points to a file that exists, and every anchor to a heading`, () => {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)|(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    assert.ok(targets.length > 0);
    for (const target of targets) {
      if (/^(https?|mailto):/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const file = path ? join(ROOT, dirname(doc), path) : join(ROOT, doc);
      assert.ok(existsSync(file), `${doc}: the link ${target} points to ${file}, which does not exist`);
      if (anchor) assert.ok(anchorsOf(readFileSync(file, 'utf8')).has(anchor), `${doc}: the link ${target} names no heading of ${path || doc}`);
    }
  });
}

test('README.md: each diagram is an image with alt text, its file exists and matches docs/diagrams.mjs, and no Mermaid block is left', async () => {
  const text = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(text, /```mermaid/, 'GitHub draws a Mermaid block too small to read: use an SVG file in docs/');
  const images = [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ alt: m[1], src: m[2] }));
  assert.deepEqual(images.map((i) => i.src), ['docs/flow.svg', 'docs/states.svg', 'docs/threads.svg']);
  const { DIAGRAMS } = await import('../docs/diagrams.mjs');
  for (const { alt, src } of images) {
    assert.ok(alt.length > 80, `${src}: the alt text must describe the diagram`);
    assert.ok(existsSync(join(ROOT, src)), `${src} does not exist`);
    const name = src.replace('docs/', '');
    assert.equal(readFileSync(join(ROOT, src), 'utf8'), DIAGRAMS[name], `${src} differs from docs/diagrams.mjs: run node docs/diagrams.mjs`);
  }
});

/** GitHub's anchors of a Markdown file's headings (outside code blocks): lower case, punctuation gone, spaces to hyphens. */
function anchorsOf(text) {
  const out = new Set();
  let code = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) code = !code;
    const h = !code && /^#{1,6} (.+)$/.exec(line);
    if (h) out.add(h[1].toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-'));
  }
  return out;
}

test('the mark parser finds an unmarked block and reads a skip reason (the parser itself)', () => {
  const [unmarked, skipped] = shellBlocks('text\n\n```sh\nls\n```\n<!-- check: skip, needs Discord -->\n```sh\nnode a.mjs\n# a comment\n```\n');
  assert.equal(unmarked.mark, null);
  assert.deepEqual([skipped.mark[1], skipped.mark[2], skipped.commands], ['skip', 'needs Discord', ['node a.mjs']]);
  assert.deepEqual([...anchorsOf('# A b\n```\n# not\n```\n## FAQ: what? · now\n')], ['a-b', 'faq-what--now']);
});

