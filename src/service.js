// @ts-check
//
// Ties it together: follows the computer in Five More Minutes, asks the reconciler what that means
// for the chosen devices, and does it on the network. Everything that can go wrong is handled by
// letting the child online: it is the direction a mistake here does the least harm in.

import { decide } from './reconciler.js';
import { FmmError } from './fmm-client.js';
import { shortMac } from './mac.js';

/**
 * @typedef {import('./fmm-client.js').FiveMoreMinutes} Fmm
 * @typedef {import('./fmm-client.js').State} State
 * @typedef {import('./unifi.js').UniFi} UniFi
 * @typedef {import('./store.js').Store} Store
 * @typedef {{ info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void }} Log
 */

const EVENTS_KEPT = 50;

export class Blocker {
  #fmm;
  #unifi;
  #store;
  #log;
  #now;
  #failOpenSeconds;
  #reconcileSeconds;
  #retry;
  #waitSeconds;

  /** @type {State | null} */
  #state = null;
  #reachable = false;
  /** @type {number} */
  #unreachableSince;
  /** @type {string | null} */
  #fmmProblem = null;
  /** @type {string | null} */
  #unifiProblem = null;
  /** @type {ReadonlyMap<string, boolean> | null} */
  #lastBlocked = null;
  /** @type {{ wantBlocked: boolean, code: string, reason: string } | null} */
  #lastDecision = null;
  /** @type {Array<{ at: string, kind: 'blocked' | 'released', name: string, code: string }>} */
  #events = [];

  #stopped = false;
  #busy = false;
  #again = false;
  #retryDelay;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #timer = null;
  #abort = new AbortController();
  /** @type {Promise<void> | null} */
  #following = null;
  /** @type {Promise<void>} */
  #idle = Promise.resolve();

  /**
   * @param {{ fmm: Fmm, unifi: UniFi, store: Store, log: Log, failOpenSeconds: number, reconcileSeconds: number,
   *           now?: () => number, retry?: { minMs: number, maxMs: number }, waitSeconds?: number }} options
   */
  constructor({ fmm, unifi, store, log, failOpenSeconds, reconcileSeconds, now = Date.now, retry = { minMs: 5_000, maxMs: 60_000 }, waitSeconds = 25 }) {
    this.#fmm = fmm;
    this.#unifi = unifi;
    this.#store = store;
    this.#log = log;
    this.#now = now;
    this.#failOpenSeconds = failOpenSeconds;
    this.#reconcileSeconds = reconcileSeconds;
    this.#retry = retry;
    this.#retryDelay = retry.minMs;
    this.#waitSeconds = waitSeconds;
    this.#unreachableSince = now();
  }

  /** Starts following. Resolves once Five More Minutes has been asked once, so that a restart does not flicker. */
  async start() {
    let firstAnswer = () => {};
    const first = new Promise((resolve) => { firstAnswer = () => resolve(undefined); });

    this.#following = this.#follow(firstAnswer);
    await first;
    this.reconcile();
  }

