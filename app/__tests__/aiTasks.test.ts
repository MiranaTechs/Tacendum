import type { AiAgentStateRow } from '../src/db';
import {
  AI_QUICK_TASKS,
  AI_SAVED_TASK_MAX,
  AI_TASK_NAME_MAX,
  AI_TASK_PROMPT_MAX,
  canStartAiTask,
  normalizeAiTaskTemplate,
  sameAiTaskTarget,
} from '../src/aiTasks';

const STATE: AiAgentStateRow = {
  peerId: 'agent-a',
  provider: 'codex',
  project: 'Tacendum',
  projectReceivedAt: 100,
  capabilities: { notifications: true, approvals: true, tasks: true },
  capabilitiesReceivedAt: 100,
  context: null,
  contextReceivedAt: null,
  usage: null,
  usageReceivedAt: null,
  lastSourceAt: 100,
  lastDisplayAt: 100,
  lastTimeTrusted: true,
  lastReceivedAt: 100,
  displayName: 'Codex',
  localName: null,
};

test('offers three bounded review prompts that do not ask to change files', () => {
  expect(AI_QUICK_TASKS.map(task => task.label)).toEqual([
    'Review changes',
    'Explain a failing check',
    'Summarize changes',
  ]);
  for (const task of AI_QUICK_TASKS) {
    expect(task.prompt.length).toBeLessThanOrEqual(AI_TASK_PROMPT_MAX);
    expect(task.prompt).toMatch(/Do not change files\./);
  }
});

test('saved request input is trimmed and bounded before local storage', () => {
  expect(normalizeAiTaskTemplate('  Release review  ', '  Check A.\nCheck B.  ')).toEqual({
    name: 'Release review',
    prompt: 'Check A.\nCheck B.',
  });
  expect(
    normalizeAiTaskTemplate('n'.repeat(AI_TASK_NAME_MAX), 'p'.repeat(AI_TASK_PROMPT_MAX)),
  ).toEqual({
    name: 'n'.repeat(AI_TASK_NAME_MAX),
    prompt: 'p'.repeat(AI_TASK_PROMPT_MAX),
  });
  expect(normalizeAiTaskTemplate('   ', 'prompt')).toBeNull();
  expect(normalizeAiTaskTemplate('name', '\n\t')).toBeNull();
  expect(
    normalizeAiTaskTemplate('n'.repeat(AI_TASK_NAME_MAX + 1), 'prompt'),
  ).toBeNull();
  expect(
    normalizeAiTaskTemplate('name', 'p'.repeat(AI_TASK_PROMPT_MAX + 1)),
  ).toBeNull();
  expect(AI_SAVED_TASK_MAX).toBeGreaterThan(AI_QUICK_TASKS.length);
});

test('tasks require an explicit source-backed task capability', () => {
  expect(canStartAiTask(STATE)).toBe(true);
  expect(canStartAiTask(null)).toBe(false);
  expect(
    canStartAiTask({
      ...STATE,
      capabilities: { notifications: true, approvals: true, tasks: false },
    }),
  ).toBe(false);
  expect(canStartAiTask({ ...STATE, capabilities: null })).toBe(false);
});

test('confirmation revalidates peer, provider, project and task capability', () => {
  expect(sameAiTaskTarget(STATE, { ...STATE })).toBe(true);
  expect(sameAiTaskTarget(STATE, { ...STATE, peerId: 'agent-b' })).toBe(false);
  expect(sameAiTaskTarget(STATE, { ...STATE, provider: 'claude' })).toBe(false);
  expect(sameAiTaskTarget(STATE, { ...STATE, project: 'Other' })).toBe(false);
  expect(
    sameAiTaskTarget(STATE, {
      ...STATE,
      capabilities: { notifications: true, approvals: true, tasks: false },
    }),
  ).toBe(false);
});

test('confirmation revalidates the reported repository, branch and context status', () => {
  const capturedContext = {
    availability: 'captured',
    capturedAt: 90,
    repository: 'example/mobile',
    branch: 'feature/saved-requests',
    resultSummary: 'Old result',
  } as const;
  const reviewed: AiAgentStateRow = {
    ...STATE,
    context: capturedContext,
  };

  expect(
    sameAiTaskTarget(reviewed, {
      ...reviewed,
      context: {
        ...capturedContext,
        capturedAt: 99,
        resultSummary: 'New result',
      },
    }),
  ).toBe(true);
  expect(
    sameAiTaskTarget(reviewed, {
      ...reviewed,
      context: { ...capturedContext, branch: 'main' },
    }),
  ).toBe(false);
  expect(
    sameAiTaskTarget(reviewed, {
      ...reviewed,
      context: { ...capturedContext, repository: 'natln/Other' },
    }),
  ).toBe(false);
  expect(
    sameAiTaskTarget(reviewed, {
      ...reviewed,
      context: { ...capturedContext, availability: 'stale' },
    }),
  ).toBe(false);
  expect(sameAiTaskTarget(reviewed, { ...reviewed, context: null })).toBe(false);

  const resultOnly: AiAgentStateRow = {
    ...reviewed,
    context: {
      availability: 'captured',
      capturedAt: 90,
      resultSummary: 'No repository target was reported.',
    },
  };
  expect(
    sameAiTaskTarget(resultOnly, {
      ...resultOnly,
      context: {
        availability: 'captured',
        capturedAt: 99,
        resultSummary: 'The result changed without adding a target.',
      },
    }),
  ).toBe(true);
});
