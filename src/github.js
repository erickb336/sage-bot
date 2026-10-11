// The GitHub REST client of the broker (T158): one function for one request, with the credential of the broker's own GitHub
// identity (G58 a: a dedicated GitHub App or machine account, never the owner's gh login). The token comes from a function, so that
// nothing stores it here; it goes only into the Authorization header, never into a URL, an argument list or an error text.

/** A request to the GitHub REST API. `fetch` is injected: production passes globalThis.fetch, the tests the fake GitHub. */
export function githubRest({ api = 'https://api.github.com', token, fetch = globalThis.fetch }) {
  if (typeof token !== 'function') throw new TypeError('the broker needs a token function (G58 a)');
  return async (method, path, body) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await token()}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    const text = await res.text();
    // The status only: a response body can hold text of other people, and it is not the session's business.
    if (!res.ok) throw new Error(`GitHub answered ${res.status} to ${method} ${path.split('?')[0]}`);
    return text ? JSON.parse(text) : null;
  };
}
