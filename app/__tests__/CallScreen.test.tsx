import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import {
  CallScreen,
  clampPip,
  durationAnnouncement,
  durationLabel,
  nearestPipCorner,
  PIP_ACCESSIBILITY_ACTIONS,
  PIP_HEIGHT,
  PIP_MARGIN,
  PIP_TOP_CLEARANCE,
  PIP_WIDTH,
  pipAnchor,
  pipCornerForAction,
  pipDragClaims,
  statusLabel,
} from '../src/screens/CallScreen';
// The SAME component the chat list, the thread header and the Calls tab draw
// a person with. Asserted by type rather than by pixel: the requirement is
// that the call screen and the chat agree about who someone looks like, and
// two independently correct-looking avatar implementations is exactly the
// disagreement that produced a bare initial here and a monogram everywhere
// else.
import { Avatar } from '../src/ui/Avatar';
import { monogram, shortId } from '../src/person';

/**
 * The call screen renders `CallState` and calls back — it holds no state and
 * touches no native module, which is why every case below is renderable
 * without a device.
 *
 * The two things worth guarding hardest are not visual. A call that never
 * connected must not display a duration ("never connected" and "0:00"
 * are different facts), and the controls must be usable with VoiceOver, which means a mute button has to report that it IS muted rather
 * than merely looking different.
 */

const T = 1_800_000_000_000;

function state(over: Partial<NonNullable<CallState['call']>> & { name?: CallState['name'] } = {}): CallState {
  const { name = 'connected', ...call } = over;
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
      startedAt: T - 60_000,
      connectedAt: T - 65_000,
      remoteOfferSdp: '',
      pendingIce: [],
      remoteReady: true,
      ...call,
    },
  } as CallState;
}

/** react-test-renderer, matching the rest of this suite. The SafeAreaProvider
 * wrapper is required: `useSafeAreaInsets` needs native measurements that do
 * not exist here, and without it every screen renders empty. */
function renderScreen(over: Partial<React.ComponentProps<typeof CallScreen>> = {}) {
  const props = {
    state: state(),
    peerName: 'Dana',
    muted: false,
    videoEnabled: false,
    speakerOn: false,
    frontCamera: true,
    onToggleMute: jest.fn(),
    onToggleVideo: jest.fn(),
    onFlipCamera: jest.fn(),
    onToggleSpeaker: jest.fn(),
    onHangup: jest.fn(),
    now: () => T,
    ...over,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <CallScreen {...props} />
      </SafeAreaProvider>,
    );
  });
  const byLabel = (label: string) =>
    tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.type !== 'string')[0];
  mounted.push(tree);
  return { tree, props, byLabel, toJSON: () => tree.toJSON() };
}

/**
 * Unmount every tree.
 *
 * The screen runs a one-second interval to advance the duration, and it clears
 * it on unmount — which never happens if a test just walks away. The jest
 * worker then stays alive forever and reports it as a leak somewhere else
 * entirely.
 */
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

/** The pip's draggable wrapper: the HOST view the panHandlers spread landed
 * on, recognised by the move-claim prop PanResponder alone sets (a Pressable
 * sets start/responder handlers, never onMoveShouldSetResponder). */
function pipWrapper(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.onMoveShouldSetResponder === 'function',
  )[0];
}

describe('duration', () => {
  it('shows nothing when the call never connected', () => {
    // A call that rang and failed must not render 0:00 — that claims it
    // happened. `connectedAt` is null precisely to keep those apart.
    expect(durationLabel(state({ connectedAt: null, name: 'outgoing_ringing' }), T)).toBeNull();
  });

  it('counts from when media flowed, not from when dialling started', () => {
    // startedAt is 60s ago and connectedAt 65s ago in the fixture; using the
    // wrong one is an easy mistake that shows a plausible-looking number.
    expect(durationLabel(state({ connectedAt: T - 65_000 }), T)).toBe('1:05');
  });

  it('pads seconds and grows to hours', () => {
    expect(durationLabel(state({ connectedAt: T - 9_000 }), T)).toBe('0:09');
    expect(durationLabel(state({ connectedAt: T - 3_725_000 }), T)).toBe('1:02:05');
  });

  it('announces at MINUTE granularity for VoiceOver', () => {
    // A live region that changes every second makes a call unusable with a
    // screen reader — it would interrupt the other person continuously.
    expect(durationAnnouncement(state({ connectedAt: T - 30_000 }), T)).toBe('Connected');
    expect(durationAnnouncement(state({ connectedAt: T - 61_000 }), T)).toBe('1 minute');
    expect(durationAnnouncement(state({ connectedAt: T - 185_000 }), T)).toBe('3 minutes');
  });
});

describe('status', () => {
  it('translates protocol states into something a person reads', () => {
    // remoteReady false spelled out: the helper's default context is a
    // CONNECTED call, and a connected call has been answered.
    expect(statusLabel(state({ name: 'outgoing_connecting', remoteReady: false }))).toBe(
      'Calling…',
    );
    expect(statusLabel(state({ name: 'outgoing_ringing' }))).toBe('Ringing…');
    expect(statusLabel(state({ name: 'reconnecting' }))).toBe('Reconnecting…');
    expect(statusLabel(state({ name: 'connected' }))).toBe('Connected');
  });

  it('an ANSWERED call reads Connecting…, never back to Calling…', () => {
    // answerReceived deliberately returns the machine to outgoing_connecting
    // ("ringing" was only ever a UI state), and rendering that literally made
    // the header regress Ringing… → Calling… at the exact moment the callee
    // picked up (Phase H hardware). `remoteReady` is the fact the
    // machine already holds about that moment — flipped by the answer, never
    // before — so the label can be honest in both directions:
    expect(statusLabel(state({ name: 'outgoing_connecting', remoteReady: true }))).toBe(
      'Connecting…',
    );
    // …and a call still dialling keeps saying so. If this line fails, the
    // label is claiming an answer nobody gave.
    expect(statusLabel(state({ name: 'outgoing_connecting', remoteReady: false }))).toBe(
      'Calling…',
    );
  });

  it('renders nothing at all when idle', () => {
    const { tree } = renderScreen({ state: { name: 'idle', call: null } });
    // The provider still renders, but the screen contributes nothing.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Call')).toHaveLength(0);
  });
});

