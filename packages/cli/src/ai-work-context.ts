import { execFileSync } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import {
  AI_WORK_BRANCH_MAX,
  AI_WORK_REPOSITORY_MAX,
  AiWorkContextSchema,
  type AiWorkContext,
} from '@tacendum/shared';

const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_BUFFER = 4_096;

// `git rev-parse --local-env-vars` documents the repository-local variables
// a hook must clear before inspecting a different working tree. The discovery
// and namespace additions below can also change which source the reads name.
const GIT_SOURCE_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

export interface AiWorkContextIo {
  git(args: string[], options: { cwd: string; timeout: number; maxBuffer: number }): string;
}

const productionIo: AiWorkContextIo = {
  git(args, options) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      const upper = key.toUpperCase();
      if (
        GIT_SOURCE_ENV.has(upper) ||
        upper.startsWith('GIT_CONFIG_KEY_') ||
        upper.startsWith('GIT_CONFIG_VALUE_')
      ) {
        delete env[key];
      }
    }
    return execFileSync('git', args, {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      shell: false,
    });
  },
};

// These ranges deliberately reject control characters in untrusted Git output.
// eslint-disable-next-line no-control-regex
const unsafeDisplayCodePoint = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function validCwd(cwd: unknown): cwd is string {
  return (
    typeof cwd === 'string' &&
    cwd.length > 0 &&
    isAbsolute(cwd) &&
    Buffer.byteLength(cwd, 'utf8') <= GIT_MAX_BUFFER &&
    !cwd.includes('\0')
  );
}

/** Accept one bounded stdout line. Git's final line ending is framing; any
 * other control/bidi content is unsafe to place in encrypted display data. */
function gitLine(output: unknown): string | null {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > GIT_MAX_BUFFER) {
    return null;
  }
  const value = output.endsWith('\r\n')
    ? output.slice(0, -2)
    : output.endsWith('\n')
      ? output.slice(0, -1)
      : output;
  if (value.length === 0 || unsafeDisplayCodePoint.test(value)) return null;
  return value;
}

function displayField(value: string, max: number): string | undefined {
  const sanitized = value.trim();
  if (sanitized.length === 0 || sanitized.length > max || unsafeDisplayCodePoint.test(sanitized)) {
    return undefined;
  }
  return sanitized;
}

function unavailable(): AiWorkContext {
  return { availability: 'unavailable' };
}

/** Capture bounded, source-backed repository context for an encrypted work
 * fact. The remote URL, raw path, git status, stderr, and exception text are
 * never returned. A detached HEAD can still yield repository evidence. */
export function captureAiWorkContext(
  cwd: string,
  capturedAt: number,
  io: AiWorkContextIo = productionIo,
): AiWorkContext {
  if (!validCwd(cwd) || !Number.isSafeInteger(capturedAt) || capturedAt < 0) {
    return unavailable();
  }

  let root: string | null;
  try {
    root = gitLine(
      io.git(['rev-parse', '--show-toplevel'], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      }),
    );
  } catch {
    return unavailable();
  }
  if (root === null || !isAbsolute(root)) return unavailable();

  const repository = displayField(basename(root), AI_WORK_REPOSITORY_MAX);
  let branch: string | undefined;
  try {
    const observed = gitLine(
      io.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      }),
    );
    if (observed !== null) {
      branch = displayField(observed, AI_WORK_BRANCH_MAX);
    }
  } catch {
    // Detached HEAD and unavailable branch evidence are both ordinary.
  }

  if (repository === undefined && branch === undefined) return unavailable();
  const parsed = AiWorkContextSchema.safeParse({
    availability: 'captured',
    capturedAt,
    ...(repository === undefined ? {} : { repository }),
    ...(branch === undefined ? {} : { branch }),
  });
  return parsed.success ? parsed.data : unavailable();
}
