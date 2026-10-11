// The sage-bot broker (T158, T134 PR 3): the only way a bridge session reaches GitHub. A few fixed verbs, each with an allow-list of
// input keys; everything else is refused with one line (G28 A). No verb merges, approves, deletes or changes a branch rule, and the
// only ref that a verb writes on GitHub is the session's own branch sage-lead/s<n>, by fast-forward. T159 wires the verbs into a
// session as in-process MCP tools of the Claude Agent SDK (G57 A); this module has no SDK.
//
// Host-side git never runs in a session folder (docs/reference.md, "Git in a session folder"): an upload reads the object files of
// the session's .git as plain files, into a new bare repository of the broker, and runs git only there, with hooks and config off.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubRest } from './github.js';
import { BRIDGE_PATH, SESSION } from './session-policy.js';

/** The fixed identity of every commit that the broker uploads (G62 a). T161 may give it the GitHub App's own address. */
export const IDENTITY = { name: 'sage-lead (via sage-bot)', email: 'sage-lead@sage-bot.invalid' };
/** The base of every session's pull request, and the branch that an upload starts from. */
export const BASE = 'main';
export const LIMITS = { title: 200, body: 60_000, message: 20_000, commits: 500, files: 100_000, bytes: 512 * 2 ** 20 };

class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };

/**
 * The text that the broker lets into GitHub: a pull request's title and body, and each commit message. People read it on GitHub.
 * The allow-list keeps letters, marks, digits, punctuation, symbols, the space and (in a body or a message) the newline, so markdown
 * stays as it is; no control, format, bidi, private-use, unassigned or default-ignorable character passes (standing order 12).
 */
const TEXT = /^[[\p{L}\p{M}\p{N}\p{P}\p{S} ]--\p{Default_Ignorable_Code_Point}]$/v;
const allowed = (ch, lines) => TEXT.test(ch) || (lines && ch === '\n');
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
export function textOf(what, value, max, lines) {
  if (typeof value !== 'string' || !value.trim()) refuse(`${what} must be text that is not empty`);
  const chars = Array.from(value);
  if (chars.length > max) refuse(`${what} has ${chars.length} characters; the most is ${max}`);
  const bad = chars.find((ch) => !allowed(ch, lines));
  if (bad !== undefined) refuse(`${what} has the character ${hex(bad)}; the broker allows only letters, marks, digits, punctuation, symbols, the space${lines ? ' and the newline' : ''}`);
  return value;
}
/** Text from GitHub back to the session's model (a pull request that people can edit too): the same allow-list, each other character a space. */
const keep = (text) => Array.from(String(text ?? ''), (ch) => (allowed(ch, true) ? ch : ' ')).join('');

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The one resolver of the broker (standing order 15): the session, its branch, its folders and the repository, from the session
 * policy (`sessionPolicy` in src/session-policy.js) and the bridge's GitHub settings. Nothing else in the broker names them.
 */
export function scopeOf(policy, { owner, repo, remote }) {
  if (!SESSION.test(policy?.session ?? '')) throw new TypeError('the broker needs the session policy of one bridge session');
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '')) throw new TypeError('the broker needs a GitHub owner and repository name');
  return {
    session: policy.session, branch: `sage-lead/${policy.session}`, folder: policy.folder, tmp: policy.tmp,
    owner, repo, full: `${owner}/${repo}`, remote: remote ?? `https://github.com/${owner}/${repo}.git`,
  };
}

/** Run git, as the broker's own process, never in a session folder. Tests wrap it to record each call. */
export const runGit = (args, { cwd, env, input }) =>
  execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 2 ** 20 });

/** The settings of every git call: no global or system config, no hooks, no fsmonitor, no prompt. The token goes only in an
 * environment variable for github.com (as actions/checkout does), never in an argument or a URL. */
const NEUTRAL = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper='];
const envOf = (home, token) => ({
  PATH: BRIDGE_PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
});

/**
 * The broker of one bridge session.
 * @param {{ policy: { session: string, folder: string, tmp: string }, github: { owner: string, repo: string, remote?: string, api?: string },
 *   token: () => string | Promise<string>, workDir: string, fetch?: typeof globalThis.fetch, git?: typeof runGit }} o
 *   `workDir` is a folder of the broker, outside every session folder; each verb makes a new folder in it and removes it after.
 */
