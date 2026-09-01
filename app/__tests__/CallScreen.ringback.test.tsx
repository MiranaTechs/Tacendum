import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import { CallScreen } from '../src/screens/CallScreen';
import { ringbackShouldPlay } from '../src/ui/ringback';

/**
 * The outgoing ringback (a device report: "ringing doesn't have any
 * sound as of now — when it calls i should hear a calling sound").
 *
 * The caller's side only. An INCOMING call is CallKit's to ring — the system
 * ringtone on the lock screen — and this suite pins that the app never adds a
 * second sound to it. What it pins for the OUTGOING side:
 *
 *  - the tone starts when, and only when, the machine reaches
 *    `outgoing_ringing` — the state that means the callee's device confirmed
 *    it is ringing. `outgoing_connecting` stays silent on purpose: playing a
 *    ring before the far phone rings would be a lie about where the call is.
 *  - it stops the INSTANT the state leaves `outgoing_ringing`: the answer
 *    (back to outgoing_connecting with remoteReady), a decline/cancel/failure
 *    (ending, idle), every terminal path.
 *  - it stops when the screen unmounts mid-ring, and when the app is
 *    backgrounded, resuming only if the call is still ringing on return.
 *
 * WHAT THIS SUITE CANNOT PROVE, said plainly: jest exercises the JS driver
 * only. That the tone is audible, routed with the call (earpiece for voice,
 * loudspeaker for video), and does not disturb the answered call's audio is
 * native behaviour, verifiable only on hardware — see the on-device steps in
 * the change report.
 */

const mockStartRingback = jest.fn(async () => {});
const mockStopRingback = jest.fn(async () => {});

// Overrides the global tacendum-audio mock (jest.setup.js) for this file: the
// global one mirrors the voice-note surface and predates the ringback.
jest.mock('tacendum-audio', () => ({
  startRingback: () => mockStartRingback(),
  stopRingback: () => mockStopRingback(),
}));

const T = 1_800_000_000_000;

function state(
  over: Partial<NonNullable<CallState['call']>> & { name?: CallState['name'] } = {},
): CallState {
  const { name = 'outgoing_ringing', ...call } = over;
  if (name === 'idle') return { name: 'idle', call: null };
  return {
    name,
    call: {
      cid: '01J0000000000000000000000A',
      peerId: 'P1',
      direction: 'out',
      video: false,
      peerAudio: true,
      peerVideo: false,
      startedAt: T - 5_000,
      connectedAt: null,
      remoteOfferSdp: '',
      pendingIce: [],
      remoteReady: false,
      ...call,
    },
  } as CallState;
}

/** Every AppState subscriber the screen registered, so a test can be the OS. */
const appStateListeners: ((next: string) => void)[] = [];
beforeEach(() => {
  mockStartRingback.mockClear();
  mockStopRingback.mockClear();
  appStateListeners.length = 0;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, handler: (next: string) => void) => {
      appStateListeners.push(handler);
      return {
        remove: () => {
          const at = appStateListeners.indexOf(handler);
          if (at >= 0) appStateListeners.splice(at, 1);
        },
      };
    }) as unknown as typeof AppState.addEventListener);
});
afterEach(() => {
  jest.restoreAllMocks();
});

function screen(s: CallState) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <CallScreen
        state={s}
        peerName="Dana"
        muted={false}
        videoEnabled={false}
        speakerOn={false}
        onToggleMute={() => {}}
        onToggleVideo={() => {}}
        onFlipCamera={() => {}}
        onToggleSpeaker={() => {}}
        onHangup={() => {}}
        now={() => T}
      />
    </SafeAreaProvider>
  );
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
function mount(s: CallState) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(screen(s));
  });
  mounted.push(tree);
  const update = (next: CallState) => {
    ReactTestRenderer.act(() => {
      tree.update(screen(next));
    });
  };
  return { tree, update };
}
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

