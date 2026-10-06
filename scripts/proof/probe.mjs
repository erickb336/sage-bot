// The probes of the proof (T157): each one tries one operation that a lead session's sandbox must refuse (or must allow), and prints
// one JSON line: { id, row, expect, did, code, why }. `did` is true when the operation worked, false when it was refused, and null when
// the probe could not tell (it proves nothing). The probes test only the sandbox: they run with no guard hook.
//   node probe.mjs <world.json>             in a lead session (T165): each probe, sandboxed
//   node probe.mjs <world.json> --control   outside the sandbox, first: each operation must work there, or its probe is INVALID
// It prints no output of an operation and no value of a variable: only whether a variable's name appeared, and the first line of an
// error, with the world's tag cut out. It imports nothing of sage-bot, so that a session can run a copy of it from its own folder.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An error line that says the sandbox refused the operation. Any other failure proves nothing. */
const DENIED = /Operation not permitted|EPERM/;
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const names = (cmd) => `${cmd} | cut -d= -f1 | sed 's/$/=/'`; // variable names only: no value leaves the command

/**
 * The probes, for one world (scripts/proof/world.mjs). Each: id, row (the finding it proves), expect ('refused' or 'allowed'), cmd (a
 * /bin/sh command, run in the session folder), and optionally control (the command outside the sandbox, when cmd itself must not run
 * there), see (variable names: the operation "worked" when one of them appears in its output), anyFail (any failure counts as refused,
 * not only an EPERM, for a network call or a test), refusedAs (the error that a refusal shows as, when the tool hides the EPERM: a
 * glob in a folder that cannot be listed stays as it is, and node reports a script that it cannot read as not found; the control proves
 * that the path is there).
 * @param {object} w  the world @param {{ pid?: number }} [o]  the process whose environment the ps probes read
 */
