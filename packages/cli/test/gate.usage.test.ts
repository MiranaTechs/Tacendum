import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { CliError, EXIT } from '../src/exit.js';

/**
 * /E — the three ways the argument layer breaks
 * the one caller this tool was built for: a Claude Code hook.
 */

describe('exit codes are hook-safe', () => {
  it('never uses 2 — a Stop hook exiting 2 BLOCKS the agent', () => {
    // Claude Code reserves hook exit 2 as the blocking code: it forces the
    // agent to keep going and feeds the hook's stderr back to the model as
    // instructions. A notifier that exits 2 on a typo turns a typo into an
    // agent-control primitive, so this CLI must never emit it.
    expect(Object.values(EXIT)).not.toContain(2);
  });

  it('keeps 0 and 1 on the shell convention', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.ERROR).toBe(1);
  });
});

describe('unknown-option errors do not echo the rejected text', () => {
  it('refuses a long dash-leading message body without quoting it', () => {
    // `tacendum send bot owner "--drop database; token=hunter2..."` with no
    // `--` terminator: the body is argv, and the error goes to stderr and to
    // --json output, i.e. into hook and CI logs.
    const secret = '--token=hunter2-SUPERSECRET-do-not-log-this-anywhere-ever';
    let message = '';
    try {
      parseArgs([secret]);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.USAGE);
      message = (err as CliError).message;
    }
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(secret);
    // The name before `=` may survive (it is not the secret half); the value
    // never may.
    expect(message).not.toContain('SUPERSECRET');
    // It must still be diagnosable, and it must teach the fix.
    expect(message).toContain('unknown option');
    expect(message).toContain('--');
  });

  it('shows a flag name but never the value after =', () => {
    try {
      parseArgs(['--title=leak-me-please']);
    } catch (err) {
      const m = (err as CliError).message;
      expect(m).toContain('--title');
      expect(m).not.toContain('leak-me-please');
    }
  });

  it('still names a short typo\'d flag, which is the whole point of the error', () => {
    try {
      parseArgs(['--titel']);
    } catch (err) {
      expect((err as CliError).message).toContain('--titel');
    }
  });

  it('refuses a flag-SHAPED body — shape alone was not enough', () => {
    // An earlier revision of the gate: `-A1b2C3d4E5f6G7h8I9j0` is dash-leading, short, has
    // no '=' and no whitespace, and is a plausible secret. Only a near-miss of
    // a flag this CLI actually has may be echoed.
    const body = '-A1b2C3d4E5f6G7h8I9j0';
    try {
      parseArgs([body]);
    } catch (err) {
      const m = (err as CliError).message;
      expect(m).not.toContain('A1b2C3d4');
      expect(m).toContain('not shown');
    }
  });

  it('still names a near-miss of a real flag, which is what the error is for', () => {
    for (const [typo, real] of [['--titel', 'titel'], ['--jsn', 'jsn'], ['--acount', 'acount']]) {
      try {
        parseArgs([typo]);
      } catch (err) {
        expect((err as CliError).message).toContain(real as string);
      }
    }
  });

  it('truncates at the first whitespace — a body is prose, a flag is one word', () => {
    try {
      parseArgs(['--secret value that must not appear']);
    } catch (err) {
      const m = (err as CliError).message;
      expect(m).not.toContain('must not appear');
    }
  });
});

describe('register accepts the flag its help documents', () => {
  it('parses --integration instead of rejecting it as unknown', () => {
    // The register dispatch reads flagBool(args, '--integration'), but the
    // parser threw first: the documented safe path was unreachable, so every
    // account the product created was human-class.
    const args = parseArgs(['ci', '--integration'], { boolean: ['--integration'] });
    expect(args.flags.get('--integration')).toBe(true);
    expect(args.positionals).toEqual(['ci']);
  });
});
