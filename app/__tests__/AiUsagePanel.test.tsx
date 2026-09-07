import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { AiWorkUsage } from '@tacendum/shared';
import { AiUsagePanel } from '../src/ui/AiUsagePanel';
import { AI_USAGE_CURRENT_MS } from '../src/aiUsage';

const NOW = 1_800_000_000_000;
const NORMAL_DIMENSIONS = {
  window: { width: 768, height: 1024, scale: 2, fontScale: 1 },
  screen: { width: 768, height: 1024, scale: 2, fontScale: 1 },
};

beforeEach(() => {
  Dimensions.set(NORMAL_DIMENSIONS);
});

function text(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children ?? ''),
    )
    .join('\n');
}

async function render(
  usage: AiWorkUsage[] | null,
  receivedAt: number | null,
  compact = false,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AiUsagePanel
        usage={usage}
        receivedAt={receivedAt}
        now={NOW}
        compact={compact}
      />,
    );
  });
  return tree;
}

test('missing usage says unavailable without inventing free or unlimited capacity', async () => {
  const tree = await render(null, null);
  const copy = text(tree);
  expect(copy).toContain('Usage unavailable');
  expect(copy).toContain('This agent has not reported usage or limits.');
  expect(copy).not.toMatch(/free|unlimited|0 turns/i);
  expect(
    tree.root.findByProps({ testID: 'ai-usage-empty' }).props
      .accessibilityLabel,
  ).toBe('Usage unavailable. This agent has not reported usage or limits.');
});

test('a current exhausted local limit is explicit in visible and spoken copy', async () => {
  const tree = await render(
    [
      {
        source: 'local-budget',
        unit: 'turns',
        period: 'hour',
        observedAt: NOW - 60_000,
        used: 5,
        remaining: 0,
        limit: 5,
      },
    ],
    NOW,
  );
  expect(text(tree)).toContain('Limit reached');
  const row = tree.root.findByProps({ testID: 'ai-usage-row-0' });
  expect(row.props.accessibilityLabel).toContain('5 turns used');
  expect(row.props.accessibilityLabel).toContain('0 turns left');
  expect(row.props.accessibilityLabel).toContain('Current');
  expect(row.props.accessibilityLabel).toContain('Limit reached');
});

test('the heading and limit badge can wrap at narrow widths and large type', async () => {
  Dimensions.set({
    window: { width: 768, height: 1024, scale: 2, fontScale: 3.1 },
    screen: { width: 768, height: 1024, scale: 2, fontScale: 3.1 },
  });
  const tree = await render(
    [
      {
        source: 'local-budget',
        unit: 'turns',
        period: 'hour',
        observedAt: NOW - 60_000,
        remaining: 0,
      },
    ],
    NOW,
  );
  const heading = tree.root
    .findAllByType(Text)
    .find(node => node.props.accessibilityRole === 'header');

  expect(heading).toBeDefined();
  expect(StyleSheet.flatten(heading?.props.style)).toMatchObject({
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
  });
  expect(
    StyleSheet.flatten(
      tree.root.findByProps({ testID: 'ai-usage-heading' }).props.style,
    ),
  ).toMatchObject({
    flexDirection: 'column',
    alignItems: 'stretch',
  });
  expect(
    StyleSheet.flatten(
      tree.root.findByProps({ testID: 'ai-usage-main-0' }).props.style,
    ),
  ).toMatchObject({
    flexDirection: 'column',
    alignItems: 'stretch',
  });
  expect(
    StyleSheet.flatten(
      tree.root.findByProps({ testID: 'ai-usage-meta-0' }).props.style,
    ),
  ).toMatchObject({
    flexDirection: 'column',
    alignItems: 'stretch',
  });
});

test('ordinary text size keeps the compact side-by-side ledger', async () => {
  const tree = await render(
    [
      {
        source: 'provider-reported',
        unit: 'tokens',
        period: 'session',
        observedAt: NOW,
        used: 1200,
      },
    ],
    NOW,
  );

  expect(
    StyleSheet.flatten(
      tree.root.findByProps({ testID: 'ai-usage-heading' }).props.style,
    ),
  ).toMatchObject({ flexDirection: 'row' });
  expect(
    StyleSheet.flatten(
      tree.root.findByProps({ testID: 'ai-usage-main-0' }).props.style,
    ),
  ).toMatchObject({ flexDirection: 'row' });
});

test('stale evidence stays visible but never presents its limit as current', async () => {
  const tree = await render(
    [
      {
        source: 'local-budget',
        unit: 'turns',
        period: 'hour',
        observedAt: NOW - AI_USAGE_CURRENT_MS - 1,
        remaining: 0,
      },
    ],
    NOW,
    true,
  );
  const copy = text(tree);
  expect(copy).toContain('Stale');
  expect(copy).not.toContain('Limit reached');
  expect(
    tree.root.findByProps({ testID: 'ai-usage-panel' }).props
      .accessibilityLabel,
  ).toContain('1 reported usage item');
});
