// The launchd agent of the bridge, as text. scripts/launchd.mjs prints or writes it; the owner loads it. Nothing here runs launchctl.

/** The label of the agent, and the name of its plist file in ~/Library/LaunchAgents. */
export const LABEL = 'com.sage.bot';

/** The fields of the config that the bridge needs, each a non-empty string (see examples/config.example.json). */
export const CONFIG_FIELDS = ['guildId', 'channelId', 'ownerId', 'apprenticeRole', 'leadRole', 'project', 'sagePath', 'statePath'];
/** The fields of the config that are Discord ids: the bridge refuses each one that does not match its SNOWFLAKE. */
export const DISCORD_IDS = ['guildId', 'channelId', 'ownerId', 'apprenticeRole', 'leadRole'];

/** The Homebrew links that `brew upgrade node` keeps, in the order the plist prefers them. */
const BREW_LINKS = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
const CELLAR = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.*)$/; // <prefix>/Cellar/<formula>/<version>/<rest>

/**
 * The node path for the plist that still works after a Node upgrade: a Homebrew link to the running node, else the
 * running formula's opt link, else execPath with a warning. It never gives a path under Cellar/<version>: a Cellar node
 * with no link throws, and so does an old Cellar node whose formula Homebrew now links to a newer one (it still runs after
 * an upgrade): then the message names the current node to run the script with. realpath is fs.realpathSync, or a fake in tests.
 * @returns {{ node: string, warning?: string }}
 */
export function stableNode(execPath, realpath) {
  const real = (p) => { try { return realpath(p); } catch { return null; } };
  const target = real(execPath) ?? execPath;
  const cellar = CELLAR.exec(target);
  const opt = cellar && `${cellar[1]}/opt/${cellar[2]}/${cellar[3]}`;
  const node = [...BREW_LINKS, opt].find((p) => p && real(p) === target);
  if (node) return { node };
  const current = opt && real(opt);
  if (current) throw new Error(`${target} is an old node: Homebrew now links ${opt} to ${current}. Run the script again with the current node (${opt})`);
  if (cellar) throw new Error(`no stable link to ${target}: run "brew link ${cellar[2]}", then make the plist again`);
  return { node: execPath, warning: `the plist runs ${execPath}: make the plist again after each Node upgrade` };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The plist that starts the bridge at login and starts it again when it stops. The token is not in it: the bridge reads it
 * from the Keychain. Every path must be absolute.
 * @param {{ node: string, script: string, config: string, logDir: string }} o
 */
export function plist({ node, script, config, logDir }) {
  for (const [key, path] of Object.entries({ node, script, config, logDir })) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError(`plist: ${key} must be an absolute path`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    <string>${xml(config)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(logDir)}/sage-bot.log</string>
  <key>StandardErrorPath</key>
  <string>${xml(logDir)}/sage-bot.log</string>
</dict>
</plist>
`;
}
