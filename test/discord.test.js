// The Discord side of the bridge with no connection: the member contract, the Keychain token, the launchd plist, the
// error log and the notes. SAMPLE DATA ONLY: no real token, no network, no launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { memberOf, readToken } from '../src/discord.js';
import { plist } from '../src/launchd.js';
import { apiError, createBridge, frame } from '../src/bridge.js';
import { fakeDiscord, fakeInteraction } from '../src/fake-discord.js';
import { peopleOf } from '../src/handle.js';
import { save } from '../src/state.js';
import { openGate, step } from '../src/vote.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'sage-bot-discord-'));
const [OWNER, MAYA, DRIVER, LEADR] = ['100000000000000001', '100000000000000002', '300000000000000001', '300000000000000002'];
const CONFIG = { ownerId: OWNER, driverRole: DRIVER, leadRole: LEADR };

test('F-T28-20: memberOf maps a real discord.js GuildMember (no login) to { id, name, roles, bot }, which peopleOf reads', () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  try {
    const guild = client.guilds._add({ id: '200000000000000001', name: 'sample', members: [], roles: [
      { id: '200000000000000001', name: '@everyone', permissions: '0', position: 0 },
      { id: DRIVER, name: 'sage-driver', permissions: '0', position: 1 }, { id: LEADR, name: 'sage-lead', permissions: '0', position: 2 }] });
    const joined = new Date(0).toISOString();
    const maya = guild.members._add({ user: { id: MAYA, username: 'maya', global_name: 'Maya G', bot: false }, nick: 'Maya', roles: [DRIVER], joined_at: joined });
    const bot = guild.members._add({ user: { id: '100000000000000005', username: 'bridge', bot: true }, roles: [DRIVER, LEADR], joined_at: joined });
    assert.deepEqual(memberOf(maya), { id: MAYA, name: 'Maya', roles: ['200000000000000001', DRIVER], bot: false });
    assert.deepEqual(memberOf(bot), { id: '100000000000000005', name: 'bridge', roles: ['200000000000000001', DRIVER, LEADR], bot: true });
    const people = peopleOf([maya, bot].map(memberOf), { driverRole: DRIVER, leadRole: LEADR });
    assert.deepEqual([[...people.holders], [...people.leads]], [[MAYA], []]);
  } finally {
    client.destroy();
  }
});

test('the token comes from the Keychain item "sage-bot"; a missing item stops with a clear message that holds no output', async () => {
  const dir = scratch();
  const tool = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o700);
    return path;
  };
  const ok = tool('security-ok', '[ "$1 $2 $3 $4" = "find-generic-password -s sage-bot -w" ] && echo sample-not-a-token');
  assert.equal(await readToken(ok), 'sample-not-a-token');
  const missing = tool('security-missing', 'echo "security: SecKeychainSearchCopyNext: sample-secret-output" >&2; exit 44');
  await assert.rejects(readToken(missing), (e) => {
    assert.equal(e.message, 'no bot token: the macOS Keychain has no generic password with the service "sage-bot". Add it with Keychain Access, then start the bridge again.');
    assert.equal(e.cause, undefined);
    return true;
  });
});

