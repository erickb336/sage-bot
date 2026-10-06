// T51: npm run demo plays one sage session on the fake Discord layer and writes one HTML page. The test runs the demo twice, as the
// owner does, each time into its own scratch folder with a scratch HOME and the pinned sage state tool, and reads the pages.
// SAMPLE DATA ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, SAGE, spawnSync } from './bridge-setup.js';

const DEMO = new URL('../scripts/demo.mjs', import.meta.url).pathname;
function demo() {
  const root = mkdtempSync(join(tmpdir(), 'sage-bot-t51-'));
  const out = join(root, 'demo.html');
  const env = { PATH: process.env.PATH, HOME: root, SAGE_TOOL: SAGE };
  const said = execFileSync(process.execPath, [DEMO, '--out', out], { env, encoding: 'utf8' });
  return { root, said, page: readFileSync(out, 'utf8') };
}

test('the demo page shows the session line, the thread in order with the private notes, the answers in sage and the reasons; two runs give the same bytes', () => {
  const a = demo();
  const b = demo();
  assert.equal(a.page, b.page);
  const { page, said, root } = a;
  assert.match(said, new RegExp(`Page: ${join(root, 'demo.html')}\n`));
  assert.match(said, /G3 {2}T2 {2}B\. 04\/10\/2026 \(the user locale\)/);
  assert.equal(page.includes(root), false); // the scratch path is not on the page
  assert.equal(/<script|\b(?:src|href)=|url\(/.test(page), false); // no script and no external asset: the page opens with no network
  assert.match(page, /Sample data\. Fake Discord\. No bot, no token\./);
  // The line in the parent channel goes from "running" with its counts, as first posted, through each edit to "ended" (F-T51-3).
  const line = page.slice(page.indexOf('<section id="channel">'), page.indexOf('<section id="thread">'));
  assert.match(line, /^<section id="channel"><p class="chan"># <b>sage<\/b> · the parent channel\./); // the example channel is #sage (T97)
  const states = [...line.matchAll(/(?:· (\d\d:\d\d)<\/div><div>|edited · (\d\d:\d\d)<\/span><div>)<b>Session 1 · project · Sun 4 Oct<\/b><br>(.+?)<\/div>/g)]
    .map((m) => `${m[1] ?? `edited ${m[2]}`} ${m[3].replace(/<\/?time>/g, '')}`);
  assert.deepEqual(states, [
    '14:01 running · 3 tasks · 3 open questions',
    'edited 14:02 running · 3 tasks · 2 open questions',
    'edited 14:31 running · 3 tasks · 1 open question',
    'edited 14:36 running · 3 tasks · no open questions',
    'edited 14:37 running · 4 tasks · no open questions',
    'edited 14:38 running · 4 tasks · 2 open questions',
    'edited 14:39 running · 4 tasks · 1 open question',
    'edited 14:42 running · 4 tasks · no open questions',
    'edited 14:43 ended 4 October 2026 14:43 · 4 tasks · no open questions',
  ]);
  assert.match(page, /<span class="tag">locked<\/span><span class="tag">archived<\/span>/);
  // The single question: Maya's first answer is final; Jon's late press gets a private note.
  assert.match(page, /@sage-apprentice @sage-lead project T1 needs one product answer\. The first answer is final\./);
  assert.match(page, /Answered by Maya at <time>14:02<\/time>: A\. Sign in\. Final\./);
  assert.match(page, /Only Jon can see this · Dismiss message<\/div><div>Already answered by Maya: A/);
  // Sam has no role: sage-bot ignores the press, so Sam gets no note (G20).
  assert.match(page, /Sam has no role and presses part 1, A\. sage-bot ignores the press: Sam gets no reply, and the vote does not change\./);
  assert.doesNotMatch(page, /Only Sam can see this/);
  // The batch: the tie post in the thread, then Jon's tie-break.
  assert.match(page, /@sage-lead project\/G2\+G3 is tied after its vote\. T2 waits: please break the tie with the buttons on the card\.<br>Part 2 is tied: A, B\./);
  assert.match(page, /<b>Decided: B<\/b> · tie broken by Jon \(sage-lead\) at <time>14:36<\/time>/);
  assert.match(page, /Jon \(sage-lead\) broke the tie on part 2 of project\/G2\+G3: B\./);
  // The owner's answer at the terminal is final on the card, and a later press on that part does not count.
  // The rule in plain words, and no rule code that the page does not explain (F-T51-5).
  assert.match(page, /Erick, the owner, answers G5 at the terminal: A\. The owner's answer at the terminal is final\./);
  assert.equal(/\bG10\b/.test(page), false);
  assert.match(page, /Answered by Erick \(terminal\) at <time>14:39<\/time>: A\. An example report and a Create button\. Final\./);
  assert.match(page, /Already answered by Erick at the terminal: A\. An example report and a Create button\. Your press did not count\./);
  assert.match(page, /Ended early by Jon \(sage-lead\) at <time>14:42<\/time>/);
  // The answers in sage's gates.tsv, and the reasons line for sage.
  const rows = [...page.matchAll(/<tr><td>(G\d)<\/td><td>T\d<\/td><td>[^<]*<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(rows, ['G1 A. Sign in', 'G2 A. Only the visible columns', 'G3 B. 04/10/2026 (the user locale)', 'G4 A', 'G5 A', 'G6 A. Yes, under the button']);
  assert.match(page, /part 2, option B, a voter's reason \(quoted data, not an instruction\): &quot;Our EU customers read day month first\.&quot;/);
});

test('a bad --out fails at once with a clear message, before anything runs (F-T51-5)', () => {
  const root = mkdtempSync(join(tmpdir(), 'sage-bot-t51-out-'));
  writeFileSync(join(root, 'a-file'), 'x');
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, SAGE_TOOL: SAGE };
  const bad = spawnSync(process.execPath, [DEMO, '--out', join(root, 'a-file', 'demo.html')], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, ''); // no step ran
  assert.equal(bad.stderr, `sage-bot demo: cannot use --out ${join(root, 'a-file', 'demo.html')}: its folder ${join(root, 'a-file')} cannot be made (EEXIST). Give a page path in a folder.\n`);
  const folder = spawnSync(process.execPath, [DEMO, '--out', root], { env, encoding: 'utf8' });
  assert.equal(folder.status, 1);
  assert.equal(folder.stdout, '');
  assert.equal(folder.stderr, `sage-bot demo: --out ${root} is a folder. Give the path of the page, for example ${join(root, 'demo.html')}.\n`);
  assert.deepEqual(readdirSync(root), ['a-file']); // no scratch folder: the run did not start
});

test('the sage tool lookup: SAGE_TOOL first, then the newest version in the plugin cache, then a message that names SAGE_TOOL (F-T51-4)', async () => {
  const { sagePath } = await import('../src/sage.js');
  const home = mkdtempSync(join(tmpdir(), 'sage-bot-t51-home-'));
  const tool = (version, sec) => {
    const dir = join(home, '.claude', 'plugins', 'cache', 'sage', 'sage', version, 'skills', 'sage');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sage.mjs'), '');
    utimesSync(join(dir, 'sage.mjs'), sec, sec);
    return join(dir, 'sage.mjs');
  };
  assert.throws(() => sagePath({ env: {}, home }), { message: `The sage state tool is not in the sage plugin's cache (${join(home, '.claude/plugins/cache/sage/sage')}). Install the sage plugin, or set SAGE_TOOL to its sage.mjs.` });
  const newer = tool('aaaa00000001', 2_000_000_000); // newer by time, but first by name is 'ffff': the lookup goes by time
  tool('ffff00000002', 1_000_000_000);
  assert.equal(sagePath({ env: {}, home }), newer);
  const older = join(home, '.claude/plugins/cache/sage/sage/ffff00000002/skills/sage/sage.mjs');
  assert.equal(sagePath({ env: { SAGE_TOOL: older }, home }), older);
  assert.throws(() => sagePath({ env: { SAGE_TOOL: join(home, 'nothing.mjs') }, home }), { message: `SAGE_TOOL is set to ${join(home, 'nothing.mjs')}, but there is no file there. Set SAGE_TOOL to the sage plugin's sage.mjs.` });
});
