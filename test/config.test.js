import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { ConfigError, loadConfig } from '../src/config.js';
import { KEY } from './mock-fmm.js';

const TOKEN = 'k3J9x-pQ2mZ7vR4tB8nW1yA6';

const good = () => ({
  FMM_URL: 'http://192.168.1.10:5072',
  FMM_API_KEY: KEY,
  UNIFI_URL: 'https://192.168.1.1',
  UNIFI_USERNAME: 'fmm',
  UNIFI_PASSWORD: 'a-good-password',
  ADMIN_TOKEN: TOKEN,
});

const problems = (env, io) => {
  try {
    loadConfig(env, io);
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    return error.problems;
  }
  return assert.fail('expected the setup to be refused');
};

describe('a good setup', () => {
  it('loads, with sensible defaults', () => {
    const config = loadConfig(good());

    assert.equal(config.fmm.url, 'http://192.168.1.10:5072');
    assert.equal(config.unifi.url, 'https://192.168.1.1');
    assert.equal(config.unifi.site, 'default');
    assert.equal(config.unifi.kind, 'unifi-os');
    assert.equal(config.admin.port, 8099);
    assert.equal(config.admin.host, '127.0.0.1', 'the settings page is for this computer unless it is told otherwise');
    assert.equal(config.failOpenSeconds, 300);
    assert.equal(config.reconcileSeconds, 60);
    assert.deepEqual(config.unifi.tls, { fingerprint: null, ca: null, insecure: false });
  });

  it('keeps secrets out of anything that prints, logs or serialises it', () => {
    const config = loadConfig(good());

    for (const text of [JSON.stringify(config), inspect(config, { depth: 10 }), String(config.admin.token), `${config.unifi.password}`]) {
      for (const secret of [KEY, 'a-good-password', TOKEN]) assert.ok(!text.includes(secret));
    }
    assert.equal(config.unifi.password.reveal(), 'a-good-password');
  });

  it('is not changeable after loading', () => {
    const config = loadConfig(good());
    assert.throws(() => { config.dataDir = '/elsewhere'; }, TypeError);
  });

  it('reads secrets from files, dropping the trailing newline', () => {
    const files = { '/run/secrets/key': `${KEY}\n`, '/run/secrets/pw': 'a-good-password\r\n', '/run/secrets/tok': `${TOKEN}\n` };
    const env = { ...good(), FMM_API_KEY: undefined, UNIFI_PASSWORD: undefined, ADMIN_TOKEN: undefined, FMM_API_KEY_FILE: '/run/secrets/key', UNIFI_PASSWORD_FILE: '/run/secrets/pw', ADMIN_TOKEN_FILE: '/run/secrets/tok' };

    const config = loadConfig(env, { readFile: (p) => { if (p in files) return files[p]; throw new Error('no such file'); } });

    assert.equal(config.fmm.apiKey.reveal(), KEY);
    assert.equal(config.unifi.password.reveal(), 'a-good-password');
    assert.equal(config.admin.token.reveal(), TOKEN);
  });

  it('normalises a fingerprint written with or without colons', () => {
    const hex = 'ab'.repeat(32);
    const expected = hex.toUpperCase().match(/../g).join(':');
    for (const value of [hex, hex.toUpperCase(), hex.match(/../g).join(':')]) {
      assert.equal(loadConfig({ ...good(), UNIFI_TLS_FINGERPRINT: value }).unifi.tls.fingerprint, expected);
    }
  });

  it('allows plain http to the UniFi console only on this computer', () => {
    assert.equal(loadConfig({ ...good(), UNIFI_URL: 'http://127.0.0.1:8443' }).unifi.url, 'http://127.0.0.1:8443');
  });

  it('reduces the UniFi address to where it is, without a path', () => {
    assert.equal(loadConfig({ ...good(), UNIFI_URL: 'https://192.168.1.1/network/default/dashboard' }).unifi.url, 'https://192.168.1.1');
  });
});

