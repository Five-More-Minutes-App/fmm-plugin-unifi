// @ts-check
//
// What the plugin remembers between runs: which devices a parent chose, when to block them, and
// which devices *this plugin* has blocked. The last one is the important one. It is what lets a
// restart, a crash, or an uninstall-and-reinstall still know what to undo, and what keeps the
// plugin from ever unblocking something it did not block.
//
// It is one small JSON file, written atomically (a temporary file, then a rename) so that a power
// cut never leaves half of one, and readable only by the account that runs the plugin.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeMac } from './mac.js';

/**
 * @typedef {object} Saved
 * @property {1} version
 * @property {'locked' | 'not-running'} mode
 * @property {Array<{ mac: string, label: string }>} selection  the devices a parent chose
 * @property {string[]} blockedByUs                             what this plugin blocked and has not released
 */

/** @returns {Saved} */
const empty = () => ({ version: 1, mode: 'locked', selection: [], blockedByUs: [] });

const MAX_DEVICES = 50;

export class Store {
  #file;
  /** @type {Saved} */
  #data;

  /** @param {string} directory */
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#file = join(directory, 'state.json');
    this.#data = this.#load();
  }

  get mode() {
    return this.#data.mode;
  }

  get selection() {
    return this.#data.selection.map((d) => ({ ...d }));
  }

  get blockedByUs() {
    return [...this.#data.blockedByUs];
  }

  /**
   * @param {'locked' | 'not-running'} mode
   * @param {Array<{ mac: string, label?: string }>} selection
   */
  saveSettings(mode, selection) {
    const seen = new Set();
    /** @type {Saved['selection']} */
    const devices = [];

    for (const item of selection) {
      const mac = normalizeMac(item.mac);
      if (!mac || seen.has(mac)) continue;
      seen.add(mac);
      devices.push({ mac, label: cleanLabel(item.label) });
    }

    if (devices.length > MAX_DEVICES) throw new RangeError(`Choose at most ${MAX_DEVICES} devices.`);

    this.#write({ ...this.#data, mode, selection: devices });
  }

  /** @param {string} mac */
  claim(mac) {
    if (!this.#data.blockedByUs.includes(mac)) this.#write({ ...this.#data, blockedByUs: [...this.#data.blockedByUs, mac] });
  }

  /** @param {string} mac */
  release(mac) {
    if (this.#data.blockedByUs.includes(mac)) this.#write({ ...this.#data, blockedByUs: this.#data.blockedByUs.filter((m) => m !== mac) });
  }

  /** @param {Saved} next */
  #write(next) {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    // Written before it is adopted: if this throws, memory still matches the disk.
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#file);
    this.#data = next;
  }

  /** @returns {Saved} */
  #load() {
    if (!existsSync(this.#file)) return empty();

    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8'));
      return sanitise(raw);
    } catch {
      // Do not lose it, and do not crash on it: keep the unreadable file for a person to look at and
      // start again. Starting again is safe because the plugin then blocks nothing until told to.
      try {
        renameSync(this.#file, `${this.#file}.unreadable-${Date.now()}`);
      } catch {
        // Nothing more to be done; the next write replaces it.
      }
      return empty();
    }
  }
}

/**
 * Whatever is on disk is treated as untrusted input: a hand-edited file must not be able to make the
 * plugin do more than a settings page could.
 *
 * @param {any} raw
 * @returns {Saved}
 */
function sanitise(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not an object');

  /** @type {Saved} */
  const saved = empty();
  if (raw.mode === 'locked' || raw.mode === 'not-running') saved.mode = raw.mode;

  const seen = new Set();
  for (const item of Array.isArray(raw.selection) ? raw.selection.slice(0, MAX_DEVICES) : []) {
    const mac = normalizeMac(item?.mac);
    if (mac && !seen.has(mac)) {
      seen.add(mac);
      saved.selection.push({ mac, label: cleanLabel(item?.label) });
    }
  }

  const claimed = new Set();
  for (const value of Array.isArray(raw.blockedByUs) ? raw.blockedByUs.slice(0, MAX_DEVICES * 4) : []) {
    const mac = normalizeMac(value);
    if (mac) claimed.add(mac);
  }
  saved.blockedByUs = [...claimed];

  return saved;
}

/** @param {unknown} label */
export function cleanLabel(label) {
  // eslint-disable-next-line no-control-regex
  return typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) : '';
}
