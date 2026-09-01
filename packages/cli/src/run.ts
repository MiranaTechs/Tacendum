import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';
import { flagBool, flagString, parseArgs } from './args.js';
import { CliError, EXIT, slugOf } from './exit.js';
import { attachInbound, type Inbound } from './inbound.js';
import { isIdentityChange } from './messaging.js';
import { MessageLog } from './msglog.js';
import type { Reporter } from './output.js';
import { isUserId, loadProfile, normalizeUserId, resolveRecipient } from './profile.js';
import { sendEncrypted } from './send.js';
import { AuthSession } from './session.js';
import { FileStores } from './stores.js';

/**
 * `tacendum run` — the universal fallback for every tool that has no hooks:
 * cron, training runs, migrations, make.
 *
 *   tacendum run <from> [<to>] [--name <label>] -- <command> [args...]
 *
 * Runs the command as a child process, streams its output through unchanged,
 * and on exit sends one E2EE notification: label, outcome, exit code, wall
 * clock, and a bounded tail of the output. The wrapper's own exit code is the
 * child's (see `wrapperExitCode` for the one exception), so it is a drop-in
 * replacement inside a script or a cron line.
 *
 * RULE 4 GOVERNS THIS WHOLE FILE, and more sharply than most: the captured
 * tail is arbitrary text from the user's build — tokens, connection strings,
 * keys — and it is held in this process at the exact moment every failure
 * path here runs. The tail may appear in exactly one place: the message BODY
 * handed to `encryptText`. It is never in a log line, never in an error,
 * never in the `--json` record — and neither is the label, the command, or
 * any other argv text, because `--name "$SECRET"` is one misconfigured
 * variable away (the same class args.ts and profile.ts each reopened once).
 * Every formatting site in this file is therefore built from numbers, slugs
 * and repo-authored prose only.
 */

/**
 * How much of the child's output the notification carries: the LAST 2 KiB.
 *
 * The tail, not the head, because the reason a build failed is the last thing
 * the compiler printed — the same argument as `MAX_BODY_BYTES` in main.ts.
 * 2 KiB because the content-discipline rule
 * caps integration plaintext at ~1–2 KB to blunt exfiltration bandwidth, and
 * because the reader is a phone: a notification is triage ("why did it
 * fail"), not a log viewer. It also keeps the whole composed body (status
 * line + separator + tail) far under main.ts's 16 KiB `composeBody` ceiling
 * and the ~22.5 KiB wire cap, so the truncation decided HERE is the only one
 * that ever happens — a second truncation downstream would cut the head off
 * a tail and keep the middle.
 */
export const TAIL_BYTES = 2048;

/**
 * The bounded output tail — the ONE place the bound is enforced.
 *
 * Both of the child's streams push into a single instance, merged in the
 * order the chunks REACH the wrapper — and that is the only order there is.
 * stdout and stderr are two independent pipes: each stream's own bytes stay
 * in sequence, but nothing preserves the child's write order BETWEEN them,
 * so a stderr line can land here (or on a terminal, which reads the same two
 * pipes) before a stdout line the child wrote first. One shared instance is
 * still right: bounding per-stream at the call sites would be the same rule
 * at two places, and it would also double the bytes held.
 *
 * Memory stays bounded however the child prints (F18): a chunk of `limit`
 * bytes or more immediately REPLACES the held chunks with a COPY of its last
 * `limit` bytes — a copy, not a subarray, because a view would pin the whole
 * source buffer behind 2 KiB of interest — and smaller chunks are dropped
 * from the front as soon as the remainder still covers the limit. Held bytes
 * therefore never exceed `limit` plus the last small chunk (< 2×limit), and
 * `text()` slices the exact suffix.
 */
export class OutputTail {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly limit: number = TAIL_BYTES) {}

  push(chunk: Buffer): void {
    if (chunk.length >= this.limit) {
      // Buffer.from copies; subarray alone would keep `chunk`'s whole
      // allocation reachable for as long as the tail lives.
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.limit))];
      this.total = this.limit;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.chunks.length > 1 && this.total - (this.chunks[0] as Buffer).length >= this.limit) {
      this.total -= (this.chunks.shift() as Buffer).length;
    }
  }

  text(): string {
    const joined = Buffer.concat(this.chunks);
    const sliced = joined.subarray(Math.max(0, joined.length - this.limit));
    // A byte-sliced UTF-8 boundary decodes as replacement characters at the
    // front; strip them rather than showing mojibake as the tail's first line.
    return sliced.toString('utf8').replace(/^�+/, '');
  }
}

