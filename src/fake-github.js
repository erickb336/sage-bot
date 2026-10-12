// A fake GitHub REST API for the broker's tests (T158): an in-process `fetch` for the few pull-request endpoints that the broker calls,
// and a record of every request. No network, no real token. SAMPLE DATA ONLY. Git itself goes to a local bare repository in the tests.

/**
 * @param {{ owner: string, repo: string, token: string, pulls?: object[] }} o `pulls` seeds pull requests, for example another session's.
 * Every request without `Bearer <token>`, and every endpoint that is not one of the four, answers 401 or 404, as GitHub would refuse it.
 */
export function fakeGitHub({ owner, repo, token, pulls = [] }) {
  const full = `${owner}/${repo}`;
  const calls = [];
  const state = { pulls: structuredClone(pulls) };
  const pr = (n) => state.pulls.find((p) => p.number === n);
  const answer = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, query: u.search, body });
    if (init.headers?.authorization !== `Bearer ${token}`) return answer(401, { message: 'Bad credentials' });
    const base = `/repos/${full}/pulls`;
    if (method === 'GET' && u.pathname === base) {
      const head = u.searchParams.get('head');
      return answer(200, state.pulls.filter((p) => !head || `${owner}:${p.head.ref}` === head));
    }
    if (method === 'POST' && u.pathname === base) {
      const number = Math.max(0, ...state.pulls.map((p) => p.number)) + 1;
      const made = {
        number, state: 'open', draft: body.draft, title: body.title, body: body.body, merged_at: null,
        html_url: `https://github.com/${full}/pull/${number}`,
        head: { ref: body.head, sha: '0'.repeat(40), repo: { full_name: full } }, base: { ref: body.base, repo: { full_name: full } },
      };
      state.pulls.push(made);
      return answer(201, made);
    }
    const m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(u.pathname);
    if (m && u.pathname.startsWith(base) && pr(Number(m[1]))) {
      const p = pr(Number(m[1]));
      if (method === 'GET') return answer(200, p);
      if (method === 'PATCH') {
        for (const k of ['title', 'body', 'state']) if (body[k] !== undefined) p[k] = body[k];
        if (body.base !== undefined) p.base.ref = body.base;
        return answer(200, p);
      }
    }
    return answer(404, { message: 'Not Found' });
  }
  return { fetch, calls, state };
}

/** A pull request of another branch of the same repository, as GitHub lists it: for a test that the broker refuses it. */
export const samplePull = ({ owner, repo, number, branch }) => ({
  number, state: 'open', draft: false, title: 'another session', body: 'sample', merged_at: null,
  html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
  head: { ref: branch, sha: '1'.repeat(40), repo: { full_name: `${owner}/${repo}` } }, base: { ref: 'main', repo: { full_name: `${owner}/${repo}` } },
});
