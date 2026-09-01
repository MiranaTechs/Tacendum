/**
 * THE SPEAKER TOGGLE, PER IDIOM.
 *
 * iPads have no earpiece. `overrideOutputAudioPort(.none)` lands on the
 * loudspeaker, `.defaultToSpeaker` changes nothing, and a control that says
 * "Speaker off" over audio still playing out loud is a route-vs-UI lie — the
 * exact class the lit-button rule exists to prevent (`call/index.ts`,
 * `CallKitCenter.swift`: the button reflects the route the device took). So
 * on the pad idiom the 1:1 and group call UIs render NO speaker control at
 * all: no control, no claim.
 *
 * Three things this suite holds, as behavior rather than narration:
 *
 *  1. THE RESOLUTION TABLE. `EARPIECE_KNOWN_ABSENT` is true exactly on the
 *     iPad idiom — idiom-driven, never window-driven. Android answers false
 *     on phone AND tablet on purpose: no JS API answers the earpiece
 *     question there, some tablets ship one, and the telecom-less class
 *     fails closed at the call button under its own guard — that lane owns
 *     the Android answer, on hardware evidence.
 *
 *  2. THE PAD IDIOM CLAIMS NOTHING. Rendered under the pad idiom, neither
 *     call screen contains any control or sentence claiming a
 *     speaker/earpiece route distinction — asserted over every accessibility
 *     label AND every rendered string, so a relabel that dodged the testID
 *     still fails.
 *
 *  3. PHONES ARE UNTOUCHED. Under the phone idiom both screens render the
 *     toggle exactly as shipped, wired to the same callback (compact is
 *     sacred).
 */

import * as React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import type { GroupCallView } from '../src/call/group';
import { CallScreen } from '../src/screens/CallScreen';
import { GroupCallScreen } from '../src/screens/GroupCallScreen';

/* ────────────────────────────────────────────────────────────────────────
 * The idiom seam. The screens read `EARPIECE_KNOWN_ABSENT` at render time;
 * the getter lets each test choose the idiom without re-requiring the world
 * (the real module's resolution is pinned separately below, against the
 * actual Platform read).
 * ──────────────────────────────────────────────────────────────────────── */

let mockEarpieceKnownAbsent = false;
jest.mock('../src/audioRoute', () => ({
  get EARPIECE_KNOWN_ABSENT() {
    return mockEarpieceKnownAbsent;
  },
}));

beforeEach(() => {
  mockEarpieceKnownAbsent = false;
});

/* ── the real module's resolution table (device-noun.test.ts pattern) ──── */

interface Idiom {
  os: 'ios' | 'android';
  isPad?: boolean;
}

function resolvedUnder(idiom: Idiom): boolean {
  let out: boolean | null = null;
  jest.isolateModules(() => {
    jest.doMock('react-native/Libraries/Utilities/Platform', () => ({
      __esModule: true,
      default: {
        OS: idiom.os,
        isPad: idiom.isPad ?? false,
        select: (spec: Record<string, unknown>) =>
          idiom.os in spec
            ? spec[idiom.os]
            : 'native' in spec
              ? spec.native
              : spec.default,
        Version: idiom.os === 'android' ? 35 : '26.0',
        isTesting: true,
      },
    }));
    // requireActual: this file mocks '../src/audioRoute' for the render
    // tests, and the resolution table is about the REAL module.
    out = (
      jest.requireActual('../src/audioRoute') as {
        EARPIECE_KNOWN_ABSENT: boolean;
      }
    ).EARPIECE_KNOWN_ABSENT;
  });
  jest.dontMock('react-native/Libraries/Utilities/Platform');
  return out!;
}

/* ── render harnesses (CallScreen.test.tsx / GroupCallScreen.test.tsx) ─── */

const T = 1_800_000_000_000;
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ME = ulid('ME1');
const ANA = ulid('ANA');
const BEN = ulid('BEN');

function callState(): CallState {
  return {
    name: 'connected',
    call: {
      cid: '01J0000000000000000000000A',
      peerId: 'P1',
      direction: 'out',
      video: false,
      peerAudio: true,
      peerVideo: false,
      startedAt: T - 60_000,
      connectedAt: T - 65_000,
      answeredAt: null,
      reportId: null,
      remoteOfferSdp: '',
      pendingIce: [],
      remoteReady: true,
    },
  } as CallState;
}

