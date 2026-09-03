/**
 * The delivery tick.
 *
 * `pending` used to draw NOTHING, so a message still in the outbox was
 * indistinguishable from one the server had routed but not yet ticked —
 * the same empty space for "hasn't left the phone" and "left, no word
 * back". A queued message now draws a small hollow ring in the muted ink:
 * still not a tick (a tick before the bytes left would be the one lie this
 * indicator must not tell), but no longer silence.
 *
 * The four states, in one place: ring, one tick, two ticks, two ticks in
 * the read accent. VoiceOver never hears the shape — the row's label
 * carries the word. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import Svg, { Circle, Path } from 'react-native-svg';
import { TickGlyph, tickLabel, type TickStatus } from '../src/ui/TickGlyph';
import { themeTokens } from '../src/theme';

const t = themeTokens();
const MUTED = t.color.inkMuted;
const READ = t.color.pine;

function draw(status: TickStatus): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <TickGlyph status={status} color={MUTED} readColor={READ} />,
    );
  });
  return tree;
}

describe('TickGlyph', () => {
  test('pending draws a hollow ring in the muted ink — never a tick', () => {
    const tree = draw('pending');
    const rings = tree.root.findAllByType(Circle);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.props.fill).toBe('none');
    expect(rings[0]!.props.stroke).toBe(MUTED);
    expect(tree.root.findAllByType(Path)).toHaveLength(0);
    // Not nothing: the glyph is on glass.
    expect(tree.root.findAllByType(Svg)).toHaveLength(1);
  });

  test('sent is one tick, delivered two, both in the muted ink', () => {
    const sent = draw('sent');
    expect(sent.root.findAllByType(Path)).toHaveLength(1);
    expect(sent.root.findAllByType(Circle)).toHaveLength(0);
    expect(sent.root.findAllByType(Path)[0]!.props.stroke).toBe(MUTED);

    const delivered = draw('delivered');
    const ticks = delivered.root.findAllByType(Path);
    expect(ticks).toHaveLength(2);
    expect(ticks.map(p => p.props.stroke)).toEqual([MUTED, MUTED]);
  });

  test('read is the same two ticks in the read accent — the colour is the claim', () => {
    const ticks = draw('read').root.findAllByType(Path);
    expect(ticks).toHaveLength(2);
    expect(ticks.map(p => p.props.stroke)).toEqual([READ, READ]);
  });

  test('every state hides its shape from VoiceOver; the words come from tickLabel', () => {
    for (const status of ['pending', 'sent', 'delivered', 'read'] as const) {
      const svg = draw(status).root.findByType(Svg);
      expect(svg.props.accessibilityElementsHidden).toBe(true);
      expect(svg.props.importantForAccessibility).toBe('no-hide-descendants');
    }
    expect(tickLabel('pending')).toBe('Sending');
    expect(tickLabel('read')).toBe('Read');
  });
});
