import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The async dispatch refactor's gate.
 *
 * `handleLine` went async so a future tool may await a network call; stdout
 * purity then stops being a property of a synchronous read loop and becomes a
 * property of `runMcpTransport`'s SINGLE-FLIGHT FIFO CHAIN. Each test here
 * pins one consequence of that chain, and each was proven non-vacuous by
 * applying its named mutation and watching exactly this file go red:
 *
 *  a. ordering            — mutate: fire handleLine without awaiting the tail
 *  b. EOF drain           — mutate: resolve 'end' without chaining through tail
 *  c. oversized-after-slow — mutate: restore the inline -32700 write
 *  d. rejection containment — mutate: let the rejection escape the chain
 *  e. rebind across await — mutate: drop the console rebind
 *  f. shared-state serialization — mutate: run dispatches concurrently
 *  g. frame integrity under load — mutate: a stray stdout diagnostic
 *
 * The fake tools stand in through `toolRun`, the protected seam the notify
 * tool will register through — `TOOLS` (what tools/list advertises, and what
 * e2e-mcp.sh's absence assertion guards) is untouched by a subclass, so this
 * file adds nothing to the shipped surface.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-mcp-flight-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { McpServer, runMcpTransport, MAX_FRAME_CHARS } = await import('../src/mcp.js');
type ToolRun = import('../src/mcp.js').ToolRun;

const USER_ID = '01AGENTAGENTAGENTAGENTAGEN';
saveProfile({
  name: 'flight',
  identityKey: 'IDKEYFLIGHT==',
  userId: USER_ID,
  authToken: 'tok-flight',
  registrationId: 1,
  deviceId: 1,
});

/** A subclass widens what IT serves; the shipped tool list stays exactly the
 * three read-side entries. This is the seam under test, used as designed. */
class TestServer extends McpServer {
  constructor(private readonly extra: Record<string, ToolRun>) {
    super('flight');
  }
  protected override toolRun(name: string): ToolRun | null {
    return this.extra[name] ?? super.toolRun(name);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** One macrotask round — enough for PassThrough delivery and the microtask
 * hops of a chain link, without ever sleeping on a wall-clock duration. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Wire a server to in-memory pipes, exactly as runMcpServer wires real
 * stdio. `lines()` is what a host has READ so far — the property every test
 * here interrogates is the order and shape of those bytes. */
function harness(server: InstanceType<typeof McpServer>): {
  stdin: PassThrough;
  done: Promise<void>;
  lines: () => string[];
  raw: () => string;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let raw = '';
  stdout.on('data', (d: Buffer | string) => {
    raw += d.toString();
  });
  const done = runMcpTransport(server, stdin, stdout);
  return { stdin, done, lines: () => raw.split('\n').filter((l) => l !== ''), raw: () => raw };
}

/** Bounded, so a mutation that silences the transport fails with a count
 * instead of hanging the suite into vitest's opaque timeout. */
async function waitFor(count: number, lines: () => string[], ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (lines().length < count) {
    if (Date.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${count} frames; the transport wrote ${lines().length}`);
    }
    await tick();
  }
}

function reqLine(id: number, name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

interface Frame {
  jsonrpc: string;
  id: number | null;
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
}

function parseAll(lines: string[]): Frame[] {
  return lines.map((l) => JSON.parse(l) as Frame);
}

// The transport rebinds the console for the life of the process — correct in
// the real server, a leak into every later test here. Captured before any
// harness runs; restored after each.
const realConsole = { log: console.log, info: console.info, warn: console.warn };
afterEach(() => {
  console.log = realConsole.log;
  console.info = realConsole.info;
  console.warn = realConsole.warn;
  vi.useRealTimers();
});

describe('the single-flight chain', () => {
  it('a. answers in request order when a slow async tool is followed by a fast one', async () => {
    const gate = deferred();
    const server = new TestServer({
      test_slow: {
        run: async () => {
          await gate.promise;
          return { slow: true };
        },
      },
    });
    const h = harness(server);
    h.stdin.write(`${reqLine(1, 'test_slow')}\n${reqLine(2, 'tacendum_whoami')}\n`);
    await tick();
    await tick();
    // While the first call is parked on its await, NOTHING answers — not even
    // the synchronous whoami queued behind it. An unchained dispatch answers
    // id 2 here, which is the reordering a host reads as a protocol violation.
    expect(h.lines()).toEqual([]);
    gate.resolve();
    await waitFor(2, h.lines);
    const frames = parseAll(h.lines());
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect(frames[0]?.result?.structuredContent).toEqual({ slow: true });
    expect(frames[1]?.result?.structuredContent).toEqual({ userId: USER_ID, label: 'flight' });
    h.stdin.end();
    await h.done;
  });

  it('b. EOF drains the in-flight call: the complete frame is written before the transport resolves', async () => {
    const gate = deferred();
    const server = new TestServer({
      test_slow: {
        run: async () => {
          await gate.promise;
          return { drained: true };
        },
      },
    });
    const h = harness(server);
    h.stdin.write(`${reqLine(1, 'test_slow')}\n`);
    await tick();
    h.stdin.end();
    await tick();
    await tick();
    // Snapshot stdout AT THE MOMENT the transport resolves: 'end' resolving
    // outside the chain settles here with an empty snapshot, which is the
    // truncated session a host reads as a died-mid-answer server.
    let atResolve: string[] | undefined;
    const settled = h.done.then(() => {
      atResolve = h.lines();
    });
    gate.resolve();
    await settled;
    const frames = parseAll(atResolve ?? []);
    expect(frames.map((f) => f.id)).toEqual([1]);
    expect(frames[0]?.result?.structuredContent).toEqual({ drained: true });
  });

  it('c. an oversized line queued behind a slow call answers -32700 AFTER the slow frame', async () => {
    const gate = deferred();
    const server = new TestServer({
      test_slow: {
        run: async () => {
          await gate.promise;
          return { slow: true };
        },
      },
    });
    const h = harness(server);
    h.stdin.write(`${reqLine(1, 'test_slow')}\n`);
    await tick();
    // No trailing newline: this is the buffered-frame memory cap, the one
    // error the old loop wrote INLINE from the data handler.
    h.stdin.write('x'.repeat(MAX_FRAME_CHARS + 16));
    await tick();
    await tick();
    // The -32700 must not jump the queue while call 1 is parked.
    expect(h.lines()).toEqual([]);
    gate.resolve();
    await waitFor(2, h.lines);
    const frames = parseAll(h.lines());
    expect(frames.map((f) => f.id)).toEqual([1, null]);
    expect(frames[0]?.result?.structuredContent).toEqual({ slow: true });
    expect(frames[1]?.error?.code).toBe(-32700);
    h.stdin.end();
    await h.done;
  });

  it('c2. discard mode KEEPS the memory cap: newline-free bytes after the trip are dropped, not buffered', async () => {
    // The cap's own stated threat is a hostile or broken pipe that streams
    // one enormous line. Before the fix, the `!discardingOversized` guard on
    // the cap check meant the FIRST MiB tripped it and every byte after
    // re-accumulated in `buffer` unbounded — the guard dead in its own
    // scenario (measured: 200 MB in, 200 MB heap growth). While discarding,
    // non-newline-terminated input must be dropped on arrival.
    const server = new TestServer({});
    const h = harness(server);
    h.stdin.write('x'.repeat(MAX_FRAME_CHARS + 16));
    await waitFor(1, h.lines);
    expect(parseAll(h.lines())[0]?.error?.code).toBe(-32700);

    // The hostile tail: one reused 1 MiB chunk written 384 times with no
    // newline. Only transport-side buffering can hold the full 384 MB live —
    // the margin below (128 MiB) is far above transient/GC noise and far
    // below the accumulated stream, so the verdict cannot flip on timing.
    const chunk = 'y'.repeat(MAX_FRAME_CHARS);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 384; i += 1) {
      h.stdin.write(chunk);
      if (i % 32 === 31) await tick();
    }
    await tick();
    const growth = process.memoryUsage().heapUsed - before;
    expect(growth, 'discard mode must not buffer the frame it is discarding').toBeLessThan(
      128 * 1024 * 1024,
    );
    // Still exactly ONE -32700 for the whole oversized frame…
    expect(h.lines()).toHaveLength(1);
    // …and the next newline ends the discard: frames after it answer.
    h.stdin.write(`\n${reqLine(9, 'tacendum_whoami')}\n`);
    await waitFor(2, h.lines);
    expect(parseAll(h.lines())[1]?.id).toBe(9);
    h.stdin.end();
    await h.done;
  });

  it('d. a rejecting async tool becomes an isError result — and the next request still answers', async () => {
    const server = new TestServer({
      test_reject: {
        run: async () => {
          await tick();
          throw new Error('dial failed');
        },
      },
    });
    const h = harness(server);
    h.stdin.write(`${reqLine(1, 'test_reject')}\n${reqLine(2, 'tacendum_whoami')}\n`);
    await waitFor(2, h.lines);
    const frames = parseAll(h.lines());
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    // A tool-execution failure is a TOOL result, not a protocol error and
    // never a dead transport.
    expect(frames[0]?.error).toBeUndefined();
    expect(frames[0]?.result?.isError).toBe(true);
    expect(frames[0]?.result?.content?.[0]?.text).toContain('dial failed');
    expect(frames[1]?.result?.structuredContent).toEqual({ userId: USER_ID, label: 'flight' });
    h.stdin.end();
    await h.done;
  });

  it('e. a console.log AFTER an await lands on stderr; stdout carries only frames', async () => {
    const seen: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        seen.push(String(chunk));
        return true;
      });
    try {
      const server = new TestServer({
        test_log: {
          run: async () => {
            await tick();
            // The stray print the file header wars against, in the spot only
            // the async refactor makes possible: after the dispatch parked.
            console.log('MARKER-AFTER-AWAIT');
            return { ok: true };
          },
        },
      });
      const h = harness(server);
      h.stdin.write(`${reqLine(1, 'test_log')}\n`);
      await waitFor(1, h.lines);
      h.stdin.end();
      await h.done;
      expect(seen.join(''), 'the rebound console did not deliver the log to stderr').toContain(
        'MARKER-AFTER-AWAIT',
      );
      expect(h.raw()).not.toContain('MARKER-AFTER-AWAIT');
      for (const f of parseAll(h.lines())) {
        expect(f.jsonrpc).toBe('2.0');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('f. two queued calls on shared state serialize: the second observes the first\'s write', async () => {
    const journal: string[] = [];
    const server = new TestServer({
      test_journal: {
        run: async () => {
          const seen = journal.length;
          await tick();
          journal.push('entry');
          return { seen };
        },
      },
    });
    const h = harness(server);
    h.stdin.write(`${reqLine(1, 'test_journal')}\n${reqLine(2, 'test_journal')}\n`);
    await waitFor(2, h.lines);
    const frames = parseAll(h.lines());
    // [0, 1]: the second call started only after the first COMPLETED its
    // write. Concurrent dispatches both read 0 — the interleaving that
    // corrupts a MessageLog or a send journal even when the frames still
    // leave in order.
    expect(frames.map((f) => f.result?.structuredContent?.seen)).toEqual([0, 1]);
    h.stdin.end();
    await h.done;
  });

  it('g. under queued load, every stdout line is exactly one complete JSON-RPC frame', async () => {
    const server = new TestServer({
      test_slow: {
        run: async () => {
          await tick();
          return { slow: true };
        },
      },
    });
    const h = harness(server);
    const input: string[] = [];
    let id = 0;
    for (let i = 0; i < 12; i++) {
      input.push(reqLine(++id, 'test_slow'));
      input.push(reqLine(++id, 'tacendum_whoami'));
      input.push(`garbage that is not a frame ${i}`);
      input.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    }
    const payload = `${input.join('\n')}\n`;
    // Delivered in arbitrary 1000-char slices, so lines split across chunk
    // boundaries and the queue builds while slow calls park.
    for (let off = 0; off < payload.length; off += 1000) {
      h.stdin.write(payload.slice(off, off + 1000));
    }
    h.stdin.end();
    await h.done;
    // e2e-mcp.sh 2b's property, under the queued load the shell gate cannot
    // produce (its tools all answer synchronously): a torn or non-frame line
    // fails the parse right here.
    const frames = parseAll(h.lines());
    expect(frames).toHaveLength(36); // 24 answers + 12 parse errors, not one line more
    for (const f of frames) {
      expect(f.jsonrpc).toBe('2.0');
      expect('id' in f).toBe(true);
      expect(f.result !== undefined || f.error !== undefined).toBe(true);
    }
    expect(frames.filter((f) => f.id !== null).map((f) => f.id)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });
});

describe('the per-call deadline seam (no shipped tool uses it yet)', () => {
  it('turns a hung tool into a tool error at its deadline — on a MOVING clock — and the transport lives', async () => {
    // Fake timers that ADVANCE, never a pinned Date.now beside them: the
    // frozen-clock pattern shipped two release-blocking call defects under a
    // green suite (repo ruling), and a deadline is exactly the arithmetic it
    // hides.
    vi.useFakeTimers();
    const server = new TestServer({
      test_hang: {
        deadlineMs: 5000,
        run: () => new Promise(() => undefined), // a dial that never answers
      },
    });
    const p = server.handleLine(reqLine(1, 'test_hang'));
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled, 'answered before its deadline had elapsed').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, 'the deadline elapsed and no frame settled').toBe(true);
    const frame = JSON.parse((await p) as string) as Frame;
    expect(frame.id).toBe(1);
    expect(frame.error).toBeUndefined();
    expect(frame.result?.isError).toBe(true);
    expect(frame.result?.content?.[0]?.text).toContain('deadline');
    // The transport outlived the expiry — the whole point of the seam.
    const after = JSON.parse(
      (await server.handleLine(reqLine(2, 'tacendum_whoami'))) as string,
    ) as Frame;
    expect(after.result?.structuredContent).toEqual({ userId: USER_ID, label: 'flight' });
  });
});
