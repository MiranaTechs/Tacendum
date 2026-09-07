import { spawnSync } from 'node:child_process';
import {
  AI_WORK_PROVIDERS,
  AiWorkCapabilitiesSchema,
  type AiWorkCapabilities,
} from '@tacendum/shared';
import { CODEX_APPSERVER_VERSION } from './codex-appserver.js';

export type AiProvider = (typeof AI_WORK_PROVIDERS)[number];

/** A caller-proven summary of one attend config. `runnable` means its local
 * binary, workdir, pairing and provider-specific configuration all passed
 * the caller's read-only checks. The explicit provider prevents an account
 * name or a different answerer on the same identity being merged into this
 * surface's capabilities. */
export type AiAttendCapabilityFact =
  | { configured: false }
  | {
      configured: true;
      provider: AiProvider;
      runnable: boolean;
      driver?: string;
      approvalPolicy?: string;
      /** Claude SDK only: current, source-backed readiness facts. Missing is
       * deliberately equivalent to false so stale configure-time success
       * cannot advertise a driver whose next turn will refuse. */
      claudeSdkInstalled?: boolean;
      claudeSdkApiKeyPresent?: boolean;
    };

/** Minimal read-only attend observation shared by setup and doctor. Values
 * are deliberately `unknown`: both callers ultimately describe local JSON,
 * and an edited future/custom provider must fail closed instead of being
 * asserted into today's provider vocabulary. */
export interface AiAttendObservation {
  configured: boolean;
  host?: unknown;
  paired?: unknown;
  binRunnable?: unknown;
  workdirIsDirectory?: unknown;
  codexSignedIn?: unknown;
  codexDriver?: unknown;
  codexApprovalPolicy?: unknown;
  claudeDriver?: unknown;
  claudeSdkInstalled?: unknown;
  claudeSdkApiKeyPresent?: unknown;
}

/** Normalize the one attend state into a capability fact. Runnability is the
 * conjunction used by both producers: pairing, executable, workdir, and for
 * Codex its isolated-home sign-in. Unknown providers and field shapes produce
 * no recognized attend fact. */
export function aiAttendCapabilityFact(observed: AiAttendObservation): AiAttendCapabilityFact {
  if (observed.configured !== true) return { configured: false };
  if (observed.host !== 'claude' && observed.host !== 'codex' && observed.host !== 'gemini') {
    return { configured: false };
  }
  const malformedProviderConfig =
    (observed.host === 'codex' &&
      ((observed.codexDriver !== undefined && typeof observed.codexDriver !== 'string') ||
        (observed.codexApprovalPolicy !== undefined &&
          typeof observed.codexApprovalPolicy !== 'string'))) ||
    (observed.host === 'claude' &&
      observed.claudeDriver !== undefined &&
      typeof observed.claudeDriver !== 'string');
  const claudeSdk = observed.host === 'claude' && observed.claudeDriver === 'sdk';
  const claudeSdkInstalled = observed.claudeSdkInstalled === true;
  const claudeSdkApiKeyPresent = observed.claudeSdkApiKeyPresent === true;
  const runnable =
    !malformedProviderConfig &&
    observed.paired === true &&
    observed.binRunnable === true &&
    observed.workdirIsDirectory === true &&
    (observed.host !== 'codex' || observed.codexSignedIn === true) &&
    (!claudeSdk || (claudeSdkInstalled && claudeSdkApiKeyPresent));
  if (observed.host === 'codex') {
    return {
      configured: true,
      provider: 'codex',
      runnable,
      ...(typeof observed.codexDriver === 'string' ? { driver: observed.codexDriver } : {}),
      ...(typeof observed.codexApprovalPolicy === 'string'
        ? { approvalPolicy: observed.codexApprovalPolicy }
        : {}),
    };
  }
  if (observed.host === 'claude') {
    return {
      configured: true,
      provider: 'claude',
      runnable,
      ...(typeof observed.claudeDriver === 'string' ? { driver: observed.claudeDriver } : {}),
      ...(claudeSdk ? { claudeSdkInstalled, claudeSdkApiKeyPresent } : {}),
    };
  }
  return { configured: true, provider: 'gemini', runnable };
}

export interface AiCapabilityFacts {
  provider: AiProvider;
  /** True only after the caller verifies the exact maintained host handler.
   * A runnable same-provider answerer is an independent notification source;
   * `readAiCapabilities` derives that from `attend` itself. */
  notificationConfigured: boolean;
  nativeClaudePermissionConfigured: boolean;
  /** The ordinary inbound listener is required to receive owner decisions. */
  listenerConfigured: boolean;
  /** Health is reported separately; configured capabilities do not disappear
   * during a temporary process restart. */
  listenerRunning?: boolean;
  attend: AiAttendCapabilityFact;
  /** Undefined omits the diagnostic; null records that the version could not
   * be observed. A string must already be the bounded parser's safe shape. */
  codexInstalledVersion?: string | null;
}

