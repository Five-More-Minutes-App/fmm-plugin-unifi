// @ts-check
//
// The settings page: where a parent chooses which devices to block and when. It can change what is
// blocked on your network, so it is treated as the sensitive thing it is.
//
//   - Nothing is reachable without the admin token. The token is checked in constant time, failed
//     attempts are rate limited, and a good one earns a session cookie that page scripts cannot read
//     (HttpOnly) and other sites cannot send (SameSite=Strict).
//   - Anything that changes something must carry a header a web page on another site cannot add, and
//     must come from this site. That is the answer to cross-site request forgery, on top of SameSite.
//   - The page is served with a policy that lets it run only its own scripts, and it puts text on the
//     screen only as text: a device named `<script>` is displayed as those characters.
//   - Only four files are ever served, from a fixed list. There is no path to traverse.
//   - It says what UniFi and Five More Minutes said in general terms; it never sends a secret,
//     because none of them ever reach it.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeMac } from './mac.js';
import { cleanLabel } from './store.js';

const SESSION_COOKIE = 'fmm_unifi_session';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_SESSIONS = 20;
const MAX_BODY = 16 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS_PER_ADDRESS = 5;
const LOGIN_ATTEMPTS_ALL = 40;
const CLIENTS_CACHE_MS = 10_000;

const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/**
 * @param {{ blocker: import('./service.js').Blocker, unifi: import('./unifi.js').UniFi, store: import('./store.js').Store,
 *           token: import('./secret.js').Secret, cookieSecure?: boolean, publicDir: URL | string, iconPath: URL | string,
 *           log: { info: (m: string) => void, warn: (m: string) => void }, now?: () => number }} options
 */
