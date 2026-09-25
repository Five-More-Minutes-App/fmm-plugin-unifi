import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, wanted } from '../src/reconciler.js';

const NOW = Date.parse('2026-09-25T18:00:00Z');
const IPAD = 'aa:bb:cc:00:00:01';
const PHONE = 'aa:bb:cc:00:00:02';
const TV = 'aa:bb:cc:00:00:03';

const at = (seconds) => new Date(NOW + seconds * 1000).toISOString();
const state = ({ timer, lock } = {}) => ({
  apiVersion: 1,
  serverTime: at(0),
  signal: 1,
  device: { id: 'd', name: 'Elliots laptop', online: true },
  timer: timer ? { id: 't', startsAt: at(-60), endsAt: at(timer), secondsLeft: timer, message: null } : null,
  lock: lock ? { startsAt: at(-60), endsAt: at(lock), secondsLeft: lock, mode: 'Network' } : null,
});

/** Facts with sensible defaults, so each test states only what it is about. */
const facts = (overrides = {}) => ({
  mode: 'locked',
  fmm: state(),
  reachable: true,
  unreachableSeconds: 0,
  failOpenSeconds: 300,
  now: NOW,
  selection: new Set([IPAD]),
  blockedByUs: new Set(),
  blocked: new Map([[IPAD, false]]),
  ...overrides,
});

describe('while locked (the default)', () => {
  it('blocks the selected device when the computer is locked', () => {
    const d = decide(facts({ fmm: state({ lock: 1800 }) }));

    assert.equal(d.wantBlocked, true);
    assert.deepEqual(d.block, [IPAD]);
    assert.deepEqual(d.release, []);
  });

  it('leaves it alone when the computer is not locked', () => {
    const d = decide(facts({ fmm: state({ timer: 600 }) }));

    assert.equal(d.wantBlocked, false);
    assert.deepEqual(d.block, []);
  });

  it('does nothing when time is simply not running, because that is not a lock', () => {
    assert.equal(decide(facts({ fmm: state() })).wantBlocked, false);
  });

  it('lets go the moment the lock ends, even if Five More Minutes never says so', () => {
    // The lock carried its own end when it began. No further word is needed to lift it.
    const during = decide(facts({ fmm: state({ lock: 60 }), reachable: false, unreachableSeconds: 10_000 }));
    assert.equal(during.wantBlocked, true, 'still locked, so still blocked, however long the silence');
    assert.equal(during.recheckAt, NOW + 60_000);

    const after = decide(facts({
      fmm: state({ lock: 60 }),
      now: NOW + 61_000,
      blockedByUs: new Set([IPAD]),
      reachable: false,
      unreachableSeconds: 10_000,
    }));
    assert.equal(after.wantBlocked, false);
    assert.deepEqual(after.release, [IPAD]);
  });

  it('lets go when time is started during the lock, which lifts it', () => {
    const d = decide(facts({ fmm: state({ timer: 1800 }), blockedByUs: new Set([IPAD]) }));

    assert.deepEqual(d.release, [IPAD]);
  });

  it('says when it will next need to look, so it need not poll for the end of a lock', () => {
    assert.equal(wanted(facts({ fmm: state({ lock: 90 }) })).recheckAt, NOW + 90_000);
    assert.equal(wanted(facts({ fmm: state() })).recheckAt, null);
  });
});

describe('only while there is time', () => {
  const only = (overrides = {}) => facts({ mode: 'not-running', ...overrides });

  it('blocks whenever no timer is running', () => {
    assert.equal(decide(only({ fmm: state() })).wantBlocked, true);
    assert.equal(decide(only({ fmm: state({ lock: 600 }) })).wantBlocked, true);
  });

  it('lets the device online while a timer runs', () => {
    const d = decide(only({ fmm: state({ timer: 600 }), blockedByUs: new Set([IPAD]) }));

    assert.equal(d.wantBlocked, false);
    assert.deepEqual(d.release, [IPAD]);
    assert.equal(d.recheckAt, NOW + 600_000);
  });

  it('treats a timer whose end has passed as no timer', () => {
    assert.equal(decide(only({ fmm: state({ timer: 30 }), now: NOW + 31_000 })).wantBlocked, true);
  });

  it('releases when Five More Minutes has been out of reach too long, as the product itself would', () => {
    const quiet = decide(only({ fmm: state(), reachable: false, unreachableSeconds: 299, blockedByUs: new Set([IPAD]) }));
    assert.equal(quiet.wantBlocked, true, 'a short silence is not a reason to let go');

    const gone = decide(only({ fmm: state(), reachable: false, unreachableSeconds: 300, blockedByUs: new Set([IPAD]) }));
    assert.equal(gone.wantBlocked, false);
    assert.deepEqual(gone.release, [IPAD]);
    assert.match(gone.reason, /out of reach/);
  });

  it('blocks again once Five More Minutes is back and says no timer is running', () => {
    assert.equal(decide(only({ fmm: state(), reachable: true, unreachableSeconds: 0 })).wantBlocked, true);
  });
});

