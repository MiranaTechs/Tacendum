import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  CallLogRow,
  callDuration,
  callGlyph,
  callLabel,
  type CallLogRowData,
} from '../src/components/CallLogRow';
import { IncomingCallScreen } from '../src/screens/IncomingCallScreen';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * Call log rows and the incoming-call screen.
 *
 * The rows are LOCAL — each side derives its own from its own state machine
 * and the two never exchange log data — so what is tested here is that the
 * distinctions a person relies on survive: missed is not declined, and a call
 * that never connected is not a zero-second call.
 */

const T = 1_800_000_000_000;

function row(over: Partial<CallLogRowData> = {}): CallLogRowData {
  return {
    cid: '01J0000000000000000000000A',
    direction: 'in',
    kind: 'audio',
    reason: 'hangup',
    connectedAt: T - 65_000,
    endedAt: T,
    missed: false,
    ...over,
  };
}

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

function mount(element: React.JSX.Element) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>,
    );
  });
  mounted.push(tree);
  const byLabel = (label: string) =>
    tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.type !== 'string')[0];
  return { tree, byLabel };
}

describe('what a call row says', () => {
  it('separates missed from declined — they are different events', () => {
    expect(callLabel(row({ missed: true, direction: 'in' }))).toBe('Missed audio call');
    expect(callLabel(row({ reason: 'decline' }))).toBe('Audio call declined');
  });

  it('says "no answer" for an outgoing call nobody picked up', () => {
    // From the caller's side "missed" would be wrong — they did not miss it.
    expect(callLabel(row({ missed: true, direction: 'out' }))).toBe('Audio call, no answer');
  });

  it('says "no answer" and "cancelled" from the CALLER\'s reason, which never carries missed', () => {
    // `missed` is only ever true on the receiving side, so an outgoing call
    // that rang out rendered as a plain "Outgoing audio call" with no
    // duration — the label above was unreachable from the caller's rows.
    expect(callLabel(row({ direction: 'out', reason: 'timeout', connectedAt: null }))).toBe(
      'Audio call, no answer',
    );
    expect(callLabel(row({ direction: 'out', reason: 'cancelled', connectedAt: null, kind: 'video' }))).toBe(
      'Video call, cancelled',
    );
    // A busy refusal on the callee's side is a missed call (the reducer marks
    // it so); the caller's own busy row keeps its word.
    expect(callLabel(row({ direction: 'in', reason: 'busy', missed: true, connectedAt: null }))).toBe(
      'Missed audio call',
    );
    expect(callLabel(row({ direction: 'out', reason: 'busy', connectedAt: null }))).toBe(
      'Audio call, busy',
    );
  });

  it('distinguishes a failure to connect from a call that happened', () => {
    expect(callLabel(row({ reason: 'failed_ice' }))).toBe('Audio call failed to connect');
    expect(callLabel(row({ reason: 'failed_media', kind: 'video' }))).toBe(
      'Video call failed to connect',
    );
  });

  it('names the kind', () => {
    expect(callLabel(row({ kind: 'video', missed: true }))).toBe('Missed video call');
  });
});

describe('duration', () => {
  it('is absent when the call never connected', () => {
    // Not "0:00" — that would assert a call took place.
    expect(callDuration(row({ connectedAt: null, missed: true }))).toBeNull();
  });

  it('measures from connection, not from dialling', () => {
    expect(callDuration(row({ connectedAt: T - 65_000, endedAt: T }))).toBe('1:05');
  });

  it('grows to hours', () => {
    expect(callDuration(row({ connectedAt: T - 3_725_000, endedAt: T }))).toBe('1:02:05');
  });
});

describe('the row does not rely on colour alone', () => {
  it('marks missed with a distinct glyph, not just a red tint', () => {
    // Someone who cannot distinguish the colours must still be able to see
    // that a call was missed.
    expect(callGlyph(row({ missed: true }))).not.toBe(callGlyph(row({ missed: false })));
  });

  it('points the arrow the way the call went', () => {
    expect(callGlyph(row({ direction: 'out' }))).toBe('↗');
    expect(callGlyph(row({ direction: 'in' }))).toBe('↙');
  });

  it('announces the duration and the redial affordance together', () => {
    const { byLabel } = mount(<CallLogRow row={row()} onRedial={jest.fn()} />);
    expect(byLabel('Incoming audio call, 1:05. Call back.')).toBeTruthy();
  });

  it('redials the same KIND the original call was', () => {
    const onRedial = jest.fn();
    const { byLabel } = mount(<CallLogRow row={row({ kind: 'video' })} onRedial={onRedial} />);
    ReactTestRenderer.act(() => {
      byLabel('Incoming video call, 1:05. Call back.').props.onPress();
    });
    expect(onRedial).toHaveBeenCalledWith('video');
  });
});

describe('answering a call in the foreground', () => {
  function incoming(over: Partial<React.ComponentProps<typeof IncomingCallScreen>> = {}) {
    const props = {
      peerName: 'Dana',
      withVideo: true,
      onAccept: jest.fn(),
      onAcceptAudioOnly: jest.fn(),
      onDecline: jest.fn(),
      ...over,
    };
    return { ...mount(<IncomingCallScreen {...props} />), props };
  }

  it('offers audio-only for a video invite', () => {
    // A video call at a bad moment is common; the alternative is decline and
    // call back, which costs both people a round trip.
    const { byLabel } = incoming({ withVideo: true });
    expect(byLabel('Answer without video')).toBeTruthy();
    expect(byLabel('Answer with video')).toBeTruthy();
  });

  it('does not offer it for an audio invite, where it would be the same button', () => {
    const { byLabel } = incoming({ withVideo: false });
    expect(byLabel('Answer without video')).toBeUndefined();
    expect(byLabel('Answer')).toBeTruthy();
  });

  it('answers audio when the camera is denied, and says so', () => {
    // Denial is a first-class state, not an error — and it is stated
    // rather than shown by a missing button.
    const { byLabel, props, tree } = incoming({ withVideo: true, cameraAvailable: false });
    expect(byLabel('Answer with video')).toBeUndefined();
    ReactTestRenderer.act(() => {
      byLabel('Answer').props.onPress();
    });
    expect(props.onAcceptAudioOnly).toHaveBeenCalled();
    const text = tree.root
      .findAll(n => typeof n.type === 'string' || true)
      .map(n => n.props.children)
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(text).toContain('Camera access is off');
  });

  it('declines', () => {
    const { byLabel, props } = incoming();
    ReactTestRenderer.act(() => {
      byLabel('Decline').props.onPress();
    });
    expect(props.onDecline).toHaveBeenCalled();
  });

  it('labels the whole screen for a screen reader', () => {
    const { byLabel } = incoming({ withVideo: true });
    expect(byLabel('Incoming video call from Dana')).toBeTruthy();
  });
});
