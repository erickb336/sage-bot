// The scratch keychain of the proof, for the Keychain probes of T165 (F-T165-2). WARNING: it changes the owner's keychain search list
// while it runs, so it runs only with the chief's approval (standing order 11); `npm run proof` never runs it and only prints its
// commands. It makes a keychain file in a scratch folder with one sample generic password, under a service name that no real item uses,
// and every probe names that keychain by its path. `security create-keychain` adds the new keychain to the user's search list and
// `delete-keychain` changes it again, so it saves the list first and puts it back after, also on a failure (F-T157-9).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const ACCOUNT = 'sage-bot-proof';

/**
 * The commands of one scratch keychain, as `security` arguments. `password` and `value` are sample values, never printed (printable).
 * @param {string} dir  the scratch folder @param {string} [id]  random hex: the service name and the sample values end in it
 */
export function keychainPlan(dir, id = randomBytes(8).toString('hex')) {
  const path = join(dir, 'proof.keychain-db'), service = `sage-bot-proof-sample-${id}`;
  const password = `sample-fake-keychain-password-${id}`, value = `sample-fake-keychain-item-${id}`;
  return {
    path, service, password, value,
    save: ['list-keychains', '-d', 'user'],
    create: ['create-keychain', '-p', password, path],
    add: ['add-generic-password', '-a', ACCOUNT, '-s', service, '-w', value, path],
    probe: ['find-generic-password', '-a', ACCOUNT, '-s', service, path], // T165's probes name the scratch keychain by its path
    remove: ['delete-keychain', path],
    restore: (saved) => ['list-keychains', '-d', 'user', '-s', ...saved],
  };
}

/** The plan's commands for a report: each sample value shown as <sample>. @param {ReturnType<typeof keychainPlan>} plan */
export function printable(plan) {
  const hide = (args) => ['security', ...args.map((a) => (a === plan.password || a === plan.value ? '<sample>' : a))].join(' ');
  return [plan.save, plan.create, plan.add, plan.probe, plan.remove, plan.restore(['<each keychain of the saved list>']), plan.save].map(hide);
}

/** The keychain paths of `security list-keychains` output: one quoted path a line. @param {string} out */
export const keychainsOf = (out) => [...out.matchAll(/^\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);

/**
 * Runs `fn(plan)` with the scratch keychain, and always puts the user's keychain search list back as it was before.
 * Refuses to start when the saved list is empty: a list that it cannot read is not one that it may later write.
 * @template T @param {string} dir @param {(plan: ReturnType<typeof keychainPlan>) => T | Promise<T>} fn
 * @param {{ env?: NodeJS.ProcessEnv, id?: string }} [o]  env: the PATH that finds `security` (a fake one, in the tests)
 * @returns {Promise<T>}
 */
export async function withScratchKeychain(dir, fn, { env = process.env, id } = {}) {
  const plan = keychainPlan(dir, id);
  const security = (args) => execFileSync('security', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const saved = keychainsOf(security(plan.save));
  if (!saved.length) throw new Error('the keychain search list is empty or could not be read: nothing was changed.');
  let created = false;
  try {
    security(plan.create);
    created = true;
    security(plan.add);
    return await fn(plan);
  } finally {
    try { if (created) security(plan.remove); } finally {
      security(plan.restore(saved));
      const now = keychainsOf(security(plan.save));
      if (now.join('\n') !== saved.join('\n')) throw new Error(`the keychain search list is not as it was: it was ${saved.join(', ')}, it is ${now.join(', ')}. Put it back with: security list-keychains -d user -s ${saved.map((p) => `'${p}'`).join(' ')}`);
    }
  }
}
