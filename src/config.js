// @ts-check
//
// Everything the plugin is told, read once at start-up and checked all together, so that someone
// setting it up is told everything wrong with the setup in one go instead of one line per restart.
//
// Secrets can be given either directly (FMM_API_KEY=...) or as the path to a file that holds them
// (FMM_API_KEY_FILE=/run/secrets/fmm_key), which is what Docker and Kubernetes secrets provide.

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { FiveMoreMinutes, FmmError } from './fmm-client.js';
import { Secret } from './secret.js';

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`The plugin is not set up correctly:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * @typedef {object} Config
 * @property {{ url: string, apiKey: Secret }} fmm
 * @property {{ url: string, username: string, password: Secret, site: string, kind: 'unifi-os' | 'classic',
 *              tls: { fingerprint: string | null, ca: string | null, insecure: boolean } }} unifi
 * @property {{ token: Secret, port: number, host: string, cookieSecure: boolean }} admin
 * @property {string} dataDir
 * @property {number} failOpenSeconds
 * @property {number} reconcileSeconds
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ readFile?: (path: string) => string }} [io]
 * @returns {Config}
 */
export function loadConfig(env = process.env, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  /** @type {string[]} */
  const problems = [];

  /**
   * @param {string} name
   * @param {{ required?: boolean, fallback?: string }} [options]
   */
  const read = (name, { required = false, fallback } = {}) => {
    const direct = clean(env[name]);
    const file = clean(env[`${name}_FILE`]);

    if (direct && file) {
      problems.push(`Set ${name} or ${name}_FILE, not both.`);
      return undefined;
    }

    if (file) {
      try {
        // A secret file usually ends with a newline; a secret does not.
        const value = readFile(file).replace(/\r?\n$/, '');
        if (value) return value;
        problems.push(`${name}_FILE (${file}) is empty.`);
      } catch {
        problems.push(`${name}_FILE points at ${file}, which could not be read.`);
      }
      return undefined;
    }

    if (direct) return direct;
    if (required) problems.push(`${name} is not set.${HINTS[name] ? ` ${HINTS[name]}` : ''}`);
    return fallback;
  };

  // --- Five More Minutes ---------------------------------------------------------------------
  const fmmUrl = read('FMM_URL', { required: true });
  const fmmKey = read('FMM_API_KEY', { required: true });
  if (fmmUrl && fmmKey) {
    try {
      // The client is the judge of what a good address and key look like; it never echoes the key.
      new FiveMoreMinutes({ url: fmmUrl, apiKey: fmmKey });
    } catch (error) {
      problems.push(error instanceof FmmError ? `FMM_URL / FMM_API_KEY: ${error.message}` : 'FMM_URL / FMM_API_KEY are not usable.');
    }
  }

  // --- UniFi ---------------------------------------------------------------------------------
  const unifiUrl = validateUnifiUrl(read('UNIFI_URL', { required: true }), problems);
  const unifiUser = read('UNIFI_USERNAME', { required: true });
  const unifiPass = read('UNIFI_PASSWORD', { required: true });

  const site = read('UNIFI_SITE', { fallback: 'default' }) ?? 'default';
  // The site name goes into a URL path, so it is held to what UniFi itself allows for one.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(site)) problems.push('UNIFI_SITE may only contain letters, digits, - and _. It is usually "default".');

  const kind = read('UNIFI_KIND', { fallback: 'unifi-os' });
  if (kind !== 'unifi-os' && kind !== 'classic') problems.push('UNIFI_KIND must be "unifi-os" (a UniFi console such as a Dream Machine) or "classic" (a self-hosted Network Application).');

  const fingerprint = parseFingerprint(read('UNIFI_TLS_FINGERPRINT'), problems);
  const caFile = read('UNIFI_CA_FILE');
  const insecure = parseBool(read('UNIFI_INSECURE_TLS'), 'UNIFI_INSECURE_TLS', problems);

  const chosen = [fingerprint, caFile, insecure ? 'x' : null].filter(Boolean).length;
  if (chosen > 1) problems.push('Choose one way to trust the UniFi certificate: UNIFI_TLS_FINGERPRINT, UNIFI_CA_FILE or UNIFI_INSECURE_TLS.');

  /** @type {string | null} */
  let ca = null;
  if (caFile) {
    try {
      ca = readFile(caFile);
      if (!ca.includes('BEGIN CERTIFICATE')) problems.push(`UNIFI_CA_FILE (${caFile}) does not look like a PEM certificate.`);
    } catch {
      problems.push(`UNIFI_CA_FILE points at ${caFile}, which could not be read.`);
    }
  }

  // --- The admin page ------------------------------------------------------------------------
  const adminToken = read('ADMIN_TOKEN', { required: true });
  if (adminToken !== undefined) {
    if (adminToken.length < 16) problems.push('ADMIN_TOKEN is too short. Use at least 16 characters; 24 random ones is better.');
    else if (new Set(adminToken).size < 6) problems.push('ADMIN_TOKEN is too guessable. Use random characters.');
  }

  const port = parseInteger(read('PORT', { fallback: '8099' }), 'PORT', 1, 65535, problems);
  const host = read('HOST', { fallback: '127.0.0.1' }) ?? '127.0.0.1';
  if (!isIP(host) && host !== 'localhost') problems.push('HOST must be an IP address such as 127.0.0.1 (this computer only) or 0.0.0.0 (the whole network).');
  const cookieSecure = parseBool(read('COOKIE_SECURE'), 'COOKIE_SECURE', problems);

  // --- Behaviour -----------------------------------------------------------------------------
  const failOpenSeconds = parseInteger(read('FAIL_OPEN_SECONDS', { fallback: '300' }), 'FAIL_OPEN_SECONDS', 30, 86_400, problems);
  const reconcileSeconds = parseInteger(read('RECONCILE_SECONDS', { fallback: '60' }), 'RECONCILE_SECONDS', 5, 3_600, problems);
  const dataDir = read('DATA_DIR', { fallback: './data' }) ?? './data';

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    fmm: { url: /** @type {string} */ (fmmUrl), apiKey: new Secret(/** @type {string} */ (fmmKey)) },
    unifi: {
      url: /** @type {string} */ (unifiUrl),
      username: /** @type {string} */ (unifiUser),
      password: new Secret(/** @type {string} */ (unifiPass)),
      site,
      kind: /** @type {'unifi-os' | 'classic'} */ (kind),
      tls: { fingerprint, ca, insecure },
    },
    admin: { token: new Secret(/** @type {string} */ (adminToken)), port, host, cookieSecure },
    dataDir,
    failOpenSeconds,
    reconcileSeconds,
  });
}

const HINTS = /** @type {Record<string, string>} */ ({
  FMM_URL: 'It is where Five More Minutes is reached from here, for example http://192.168.1.10:5072.',
  FMM_API_KEY: 'Make one in the Five More Minutes portal under Plugins.',
  UNIFI_URL: 'It is the address of your UniFi console, for example https://192.168.1.1.',
  UNIFI_USERNAME: 'Use a local account made for this, not your own.',
  UNIFI_PASSWORD: 'It is the password of that account.',
  ADMIN_TOKEN: 'It is the password for this plugin\'s settings page. Make one with: node -e "console.log(require(\'crypto\').randomBytes(18).toString(\'base64url\'))"',
});

/** @param {string | undefined} value */
function clean(value) {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * @param {string | undefined} value
 * @param {string[]} problems
 */
function validateUnifiUrl(value, problems) {
  if (value === undefined) return undefined;

  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push(`UNIFI_URL "${value}" is not a web address. Use something like https://192.168.1.1`);
    return undefined;
  }

  if (url.username || url.password) {
    problems.push('Do not put a user name or password in UNIFI_URL. Use UNIFI_USERNAME and UNIFI_PASSWORD.');
    return undefined;
  }

  // The user name and password go to this address, so it has to be private: https, except on this computer.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    problems.push('UNIFI_URL must start with https://. Your UniFi login is sent to it.');
    return undefined;
  }

  return url.origin;
}

/**
 * @param {string | undefined} value
 * @param {string[]} problems
 */
function parseFingerprint(value, problems) {
  if (value === undefined) return null;

  const hex = value.replace(/[:\s]/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    problems.push('UNIFI_TLS_FINGERPRINT must be the certificate\'s SHA-256 fingerprint: 64 hexadecimal characters, with or without colons.');
    return null;
  }

  return /** @type {RegExpMatchArray} */ (hex.toUpperCase().match(/.{2}/g)).join(':');
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @param {string[]} problems
 */
function parseBool(value, name, problems) {
  if (value === undefined) return false;

  const text = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;

  problems.push(`${name} must be true or false.`);
  return false;
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {string[]} problems
 */
function parseInteger(value, name, min, max, problems) {
  const number = Number(value);
  if (!/^\d+$/.test(value ?? '') || number < min || number > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}.`);
    return min;
  }
  return number;
}