describe('video actually renders (found by review)', () => {
  /**
   * The module transmitted and received video and NOTHING displayed it: no
   * remote surface, no local preview, `remoteTrackAdded` unsubscribed, and the
   * decoded track dropped on the floor in the peer connection's delegate. A
   * video call carried video neither side could see, and every unit test
   * passed, because none of them asked whether a renderer existed.
   */
  function videoCall() {
    return state({ video: true, peerVideo: true });
  }

  function views(tree: ReactTestRenderer.ReactTestRenderer) {
    // The jest mock renders the component as a host string.
    return tree.root.findAll(n => (n.type as unknown as string) === 'TacendumVideoView');
  }

  it('renders a remote surface for a video call', () => {
    const { tree } = renderScreen({ state: videoCall(), videoEnabled: true });
    const remote = views(tree).filter(v => v.props.track === 'remote');
    expect(remote).toHaveLength(1);
    expect(remote[0]!.props.cid).toBe('01J0000000000000000000000A');
  });

  it('renders a local preview, mirrored', () => {
    // People expect their own image to behave like a mirror and expect the
    // remote one not to; mirroring the wrong one is immediately disorienting.
    const { tree } = renderScreen({ state: videoCall(), videoEnabled: true });
    const local = views(tree).filter(v => v.props.track === 'local');
    expect(local).toHaveLength(1);
    expect(local[0]!.props.mirror).toBe(true);
    const remote = views(tree).filter(v => v.props.track === 'remote');
    expect(remote[0]!.props.mirror).toBeFalsy();
  });

  it('hides the local preview when the camera is off', () => {
    const { tree } = renderScreen({ state: videoCall(), videoEnabled: false });
    expect(views(tree).filter(v => v.props.track === 'local')).toHaveLength(0);
  });

  it('renders no video surface at all for an audio call', () => {
    // An audio call shows the person, not a black rectangle.
    const { tree } = renderScreen({ state: state({ video: false, peerVideo: false }) });
    expect(views(tree)).toHaveLength(0);
  });
});

/**
 * THE DARK RECTANGLE (reported on hardware).
 *
 * "during video call if i am calling person b i should see person B photo
 *  fully on the screen and my video on the top right corner — currently
 *  person B is all dark screen".
 *
 * The native surface is honest: `TacendumVideoHost` paints `.black` and an
 * empty `RTCMTLVideoView` when it holds no track, which is the truth for the
 * whole of a call's ringing and connecting phases and for every second the
 * far end's camera is off. What was missing is the SCREEN's half — the
 * fallback the design already specifies for an audio call was gated on `!isVideo`,
 * so a VIDEO call could never show the person at all, in any state.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE. They prove which element is
 * rendered, whose picture it is, which blob it came from, and that it gets
 * out of the way when the peer's video is live. They CANNOT prove a single
 * pixel: whether frames reach the Metal view is hardware, and stays a
 * device check.
 */
