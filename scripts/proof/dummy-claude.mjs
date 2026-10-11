// A dummy `claude` for the proof (T165): no model, no network. `node dummy-claude.mjs <mode> <claude arguments>`, where mode is `ok`
// (the sandbox status of a ready Mac) or `unavailable` (the status that must refuse a start, F-T134-15c). It answers `--version`,
// `sandbox status` and `-p` (one init line and one result line of the stream-json format, with no tool call), and nothing else.
// The runner starts it through a wrapper script that fixes the mode (dummyClaude in scripts/proof/session.mjs), because the session's
// environment and arguments are the policy's and carry no mode.
const [mode, ...args] = process.argv.slice(2);
const STATUS = {
  ok: { supported: true, enabled: true, strictMode: true, strictModeSource: 'policy', autoAllowBashIfSandboxed: true, autoAllowBashIfSandboxedSource: 'default', unavailableReason: null },
  unavailable: { supported: true, enabled: false, strictMode: true, strictModeSource: 'policy', autoAllowBashIfSandboxed: true, autoAllowBashIfSandboxedSource: 'default', unavailableReason: 'dummy: the sandbox is unavailable here' },
};
if (!STATUS[mode]) { console.error(`usage: node dummy-claude.mjs ok|unavailable <claude arguments>`); process.exit(2); }
if (args.includes('--version')) console.log('0.0.0 (dummy claude)');
else if (args.includes('sandbox') && args.includes('status')) console.log(JSON.stringify(STATUS[mode]));
else if (args.includes('-p')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'dummy', tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Agent'], plugins: [], plugin_errors: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0, permission_denials: [], result: 'dummy claude: no model ran' }));
} else { console.error(`dummy claude: unknown arguments ${args.join(' ')}`); process.exit(2); }
