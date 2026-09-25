// @ts-check
//
// One HTTPS request to the UniFi console, with the trust decision made explicitly.
//
// A UniFi console presents a certificate it made itself, so "trust the usual authorities" fails on
// most homes by default. The honest ways out are, in order of preference:
//
//   1. pin it: you tell the plugin the certificate's fingerprint, and it accepts that one and no other;
//   2. give it the certificate authority that signed it (your own, if you run one);
//   3. switch checking off, which is allowed but named "insecure" everywhere it appears.
//
// The connection is made, checked, and only then is any request written to it. That order matters:
// the request carries the UniFi password on the first call, and a pinned connection must not send
// it to a certificate that turns out to be the wrong one.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { timingSafeEqual } from 'node:crypto';

export class TransportError extends Error {
  /**
   * @param {'network' | 'tls' | 'timeout' | 'too-large'} kind
   * @param {string} message
   * @param {{ cause?: unknown, fingerprint?: string }} [details]
   */
  constructor(kind, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'TransportError';
    this.kind = kind;
    /** The certificate's fingerprint, when the failure was about the certificate. Public information. */
    this.fingerprint = details.fingerprint;
  }
}

/**
 * @typedef {{ fingerprint?: string | null, ca?: string | null, insecure?: boolean }} TlsTrust
 * @typedef {{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string }} Reply
 * @typedef {(options: { url: URL, method?: string, headers?: Record<string, string>, body?: string, tls?: TlsTrust, timeoutMs?: number }) => Promise<Reply>} Transport
 */

const MAX_BYTES = 8 * 1024 * 1024;

/** @type {Transport} */
export async function request({ url, method = 'GET', headers = {}, body, tls: trust = {}, timeoutMs = 10_000 }) {
  const secure = url.protocol === 'https:';
  const signal = AbortSignal.timeout(timeoutMs);

  /** @type {import('node:http').RequestOptions} */
  const options = {
    method,
    signal,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }), Connection: 'close' },
  };

  if (secure) {
    const socket = await connectVerified(url, trust, timeoutMs);
    // No agent: the socket that was just checked is the one, and the only one, that is used.
    options.createConnection = () => socket;
  }

  return await new Promise((resolve, reject) => {
    const send = secure ? https.request : http.request;
    const req = send(url, options, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(new TransportError('too-large', 'The UniFi console answered with far more data than expected.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (cause) => reject(failure(cause, signal)));
    });

    req.on('error', (cause) => reject(failure(cause, signal)));
    req.end(body);
  });
}

/**
 * @param {unknown} cause
 * @param {AbortSignal} signal
 */
function failure(cause, signal) {
  if (signal.aborted) return new TransportError('timeout', 'The UniFi console did not answer in time.', { cause });
  return new TransportError('network', 'Could not reach the UniFi console. Is the address right, and is it switched on?', { cause });
}

/**
 * Opens a TLS connection and does not return it until the certificate has been accepted.
 *
 * @param {URL} url
 * @param {TlsTrust} trust
 * @param {number} timeoutMs
 * @returns {Promise<tls.TLSSocket>}
 */
function connectVerified(url, trust, timeoutMs) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const pinned = trust.fingerprint ? trust.fingerprint.replace(/:/g, '').toLowerCase() : null;

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: Number(url.port || 443),
      servername: net.isIP(host) ? undefined : host,
      // A pinned or insecure connection cannot be judged by the usual rules; the pin (below) is the judge.
      rejectUnauthorized: !(pinned || trust.insecure),
      ...(trust.ca ? { ca: trust.ca } : {}),
      timeout: timeoutMs,
    });

    /** @param {TransportError} error */
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };

    socket.once('timeout', () => fail(new TransportError('timeout', 'The UniFi console did not answer in time.')));

    socket.once('error', (cause) => {
      const code = /** @type {any} */ (cause).code;
      if (typeof code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS/.test(code)) {
        fail(new TransportError('tls', `The UniFi console's certificate was not accepted (${code}). See "Trusting the certificate" in the README.`, { cause }));
      } else {
        fail(new TransportError('network', 'Could not reach the UniFi console. Is the address right, and is it switched on?', { cause }));
      }
    });

    socket.once('secureConnect', () => {
      const seen = socket.getPeerCertificate().fingerprint256 ?? '';

      if (pinned && !sameFingerprint(seen, pinned)) {
        fail(new TransportError('tls', 'The UniFi console presented a different certificate from the one pinned in UNIFI_TLS_FINGERPRINT, so nothing was sent to it.', { fingerprint: seen }));
        return;
      }

      socket.setTimeout(0);
      socket.removeAllListeners('timeout');
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
}

/**
 * Compares two SHA-256 fingerprints without leaking where they differ.
 * @param {string} seen colon-separated, any case
 * @param {string} pinnedHex hex without colons, lower case
 */
function sameFingerprint(seen, pinnedHex) {
  const a = Buffer.from(seen.replace(/:/g, '').toLowerCase());
  const b = Buffer.from(pinnedHex);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What certificate is that console presenting? Sends nothing. It exists so that setting up can say
 * "this is the fingerprint; if it is yours, pin it", which is a decision for a person, not for code.
 *
 * @param {URL} url
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} the SHA-256 fingerprint, colon-separated, upper case
 */
export function probeCertificate(url, timeoutMs = 5_000) {
  const host = url.hostname.replace(/^\[|\]$/g, '');

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: Number(url.port || 443),
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });

    socket.once('secureConnect', () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      fingerprint ? resolve(fingerprint) : reject(new TransportError('tls', 'The console did not present a certificate.'));
    });
    socket.once('timeout', () => { socket.destroy(); reject(new TransportError('timeout', 'The UniFi console did not answer in time.')); });
    socket.once('error', (cause) => reject(new TransportError('network', 'Could not reach the UniFi console.', { cause })));
  });
}
