import { flagCount, flagString, parseArgs } from './args.js';
import {
  requestOwnerApproval,
  type ApprovalAsk,
  type ApprovalDecision,
  type OwnerApprovalIo,
} from './attend.js';
import { EXIT, type ExitCode } from './exit.js';
import { readHookStdin } from './hooks.js';
import type { Reporter } from './output.js';

/**
 * Claude Code native PermissionRequest bridge.
 *
 * This is deliberately separate from `notify`: notify must never block an
 * agent, while a permission hook exists to park until a human answers. The
 * current Claude Code contract invokes PermissionRequest immediately before
 * its interactive permission prompt and consumes the JSON object below.
 * Claude's `-p` noninteractive mode does not fire this hook (the current
 * official hooks guide calls that out explicitly), so this command is an
 * interactive-CLI approval bridge, not an attend subprocess approval mode.
 *
 * The bridge never returns updatedInput or updatedPermissions. An allow says
 * only “run the exact tool input Claude already proposed”; every parse,
 * transport, lock, timeout, or configuration failure returns deny.
 */

/** Hook settings use exactly ten minutes. The process and approval clocks
 * finish earlier so cleanup/output have a real margin and the child can never
 * outlive Claude's host-side timeout. */
export const CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS = 600;
export const CLAUDE_PERMISSION_APPROVAL_TTL_MS = 9 * 60_000;
export const CLAUDE_PERMISSION_PROCESS_DEADLINE_MS = 9 * 60_000 + 30_000;

const TOOL_NAME_MAX = 128;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const CWD_MAX = 4_096;
const DENY_MESSAGE = 'The paired Tacendum owner did not approve this request.';
const USAGE = 'usage: tacendum claude-permission --account <name> [--approvals <min-app-build>]';

class PermissionPayloadError extends Error {}

export interface ClaudePermissionRequest {
  toolName: string;
  /** The parsed JSON object is never rewritten or returned to Claude. It is
   * retained only long enough to compose the exact approval display payload. */
  toolInput: Record<string, unknown>;
  /** Verbatim native working directory. A relative Bash command without it
   * would authorize different bytes-by-effect in two projects. */
  cwd: string;
}

export type ClaudePermissionHookOutput = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow' } | { behavior: 'deny'; message: typeof DENY_MESSAGE };
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse the documented native hook input and nothing adjacent to it. Raw
 * session ids, transcript paths and permission suggestions are ignored. Cwd
 * is different: relative tool input changes meaning across directories, so
 * the validated verbatim cwd is folded into the immutable phone payload. */
export function parseClaudePermissionRequest(raw: string): ClaudePermissionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PermissionPayloadError('invalid JSON');
  }
  const input = asRecord(parsed);
  if (input === null || input.hook_event_name !== 'PermissionRequest') {
    throw new PermissionPayloadError('not a PermissionRequest');
  }
  const toolName = input.tool_name;
  if (
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    toolName.length > TOOL_NAME_MAX ||
    !TOOL_NAME_RE.test(toolName)
  ) {
    throw new PermissionPayloadError('invalid tool name');
  }
  const toolInput = asRecord(input.tool_input);
  if (toolInput === null) throw new PermissionPayloadError('invalid tool input');
  const cwd = input.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > CWD_MAX || cwd.includes('\0')) {
    throw new PermissionPayloadError('invalid cwd');
  }
  return { toolName, toolInput, cwd };
}

/** The only two provider responses this bridge can write. Keeping the fixed
 * deny message here makes every failure payload-free and testable. */
export function claudePermissionOutput(decision: ApprovalDecision): ClaudePermissionHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision:
        decision === 'approve'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: DENY_MESSAGE },
    },
  };
}

