// @ts-check

/**
 * A logger that puts a timestamp on each line and, whatever it is given, cannot print a secret it
 * was told about. Nothing is meant to be passed to it that could; this is for the day something is.
 *
 * @param {{ redact?: (text: string) => string, write?: (line: string) => void }} [options]
 */
export function createLogger({ redact = (text) => text, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  /** @param {string} level */
  const line = (level) => (/** @type {string} */ message) => write(`${new Date().toISOString()} ${level} ${redact(String(message))}`);

  return { info: line('INFO '), warn: line('WARN '), error: line('ERROR') };
}
