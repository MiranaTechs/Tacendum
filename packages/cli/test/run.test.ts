import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermetic before ANY src import: run.ts pulls config.ts, which resolves
// endpoints at import time; nothing in this suite may touch a real host.
const home = mkdtempSync(join(tmpdir(), 'tacendum-run-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://run.test';
process.env.TACENDUM_WS = 'ws://run.test';

const {
  OutputTail,
  TAIL_BYTES,
  buildNotificationBody,
  cmdRun,
  formatDuration,
  guardSink,
  parseRunArgv,
  runChild,
  wrapperExitCode,
} = await import('../src/run.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { Reporter } = await import('../src/output.js');
const { saveProfile } = await import('../src/profile.js');
type ChildOutcome = import('../src/run.js').ChildOutcome;
type SignalSource = import('../src/run.js').SignalSource;

const OWNER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

/** A value shaped like the secrets the no-leak rule exists for. It must never appear on
 * any surface but the (stubbed) notification body and the raw passthrough. */
const CANARY = 'AKIACANARY7SECRET7VALUE99';

function usageError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    return err as CliError;
  }
  throw new Error('expected a CliError and got none');
}

describe('parseRunArgv', () => {
  it('splits at the first -- and keeps the child argv verbatim', () => {
    const inv = parseRunArgv(['ci', OWNER, '--name', 'build', '--', 'make', '-j4', '--flag']);
    expect(inv).toMatchObject({
      fromName: 'ci',
      to: OWNER,
      label: 'build',
      command: 'make',
      args: ['-j4', '--flag'],
    });
  });

  it('a child --json after -- is the child\'s, and never parsed as ours', () => {
    // If the head parse ever ran over the whole line, `--json` here would
    // either flip modes or (as a stray flag in a value slot) get eaten.
    const inv = parseRunArgv(['ci', '--', 'node', '--json', '--not-a-tacendum-flag']);
    expect(inv.command).toBe('node');
    expect(inv.args).toEqual(['--json', '--not-a-tacendum-flag']);
  });

  it('refuses a line without --, naming the fix', () => {
    const err = usageError(() => parseRunArgv(['ci', 'make', 'build']));
    expect(err.message).toContain('--');
  });

  it('refuses an empty command after --', () => {
    usageError(() => parseRunArgv(['ci', '--']));
  });

  it('refuses a missing account', () => {
    usageError(() => parseRunArgv(['--', 'make']));
  });

  it('refuses >2 positionals without echoing them', () => {
    const err = usageError(() => parseRunArgv(['ci', OWNER, CANARY, '--', 'make']));
    expect(err.message).not.toContain(CANARY);
  });

  it('--help wins over everything else', () => {
    expect(parseRunArgv(['--help']).help).toBe(true);
    expect(parseRunArgv(['ci', '--help', '--', 'make']).help).toBe(true);
  });
});

describe('wrapperExitCode — the one exit rule', () => {
  it('passes the child code through untouched', () => {
    expect(wrapperExitCode({ code: 0, signal: null }).exit).toBe(0);
    expect(wrapperExitCode({ code: 7, signal: null }).exit).toBe(7);
    expect(wrapperExitCode({ code: 254, signal: null }).exit).toBe(254);
  });

  it('remaps a child exit of 2 to 1, loudly', () => {
    const { exit, note } = wrapperExitCode({ code: 2, signal: null });
    expect(exit).toBe(1);
    expect(note).toBeDefined();
    expect(note).toContain('2');
  });

  it('NEVER returns 2, for any wait status a child can produce', () => {
    for (let code = 0; code <= 255; code++) {
      expect(wrapperExitCode({ code, signal: null }).exit).not.toBe(2);
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'] as const) {
      expect(wrapperExitCode({ code: null, signal }).exit).not.toBe(2);
    }
  });

  it('spells signal death the way a shell would (128+signum)', () => {
    expect(wrapperExitCode({ code: null, signal: 'SIGINT' }).exit).toBe(130);
    expect(wrapperExitCode({ code: null, signal: 'SIGTERM' }).exit).toBe(143);
  });

  it('uses the shell conventions for start failures, without echoing the command', () => {
    const notFound = wrapperExitCode({ code: null, signal: null, startFailure: 'not-found' });
    expect(notFound.exit).toBe(127);
    const notRunnable = wrapperExitCode({ code: null, signal: null, startFailure: 'not-runnable' });
    expect(notRunnable.exit).toBe(126);
    expect(notFound.note).toBeDefined();
  });
});

describe('OutputTail', () => {
  it('keeps the END of the output, bounded at TAIL_BYTES', () => {
    const tail = new OutputTail();
    // 400 * 11 bytes = 4400 — more than twice the bound, so the head MUST go.
    for (let i = 0; i < 400; i++) {
      tail.push(Buffer.from(`chunk-${String(i).padStart(4, '0')}\n`));
    }
    const text = tail.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TAIL_BYTES);
    expect(text.endsWith('chunk-0399\n')).toBe(true);
    expect(text).not.toContain('chunk-0000'); // the head is gone
  });

  it('bounds a single oversized chunk too', () => {
    const tail = new OutputTail();
    tail.push(Buffer.from('A'.repeat(TAIL_BYTES * 5) + 'END'));
    const text = tail.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TAIL_BYTES);
    expect(text.endsWith('END')).toBe(true);
  });

  it('does not open with mojibake when the slice lands inside a UTF-8 sequence', () => {
    const tail = new OutputTail(8);
    tail.push(Buffer.from('日本語テキスト')); // 3 bytes per char: 8 is mid-sequence
    expect(tail.text().startsWith('�')).toBe(false);
  });

  it('bounds MEMORY, not just the formatted text (F18)', () => {
    const tail = new OutputTail();
    const heldBytes = (): number =>
      (tail as unknown as { chunks: Buffer[] }).chunks.reduce((n, b) => n + b.length, 0);
    // One oversized chunk: what is HELD must shrink to the limit at push
    // time, not merely be sliced down when text() formats it.
    const big = Buffer.alloc(8 * 1024 * 1024, 0x61);
    big.write('END', big.length - 3);
    tail.push(big);
    expect(heldBytes()).toBeLessThanOrEqual(TAIL_BYTES);
    // And what is held must be a COPY, not a subarray view that pins the
    // 8 MiB source allocation alive behind a 2 KiB window.
    for (const b of (tail as unknown as { chunks: Buffer[] }).chunks) {
      expect(b.buffer.byteLength).toBeLessThan(1024 * 1024);
    }
    expect(tail.text().endsWith('END')).toBe(true);
    // A stream of pipe-sized (64 KiB) chunks stays bounded the same way.
    for (let i = 0; i < 16; i++) tail.push(Buffer.alloc(64 * 1024, 0x62));
    expect(heldBytes()).toBeLessThanOrEqual(TAIL_BYTES);
  });
});

