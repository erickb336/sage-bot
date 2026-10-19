// T232 round 2: what the records keep of a person's roles (F-T232-13), and the one owner check (F-T232-12).
// SAMPLE DATA ONLY: every id, name and text is made up. Nothing connects to Discord or reads the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAsk } from '../src/ask.js';
import { auditPathOf, openLog, verifyLog } from '../src/audit.js';
import { openChannels, withHome } from '../src/channels.js';
import { CREW, isOwner, keptRoles, placeOf } from '../src/crew.js';
import { fakeDiscord, fakeMention } from '../src/fake-discord.js';
import { loadProjects } from '../src/projects.js';
import { writeWhole } from '../src/state.js';
import { threadsPathOf } from '../src/threads.js';
import { openGate, step } from '../src/vote.js';
import { CONFIG, JON, MAYA, OWNER, SAGE, setup, T0 } from './bridge-setup.js';

const ASK = '400000000000000009';
const THREAD = '400000000000000077';
// Role names that a server admin can make: a right-to-left override, zero-width characters, and a private group's name.
const RLO = 'mods‮evil';
const ZW = 'sage​crew';
const PRIVATE = 'Therapy group';
const HIDDEN = /[‮​]|Therapy/;

function world(t) {
  const b = setup({ markAll: false });
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  b.env = { PATH: process.env.PATH, HOME: join(b.root, 'home'), SAGE_HOME: join(b.root, 'home', 'sage') };
  b.config = { ...CONFIG, askChannelId: ASK, project: b.project, sagePath: SAGE, statePath: b.statePath };
  b.place = fakeDiscord([]);
  b.start = () => {
    const channels = openChannels(b.config, loadProjects(b.config));
    b.ask = createAsk({ config: withHome(b.config, channels), channels, env: b.env, now: () => T0, log: () => {}, audit: async () => {} });
  };
  b.start();
  b.say = (user, roles, content, at = {}) => b.ask.mention(fakeMention({ user, roles, content, place: b.place, channelId: ASK, ...at }));
  b.log = () => verifyLog(auditPathOf(b.config));
  b.raw = () => readFileSync(auditPathOf(b.config), 'utf8');
  return b;
}

test('F-T232-12: isOwner is the one owner check; placeOf and the vote rules give the same answer through it', () => {
  assert.equal(isOwner(OWNER, OWNER), true);
  assert.equal(isOwner(MAYA, OWNER), false);
  assert.equal(isOwner(undefined, undefined), false); // no owner resolved: nobody is the owner
  assert.deepEqual(placeOf(OWNER, [], OWNER), { owner: true, crew: false });
  const gate = openGate({ id: 'G1', kind: 'batch', parts: [['A', 'B']], askedBy: OWNER, at: T0 });
  const end = (by) => step(gate, { type: 'end', by, at: T0 + 1, via: 'discord' }, [MAYA], OWNER).gate.phase;
  assert.equal(gate.phase, 'voting');
  assert.equal(end(MAYA), 'voting'); // a crew member cannot end the vote
  assert.notEqual(end(OWNER), 'voting'); // the owner can, with no role
});

test('F-T232-13: keptRoles keeps only the crew name, and never any other text of Discord', () => {
  assert.deepEqual(keptRoles(placeOf(MAYA, [CREW, RLO, ZW, PRIVATE], OWNER)), [CREW]);
  assert.deepEqual(keptRoles(placeOf(OWNER, [RLO, ZW, PRIVATE], OWNER)), []);
});

test('F-T232-13: the audit log keeps only the crew name: no role name with a bidi or zero-width character, and no unrelated role name', async (t) => {
  const b = world(t);
  await b.say(OWNER, [CREW, RLO, ZW, PRIVATE], '<@1> talk: the login');
  await b.say(OWNER, [RLO, ZW, PRIVATE], '<@1> talk: the board');
  const { lines, broken } = b.log();
  assert.equal(broken, null);
  assert.deepEqual(lines.map((x) => [x.author, x.roles, x.outcome]), [[OWNER, [CREW], 'dry-run'], [OWNER, [], 'dry-run']]);
  assert.doesNotMatch(b.raw(), HIDDEN);
});

test('F-T232-13: a held crew mention keeps only the crew name in the thread map, and its log line has only that name', async (t) => {
  const b = world(t);
  await b.say(MAYA, [CREW, RLO, PRIVATE], '<@1> show the board');
  const [thread] = [...b.place.threads.keys()];
  const at = { channelId: thread, parentId: ASK };
  await b.say(MAYA, [CREW, ZW, PRIVATE], '<@1> the login breaks', at);
  const map = readFileSync(threadsPathOf(b.config), 'utf8');
  assert.deepEqual(JSON.parse(map).threads[thread].held.map((h) => h.roles), [[CREW], [CREW]]);
  assert.doesNotMatch(map, HIDDEN);
  b.start(); // the saved form loads again
  await b.say(OWNER, [], '<@1> talk: fix the login', at);
  assert.deepEqual(b.log().lines.map((x) => [x.author, x.roles, x.outcome]), [[MAYA, [CREW], 'earlier'], [MAYA, [CREW], 'earlier'], [OWNER, [], 'dry-run']]);
  assert.doesNotMatch(b.raw(), HIDDEN);
});

test('F-T232-13: an audit log and a thread map from before this change still load; their old role names never reach a new line', async (t) => {
  const b = world(t);
  // An old log line with role ids (before T232) and one with raw role names (T232 before round 2).
  const old = openLog(auditPathOf(b.config), loadProjects(b.config));
  for (const roles of [['300000000000000099'], [CREW, RLO]]) {
    old.append({ at: new Date(T0).toISOString(), message: `5000000000000000${roles.length}0`, author: MAYA, roles, textSha256: '0'.repeat(64), text: 'old', thread: null, project: 'project', outcome: 'dry-run' });
  }
  // An old thread map: held mentions with role ids, and with raw role names.
  writeWhole(threadsPathOf(b.config), `${JSON.stringify({ version: 1, threads: { [THREAD]: { kind: 'answer', channel: ASK, project: 'project', by: MAYA, at: T0, held: [
    { id: '500000000000000031', user: JON, roles: ['300000000000000099'], content: '<@1> ids' },
    { id: '500000000000000032', user: MAYA, roles: [CREW, RLO, PRIVATE], content: '<@1> names' },
  ] } } })}\n`);
  b.start();
  await b.say(OWNER, [], '<@1> talk: go', { channelId: THREAD, parentId: ASK });
  const { lines, broken } = b.log();
  assert.equal(broken, null);
  assert.deepEqual(lines.map((x) => [x.author, x.roles, x.outcome]), [
    [MAYA, ['300000000000000099'], 'dry-run'], [MAYA, [CREW, RLO], 'dry-run'], // the old lines, as they were
    [JON, [], 'earlier'], [MAYA, [CREW], 'earlier'], [OWNER, [], 'dry-run'],
  ]);
  assert.doesNotMatch(b.raw().split('\n').slice(2).join('\n'), HIDDEN);
});
