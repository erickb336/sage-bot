// T244 repair round 1 (PR 65, cycle 1): a wrong guildId leaves nothing (F-T244-1); /sage takes a name of any length, and a refused
// /sage stops only /sage (F-T244-5); the owner's name is their own Discord name, not a server nickname (F-T244-6); a vote press counts
// only on the card's own message (F-T244-4); the limit of open requests is per bot (F-T244-7). SAMPLE DATA ONLY: no token, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { askCommand } from '../src/ask.js';
import { namesOf } from '../src/crew.js';
import { enter, keepToGuild, ownerNameOf } from '../src/discord.js';
import { fakeGuilds, fakeInteraction } from '../src/fake-discord.js';
import { confirmMessage, REQUEST_NOTES } from '../src/requestCards.js';
import { CONFIG, JON, key, MAYA, OWNER, setup, T0 } from './bridge-setup.js';

const GUILD = CONFIG.guildId;
/** 32 letters of the Unicode mathematical script (U+1D4D0 and on): 32 code points, 64 UTF-16 units. */
const SCRIPT = Array.from({ length: 32 }, (_, n) => String.fromCodePoint(0x1d4d0 + (n % 26))).join('');

test('F-T244-1: a guildId that the bot is not in: it leaves no server, and the start stops with one line that names the guildId', async () => {
  const REAL = '500000000000000010';
  const TYPO = '500000000000000011';
  const client = fakeGuilds([REAL]);
  const lines = [];
  await assert.rejects(keepToGuild(client, TYPO, (l) => lines.push(l)), {
    message: `sage-bot is not in the server ${TYPO} of its config, so it left no server. Check guildId in the config, or add sage-bot to that server, then start it again.`,
  });
  assert.deepEqual([client.left, [...client.guilds.cache.keys()], lines], [[], [REAL], []]);
  client.join('500000000000000012'); // a server added later is not left either: the start stopped
  await new Promise(setImmediate);
  assert.deepEqual(client.left, []);
});

test('F-T244-5: /sage with an owner and a bot of 32 mathematical-script letters: each description fits Discord\'s 100 UTF-16 units', () => {
  const us = namesOf({ ownerName: SCRIPT, botName: SCRIPT });
  assert.equal(us.owner, SCRIPT);
  const descriptions = Object.fromEntries(askCommand([{ name: 'project' }], us).options.map((o) => [o.name, o.description]));
  assert.deepEqual(Object.values(descriptions).map((d) => d.length <= 100), Array(7).fill(true));
  // Each is cut to 99 units and "…", never inside a letter (a letter here is 2 units).
  assert.equal(descriptions.request, `Request a feature: ${SCRIPT} approves or dec…`);
  assert.equal(descriptions.stop, `Turn off the link from Discord to sage at once (the crew and ${SCRIPT.slice(0, 38)}…`);
  assert.equal(descriptions.unregister, `Stop ${SCRIPT} in this channel (${SCRIPT.slice(0, 12)}…`);
});

test('F-T244-5: a /sage that cannot be built stops only /sage: enter logs it and gives the guild', async () => {
  let set = 0;
  const guild = { members: { fetch: async () => {} }, commands: { set: async () => { set++; } } };
  const client = { user: { id: '100000000000000099' }, guilds: { fetch: async () => guild }, channels: { fetch: async () => null } };
  const lines = [];
  // Discord takes at most 25 choices; a config with 26 projects makes a /sage that discord.js refuses to build.
  const projects = Array.from({ length: 26 }, (_, n) => ({ name: `p${n}` }));
  assert.equal(await enter(client, { config: { guildId: GUILD }, channels: new Map(), ask: { projects }, log: (l) => lines.push(l) }), guild);
  assert.equal(set, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Discord refused to set \/sage and Send to sage, so they keep the commands of the last start that worked, or there are none; the votes and cards work: /);
});

test('F-T244-6: the owner\'s name is their own Discord name (global name, else user name), never a server nickname', async () => {
  const users = { [OWNER]: { globalName: 'Erick B', username: 'erickb' }, [MAYA]: { globalName: null, username: 'maya.r' } };
  const client = {
    // A moderator renamed Maya to "Erick" in the server: the copy must not read it.
    guilds: { fetch: async () => ({ members: { fetch: async () => ({ displayName: 'Erick', nickname: 'Erick' }) } }) },
    users: { fetch: async (id) => { if (!users[id]) throw Object.assign(new Error('Unknown User'), { code: 10013 }); return users[id]; } },
  };
  assert.deepEqual(await Promise.all([OWNER, MAYA, JON].map((id) => ownerNameOf(client, id))), ['Erick B', 'maya.r', undefined]);
});

test('F-T244-4: a vote press with the right gate key from another message changes nothing; the same press on the card counts', async (t) => {
  const b = setup();
  t.after(() => rmSync(b.root, { recursive: true, force: true }));
  b.sh('task', 'add', '--title', 'Colours', '--size', 'small');
  b.sh('gate', 'add', 'T1', '--question', 'Which colour?', '--options', 'Red|Blue', '--recommend', 'Red');
  await b.post();
  const card = b.discord.cardOf(key('G1'));
  const press = async (message) => {
    const i = fakeInteraction({ user: JON, customId: `press:${key('G1')}:0:1`, message });
    await b.bridge.interaction(i);
    return i.replies.map((x) => [x.kind, x.content]);
  };
  const before = JSON.stringify(b.discord.latest(card));
  assert.deepEqual(await press('900000000000000999'), [['reply', 'I do not know this button or its question. Nothing changed.']]);
  assert.equal(JSON.stringify(b.discord.latest(card)), before);
  const [[kind]] = await press(card);
  assert.equal(kind, 'update');
  assert.notEqual(JSON.stringify(b.discord.latest(card)), before);
});

test('F-T244-7: the limit of one open request names the bot it is on', () => {
  const us = namesOf({ ownerName: 'Maya', botName: "Maya's sage" });
  const r = { id: 'RQ1', title: 'Add CSV export', createdAt: T0 };
  assert.match(REQUEST_NOTES.open(us, r), / A sage-crew member can have 1 open request at a time on Maya's sage\. /);
  assert.match(confirmMessage('D1', { project: 'project', title: 'Add CSV', text: 'Why' }, us).embeds[0].footer.text,
    / You can have 1 open request at a time on Maya's sage\.$/);
});
