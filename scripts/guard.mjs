// The guard hook (T133): a Claude Code PreToolUse hook for a sage session that sage-bot starts for a sage-lead.
// node scripts/guard.mjs reads the hook's JSON on stdin. The rules are in src/guard.js.
// - SAGE_ORIGIN is not "lead": exit 0, no output. The owner's own sessions are unaffected.
// - A lead session: exit 0 with no output allows the tool call; a refusal prints the deny decision as JSON on stdout.
//   An input over 64 KB is refused before it is parsed.
// - Any failure in a lead session (a crash, a module that does not load) refuses: exit code 2 blocks the tool call in
//   Claude Code, and the reason goes to stderr.
if (process.env.SAGE_ORIGIN === 'lead') {
  const fail = (e) => {
    process.stderr.write(`sage-bot guard: refused, the guard could not decide (${String(e?.message ?? e).slice(0, 200)}). This needs Erick; tell the sage-lead and stop this action.\n`);
    process.exit(2);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  try {
    const { readFileSync } = await import('node:fs');
    const { decideText } = await import('../src/guard.js');
    const reason = decideText(readFileSync(0, 'utf8'), process.env);
    if (reason) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
    }
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}
