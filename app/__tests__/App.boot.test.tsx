/**
 * The boot frame: the brand mark arrives centred (solid bar, a beat, the
 * reply) over the bare paper field the launch storyboard put up. The mark
 * must be the animated BrandMark — a static one would leave the storyboard
 * hand-off dead — and the frame must still give VoiceOver the name.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { BrandMark } from '../src/ui/BrandMark';

test('the boot frame animates the mark and names it for VoiceOver', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<App />);
  });

  const mark = tree.root.findByType(BrandMark);
  expect(mark.props.animate).toBe(true);

  const named = tree.root.findAll(
    node =>
      node.props?.accessibilityLabel === 'Tacendum' &&
      node.props?.accessibilityRole === 'header',
  );
  expect(named.length).toBeGreaterThan(0);

  // Unmount inside act, as App.test.tsx does: the boot effect resolves
  // asynchronously and the arrival animation keeps timers.
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
