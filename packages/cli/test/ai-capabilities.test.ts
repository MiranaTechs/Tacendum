import { describe, expect, it, vi } from 'vitest';
import {
  aiAttendCapabilityFact,
  observeCodexVersion,
  parseCodexVersionOutput,
  readAiCapabilities,
  type AiCapabilityFacts,
} from '../src/ai-capabilities.js';

function facts(overrides: Partial<AiCapabilityFacts> = {}): AiCapabilityFacts {
  return {
    provider: 'codex',
    notificationConfigured: false,
    nativeClaudePermissionConfigured: false,
    listenerConfigured: false,
    listenerRunning: false,
    attend: { configured: false },
    ...overrides,
  };
}

describe('provider-scoped AI capabilities', () => {
  it('normalizes attend runnability once and requires Codex isolated-home sign-in', () => {
    const observed = {
      configured: true,
      host: 'codex',
      paired: true,
      binRunnable: true,
      workdirIsDirectory: true,
      codexDriver: 'app-server',
      codexApprovalPolicy: 'on-request',
    };
    expect(aiAttendCapabilityFact(observed)).toEqual({
      configured: true,
      provider: 'codex',
      runnable: false,
      driver: 'app-server',
      approvalPolicy: 'on-request',
    });
    expect(aiAttendCapabilityFact({ ...observed, codexSignedIn: true })).toEqual({
      configured: true,
      provider: 'codex',
      runnable: true,
      driver: 'app-server',
      approvalPolicy: 'on-request',
    });
  });

  it('keeps unknown drivers inspectable but refuses custom attend providers', () => {
    expect(
      aiAttendCapabilityFact({
        configured: true,
        host: 'claude',
        paired: true,
        binRunnable: true,
        workdirIsDirectory: true,
        claudeDriver: 'future-driver',
      }),
    ).toEqual({
      configured: true,
      provider: 'claude',
      runnable: true,
      driver: 'future-driver',
    });
    expect(
      aiAttendCapabilityFact({
        configured: true,
        host: 'custom-provider',
        paired: true,
        binRunnable: true,
        workdirIsDirectory: true,
      }),
    ).toEqual({ configured: false });
  });

  it('fails closed when a present driver or approval policy has a malformed shape', () => {
    const base = {
      configured: true,
      paired: true,
      binRunnable: true,
      workdirIsDirectory: true,
    };
    expect(
      aiAttendCapabilityFact({ ...base, host: 'codex', codexSignedIn: true, codexDriver: 123 }),
    ).toEqual({ configured: true, provider: 'codex', runnable: false });
    expect(
      aiAttendCapabilityFact({
        ...base,
        host: 'codex',
        codexSignedIn: true,
        codexApprovalPolicy: 123,
      }),
    ).toEqual({ configured: true, provider: 'codex', runnable: false });
    expect(aiAttendCapabilityFact({ ...base, host: 'claude', claudeDriver: 123 })).toEqual({
      configured: true,
      provider: 'claude',
      runnable: false,
    });
  });

  it('requires current package and API-key presence for the Claude SDK only', () => {
    const sdk = {
      configured: true,
      host: 'claude',
      paired: true,
      binRunnable: true,
      workdirIsDirectory: true,
      claudeDriver: 'sdk',
    };
    expect(aiAttendCapabilityFact(sdk)).toEqual({
      configured: true,
      provider: 'claude',
      runnable: false,
      driver: 'sdk',
      claudeSdkInstalled: false,
      claudeSdkApiKeyPresent: false,
    });
    expect(aiAttendCapabilityFact({ ...sdk, claudeSdkInstalled: true })).toEqual({
      configured: true,
      provider: 'claude',
      runnable: false,
      driver: 'sdk',
      claudeSdkInstalled: true,
      claudeSdkApiKeyPresent: false,
    });
    expect(
      aiAttendCapabilityFact({
        ...sdk,
        claudeSdkInstalled: true,
        claudeSdkApiKeyPresent: true,
      }),
    ).toEqual({
      configured: true,
      provider: 'claude',
      runnable: true,
      driver: 'sdk',
      claudeSdkInstalled: true,
      claudeSdkApiKeyPresent: true,
    });

    expect(
      aiAttendCapabilityFact({
        ...sdk,
        claudeDriver: 'subprocess',
      }),
    ).toEqual({
      configured: true,
      provider: 'claude',
      runnable: true,
      driver: 'subprocess',
    });
  });

  it('reports a maintained Codex hook alone as notifications-only', () => {
    expect(
      readAiCapabilities(
        facts({
          provider: 'codex',
          notificationConfigured: true,
          codexInstalledVersion: '0.153.4',
        }),
      ),
    ).toEqual({
      capabilities: { notifications: true, approvals: false, tasks: false },
      codexVersion: {
        installed: '0.153.4',
        validatedTarget: '0.153.4',
        status: 'validated',
      },
    });
  });

  it('requires a configured listener before a native Claude hook is approval-capable', () => {
    const hookOnly = facts({
      provider: 'claude',
      nativeClaudePermissionConfigured: true,
    });
    expect(readAiCapabilities(hookOnly).capabilities).toEqual({
      notifications: false,
      approvals: false,
      tasks: false,
    });
    expect(readAiCapabilities({ ...hookOnly, listenerConfigured: true }).capabilities).toEqual({
      notifications: false,
      approvals: true,
      tasks: false,
    });
  });

  it('enables tasks and approvals only for a runnable same-provider approval driver', () => {
    const appServer = facts({
      provider: 'codex',
      codexInstalledVersion: '0.153.4',
      listenerConfigured: true,
      attend: {
        configured: true,
        provider: 'codex',
        runnable: true,
        driver: 'app-server',
        approvalPolicy: 'untrusted',
      },
    });
    expect(readAiCapabilities(appServer).capabilities).toEqual({
      notifications: true,
      approvals: true,
      tasks: true,
    });
    expect(
      readAiCapabilities({
        ...appServer,
        codexInstalledVersion: '0.154.0',
      }).capabilities,
    ).toEqual({ notifications: true, approvals: false, tasks: true });
    expect(
      readAiCapabilities({
        ...appServer,
        attend: { ...appServer.attend, approvalPolicy: 'never' },
      }).capabilities,
    ).toEqual({ notifications: true, approvals: false, tasks: true });

    expect(
      readAiCapabilities(
        facts({
          provider: 'claude',
          listenerConfigured: true,
          attend: {
            configured: true,
            provider: 'claude',
            runnable: true,
            driver: 'sdk',
            claudeSdkInstalled: true,
            claudeSdkApiKeyPresent: true,
          },
        }),
      ).capabilities,
    ).toEqual({ notifications: true, approvals: true, tasks: true });

    expect(
      readAiCapabilities(
        facts({
          provider: 'claude',
          listenerConfigured: true,
          attend: {
            configured: true,
            provider: 'claude',
            runnable: true,
            driver: 'sdk',
          },
        }),
      ).capabilities,
    ).toEqual({ notifications: false, approvals: false, tasks: false });
  });

  it('treats a runnable same-provider answerer as its own notification source', () => {
    expect(
      readAiCapabilities(
        facts({
          provider: 'claude',
          attend: {
            configured: true,
            provider: 'claude',
            runnable: true,
            driver: 'subprocess',
          },
        }),
      ).capabilities,
    ).toEqual({ notifications: true, approvals: false, tasks: true });
  });

  it('does not merge a different provider answerer or an unrecognized driver', () => {
    const codexAnswerer = {
      configured: true as const,
      provider: 'codex' as const,
      runnable: true,
      driver: 'app-server',
      approvalPolicy: 'on-request',
    };
    expect(
      readAiCapabilities(
        facts({
          provider: 'claude',
          notificationConfigured: true,
          attend: codexAnswerer,
        }),
      ).capabilities,
    ).toEqual({ notifications: true, approvals: false, tasks: false });
    expect(
      readAiCapabilities(
        facts({
          attend: { ...codexAnswerer, provider: 'codex', driver: 'future-driver' },
        }),
      ).capabilities,
    ).toEqual({ notifications: false, approvals: false, tasks: false });
  });

  it('labels other observed Codex versions unvalidated rather than broken', () => {
    expect(readAiCapabilities(facts({ codexInstalledVersion: '0.154.0' })).codexVersion).toEqual({
      installed: '0.154.0',
      validatedTarget: '0.153.4',
      status: 'unvalidated',
    });
    expect(readAiCapabilities(facts({ codexInstalledVersion: null })).codexVersion).toEqual({
      installed: null,
      validatedTarget: '0.153.4',
      status: 'unavailable',
    });
  });
});

describe('bounded Codex version observation', () => {
  it('accepts only the fixed one-line CLI version shape', () => {
    expect(parseCodexVersionOutput('codex-cli 0.153.4\n')).toBe('0.153.4');
    expect(parseCodexVersionOutput('codex 0.153.4-beta.1\n')).toBe('0.153.4-beta.1');
    expect(parseCodexVersionOutput('warning\ncodex-cli 0.153.4\n')).toBeNull();
    expect(parseCodexVersionOutput('x'.repeat(300))).toBeNull();
  });

  it('spawns without a shell and bounds time and output', () => {
    const spawnVersion = vi.fn(() => ({ status: 0, stdout: 'codex-cli 0.153.4\n' }));
    expect(observeCodexVersion('/path with spaces/codex', { spawnVersion })).toBe('0.153.4');
    expect(spawnVersion).toHaveBeenCalledWith('/path with spaces/codex', ['--version'], {
      shell: false,
      timeout: 2_000,
      maxBuffer: 4_096,
      encoding: 'utf8',
    });
  });
});
