import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { UniFi, UnifiError } from '../src/unifi.js';
import { probeCertificate } from '../src/transport.js';
import { FIXTURE_CERT, FIXTURE_FINGERPRINT, IPAD, PHONE, TV, startUnifi } from './mock-unifi.js';

const open = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });

async function connect(options = {}, client = {}) {
  const server = await startUnifi(options);
  open.push(server);
  const unifi = new UniFi({ url: server.url, username: server.username, password: server.password, kind: server.kind, ...client });
  return { server, unifi };
}

for (const kind of ['unifi-os', 'classic']) {
  describe(`a ${kind} console`, () => {
    it('signs in and lists what it knows, online devices first', async () => {
      const { unifi } = await connect({ kind });

      const clients = await unifi.clients();

      assert.equal(clients.length, 3);
      assert.deepEqual(clients.map((c) => c.name).sort(), ["Elliot's iPad", 'Living room TV', 'elliots-phone']);
      const ipad = clients.find((c) => c.mac === IPAD);
      assert.deepEqual({ ip: ipad.ip, online: ipad.online, blocked: ipad.blocked, wired: ipad.wired }, { ip: '192.168.1.21', online: true, blocked: false, wired: false });
    });

    it('blocks a device and says so, and unblocks it again', async () => {
      const { server, unifi } = await connect({ kind });

      await unifi.block(IPAD);
      assert.deepEqual(server.world.blockedMacs(), [IPAD]);
      assert.equal((await unifi.blocked([IPAD, PHONE])).get(IPAD), true);
      assert.equal((await unifi.blocked([IPAD, PHONE])).get(PHONE), false);

      // A blocked device is no longer connected, but is still known, and still shows as blocked.
      const listed = (await unifi.clients()).find((c) => c.mac === IPAD);
      assert.equal(listed.blocked, true);
      assert.equal(listed.online, false);

      await unifi.unblock(IPAD);
      assert.deepEqual(server.world.blockedMacs(), []);
    });

    it('signs in once for many calls, and again when the session expires', async () => {
      const { server, unifi } = await connect({ kind });

      await unifi.clients();
      await unifi.clients();
      assert.equal(server.world.logins, 1);

      server.world.expire();
      await unifi.block(TV);

      assert.equal(server.world.logins, 2);
      assert.deepEqual(server.world.blockedMacs(), [TV]);
    });

    it('sends the CSRF token a console requires on a change', async () => {
      // The mock refuses a POST without it (403), so success is the proof.
      const { server, unifi } = await connect({ kind });
      await unifi.block(PHONE);
      assert.deepEqual(server.world.blockedMacs(), [PHONE]);
    });
  });
}

describe('signing in', () => {
  it('says plainly that the password was not accepted', async () => {
    const { unifi } = await connect({}, { password: 'wrong' });

    await assert.rejects(unifi.check(), (e) => e instanceof UnifiError && e.kind === 'auth' && /user name and password/.test(e.message));
  });

  it('never puts the password in an error or in anything that prints the client', async () => {
    const { unifi } = await connect({}, { password: 'super-secret-password' });

    const error = await unifi.check().catch((e) => e);

    for (const text of [error.message, String(error.stack), inspect(unifi, { depth: 5 }), JSON.stringify(unifi)]) {
      assert.ok(!text.includes('super-secret-password'));
    }
  });

  it('shares one sign-in between calls made together', async () => {
    const { server, unifi } = await connect();

    await Promise.all([unifi.clients(), unifi.clients(), unifi.blocked([IPAD])]);

    assert.equal(server.world.logins, 1);
  });

  it('does not keep asking forever when the account is refused after signing in', async () => {
    const { server, unifi } = await connect();
    await unifi.clients();
    // The console signs us in fine but then refuses everything.
    server.world.sessions.clear();
    const original = server.world.sessions.get.bind(server.world.sessions);
    server.world.sessions.get = () => undefined;

    await assert.rejects(unifi.clients(), (e) => e.kind === 'auth');
    assert.ok(server.world.logins <= 2, `signed in ${server.world.logins} times`);
    server.world.sessions.get = original;
  });
});