function approvalAsk(request: ClaudePermissionRequest): ApprovalAsk {
  const kind: ApprovalAsk['kind'] =
    request.toolName === 'Bash'
      ? 'commandExecution'
      : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(request.toolName)
        ? 'fileChange'
        : undefined;
  // These are the exact parsed tool values, serialized once for the card and
  // journal. JSON lexical spelling (escape form, numeric notation) may
  // normalize. Claude receives NONE of these serialized bytes back: allow
  // omits updatedInput, so the native host retains its original input object.
  // Cwd is part of the immutable authorization payload, not supplementary
  // context: the same relative command in two directories is not the same
  // operation. One JSON object keeps tool name, exact input and cwd bound
  // under the existing journal's single q/p pair.
  const payload = JSON.stringify({
    tool_name: request.toolName,
    tool_input: request.toolInput,
    cwd: request.cwd,
  });
  return {
    payload,
    ttlMs: CLAUDE_PERMISSION_APPROVAL_TTL_MS,
    contextCwd: request.cwd,
    ...(kind === undefined ? {} : { kind }),
  };
}

export interface ClaudePermissionDeps extends Pick<OwnerApprovalIo, 'now' | 'sleep' | 'sendReply'> {
  readStdin?: () => string | Promise<string>;
  emitDecision?: (output: ClaudePermissionHookOutput) => void | Promise<void>;
  requestApproval?: typeof requestOwnerApproval;
}

/**
 * Testable command core. Once invoked as this hook command it attempts exactly
 * one valid PermissionRequest decision. Ordinary failures emit an explicit
 * deny and exit zero. If stdout rejects that one write, the command exits
 * nonzero and says no decision was delivered; it never retries a possibly
 * partial allow on the same protocol stream.
 */
export async function runClaudePermission(
  argv: string[],
  report: Reporter,
  deps: ClaudePermissionDeps = {},
): Promise<ExitCode> {
  let emission: Promise<void> | undefined;
  let decisionWriteFailed = false;
  const emit = async (output: ClaudePermissionHookOutput): Promise<void> => {
    if (emission === undefined) {
      emission = (async () => {
        try {
          if (deps.emitDecision !== undefined) await deps.emitDecision(output);
          else await report.emitRecordAsync(output);
        } catch (err) {
          decisionWriteFailed = true;
          throw err;
        }
      })();
    }
    await emission;
  };
  const denyFailure = async (message: string): Promise<ExitCode> => {
    try {
      await emit(claudePermissionOutput('deny'));
    } catch {
      report.note('claude-permission: hook decision delivery could not be confirmed');
      return EXIT.ERROR;
    }
    report.note(message);
    return EXIT.OK;
  };

  let account: string;
  let approvalsMinAppBuild: number | undefined;
  let request: ClaudePermissionRequest;
  try {
    const args = parseArgs(argv, { value: ['--account', '--approvals'] });
    if (args.positionals.length > 0) throw new PermissionPayloadError('unexpected positional');
    const named = flagString(args, '--account');
    if (named === undefined || named === '') throw new PermissionPayloadError('missing account');
    account = named;
    if (flagString(args, '--approvals') !== undefined) {
      const build = flagCount(args, '--approvals', 0);
      if (build < 1) throw new PermissionPayloadError('invalid app build');
      approvalsMinAppBuild = build;
    }
    request = parseClaudePermissionRequest(await (deps.readStdin ?? readHookStdin)());
  } catch {
    return await denyFailure(
      `claude-permission: the hook invocation was invalid; request denied. ${USAGE}`,
    );
  }

  try {
    const outcome = await (deps.requestApproval ?? requestOwnerApproval)(
      account,
      approvalAsk(request),
      (decision) => emit(claudePermissionOutput(decision)),
      {
        ...(approvalsMinAppBuild === undefined ? {} : { approvalsMinAppBuild }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.sendReply === undefined ? {} : { sendReply: deps.sendReply }),
      },
    );
    if (outcome.status === 'busy') {
      report.note('claude-permission: another approval is already waiting; request denied');
    }
    return EXIT.OK;
  } catch {
    if (decisionWriteFailed) {
      report.note('claude-permission: hook decision delivery could not be confirmed');
      return EXIT.ERROR;
    }
    return await denyFailure(
      'claude-permission: the approval channel was unavailable; request denied',
    );
  }
}

