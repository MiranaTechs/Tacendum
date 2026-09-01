/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { callMetricDrain } from '../src/call/metrics';

test('renders correctly', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<App />);
  });
  // Unmount inside act: the landing cursor loops forever and the boot effect
  // resolves asynchronously. Left mounted, both tick on past the end of the
  // test and touch a torn-down environment, which fails the run even though
  // every assertion passed.
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('generic call startup does not activate metric upload before a real session is adopted', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
    await Promise.resolve();
  });
  expect(callMetricDrain.activeReal).toBe(false);
  await ReactTestRenderer.act(async () => tree.unmount());
});
