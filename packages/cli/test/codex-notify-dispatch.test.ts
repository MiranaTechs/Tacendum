import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeCodexNotifyPlan,
  encodeCodexNotifyPlan,
  readCodexNotifyDiagnostic,
  runCodexNotifyDispatch,
  type CodexNotifyPlanV1,
} from '../src/codex-notify-dispatch.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tacendum codex dispatch '));
  dirs.push(dir);
  return dir;
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!existsSync(path)) throw new Error('recorder did not finish');
}

describe('managed Codex notification dispatcher', () => {
  it('forwards the final JSON argument unchanged with no shell interpolation', async () => {
    const dir = scratch();
    const previousScript = join(dir, 'previous notifier.mjs');
    const tacendumScript = join(dir, 'fake cli entry.mjs');
    const previousOut = join(dir, 'previous.json');
    const tacendumOut = join(dir, 'tacendum.json');
    const diagnosticPath = join(dir, 'diagnostic.json');
    const shellSentinel = join(dir, 'shell-expanded');
    writeFileSync(
      previousScript,
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PREVIOUS_OUT, JSON.stringify(process.argv.slice(2)));\n",
    );
    writeFileSync(
      tacendumScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.TACENDUM_OUT, JSON.stringify(process.argv.slice(2)));",
        "process.stdout.write(JSON.stringify({ok:true, action:'notified', host:'codex', state:'sent'}) + '\\n');",
        '',
      ].join('\n'),
    );
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      text: `quotes "; line one\nline two; $(touch ${shellSentinel}); ☺`,
    });
    const plan: CodexNotifyPlanV1 = {
      v: 1,
      account: 'ci',
      previous: [
        {
          argv: [process.execPath, previousScript, 'fixed argument with spaces'],
          env: { PREVIOUS_OUT: previousOut },
        },
      ],
      tacendumEnv: { TACENDUM_OUT: tacendumOut },
    };

    const outcome = await runCodexNotifyDispatch(
      ['--plan-v1', encodeCodexNotifyPlan(plan), payload],
      {
        nodePath: process.execPath,
        entryPath: tacendumScript,
        diagnosticPath,
        childTimeoutMs: 2_000,
      },
    );
    await waitFor(previousOut);

    expect(JSON.parse(readFileSync(previousOut, 'utf8'))).toEqual([
      'fixed argument with spaces',
      payload,
    ]);
    expect(JSON.parse(readFileSync(tacendumOut, 'utf8'))).toEqual([
      'notify',
      '--hook',
      'codex',
      '--account',
      'ci',
      '--json',
      payload,
    ]);
    expect(existsSync(shellSentinel)).toBe(false);
    expect(outcome).toEqual({
      tacendum: 'notified',
      foreign: { started: 1, completed: 1, failed: 0 },
      diagnosticPath,
    });
    expect(statSync(diagnosticPath).mode & 0o777).toBe(0o600);
    const diagnostic = readFileSync(diagnosticPath, 'utf8');
    expect(diagnostic).not.toContain(payload);
    expect(diagnostic).not.toContain(previousScript);
    expect(JSON.parse(diagnostic)).toMatchObject({
      v: 1,
      tacendum: 'notified',
      previous: [{ index: 0, state: 'completed' }],
    });
    expect(readCodexNotifyDiagnostic('ci', { diagnosticPath })).toMatchObject({
      kind: 'ok',
      diagnostic: {
        v: 1,
        tacendum: 'notified',
        previous: [{ index: 0, state: 'completed' }],
      },
    });
  });

  it('reports a previous program that never started while Tacendum still queues', async () => {
    const dir = scratch();
    const tacendumScript = join(dir, 'queueing cli.mjs');
    const tacendumOut = join(dir, 'tacendum.json');
    const diagnosticPath = join(dir, 'diagnostic.json');
    writeFileSync(
      tacendumScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.TACENDUM_OUT, JSON.stringify(process.argv.at(-1)));",
        "process.stdout.write(JSON.stringify({ok:true, action:'queued', host:'codex'}) + '\\n');",
        '',
      ].join('\n'),
    );
    const payload = '{"type":"agent-turn-complete","last-assistant-message":"kept opaque"}';
    const plan: CodexNotifyPlanV1 = {
      v: 1,
      account: 'ci',
      previous: [{ argv: [join(dir, 'missing notifier'), 'fixed'] }],
      tacendumEnv: { TACENDUM_OUT: tacendumOut },
    };

    const outcome = await runCodexNotifyDispatch(
      ['--plan-v1', encodeCodexNotifyPlan(plan), payload],
      {
        nodePath: process.execPath,
        entryPath: tacendumScript,
        diagnosticPath,
        childTimeoutMs: 2_000,
      },
    );

    expect(JSON.parse(readFileSync(tacendumOut, 'utf8'))).toBe(payload);
    expect(outcome).toEqual({
      tacendum: 'queued',
      foreign: { started: 0, completed: 0, failed: 1 },
      diagnosticPath,
    });
    expect(JSON.parse(readFileSync(diagnosticPath, 'utf8'))).toMatchObject({
      tacendum: 'queued',
      previous: [{ index: 0, state: 'never-started' }],
    });
  });

  it('distinguishes a Tacendum program that never starts from failure after startup', async () => {
    const dir = scratch();
    const payload = '{"type":"agent-turn-complete"}';
    const plan: CodexNotifyPlanV1 = { v: 1, account: 'ci', previous: [] };
    const neverPath = join(dir, 'never.json');
    const never = await runCodexNotifyDispatch(
      ['--plan-v1', encodeCodexNotifyPlan(plan), payload],
      {
        nodePath: join(dir, 'missing node'),
        entryPath: join(dir, 'missing entry'),
        diagnosticPath: neverPath,
        childTimeoutMs: 200,
      },
    );
    expect(never.tacendum).toBe('never-started');
    expect(JSON.parse(readFileSync(neverPath, 'utf8')).tacendum).toBe('never-started');

    const failingEntry = join(dir, 'failing cli.mjs');
    writeFileSync(failingEntry, 'process.exitCode = 7;\n');
    const failedPath = join(dir, 'failed.json');
    const failed = await runCodexNotifyDispatch(
      ['--plan-v1', encodeCodexNotifyPlan(plan), payload],
      {
        nodePath: process.execPath,
        entryPath: failingEntry,
        diagnosticPath: failedPath,
        childTimeoutMs: 2_000,
      },
    );
    expect(failed.tacendum).toBe('failed-after-start');
    expect(JSON.parse(readFileSync(failedPath, 'utf8')).tacendum).toBe('failed-after-start');
  });

  it('reads only the bounded payload-free diagnostic schema', () => {
    const dir = scratch();
    const diagnosticPath = join(dir, 'status.json');
    expect(readCodexNotifyDiagnostic('ci', { diagnosticPath })).toEqual({ kind: 'missing' });

    writeFileSync(diagnosticPath, '{"v":1,"recordedAt":"now","tacendum":"notified","previous":[],"payload":"secret"}');
    expect(readCodexNotifyDiagnostic('ci', { diagnosticPath })).toEqual({ kind: 'unreadable' });

    writeFileSync(diagnosticPath, 'x'.repeat(20 * 1024));
    expect(readCodexNotifyDiagnostic('ci', { diagnosticPath })).toEqual({ kind: 'unreadable' });
  });

  it('rejects oversized and unknown notifier plans without echoing their contents', () => {
    const unknown = Buffer.from(
      JSON.stringify({ v: 1, account: 'ci', previous: [], secret: 'do not echo' }),
    ).toString('base64url');
    expect(() => decodeCodexNotifyPlan(unknown)).toThrow(
      'the managed Codex notifier plan is invalid or unsupported',
    );
    expect(() => decodeCodexNotifyPlan('a'.repeat(65 * 1024))).toThrow(
      'the managed Codex notifier plan is invalid or unsupported',
    );
  });
});