describe('the person, when there is no video of them', () => {
  /** A stand-in for `chats.avatarB64` — the exact column the chat list, the
   * thread header and `App.tsx`'s `callPeerAvatar` all read. */
  const PHOTO = '/9j/4AAQSkZJRgABAQAAAQABAAD==';
  /** The uri `Avatar` builds from that column. Same blob, same scheme — the
   * backdrop is provably the chat's picture, not a second source. */
  const PHOTO_URI = `data:image/jpeg;base64,${PHOTO}`;

  function faces(tree: ReactTestRenderer.ReactTestRenderer) {
    return tree.root.findAllByType(Avatar);
  }

  function views(tree: ReactTestRenderer.ReactTestRenderer) {
    return tree.root.findAll(n => (n.type as unknown as string) === 'TacendumVideoView');
  }

  /** The cover-cropped photo standing where the peer's video would be —
   * matched on the HOST node so one picture is one match, and EDGE-PINNED so
   * the centred disc counts as what it is. Both draw the same blob; only the
   * surface-filling one can be mistaken for the peer's live camera, which is
   * the whole distinction the pre-connect rule below turns on. */
  function backdropPhotos(node: ReactTestRenderer.ReactTestInstance) {
    return node.findAll(n => {
      if (typeof n.type !== 'string' || n.props?.source?.uri !== PHOTO_URI) return false;
      return StyleSheet.flatten(n.props.style)?.position === 'absolute';
    });
  }

  /** The backdrop's own wrapper: the pointer-transparent fill inside a video
   * surface. There is at most one per surface. */
  function backdropWrap(surface: ReactTestRenderer.ReactTestInstance) {
    return surface.findAll(n => n.props?.pointerEvents === 'none')[0];
  }

  const texts = (node: ReactTestRenderer.ReactTestInstance) =>
    node
      .findAll(n => String(n.type) === 'Text')
      .map(n => [n.props.children].flat().join(''));

  it('shows the peer as a DISC while their video is still on its way', () => {
    // The reported case exactly: dialling a video call. No remote track can
    // exist yet — the answer has not landed — so the surface is black, and
    // black is what filled the screen where the person should be.
    //
    // Filling it with their photo cover-cropped to the surface fixed the
    // black and bought a worse problem: a
    // full-bleed face where the remote camera goes IS what a live remote
    // camera looks like, so the screen read as connected video while the
    // header still said "Ringing…". Before the call connects there is no
    // remote media of any kind to stand in for, so the person is drawn the
    // way an audio call draws them — one 128pt disc, centred, over the pine
    // ground — which no one reads as a camera feed.
    const { tree } = renderScreen({
      state: state({
        name: 'outgoing_ringing',
        video: true,
        peerVideo: true,
        connectedAt: null,
      }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(0);
    const shown = faces(tree);
    expect(shown).toHaveLength(1);
    // The audio layout's number, and pinned for the audio layout's reason:
    // `size={128}` → `size={1}` is a mutation nothing else here would catch.
    expect(shown[0]!.props.size).toBe(128);
    expect(shown[0]!.props.peerId).toBe('P1');
    expect(shown[0]!.props.photoB64).toBe(PHOTO);
    // The label that was telling the truth all along is untouched.
    expect(texts(tree.root)).toContain('Ringing…');
  });

  it('is still the disc while the ANSWER is applied and ICE is not', () => {
    // `outgoing_connecting` with the answer in hand ("Connecting…") is the
    // other pre-connect state, and it has no remote media either.
    const { tree } = renderScreen({
      state: state({
        name: 'outgoing_connecting',
        video: true,
        peerVideo: true,
        connectedAt: null,
      }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(0);
    expect(faces(tree)).toHaveLength(1);
    expect(texts(tree.root)).toContain('Connecting…');
  });

  it('paints the surface-sized photo the moment the call IS connected', () => {
    // The other half of the rule, and the one that keeps this change from
    // quietly becoming "the photo never shows": a connected call with the
    // far camera off is exactly one full-bleed photo, and nothing else.
    const { tree } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(1);
    expect(faces(tree)).toHaveLength(0);
  });

  it('keeps it while a connected call is reconnecting', () => {
    // Reconnecting is a call that HAS connected: the remote track exists and
    // is not flowing, which is the case the backdrop was built for.
    const { tree } = renderScreen({
      state: state({ name: 'reconnecting', video: true, peerVideo: true }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(1);
  });

  it('keeps the person through the teardown of a call that CONNECTED', () => {
    // `ending` is a POST-connect state for any call that reached it: the
    // remote track existed a moment ago, and nothing about who is on the
    // screen has changed for the person watching it. Naming only `connected`
    // and `reconnecting` swapped the full-bleed peer for a 128pt disc for the
    // whole of the hangup.
    const { tree } = renderScreen({
      state: state({
        name: 'ending',
        video: true,
        peerVideo: false,
        connectedAt: T - 65_000,
      }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(1);
    expect(faces(tree)).toHaveLength(0);
  });

  it('ends a call CANCELLED before it connected on the disc, not the surface', () => {
    // The other side of the same fact, and the reason the gate cannot simply
    // add `ending`: a dial you cancel never had remote media, so the
    // pre-connect rule still holds and no full-bleed face may flash up to
    // read as the far camera on the way out.
    const { tree } = renderScreen({
      state: state({
        name: 'ending',
        video: true,
        peerVideo: true,
        connectedAt: null,
      }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(0);
    expect(faces(tree)).toHaveLength(1);
  });

  it('letters the pre-connect disc “?”, never the placeholder’s own initials', () => {
    // `tileName` answers `Someone` for a peer who has never shared a name,
    // and handing that sentinel to `Avatar` as a display name lettered the
    // disc `SO`, so the same person wore `SO` while the call rang and `?`
    // the instant it connected, seconds apart. The name here is the exact
    // fallback App.tsx hands down (`personName` to `shortId`), not a stand-in.
    const peerId = '01J0000000000000000000000B';
    const { tree } = renderScreen({
      state: state({
        name: 'outgoing_ringing',
        peerId,
        video: true,
        peerVideo: true,
        connectedAt: null,
      }),
      peerName: shortId(peerId),
      peerAvatarB64: null,
      videoEnabled: true,
    });
    const rendered = texts(tree.root);
    expect(rendered).toContain('?');
    expect(rendered).not.toContain('SO');
    // Nor the id's own characters, which is what a bare `Avatar` falls to
    // once the sentinel is refused.
    expect(rendered).not.toContain(monogram(peerId, null));
  });

  it('keeps showing them while their camera is off mid-call', () => {
    // `peerVideo` is the far end's own report (the answer's `vid`, then every
    // `call.media`). A connected call with their camera off has a live audio
    // path and nothing to render — the same black rectangle, with no
    // "connecting" to explain it.
    const { tree } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(1);
  });

  it('gets out of the way once their video is actually flowing', () => {
    const { tree, byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: true }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(0);
    // Nothing covers the live video: no photo, no fill, no letters.
    expect(texts(byLabel("Dana's video, full screen"))).toHaveLength(0);
  });

  it('pictures them from the CHAT’S source, not a second one of its own', () => {
    const { tree } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    // The blob App.tsx read out of `chats.avatarB64` for this peer, in the
    // exact uri `Avatar` builds from that column everywhere else.
    expect(backdropPhotos(tree.root)[0]!.props.source.uri).toBe(PHOTO_URI);
  });

  it('COVERS the surface with the person — not a disc floating in black', () => {
    // The first fix rendered the peer at
    // `size={160}`, centred: about 6% of a 390×844 display, so "person B is
    // all dark screen" stayed ~94% true. The backdrop must fill the surface
    // the way the video it stands in for does (`objectFit="cover"`).
    //
    // These are the load-bearing geometry pins — a mutation audit proved
    // 160→73 left the whole suite green. Jest cannot see pixels; what it CAN
    // pin is the geometry the renderer is told to draw, and any mutation of
    // an edge, the crop mode or a reintroduced fixed size goes red here.
    const { tree, byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    const photo = backdropPhotos(tree.root)[0]!;
    expect(photo.props.resizeMode).toBe('cover');
    const flat = StyleSheet.flatten(photo.props.style);
    expect(flat.position).toBe('absolute');
    expect([flat.top, flat.left, flat.right, flat.bottom]).toEqual([0, 0, 0, 0]);
    // Edge-pinned, never sized: a fixed width is exactly how 160 happened.
    expect(flat.width).toBeUndefined();
    expect(flat.height).toBeUndefined();

    const wrap = backdropWrap(byLabel("Dana's video, full screen"))!;
    const wrapFlat = StyleSheet.flatten(wrap.props.style);
    expect(wrapFlat.position).toBe('absolute');
    expect([wrapFlat.top, wrapFlat.left, wrapFlat.right, wrapFlat.bottom]).toEqual([
      0, 0, 0, 0,
    ]);
    // Inside an accessible Pressable that already says whose video this is;
    // a second accessible node would read the name twice…
    expect(wrap.props.accessibilityElementsHidden).toBe(true);
    // …and it must not eat the tap that swaps the surfaces: the fill covers
    // exactly where a thumb lands.
    expect(wrap.props.pointerEvents).toBe('none');
  });

  it('fills the surface for a peer with NO photo too — never bare black', () => {
    // The no-photo treatment is CallTile's, inflated to the surface: the pine
    // wash the app puts behind every photo-less person on the media surface,
    // with the chat's monogram as the subject.
    const { byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: null,
      videoEnabled: true,
    });
    const surface = byLabel("Dana's video, full screen");
    const wrap = backdropWrap(surface)!;
    const flat = StyleSheet.flatten(wrap.props.style);
    expect([flat.top, flat.left, flat.right, flat.bottom]).toEqual([0, 0, 0, 0]);
    expect(flat.backgroundColor).toBe('rgba(14,107,69,0.10)');
    // The chat's monogram — `Dana` → `DA`, never a bare initial — at a size
    // that reads as the surface's subject. Pinned to the number because the
    // mutation audit proved the old sizes could mutate to 73 and 1 unnoticed.
    expect(monogram('P1', 'Dana')).toBe('DA');
    const letters = wrap.findAll(
      n => String(n.type) === 'Text' && [n.props.children].flat().join('') === 'DA',
    )[0]!;
    expect(StyleSheet.flatten(letters.props.style).fontSize).toBe(96);
    expect(letters.props.allowFontScaling).toBe(false);
  });

  it('never letters the fill with id characters', () => {
    // App.tsx's `peerName` fallback is `personName(peerId)`, which is the
    // shortId fragment. `tileName` refuses both forms an id can arrive in
    // (CallTile's rule 2, now enforced on this surface too), so a peer with
    // no shared name wears "?" — never characters of their id.
    const { byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerName: 'P1', // === call.peerId: the id arriving dressed as a name
      peerAvatarB64: null,
      videoEnabled: true,
    });
    // RE-CUT: this used to look the surface up by
    // `"P1's video, full screen"` — and that assertion PINNED the violation,
    // because the label itself was spelling the id out to VoiceOver while the
    // fill below it refused to. The label now goes through `tileName` too, so
    // the surface answers to the placeholder and no rendered or spoken string
    // on this screen carries the id.
    const rendered = texts(byLabel("Someone's video, full screen"));
    expect(rendered).toContain('?');
    expect(rendered).not.toContain('P1');
  });

  it('an AUDIO call uses the same placeholder, for the same reason', () => {
    const { tree } = renderScreen({
      state: state({ video: false, peerVideo: false }),
      peerAvatarB64: null,
    });
    expect(faces(tree)).toHaveLength(1);
    expect(faces(tree)[0]!.props.peerId).toBe('P1');
    expect(faces(tree)[0]!.props.displayName).toBe('Dana');
    // 128 exactly: the mutation audit proved `size={128}` → `size={1}` left
    // the whole suite green — nothing pinned the number that decides whether
    // this screen shows a person or a dot.
    expect(faces(tree)[0]!.props.size).toBe(128);
    // The whole screen IS the person here, so the disc carries the name for
    // VoiceOver. Inside a video surface it must not — the Pressable around it
    // already says whose video it is, and a second accessible node inside an
    // accessible one reads the name twice.
    expect(faces(tree)[0]!.props.accessibilityLabel).toBe("Dana's picture");
  });

  it('follows the swap into the corner — same person, same photo', () => {
    // Tap-to-swap moves the REMOTE track into the small surface. The person
    // it is a picture of has to travel with it, or the corner goes black and
    // the full screen shows a face nobody asked to see full size.
    //
    // IDENTITY AND BLOB PINNED, not just presence: a mutation audit mutated
    // all three of `peerId`, `peerName` and `photoB64` on the corner face to
    // garbage and 29/29 tests stayed green, because the old assertion counted
    // discs and measured sizes without ever asking whose face it was.
    const { tree, byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    expect(backdropPhotos(tree.root)).toHaveLength(1);
    ReactTestRenderer.act(() => byLabel("Dana's video, full screen").props.onPress());
    // The full surface now carries MY video, uncovered…
    expect(backdropPhotos(byLabel('Your video, full screen'))).toHaveLength(0);
    // …and the corner carries the PEER'S photo, cover-cropped to its box.
    const pip = byLabel("Dana's video, small");
    const corner = backdropPhotos(pip);
    expect(corner).toHaveLength(1);
    expect(corner[0]!.props.source.uri).toBe(PHOTO_URI);
    expect(corner[0]!.props.resizeMode).toBe('cover');
    const flat = StyleSheet.flatten(corner[0]!.props.style);
    expect([flat.top, flat.left, flat.right, flat.bottom]).toEqual([0, 0, 0, 0]);
    // AND IT MUST NOT EAT THE TAP THAT PUT IT THERE, or the surfaces would
    // swap once and never swap back.
    expect(backdropWrap(pip)!.props.pointerEvents).toBe('none');
  });

  it('letters the corner from the PEER, monogram and wash, never black', () => {
    // Peer's camera off, swapped: the corner is the only place the peer
    // exists. Its letters must derive from THEIR name — mutate `peerName` on
    // the corner face and `DA` becomes someone else's initials.
    const { byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: null,
      videoEnabled: true,
    });
    ReactTestRenderer.act(() => byLabel("Dana's video, full screen").props.onPress());
    const pip = byLabel("Dana's video, small");
    const letters = pip.findAll(
      n => String(n.type) === 'Text' && [n.props.children].flat().join('') === 'DA',
    )[0]!;
    expect(letters).toBeTruthy();
    // At the corner's own size — surface-sized letters would clip a 110pt box.
    expect(StyleSheet.flatten(letters.props.style).fontSize).toBe(32);
    // The wash behind them fills the box, so the corner is never bare black.
    expect(
      StyleSheet.flatten(backdropWrap(pip)!.props.style).backgroundColor,
    ).toBe('rgba(14,107,69,0.10)');
  });

  it('shows “?” in the corner for an unnamed peer, never id characters', () => {
    // The corner's half of the id rule — and the pin on the corner's
    // `peerId`: hand the fill a wrong id and `tileName` stops recognising
    // the name as that id's fallback, so the id characters leak and this
    // goes red.
    const { byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerName: 'P1',
      peerAvatarB64: null,
      videoEnabled: true,
    });
    // Re-cut for the same reason as the full-screen case above: the corner's
    // label went through the raw name and said the id out loud.
    ReactTestRenderer.act(() => byLabel("Someone's video, full screen").props.onPress());
    const rendered = texts(byLabel("Someone's video, small"));
    expect(rendered).toContain('?');
    expect(rendered).not.toContain('P1');
  });

  it('does not lose the peer when you swap with your own camera off', () => {
    // The small surface was gated on `videoEnabled`, which is a fact about
    // THIS device's camera. Once swapped it carries the OTHER person, so that
    // gate deleted the remote surface — and with it the only place the peer
    // could appear — for anyone who swapped with their camera off.
    const { tree, byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: true }),
      peerAvatarB64: PHOTO,
      videoEnabled: false,
    });
    ReactTestRenderer.act(() => byLabel("Dana's video, full screen").props.onPress());
    expect(views(tree).filter(v => v.props.track === 'remote')).toHaveLength(1);
    // Their video is LIVE, so no backdrop may cover it — in the corner any
    // more than full screen. (Falsifier: drop `!remoteVideoLive` from the
    // corner's gate; the photo paints over their live tile and this goes red.)
    expect(backdropPhotos(tree.root)).toHaveLength(0);
  });

  it('falls back to the fill when the photo fails to decode', () => {
    // `Avatar`'s guard, kept by the backdrop: a truncated or non-JPEG blob
    // must fall back to the monogram fill, never leave the surface blank —
    // and never reach for id characters on the way down.
    const { tree, byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    const photo = backdropPhotos(tree.root)[0]!;
    ReactTestRenderer.act(() => photo.props.onError());
    expect(backdropPhotos(tree.root)).toHaveLength(0);
    const rendered = texts(byLabel("Dana's video, full screen"));
    expect(rendered).toContain('DA');
    expect(rendered).not.toContain('P1');
  });

  it('tries the NEW photo after an old one failed to decode', () => {
    // The failure belongs to the BLOB, not to the person: a profile-photo
    // update landing mid-call must get its chance, or a single truncated
    // blob pins the monogram for the rest of the call. (Falsifier: drop the
    // `setFailed(false)` reset keyed on `photoB64` — the fresh blob below
    // never renders and this goes red.)
    const PHOTO2 = `${PHOTO}AAAA`;
    const { tree, props } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
      videoEnabled: true,
    });
    ReactTestRenderer.act(() => backdropPhotos(tree.root)[0]!.props.onError());
    expect(backdropPhotos(tree.root)).toHaveLength(0);
    ReactTestRenderer.act(() => {
      tree.update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <CallScreen {...props} peerAvatarB64={PHOTO2} />
        </SafeAreaProvider>,
      );
    });
    expect(
      tree.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props?.source?.uri === `data:image/jpeg;base64,${PHOTO2}`,
      ),
    ).toHaveLength(1);
  });

  it('puts the local preview in the TOP-RIGHT corner, small', () => {
    // The layout, asserted rather than assumed: the remote fills the
    // screen and the self-view is a corner picture-in-picture. Since the pip
    // became draggable the position lives on its WRAPPER (the pan surface),
    // and the default must be exactly where the static pip always sat: 16
    // from the right edge of the 390pt frame, insets.top + 96 down.
    const { tree, byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: true }),
      videoEnabled: true,
    });
    const pip = StyleSheet.flatten(pipWrapper(tree)!.props.style);
    expect(pip.position).toBe('absolute');
    expect(pip.left).toBe(390 - PIP_MARGIN - PIP_WIDTH); // ⇔ the old right: 16
    // Below the header, not under the notch.
    expect(pip.top).toBe(47 + PIP_TOP_CLEARANCE);
    expect(pip.width).toBeLessThan(200);
    // The drag rides an animated translation, not a re-render per move.
    expect(pip.transform).toHaveLength(2);

    const remote = StyleSheet.flatten(byLabel("Dana's video, full screen").props.style);
    expect(remote.position).toBe('absolute');
    expect([remote.top, remote.left, remote.right, remote.bottom]).toEqual([0, 0, 0, 0]);
  });
});

describe('controls are usable with VoiceOver', () => {
  it('reports mute as SELECTED, not just differently coloured', () => {
    const { byLabel } = renderScreen({ muted: true });
    expect(byLabel('Unmute').props.accessibilityState.selected).toBe(true);
  });

  it('labels the action, not the current state', () => {
    // "Mute" when unmuted, "Unmute" when muted — a label that reads "Mute"
    // in both states leaves a screen-reader user guessing what will happen.
    expect(renderScreen({ muted: false }).byLabel('Mute')).toBeTruthy();
    expect(renderScreen({ muted: true }).byLabel('Unmute')).toBeTruthy();
  });

  // The two cases below render a call that NEGOTIATED video (`video: true`).
  // They used to render the default audio-negotiated state and still find
  // the camera controls, which pinned an audio call has no video m-line, no
  // local track and no renegotiation path, so offering the camera there lied
  // locally and blacked out the peer. The controls are now offered only on a
  // call that carries video.
  it('disables flip camera when the camera is off', () => {
    const { byLabel } = renderScreen({ state: state({ video: true }), videoEnabled: false });
    expect(byLabel('Flip camera').props.accessibilityState.disabled).toBe(true);
  });

  it('gives every control a label', () => {
    const { byLabel } = renderScreen({ state: state({ video: true }), videoEnabled: true });
    for (const label of ['Mute', 'Turn camera off', 'Flip camera', 'Speaker on', 'End call']) {
      expect(byLabel(label)).toBeTruthy();
    }
  });

  it('offers no camera control on a call that negotiated no video', () => {
    // Placed as audio, or a video invite answered without video: there is no
    // transceiver for a camera to feed, so there is no camera button and no
    // flip. Mute, speaker and End remain.
    const { byLabel } = renderScreen({ state: state({ video: false }), videoEnabled: false });
    expect(byLabel('Turn camera on')).toBeUndefined();
    expect(byLabel('Turn camera off')).toBeUndefined();
    expect(byLabel('Flip camera')).toBeUndefined();
    for (const label of ['Mute', 'Speaker on', 'End call']) {
      expect(byLabel(label)).toBeTruthy();
    }
  });

  it('hangs up when End call is pressed', () => {
    const { byLabel, props } = renderScreen();
    ReactTestRenderer.act(() => {
      byLabel('End call').props.onPress();
    });
    expect(props.onHangup).toHaveBeenCalled();
  });
});

describe('tapping a video swaps which one fills the screen', () => {
  function videoViews(tree: ReactTestRenderer.ReactTestRenderer) {
    return tree.root.findAll(
      // Identified by props rather than by type: the jest mock renders the
      // component as a host string, and comparing against it does not
      // typecheck against ElementType.
      n => n.props?.track !== undefined && n.props?.cid !== undefined,
    );
  }

  it('starts with the peer full-screen and me in the corner', () => {
    const { tree } = renderScreen({
      state: state({ video: true, peerVideo: true }),
      videoEnabled: true,
    });
    const views = videoViews(tree);
    expect(views[0]!.props.track).toBe('remote');
    expect(views[1]!.props.track).toBe('local');
    // Only MY image is mirrored — a mirrored peer would show their world
    // reversed, and text behind them backwards.
    expect(views[0]!.props.mirror).toBe(false);
    expect(views[1]!.props.mirror).toBe(true);
  });

  it('swaps both surfaces AND the mirroring when tapped', () => {
    // Mirroring has to travel with the local track rather than with the
    // position, or swapping would mirror the peer and un-mirror me.
    const { tree } = renderScreen({
      state: state({ video: true, peerVideo: true }),
      videoEnabled: true,
    });
    const pip = tree.root.findAll(
      n => typeof n.type !== 'string' && /Your video, small/.test(String(n.props?.accessibilityLabel)),
    )[0]!;

    ReactTestRenderer.act(() => pip.props.onPress());

    const views = videoViews(tree);
    expect(views[0]!.props.track).toBe('local');
    expect(views[1]!.props.track).toBe('remote');
    expect(views[0]!.props.mirror).toBe(true);
    expect(views[1]!.props.mirror).toBe(false);
  });
});

/**
 * THE DRAGGABLE PREVIEW.
 *
 * "i need to move the video window around of mine when am in a video call" —
 * the corner pip follows the finger and a release snaps it to the nearest of
 * the four corners, WhatsApp-style, on core PanResponder + Animated.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE. PanResponder's view-level handlers
 * parse RN's internal touch histories, which jest cannot honestly fabricate —
 * so the finger itself stays a device check, exactly as PhotoViewer's
 * gestures do. What CAN be pinned is everything that decides where the pip
 * goes: the four anchors, the safe-area clamp, the nearest-corner choice and
 * the tap-vs-drag threshold are exported pure functions, and the wiring —
 * which node carries the pan, where the default parks, that the swap tap
 * survives — is asserted on the rendered tree. No clocks, no timers: the
 * snap maths is pure, so the frozen-clock landmine has nothing to bite.
 */
describe('the corner preview drags', () => {
  // The suite's own device: the 390×844 frame and 47/34 insets renderScreen
  // stipulates, so the pure maths and the rendered tree agree by construction.
  const FRAME = { width: 390, height: 844 };
  const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };

  it('anchors all four corners inside the safe area, clear of header and controls', () => {
    // top-right is TODAY'S position exactly: right edge 16 in, insets.top+96
    // down. The default corner changing these numbers is a regression.
    expect(pipAnchor('top-right', FRAME, INSETS)).toEqual({ x: 264, y: 143 });
    expect(pipAnchor('top-left', FRAME, INSETS)).toEqual({ x: 16, y: 143 });
    const bl = pipAnchor('bottom-left', FRAME, INSETS);
    expect(bl.x).toBe(16);
    expect(bl.y).toBeCloseTo(844 - 34 - 96 - PIP_HEIGHT);
    expect(pipAnchor('bottom-right', FRAME, INSETS).x).toBe(264);
    // The whole pip clears the control band: 16 + 44pt buttons + 20 padding
    // = 80 above the home indicator, and the pip's bottom edge stays above it.
    expect(bl.y + PIP_HEIGHT).toBeLessThanOrEqual(844 - 34 - 80);
  });

  it('re-derives anchors for a rotated window, and clamps a window with no room', () => {
    // iPad landscape: the corner is the stored fact, the coordinates follow
    // the new frame.
    const LAND = { width: 1180, height: 820 };
    const PAD = { top: 24, bottom: 20, left: 0, right: 0 };
    expect(pipAnchor('top-right', LAND, PAD)).toEqual({ x: 1180 - 16 - 110, y: 120 });
    expect(pipAnchor('bottom-right', LAND, PAD).y).toBeCloseTo(820 - 20 - 96 - PIP_HEIGHT);
    // A Split View sliver too short for any vertical travel: no position
    // clears both bands, so the shortfall is SPLIT — every corner collapses
    // to the midpoint between the band edges. The old clamp parked the pip
    // at the top band edge and dropped the WHOLE 31.6pt shortfall on the
    // control row (review); split, each band gives up half.
    const SLIVER = { width: 320, height: 400 };
    const bandTop = 24 + 96;
    const bandBottom = 400 - 20 - 96 - PIP_HEIGHT;
    const sliverY = pipAnchor('bottom-left', SLIVER, PAD).y;
    expect(sliverY).toBeCloseTo((bandTop + bandBottom) / 2);
    // One position, whatever the corner claims to be.
    expect(pipAnchor('top-right', SLIVER, PAD).y).toBeCloseTo(sliverY);
    // The BOTTOM edge is the coordinate that touches the controls, so it is
    // the one pinned: the intrusion into the control band equals the
    // intrusion into the header band — symmetric, never all on the buttons.
    const controlBandEdge = 400 - 20 - 96;
    expect(sliverY + PIP_HEIGHT - controlBandEdge).toBeCloseTo(bandTop - sliverY);
    // And in a window with room, the split never engages: the bottom edge
    // stays strictly clear of the control band (the non-degenerate pin).
    const bl = pipAnchor('bottom-left', LAND, PAD);
    expect(bl.y + PIP_HEIGHT).toBeLessThanOrEqual(820 - 20 - 80);
  });

  it('clamps the drag inside the band — never under notch, header, controls or home bar', () => {
    expect(clampPip(-40, -200, FRAME, INSETS)).toEqual({ x: 16, y: 143 });
    const far = clampPip(9999, 9999, FRAME, INSETS);
    expect(far.x).toBe(264);
    expect(far.y).toBeCloseTo(844 - 34 - 96 - PIP_HEIGHT);
    // Inside the band the finger is obeyed — the pip is not on rails.
    expect(clampPip(100, 300, FRAME, INSETS)).toEqual({ x: 100, y: 300 });
  });

  it('a release snaps to the NEAREST corner — one per quadrant', () => {
    expect(nearestPipCorner(20, 150, FRAME, INSETS)).toBe('top-left');
    expect(nearestPipCorner(260, 150, FRAME, INSETS)).toBe('top-right');
    expect(nearestPipCorner(20, 500, FRAME, INSETS)).toBe('bottom-left');
    expect(nearestPipCorner(260, 500, FRAME, INSETS)).toBe('bottom-right');
    // Dead centre of the band ties up-left, deterministically.
    const midX = (16 + 264) / 2;
    const midY = (143 + pipAnchor('bottom-left', FRAME, INSETS).y) / 2;
    expect(nearestPipCorner(midX, midY, FRAME, INSETS)).toBe('top-left');
  });

  it('a tap-sized wobble is not a drag — the swap tap survives the pan', () => {
    // PhotoViewer's 12pt Manhattan threshold: at or under it the Pressable
    // keeps the gesture and tap-to-swap fires; past it the pan claims it.
    expect(pipDragClaims(0, 0)).toBe(false);
    expect(pipDragClaims(6, 6)).toBe(false); // exactly 12: still a tap
    expect(pipDragClaims(7, 6)).toBe(true);
    expect(pipDragClaims(0, -13)).toBe(true); // direction-agnostic
  });

  it('wires the pan onto the pip wrapper, tap contract intact', () => {
    const { tree, byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: true }),
      videoEnabled: true,
    });
    const wraps = tree.root.findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.onMoveShouldSetResponder === 'function',
    );
    // Exactly ONE draggable surface on the screen, and the labeled pip
    // Pressable lives inside it — still pressable, still hinting the swap.
    expect(wraps).toHaveLength(1);
    expect(
      wraps[0]!.findAll(n => n.props?.accessibilityLabel === 'Your video, small')
        .length,
    ).toBeGreaterThan(0);
    const pip = byLabel('Your video, small');
    expect(typeof pip.props.onPress).toBe('function');
    expect(pip.props.accessibilityHint).toBe('Tap to swap the two videos');
    // Never claims on touch DOWN — a tap must reach the Pressable. (Safe to
    // drive directly: PanResponder's start handler reads no touch history.)
    expect(wraps[0]!.props.onStartShouldSetResponder()).toBe(false);
    // And it does not surrender mid-drag: a claimed drag is not stolen back.
    expect(wraps[0]!.props.onResponderTerminationRequest()).toBe(false);
  });

  it('VoiceOver can move the pip — four corner actions on the pressable', () => {
    // The one-finger pan IS VoiceOver's navigation gesture, so the drag
    // alone leaves a screen-reader user unable to reposition at all: the
    // same four destinations are rotor actions on the pip's own button.
    const { byLabel } = renderScreen({
      state: state({ name: 'connected', video: true, peerVideo: true }),
      videoEnabled: true,
    });
    const pip = byLabel('Your video, small');
    expect(pip.props.accessibilityActions).toEqual(PIP_ACCESSIBILITY_ACTIONS);
    expect(PIP_ACCESSIBILITY_ACTIONS.map(a => a.name)).toEqual([
      'move-top-left',
      'move-top-right',
      'move-bottom-left',
      'move-bottom-right',
    ]);
    // Every action carries a spoken label — a bare name reads as nothing.
    for (const a of PIP_ACCESSIBILITY_ACTIONS) expect(a.label).toBeTruthy();
    // The handler routes through the SAME corner vocabulary the snap uses,
    // and system actions it does not own (magicTap, activate) map to null
    // rather than teleporting the pip.
    expect(pipCornerForAction('move-bottom-left')).toBe('bottom-left');
    expect(pipCornerForAction('move-top-right')).toBe('top-right');
    expect(pipCornerForAction('activate')).toBeNull();
    // Driving one settles without throwing — the wiring is live, not
    // metadata that fell off the element.
    ReactTestRenderer.act(() => {
      pip.props.onAccessibilityAction({ nativeEvent: { actionName: 'move-bottom-right' } });
    });
  });

  it('an audio-only call has no preview and nothing draggable', () => {
    const { tree } = renderScreen({ state: state({ video: false, peerVideo: false }) });
    expect(pipWrapper(tree)).toBeUndefined();
  });
});

