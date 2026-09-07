import React from 'react';
import { View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { useVideoReadiness } from '../src/ui/videoReadiness';

type Readiness = ReturnType<typeof useVideoReadiness>;
type FrameEvent = Parameters<Readiness['onFrameReady']>[0];
type Props = { cid: string; track: string; expected: boolean };

function frame(surfaceId: string, generation: number, ready: boolean): FrameEvent {
  return { nativeEvent: { surfaceId, generation, ready } } as FrameEvent;
}

function mount(over: Partial<Props> = {}) {
  let props: Props = { cid: 'call-a', track: 'remote', expected: true, ...over };
  let latest!: Readiness;
  let tree!: ReactTestRenderer.ReactTestRenderer;
  function Probe(current: Props) {
    latest = useVideoReadiness(current.cid, current.track, current.expected);
    return <View testID="readiness" accessibilityState={{ busy: !latest.ready }} />;
  }
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Probe {...props} />);
  });
  return {
    current: () => latest,
    update(next: Partial<Props>) {
      props = { ...props, ...next };
      ReactTestRenderer.act(() => tree.update(<Probe {...props} />));
    },
    deliver(generation: number, ready: boolean, surfaceId = latest.surfaceId) {
      ReactTestRenderer.act(() => latest.onFrameReady(frame(surfaceId, generation, ready)));
    },
    unmount() {
      ReactTestRenderer.act(() => tree.unmount());
    },
  };
}

describe('video renderer readiness lifetimes', () => {
  it('waits for a frame, accepts the reset then ready pair, and keeps the same token on ordinary renders', () => {
    const view = mount();
    const token = view.current().surfaceId;
    expect(view.current().ready).toBe(false);
    view.deliver(0, false);
    expect(view.current().ready).toBe(false);
    view.deliver(0, true);
    expect(view.current().ready).toBe(true);
    view.update({});
    expect(view.current().surfaceId).toBe(token);
    expect(view.current().ready).toBe(true);
    view.unmount();
  });

  it.each([
    ['call', { cid: 'call-b' }],
    ['track role', { track: 'local' }],
  ] as const)('requires new evidence when the %s changes and refuses queued old callbacks', (_, change) => {
    const view = mount();
    const previous = view.current();
    view.deliver(50, true);
    view.update(change);
    expect(view.current().surfaceId).not.toBe(previous.surfaceId);
    expect(view.current().ready).toBe(false);
    ReactTestRenderer.act(() => {
      previous.onFrameReady(frame(previous.surfaceId, 51, true));
    });
    view.deliver(52, true, previous.surfaceId);
    expect(view.current().ready).toBe(false);
    // Generations belong to one surface; the replacement starts from zero.
    view.deliver(0, true);
    expect(view.current().ready).toBe(true);
    view.unmount();
  });

  it('camera-off or reconnect invalidates readiness immediately and reconnecting requires a fresh token and frame', () => {
    const view = mount();
    const connected = view.current();
    view.deliver(4, true);
    expect(view.current().ready).toBe(true);
    view.update({ expected: false });
    const unavailable = view.current();
    expect(unavailable.surfaceId).not.toBe(connected.surfaceId);
    expect(unavailable.ready).toBe(false);
    ReactTestRenderer.act(() => {
      connected.onFrameReady(frame(connected.surfaceId, 5, true));
    });
    view.deliver(6, true);
    expect(view.current().ready).toBe(false);

    view.update({ expected: true });
    expect(view.current().surfaceId).not.toBe(connected.surfaceId);
    expect(view.current().surfaceId).not.toBe(unavailable.surfaceId);
    expect(view.current().ready).toBe(false);
    view.deliver(7, true, connected.surfaceId);
    ReactTestRenderer.act(() => {
      unavailable.onFrameReady(frame(unavailable.surfaceId, 7, true));
    });
    expect(view.current().ready).toBe(false);
    view.deliver(0, true);
    expect(view.current().ready).toBe(true);
    view.unmount();
  });

  it('orders track replacement resets and frames within one surface', () => {
    const view = mount();
    const token = view.current().surfaceId;
    view.deliver(2, true);
    expect(view.current().ready).toBe(true);
    view.deliver(3, false);
    expect(view.current().ready).toBe(false);
    view.deliver(2, true);
    expect(view.current().ready).toBe(false);
    view.deliver(3, true);
    expect(view.current().ready).toBe(true);
    view.deliver(2, false);
    expect(view.current().ready).toBe(true);
    expect(view.current().surfaceId).toBe(token);
    view.deliver(4, false);
    expect(view.current().ready).toBe(false);
    view.unmount();
  });

  it('does not accept invalid generations, malformed ready values, or foreign surfaces', () => {
    const view = mount();
    for (const generation of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      view.deliver(generation, true);
      expect(view.current().ready).toBe(false);
    }
    view.deliver(0, true, 'unrelated-surface');
    view.deliver(0, 'true' as unknown as boolean);
    expect(view.current().ready).toBe(false);
    view.deliver(0, true);
    expect(view.current().ready).toBe(true);
    view.unmount();
  });

  it('gives simultaneous full-screen and preview instances independent readiness', () => {
    const full = mount();
    const preview = mount();
    expect(full.current().surfaceId).not.toBe(preview.current().surfaceId);
    full.deliver(1, true);
    preview.deliver(1, true, full.current().surfaceId);
    expect(full.current().ready).toBe(true);
    expect(preview.current().ready).toBe(false);
    preview.deliver(1, true);
    expect(preview.current().ready).toBe(true);
    full.unmount();
    preview.unmount();
  });

  it('does not reuse a token when the same call and role unmount and remount', () => {
    const first = mount();
    const old = first.current();
    first.deliver(8, true);
    first.unmount();
    const next = mount();
    expect(next.current().surfaceId).not.toBe(old.surfaceId);
    ReactTestRenderer.act(() => {
      old.onFrameReady(frame(old.surfaceId, 9, true));
    });
    next.deliver(9, true, old.surfaceId);
    expect(next.current().ready).toBe(false);
    next.deliver(0, true);
    expect(next.current().ready).toBe(true);
    next.unmount();
  });
});