test('the launchd plist is text with the absolute paths, KeepAlive and RunAtLoad, and no token; a relative path is refused', () => {
  const text = plist({ node: '/opt/node/bin/node', script: '/Users/sample/sage-bot/scripts/bridge.mjs', config: '/Users/sample/.config/sage-bot/config & co.json', logDir: '/Users/sample/Library/Logs' });
  assert.match(text, /<key>Label<\/key>\n  <string>com\.sage\.bot<\/string>/);
  assert.match(text, /<array>\n    <string>\/opt\/node\/bin\/node<\/string>\n    <string>\/Users\/sample\/sage-bot\/scripts\/bridge\.mjs<\/string>\n    <string>\/Users\/sample\/\.config\/sage-bot\/config &amp; co\.json<\/string>\n  <\/array>/);
  assert.match(text, /<key>RunAtLoad<\/key>\n  <true\/>\n  <key>KeepAlive<\/key>\n  <true\/>/);
  assert.match(text, /<string>\/Users\/sample\/Library\/Logs\/sage-bot\.log<\/string>/);
  assert.doesNotMatch(text, /token|EnvironmentVariables/i);
  assert.throws(() => plist({ node: 'node', script: '/s', config: '/c', logDir: '/l' }), /node must be an absolute path/);
  // On macOS, plutil reads it as a valid property list (a read-only check; nothing is loaded).
  if (existsSync('/usr/bin/plutil')) {
    const file = join(scratch(), 'com.sage.bot.plist');
    writeFileSync(file, text);
    assert.match(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' }), /: OK\n$/);
  }
});

test('F-T28-23: a Discord error is logged as its code, status and message only, never its url or body', async () => {
  const error = Object.assign(new Error('Unknown interaction'), { code: 10062, status: 404, url: 'https://discord.com/api/v10/interactions/1/sample-token/callback', requestBody: { json: { secret: 'x' } } });
  assert.equal(apiError(error), 'code 10062, status 404: Unknown interaction');
  const lines = [];
  const dir = scratch();
  const statePath = join(dir, 'gates.json');
  const gate = openGate({ id: 'G1', kind: 'single', options: ['A', 'B'], askedBy: OWNER, at: 1 });
  const ask = { kind: 'single', task: 'T1', title: '', parts: [{ question: 'Q?', why: 'w', recommended: 'A', options: { A: 'a', B: 'b' } }] };
  save(statePath, [{ gate, ask, sage: ['G1'], texts: [['a', 'b']], message: '900000000000000000', remindedAt: 1, sent: {} }]);
  const bridge = createBridge({ sage: { gates: async () => [], answer: async () => '' }, discord: fakeDiscord([{ id: MAYA, name: 'Maya', roles: [DRIVER] }]), config: CONFIG, statePath, now: () => 2, log: (l) => lines.push(l) });
  await bridge.interaction(fakeInteraction({ user: MAYA, customId: 'press:G1:0:0', refuse: error }));
  assert.ok(lines.includes('Discord refused a reply: code 10062, status 404: Unknown interaction'), lines.join('\n'));
  assert.equal(lines.join('\n').includes('sample-token'), false);
});

test('F-T28-21: a throw from handle gets a private note and changes nothing', async () => {
  const dir = scratch();
  const statePath = join(dir, 'gates.json');
  // A batch of 5 parts cannot be a card (5 rows of options and one more for "End vote now"): the reason form's card throws.
  const gate = openGate({ id: 'B1', kind: 'batch', parts: Array.from({ length: 5 }, () => ['A', 'B']), askedBy: OWNER, at: 1 });
  const ask = { kind: 'batch', task: 'T1', title: '', parts: Array.from({ length: 5 }, () => ({ question: 'Q?', why: 'w', recommended: 'A', options: { A: 'a', B: 'b' } })) };
  save(statePath, [{ gate, ask, sage: ['G1', 'G2', 'G3', 'G4', 'G5'], texts: Array.from({ length: 5 }, () => ['a', 'b']), message: null, remindedAt: 1, sent: {} }]);
  const lines = [];
  const bridge = createBridge({ sage: { gates: async () => [] }, discord: fakeDiscord([{ id: MAYA, name: 'Maya', roles: [DRIVER] }]), config: CONFIG, statePath, now: () => 2, log: (l) => lines.push(l) });
  const i = fakeInteraction({ user: MAYA, customId: 'reason:B1:0:0', fields: { reason: 'r' } });
  await bridge.interaction(i);
  assert.deepEqual(i.replies, [{ kind: 'reply', content: 'The bridge could not handle this press. Nothing changed. Please tell the owner.', flags: 64, allowedMentions: { parse: [] } }]);
  assert.deepEqual(bridge.entry('B1').gate, gate);
  assert.deepEqual(lines, ['the bridge could not handle a press: card: Discord allows 5 rows of buttons on one message']);
});

test('F-T28-21: a long display name is made safe, then cut to 32 characters, in the message that names the lead', async () => {
  const statePath = join(scratch(), 'gates.json');
  const long = `*${'Jonathan'.repeat(40)}`;
  const people = [{ id: OWNER, name: long, roles: [DRIVER, LEADR] }];
  const tied = step(openGate({ id: 'B1', kind: 'batch', parts: [['A', 'B']], askedBy: OWNER, at: 1 }), { type: 'tick', at: 1 + 30 * 60_000 }, [OWNER], []).gate;
  const ask = { kind: 'batch', task: 'T1', title: '', parts: [{ question: 'Q?', why: 'w', recommended: 'A', options: { A: 'a', B: 'b' } }] };
  save(statePath, [{ gate: tied, ask, sage: ['G1'], texts: [['a', 'b']], message: '900000000000000000', remindedAt: 1, sent: {} }]);
  const discord = fakeDiscord(people);
  const bridge = createBridge({ sage: { gates: async () => [], answer: async () => '' }, discord, config: CONFIG, statePath, now: () => 2 * 60 * 60_000, log: () => {} });
  await bridge.interaction(fakeInteraction({ user: OWNER, customId: 'tiebreak:B1:0:1' }));
  assert.equal(discord.posts[0].content, `\\*${'Jonathan'.repeat(4).slice(0, 29)}… (sage-lead) broke the tie on part 1 of B1: B.`);
});

test('F-T28-24: the texts of a sage gate are cut before safe: a 100,000-character question and label stay short on the card', () => {
  const row = { id: 'G1', task: 'T1', question: `**${'q'.repeat(100_000)}`, options: `${'<@1>'.repeat(50_000)}|b`, recommendation: 'b', default: '', answer: '' };
  const { ask } = frame([row], 'x'.repeat(100_000), OWNER, 1);
  assert.ok(ask.parts[0].question.length <= 1002, `${ask.parts[0].question.length}`);
  assert.ok(ask.parts[0].question.startsWith('\\*\\*qqq'));
  assert.ok(ask.parts[0].options.A.length <= 1000 && ask.parts[0].options.A.startsWith('\\<@1\\>'));
  assert.ok(ask.title.length <= 302);
  assert.equal(ask.parts[0].recommended, 'B');
});
