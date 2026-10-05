/**
 * THE keyboard mechanism: keyboard-frame ∩ pane,
 * one truth for every screen that lifts for typing.
 *
 * The pure function carries the geometry, so the geometry is pinned as a
 * table: a DOCKED keyboard insets the pane by exactly the strip it covers
 * (the arithmetic the thread has always shipped — compact is sacred), and a
 * FLOATING or undocked frame insets nothing, because glass below the frame
 * means it hovers over content — the `height - screenY` subtraction read
 * that gap as a keyboard inset, which is the probe row's
 * construction-level defect on an iPad's floating palette.
 *
 * The hook half is pinned through a probe component: the same docked/
 * floating verdicts, live, through the real Keyboard listener seam — and
 * through the two screens that traded their KeyboardAvoidingView for this
 * mechanism (Profile, StartChat), whose roots must lift by the inset. KAV
 * itself cannot work here: these screens render inside RouteTransition's
 * transformed Animated.View, which defeats KAV's own-frame measurement.
 */

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { ProfileRow } from '../src/db';
import { keyboardPaneInset, useKeyboardInset } from '../src/keyboardInset';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { StartChatScreen } from '../src/screens/StartChatScreen';
import { PaneWidthProvider } from '../src/windowClass';

// The live module object, not a wildcard import copy — the spy must land on
// the binding the hook calls (the ChatThread.blocking discipline).
const RN: typeof import('react-native') = require('react-native');

// ---------------------------------------------------------------------------
// The pure geometry, as a table.
// ---------------------------------------------------------------------------

