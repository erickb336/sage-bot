// The GitHub REST client of the broker (T158): one function for one request, with the credential of the broker's own GitHub
// identity (G58 a: a dedicated GitHub App or machine account, never the owner's gh login). The token comes from a function, so that
// nothing stores it here; it goes only into the Authorization header, never into a URL, an argument list or an error text.

/** A refusal of the broker: one line that the session's model reads, so it names no path and holds no text from GitHub. */
export class Refusal extends Error {}

/** The short meaning of a GitHub error status (F-T191-2). */
const meaning = (status) => (status === 401 || status === 403 ? 'the broker\'s GitHub access was refused'
  : status === 404 ? 'not found' : status === 422 ? 'GitHub refused the request'
    : status >= 500 ? 'an error of GitHub' : 'an answer that the broker does not expect');

/** A request to the GitHub REST API. `fetch` is injected: production passes globalThis.fetch, the tests the fake GitHub. `signal`
 * stops the request and the reading of its answer (the broker's time limit, F-T158-18). `onSend` runs just before the request goes:
 * after it, an error can hide a change that landed (F-T191-1). */
export function githubRest({ api = 'https://api.github.com', token, fetch = globalThis.fetch }) {
  if (typeof token !== 'function') throw new TypeError('the broker needs a token function (G58 a)');
  return async (method, path, body, { signal, onSend } = {}) => {
    const authorization = `Bearer ${await token()}`;
    onSend?.();
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    const text = await res.text();
    // The method, the status and its meaning only: no path, and no response body (it can hold text of other people).
    if (!res.ok) throw new Refusal(`GitHub answered ${res.status} to ${method}: ${meaning(res.status)}`);
    return text ? JSON.parse(text) : null;
  };
}
