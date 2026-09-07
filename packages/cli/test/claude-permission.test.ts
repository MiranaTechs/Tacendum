import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code's native PermissionRequest hook, through the real approval
 * journal and owner-reply spool. The network alone is replaced: a fixture
 * must never need a registered server account to prove provider JSON → phone
 * card → validated reply → provider JSON.
 */
const home = mkdtempSync(join(tmpdir(), 'tacendum-claude-permission-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://claude-permission.test';
process.env.TACENDUM_WS = 'ws://claude-permission.test';

const seams = vi.hoisted(() => ({
  sends: [] as { to: string; body: string; msgId?: string; notify?: false }[],
}));

vi.mock('../src/send.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/send.js')>();
  return {
    ...real,
    sendEncrypted: async (args: { to: string; body: string; msgId?: string }) => {
      seams.sends.push({
        to: args.to,
        body: args.body,
        ...(args.msgId === undefined ? {} : { msgId: args.msgId }),
      });
      return { msgId: args.msgId ?? '', msgType: 'msg', receipt: { type: 'receipt' } };
    },
    sendEncryptedAll: async (args: {
      to: string;
      messages: { body: string; msgId?: string; notify?: boolean }[];
    }) =>
      args.messages.map((message) => {
        seams.sends.push({
          to: args.to,
          body: message.body,
          ...(message.msgId === undefined ? {} : { msgId: message.msgId }),
          ...(message.notify === false ? { notify: false as const } : {}),
        });
        return {
          msgId: message.msgId ?? '',
          msgType: 'msg' as const,
          receipt: { type: 'receipt' as const },
        };
      }),
  };
});

