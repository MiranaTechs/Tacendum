/**
 * Structured logging. One JSON object per line:
 * `{ ts, level, event, ...fields }`.
 *
 * Rule 4 — no payloads, plaintext, tokens, phone numbers or verification codes
 * is a CALLER discipline, enforced by review and by the tests that scan for
 * canaries. `LogFields` does not enforce it and must not be described as
 * though it does: it excludes objects, arrays and Buffers, but every secret
 * this codebase handles is a *string* and is therefore type-legal here. The
 * type buys "no accidental blob dumps", nothing more.
 *
 * Adapter error paths call `log.error` directly rather than going through
 * `Deps.log`, which is the handlers' seam and is wired to `log.info` — see
 * aws/http.lambda.ts.
 */

export type LogFields = Record<string, string | number | boolean>;

export type LogLevel = 'info' | 'warn' | 'error';

/** Emit one structured line. Errors go to stderr, everything else to stdout. */
export function logLine(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: Date.now(), level, event, ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (event: string, fields?: LogFields) => logLine('info', event, fields),
  warn: (event: string, fields?: LogFields) => logLine('warn', event, fields),
  error: (event: string, fields?: LogFields) => logLine('error', event, fields),
};