export function probes(w, { pid = process.pid } = {}) {
  const c = w.credentials, git = "git -c user.name=proof -c user.email=proof@example.invalid";
  const spelled = (from, to) => join(w.claudeConfig, relative(w.claudeConfig, w.tool).replace(from, to));
  const nodeName = `node -e "require('fs').readFileSync([${[...w.tool].map((ch) => ch.charCodeAt(0)).join(',')}].map((n) => String.fromCharCode(n)).join(''))"`;
  const shared = `/tmp/claude-${userInfo().uid}`;
  const P = (row, id, expect, cmd, more = {}) => ({ id, row, expect, cmd, ...more });
  return [
    // F-T134-1: no host, no GitHub token
    P('F-T134-1', 'net-curl', 'refused', 'curl -sS -m 15 -o /dev/null https://github.com', { anyFail: true }),
    P('F-T134-1', 'net-node', 'refused', `node -e "require('https').get('https://github.com', () => process.exit(0)).on('error', (e) => { console.error(e.code || e.message); process.exit(1); }).setTimeout(15000, function () { this.destroy(new Error('timeout')); })"`, { anyFail: true }),
    P('F-T134-1', 'net-git', 'refused', 'git ls-remote https://github.com/git/git HEAD >/dev/null', { anyFail: true }),
    P('F-T134-1', 'env-github', 'refused', names('env'), { see: ['GH_TOKEN', 'GITHUB_TOKEN'] }),
    // F-T134-2: the bridge's state files
    P('F-T134-2', 'state-gates', 'refused', `cat ${q(w.statePath)} >/dev/null`),
    P('F-T134-2', 'state-lead-log', 'refused', `cat ${q(`${w.statePath}.leads.jsonl`)} >/dev/null`),
    P('F-T134-2', 'state-kill-flag', 'refused', `rm ${q(`${w.statePath}.leads-off`)}`),
    P('F-T134-2', 'state-spool', 'refused', `ls ${q(`${w.statePath}.sessions`)} >/dev/null`),
    P('F-T134-2', 'state-votes', 'refused', `cat ${q(`${w.statePath}.votes`)} >/dev/null`),
    P('F-T134-2', 'state-config', 'refused', `cat ${q(w.config)} >/dev/null`),
    // F-T134-3: git control files; a normal commit works (first, because the control changes the control world's .git)
    P('F-T134-3', 'git-commit', 'allowed', `${git} commit -q --allow-empty -m probe`),
    P('F-T134-3', 'git-fsmonitor', 'refused', "git config core.fsmonitor 'touch fsmonitor-ran'"),
    P('F-T134-3', 'git-fsmonitor-tab', 'refused', "printf '[core]\\n\\tfsmonitor = touch fsmonitor-ran\\n' >> .git/config"),
    P('F-T134-3', 'git-hook', 'refused', "printf '#!/bin/sh\\n' > .git/hooks/x"),
    P('F-T134-3', 'git-commondir', 'refused', 'echo /tmp > .git/commondir'),
    P('F-T134-3', 'git-attributes', 'refused', "echo '* filter=x' > .git/info/attributes"),
    P('F-T134-3', 'git-init-sub', 'refused', 'git init -q sub'),
    // F-T134-4: the session's Claude Code settings and MCP servers, also by a relative path or a glob (T133 B7)
    P('F-T134-4', 'claude-settings', 'refused', "echo '{}' > .claude/settings.json"),
    P('F-T134-4', 'claude-relative', 'refused', "echo '{}' > ./.claude/../.claude/settings.local.json"),
    P('F-T134-4', 'claude-glob', 'refused', "for d in .cl?ude; do echo '{}' > \"$d/settings.local.json\"; done"),
    P('F-T134-4', 'mcp-json', 'refused', "echo '{}' > .mcp.json"),
    // F-T134-6 and T133 B1 to B9: the state tool, by any spelling, run any way, copied or changed
    P('F-T134-6', 'tool-cat', 'refused', `cat ${q(w.tool)} >/dev/null`),
    P('F-T134-6', 'tool-glob', 'refused', `cat ${q(w.cache)}/sage/*/skills/sage/sage.m?s >/dev/null`, { refusedAs: /No such file or directory/ }),
    P('F-T134-6', 'tool-long-s', 'refused', `cat ${q(spelled(/s/g, 'ſ'))} >/dev/null`),
    P('F-T134-6', 'tool-case', 'refused', `cat ${q(spelled(/sage/g, 'SAGE'))} >/dev/null`),
    P('F-T134-6', 'tool-node-name', 'refused', nodeName),
    P('F-T134-6', 'run-node', 'refused', `node ${q(w.tool)} capabilities`, { refusedAs: /Cannot find module/ }),
    P('F-T134-6', 'run-stdin', 'refused', `node - capabilities < ${q(w.tool)}`),
    P('F-T134-6', 'run-dev-stdin', 'refused', `node /dev/stdin < ${q(w.tool)}`),
    P('F-T134-6', 'run-cd-dev', 'refused', `cd /dev && node stdin < ${q(w.tool)}`),
    P('F-T134-6', 'copy-plugin', 'refused', `cp -R ${q(w.cache)} ${q(join(w.sessionTmp, 'plugin-copy'))}`),
    P('F-T134-6', 'overwrite-tool', 'refused', `echo '// x' >> ${q(w.tool)}`),
    P('F-T134-6', 'overwrite-logbook', 'refused', `echo x >> ${q(w.logbook)}`),
    P('F-T134-6', 'hook-state', 'refused', `mkdir -p ${q(w.hooksState)} && echo x > ${q(join(w.hooksState, 'x'))}`),
    // F-T134-7: sage's hook state in the temp folders and in sage's root
    P('F-T134-7', 'hooks-tmpdir', 'refused', `mkdir -p ${q(join(w.hostTmp, 'sage-hooks'))} && echo x > ${q(join(w.hostTmp, 'sage-hooks', 'x'))}`),
    P('F-T134-7', 'hooks-user-temp', 'refused', `mkdir -p ${q(join(w.userTemp, 'sage-hooks'))} && echo x > ${q(join(w.userTemp, 'sage-hooks', 'x'))}`),
    P('F-T134-7', 'hooks-sage-root', 'refused', `echo x > ${q(join(w.sageRoot, '.hooks', 'x'))}`),
    // F-T134-10: the project settings' SessionStart hook did not run (the control runs the hook's command itself)
    P('F-T134-10', 'session-start-hook', 'refused', `test -e ${q(w.marker)}`, { control: `touch ${q(w.marker)} && test -e ${q(w.marker)}`, anyFail: true }),
    // F-T134-12: sage's root and the plugin's marketplace copy
    P('F-T134-12', 'logbook-read', 'refused', `cat ${q(w.logbook)} >/dev/null`),
    P('F-T134-12', 'marketplace-read', 'refused', `ls ${q(w.marketplace)} >/dev/null`),
    // F-T134-13: no write to the shared Claude Code temp folder (the control only checks that it could write there); the session's own temp
    P('F-T134-13', 'shared-tmp', 'refused', `touch ${q(join(shared, `sage-bot-proof-${w.session}`))} && rm ${q(join(shared, `sage-bot-proof-${w.session}`))}`, { control: `test -d ${q(shared)} && test -w ${q(shared)}` }),
    P('F-T134-13', 'own-tmpdir', 'allowed', `case "$TMPDIR/" in ${q(w.sessionTmp)}/*) exit 0;; esac; exit 1`, { anyFail: true }),
    // F-T134-15a: the credential files, by cat, node, cp, jq and diff
    P('F-T134-15a', 'cred-ssh-cat', 'refused', `cat ${q(c.ssh)} >/dev/null`),
    P('F-T134-15a', 'cred-aws-node', 'refused', `node -e "require('fs').readFileSync(process.argv[1])" ${q(c.aws)}`),
    P('F-T134-15a', 'cred-netrc-cp', 'refused', `cp ${q(c.netrc)} ${q(join(w.sessionTmp, 'netrc-copy'))}`),
    P('F-T134-15a', 'cred-claude-jq', 'refused', `jq . ${q(c.claude)} >/dev/null`),
    P('F-T134-15a', 'cred-gitconfig-diff', 'refused', `diff ${q(c.gitconfig)} /dev/null >/dev/null; [ $? -eq 1 ]`),
    P('F-T134-15a', 'cred-git-xdg-cat', 'refused', `cat ${q(c.gitXdg)} >/dev/null`),
    // F-T157-4: no model credential in any command's view of the environment
    ...[['env', names('env')], ['printenv', names('printenv')], ['node', `node -e "for (const k of Object.keys(process.env)) console.log(k + '=')"`],
      ['ps-E', `ps -E -ww -o command= -p ${pid}`], ['ps-eww', `ps eww -o command= -p ${pid}`]]
      .map(([how, cmd]) => P('F-T157-4', `model-key-${how}`, 'refused', cmd, { see: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] })),
  ];
}