export function createBroker({ policy, github, token, workDir, fetch, git = runGit }) {
  const s = scopeOf(policy, github);
  const rest = githubRest({ api: github.api, token, fetch });
  const MAIN = `refs/heads/${BASE}`, BRANCH = `refs/heads/${s.branch}`;

  /** A new bare repository of the broker, with GitHub's main (and the session's branch, when it exists) in it. */
  async function mirror() {
    const repo = mkdtempSync(join(workDir, `${s.session}-`));
    const env = envOf(repo, await token());
    const g = (args, input) => {
      try { return git(['--git-dir', repo, ...NEUTRAL, ...args], { cwd: repo, env, input }); }
      catch { throw new Error(`git ${args[0]} failed`); }
    };
    g(['init', '--bare', '--quiet']);
    const heads = Object.fromEntries(g(['ls-remote', '--heads', s.remote, MAIN, BRANCH]).split('\n').filter(Boolean).map((l) => l.split('\t').reverse()));
    if (!SHA.test(heads[MAIN] ?? '')) refuse(`GitHub has no ${BASE} branch in ${s.full}`);
    return { repo, g, heads, done: () => rmSync(repo, { recursive: true, force: true }) };
  }
  const pull = (m) => m.g(['fetch', '--quiet', '--no-tags', s.remote, ...[MAIN, ...(m.heads[BRANCH] ? [BRANCH] : [])].map((r) => `+${r}:${r}`)]);

  /** fetch: read-only. GitHub's main and the session's branch, as a git bundle in the session's temp folder. */
  async function fetchVerb() {
    const m = await mirror();
    try {
      pull(m);
      const bundle = join(s.tmp, `fetch-${randomBytes(6).toString('hex')}.bundle`);
      m.g(['bundle', 'create', '--quiet', join(m.repo, 'out.bundle'), MAIN, ...(m.heads[BRANCH] ? [BRANCH] : [])]);
      writeFileSync(bundle, readFileSync(join(m.repo, 'out.bundle')), { flag: 'wx', mode: 0o600 }); // wx: never through a link the session made
      return { main: m.heads[MAIN], branch: m.heads[BRANCH] ?? null, bundle };
    } finally { m.done(); }
  }

  /** upload: the session's commits after main, made again with the fixed identity, to sage-lead/s<n> by fast-forward only. */
  async function upload({ commit }) {
    if (!SHA.test(commit ?? '')) refuse('commit must be the 40-character id of the session\'s commit (git rev-parse HEAD)');
    const m = await mirror();
    try {
      copyObjects(s.folder, m.repo);
      m.g(['fsck', '--strict', '--no-dangling', '--no-progress']);
      pull(m);
      if (m.g(['cat-file', '-t', commit]).trim() !== 'commit') refuse(`${commit} is not a commit of the session`);
      m.g(['rev-list', '--objects', '--quiet', commit, '--not', MAIN]); // every object of the new commits is there
      const lines = m.g(['rev-list', '--reverse', '--topo-order', '--parents', commit, '--not', MAIN]).split('\n').filter(Boolean);
      if (!lines.length) refuse(`${commit} has no commit that ${BASE} does not have: nothing to upload`);
      if (lines.length > LIMITS.commits) refuse(`the upload has ${lines.length} commits; the most is ${LIMITS.commits}`);
      const made = new Map();
      for (const line of lines) {
        const [c, ...parents] = line.split(' ');
        if (parents.length !== 1) refuse(`commit ${c} is a merge or has no parent; the broker uploads a straight line of commits on ${BASE}`);
        const paths = m.g(['diff-tree', '-r', '-z', '--name-only', '--no-renames', parents[0], c]).split('\0').filter(Boolean);
        const ci = paths.find((p) => p === '.github' || p.startsWith('.github/'));
        if (ci) refuse(`commit ${c} changes ${JSON.stringify(keep(ci))}; a session does not change .github (workflows run with the repository's rights)`);
        made.set(c, remake(m, c, made.get(parents[0]) ?? parents[0]));
      }
      const head = made.get(commit);
      const old = m.heads[BRANCH];
      if (old === head) return { branch: s.branch, head, commits: lines.length, pushed: false };
      if (old) { try { m.g(['merge-base', '--is-ancestor', BRANCH, head]); } catch { refuse(`the upload is not a fast-forward of ${s.branch}: the broker never rewrites the session's branch`); } }
      m.g(['push', '--quiet', '--no-verify', s.remote, `${head}:${BRANCH}`]); // no +, no delete, one fixed ref
      return { branch: s.branch, head, commits: lines.length, pushed: true };
    } finally { m.done(); }
  }

  /** One commit again: its tree, its message (checked) and its dates; the fixed identity; the new parent. The same input gives the same id. */
  function remake(m, c, parent) {
    const raw = m.g(['cat-file', 'commit', c]);
    const cut = raw.indexOf('\n\n');
    const head = raw.slice(0, cut < 0 ? raw.length : cut), message = cut < 0 ? '' : raw.slice(cut + 2);
    const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1];
    const when = (who) => { const d = new RegExp(`^${who} .* (\\d{1,12}) ([+-]\\d{4})$`, 'm').exec(head); return d && `@${d[1]} ${d[2]}`; };
    if (!tree || !when('author') || !when('committer')) refuse(`commit ${c} is not a commit that the broker can read`);
    textOf(`the message of commit ${c}`, message, LIMITS.message, true);
    const env = { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: when('author'),
      GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: when('committer') };
    try {
      return git(['--git-dir', m.repo, ...NEUTRAL, 'commit-tree', tree, '-p', parent, '-F', '-'], { cwd: m.repo, env: { ...envOf(m.repo, ''), ...env }, input: message }).trim();
    } catch { throw new Error('git commit-tree failed'); }
  }

  /** The session's own pull request, or null. GitHub lists by head; each answer must be of this repository and branch, else refuse. */
  async function own(number) {
    if (number !== undefined && !(Number.isSafeInteger(number) && number > 0)) refuse('number must be the number of the session\'s pull request');
    const list = await rest('GET', `/repos/${s.full}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${s.owner}:${s.branch}`)}`);
    const same = (r) => String(r?.repo?.full_name).toLowerCase() === s.full.toLowerCase();
    if (!Array.isArray(list) || !list.every((p) => p?.head?.ref === s.branch && same(p.head) && same(p.base) && Number.isSafeInteger(p.number))) {
      refuse(`GitHub's list of pull requests for ${s.branch} has one that is not this session's`);
    }
    if (list.length > 1) refuse(`${s.branch} has ${list.length} pull requests; a session has one`);
    const pr = list[0] ?? null;
    if (number !== undefined && number !== pr?.number) refuse(`#${number} is not this session's pull request${pr ? ` (#${pr.number})` : ''}`);
    return pr;
  }
  const view = (pr) => ({ number: pr.number, url: pr.html_url, state: pr.merged_at ? 'merged' : pr.state, draft: Boolean(pr.draft),
    title: keep(pr.title), body: keep(pr.body), head: pr.head.sha, base: pr.base.ref });
  const fields = ({ title, body }) => ({
    ...(title === undefined ? {} : { title: textOf('title', title, LIMITS.title, false) }),
    ...(body === undefined ? {} : { body: textOf('body', body, LIMITS.body, true) }),
  });

  const VERBS = {
    fetch: { keys: [], run: fetchVerb },
    upload: { keys: ['commit'], run: upload },
    pr_create: { keys: ['title', 'body', 'draft'], run: async (i) => {
      if (i.title === undefined || i.body === undefined) refuse('pr_create needs a title and a body');
      if (i.draft !== undefined && typeof i.draft !== 'boolean') refuse('draft must be true or false');
      const f = fields(i);
      const pr = await own();
      if (pr) refuse(`this session already has its pull request #${pr.number}; change it with pr_edit`);
      await rest('POST', `/repos/${s.full}/pulls`, { ...f, head: s.branch, base: BASE, draft: i.draft ?? false, maintainer_can_modify: false });
      return view(await own());
    } },
    pr_edit: { keys: ['number', 'title', 'body', 'base'], run: async (i) => {
      if (i.base !== undefined && i.base !== BASE) refuse(`the base of the session's pull request stays ${BASE}`);
      if (i.title === undefined && i.body === undefined) refuse('pr_edit needs a title or a body');
      const f = fields(i);
      const pr = await own(i.number);
      if (!pr) refuse('this session has no pull request yet; open it with pr_create');
      await rest('PATCH', `/repos/${s.full}/pulls/${pr.number}`, f);
      return view(await own(pr.number));
    } },
    pr_view: { keys: ['number'], run: async (i) => {
      const pr = await own(i.number);
      if (!pr) refuse('this session has no pull request yet');
      return view(pr);
    } },
  };

  /** One verb. Every answer is { ok: true, ... } or { ok: false, refused: one line }; any error refuses (fail closed). */
  async function call(verb, input = {}) {
    try {
      if (typeof verb !== 'string' || !Object.hasOwn(VERBS, verb)) refuse(`that is not a broker verb; the verbs are ${Object.keys(VERBS).join(', ')}, and none of them merges, approves or changes a branch`);
      const proto = input !== null && typeof input === 'object' && Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null) refuse(`the input of ${verb} must be an object`);
      const extra = Object.keys(input).filter((k) => !VERBS[verb].keys.includes(k));
      if (extra.length) refuse(`${verb} takes ${VERBS[verb].keys.join(', ') || 'no input'}, not ${extra.map((k) => JSON.stringify(keep(k))).join(', ')}`);
      return { ok: true, ...(await VERBS[verb].run(input)) };
    } catch (e) {
      const why = e instanceof Refusal ? e.message : `the broker could not finish ${verb} (${String(e?.message).split('\n')[0].replace(/[^ -~]/g, ' ').slice(0, 120)})`;
      return { ok: false, refused: `${why}. The broker did nothing more.` };
    }
  }
  return { call, verbs: Object.keys(VERBS), scope: s };
}

