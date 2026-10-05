// T70: two roles, sage-apprentice and sage-lead; sage-driver is gone. Holders are the members with either role, leads the
// members with sage-lead. A new card pings both roles; a tie pings only the leads. An old config with driverRole stops.
// SAMPLE DATA ONLY: every id and name is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { fakeDiscord } from '../src/fake-discord.js';
import { peopleOf } from '../src/handle.js';
import { MINUTE } from '../src/vote.js';
import { CHANNEL, JON, MAYA, MEMBERS, OWNER, setup } from './bridge-setup.js';

const [APPRENTICE, LEAD] = ['300000000000000001', '300000000000000002'];
const OLD_CONFIG = 'the config has driverRole: sage-driver is gone. Rename driverRole to apprenticeRole and give that role id to the sage-apprentice role.';
const ROOT = new URL('..', import.meta.url).pathname;

test('peopleOf: an apprentice is a holder, a lead with only the lead role is a holder and a lead, a member with both is a lead, a member with neither counts for nothing', () => {
  const p = peopleOf([
    { id: 'maya', name: 'Maya', roles: ['app'] },
    { id: 'jon', name: 'Jon', roles: ['ld'] },
    { id: 'erick', name: 'Erick', roles: ['app', 'ld'] },
    { id: 'sam', name: 'Sam', roles: ['other'] },
  ], { apprenticeRole: 'app', leadRole: 'ld' });
  assert.deepEqual([...p.holders].sort(), ['erick', 'jon', 'maya']);
  assert.deepEqual([...p.leads].sort(), ['erick', 'jon']);
});

test('the bridge logs one line that names each member with both roles, and no line when nobody has both', async () => {
  const both = setup({ members: MEMBERS.map((m) => (m.id === OWNER ? { ...m, roles: [APPRENTICE, LEAD] } : m)) });
  await both.bridge.loop();
  await both.bridge.loop();
  assert.deepEqual(both.lines.filter((l) => l.includes('both')),
    [`these members have both sage-apprentice and sage-lead, so each counts as a sage-lead: Erick (${OWNER}). Give each person one of the two roles.`]);
  const one = setup();
  await one.bridge.loop();
  assert.deepEqual(one.lines.filter((l) => l.includes('both')), []);
});

test('a new card pings sage-apprentice and sage-lead; a tie after the vote pings only sage-lead', async () => {
  const b = setup();
  b.sh('gate', 'add', 'T7', '--question', 'Which columns?', '--options', 'Visible only|All fields', '--recommend', 'Visible only');
  b.sh('gate', 'add', 'T7', '--question', 'Which date format?', '--options', 'ISO|Locale', '--recommend', 'ISO');
  await b.post();
  const pings = () => b.discord.posts.filter((p) => p.content).map((p) => [p.content, p.allowedMentions.roles]);
  assert.deepEqual(pings(), [[`<@&${APPRENTICE}> <@&${LEAD}> T7 has 2 product questions. Vote on each part within 30 minutes.`, [APPRENTICE, LEAD]]]);
  await b.press(MAYA, 'press:G1+G2:0:0');
  await b.press(JON, 'press:G1+G2:0:1');
  b.now += 30 * MINUTE;
  await b.bridge.loop();
  assert.deepEqual(pings().at(-1), [`<@&${LEAD}> G1+G2 is tied after its vote. T7 waits: please break the tie with the buttons on the card.\nPart 1 is tied: A, B. Nobody gave a reason.\nPart 2 is tied: A, B. Nobody gave a reason.`, [LEAD]]);
});

test('a config with driverRole and no apprenticeRole stops the bridge with the rename message', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-bot-t70-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { channelId: CHANNEL, ownerId: OWNER, driverRole: APPRENTICE, leadRole: LEAD };
  assert.throws(() => createBridge({ sage: {}, discord: fakeDiscord([]), config, statePath: join(dir, 'gates.json'), log: () => {} }), { message: OLD_CONFIG });
});

test('launchd.mjs refuses a config with driverRole and no apprenticeRole with the same message, and writes no plist', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sage-bot-t70-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { apprenticeRole, ...rest } = JSON.parse(readFileSync(join(ROOT, 'examples/config.example.json'), 'utf8'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ ...rest, driverRole: apprenticeRole ?? APPRENTICE }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/launchd.mjs'), path], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `sage-bot launchd: ${OLD_CONFIG} No plist printed.\n`);
});
