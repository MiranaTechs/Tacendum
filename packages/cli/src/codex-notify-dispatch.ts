import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { clientDir } from './config.js';
import { CliError, EXIT } from './exit.js';

/**
 * The private command installed in Codex's one legacy `notify` slot.
 *
 * Codex appends its JSON payload as one final argv element.  The dispatcher
 * plan therefore carries only fixed child argv/environment; the payload is
 * never serialized into the plan or interpreted by this layer.
 */
export const CODEX_NOTIFY_DISPATCH_COMMAND = 'codex-notify-dispatch';
export const CODEX_NOTIFY_PLAN_FLAG = '--plan-v1';

const MAX_ENCODED_PLAN_BYTES = 64 * 1024;
const MAX_ARGV_ITEMS = 64;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_CHILD_STDOUT_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const DEFAULT_CHILD_TIMEOUT_MS = 8_000;

export interface CodexPreviousNotifier {
  argv: string[];
  env?: Record<string, string>;
}

export interface CodexNotifyPlanV1 {
  v: 1;
  account: string;
  previous: CodexPreviousNotifier[];
  /** Overrides retained from a validated legacy Tacendum dispatcher. */
  tacendumEnv?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ARGV_ITEMS &&
    value.every(
      item =>
        typeof item === 'string' &&
        item.length > 0 &&
        !item.includes('\0') &&
        Buffer.byteLength(item) <= MAX_ARG_BYTES,
    )
  );
}

function validEnv(value: unknown): value is Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > MAX_ENV_ENTRIES) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      typeof item === 'string' &&
      !item.includes('\0') &&
      Buffer.byteLength(item) <= MAX_ENV_VALUE_BYTES,
  );
}

/** Decode only the schema this release writes.  No decoded value is included
 * in the error: notifier argv and environment values may contain secrets. */
export function decodeCodexNotifyPlan(encoded: string): CodexNotifyPlanV1 {
  const invalid = (): never => {
    throw new Error('the managed Codex notifier plan is invalid or unsupported');
  };
  if (
    encoded.length === 0 ||
    Buffer.byteLength(encoded) > MAX_ENCODED_PLAN_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return invalid();
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    return invalid();
  }
  if (bytes.toString('base64url') !== encoded) return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid();
  }
  if (!isRecord(parsed) || parsed.v !== 1) return invalid();
  if (typeof parsed.account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(parsed.account)) {
    return invalid();
  }
  if (!Array.isArray(parsed.previous) || parsed.previous.length > 1) return invalid();
  const previous: CodexPreviousNotifier[] = [];
  for (const item of parsed.previous) {
    if (!isRecord(item) || !validArgv(item.argv)) return invalid();
    if (item.env !== undefined && !validEnv(item.env)) return invalid();
    previous.push({ argv: [...item.argv], ...(item.env !== undefined ? { env: { ...item.env } } : {}) });
  }
  if (parsed.tacendumEnv !== undefined && !validEnv(parsed.tacendumEnv)) return invalid();
  const known = new Set(['v', 'account', 'previous', 'tacendumEnv']);
  if (Object.keys(parsed).some(key => !known.has(key))) return invalid();
  return {
    v: 1,
    account: parsed.account,
    previous,
    ...(parsed.tacendumEnv !== undefined ? { tacendumEnv: { ...parsed.tacendumEnv } } : {}),
  };
}

export function encodeCodexNotifyPlan(plan: CodexNotifyPlanV1): string {
  // Validation on the round trip keeps hostconfig and runtime on one schema.
  const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
  decodeCodexNotifyPlan(encoded);
  return encoded;
}

export interface CodexNotifyDispatchOwner {
  nodePath: string;
  entryPath: string;
}

/** Null means a different notifier. Throwing means something claims our
 * private command name but does not validate as our exact owned format.
 * The fixed executable and entry path are part of that proof: a foreign
 * tool can use the same innocent subcommand word, so the word alone never
 * grants ownership of Codex's single notify slot. */
export function planFromCodexNotifyDispatchArgv(
  argv: readonly string[],
  owner: CodexNotifyDispatchOwner,
): CodexNotifyPlanV1 | null {
  if (argv[2] !== CODEX_NOTIFY_DISPATCH_COMMAND) return null;
  if (argv[0] !== owner.nodePath || argv[1] !== owner.entryPath) {
    throw new Error('the managed Codex notifier ownership cannot be established');
  }
  if (argv.length !== 5 || argv[3] !== CODEX_NOTIFY_PLAN_FLAG || argv[4] === undefined) {
    throw new Error('the managed Codex notifier command is malformed');
  }
  return decodeCodexNotifyPlan(argv[4]);
}

export function codexNotifyDispatchArgv(
  nodePath: string,
  entryPath: string,
  plan: CodexNotifyPlanV1,
): string[] {
  return [
    nodePath,
    entryPath,
    CODEX_NOTIFY_DISPATCH_COMMAND,
    CODEX_NOTIFY_PLAN_FLAG,
    encodeCodexNotifyPlan(plan),
  ];
}

