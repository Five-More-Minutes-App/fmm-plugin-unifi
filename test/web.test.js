import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { FiveMoreMinutes } from '../src/fmm-client.js';
import { Secret } from '../src/secret.js';
import { Blocker } from '../src/service.js';
import { Store } from '../src/store.js';
import { UniFi } from '../src/unifi.js';
import { createWeb } from '../src/web.js';
import { messages } from '../public/i18n.js';
import { KEY, startMock } from './mock-fmm.js';
import { IPAD, PHONE, startUnifi } from './mock-unifi.js';

const TOKEN = 'k3J9x-pQ2mZ7vR4tB8nW1yA6';
const cleanups = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup({ now } = {}) {
  const fmmServer = await startMock();
  const unifiServer = await startUnifi({ clients: [{ mac: IPAD, name: '<img src=x onerror=alert(1)>', ip: '192.168.1.21' }, { mac: PHONE, name: 'Phone' }] });
  const dir = mkdtempSync(join(tmpdir(), 'fmm-unifi-'));
  const store = new Store(dir);
  const log = { info() {}, warn() {}, error() {} };
  const unifi = new UniFi({ url: unifiServer.url, username: unifiServer.username, password: unifiServer.password, timeoutMs: 2000 });
  const blocker = new Blocker({
    fmm: new FiveMoreMinutes({ url: fmmServer.url, apiKey: KEY, timeoutMs: 2000 }),
    unifi, store, log, failOpenSeconds: 300, reconcileSeconds: 60, retry: { minMs: 50, maxMs: 200 }, waitSeconds: 1,
  });
  const web = createWeb({
    blocker, unifi, store, log, token: new Secret(TOKEN), now,
    publicDir: new URL('../public/', import.meta.url),
    iconPath: new URL('../icon.png', import.meta.url),
  });
  const port = await web.listen(0, '127.0.0.1');
  await blocker.start();

  cleanups.push(async () => { await blocker.stop(); await web.close(); await unifiServer.close(); await fmmServer.close(); rmSync(dir, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  const call = (path, { method = 'GET', body, headers = {}, cookie, raw } = {}) => fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(method !== 'GET' ? { 'X-Requested-With': 'fmm-unifi' } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });

  const signIn = async () => {
    const response = await call('/api/login', { method: 'POST', body: { token: TOKEN } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };

  return { base, call, signIn, store, blocker, fmmServer, unifiServer, port };
}

describe('signing in', () => {
  it('serves the page to anyone, and everything else only to someone signed in', async () => {
    const t = await setup();

    assert.equal((await t.call('/')).status, 200);
    for (const path of ['/api/status', '/api/clients']) assert.equal((await t.call(path)).status, 401, path);
    assert.equal((await t.call('/api/settings', { method: 'PUT', body: { mode: 'locked', devices: [] } })).status, 401);
    assert.equal((await t.call('/api/logout', { method: 'POST' })).status, 401);
  });

  it('accepts the token and hands out a cookie scripts cannot read and other sites cannot send', async () => {
    const t = await setup();

    const response = await t.call('/api/login', { method: 'POST', body: { token: TOKEN } });
    const cookie = response.headers.get('set-cookie');

    assert.equal(response.status, 200);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.ok(!cookie.includes(TOKEN), 'the cookie is not the token');
    assert.equal((await (await t.call('/api/session', { cookie: cookie.split(';')[0] })).json()).authenticated, true);
  });

  it('refuses a wrong token, without saying how close it was', async () => {
    const t = await setup();

    for (const token of ['wrong', TOKEN.slice(0, -1), `${TOKEN}x`, '', 42]) {
      const response = await t.call('/api/login', { method: 'POST', body: { token } });
      assert.equal(response.status, 401, String(token));
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { error: 'That is not the right token.' });
    }
  });

  it('slows down someone guessing, and then refuses even the right token for a while', async () => {
    let now = 1_000_000;
    const t = await setup({ now: () => now });

    for (let i = 0; i < 5; i += 1) assert.equal((await t.call('/api/login', { method: 'POST', body: { token: `guess-${i}` } })).status, 401);

    const locked = await t.call('/api/login', { method: 'POST', body: { token: TOKEN } });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);

    now += 16 * 60 * 1000;
    assert.equal((await t.call('/api/login', { method: 'POST', body: { token: TOKEN } })).status, 200);
  });

  it('ends a session after a while, and on request', async () => {
    let now = 1_000_000;
    const t = await setup({ now: () => now });
    const cookie = await t.signIn();
    assert.equal((await t.call('/api/status', { cookie })).status, 200);

    assert.equal((await t.call('/api/logout', { method: 'POST', cookie })).status, 200);
    assert.equal((await t.call('/api/status', { cookie })).status, 401);

    const second = await t.signIn();
    now += 9 * 60 * 60 * 1000;
    assert.equal((await t.call('/api/status', { cookie: second })).status, 401);
  });

  it('does not accept a made-up or oversized session cookie', async () => {
    const t = await setup();

    for (const value of ['abc', 'x'.repeat(500), '']) {
      assert.equal((await t.call('/api/status', { cookie: `fmm_unifi_session=${value}` })).status, 401);
    }
  });
});

describe('cross-site requests', () => {
  it('refuses a change that does not carry the header only the page adds', async () => {
    const t = await setup();
    const cookie = await t.signIn();

    const response = await fetch(`${t.base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mode: 'locked', devices: [{ mac: IPAD }] }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(t.store.selection, []);
  });

  it('refuses one that comes from another origin, or another site by the browser\'s own word', async () => {
    const t = await setup();
    const cookie = await t.signIn();
    const body = { mode: 'locked', devices: [{ mac: IPAD }] };

    assert.equal((await t.call('/api/settings', { method: 'PUT', body, cookie, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await t.call('/api/settings', { method: 'PUT', body, cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await t.call('/api/settings', { method: 'PUT', body, cookie, headers: { Origin: 'not a url' } })).status, 403);
    assert.deepEqual(t.store.selection, []);

    assert.equal((await t.call('/api/settings', { method: 'PUT', body, cookie, headers: { Origin: t.base, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  });

  it('applies the same rule to signing in, so a page cannot sign someone in as itself', async () => {
    const t = await setup();

    const response = await fetch(`${t.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });

    assert.equal(response.status, 403);
  });

  it('sends no permission for other sites to read anything', async () => {
    const t = await setup();
    const response = await t.call('/api/session', { headers: { Origin: 'https://evil.example' } });

    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await t.call('/api/session', { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), null);
  });
});

describe('the settings', () => {
  it('saves them, applies them, and reports them', async () => {
    const t = await setup();
    const cookie = await t.signIn();

    const response = await t.call('/api/settings', { method: 'PUT', cookie, body: { mode: 'not-running', devices: [{ mac: 'AA-BB-CC-00-00-01', label: 'iPad' }] } });
    const status = await response.json();

    assert.equal(response.status, 200);
    assert.equal(status.mode, 'not-running');
    assert.deepEqual(status.devices.map((d) => d.mac), [IPAD]);
    assert.deepEqual(t.store.selection, [{ mac: IPAD, label: 'iPad' }]);

    // Not running is the rule, and no timer runs, so it is blocked.
    const end = Date.now() + 4000;
    while (Date.now() < end && t.unifiServer.world.blockedMacs().length === 0) await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(t.unifiServer.world.blockedMacs(), [IPAD]);
  });

  it('refuses anything that is not what it asks for', async () => {
    const t = await setup();
    const cookie = await t.signIn();
    const bad = [
      { mode: 'always', devices: [] },
      { devices: [] },
      { mode: 'locked' },
      { mode: 'locked', devices: 'all' },
      { mode: 'locked', devices: [{ mac: 'nope' }] },
      { mode: 'locked', devices: [{ mac: 'ff:ff:ff:ff:ff:ff' }] },
      { mode: 'locked', devices: [null] },
      { mode: 'locked', devices: Array.from({ length: 51 }, (_, i) => ({ mac: `aa:bb:cc:00:00:${(i * 2).toString(16).padStart(2, '0')}` })) },
    ];

    for (const body of bad) {
      const response = await t.call('/api/settings', { method: 'PUT', cookie, body });
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.deepEqual(t.store.selection, []);
  });

  it('refuses a body that is not JSON, too large, or the wrong type', async () => {
    const t = await setup();
    const cookie = await t.signIn();

    assert.equal((await t.call('/api/settings', { method: 'PUT', cookie, raw: '{nope', headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await t.call('/api/settings', { method: 'PUT', cookie, raw: '[]', headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await t.call('/api/settings', { method: 'PUT', cookie, raw: 'mode=locked', headers: { 'Content-Type': 'text/plain' } })).status, 415);

    const huge = await t.call('/api/settings', { method: 'PUT', cookie, raw: JSON.stringify({ mode: 'locked', devices: [], pad: 'x'.repeat(40_000) }), headers: { 'Content-Type': 'application/json' } }).catch(() => null);
    assert.ok(huge === null || huge.status === 413, 'refused, or the connection was cut');
  });

  it('cleans a label it is given', async () => {
    const t = await setup();
    const cookie = await t.signIn();

    await t.call('/api/settings', { method: 'PUT', cookie, body: { mode: 'locked', devices: [{ mac: IPAD, label: `x\u0007${'y'.repeat(200)}` }] } });

    assert.ok(t.store.selection[0].label.length <= 60);
    assert.ok(!/[\u0000-\u001f]/.test(t.store.selection[0].label));
  });
});

describe('what it shows', () => {
  it('lists the devices UniFi knows, as data, exactly as UniFi named them', async () => {
    const t = await setup();
    const cookie = await t.signIn();

    const { clients } = await (await t.call('/api/clients', { cookie })).json();

    assert.deepEqual(clients.map((c) => c.mac).sort(), [IPAD, PHONE]);
    assert.ok(clients.some((c) => c.name === '<img src=x onerror=alert(1)>'), 'sent as data; the page shows it as text');
  });

  it('says so when UniFi cannot be asked, without anything internal', async () => {
    const t = await setup();
    const cookie = await t.signIn();
    await t.unifiServer.close();

    const response = await t.call('/api/clients', { cookie });

    assert.equal(response.status, 502);
    const text = JSON.stringify(await response.json());
    assert.ok(!text.includes('127.0.0.1:'), 'no internal addresses');
    assert.ok(!text.includes(t.unifiServer.password));
  });

  it('never includes a secret in the status', async () => {
    const t = await setup();
    const cookie = await t.signIn();

    const text = await (await t.call('/api/status', { cookie })).text();

    for (const secret of [KEY, TOKEN, t.unifiServer.password]) assert.ok(!text.includes(secret));
  });
});

describe('the page itself', () => {
  it('is served with a policy that allows only its own scripts and styles, and no framing', async () => {
    const t = await setup();

    for (const path of ['/', '/app.js', '/i18n.js', '/style.css', '/api/session']) {
      const response = await t.call(path);
      const csp = response.headers.get('content-security-policy');

      assert.match(csp, /default-src 'none'/, path);
      assert.match(csp, /script-src 'self'/, path);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, path);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path);
    }
  });

  it('serves only its own files, and cannot be talked into another', async () => {
    const t = await setup();

    for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/.env', '/src/config.js', '/package.json', '/data/state.json', '/test/mock-fmm.js', '/public/app.js', '//etc/passwd', '/app.js/../../.env']) {
      const response = await t.call(path);
      assert.equal(response.status, 404, path);
      assert.ok(!(await response.text()).includes('ADMIN_TOKEN'), path);
    }
  });

  it('does not run inline scripts or load anything from elsewhere', async () => {
    const t = await setup();
    const html = await (await t.call('/')).text();

    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'no inline script');
    assert.doesNotMatch(html, /\son\w+\s*=/i, 'no inline handlers');
    assert.doesNotMatch(html, /https?:\/\//i, 'nothing fetched from elsewhere');
  });

  it('puts things on the screen only as text', async () => {
    const script = await (await (await setup()).call('/app.js')).text();

    assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it('answers the wrong method with 405 and an unknown path with 404', async () => {
    const t = await setup();
    const cookie = await t.signIn();

    assert.equal((await t.call('/', { method: 'POST' })).status, 405);
    assert.equal((await t.call('/api/status', { method: 'POST', cookie })).status, 405);
    assert.equal((await t.call('/api/settings', { method: 'POST', cookie, body: {} })).status, 405);
    assert.equal((await t.call('/api/nothing', { cookie })).status, 404);
  });
});

describe('the words on the page', () => {
  it('exist in every language, the same set of them', () => {
    assert.deepEqual(Object.keys(messages.sv).sort(), Object.keys(messages.en).sort());
  });

  it('keep the same placeholders in every language', () => {
    for (const key of Object.keys(messages.en)) {
      const holes = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(holes(messages.sv[key]), holes(messages.en[key]), key);
    }
  });

  it('cover every reason and every event the service can report', () => {
    for (const code of ['waiting', 'locked', 'lock-ended', 'not-locked', 'out-of-reach', 'timer-running', 'no-timer']) assert.ok(messages.en[`reason.${code}`], code);
    for (const kind of ['blocked', 'released']) assert.ok(messages.en[`event.${kind}`], kind);
  });
});
