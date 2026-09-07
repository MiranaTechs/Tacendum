import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AI_WORK_BRANCH_MAX, AI_WORK_REPOSITORY_MAX } from '@tacendum/shared';
import { captureAiWorkContext, type AiWorkContextIo } from '../src/ai-work-context.js';

const CAPTURED_AT = 1_800_000_000_000;

function scriptedGit(responses: Array<string | Error>): AiWorkContextIo['git'] {
  return vi.fn(() => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error('unexpected git call');
    return response;
  });
}

describe('bounded AI work context capture', () => {
  it('captures only the repository basename and branch with fixed bounded git calls', () => {
    const git = scriptedGit(['/Users/alice/Private Work/Tacendum\n', 'feature/chat-review\n']);

    expect(
      captureAiWorkContext('/Users/alice/Private Work/Tacendum/app', CAPTURED_AT, {
        git,
      }),
    ).toEqual({
      availability: 'captured',
      capturedAt: CAPTURED_AT,
      repository: 'Tacendum',
      branch: 'feature/chat-review',
    });
    expect(git).toHaveBeenNthCalledWith(1, ['rev-parse', '--show-toplevel'], {
      cwd: '/Users/alice/Private Work/Tacendum/app',
      timeout: 2_000,
      maxBuffer: 4_096,
    });
    expect(git).toHaveBeenNthCalledWith(2, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: '/Users/alice/Private Work/Tacendum',
      timeout: 2_000,
      maxBuffer: 4_096,
    });
    expect(git).toHaveBeenCalledTimes(2);
  });

  it('keeps repository evidence when detached HEAD has no branch', () => {
    const git = scriptedGit(['/private/repo\n', new Error('detached')]);
    expect(captureAiWorkContext('/private/repo', CAPTURED_AT, { git })).toEqual({
      availability: 'captured',
      capturedAt: CAPTURED_AT,
      repository: 'repo',
    });
  });

  it('returns unavailable when cwd, timestamp, or repository discovery is invalid', () => {
    const git = scriptedGit(['/private/repo\n']);
    expect(captureAiWorkContext('', CAPTURED_AT, { git })).toEqual({
      availability: 'unavailable',
    });
    expect(captureAiWorkContext('/private/repo', -1, { git })).toEqual({
      availability: 'unavailable',
    });
    expect(captureAiWorkContext('relative/repo', CAPTURED_AT, { git })).toEqual({
      availability: 'unavailable',
    });
    expect(git).not.toHaveBeenCalled();

    for (const firstResponse of [
      new Error('not a repository'),
      'relative/repo\n',
      '/private/repo\nsecond line\n',
      '/private/unsafe\u0000repo\n',
      'x'.repeat(4_097),
    ]) {
      const failingGit = scriptedGit([firstResponse]);
      expect(
        captureAiWorkContext('/private/repo', CAPTURED_AT, {
          git: failingGit,
        }),
      ).toEqual({ availability: 'unavailable' });
      expect(failingGit).toHaveBeenCalledTimes(1);
    }
  });

  it('drops over-cap or unsafe fields while preserving independent usable evidence', () => {
    const longRepository = 'r'.repeat(AI_WORK_REPOSITORY_MAX + 1);
    const longBranch = 'b'.repeat(AI_WORK_BRANCH_MAX + 1);

    expect(
      captureAiWorkContext('/work', CAPTURED_AT, {
        git: scriptedGit([`/private/${longRepository}\n`, 'main\n']),
      }),
    ).toEqual({
      availability: 'captured',
      capturedAt: CAPTURED_AT,
      branch: 'main',
    });
    expect(
      captureAiWorkContext('/work', CAPTURED_AT, {
        git: scriptedGit(['/private/repo\n', `${longBranch}\n`]),
      }),
    ).toEqual({
      availability: 'captured',
      capturedAt: CAPTURED_AT,
      repository: 'repo',
    });
    expect(
      captureAiWorkContext('/work', CAPTURED_AT, {
        git: scriptedGit([`/private/${longRepository}\n`, `${longBranch}\n`]),
      }),
    ).toEqual({ availability: 'unavailable' });
    expect(
      captureAiWorkContext('/work', CAPTURED_AT, {
        git: scriptedGit(['/private/repo\n', 'feature/clean\u001b[31m\n']),
      }),
    ).toEqual({
      availability: 'captured',
      capturedAt: CAPTURED_AT,
      repository: 'repo',
    });
  });

  it('does not expose raw paths or exception details on failure', () => {
    const secretPath = '/Users/alice/customer-secret/visible-name';
    const context = captureAiWorkContext(secretPath, CAPTURED_AT, {
      git: scriptedGit([new Error('credential helper failed for private-user')]),
    });

    expect(context).toEqual({ availability: 'unavailable' });
    expect(JSON.stringify(context)).not.toContain('alice');
    expect(JSON.stringify(context)).not.toContain('credential');
  });

  it('binds production discovery to absolute cwd despite a foreign hook Git environment', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'tacendum-ai-context-'));
    const target = join(scratch, 'target repo');
    const foreign = join(scratch, 'foreign repo');
    const cleanEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    };
    const init = (directory: string, branch: string) => {
      mkdirSync(directory);
      execFileSync('git', ['init', '--quiet', directory], {
        env: cleanEnv,
        stdio: 'ignore',
      });
      execFileSync('git', ['-C', directory, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
        env: cleanEnv,
        stdio: 'ignore',
      });
    };
    init(target, 'target-branch');
    init(foreign, 'foreign-branch');

    const overridden = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_PREFIX'] as const;
    const previous = Object.fromEntries(overridden.map((key) => [key, process.env[key]]));
    process.env.GIT_DIR = join(foreign, '.git');
    process.env.GIT_WORK_TREE = foreign;
    process.env.GIT_COMMON_DIR = join(foreign, '.git');
    process.env.GIT_PREFIX = 'foreign-prefix/';

    try {
      expect(captureAiWorkContext(target, CAPTURED_AT)).toEqual({
        availability: 'captured',
        capturedAt: CAPTURED_AT,
        repository: 'target repo',
        branch: 'target-branch',
      });
    } finally {
      for (const key of overridden) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