describe('a setup that is not right', () => {
  it('says everything that is wrong at once, not one thing per attempt', () => {
    const found = problems({});

    assert.ok(found.length >= 6, found.join('\n'));
    for (const name of ['FMM_URL', 'FMM_API_KEY', 'UNIFI_URL', 'UNIFI_USERNAME', 'UNIFI_PASSWORD', 'ADMIN_TOKEN']) {
      assert.ok(found.some((p) => p.includes(name)), `${name} should be mentioned`);
    }
  });

  it('tells you how to make an admin token', () => {
    assert.ok(problems({ ...good(), ADMIN_TOKEN: undefined }).some((p) => /randomBytes/.test(p)));
  });

  it('never repeats a secret back, even a wrong one', () => {
    const found = problems({ ...good(), FMM_API_KEY: 'fmmk_not-a-real-key-but-secret', UNIFI_PASSWORD: undefined, ADMIN_TOKEN: 'shorty' }).join('\n');

    assert.ok(!found.includes('not-a-real-key-but-secret'));
    assert.ok(!found.includes('shorty'));
  });

  it('refuses to send a UniFi login over plain http to another computer', () => {
    assert.ok(problems({ ...good(), UNIFI_URL: 'http://192.168.1.1' }).some((p) => /https/.test(p)));
  });

  it('refuses credentials written into an address', () => {
    assert.ok(problems({ ...good(), UNIFI_URL: 'https://admin:pw@192.168.1.1' }).some((p) => /UNIFI_USERNAME/.test(p)));
    assert.ok(problems({ ...good(), FMM_URL: 'http://a:b@192.168.1.10' }).some((p) => /FMM/.test(p)));
  });

  it('refuses a site name that could change the path', () => {
    for (const site of ['../x', 'a/b', 'a b', 'x'.repeat(65)]) {
      assert.ok(problems({ ...good(), UNIFI_SITE: site }).some((p) => /UNIFI_SITE/.test(p)), site);
    }
  });

  it('refuses a kind it does not know', () => {
    assert.ok(problems({ ...good(), UNIFI_KIND: 'cloud' }).some((p) => /UNIFI_KIND/.test(p)));
  });

  it('refuses a token that is short or made of few different characters', () => {
    assert.ok(problems({ ...good(), ADMIN_TOKEN: 'abc123' }).some((p) => /too short/.test(p)));
    assert.ok(problems({ ...good(), ADMIN_TOKEN: 'a'.repeat(30) }).some((p) => /guessable/.test(p)));
  });

  it('refuses a malformed fingerprint', () => {
    assert.ok(problems({ ...good(), UNIFI_TLS_FINGERPRINT: 'abc' }).some((p) => /FINGERPRINT/.test(p)));
  });

  it('makes you choose one way to trust the certificate', () => {
    const env = { ...good(), UNIFI_TLS_FINGERPRINT: 'ab'.repeat(32), UNIFI_INSECURE_TLS: 'true' };
    assert.ok(problems(env).some((p) => /Choose one/.test(p)));
  });

  it('checks the CA file is a certificate', () => {
    assert.ok(problems({ ...good(), UNIFI_CA_FILE: '/ca.pem' }, { readFile: () => 'hello' }).some((p) => /PEM/.test(p)));
    assert.ok(problems({ ...good(), UNIFI_CA_FILE: '/missing.pem' }, { readFile: () => { throw new Error('x'); } }).some((p) => /could not be read/.test(p)));
  });

  it('refuses both a value and a file for the same setting', () => {
    assert.ok(problems({ ...good(), ADMIN_TOKEN_FILE: '/x' }, { readFile: () => 'y' }).some((p) => /not both/.test(p)));
  });

  it('refuses an empty or unreadable secret file', () => {
    const env = { ...good(), UNIFI_PASSWORD: undefined, UNIFI_PASSWORD_FILE: '/pw' };
    assert.ok(problems(env, { readFile: () => '\n' }).some((p) => /empty/.test(p)));
    assert.ok(problems(env, { readFile: () => { throw new Error('nope'); } }).some((p) => /could not be read/.test(p)));
  });

  it('holds numbers to their limits', () => {
    for (const [name, value] of [['PORT', '0'], ['PORT', '70000'], ['PORT', 'http'], ['FAIL_OPEN_SECONDS', '5'], ['FAIL_OPEN_SECONDS', '999999'], ['RECONCILE_SECONDS', '1'], ['RECONCILE_SECONDS', '-3']]) {
      assert.ok(problems({ ...good(), [name]: value }).some((p) => p.includes(name)), `${name}=${value}`);
    }
  });

  it('wants an address for HOST, not a name that could be anything', () => {
    assert.ok(problems({ ...good(), HOST: 'example.com' }).some((p) => /HOST/.test(p)));
    assert.equal(loadConfig({ ...good(), HOST: '0.0.0.0' }).admin.host, '0.0.0.0');
  });

  it('understands true and false in the usual spellings, and nothing else', () => {
    for (const yes of ['1', 'true', 'YES', 'on']) assert.equal(loadConfig({ ...good(), COOKIE_SECURE: yes }).admin.cookieSecure, true);
    for (const no of ['0', 'false', 'No', 'off']) assert.equal(loadConfig({ ...good(), COOKIE_SECURE: no }).admin.cookieSecure, false);
    assert.ok(problems({ ...good(), COOKIE_SECURE: 'maybe' }).some((p) => /COOKIE_SECURE/.test(p)));
  });
});