export type CodexTacendumDispatchState =
  | 'not-run'
  | 'notified'
  | 'queued'
  | 'dropped'
  | 'never-started'
  | 'failed-after-start';

export type CodexPreviousDispatchState =
  | 'started'
  | 'completed'
  | 'never-started'
  | 'failed-after-start';

export interface CodexNotifyDiagnosticV1 {
  v: 1;
  recordedAt: string;
  tacendum: CodexTacendumDispatchState;
  previous: Array<{ index: number; state: CodexPreviousDispatchState }>;
}

export interface CodexNotifyDispatchOutcome {
  tacendum: CodexTacendumDispatchState;
  foreign: { started: number; completed: number; failed: number };
  diagnosticPath: string;
}

export type CodexNotifyDiagnosticRead =
  | { kind: 'ok'; diagnostic: CodexNotifyDiagnosticV1 }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

export interface CodexNotifyDiagnosticReadDeps {
  diagnosticPath?: string;
}

export interface CodexNotifyDispatchDeps {
  nodePath?: string;
  entryPath?: string;
  diagnosticPath?: string;
  childTimeoutMs?: number;
  now?: () => Date;
  spawnChild?: typeof spawn;
}

export function codexNotifyDiagnosticPath(account: string): string {
  return join(clientDir(account), 'codex-notify-status.json');
}

/** Read the dispatcher's last payload-free status for setup/doctor. The
 * result deliberately separates absence from malformed/unreadable state and
 * never returns file bytes in an error. A fixed-size read prevents a damaged
 * status path from becoming an unbounded doctor operation. */
export function readCodexNotifyDiagnostic(
  account: string,
  deps: CodexNotifyDiagnosticReadDeps = {},
): CodexNotifyDiagnosticRead {
  const path = deps.diagnosticPath ?? codexNotifyDiagnosticPath(account);
  let fd: number | undefined;
  let text: string;
  try {
    fd = openSync(path, 'r');
    const bytes = Buffer.alloc(MAX_DIAGNOSTIC_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_DIAGNOSTIC_BYTES) return { kind: 'unreadable' };
    text = bytes.subarray(0, count).toString('utf8');
  } catch (err) {
    return isRecord(err) && err.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read already completed; never surface filesystem detail from a
        // payload-adjacent diagnostic path.
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable' };
  }
  const tacendumStates: ReadonlySet<string> = new Set([
    'not-run',
    'notified',
    'queued',
    'dropped',
    'never-started',
    'failed-after-start',
  ]);
  const previousStates: ReadonlySet<string> = new Set([
    'started',
    'completed',
    'never-started',
    'failed-after-start',
  ]);
  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    typeof parsed.recordedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.recordedAt) ||
    typeof parsed.tacendum !== 'string' ||
    !tacendumStates.has(parsed.tacendum) ||
    !Array.isArray(parsed.previous) ||
    parsed.previous.length > 1 ||
    Object.keys(parsed).some(key => !['v', 'recordedAt', 'tacendum', 'previous'].includes(key))
  ) {
    return { kind: 'unreadable' };
  }
  const previous: Array<{ index: number; state: CodexPreviousDispatchState }> = [];
  for (const item of parsed.previous) {
    if (
      !isRecord(item) ||
      !Number.isSafeInteger(item.index) ||
      item.index !== previous.length ||
      typeof item.state !== 'string' ||
      !previousStates.has(item.state) ||
      Object.keys(item).some(key => key !== 'index' && key !== 'state')
    ) {
      return { kind: 'unreadable' };
    }
    previous.push({
      index: item.index as number,
      state: item.state as CodexPreviousDispatchState,
    });
  }
  return {
    kind: 'ok',
    diagnostic: {
      v: 1,
      recordedAt: parsed.recordedAt,
      tacendum: parsed.tacendum as CodexTacendumDispatchState,
      previous,
    },
  };
}

interface PreviousTracker {
  index: number;
  state: CodexPreviousDispatchState;
}

function launchPrevious(
  previous: CodexPreviousNotifier,
  payload: string,
  index: number,
  spawnChild: typeof spawn,
): PreviousTracker {
  const tracker: PreviousTracker = { index, state: 'never-started' };
  let child: ChildProcess;
  try {
    const [program, ...fixed] = previous.argv;
    if (program === undefined) return tracker;
    child = spawnChild(program, [...fixed, payload], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(previous.env ?? {}) },
    });
  } catch {
    return tracker;
  }
  let didStart = false;
  child.once('spawn', () => {
    didStart = true;
    tracker.state = 'started';
  });
  child.once('error', () => {
    tracker.state = 'never-started';
  });
  child.once('close', code => {
    if (!didStart) return;
    tracker.state = code === 0 ? 'completed' : 'failed-after-start';
  });
  child.unref();
  return tracker;
}