describe('guardSink — the consumer that dies mid-run', () => {
  it('a SYNCHRONOUS throw from write marks the sink broken; later writes are discarded, callbacks still fire', () => {
    let calls = 0;
    const g = guardSink({
      write(): boolean {
        calls++;
        if (calls >= 2) throw new Error('EPIPE');
        return true;
      },
    });
    expect(g.write(Buffer.from('a'))).toBe(true);
    expect(g.broken).toBe(false);
    // The throw is swallowed — the wrapper must outlive its consumer.
    expect(g.write(Buffer.from('b'))).toBe(true);
    expect(g.broken).toBe(true);
    g.write(Buffer.from('c'));
    expect(calls).toBe(2); // nothing more reaches a dead consumer
    // drained()'s sentinel must not hang on a broken sink: callback fires,
    // and writableLength reports nothing left to wait for.
    let cbFired = false;
    g.write(Buffer.alloc(0), () => {
      cbFired = true;
    });
    expect(cbFired).toBe(true);
    expect(g.writableLength).toBe(0);
  });

  it("an ASYNC 'error' event marks the sink broken and fires the pending drain wait", () => {
    const ee = new EventEmitter();
    const g = guardSink({
      write: () => false, // always backed up: every write starts a drain wait
      once: (event: 'drain' | 'error', listener: () => void) => void ee.once(event, listener),
      on: (event: 'error', listener: () => void) => void ee.on(event, listener),
    });
    g.write(Buffer.from('x'));
    let drainFired = 0;
    g.once?.('drain', () => drainFired++);
    expect(drainFired).toBe(0);
    ee.emit('error', new Error('write EPIPE'));
    // The drain will never come; the guard fires the wait itself so the
    // paused child stream resumes and the run can end.
    expect(g.broken).toBe(true);
    expect(drainFired).toBe(1);
    // A drain wait requested AFTER breakage fires immediately.
    g.once?.('drain', () => drainFired++);
    expect(drainFired).toBe(2);
  });
});

describe('formatDuration', () => {
  it('picks the humane unit', () => {
    expect(formatDuration(412)).toBe('412ms');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe('2h 5m');
  });
});

describe('buildNotificationBody', () => {
  const ok: ChildOutcome = { code: 0, signal: null };

  it('success: label, ok, duration, tail after a separator', () => {
    const body = buildNotificationBody('build', ok, 42_000, 'last lines');
    expect(body).toBe('build: ok in 42s\n--- output tail ---\nlast lines');
  });

  it('failure carries the REAL exit code — including 2, which the wrapper itself remaps', () => {
    const body = buildNotificationBody('build', { code: 2, signal: null }, 1000, '');
    expect(body).toContain('exit 2');
    expect(body).toContain('FAILED');
  });

  it('signal death and start failure each say what happened', () => {
    expect(buildNotificationBody('b', { code: null, signal: 'SIGINT' }, 1000, '')).toContain(
      'killed by SIGINT',
    );
    expect(
      buildNotificationBody('b', { code: null, signal: null, startFailure: 'not-found' }, 5, ''),
    ).toContain('command not found');
  });

  it('an empty tail means no separator', () => {
    expect(buildNotificationBody('b', ok, 1000, '')).toBe('b: ok in 1s');
  });
});

