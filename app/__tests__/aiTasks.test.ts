import type { AiAgentStateRow } from '../src/db';
import {
  AI_QUICK_TASKS,
  AI_TASK_PROMPT_MAX,
  canStartAiTask,
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
