// Who is who on this sage-bot (T232): the one place that reads the crew and the owner. The crew is every member with a guild role whose
// name is exactly CREW, found by name at run time, never by an id in the config. The owner is one Discord user id, set at the start:
// the config's ownerId, else the owner of the bot's Discord application. A role never makes anyone the owner.

/** The name of the shared crew role, case-sensitive. Every sage-bot in a server reads the same role. */
export const CREW = 'sage-crew';

/**
 * Where a person is on this bot, from their user id and the NAMES of their roles: `owner` when the id is the owner's (with or
 * without a role), `crew` when a role is named exactly CREW (also when two roles share the name). Nothing else counts.
 * @param {string} id @param {Iterable<string>} roleNames @param {string} ownerId
 * @returns {{ owner: boolean, crew: boolean }}
 */
export const placeOf = (id, roleNames, ownerId) => ({ owner: typeof ownerId === 'string' && id === ownerId, crew: [...(roleNames ?? [])].includes(CREW) });

/**
 * Who may use the emergency stop (/sage stop and its confirm): the crew and the owner. It takes effect at once, with no approval of the
 * owner; only the owner turns the link on again, at the terminal. Every other right on this bot is the owner's alone.
 * @param {{ owner: boolean, crew: boolean }} place  from placeOf
 */
export const mayStop = (place) => place.owner || place.crew;

/** The ids of the guild's roles named exactly CREW, from `[{ id, name }]`: the roles that a new card pings. */
export const crewRoleIds = (roles) => [...roles].filter((r) => r.name === CREW).map((r) => r.id);

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
