import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliError, EXIT } from '../src/exit.js';
import { assertPlatformSupported } from '../src/platform.js';

/**
 * The Windows front door.
 *
 * Before the guard, Windows was not refused — it was undefined:
 * `preferredBackend()` probes only darwin and linux, so win32 silently
 * landed on the `file` backend, whose 0600 chmod is a POSIX permission
 * model that does not bind NTFS ACLs. The credential in that file IS the
 * account, so the guard refuses at startup with the honest reason instead.
 * These tests pin the refusing arm (unreachable any other way from the
 * platforms this suite runs on — the platform parameter exists for exactly
 * this test), the pass-through arm, and the wiring.
 */
describe('the Windows front door (assertPlatformSupported)', () => {
  const refusal = (): CliError => {
    try {
      assertPlatformSupported('win32');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      return err as CliError;
    }
    throw new Error('win32 was not refused');
  };

  it('refuses win32 with the honest reason', () => {
    const err = refusal();
    // The message must name (a) the claim, (b) what DOES run, (c) the two
    // technical reasons B6 records, and (d) the condition under which the
    // refusal is lifted — a refusal that names no remedy teaches nothing.
    expect(err.message).toMatch(/Windows is not yet supported/);
    expect(err.message).toMatch(/macOS and Linux/);
    expect(err.message).toMatch(/DPAPI\/wincred/);
    expect(err.message).toMatch(/POSIX/);
    expect(err.message).toMatch(/credential backend and a CI matrix row/);
  });

  it('exits ERROR, and never the hook-blocking 2', () => {
    const err = refusal();
    expect(err.exitCode).toBe(EXIT.ERROR);
    // The published contract: no failure of this CLI may ever produce 2
    // (exit.ts's permanently-unused code). A platform refusal at startup is
    // still a failure of this CLI.
    expect(err.exitCode).not.toBe(2);
  });

  it('passes darwin and linux through untouched', () => {
    expect(() => assertPlatformSupported('darwin')).not.toThrow();
    expect(() => assertPlatformSupported('linux')).not.toThrow();
  });

  it('defaults to the real process.platform (production callers pass nothing)', () => {
    // This suite runs on darwin or linux, where the default must be a no-op;
    // on a hypothetical win32 CI runner this same line would throw, which is
    // the correct answer there too.
    expect(() => assertPlatformSupported()).not.toThrow();
  });

  it('is wired at the front door of main(), after --help/--version, before dispatch', () => {
    // A guard nobody calls is a comment. main.ts self-executes on import, so
    // the wiring is pinned at the source level: the call must exist, and it
    // must sit after the --version early-return and before the command
    // switch — the order that keeps help/version answerable everywhere while
    // no command can run un-guarded.
    const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const call = src.indexOf('assertPlatformSupported();');
    const version = src.indexOf("command === '--version'");
    const dispatch = src.indexOf('switch (command)');
    expect(call).toBeGreaterThan(version);
    expect(version).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(call);
  });
});
