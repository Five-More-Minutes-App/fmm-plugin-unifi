import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { FiveMoreMinutes } from '../src/fmm-client.js';
import { Blocker } from '../src/service.js';
import { Store } from '../src/store.js';
import { UniFi } from '../src/unifi.js';
import { KEY, startMock } from './mock-fmm.js';
import { IPAD, PHONE, TV, startUnifi } from './mock-unifi.js';

const cleanups = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** Polls until something is true; the plugin acts on its own schedule, so tests wait for its effects. */
async function until(check, what, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function setup({ mode = 'locked', selection = [{ mac: IPAD, label: 'iPad' }], failOpenSeconds = 300, reconcileSeconds = 60, unifiOptions = {}, fmmOptions = {}, preload } = {}) {
  const fmmServer = await startMock(fmmOptions);
  const unifiServer = await startUnifi(unifiOptions);
  const dir = mkdtempSync(join(tmpdir(), 'fmm-unifi-'));
  const store = new Store(dir);
  store.saveSettings(mode, selection);
  preload?.(store, unifiServer);

  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const blocker = new Blocker({
    fmm: new FiveMoreMinutes({ url: fmmServer.url, apiKey: KEY, timeoutMs: 2000 }),
    unifi: new UniFi({ url: unifiServer.url, username: unifiServer.username, password: unifiServer.password, timeoutMs: 2000 }),
    store,
    log,
    failOpenSeconds,
    reconcileSeconds,
    retry: { minMs: 50, maxMs: 200 },
    waitSeconds: 1,
  });

  let stopped = false;
  const stop = async (options) => { if (!stopped) { stopped = true; await blocker.stop(options); } };
  cleanups.push(async () => { await stop(); await unifiServer.close(); await fmmServer.close(); rmSync(dir, { recursive: true, force: true }); });

  return { fmmServer, unifiServer, store, blocker, logs, stop, dir };
}

const blocked = (t) => t.unifiServer.world.blockedMacs();

describe('while locked', () => {
  it('blocks the chosen device when the computer is locked, and lets it back when time is given', async () => {
    const t = await setup();
    await t.blocker.start();
    assert.deepEqual(blocked(t), [], 'nothing is locked yet');

    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 1, 'the iPad to be blocked');
    assert.deepEqual(blocked(t), [IPAD]);
    assert.deepEqual(t.store.blockedByUs, [IPAD]);

    t.fmmServer.parentStarts(15);
    await until(() => blocked(t).length === 0, 'the iPad to be let back');
    assert.deepEqual(t.store.blockedByUs, []);
  });

  it('blocks at once when it starts into a lock', async () => {
    const t = await setup();
    t.fmmServer.parentLocks(30);

    await t.blocker.start();

    await until(() => blocked(t).length === 1, 'the iPad to be blocked');
  });

  it('lets go by itself when the lock ends, without being told', async () => {
    const t = await setup();
    await t.blocker.start();

    t.fmmServer.parentLocks(0.03); // about two seconds
    await until(() => blocked(t).length === 1, 'the iPad to be blocked');
    await until(() => blocked(t).length === 0, 'the lock to end and the iPad to be let back', 6000);
  });

  it('only touches the chosen devices', async () => {
    const t = await setup({ selection: [{ mac: IPAD }, { mac: TV }] });
    await t.blocker.start();

    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 2, 'both to be blocked');

    assert.deepEqual(blocked(t), [IPAD, TV]);
    assert.ok(!blocked(t).includes(PHONE));
  });

  it('stays blocked while Five More Minutes is unreachable, until the lock would have ended anyway', async () => {
    const t = await setup();
    await t.blocker.start();
    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 1, 'the iPad to be blocked');

    await t.fmmServer.close();
    await new Promise((r) => setTimeout(r, 600));

    assert.deepEqual(blocked(t), [IPAD], 'a lock carries its own end; silence does not lift it');
    assert.equal(t.blocker.status().fmm.reachable, false);
  });
});

describe('only while there is time', () => {
  it('blocks when no timer is running and lets go while one is', async () => {
    const t = await setup({ mode: 'not-running' });
    await t.blocker.start();
    await until(() => blocked(t).length === 1, 'the iPad to be blocked, no timer running');

    t.fmmServer.parentStarts(10);
    await until(() => blocked(t).length === 0, 'the iPad to be let back');

    t.fmmServer.world.timer = null;
    t.fmmServer.parentLocks(1);
    await until(() => blocked(t).length === 1, 'it to be blocked again');
  });

  it('lets everyone back online if Five More Minutes stays out of reach past the limit', async () => {
    const t = await setup({ mode: 'not-running', failOpenSeconds: 1 });
    await t.blocker.start();
    await until(() => blocked(t).length === 1, 'the iPad to be blocked');

    await t.fmmServer.close();

    await until(() => blocked(t).length === 0, 'the fail-open release', 6000);
    assert.match(t.blocker.status().code, /out-of-reach/);
  });

  it('blocks again once Five More Minutes is reachable again', async () => {
    const t = await setup({ mode: 'not-running', failOpenSeconds: 1 });
    await t.blocker.start();
    await until(() => blocked(t).length === 1, 'blocked');

    // Make it unreachable without closing it: every request fails.
    t.fmmServer.world.failNext = 1000;
    await until(() => blocked(t).length === 0, 'the fail-open release', 6000);

    t.fmmServer.world.failNext = 0;
    await until(() => blocked(t).length === 1, 'blocked again', 6000);
  });
});