  /** Something changed that the rules depend on: the parent's choices, most of all. */
  reconcile() {
    if (this.#stopped) return;
    this.#again = true;
    if (!this.#busy) this.#idle = this.#run();
  }

  /**
   * Stops following and, by default, lets everyone back online first. A plugin that is being stopped,
   * updated or removed must not leave a child behind a block that nothing is around to lift.
   *
   * @param {{ release?: boolean }} [options]
   */
  async stop({ release = true } = {}) {
    this.#stopped = true;
    this.#abort.abort();
    if (this.#timer) clearTimeout(this.#timer);
    await this.#following;
    await this.#idle;

    if (release) await this.#releaseAll();
    await this.#unifi.close();
  }

  /** What the settings page shows. Nothing secret is, or could be, in here. */
  status() {
    const now = this.#now();
    const claimed = new Set(this.#store.blockedByUs);

    return {
      mode: this.#store.mode,
      failOpenSeconds: this.#failOpenSeconds,
      wantBlocked: this.#lastDecision?.wantBlocked ?? false,
      code: this.#lastDecision?.code ?? 'waiting',
      fmm: {
        reachable: this.#reachable,
        problem: this.#fmmProblem,
        unreachableSeconds: this.#reachable ? 0 : Math.floor((now - this.#unreachableSince) / 1000),
        computer: this.#state ? { name: this.#state.device.name, online: this.#state.device.online } : null,
        timerRunning: Boolean(this.#state?.timer),
        locked: Boolean(this.#state?.lock),
      },
      unifi: { ok: this.#unifiProblem === null && this.#lastBlocked !== null, problem: this.#unifiProblem },
      devices: this.#store.selection.map(({ mac, label }) => ({
        mac,
        label: label || `Device ${shortMac(mac)}`,
        blocked: this.#lastBlocked?.get(mac) ?? null,
        blockedByUs: claimed.has(mac),
      })),
      events: [...this.#events].reverse(),
    };
  }

  // -----------------------------------------------------------------------------------------------

  /** @param {() => void} firstAnswer */
  async #follow(firstAnswer) {
    let since;
    let delay = this.#retry.minMs;
    const { signal } = this.#abort;

    while (!signal.aborted) {
      try {
        const state = await this.#fmm.state({ wait: this.#waitSeconds, since, signal });
        since = state.signal;
        delay = this.#retry.minMs;

        const changed = !this.#reachable || this.#fmmProblem !== null || !sameShape(this.#state, state);
        this.#state = state;
        this.#reachable = true;
        this.#fmmProblem = null;
        firstAnswer();
        if (changed) this.reconcile();
      } catch (error) {
        if (signal.aborted) break;

        this.#markUnreachable(error);
        firstAnswer();
        this.reconcile();

        // Trying again cannot help with a revoked key; say so and stop asking. What is blocked still
        // ends at the lock's own end, or when the silence has lasted as long as the rules allow.
        if (error instanceof FmmError && !error.retryable) {
          this.#log.error(this.#fmmProblem ?? 'Five More Minutes refused the key.');
          break;
        }

        const wait = error instanceof FmmError && error.retryAfter ? error.retryAfter * 1000 : delay;
        await sleep(wait, signal);
        delay = Math.min(delay * 2, this.#retry.maxMs);
      }
    }

    firstAnswer();
  }

  /** @param {unknown} error */
  #markUnreachable(error) {
    const problem = fmmProblem(error);

    // The silence starts when it starts, not each time it is noticed again.
    if (this.#reachable) this.#unreachableSince = this.#now();
    if (this.#reachable || this.#fmmProblem !== problem) this.#log.warn(`Five More Minutes is not answering: ${describe(error)}`);

    this.#reachable = false;
    this.#fmmProblem = problem;
  }

  async #run() {
    this.#busy = true;
    try {
      while (this.#again && !this.#stopped) {
        this.#again = false;
        await this.#once();
      }
    } finally {
      this.#busy = false;
    }
  }

  async #once() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    const selection = new Set(this.#store.selection.map((d) => d.mac));
    const claimed = new Set(this.#store.blockedByUs);
    const now = this.#now();

    /** @type {Map<string, boolean> | null} */
    let blocked = null;
    let networkFailed = false;

    if (selection.size + claimed.size > 0) {
      try {
        blocked = await this.#unifi.blocked([...selection, ...claimed]);
        this.#unifiProblem = null;
      } catch (error) {
        networkFailed = true;
        this.#unifiFailed(error);
      }
    } else {
      this.#unifiProblem = null;
      blocked = new Map();
    }

    const decision = decide({
      mode: this.#store.mode,
      fmm: this.#state,
      reachable: this.#reachable,
      unreachableSeconds: this.#reachable ? 0 : Math.floor((now - this.#unreachableSince) / 1000),
      failOpenSeconds: this.#failOpenSeconds,
      now,
      selection,
      blockedByUs: claimed,
      blocked,
    });

    if (this.#lastDecision?.wantBlocked !== decision.wantBlocked || this.#lastDecision?.reason !== decision.reason) {
      this.#log.info(`${decision.wantBlocked ? 'Blocking' : 'Not blocking'}: ${decision.reason}.`);
    }
    this.#lastDecision = { wantBlocked: decision.wantBlocked, code: decision.code, reason: decision.reason };

    let failed = networkFailed;

    if (blocked) {
      /** @type {Map<string, boolean>} */
      const after = new Map(blocked);

      // Letting go comes before blocking: if anything goes wrong half way, it goes wrong towards online.
      for (const mac of decision.release) {
        try {
          await this.#unifi.unblock(mac);
          this.#store.release(mac);
          after.set(mac, false);
          this.#event('released', mac, decision.code, `${this.#nameOf(mac)} is back online (${decision.reason}).`);
        } catch (error) {
          failed = true;
          this.#unifiFailed(error);
        }
      }

      for (const mac of decision.block) {
        try {
          // Written down before it is done: a crash between the two leaves a note to undo something
          // that was never done, which is harmless, and never the reverse.
          this.#store.claim(mac);
          await this.#unifi.block(mac);
          after.set(mac, true);
          this.#event('blocked', mac, decision.code, `${this.#nameOf(mac)} is blocked (${decision.reason}).`);
        } catch (error) {
          failed = true;
          this.#unifiFailed(error);
        }
      }

      this.#lastBlocked = after;
      if (!failed) this.#unifiProblem = null;
    }

    if (failed) this.#retryDelay = Math.min(this.#retryDelay * 2, this.#retry.maxMs);
    else this.#retryDelay = this.#retry.minMs;

    this.#schedule(decision.recheckAt, failed, now);
  }

  /**
   * @param {number | null} recheckAt
   * @param {boolean} failed
   * @param {number} now
   */
  #schedule(recheckAt, failed, now) {
    if (this.#stopped) return;

    const candidates = [now + this.#reconcileSeconds * 1000];
    if (failed) candidates.push(now + this.#retryDelay);
    if (recheckAt !== null) candidates.push(recheckAt);
    // The end of the patience for silence is a moment too, and nothing else will wake us for it.
    if (!this.#reachable && this.#store.mode === 'not-running') candidates.push(this.#unreachableSince + this.#failOpenSeconds * 1000);

    const next = Math.min(...candidates.filter((t) => t > now));
    this.#timer = setTimeout(() => this.reconcile(), Math.max(50, next - now) + 20);
    this.#timer.unref?.();
  }

  async #releaseAll() {
    for (const mac of this.#store.blockedByUs) {
      try {
        await this.#unifi.unblock(mac);
        this.#store.release(mac);
        this.#log.info(`${this.#nameOf(mac)} let back online (the plugin is stopping).`);
      } catch (error) {
        // It stays on the list, so the next start (or `npm run release`) tries again.
        this.#log.error(`Could not let ${this.#nameOf(mac)} back online: ${describe(error)}. It is still blocked; run "npm run release" or unblock it in UniFi.`);
      }
    }
  }

  /** @param {unknown} error */
  #unifiFailed(error) {
    const message = describe(error);
    if (this.#unifiProblem !== message) this.#log.warn(`UniFi: ${message}`);
    this.#unifiProblem = message;
  }

  /** @param {string} mac */
  #nameOf(mac) {
    return this.#store.selection.find((d) => d.mac === mac)?.label || `Device ${shortMac(mac)}`;
  }

  /**
   * @param {'blocked' | 'released'} kind
   * @param {string} mac
   * @param {string} code
   * @param {string} text
   */
  #event(kind, mac, code, text) {
    this.#log.info(text);
    this.#events.push({ at: new Date(this.#now()).toISOString(), kind, name: this.#nameOf(mac), code });
    if (this.#events.length > EVENTS_KEPT) this.#events.shift();
  }
}

/**
 * Whether two states would make the plugin do the same thing. A heartbeat that changes nothing does
 * not need a network round trip.
 *
 * @param {State | null} a
 * @param {State | null} b
 */
function sameShape(a, b) {
  return Boolean(a && b)
    && a?.timer?.endsAt === b?.timer?.endsAt
    && a?.lock?.endsAt === b?.lock?.endsAt
    && a?.device.online === b?.device.online
    && a?.device.name === b?.device.name;
}

/** @param {unknown} error */
function describe(error) {
  return error instanceof Error ? error.message : 'something unexpected went wrong';
}

/** @param {unknown} error */
function fmmProblem(error) {
  if (error instanceof FmmError) {
    switch (error.kind) {
      case 'auth': return 'Five More Minutes no longer accepts this plugin\'s key. It may have been revoked or have expired. Make a new key in the portal and restart the plugin.';
      case 'forbidden': return 'The key is missing the permission to see the computer\'s state. Make a new key with "state:read" ticked.';
      case 'network-only': return 'Five More Minutes will only talk to plugins on the local network. Run this plugin on the same network.';
      default: return error.message;
    }
  }
  return 'Could not reach Five More Minutes.';
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve(undefined);
    }
  });
}
