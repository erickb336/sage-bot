// The Claude Code hook of the sage bridge (T29): node scripts/hook.mjs [--config <config.json>], for SessionStart, SessionEnd and
// PostToolUse on Bash. It reads the hook's JSON on stdin and records the session in the bridge's spool (src/sessions.js record), for
// every project in the config's projects (T132).
// It never blocks or fails the session: it always exits 0 and prints nothing on stdout (Claude Code would add SessionStart's stdout
// to sage's context). A refusal goes to stderr, one line, through the terminal allow-list.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { forTerminal } from '../src/clean.js';
import { projectsOf } from '../src/ask.js';
import { pickProject } from '../src/sage.js';
import { record, sessionsPathOf } from '../src/sessions.js';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/** The pid of the Claude Code process: the parent of this hook, past the shell that Claude Code may run the hook command in. */
function claudePid() {
  let pid = process.ppid;
  for (let up = 0; up < 3; up++) {
    const [, ppid, comm] = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).match(/^\s*(\d+)\s+(.*?)\s*$/) ?? [];
    if (!comm || !SHELLS.has(basename(comm).replace(/^-/, ''))) return pid;
    pid = Number(ppid);
  }
  return pid;
}

try {
  const args = process.argv.slice(2);
  const configPath = args[0] === '--config' ? args[1] : join(homedir(), '.config', 'sage-bot', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const projects = projectsOf(config);
  pickProject(config, projects); // a config whose project is not listed records nothing (F-T132-1)
  record(input, { projects, dir: sessionsPathOf(config), pid: claudePid(), now: Date.now(), home: homedir() });
} catch (e) {
  process.stderr.write(`sage-bot hook: nothing recorded: ${forTerminal(e?.message ?? e)}\n`);
}
process.exit(0);
