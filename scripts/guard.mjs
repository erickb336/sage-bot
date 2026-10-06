// The guard hook (T133): a Claude Code PreToolUse hook for a sage session that sage-bot starts for a sage-lead.
// node scripts/guard.mjs reads the hook's JSON on stdin. The rules are in src/guard.js.
// - SAGE_ORIGIN is not "lead": exit 0, no output. The owner's own sessions are unaffected.
// - A lead session: exit 0 with no output allows the tool call; a refusal prints the deny decision as JSON on stdout.
//   An input over 64 KB is refused before it is parsed.
// - The deadline starts before the hook reads stdin, and the rules run in a worker thread. When the hook has not read stdin
//   to its end and decided within DEADLINE_MS, it refuses (F-T133-62, F-T134-5): a hook that runs past Claude Code's timeout
//   does not block the call (F-T134-13), so a stdin that never closes or a slow decision must not let the call run.
// - Any failure in a lead session (a crash, a module that does not load) refuses: exit code 2 blocks the tool call in
//   Claude Code, and the reason goes to stderr.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

/** The longest time the rules may take, well under the 30 s hook timeout of Claude Code. */
const DEADLINE_MS = 5000;

if (!isMainThread) {
  const { decideText } = await import('../src/guard.js');
  parentPort.postMessage(decideText(workerData, process.env));
} else if (process.env.SAGE_ORIGIN === 'lead') {
  const fail = (e) => {
    process.stderr.write(`sage-bot guard: refused, the guard could not decide (${String(e?.message ?? e).slice(0, 200)}). This needs Erick; tell the sage-lead and stop this action.\n`);
    process.exit(2);
  };
  // A worker that throws (a rules module that does not load) emits an error with no listener, and it comes here too.
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  try {
    const { writeSync } = await import('node:fs');
    const { refusal } = await import('../src/guard.js');
    const answer = (reason) => {
      if (reason) {
        // A synchronous write (F-T133-57): process.stdout.write to a pipe is asynchronous on macOS, and process.exit then
        // cut the JSON at 64 KB; a deny that does not parse lets the call run.
        const out = Buffer.from(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
        for (let done = 0; done < out.length;) done += writeSync(1, out, done);
      }
      process.exit(0);
    };
    // stdout and stderr: true keep the worker's streams off ours. Piped to process.stdout and process.stderr, they made fd 1
    // non-blocking, and writeSync of a long deny then failed with EAGAIN when the reader was slow.
    setTimeout(() => answer(refusal(`a tool call that the guard did not decide in ${DEADLINE_MS / 1000} s`)), DEADLINE_MS);
    // stdin is read as a stream, so that the deadline above runs while it waits (a synchronous read blocked the timer).
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c)).on('error', fail).on('end', () => {
      new Worker(new URL(import.meta.url), { workerData: Buffer.concat(chunks).toString('utf8'), stdout: true, stderr: true }).on('message', answer);
    });
  } catch (e) {
    fail(e);
  }
}
