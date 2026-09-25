import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { main } from '../src/main.js';
import { Store } from '../src/store.js';
import { KEY, startMock } from './mock-fmm.js';
import { FIXTURE_FINGERPRINT, IPAD, TV, startUnifi } from './mock-unifi.js';

const cleanups = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup({ fmmOptions, unifiOptions, env = {} } = {}) {
  const fmm = await startMock(fmmOptions);
  const unifi = await startUnifi(unifiOptions);
  const dir = mkdtempSync(join(tmpdir(), 'fmm-unifi-'));
  cleanups.push(async () => { await unifi.close(); await fmm.close(); rmSync(dir, { recursive: true, force: true }); });

  const lines = [];
  const environment = {
    FMM_URL: fmm.url, FMM_API_KEY: KEY,
    UNIFI_URL: unifi.url, UNIFI_USERNAME: unifi.username, UNIFI_PASSWORD: unifi.password, UNIFI_KIND: unifi.kind,
    ADMIN_TOKEN: 'k3J9x-pQ2mZ7vR4tB8nW1yA6', DATA_DIR: dir,
    ...env,
  };
  const run = async (...argv) => ({ code: await main(argv, environment, { out: (l) => lines.push(l) }), text: lines.join('\n') });
  return { fmm, unifi, dir, run, lines };
}

describe('--check', () => {
  it('says everything works when it does', async () => {
    const t = await setup();

    const { code, text } = await t.run('--check');

    assert.equal(code, 0, text);
    assert.match(text, /OK\s+Five More Minutes: the key opens "Elliots laptop"/);
    assert.match(text, /OK\s+UniFi: signed in as fmm/);
    assert.match(text, /3 devices known/);
    assert.match(text, /Everything needed is working/);
  });

  it('points out a key that can do more than this plugin needs', async () => {
    const t = await setup();

    assert.match((await t.run('--check')).text, /NOTE.*timer:start.*a smaller key is safer/);
  });

  it('says what is wrong with the key, the password, or the permission, and exits with an error', async () => {
    const wrongKey = await setup({ fmmOptions: { key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` } });
    assert.equal((await wrongKey.run('--check')).code, 1);

    const wrongPassword = await setup({ env: { UNIFI_PASSWORD: 'not-the-password' } });
    const wrong = await wrongPassword.run('--check');
    assert.equal(wrong.code, 1);
    assert.match(wrong.text, /FAIL\s+UniFi: UniFi did not accept that user name and password/);
    assert.ok(!wrong.text.includes('not-the-password'));

    const noScope = await setup({ fmmOptions: { scopes: ['timer:start'] } });
    assert.match((await noScope.run('--check')).text, /FAIL.*state:read/);
  });

  it('offers the certificate\'s fingerprint when it does not trust it, for a person to decide on', async () => {
    const t = await setup({ unifiOptions: { tls: true } });

    const { code, text } = await t.run('--check');

    assert.equal(code, 1);
    assert.match(text, /certificate was not accepted/);
    assert.ok(text.includes(`UNIFI_TLS_FINGERPRINT=${FIXTURE_FINGERPRINT}`), text);
  });

  it('works against a certificate that has been pinned', async () => {
    const t = await setup({ unifiOptions: { tls: true }, env: { UNIFI_TLS_FINGERPRINT: FIXTURE_FINGERPRINT } });

    assert.equal((await t.run('--check')).code, 0);
  });

  it('changes nothing', async () => {
    const t = await setup();
    await t.run('--check');

    assert.deepEqual(t.unifi.world.calls.filter((c) => c.body?.cmd), []);
  });
});

describe('--release', () => {
  it('lets back online what the plugin blocked, and only that', async () => {
    const t = await setup();
    // The plugin blocked the iPad; the TV was blocked by a person.
    const store = new Store(t.dir);
    store.claim(IPAD);
    for (const mac of [IPAD, TV]) { const c = t.unifi.world.clients.get(mac); c.blocked = true; c.everBlocked = true; }

    const { code, text } = await t.run('--release');

    assert.equal(code, 0, text);
    assert.deepEqual(t.unifi.world.blockedMacs(), [TV]);
    assert.deepEqual(new Store(t.dir).blockedByUs, []);
  });

  it('says so when there is nothing to do', async () => {
    const t = await setup();

    const { code, text } = await t.run('--release');

    assert.equal(code, 0);
    assert.match(text, /has not blocked anything/);
  });

  it('keeps a device on the list when it could not be let go, and exits with an error', async () => {
    const t = await setup();
    new Store(t.dir).claim(IPAD);
    t.unifi.world.dropNext = 100;

    const { code } = await t.run('--release');

    assert.equal(code, 1);
    assert.deepEqual(new Store(t.dir).blockedByUs, [IPAD]);
  });
});

describe('start-up', () => {
  it('tells you everything wrong with the setup and starts nothing', async () => {
    const lines = [];

    const code = await main([], {}, { out: (l) => lines.push(l) });

    assert.equal(code, 2);
    assert.match(lines.join('\n'), /FMM_URL is not set/);
    assert.match(lines.join('\n'), /ADMIN_TOKEN is not set/);
  });

  it('refuses an option it does not know, and prints help for --help', async () => {
    const lines = [];
    assert.equal(await main(['--nope'], {}, { out: (l) => lines.push(l) }), 2);
    assert.equal(await main(['--help'], {}, { out: (l) => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /--release/);
  });
});