/** How the child ended: a wait status, or a failure to start at all. */
export interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process never spawned (ENOENT / EACCES / other). */
  startFailure?: 'not-found' | 'not-runnable' | 'unknown';
  /** Set when the WRAPPER forwarded a termination signal to the child — i.e.
   * the user cancelled the run. `cmdRun` reads this as "exit promptly beats
   * delivering every buffered byte": a consumer that has stopped reading must
   * not turn Ctrl-C into a hang (a wrapper that cannot be cancelled is worse
   * than one that drops output). An EXTERNAL kill of the child does not set
   * it, so those runs keep the full F18 drain guarantee. */
  cancelled?: boolean;
}

/**
 * THE exit-code rule for the wrapper — one total function, so "the wrapper
 * exits with the child's code, except never 2" cannot diverge between the
 * command path and anything else that reports an outcome (the test driver
 * uses this same function; so must any future daemonized variant).
 *
 *  - signal death: 128 + signum, the shell's own spelling of it (SIGINT →
 *    130), which is what the surrounding script would have seen running the
 *    command bare. Never 2, since signum ≥ 1.
 *  - start failures: 127 (not found) and 126 (found but not runnable) — the
 *    POSIX shell conventions, again so `tacendum run -- make build` reports
 *    exactly what `make build` would have.
 *  - child exit 2: reported as EXIT.ERROR (1), and NEVER silently. Exit 2 is
 *    Claude Code's blocking hook code (see exit.ts) — a Stop hook that exits
 *    2 forces the agent onward and feeds stderr back to the model — and this
 *    wrapper is designed to run inside such hooks, so 2 must not escape even
 *    when the child genuinely produced it. 1 is chosen because every shell
 *    convention reads it as plain failure and nothing in EXIT gives it a
 *    specific remedy a caller would wrongly apply. The remap is announced in
 *    the returned note, and the REAL code still travels in the notification
 *    body and the `--json` record (`childExit`), so nothing downstream has to
 *    guess.
 */
export function wrapperExitCode(outcome: ChildOutcome): { exit: number; note?: string } {
  if (outcome.startFailure !== undefined) {
    const exit = outcome.startFailure === 'not-found' ? 127 : outcome.startFailure === 'not-runnable' ? 126 : EXIT.ERROR;
    // The command itself is NOT echoed: `tacendum run ci -- "$CMD"` with a
    // misconfigured variable puts a secret here, and this note reaches hook
    // and CI logs. The operator has the command on their own line.
    return {
      exit,
      note:
        outcome.startFailure === 'not-found'
          ? 'error: the command was not found on PATH'
          : outcome.startFailure === 'not-runnable'
            ? 'error: the command exists but is not executable'
            : 'error: the command could not be started',
    };
  }
  if (outcome.signal !== null) {
    const signum = osConstants.signals[outcome.signal];
    return { exit: typeof signum === 'number' ? 128 + signum : EXIT.ERROR };
  }
  const child = outcome.code ?? EXIT.ERROR;
  if (child === 2) {
    return {
      exit: EXIT.ERROR,
      note:
        'note: the command exited 2, reported here as 1 — exit 2 is reserved ' +
        '(Claude Code reads a hook\'s exit 2 as "block the agent", and this ' +
        'wrapper runs inside hooks). The notification and --json carry the real code.',
    };
  }
  return { exit: child };
}

/** The narrow slice of `process` the forwarder needs — narrow so a test can
 * stand in a plain EventEmitter and fire signals without signalling itself. */
export interface SignalSource {
  on(event: NodeJS.Signals, handler: () => void): unknown;
  off(event: NodeJS.Signals, handler: () => void): unknown;
}