export interface CodexVersionDiagnostic {
  installed: string | null;
  validatedTarget: typeof CODEX_APPSERVER_VERSION;
  status: 'validated' | 'unvalidated' | 'unavailable';
}

export interface AiCapabilityAssessment {
  capabilities: AiWorkCapabilities;
  codexVersion?: CodexVersionDiagnostic;
}

function attendSupport(
  provider: AiProvider,
  attend: AiAttendCapabilityFact,
): { tasks: boolean; approvals: boolean } {
  if (!attend.configured || !attend.runnable || attend.provider !== provider) {
    return { tasks: false, approvals: false };
  }
  switch (provider) {
    case 'codex': {
      const driver = attend.driver ?? 'exec';
      if (driver === 'exec') {
        return attend.approvalPolicy === undefined
          ? { tasks: true, approvals: false }
          : { tasks: false, approvals: false };
      }
      if (driver !== 'app-server') return { tasks: false, approvals: false };
      const policy = attend.approvalPolicy ?? 'untrusted';
      if (policy !== 'untrusted' && policy !== 'on-request' && policy !== 'never') {
        return { tasks: false, approvals: false };
      }
      return { tasks: true, approvals: policy !== 'never' };
    }
    case 'claude': {
      const driver = attend.driver ?? 'subprocess';
      if (attend.approvalPolicy !== undefined) return { tasks: false, approvals: false };
      if (driver === 'subprocess') return { tasks: true, approvals: false };
      if (driver !== 'sdk') return { tasks: false, approvals: false };
      return attend.claudeSdkInstalled === true && attend.claudeSdkApiKeyPresent === true
        ? { tasks: true, approvals: true }
        : { tasks: false, approvals: false };
    }
    case 'gemini':
      return attend.driver === undefined && attend.approvalPolicy === undefined
        ? { tasks: true, approvals: false }
        : { tasks: false, approvals: false };
    case 'cursor':
      return { tasks: false, approvals: false };
  }
}

/** Derive the exact wire capability triple from already-observed local facts.
 * The output passes the shared strict schema rather than relying on a second
 * handwritten shape in the CLI. */
export function readAiCapabilities(facts: AiCapabilityFacts): AiCapabilityAssessment {
  const attend = attendSupport(facts.provider, facts.attend);
  const attendApprovalsValidated =
    attend.approvals &&
    (facts.provider !== 'codex' || facts.codexInstalledVersion === CODEX_APPSERVER_VERSION);
  const capabilities = AiWorkCapabilitiesSchema.parse({
    notifications: facts.notificationConfigured === true || attend.tasks,
    approvals:
      facts.listenerConfigured === true &&
      (attendApprovalsValidated ||
        (facts.provider === 'claude' && facts.nativeClaudePermissionConfigured === true)),
    tasks: attend.tasks,
  });
  if (facts.provider !== 'codex' || facts.codexInstalledVersion === undefined) {
    return { capabilities };
  }
  const installed = facts.codexInstalledVersion;
  if (installed !== null && parseCodexVersionOutput(`codex-cli ${installed}`) !== installed) {
    throw new Error('the observed Codex version is not a supported diagnostic value');
  }
  return {
    capabilities,
    codexVersion: {
      installed,
      validatedTarget: CODEX_APPSERVER_VERSION,
      status:
        installed === null
          ? 'unavailable'
          : installed === CODEX_APPSERVER_VERSION
            ? 'validated'
            : 'unvalidated',
    },
  };
}

const MAX_VERSION_OUTPUT_BYTES = 256;

/** Parse only Codex's fixed, one-line version response. Runtime warnings,
 * multiline output and unbounded text never reach a diagnostic field. */
export function parseCodexVersionOutput(output: string): string | null {
  if (Buffer.byteLength(output) > MAX_VERSION_OUTPUT_BYTES) return null;
  const match = /^(?:codex|codex-cli) ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\r?\n?$/.exec(
    output,
  );
  return match?.[1] ?? null;
}

interface CodexVersionSpawnResult {
  status: number | null;
  stdout: string | Buffer;
  error?: unknown;
}

interface CodexVersionSpawnOptions {
  shell: false;
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8';
}

export interface CodexVersionProbeIo {
  spawnVersion?: (
    file: string,
    args: string[],
    options: CodexVersionSpawnOptions,
  ) => CodexVersionSpawnResult;
}

/** Observe the installed dialect without a shell and with hard time/output
 * bounds. Failure is absence of evidence, represented as null. */
export function observeCodexVersion(bin = 'codex', io: CodexVersionProbeIo = {}): string | null {
  const options: CodexVersionSpawnOptions = {
    shell: false,
    timeout: 2_000,
    maxBuffer: 4_096,
    encoding: 'utf8',
  };
  let result: CodexVersionSpawnResult;
  try {
    result = (io.spawnVersion ?? spawnSync)(bin, ['--version'], options);
  } catch {
    return null;
  }
  if (result.error !== undefined || result.status !== 0) return null;
  const output = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  return parseCodexVersionOutput(output);
}
