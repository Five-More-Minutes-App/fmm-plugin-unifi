#!/usr/bin/env node
// @ts-check
//
//   node src/main.js             run the plugin
//   node src/main.js --check     check the setup and say what is wrong, without changing anything
//   node src/main.js --release   let back online everything this plugin has blocked, then stop

import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { FiveMoreMinutes, FmmError } from './fmm-client.js';
import { createLogger } from './log.js';
import { Blocker } from './service.js';
import { redactor } from './secret.js';
import { Store } from './store.js';
import { probeCertificate } from './transport.js';
import { UniFi, UnifiError } from './unifi.js';
import { createWeb } from './web.js';

const USAGE = `Five More Minutes - UniFi plugin

  node src/main.js             run the plugin
  node src/main.js --check     check the setup and say what is wrong (changes nothing)
  node src/main.js --release   let back online everything this plugin has blocked, then stop
`;

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ out?: (line: string) => void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2), env = process.env, { out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }

  const unknown = argv.filter((a) => a !== '--check' && a !== '--release');
  if (unknown.length > 0) {
    out(`Unknown option: ${unknown[0].slice(0, 40)}\n\n${USAGE}`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    out(error instanceof ConfigError ? error.message : 'The plugin could not read its settings.');
    return 2;
  }

  const redact = redactor([config.fmm.apiKey, config.unifi.password, config.admin.token]);
  const log = createLogger({ redact, write: out });

  const fmm = new FiveMoreMinutes({ url: config.fmm.url, apiKey: config.fmm.apiKey.reveal() });
  const unifi = new UniFi({ ...config.unifi });
  const store = new Store(config.dataDir);

  if (argv.includes('--check')) return await check({ config, fmm, unifi, out });
  if (argv.includes('--release')) return await release({ store, unifi, out });
  return await serve({ config, fmm, unifi, store, log });
}

/**
 * Every step says what it found, and what to do if that is not good.
 * @param {{ config: import('./config.js').Config, fmm: FiveMoreMinutes, unifi: UniFi, out: (line: string) => void }} parts
 */
async function check({ config, fmm, unifi, out }) {
  let ok = true;

  try {
    const me = await fmm.me();
    out(`OK    Five More Minutes: the key opens "${me.device.name}".`);
    if (me.key.scopes.includes('state:read')) out('OK    The key can see the computer\'s state (state:read).');
    else {
      ok = false;
      out('FAIL  The key cannot see the computer\'s state. Make a new key with "state:read" ticked.');
    }
    const extra = me.key.scopes.filter((s) => s !== 'state:read');
    if (extra.length > 0) out(`NOTE  The key can also: ${extra.join(', ')}. This plugin only needs state:read; a smaller key is safer.`);
  } catch (error) {
    ok = false;
    out(`FAIL  Five More Minutes: ${error instanceof FmmError ? error.message : 'could not be checked.'}`);
  }

  try {
    await unifi.check();
    out(`OK    UniFi: signed in as ${config.unifi.username}.`);
    const clients = await unifi.clients();
    out(`OK    UniFi: ${clients.length} devices known on site "${config.unifi.site}".`);
  } catch (error) {
    ok = false;
    out(`FAIL  UniFi: ${error instanceof Error ? error.message : 'could not be checked.'}`);

    if (error instanceof UnifiError && error.kind === 'tls') {
      const seen = error.fingerprint ?? await probeCertificate(new URL(config.unifi.url)).catch(() => null);
      if (seen) {
        out(`      The console's certificate has the fingerprint ${seen}`);
        out('      If you are sure that is your console, pin it: UNIFI_TLS_FINGERPRINT=' + seen);
      }
    }
  } finally {
    await unifi.close();
  }

  out(ok ? '\nEverything needed is working.' : '\nSomething needs fixing before this will work.');
  return ok ? 0 : 1;
}

/** @param {{ store: Store, unifi: UniFi, out: (line: string) => void }} parts */
async function release({ store, unifi, out }) {
  const claimed = store.blockedByUs;
  if (claimed.length === 0) {
    out('This plugin has not blocked anything that is still blocked.');
    return 0;
  }

  let failed = 0;
  for (const mac of claimed) {
    try {
      await unifi.unblock(mac);
      store.release(mac);
      out(`Unblocked ${mac}.`);
    } catch (error) {
      failed += 1;
      out(`Could not unblock ${mac}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  await unifi.close();
  return failed === 0 ? 0 : 1;
}

/** @param {{ config: import('./config.js').Config, fmm: FiveMoreMinutes, unifi: UniFi, store: Store, log: ReturnType<typeof createLogger> }} parts */
async function serve({ config, fmm, unifi, store, log }) {
  const blocker = new Blocker({
    fmm, unifi, store, log,
    failOpenSeconds: config.failOpenSeconds,
    reconcileSeconds: config.reconcileSeconds,
  });

  const web = createWeb({
    blocker, unifi, store, log,
    token: config.admin.token,
    cookieSecure: config.admin.cookieSecure,
    publicDir: new URL('../public/', import.meta.url),
    iconPath: new URL('../icon.png', import.meta.url),
  });

  const port = await web.listen(config.admin.port, config.admin.host);
  log.info(`Settings page: http://${config.admin.host === '0.0.0.0' ? 'this-computer' : config.admin.host}:${port}`);
  if (config.unifi.tls.insecure) log.warn('Certificate checking for UniFi is switched off (UNIFI_INSECURE_TLS). Pin the certificate instead: see the README.');

  await blocker.start();

  await new Promise((resolve) => {
    let stopping = false;

    /** @param {string} signal */
    const stop = async (signal) => {
      // A second signal means "now": give up being tidy.
      if (stopping) process.exit(1);
      stopping = true;
      log.info(`${signal}: stopping. Everything this plugin blocked is being let back online.`);

      await Promise.race([
        blocker.stop().then(() => web.close()),
        new Promise((done) => setTimeout(done, 15_000).unref()),
      ]);
      resolve(undefined);
    };

    process.on('SIGINT', () => void stop('SIGINT'));
    process.on('SIGTERM', () => void stop('SIGTERM'));
  });

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`Unexpected error: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  });
}
