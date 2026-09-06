/**
 * REDUCE MOTION STOPS SILENCING THE CALL STATUS.
 *
 * Both call screens gated their status line's live region on Reduce Motion:
 *
 * // The pulse is a static state when Reduce Motion is on; the label
 * // still changes, so nothing is lost, only the animation.
 * accessibilityLiveRegion={reduceMotion ? 'none': 'polite'}
 *
 * THERE IS NO PULSE. `grep -i pulse` over app/src returned that comment and
 * nothing else, and `GroupCallScreen` imports no `Animated` at all — it read
 * `useReduceMotion()` for this one line. A live region is not motion: it is
 * how a person who is not looking at the screen learns the call went
 * Ringing → Connected → Reconnecting. Turning animation down turned that
 * information off, for the population most likely to have turned it down.
 *
 * FALSIFYING CASE, run at authoring time: restore the branch on either
 * screen and that screen's case here goes red with 'none'.
 */

// Reduce Motion ON for every case in this file — the setting whose effect is
// the whole subject. Mocked at the module boundary because the real hook
// resolves an AccessibilityInfo promise after mount, and a status line that
// is correct only until the promise lands is not a fix.
jest.mock('../src/useReduceMotion', () => ({ useReduceMotion: () => true }));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import type { GroupCallView } from '../src/call/group';
import { CallScreen, statusLabel } from '../src/screens/CallScreen';
import { GroupCallScreen, sessionStatusLabel } from '../src/screens/GroupCallScreen';
import { useReduceMotion } from '../src/useReduceMotion';

const T = 1_800_000_000_000;
const ME = '01J0000000000000000000000M';
const ANA = '01J0000000000000000000000A';

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

function frame(node: React.JSX.Element) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        {node}
      </SafeAreaProvider>,
    );
  });
  mounted.push(tree);
  return tree;
}

/** The one node whose text is the status word, wherever it sits. */
function statusNode(tree: ReactTestRenderer.ReactTestRenderer, text: string) {
  return tree.root.findAll(
    n => String(n.type) === 'Text' && [n.props.children].flat().join('') === text,
  )[0]!;
}

const CALL: CallState = {
  name: 'reconnecting',
  call: {
    cid: '01J0000000000000000000000C',
    peerId: ANA,
    direction: 'out',
    video: false,
    peerAudio: true,
    peerVideo: false,
    startedAt: T - 60_000,
    reportId: null,
    answeredAt: T - 65_000,
    connectedAt: T - 65_000,
    remoteOfferSdp: '',
    pendingIce: [],
    remoteReady: true,
  },
};

const VIEW: GroupCallView = {
  sid: '01J0000000000000000000000S',
  sessionKey: 1,
  starterId: ME,
  selfId: ME,
  roomId: null,
  roster: [ME, ANA],
  video: false,
  phase: 'live',
  legs: [{ peerId: ANA, phase: 'reconnecting', skipped: null, invitedAt: null }],
  startedAt: T - 60_000,
  connectedAt: T - 65_000,
  muted: false,
  speakerOn: false,
} as GroupCallView;

it('the mock is in force — the screens below really do see Reduce Motion on', () => {
  // Without this the two cases below would pass for the wrong reason the day
  // the mock's path or shape drifts.
  expect(useReduceMotion()).toBe(true);
});

it('the 1:1 call still announces its status with Reduce Motion on', () => {
  const tree = frame(
    <CallScreen
      state={CALL}
      peerName="Ana"
      muted={false}
      videoEnabled={false}
      speakerOn={false}
      onToggleMute={jest.fn()}
      onToggleVideo={jest.fn()}
      onFlipCamera={jest.fn()}
      onToggleSpeaker={jest.fn()}
      onHangup={jest.fn()}
      now={() => T}
    />,
  );
  const node = statusNode(tree, statusLabel(CALL));
  expect(node.props.accessibilityLiveRegion).toBe('polite');
});

it('the small-group call does too', () => {
  const tree = frame(
    <GroupCallScreen
      view={VIEW}
      nameFor={(id: string) => (id === ANA ? 'Ana' : null)}
      onToggleMute={jest.fn()}
      onToggleSpeaker={jest.fn()}
      onEnd={jest.fn()}
      now={() => T}
    />,
  );
  const node = statusNode(tree, sessionStatusLabel(VIEW));
  expect(node.props.accessibilityLiveRegion).toBe('polite');
});