export const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Forward the FIRST termination signal to the child's process GROUP; returns
 * the disposer.
 *
 * The failure this prevents is the orphan: a CI runner cancels a job with
 * SIGTERM to the WRAPPER's pid only, and without forwarding the build keeps
 * running headless while the runner tears the workspace down under it.
 * Delivery is to the group (`kill(-pid)`), not the child pid alone, because
 * `runChild` spawns the child as its own group leader: signalling only the
 * pid of `sh -c 'sleep 600 & wait'` kills the shell, leaves `sleep` orphaned
 * holding the output pipe open, and the wrapper then waits on 'close' forever
 * for a build that is already dead (F19). Group delivery reaches every
 * descendant that is still in the child's group — which is all of them unless
 * one called setsid/setpgid itself; a self-daemonizing survivor is out of any
 * wrapper's reach — so the pipes actually close. If the group is already
 * gone the kill falls back to `child.kill`, which on a dead child is a no-op.
 *
 * The handlers uninstall themselves after the first delivery, for two
 * reasons. First, a trapping child sees the signal exactly ONCE: it is in its
 * own group, so a foreground Ctrl-C reaches it only through this forward —
 * never a second time from the kernel — and its cleanup traps run once, not
 * twice. Second, uninstalling restores the wrapper's default disposition, so
 * a SECOND Ctrl-C or TERM kills the wrapper itself instead of being swallowed
 * while it waits out a child that refuses to die — the escape hatch that
 * guarantees the wrapper cannot hang forever on a pipe a survivor holds open.
 *
 * The disposer also runs when the child closes (see `runChild`), which
 * restores default signal handling for the notify phase on purpose: a Ctrl-C
 * while the notification send hangs should kill the wrapper, not be swallowed
 * by a handler whose child no longer exists.
 */
export function forwardSignals(
  child: Pick<ChildProcess, 'kill' | 'pid'>,
  source: SignalSource = process,
  onDeliver?: () => void,
): () => void {
  const dispose = (): void => {
    for (const [sig, handler] of installed) source.off(sig, handler);
  };
  const installed = FORWARDED_SIGNALS.map((sig) => {
    const handler = (): void => {
      // One delivery, then default disposition (see the doc block above).
      dispose();
      // Before the kill, not after: the INTENT to cancel is what the caller
      // needs recorded, even if the group is already gone.
      onDeliver?.();
      const pid = child.pid;
      if (typeof pid === 'number' && pid > 0) {
        try {
          process.kill(-pid, sig); // the group: child + descendants still in it
          return;
        } catch {
          // Group already reaped (or not ours): fall through to the pid.
        }
      }
      child.kill(sig);
    };
    source.on(sig, handler);
    return [sig, handler] as const;
  });
  return dispose;
}

/**
 * Where the child's bytes go. `write` follows the Writable contract: a
 * `false` return means "stop until my 'drain' fires", and `runChild` obeys it
 * by pausing the child's stream — which is why `once` is part of the shape.
 * `writableLength` (bytes accepted but not yet handed to the OS) lets
 * `cmdRun` refuse to surrender the exit code while output is still buffered.
 * Both are optional so a plain collecting object still satisfies the type;
 * without them the sink is assumed synchronous and never behind.
 */
export interface OutputSink {
  write(chunk: Buffer, callback?: () => void): unknown;
  once?: ((event: 'drain' | 'error', listener: () => void) => unknown) | undefined;
  /** Persistent subscription — `guardSink` uses it for 'error', because a
   * destroyed stream can error more than once and an unheard 'error' on
   * process.stdout is fatal to the whole process. Optional like the rest. */
  on?: ((event: 'error', listener: (err: unknown) => void) => unknown) | undefined;
  writableLength?: number | undefined;
}

export interface OutputSinks {
  stdout: OutputSink;
  stderr: OutputSink;
}

/** A sink that cannot take the process down with it; see `guardSink`. */
export interface GuardedSink extends OutputSink {
  /** True once the consumer is known dead; writes are discarded from then on. */
  readonly broken: boolean;
}

/**
 * Wrap a sink so the DEATH OF ITS CONSUMER cannot crash or hang the wrapper.
 *
 * `tacendum run ci -- make build | head -20` is ordinary shell usage: `head`
 * exits after twenty lines and closes the pipe, and every later write to the
 * wrapper's stdout raises EPIPE. Unguarded, that error has two shapes and
 * both ended the run while the child was still building: an async 'error'
 * event on process.stdout is an UNCAUGHT EXCEPTION with no listener, and a
 * synchronous stream can throw straight out of `write`. Either way the
 * child's exit code — the user's actual answer — died with the wrapper.
 *
 * The guard's rule once the consumer is gone: the passthrough is undeliverable
 * and is silently discarded (the bare pipeline says nothing either — its
 * producer just dies of SIGPIPE), while everything else about the run
 * proceeds — the child runs on to its own exit, the tail still reaches the
 * notification, the exit code passes through. Concretely:
 *
 *  - 'error' from the underlying sink, or a synchronous throw from `write`,
 *    marks the sink broken. The error itself is swallowed unexamined: any
 *    stream error here means "stop writing", and its message is not ours to
 *    print (log-hygiene posture — this process holds the tail).
 *  - the 'error' subscription is persistent (`on`), not `once`: a write that
 *    races the breakage can error a destroyed stream AGAIN, and a consumed
 *    once-listener would leave that second event unheard and fatal.
 *  - while broken, `write` accepts and discards (returns true, fires the
 *    callback), so the pump never pauses the child against a consumer that
 *    will never drain it.
 *  - a pending 'drain' wait is fired immediately at breakage: the drain will
 *    never come, and the child's stream must resume or its 'close' — and the
 *    wrapper's exit — never happens.
 *  - `writableLength` reports 0 while broken, so `drained` does not wait on
 *    bytes with nowhere to go.
 */