const {
  CLAUDE_PERMISSION_APPROVAL_TTL_MS,
  CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS,
  CLAUDE_PERMISSION_PROCESS_DEADLINE_MS,
  claudePermissionOutput,
  cmdClaudePermission,
  completeClaudePermissionProcess,
  parseClaudePermissionRequest,
  runClaudePermission,
} = await import('../src/claude-permission.js');
const { MessageLog } = await import('../src/msglog.js');
const { Reporter } = await import('../src/output.js');
const { saveProfile } = await import('../src/profile.js');
const { ApprovalRequestEnvelope } = await import('@tacendum/shared');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVS0';
const SELF = '01HQXW0000000000000000TEST';
let seq = 0;
const messageId = (): string =>
  `01HQXP00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const permissionPayload = (
  toolInput: Record<string, unknown> = {
    command: 'touch approved.txt',
    description: 'create the fixture artifact',
  },
): string =>
  JSON.stringify({
    session_id: 'aaaaaaaa-1111-4111-8111-111111111111',
    transcript_path: '/private/project/transcript.jsonl',
    cwd: '/private/project',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: toolInput,
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
  });

interface JournalRow {
  requestId: string;
  payload: string;
  state: string;
  msgId?: string;
  decision?: string;
  via?: string;
  answerId?: string;
}

const approvalPath = join(home, 'state', 'bot', 'attend-approvals.json');
const rows = (): JournalRow[] => {
  try {
    return (JSON.parse(readFileSync(approvalPath, 'utf8')) as { rows: JournalRow[] }).rows;
  } catch {
    return [];
  }
};

async function poll(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= end) throw new Error('poll timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function answer(peer: string, ref: string, text: string): string {
  const id = messageId();
  new MessageLog('bot').append({
    id,
    dir: 'in',
    peer,
    ts: Date.now(),
    tcm: 'reply',
    text,
    read: false,
    ref,
  });
  return id;
}

function capture() {
  const outputs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const report = new Reporter({ json: false, plain: true });
  vi.spyOn(report, 'note').mockImplementation((text) => notes.push(text));
  return {
    outputs,
    notes,
    report,
    emitDecision: (value: Record<string, unknown>) => outputs.push(value),
  };
}

beforeEach(() => {
  rmSync(join(home, 'clients'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.sends.length = 0;
  saveProfile({
    name: 'bot',
    identityKey: 'AAAA',
    userId: SELF,
    deviceId: 1,
    authToken: 'tok',
    registrationId: 1,
    accountClass: 'integration',
    ownerUserId: OWNER,
  });
});

describe('Claude PermissionRequest contract', () => {
  it('parses only the native event and emits an allow/deny decision with no policy or input mutation', () => {
    const toolInput = {
      command: 'printf %s "$VALUE"',
      timeout: 12_000,
      nested: { literal: 'updatedInput', values: [1, true, null] },
    };
    expect(parseClaudePermissionRequest(permissionPayload(toolInput))).toEqual({
      toolName: 'Bash',
      toolInput,
      cwd: '/private/project',
    });

    const allow = claudePermissionOutput('approve');
    expect(allow).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    const deny = claudePermissionOutput('deny');
    expect(deny).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: 'The paired Tacendum owner did not approve this request.',
        },
      },
    });
    for (const output of [allow, deny]) {
      const decision = output.hookSpecificOutput.decision as Record<string, unknown>;
      expect(Object.keys(decision)).not.toContain('updatedInput');
      expect(Object.keys(decision)).not.toContain('updatedPermissions');
      expect(Object.keys(decision)).not.toContain('interrupt');
    }
  });

  it("keeps the phone decision and cleanup inside Claude's ten-minute hook timeout", () => {
    expect(CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS).toBe(600);
    expect(CLAUDE_PERMISSION_APPROVAL_TTL_MS).toBeLessThan(CLAUDE_PERMISSION_PROCESS_DEADLINE_MS);
    expect(CLAUDE_PERMISSION_PROCESS_DEADLINE_MS).toBeLessThan(
      CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS * 1000,
    );
  });

  it('maps one native prompt through the real card/journal/reply path and returns allow for the unchanged tool input', async () => {
    const c = capture();
    const raw = permissionPayload();
    const run = runClaudePermission(['--account', 'bot', '--approvals', '42'], c.report, {
      readStdin: async () => raw,
      emitDecision: c.emitDecision,
    });
    await poll(() => rows()[0]?.state === 'pending' && rows()[0]?.msgId !== undefined);

    const parked = rows()[0] as JournalRow;
    expect(statSync(approvalPath).mode & 0o777).toBe(0o600);
    expect(seams.sends).toHaveLength(1);
    expect(seams.sends[0]?.to).toBe(OWNER);
    const parsed = ApprovalRequestEnvelope.safeParse(JSON.parse(seams.sends[0]!.body));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.q).toBe(parked.requestId);
    expect(parsed.data.k).toBe('exec');
    expect(parsed.data.work).toEqual({
      provider: 'claude',
      updatedAt: expect.any(Number),
      event: 'needs-review',
      eventId: parked.requestId,
      requestId: parked.requestId,
      context: { availability: 'unavailable' },
    });
    expect(parsed.data.p).toBe(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command: 'touch approved.txt',
          description: 'create the fixture artifact',
        },
        cwd: '/private/project',
      }),
    );
    expect(parsed.data.p).not.toContain('session_id');
    expect(parsed.data.p).not.toContain('transcript.jsonl');

    const wrong = answer(OTHER, parked.msgId as string, 'approve');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rows()[0]?.answerId, 'a different peer cannot decide the request').not.toBe(wrong);
    const right = answer(OWNER, parked.msgId as string, 'approve');
    expect(await run).toBe(0);

    expect(c.outputs).toEqual([claudePermissionOutput('approve')]);
    expect(rows()[0]).toMatchObject({
      state: 'returned',
      decision: 'approve',
      via: 'reply',
      answerId: right,
    });
    expect(rows()[0]?.payload, 'the immutable q/p authorization remains unchanged').toBe(
      parsed.data.p,
    );
    expect(seams.sends).toHaveLength(2);
    const observation = JSON.parse(seams.sends[1]!.body) as Record<string, unknown>;
    expect(seams.sends[1]?.notify).toBe(false);
    expect(observation).toMatchObject({
      tcm: 'reply',
      ref: parked.msgId,
      ofs: true,
      text: 'Approval decision returned to Claude.',
      ai: true,
      work: {
        provider: 'claude',
        requestId: parked.requestId,
        approvalObservation: 'decision-returned',
        updatedAt: expect.any(Number),
      },
    });
    expect((observation.work as Record<string, unknown>).event).toBeUndefined();
  }, 30_000);

  it('binds cwd into p, so the same relative command in two directories is a different approval', async () => {
    const first = parseClaudePermissionRequest(permissionPayload({ command: 'touch result.txt' }));
    const second = parseClaudePermissionRequest(
      permissionPayload({ command: 'touch result.txt' }).replace(
        '"cwd":"/private/project"',
        '"cwd":"/private/other project"',
      ),
    );
    expect(first.toolInput).toEqual(second.toolInput);
    expect(first.cwd).not.toBe(second.cwd);

    const asks: { payload: string; contextCwd?: string }[] = [];
    const requestApproval = async (
      _account: string,
      ask: { payload: string; contextCwd?: string },
      returnDecision: (decision: 'approve' | 'deny') => void | Promise<void>,
    ) => {
      asks.push(ask);
      await returnDecision('deny');
      return { status: 'returned' as const, decision: 'deny' as const, requestId: messageId() };
    };
    for (const raw of [
      permissionPayload({ command: 'touch result.txt' }),
      permissionPayload({ command: 'touch result.txt' }).replace(
        '"cwd":"/private/project"',
        '"cwd":"/private/other project"',
      ),
    ]) {
      const c = capture();
      await runClaudePermission(['--account', 'bot'], c.report, {
        readStdin: async () => raw,
        emitDecision: c.emitDecision,
        requestApproval,
      });
    }
    expect(asks).toEqual([
      {
        payload: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'touch result.txt' },
          cwd: '/private/project',
        }),
        contextCwd: '/private/project',
        ttlMs: CLAUDE_PERMISSION_APPROVAL_TTL_MS,
        kind: 'commandExecution',
      },
      {
        payload: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'touch result.txt' },
          cwd: '/private/other project',
        }),
        contextCwd: '/private/other project',
        ttlMs: CLAUDE_PERMISSION_APPROVAL_TTL_MS,
        kind: 'commandExecution',
      },
    ]);
  });

  it('returns deny on owner denial and on timeout; neither output widens policy', async () => {
    const denied = capture();
    const denyRun = runClaudePermission(['--account', 'bot', '--approvals', '42'], denied.report, {
      readStdin: async () => permissionPayload(),
      emitDecision: denied.emitDecision,
    });
    await poll(() => rows()[0]?.state === 'pending');
    answer(OWNER, rows()[0]!.msgId as string, 'deny');
    expect(await denyRun).toBe(0);
    expect(denied.outputs).toEqual([claudePermissionOutput('deny')]);
    expect(rows()[0]).toMatchObject({ state: 'returned', decision: 'deny', via: 'reply' });

    rmSync(join(home, 'state'), { recursive: true, force: true });
    let now = Date.now();
    const timed = capture();
    expect(
      await runClaudePermission(['--account', 'bot', '--approvals', '42'], timed.report, {
        readStdin: async () => permissionPayload(),
        emitDecision: timed.emitDecision,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      }),
    ).toBe(0);
    expect(timed.outputs).toEqual([claudePermissionOutput('deny')]);
    expect(rows()[0]).toMatchObject({ state: 'returned', decision: 'deny', via: 'ttl' });
  }, 30_000);

  it('denies when the pending journal binding changes before settlement', async () => {
    const c = capture();
    const run = runClaudePermission(['--account', 'bot', '--approvals', '42'], c.report, {
      readStdin: async () => permissionPayload(),
      emitDecision: c.emitDecision,
    });
    await poll(() => rows()[0]?.state === 'pending');
    const original = rows()[0] as JournalRow;
    const file = JSON.parse(readFileSync(approvalPath, 'utf8')) as {
      overCapRefusals: number;
      rows: (JournalRow & { askedAt: number; ttlMs: number })[];
    };
    file.rows[0] = { ...file.rows[0]!, payload: 'locally altered payload' };
    writeFileSync(approvalPath, JSON.stringify(file), { mode: 0o600 });
    answer(OWNER, original.msgId as string, 'approve');

    expect(await run).toBe(0);
    expect(c.outputs).toEqual([claudePermissionOutput('deny')]);
    expect(rows()[0]).toMatchObject({
      state: 'returned',
      decision: 'deny',
      via: 'mismatch',
    });
  }, 30_000);

  it('does not mark a decision returned when the provider stdout write fails', async () => {
    const report = new Reporter({ json: false, plain: true });
    vi.spyOn(report, 'note').mockImplementation(() => {});
    const run = runClaudePermission(['--account', 'bot', '--approvals', '42'], report, {
      readStdin: async () => permissionPayload(),
      emitDecision: async () => {
        throw new Error('stdout unavailable');
      },
    });
    await poll(() => rows()[0]?.state === 'pending');
    answer(OWNER, rows()[0]!.msgId as string, 'approve');

    expect(await run).toBe(1);
    expect(rows()[0]).toMatchObject({ state: 'answering', decision: 'approve' });
    expect(rows()[0]?.state).not.toBe('returned');
    expect(report.note).toHaveBeenCalledWith(
      'claude-permission: hook decision delivery could not be confirmed',
    );
  }, 30_000);

  it('propagates the command result through both process-exit paths after a final drain', () => {
    const report = new Reporter({ json: false, plain: true });
    vi.spyOn(report, 'done').mockImplementation(() => {});
    const setCodes: number[] = [];
    const exited: number[] = [];
    let fallback: (() => void) | undefined;
    let drained: ((err?: Error | null) => void) | undefined;
    const unref = vi.fn();

    completeClaudePermissionProcess(1, report, {
      setExitCode: (code) => setCodes.push(code),
      scheduleExit: (callback) => {
        fallback = callback;
        return { unref };
      },
      drain: (callback) => {
        drained = callback;
      },
      exit: (code) => exited.push(code),
    });

    expect(report.done).toHaveBeenCalledOnce();
    expect(setCodes).toEqual([1]);
    expect(unref).toHaveBeenCalledOnce();
    drained?.();
    fallback?.();
    expect(exited).toEqual([1]);
  });

  it('carries an undelivered decision failure through the wired command status', async () => {
    const report = new Reporter({ json: false, plain: true });
    vi.spyOn(report, 'note').mockImplementation(() => {});
    const completed: number[] = [];

    await cmdClaudePermission(['--account', 'bot', '--approvals', '42'], report, {
      readStdin: async () => permissionPayload(),
      emitDecision: async () => {
        throw new Error('stdout unavailable');
      },
      requestApproval: async (_account, _ask, returnDecision) => {
        await returnDecision('approve');
        throw new Error('decision write failed');
      },
      completeProcess: (code) => completed.push(code),
    });

    expect(completed).toEqual([1]);
    expect(report.note).toHaveBeenCalledWith(
      'claude-permission: hook decision delivery could not be confirmed',
    );
  });

  it('bounded-denies a simultaneous hook for the same account without a second card or stolen reply', async () => {
    const first = capture();
    const firstRun = runClaudePermission(['--account', 'bot', '--approvals', '42'], first.report, {
      readStdin: async () => permissionPayload(),
      emitDecision: first.emitDecision,
    });
    await poll(() => rows()[0]?.state === 'pending');
    const firstMsgId = rows()[0]!.msgId as string;

    const second = capture();
    expect(
      await runClaudePermission(['--account', 'bot', '--approvals', '42'], second.report, {
        readStdin: async () => permissionPayload({ command: 'touch second.txt' }),
        emitDecision: second.emitDecision,
      }),
    ).toBe(0);
    expect(second.outputs).toEqual([claudePermissionOutput('deny')]);
    expect(second.notes.join('\n')).toContain('another approval is already waiting');
    expect(rows(), 'the rejected contender mints no journal row').toHaveLength(1);
    expect(seams.sends, 'the rejected contender sends no card').toHaveLength(1);

    answer(OWNER, firstMsgId, 'deny');
    expect(await firstRun).toBe(0);
    expect(first.outputs).toEqual([claudePermissionOutput('deny')]);
    expect(rows()[0]?.state).toBe('returned');
  }, 30_000);

  it('malformed or wrong-event input emits one fixed deny and never repeats payload bytes in diagnostics', async () => {
    for (const raw of [
      '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":',
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'SECRET_TOOL_TEXT',
        tool_input: { command: 'SECRET_COMMAND_TEXT' },
      }),
    ]) {
      const c = capture();
      expect(
        await runClaudePermission(['--account', 'bot', '--approvals', '42'], c.report, {
          readStdin: async () => raw,
          emitDecision: c.emitDecision,
        }),
      ).toBe(0);
      expect(c.outputs).toEqual([claudePermissionOutput('deny')]);
      const diagnostics = c.notes.join('\n');
      expect(diagnostics).not.toContain('SECRET_TOOL_TEXT');
      expect(diagnostics).not.toContain('SECRET_COMMAND_TEXT');
      expect(diagnostics).not.toContain('tool_input');
    }
    expect(seams.sends).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });
});
