// @ts-check
//
// The little of UniFi this plugin needs: sign in, list the devices it knows about, block one,
// unblock one. Four things, and nothing else is reachable from here: there is no method that takes a
// command name, a path or a body from the caller, so nothing above this file can be talked into
// reconfiguring the network.
//
// UniFi's local API is not officially documented. The calls below are the ones the UniFi web app
// itself makes, and the ones every home-automation integration uses; README.md says which UniFi
// versions this was written against.

import { normalizeMac, shortMac } from './mac.js';
import { request } from './transport.js';
import { Secret } from './secret.js';

export class UnifiError extends Error {
  /**
   * @param {'auth' | 'network' | 'tls' | 'rate-limited' | 'unexpected'} kind
   * @param {string} message
   * @param {{ cause?: unknown, fingerprint?: string }} [details]
   */
  constructor(kind, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'UnifiError';
    this.kind = kind;
    this.fingerprint = details.fingerprint;
  }
}

/**
 * @typedef {object} Client
 * @property {string} mac        normalised
 * @property {string} name       what to call it: the name given in UniFi, else its host name, else its address
 * @property {string | null} ip
 * @property {boolean} online
 * @property {boolean} blocked
 * @property {boolean} wired
 */

const CONTROL = /[\u0000-\u001f\u007f]/g;

export class UniFi {
  #origin;
  #username;
  #password;
  #os;
  #site;
  #tls;
  #timeoutMs;
  #transport;
  /** @type {Map<string, string>} */
  #cookies = new Map();
  #csrf = '';
  /** @type {Promise<void> | null} */
  #signingIn = null;

  /**
   * @param {{ url: string, username: string, password: Secret | string, site?: string, kind?: 'unifi-os' | 'classic',
   *           tls?: import('./transport.js').TlsTrust, timeoutMs?: number, transport?: import('./transport.js').Transport }} options
   */
  constructor({ url, username, password, site = 'default', kind = 'unifi-os', tls = {}, timeoutMs = 10_000, transport = request }) {
    this.#origin = new URL(url).origin;
    this.#username = username;
    this.#password = password instanceof Secret ? password : new Secret(password);
    this.#os = kind === 'unifi-os';
    this.#site = encodeURIComponent(site);
    this.#tls = tls;
    this.#timeoutMs = timeoutMs;
    this.#transport = transport;
  }

