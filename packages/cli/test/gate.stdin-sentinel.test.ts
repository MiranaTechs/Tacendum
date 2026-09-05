/**
 * Gate 2026-09-03 — the explicit `-` stdin sentinel.
 *
 * M10 asked for "a TTY check or an explicit `-`". Only the TTY check shipped,
 * and it closes the interactive mistake but not the embedded one: a host that
 * OWNS fd 0 — the MCP server speaks JSON-RPC over exactly that fd — is not a
 * terminal, so an omitted body there would read the transport as a message
 * body and the guard could not see it. `-` is the way a caller says "stdin,
 * deliberately", and its absence is the way a caller says "I forgot the body".
 *
 * The reader is injected rather than stubbed on `node:fs`, because the real
 * `readFileSync(0)` in a test worker either returns the runner's own stdin or
 * blocks on it — both of which would make this file a flake rather than a
 * check. `process.stdin.isTTY` is the real property, set and restored.
 *
 * REVERTS THAT MUST MAKE THIS FILE FAIL:
 *  - drop `text === STDIN_SENTINEL ? undefined : text` (a literal "-" is sent)
 *  - drop `text !== STDIN_SENTINEL &&` from the TTY guard (`-` refused at a
 *    terminal, which is the one place it is most clearly meant)
 *  - drop the `-` from the usage string or the HELP block (an affordance the
 *    tool has and does not offer).
 *  - drop `|| arg === '-'` from args.ts's positional test: a bare `-` becomes
 *    an unknown OPTION and `tacendum send a b -` dies at EXIT.USAGE before
 *    composeBody is ever reached — every behavioural case below calls
 *    composeBody directly, so nothing else in this file would notice.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { EXIT } from '../src/exit.js';
import { Reporter } from '../src/output.js';
import { STDIN_SENTINEL, composeBody } from '../src/send.js';

const report = new Reporter({ json: false, plain: true });

/** Run `fn` with `process.stdin.isTTY` forced, then put it back exactly. */
function withTty<T>(isTty: boolean, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.stdin, 'isTTY');
  const previous = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', {
    value: isTty,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (had) {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }
}

describe('the body argument decides where the body comes from', () => {
  it('sends a real body argument without touching fd 0', () => {
    let reads = 0;
    const body = withTty(true, () =>
      composeBody('build failed', undefined, report, () => {
        reads += 1;
        return 'NOT THIS';
      }),
    );
    expect(body).toBe('build failed');
    expect(reads).toBe(0);
  });

  it('honours `-` as READ STDIN even at a terminal', () => {
    const body = withTty(true, () =>
      composeBody(STDIN_SENTINEL, undefined, report, () => 'from the pipe\n'),
    );
    // The sentinel is consumed, not sent: a literal "-" reaching the phone
    // would be the bug this test exists for.
    expect(body).toBe('from the pipe');
  });

  it('refuses an OMITTED body at a terminal, and names `-` in the remedy', () => {
    expect(() =>
      withTty(true, () => composeBody(undefined, undefined, report, () => 'unreachable')),
    ).toThrowError(
      expect.objectContaining({
        exitCode: EXIT.USAGE,
        message: expect.stringContaining('pass - to read stdin deliberately'),
      }),
    );
  });

  it('keeps the implicit pipe form: an omitted body off a terminal still reads stdin', () => {
    // `make build || tacendum send ci me` is the premise of the product and
    // the gate's section 2 asserts it end to end; the sentinel must not have
    // become a requirement.
    const body = withTty(false, () =>
      composeBody(undefined, undefined, report, () => 'piped output\n'),
    );
    expect(body).toBe('piped output');
  });

  it('composes the title with a sentinel body exactly as with any other', () => {
    const body = withTty(false, () =>
      composeBody(STDIN_SENTINEL, 'build failed', report, () => 'exit 1\n'),
    );
    expect(body).toBe('build failed\nexit 1');
  });
});

describe('the usage text offers the affordance the code has', () => {
  const mainSrc = readFileSync(
    fileURLToPath(new URL('../src/main.ts', import.meta.url)),
    'utf8',
  );

  it("names `-` in `send`'s usage line and in the HELP block", () => {
    // Two surfaces, both reached by a confused operator: the usage string
    // thrown on a bad `send`, and `tacendum --help`.
    expect(mainSrc).toContain(
      'tacendum send <from> <to> ["<text>" | - | --attach <file>] [--title T]',
    );
    expect(mainSrc).toContain('a body of exactly - means READ STDIN, deliberately');
  });
});

describe('the argument parser is what lets `-` reach composeBody at all', () => {
  it("classifies a bare `-` as a POSITIONAL, not an unknown option", () => {
    // send.ts's comment leans on this clause (args.ts, `arg === '-'`) and
    // nothing else in packages/cli/test pinned it: without it the documented
    // affordance is an EXIT.USAGE error and every case above stays green.
    const args = parseArgs(['alice', 'bob', '-'], {
      value: ['--title', '--attach'],
      boolean: ['--drain'],
    });
    expect(args.positionals[2]).toBe(STDIN_SENTINEL);
    expect(args.positionals).toHaveLength(3);
  });

  it('still refuses a real unknown option', () => {
    expect(() => parseArgs(['alice', 'bob', '-x'], { value: ['--title'] })).toThrow();
  });
});