export function guardSink(sink: OutputSink): GuardedSink {
  let broken = false;
  const pendingDrains: (() => void)[] = [];
  const markBroken = (): void => {
    if (broken) return;
    broken = true;
    for (const fire of pendingDrains.splice(0)) fire();
  };
  if (typeof sink.on === 'function') sink.on('error', markBroken);
  else if (typeof sink.once === 'function') sink.once('error', markBroken);
  return {
    get broken(): boolean {
      return broken;
    },
    write(chunk: Buffer, callback?: () => void): unknown {
      if (broken) {
        callback?.();
        return true;
      }
      try {
        return sink.write(chunk, callback);
      } catch {
        markBroken();
        callback?.();
        return true;
      }
    },
    once:
      typeof sink.once === 'function'
        ? (event: 'drain' | 'error', listener: () => void): unknown => {
            if (event !== 'drain') return sink.once?.(event, listener);
            if (broken) {
              listener();
              return undefined;
            }
            pendingDrains.push(listener);
            return sink.once?.('drain', () => {
              const i = pendingDrains.indexOf(listener);
              if (i !== -1) pendingDrains.splice(i, 1);
              listener();
            });
          }
        : undefined,
    get writableLength(): number | undefined {
      return broken ? 0 : sink.writableLength;
    },
  };
}

/**
 * Map a spawn errno to the start-failure taxonomy — one function, because the
 * same errno can surface two ways (a synchronous throw from `spawn`, or the
 * 'error' event) and the two paths must never disagree on the exit code.
 * ENOTDIR joins ENOENT as 'not-found': the path resolved to nothing runnable
 * (a component was a plain file), which run reports as 127.
 */
function classifyStartFailure(code: string | undefined): NonNullable<ChildOutcome['startFailure']> {
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? 'not-found'
    : code === 'EACCES'
      ? 'not-runnable'
      : 'unknown';
}

/**
 * Spawn the command, stream its output through, capture the tail, forward
 * signals for as long as it lives.
 *
 * stdout/stderr are PIPED, not inherited — capture requires it — so the child
 * sees a pipe, exactly as it would under `make build | tee`. Build tools that
 * colorize only on a TTY will run plain; that is the same trade every wrapper
 * in this family (noti, runitor) makes. stdin IS inherited, so a child that
 * asks a question still can — though see the `detached` note below.
 *
 * The child is spawned DETACHED, i.e. as the leader of its own process
 * group, so that `forwardSignals` can signal the whole GROUP with kill(-pid)
 * — not the whole tree: a descendant that moves itself out of the group
 * (setsid) escapes, and no wrapper can promise otherwise —
 * and a terminal Ctrl-C cannot reach the child twice (kernel + forward). The
 * costs are accepted and named: a SIGKILL to the wrapper (unforwardable)
 * leaves the child running, and a child that reads from a TTY's stdin while
 * outside the foreground group is stopped with SIGTTIN — tolerable because
 * the wrapper's stated audience (hooks, cron, CI; see the doc at top) has no TTY.
 *
 * Passthrough honours the sinks' backpressure (F18): when a sink's `write`
 * returns false the child's stream is paused until 'drain', so a slow
 * consumer of the WRAPPER's stdout blocks the child at the pipe — exactly as
 * `make | slow-consumer` would — instead of the wrapper buffering the
 * difference in memory without bound.
 *
 * `spawn` itself can throw SYNCHRONOUSLY: Node routes only a short list of
 * errnos (ENOENT, EACCES among them) through the 'error' event and throws
 * the rest — ENOTDIR, the one a path through a plain file actually produces,
 * is thrown. Both shapes land in the same `startFailure` outcome (with
 * `child: null`), so the caller notifies and exits 127/126 identically.
 *
 * Resolution waits for 'close', not 'exit': 'close' additionally waits for
 * the stdio pipes to drain, so the tail is complete — and if the child handed
 * its pipes to a grandchild, the wrapper waits for that output too, which is
 * what a shell pipeline would do. (A grandchild that survives a forwarded
 * signal cannot hold this open forever: the signal goes to the whole group,
 * and a second signal kills the wrapper itself — see `forwardSignals`.)
 */