describe('keyboardPaneInset: keyboard-frame ∩ pane', () => {
  // An iPad-portrait-shaped pane; the numbers are arbitrary but realistic.
  const pane = { width: 1024, height: 1366 };

  test('a docked keyboard insets by exactly the strip it covers', () => {
    const frame = { screenX: 0, screenY: 1046, width: 1024, height: 320 };
    expect(keyboardPaneInset(frame, pane, 0)).toBe(320);
  });

  test('the safe-area bottom comes off the docked inset', () => {
    // The SafeAreaView already reserved that strip; padding by the full
    // keyboard height lifts a composer a home-indicator's worth too far.
    const frame = { screenX: 0, screenY: 1046, width: 1024, height: 320 };
    expect(keyboardPaneInset(frame, pane, 34)).toBe(286);
  });

  test('a partial frame answers the phone arithmetic — compact is sacred', () => {
    // Older harnesses (and defensive paths) carry only screenY. The docked
    // defaults must resolve to height - screenY, the thread's shipped math.
    expect(keyboardPaneInset({ screenY: 444 }, { width: 390, height: 844 }, 0)).toBe(400);
  });

  test('a FLOATING palette insets nothing: glass below the frame', () => {
    // The probe row's construction-level fact: a floating palette's frame
    // makes height - screenY measure the gap BELOW the palette. Here that
    // subtraction says 566; the intersection math says the pane holds still.
    const palette = { screenX: 600, screenY: 800, width: 320, height: 260 };
    expect(keyboardPaneInset(palette, pane, 0)).toBe(0);
  });

  test('an undocked (split-style) keyboard riding high insets nothing', () => {
    const undocked = { screenX: 0, screenY: 700, width: 1024, height: 271 };
    expect(keyboardPaneInset(undocked, pane, 0)).toBe(0);
  });

  test('a half-width frame at the bottom does not count as docked', () => {
    // One split half pinned to the bottom edge still leaves most of the
    // pane's width uncovered — content under the open half must not lift.
    const half = { screenX: 0, screenY: 1046, width: 512, height: 320 };
    expect(keyboardPaneInset(half, pane, 0)).toBe(0);
  });

  test('a hidden keyboard (frame at or past the bottom) insets nothing', () => {
    expect(
      keyboardPaneInset({ screenX: 0, screenY: 1366, width: 1024, height: 320 }, pane, 0),
    ).toBe(0);
    // The partial-frame shape of the same event — and never a negative pad.
    expect(keyboardPaneInset({ screenY: 1400 }, pane, 0)).toBe(0);
  });

  test('the ∩ clips to the pane: a window-wide keyboard insets a narrow pane', () => {
    // The wide shell's list pane: the docked keyboard spans the whole
    // window, so its clipped intersection spans the pane — same inset.
    const frame = { screenX: 0, screenY: 1046, width: 2560, height: 320 };
    expect(keyboardPaneInset(frame, { width: 360, height: 1366 }, 0)).toBe(320);
  });

  test('the ∩ clips to the pane: a palette beside the pane misses it', () => {
    const palette = { screenX: 600, screenY: 900, width: 320, height: 466 };
    expect(keyboardPaneInset(palette, { width: 360, height: 1366 }, 0)).toBe(0);
  });

  test('the inset clamps at zero and a missing frame is no frame', () => {
    // A sliver under the home indicator must not go negative...
    const sliver = { screenX: 0, screenY: 1360, width: 1024, height: 6 };
    expect(keyboardPaneInset(sliver, pane, 34)).toBe(0);
    // ...and an event with no coordinates covers nothing.
    expect(keyboardPaneInset(undefined, pane, 0)).toBe(0);
    expect(keyboardPaneInset(null, pane, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The hook, live, through the real Keyboard listener seam.
// ---------------------------------------------------------------------------

/** Every registered handler for the event, invoked — the thread tests' emit. */
function emit(event: string, payload: unknown) {
  const calls = (RN.Keyboard.addListener as unknown as jest.Mock).mock.calls;
  for (const [name, handler] of calls) {
    if (name === event) {
      ReactTestRenderer.act(() => handler(payload));
    }
  }
}

/** A docked-keyboard frame for the current test window. */
function dockedFrame(cover: number) {
  const { width, height } = RN.Dimensions.get('window');
  return {
    endCoordinates: {
      screenX: 0,
      screenY: height - cover,
      width,
      height: cover,
    },
  };
}

function Probe() {
  return <Text testID="probe-inset">{String(useKeyboardInset())}</Text>;
}

function probeValue(tree: ReactTestRenderer.ReactTestRenderer): string {
  const node = tree.root.findAll(
    n => n.props.testID === 'probe-inset' && typeof n.type === 'string',
  )[0];
  return String(node.props.children);
}

/** The root View's paddingBottom — the lift the mechanism applies. */
function lift(tree: ReactTestRenderer.ReactTestRenderer): number | undefined {
  for (const node of tree.root.findAll(
    n => typeof n.type === 'string' && Array.isArray(n.props?.style),
  )) {
    for (const entry of node.props.style as unknown[]) {
      if (entry && typeof entry === 'object' && 'paddingBottom' in entry) {
        return (entry as { paddingBottom: number }).paddingBottom;
      }
    }
  }
  return undefined;
}

async function render(
  element: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useKeyboardInset', () => {
  test('answers the docked strip, and zero again on hide', async () => {
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await render(<Probe />);

    expect(probeValue(tree)).toBe('0');
    emit('keyboardWillChangeFrame', dockedFrame(336));
    expect(probeValue(tree)).toBe('336');
    emit('keyboardWillHide', undefined);
    expect(probeValue(tree)).toBe('0');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a floating palette moves nothing, even mid-pane', async () => {
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await render(<Probe />);
    const { height } = RN.Dimensions.get('window');

    emit('keyboardWillChangeFrame', {
      endCoordinates: {
        screenX: 40,
        screenY: height - 400,
        width: 320,
        height: 260,
      },
    });
    expect(probeValue(tree)).toBe('0');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('inside a claimed pane the docked keyboard still insets', async () => {
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await render(
      <PaneWidthProvider width={360}>
        <Probe />
      </PaneWidthProvider>,
    );

    emit('keyboardWillChangeFrame', dockedFrame(336));
    expect(probeValue(tree)).toBe('336');

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

// ---------------------------------------------------------------------------
// The two screens that traded KAV for the mechanism.
// ---------------------------------------------------------------------------

const PROFILE: ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Ana',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

describe('the screens that replaced KeyboardAvoidingView lift by the inset', () => {
  test('ProfileScreen: root paddingBottom follows the docked keyboard', async () => {
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await render(
      <ProfileScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onProfileChanged={jest.fn()}
        onOpenSettings={jest.fn()}
        onSignedOut={jest.fn()}
      />,
    );

    expect(lift(tree)).toBe(0);
    emit('keyboardWillChangeFrame', dockedFrame(300));
    expect(lift(tree)).toBe(300);
    emit('keyboardWillHide', undefined);
    expect(lift(tree)).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('StartChatScreen: root paddingBottom follows the docked keyboard', async () => {
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await render(
      <StartChatScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenChat={jest.fn()}
        // The find door's prop retired with build 33 (find runs inline).
        onOpenAccountEmail={jest.fn()}
      />,
    );

    expect(lift(tree)).toBe(0);
    emit('keyboardWillChangeFrame', dockedFrame(300));
    expect(lift(tree)).toBe(300);
    emit('keyboardWillHide', undefined);
    expect(lift(tree)).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
