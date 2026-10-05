import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import type { GroupCallView } from '../src/call/group';
import { CallScreen } from '../src/screens/CallScreen';
import {
  GroupCallScreen,
  type GroupCallScreenProps,
} from '../src/screens/GroupCallScreen';
import {
  AddPersonGlyph,
  EndCallGlyph,
  FlipCameraGlyph,
  MicGlyph,
  MicMutedGlyph,
  SpeakerGlyph,
} from '../src/ui/CallControlGlyphs';
import { PhoneGlyph, VideoGlyph } from '../src/ui/CallGlyph';

/**
 * The in-call controls render DRAWN icons, one per control, not typographic
 * stand-ins.
 *
 * The control bar shipped with characters (`M̸`, `♪`, `▣`, `⇄`, `＋`, `✕`)
 * standing in for icons; they are now `react-native-svg` line art via
 * `ControlButton`'s glyph map. Two regressions are worth pinning:
 *
 *  - a control silently falling back to the `Text` path and shipping a
 *    character again (the fallback exists on purpose, for glyph names the map
 *    has not met — but every REAL control must resolve to its own drawing);
 *  - the mute swap collapsing: `muted` must render a DIFFERENT drawing, not
 *    the same microphone re-tinted, because the icon swap is the one signal
 *    of mute that does not depend on colour (the spirit, applied to
 *    sighted users with atypical colour vision).
 *
 * Labels, hints, testIDs and accessibilityState are pinned by the existing
 * screen suites; nothing here re-asserts them.
 */

const T = 1_800_000_000_000;

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
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        {element}
      </SafeAreaProvider>,
    );
  });
  mounted.push(tree);
  const byLabel = (label: string) =>
    tree.root.findAll(
      n => n.props.accessibilityLabel === label && typeof n.type !== 'string',
    )[0];
  const byTestID = (testID: string) =>
    tree.root.findAll(n => n.props.testID === testID && typeof n.type !== 'string')[0];
  return { tree, byLabel, byTestID };
}

function callState(): CallState {
  return {
    name: 'connected',
    call: {
      cid: '01J0000000000000000000000A',
      peerId: 'P1',
      direction: 'out',
      video: true,
      peerAudio: true,
      peerVideo: true,
      startedAt: T - 60_000,
      reportId: null,
      answeredAt: null,
      connectedAt: T - 65_000,
      remoteOfferSdp: '',
      pendingIce: [],
      remoteReady: true,
    },
  } as CallState;
}

function renderCallScreen(over: Partial<React.ComponentProps<typeof CallScreen>> = {}) {
  return mount(
    <CallScreen
      state={callState()}
      peerName="Dana"
      muted={false}
      videoEnabled
      speakerOn={false}
      frontCamera
      onToggleMute={jest.fn()}
      onToggleVideo={jest.fn()}
      onFlipCamera={jest.fn()}
      onToggleSpeaker={jest.fn()}
      onHangup={jest.fn()}
      now={() => T}
      {...over}
    />,
  );
}