/**
 * The object files of the session's .git, copied as plain files into the broker's repository. Only the names of git objects and packs
 * pass (an allow-list): no info/alternates, which would make git read the objects of another folder. A link, a FIFO or any other
 * file that is not a regular file is refused; each file opens with O_NOFOLLOW and O_NONBLOCK. The broker's git then checks each
 * object (fsck --strict). No git command runs in the session folder.
 */
function copyObjects(folder, repo) {
  const from = join(folder, '.git', 'objects');
  for (const dir of [folder, join(folder, '.git'), from]) {
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) refuse(`${dir} is not a folder (a link is not one): the broker reads only the session's own .git folder`);
  }
  let files = 0, bytes = 0;
  const copy = (src, dst) => {
    const fd = openNoFollow(src);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) refuse(`${src} is not a plain file`);
      files += 1; bytes += st.size;
      if (files > LIMITS.files || bytes > LIMITS.bytes) refuse(`the session's .git has more than ${LIMITS.files} object files or ${LIMITS.bytes} bytes`);
      writeFileSync(dst, readFileSync(fd), { flag: 'wx', mode: 0o444 });
    } finally { closeSync(fd); }
  };
  const dir = (path) => { if (!lstatSync(path).isDirectory()) refuse(`${path} is not a folder`); return readdirSync(path); };
  for (const name of dir(from)) {
    if (/^[0-9a-f]{2}$/.test(name)) {
      mkdirSync(join(repo, 'objects', name), { recursive: true });
      for (const f of dir(join(from, name))) if (/^[0-9a-f]{38}$/.test(f)) copy(join(from, name, f), join(repo, 'objects', name, f));
    } else if (name === 'pack') {
      for (const f of dir(join(from, 'pack'))) if (/^pack-[0-9a-f]{40}\.(pack|idx)$/.test(f)) copy(join(from, 'pack', f), join(repo, 'objects', 'pack', f));
    }
  }
}
const openNoFollow = (path) => {
  try { return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return refuse(`${path} is not a plain file that the broker can read`); }
};