export function runChild(
  command: string,
  args: string[],
  tail: OutputTail,
  sinks: OutputSinks = process,
  signalSource: SignalSource = process,
): { child: ChildProcess | null; done: Promise<ChildOutcome> } {
  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], detached: true });
  } catch (err) {
    return {
      child: null,
      done: Promise.resolve({
        code: null,
        signal: null,
        startFailure: classifyStartFailure((err as NodeJS.ErrnoException).code),
      }),
    };
  }
  let cancelled = false;
  const dispose = forwardSignals(child, signalSource, () => {
    cancelled = true;
  });
  const done = new Promise<ChildOutcome>((resolve) => {
    let settled = false;
    // Set at 'exit': from that moment backpressure has nothing left to
    // protect — the producer is dead, and what remains in the pipes is at
    // most their kernel capacity — while a pause could still cost everything:
    // a consumer that never drains would hold the paused stream short of
    // 'end', 'close' would never fire, and a run the user already Ctrl-C'd
    // (which kills the child but cannot make a dead consumer read) would
    // hang the wrapper forever.
    let childGone = false;
    const finish = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      dispose();
      resolve(outcome);
    };
    const pump = (stream: NodeJS.ReadableStream | null, sink: OutputSink): void => {
      stream?.on('data', (chunk: Buffer) => {
        const accepted = sink.write(chunk);
        tail.push(chunk);
        if (accepted === false && !childGone && typeof sink.once === 'function') {
          stream.pause();
          sink.once('drain', () => stream.resume());
        }
      });
    };
    pump(child.stdout, sinks.stdout);
    pump(child.stderr, sinks.stderr);
    child.on('exit', () => {
      childGone = true;
      // Release any pause immediately: the drain being waited on may never
      // come (see `childGone` above). The residue flows into the sink's own
      // buffer — bounded by pipe capacity, not by the child's output.
      child.stdout?.resume();
      child.stderr?.resume();
    });
    child.on('error', (err) => {
      finish({
        code: null,
        signal: null,
        startFailure: classifyStartFailure((err as NodeJS.ErrnoException).code),
      });
    });
    child.on('close', (code, signal) =>
      finish({ code, signal, ...(cancelled ? { cancelled: true } : {}) }),
    );
  });
  return { child, done };
}

/** `412ms`, `42s`, `3m 12s`, `2h 5m` — for a human reading one line. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * The notification body — the ONE surface that may carry the label and the
 * tail, because it exists only as libsignal plaintext input.
 *
 * The REAL child exit code goes here even when the wrapper's own exit was
 * remapped (see `wrapperExitCode`): the phone is where the operator reads the
 * truth, so it is the one place the truth must be complete.
 *
 * The tail is included on success as well as failure — a training run's whole
 * point is the final metrics line, and "ok" without it would send the least
 * informative half of the message.
 */
export function buildNotificationBody(
  label: string,
  outcome: ChildOutcome,
  durationMs: number,
  tailText: string,
): string {
  const dur = formatDuration(durationMs);
  let status: string;
  if (outcome.startFailure !== undefined) {
    status = `${label}: could not start (${outcome.startFailure === 'not-found' ? 'command not found' : outcome.startFailure === 'not-runnable' ? 'not executable' : 'spawn failed'})`;
  } else if (outcome.signal !== null) {
    status = `${label}: killed by ${outcome.signal} after ${dur}`;
  } else if (outcome.code === 0) {
    status = `${label}: ok in ${dur}`;
  } else {
    status = `${label}: FAILED (exit ${outcome.code ?? '?'}) in ${dur}`;
  }
  if (tailText === '') return status;
  return `${status}\n--- output tail ---\n${tailText}`;
}

export const RUN_USAGE =
  'usage: tacendum run <from> [<to>] [--name <label>] -- <command> [args...]';

export const RUN_HELP = `tacendum run — run a command, notify your phone when it finishes

${RUN_USAGE}

  <from>   the account to send from (register one with --integration first)
  <to>     the recipient: a 26-character user id or a local client name.
           Optional when <from> is an integration paired to its owner —
           the owner is then the default.
  --name   a label for the notification (default: the command's own name)

Everything after -- is the command, verbatim; the -- is required, so the
command's own flags are never mistaken for tacendum's.

The command's output streams through unchanged; on exit one E2EE notification
carries the label, the outcome, the exit code, the duration and the last
${TAIL_BYTES} bytes of output. A notification failure never changes the
command's result. The wrapper exits with the command's own exit code —
except a child exit of 2, reported as 1 (2 is Claude Code's blocking hook
code; the notification and --json carry the real code).`;

