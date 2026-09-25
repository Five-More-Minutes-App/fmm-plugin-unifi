// A stand-in for a UniFi console, for tests: sign-in with a session cookie and a CSRF token, the list
// of known and connected clients, and block/unblock. It answers the way the real one does (including
// the 400 a UniFi OS console gives for a wrong password, and a session that quietly expires), over
// real HTTP or, with `tls`, real HTTPS using the throwaway certificate in test/fixtures.

import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

export const FIXTURE_FINGERPRINT = 'AD:E7:84:03:22:C3:13:5C:14:1A:B5:8D:20:C1:98:86:63:66:EA:4B:CB:84:A0:41:8B:93:51:6C:9C:62:82:94';
export const FIXTURE_CERT = fixture('test-cert.pem').toString('utf8');

export const IPAD = 'aa:bb:cc:00:00:01';
export const PHONE = 'aa:bb:cc:00:00:02';
export const TV = 'aa:bb:cc:00:00:03';

export const defaultClients = () => [
  { mac: IPAD, name: "Elliot's iPad", ip: '192.168.1.21', wired: false },
  { mac: PHONE, hostname: 'elliots-phone', ip: '192.168.1.22', wired: false },
  { mac: TV, name: 'Living room TV', ip: '192.168.1.23', wired: true },
];

/**
 * @param {{ kind?: 'unifi-os' | 'classic', username?: string, password?: string, site?: string, clients?: any[], tls?: boolean }} [options]
 */
export async function startUnifi({ kind = 'unifi-os', username = 'fmm', password = 'a-good-password', site = 'default', clients = defaultClients(), tls = false } = {}) {
  const os = kind === 'unifi-os';
  const prefix = os ? `/proxy/network/api/s/${site}` : `/api/s/${site}`;

  const world = {
    /** @type {Map<string, any>} */
    clients: new Map(clients.map((c) => [c.mac, { blocked: false, online: true, ...c }])),
    /** @type {Map<string, string>} session id -> csrf token */
    sessions: new Map(),
    /** @type {Array<{ method: string, path: string, body: any }>} */
    calls: [],
    logins: 0,
    failNext: 0,
    dropNext: 0,
    /** Ends every session, the way a console does when it restarts or a token runs out. */
    expire() { world.sessions.clear(); },
    blockedMacs: () => [...world.clients.values()].filter((c) => c.blocked).map((c) => c.mac).sort(),
  };

  const handler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;

    const reply = (status, json, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(json));
    };

    if (world.dropNext > 0) {
      world.dropNext -= 1;
      return request.socket.destroy();
    }

    const loginPath = os ? '/api/auth/login' : '/api/login';
    if (request.method === 'POST' && url.pathname === loginPath) {
      world.calls.push({ method: 'POST', path: url.pathname, body: { ...body, password: '[hidden]' } });
      world.logins += 1;
      if (world.failNext > 0) { world.failNext -= 1; return reply(500, {}); }
      if (body?.username !== username || body?.password !== password) {
        return os ? reply(400, { code: 'AUTHENTICATION_FAILED_INVALID_CREDENTIALS' }) : reply(400, { meta: { rc: 'error', msg: 'api.err.Invalid' }, data: [] });
      }
      const id = randomBytes(8).toString('hex');
      const csrf = randomBytes(8).toString('hex');
      world.sessions.set(id, csrf);
      return reply(200, os ? { unique_id: 'x' } : { meta: { rc: 'ok' }, data: [] }, {
        'set-cookie': [`${os ? 'TOKEN' : 'unifises'}=${id}; path=/; secure; httponly`, ...(os ? [] : [`csrf_token=${csrf}; path=/`])],
        ...(os ? { 'x-csrf-token': csrf } : {}),
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      world.calls.push({ method: 'POST', path: url.pathname, body });
      world.sessions.clear();
      return reply(200, {}, { 'set-cookie': ['TOKEN=; path=/; max-age=0'] });
    }

    world.calls.push({ method: request.method, path: url.pathname, body });

    const cookie = Object.fromEntries((request.headers.cookie ?? '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]));
    const session = cookie[os ? 'TOKEN' : 'unifises'];
    const csrf = world.sessions.get(session);
    if (csrf === undefined) return reply(401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' }, data: [] });
    if (request.method === 'POST' && request.headers['x-csrf-token'] !== csrf) return reply(403, { meta: { rc: 'error', msg: 'api.err.CsrfTokenMissing' }, data: [] });

    if (world.failNext > 0) { world.failNext -= 1; return reply(500, {}); }

    const ok = (data) => reply(200, { meta: { rc: 'ok' }, data });

    if (request.method === 'GET' && url.pathname === `${prefix}/rest/user`) {
      return ok([...world.clients.values()].map((c) => ({
        mac: c.mac, name: c.name, hostname: c.hostname, last_ip: c.ip, is_wired: c.wired,
        // The real one leaves the flag out for a client that has never been blocked.
        ...(c.everBlocked ? { blocked: c.blocked } : {}),
      })));
    }

    if (request.method === 'GET' && url.pathname === `${prefix}/stat/sta`) {
      return ok([...world.clients.values()].filter((c) => c.online && !c.blocked).map((c) => ({ mac: c.mac, name: c.name, hostname: c.hostname, ip: c.ip, is_wired: c.wired })));
    }

    if (request.method === 'POST' && url.pathname === `${prefix}/cmd/stamgr`) {
      const client = world.clients.get(body?.mac) ?? (() => { const fresh = { mac: body?.mac, blocked: false, online: false }; world.clients.set(body?.mac, fresh); return fresh; })();
      if (body?.cmd === 'block-sta') { client.blocked = true; client.everBlocked = true; return ok([]); }
      if (body?.cmd === 'unblock-sta') { client.blocked = false; client.everBlocked = true; return ok([]); }
      return reply(400, { meta: { rc: 'error', msg: 'api.err.InvalidCommand' }, data: [] });
    }

    return reply(404, { meta: { rc: 'error', msg: 'api.err.NotFound' }, data: [] });
  };

  const server = tls
    ? createHttps({ key: fixture('test-key.pem'), cert: fixture('test-cert.pem') }, handler)
    : createHttp(handler);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    kind,
    username,
    password,
    world,
    close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}
