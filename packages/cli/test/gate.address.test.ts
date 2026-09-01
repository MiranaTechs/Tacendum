import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isUserId, resolveRecipient } from '../src/profile.js';
import { CliError, EXIT } from '../src/exit.js';

/** Reported from a real session. */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-addr-'));
  process.env.TACENDUM_HOME = home;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const ID = '01K9RZ4M8V2QW7X3YB6NCDPFGH';

describe('the error must never advise registering the RECIPIENT', () => {
  it('does not tell the user to run `tacendum register <recipient>`', () => {
    // That advice creates a second LOCAL account named after the recipient,
    // after which `send` resolves the name to that stub and reports success:
    // silent misdelivery, exit 0. The function's own docstring describes this
    // trap as the reason the id path exists — and the message recreated it.
    let msg = '';
    try {
      resolveRecipient('01K9RZ…');
    } catch (err) {
      msg = (err as CliError).message;
      expect((err as CliError).exitCode).toBe(EXIT.RECIPIENT);
    }
    expect(msg).not.toMatch(/register\s+01K9RZ/);
    expect(msg).not.toMatch(/run:\s*tacendum register/);
  });

  it('says so plainly when the id was abbreviated with an ellipsis', () => {
    try {
      resolveRecipient('01K9RZ…');
    } catch (err) {
      expect((err as CliError).message).toMatch(/shorten|abbreviat|…/i);
    }
  });
});

describe('user ids are case-insensitive, as Crockford base32 is', () => {
  it('accepts a lowercase id and normalises it', () => {
    expect(isUserId(ID.toLowerCase())).toBe(true);
    expect(resolveRecipient(ID.toLowerCase())).toBe(ID);
  });

  it('accepts mixed case', () => {
    expect(resolveRecipient(ID.slice(0, 13) + ID.slice(13).toLowerCase())).toBe(ID);
  });

  it('still accepts the uppercase form unchanged', () => {
    expect(resolveRecipient(ID)).toBe(ID);
  });

  it('does not mistake an ordinary client name for an id', () => {
    expect(isUserId('ci-bot')).toBe(false);
    expect(isUserId('alice')).toBe(false);
  });
});