export interface RunInvocation {
  help: boolean;
  fromName: string;
  to: string | undefined;
  label: string | undefined;
  command: string;
  args: string[];
}

/**
 * Parse `tacendum run`'s argv. The split at the FIRST `--` happens here,
 * BEFORE `parseArgs` ever sees the line, and that ordering is the point:
 * everything after the terminator is the child's argv, which is not ours to
 * parse — `parseArgs` would fold it into positionals and lose the boundary,
 * and worse, a head-parse over the whole line would let the child's own
 * `--json` flip our Reporter or an unknown child flag trip our USAGE refusal.
 *
 * The `--` is REQUIRED rather than inferred. Without it, `tacendum run ci
 * make test` is ambiguous — is `make` the recipient or the command? — and
 * every wrong guess either messages a freshly minted stub account or execs
 * the recipient. A refusal that says exactly what to type beats a guess.
 */
export function parseRunArgv(argv: string[]): RunInvocation {
  const split = argv.indexOf('--');
  const head = argv.slice(0, split === -1 ? argv.length : split);
  const command = split === -1 ? [] : argv.slice(split + 1);

  const parsed = parseArgs(head, { value: ['--name'] });
  // `--json`/`--plain` need no handling here: the Reporter was built from
  // `scanGlobals`, which stops at the same `--` this function splits on.
  if (flagBool(parsed, '--help') || flagBool(parsed, '-h')) {
    return { help: true, fromName: '', to: undefined, label: undefined, command: '', args: [] };
  }
  if (split === -1) {
    throw new CliError(
      EXIT.USAGE,
      `run needs \`--\` before the command, so the command's flags stay its own. ${RUN_USAGE}`,
    );
  }
  const executable = command[0];
  if (executable === undefined || executable === '') {
    throw new CliError(EXIT.USAGE, `nothing to run after --. ${RUN_USAGE}`);
  }
  const fromName = parsed.positionals[0];
  if (fromName === undefined) {
    throw new CliError(EXIT.USAGE, RUN_USAGE);
  }
  if (parsed.positionals.length > 2) {
    // The extras are NEVER echoed: an unquoted value splits into
    // words here exactly as it does for `send`, and one of those words can be
    // a secret. Same posture as main.ts's "send takes one body argument".
    throw new CliError(
      EXIT.USAGE,
      `run takes at most two positionals before --, got ${parsed.positionals.length}. ${RUN_USAGE}`,
    );
  }
  return {
    help: false,
    fromName,
    to: parsed.positionals[1],
    label: flagString(parsed, '--name'),
    command: executable,
    args: command.slice(1),
  };
}

/**
 * Send the composed notification — `sendEncrypted` (send.ts), the ONE owner
 * of the wire sequence, with run's own posture on the seams. This function
 * used to hand-mirror cmdSend's steps instead, and the mirror preserved the
 * account-bricking encrypt-before-connect order AFTER it had been found and
 * fixed in hooks.ts — the two-call-site divergence, verbatim. A cron line
 * retrying `tacendum run` against a dead relay every night is exactly the
 * offline-retry treadmill that walks a sender chain past libsignal's 25,000
 * forward-jump cap; the connect-first order that prevents it now has one
 * owner, and this caller cannot lose it again.
 *
 * What is run's own: no status lines (the wrapper's stderr belongs to the
 * child's passthrough), observe-don't-ack inbound (consume:false — see
 * inbound.ts for why draining would be the wrong default for a send-only
 * account), and the identity-change wording below.
 *
 * Every stage is bounded: the HTTP calls by undici's timeouts, the dial by
 * WsClient's bounded redials, the receipt wait by `waitFor`'s 10s default —
 * so a dead network stalls the wrapper by seconds, not forever, before the
 * caller's guard writes it off as a failed notification.
 */
