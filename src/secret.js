// @ts-check
import { inspect } from 'node:util';

/**
 * A value that must not end up in a log, an error, a status page or a crash report. It prints as
 * `[hidden]` however it is asked to, and the only way to the value is to say so: `.reveal()`.
 */
export class Secret {
  #value;

  /** @param {string} value */
  constructor(value) {
    this.#value = value;
  }

  reveal() {
    return this.#value;
  }

  get length() {
    return this.#value.length;
  }

  toString() {
    return '[hidden]';
  }

  toJSON() {
    return '[hidden]';
  }

  [inspect.custom]() {
    return '[hidden]';
  }
}

/**
 * Makes a function that removes known secrets from a piece of text. Belt and braces: nothing here
 * is meant to log a secret, and this is what catches the day something does.
 *
 * @param {Array<Secret | string | undefined>} secrets
 * @returns {(text: string) => string}
 */
export function redactor(secrets) {
  /** @type {string[]} */
  const values = [];
  for (const secret of secrets) {
    const value = secret instanceof Secret ? secret.reveal() : secret;
    if (typeof value === 'string' && value.length >= 6) values.push(value);
  }

  return (text) => values.reduce((out, value) => out.split(value).join('[hidden]'), text);
}
