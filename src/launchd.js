// The launchd agent of the bridge, as text. scripts/launchd.mjs prints it; the owner saves and loads it. Nothing here runs launchctl.

/** The label of the agent, and the name of its plist file in ~/Library/LaunchAgents. */
export const LABEL = 'com.sage.bot';

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