/** Valid Crockford ULIDs (no I, L, O, U), 26 characters. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ME = ulid('ME1');
const ANA = ulid('ANA');
const BEN = ulid('BEN');

function groupView(over: Partial<GroupCallView> = {}): GroupCallView {
  return {
    sid: ulid('SESSION'),
    sessionKey: 1,
    starterId: ME,
    selfId: ME,
    roomId: null,
    roster: [ME, ANA, BEN],
    video: true,
    phase: 'live',
    legs: [
      { peerId: ANA, phase: 'connected', skipped: null, invitedAt: null },
      { peerId: BEN, phase: 'connected', skipped: null, invitedAt: null },
    ],
    startedAt: T - 60_000,
    connectedAt: T - 65_000,
    muted: false,
    speakerOn: false,
    ...over,
  };
}

function renderGroupScreen(over: Partial<GroupCallScreenProps> = {}) {
  const names: Record<string, string> = { [ANA]: 'Ana', [BEN]: 'Ben' };
  return mount(
    <GroupCallScreen
      view={groupView()}
      nameFor={id => names[id] ?? null}
      cameraOn
      onToggleMute={jest.fn()}
      onToggleCamera={jest.fn()}
      onToggleSpeaker={jest.fn()}
      onAdd={jest.fn()}
      onEnd={jest.fn()}
      now={() => T}
      {...over}
    />,
  );
}

describe('1:1 call controls render drawn icons', () => {
  it('gives each control its own icon component', () => {
    const { byLabel } = renderCallScreen();
    const pairs: Array<[string, (props: { color: string }) => React.JSX.Element]> = [
      ['Mute', MicGlyph],
      ['Turn camera off', VideoGlyph],
      ['Flip camera', FlipCameraGlyph],
      ['Speaker on', SpeakerGlyph],
      ['End call', EndCallGlyph],
    ];
    for (const [label, Icon] of pairs) {
      expect(byLabel(label)!.findAllByType(Icon)).toHaveLength(1);
    }
  });

  it('ships no typographic stand-in anywhere on the screen', () => {
    const { tree } = renderCallScreen();
    // The old characters, byte-exact — including the combining slash that
    // rendered differently in every font it met.
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/[▣⇄♪＋✕]|M̸/);
  });
});

describe('mute and unmute are different drawings, not a re-tint', () => {
  it('renders the intact microphone only while unmuted', () => {
    const { byLabel } = renderCallScreen({ muted: false });
    expect(byLabel('Mute')!.findAllByType(MicGlyph)).toHaveLength(1);
    expect(byLabel('Mute')!.findAllByType(MicMutedGlyph)).toHaveLength(0);
  });

  it('renders the broken, slashed microphone only while muted', () => {
    const { byLabel } = renderCallScreen({ muted: true });
    expect(byLabel('Unmute')!.findAllByType(MicMutedGlyph)).toHaveLength(1);
    expect(byLabel('Unmute')!.findAllByType(MicGlyph)).toHaveLength(0);
  });

  it('draws distinct shapes for every control, muted mic included', () => {
    // The regression this exists for: an icon swap whose two components
    // render the SAME art would pass the component-identity checks above and
    // still ship a mute button that never visibly changes. Same size, same
    // colour — only the drawing may differ.
    const art = [
      MicGlyph,
      MicMutedGlyph,
      VideoGlyph,
      FlipCameraGlyph,
      SpeakerGlyph,
      AddPersonGlyph,
      EndCallGlyph,
      PhoneGlyph,
    ].map(Icon => {
      let t!: ReactTestRenderer.ReactTestRenderer;
      ReactTestRenderer.act(() => {
        t = ReactTestRenderer.create(<Icon size={22} color="#FFFFFF" />);
      });
      mounted.push(t);
      return JSON.stringify(t.toJSON());
    });
    expect(new Set(art).size).toBe(art.length);
  });
});

describe('group call controls render drawn icons', () => {
  it('gives each control its own icon component', () => {
    const { byTestID } = renderGroupScreen();
    expect(byTestID('group-call-mute')!.findAllByType(MicGlyph)).toHaveLength(1);
    expect(byTestID('group-call-camera')!.findAllByType(VideoGlyph)).toHaveLength(1);
    expect(byTestID('group-call-add')!.findAllByType(AddPersonGlyph)).toHaveLength(1);
    expect(byTestID('group-call-end')!.findAllByType(EndCallGlyph)).toHaveLength(1);
  });

  it('swaps the mute icon from the view, like the 1:1 screen', () => {
    const { byTestID } = renderGroupScreen({ view: groupView({ muted: true }) });
    expect(byTestID('group-call-mute')!.findAllByType(MicMutedGlyph)).toHaveLength(1);
    expect(byTestID('group-call-mute')!.findAllByType(MicGlyph)).toHaveLength(0);
  });

  it('draws the ringing pair as handsets: up to answer, down to decline', () => {
    const { byTestID } = renderGroupScreen({
      view: groupView({ phase: 'ringing', starterId: ANA, connectedAt: null }),
      onAnswer: jest.fn(),
      onDecline: jest.fn(),
    });
    expect(byTestID('group-call-answer')!.findAllByType(PhoneGlyph)).toHaveLength(1);
    expect(byTestID('group-call-answer')!.findAllByType(EndCallGlyph)).toHaveLength(0);
    expect(byTestID('group-call-decline')!.findAllByType(EndCallGlyph)).toHaveLength(1);
  });
});