export function createWeb({ blocker, unifi, store, token, cookieSecure = false, publicDir, iconPath, log, now = Date.now }) {
  const dir = typeof publicDir === 'string' ? new URL(`file:///${publicDir.replace(/\\/g, '/')}/`) : publicDir;

  /** The only files that are ever served. Read once: nothing about a request can pick a different one. */
  const assets = new Map([
    ['/', asset(new URL('index.html', dir), 'text/html; charset=utf-8')],
    ['/app.js', asset(new URL('app.js', dir), 'text/javascript; charset=utf-8')],
    ['/i18n.js', asset(new URL('i18n.js', dir), 'text/javascript; charset=utf-8')],
    ['/style.css', asset(new URL('style.css', dir), 'text/css; charset=utf-8')],
    ['/icon.png', asset(iconPath, 'image/png')],
  ]);

  const tokenHash = sha256(token.reveal());

  /** @type {Map<string, number>} hash of the session id -> when it ends */
  const sessions = new Map();
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const failures = new Map();
  let failuresAll = { count: 0, resetAt: 0 };

  /** @type {{ at: number, clients: Promise<any[]> } | null} */
  let clientsCache = null;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      // Nothing about what went wrong is worth telling whoever asked.
      log.warn(`Settings page: unexpected error handling ${req.method} (${error instanceof Error ? error.name : 'unknown'}).`);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
      else res.end();
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    const page = assets.get(path);
    if (page) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
      res.writeHead(200, { ...HEADERS, 'Content-Type': page.type, 'Content-Length': page.body.length });
      return res.end(method === 'HEAD' ? undefined : page.body);
    }

    if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

    // -- Reads that need nothing -------------------------------------------------------------
    if (path === '/api/session') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return send(res, 200, { authenticated: sessionOf(req) !== null });
    }

    // -- Everything else changes something or shows something, and has to be from this site --
    if (method !== 'GET') {
      const problem = crossSiteProblem(req);
      if (problem) return send(res, 403, { error: problem });
    }

    if (path === '/api/login') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return await login(req, res);
    }

    const session = sessionOf(req);
    if (session === null) return send(res, 401, { error: 'Sign in first.' });

    switch (path) {
      case '/api/logout':
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        sessions.delete(session);
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });

      case '/api/status':
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return send(res, 200, blocker.status());

      case '/api/clients':
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return await clients(res);

      case '/api/settings':
        if (method !== 'PUT') return methodNotAllowed(res, 'PUT');
        return await settings(req, res);

      default:
        return send(res, 404, { error: 'Not found.' });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function login(req, res) {
    const address = req.socket.remoteAddress ?? 'unknown';
    const at = now();

    const mine = failures.get(address);
    if (mine && mine.resetAt > at && mine.count >= LOGIN_ATTEMPTS_PER_ADDRESS) return tooMany(res, mine.resetAt - at);
    if (failuresAll.resetAt > at && failuresAll.count >= LOGIN_ATTEMPTS_ALL) return tooMany(res, failuresAll.resetAt - at);

    const body = await readJson(req, res);
    if (body === undefined) return;

    const given = typeof body?.token === 'string' ? body.token.slice(0, 256) : '';
    if (!timingSafeEqual(sha256(given), tokenHash)) {
      const entry = mine && mine.resetAt > at ? mine : { count: 0, resetAt: at + LOGIN_WINDOW_MS };
      entry.count += 1;
      failures.set(address, entry);
      if (failuresAll.resetAt <= at) failuresAll = { count: 0, resetAt: at + LOGIN_WINDOW_MS };
      failuresAll.count += 1;
      if (failures.size > 1000) failures.clear();

      log.warn(`Settings page: a sign-in with the wrong token from ${address}.`);
      return send(res, 401, { error: 'That is not the right token.' });
    }

    failures.delete(address);

    // Sessions that have ended are forgotten, and there are never many: it is one household.
    for (const [id, ends] of sessions) if (ends <= at) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(/** @type {string} */ (sessions.keys().next().value));

    const id = randomBytes(32).toString('base64url');
    sessions.set(sha256(id).toString('hex'), at + SESSION_SECONDS * 1000);

    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(id, SESSION_SECONDS) });
  }

  /** @param {import('node:http').ServerResponse} res */
  async function clients(res) {
    const at = now();
    if (!clientsCache || at - clientsCache.at > CLIENTS_CACHE_MS) {
      const promise = unifi.clients();
      clientsCache = { at, clients: promise };
      // A failure is not remembered: the next look asks again.
      promise.catch(() => { if (clientsCache?.clients === promise) clientsCache = null; });
    }

    try {
      return send(res, 200, { clients: await clientsCache.clients });
    } catch (error) {
      return send(res, 502, { error: error instanceof Error ? error.message : 'Could not ask UniFi.' });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function settings(req, res) {
    const body = await readJson(req, res);
    if (body === undefined) return;

    if (body?.mode !== 'locked' && body?.mode !== 'not-running') return send(res, 400, { error: 'Choose when to block: "locked" or "not-running".' });
    if (!Array.isArray(body.devices)) return send(res, 400, { error: 'Send the devices as a list.' });
    if (body.devices.length > 50) return send(res, 400, { error: 'Choose at most 50 devices.' });

    /** @type {Array<{ mac: string, label: string }>} */
    const devices = [];
    for (const item of body.devices) {
      const mac = normalizeMac(item?.mac);
      if (!mac) return send(res, 400, { error: 'One of the devices does not have a valid address.' });
      devices.push({ mac, label: cleanLabel(item?.label) });
    }

    store.saveSettings(body.mode, devices);
    blocker.reconcile();
    return send(res, 200, blocker.status());
  }

  /**
   * The page's own scripts add the header; a page on another site cannot, without a cross-origin
   * permission this server never gives.
   * @param {import('node:http').IncomingMessage} req
   * @returns {string | null}
   */
  function crossSiteProblem(req) {
    if (req.headers['x-requested-with'] !== 'fmm-unifi') return 'Not accepted: this has to come from the settings page.';

    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'Not accepted: this has to come from the settings page.';

    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (new URL(origin).host !== req.headers.host) return 'Not accepted: this has to come from the settings page.';
      } catch {
        return 'Not accepted: this has to come from the settings page.';
      }
    }
    return null;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {string | null} the session's key, if there is a live session
   */
  function sessionOf(req) {
    const value = /** @type {string | undefined} */ (req.headers.cookie)
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);

    if (!value || value.length > 100) return null;

    const key = sha256(value).toString('hex');
    const ends = sessions.get(key);
    if (ends === undefined) return null;
    if (ends <= now()) {
      sessions.delete(key);
      return null;
    }
    return key;
  }

  /**
   * @param {string} value
   * @param {number} maxAge
   */
  function cookie(value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecure ? '; Secure' : ''}`;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<any | undefined>} the parsed body, or undefined after having answered
   */
  async function readJson(req, res) {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      send(res, 415, { error: 'Send JSON.' });
      return undefined;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(res, 413, { error: 'That is too much to accept.' }, { Connection: 'close' });
        req.destroy();
        return undefined;
      }
      chunks.push(chunk);
    }

    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch {
      send(res, 400, { error: 'That was not understood.' });
      return undefined;
    }
  }

  return {
    server,
    /**
     * @param {number} port
     * @param {string} host
     * @returns {Promise<number>} the port it is listening on
     */
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      });
    },
  };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [extra]
 */
function send(res, status, body, extra = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), ...extra });
  res.end(json);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} allow
 */
function methodNotAllowed(res, allow) {
  send(res, 405, { error: 'That is not allowed here.' }, { Allow: allow });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} ms
 */
function tooMany(res, ms) {
  send(res, 429, { error: 'Too many wrong tries. Wait a while and try again.' }, { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) });
}

/**
 * @param {URL | string} location
 * @param {string} type
 */
function asset(location, type) {
  return { type, body: readFileSync(location) };
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest();
}
