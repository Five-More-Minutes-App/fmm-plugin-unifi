// @ts-check
//
// The Five More Minutes client, copied unchanged from fmm-plugin-template-node (src/client.js). It is
// deliberately a copy and not a dependency: a plugin that can cut a child's internet should have
// nothing in it that changes without a commit here.
//
// It is a small client for the Five More Minutes plugin API (v1) with no dependencies: it uses the
// fetch that Node already has.
//
// What it will not do, on purpose:
//   - It never puts your key in an error message, a log line, or the output of console.log(client).
//   - It refuses a key that is not shaped like one, so a typo fails at start-up, not at three in the morning.
//   - It does not follow redirects. The plugin API does not redirect, so a redirect means something
//     is in the way, and following it would send your key to wherever it points.
//
// The API itself is described in the public API reference at https://api.fivemoreminutes.app/docs.

import { inspect } from 'node:util';

/** Where the API lives, under whatever address the service is reached at. */
const BASE_PATH = '/api/integrations/v1';

/** What a key looks like: fmmk_ + 32 hex characters + _ + 43 url-safe characters. */
const KEY_SHAPE = /^fmmk_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;

/**
 * What went wrong, in a form a program can act on. `kind` is one of:
 *
 * | kind            | meaning                                                          | worth retrying? |
 * |-----------------|------------------------------------------------------------------|-----------------|
 * | `config`        | The address or the key is not usable. Fix the setup.             | no              |
 * | `auth`          | The key was refused: wrong, revoked or expired.                  | no              |
 * | `network-only`  | The service will only answer from the local network.             | no              |
 * | `forbidden`     | The key is valid but lacks a permission this call needs.         | no              |
 * | `not-possible`  | The computer is not in a state that allows it (e.g. nothing running to extend). | no |
 * | `invalid`       | The request itself was wrong.                                    | no              |
 * | `rate-limited`  | Too many requests. `retryAfter` says how long to wait.           | yes             |
 * | `network`       | Could not reach the service at all.                              | yes             |
 * | `unexpected`    | The service answered with something this client did not expect.  | yes             |
 */
export class FmmError extends Error {
  /**
   * @param {'config'|'auth'|'network-only'|'forbidden'|'not-possible'|'invalid'|'rate-limited'|'network'|'unexpected'} kind
   * @param {string} message
   * @param {{ status?: number, retryAfter?: number, cause?: unknown }} [details]
   */
  constructor(kind, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'FmmError';
    this.kind = kind;
    this.status = details.status;
    this.retryAfter = details.retryAfter;
  }

  /** Whether trying the same thing again later could work. */
  get retryable() {
    return this.kind === 'rate-limited' || this.kind === 'network' || this.kind === 'unexpected';
  }
}

/**
 * @typedef {{ id: string, name: string, online: boolean }} Computer
 * @typedef {{ id: string, startsAt: string, endsAt: string, secondsLeft: number, message: string | null }} Timer
 * @typedef {{ startsAt: string, endsAt: string, secondsLeft: number, mode: string }} Lock
 * @typedef {{ apiVersion: number, serverTime: string, signal: number, device: Computer, timer: Timer | null, lock: Lock | null }} State
 * @typedef {{ apiVersion: number, key: { id: string, name: string, pluginId: string | null, scopes: string[], createdAt: string, expiresAt: string | null, lastUsedAt: string | null }, device: { id: string, name: string } }} Me
 */

export class FiveMoreMinutes {
  #base;
  #key;
  #fetch;
  #timeoutMs;

