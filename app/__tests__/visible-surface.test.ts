/**
 * The visible-surface model.
 *
 * Two halves, one invariant:
 *
 * 1. THE MATRIX — the pure model's answers for every route in the 20-name
 *    union under every overlay state, pinned PER CELL with no blanket
 *    expectation. For every NO-OVERLAY case the derived facts must equal
 *    the previous route-name-string answers longhand — the expectation table
 *    below IS today's behavior, written out, not re-derived — so the
 *    extraction provably changes nothing in compact except the recorded
 *    divergence. Each row also states its own answer for "a call
 *    overlay is on glass": AS AMENDED, that answer is `covered` for every route — the three
 *    capture-exempt routes are the DIVERGENT cells (previously uncovered) and
 *    each carries its reachability evidence inline. Screenshot disclosure
 *    fires for thread/photoViewer and nothing else — peerProfile carries a
 *    peerId and must NOT disclose.
 *
 * 2. THE DEFECT REGRESSION — written FIRST, red on the pre-extraction App.tsx: a locked route
 *    with a live call overlay and active capture renders the cover. Before
 *    the fix, `blankableRoute` exempted `locked` by route name while the
 *    call — a router sibling mounted below the cover precisely so recording
 *    blanks it — was composited over the lock screen uncovered. The same
 *    test also pins both edges of the fix: locked with NO overlay stays
 *    uncovered (duress-unlock while mirroring must remain possible), and
 *    the cover leaves with the overlay.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { CallScreen } from '../src/screens/CallScreen';
import * as api from '../src/api';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import {
  compactVisibleSurface,
  deriveSurfaceFacts,
  type OverlayFacts,
  type SurfaceRouteName,
  type VisibleRoute,
} from '../src/visibleSurface';

// --- half 1: the matrix -----------------------------------------------------

const PEER = '01HQBBBB00000000000000000A';

/**
 * Today's route-name answers, LONGHAND — one row per name in the 20-route
 * union. cover = the old `blankableRoute` answer with NO overlay (everything except
 * locked/landing/loading); coverWithCall = the row's OWN answer for "a live
 * call overlay is on glass" (the design as amended: covered on every route — the
 * three rows where this diverges from `cover` are the recorded cells, each
 * annotated); workspace = the preview-lease gate's list (everything except
 * locked/loading/landing/register); redeem = the warm-tap begin gate
 * (everything except landing/register); land = the redemption landing gate
 * (everything except locked); disclose = the screenshot-notice routes
 * (thread/photoViewer only, to their peer).
 */
