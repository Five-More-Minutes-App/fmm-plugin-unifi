// @ts-check
//
// Decides what should be blocked, and what to do about it. The whole safety story of this plugin is
// in this file, so it is pure - no network, no clock, no disk - and every rule below is a test.
//
// The rules, in the order they matter:
//
//   1. Only ever touch a device a parent selected.
//   2. Only ever undo what this plugin did. A device that was blocked before we got there, by hand
//      or by another tool, stays blocked when we leave.
//   3. When in doubt, let the child online. A plugin that cannot reach Five More Minutes releases
//      what it blocked rather than strand a child behind it, as the product itself does: a lock
//      always carries its own end.

/**
 * @typedef {import('./fmm-client.js').State} State
 * @typedef {'locked' | 'not-running'} Mode
 * @typedef {'waiting' | 'locked' | 'lock-ended' | 'not-locked' | 'out-of-reach' | 'timer-running' | 'no-timer'} Code
 *
 * @typedef {object} Facts
 * @property {Mode} mode                     when to block: while locked, or whenever no timer is running
 * @property {State | null} fmm              the last state Five More Minutes reported, or null if none yet
 * @property {boolean} reachable             whether Five More Minutes answered recently
 * @property {number} unreachableSeconds     how long it has not, or 0
 * @property {number} failOpenSeconds        how long silence is tolerated before releasing
 * @property {number} now                    the time, in milliseconds since the epoch
 * @property {ReadonlySet<string>} selection the devices a parent chose (normalised MAC addresses)
 * @property {ReadonlySet<string>} blockedByUs what this plugin blocked and has not yet released
 * @property {ReadonlyMap<string, boolean> | null} blocked  for each selected device, whether the network
 *                                           says it is blocked right now; null if the network could not be asked
 *
 * @typedef {object} Decision
 * @property {boolean} wantBlocked           whether the selected devices should be blocked
 * @property {Code} code                     what the reason is, for a page that speaks more than one language
 * @property {string} reason                 a short phrase for the log
 * @property {string[]} block                devices to block now
 * @property {string[]} release              devices to unblock now (only ever ones this plugin blocked)
 * @property {number | null} recheckAt       when this decision expires by itself, if it does
 */

/**
 * @param {Facts} facts
 * @returns {{ wantBlocked: boolean, code: Code, reason: string, recheckAt: number | null }}
 */
export function wanted(facts) {
  const { mode, fmm, reachable, unreachableSeconds, failOpenSeconds, now } = facts;

  // Nothing known yet: a plugin that has not heard from Five More Minutes has no business blocking.
  if (!fmm) return { wantBlocked: false, code: 'waiting', reason: 'waiting to hear from Five More Minutes', recheckAt: null };

  if (mode === 'locked') {
    // A lock carries its own end, so this needs no further word from Five More Minutes: it lifts by
    // itself at that instant even if the service is never heard from again.
    const ends = fmm.lock ? Date.parse(fmm.lock.endsAt) : NaN;
    if (fmm.lock && ends > now) return { wantBlocked: true, code: 'locked', reason: 'the computer is locked', recheckAt: ends };
    return fmm.lock
      ? { wantBlocked: false, code: 'lock-ended', reason: 'the lock has ended', recheckAt: null }
      : { wantBlocked: false, code: 'not-locked', reason: 'the computer is not locked', recheckAt: null };
  }

  // "Only while there is time": blocked whenever no timer runs. That has no end of its own, so
  // silence has to be bounded here instead.
  if (!reachable && unreachableSeconds >= failOpenSeconds) {
    return { wantBlocked: false, code: 'out-of-reach', reason: 'Five More Minutes has been out of reach, so nothing is blocked', recheckAt: null };
  }

  const timerEnds = fmm.timer ? Date.parse(fmm.timer.endsAt) : NaN;
  if (fmm.timer && timerEnds > now) {
    return { wantBlocked: false, code: 'timer-running', reason: 'a timer is running', recheckAt: timerEnds };
  }

  return { wantBlocked: true, code: 'no-timer', reason: 'no timer is running', recheckAt: null };
}

/**
 * @param {Facts} facts
 * @returns {Decision}
 */
export function decide(facts) {
  const { selection, blockedByUs, blocked } = facts;
  const { wantBlocked, code, reason, recheckAt } = wanted(facts);

  /** @type {string[]} */
  const block = [];
  /** @type {string[]} */
  const release = [];

  if (wantBlocked) {
    for (const mac of selection) {
      // Block what is not blocked. That includes what we blocked and something has since unblocked:
      // while the rule says blocked, it is blocked. (A parent who wants an exception uses Five More
      // Minutes to give time, which is what the rule follows.) What is already blocked is left alone
      // and, importantly, not claimed: it is somebody else's block, and stays theirs.
      if (blocked?.get(mac) !== true) block.push(mac);
    }
  } else {
    // Only ever what we blocked.
    release.push(...blockedByUs);
  }

  // A device the parent has since taken off the list is released whatever the rule says, so that
  // removing it from the page is enough to free it.
  for (const mac of blockedByUs) {
    if (!selection.has(mac) && !release.includes(mac)) release.push(mac);
  }

  return { wantBlocked, code, reason, block: block.sort(), release: release.sort(), recheckAt };
}