  /**
   * @param {{ url: string, apiKey: string, timeoutMs?: number, fetch?: typeof fetch }} options
   *   `url` is where Five More Minutes can be reached from here, e.g. http://192.168.1.10:5072
   */
  constructor({ url, apiKey, timeoutMs = 10_000, fetch: fetchImpl = globalThis.fetch }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new FmmError('config', `"${url}" is not a web address. Use something like http://192.168.1.10:5072`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new FmmError('config', 'The address has to start with http:// or https://');
    }

    if (parsed.username || parsed.password) {
      throw new FmmError('config', 'Do not put a user name or password in the address. The key goes in FMM_API_KEY.');
    }

    if (typeof apiKey !== 'string' || !KEY_SHAPE.test(apiKey)) {
      // Deliberately does not say what was given.
      throw new FmmError('config', 'That does not look like a Five More Minutes API key. It starts with fmmk_ and is 81 characters long.');
    }

    this.#base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${BASE_PATH}`;
    this.#key = apiKey;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  /** Keeps the key out of console.log(client), util.inspect and JSON.stringify. */
  [inspect.custom]() {
    return `FiveMoreMinutes { ${this.#base} }`;
  }

  toJSON() {
    return { base: this.#base };
  }

  /** Who this key is, what it may do, and which computer it opens. Call it first: it proves the address and key work. */
  async me() {
    return /** @type {Promise<Me>} */ (this.#request('GET', '/me'));
  }

  /**
   * The computer's timer and lock. With `wait` (seconds, up to 25) the request is held open until
   * something changes, so a plugin hears about a change at once instead of polling for it.
   *
   * @param {{ wait?: number, since?: number, signal?: AbortSignal }} [options]
   *   `since` is the `signal` from the last state you saw; without it the answer is immediate.
   */
  async state({ wait, since, signal } = {}) {
    /** @type {Record<string, string>} */
    const query = {};
    if (wait !== undefined) query.wait = String(Math.max(1, Math.min(25, Math.trunc(wait))));
    if (since !== undefined) query.since = String(since);

    // A held-open request has to be allowed to last as long as the wait.
    const timeoutMs = wait === undefined ? this.#timeoutMs : this.#timeoutMs + wait * 1000;
    return /** @type {Promise<State>} */ (this.#request('GET', '/state', { query, signal, timeoutMs }));
  }

  /**
   * Start time. Give `minutes` or `until` ("20:00", in the household's time zone), not both.
   * Starting during a lock lifts the lock.
   *
   * @param {{ minutes?: number, until?: string, message?: string }} options
   */
  async start({ minutes, until, message }) {
    return /** @type {Promise<State>} */ (this.#request('POST', '/timer/start', { body: { minutes, until, message } }));
  }

  /**
   * Add time to what is running. Without `minutes`, the household's usual "five more minutes".
   * @param {number} [minutes]
   */
  async extend(minutes) {
    return /** @type {Promise<State>} */ (this.#request('POST', '/timer/extend', { body: { minutes } }));
  }

  /** Time is up, now: the timer ends and the lock the rules ask for begins. */
  async stop() {
    return /** @type {Promise<State>} */ (this.#request('POST', '/timer/stop'));
  }

  /** Let go: the timer ends and nothing else happens. The computer is simply free. */
  async cancel() {
    return /** @type {Promise<State>} */ (this.#request('POST', '/timer/cancel'));
  }

  /**
   * Follows the computer as it changes: yields the state now, then again each time it changes.
   * Reconnects by itself when the network drops; stops with the error when it cannot help, such as
   * when the key is revoked.
   *
   * @param {{ signal?: AbortSignal, waitSeconds?: number, backoff?: { minMs?: number, maxMs?: number } }} [options]
   * @returns {AsyncGenerator<State, void, void>}
   */
  async *watch({ signal, waitSeconds = 25, backoff = {} } = {}) {
    const { minMs = 1_000, maxMs = 60_000 } = backoff;
    let since;
    let delay = minMs;

    while (!signal?.aborted) {
      try {
        const state = await this.state({ wait: waitSeconds, since, signal });
        since = state.signal;
        delay = minMs;
        yield state;
      } catch (error) {
        if (signal?.aborted) return;

        // Nothing to be done about these by trying again: tell the caller, who can tell a person.
        if (error instanceof FmmError && !error.retryable) throw error;

        const wait = error instanceof FmmError && error.retryAfter ? error.retryAfter * 1000 : delay;
        await sleep(wait + Math.floor(Math.random() * 250), signal);
        delay = Math.min(delay * 2, maxMs);
      }
    }
  }

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {{ query?: Record<string, string>, body?: object, signal?: AbortSignal, timeoutMs?: number }} [options]
   */
  async #request(method, path, { query, body, signal, timeoutMs = this.#timeoutMs } = {}) {
    const url = new URL(`${this.#base}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    /** @type {Response} */
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: 'manual',
        signal: combined,
        headers: {
          Authorization: `Bearer ${this.#key}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        // Undefined fields are left out rather than sent as null.
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new FmmError('network', `Could not reach Five More Minutes at ${new URL(this.#base).origin}. Is it running, and is this on the same network?`, { cause });
    }

    if (response.status >= 300 && response.status < 400) {
      throw new FmmError('unexpected', 'The service redirected the request, which it never does. Something is in the way; check the address.', { status: response.status });
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch (cause) {
        throw new FmmError('unexpected', 'The service answered with something that was not JSON.', { status: response.status, cause });
      }
    }

    throw await problemFrom(response);
  }
}

/**
 * Turns a refusal into an error a program can act on.
 * @param {Response} response
 */
async function problemFrom(response) {
  /** @type {{ type?: string, detail?: string, title?: string }} */
  let problem = {};
  try {
    problem = await response.json();
  } catch {
    // Not every refusal has a body.
  }

  const detail = problem.detail ?? problem.title ?? response.statusText;
  const details = { status: response.status };

  switch (response.status) {
    case 401:
      return new FmmError('auth', 'The API key was not accepted. It may have been revoked or have expired; make a new one in the portal.', details);
    case 403:
      return problem.type?.endsWith('/local-network-only')
        ? new FmmError('network-only', 'Five More Minutes only answers plugins on the local network. Run this on the same network as the service.', details)
        : new FmmError('forbidden', detail, details);
    case 404:
    case 409:
      return new FmmError('not-possible', detail, details);
    case 400:
      return new FmmError('invalid', detail, details);
    case 429: {
      const seconds = Number(response.headers.get('retry-after'));
      return new FmmError('rate-limited', detail, { ...details, retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined });
    }
    default:
      return new FmmError('unexpected', `The service answered ${response.status}.`, details);
  }
}

/**
 * Waits, and stops waiting the moment the signal is aborted.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    const timer = setTimeout(() => resolve(undefined), ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
  });
}