async function sendNotification(
  fromName: string,
  peerUserId: string,
  body: string,
  report: Reporter,
): Promise<void> {
  const stores = new FileStores(fromName);
  const auth = new AuthSession(fromName, stores);

  let inbound: Inbound | undefined;
  try {
    await sendEncrypted({
      stores,
      auth,
      to: peerUserId,
      body,
      events: {
        onSocket: (ws) => {
          inbound = attachInbound({
            name: fromName,
            userId: auth.userId,
            stores,
            ws,
            report,
            log: new MessageLog(fromName),
            consume: false,
          });
        },
        beforeClose: () => inbound?.settled() ?? Promise.resolve(),
      },
    });
  } catch (err) {
    if (isIdentityChange(err)) {
      // `establishSession` already recorded the change at the raise site, so
      // `tacendum trust` has something to accept; this only owns the words.
      throw new CliError(
        EXIT.SAFETY,
        `SAFETY NUMBER CHANGED for the recipient — notification refused. Verify out of ` +
          `band (tacendum safety ${fromName} ${peerUserId}); to accept: ` +
          `tacendum trust ${fromName} ${peerUserId}`,
      );
    }
    throw err;
  }
  inbound?.report();
}

/**
 * Resolve once everything `sink` has accepted is out of this process (F18).
 *
 * Node's Writable buffers what the OS did not take immediately, and
 * `process.exit` — which main.ts calls for every nonzero code — DISCARDS
 * that buffer. Without this wait, a child whose output outran a slow
 * consumer lost its own tail and the --json record the moment it failed:
 * the exact run whose output mattered most. The zero-length sentinel write's
 * callback fires only after every previously accepted chunk has been handed
 * to the OS (from where an exit cannot lose it), which is also the only
 * portable "buffer now empty" signal: 'drain' fires solely after a `write`
 * returned false, so waiting on it when the buffer is merely non-empty would
 * hang. A sink with no `writableLength` never buffers and needs no wait.
 */
async function drained(sink: OutputSink): Promise<void> {
  if (typeof sink.writableLength !== 'number' || sink.writableLength === 0) return;
  await new Promise<void>((resolve) => {
    sink.write(Buffer.alloc(0), resolve);
  });
}

export type NotifyFn = (
  fromName: string,
  peerUserId: string,
  body: string,
  report: Reporter,
) => Promise<void>;

export interface RunDeps {
  /** Injectable for tests; the default is the real E2EE send above. */
  notify?: NotifyFn;
  sinks?: OutputSinks;
  signalSource?: SignalSource;
}

/**
 * The `run` command. Returns the process exit code — the child's own, via
 * `wrapperExitCode` — and NEVER throws once the child has been spawned:
 * from that moment the exit code belongs to the child, and our failures are
 * stderr commentary.
 *
 * The split in error handling is deliberate and worth stating:
 *  - BEFORE the spawn, misconfiguration refuses loudly (USAGE/RECIPIENT, via
 *    throw): a wrapper that can never notify should say so at second zero,
 *    not after a three-hour build.
 *  - AFTER the spawn, nothing about notification failure may alter the
 *    command's result — the build's outcome is the user's; our inability to
 *    tell them about it is not a build failure.
 */
