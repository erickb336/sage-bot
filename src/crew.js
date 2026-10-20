// Who is who on this sage-bot (T232): the one place that reads the crew and the owner. The crew is every member with a guild role whose
// name is exactly CREW, found by name at run time, never by an id in the config. The owner is one Discord user id, set at the start:
// the config's ownerId, else the owner of the bot's Discord application. A role never makes anyone the owner.

/** The name of the shared crew role, case-sensitive. Every sage-bot in a server reads the same role. */
export const CREW = 'sage-crew';

/**
 * The one private line for a person who is neither in the crew nor the owner and uses /sage or presses a button of this sage-bot (T239,
 * owner decision), with the bot's own name from namesOf. A mention of theirs gets nothing at all.
 */
export const notCrew = (us) => `Only the ${CREW} role can use ${us.bot}.`;

/** The longest name that the copy shows, in code points: Discord's own limit of a display name. */
export const NAME_MAX = 32;
const NAME_LETTER = /^[\p{L}--\p{Default_Ignorable_Code_Point}]$/v;
const NAME_MARK = /^[\p{M}--\p{Default_Ignorable_Code_Point}]$/v;
const NAME_KEEP = /^[\p{Nd}.'\-]$/v;
/**
 * A Discord name as the copy shows it (T244). Who reads it: people on Discord only (cards, buttons, private notes and the /sage
 * descriptions), never a model. An allow-list (standing order 12): letters, decimal digits, at most 3 marks on a letter, one space
 * between words, and `. ' -`. Every other character parts words. So no markdown, mention, link, emoji, escape or hidden character
 * stays, and the name reads the same in a button label (no markdown) and in a card (markdown). The name starts with a letter or a
 * digit and is cut to NAME_MAX code points; '' when nothing is left.
 */
export function personName(text) {
  let out = '';
  let marks = -1; // -1: no letter before, so no mark may stay; else the marks on the last letter
  for (const ch of String(text ?? '').toWellFormed().normalize('NFC')) {
    if (NAME_LETTER.test(ch)) [out, marks] = [out + ch, 0];
    else if (NAME_MARK.test(ch)) { if (marks >= 0 && marks < 3) [out, marks] = [out + ch, marks + 1]; }
    else if (NAME_KEEP.test(ch)) [out, marks] = [out + ch, -1];
    else [out, marks] = [`${out} `, -1];
  }
  const name = out.replace(/ +/g, ' ').trim().replace(/^[^\p{L}\p{Nd}]+/u, '');
  return Array.from(name).slice(0, NAME_MAX).join('').trim();
}

/**
 * The one resolver of the names in the copy of this sage-bot (T244): the owner's Discord display name and the bot's own name, as
 * src/discord.js reads them at the start into the config (`ownerName`, `botName`), each cleaned by personName. "the owner" and
 * "sage-bot" when a name is unknown or nothing of it is left. `Owner` is the owner at the start of a sentence: "The owner" or the name.
 * @param {{ ownerName?: string, botName?: string }} config
 * @returns {{ owner: string, Owner: string, bot: string }}
 */
export function namesOf({ ownerName, botName } = {}) {
  const owner = personName(ownerName);
  return { owner: owner || 'the owner', Owner: owner || 'The owner', bot: personName(botName) || 'sage-bot' };
}

/**
 * Where a person is on this bot, from their user id and the NAMES of their roles: `owner` when the id is the owner's (with or
 * without a role), `crew` when a role is named exactly CREW (also when two roles share the name). Nothing else counts.
 * @param {string} id @param {Iterable<string>} roleNames @param {string} ownerId
 * @returns {{ owner: boolean, crew: boolean }}
 */
export const placeOf = (id, roleNames, ownerId) => ({ owner: isOwner(id, ownerId), crew: [...(roleNames ?? [])].includes(CREW) });

/** Whether `id` is the owner's user id (`ownerId`, as ownerOf resolved it). The one owner check: placeOf, the bridge and the vote rules use it. */
export const isOwner = (id, ownerId) => typeof ownerId === 'string' && id === ownerId;

/**
 * The roles that a record (the audit log, a held mention) keeps of a person (F-T232-13): [CREW] when they are in the crew, else none.
 * No other role name, and no text of Discord, goes into a record. Old records with role ids or names still load.
 * @param {{ crew: boolean }} place  from placeOf
 */
export const keptRoles = (place) => (place.crew ? [CREW] : []);

/**
 * Who may use the emergency stop (/sage stop and its confirm): the crew and the owner. It takes effect at once, with no approval of the
 * owner; only the owner turns the link on again, at the terminal. Every other right on this bot is the owner's alone.
 * @param {{ owner: boolean, crew: boolean }} place  from placeOf
 */
export const mayStop = (place) => place.owner || place.crew;

/** The ids of the guild's roles named exactly CREW, from `[{ id, name }]`. */
export const crewRoleIds = (roles) => [...roles].filter((r) => r.name === CREW).map((r) => r.id);

/**
 * The most crew roles that one message pings (F-T232-1). Many roles named CREW (anyone with Manage
 * Roles can make them) never make a message that the gate file refuses at the next start, and crewWarning names them all.
 */
export const PINGED_ROLES = 10;
/** The ids of the roles that a crew alert pings: the roles named CREW, at most PINGED_ROLES; none when no role has the name. */
export const crewPings = (roles) => crewRoleIds(roles).slice(0, PINGED_ROLES);

/** The one warning line when two or more roles are named CREW (all of them count), else null. */
export function crewWarning(roles) {
  const ids = crewRoleIds(roles);
  return ids.length > 1 ? `${ids.length} roles are named ${CREW} (${ids.join(', ')}): each member of any of them is in the crew. Delete or rename all but one.` : null;
}

/** The config keys of the roles before T232. A config that still has one starts, with a warning, and the key does nothing (for one release). */
export const OLD_ROLE_KEYS = ['apprenticeRole', 'leadRole', 'driverRole'];
/** The warning for the old role keys of `config`, or null. */
export function oldRoleKeys(config) {
  const old = OLD_ROLE_KEYS.filter((k) => config?.[k] !== undefined);
  return old.length ? `the config has ${old.join(', ')}: sage-bot no longer reads ${old.length > 1 ? 'them' : 'it'}. The crew is every member with the role named ${CREW}. Remove ${old.join(' and ')} from the config.` : null;
}

/**
 * The owner of this bot (C12), from the config's ownerId (or undefined) and the bot's Discord application as
 * `{ owner: { id } | null, team: { ownerId } | null }` (src/discord.js maps client.application). The config wins; else the owner of an
 * application of one user. An application of a Developer Team needs ownerId in the config: then this throws, and nothing starts.
 * `warning` is set when the config and the application name different people.
 * @returns {{ ownerId: string, warning: string | null }}
 */
export function ownerOf(configOwner, app) {
  const appOwner = app.team ? app.team.ownerId ?? null : app.owner?.id ?? null;
  if (configOwner !== undefined) {
    const warning = appOwner && appOwner !== configOwner
      ? `the config's ownerId ${configOwner} is not the owner of the Discord application (${appOwner}): sage-bot takes ${configOwner} as its owner`
      : null;
    return { ownerId: configOwner, warning };
  }
  if (app.team) throw new Error('the Discord application of sage-bot belongs to a Developer Team, so sage-bot cannot tell who its owner is. Add "ownerId" with your Discord user id to the config, then start sage-bot again. Nothing was started.');
  if (!appOwner) throw new Error('Discord did not say who owns the application of sage-bot. Add "ownerId" with your Discord user id to the config, then start sage-bot again. Nothing was started.');
  return { ownerId: appOwner, warning: null };
}