  get #api() {
    return this.#os ? `/proxy/network/api/s/${this.#site}` : `/api/s/${this.#site}`;
  }

  /** Signs in now, so a wrong password is found at start-up instead of in the middle of a lock. */
  async check() {
    await this.#signIn();
  }

  /**
   * Every device UniFi knows about, whether or not it is connected now, with what is blocked.
   * @returns {Promise<Client[]>}
   */
  async clients() {
    const [known, active] = await Promise.all([this.#get('/rest/user'), this.#get('/stat/sta')]);

    /** @type {Map<string, Client>} */
    const byMac = new Map();

    for (const item of known) {
      const mac = normalizeMac(item?.mac);
      if (!mac) continue;
      byMac.set(mac, {
        mac,
        name: nameOf(item, mac),
        ip: ipOf(item?.last_ip ?? item?.fixed_ip),
        online: false,
        blocked: item?.blocked === true,
        wired: item?.is_wired === true,
      });
    }

    for (const item of active) {
      const mac = normalizeMac(item?.mac);
      if (!mac) continue;
      const existing = byMac.get(mac);
      byMac.set(mac, {
        mac,
        name: existing?.name ?? nameOf(item, mac),
        ip: ipOf(item?.ip) ?? existing?.ip ?? null,
        online: true,
        blocked: existing?.blocked ?? item?.blocked === true,
        wired: item?.is_wired === true,
      });
    }

    return [...byMac.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  /**
   * Which of these devices are blocked right now. A device UniFi has never heard of is not blocked.
   * @param {Iterable<string>} macs
   * @returns {Promise<Map<string, boolean>>}
   */
  async blocked(macs) {
    const wanted = new Set(macs);
    const known = await this.#get('/rest/user');

    const blocked = new Map([...wanted].map((mac) => [mac, false]));
    for (const item of known) {
      const mac = normalizeMac(item?.mac);
      if (mac && wanted.has(mac)) blocked.set(mac, item?.blocked === true);
    }
    return blocked;
  }

  /** @param {string} mac */
  async block(mac) {
    await this.#command('block-sta', mac);
  }

  /** @param {string} mac */
  async unblock(mac) {
    await this.#command('unblock-sta', mac);
  }

  /** Ends the session. Best effort: nobody is harmed if it does not happen. */
  async close() {
    if (!this.#os || this.#cookies.size === 0) return;
    try {
      await this.#send('POST', '/api/auth/logout', undefined);
    } catch {
      // The session expires by itself.
    }
    this.#cookies.clear();
  }

  /**
   * @param {'block-sta' | 'unblock-sta'} cmd
   * @param {string} input
   */
  async #command(cmd, input) {
    // The last line of defence: only a real, unicast MAC address ever leaves here.
    const mac = normalizeMac(input);
    if (!mac) throw new TypeError('That is not a device address.');

    await this.#post('/cmd/stamgr', { cmd, mac });
  }

  /** @param {string} path */
  async #get(path) {
    return await this.#call('GET', path, undefined);
  }

  /**
   * @param {string} path
   * @param {object} body
   */
  async #post(path, body) {
    return await this.#call('POST', path, body);
  }

  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {object | undefined} body
   * @returns {Promise<any[]>}
   */
  async #call(method, path, body) {
    let reply = await this.#sendSignedIn(method, `${this.#api}${path}`, body);

    // The session may simply have expired. Sign in once more and try once more; not a loop.
    if (reply.status === 401) {
      this.#cookies.clear();
      reply = await this.#sendSignedIn(method, `${this.#api}${path}`, body);
    }

    if (reply.status === 401 || reply.status === 403) {
      throw new UnifiError('auth', 'UniFi refused this account. It needs to be an administrator of the site (a local one made for this is best).');
    }
    if (reply.status === 429) throw new UnifiError('rate-limited', 'UniFi says there have been too many requests. It will be tried again shortly.');
    if (reply.status < 200 || reply.status >= 300) throw new UnifiError('unexpected', `UniFi answered ${reply.status}, which this plugin does not know how to handle.`);

    let json;
    try {
      json = JSON.parse(reply.text);
    } catch (cause) {
      throw new UnifiError('unexpected', 'UniFi answered with something that was not JSON. Is UNIFI_URL the console and not, say, a router login page?', { cause });
    }

    if (json?.meta?.rc !== 'ok' || !Array.isArray(json?.data)) {
      throw new UnifiError('unexpected', `UniFi did not accept the request (${String(json?.meta?.msg ?? 'no reason given').slice(0, 80)}).`);
    }

    return json.data;
  }

  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {object | undefined} body
   */
  async #sendSignedIn(method, path, body) {
    if (this.#cookies.size === 0) await this.#signIn();
    return await this.#send(method, path, body);
  }

  async #signIn() {
    // Several callers at once share one sign-in instead of each starting their own.
    this.#signingIn ??= this.#doSignIn().finally(() => { this.#signingIn = null; });
    await this.#signingIn;
  }

  async #doSignIn() {
    this.#cookies.clear();
    this.#csrf = '';

    const path = this.#os ? '/api/auth/login' : '/api/login';
    const payload = { username: this.#username, password: this.#password.reveal(), ...(this.#os ? { remember: false } : {}) };
    const reply = await this.#send('POST', path, payload);

    if (reply.status === 400 || reply.status === 401 || reply.status === 403) {
      throw new UnifiError('auth', 'UniFi did not accept that user name and password. Check UNIFI_USERNAME and UNIFI_PASSWORD, and that the account is a local one.');
    }
    if (reply.status === 429) throw new UnifiError('rate-limited', 'UniFi is refusing sign-ins for a while, after too many. It will be tried again shortly.');
    if (reply.status !== 200) throw new UnifiError('unexpected', `UniFi answered ${reply.status} to the sign-in, which is not what a UniFi console does.`);
    if (this.#cookies.size === 0) throw new UnifiError('unexpected', 'UniFi accepted the sign-in but did not start a session. Is UNIFI_KIND right?');
  }

  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {object | undefined} body
   */
  async #send(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.#cookies.size > 0) headers.Cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.#csrf) headers['X-CSRF-Token'] = this.#csrf;

    let reply;
    try {
      reply = await this.#transport({
        url: new URL(path, this.#origin),
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        tls: this.#tls,
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      const e = /** @type {any} */ (error);
      throw new UnifiError(e?.kind === 'tls' ? 'tls' : 'network', String(e?.message ?? 'Could not reach the UniFi console.'), { cause: error, fingerprint: e?.fingerprint });
    }

    this.#remember(reply.headers);
    return reply;
  }

  /** @param {import('node:http').IncomingHttpHeaders} headers */
  #remember(headers) {
    for (const line of headers['set-cookie'] ?? []) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      if (at <= 0) continue;

      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      // A cookie set to nothing is the console ending the session.
      if (value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, value);

      // A self-hosted (classic) controller hands the token over as a cookie, and wants it back as a header.
      if (name === 'csrf_token' && value) this.#csrf = value;
    }

    const token = headers['x-updated-csrf-token'] ?? headers['x-csrf-token'];
    if (typeof token === 'string' && token) this.#csrf = token;
  }
}

/**
 * @param {any} item
 * @param {string} mac
 */
function nameOf(item, mac) {
  for (const candidate of [item?.name, item?.hostname]) {
    if (typeof candidate === 'string') {
      const text = candidate.replace(CONTROL, ' ').trim().slice(0, 80);
      if (text) return text;
    }
  }
  return `Device ${shortMac(mac)}`;
}

/** @param {unknown} value */
function ipOf(value) {
  return typeof value === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(value) ? value : null;
}