export async function cmdRun(
  argv: string[],
  report: Reporter,
  deps: RunDeps = {},
): Promise<number> {
  const notify = deps.notify ?? sendNotification;
  const invocation = parseRunArgv(argv);
  if (invocation.help) {
    console.log(RUN_HELP);
    return EXIT.OK;
  }

  // Fail-fast validation, all local, all before the child exists.
  const profile = loadProfile(invocation.fromName);
  let peerUserId: string;
  if (invocation.to !== undefined) {
    peerUserId = resolveRecipient(invocation.to);
  } else if (profile.ownerUserId !== undefined && isUserId(profile.ownerUserId)) {
    // A paired integration already knows the one person it may notify.
    peerUserId = normalizeUserId(profile.ownerUserId);
  } else {
    throw new CliError(
      EXIT.USAGE,
      `no recipient: pass one (${RUN_USAGE}), or pair this integration once — ` +
        `tacendum pair ${invocation.fromName} <owner-id> — and run will default to its owner`,
    );
  }
  const label =
    invocation.label !== undefined && invocation.label !== ''
      ? invocation.label
      : basename(invocation.command);

  const tail = new OutputTail();
  // Track the last byte the child leaves on stdout: under `--json` the record
  // below must start on its OWN line, and a child that ends mid-line (printf
  // without \n, a progress meter, a spinner) would otherwise have the record
  // concatenated onto its last line — the exact line a machine consumer is
  // told to parse. Tracking (rather than always writing '\n') is what keeps a
  // well-terminated run free of a stray blank line.
  const baseSinks = deps.sinks ?? process;
  // Both sinks are guarded (see `guardSink`): `run ci -- make build | head`
  // is ordinary usage, and the consumer's exit must not crash the wrapper or
  // cost it the child's exit code. Everything below — the passthrough, the
  // record's newline, the final drain — goes through the guards; in
  // production the guard's persistent 'error' listener on process.stdout
  // also covers report.emit's direct write.
  const outGuard = guardSink(baseSinks.stdout);
  const errGuard = guardSink(baseSinks.stderr);
  let stdoutOpenLine = false; // true while stdout ends mid-line
  const sinks: OutputSinks = {
    stdout: {
      write(chunk: Buffer): unknown {
        if (chunk.length > 0) stdoutOpenLine = chunk[chunk.length - 1] !== 0x0a;
        // The return value and `once` pass through untouched: runChild's
        // backpressure handling (pause on false, resume on 'drain') must see
        // the guarded sink's answers, or this wrapper would silently reopen
        // the unbounded buffering F18 closed.
        return outGuard.write(chunk);
      },
      once: outGuard.once,
    },
    stderr: errGuard,
  };
  const started = Date.now();
  const { done } = runChild(
    invocation.command,
    invocation.args,
    tail,
    sinks,
    deps.signalSource ?? process,
  );
  const outcome = await done;
  const durationMs = Date.now() - started;

  const { exit, note } = wrapperExitCode(outcome);
  if (note !== undefined) report.note(note);

  const body = buildNotificationBody(label, outcome, durationMs, tail.text());
  let notified = false;
  let notifyError: string | undefined;
  try {
    await notify(invocation.fromName, peerUserId, body, report);
    notified = true;
  } catch (err) {
    // The command's result is the user's; this failure is commentary. What
    // gets printed is asymmetric on purpose: a CliError's message is
    // repo-authored prose already vetted for this surface, while an arbitrary
    // throw's message is unvetted text produced while this process holds the
    // tail — so it contributes its NAME and nothing more. Six reopenings of
    // this leak class bought that caution.
    notifyError = slugOf(err);
    report.done();
    const detail = err instanceof CliError ? err.message : err instanceof Error ? err.name : 'unknown';
    report.note(
      `note: notification failed (${notifyError}): ${detail} — the command's own result is unaffected`,
    );
  }

  // The result surface. Human mode says its one line on STDERR — stdout
  // belongs to the child, and a drop-in wrapper must not append to a stream
  // a script may be capturing. --json emits the record on stdout after the
  // child's own output, which a machine consumer separates by taking the
  // last line. Neither carries the tail or the label.
  const record = {
    ok: exit === EXIT.OK,
    to: peerUserId,
    childExit: outcome.code,
    ...(outcome.signal !== null ? { signal: outcome.signal } : {}),
    ...(outcome.startFailure !== undefined ? { startFailure: outcome.startFailure } : {}),
    exit,
    durationMs,
    notified,
    ...(notifyError !== undefined ? { notifyError } : {}),
  };
  if (report.json) {
    // Close the child's dangling line first (see `stdoutOpenLine` above), so
    // "parse the last line" always finds a record that starts at column 0. In
    // human mode this is deliberately NOT done: stdout is the child's alone,
    // and a drop-in wrapper must not append even a newline to it.
    if (stdoutOpenLine) outGuard.write(Buffer.from('\n'));
    report.emit(record, '');
  } else {
    const outcomeText =
      outcome.startFailure !== undefined
        ? 'could not start'
        : outcome.signal !== null
          ? `killed by ${outcome.signal}`
          : `exit ${outcome.code ?? '?'}`;
    report.note(
      `run: ${outcomeText} in ${formatDuration(durationMs)} — ` +
        (notified ? 'notification sent' : `notification failed (${notifyError ?? 'unknown'})`),
    );
  }
  // Surrender the exit code only after our streams have drained (F18):
  // main.ts turns a nonzero return into process.exit, which discards any
  // still-buffered child output and the record emitted just above. In
  // production `baseSinks` IS `process`, so this also covers report.emit's
  // write. Blocking here on a consumer that has not read YET is correct —
  // that is what the bare command in the same pipeline would do — with two
  // exceptions that must not block: a BROKEN consumer (the guard reports
  // nothing buffered, because the bytes have nowhere to go), and a CANCELLED
  // run (the user asked the whole thing to stop; in the bare pipeline the
  // terminal's Ctrl-C kills the stuck consumer too, and 128+signum now beats
  // delivering bytes to a reader that may never come back).
  if (outcome.cancelled !== true) {
    await drained(outGuard);
    await drained(errGuard);
  }
  return exit;
}