describe('respecting what it did not do', () => {
  it('never unblocks a device that was already blocked when it arrived', async () => {
    const t = await setup({
      selection: [{ mac: TV }, { mac: IPAD }],
      preload: (_store, unifi) => { const tv = unifi.world.clients.get(TV); tv.blocked = true; tv.everBlocked = true; tv.online = false; },
    });
    await t.blocker.start();

    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).includes(IPAD), 'the iPad to be blocked');
    assert.deepEqual(t.store.blockedByUs, [IPAD], 'the TV was not claimed');

    t.fmmServer.parentStarts(10);
    await until(() => !blocked(t).includes(IPAD), 'the iPad to be let back');

    assert.deepEqual(blocked(t), [TV], 'the TV is still blocked, as it was');
  });

  it('lets a device go the moment it is taken off the list', async () => {
    const t = await setup({ selection: [{ mac: IPAD }, { mac: TV }] });
    await t.blocker.start();
    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 2, 'both blocked');

    t.store.saveSettings('locked', [{ mac: TV }]);
    t.blocker.reconcile();

    await until(() => blocked(t).length === 1, 'the iPad to be let go');
    assert.deepEqual(blocked(t), [TV]);
  });

  it('puts a block back if something unblocks the device during a lock', async () => {
    const t = await setup({ reconcileSeconds: 5 });
    await t.blocker.start();
    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 1, 'blocked');

    t.unifiServer.world.clients.get(IPAD).blocked = false;
    t.blocker.reconcile();

    await until(() => blocked(t).length === 1, 'the block to be put back');
  });

  it('lets everyone back online, and forgets it, when it stops', async () => {
    const t = await setup({ selection: [{ mac: IPAD }, { mac: TV }] });
    await t.blocker.start();
    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 2, 'both blocked');

    await t.stop();

    assert.deepEqual(blocked(t), []);
    assert.deepEqual(t.store.blockedByUs, []);
  });

  it('remembers what it blocked across a restart, and lets it go if the lock is over', async () => {
    const t = await setup({
      preload: (store, unifi) => { store.claim(IPAD); const c = unifi.world.clients.get(IPAD); c.blocked = true; c.everBlocked = true; c.online = false; },
    });

    await t.blocker.start();

    await until(() => blocked(t).length === 0, 'the leftover block to be lifted');
    assert.deepEqual(t.store.blockedByUs, []);
  });
});

describe('when things fail', () => {
  it('keeps trying to reach UniFi, and says so', async () => {
    const t = await setup();
    t.unifiServer.world.dropNext = 1000;
    await t.blocker.start();
    t.fmmServer.parentLocks(30);

    await until(() => t.blocker.status().unifi.problem !== null, 'a problem to be reported');
    assert.equal(t.blocker.status().unifi.ok, false);
    assert.deepEqual(blocked(t), []);

    t.unifiServer.world.dropNext = 0;
    await until(() => blocked(t).length === 1, 'the block to happen once UniFi is back', 6000);
    await until(() => t.blocker.status().unifi.problem === null, 'the problem to clear');
  });

  it('stops asking when the key is refused, and says why', async () => {
    const t = await setup({ fmmOptions: { key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` } });

    await t.blocker.start();

    const status = t.blocker.status();
    assert.equal(status.fmm.reachable, false);
    assert.match(status.fmm.problem, /no longer accepts/);
    const requests = t.fmmServer.world.requests.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.fmmServer.world.requests.length, requests, 'it does not keep trying a key that is refused');
  });

  it('says when the key cannot see the state', async () => {
    const t = await setup({ fmmOptions: { scopes: ['timer:start'] } });

    await t.blocker.start();

    assert.match(t.blocker.status().fmm.problem, /state:read/);
  });

  it('does not block anything before it has heard from Five More Minutes', async () => {
    const t = await setup({ fmmOptions: { localOnly: true } });

    await t.blocker.start();

    assert.deepEqual(blocked(t), []);
    assert.match(t.blocker.status().fmm.problem, /local network/);
  });

  it('never puts the key or the password in a log line', async () => {
    const t = await setup();
    await t.blocker.start();
    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 1, 'blocked');
    await t.fmmServer.close();
    await new Promise((r) => setTimeout(r, 300));

    const text = t.logs.join('\n');
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes(t.unifiServer.password));
  });
});

describe('what it reports', () => {
  it('describes the situation in a form a page can translate, and includes nothing secret', async () => {
    const t = await setup();
    await t.blocker.start();
    t.fmmServer.parentLocks(30);
    await until(() => blocked(t).length === 1, 'blocked');

    const status = t.blocker.status();

    assert.equal(status.wantBlocked, true);
    assert.equal(status.code, 'locked');
    assert.equal(status.fmm.computer.name, 'Elliots laptop');
    assert.deepEqual(status.devices.map((d) => ({ mac: d.mac, blocked: d.blocked, blockedByUs: d.blockedByUs })), [{ mac: IPAD, blocked: true, blockedByUs: true }]);
    assert.equal(status.events[0].kind, 'blocked');
    assert.equal(status.events[0].name, 'iPad');

    const text = JSON.stringify(status);
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes(t.unifiServer.password));
  });
});