describe('when nothing is known', () => {
  it('blocks nothing before Five More Minutes has ever answered', () => {
    for (const mode of ['locked', 'not-running']) {
      const d = decide(facts({ mode, fmm: null }));
      assert.equal(d.wantBlocked, false, mode);
      assert.deepEqual(d.block, [], mode);
    }
  });
});

describe('only ever touching what it should', () => {
  it('blocks only what was selected', () => {
    const d = decide(facts({
      fmm: state({ lock: 600 }),
      selection: new Set([IPAD]),
      blocked: new Map([[IPAD, false]]),
    }));

    assert.deepEqual(d.block, [IPAD]);
    assert.ok(!d.block.includes(PHONE));
  });

  it('blocks several, in a stable order', () => {
    const d = decide(facts({
      fmm: state({ lock: 600 }),
      selection: new Set([TV, IPAD, PHONE]),
      blocked: new Map([[TV, false], [IPAD, false], [PHONE, false]]),
    }));

    assert.deepEqual(d.block, [IPAD, PHONE, TV]);
  });

  it('releases only what it blocked itself', () => {
    // The TV was blocked by hand long before this ran. Leaving must not undo that.
    const d = decide(facts({
      fmm: state({ timer: 600 }),
      selection: new Set([IPAD, TV]),
      blockedByUs: new Set([IPAD]),
      blocked: new Map([[IPAD, true], [TV, true]]),
    }));

    assert.deepEqual(d.release, [IPAD]);
    assert.ok(!d.release.includes(TV));
  });

  it('does not block again what it has already blocked', () => {
    const d = decide(facts({
      fmm: state({ lock: 600 }),
      blockedByUs: new Set([IPAD]),
      blocked: new Map([[IPAD, true]]),
    }));

    assert.deepEqual(d.block, []);
    assert.deepEqual(d.release, []);
  });

  it('does not touch a device that was already blocked by someone else', () => {
    const d = decide(facts({
      fmm: state({ lock: 600 }),
      selection: new Set([TV]),
      blockedByUs: new Set(),
      blocked: new Map([[TV, true]]),
    }));

    assert.deepEqual(d.block, [], 'nothing to do, and so nothing to claim');
    assert.deepEqual(d.release, [], 'and nothing that will ever be undone');
  });

  it('puts it right when something unblocked a device it had blocked', () => {
    const d = decide(facts({
      fmm: state({ lock: 600 }),
      blockedByUs: new Set([IPAD]),
      blocked: new Map([[IPAD, false]]),
    }));

    assert.deepEqual(d.block, [IPAD]);
  });

  it('frees a device the moment it is taken off the list, whatever the rule says', () => {
    const d = decide(facts({
      fmm: state({ lock: 600 }),
      selection: new Set([PHONE]),
      blockedByUs: new Set([IPAD, PHONE]),
      blocked: new Map([[PHONE, true]]),
    }));

    assert.deepEqual(d.release, [IPAD]);
    assert.deepEqual(d.block, []);
  });

  it('blocks nothing at all with nothing selected, and frees what it had', () => {
    const d = decide(facts({
      fmm: state({ lock: 600 }),
      selection: new Set(),
      blockedByUs: new Set([IPAD]),
    }));

    assert.deepEqual(d.block, []);
    assert.deepEqual(d.release, [IPAD]);
  });

  it('still blocks when the network could not be asked what is blocked', () => {
    const d = decide(facts({ fmm: state({ lock: 600 }), blocked: null }));

    assert.deepEqual(d.block, [IPAD]);
  });

  it('never lists a device to both block and release', () => {
    for (const mode of ['locked', 'not-running']) {
      for (const fmm of [null, state(), state({ timer: 600 }), state({ lock: 600 })]) {
        const d = decide(facts({
          mode,
          fmm,
          selection: new Set([IPAD, PHONE]),
          blockedByUs: new Set([IPAD, TV]),
          blocked: new Map([[IPAD, true], [PHONE, false]]),
        }));

        assert.deepEqual(d.block.filter((mac) => d.release.includes(mac)), [], `${mode} ${JSON.stringify(fmm?.timer)}`);
      }
    }
  });
});
