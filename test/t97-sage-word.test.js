// T97: one word for the session that runs the work. People read "sage", never "chief" (the owner's request).
// The check reads every text file of the repository (tracked, or new and not ignored): any form of the word, also "chiefs",
// "forChief" or "chief_of_staff", fails it. Only binary files (with a NUL byte), this check, which names the word, and the pinned
// copies of the sage state tool (test/fixtures/sage/<version>/sage.mjs, sage's own text, kept byte for byte, T162) are left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'test/t97-sage-word.test.js';
const WORD = /chief/i;
const PINNED = /^test\/fixtures\/sage\/[^/]+\/sage\.mjs$/;

/** Each line of a text file of the repository at `root` that holds the word, as "path:line: text". */
function chiefLines(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((f) => f && f !== SELF && !PINNED.test(f));
  return [...new Set(files)].flatMap((f) => {
    const bytes = readFileSync(join(root, f));
    if (bytes.includes(0)) return [];
    return bytes.toString('utf8').split('\n').flatMap((line, i) => (WORD.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 120)}`] : []));
  });
}

test('T97: no text of the repository says "chief"; sage-bot says "sage" for the session that runs the work', () => {
  assert.deepEqual(chiefLines(ROOT), []);
});

test('T97: the check finds every form of the word in every text file, and skips only binary files, itself and the pinned sage tool', () => {
  const root = mkdtempSync(join(tmpdir(), 'sage-bot-t97-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const files = {
    'a.md': 'Ask the chiefs.\n',
    'b.js': 'const forChief = 1;\n',
    'c.mjs': 'const chief_of_staff = 2;\n',
    'package.json': '{ "description": "The Chief bridge" }\n',
    'd.css': '.card { content: "chief"; }\n',
    'e.png': Buffer.from('\x89PNG\0chief'),
    [SELF]: 'const WORD = /chief/i;\n',
    'clean.md': 'sage asks; sage-bot posts.\n',
    'test/fixtures/sage/0123abcd/sage.mjs': '// The chief of staff calls it.\n',
    'test/fixtures/sage/README.md': 'The chief of staff.\n',
    'test/fixtures/sage/0123abcd/other.mjs': '// chief\n',
  };
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  assert.deepEqual(chiefLines(root).sort(), [
    'a.md:1: Ask the chiefs.',
    'b.js:1: const forChief = 1;',
    'c.mjs:1: const chief_of_staff = 2;',
    'd.css:1: .card { content: "chief"; }',
    'package.json:1: { "description": "The Chief bridge" }',
    'test/fixtures/sage/0123abcd/other.mjs:1: // chief',
    'test/fixtures/sage/README.md:1: The chief of staff.',
  ]);
});