const ROUTE_MATRIX: ReadonlyArray<{
  route: VisibleRoute;
  cover: boolean;
  coverWithCall: boolean;
  workspace: boolean;
  redeem: boolean;
  land: boolean;
  disclose: readonly string[];
}> = [
  // DIVERGENT CELLS (loading × 1:1/group/both — as amended, uncovered
  // before the change): REACHABLE BY DESIGN. `startCalling` runs at App mount,
  // deliberately before the verdict; a VoIP wake drives the cold ring
  // (src/call/index.ts:1062) and the group ring's lock-screen restore
  // admits pre-verdict (`learnSelfIdForRingService`) — all while the route
  // sits at 'loading' until boot's `lock.status()` resolves. The cold-ring
  // window IS the loading window.
  { route: { name: 'loading' }, cover: false, coverWithCall: true, workspace: false, redeem: true, land: true, disclose: [] },
  // DIVERGENT CELL (locked × call): the ORIGINAL the design defect — a screen
  // recording captured an incoming ring or the other person's face
  // composited over the lock screen. Locked with NO overlay stays
  // uncovered: duress-unlock while mirroring must remain possible.
  { route: { name: 'locked' }, cover: false, coverWithCall: true, workspace: false, redeem: true, land: false, disclose: [] },
  // DIVERGENT CELLS (landing × 1:1/group/both — as amended):
  // EDGE-CONSTRUCTIBLE. Only relock and account deletion end calls
  // (`endCallOnQuiesce`, `disposeGroupCall`); the unlock arms do not — so
  // an unlock that finds no profile or a gone identity routes to landing
  // with a pre-verdict ring still on glass. (A fresh install cannot ring —
  // no registration — but the heal/identity-gone paths can.)
  { route: { name: 'landing' }, cover: false, coverWithCall: true, workspace: false, redeem: false, land: true, disclose: [] },
  { route: { name: 'register' }, cover: true, coverWithCall: true, workspace: false, redeem: false, land: true, disclose: [] },
  { route: { name: 'chats' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'calls' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'attention' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'newChat' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'newRoom' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'thread', peerId: PEER }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [PEER] },
  { route: { name: 'profile' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'settings' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  // peerProfile CARRIES a peerId and shows no conversation content: a
  // disclosure here would manufacture false evidence. Keyed on the name.
  { route: { name: 'peerProfile', peerId: PEER }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'groupProfile' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'photoViewer', peerId: PEER }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [PEER] },
  // Device linking (the routes join THROUGH
  // the visible-surface module). Ordinary workspace surfaces to every
  // consumer: covered during capture — a ceremony code mirrored to a
  // projector is exactly what the cover exists for — proving a workspace,
  // redeemable/landable, and disclosing no conversation content (the
  // peerProfile precedent: naming a device is not showing a message).
  { route: { name: 'linkDevice' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'linkConfirm' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'linkedDevices' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  // Identifier + discovery + recovery.
  // accountEmail and discover are ordinary workspace surfaces (typed
  // addresses on glass are exactly what the capture cover exists for);
  // recover is REGISTER-CLASS: reachable from the landing surface before
  // any profile or verdict exists, so it proves no workspace and refuses
  // push-tap redemption — the conservative answer fails safe on its
  // post-registration visits too.
  { route: { name: 'accountEmail' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  // The phone surface: accountEmail's
  // sibling, and the same ordinary workspace surface to every consumer —
  // dark behind the build pin, but the facts hold either way.
  { route: { name: 'accountPhone' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  // The username surface: the
  // identifier siblings' sibling, the same ordinary workspace surface to
  // every consumer — dark behind USERNAME_UI_ENABLED, facts hold either way.
  { route: { name: 'accountUsername' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'discover' }, cover: true, coverWithCall: true, workspace: true, redeem: true, land: true, disclose: [] },
  { route: { name: 'recover' }, cover: true, coverWithCall: true, workspace: false, redeem: false, land: true, disclose: [] },
  // The update wall (§9 rule 9 a fourth time): an
  // EMPTY screen with a title, a sentence and two controls, standing in
  // front of a workspace that was never opened. Exempt from the capture
  // cover with locked/landing/loading for their reason — there is nothing
  // on it to read, and covering it would leave a mirroring person no way to
  // reach the store button. Register-class to every other consumer: it
  // proves no workspace (`messaging.start` is never reached from here) and
  // redeems no push tap, since a consumed intent would have no thread to
  // land in. A call overlay covers it as it covers every route (§3.8).
  // `land: false` with the lock screen, and for the same shape of reason:
  // an intent consumed on `chats` a moment before the wall went up must not
  // resolve INTO the wall and open a thread on top of it.
  { route: { name: 'updateRequired' }, cover: false, coverWithCall: true, workspace: false, redeem: false, land: false, disclose: [] },
];

const OVERLAY_STATES: ReadonlyArray<{ label: string; overlays: OverlayFacts }> = [
  { label: 'no overlay', overlays: { call: false, groupCall: false } },
  { label: '1:1 call overlay', overlays: { call: true, groupCall: false } },
  { label: 'group call overlay', overlays: { call: false, groupCall: true } },
  { label: 'both call overlays', overlays: { call: true, groupCall: true } },
];

test('the matrix covers the whole 24-name Route union, each name once', () => {
  // accountPhone, accountUsername and updateRequired joined through the
  // visibility module; the payload-free AI attention inbox is the 24th
  // route, an ordinary workspace surface.
  const names = ROUTE_MATRIX.map(c => c.route.name);
  expect(names).toHaveLength(24);
  expect(new Set(names).size).toBe(24);
  // Compile-time: the union has no 25th name the table missed.
  const all: SurfaceRouteName[] = names;
  expect(all).toBeDefined();
});

describe.each(OVERLAY_STATES)('$label', ({ overlays }) => {
  const anyOverlay = overlays.call || overlays.groupCall;
  test.each(ROUTE_MATRIX.map(c => [c.route.name, c] as const))(
    'route %s derives its pinned per-cell answers',
    (_name, expected) => {
      const facts = deriveSurfaceFacts({ routes: [expected.route], overlays });
      // The cover answer is the ROW'S OWN per-cell pin, not a blanket rule:
      // `cover` with no overlay (the old route-name answer), the row's
      // `coverWithCall` under any call overlay (the design as amended — the
      // divergent cells are annotated in the table). Everything else must
      // match the no-overlay answer exactly — an overlay proves nothing
      // about the lock verdict, so it may not renew a lease, redeem a tap,
      // or add a disclosure target.
      expect(facts.captureCoverApplies).toBe(
        anyOverlay ? expected.coverWithCall : expected.cover,
      );
      expect(facts.provesWorkspaceOpen).toBe(expected.workspace);
      expect(facts.pushNavRedeemable).toBe(expected.redeem);
      expect(facts.pushNavLandable).toBe(expected.land);
      expect([...facts.screenshotDisclosureTo]).toEqual([...expected.disclose]);
    },
  );
});

test('compactVisibleSurface mirrors the sibling render conditions exactly', () => {
  const route: VisibleRoute = { name: 'chats' };
  const ctx = {} as object;
  // Idle machine: no overlay, whatever the context slot holds.
  expect(
    compactVisibleSurface(route, { call: { name: 'idle', call: null }, groupCall: null })
      .overlays,
  ).toEqual({ call: false, groupCall: false });
  // Every non-idle state with a call context is on glass: incoming_ringing
  // renders IncomingCallScreen, every other non-idle state renders
  // CallScreen — the union is exactly "non-idle with a context".
  for (const name of [
    'outgoing_connecting',
    'outgoing_ringing',
    'incoming_ringing',
    'incoming_answering',
    'connected',
    'reconnecting',
    'ending',
  ]) {
    expect(
      compactVisibleSurface(route, { call: { name, call: ctx }, groupCall: null })
        .overlays.call,
    ).toBe(true);
  }
  // A group session view on glass is the group overlay.
  expect(
    compactVisibleSurface(route, { call: { name: 'idle', call: null }, groupCall: ctx })
      .overlays.groupCall,
  ).toBe(true);
  // THE MINIMIZED CALL did not fork this fact: App.tsx swaps the
  // full CallScreen for the small CallOverlay window INSIDE the same
  // non-idle condition, so the states the window can show are the 1:1
  // overlay on glass exactly as the full screen is — the other person's
  // face in a corner is still their face, and the cover still applies.
  // The model knows nothing about "minimized", on purpose; the render side
  // is pinned in App.callminimize.test.tsx (cover over a minimized call).
  for (const name of ['connected', 'reconnecting', 'ending']) {
    expect(
      compactVisibleSurface(route, { call: { name, call: ctx }, groupCall: null })
        .overlays.call,
    ).toBe(true);
  }
});

// --- half 2: the defect regression, against the real App ---------------

const CID = '01HQCA11000000000000000AAA';

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  hasIdentity: jest.Mock;
};
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { reset: () => void };
  }
).__sqlite;
const callEvents = (
  jest.requireMock('tacendum-call') as unknown as {
    __call: { emit: (n: string, p: unknown) => void };
  }
).__call;
const screensec = (
  jest.requireMock('tacendum-screen-security') as {
    __screensec: { emitCaptured: (captured: boolean) => void };
  }
).__screensec;

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(React.createElement(App));
  });
  mounted.push(tree);
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  return tree;
}

function coverCount(tree: ReactTestRenderer.ReactTestRenderer): number {
  return tree.root.findAll(node => node.props.testID === 'capture-cover')
    .length;
}

describe('the capture-cover contract against the real App', () => {
  beforeEach(async () => {
    calling.resetCallingForTests();
    messaging.stop();
    await db.close();
    db.setWorkspace('real');
    session.setMode('real');
    crypto.__keychain.clear();
    crypto.hasIdentity.mockResolvedValue(true);
    sqlite.reset();
    jest.clearAllMocks();
    // The transport, spied as App.relockcall.test.tsx spies it: this file is
    // about what is ON GLASS, not about the ratchet or the relay.
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    // No relay in this fixture, decided instantly — the real path would wait
    // out a credential timeout against jest's dead fetch.
    jest
      .spyOn(api, 'apiTurnCredentials')
      .mockRejectedValue(new Error('no relay in tests'));
  });

  afterEach(async () => {
    // Drive the real screen-security service back to rest before unmounting.
    await ReactTestRenderer.act(async () => {
      screensec.emitCaptured(false);
    });
    await ReactTestRenderer.act(async () => {
      while (mounted.length) mounted.pop()!.unmount();
    });
    calling.resetCallingForTests();
    jest.restoreAllMocks();
    crypto.hasIdentity.mockResolvedValue(false);
    await db.close();
  });

  test('locked route with a live call overlay and active capture renders the cover (written first, red on the prior App.tsx)', async () => {
    const tree = await renderApp();

    // The lock screen alone, captured: UNCOVERED — a person must be able to
    // unlock, or duress-unlock, while mirroring. True before AND after the change.
    await ReactTestRenderer.act(async () => {
      devNav()({ name: 'locked' });
    });
    await ReactTestRenderer.act(async () => {
      screensec.emitCaptured(true);
    });
    expect(coverCount(tree)).toBe(0);

    // A live call arrives on glass while the capture is still running. Calls
    // are router SIBLINGS: they render over any route and start before the
    // lock verdict by design, so this composition ships.
    await ReactTestRenderer.act(async () => {
      await calling.callController().placeCall(PEER, CID, false);
      callEvents.emit('iceState', { cid: CID, state: 'connected' });
      await flush();
    });
    expect(calling.callController().state.name).toBe('connected');
    // The call surface IS composited over the locked route…
    expect(tree.root.findAllByType(CallScreen).length).toBe(1);
    // …so the cover MUST render over it. Before the fix this is 0: blankableRoute
    // exempted `locked` by route name and the recording captured the call —
    // the other person's face — uncovered. THE defect assertion.
    expect(coverCount(tree)).toBeGreaterThan(0);

    // The overlay leaves; the exemption returns. The cover is keyed to the
    // visible surface, not latched.
    await ReactTestRenderer.act(async () => {
      await calling.callController().hangup();
      await flush();
    });
    expect(calling.callController().state.name).toBe('idle');
    expect(coverCount(tree)).toBe(0);

    await ReactTestRenderer.act(async () => {
      screensec.emitCaptured(false);
    });
  });

  test('a screenshot during a call over the lock screen discloses nothing — no conversation is visible', async () => {
    // The disclosure path is NOT implicated by the design:
    // disclosure keys off thread/photoViewer content, and a call
    // overlay adds no disclosure target. Pinned so the fix cannot creep.
    const spy = jest
      .spyOn(messaging, 'sendScreenshotNotice')
      .mockResolvedValue(undefined);
    const tree = await renderApp();
    await ReactTestRenderer.act(async () => {
      devNav()({ name: 'locked' });
    });
    await ReactTestRenderer.act(async () => {
      await calling.callController().placeCall(PEER, CID, false);
      callEvents.emit('iceState', { cid: CID, state: 'connected' });
      await flush();
    });
    const emitShot = (
      jest.requireMock('tacendum-screen-security') as {
        __screensec: { emitScreenshot: () => void };
      }
    ).__screensec;
    await ReactTestRenderer.act(async () => {
      emitShot.emitScreenshot();
    });
    expect(spy).not.toHaveBeenCalled();
    // Sanity: the fixture CAN disclose — same tree, thread route, one notice.
    await ReactTestRenderer.act(async () => {
      devNav()({ name: 'thread', peerId: PEER });
    });
    await ReactTestRenderer.act(async () => {
      emitShot.emitScreenshot();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(PEER);
    await ReactTestRenderer.act(async () => {
      await calling.callController().hangup();
      await flush();
    });
    void tree;
  });
});