/** Collect a stream's chunks without letting them near the real terminal. */
function sink(): { write(chunk: Buffer): boolean; data(): string } {
  const chunks: Buffer[] = [];
  return {
    write(chunk: Buffer): boolean {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    data: () => Buffer.concat(chunks).toString('utf8'),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read a pid a spawned driver wrote, once it is ACTUALLY THERE.
 *
 * `writeFileSync` is open-then-write-then-close, so between the open and the
 * write the path exists and holds zero bytes. A poll that gates on
 * `existsSync` alone can win that race, and `Number('')` is 0 — which is not
 * a harmless wrong answer, because pid 0 means THE CALLER'S OWN PROCESS GROUP.
 * `process.kill(0, 0)` therefore always succeeds, so a liveness probe on it
 * reports "still alive" forever and the test fails claiming an orphan. Under
 * full-suite load the scheduler preempts between the open and the write often
 * enough to see it; alone it effectively never loses.
 *
 * So: wait for a parseable pid rather than for a path, and refuse anything
 * that is not a plausible child. Drivers here also write via rename, which
 * closes the window at the source — this is the second lock on the same door,
 * because the value feeds a kill().
 */
async function readChildPid(pidFile: string, ms = 15_000): Promise<number> {
  let seen = '';
  await poll(() => {
    seen = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : '';
    return /^\d+$/.test(seen.trim());
  }, ms);
  const pid = Number(seen.trim());
  expect(pid, `driver never wrote a usable pid (saw ${JSON.stringify(seen)})`).toBeGreaterThan(1);
  return pid;
}

async function poll(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await sleep(20);
  }
}

describe('runChild', () => {
  it('streams stdout AND stderr through unchanged while capturing a bounded tail', async () => {
    const out = sink();
    const err = sink();
    const tail = new OutputTail();
    const script = `process.stdout.write('X'.repeat(5000)); process.stderr.write('E-STREAM'); process.exitCode = 3;`;
    const { done } = runChild(
      process.execPath,
      ['-e', script],
      tail,
      { stdout: out, stderr: err },
      new EventEmitter() as unknown as SignalSource,
    );
    const outcome = await done;
    expect(outcome.code).toBe(3);
    // Passthrough is UNCHANGED: all 5000 bytes, even though the tail keeps 2048.
    expect(out.data()).toBe('X'.repeat(5000));
    expect(err.data()).toBe('E-STREAM');
    expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(TAIL_BYTES);
  });

  it('reports a nonexistent command as a start failure, not a crash', async () => {
    const { done } = runChild(
      join(home, 'no-such-binary-anywhere'),
      [],
      new OutputTail(),
      { stdout: sink(), stderr: sink() },
      new EventEmitter() as unknown as SignalSource,
    );
    const outcome = await done;
    expect(outcome.startFailure).toBe('not-found');
    expect(wrapperExitCode(outcome).exit).toBe(127);
  });

  it('forwards a signal to the child, reaps it, and removes its handlers', async () => {
    const source = new EventEmitter();
    const { child, done } = runChild(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      new OutputTail(),
      { stdout: sink(), stderr: sink() },
      source as unknown as SignalSource,
    );
    expect(child).not.toBeNull();
    expect(source.listenerCount('SIGTERM')).toBe(1);
    source.emit('SIGTERM');
    const outcome = await done;
    expect(outcome.signal).toBe('SIGTERM');
    // No orphan: the pid is gone (kill 0 probes without signalling).
    expect(() => process.kill((child as ChildProcess).pid as number, 0)).toThrow();
    // Handlers disposed, so the notify phase gets default signal handling back.
    expect(source.listenerCount('SIGTERM')).toBe(0);
    expect(source.listenerCount('SIGINT')).toBe(0);
  });

  it('spawns the child as its own process-group leader (F19: no kernel double-delivery)', async () => {
    const source = new EventEmitter();
    const { child, done } = runChild(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      new OutputTail(),
      { stdout: sink(), stderr: sink() },
      source as unknown as SignalSource,
    );
    expect(child).not.toBeNull();
    const pid = (child as ChildProcess).pid as number;
    // If the child sat in the WRAPPER's group, -pid would name no group and
    // the probe would throw ESRCH. A group of its own means a foreground
    // Ctrl-C on the wrapper's group cannot reach the child a second time
    // around the forwarder — a trapping child runs its cleanup exactly once.
    await poll(() => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    }, 2000);
    source.emit('SIGTERM');
    const outcome = await done;
    expect(outcome.signal).toBe('SIGTERM');
  });

  it('uninstalls its handlers after the FIRST delivery, so a second signal is not swallowed (F19)', async () => {
    const source = new EventEmitter();
    const { done } = runChild(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      new OutputTail(),
      { stdout: sink(), stderr: sink() },
      source as unknown as SignalSource,
    );
    expect(source.listenerCount('SIGTERM')).toBe(1);
    source.emit('SIGTERM');
    // IMMEDIATELY — before the child is even reaped — the wrapper is back to
    // default dispositions, so a second TERM kills the wrapper rather than
    // vanishing into a forwarder whose child refuses to die.
    expect(source.listenerCount('SIGTERM')).toBe(0);
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGHUP')).toBe(0);
    await done;
  });

  it('obeys sink backpressure: a false write pauses the child instead of buffering it (F18)', async () => {
    const drainers = new EventEmitter();
    let received = 0;
    const out = {
      write(chunk: Buffer): boolean {
        received += chunk.length;
        return false; // consumer is always behind
      },
      once(event: 'drain', listener: () => void): unknown {
        return drainers.once(event, listener);
      },
    };
    const total = 512 * 1024;
    const { done } = runChild(
      process.execPath,
      ['-e', `process.stdout.write(Buffer.alloc(${total}, 0x61))`],
      new OutputTail(),
      { stdout: out, stderr: sink() },
      new EventEmitter() as unknown as SignalSource,
    );
    // The first write said false and no drain has fired: the child must be
    // PAUSED at the pipe, so only a bounded prefix has crossed — not, as
    // before the fix, the entire output accumulating in wrapper memory.
    await poll(() => received > 0);
    await sleep(250);
    expect(received).toBeLessThan(total);
    // Now play the slow consumer that eventually drains: every byte arrives.
    const interval = setInterval(() => drainers.emit('drain'), 5);
    const outcome = await done;
    clearInterval(interval);
    expect(outcome.code).toBe(0);
    expect(received).toBe(total);
  });

  it('a forwarded signal ends the run even when the consumer NEVER drains', async () => {
    // The gate's cancellation shape: the sink reports backpressure and its
    // drain never comes, so the child's stream is paused; the user then
    // cancels. Pre-fix the paused stream never reached 'end', the child's
    // 'close' never fired, and `done` — with the user's Ctrl-C already
    // delivered and the child already dead — never resolved.
    const source = new EventEmitter();
    let received = 0;
    const out = {
      write(chunk: Buffer): boolean {
        received += chunk.length;
        return false; // stuck consumer…
      },
      once(): void {
        /* …whose drain NEVER fires */
      },
    };
    const script = `process.stdout.write(Buffer.alloc(1024 * 1024, 0x61), () => {}); setInterval(() => {}, 1000);`;
    const { done } = runChild(
      process.execPath,
      ['-e', script],
      new OutputTail(),
      { stdout: out, stderr: sink() },
      source as unknown as SignalSource,
    );
    await poll(() => received > 0); // the stream is now paused mid-flood
    source.emit('SIGTERM');
    const outcome = await done; // pre-fix: never resolves (test times out)
    expect(outcome.signal).toBe('SIGTERM');
    expect(outcome.cancelled).toBe(true);
  }, 15_000);

  it('an EXTERNAL kill of the child is not a cancellation: outcome.cancelled stays unset', async () => {
    const { child, done } = runChild(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      new OutputTail(),
      { stdout: sink(), stderr: sink() },
      new EventEmitter() as unknown as SignalSource,
    );
    process.kill((child as ChildProcess).pid as number, 'SIGTERM');
    const outcome = await done;
    expect(outcome.signal).toBe('SIGTERM');
    // Only the wrapper's own forwarding marks cancellation — an external kill
    // keeps the full F18 drain guarantee in cmdRun.
    expect(outcome.cancelled).toBeUndefined();
  });

  it('a SYNCHRONOUS spawn error (ENOTDIR) becomes a start failure, not a throw', async () => {
    // A path THROUGH a plain file: Node routes only a whitelist of errnos
    // (ENOENT, EACCES, ...) via the 'error' event and throws the rest from
    // the spawn call itself — ENOTDIR is one it throws.
    const file = join(home, 'a-plain-file');
    writeFileSync(file, 'not a directory');
    const { child, done } = runChild(
      join(file, 'sub'),
      [],
      new OutputTail(),
      { stdout: sink(), stderr: sink() },
      new EventEmitter() as unknown as SignalSource,
    );
    expect(child).toBeNull();
    const outcome = await done;
    expect(outcome.startFailure).toBe('not-found');
    expect(wrapperExitCode(outcome).exit).toBe(127); // the shell convention
  });
});

describe('a real Ctrl-C: wrapper signalled, child must die, no orphan', () => {
  it('SIGINT to the wrapper process kills the grandchild and exits 130', async () => {
    // A real process tree — vitest -> driver (runChild) -> sleeper — because
    // the in-process test above cannot prove that a signal delivered BY THE
    // KERNEL to the wrapper reaches the child. The driver is the wrapper's
    // core (runChild + wrapperExitCode), which is exactly what main.ts wires.
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-run-sig-'));
    const pidFile = join(dir, 'pid');
    const outcomeFile = join(dir, 'outcome.json');
    const runModule = fileURLToPath(new URL('../src/run.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const driver = join(dir, 'driver.mjs');
    const driverSource = `
      import { renameSync, writeFileSync } from 'node:fs';
      import { runChild, OutputTail, wrapperExitCode } from ${JSON.stringify(runModule)};
      const { child, done } = runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], new OutputTail());
      // Rename, not a plain write: the reader must never observe the file
      // between its creation and its content. See readChildPid.
      writeFileSync(${JSON.stringify(pidFile)} + '.tmp', String(child.pid));
      renameSync(${JSON.stringify(pidFile)} + '.tmp', ${JSON.stringify(pidFile)});
      const outcome = await done;
      writeFileSync(${JSON.stringify(outcomeFile)}, JSON.stringify(outcome));
      process.exit(wrapperExitCode(outcome).exit);
    `;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(driver, driverSource);

    const wrapper = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    let wrapperStderr = '';
    wrapper.stderr.on('data', (d) => (wrapperStderr += String(d)));
    const closed = new Promise<number | null>((resolve) => wrapper.on('close', resolve));

    // Wait until the grandchild exists (the driver writes its pid), then
    // deliver SIGINT to the WRAPPER ONLY — process-directed, not the group,
    // so nothing but the forwarding under test can reach the grandchild.
    const grandchild = await readChildPid(pidFile).catch((err: unknown) => {
      throw new Error(`driver never spawned a child: ${wrapperStderr}`, { cause: err });
    });
    wrapper.kill('SIGINT');

    const exit = await closed;
    expect(exit, wrapperStderr).toBe(130); // 128 + SIGINT via wrapperExitCode
    expect(JSON.parse(readFileSync(outcomeFile, 'utf8'))).toMatchObject({ signal: 'SIGINT' });
    // The grandchild must be gone. Poll briefly: init reaps it the moment the
    // driver exits, but "the moment" is not guaranteed to be before this line.
    const gone = async (): Promise<boolean> => {
      const until = Date.now() + 3000;
      for (;;) {
        try {
          process.kill(grandchild, 0);
        } catch {
          return true;
        }
        if (Date.now() > until) return false;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    expect(await gone()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('F19: a grandchild must not orphan, and must not pin the wrapper open', () => {
  it('SIGTERM to the wrapper kills the WHOLE group — `sleep 600 &` included — and the wrapper exits 143', async () => {
    // The gate's repro: `sh -c 'sleep 600 & wait'`. Signalled by pid alone,
    // the shell dies, `sleep` survives holding the output pipe, and the
    // wrapper waits on 'close' forever. Group delivery must end all three.
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-run-orphan-'));
    const pidFile = join(dir, 'pid');
    const outcomeFile = join(dir, 'outcome.json');
    const runModule = fileURLToPath(new URL('../src/run.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `
      import { writeFileSync } from 'node:fs';
      import { runChild, OutputTail, wrapperExitCode } from ${JSON.stringify(runModule)};
      const { child, done } = runChild('/bin/sh', ['-c', 'sleep 600 & echo $!; wait'], new OutputTail());
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      const outcome = await done;
      writeFileSync(${JSON.stringify(outcomeFile)}, JSON.stringify(outcome));
      process.exit(wrapperExitCode(outcome).exit);
      `,
    );

    const wrapper = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutText = '';
    let stderrText = '';
    wrapper.stdout.on('data', (d) => (stdoutText += String(d)));
    wrapper.stderr.on('data', (d) => (stderrText += String(d)));
    const closed = new Promise<number | null>((resolve) => wrapper.on('close', resolve));

    // Wait until the shell has started AND printed the sleeper's pid.
    await poll(() => existsSync(pidFile) && /^\d+\n/.test(stdoutText), 15_000);
    const sleeper = Number(/^(\d+)\n/.exec(stdoutText)?.[1]);
    expect(sleeper).toBeGreaterThan(1);

    // Process-directed TERM to the WRAPPER only — the CI-cancellation shape.
    wrapper.kill('SIGTERM');
    const exit = await closed; // pre-fix this never resolves: sleep pins the pipe
    expect(exit, stderrText).toBe(143); // 128 + SIGTERM
    expect(JSON.parse(readFileSync(outcomeFile, 'utf8'))).toMatchObject({ signal: 'SIGTERM' });

    // And the sleeper is dead, not orphaned to init for the next ten minutes.
    await poll(() => {
      try {
        process.kill(sleeper, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('F18: a slow consumer must not cost the run its own output', () => {
  it('8 MiB through a consumer that starts reading late arrives whole, record and exit code intact', async () => {
    // The gate's repro, end to end: child writes 8 MiB and exits 7; the
    // consumer of the WRAPPER's stdout reads nothing for two seconds. The
    // combination under test is backpressure on the way through (the child
    // blocks at the pipe instead of the wrapper buffering ~180 MiB) and the
    // drain-before-exit (a nonzero code reaches process.exit only after the
    // last byte and the --json record have left the process).
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-run-slow-'));
    const runModule = fileURLToPath(new URL('../src/run.ts', import.meta.url));
    const profileModule = fileURLToPath(new URL('../src/profile.ts', import.meta.url));
    const outputModule = fileURLToPath(new URL('../src/output.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const driver = join(dir, 'driver.mjs');
    const MB8 = 8 * 1024 * 1024;
    writeFileSync(
      driver,
      `
      import { saveProfile } from ${JSON.stringify(profileModule)};
      import { cmdRun } from ${JSON.stringify(runModule)};
      import { Reporter } from ${JSON.stringify(outputModule)};
      saveProfile({ name: 'runner', identityKey: 'AAAA', userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', authToken: 'tok', registrationId: 1, deviceId: 1, accountClass: 'integration', ownerUserId: ${JSON.stringify(OWNER)} });
      const report = new Reporter({ json: true, plain: true });
      const script = 'process.stdout.write(Buffer.alloc(${MB8}, 0x61)); process.exitCode = 7;';
      const code = await cmdRun(['runner', '--', process.execPath, '-e', script], report, { notify: async () => {} });
      process.exit(code); // main.ts's nonzero path: exit as soon as the code is back
      `,
    );

    const wrapper = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TACENDUM_HOME: dir,
        TACENDUM_API: 'http://run.test',
        TACENDUM_WS: 'ws://run.test',
      },
    });
    let stderrText = '';
    wrapper.stderr.on('data', (d) => (stderrText += String(d)));
    const chunks: Buffer[] = [];
    const closed = new Promise<number | null>((resolve) => wrapper.on('close', resolve));
    // The slow consumer: attach no reader for two seconds. The stream stays
    // paused, the kernel pipe fills at ~64 KiB, and everything beyond that is
    // the wrapper's problem — exactly the gate's repro.
    await sleep(2000);
    wrapper.stdout.on('data', (d: Buffer) => chunks.push(d));
    const exit = await closed;

    expect(exit, stderrText).toBe(7);
    const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n');
    // Line 1: every one of the child's 8 MiB of 'a' bytes — none lost to the
    // exit. Line 2: the --json record, on its own line, also intact.
    expect(lines).toHaveLength(2);
    expect((lines[0] as string).length).toBe(MB8);
    expect(/^a+$/.test(lines[0] as string)).toBe(true);
    const record = JSON.parse(lines[1] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ ok: false, childExit: 7, exit: 7, notified: true });
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);
});

describe('EPIPE end to end: `tacendum run … | head` must not crash the wrapper', () => {
  it('the pipe closes after 20 lines; the wrapper survives and exits with the CHILD\'s code', async () => {
    // A real process and a real pipe, because the pre-fix failure was an
    // unhandled 'error' EVENT on process.stdout — something no in-process
    // mock can raise the way a closed kernel pipe does.
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-run-epipe-'));
    const runModule = fileURLToPath(new URL('../src/run.ts', import.meta.url));
    const profileModule = fileURLToPath(new URL('../src/profile.ts', import.meta.url));
    const outputModule = fileURLToPath(new URL('../src/output.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `
      import { saveProfile } from ${JSON.stringify(profileModule)};
      import { cmdRun } from ${JSON.stringify(runModule)};
      import { Reporter } from ${JSON.stringify(outputModule)};
      saveProfile({ name: 'runner', identityKey: 'AAAA', userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', authToken: 'tok', registrationId: 1, deviceId: 1, accountClass: 'integration', ownerUserId: ${JSON.stringify(OWNER)} });
      const report = new Reporter({ json: false, plain: true });
      const script = "let i = 0; const t = setInterval(() => { for (let j = 0; j < 50; j++) process.stdout.write('line ' + (i++) + ' ' + 'x'.repeat(80) + '\\\\n'); if (i >= 2000) { clearInterval(t); process.exitCode = 5; } }, 10);";
      const code = await cmdRun(['runner', '--', process.execPath, '-e', script], report, { notify: async () => {} });
      process.exit(code);
      `,
    );
    const wrapper = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TACENDUM_HOME: dir,
        TACENDUM_API: 'http://run.test',
        TACENDUM_WS: 'ws://run.test',
      },
    });
    let stderrText = '';
    wrapper.stderr.on('data', (d) => (stderrText += String(d)));
    const closed = new Promise<number | null>((resolve) => wrapper.on('close', resolve));
    // Play `head -20`: take a few lines, then close the read end of the pipe
    // while the child is still printing. Every wrapper write after this
    // raises EPIPE.
    let lines = 0;
    wrapper.stdout.on('data', (d: Buffer) => {
      lines += String(d).split('\n').length - 1;
      if (lines >= 20) wrapper.stdout.destroy();
    });
    const exit = await closed;
    // Pre-fix: an uncaught EPIPE killed the wrapper with 1 (and a stack on
    // stderr) while the child was mid-run; the child's code was lost.
    expect(exit, stderrText).toBe(5);
    expect(stderrText).not.toContain('EPIPE');
    expect(stderrText).toContain('exit 5');
    expect(stderrText).toContain('notification sent');
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);
});

describe('cancellation end to end: Ctrl-C with a consumer that never reads', () => {
  it('one SIGINT ends the run at 130; the wrapper does not wait on the dead consumer', async () => {
    // The gate's second shape: the consumer of the wrapper's stdout stops
    // reading entirely (pipe full, stream paused), and the user cancels.
    // Pre-fix the SIGINT killed the child but the wrapper hung forever.
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-run-cancel-'));
    const runModule = fileURLToPath(new URL('../src/run.ts', import.meta.url));
    const profileModule = fileURLToPath(new URL('../src/profile.ts', import.meta.url));
    const outputModule = fileURLToPath(new URL('../src/output.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const driver = join(dir, 'driver.mjs');
    const readyFile = join(dir, 'ready');
    writeFileSync(
      driver,
      `
      import { writeFileSync } from 'node:fs';
      import { saveProfile } from ${JSON.stringify(profileModule)};
      import { cmdRun } from ${JSON.stringify(runModule)};
      import { Reporter } from ${JSON.stringify(outputModule)};
      saveProfile({ name: 'runner', identityKey: 'AAAA', userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', authToken: 'tok', registrationId: 1, deviceId: 1, accountClass: 'integration', ownerUserId: ${JSON.stringify(OWNER)} });
      const report = new Reporter({ json: false, plain: true });
      // Floods far past the pipe's capacity, then runs forever: only a signal ends it.
      const script = "process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 0x61), () => {}); setInterval(() => {}, 1000);";
      writeFileSync(${JSON.stringify(readyFile)}, 'go');
      const code = await cmdRun(['runner', '--', process.execPath, '-e', script], report, { notify: async () => {} });
      process.exit(code);
      `,
    );
    const wrapper = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TACENDUM_HOME: dir,
        TACENDUM_API: 'http://run.test',
        TACENDUM_WS: 'ws://run.test',
      },
    });
    let stderrText = '';
    wrapper.stderr.on('data', (d) => (stderrText += String(d)));
    const closed = new Promise<number | null>((resolve) => wrapper.on('close', resolve));
    // NEVER read wrapper.stdout: the consumer that never drains. Give the
    // flood time to fill the pipe and pause the child's stream, then cancel
    // ONCE — process-directed, the terminal's Ctrl-C shape.
    await poll(() => existsSync(readyFile), 15_000);
    await sleep(2000);
    wrapper.kill('SIGINT');
    const exit = await closed; // pre-fix: never resolves
    expect(exit, stderrText).toBe(130); // 128 + SIGINT
    expect(stderrText).toContain('killed by SIGINT');
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);
});

describe('cmdRun', () => {
  // A paired integration on disk, so the owner-default path is the one tested.
  saveProfile({
    name: 'runner',
    identityKey: 'AAAA',
    userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    authToken: 'tok',
    registrationId: 1,
    deviceId: 1,
    accountClass: 'integration',
    ownerUserId: OWNER,
  });

  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  function captureStreams(): void {
    // The mocks must honour write's callback contract: cmdRun's final drain
    // does a sentinel write whose callback signals "flushed", and a mock
    // that swallows it would hang every test here.
    const impl = (...args: unknown[]): boolean => {
      const cb = args.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    };
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(impl);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(impl);
  }
  function writes(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((c) => String(c[0]));
  }
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the child, defaults the recipient to the bound owner, notifies with the tail, and returns the child code', async () => {
    const sent: { to: string; body: string }[] = [];
    const report = new Reporter({ json: true, plain: true });
    captureStreams();
    const script = `process.stdout.write(${JSON.stringify(CANARY)}); process.exitCode = 5;`;
    const code = await cmdRun(['runner', '--name', 'train', '--', process.execPath, '-e', script], report, {
      notify: async (_from, to, body) => {
        sent.push({ to, body });
      },
    });

    expect(code).toBe(5);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(OWNER);
    // The body is the ONE surface that carries the label, the truth, and the tail.
    expect(sent[0]?.body).toContain('train');
    expect(sent[0]?.body).toContain('exit 5');
    expect(sent[0]?.body).toContain(CANARY);

    // Rule 4 on our own output: the child's bytes pass through stdout raw,
    // but the --json record must carry no tail, no label, no argv text.
    const jsonLine = writes(stdoutSpy).find((w) => w.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const record = JSON.parse(jsonLine as string) as Record<string, unknown>;
    expect(record).toMatchObject({ ok: false, childExit: 5, exit: 5, notified: true, to: OWNER });
    expect(jsonLine).not.toContain(CANARY);
    expect(jsonLine).not.toContain('train');
    expect(writes(stderrSpy).join('')).not.toContain(CANARY);
  });

  it('a notification failure never fails the command, and leaks nothing', async () => {
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    const script = `process.stderr.write(${JSON.stringify(CANARY)});`;
    const code = await cmdRun(['runner', '--', process.execPath, '-e', script], report, {
      notify: async () => {
        throw new CliError(EXIT.NETWORK, 'server unreachable');
      },
    });

    expect(code).toBe(0); // the child succeeded; our failure is commentary
    const stderrText = writes(stderrSpy).join('');
    expect(stderrText).toContain('notification failed (network)');
    expect(stderrText).toContain("unaffected");
    // The canary reached stderr exactly once: the raw passthrough. Every
    // OTHER line — the failure note, the summary — must not repeat it.
    const mentions = stderrText.split(CANARY).length - 1;
    expect(mentions).toBe(1);
  });

  it('an UNCLASSIFIED notify failure contributes its name, never its message', async () => {
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    const code = await cmdRun(['runner', '--', process.execPath, '-e', ''], report, {
      notify: async () => {
        // An arbitrary throw minted while the process holds the tail: its
        // message is unvetted and could quote anything.
        throw new Error(`connect failed for body ${CANARY}`);
      },
    });
    expect(code).toBe(0);
    const stderrText = writes(stderrSpy).join('');
    expect(stderrText).toContain('notification failed');
    expect(stderrText).not.toContain(CANARY);
  });

  it('--json: the record gets its own line even when the child ends mid-line', async () => {
    const report = new Reporter({ json: true, plain: true });
    captureStreams();
    // `printf` without a trailing newline — the common case the record must
    // never concatenate onto, because the LAST LINE is what machines parse.
    const script = `process.stdout.write('progress 99%');`;
    const code = await cmdRun(['runner', '--', process.execPath, '-e', script], report, {
      notify: async () => {},
    });
    expect(code).toBe(0);
    const stdoutText = writes(stdoutSpy).join('');
    // The child's bytes are intact and terminated before the record starts.
    expect(stdoutText.startsWith('progress 99%\n')).toBe(true);
    const lastLine = stdoutText.replace(/\n$/, '').split('\n').at(-1) as string;
    const record = JSON.parse(lastLine) as Record<string, unknown>;
    expect(record).toMatchObject({ ok: true, childExit: 0, notified: true });
  });

  it('--json: no stray blank line when the child already ended its last line', async () => {
    const report = new Reporter({ json: true, plain: true });
    captureStreams();
    const script = `process.stdout.write('done\\n');`;
    const code = await cmdRun(['runner', '--', process.execPath, '-e', script], report, {
      notify: async () => {},
    });
    expect(code).toBe(0);
    const stdoutText = writes(stdoutSpy).join('');
    expect(stdoutText.startsWith('done\n{')).toBe(true);
    expect(stdoutText).not.toContain('\n\n');
  });

  it('--json: a silent child gets a record at column 0 with nothing prepended', async () => {
    const report = new Reporter({ json: true, plain: true });
    captureStreams();
    const code = await cmdRun(['runner', '--', process.execPath, '-e', ''], report, {
      notify: async () => {},
    });
    expect(code).toBe(0);
    const stdoutText = writes(stdoutSpy).join('');
    expect(stdoutText.startsWith('{')).toBe(true);
  });

  it('child exit 2 becomes 1 with a loud note; the real code rides the notification', async () => {
    const bodies: string[] = [];
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    const code = await cmdRun(['runner', '--', process.execPath, '-e', 'process.exitCode = 2'], report, {
      notify: async (_f, _t, body) => {
        bodies.push(body);
      },
    });
    expect(code).toBe(1);
    expect(writes(stderrSpy).join('')).toContain('exited 2');
    expect(bodies[0]).toContain('exit 2');
  });

  it('a sync spawn failure (path through a file) still notifies and exits 127', async () => {
    const bodies: string[] = [];
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    const file = join(home, 'plain-file-for-cmdrun');
    writeFileSync(file, 'x');
    const code = await cmdRun(['runner', '--', join(file, 'child')], report, {
      notify: async (_f, _t, body) => {
        bodies.push(body);
      },
    });
    expect(code).toBe(127); // not a bare 1 from an escaped throw
    expect(bodies).toHaveLength(1); // the failure-to-start still notifies
    expect(bodies[0]).toContain('could not start');
  });

  it('holds the exit code until the stdout sink has drained (F18)', async () => {
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    let flushCb: (() => void) | undefined;
    const out = {
      write(chunk: Buffer, cb?: () => void): boolean {
        // The zero-length sentinel is the drain probe; hold its callback.
        if (chunk.length === 0 && typeof cb === 'function') flushCb = cb;
        return true;
      },
      writableLength: 7, // bytes forever "still buffered" until we say so
    };
    let resolved = false;
    const pending = cmdRun(
      ['runner', '--', process.execPath, '-e', 'process.exitCode = 3'],
      report,
      { notify: async () => {}, sinks: { stdout: out, stderr: sink() } },
    ).then((code) => {
      resolved = true;
      return code;
    });
    await poll(() => flushCb !== undefined);
    await sleep(50);
    // The child is long done, the notification sent — but bytes are still
    // buffered, so the exit code (which main.ts turns into process.exit,
    // discarding buffers) must NOT have been surrendered yet.
    expect(resolved).toBe(false);
    (flushCb as () => void)();
    expect(await pending).toBe(3);
  });

  it('EPIPE mid-run: the consumer dies, the child still runs to ITS OWN exit code', async () => {
    // The `make build | head -20` shape, in process: the consumer takes some
    // output, reports backpressure, then errors (pipe closed). The child is
    // still ALIVE and blocked at the pipe behind the paused stream — only the
    // guard's fired drain wait can resume it. The run must end with the
    // child's own code, and the tail must still reach the notification.
    const ee = new EventEmitter();
    let received = 0;
    const out = {
      write(chunk: Buffer): boolean {
        received += chunk.length;
        return false;
      },
      once: (event: 'drain' | 'error', listener: () => void) => void ee.once(event, listener),
      on: (event: 'error', listener: () => void) => void ee.on(event, listener),
    };
    const bodies: string[] = [];
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    const script = `process.stdout.write(Buffer.alloc(1024 * 1024, 0x61)); process.stdout.write(${JSON.stringify(CANARY)}, () => { process.exitCode = 5; });`;
    const pending = cmdRun(['runner', '--', process.execPath, '-e', script], report, {
      notify: async (_f, _t, body) => {
        bodies.push(body);
      },
      sinks: { stdout: out, stderr: sink() },
    });
    await poll(() => received > 0); // paused mid-flood, child blocked at the pipe
    ee.emit('error', new Error('write EPIPE')); // the consumer is gone
    const code = await pending; // pre-fix: crash or hang; never the child's code
    expect(code).toBe(5);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('exit 5');
    // The tail survived the consumer's death: capture is independent of
    // passthrough, and the body is still the one surface that carries it.
    expect(bodies[0]).toContain(CANARY);
  }, 15_000);

  it('cancellation beats a consumer that never reads: 128+signum, not a hang', async () => {
    const source = new EventEmitter();
    let received = 0;
    const out = {
      write(chunk: Buffer): boolean {
        received += chunk.length;
        return false; // stuck…
      },
      once(): void {
        /* …no drain, ever */
      },
      writableLength: 4096, // and forever claiming buffered bytes
    };
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    const script = `process.stdout.write(Buffer.alloc(1024 * 1024, 0x61), () => {}); setInterval(() => {}, 1000);`;
    const pending = cmdRun(['runner', '--', process.execPath, '-e', script], report, {
      notify: async () => {},
      sinks: { stdout: out, stderr: sink() },
      signalSource: source as unknown as SignalSource,
    });
    await poll(() => received > 0);
    source.emit('SIGINT'); // the user cancels ONCE
    // Pre-fix this never resolved: the paused stream pinned 'close', and the
    // final drain waited on bytes the consumer would never take.
    expect(await pending).toBe(130);
  }, 15_000);

  it('refuses BEFORE spawning when the account does not exist', async () => {
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    await expect(
      cmdRun(['no-such-account', OWNER, '--', process.execPath, '-e', ''], report, {
        notify: async () => {},
      }),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });

  it('refuses when there is no recipient and no owner binding', async () => {
    saveProfile({
      name: 'unbound',
      identityKey: 'AAAA',
      userId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      authToken: 'tok',
      registrationId: 1,
      deviceId: 1,
      accountClass: 'integration',
    });
    const report = new Reporter({ json: false, plain: true });
    captureStreams();
    await expect(
      cmdRun(['unbound', '--', process.execPath, '-e', ''], report, { notify: async () => {} }),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});
