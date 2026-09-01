import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `attend disable` MUST NOT REPORT SUCCESS OVER A FAILED WRITE.
 *
 * The disable IS the durable write: an empty attend.json is what
 * `loadAttendConfig` reads as null, and null is `attendOnce`'s ONLY
 * enablement gate. The write sat inside a bare catch whose comment read
 * "nothing to remove is disabled enough", so on EROFS/EACCES/ENOSPC/EDQUOT
 * the command
 * printed `{"ok":true,"action":"attend-disabled"}` at exit 0 while the
 * config still loaded and the supervised `attend run` KEPT SPAWNING AGENT
 * TURNS on owner messages. There is no `attend status` and doctor never
 * mentions attend, so nothing contradicted the false claim — a false
 * negative on the only in-band brake over the command that runs code
 * derived from message content.
 *
 * "Nothing to remove is disabled enough" stays true where it was true: a
 * box where no config LOADS after the failed write genuinely has nothing to
 * disable. The predicate is asked, not assumed.
 *
 * Written RED against the bare catch.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-attend-truth-'));
process.env.TACENDUM_HOME = home;

const { cmdAttendDisable, loadAttendConfig, saveAttendConfig } = await import('../src/attend.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { Reporter } = await import('../src/output.js');

afterAll(() => {
  // Re-arm permissions so rm -rf can clean up.
  try {
    chmodSync(join(home, 'lockedbot'), 0o700);
  } catch {
    /* already writable or gone */
  }
  rmSync(home, { recursive: true, force: true });
});

function reporter(): {
  rep: InstanceType<typeof Reporter>;
  emitted: Array<Record<string, unknown>>;
} {
  const emitted: Array<Record<string, unknown>> = [];
  const rep = new Reporter({ json: false, plain: true });
  rep.emit = (record: Record<string, unknown>) => {
    emitted.push(record);
  };
  return { rep, emitted };
}

const CFG = {
  host: 'claude' as const,
  bin: '/usr/bin/true',
  workdir: '/tmp',
  caps: ['--permission-mode', 'plan'],
  ownSession: 'ffffffff-9999-4999-8999-999999999999',
  turnsPerHour: 6,
};

describe('attend disable tells the truth about the brake', () => {
  it('a write that cannot land, with the agent still armed, FAILS loudly', () => {
    const account = 'lockedbot';
    const dir = join(home, account);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    saveAttendConfig(account, CFG);
    expect(loadAttendConfig(account)).not.toBeNull();
    const before = readFileSync(join(dir, 'attend.json'), 'utf8');

    // The gate's repro: the account dir goes read-only (EROFS/ENOSPC/EIO
    // reach the same catch with no chmod needed — atomic-write's temp file
    // lives in this directory).
    chmodSync(dir, 0o500);
    try {
      const { rep, emitted } = reporter();
      let caught: unknown;
      try {
        cmdAttendDisable(account, rep);
      } catch (err) {
        caught = err;
      }

      // THE ASSERTION: no ok:true over an armed agent, nonzero exit, and the
      // message says the agent is still enabled.
      expect(
        caught,
        'attend disable reported success while the agent stayed armed',
      ).toBeInstanceOf(CliError);
      expect((caught as CliError).exitCode).toBe(EXIT.ERROR);
      expect((caught as CliError).message).toMatch(/still ENABLED/i);
      expect(emitted.filter(e => e.ok === true)).toEqual([]);

      // The ground truth the false claim papered over: config unchanged,
      // still loading, gate still open.
      expect(readFileSync(join(dir, 'attend.json'), 'utf8')).toBe(before);
      expect(loadAttendConfig(account)).not.toBeNull();

      // The errno travels; the path does not (it embeds the account name in
      // a home an operator may have put anywhere).
      expect((caught as CliError).message).toMatch(/E[A-Z0-9]+|unclassified/);
      expect((caught as CliError).message).not.toContain(home);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('a machine with nothing to disable still succeeds — disabled enough', () => {
    // No account dir at all: the write fails (ENOENT parent), no config
    // loads, and the claim "attend is disabled" is TRUE.
    const { rep, emitted } = reporter();
    cmdAttendDisable('neverenabled', rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.ok).toBe(true);
    expect(loadAttendConfig('neverenabled')).toBeNull();
    expect(existsSync(join(home, 'neverenabled', 'attend.json'))).toBe(false);
  });

  it('the working path is untouched: disable lands, config stops loading', () => {
    const account = 'healthybot';
    mkdirSync(join(home, account), { recursive: true, mode: 0o700 });
    saveAttendConfig(account, CFG);
    expect(loadAttendConfig(account)).not.toBeNull();
    const { rep, emitted } = reporter();
    cmdAttendDisable(account, rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.ok).toBe(true);
    expect(loadAttendConfig(account)).toBeNull();
    expect(readFileSync(join(home, account, 'attend.json'), 'utf8')).toBe('');
  });
});