describe('the outgoing ringback starts', () => {
  it('plays when the callee’s device confirms it is ringing', () => {
    mount(state({ name: 'outgoing_ringing' }));
    expect(mockStartRingback).toHaveBeenCalledTimes(1);
    expect(mockStopRingback).not.toHaveBeenCalled();
  });

  it('stays silent while the call is only connecting — no fake ring before the far phone rings', () => {
    mount(state({ name: 'outgoing_connecting' }));
    expect(mockStartRingback).not.toHaveBeenCalled();
  });

  it('does not restart on unrelated re-renders of the same ringing call', () => {
    const { update } = mount(state({ name: 'outgoing_ringing' }));
    update(state({ name: 'outgoing_ringing', peerVideo: false }));
    expect(mockStartRingback).toHaveBeenCalledTimes(1);
  });
});

describe('the outgoing ringback stops the instant the ring ends', () => {
  it('on answer — outgoing_connecting with the answer applied', () => {
    const { update } = mount(state({ name: 'outgoing_ringing' }));
    update(state({ name: 'outgoing_connecting', remoteReady: true }));
    expect(mockStopRingback).toHaveBeenCalledTimes(1);
    // And connecting-after-answer must not re-ring.
    expect(mockStartRingback).toHaveBeenCalledTimes(1);
  });

  it('on the terminal transition — decline, cancel, failure all land in ending', () => {
    const { update } = mount(state({ name: 'outgoing_ringing' }));
    update(state({ name: 'ending' }));
    expect(mockStopRingback).toHaveBeenCalledTimes(1);
  });

  it('when the call is gone entirely (idle renders nothing)', () => {
    const { update } = mount(state({ name: 'outgoing_ringing' }));
    update(state({ name: 'idle' }));
    expect(mockStopRingback).toHaveBeenCalledTimes(1);
  });

  it('when the screen unmounts mid-ring', () => {
    const { tree } = mount(state({ name: 'outgoing_ringing' }));
    ReactTestRenderer.act(() => {
      tree.unmount();
    });
    expect(mockStopRingback).toHaveBeenCalledTimes(1);
  });
});

describe('the ringback never plays for an incoming call', () => {
  it('incoming_ringing is CallKit’s to ring, not ours', () => {
    mount(state({ name: 'incoming_ringing', direction: 'in' }));
    expect(mockStartRingback).not.toHaveBeenCalled();
  });

  it('incoming_answering stays silent too', () => {
    mount(state({ name: 'incoming_answering', direction: 'in' }));
    expect(mockStartRingback).not.toHaveBeenCalled();
  });
});

describe('ringbackShouldPlay, the predicate directly', () => {
  it('plays for the real thing', () => {
    expect(ringbackShouldPlay(state({ name: 'outgoing_ringing' }), 'active')).toBe(true);
  });

  it('refuses a state that claims outgoing_ringing for an inbound call', () => {
    // The machine never produces this shape — outgoing_ringing is the
    // caller's state — so no rendered test can reach it. The guard is belt
    // over that invariant: if the machine ever broke it, the failure mode
    // would be a ring playing into the CALLEE's ear, which is worth a
    // redundant conjunct. This pins the belt so deleting it goes red.
    expect(
      ringbackShouldPlay(state({ name: 'outgoing_ringing', direction: 'in' }), 'active'),
    ).toBe(false);
  });

  it('never plays with the call idle', () => {
    expect(ringbackShouldPlay({ name: 'idle', call: null }, 'active')).toBe(false);
  });
});

describe('backgrounding', () => {
  it('stops the tone when the app leaves the foreground, and resumes it on return while still ringing', () => {
    mount(state({ name: 'outgoing_ringing' }));
    expect(mockStartRingback).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => {
      for (const l of [...appStateListeners]) l('background');
    });
    expect(mockStopRingback).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => {
      for (const l of [...appStateListeners]) l('active');
    });
    expect(mockStartRingback).toHaveBeenCalledTimes(2);
  });

  it('returning to the foreground after the call ended starts nothing', () => {
    const { update } = mount(state({ name: 'outgoing_ringing' }));
    update(state({ name: 'ending' }));
    ReactTestRenderer.act(() => {
      for (const l of [...appStateListeners]) l('background');
    });
    ReactTestRenderer.act(() => {
      for (const l of [...appStateListeners]) l('active');
    });
    expect(mockStartRingback).toHaveBeenCalledTimes(1);
  });
});