function tacendumStateFromStdout(text: string): CodexTacendumDispatchState {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return 'failed-after-start';
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] as string);
  } catch {
    return 'failed-after-start';
  }
  if (!isRecord(parsed) || typeof parsed.action !== 'string') return 'failed-after-start';
  switch (parsed.action) {
    case 'notified':
      return 'notified';
    case 'queued':
      return 'queued';
    case 'dropped':
    case 'unparsed':
      return 'dropped';
    case 'ignored':
    case 'cached':
    case 'uncacheable':
      return 'not-run';
    default:
      return 'failed-after-start';
  }
}

function runTacendumChild(
  plan: CodexNotifyPlanV1,
  payload: string,
  deps: CodexNotifyDispatchDeps,
): Promise<CodexTacendumDispatchState> {
  const spawnChild = deps.spawnChild ?? spawn;
  const nodePath = deps.nodePath ?? process.execPath;
  const entryPath = deps.entryPath ?? process.argv[1];
  if (entryPath === undefined) return Promise.resolve('never-started');
  const timeoutMs = deps.childTimeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
  return new Promise(resolve => {
    let child: ChildProcess;
    let settled = false;
    let started = false;
    let stdout = '';
    const finish = (state: CodexTacendumDispatchState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    try {
      child = spawnChild(
        nodePath,
        [entryPath, 'notify', '--hook', 'codex', '--account', plan.account, '--json', payload],
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, ...(plan.tacendumEnv ?? {}) },
        },
      );
    } catch {
      resolve('never-started');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A process that exited between the timer and kill is still an
        // after-start failure because it produced no classifiable result.
      }
      finish(started ? 'failed-after-start' : 'never-started');
    }, timeoutMs);
    child.once('spawn', () => {
      started = true;
    });
    child.once('error', () => finish('never-started'));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (Buffer.byteLength(stdout) > MAX_CHILD_STDOUT_BYTES) return;
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_CHILD_STDOUT_BYTES) {
        try {
          child.kill();
        } catch {
          // The close/error handlers settle the result.
        }
      }
    });
    child.once('close', code => {
      if (!started) return finish('never-started');
      if (code !== 0 || Buffer.byteLength(stdout) > MAX_CHILD_STDOUT_BYTES) {
        return finish('failed-after-start');
      }
      finish(tacendumStateFromStdout(stdout));
    });
  });
}

/**
 * Run the managed fan-out.  The input shape is positional on purpose: Codex
 * appends an opaque JSON string after the fixed config argv, and parsing it
 * as flags would make a payload beginning with `-` part of our CLI syntax.
 * This function writes no stdout/stderr; Codex discards both, while the
 * private status file remains available to setup/doctor.
 */
export async function runCodexNotifyDispatch(
  argv: string[],
  deps: CodexNotifyDispatchDeps = {},
): Promise<CodexNotifyDispatchOutcome> {
  if (argv.length !== 3 || argv[0] !== CODEX_NOTIFY_PLAN_FLAG || argv[1] === undefined) {
    throw new CliError(EXIT.USAGE, 'the managed Codex notifier invocation is malformed');
  }
  const payload = argv[2];
  if (payload === undefined) {
    throw new CliError(EXIT.USAGE, 'Codex did not append its notification payload');
  }
  let plan: CodexNotifyPlanV1;
  try {
    plan = decodeCodexNotifyPlan(argv[1]);
  } catch {
    throw new CliError(EXIT.ERROR, 'the managed Codex notifier plan is invalid or unsupported');
  }
  const spawnChild = deps.spawnChild ?? spawn;
  const previous = plan.previous.map((handler, index) =>
    launchPrevious(handler, payload, index, spawnChild),
  );
  const tacendum = await runTacendumChild(plan, payload, deps);
  // Let exit/close events already queued behind the Tacendum child update the
  // detached trackers before taking the diagnostic snapshot.
  await new Promise(resolve => setImmediate(resolve));

  const diagnosticPath = deps.diagnosticPath ?? codexNotifyDiagnosticPath(plan.account);
  const diagnostic: CodexNotifyDiagnosticV1 = {
    v: 1,
    recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
    tacendum,
    previous: previous.map(item => ({ index: item.index, state: item.state })),
  };
  try {
    mkdirSync(dirname(diagnosticPath), { recursive: true, mode: 0o700 });
    writeFileAtomic(diagnosticPath, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
  } catch {
    // A diagnostic write cannot recover a notification and must not turn a
    // fire-and-forget Codex hook into a host failure.
  }

  return {
    tacendum,
    foreign: {
      started: previous.filter(item => item.state !== 'never-started').length,
      completed: previous.filter(item => item.state === 'completed').length,
      failed: previous.filter(
        item => item.state === 'never-started' || item.state === 'failed-after-start',
      ).length,
    },
    diagnosticPath,
  };
}
