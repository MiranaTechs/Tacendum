import { describe, expect, it } from 'vitest';
import {
  flagBool,
  flagCount,
  flagNumber,
  flagString,
  parseArgs,
  scanGlobals,
} from '../src/args.js';
import { CliError, EXIT } from '../src/exit.js';

/**
 * the design plan Each case here is a failure the index-based parser actually
 * had, kept as a test because none of them announced themselves — two of the
 * three exited 0.
 */
describe('argument parsing', () => {
  it('binds positionals independently of flag position', () => {
    // `cli listen --calls alice` used to bind name = '--calls' and then die in
    // the store layer with `invalid client name: "--calls"`.
    const args = parseArgs(['--calls', 'alice'], { boolean: ['--calls'] });
    expect(args.positionals).toEqual(['alice']);
    expect(flagBool(args, '--calls')).toBe(true);
  });

  it('refuses an unknown option instead of ignoring it', () => {
    // `--titel "build failed"` used to send an untitled notification and
    // report success.
    const err = (() => {
      try {
        parseArgs(['ci', 'me', '--titel', 'x'], { value: ['--title'] });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
  });

  it('refuses a value flag with no value instead of silently defaulting', () => {
    expect(() => parseArgs(['--seconds'], { value: ['--seconds'] })).toThrow(/needs a value/);
  });

  it('refuses a non-numeric count instead of producing NaN', () => {
    // Number('abc') -> NaN -> setTimeout(NaN) fires immediately, so an
    // 18-second listener became a no-op that exited 0.
    const args = parseArgs(['--seconds', 'abc'], { value: ['--seconds'] });
    expect(() => flagCount(args, '--seconds', 30)).toThrow(/expects a non-negative whole number/);
    expect(() => flagNumber(args, '--seconds', 30)).toThrow(/expects a non-negative whole number/);
  });

  it('refuses a negative or fractional count', () => {
    const negative = parseArgs(['--ice', '-1'], { value: ['--ice'] });
    expect(() => flagCount(negative, '--ice', 0)).toThrow(/non-negative whole number/);
    const fractional = parseArgs(['--ice', '2.5'], { value: ['--ice'] });
    expect(() => flagCount(fractional, '--ice', 0)).toThrow(/non-negative whole number/);
  });

  it('treats everything after -- as a positional', () => {
    // A build log can start with a dash; without a terminator there would be
    // text this tool simply could not send.
    const args = parseArgs(['ci', 'me', '--', '--not-a-flag'], { value: ['--title'] });
    expect(args.positionals).toEqual(['ci', 'me', '--not-a-flag']);
  });

  it('reads a value flag and the global booleans', () => {
    const args = parseArgs(['ci', 'me', '--title', 'build failed', '--json'], {
      value: ['--title'],
    });
    expect(args.positionals).toEqual(['ci', 'me']);
    expect(flagString(args, '--title')).toBe('build failed');
    expect(flagBool(args, '--json')).toBe(true);
    expect(flagBool(args, '--plain')).toBe(false);
  });
});

/**
 * The global flags are read BEFORE the command's own spec exists, so this scan
 * is a second, independent parser — and it had two bugs the real one did not,
 * both of which refused a command line that is documented to work.
 */
describe('the global-flag scan', () => {
  it('finds --json and --plain wherever they appear', () => {
    expect(scanGlobals(['alice', 'bob', '--json'])).toEqual({ json: true, plain: false });
    expect(scanGlobals(['--plain', 'alice'])).toEqual({ json: false, plain: true });
    expect(scanGlobals(['alice'])).toEqual({ json: false, plain: false });
  });

  it('stops at --, so a message body may begin with --json', () => {
    // `tacendum send ci me -- "--json is broken in prod"` used to die with
    // `error: unknown option --json is broken in prod` (exit 2). The whole
    // point of `--` is that a log line starting with a dash can be sent.
    expect(scanGlobals(['ci', 'me', '--', '--json is broken in prod'])).toEqual({
      json: false,
      plain: false,
    });
    expect(scanGlobals(['ci', 'me', '--', '--plain'])).toEqual({ json: false, plain: false });
  });

  it('matches exactly, not by prefix', () => {
    // The prefix rule was what dragged the body into the parser in the first
    // place: `--jsonish` is not `--json`.
    expect(scanGlobals(['ci', 'me', '--jsonish'])).toEqual({ json: false, plain: false });
  });

  it('does not mistake a value flag’s argument for a global', () => {
    // `send ci me hello --title --json` — where `--json` is legitimately the
    // title — used to switch the whole command into JSON mode.
    expect(scanGlobals(['ci', 'me', 'hello', '--title', '--json'])).toEqual({
      json: false,
      plain: false,
    });
    // ...and the flag after the consumed value is still seen.
    expect(scanGlobals(['ci', 'me', '--title', '--plain', '--json'])).toEqual({
      json: true,
      plain: false,
    });
  });
});