export interface ClaudePermissionProcessIo {
  setExitCode: (code: ExitCode) => void;
  scheduleExit: (callback: () => void, delayMs: number) => { unref: () => unknown };
  drain: (callback: (error?: Error | null) => void) => void;
  exit: (code: ExitCode) => void;
}

const realProcessIo: ClaudePermissionProcessIo = {
  setExitCode: (code) => {
    process.exitCode = code;
  },
  scheduleExit: (callback, delayMs) => setTimeout(callback, delayMs),
  drain: (callback) => {
    process.stdout.write('', callback);
  },
  exit: (code) => process.exit(code),
};

/** Propagate one command result through both the normal stdout-drain callback
 * and the bounded fallback timer. `exitOnce` matters to injected tests and to
 * streams whose callback races the timer; production `process.exit` normally
 * makes the second arm unreachable. */
export function completeClaudePermissionProcess(
  code: ExitCode,
  report: Reporter,
  io: ClaudePermissionProcessIo = realProcessIo,
): void {
  report.done();
  io.setExitCode(code);
  let exited = false;
  const exitOnce = (result: ExitCode): void => {
    if (exited) return;
    exited = true;
    io.exit(result);
  };
  io.scheduleExit(() => exitOnce(code), 500).unref();
  io.drain((error) => {
    if (error) {
      report.note('claude-permission: stdout drain failed after the decision write');
      io.setExitCode(EXIT.ERROR);
      exitOnce(EXIT.ERROR);
      return;
    }
    exitOnce(code);
  });
}

export interface ClaudePermissionCommandDeps extends ClaudePermissionDeps {
  completeProcess?: (code: ExitCode, report: Reporter) => void;
}

/**
 * Wired hook entry point with a hard process bound. The core's TTL normally
 * wins first; this timer covers an abandoned socket or filesystem operation.
 * It emits a fixed deny before exiting and leaves any in-flight journal row
 * for the next lock holder's ordinary lapse sweep.
 */
export async function cmdClaudePermission(
  argv: string[],
  report: Reporter,
  deps: ClaudePermissionCommandDeps = {},
): Promise<void> {
  let emitted = false;
  const emitDecision = async (output: ClaudePermissionHookOutput): Promise<void> => {
    if (emitted) return;
    emitted = true;
    if (deps.emitDecision !== undefined) await deps.emitDecision(output);
    else await report.emitRecordAsync(output);
  };
  const complete = deps.completeProcess ?? completeClaudePermissionProcess;
  let completed = false;
  const finish = (code: ExitCode): void => {
    if (completed) return;
    completed = true;
    complete(code, report);
  };
  const deadline = setTimeout(() => {
    void (async () => {
      let code: ExitCode = EXIT.OK;
      try {
        await emitDecision(claudePermissionOutput('deny'));
      } catch {
        // Stdout itself failed. There is no second stream on which a valid
        // hook decision could be delivered; stderr stays fixed and payload-free.
        code = EXIT.ERROR;
      }
      report.note(
        code === EXIT.OK
          ? 'claude-permission: approval deadline reached; request denied'
          : 'claude-permission: hook decision delivery could not be confirmed',
      );
      finish(code);
    })();
  }, CLAUDE_PERMISSION_PROCESS_DEADLINE_MS);
  deadline.unref();
  const code = await runClaudePermission(argv, report, {
    emitDecision,
    ...(deps.readStdin === undefined ? {} : { readStdin: deps.readStdin }),
    ...(deps.requestApproval === undefined ? {} : { requestApproval: deps.requestApproval }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.sendReply === undefined ? {} : { sendReply: deps.sendReply }),
  });
  clearTimeout(deadline);
  finish(code);
}