/**
 * THE MINIMIZE CONTROL ("go back to the chat
 * from a video call while the video call is on"). The screen only renders
 * it when App.tsx offers it — a connected or reconnecting call on a
 * workspace route — so the header of every other call is exactly what it
 * always was; App.callminimize.test.tsx pins WHEN it is offered, this pins
 * what it is.
 */
describe('the minimize control', () => {
  it('is absent unless offered — the header is unchanged for a call that cannot minimize', () => {
    const { tree, byLabel } = renderScreen();
    expect(byLabel('Minimize call')).toBeUndefined();
    expect(tree.root.findAll(n => n.props.testID === 'call-minimize')).toHaveLength(0);
  });

  it('is a labeled button that says what it does, and fires onMinimize', () => {
    const onMinimize = jest.fn();
    const { byLabel, props } = renderScreen({ onMinimize });
    const button = byLabel('Minimize call');
    expect(button.props.accessibilityRole).toBe('button');
    // "Minimize" on a call screen could be read as ending it: the hint says
    // the call keeps going.
    expect(button.props.accessibilityHint).toMatch(/keeps the call going/i);
    ReactTestRenderer.act(() => button.props.onPress());
    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(props.onHangup).not.toHaveBeenCalled();
    // A 44pt target (HIG minimum).
    const flat = StyleSheet.flatten(
      typeof button.props.style === 'function'
        ? button.props.style({ pressed: false })
        : button.props.style,
    );
    expect(flat.width).toBe(44);
    expect(flat.height).toBe(44);
  });
});

