// @ts-check
//
// A device is chosen by its MAC address, and that address ends up in a request to your network, so it
// is checked here and nowhere else: whatever leaves this file is `aa:bb:cc:dd:ee:ff` or it is null.

// One kind of separator throughout, not a mixture.
const COLONS = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$|^([0-9a-f]{2}-){5}[0-9a-f]{2}$/i;
const BARE = /^[0-9a-f]{12}$/i;
const DOTS = /^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i;

/**
 * Turns the ways people write a MAC address into one shape, or says it is not one.
 *
 * Group and empty addresses are refused: a device on your network has a unicast address, so an
 * address that is all ones (broadcast) or has the group bit set is a typo or something worse.
 *
 * @param {unknown} input
 * @returns {string | null} lower-case, colon-separated
 */
export function normalizeMac(input) {
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (!COLONS.test(text) && !BARE.test(text) && !DOTS.test(text)) return null;

  const hex = text.replace(/[:\-.]/g, '').toLowerCase();
  if (/^0+$/.test(hex)) return null;
  if ((parseInt(hex.slice(0, 2), 16) & 1) === 1) return null;

  return /** @type {RegExpMatchArray} */ (hex.match(/.{2}/g)).join(':');
}

/**
 * A label for a device that has no name: the last three bytes, which is what is printed on the box.
 * @param {string} mac normalised
 */
export function shortMac(mac) {
  return mac.slice(9).toUpperCase();
}