function groupView(): GroupCallView {
  return {
    sid: ulid('SESSION'),
    sessionKey: 1,
    starterId: ME,
    selfId: ME,
    roomId: null,
    roster: [ME, ANA, BEN],
    video: false,
    phase: 'live',
    legs: [
      { peerId: ANA, phase: 'connected', skipped: null, invitedAt: null },
      { peerId: BEN, phase: 'connected', skipped: null, invitedAt: null },
    ],
    startedAt: T - 60_000,
    connectedAt: T - 65_000,
    muted: false,
    speakerOn: false,
  };
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

function renderInProvider(element: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      React.createElement(
        SafeAreaProvider,
        {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 834, height: 1194 },
            insets: { top: 24, left: 0, right: 0, bottom: 20 },
          },
        },
        element,
      ),
    );
  });
  mounted.push(tree);
  return tree;
}

function renderCall(onToggleSpeaker: () => void) {
  return renderInProvider(
    React.createElement(CallScreen, {
      state: callState(),
      peerName: 'Dana',
      muted: false,
      videoEnabled: false,
      speakerOn: false,
      frontCamera: true,
      onToggleMute: jest.fn(),
      onToggleVideo: jest.fn(),
      onFlipCamera: jest.fn(),
      onToggleSpeaker,
      onHangup: jest.fn(),
      now: () => T,
    }),
  );
}

function renderGroup(onToggleSpeaker: () => void) {
  return renderInProvider(
    React.createElement(GroupCallScreen, {
      view: groupView(),
      nameFor: () => 'Someone',
      onToggleMute: jest.fn(),
      onToggleSpeaker,
      onEnd: jest.fn(),
      now: () => T,
    }),
  );
}

/** Every accessibility label plus every rendered string — the full surface a
 * control could use to claim a route. */
function claims(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const labels = tree.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => n.props.accessibilityLabel as string);
  const texts = tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
  return [...labels, ...texts];
}

const speakerControl = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      (n.props.accessibilityLabel === 'Speaker on' ||
        n.props.accessibilityLabel === 'Speaker off'),
  );

/* ────────────────────────────────────────────────────────────────────────── */

describe('the resolution table (idiom-driven, never window-driven)', () => {
  it('is true exactly on the iPad idiom', () => {
    expect(resolvedUnder({ os: 'ios', isPad: true })).toBe(true);
    expect(resolvedUnder({ os: 'ios', isPad: false })).toBe(false);
  });

  it('claims nothing about Android hardware — phone or tablet, the toggle stays', () => {
    expect(resolvedUnder({ os: 'android' })).toBe(false);
    expect(resolvedUnder({ os: 'android', isPad: false })).toBe(false);
  });
});

describe('on the pad idiom the call UIs claim no speaker/earpiece route distinction', () => {
  beforeEach(() => {
    mockEarpieceKnownAbsent = true;
  });

  it('the 1:1 screen renders no speaker control and no route claim', () => {
    const tree = renderCall(jest.fn());
    expect(speakerControl(tree)).toHaveLength(0);
    for (const claim of claims(tree)) {
      expect(claim).not.toMatch(/speaker|earpiece/i);
    }
    // The rest of the row survives the gate: the call is still endable.
    expect(
      tree.root.findAll(n => n.props.accessibilityLabel === 'End call').length,
    ).toBeGreaterThan(0);
  });

  it('the group screen renders no speaker control and no route claim', () => {
    const tree = renderGroup(jest.fn());
    expect(speakerControl(tree)).toHaveLength(0);
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-speaker'),
    ).toHaveLength(0);
    for (const claim of claims(tree)) {
      expect(claim).not.toMatch(/speaker|earpiece/i);
    }
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-end').length,
    ).toBeGreaterThan(0);
  });
});

describe('on the phone idiom the toggle is exactly as shipped (compact is sacred)', () => {
  it('the 1:1 screen offers the toggle, wired', () => {
    const onToggleSpeaker = jest.fn();
    const tree = renderCall(onToggleSpeaker);
    const controls = speakerControl(tree);
    expect(controls.length).toBeGreaterThan(0);
    ReactTestRenderer.act(() => {
      controls[0]!.props.onPress();
    });
    expect(onToggleSpeaker).toHaveBeenCalledTimes(1);
  });

  it('the group screen offers the toggle, wired', () => {
    const onToggleSpeaker = jest.fn();
    const tree = renderGroup(onToggleSpeaker);
    const controls = speakerControl(tree);
    expect(controls.length).toBeGreaterThan(0);
    ReactTestRenderer.act(() => {
      controls[0]!.props.onPress();
    });
    expect(onToggleSpeaker).toHaveBeenCalledTimes(1);
  });
});