describe('the notice restore tap', () => {
  it('is a labeled button that fires the restore when the cap is liftable', () => {
    const onRestoreQuality = jest.fn();
    const { tree } = renderScreen({
      state: state({ video: true }),
      pressureNotice: 'Low Power Mode',
      pressureRestorable: true,
      onRestoreQuality,
    });
    const button = tree.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        n.props?.accessibilityRole === 'button' &&
        /Tap to restore/.test(String(n.props?.accessibilityLabel)),
    )[0]!;
    expect(button).toBeTruthy();
    // Voice Control users activate controls by saying what they SEE, so the
    // accessible name must be the visible text, not a paraphrase of it —
    // asserted against the RENDERED children, so copy drift cannot leave a
    // stale label behind and quietly break "say what you see".
    expect(button.props.accessibilityLabel).toBe('Low Power Mode · Tap to restore');
    expect([button.props.children].flat().join('')).toBe(button.props.accessibilityLabel);
    expect(button.props.accessibilityHint).toMatch(/battery/i);

    ReactTestRenderer.act(() => button.props.onPress());
    expect(onRestoreQuality).toHaveBeenCalledTimes(1);
  });

  it('a thermal notice is not a button — a tap cannot cool a phone down', () => {
    const { tree } = renderScreen({
      state: state({ video: true }),
      pressureNotice: 'Reduced quality',
      pressureRestorable: false,
    });
    const notice = tree.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        n.props?.accessibilityLiveRegion === 'polite' &&
        String(n.props?.children).includes('Reduced quality'),
    )[0]!;
    expect(notice).toBeTruthy();
    expect(notice.props.onPress).toBeUndefined();
    expect(notice.props.accessibilityRole).toBeUndefined();
  });
});