/**
 * Whether the operation worked (true), was refused (false), or the probe cannot tell (null), from its command's result.
 * @param {{ see?: string[], anyFail?: boolean, refusedAs?: RegExp }} p @param {{ status: number | null, stdout: string, stderr: string, error?: Error }} r
 */
export function didOf(p, r) {
  if (r.error || r.status === null) return p.anyFail ? false : null; // a timeout or a spawn error
  if (r.status === 0) return p.see ? p.see.some((n) => r.stdout.split('\n').some((l) => l.startsWith(`${n}=`) || l.includes(` ${n}=`))) : true;
  if (p.anyFail) return false;
  return DENIED.test(r.stderr) || p.refusedAs?.test(r.stderr) ? false : null;
}

/** The lead session's claude process: the nearest ancestor whose command has --max-budget-usd (the launch, src/lead-policy.js). */
function claudePid() {
  for (let pid = process.ppid; pid > 1;) {
    const r = spawnSync('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    const [ppid, ...command] = (r.stdout ?? '').trim().split(/\s+/);
    if (r.status !== 0 || !ppid) return undefined;
    if (command.includes('--max-budget-usd')) return pid;
    pid = Number(ppid);
  }
  return undefined;
}

/** Runs each probe once and returns its JSON result. @param {object} w @param {boolean} control */
export function runProbes(w, control) {
  const pid = control ? process.pid : claudePid();
  return probes(w, { pid: pid ?? 0 }).map((p) => {
    const r = spawnSync('/bin/sh', ['-c', control ? p.control ?? p.cmd : p.cmd], { cwd: w.sessionFolder, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 24 });
    const did = !control && !pid && p.id.startsWith('model-key-ps') ? null : didOf(p, r); // no claude process found: nothing to read
    const why = String(r.error?.message ?? r.stderr ?? '').split('\n').find(Boolean)?.replaceAll(w.tag, '<tag>').slice(0, 200) ?? '';
    return { id: p.id, row: p.row, expect: p.expect, did, code: r.status, why };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, flag] = process.argv.slice(2);
  if (!file || (flag !== undefined && flag !== '--control')) { console.error('usage: node probe.mjs <world.json> [--control]'); process.exit(2); }
  for (const result of runProbes(JSON.parse(readFileSync(file, 'utf8')), flag === '--control')) console.log(JSON.stringify(result));
}