describe('when things go wrong', () => {
  it('reports a console that cannot be reached', async () => {
    const { server, unifi } = await connect();
    await server.close();

    await assert.rejects(unifi.clients(), (e) => e instanceof UnifiError && e.kind === 'network');
  });

  it('reports a dropped connection as a network problem', async () => {
    const { server, unifi } = await connect();
    server.world.dropNext = 1;

    await assert.rejects(unifi.check(), (e) => e.kind === 'network');
  });

  it('reports an answer it does not understand without guessing', async () => {
    const { server, unifi } = await connect();
    await unifi.check();
    server.world.failNext = 1;

    await assert.rejects(unifi.clients(), (e) => e.kind === 'unexpected' && /500/.test(e.message));
  });

  it('ignores clients with addresses that are not addresses', async () => {
    const { unifi } = await connect({ clients: [{ mac: 'not-a-mac', name: 'x' }, { mac: IPAD, name: 'Fine' }] });

    assert.deepEqual((await unifi.clients()).map((c) => c.mac), [IPAD]);
  });

  it('cleans names: no control characters, no long ones, and a fallback when there is none', async () => {
    const { unifi } = await connect({
      clients: [
        { mac: IPAD, name: `Bad\u0007 name\n${'x'.repeat(300)}` },
        { mac: PHONE },
      ],
    });

    const names = Object.fromEntries((await unifi.clients()).map((c) => [c.mac, c.name]));
    assert.ok(names[IPAD].length <= 80);
    assert.ok(!/[\u0000-\u001f]/.test(names[IPAD]));
    assert.equal(names[PHONE], 'Device 00:00:02');
  });
});

describe('what can be sent', () => {
  it('refuses to send anything but a real device address', async () => {
    const { server, unifi } = await connect();

    for (const bad of ['', 'not-a-mac', 'ff:ff:ff:ff:ff:ff', '00:00:00:00:00:00', '01:00:5e:00:00:01', `${IPAD}; drop`, undefined, null, 42]) {
      await assert.rejects(unifi.block(bad), TypeError, String(bad));
      await assert.rejects(unifi.unblock(bad), TypeError, String(bad));
    }

    assert.equal(server.world.calls.filter((c) => c.path.endsWith('/cmd/stamgr')).length, 0);
  });

  it('only ever issues block and unblock', async () => {
    const { server, unifi } = await connect();

    await unifi.block(IPAD);
    await unifi.unblock(IPAD);
    await unifi.clients();

    const commands = server.world.calls.filter((c) => c.body?.cmd).map((c) => c.body.cmd);
    assert.deepEqual(commands, ['block-sta', 'unblock-sta']);
  });

  it('normalises an address on the way out', async () => {
    const { server, unifi } = await connect();

    await unifi.block('AA-BB-CC-00-00-01');

    assert.deepEqual(server.world.blockedMacs(), [IPAD]);
  });

  it('keeps the site name out of the path except as one encoded piece', async () => {
    const { unifi } = await connect({ site: 'default' }, { site: '../../evil' });

    // Nothing here is reachable: the mock has no such site, and the path stays under /s/.
    await assert.rejects(unifi.clients(), (e) => e instanceof UnifiError);
  });
});

describe('trusting the certificate', () => {
  it('refuses a self-signed certificate by default, and says where to go next', async () => {
    const { unifi } = await connect({ tls: true });

    await assert.rejects(unifi.check(), (e) => e.kind === 'tls' && /Trusting the certificate/.test(e.message));
  });

  it('accepts it when the pinned fingerprint matches, in either notation', async () => {
    for (const fingerprint of [FIXTURE_FINGERPRINT, FIXTURE_FINGERPRINT.replace(/:/g, '').toLowerCase()]) {
      const { unifi } = await connect({ tls: true }, { tls: { fingerprint } });
      await unifi.check();
      assert.equal((await unifi.clients()).length, 3);
    }
  });

  it('sends nothing at all, password included, to a certificate that is not the pinned one', async () => {
    const { server, unifi } = await connect({ tls: true }, { tls: { fingerprint: 'AA'.repeat(32).replace(/(..)(?!$)/g, '$1:') } });

    await assert.rejects(unifi.check(), (e) => e.kind === 'tls' && e.fingerprint === FIXTURE_FINGERPRINT);

    assert.equal(server.world.calls.length, 0, 'the sign-in never arrived');
    assert.equal(server.world.logins, 0);
  });

  it('accepts a certificate its own authority vouches for', async () => {
    // The fixture is its own authority, which is what a home CA's certificate looks like to a client.
    const { unifi } = await connect({ tls: true }, { tls: { ca: FIXTURE_CERT } });

    await unifi.check();
  });

  it('accepts anything when checking is switched off, and only then', async () => {
    const { unifi } = await connect({ tls: true }, { tls: { insecure: true } });

    await unifi.check();
  });

  it('can say what fingerprint a console presents, without sending it anything', async () => {
    const { server } = await connect({ tls: true });

    assert.equal(await probeCertificate(new URL(server.url)), FIXTURE_FINGERPRINT);
    assert.equal(server.world.calls.length, 0);
  });
});
