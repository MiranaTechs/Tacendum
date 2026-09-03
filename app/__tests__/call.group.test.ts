import { CALL_CONNECT_TIMEOUT_MS, type GroupCallEnvelope } from '@tacendum/shared';
import {
  DEPARTED_LEG_TEARDOWN_MS,
  GROUP_SIGNAL_PACING,
  GroupCallCoordinator,
  GroupCallRefusedError,
  PUSH_MIRROR_PACING,
  type GroupCallDeps,
  type GroupCallNative,
  type GroupCallStore,
  type GroupCallView,
} from '../src/call/group';
import { GINVITE_REOFFER_DELAYS_MS } from '@tacendum/shared/call-session';
import {
  CallController,
  type CallNativeBridge,
  type GroupRouter,
} from '../src/call/controller';
import type { CallLogRow, CallMetricSink } from '../src/call/service';
import { decideRing } from '../src/call/policy';
import { shortId } from '../src/person';
import * as nativeModule from 'tacendum-call';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';

/**
 * SMALL-GROUP CALLS, THE APP HALF.
 *
 * `groupSessionReducer` is proved pure and exhaustively at the shared layer;
 * what is proved HERE is everything the reducer deliberately cannot know — the
 * executor. Each `describe` below answers one Verify line, and each names the
 * mutation that was run to prove it can fail. A test nobody has watched go red
 * is a test nobody has tested.
 *
 * The harness is deliberately real: a real `GroupCallCoordinator`, real
 * `CallService`s per leg, the real shipped `callReducer` inside them, the real
 * pacing bucket. Only the four edges are faked — native, transport, store, and
 * the clock — so a failure here is a failure of this code and not of a mocking
 * framework.
 */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A REAL 26-character Crockford ULID. The shipped zod schema validates every
 * id on an inbound envelope, and a placeholder would silently exercise the
 * rejection path instead of the routing this file means to check. */
function ulid(seed: string): string {
  const base = `01HQ${seed}`;
  let out = base.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '0');
  while (out.length < 26) out += B32[(out.length * 7) % 32];
  return out.slice(0, 26);
}

const SELF = ulid('SELF');
const STARTER = ulid('START');
const B = ulid('BBBB');
const C = ulid('CCCC');
const D = ulid('DDDD');
const E = ulid('EEEE');
const F = ulid('FFFF');
const STRANGER = ulid('XXXX');
const ROOM = ulid('R00M');
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';
const ANSWER_SDP = 'v=0\r\na=fingerprint:sha-256 CC:DD\r\nANSWER';
const BASE = 1_800_000_000_000;

interface SentFrame {
  at: number;
  peerId: string;
  envelope: { tcm: string; [k: string]: unknown };
  urgent: boolean;
}

interface Harness {
  co: GroupCallCoordinator;
  sent: SentFrame[];
  trace: string[];
  logs: (CallLogRow & { sessionId: string | null; roomId: string | null })[];
  store: GroupCallStore;
  sessions: Map<string, { sid: string; roster: string[]; starterId: string }>;
  offers: Map<string, { cid: string; peerId: string; sid: string; exp: number }>;
  native: jest.Mocked<GroupCallNative>;
  metrics: jest.Mocked<CallMetricSink>;
  now: () => number;
  advance: (ms: number) => void;
  minted: string[];
  reportMinted: string[];
  /**
   * EVERY VIEW THIS COORDINATOR PUBLISHED, in order.
   *
   * The screen is a subscriber, not a poller: a view that was true for one
   * notify and corrected on the next was still shown. So the session-fence
   * assertions read the published SEQUENCE, not only the final state — a
   * winner's first frame carrying a loser's timestamp is exactly the defect,
   * and reading `co.view` afterwards cannot see it.
   */
  views: (GroupCallView | null)[];
  /** Every peer the ring gate was asked about, in order. Its EMPTINESS is an
   * assertion too: an invite into a live session must never be judged as a
   * caller reaching this phone. */
  ringChecks: string[];
  /** Every peer routed to the controller's decided-cancellation path, in
   * order — the group arm of the 1:1 `call.end` branch. */
  ringCancels: string[];
  deliver: (from: string, envelope: unknown, ts?: number) => Promise<void>;
  frames: (tcm?: string) => SentFrame[];
}

interface Options {
  blocked?: Set<string>;
  identityChanged?: Set<string>;
  duress?: boolean;
  oneToOneBusy?: boolean;
  /** Peers whose VoIP PLACEHOLDER the person already declined. Consumed. */
  pushDeclined?: Set<string>;
  /**
   * THE PLACEHOLDER NATIVE SAYS IS RINGING, per peer — the controller's
   * `ringCidFor`, which a dismissal names so it cannot end a placeholder it
   * was never about.
   *
   * Absent map ⇒ NO DEP AT ALL, exactly like the CLI wiring and like a JS
   * build running ahead of the binary: every dismissal then degrades to the
   * caller-keyed match, which is what the other tests in this file assert.
   */
  ringCids?: Map<string, string>;
  /** Forward the coordinator's decided-cancellation report onward — how the
   * seam block below wires it into a REAL controller. */
  onRingCancelled?: (peerId: string) => void;
  audioApply?: (cid: string) => boolean;
  /** The audio-route call rejects — an unreachable bridge, or an audio session
   * that will not take the override. There is no `applied` verdict to fake:
   * `setSpeaker` resolves void, so refusal only has the one expression. */
  speakerRejects?: boolean;
  /**
   * THE ROOM, AS IT STANDS AT THE MOMENT SOMEBODY PRESSES ADD.
   *
   * Keyed by room id; a `null` value is a room this device could not read at
   * all, which is a different answer from an empty room and must not be
   * mistaken for one. Absent map ⇒ every room reads null, so a test that means
   * to add somebody has to say which room holds them.
   */
  roomMembers?: Map<string, readonly string[] | null>;
  /**
   * Stored display names for the CXCall-label tests. When present, an id
   * absent from the map resolves exactly as the production dep does for a
   * nameless peer — `personName`'s shortId fallback — so a test can hold
   * someone nameless. Absent ⇒ the harness default `name:<id>` (everyone
   * known), which every other test in this file assumes.
   */
  displayNames?: Map<string, string>;
  /** `displayNameFor` throws — the database closed under the read. */
  displayNameThrows?: boolean;
  /** The room's local name (`roomNameFor`'s answer). Absent map ⇒ no dep,
   * exactly like the CLI. */
  roomNames?: Map<string, string>;
  selfId?: string | null;
  seedSession?: { sid: string; roomId: string | null; starterId: string; roster: string[]; se: number; video: boolean; startedAt: number };
  seedOffers?: { cid: string; peerId: string; sdp: string; video: boolean; exp: number; serverTs: number; sid: string | null }[];
  /**
   * LATCHES ACROSS ONE AWAIT EACH.
   *
   * The remaining defects are all the same shape — something happens
   * WHILE the coordinator is suspended in an await — so the harness has to be
   * able to hold it there. Each hook below is awaited at the point its name
   * says, which lets a test interleave a relock, a second CallKit event or a
   * lock-screen decline exactly where the phone can. Absent ⇒ identity, so
   * every other test in this file is unchanged.
   */
  beforeCredentials?: () => Promise<void>;
  beforeTakeOffers?: () => Promise<void>;
  beforeDisplayName?: () => Promise<void>;
  /** Held inside the ROOM FOLD, which is `addParticipant`'s one database read
   * — and the await a whole session can end and be replaced inside. */
  beforeRoomMembers?: () => Promise<void>;
  /** Held inside the TRANSPORT, keyed by frame kind. A teardown announce
   * (`call.end`) suspends the coordinator AFTER the reducer has collapsed the
   * session to null and BEFORE `releaseGroupCall` — the vulnerable window. */
  beforeSend?: (tcm: string) => Promise<void>;
  /** Held inside `closeSessionRow`, which runs immediately AFTER
   * `releaseGroupCall`: the other side of the same window. */
  beforeDeleteSession?: () => Promise<void>;
  /** Held inside a LEG's history-row write — the last effect of a leg
   * service's teardown, after its peer connection is already closed. A leg
   * parked here is one the session already counts as `left`. */
  beforeWriteLog?: () => Promise<void>;
  /** Held inside the NATIVE offer creation — i.e. inside a leg
   * `CallService`'s own effect loop, one layer below the coordinator's fence. */
  beforeCreateOffer?: () => Promise<void>;
  /** Held inside the PACER'S wait. Unlike `beforeSend`, this is before the
   * empty push-mirror verdict is dispatched, which is the race under test. */
  beforeDelay?: (ms: number) => Promise<void>;
  /**
   * Held inside `mintId` — the ONE await both answer paths and the re-offer
   * timer suspend in. Each crosses the native bridge for entropy and each
   * DISPATCHES on the far side of it, so this is the only place a test can
   * stand between the press and the dispatch it turns into.
   */
  beforeMintId?: () => Promise<void>;
  /** Held inside the AUDIO-ROUTE call — the one await `setSpeakerEnabled` has,
   * and therefore the only place a session can end underneath it. */
  beforeSetSpeaker?: () => Promise<void>;
  /**
   * The setting. **OFF by default HERE and ON by default in production**,
   * deliberately: every other test in this file predates the gate and rings
   * from ids it never exchanged a message with, so a harness that defaulted
   * the way the phone does would silence the whole file and prove nothing.
   * The tests that mean to exercise the gate say so.
   */
  silenceUnknown?: boolean;
  /** Peers this device HAS exchanged a message with — `hasHistory`,
   * which production reads as a `chats` row carrying a `lastMessageAt`. */
  known?: Set<string>;
  /** The verdict throws: the database closed under the read. Its answer is
   * the one fallback in the coordinator that fails toward quiet. */
  mayRingThrows?: boolean;
  /** The TURN preflight failed; a call must not mint reporting authority. */
  credentialsRejects?: boolean;
  /** Proves one telemetry outage cannot stop later session effects. */
  metricOpenRejects?: boolean;
}

/** A promise a test opens by hand. The whole point is that nothing resolves
 * it until the interleaving under test has happened. */
function latch(): { held: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  return { held, release };
}

/** Drain the microtask queue. `dispose()` is SYNCHRONOUS and its destructive
 * work is deliberately fire-and-forget — a locked phone must not wait on the
 * bridge — so the assertions about what it did need somewhere to land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function harness(opts: Options = {}): Harness {
  const sent: SentFrame[] = [];
  const trace: string[] = [];
  const logs: Harness['logs'] = [];
  const ringChecks: string[] = [];
  const ringCancels: string[] = [];
  let clock = BASE;
  let mintCounter = 0;
  let reportMintCounter = 0;
  const minted: string[] = [];
  const reportMinted: string[] = [];

  const sessionRows = new Map<string, any>();
  if (opts.seedSession) sessionRows.set(opts.seedSession.sid, { ...opts.seedSession });
  const offerRows = new Map<string, any>();
  for (const o of opts.seedOffers ?? []) offerRows.set(o.cid, { ...o });

  const nativeFn = (name: string, result: unknown = undefined) =>
    jest.fn(async (...args: unknown[]) => {
      trace.push(`${name}(${args.map(a => JSON.stringify(a)).join(',')})`);
      return result;
    });

  /**
   * THE PEER CONNECTIONS THAT EXIST, by cid — born in `createOffer` /
   * `createAnswer`, gone at `close`. The shipped native answers `false` to a
   * track change on a cid it holds no connection for (`call(cid)?… ?? false`),
   * and the fake used to answer `true` for ANY cid, which is exactly how a
   * mute during a paced dial closing not-yet-opened legs stayed invisible
   * here. */
  const liveCids = new Set<string>();
  const native = {
    configure: nativeFn('configure'),
    createOffer: jest.fn(async (cid: string, withVideo: boolean) => {
      trace.push(`createOffer(${JSON.stringify(cid)},${JSON.stringify(withVideo)})`);
      await opts.beforeCreateOffer?.();
      liveCids.add(cid);
      return SDP;
    }),
    createAnswer: jest.fn(async (...args: unknown[]) => {
      trace.push(`createAnswer(${args.map(a => JSON.stringify(a)).join(',')})`);
      liveCids.add(String(args[0]));
      return ANSWER_SDP;
    }),
    setRemoteAnswer: nativeFn('setRemoteAnswer'),
    addIceCandidates: nativeFn('addIceCandidates'),
    restartIce: nativeFn('restartIce', SDP),
    close: jest.fn(async (cid: string) => {
      trace.push(`close(${JSON.stringify(cid)})`);
      liveCids.delete(cid);
    }),
    reportOutgoingCall: nativeFn('reportOutgoingCall'),
    reportOutgoingConnected: nativeFn('reportOutgoingConnected'),
    reportIncomingCall: nativeFn('reportIncomingCall'),
    endCall: nativeFn('endCall'),
    dismissPendingIncomingCall: nativeFn('dismissPendingIncomingCall'),
    answerReportedCall: nativeFn('answerReportedCall'),
    setAudioEnabled: jest.fn(async (cid: string, on: boolean) => {
      trace.push(`setAudioEnabled(${cid},${on})`);
      if (!liveCids.has(cid)) return false;
      return opts.audioApply ? opts.audioApply(cid) : true;
    }),
    setVideoEnabled: jest.fn(async (cid: string) => liveCids.has(cid)),
    // Resolves void, exactly as the bridge does: there is no applied verdict
    // for an output route, so a test that could assert one would be asserting
    // against a fiction. `speakerRejects` is how a failure is expressed.
    setSpeaker: jest.fn(async (cid: string, on: boolean) => {
      trace.push(`setSpeaker(${cid},${on})`);
      if (opts.speakerRejects) throw new Error('no audio session');
      await opts.beforeSetSpeaker?.();
    }),
  } as unknown as jest.Mocked<GroupCallNative>;

  const metrics = {
    open: jest.fn(async (_input: Parameters<CallMetricSink['open']>[0]): Promise<void> => {
      if (opts.metricOpenRejects) throw new Error('metrics unavailable');
    }),
    answered: jest.fn(async (_localId: string, _at: number): Promise<void> => undefined),
    connected: jest.fn(async (_localId: string, _at: number): Promise<void> => undefined),
    peak: jest.fn(async (_localId: string, _participants: number): Promise<void> => undefined),
    finalize: jest.fn(async (
      _localId: string,
      _reason: Parameters<CallMetricSink['finalize']>[1],
      _endedAt: number,
    ): Promise<void> => undefined),
    discard: jest.fn(async (_localId: string): Promise<void> => undefined),
  } as jest.Mocked<CallMetricSink>;

  const store: GroupCallStore = {
    saveSession: async row => {
      trace.push(`saveSession(${row.sid})`);
      sessionRows.set(row.sid, { ...row });
    },
    loadSession: async () => {
      const rows = [...sessionRows.values()].sort((a, b) => b.startedAt - a.startedAt);
      return rows[0] ?? null;
    },
    deleteSession: async sid => {
      await opts.beforeDeleteSession?.();
      trace.push(`deleteSession(${sid})`);
      sessionRows.delete(sid);
    },
    saveOffer: async offer => {
      trace.push(`saveOffer(${offer.cid})`);
      offerRows.set(offer.cid, { ...offer });
    },
    takeOffersForSession: async sid => {
      // The latch sits BEFORE the select-then-delete, which is the whole
      // non-transactional window `restore` used to run outside any queue.
      await opts.beforeTakeOffers?.();
      const taken = [...offerRows.values()].filter(o => o.sid === sid);
      for (const o of taken) offerRows.delete(o.cid);
      return taken;
    },
    deleteOffersForSession: async sid => {
      trace.push(`deleteOffers(${sid})`);
      for (const o of [...offerRows.values()]) if (o.sid === sid) offerRows.delete(o.cid);
    },
    writeLog: async row => {
      await opts.beforeWriteLog?.();
      trace.push(`log(${row.peerId},${row.reason},${row.sessionId ?? 'null'})`);
      logs.push(row);
    },
  };

  const views: (GroupCallView | null)[] = [];
  const deps: GroupCallDeps = {
    selfId: () => (opts.selfId === undefined ? SELF : opts.selfId),
    native,
    transport: {
      sendCallEnvelope: async (peerId, envelope, o) => {
        await opts.beforeSend?.(envelope.tcm);
        sent.push({ at: clock, peerId, envelope: envelope as never, urgent: o.urgent });
        trace.push(`send(${peerId},${envelope.tcm})`);
      },
      sendGroupCallEnvelope: async (peerId, envelope, o) => {
        await opts.beforeSend?.(envelope.tcm);
        sent.push({ at: clock, peerId, envelope: envelope as never, urgent: o.urgent });
        trace.push(`send(${peerId},${envelope.tcm})`);
      },
    },
    store,
    displayNameFor: async id => {
      await opts.beforeDisplayName?.();
      if (opts.displayNameThrows) throw new Error('db closed');
      if (opts.displayNames) return opts.displayNames.get(id) ?? shortId(id);
      return `name:${id}`;
    },
    ...(opts.roomNames
      ? {
          roomNameFor: async (roomId: string) =>
            opts.roomNames!.get(roomId) ?? '',
        }
      : {}),
    mayCall: async peerId => {
      if (opts.blocked?.has(peerId)) return { allowed: false, reason: 'blocked' };
      if (opts.identityChanged?.has(peerId)) return { allowed: false, reason: 'identity_changed' };
      return { allowed: true };
    },
    isBlockedLocally: peerId => opts.blocked?.has(peerId) === true,
    // THE SHIPPED RULE, not a restatement of it: `decideRing` is imported and
    // run, so a test here fails if the policy module changes its mind. Only
    // the three facts are faked, which is exactly what production's wiring
    // supplies (`index.ts`: a `chats` row's `lastMessageAt`, the persisted
    // setting, and messaging's blocked set).
    mayRing: async peerId => {
      ringChecks.push(peerId);
      if (opts.mayRingThrows) throw new Error('db closed');
      return decideRing({
        silenceUnknownCallers: opts.silenceUnknown === true,
        hasHistory: opts.known?.has(peerId) === true,
        blocked: opts.blocked?.has(peerId) === true,
      });
    },
    roomMembers: async roomId => {
      trace.push(`roomMembers(${roomId})`);
      await opts.beforeRoomMembers?.();
      return opts.roomMembers?.get(roomId) ?? null;
    },
    inDuress: () => opts.duress === true,
    // The 1:1 controller's tombstone, consumed exactly as the real one is:
    // one decline answers one invite and cannot ambush the next.
    takePushDecline: peerId => opts.pushDeclined?.delete(peerId) === true,
    ...(opts.ringCids
      ? { ringCidFor: (peerId: string) => opts.ringCids!.get(peerId) ?? '' }
      : {}),
    noteRingCancelled: (peerId: string) => {
      ringCancels.push(peerId);
      opts.onRingCancelled?.(peerId);
    },
    oneToOneBusy: () => opts.oneToOneBusy === true,
    ensureCredentials: async () => {
      trace.push('ensureCredentials()');
      await opts.beforeCredentials?.();
      if (opts.credentialsRejects) throw new Error('credentials unavailable');
    },
    mintId: async () => {
      // Guarded rather than `await opts.beforeMintId?.()`: every start mints
      // N+1 times, and an unconditional extra microtask would re-time every
      // other test in this file for a hook they do not use.
      if (opts.beforeMintId) await opts.beforeMintId();
      const id = ulid(`M${mintCounter++}`);
      minted.push(id);
      return id;
    },
    mintReportId: async () => {
      const reportId = `REPORT-GROUP-${reportMintCounter++}`;
      reportMinted.push(reportId);
      return reportId;
    },
    metrics,
    now: () => clock,
    // A DELAY THAT ADVANCES THE VIRTUAL CLOCK. The pacer's only way to spend
    // time is this call, so the frame timestamps recorded above are exactly
    // the spacing the bucket imposed — measured, not simulated.
    delay: async ms => {
      await opts.beforeDelay?.(ms);
      clock += ms;
    },
    onChange: v => {
      views.push(v);
    },
  };

  const co = new GroupCallCoordinator(deps);
  created.push(co);
  return {
    co,
    sent,
    trace,
    logs,
    store,
    sessions: sessionRows as never,
    offers: offerRows as never,
    native,
    metrics,
    now: () => clock,
    advance: ms => {
      clock += ms;
    },
    minted,
    reportMinted,
    views,
    ringChecks,
    ringCancels,
    deliver: async (from, envelope, ts = clock) => {
      if (!co.handles(from, envelope)) return;
      await co.handle(from, envelope, { msgId: 'm', ts });
      await co.whenIdle();
    },
    frames: tcm => (tcm ? sent.filter(f => f.envelope.tcm === tcm) : sent),
  };
}

const created: GroupCallCoordinator[] = [];
afterEach(() => {
  for (const c of created.splice(0)) c.dispose();
});

function ginvite(fields: {
  sid: string;
  cid: string;
  r: string[];
  vid?: boolean;
  exp?: number;
}): GroupCallEnvelope {
  return {
    tcm: 'call.ginvite',
    sid: fields.sid,
    cid: fields.cid,
    r: fields.r,
    sdp: SDP,
    vid: fields.vid ?? false,
    exp: fields.exp ?? BASE + 60_000,
  };
}

/** The cid the coordinator LAST dialled a given peer under. Last, not first:
 * a re-offer mints a fresh cid, and so does a second session — a helper
 * that answered with a dead cid would silently test the ignore path. */
function dialledCid(h: Harness, peerId: string): string {
  for (let i = h.sent.length - 1; i >= 0; i--) {
    const frame = h.sent[i];
    if (frame.peerId === peerId && frame.envelope.tcm === 'call.ginvite') {
      return frame.envelope.cid as string;
    }
  }
  throw new Error(`no ginvite was sent to ${peerId}`);
}

/** Bring a dialled leg all the way to connected, as its peer would. */
async function connectLeg(h: Harness, peerId: string): Promise<void> {
  const cid = dialledCid(h, peerId);
  await h.deliver(peerId, { tcm: 'call.ringing', cid });
  await h.deliver(peerId, { tcm: 'call.answer', cid, sdp: ANSWER_SDP, vid: false });
  await h.co.onIceStateChanged(cid, 'connected');
  await h.co.whenIdle();
}

// ---------------------------------------------------------------------------
// Authoritative group metrics: one session sink, never N leg sinks.
// ---------------------------------------------------------------------------

describe('the authoritative group metric executor', () => {
  it('routes every session lifecycle operation through the injected shared sink, never a direct leg', async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();

    // `openLegDial` starts a real CallService too. Its explicit null reportId
    // must not create a second, direct-scoped metric beside the group row.
    expect(h.metrics.open).toHaveBeenCalledTimes(1);
    expect(h.metrics.open).toHaveBeenCalledWith({
      reportId: h.reportMinted[0],
      localId: sid,
      scope: 'group',
      media: 'audio',
      startedAt: BASE,
    });
    // This is the real per-leg CallService created by `openLegDial`, not a
    // test double. It must receive the shared sink so a future direct-leg
    // lifecycle regression is observable here; its required null authority
    // then proves that sink receives no direct open.
    const leg = (h.co as unknown as { legs: Map<string, unknown> }).legs.get(B) as {
      deps: { metrics?: CallMetricSink };
    };
    expect(leg.deps.metrics).toBe(h.metrics);
    expect(h.metrics.open.mock.calls.filter(([input]) => input.scope === 'direct')).toEqual([]);

    await connectLeg(h, B);
    expect(h.metrics.open.mock.calls.filter(([input]) => input.scope === 'direct')).toEqual([]);
    expect(h.metrics.answered).toHaveBeenCalledWith(sid, BASE);
    expect(h.metrics.connected).toHaveBeenCalledWith(sid, BASE);
    expect(h.metrics.peak).toHaveBeenCalledWith(sid, 2);

    await h.co.hangup();
    await h.co.whenIdle();
    expect(h.metrics.finalize).toHaveBeenCalledWith(sid, 'hangup', BASE);

    // A second authoritative session that loses glare is discarded, not
    // finalized. It is the same injected sink and the terminal ordering is
    // exercised by the real coordinator/effect executor.
    const discardedSid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await h.deliver(B, ginvite({
      sid: ulid('0METRIC'), cid: ulid('0MCID'), r: [B, SELF],
    }));
    expect(h.metrics.discard).toHaveBeenCalledWith(discardedSid);
  });

  it('keeps executing session effects after the metric sink rejects', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness({ metricOpenRejects: true });
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();

    expect(h.metrics.open).toHaveBeenCalledTimes(1);
    // `openGroupCallMetric` precedes the dial. Seeing the real ginvite proves
    // the failed sink did not short-circuit the session's following effect.
    expect(h.frames('call.ginvite')).toHaveLength(1);
    warning.mockRestore();
  });
});

describe('group reporting authority is minted only after successful preflight', () => {
  it.each([
    ['blocked roster', { blocked: new Set([B]) }],
    ['duress', { duress: true }],
    ['one-to-one busy', { oneToOneBusy: true }],
    ['credential refusal', { credentialsRejects: true }],
  ] as const)('does not mint a report id for %s', async (_name, options) => {
    const h = harness(options);
    await expect(h.co.startGroupCall([B], false)).rejects.toBeInstanceOf(GroupCallRefusedError);
    expect(h.reportMinted).toEqual([]);
  });

  it('mints a fresh authority after preflight and never gives inbound sessions one', async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    expect(h.reportMinted).toEqual(['REPORT-GROUP-0']);
    expect(h.metrics.open).toHaveBeenCalledWith(expect.objectContaining({
      reportId: 'REPORT-GROUP-0', localId: sid,
    }));

    await h.co.hangup();
    await h.co.whenIdle();
    await h.deliver(STARTER, ginvite({
      sid: ulid('INBOUND'), cid: ulid('INCID'), r: [STARTER, SELF],
    }));
    expect(h.reportMinted).toEqual(['REPORT-GROUP-0']);
    expect(h.metrics.open).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 1. The CallKit aggregate, the session row, and the per-leg history rows.
// ---------------------------------------------------------------------------

describe('a 3-way audio session: ONE CXCall, one row, N leg rows', () => {
  it('reports once, connects on the first leg, releases on the last', async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();

    // ONE report for N legs, under the SID and not under any cid.
    expect(h.native.reportOutgoingCall).toHaveBeenCalledTimes(1);
    expect(h.native.reportOutgoingCall.mock.calls[0][0]).toBe(sid);
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.frames('call.ginvite')).toHaveLength(2);

    await connectLeg(h, B);
    expect(h.native.reportOutgoingConnected).toHaveBeenCalledTimes(1);
    await connectLeg(h, C);
    // The SECOND leg connecting emits nothing: the CXCall connected when the
    // call became real, not once per participant.
    expect(h.native.reportOutgoingConnected).toHaveBeenCalledTimes(1);

    await h.co.hangup();
    await h.co.whenIdle();
    const releases = h.native.endCall.mock.calls.filter(c => c[0] === sid);
    expect(releases).toHaveLength(1);
  });

  it('writes the session row STRICTLY before the ring and deletes it at release', async () => {
    const h = harness();
    const sid = ulid('SESS1');
    const cid = ulid('CID1');
    await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF, B] }));

    // The persist-before-ring ordering `call_offers` already uses: there must
    // be no window in which the system shows a call the app cannot answer.
    const save = h.trace.indexOf(`saveSession(${sid})`);
    const report = h.trace.findIndex(t => t.startsWith('reportIncomingCall('));
    expect(save).toBeGreaterThanOrEqual(0);
    expect(report).toBeGreaterThan(save);
    expect(h.sessions.has(sid)).toBe(true);

    await h.co.decline();
    await h.co.whenIdle();
    expect(h.sessions.has(sid)).toBe(false);
  });

  it('per-leg history rows share one sessionId', async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await connectLeg(h, C);
    await h.co.hangup();
    await h.co.whenIdle();

    const peers = h.logs.map(r => r.peerId).sort();
    expect(peers).toEqual([B, C].sort());
    expect(new Set(h.logs.map(r => r.sessionId))).toEqual(new Set([sid]));
  });

  it('MUTATION: a per-leg CallKit report reaching the provider is the release blocker', async () => {
    // Falsifier run at authoring time: delete `filterEffects` from
    // `ensureLeg`, so each leg runs its own reportOutgoingCall/endCallKit.
    // reportOutgoingCall is then called 3 times for one conversation (once
    // per leg plus the session's) and this assertion fails. Restored.
    const h = harness();
    await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    expect(h.native.reportOutgoingCall).toHaveBeenCalledTimes(1);
    await connectLeg(h, B);
    await connectLeg(h, C);
    // Not one endCall per leg either: legs close their peer connections, the
    // SESSION releases the CXCall.
    expect(h.native.endCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1b. The CXCall's NAME: never a ULID, on either direction (the ring rule).
// ---------------------------------------------------------------------------

describe("the CXCall's name", () => {
  it('an unnamed starter rings with an EMPTY name — the native side keeps its placeholder', async () => {
    // FALSIFYING CASE, run at authoring time: drop the known-name filter from
    // `reportGroupIncoming`. `displayNameFor` bottoms out at shortId, the
    // Swift side treats any non-empty displayName as a real name, and the
    // phone rings "…XXXXXXXX" full-screen — over the honest "Incoming call"
    // placeholder a VoIP wake already painted.
    const h = harness({ displayNames: new Map() });
    await h.deliver(
      STARTER,
      ginvite({ sid: ulid('SESS1'), cid: ulid('CID1'), r: [STARTER, SELF, B] }),
    );

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    const [, starterId, handle, displayName] =
      h.native.reportIncomingCall.mock.calls[0];
    expect(starterId).toBe(STARTER);
    expect(handle).toBe('');
    expect(displayName).toBe('');
  });

  it('a named starter rings under the stored name', async () => {
    // The companion precondition, so the empty-name test cannot pass because
    // names never cross the seam at all.
    const h = harness({ displayNames: new Map([[STARTER, 'Ana']]) });
    await h.deliver(
      STARTER,
      ginvite({ sid: ulid('SESS2'), cid: ulid('CID2'), r: [STARTER, SELF, B] }),
    );

    expect(h.native.reportIncomingCall.mock.calls[0][2]).toBe('Ana');
    expect(h.native.reportIncomingCall.mock.calls[0][3]).toBe('Ana');
  });

  it("an outgoing ROOM call is titled with the room's local name, not a callee's", async () => {
    const h = harness({
      roomMembers: new Map([[ROOM, [SELF, B, C]]]),
      roomNames: new Map([[ROOM, 'Family']]),
      displayNames: new Map([[B, 'Ana']]),
    });
    await h.co.startGroupCall([B, C], false, ROOM);
    await h.co.whenIdle();

    expect(h.native.reportOutgoingCall.mock.calls[0][1]).toBe('Family');
  });

  it('an outgoing ad-hoc call is named from KNOWN names, counted from the roster', async () => {
    // B is known, C and D are not: the label names who it can and counts the
    // seats it dialled — never "…XXXXXXXX" (the incoming doctrine applied to
    // the one path with no native placeholder behind it).
    const h = harness({ displayNames: new Map([[B, 'Ana']]) });
    await h.co.startGroupCall([B, C, D], false);
    await h.co.whenIdle();

    expect(h.native.reportOutgoingCall.mock.calls[0][1]).toBe('Ana and 2 others');
  });

  it('an outgoing call to entirely unnamed callees is "Group call", never a ULID', async () => {
    // FALSIFYING CASE, run at authoring time: restore `roster[1]` — the
    // handle is then shortId(B), and unlike every incoming path,
    // reportOutgoingCall has no mirror consult to save it.
    const h = harness({ displayNames: new Map() });
    await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();

    const name = h.native.reportOutgoingCall.mock.calls[0][1] as string;
    expect(name).toBe('Group call');
    expect(name.includes(shortId(B))).toBe(false);
  });

  it('a name read failing does not blank the outgoing CXCall', async () => {
    // The old `.catch(() => '')` passed '' straight to the bridge, and an
    // empty CXHandle renders a blank call on the lock screen.
    const h = harness({ displayNameThrows: true });
    await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();

    expect(h.native.reportOutgoingCall.mock.calls[0][1]).toBe('Group call');
  });

  it('a nameless room falls back to the known callees, then to the noun', async () => {
    // roomNameFor answers '' (the room is unnamed or its stored name is the
    // id in disguise): the ad-hoc naming takes over rather than the ULID.
    const h = harness({
      roomMembers: new Map([[ROOM, [SELF, B]]]),
      roomNames: new Map(),
      displayNames: new Map([[B, 'Ana']]),
    });
    await h.co.startGroupCall([B], false, ROOM);
    await h.co.whenIdle();

    expect(h.native.reportOutgoingCall.mock.calls[0][1]).toBe('Ana');
  });

  it("a room 'name' that is the room's id in disguise is refused the handle", async () => {
    // The dep's production wiring carries this guard too; the executor keeps
    // its own because the dep is injected — the CLI or a future wiring may
    // not. FALSIFYING CASE, run at authoring time: drop the belt, and the
    // outgoing CXCall is titled with 26 characters of room ULID.
    const h = harness({
      roomMembers: new Map([[ROOM, [SELF, B]]]),
      roomNames: new Map([[ROOM, ROOM]]),
      displayNames: new Map([[B, 'Ana']]),
    });
    await h.co.startGroupCall([B], false, ROOM);
    await h.co.whenIdle();

    expect(h.native.reportOutgoingCall.mock.calls[0][1]).toBe('Ana');
  });
});

// ---------------------------------------------------------------------------
// 2. The signalling budget.
// ---------------------------------------------------------------------------

describe('the signalling budget: 24 frames in any 6-second window', () => {
  it('the arithmetic identity holds', () => {
    // Pinned as ARITHMETIC because the group-chat pair taught that a jittered
    // drain cannot fail. capacity + windowSec × refill must not exceed 24, and
    // 24 is strictly under wsSend's 30 burst + 6×5 = 60.
    const worst =
      GROUP_SIGNAL_PACING.capacity +
      GROUP_SIGNAL_PACING.windowSec * GROUP_SIGNAL_PACING.refillPerSec;
    expect(worst).toBeLessThanOrEqual(GROUP_SIGNAL_PACING.maxPerWindow);
    expect(worst).toBeCloseTo(24, 9);
    // And under the SERVER's window, which is the bound that actually bites.
    expect(GROUP_SIGNAL_PACING.maxPerWindow).toBeLessThan(30 + 6 * 5);
  });

  it('a 4-way start stays inside every 6-second window', async () => {
    const h = harness();
    await h.co.startGroupCall([B, C, D], false);
    await h.co.whenIdle();
    // 3 ginvites, then ICE on each leg once the peers answer.
    for (const peer of [B, C, D]) {
      const cid = dialledCid(h, peer);
      await h.deliver(peer, { tcm: 'call.answer', cid, sdp: ANSWER_SDP, vid: false });
      for (let i = 0; i < 12; i++) {
        h.co.onLocalIceCandidate(cid, { cand: `candidate:${i} 1 udp 1 10.0.0.1 1 typ host`, mid: '0', idx: 0 });
      }
    }
    await h.co.whenIdle();
    expect(worstWindow(h.sent, 6_000)).toBeLessThanOrEqual(GROUP_SIGNAL_PACING.maxPerWindow);
    expect(h.frames('call.ginvite')).toHaveLength(3);
  });

  it('a saturating drain never exceeds 24 in any window — the bucket, not the arithmetic', async () => {
    // FALSIFYING CASE, run at authoring time: bypass `send`'s bucket (call the
    // transport directly from `legSend`) and this observes 40 frames in the
    // first window. Restored.
    //
    // 40 frames offered back-to-back is well past a single start's traffic,
    // which is the point: the bound must hold under churn (a start, a drop,
    // re-offers and a second attempt), not only under the happy path the design
    // arithmetics out to 15.
    const h = harness();
    // SIX participants — the widest roster the audio cap allows — so the
    // frames actually offered (5 ginvites + 5 legs x 4 ICE envelopes at the
    // 40-candidate cap = 25) EXCEED the window bound. A drain that offered
    // fewer than 25 could not fail however the bucket was mutated, which is
    // exactly the vacuous shape this repo's own record warns about.
    await h.co.startGroupCall([B, C, D, E, F], false);
    await h.co.whenIdle();
    for (const peer of [B, C, D, E, F]) {
      const cid = dialledCid(h, peer);
      await h.deliver(peer, { tcm: 'call.answer', cid, sdp: ANSWER_SDP, vid: false });
    }
    // Enough ICE to push well past one window's worth of frames.
    for (let round = 0; round < 5; round++) {
      for (const peer of [B, C, D, E, F]) {
        const cid = dialledCid(h, peer);
        for (let i = 0; i < 10; i++) {
          h.co.onLocalIceCandidate(cid, {
            cand: `candidate:${round}${i} 1 udp 1 10.0.0.1 1 typ host`,
            mid: '0',
            idx: 0,
          });
        }
      }
      await h.co.whenIdle();
    }
    await h.co.whenIdle();
    expect(h.sent.length).toBeGreaterThan(GROUP_SIGNAL_PACING.maxPerWindow);
    expect(worstWindow(h.sent, 6_000)).toBeLessThanOrEqual(GROUP_SIGNAL_PACING.maxPerWindow);
  });
});

/** The most frames observed in any window of `ms`, measured on the wire. */
function worstWindow(sent: SentFrame[], ms: number): number {
  let worst = 0;
  for (let i = 0; i < sent.length; i++) {
    let n = 0;
    for (let j = i; j < sent.length && sent[j].at < sent[i].at + ms; j++) n++;
    worst = Math.max(worst, n);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// 3. The pushSend mirror and "Couldn't reach".
// ---------------------------------------------------------------------------

describe('the local pushSend mirror', () => {
  it('mirrors the server constants exactly', () => {
    // The client cannot see the server's refusal, so the mirror is only
    // honest if it is the same bucket: 10 burst, 10 per minute
    // (packages/server/src/ratelimit.ts).
    expect(PUSH_MIRROR_PACING.capacity).toBe(10);
    expect(PUSH_MIRROR_PACING.refillPerSec).toBeCloseTo(10 / 60, 9);
  });

  it('an empty mirror shows "Couldn\'t reach", and a later ringing upgrades it', async () => {
    // FALSIFYING CASE, run at authoring time: delete the `pushMirror.tryTake`
    // consult in `send`. The tile then stays 'inviting' ("Calling…") forever
    // and both assertions below fail. Restored.
    const h = harness();
    // Drain the mirror: a start-cancel-restart cycle costs urgent frames and
    // WILL cross 10 inside a minute (an accepted trade).
    await h.co.startGroupCall([B, C, D], false);
    await h.co.whenIdle();
    await h.co.hangup();
    await h.co.whenIdle();
    await h.co.startGroupCall([B, C, D], false);
    await h.co.whenIdle();
    await h.co.hangup();
    await h.co.whenIdle();

    await h.co.startGroupCall([B, C, D], false);
    await h.co.whenIdle();
    const view = h.co.view!;
    const unreachable = view.legs.filter(l => l.phase === 'unreachable');
    expect(unreachable.length).toBeGreaterThan(0);

    // The honest upgrade wins: they were online after all, so no push was
    // needed and the tile must stop claiming otherwise.
    const peer = unreachable[0].peerId;
    await h.deliver(peer, { tcm: 'call.ringing', cid: dialledCid(h, peer) });
    expect(h.co.view!.legs.find(l => l.peerId === peer)!.phase).toBe('ringing');
  });

  it("does not mark B unreachable on A's exhausted push mirror", async () => {
    // THE MIRROR BELONGS TO THE SESSION WHOSE FRAME EXHAUSTED IT. A leg's
    // timeout runs below the coordinator queue: it publishes `ending`, then
    // its urgent call.end can sit in the pacer while that report releases A
    // and B installs with the SAME peer. The old empty-mirror input named only
    // the peer, so when it finally got a queue slot it painted B's fresh dial
    // "Couldn't reach" on evidence from A.
    //
    // FALSIFYING CASE: send `legPushMirrorEmpty` through plain `dispatch`.
    // B's phase below becomes `unreachable`, even though B's own mirror had a
    // token and its ginvite was sent normally.
    jest.useFakeTimers();
    const pacingEntered = latch();
    const pacingGate = latch();
    try {
      let holdNextDelay = false;
      let refillBeforeB = false;
      let h!: Harness;
      h = harness({
        beforeDelay: async () => {
          if (!holdNextDelay) return;
          holdNextDelay = false;
          pacingEntered.release();
          await pacingGate.held;
        },
        beforeSend: async tcm => {
          if (!refillBeforeB || tcm !== 'call.end') return;
          refillBeforeB = false;
          // A's mirror verdict has already been made, but B's queued ginvite
          // has not run. Refill here so only A can honestly say "empty".
          h.advance(60_000);
        },
      });

      // Ten urgent LEG frames spend the local push mirror. Coordinator-owned
      // hangup frames carry no legPeer and therefore do not touch it.
      for (let i = 0; i < 3; i++) {
        await h.co.startGroupCall([B, C, D], false);
        await h.co.whenIdle();
        await h.co.hangup();
        await h.co.whenIdle();
      }
      await h.co.startGroupCall([B], false);
      await h.co.whenIdle();
      await h.co.hangup();
      await h.co.whenIdle();

      // A is a one-leg answered session. Its connect timeout is owned by the
      // leg service, so it can end A while its own call.end remains paced.
      const sidA = ulid('MIRA');
      const cidA = ulid('MIRAC');
      await h.deliver(STARTER, ginvite({ sid: sidA, cid: cidA, r: [STARTER, SELF] }));
      await h.co.answer();
      await h.co.whenIdle();

      holdNextDelay = true;
      jest.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
      await pacingEntered.held;
      // NOT `whenIdle`: it waits on the deliberately held send chain.
      await flush();
      await flush();
      expect(h.co.view).toBeNull();

      // B installs and publishes its fresh leg while its ginvite waits behind
      // A's held demolition in the independent send chain.
      const startingB = h.co.startGroupCall([STARTER], false);
      await flush();
      await flush();
      const sidB = h.co.view!.sid;
      expect(sidB).not.toBe(sidA);
      expect(h.co.view!.legs.find(l => l.peerId === STARTER)!.phase).toBe('inviting');

      refillBeforeB = true;
      pacingGate.release();
      await startingB;
      await h.co.whenIdle();
      await flush();

      // A's UI verdict is fenced, while A's demolition still reaches the
      // wire: a fence must stop the building, never the demolishing.
      expect(h.co.view!.sid).toBe(sidB);
      expect(h.co.view!.legs.find(l => l.peerId === STARTER)!.phase).toBe('inviting');
      expect(
        h.views.some(
          v =>
            v?.sid === sidB &&
            v.legs.some(l => l.peerId === STARTER && l.phase === 'unreachable'),
        ),
      ).toBe(false);
      expect(
        h.sent.some(f => f.envelope.tcm === 'call.end' && f.envelope.cid === cidA),
      ).toBe(true);
    } finally {
      pacingGate.release();
      jest.useRealTimers();
    }
  });

  it("does not give B's token to a timeout A composes after glare installs B", async () => {
    // THE LEG'S CLOCK, not the coordinator's composition clock. Session glare
    // publishes B before it finishes tearing A down. While the first teardown
    // frame is suspended, A's independent CallService timeout can compose its
    // own urgent call.end with B already current. Reading the incarnation in
    // `send` gives that dead frame B's token, so its empty-mirror verdict passes
    // B's fence and paints B's brand-new attempt "Couldn't reach".
    jest.useFakeTimers();
    const teardownEntered = latch();
    const teardownGate = latch();
    try {
      let trackGlareTeardown = false;
      let glareEnds = 0;
      let h!: Harness;
      h = harness({
        beforeSend: async tcm => {
          if (!trackGlareTeardown || tcm !== 'call.end') return;
          glareEnds++;
          if (glareEnds === 1) {
            teardownEntered.release();
            await teardownGate.held;
            return;
          }
          if (glareEnds === 3) {
            // `send` made A's empty-mirror verdict before entering transport.
            // Refill only now so B's own ginvite has an honest mirror token and
            // cannot make the final phase ambiguous. THE THIRD end, not the
            // second: A now has two legs (see below), so the chain runs
            // [teardown-1 (held), timeout-STARTER, timeout-C, teardown-2] —
            // the C timeout, whose verdict is the one B re-dials into, is the
            // third.
            h.advance(60_000);
          }
        },
      });

      // Spend the mirror on urgent frames. Whole-session hangups have no leg
      // owner, so however they debit the bucket they cannot publish a tile
      // verdict; the leg-owned frame below is the one whose attribution matters.
      for (let i = 0; i < 3; i++) {
        await h.co.startGroupCall([B, C, D], false);
        await h.co.whenIdle();
        await h.co.hangup();
        await h.co.whenIdle();
      }
      await h.co.startGroupCall([B], false);
      await h.co.whenIdle();
      await h.co.hangup();
      await h.co.whenIdle();

      // A owns a live dial timer. The lower sid wins glare and publishes B at
      // the top of the coordinator step, before A's teardown effects settle.
      //
      // STARTER is on A's roster: glare is between the people on a call, so
      // only a member's crossing invite can supersede. This test used to
      // start A with C alone and let a stranger's lower sid win it;
      // rewritten deliberately.
      const sidA = await h.co.startGroupCall([STARTER, C], false);
      await h.co.whenIdle();
      const cidA = dialledCid(h, C);
      const sidB = ulid('AAAA');
      expect(sidB < sidA).toBe(true);

      trackGlareTeardown = true;
      const swapping = h.deliver(
        STARTER,
        ginvite({ sid: sidB, cid: ulid('GLAREC'), r: [STARTER, C, SELF] }),
      );
      await teardownEntered.held;
      expect(h.co.view!.sid).toBe(sidB);
      expect(h.co.view!.legs.find(l => l.peerId === C)!.phase).toBe('inviting');

      // The answer is already queued behind glare. It will open B's real leg
      // before the mirror verdict that A's delayed frame is about to enqueue.
      const answeringB = h.co.answer();
      await flush();
      await flush();

      // This timeout belongs to A's CallService, but it composes its call.end
      // only now, while B is the coordinator's current session.
      jest.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
      await flush();
      await flush();

      teardownGate.release();
      await Promise.all([swapping, answeringB]);
      await h.co.whenIdle();
      await flush();

      expect(h.co.view!.sid).toBe(sidB);
      expect(h.co.view!.legs.find(l => l.peerId === C)!.phase).toBe('inviting');
      expect(
        h.views.some(
          v =>
            v?.sid === sidB &&
            v.legs.some(l => l.peerId === C && l.phase === 'unreachable'),
        ),
      ).toBe(false);
      expect(
        h.sent.some(
          f =>
            f.peerId === C &&
            f.envelope.tcm === 'call.end' &&
            f.envelope.cid === cidA &&
            f.envelope.r === 'failed_ice',
        ),
      ).toBe(true);
    } finally {
      teardownGate.release();
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Admission, through the whole coordinator (the distributed-dialler case).
// ---------------------------------------------------------------------------

describe('roster authority, re-asserted through the coordinator', () => {
  it('a non-starter gjoin naming an unknown account changes NOTHING anywhere', async () => {
    // The distributed-dialler case. Proved pure at the shared layer; re-proved
    // here because a coordinator that acted on the input BEFORE the reducer
    // saw it would dial a stranger with the pure module still innocent.
    const h = harness();
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    const before = h.sent.length;
    const rosterBefore = [...h.co.view!.roster];

    await h.deliver(B, { tcm: 'call.gjoin', sid, m: STRANGER, se: 1 });

    expect(h.co.view!.roster).toEqual(rosterBefore);
    expect(h.sent.length).toBe(before);
    expect(h.sent.some(f => f.peerId === STRANGER)).toBe(false);
    expect(h.native.createOffer.mock.calls.length).toBe(2); // B and C only
  });

  it("a stranger's ginvite into a live session is answered busy, and the session lives", async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    const strangerCid = ulid('SCID');

    await h.deliver(STRANGER, ginvite({ sid, cid: strangerCid, r: [STRANGER, SELF] }));

    const busy = h.sent.filter(
      f => f.peerId === STRANGER && f.envelope.tcm === 'call.end' && f.envelope.r === 'busy',
    );
    expect(busy).toHaveLength(1);
    expect(h.co.view!.sid).toBe(sid);
    expect(h.native.createAnswer).not.toHaveBeenCalled();
  });

  it('a live 1:1 call makes this device busy to a ginvite, and never rings', async () => {
    const h = harness({ oneToOneBusy: true });
    await h.deliver(STARTER, ginvite({ sid: ulid('S2'), cid: ulid('C2'), r: [STARTER, SELF] }));
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.frames('call.end').map(f => f.envelope.r)).toEqual(['busy']);
    expect(h.co.view).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. The three refusals: blocked, identity-changed, duress.
// ---------------------------------------------------------------------------

describe('who this device will not call, and what it does instead', () => {
  it('a blocked member in the roster ⇒ no ring, no join, ZERO frames', async () => {
    const h = harness({ blocked: new Set([B]) });
    await h.deliver(STARTER, ginvite({ sid: ulid('S3'), cid: ulid('C3'), r: [STARTER, SELF, B] }));

    // Counted on the transport mock, not inferred: skipping the blocked
    // member's leg silently would be the omission-tell rule 21 forbids, so
    // the whole session is refused — and a row says why.
    expect(h.sent).toEqual([]);
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.co.view).toBeNull();
    expect(h.logs.map(r => r.reason)).toEqual(['blocked']);
  });

  it('starting a call that names a blocked member is refused before any frame', async () => {
    const h = harness({ blocked: new Set([C]) });
    await expect(h.co.startGroupCall([B, C], false)).rejects.toThrow(GroupCallRefusedError);
    expect(h.sent).toEqual([]);
    expect(h.native.createOffer).not.toHaveBeenCalled();
  });

  it('an identity-changed member ⇒ THEIR leg is skipped, every other leg lives', async () => {
    // The room decision applied to calls: the naive 1:1 refusal would kill the
    // whole session over one member. FALSIFIER, run at authoring time: drop
    // the `mayCall` consult at the dial site in `openLegDial` — B is then
    // dialled anyway and the "no frame reached B" assertion below fails.
    // (The gate lives at the DIAL SITE and not once at session start because
    // Re-offers and a late joiner both arrive through that same effect; a
    // check anywhere else would be a check with holes.) Restored.
    const h = harness({ identityChanged: new Set([B]) });
    await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();

    expect(h.sent.some(f => f.peerId === B)).toBe(false);
    expect(h.frames('call.ginvite').map(f => f.peerId)).toEqual([C]);
    // The state NAMES them, so the tile can say "Safety number changed —
    // not connected" rather than silently showing one fewer person.
    expect(h.co.view!.legs.find(l => l.peerId === B)!.skipped).toBe('identity_changed');

    await connectLeg(h, C);
    expect(h.co.view!.legs.find(l => l.peerId === C)!.phase).toBe('connected');
    expect(h.co.view).not.toBeNull();
  });

  it('duress is network-silent: zero frames, no session, no CallKit', async () => {
    const h = harness({ duress: true });
    await expect(h.co.startGroupCall([B, C], false)).rejects.toThrow(GroupCallRefusedError);
    await h.deliver(STARTER, ginvite({ sid: ulid('S4'), cid: ulid('C4'), r: [STARTER, SELF] }));
    expect(h.sent).toEqual([]);
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.native.createOffer).not.toHaveBeenCalled();
    expect(h.co.view).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Cold restore of a SESSION.
// ---------------------------------------------------------------------------

describe('killed mid-ring, answered from the lock screen', () => {
  const SID = ulid('SESS9');
  const STARTER_CID = ulid('SCID9');
  const HELD_CID = ulid('HCID9');

  function seeded(stripSid: boolean) {
    // A three-way: the starter's ginvite AND B's join_leg invite both arrived
    // and were persisted before the app died. B sorts BELOW self in the
    // roster, so the offer rule says B offers to us — and C sorts below us too, so
    // makes us offer to C.
    // ORDER IS DATA: C sits BELOW us, so the C leg is ours to open at
    // answer time; B sits below us too, but B's offer already arrived, so
    // that leg exists and is answered instead of re-offered.
    const roster = [STARTER, B, C, SELF];
    return harness({
      seedSession: {
        sid: SID,
        roomId: null,
        starterId: STARTER,
        roster,
        se: 0,
        video: false,
        startedAt: BASE,
      },
      seedOffers: [
        {
          cid: STARTER_CID,
          peerId: STARTER,
          sdp: SDP,
          video: false,
          exp: BASE + 60_000,
          serverTs: BASE,
          sid: stripSid ? null : SID,
        },
        {
          cid: HELD_CID,
          peerId: B,
          sdp: SDP,
          video: false,
          exp: BASE + 60_000,
          serverTs: BASE,
          sid: stripSid ? null : SID,
        },
      ],
    });
  }

  it('rebuilds the SESSION whole: the starter leg is answered AND the answer-time offers go out', async () => {
    const h = seeded(false);
    expect(await h.co.onCallKitAnswer(SID, h.co.captureCallKitPress())).toBe('claimed');
    await h.co.whenIdle();

    // The starter's leg and the held leg are both answered — the held offer
    // is exactly what a cid-keyed restore drops on the floor.
    const answered = h.native.createAnswer.mock.calls.map(c => c[0]).sort();
    expect(answered).toEqual([HELD_CID, STARTER_CID].sort());
    // The sovereign self-announce: load-bearing, because it is what arms
    // every incumbent's re-offers toward us.
    expect(h.frames('call.gjoin').map(f => f.envelope.m)).toEqual([SELF, SELF, SELF]);
    // Answer-time offers: C is below us in the roster, so the leg is ours to open.
    expect(h.frames('call.ginvite').map(f => f.peerId)).toEqual([C]);
    // ONE CXCall, and it is NOT re-reported: it survived the kill.
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
  });

  it('a rebuilt session publishes an anchor for every leg still waiting', async () => {
    // The restore writes `this.state` DIRECTLY rather than through `step`, so
    // it carries its own stamp — and on the silent restore it is the only one
    // that runs: nothing opens a leg, so no `legStateChanged` follows to
    // re-derive anything. FALSIFYING CASE, run at authoring time: drop
    // `syncInvitedAt()` from `restoreLocked` and every tile on the rebuilt
    // session publishes with no clock to measure silence against.
    const h = seeded(false);
    h.advance(5_000);
    const before = h.now();
    expect(await h.co.restore(SID, { ring: false })).toBe(true);

    const waiting = h.co.view!.legs.filter(l => l.phase === 'inviting');
    expect(waiting.length).toBeGreaterThan(0);
    for (const l of waiting) {
      expect(l.invitedAt).not.toBeNull();
      // The coordinator's clock at RESTORE time, not the session's start:
      // this device has been waiting since it came back, not since the ring.
      expect(l.invitedAt!).toBeGreaterThanOrEqual(before);
      expect(l.invitedAt!).toBeGreaterThan(BASE);
    }
  });

  it('FALSIFIER: with `sid` stripped from the stored offers, the restore produces NO leg', async () => {
    // This is the cid-keyed-take bug kept as a test. Without the column the restore
    // cannot find the session's offers at all, so rather than answering a
    // call it can never carry, it releases the CXCall — the `rehydrate`
    // doctrine.
    const h = seeded(true);
    await h.co.onCallKitAnswer(SID, h.co.captureCallKitPress());
    await h.co.whenIdle();

    expect(h.native.createAnswer).not.toHaveBeenCalled();
    expect(h.frames('call.ginvite')).toEqual([]);
    expect(h.native.endCall).toHaveBeenCalledWith(SID, 'failed_media');
  });

  it('DROPS a held offer from an account the persisted roster does not name', async () => {
    // THE DISTRIBUTED DIALLER, ONE LAYER DOWN. Every ringable invite is
    // persisted BEFORE the reducer's verdict — the SDP is what a cold answer
    // needs and the ratchet consumed its message key on first decrypt — so
    // the table also holds the invites this device refused. A non-rostered
    // account that knows the sid was answered `busy` while the app ran and
    // became an ANSWERED MEDIA LEG the moment the phone was killed and the
    // call answered from the lock screen.
    //
    // FALSIFIER, run at authoring time: drop the `admitted(...)` filter in
    // `restore` — createAnswer is then called for the stranger's cid and the
    // first assertion fails.
    const h = harness({
      seedSession: {
        sid: SID,
        roomId: null,
        starterId: STARTER,
        roster: [STARTER, SELF],
        se: 0,
        video: false,
        startedAt: BASE,
      },
      seedOffers: [
        {
          cid: STARTER_CID,
          peerId: STARTER,
          sdp: SDP,
          video: false,
          exp: BASE + 60_000,
          serverTs: BASE,
          sid: SID,
        },
        {
          // Same sid, same session — and an account the starter never named.
          cid: ulid('SCIDX'),
          peerId: STRANGER,
          sdp: SDP,
          video: false,
          exp: BASE + 60_000,
          serverTs: BASE,
          sid: SID,
        },
      ],
    });
    await h.co.onCallKitAnswer(SID, h.co.captureCallKitPress());
    await h.co.whenIdle();

    // The starter's leg, and only the starter's leg.
    expect(h.native.createAnswer.mock.calls.map(c => c[0])).toEqual([STARTER_CID]);
    // Dropped, not refused again: they were told `busy` on the live path, and
    // a restore that answered them at all would tell an account the roster
    // does not name that this phone came back.
    expect(h.sent.some(f => f.peerId === STRANGER)).toBe(false);
    expect(h.co.view!.legs.some(l => l.peerId === STRANGER)).toBe(false);
  });

  it('a cold CallKit END restores, declines to the caller, and leaves no persistence', async () => {
    // The end half of the same unreachable path. An end that
    // found nothing to end left the row, the stored offers and the CXCall
    // behind — and the starter ringing out their full timeout.
    const h = seeded(false);
    await h.co.onCallKitEnd(SID, h.co.captureCallKitPress());
    await h.co.whenIdle();

    const declines = h.sent.filter(
      f => f.envelope.tcm === 'call.end' && f.envelope.r === 'decline',
    );
    expect(declines.map(f => f.peerId).sort()).toEqual([B, STARTER].sort());
    expect(h.native.createAnswer).not.toHaveBeenCalled();
    expect(h.sessions.has(SID)).toBe(false);
    expect(h.offers.size).toBe(0);
    expect(h.co.view).toBeNull();
  });

  it('an offer that aged out while the phone was off releases rather than answers', async () => {
    const h = harness({
      seedSession: {
        sid: SID,
        roomId: null,
        starterId: STARTER,
        roster: [STARTER, SELF],
        se: 0,
        video: false,
        startedAt: BASE - 600_000,
      },
      seedOffers: [
        {
          cid: STARTER_CID,
          peerId: STARTER,
          sdp: SDP,
          video: false,
          exp: BASE - 1,
          serverTs: BASE - 600_000,
          sid: SID,
        },
      ],
    });
    await h.co.onCallKitAnswer(SID, h.co.captureCallKitPress());
    await h.co.whenIdle();
    expect(h.native.createAnswer).not.toHaveBeenCalled();
    expect(h.native.endCall).toHaveBeenCalledWith(SID, 'timeout');
  });
});

// ---------------------------------------------------------------------------
// 7. Mute, fanned — all-or-close-the-leg.
// ---------------------------------------------------------------------------

describe('a mute that one leg cannot apply', () => {
  it('closes THAT leg and leaves the others muted — never a live open mic', async () => {
    // FALSIFYING CASE, run at authoring time: make the failure silent (treat
    // every apply as successful). The "no leg is both live and unmuted"
    // assertion then fails, which is the whole point — a microphone you
    // cannot silence toward one participant is a live open mic to them while
    // the UI says muted.
    const h = harness({ audioApply: () => true });
    await h.co.startGroupCall([B, C, D], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await connectLeg(h, C);
    await connectLeg(h, D);

    const failing = dialledCid(h, C);
    h.native.setAudioEnabled.mockImplementation(async (cid: string) => cid !== failing);

    await h.co.setMuted(true);
    await h.co.whenIdle();

    const view = h.co.view!;
    expect(view.muted).toBe(true);
    // The leg that could not be silenced is CLOSED, loudly.
    const cLeg = view.legs.find(l => l.peerId === C)!;
    expect(['failed', 'gone', 'left']).toContain(cLeg.phase);
    expect(
      h.sent.some(
        f => f.peerId === C && f.envelope.tcm === 'call.end' && f.envelope.r === 'failed_media',
      ),
    ).toBe(true);
    // And nobody is left both live and unmuted.
    for (const peer of [B, D]) {
      expect(h.native.setAudioEnabled).toHaveBeenCalledWith(dialledCid(h, peer), false);
      expect(view.legs.find(l => l.peerId === peer)!.phase).toBe('connected');
    }
  });

  it('retries once before closing — a transient native failure is not a dead leg', async () => {
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    const cid = dialledCid(h, B);
    let calls = 0;
    h.native.setAudioEnabled.mockImplementation(async () => ++calls > 1);

    await h.co.setMuted(true);
    await h.co.whenIdle();
    expect(calls).toBe(2);
    expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('connected');
    expect(
      h.sent.some(f => f.envelope.tcm === 'call.end' && f.envelope.cid === cid),
    ).toBe(false);
  });

  it('names, per leg, what the fan actually did', async () => {
    // FALSIFYING CASE: return nothing (the old `Promise<void>`) and the screen
    // is back to inferring causality from a time window — which reports an
    // unrelated hangup as "their leg couldn't be changed". The verdict exists
    // inside the fan already; this is it leaving.
    const h = harness();
    await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await connectLeg(h, C);

    const failing = dialledCid(h, C);
    const applied = dialledCid(h, B);
    h.native.setAudioEnabled.mockImplementation(async (cid: string) => cid !== failing);

    const outcomes = await h.co.setMuted(true);
    await h.co.whenIdle();

    expect(outcomes).toEqual(
      expect.arrayContaining([
        { peerId: B, cid: applied, applied: true, closed: false },
        // `closed: true` is the CLOSE's verdict here, not the fan's intent: C
        // is still on the cid the fan named, so the close really landed.
        { peerId: C, cid: failing, applied: false, closed: true },
      ]),
    );
    expect(outcomes).toHaveLength(2);
    // Exactly the legs this fan closed, and nobody else — the property the
    // screen's attribution now rests on.
    expect(outcomes.filter(o => o.closed).map(o => o.peerId)).toEqual([C]);
  });

  it('reports no drop when the close it asked for was a cid no-op', async () => {
    // THE SNAPSHOT RESIDUAL. The fan walks a SNAPSHOT of the legs, so it can name a
    // cid the peer has already abandoned. `closeLeg`'s cid guard is right to
    // leave the peer's new leg alone — but the outcome reported the INTENT,
    // so the screen named a live participant in "…was dropped". Attribution by
    // data is only worth having if the data is the verdict.
    //
    // FALSIFYING CASE, run at authoring time: return `closed: true` from the
    // close branch again. `outcomes` claims B was dropped while B is on a
    // healthy leg two lines below, and this goes red.
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    const oldCid = dialledCid(h, B);

    const entered = latch();
    const gate = latch();
    h.native.setAudioEnabled.mockImplementation(async (cid: string) => {
      if (cid !== oldCid) return true;
      entered.release();
      await gate.held;
      // The leg the fan snapshotted cannot be reached — because it is gone.
      return false;
    });

    const fan = h.co.setMuted(true);
    await entered.held;

    // B's device abandoned that leg and re-offered on a fresh cid, mid-fan.
    const fresh = ulid('REOF2');
    await h.deliver(B, ginvite({ sid, cid: fresh, r: [SELF, B] }));
    expect(h.native.createAnswer).toHaveBeenCalled();

    gate.release();
    const outcomes = await fan;
    await h.co.whenIdle();

    // The outcome names the cid it acted on and the close's OWN verdict.
    expect(outcomes).toEqual([{ peerId: B, cid: oldCid, applied: false, closed: false }]);
    // …so nobody is reported dropped, and B is still in the call.
    expect(outcomes.filter(o => o.closed)).toEqual([]);
    expect(['connecting', 'connected']).toContain(
      h.co.view!.legs.find(l => l.peerId === B)!.phase,
    );
    // The fresh leg is muted, so the session's claim stays honest: the mute
    // was achieved on the leg B is actually on.
    expect(h.native.setAudioEnabled).toHaveBeenCalledWith(fresh, false);
  });
});

// ---------------------------------------------------------------------------
// 7b. A mute a leg BORN AFTER IT must still honour.
// ---------------------------------------------------------------------------

describe('the legs that open after the fan has already run', () => {
  it('applies the session mute to a participant added afterwards', async () => {
    // THE HONESTY BLOCKER, stated as a test. `setMuted` fans across a SNAPSHOT
    // and then publishes `muted: true`; a leg opened after that snapshot is
    // born with an enabled audio track, and nothing used to re-ask. The UI
    // said Muted while the newest participant heard a live microphone — for
    // the rest of the call, not for a window.
    //
    // FALSIFYING CASE, run at authoring time: remove the `bindLegTracks` call
    // from `openLegDial`. `setAudioEnabled` is then never called for C's cid
    // and this goes red while `view.muted` still reads true, which is exactly
    // the shape of the lie.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    await h.co.setMuted(true);
    await h.co.whenIdle();
    expect(h.co.view!.muted).toBe(true);

    h.native.setAudioEnabled.mockClear();
    await h.co.addParticipant(C);
    await h.co.whenIdle();

    expect(h.native.setAudioEnabled).toHaveBeenCalledWith(dialledCid(h, C), false);
    // …and the leg is alive, because it accepted the mute.
    expect(h.co.view!.legs.find(l => l.peerId === C)!.phase).toBe('inviting');
    expect(h.co.view!.muted).toBe(true);
  });

  it('CLOSES a late leg that cannot be silenced, exactly as the fan would', async () => {
    // All-or-close-the-leg does not get weaker because the leg arrived late: a
    // microphone that cannot be silenced toward the newest participant is the
    // same open mic.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await h.co.setMuted(true);
    await h.co.whenIdle();

    const alreadyDialled = new Set(
      h.frames('call.ginvite').map(f => f.envelope.cid as string),
    );
    // Everything that already exists can be silenced; the leg about to be born
    // cannot.
    h.native.setAudioEnabled.mockImplementation(async (cid: string) =>
      alreadyDialled.has(cid),
    );

    await h.co.addParticipant(C);
    await h.co.whenIdle();

    expect(
      h.sent.some(
        f => f.peerId === C && f.envelope.tcm === 'call.end' && f.envelope.r === 'failed_media',
      ),
    ).toBe(true);
    expect(['failed', 'gone', 'left']).toContain(
      h.co.view!.legs.find(l => l.peerId === C)!.phase,
    );
    // The rest of the call is untouched — closing is per leg, not per session.
    expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('connected');
  });

  it('applies it to a leg opened by ANSWERING a fresh offer, not only to a dial', async () => {
    // The re-offer's other side: B's leg died on THEIR device and their re-offer arrives
    // with a fresh cid, which this session adopts through `openLegAnswer`. A
    // binding that only covered dials would leave that adopted leg unmuted.
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await h.co.setMuted(true);
    await h.co.whenIdle();

    h.native.setAudioEnabled.mockClear();
    const fresh = ulid('REOFF');
    await h.deliver(B, ginvite({ sid, cid: fresh, r: [SELF, B] }));

    expect(h.native.createAnswer).toHaveBeenCalled();
    expect(h.native.setAudioEnabled).toHaveBeenCalledWith(fresh, false);
  });

  it('applies a camera that was turned OFF to a leg added afterwards', async () => {
    // The same defect one track over, and the same rule: a camera you cannot
    // stop toward one participant is a live camera to them while the control
    // says off.
    const h = harness();
    await h.co.startGroupCall([B], true);
    await h.co.whenIdle();
    await connectLeg(h, B);

    await h.co.setVideoEnabled(false);
    await h.co.whenIdle();

    h.native.setVideoEnabled.mockClear();
    await h.co.addParticipant(C);
    await h.co.whenIdle();

    expect(h.native.setVideoEnabled).toHaveBeenCalledWith(dialledCid(h, C), false);
  });

  it('touches no camera in an AUDIO session, and no microphone when unmuted', async () => {
    // The other direction of the same care. A fresh leg's tracks are enabled
    // by construction, so re-applying "on" buys nothing — and an audio session
    // has no video track at all, so `setVideoEnabled` there could only ever
    // answer false and close a perfectly healthy leg.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    h.native.setAudioEnabled.mockClear();
    h.native.setVideoEnabled.mockClear();

    await h.co.addParticipant(C);
    await h.co.whenIdle();

    expect(h.native.setVideoEnabled).not.toHaveBeenCalled();
    expect(h.native.setAudioEnabled).not.toHaveBeenCalled();
    expect(h.co.view!.legs.find(l => l.peerId === C)!.phase).toBe('inviting');
  });
});

// ---------------------------------------------------------------------------
// 7b-bis. The loudspeaker: ONE route for the device, not one per leg.
// ---------------------------------------------------------------------------

describe('the output route, which is not a fan', () => {
  it('makes ONE bridge call for a three-leg session, addressed with the sid', async () => {
    // THE LOCAL-VERSUS-FAN DECISION, stated as a test. `setSpeaker(cid, on)`
    // takes a cid and native discards it: TacendumCall.mm forwards only `on`
    // to `setSpeakerEnabled:`, whose Swift signature has no cid, and which
    // ends at `overrideOutputAudioPort` on the RTCAudioSession SINGLETON. One
    // route for the process. Fanning it would be N identical writes to the
    // same global, and — the reason this matters rather than merely being
    // wasteful — all-or-close-the-leg would then DROP a participant because
    // an earpiece declined to become a loudspeaker.
    //
    // FALSIFYING CASE, run at authoring time: route `setSpeakerEnabled`
    // through `fanTrack`. The count below reads 3 and the sid assertion reads
    // a leg's cid; both go red.
    const h = harness();
    const sid = await h.co.startGroupCall([B, C, D], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await connectLeg(h, C);
    await connectLeg(h, D);
    h.native.setSpeaker.mockClear();

    await h.co.setSpeakerEnabled(true);
    await h.co.whenIdle();

    expect(h.native.setSpeaker).toHaveBeenCalledTimes(1);
    // The SESSION's own device-facing handle — the aggregate CXCall the design
    // reports — and never one of the three legs.
    expect(h.native.setSpeaker).toHaveBeenCalledWith(sid, true);
    const legCids = [B, C, D].map(p => dialledCid(h, p));
    for (const cid of legCids) {
      expect(h.native.setSpeaker).not.toHaveBeenCalledWith(cid, true);
    }
    // And nobody was dropped for it: a route is not a leg's media.
    for (const peer of [B, C, D]) {
      expect(h.co.view!.legs.find(l => l.peerId === peer)!.phase).toBe('connected');
    }
    expect(h.sent.some(f => f.envelope.tcm === 'call.end')).toBe(false);
  });

  it('publishes the route it took, and toggles back off', async () => {
    // FALSIFYING CASE: drop `speakerOn` from the `view` getter. Both reads
    // below come back undefined and this goes red — the screen would have no
    // way to light the control it just pressed.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    // A call starts on the earpiece. An audio call that opened on the
    // loudspeaker would be broadcasting somebody's conversation to the room
    // they are standing in.
    expect(h.co.view!.speakerOn).toBe(false);

    await h.co.setSpeakerEnabled(true);
    expect(h.co.view!.speakerOn).toBe(true);
    expect(h.views.some(v => v?.speakerOn === true)).toBe(true);

    await h.co.setSpeakerEnabled(false);
    expect(h.co.view!.speakerOn).toBe(false);
    expect(h.native.setSpeaker).toHaveBeenLastCalledWith(expect.any(String), false);
  });

  it('a REJECTED bridge call claims nothing — no lit button over an earpiece', async () => {
    // There is no `applied` verdict for an output route (the bridge resolves
    // void), so the one thing that can be honoured is a refusal. A button that
    // lights on a rejected call tells the person their call is coming out of a
    // speaker it is not coming out of — the muted-glyph-over-a-live-mic shape,
    // one control across.
    //
    // FALSIFYING CASE, run at authoring time: write `this.speakerOn = on`
    // before the await, or swallow the rejection and fall through. The read
    // below reads true and this goes red.
    const h = harness({ speakerRejects: true });
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    await h.co.setSpeakerEnabled(true);
    await h.co.whenIdle();

    expect(h.native.setSpeaker).toHaveBeenCalled();
    expect(h.co.view!.speakerOn).toBe(false);
    expect(h.views.some(v => v?.speakerOn === true)).toBe(false);
    // A route that would not change is not a reason to end anybody's call.
    expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('connected');
  });

  it("does not light B's speaker because A's press finally came back", async () => {
    // The `setMuted` fence, at the one-await scale this has. A bridge call
    // outlives a hangup; an unconditional write after it would light the NEXT
    // call's speaker button over a route that call never chose.
    //
    // FALSIFYING CASE, run at authoring time: remove the `sessionSid()` check
    // after the await. Session B publishes `speakerOn: true` and this goes red.
    const held = latch();
    const h = harness({ beforeSetSpeaker: () => held.held });
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    const press = h.co.setSpeakerEnabled(true);
    await flush();

    // A ends the ordinary way — no relock, so `generation` never moves and
    // only the SESSION fence can catch this.
    await h.co.hangup();
    await h.co.whenIdle();
    const sidB = await h.co.startGroupCall([C], false);
    await h.co.whenIdle();
    await connectLeg(h, C);

    held.release();
    await press;
    await h.co.whenIdle();

    expect(h.co.view!.sid).toBe(sidB);
    expect(h.co.view!.speakerOn).toBe(false);
    expect(h.views.some(v => v?.sid === sidB && v.speakerOn)).toBe(false);
  });

  it('does not carry the loudspeaker into the NEXT call', async () => {
    // THE LEAK. CallKit deactivates the audio session when a call ends and
    // `configureAudioSession` builds the next one from scratch, so the route
    // override this flag reports is gone. A `true` surviving into the next
    // session is a lit speaker button over an earpiece — the app asserting
    // something false about the person's own hardware, for a whole call.
    //
    // FALSIFYING CASE, run at authoring time: delete `this.speakerOn = false`
    // from `resetSessionScratch()`. The second session opens with
    // `speakerOn: true` and this goes red.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await h.co.setSpeakerEnabled(true);
    expect(h.co.view!.speakerOn).toBe(true);

    await h.co.hangup();
    await h.co.whenIdle();

    const sidB = await h.co.startGroupCall([C], false);
    await h.co.whenIdle();

    expect(h.co.view!.sid).toBe(sidB);
    expect(h.co.view!.speakerOn).toBe(false);
    // Not merely settled false: no frame of session B ever claimed otherwise.
    expect(h.views.some(v => v?.sid === sidB && v.speakerOn)).toBe(false);
  });

  it('a press with no session never reaches the bridge', async () => {
    // The idle guard. Overriding the output port with no call running would
    // move a route the app does not own — the music somebody is listening to.
    const h = harness();
    await h.co.setSpeakerEnabled(true);
    expect(h.native.setSpeaker).not.toHaveBeenCalled();
    expect(h.co.view).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7c. Add, judged against the room as it stands NOW.
// ---------------------------------------------------------------------------

describe('an Add the room no longer allows', () => {
  /** A room call whose leg to B is up, ready for an Add. */
  async function roomCall(opts: Options): Promise<Harness> {
    const h = harness(opts);
    await h.co.startGroupCall([B], false, ROOM);
    await h.co.whenIdle();
    await connectLeg(h, B);
    return h;
  }

  it('refuses somebody the room has removed — no dial, no delta, no frame', async () => {
    // THE FINDING. `addParticipant` judged the starter, the epoch and the cap;
    // membership was checked only by a candidate list the UI folded once per
    // room id. So a person removed at minute three stayed selectable and could
    // be dialled INTO the room's call.
    //
    // FALSIFYING CASE, run at authoring time: drop the `roomMembers` consult
    // from `addParticipant`. C is then dialled — a ginvite carrying an SDP and
    // the session roster reaches an account the room has ejected — and every
    // assertion below fails.
    const h = await roomCall({ roomMembers: new Map([[ROOM, [SELF, B]]]) });
    const before = h.sent.length;

    await expect(h.co.addParticipant(C)).rejects.toThrow(GroupCallRefusedError);
    await h.co.whenIdle();

    expect(h.sent.some(f => f.peerId === C)).toBe(false);
    expect(h.sent).toHaveLength(before);
    expect(h.frames('call.gjoin')).toEqual([]);
    expect(h.co.view!.roster).toEqual([SELF, B]);
    expect(h.native.createOffer).toHaveBeenCalledTimes(1); // B's leg only
  });

  it('refuses when the room cannot be read at all', async () => {
    // A fold this device could not perform is not a fold that passed. The cost
    // of refusing is an Add that must be pressed again; the cost of the other
    // direction is dialling on the strength of a database failure.
    const h = await roomCall({ roomMembers: new Map([[ROOM, null]]) });
    await expect(h.co.addParticipant(C)).rejects.toThrow(GroupCallRefusedError);
    await h.co.whenIdle();
    expect(h.sent.some(f => f.peerId === C)).toBe(false);
  });

  it('adds somebody the room DOES hold', async () => {
    // The check must not be a wall. A current member is dialled exactly as
    // before, and the roster delta goes to the incumbents.
    const h = await roomCall({ roomMembers: new Map([[ROOM, [SELF, B, C]]]) });
    await h.co.addParticipant(C);
    await h.co.whenIdle();

    expect(h.co.view!.roster).toEqual([SELF, B, C]);
    expect(dialledCid(h, C)).toBeTruthy();
    expect(h.frames('call.gjoin').map(f => f.peerId)).toEqual([B]);
  });

  it('an ad-hoc call has no room to consult, and adds as it always did', async () => {
    // The picker call belongs to no room, so there is nothing to fold and
    // the reducer's judgement is the whole judgement. A membership check that
    // refused here would have broken every non-room group call.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    await h.co.addParticipant(C);
    await h.co.whenIdle();

    expect(h.co.view!.roster).toEqual([SELF, B, C]);
    expect(h.trace.some(t => t.startsWith('roomMembers('))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7d. The "May be offline" anchor, on the COORDINATOR's clock.
// ---------------------------------------------------------------------------

describe('when this device started waiting on a leg', () => {
  it('stamps a dialled leg once and does not move it', async () => {
    // The design requires status to derive from coordinator state rather than from a
    // view timer. The screen used to own this map, so remounting the screen —
    // or simply observing late — changed the answer for a leg that had been
    // silent the whole time.
    //
    // FALSIFYING CASE: drop `syncInvitedAt()` from `step`. `invitedAt` is then
    // null forever and every tile is stuck on "Calling…" no matter how long
    // the invite has been out.
    const h = harness();
    const at = h.now();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();

    const first = h.co.view!.legs.find(l => l.peerId === B)!.invitedAt;
    expect(first).not.toBeNull();
    expect(first).toBeGreaterThanOrEqual(at);

    // Twelve seconds and several inputs later, the anchor is the SAME instant:
    // re-stamping would reset the clock on exactly the leg making no progress.
    h.advance(12_000);
    await h.deliver(B, { tcm: 'call.ice', cid: dialledCid(h, B), c: [] });
    expect(h.co.view!.legs.find(l => l.peerId === B)!.invitedAt).toBe(first);
  });

  it('clears it the moment something comes back', async () => {
    // "May be offline" is about silence. A leg that rang is not silent, and a
    // stamp left standing would let the sentence reappear later on a leg that
    // had already answered for itself.
    const h = harness();
    await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    expect(h.co.view!.legs.find(l => l.peerId === B)!.invitedAt).not.toBeNull();

    await h.deliver(B, { tcm: 'call.ringing', cid: dialledCid(h, B) });

    expect(h.co.view!.legs.find(l => l.peerId === B)!.invitedAt).toBeNull();
    // C never rang, so C is still waiting — the anchor is per leg, which is
    // the whole reason it is not `view.startedAt`.
    expect(h.co.view!.legs.find(l => l.peerId === C)!.invitedAt).not.toBeNull();
  });

  it('stamps a participant added at minute three from THEIR invite, not the call', async () => {
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    h.advance(180_000);
    await h.co.addParticipant(C);
    await h.co.whenIdle();

    const started = h.co.view!.startedAt;
    const invited = h.co.view!.legs.find(l => l.peerId === C)!.invitedAt!;
    // Three minutes apart. Dating C from the session would put "May be
    // offline" under their name the instant they were invited.
    expect(invited - started).toBeGreaterThanOrEqual(180_000);
  });

  it('re-anchors a ringing leg when the starter re-offers on a fresh cid', async () => {
    // THE RE-OFFER RESIDUAL. The anchor is cleared "the moment the leg
    // leaves `inviting`" — but a ringing leg NEVER has a `legs` entry, so a
    // starter who re-offers (their first try died, or our ringing ack was
    // lost) swaps `starterOffer.cid` under a peer whose derived phase stays
    // `inviting` forever. The peer-keyed map kept the dead attempt's instant,
    // so a call that has been ringing for two seconds read "May be offline".
    //
    // FALSIFYING CASE: key the map by peer alone again. `second` equals
    // `first` — twelve seconds stale — and this goes red.
    const h = harness();
    const sid = ulid('SRO');
    const firstCid = ulid('CRO1');
    const secondCid = ulid('CRO2');
    await h.deliver(STARTER, ginvite({ sid, cid: firstCid, r: [STARTER, SELF] }));
    const first = h.co.view!.legs.find(l => l.peerId === STARTER)!.invitedAt!;
    expect(first).not.toBeNull();

    h.advance(12_000);
    const at = h.now();
    await h.deliver(STARTER, ginvite({ sid, cid: secondCid, r: [STARTER, SELF] }));

    // The swap really happened: one session, one CXCall, a new ringing cid.
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(
      h.sent.some(f => f.envelope.tcm === 'call.ringing' && f.envelope.cid === secondCid),
    ).toBe(true);

    const second = h.co.view!.legs.find(l => l.peerId === STARTER)!.invitedAt!;
    // A fresh attempt starts its own eight seconds — the property `invitedAt`
    // already promises for a re-offer, which a ringing re-offer is.
    expect(second).toBeGreaterThanOrEqual(at);
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 7e. THE SESSION FENCE (two defects' shared root cause).
//
// `generation` fences DISPOSAL and nothing else — an ordinary session end
// (`state → null`) and session glare both leave it untouched. So an async step
// started under session A resumed happily inside session B and wrote there:
// the same class the generation fence exists against, arriving through the one
// door it does not watch. Every async operation now captures the sid it began
// under and re-checks it before touching state or publishing.
// ---------------------------------------------------------------------------

describe('a step whose session ended while it was suspended', () => {
  it("does not publish B as muted because A's fan finally finished", async () => {
    // THE STALE-FAN RESIDUAL. `setMuted` records intent, fans across A's legs, and
    // then writes `this.muted` unconditionally. Hold that fan inside the
    // bridge, end A, start B — and the write lands on B: a muted glyph over a
    // live microphone, which is the exact lie all-or-close-the-leg exists to
    // prevent, arriving from a call that is already over.
    //
    // FALSIFYING CASE, run at authoring time: drop the sid guard around the
    // post-fan write. `view.muted` reads true for session B and this goes red.
    const held = latch();
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    const cidA = dialledCid(h, B);

    h.native.setAudioEnabled.mockImplementation(async (cid: string) => {
      if (cid === cidA) await held.held;
      return true;
    });
    const fan = h.co.setMuted(true);
    await flush();

    // A ends the ordinary way — no relock, so `generation` never moves.
    await h.co.hangup();
    await h.co.whenIdle();
    const sidB = await h.co.startGroupCall([C], false);
    await h.co.whenIdle();
    await connectLeg(h, C);
    h.native.setAudioEnabled.mockClear();

    held.release();
    await fan;
    await h.co.whenIdle();

    expect(h.co.view!.sid).toBe(sidB);
    // B's microphone was never muted, so B's screen must not say it was.
    expect(h.co.view!.muted).toBe(false);
    // …and no view was ever PUBLISHED claiming otherwise.
    expect(h.views.some(v => v?.sid === sidB && v.muted)).toBe(false);
    // A's fan touched none of B's tracks and closed none of B's legs.
    expect(h.native.setAudioEnabled).not.toHaveBeenCalled();
    expect(h.co.view!.legs.find(l => l.peerId === C)!.phase).toBe('connected');
  });

  it('a REUSED sid is a new session, and a dead fan cannot mute it', async () => {
    // The reason the fence token is an INCARNATION
    // rather than the sid: this device does not mint an inbound session's sid
    // — the remote starter does — so nothing stops a fresh invite reusing a
    // dead session's sid, as a legitimate re-ring or a hostile replay. Under
    // a sid-value fence that reuse passed X === X, the dead session's fan
    // published muted onto the new ring, and because the new session's intent
    // was already reset, ANSWERING it would not have bound the mute to its
    // legs either: a muted glyph over a live microphone, via sid collision.
    //
    // FALSIFYING CASE, run at authoring time: return the fence to the raw
    // sid. The reused-sid ring reads muted:true below and this goes red.
    const SID = ulid('REUSED');
    const held = latch();
    const h = harness();
    const cidA = ulid('RCID1');
    await h.deliver(STARTER, ginvite({ sid: SID, cid: cidA, r: [STARTER, SELF] }));
    await h.co.answer();
    await h.co.whenIdle();
    // Deliberately not driven to connected: the fan walks every non-terminal
    // leg, and an answered-but-connecting leg is exactly the common case.

    h.native.setAudioEnabled.mockImplementation(async (cid: string) => {
      if (cid === cidA) await held.held;
      return true;
    });
    const fan = h.co.setMuted(true);
    await flush();

    // The STARTER ends the session — the ordinary remote end, no relock —
    // and then re-rings with the SAME sid on a fresh cid.
    await h.deliver(STARTER, { tcm: 'call.gleave', sid: SID, m: STARTER, se: 1 });
    await h.co.whenIdle();
    await h.deliver(STARTER, ginvite({ sid: SID, cid: ulid('RCID2'), r: [STARTER, SELF] }));
    await h.co.whenIdle();

    held.release();
    await fan;
    await h.co.whenIdle();

    // The re-ring is a NEW session wearing an old name. The dead fan's
    // achievement belongs to nobody.
    expect(h.co.view!.sid).toBe(SID);
    expect(h.co.view!.muted).toBe(false);
    expect(h.views.filter(v => v?.muted).length).toBeLessThanOrEqual(1); // A's own, at most
    // …AND THE SCREEN IS TOLD SO. A published view carries the incarnation as
    // an opaque `sessionKey`, because a UI that reset itself on `sid` would
    // read this pair of calls as one — and no sid content crosses
    // with it.
    const keys = h.views.filter(v => v?.sid === SID).map(v => v!.sessionKey);
    expect(new Set(keys).size).toBeGreaterThan(1);
    expect(h.co.view!.sessionKey).toBe(Math.max(...keys));
  });

  it("does not dial into B on the strength of A's room fold", async () => {
    // THE CAPTURED-ROOM RESIDUAL. `addParticipant` captures `roomId` and `generation` and
    // not `sid`, so a fold that answers after A ended dispatches an Add into
    // whatever session is live now — a person judged against room A's
    // membership dialled into an ad-hoc call that has no room at all.
    //
    // FALSIFYING CASE: drop the sid guard after the fold. C is added to B's
    // roster and dialled, and every assertion below fails.
    const held = latch();
    let folds = 0;
    const h = harness({
      roomMembers: new Map([[ROOM, [SELF, B, C]]]),
      beforeRoomMembers: async () => {
        if (++folds === 1) await held.held;
      },
    });
    await h.co.startGroupCall([B], false, ROOM);
    await h.co.whenIdle();
    await connectLeg(h, B);

    const add = h.co.addParticipant(C);
    await flush();

    await h.co.hangup();
    await h.co.whenIdle();
    const sidB = await h.co.startGroupCall([D], false);
    await h.co.whenIdle();
    await connectLeg(h, D);

    held.release();
    await add.catch(() => undefined);
    await h.co.whenIdle();

    expect(h.co.view!.sid).toBe(sidB);
    expect(h.co.view!.roster).toEqual([SELF, D]);
    // Nothing reached C at all: no ginvite, no delta, no frame.
    expect(h.sent.some(f => f.peerId === C)).toBe(false);
    expect(h.frames('call.gjoin')).toEqual([]);
  });

  it('does not answer B because the press on A was still minting cids', async () => {
    // THE ANSWER PATH, UNFENCED — and this one opens the microphone.
    // `answer()` captured the generation only, and the generation moves on
    // `dispose()` alone: A can end the ordinary way (its starter leaves)
    // and B can ring, both under ONE generation, while this device is
    // suspended in `answerCids`' mint. The continuation then dispatches
    // `localAnswer` — which names no session at all — and the human's press on
    // A's ring answers B: `createAnswer` starts the camera and the audio track
    // into a call nobody in front of this phone ever consented to.
    //
    // FALSIFYING CASE, run at authoring time: drop the incarnation check after
    // the mint. B is answered — createAnswer runs, a gjoin leaves, the session
    // reads 'joining' — and every assertion below fails.
    const held = latch();
    const h = harness({ beforeMintId: () => held.held });
    const sidA = ulid('SANS1');
    await h.deliver(STARTER, ginvite({ sid: sidA, cid: ulid('CANS1'), r: [STARTER, SELF, B] }));
    expect(h.co.view!.phase).toBe('ringing');

    // The press. It gets as far as the first mint and no further.
    const answering = h.co.answer();
    await flush();
    expect(h.native.createAnswer).not.toHaveBeenCalled();

    // A ends the ordinary way — the starter announces out, no relock, so
    // `generation` never moves.
    await h.deliver(STARTER, { tcm: 'call.gleave', sid: sidA, m: STARTER, se: 1 });
    await h.co.whenIdle();
    expect(h.co.view).toBeNull();

    // …and B rings: a different sid, a different starter, and a roster whose
    // one peer A's cid map happens to cover — so nothing but identity stands
    // between the stale press and B's microphone.
    const sidB = ulid('SANS2');
    await h.deliver(B, ginvite({ sid: sidB, cid: ulid('CANS2'), r: [B, SELF] }));
    await h.co.whenIdle();

    held.release();
    await answering;
    await h.co.whenIdle();

    // B is STILL RINGING, waiting for a human, and nothing opened.
    expect(h.co.view!.sid).toBe(sidB);
    expect(h.co.view!.phase).toBe('ringing');
    expect(h.native.createAnswer).not.toHaveBeenCalled();
    expect(h.frames('call.gjoin')).toEqual([]);
    expect(h.sent.some(f => f.envelope.tcm === 'call.answer')).toBe(false);
    expect(h.views.some(v => v?.sid === sidB && v.phase !== 'ringing')).toBe(false);
  });

  it('does not answer a REUSED sid because CallKit answered the dead one', async () => {
    // THE SAME HOLE ON THE CALLKIT PATH, and worse: `callKitAnswered` carries
    // the raw sid and the reducer admits it on `input.sid === state.sid`. This
    // device does not mint an inbound sid — the REMOTE starter does — so a
    // re-ring (or a replay) can wear the dead session's name, and the sid the
    // dispatch carries then matches the very session it was never meant for.
    // The lock-screen button answered a call that arrived after it was pressed.
    //
    // FALSIFYING CASE, run at authoring time: drop the incarnation check after
    // the mint. The re-ring is answered — createAnswer runs and a gjoin leaves
    // — and every assertion below fails.
    const SID = ulid('REUSE2');
    const held = latch();
    const h = harness({ beforeMintId: () => held.held });
    await h.deliver(STARTER, ginvite({ sid: SID, cid: ulid('CKA1'), r: [STARTER, SELF] }));
    expect(h.co.view!.phase).toBe('ringing');

    // The lock-screen green button, suspended in the mint.
    const answering = h.co.onCallKitAnswer(SID, h.co.captureCallKitPress());
    await flush();
    expect(h.native.createAnswer).not.toHaveBeenCalled();

    // The starter ends the session and re-rings under the SAME sid.
    await h.deliver(STARTER, { tcm: 'call.gleave', sid: SID, m: STARTER, se: 1 });
    await h.co.whenIdle();
    expect(h.co.view).toBeNull();
    await h.deliver(STARTER, ginvite({ sid: SID, cid: ulid('CKA2'), r: [STARTER, SELF] }));
    await h.co.whenIdle();

    held.release();
    const claimed = await answering;
    await h.co.whenIdle();

    // A new session wearing an old name is still a new session, and it is
    // still waiting for a human.
    expect(h.co.view!.sid).toBe(SID);
    expect(h.co.view!.phase).toBe('ringing');
    expect(h.native.createAnswer).not.toHaveBeenCalled();
    expect(h.frames('call.gjoin')).toEqual([]);
    expect(h.sent.some(f => f.envelope.tcm === 'call.answer')).toBe(false);
    expect(h.views.some(v => v?.phase !== 'ringing' && v !== null)).toBe(false);
    // A owned the button when it was pressed. Its successor does not turn
    // that dead sheet into a 1:1 press merely because the reducer declined it.
    expect(claimed).toBe('stale');
  });

  it("does not spend B's retry budget on A's re-offer timer", async () => {
    // THE TIMER THAT OUTLIVES ITS OWN CANCELLATION. The callback's first act
    // is to delete its handle from `reofferTimers`, so from that instant
    // teardown's `clearTimeout` cannot reach it — and what it does next is
    // await a mint and dispatch. Under the generation fence alone, A can end
    // ordinarily and B can install with the same peer sitting in the same
    // retry-pending state, and A's timer then fires a dial B never scheduled,
    // out of B's two-retry budget.
    //
    // FALSIFYING CASE, run at authoring time: drop the incarnation check from
    // the timer body. A second ginvite reaches B inside session B on a cid B
    // never chose, its leg flips back to 'inviting', and the assertions below
    // fail.
    jest.useFakeTimers();
    try {
      const held = latch();
      let hold = false;
      const h = harness({
        beforeMintId: async () => {
          if (hold) await held.held;
        },
      });
      await h.co.startGroupCall([B, C], false);
      await h.co.whenIdle();
      // C connects, so the session outlives B's failure on its own merits.
      await connectLeg(h, C);
      const cidBA = dialledCid(h, B);

      // B refuses BUSY: a failure a re-offer repairs, and — because only a device live
      // in a session sends busy — an announcement too, which is `revivable`'s
      // last condition. The re-offer timer is armed.
      await h.deliver(B, { tcm: 'call.end', cid: cidBA, r: 'busy' });
      await h.co.whenIdle();
      expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('failed');

      // IT FIRES, deletes its handle, and suspends in the mint.
      hold = true;
      jest.advanceTimersByTime(GINVITE_REOFFER_DELAYS_MS[0]);
      await flush();
      hold = false;

      // A ends the ordinary way. No relock: `generation` never moves.
      await h.co.hangup();
      await h.co.whenIdle();
      expect(h.co.view).toBeNull();

      // B: the same peer, dialled again and refused again, sitting in exactly
      // the state A's timer was armed for — with its OWN repair not yet due.
      const sidB = await h.co.startGroupCall([B, C], false);
      await h.co.whenIdle();
      await connectLeg(h, C);
      const cidBB = dialledCid(h, B);
      await h.deliver(B, { tcm: 'call.end', cid: cidBB, r: 'busy' });
      await h.co.whenIdle();
      const ginvitesToB = (): number =>
        h.sent.filter(f => f.peerId === B && f.envelope.tcm === 'call.ginvite').length;
      const before = ginvitesToB();

      held.release();
      await flush();
      await h.co.whenIdle();

      // Nothing dialled, and the leg is untouched: still failed, still on the
      // cid B's own session chose.
      expect(h.co.view!.sid).toBe(sidB);
      expect(ginvitesToB()).toBe(before);
      expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('failed');
      expect(dialledCid(h, B)).toBe(cidBB);

      // AND THE BUDGET IS STILL THERE TO SPEND. The fence must stop A's timer,
      // not re-offers as such — B's own repair comes due and dials, once, on a
      // fresh cid. A test that only proved silence would pass on a coordinator
      // that had forgotten how to repair a leg at all.
      jest.advanceTimersByTime(GINVITE_REOFFER_DELAYS_MS[0]);
      await flush();
      await h.co.whenIdle();
      expect(ginvitesToB()).toBe(before + 1);
      expect(dialledCid(h, B)).not.toBe(cidBB);
      expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('inviting');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 7b. The two presses a queue can carry into the wrong call.
// ---------------------------------------------------------------------------

describe('a lock-screen press whose restore found somebody else’s ring', () => {
  const SID = ulid('USURP');
  const STARTER_CID = ulid('UCID1');

  it('answers nothing when a fresh ring installed while the press was queued', async () => {
    // `onCallKitAnswer` restores when the machine is empty, and
    // `restore` answers TRUE for a session it merely FOUND live — a step that
    // ran while it waited its turn in the queue. This device does not mint an
    // inbound sid (the remote starter does), so the session it found can wear
    // the name of the row still sitting on disk: both the state check and the
    // incarnation check then pass and the press opens the microphone into a
    // call that arrived AFTER the person pressed the button.
    //
    // FALSIFYING CASE, run at authoring time: drop the ring check in
    // `onCallKitAnswer`. `createAnswer` runs for the fresh ring's cid, a gjoin
    // leaves, and every assertion below fails.
    const gate = latch();
    let holdDelete = false;
    const h = harness({
      beforeDeleteSession: async () => {
        if (holdDelete) await gate.held;
      },
      seedSession: {
        sid: SID,
        roomId: null,
        starterId: STARTER,
        roster: [STARTER, SELF],
        se: 0,
        video: false,
        startedAt: BASE,
      },
      seedOffers: [
        {
          cid: STARTER_CID,
          peerId: STARTER,
          sdp: SDP,
          video: false,
          exp: BASE + 60_000,
          serverTs: BASE,
          sid: SID,
        },
      ],
    });

    // AN UNRELATED CALL, ENDING. Its teardown holds the coordinator's queue
    // with `state` already collapsed to null — which is exactly the emptiness
    // a cold press tests for before it restores.
    await h.co.startGroupCall([D], false);
    await h.co.whenIdle();
    await connectLeg(h, D);
    holdDelete = true;
    const ending = h.co.hangup();
    await flush();
    await flush();
    expect(h.co.view).toBeNull();

    // A FRESH RING, wearing the sid of the row on disk. Its dispatch queues
    // behind the held teardown, so it installs BEFORE the restore runs.
    const ringing = h.deliver(
      STARTER,
      ginvite({ sid: SID, cid: ulid('UCID2'), r: [STARTER, SELF] }),
    );
    await flush();

    // The lock-screen green button, pressed on the sheet the OS has been
    // showing since before this process existed.
    const press = h.co.onCallKitAnswer(SID, h.co.captureCallKitPress());
    holdDelete = false;
    gate.release();
    await Promise.all([ending, ringing, press]);
    await h.co.whenIdle();

    // The fresh session is STILL RINGING, waiting for a human, and nothing
    // opened: the sheet this press was made on is gone, and pressing the live
    // one is a thing the person can still do.
    expect(h.co.view!.sid).toBe(SID);
    expect(h.co.view!.phase).toBe('ringing');
    expect(h.native.createAnswer).not.toHaveBeenCalled();
    expect(h.frames('call.gjoin')).toEqual([]);
    expect(h.sent.some(f => f.envelope.tcm === 'call.answer')).toBe(false);
    expect(h.views.some(v => v?.sid === SID && v.phase !== 'ringing')).toBe(false);
  });
});

describe('an End pressed on the call that is still on the screen', () => {
  /** A sid that sorts BELOW anything `mintId` produces, so it wins glare. */
  const WINNER_SID = ulid('0');
  const WINNER_CID = ulid('0CID');

  it('does not tear down the glare winner that installed while it was queued', async () => {
    // `hangup()` names no session: it was checked at ENQUEUE time
    // and not at execution time, so a press made against session A — still the
    // only thing on the screen — ran after the winner of a glare had already
    // replaced it, and demolished a call this device had just started ringing
    // for. That is not the demolition `dispose()` owns: the press never began
    // tearing A down, it tore its SUCCESSOR down first.
    //
    // FALSIFYING CASE, run at authoring time: send the End through the plain
    // `dispatch` again. The winner is ended, `view` reads null, and the first
    // three assertions fail.
    const held = latch();
    let names = 0;
    const h = harness({
      beforeDisplayName: async () => {
        if (++names === 1) await held.held;
      },
    });
    // A's own step is suspended in its outgoing report — the queue is held
    // with A installed, which is what the person is looking at.
    const start = h.co.startGroupCall([B], false);
    await flush();
    const loserSid = h.co.view!.sid;
    expect(loserSid).not.toBe(WINNER_SID);

    // The glare winner's invite: admitted, and its dispatch queued behind A's
    // step.
    const invite = h.deliver(B, ginvite({ sid: WINNER_SID, cid: WINNER_CID, r: [B, SELF] }));
    await flush();
    expect(h.co.view!.sid).toBe(loserSid);

    // THE PRESS, made on A's screen, queued behind the swap it cannot see.
    const end = h.co.hangup();
    held.release();
    await Promise.all([start, invite, end]);
    await h.co.whenIdle();

    // The winner survived, still ringing…
    expect(h.co.view).not.toBeNull();
    expect(h.co.view!.sid).toBe(WINNER_SID);
    expect(h.co.view!.phase).toBe('ringing');
    // …and nobody was told this device hung up on it.
    expect(
      h.sent.some(f => f.envelope.tcm === 'call.end' && f.envelope.cid === WINNER_CID),
    ).toBe(false);
  });

  it('still ends the call when no swap intervened', async () => {
    // THE LIVENESS HALF. A fence that refused every End would pass the test
    // above and ship a phone nobody can hang up.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    const cid = dialledCid(h, B);

    await h.co.hangup();
    await h.co.whenIdle();

    expect(h.co.view).toBeNull();
    expect(
      h.sent.some(f => f.peerId === B && f.envelope.tcm === 'call.end' && f.envelope.cid === cid),
    ).toBe(true);
  });
});

describe('a CallKit End that waits behind a session replacement', () => {
  it('does not tear down a fresh session wearing the same sid', async () => {
    // THE SID PROVES NOTHING HERE. A remote starter mints inbound sids, so B
    // can wear A's exact name. A's ordinary end and B's invite are already in
    // the queue when the red-button input joins it; by the time the raw
    // `callKitEnded {sid}` runs, it matches B and demolishes the successor.
    //
    // FALSIFYING CASE: use plain `dispatch` for `callKitEnded`. The final view
    // is null instead of B's still-ringing session.
    const held = latch();
    let names = 0;
    const h = harness({
      beforeDisplayName: async () => {
        if (++names === 1) await held.held;
      },
    });

    // A is installed and visible, but its first effect holds the queue.
    const startA = h.co.startGroupCall([D], false);
    await flush();
    const sid = h.co.view!.sid;

    // A ends first; B's fresh same-sid invite installs second. Both are ahead
    // of the red-button input, while the person can still only see A.
    const endA = h.co.hangup();
    const ringB = h.deliver(
      B,
      ginvite({ sid, cid: ulid('CKEND2'), r: [B, SELF] }),
    );
    await flush();
    const pressedEnd = h.co.onCallKitEnd(sid, h.co.captureCallKitPress());

    held.release();
    const [, , , claimed] = await Promise.all([startA, endA, ringB, pressedEnd]);
    await h.co.whenIdle();

    expect(h.co.view).not.toBeNull();
    expect(h.co.view!.sid).toBe(sid);
    expect(h.co.view!.phase).toBe('ringing');
    expect(
      h.sent.some(
        f => f.envelope.tcm === 'call.end' && f.envelope.cid === ulid('CKEND2'),
      ),
    ).toBe(false);
    expect(claimed).toBe('stale');
  });

  it('still ends the session named by an unmoved CallKit press', async () => {
    // THE LIVENESS HALF. An execution-slot fence that drops every press makes
    // the stale test green and leaves the system red button ornamental.
    const h = harness();
    const sid = ulid('CKLIVE');
    const cid = ulid('CKLIVEC');
    await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF] }));

    expect(await h.co.onCallKitEnd(sid, h.co.captureCallKitPress())).toBe('claimed');
    await h.co.whenIdle();

    expect(h.co.view).toBeNull();
    expect(
      h.sent.some(
        f => f.peerId === STARTER && f.envelope.tcm === 'call.end' && f.envelope.cid === cid,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. The ring path, and the one CXCall it reports.
// ---------------------------------------------------------------------------

describe('being rung into a session', () => {
  it('rings ONCE for a session, however many invites arrive', async () => {
    // A second same-sid invite while ringing is admitted and HELD — never
    // a second ring, and critically never an answer before the human answers
    // (`createAnswer` starts the camera).
    const h = harness();
    const sid = ulid('SR1');
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CR1'), r: [STARTER, SELF, B] }));
    await h.deliver(B, ginvite({ sid, cid: ulid('CR2'), r: [STARTER, SELF, B] }));

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.native.reportIncomingCall.mock.calls[0][0]).toBe(sid);
    expect(h.native.createAnswer).not.toHaveBeenCalled();

    await h.co.answer();
    await h.co.whenIdle();
    // Both legs answered now, and only now.
    expect(h.native.createAnswer).toHaveBeenCalledTimes(2);
  });

  it('the ring acks, so the starter sees "Ringing…" rather than a silence', async () => {
    const h = harness();
    const cid = ulid('CR3');
    await h.deliver(STARTER, ginvite({ sid: ulid('SR3'), cid, r: [STARTER, SELF] }));
    expect(
      h.sent.filter(f => f.envelope.tcm === 'call.ringing' && f.envelope.cid === cid),
    ).toHaveLength(1);
  });

  it('a declined ring tells every held leg at once and writes no session row behind', async () => {
    const h = harness();
    const sid = ulid('SR4');
    const starterCid = ulid('CR4');
    const heldCid = ulid('CR5');
    await h.deliver(STARTER, ginvite({ sid, cid: starterCid, r: [STARTER, SELF, B] }));
    await h.deliver(B, ginvite({ sid, cid: heldCid, r: [STARTER, SELF, B] }));

    await h.co.decline();
    await h.co.whenIdle();

    const declines = h.sent.filter(
      f => f.envelope.tcm === 'call.end' && f.envelope.r === 'decline',
    );
    expect(declines.map(f => f.peerId).sort()).toEqual([B, STARTER].sort());
    expect(h.sessions.has(sid)).toBe(false);
    // Declining is not leaving a call you never joined: no gleave, ever.
    expect(h.frames('call.gleave')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. The ginvite IS the leg offer.
// ---------------------------------------------------------------------------

describe('the wire a leg actually speaks', () => {
  it('a dial leaves as call.ginvite carrying the session binding and the roster', async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    const frame = h.frames('call.ginvite')[0];
    expect(frame.envelope.sid).toBe(sid);
    expect(frame.envelope.sdp).toBe(SDP);
    expect(frame.envelope.r).toEqual([SELF, B, C]);
    // Urgent: it is what wakes a sleeping phone.
    expect(frame.urgent).toBe(true);
    // And NO bare call.offer ever leaves — an old build must not half-join a
    // small-group call as a 1:1.
    expect(h.frames('call.offer')).toEqual([]);
  });

  it('everything after the offer travels as the ordinary 1:1 kind', async () => {
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    const cid = dialledCid(h, B);
    await h.deliver(B, { tcm: 'call.answer', cid, sdp: ANSWER_SDP, vid: false });
    // A full envelope's worth, so the batch flushes on size rather than on
    // the 200 ms window timer this test does not run.
    for (let i = 0; i < 10; i++) {
      h.co.onLocalIceCandidate(cid, {
        cand: `candidate:${i} 1 udp 1 10.0.0.1 1 typ host`,
        mid: '0',
        idx: 0,
      });
    }
    await h.co.whenIdle();
    expect(h.frames('call.ice').length).toBeGreaterThan(0);
    expect(h.frames('call.ice')[0].envelope.cid).toBe(cid);
  });

  it('a roster delta is never urgent — it must not spend the push budget', async () => {
    const h = harness();
    const sid = ulid('SR6');
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CR6'), r: [STARTER, SELF, B] }));
    await h.co.answer();
    await h.co.whenIdle();
    const joins = h.frames('call.gjoin');
    expect(joins.length).toBeGreaterThan(0);
    for (const frame of joins) expect(frame.urgent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. The router seam's own contract.
// ---------------------------------------------------------------------------

describe('the groupRouter seam', () => {
  it('claims call.g* always, and a 1:1 kind only for a cid this session owns', async () => {
    const h = harness();
    expect(h.co.handles(B, ginvite({ sid: ulid('SR7'), cid: ulid('CR7'), r: [B, SELF] }))).toBe(true);
    // Nothing is live: a 1:1 frame belongs to the 1:1 controller, untouched.
    expect(h.co.handles(B, { tcm: 'call.offer', cid: ulid('CR8'), sdp: SDP, vid: false, exp: BASE })).toBe(false);
    expect(h.co.handles(B, { tcm: 'react', m: 'x' })).toBe(false);

    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    const cid = dialledCid(h, B);
    expect(h.co.handles(B, { tcm: 'call.answer', cid, sdp: ANSWER_SDP, vid: false })).toBe(true);
    // A cid from someone else's call is still not ours.
    expect(h.co.handles(B, { tcm: 'call.ice', cid: ulid('CR9'), c: [] })).toBe(false);
  });

  it('liveSessionBusy is true exactly while a session lives', async () => {
    const h = harness();
    expect(h.co.liveSessionBusy()).toBe(false);
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    expect(h.co.liveSessionBusy()).toBe(true);
    await h.co.hangup();
    await h.co.whenIdle();
    expect(h.co.liveSessionBusy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. The starter leaving.
// ---------------------------------------------------------------------------

describe('when the person who started the call leaves', () => {
  it("the starter's hangup broadcasts an AUTHORITY gleave naming themself", async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await h.co.hangup();
    await h.co.whenIdle();

    const leaves = h.frames('call.gleave');
    expect(leaves.length).toBe(2);
    for (const frame of leaves) {
      expect(frame.envelope.sid).toBe(sid);
      expect(frame.envelope.m).toBe(SELF);
      expect(frame.envelope.se).toBe(1); // the NEXT epoch — an authority write
    }
  });

  it("a NON-starter's gleave naming the starter ends nobody's call", async () => {
    // The distributed-hangup twin of the distributed dialler, and the single
    // most important falsifier in the session layer — re-asserted here through
    // the full coordinator, where the CXCall is real.
    const h = harness();
    const sid = ulid('SR8');
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CRA'), r: [STARTER, SELF, B] }));
    await h.co.answer();
    await h.co.whenIdle();
    const releases = () => h.native.endCall.mock.calls.filter(c => c[0] === sid).length;
    expect(releases()).toBe(0);

    await h.deliver(B, { tcm: 'call.gleave', sid, m: STARTER, se: 1 });

    expect(releases()).toBe(0);
    expect(h.co.view).not.toBeNull();
    expect(h.co.view!.sid).toBe(sid);
  });

  it("the STARTER's own gleave does end it, for everyone", async () => {
    const h = harness();
    const sid = ulid('SR9');
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CRB'), r: [STARTER, SELF, B] }));
    await h.co.answer();
    await h.co.whenIdle();

    await h.deliver(STARTER, { tcm: 'call.gleave', sid, m: STARTER, se: 1 });

    expect(h.native.endCall.mock.calls.filter(c => c[0] === sid)).toHaveLength(1);
    expect(h.co.view).toBeNull();
    expect(h.sessions.has(sid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. The VoIP push placeholder, which the group path used to walk past.
// ---------------------------------------------------------------------------

describe('the push placeholder a ginvite arrives behind', () => {
  it('a declined placeholder means the session NEVER rings', async () => {
    // The phone rang twice for one call: the person declined the placeholder,
    // the ginvite decrypted seconds later, and the coordinator — which
    // `handles()` routes to before the offer path that consults the tombstone
    // — reported a fresh CXCall for the call they had just refused.
    //
    // FALSIFIER, run at authoring time: delete the `takePushDecline` consult
    // in `handleInvite` — reportIncomingCall is called and this fails.
    const h = harness({ pushDeclined: new Set([STARTER]) });
    await h.deliver(STARTER, ginvite({ sid: ulid('SD1'), cid: ulid('CD1'), r: [STARTER, SELF] }));

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.co.view).toBeNull();
    // The caller learns, which is the frame that was impossible to send from
    // a synthetic cid.
    expect(h.frames('call.end').map(f => f.envelope.r)).toEqual(['decline']);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');
    expect(h.logs.map(r => r.reason)).toEqual(['decline']);
  });

  it('is consumed, so the starter can ring again a moment later', async () => {
    const declined = new Set([STARTER]);
    const h = harness({ pushDeclined: declined });
    await h.deliver(STARTER, ginvite({ sid: ulid('SD2'), cid: ulid('CD2'), r: [STARTER, SELF] }));
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();

    await h.deliver(STARTER, ginvite({ sid: ulid('SD3'), cid: ulid('CD3'), r: [STARTER, SELF] }));
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('EVERY refusal dismisses it — blocked, busy, expired', async () => {
    // A refused invite whose placeholder is left ringing is a full-screen
    // ring in front of a call that will never happen: the caller has already
    // heard the refusal, or stopped, and nothing local can end it.
    const blocked = harness({ blocked: new Set([B]) });
    await blocked.deliver(
      STARTER,
      ginvite({ sid: ulid('SD4'), cid: ulid('CD4'), r: [STARTER, SELF, B] }),
    );
    expect(blocked.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');

    const busy = harness({ oneToOneBusy: true });
    await busy.deliver(STARTER, ginvite({ sid: ulid('SD5'), cid: ulid('CD5'), r: [STARTER, SELF] }));
    expect(busy.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');

    const expired = harness();
    await expired.deliver(
      STARTER,
      // Past its life by more than the skew forgiveness (OFFER_EXP_SKEW_MS).
      ginvite({
        sid: ulid('SD6'),
        cid: ulid('CD6'),
        r: [STARTER, SELF],
        exp: BASE - 60_000,
      }),
    );
    expect(expired.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(expired.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'expired', '');
  });

  it('and a stranger refused by the REDUCER while a session is live', async () => {
    // The refusal the coordinator does not decide: `inviteWhileLive` answers
    // busy through a `closeLeg`, and that ring arrived behind a placeholder
    // exactly like any other.
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();

    await h.deliver(STRANGER, ginvite({ sid, cid: ulid('CD7'), r: [STRANGER, SELF] }));

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STRANGER, 'declined', '');
    expect(h.co.view!.sid).toBe(sid);
  });

  it('names the placeholder it refused', async () => {
    // CONSTRAINT 1, THE GROUP ARM. Every dismissal from here now says WHICH
    // placeholder it is ending. Peer-keying alone was enough only while a
    // peer could have at most one placeholder in a refusal's lifetime, and
    // that has never been true: the refusals below sit behind `mayRing`, a
    // persist and a credential fetch, and a second push can land in any of
    // them.
    const h = harness({ ringCids: new Map([[STARTER, 's1']]) });
    await h.deliver(
      STARTER,
      ginvite({
        sid: ulid('SD8'),
        cid: ulid('CD8'),
        r: [STARTER, SELF],
        exp: BASE - 60_000,
      }),
    );

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'expired', 's1');
  });

  it('a gleave nothing claimed is routed to the decided-cancellation path', async () => {
    // RULE 1, THE BEHAVIOURAL TWIN. The 1:1 `call.end` branch treats an end
    // naming no live call as an ambiguous CANCELLATION and gives it the grace;
    // the group arm dropped its gleave into the router's `adopted === false`
    // and let the controller file it as 'not_call' — .unanswered, i.e. "you
    // ignored them", for a call the other side hung up.
    const h = harness();
    await h.deliver(STARTER, { tcm: 'call.gleave', sid: ulid('SD9'), m: STARTER, se: 1 });

    expect(h.ringCancels).toEqual([STARTER]);
  });

  it('a gleave a LIVE session claims is not a cancellation', async () => {
    // The group arm's `namesLiveCall`. A leave inside a running session is
    // ordinary traffic — somebody stepping out of a call this phone is in —
    // not "they hung up on a ring you never saw". Routed to the decided
    // cancellation it would schedule a dismissal against a session that is
    // live, and spend the push notes an unanswered decline still needs.
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();

    await h.deliver(B, { tcm: 'call.gleave', sid, m: B, se: 1 });

    expect(h.ringCancels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12b. Silence unknown callers, applied to a session invite.
//
// The shipped defect this section exists for: `handles()` routes a
// `call.ginvite` to the coordinator and RETURNS, before the 1:1 `call.offer`
// branch that consults `mayRing` — so the rule the Terms state without
// qualification ("someone you have never exchanged a message with cannot make
// your phone ring") was true of a 1:1 call and false of a group invite. A
// stranger who put you in a roster made your phone ring, at any hour.
//
// FALSIFIER FOR THE WHOLE SECTION, run before the fix existed: with the gate
// removed from `handleInvite`, the first, fourth-b, seventh, eighth and ninth
// tests below all fail — `reportIncomingCall` is called for an inviter this
// device has never exchanged a message with. Restored.
// ---------------------------------------------------------------------------

describe('a stranger who puts you in a small-group roster', () => {
  it('does not make the phone ring, and spends nothing on the attempt', async () => {
    const h = harness({ silenceUnknown: true });
    await h.deliver(STARTER, ginvite({ sid: ulid('SU1'), cid: ulid('CU1'), r: [STARTER, SELF] }));

    // THE RING, which is the whole promise.
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.co.view).toBeNull();
    // No session was built, so nothing joined either: "you are in a call you
    // never heard about" is its own defect, and the softer verdict is still a
    // refusal — exactly as the 1:1 path returns before its own dispatch.
    expect(h.trace.some(t => t.startsWith('saveSession('))).toBe(false);
    // And nothing was spent BEFORE the decision: no credential fetched, no
    // stranger's SDP, DTLS fingerprint and candidate set written to disk for
    // a call that will never happen. This is why the gate sits at the top of
    // the ringable branch rather than after the persist.
    expect(h.trace).not.toContain('ensureCredentials()');
    expect(h.trace.some(t => t.startsWith('saveOffer('))).toBe(false);
    // Asked once, about the person reaching us.
    expect(h.ringChecks).toEqual([STARTER]);
  });

  it('DOES ring when the person turned the setting off', async () => {
    // The gate is a setting, not a wall: this is the same invite from the
    // same stranger, and it rings. FALSIFIER, run: drop `!permission.ring`
    // from the silence branch's condition, so the verdict is ignored and
    // every inviter is silenced — this test and the next two go red. That is
    // what proves the test above measures the policy rather than a
    // coordinator that quietly stopped ringing for everybody. Restored.
    const h = harness({ silenceUnknown: false });
    await h.deliver(STARTER, ginvite({ sid: ulid('SU2'), cid: ulid('CU2'), r: [STARTER, SELF] }));

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.co.view).not.toBeNull();
  });

  it('rings from someone you HAVE exchanged a message with, either way', async () => {
    const on = harness({ silenceUnknown: true, known: new Set([STARTER]) });
    await on.deliver(STARTER, ginvite({ sid: ulid('SU3'), cid: ulid('CU3'), r: [STARTER, SELF] }));
    expect(on.native.reportIncomingCall).toHaveBeenCalledTimes(1);

    const off = harness({ silenceUnknown: false, known: new Set([STARTER]) });
    await off.deliver(STARTER, ginvite({ sid: ulid('SU4'), cid: ulid('CU4'), r: [STARTER, SELF] }));
    expect(off.native.reportIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('is judged on the INVITER, never on the roster they assert', async () => {
    // WHOSE HISTORY MATTERS, in both directions, because the roster is
    // PAYLOAD and `from` is the ratchet-authenticated writerId.
    //
    // (a) A friend who added people you have never met still rings. Reading
    //     the rule as "history with everyone in `r`" would silence exactly
    //     the call small groups exist for.
    const friend = harness({ silenceUnknown: true, known: new Set([STARTER]) });
    await friend.deliver(
      STARTER,
      ginvite({ sid: ulid('SU5'), cid: ulid('CU5'), r: [STARTER, SELF, B, C, D] }),
    );
    expect(friend.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(friend.ringChecks).toEqual([STARTER]);

    // (b) A stranger who names your entire address book does NOT ring.
    //     Reading the rule as "somebody in `r` is known" would hand the gate
    //     to the one party it exists to stop: `r` is theirs to write.
    //     FALSIFIER, run: consult
    //     `invite.r.filter(id => id !== selfId).at(-1)` instead of `from` —
    //     this test fails on both halves at once (the friend's call is
    //     silenced by D, the stranger's rings on D) and every other test in
    //     this section still passes, so it is this test that pins the
    //     direction. Restored. (A first-roster-entry mutation proves nothing:
    //     `r` conventionally names its sender first, so it is a no-op.)
    const stranger = harness({ silenceUnknown: true, known: new Set([B, C, D]) });
    await stranger.deliver(
      STRANGER,
      ginvite({ sid: ulid('SU6'), cid: ulid('CU6'), r: [STRANGER, SELF, B, C, D] }),
    );
    expect(stranger.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(stranger.ringChecks).toEqual([STRANGER]);
  });

  it('leaves a missed-call row, because silencing is not hiding', async () => {
    // The asymmetry the default rests on (`policy.ts`): a wrongly silenced
    // call costs a delayed call back, and the person can only make that call
    // back if the row exists. FALSIFIER: delete the `writeAggregateRow` call
    // from the silence branch — the invite still does not ring and this
    // fails, which is the difference between silencing and hiding.
    const sid = ulid('SU7');
    const h = harness({ silenceUnknown: true });
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CU7'), r: [STARTER, SELF], vid: true }));

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      peerId: STARTER,
      direction: 'in',
      kind: 'video',
      // `decline`, not `blocked`: the device declined this under a policy its
      // owner set, and the row must not accuse them of blocking someone they
      // never blocked.
      reason: 'decline',
      missed: true,
      sessionId: sid,
    });
  });

  it('dismisses the VoIP placeholder the push already rang', async () => {
    // The push arrives BEFORE anything can decrypt, so a silence with no
    // dismissal is a phone that rang anyway with a full-screen ring left
    // sitting in front of a call that will never happen. One dismissal is the
    // whole of it: N legs are ONE CallKit call and the placeholder is
    // matched on the peer that pushed — the inviter.
    // FALSIFIER: drop the `dismissPlaceholder` call from the silence branch
    // and this fails while every other test here still passes.
    const h = harness({ silenceUnknown: true });
    await h.deliver(STARTER, ginvite({ sid: ulid('SU8'), cid: ulid('CU8'), r: [STARTER, SELF] }));

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('tells the inviter NOTHING — not a decline, not busy, not ringing', async () => {
    // A silenced invite must be indistinguishable from one that reached a
    // phone that was off. Every other refusal in `handleInvite` sends
    // something back; this one must not, or the silence announces itself and
    // becomes a way to probe for it.
    const h = harness({ silenceUnknown: true });
    await h.deliver(STARTER, ginvite({ sid: ulid('SU9'), cid: ulid('CU9'), r: [STARTER, SELF] }));
    expect(h.sent).toEqual([]);

    // The contrast, on the same envelope shape: a placeholder the person
    // actually declined DOES tell the starter. So the emptiness above is a
    // property of this branch, not of a harness that cannot send.
    const declined = harness({ silenceUnknown: true, pushDeclined: new Set([STARTER]) });
    await declined.deliver(
      STARTER,
      ginvite({ sid: ulid('SUA'), cid: ulid('CUA'), r: [STARTER, SELF] }),
    );
    expect(declined.frames('call.end').map(f => f.envelope.r)).toEqual(['decline']);
  });

  it('stays silent when the verdict itself fails', async () => {
    // The one fallback in this file that fails toward quiet rather than
    // toward a working phone (`loadSilenceUnknownCallers`'s asymmetry): a
    // database that cannot say whether this is a stranger is not a reason to
    // let a stranger ring at 3am. It still dismisses and still writes the
    // row, so the failure is visible rather than an invite that vanished.
    // FALSIFIER: `.catch(() => ({ ring: true }))` and this fails.
    const h = harness({ silenceUnknown: true, known: new Set([STARTER]), mayRingThrows: true });
    await h.deliver(STARTER, ginvite({ sid: ulid('SUB'), cid: ulid('CUB'), r: [STARTER, SELF] }));

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');
    expect(h.logs.map(r => r.reason)).toEqual(['decline']);
  });

  it('does not regress the BLOCK, which is a harder verdict and stays first', async () => {
    // A blocked inviter is refused by the block — the whole session, with a
    // row that says `blocked` — and the gate is never even consulted. The two
    // rules must not collapse into one another: `blocked` is a fact about a
    // person the owner acted on, `decline` is a policy the device applied.
    const inviter = harness({ silenceUnknown: true, blocked: new Set([STARTER]) });
    await inviter.deliver(
      STARTER,
      ginvite({ sid: ulid('SUC'), cid: ulid('CUC'), r: [STARTER, SELF] }),
    );
    expect(inviter.logs.map(r => r.reason)).toEqual(['blocked']);
    expect(inviter.ringChecks).toEqual([]);
    expect(inviter.sent).toEqual([]);

    // And a blocked MEMBER still refuses the whole session even though the
    // inviter is someone you know and the gate would have let them ring.
    const member = harness({
      silenceUnknown: true,
      known: new Set([STARTER]),
      blocked: new Set([B]),
    });
    await member.deliver(
      STARTER,
      ginvite({ sid: ulid('SUD'), cid: ulid('CUD'), r: [STARTER, SELF, B] }),
    );
    expect(member.logs.map(r => r.reason)).toEqual(['blocked']);
    expect(member.native.reportIncomingCall).not.toHaveBeenCalled();
  });

  it('never judges an invite that arrives into a LIVE session', async () => {
    // THE LEG THIS MUST NOT CUT. Inside a running session, invites arrive
    // from non-starter pairs, from re-offers and from late joiners —
    // accounts the STARTER's roster admitted, several of whom a person
    // legitimately has no history with (the friend-of-a-friend). None of them
    // rings anything on its own, so none of them is a caller reaching this
    // phone, and judging them would break a call the person is already in.
    // FALSIFIER: drop the `this.state === null` guard from the gate and the
    // stranger's invite below is silenced instead of answered, so the
    // dismissal assertion fails and `ringChecks` is no longer empty.
    const h = harness({ silenceUnknown: true, known: new Set([B]) });
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    h.ringChecks.length = 0;

    await h.deliver(STRANGER, ginvite({ sid, cid: ulid('CUE'), r: [STRANGER, SELF] }));

    expect(h.ringChecks).toEqual([]);
    // The shipped refusal is unchanged: the reducer answers busy through a
    // closeLeg and the placeholder is dismissed.
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STRANGER, 'declined', '');
    expect(h.co.view!.sid).toBe(sid);
  });

  it('leaves an EXPIRED invite its own accounting', async () => {
    // The gate sits inside the ringable branch, so an invite past its life
    // keeps the row and the dismissal reason that describe what actually
    // happened — the 1:1 path's ordering, where expiry is answered before
    // `mayRing` is consulted at all. A row reading `decline` here would tell
    // the person their phone refused a call that had already died.
    const h = harness({ silenceUnknown: true });
    await h.deliver(
      STARTER,
      ginvite({
        sid: ulid('SUF'),
        cid: ulid('CUF'),
        r: [STARTER, SELF],
        exp: BASE - 60_000,
      }),
    );

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.logs.map(r => r.reason)).toEqual(['expired']);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'expired', '');
    expect(h.ringChecks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 13. Session glare, executed (the coordinator half).
// ---------------------------------------------------------------------------

describe('when a lower sid supersedes the session we started', () => {
  /** A sid that sorts BELOW anything `mintId` produces, so it wins glare. */
  const WINNER_SID = ulid('0');
  const WINNER_CID = ulid('0CID');

  it("deletes the LOSER's row, not the winner's, and keeps no scratch across", async () => {
    // Both halves of the same mistake: the loser's teardown runs AFTER the
    // state has already become the winner. `closeSessionRow` therefore named
    // the winner (whose row the winner's own `writeSessionRow` then restored)
    // and the loser's row survived the call it belonged to; and the scratch
    // reset, keyed on state-to-null, never ran at all — so the losing
    // session's mute flag, leg services and timers crossed into a call they
    // were never part of.
    const h = harness();
    const loserSid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    // NOT connected: glare is two invites crossing in flight, and a session
    // already carrying media crossed nothing — B's lower sid into a connected
    // call is busy, not a supersede (this test used to connect the leg first
    // and was rewritten deliberately). The dialled leg's media exists, so the
    // mute below still reaches it.
    await h.co.setMuted(true);
    await h.co.whenIdle();
    expect(h.co.view!.muted).toBe(true);
    expect(h.sessions.has(loserSid)).toBe(true);

    await h.deliver(B, ginvite({ sid: WINNER_SID, cid: WINNER_CID, r: [B, SELF] }));

    expect(h.co.view!.sid).toBe(WINNER_SID);
    // The row that goes is the one whose call ended.
    expect(h.sessions.has(loserSid)).toBe(false);
    expect(h.sessions.has(WINNER_SID)).toBe(true);
    // A fresh session's microphone is live. Inheriting `muted` would show a
    // muted button over a transmitting microphone — the same false claim
    // about the hardware that all-or-close-the-leg exists to prevent, only
    // upside down.
    expect(h.co.view!.muted).toBe(false);
    // And the winner really is ringing: its own leg acked.
    expect(
      h.sent.some(f => f.envelope.tcm === 'call.ringing' && f.envelope.cid === WINNER_CID),
    ).toBe(true);
  });

  it('does not hand the winner the loser’s "waiting since" for the same peer', async () => {
    // THE GLARE RESIDUAL. `syncInvitedAt()` runs at the top of the step —
    // with the winner already in `state` and the LOSER's anchors still in the
    // map — and publishes before any effect. The scratch reset that follows
    // clears the map without re-stamping or notifying, so the winner's first
    // frame carried a twelve-second-old instant for a peer who has been
    // ringing for zero seconds, and every frame after it carried none at all.
    //
    // FALSIFYING CASE: remove the re-stamp at the loser/winner boundary and
    // key the anchors by peer alone. The published winner view carries the
    // loser's instant and the final view carries null; both halves go red.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    const stale = h.co.view!.legs.find(l => l.peerId === B)!.invitedAt!;

    h.advance(12_000);
    const at = h.now();
    await h.deliver(B, ginvite({ sid: WINNER_SID, cid: WINNER_CID, r: [B, SELF] }));

    expect(h.co.view!.sid).toBe(WINNER_SID);
    const anchor = h.co.view!.legs.find(l => l.peerId === B)!.invitedAt;
    // The winner is waiting on B from NOW — not from the losing call, and not
    // from nowhere: a null anchor is a tile that can never say "May be
    // offline" for the rest of the ring.
    expect(anchor).not.toBeNull();
    expect(anchor).toBeGreaterThanOrEqual(at);
    expect(anchor).not.toBe(stale);
    // And no view published under the winner's sid ever said otherwise —
    // including by saying NOTHING. The first version of this loop judged only
    // non-null anchors, and a verified mutation walked straight through it:
    // with the boundary re-stamp deleted, the view published at the
    // loser/winner boundary carried `invitedAt: null` (the scratch reset had
    // cleared the map, and nothing re-stamped before the notify), the next
    // step's per-attempt sync repaired it, and every assertion here still
    // passed. A null anchor is not neutral — it is a tile that cannot say
    // "May be offline" for as long as it lasts — so B's anchor must be
    // PRESENT and fresh in every winner-sid view, the boundary's included.
    for (const v of h.views) {
      if (!v || v.sid !== WINNER_SID) continue;
      const b = v.legs.find(l => l.peerId === B);
      // Only an 'inviting' leg owes an anchor — production rightly clears it
      // once the peer progresses (the over-constraint note).
      if (b && b.phase === 'inviting') {
        expect(b.invitedAt).not.toBeNull();
        expect(b.invitedAt).toBeGreaterThanOrEqual(at);
      }
      for (const leg of v.legs) {
        if (leg.invitedAt !== null) expect(leg.invitedAt).toBeGreaterThanOrEqual(at);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 14. What a finished session leaves behind (retention).
// ---------------------------------------------------------------------------

describe('nothing outlives the call it belonged to', () => {
  it('a declined session takes its stored offers with it', async () => {
    // The row holds a peer id, a DTLS fingerprint and a set of candidate
    // addresses. `takeCallOffersForSession` consumes them on the RESTORE
    // path; the ordinary terminal path consumed nothing, so they waited for a
    // boot prune bounded by the ring TTL — which on a phone that is never
    // force-quit is no bound at all.
    const h = harness();
    const sid = ulid('SK1');
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CK1'), r: [STARTER, SELF, B] }));
    await h.deliver(B, ginvite({ sid, cid: ulid('CK2'), r: [STARTER, SELF, B] }));
    expect(h.offers.size).toBe(2);

    await h.co.decline();
    await h.co.whenIdle();

    expect(h.offers.size).toBe(0);
    expect(h.sessions.has(sid)).toBe(false);
  });

  it('a departed leg whose teardown never settles is released on a deadline', async () => {
    // A liveness hole. The rule below — never release a service that
    // still owns a call — is right, because `dispose()` would abandon the very
    // demolition that teardown exists to perform. But it was written with no
    // fallback, so "still winding down" and "wound down and stuck" were the
    // same answer: one native close that never resolves (a wedged bridge, a
    // peer connection whose `close` blocks) kept the service, its cid, its end
    // reason and its skip note resident for the WHOLE session, and starter-
    // authorised remove/add churn is unbounded in exactly that dimension.
    //
    // So the wait is bounded, in the idiom the 1:1 path already uses for a
    // hung connect (CALL_CONNECT_TIMEOUT_MS and its family): a departed leg
    // still unreleased after DEPARTED_LEG_TEARDOWN_MS is force-disposed, and
    // the close its own teardown could not finish is issued from here.
    jest.useFakeTimers();
    try {
      const entered = latch();
      const gate = latch();
      const h = harness();
      const sid = ulid('SDL1');
      const cid0 = ulid('CDL0');
      // SELF LAST, so B's leg is ours to dial (the roster-index rule).
      await h.deliver(STARTER, ginvite({ sid, cid: cid0, r: [STARTER, B, SELF] }));
      await h.co.answer();
      await h.co.whenIdle();
      // The starter's leg connects, so the session survives B's departure and
      // so that only B's connect timer is left armed.
      await h.co.onIceStateChanged(cid0, 'connected');
      await h.co.whenIdle();
      const cidB = dialledCid(h, B);
      expect(h.co.residentLegs).toBe(2);

      // B's leg gives up on its own — and its `closePeerConnection` wedges.
      h.native.close.mockImplementation(async (c: string) => {
        if (c !== cidB) return;
        entered.release();
        await gate.held;
      });
      jest.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
      await entered.held;
      await flush();

      // The starter removes B: departed, terminal, and reclaimable — except
      // that its service still owns a call it can never finish ending.
      await h.deliver(STARTER, { tcm: 'call.gleave', sid, m: B, se: 1 });
      expect(h.co.view!.roster).not.toContain(B);
      expect(h.co.residentLegs).toBe(2);
      expect(h.native.close.mock.calls.filter(c => c[0] === cidB)).toHaveLength(1);

      jest.advanceTimersByTime(DEPARTED_LEG_TEARDOWN_MS);
      await flush();

      expect(h.co.residentLegs).toBe(1);
      // Forced, and WITH the close: dropping the reference without it is how a
      // departed peer keeps receiving audio from a call they left.
      expect(h.native.close.mock.calls.filter(c => c[0] === cidB)).toHaveLength(2);
      // And the session it departed from is untouched.
      expect(h.co.view).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a departed deadline does not dispose the leg its peer came BACK on', async () => {
    // The deadline above is armed against a peer who has left and
    // whose teardown will not settle. But leaving is not permanent: the starter
    // can re-add the same account, and a re-added peer gets a FRESH cid
    // (`addParticipant`, and the re-offer path here). `releaseDepartedLegs`
    // correctly skips a peer who is back on the roster — and skipped WITHOUT
    // cancelling the deadline armed while they were gone. Ten seconds later
    // that timer disposed the recovered leg: a participant who rejoined, was
    // dialled, and then had their live peer connection closed by a timer armed
    // for a call that no longer existed.
    //
    // The deadline is keyed by (peer, cid) now, and the callback re-reads the
    // service's CURRENT cid: a different one means recovery happened, and the
    // deadline cancels itself silently.
    jest.useFakeTimers();
    try {
      const entered = latch();
      const gate = latch();
      const h = harness();
      const sid = ulid('SDL2');
      const cid0 = ulid('CDL2');
      await h.deliver(STARTER, ginvite({ sid, cid: cid0, r: [STARTER, B, SELF] }));
      await h.co.answer();
      await h.co.whenIdle();
      await h.co.onIceStateChanged(cid0, 'connected');
      await h.co.whenIdle();
      const cidB = dialledCid(h, B);
      expect(h.co.residentLegs).toBe(2);

      // B's leg gives up, and its close wedges — the only way to be sure the
      // deadline is armed rather than the leg simply released.
      h.native.close.mockImplementation(async (c: string) => {
        if (c !== cidB) return;
        entered.release();
        await gate.held;
      });
      jest.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
      await entered.held;
      await flush();

      // Removed: departed, terminal, service still owns a call. Deadline armed.
      await h.deliver(STARTER, { tcm: 'call.gleave', sid, m: B, se: 1 });
      expect(h.co.view!.roster).not.toContain(B);
      expect(h.co.residentLegs).toBe(2);

      // …and RE-ADDED, which is the legitimate move the deadline never learned
      // about: the starter's authority delta puts B back, B announces
      // themselves, and the re-offer dials them on a brand-new cid.
      await h.deliver(STARTER, { tcm: 'call.gjoin', sid, m: B, se: 2 });
      await h.deliver(B, { tcm: 'call.gjoin', sid, m: B, se: 2 });
      expect(h.co.view!.roster).toContain(B);
      // The wedged close settles, so the OLD leg is genuinely finished and the
      // only thing still standing for B is the recovery.
      gate.release();
      await flush();
      jest.advanceTimersByTime(1);
      await flush();
      await h.co.whenIdle();
      const freshCid = dialledCid(h, B);
      expect(freshCid).not.toBe(cidB);
      expect(h.co.residentLegs).toBe(2);

      // THE DEADLINE, arriving on a leg that is not the one it was armed for.
      jest.advanceTimersByTime(DEPARTED_LEG_TEARDOWN_MS);
      await flush();

      expect(h.co.residentLegs).toBe(2);
      expect(h.native.close.mock.calls.filter(c => c[0] === freshCid)).toHaveLength(0);
      expect(h.co.view).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a removed participant\'s CallService is released when their leg is done', async () => {
    // Starter-authorised remove/add churn keeps the LIVE roster under the cap
    // while the unique-peer count grows without limit; every departed peer's
    // service, cid, end reason and skip note stayed resident for the whole
    // session.
    const h = harness();
    const sid = ulid('SK2');
    // SELF LAST: the offer rule is roster-index based, so this is the order
    // in which the B and C legs are OURS to open — i.e. the order in which we
    // hold a service for each of them.
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CK3'), r: [STARTER, B, C, SELF] }));
    await h.co.answer();
    await h.co.whenIdle();
    const before = h.co.residentLegs;
    expect(before).toBe(3); // the starter's ring leg, plus B and C

    // The STARTER removes B — an authority delta, the only lane that can.
    await h.deliver(STARTER, { tcm: 'call.gleave', sid, m: B, se: 1 });

    expect(h.co.view!.roster).not.toContain(B);
    expect(h.co.residentLegs).toBe(before - 1);
    // The session is untouched by it.
    expect(h.co.view).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 15. THE GENERATION FENCE: what happens while the coordinator is suspended.
//
// The cases below are one disease. The
// coordinator awaits — a database write, a display name, a TURN credential,
// the pacer — and the world moves underneath it: the app relocks, a second
// CallKit event arrives from the native flush, the person declines the
// lock-screen ring. `messaging.ts` solved this years ago with a GENERATION
// counter, and these tests hold the coordinator to the same contract.
// ---------------------------------------------------------------------------

describe('work that must not survive its own disposal', () => {
  it('a relock mid-effect abandons every effect that has not run yet', async () => {
    // A step assigns state and awaits its effects one at a time.
    // `dispose()` used to clear only JS scratch, so the effect that was
    // suspended came back and carried on: it reported a CXCall, opened media
    // and re-created leg services for a session the relock had already
    // ended — a full-screen incoming call on a phone that is locked.
    //
    // Held at `displayNameFor`, which is the await inside
    // `reportGroupIncoming` — the effect that reports the CXCall.
    const gate = latch();
    const h = harness({ beforeDisplayName: () => gate.held });
    const pending = h.deliver(
      STARTER,
      ginvite({ sid: ulid('FEN1'), cid: ulid('FCID1'), r: [STARTER, SELF] }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    h.co.dispose();
    gate.release();
    await pending;

    // No ring for a call that no longer exists anywhere.
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.co.view).toBeNull();
  });

  it('a relock during a dial abandons the ginvites that had not left yet', async () => {
    // The same fence, on the outbound side and on the send chain: the effect
    // list of `start` is writeSessionRow → reportGroupOutgoing → N dials, and
    // `reportGroupOutgoing` awaits a display name. A dispose there used to
    // leave the remaining dials to run — N ginvites onto a still-live send
    // chain, from a workspace that had just been torn down.
    const entered = latch();
    const gate = latch();
    const h = harness({
      beforeDisplayName: () => {
        entered.release();
        return gate.held;
      },
    });
    const started = h.co.startGroupCall([B, C, D], false);
    // Held INSIDE the effect list, not merely somewhere in the call: the
    // suspended effect is the one the fence has to catch.
    await entered.held;

    h.co.dispose();
    gate.release();
    await started;
    await h.co.whenIdle();

    expect(h.native.reportOutgoingCall).not.toHaveBeenCalled();
    expect(h.frames('call.ginvite')).toEqual([]);
    expect(h.co.view).toBeNull();
  });

  it('a relock while the call is still being composed refuses it outright', async () => {
    // Before the first effect there are still four awaits — a credential
    // fetch across the network and a ULID mint per callee, each of which
    // crosses the native bridge for entropy. A relock lands inside them
    // routinely, and the old code went on to ring N people from a workspace
    // that no longer existed. There is no honest sid to hand back to a caller
    // that is about to render a call screen, so it is a refusal.
    const gate = latch();
    const h = harness({ beforeCredentials: () => gate.held });
    const started = h.co.startGroupCall([B, C, D], false);
    await Promise.resolve();

    h.co.dispose();
    gate.release();

    await expect(started).rejects.toThrow(GroupCallRefusedError);
    await h.co.whenIdle();
    expect(h.frames('call.ginvite')).toEqual([]);
    expect(h.co.view).toBeNull();
  });

  it('closes every live legs native peer connection, not just its timers', async () => {
    // Disposal released
    // timers and dropped the JS objects; the peer connections underneath went
    // on carrying audio, because a `CallService` only ever closed one from a
    // reducer-emitted `closeMedia` — and a relock emits no reducer input at
    // all. A locked phone with a live microphone is the worst bug this
    // module can have.
    const h = harness();
    await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await connectLeg(h, C);
    const live = [dialledCid(h, B), dialledCid(h, C)].sort();
    h.native.close.mockClear();

    h.co.dispose();
    await Promise.resolve();

    expect(h.native.close.mock.calls.map(c => c[0]).sort()).toEqual(live);
  });

  it('releases the CXCall too, so the system is not left showing a dead call', async () => {
    // The fence's one new edge: an effect list abandoned mid-teardown may
    // never reach its `releaseGroupCall`, and the lock screen would go on
    // offering a call nothing can answer, mute or end. `restore` has always
    // released rather than leave a CXCall it could not honour; the abrupt
    // seam owes the same.
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    h.native.endCall.mockClear();

    h.co.dispose();
    await Promise.resolve();

    expect(h.native.endCall.mock.calls.map(c => c[0])).toEqual([sid]);
  });

  // -------------------------------------------------------------------------
  // A fence must stop the BUILDING, never the DEMOLISHING.
  //
  // The three tests above all catch a fence refusing to let CONSTRUCTIVE work
  // resume, which is what a fence is for. This pair catches the opposite edge,
  // and it is the one that leaves a phone lying to its owner: a step abandoned
  // MID-TEARDOWN never reaches `releaseGroupCall`, and by then the reducer has
  // already collapsed the session to null — so `dispose()`, reading
  // `this.state?.sid`, had no sid to release either. Both halves of the
  // demolition were dropped and iOS went on showing a live call for a session
  // that was dead in every other respect.
  // -------------------------------------------------------------------------

  it('a relock BETWEEN the state swap and the release still releases the CXCall', async () => {
    // The window, precisely: `step` assigns `this.state = null` before running
    // the effect list, and the list is [closeLeg…, releaseGroupCall,
    // closeSessionRow]. Suspending in the `closeLeg` announce puts the
    // coordinator inside the teardown with the session already gone from
    // `this.state` and the release still unrun — which is exactly where a
    // relock lands, because an announce goes out through the pacer.
    const entered = latch();
    const gate = latch();
    let heldOnce = false;
    const h = harness({
      beforeSend: async tcm => {
        if (tcm !== 'call.end' || heldOnce) return;
        heldOnce = true;
        entered.release();
        await gate.held;
      },
    });
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    expect(h.sessions.has(sid)).toBe(true);
    h.native.endCall.mockClear();

    const hangup = h.co.hangup();
    await entered.held;
    // The reducer has already collapsed the session; the release has not run.
    expect(h.co.view).toBeNull();
    expect(h.native.endCall).not.toHaveBeenCalled();

    h.co.dispose();
    gate.release();
    await hangup;
    await h.co.whenIdle();
    await flush();

    // EXACTLY ONCE, and for the session that was being torn down.
    expect(h.native.endCall.mock.calls.map(c => c[0])).toEqual([sid]);
    // And the rest of the demolition the abandoned step owed: a session row
    // left behind is a dead call a later cold launch would rebuild and ring.
    expect(h.sessions.has(sid)).toBe(false);
  });

  it('a relock just AFTER the release does not release the CXCall twice', async () => {
    // The other side of the same window, and the reason the fix is a LEDGER
    // rather than a `lastSession` fallback: `closeSessionRow` runs immediately
    // after `releaseGroupCall`, so a disposal suspended there finds a session
    // whose CXCall is already gone. A dispose that released whatever session
    // it could still name would report a second `endCall` for one
    // conversation — the release-blocker rule 26 exists to prevent, arriving
    // from the teardown path instead of the ring path.
    const entered = latch();
    const gate = latch();
    const h = harness({
      beforeDeleteSession: async () => {
        entered.release();
        await gate.held;
      },
    });
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    h.native.endCall.mockClear();

    const hangup = h.co.hangup();
    await entered.held;
    expect(h.native.endCall.mock.calls.map(c => c[0])).toEqual([sid]);

    h.co.dispose();
    gate.release();
    await hangup;
    await h.co.whenIdle();
    await flush();

    expect(h.native.endCall.mock.calls.map(c => c[0])).toEqual([sid]);
    // And the deletes the disposal was ABOUT to duplicate.
    // `dispose()` copies the owed sid and starts its own delete pair while the
    // suspended teardown is standing inside the first one; destruction is
    // unfenced by design, so that teardown resumes and deletes again. SQLite
    // makes the second delete harmless TODAY — which is precisely the shape of
    // bug that survives until someone adds a non-idempotent effect to this
    // pair (a tombstone write, a counter, a secure-erase) and inherits the
    // race with it. `deletingNow` is claimed synchronously before the first
    // await, so the drain can tell "owed and abandoned" from "owed and
    // already in hand".
    expect(h.trace.filter(t => t === `deleteSession(${sid})`)).toHaveLength(1);
    expect(h.trace.filter(t => t === `deleteOffers(${sid})`)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The fence, threaded down one layer.
  //
  // `openLegDial`/`openLegRinging`/`openLegAnswer` each await an ENTIRE
  // `CallService.dispatch()`. That service has its own effect loop, its own
  // awaits and its own transport callback — and the callback is the
  // coordinator's own `legSend`, which used to read `this.generation` at the
  // moment the frame was composed. So a leg suspended in `createOffer` came
  // back after the relock, composed a send, read the NEW generation, and
  // passed the fence with it.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // The adjacent leak. The CXCall ledger was right and the
  // PERSISTENCE was not: `dispose()` treats `lastSession` as abandoned only
  // when `this.state` is already null, and session glare installs the WINNER
  // in `this.state` while the LOSER's teardown effects are still queued
  // (`call-session.ts`'s `supersede`). A relock inside that teardown therefore
  // found a non-null state, concluded nothing was abandoned, bumped the
  // generation, and fenced off the loser's own `closeSessionRow` — leaving its
  // row and every stored invite behind it: a roster, a peer id, a DTLS
  // fingerprint and a set of candidate addresses, for a call that had already
  // lost.
  //
  // The fix is `cxCallSid`'s doctrine applied one field over, and it is
  // deliberately NOT a glare special case: a sid is OWED a deletion from the
  // moment the reducer emits `closeSessionRow`, and surrendered only when the
  // delete has actually happened.
  // -------------------------------------------------------------------------

  it("a relock inside the glare teardown still deletes the LOSER's row and offers", async () => {
    const entered = latch();
    const gate = latch();
    let heldOnce = false;
    const h = harness({
      beforeSend: async tcm => {
        if (tcm !== 'call.end' || heldOnce) return;
        heldOnce = true;
        entered.release();
        await gate.held;
      },
    });
    // A LOSING session that really has persistence to lose: an incoming ring
    // stores the starter's invite and B's held one, and its own session row.
    const loserSid = ulid('SGL1');
    await h.deliver(STARTER, ginvite({ sid: loserSid, cid: ulid('CGL1'), r: [STARTER, B, SELF] }));
    await h.deliver(B, ginvite({ sid: loserSid, cid: ulid('CGL2'), r: [STARTER, B, SELF] }));
    expect(h.sessions.has(loserSid)).toBe(true);
    expect([...h.offers.values()].filter(o => o.sid === loserSid).length).toBe(2);

    // A lower sid supersedes it. `supersede` emits the loser's whole teardown
    // and the winner's fresh ring in ONE reducer output, so `this.state` is
    // the winner from the first effect onward.
    const winnerSid = ulid('0');
    void h.deliver(B, ginvite({ sid: winnerSid, cid: ulid('0CID'), r: [B, SELF] }));
    await entered.held;
    expect(h.co.view!.sid).toBe(winnerSid);
    expect(h.sessions.has(loserSid)).toBe(true);

    h.co.dispose();
    gate.release();
    await h.co.whenIdle();
    await flush();

    // The loser takes its row AND its stored SDPs with it, however the step
    // that owed them was abandoned.
    expect(h.sessions.has(loserSid)).toBe(false);
    expect([...h.offers.values()].filter(o => o.sid === loserSid)).toEqual([]);
  });

  it('a relock just AFTER the row is deleted does not delete it twice', async () => {
    // The other half of a ledger, and the reason it is a ledger rather than a
    // "delete whatever we can still name": the sid is SURRENDERED the moment
    // the delete completes, so a disposal landing one effect later owes
    // nothing. Without the surrender this is not a correctness bug — the
    // deletes are idempotent — but a ledger nobody hands back is a ledger that
    // stops meaning anything, and the CXCall one next to it is not idempotent
    // at all.
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    await h.co.hangup();
    await h.co.whenIdle();
    expect(h.sessions.has(sid)).toBe(false);

    h.co.dispose();
    await flush();

    expect(h.trace.filter(t => t === `deleteSession(${sid})`)).toHaveLength(1);
  });

  it('a leg suspended in createOffer puts nothing on the wire after the relock', async () => {
    const entered = latch();
    const gate = latch();
    const h = harness({
      beforeCreateOffer: () => {
        entered.release();
        return gate.held;
      },
    });
    const started = h.co.startGroupCall([B], false);
    // Suspended INSIDE the leg service's effect loop, between `createOffer`
    // and the `sendEnvelope` that carries its SDP.
    await entered.held;

    h.co.dispose();
    gate.release();
    await started.catch(() => undefined);
    await h.co.whenIdle();
    await flush();

    // Not "no ginvite" — NOTHING. With the session gone, `legSend` no longer
    // recognises the frame as a leg offer and sent it as a bare `call.offer`:
    // a 1:1 call placed by a workspace that no longer exists.
    expect(h.sent).toEqual([]);
  });

  it('a leg suspended in createOffer arms no timer that can fire after the relock', async () => {
    // THE HALF THE TRANSPORT FENCE CANNOT REACH. Refusing the leg's SEND
    // still leaves its effect loop running: the very next effect after the
    // offer template is `startTimer`, so a leg abandoned here sat in
    // `outgoing_connecting` behind a 45-second connect timeout that would fire
    // into a disposed coordinator long after the phone locked. That is why
    // `CallService.dispose()` stops the loop rather than only clearing what
    // the loop had already armed.
    jest.useFakeTimers();
    try {
      const entered = latch();
      const gate = latch();
      const h = harness({
        beforeCreateOffer: () => {
          entered.release();
          return gate.held;
        },
      });
      void h.co.startGroupCall([B], false);
      await entered.held;

      h.co.dispose();
      gate.release();
      await h.co.whenIdle();
      await flush();

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes the native connection of a leg whose offer is still being created', async () => {
    // The JS precondition the Swift tombstone needs: disposal must NAME the
    // cid of a leg that has not finished negotiating, or there is nothing for
    // the native side to tombstone in the first place.
    const entered = latch();
    const gate = latch();
    const h = harness({
      beforeCreateOffer: () => {
        entered.release();
        return gate.held;
      },
    });
    void h.co.startGroupCall([B], false);
    await entered.held;
    const cid = h.native.createOffer.mock.calls[0][0] as string;
    h.native.close.mockClear();

    h.co.dispose();
    gate.release();
    await h.co.whenIdle();
    await flush();

    expect(h.native.close.mock.calls.map(c => c[0])).toEqual([cid]);
  });

  it('the native contract that close depends on: a late install finds a tombstone', async () => {
    // WHAT THIS PROVES AND WHAT IT DOES NOT.
    //
    // `TacendumCallImpl.createOffer`/`createAnswer` run their body in a
    // `Task`, and `makeCall` installs the `CallPeerConnection` into the
    // `calls` dictionary only when that Task gets there. `closeCall(cid)`
    // arriving in between scans a dictionary the connection is not in yet,
    // closes nothing, and the Task then installs a LIVE peer connection — a
    // microphone that survived the relock meant to end it.
    //
    // There is no XCTest target in this repo, so the native half is proved by
    // inspection and by the Debug build. What is proved HERE is the ALGORITHM
    // the Swift side implements, transcribed: a closed-cid tombstone, checked
    // under the same lock that performs the install. The fake below is the
    // subject; the real Swift is its faithful copy, and removing the two
    // tombstone lines from either one turns this red.
    const closedCids = new Set<string>();
    const live = new Set<string>();
    const gate = latch();
    const entered = latch();

    const makeCall = async (cid: string): Promise<void> => {
      // The Task boundary: everything below runs after the JS caller returned.
      entered.release();
      await gate.held;
      // `makeCall`'s guard, atomic with the install.
      if (closedCids.has(cid)) return;
      live.add(cid);
    };
    const closeCall = (cid: string): void => {
      closedCids.add(cid);
      live.delete(cid);
    };

    const offer = makeCall('CID');
    await entered.held;
    // The scan happens while the Task is still in flight: it finds nothing.
    closeCall('CID');
    expect(live.has('CID')).toBe(false);
    gate.release();
    await offer;

    // …and the install that lands afterwards must NOT resurrect it.
    expect(live.has('CID')).toBe(false);
  });

  it('the native contract, part two: a close AFTER the install abandons the Task', async () => {
    // The tombstone closes the race in which the close
    // arrives BEFORE the install. It says nothing about the ordinary one after
    // it: `makeCall` installs and unlocks, `closeCall` removes the entry and
    // closes it, and the SAME Task then walks on into `createOffer` /
    // `createAnswer` — `addLocalMedia` takes the microphone and, with video,
    // starts an `AVCaptureSession` on a peer connection nothing above the
    // bridge still holds a handle to.
    //
    // WIDENING THE WINDOW TO THE REAL ONE. The earlier fake made
    // media acquisition synchronous immediately after its test-and-set, which
    // is the one shape the Swift does NOT have: `addLocalMedia` releases
    // `stateLock` and then builds a video source, a track and an
    // `AVCaptureSession` — device enumeration, format selection, a capture
    // start — before `self.capturer` is ever assigned. A `close()` arriving in
    // THAT gap raises the flag, finds a nil capturer, stops nothing, and never
    // runs again, because it is idempotent. The camera the Task starts
    // afterwards has nothing left in the process that will ever turn it off.
    //
    // So the fake below yields where the Swift yields, and transcribes the
    // answer: create into locals outside the lock, RETAKE the lock, re-read
    // `closed`, and either install (where `close()` can see it) or destroy.
    // The same caveats as the tombstone above — there is no XCTest target, so
    // the native half is proved by inspection and by the Debug build, and what
    // is proved HERE is the ALGORITHM. Delete the re-check from either copy
    // and this turns red.
    const opened: string[] = [];
    /** Capturers that are CURRENTLY capturing — the camera indicator, modelled. */
    const capturing = new Set<string>();
    const inGap = latch();
    const gap = latch();
    const gate = latch();
    const entered = latch();

    // The Swift object, reduced to the fields that matter.
    const pc = {
      closed: false,
      localMediaAdded: false,
      capturer: null as string | null,
      close(): void {
        // FIRST, and before a single resource is released: the window being
        // closed is the one between "close has begun" and "close has finished".
        const already = this.closed;
        this.closed = true;
        // CLAIMED in the same critical section that raises the flag, because
        // that is the section `addLocalMedia` installs it in. Reading it after
        // the unlock would reopen the gap by exactly one line.
        const doomed = this.capturer;
        this.capturer = null;
        if (already) return;
        if (doomed) capturing.delete(doomed);
      },
      async addLocalMedia(cid: string): Promise<void> {
        // Test-and-set as ONE critical section, closed included: a separate
        // check would be overwritten by the very assignment it raced.
        const skip = this.localMediaAdded || this.closed;
        this.localMediaAdded = true;
        if (skip) return;
        opened.push(cid);
        // THE GAP. The lock is released here in the Swift, and everything
        // below is built with `close()` free to run beside it.
        inGap.release();
        await gap.held;
        const fresh = `capturer:${cid}`;
        capturing.add(fresh);
        // The lock RETAKEN, and the flag re-read inside it.
        const closedInGap = this.closed;
        if (!closedInGap) this.capturer = fresh;
        if (closedInGap) {
          // Nothing was installed, so `close()` cannot reach this — which
          // makes this the only place that can end it.
          capturing.delete(fresh);
          return;
        }
      },
      async createOffer(cid: string): Promise<string> {
        if (this.closed) throw new Error('closed');
        await this.addLocalMedia(cid);
        entered.release();
        await gate.held; // libwebrtc's own suspension point
        if (this.closed) throw new Error('closed');
        return 'sdp';
      },
    };

    // Installed, unlocked, and only then negotiating — the post-install order.
    const offer = pc.createOffer('CID');
    await inGap.held;
    // The close lands while the capture pipeline is still being built: there is
    // no capturer for it to find, and it will not be called again.
    pc.close();
    expect(pc.capturer).toBeNull();
    expect(capturing.size).toBe(0);
    gap.release();

    await entered.held;
    gate.release();
    await expect(offer).rejects.toThrow('closed');

    // NOTHING IS STILL CAPTURING. Without the re-check this is 1: a live
    // camera, its indicator lit, on a call the app believes is over.
    expect(capturing.size).toBe(0);
    expect(pc.capturer).toBeNull();
    // A second Task on the same connection (an answer, a restart) must not
    // open the microphone the close just took away either.
    await pc.addLocalMedia('CID');
    expect(opened).toEqual(['CID']);
    expect(pc.closed).toBe(true);
  });

  it('the native contract, part three: a tombstone outlives 256 later closes', async () => {
    // The eviction that could hand the pre-install race back. The bound was a
    // plain FIFO trim at 256, justified as "far beyond any window in which a
    // close can still be racing an install" — a claim with no mechanism behind
    // it. A negotiation Task is scheduled by the Swift runtime and can be
    // starved arbitrarily long, and a device that places 256 calls while ONE
    // Task is stalled evicts that Task's tombstone and restores the race, with
    // a live microphone as the prize.
    //
    // Transcribed: eviction skips any cid whose negotiation is still in
    // flight, so the count is a trim TARGET and liveness is the real bound.
    const MAX = 4; // 256 in the Swift; the algorithm does not care
    const closedCids = new Set<string>();
    let order: string[] = [];
    const inFlight = new Map<string, number>();
    const live = new Set<string>();

    const trim = (): void => {
      let over = order.length - MAX;
      if (over <= 0) return;
      const kept: string[] = [];
      for (const cid of order) {
        if (over > 0 && !inFlight.has(cid)) {
          closedCids.delete(cid);
          over -= 1;
          continue;
        }
        kept.push(cid);
      }
      order = kept;
    };
    const closeCall = (cid: string): void => {
      if (!closedCids.has(cid)) {
        closedCids.add(cid);
        order.push(cid);
        trim();
      }
      live.delete(cid);
    };
    // Marked SYNCHRONOUSLY, before the Task — the whole race is the window in
    // which the Task has not been scheduled yet.
    const begin = (cid: string): void => {
      inFlight.set(cid, (inFlight.get(cid) ?? 0) + 1);
    };
    const end = (cid: string): void => {
      const left = (inFlight.get(cid) ?? 1) - 1;
      if (left <= 0) {
        inFlight.delete(cid);
        trim();
      } else {
        inFlight.set(cid, left);
      }
    };
    const install = (cid: string): void => {
      if (closedCids.has(cid)) return;
      live.add(cid);
    };

    // The stalled negotiation: issued, closed, and never scheduled.
    begin('STALLED');
    closeCall('STALLED');
    // …while the phone gets on with more calls than the trim target.
    for (let i = 0; i < MAX * 3; i++) closeCall(`OTHER${i}`);

    // Its tombstone is still standing, so the install it was racing refuses.
    expect(closedCids.has('STALLED')).toBe(true);
    install('STALLED');
    expect(live.has('STALLED')).toBe(false);
    // And the set did not grow to hold it: the trim target still bounds
    // everything that is NOT in flight.
    expect(closedCids.size).toBeLessThanOrEqual(MAX + inFlight.size);

    // Once the Task finishes, nothing can install under that cid any more, so
    // it takes its turn in the queue like every other tombstone — the bound is
    // liveness, not a permanent exemption.
    end('STALLED');
    closeCall('LATER');
    expect(closedCids.has('STALLED')).toBe(false);
    expect(closedCids.size).toBe(MAX);
  });
});

// ---------------------------------------------------------------------------
// 15b. THE DISPOSED FLAG, AND THE DEMOLITION IT WAS STARVING.
//
// `CallService.dispose()` learned to STOP the effect loop, which is
// what stopped a leg abandoned by a relock from arming timers and composing
// sends. But a leg's own teardown runs in that same loop, and `endCall`
// (`call-machine.ts`) announces FIRST and closes the peer connection three
// effects later — while `onStateChange` publishes `ending` BEFORE any of it.
//
// So the session hears "this leg is over", finds it was the last one, releases,
// and `resetSessionScratch()` disposes the service — and the announce, which
// was suspended in the pacer the whole time, resumes into the new disposed
// check and returns before `closePeerConnection`. An ORDINARY hangup could
// leave a live peer connection carrying audio with nothing left anywhere that
// knows its cid. The fence had been taught to stop the building; one layer
// down it was still stopping the demolishing.
// ---------------------------------------------------------------------------

describe('a leg service disposed while its own teardown is in flight', () => {
  it('performs the demolition itself rather than leaving it to the loop it stopped', async () => {
    jest.useFakeTimers();
    try {
      const entered = latch();
      const gate = latch();
      const h = harness({
        beforeSend: async tcm => {
          if (tcm !== 'call.end') return;
          entered.release();
          await gate.held;
        },
      });
      const sid = ulid('SDS1');
      const cid = ulid('CDS1');
      // A two-party incoming session, answered: ONE leg, so when it ends the
      // session ends with it.
      await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF] }));
      await h.co.answer();
      await h.co.whenIdle();
      h.native.close.mockClear();

      // The leg gives up on its own — nothing the coordinator drove, so
      // nothing the coordinator is awaiting.
      jest.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
      await entered.held;
      // NOT `whenIdle`: it awaits the send chain, and the send chain is the
      // very thing suspended here.
      await flush();
      await flush();
      // The session is already gone: its last leg reported `ending` before
      // running a single teardown effect, and the scratch reset that followed
      // disposed the service now suspended in its own announce.
      expect(h.co.view).toBeNull();

      gate.release();
      await h.co.whenIdle();
      await flush();

      // Not "eventually" and not "by the coordinator": the service that owned
      // this cid is the one that has to close it.
      expect(h.native.close.mock.calls.map(c => c[0])).toEqual([cid]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a decline that lands while the invite is still being admitted', () => {
  it('is honoured after the awaits, not lost behind them', async () => {
    // The tombstone was consulted ONCE, before `saveOffer` and the
    // credential fetch. CallKit records a lock-screen decline during exactly
    // those awaits — the placeholder is on screen the whole time — and the
    // group path never looked again: it rang for a call the person had just
    // refused, and left the tombstone standing to ambush the next one. The
    // 1:1 offer path has had the late recheck since round four
    // (`controller.ts`, "the person may have declined the PLACEHOLDER during
    // the awaits above").
    const declined = new Set<string>();
    const gate = latch();
    const h = harness({ pushDeclined: declined, beforeCredentials: () => gate.held });

    const pending = h.deliver(
      STARTER,
      ginvite({ sid: ulid('LATE1'), cid: ulid('LCID1'), r: [STARTER, SELF] }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The red button, pressed while the coordinator is suspended.
    declined.add(STARTER);
    gate.release();
    await pending;

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.co.view).toBeNull();
    expect(h.frames('call.end').map(f => f.envelope.r)).toEqual(['decline']);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');
    // CONSUMED EXACTLY ONCE: the tombstone must not decline the next call.
    expect(declined.has(STARTER)).toBe(false);
  });

  it('a decline that never happened leaves the ring alone', async () => {
    // The falsifier for the recheck itself: an unconditional consume would
    // pass the test above and silence every ordinary call.
    const gate = latch();
    const h = harness({ beforeCredentials: () => gate.held });
    const pending = h.deliver(
      STARTER,
      ginvite({ sid: ulid('LATE2'), cid: ulid('LCID2'), r: [STARTER, SELF] }),
    );
    await Promise.resolve();
    gate.release();
    await pending;

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
  });
});

describe('two cold CallKit events from one native flush', () => {
  const SID = ulid('COLD1');
  const STARTER_CID = ulid('CCID1');

  function seeded(hooks: Partial<Options> = {}): Harness {
    return harness({
      ...hooks,
      seedSession: {
        sid: SID,
        roomId: null,
        starterId: STARTER,
        roster: [STARTER, SELF],
        se: 0,
        video: false,
        startedAt: BASE,
      },
      seedOffers: [
        {
          cid: STARTER_CID,
          peerId: STARTER,
          sdp: SDP,
          video: false,
          exp: BASE + 60_000,
          serverTs: BASE,
          sid: SID,
        },
      ],
    });
  }

  it('restore once, not twice — the second must not release an answered call', async () => {
    // `flushPendingEvents` delivers everything CallKit raised before
    // JS existed, synchronously, and each handler starts its own async task.
    // `restore()` ran outside the coordinator queue and set no state until
    // several awaits in, so both handlers observed a null session and both
    // entered the SELECT-then-DELETE of `takeCallOffersForSession`. The
    // loser found an empty table, decided there was nothing to rebuild, and
    // released the CXCall the winner had just answered as `failed_media`.
    const gate = latch();
    const h = seeded({ beforeTakeOffers: () => gate.held });

    const first = h.co.onCallKitAnswer(SID, h.co.captureCallKitPress());
    const second = h.co.onCallKitAnswer(SID, h.co.captureCallKitPress());
    await Promise.resolve();
    await Promise.resolve();
    gate.release();
    await Promise.all([first, second]);
    await h.co.whenIdle();

    expect(h.native.endCall).not.toHaveBeenCalledWith(SID, 'failed_media');
    // Answered exactly once — a second restore would answer the same offer
    // again, or find nothing and tear the call down.
    expect(h.native.createAnswer.mock.calls.map(c => c[0])).toEqual([STARTER_CID]);
    expect(h.co.view!.sid).toBe(SID);
  });

  it('a cold END sends no ring acknowledgement before the decline', async () => {
    // `onCallKitEnd` restored first, and restore opened the starter's
    // leg in `incoming_ringing` — whose reducer emits `call.ringing`. So a
    // phone answering the lock-screen red button told the caller "ringing"
    // one frame before telling them "declined": a device that was asleep
    // announced itself as present, which is a presence leak with a decline
    // stapled to it.
    const h = seeded();
    await h.co.onCallKitEnd(SID, h.co.captureCallKitPress());
    await h.co.whenIdle();

    expect(h.frames('call.ringing')).toEqual([]);
    expect(h.native.createAnswer).not.toHaveBeenCalled();
    // And the decline still goes, which is what the restore was for.
    expect(h.frames('call.end').map(f => f.envelope.r)).toEqual(['decline']);
    expect(h.sessions.has(SID)).toBe(false);
    expect(h.offers.size).toBe(0);
    expect(h.co.view).toBeNull();
  });
});

describe('the refusals that left a placeholder ringing', () => {
  it('an over-cap video invite dismisses the ring it arrived behind', async () => {
    // PARTIAL-4. `admitGroupCallInvite` refuses a video roster wider than the
    // video cap with `ignore/over_cap`, and the reducer returned NOTHING —
    // no state, no effects, and therefore nothing to tell the coordinator a
    // dismissal was owed. The VoIP push had already rung a full-screen
    // placeholder; nothing local could ever end it.
    const h = harness();
    await h.deliver(
      STARTER,
      ginvite({
        sid: ulid('CAP1'),
        cid: ulid('PCID1'),
        // Six is inside the schema's roster bound and outside the VIDEO cap.
        r: [STARTER, SELF, B, C, D, E],
        vid: true,
      }),
    );

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');
  });

  it('a glare winner that arrived too late dismisses its ring too', async () => {
    // The other refusal with no dismissal: a lower sid WINS glare, but a
    // stale losing frame must not kill a healthy call — so the reducer
    // refuses it on ringability and returns NOTHING. The winner's own VoIP
    // push rang this phone on the way in.
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    h.native.dismissPendingIncomingCall.mockClear();

    await h.deliver(
      B,
      ginvite({
        sid: ulid('0GLARE'), // sorts below anything mintId produces: it wins
        cid: ulid('GCID1'),
        r: [B, SELF],
        exp: BASE - 60_000, // and it is long past its life
      }),
    );

    // The healthy call survives, which is the point of the ringability bound.
    expect(h.co.view).not.toBeNull();
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(B, 'declined', '');
  });
});

// ---------------------------------------------------------------------------
// 16. The seam, from the CONTROLLER's side (risk 1).
// ---------------------------------------------------------------------------

describe('the controller consults the router inside its own queue', () => {
  /**
   * TIME ADVANCES IN THIS BLOCK, exactly as production wires it
   * (src/call/index.ts: `now: () => Date.now()`).
   *
   * It used to be pinned — `now: () => BASE` in `seam()` below — while the
   * tests inside it advanced fake timers by 2 500 ms and then asserted about
   * the controller's TWO-SECOND ABSOLUTE grace. That combination proves
   * nothing: the grace is arithmetic on the injected clock
   * (`Math.max(0, deadline - now)` in the controller's ring-proof arming), and
   * a `now` that never moves can never observe a deadline elapse, so every
   * fuse re-armed for the full two seconds however much virtual time had
   * passed. The sibling harness in call.controller.test.ts was migrated off
   * exactly this for exactly this reason, after 1989 green tests missed a
   * release-blocking stale-deadline burn.
   *
   * Modern fake timers own `Date.now()`; the epoch is pinned once with
   * `jest.setSystemTime`, and every `advanceTimersByTimeAsync` moves the
   * timers AND the clock together. ONE owner: no test in this block installs
   * or restores timers itself.
   */
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
  });

  interface Seam {
    controller: CallController;
    routed: { peerId: string; tcm: string }[];
    sent: { peerId: string; tcm: string; r?: string }[];
    native: jest.Mocked<CallNativeBridge>;
    deliver: (peerId: string, envelope: unknown) => void;
  }

  function seam(router?: Partial<GroupRouter>): Seam {
    const routed: Seam['routed'] = [];
    const sent: Seam['sent'] = [];
    let listener:
      | ((p: string, e: unknown, m: { msgId: string; ts: number }) => void)
      | null = null;
    const native = {
      configure: jest.fn().mockResolvedValue(undefined),
      createOffer: jest.fn().mockResolvedValue(SDP),
      createAnswer: jest.fn().mockResolvedValue(ANSWER_SDP),
      setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
      addIceCandidates: jest.fn().mockResolvedValue(undefined),
      restartIce: jest.fn().mockResolvedValue(SDP),
      close: jest.fn().mockResolvedValue(undefined),
      reportOutgoingCall: jest.fn().mockResolvedValue(undefined),
      reportOutgoingConnected: jest.fn().mockResolvedValue(undefined),
      reportIncomingCall: jest.fn().mockResolvedValue(undefined),
      updateIncomingCallDisplay: jest.fn().mockResolvedValue(undefined),
      dismissPendingIncomingCall: jest.fn().mockResolvedValue(undefined),
      endCall: jest.fn().mockResolvedValue(undefined),
      registerForVoipPush: jest.fn().mockResolvedValue(undefined),
      getVoipToken: jest.fn().mockResolvedValue('t'),
    } as unknown as jest.Mocked<CallNativeBridge>;

    const controller = new CallController({
      messaging: {
        onEnvelope: l => {
          listener = l;
          return () => {
            listener = null;
          };
        },
        sendCallEnvelope: async (peerId, envelope) => {
          sent.push({ peerId, tcm: envelope.tcm, r: (envelope as { r?: string }).r });
        },
      },
      native,
      fetchTurnCredentials: async () => ({ iceServers: [], ttlSeconds: 3600 }),
      writeLog: async () => undefined,
      displayNameFor: async id => `name:${id}`,
      relayOnly: () => false,
      now: () => Date.now(),
      mintReportId: async () => 'REPORT-CONTROLLER',
      groupRouter: router
        ? ({
            handles: () => false,
            handle: async () => false,
            liveSessionBusy: () => false,
            ...router,
          } as GroupRouter)
        : undefined,
    });
    controllers.push(controller);
    return {
      controller,
      routed,
      sent,
      native,
      deliver: (peerId, envelope) => listener?.(peerId, envelope, { msgId: 'm', ts: Date.now() }),
    };
  }

  const controllers: CallController[] = [];
  afterEach(() => {
    // Stop BEFORE restoring real timers: stop() clears fake timer handles,
    // which needs the fake installation still in place.
    for (const c of controllers.splice(0)) c.stop();
    jest.useRealTimers();
  });

  it('routes a ginvite to the router and never to the 1:1 path', async () => {
    const routed: { peerId: string; tcm: string }[] = [];
    const s = seam({
      handles: (_p, e) => (e as { tcm: string }).tcm.startsWith('call.g'),
      handle: async (peerId, e) => {
        routed.push({ peerId, tcm: (e as { tcm: string }).tcm });
        return true;
      },
    });
    await s.controller.start();
    s.deliver(B, ginvite({ sid: ulid('SS1'), cid: ulid('CC1'), r: [B, SELF] }));
    await s.controller.whenIdle();

    expect(routed).toEqual([{ peerId: B, tcm: 'call.ginvite' }]);
    // The 1:1 machine never saw it: no ring, no CallKit, no state.
    expect(s.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(s.controller.state.name).toBe('idle');
  });

  it('a live session makes a stray 1:1 offer busy, and dismisses its push placeholder', async () => {
    // The busy rule, and the reason it lives in the controller: the reducer models ONE
    // call and knows nothing about the session that owns the microphone, so
    // its own `reportBusy` path would never fire and the caller would ring out
    // the full 45 seconds against a device already in a call.
    const s = seam({ liveSessionBusy: () => true });
    await s.controller.start();
    const cid = ulid('CC2');
    s.deliver(B, { tcm: 'call.offer', cid, sdp: SDP, vid: false, exp: BASE + 60_000 });
    await s.controller.whenIdle();

    expect(s.sent).toEqual([{ peerId: B, tcm: 'call.end', r: 'busy' }]);
    expect(s.native.dismissPendingIncomingCall).toHaveBeenCalledWith(B, 'declined', '');
    expect(s.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(s.controller.state.name).toBe('idle');
  });

  it('outbound busy: a live session refuses placeCall BEFORE the camera', async () => {
    // The rule is both directions or it is not the rule. The inbound half —
    // a stray 1:1 offer answered busy — shipped with the seam; the outbound
    // half did not, so the Call button could start a second CallService, a
    // second CXCall and a second capture while N legs were still
    // transmitting, with one microphone between them.
    //
    // FALSIFIER, run at authoring time: delete the `liveSessionBusy` guard in
    // `placeCall` — createOffer and reportOutgoingCall both run and the last
    // three assertions fail.
    const s = seam({ liveSessionBusy: () => true });
    await s.controller.start();

    await expect(s.controller.placeCall(B, ulid('CC5'), true)).rejects.toThrow(
      /already in a call/,
    );

    expect(s.native.createOffer).not.toHaveBeenCalled();
    expect(s.native.reportOutgoingCall).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    expect(s.controller.state.name).toBe('idle');
  });

  it('with NO router, the 1:1 path is untouched — the seam defaults to absent', async () => {
    // The regression argument in one test, and the byte-level version of it
    // is `call.trace.test.ts`'s committed snapshot.
    const s = seam();
    await s.controller.start();
    const cid = ulid('CC3');
    s.deliver(B, { tcm: 'call.offer', cid, sdp: SDP, vid: false, exp: BASE + 60_000 });
    await s.controller.whenIdle();
    expect(s.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(s.controller.state.name).toBe('incoming_ringing');
  });

  it('a router that claims nothing changes nothing', async () => {
    const s = seam({ handles: () => false, liveSessionBusy: () => false });
    await s.controller.start();
    const cid = ulid('CC4');
    s.deliver(B, { tcm: 'call.offer', cid, sdp: SDP, vid: false, exp: BASE + 60_000 });
    await s.controller.whenIdle();
    expect(s.controller.state.name).toBe('incoming_ringing');
  });

  // The GROUP arm of the fuse-defeat class. A valid urgent
  // call.gjoin/gleave defuses the ring-proof fuse the moment it is delivered
  // (onEnvelope defuses on arrival), is claimed by the group router, reduces
  // to NOTHING from idle, and used to return before the 1:1 arm's placeholder
  // cleanup ever ran — so the reported placeholder rang to the native
  // 75-second watchdog. The router now reports whether the frame was adopted
  // by a live/ringing session; an inert delta re-arms the fuse, and with
  // nothing arriving behind it the fuse takes its placeholder down (a later fix
  // moved the dismissal from immediate to the grace — see below).

  /** The real coordinator as the seam's router, so the adoption verdict under
   * test is the shipped one and never a stub's restatement of it. */
  function realRouter(h: Harness): Partial<GroupRouter> {
    return {
      handles: (p, e) => h.co.handles(p, e),
      handle: (p, e, m) => h.co.handle(p, e, m),
      liveSessionBusy: () => h.co.liveSessionBusy(),
    };
  }

  it('a gleave nothing claimed ends the placeholder as a cancellation, not an ignored call', async () => {
    // RULE 1'S BEHAVIOURAL TWIN, end to end through the REAL coordinator. A
    // `call.gleave` from idle is the group shape of "they hung up": the 1:1
    // `call.end` branch gives exactly that frame the decided-cancellation
    // grace and CallKit files it .remoteEnded. Routed only through
    // `adopted === false`, this one arrived as a guess — 'not_call',
    // i.e. .unanswered — and the missed-call row accused the person of
    // ignoring a caller who had rung off.
    let ctrl: CallController | null = null;
    const h = harness({ onRingCancelled: p => ctrl?.noteRingCancelled(p) });
    const s = seam(realRouter(h));
    ctrl = s.controller;
    await s.controller.start();

    s.controller.notePushRing('synthetic-gleave', B, 's1');
    s.deliver(B, { tcm: 'call.gleave', sid: ulid('SGL9'), m: B, se: 1 });
    await s.controller.whenIdle();
    await h.co.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(s.native.dismissPendingIncomingCall).toHaveBeenCalledWith(B, 'cancelled', 's1');
    expect(s.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith(B, 'not_call', 's1');
    expect(s.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('a gleave from a peer with NO noted ring arms nothing at all', async () => {
    // The `peerHasPushRing` gate on the decided cancellation, and the group
    // arm is the only caller that does not check it first. Without it an
    // ordinary leave from any peer schedules a dismissal two seconds out —
    // crossing the bridge on foreground traffic and ending whatever
    // placeholder happens to be pending for that peer by then, with an empty
    // cid that matches ANY of them.
    let ctrl: CallController | null = null;
    const h = harness({ onRingCancelled: p => ctrl?.noteRingCancelled(p) });
    const s = seam(realRouter(h));
    ctrl = s.controller;
    await s.controller.start();

    s.deliver(B, { tcm: 'call.gleave', sid: ulid('SGLA'), m: B, se: 1 });
    await s.controller.whenIdle();
    await h.co.whenIdle();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(s.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('a valid call.gjoin reducing to nothing from idle takes the push placeholder with it', async () => {
    const h = harness();
    const s = seam(realRouter(h));
    await s.controller.start();

    // The VoIP push rang a placeholder for B and noted it.
    s.controller.notePushRing('synthetic-r2-gj', B);
    s.deliver(B, { tcm: 'call.gjoin', sid: ulid('SGJ7'), m: B, se: 1 });
    await s.controller.whenIdle();
    await h.co.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(s.native.dismissPendingIncomingCall).toHaveBeenCalledWith(B, 'not_call', '');
  });

  it('a valid call.gleave from idle is the same defect and gets the same sweep', async () => {
    const h = harness();
    const s = seam(realRouter(h));
    await s.controller.start();

    s.controller.notePushRing('synthetic-r2-gl', B);
    s.deliver(B, { tcm: 'call.gleave', sid: ulid('SGL7'), m: B, se: 1 });
    await s.controller.whenIdle();
    await h.co.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(s.native.dismissPendingIncomingCall).toHaveBeenCalledWith(B, 'not_call', '');
  });

  it('a delta arriving into a LIVE session is session traffic — no sweep', async () => {
    const h = harness();
    const s = seam(realRouter(h));
    await s.controller.start();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();

    s.controller.notePushRing('synthetic-r2-live', B);
    // B announcing himself in: claimed, applied or ignored by the reducer,
    // and either way the session it addresses is alive — nothing is inert.
    s.deliver(B, { tcm: 'call.gjoin', sid: h.minted[0], m: B, se: 1 });
    await s.controller.whenIdle();
    await h.co.whenIdle();

    expect(s.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith(B, 'not_call', '');
  });

  it('a ginvite that RINGS is adopted — the sweep must not touch its placeholder', async () => {
    const h = harness({ known: new Set([B]) });
    const s = seam(realRouter(h));
    await s.controller.start();

    s.controller.notePushRing('synthetic-r2-gi', B);
    s.deliver(B, ginvite({ sid: ulid('SGI7'), cid: ulid('CGI7'), r: [B, SELF] }));
    await s.controller.whenIdle();
    await h.co.whenIdle();

    // The session rang (the coordinator's own native reported it)…
    expect(h.native.reportIncomingCall).toHaveBeenCalled();
    // …and the controller's sweep left the adopted placeholder alone.
    expect(s.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith(B, 'not_call', '');
  });

  it('an idle delta draining ahead of the ginvite must not end the placeholder the invite adopts', async () => {
    // The group arm. A stale call.gjoin from a
    // session long over, queued while the phone was dead, drains one frame
    // ahead of the ginvite whose push is ringing. The earlier immediate
    // dismissal ended that placeholder before the invite could adopt it —
    // natively clearing pendingAnswered and abandoning a parked rebind. The
    // inert delta must arm the ring-proof fuse instead, and the invite's own
    // handling must defuse it.
    const h = harness({ known: new Set([B]) });
    const s = seam(realRouter(h));
    await s.controller.start();

    s.controller.notePushRing('synthetic-r3-gd', B);
    s.deliver(B, { tcm: 'call.gjoin', sid: ulid('SR3A'), m: B, se: 1 });
    s.deliver(B, ginvite({ sid: ulid('SR3B'), cid: ulid('CR3B'), r: [B, SELF] }));
    await s.controller.whenIdle();
    await h.co.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    // The session rang, and the sweep never touched the adopted placeholder.
    expect(h.native.reportIncomingCall).toHaveBeenCalled();
    expect(s.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith(B, 'not_call', '');
  });

  it('a stale bare call.end draining ahead of a ginvite must not end the invite’s placeholder', async () => {
    // The GROUP arm of the `call.end` defect. `handles()` returns false for a
    // bare 1:1 `call.end` whose cid no live session owns, so it falls through
    // to the controller's own 1:1 branch — the single site — and the
    // placeholder it kills there is the one the ginvite one frame behind it
    // is about to adopt. Nothing in group.ts needs to change for this; what
    // it needs is to be PROVED, because the fall-through is invisible from
    // either file on its own.
    const h = harness({ known: new Set([B]) });
    const s = seam(realRouter(h));
    await s.controller.start();

    s.controller.notePushRing('synthetic-r3-ge', B, 's1');
    // A cancellation from a call long over — no live session owns this cid,
    // so the group router declines it and the 1:1 branch takes it.
    s.deliver(B, { tcm: 'call.end', cid: ulid('CR3E'), r: 'timeout' });
    s.deliver(B, ginvite({ sid: ulid('SR3F'), cid: ulid('CR3F'), r: [B, SELF] }));
    await s.controller.whenIdle();
    await h.co.whenIdle();

    // THE GUARANTEE, AND IT IS A TIMING ONE: the invite got the door. Nothing
    // was dismissed while it was still draining, so the placeholder it
    // adopted was still there to adopt.
    expect(h.native.reportIncomingCall).toHaveBeenCalled();
    expect(s.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The decided cancellation still discharges on its own clock — it is not
    // swallowed by the adoption, because a cancellation an adopted group
    // frame could park forever was a shipped defect, and a placeholder dismissed by nothing
    // rings to the 75-second watchdog. It names the placeholder the invite has
    // ALREADY REBOUND (`reportIncomingCall` clears native `pendingPush` when a
    // session adopts the ring), so natively it matches nothing and ends
    // nothing. What must never happen — the sweep relabelling this ring
    // .unanswered — still never does.
    await jest.advanceTimersByTimeAsync(2_500);
    expect(s.native.dismissPendingIncomingCall).toHaveBeenCalledWith(B, 'cancelled', 's1');
    expect(s.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith(B, 'not_call', 's1');
  });

  it('handle REPORTS adoption: false for an idle delta, true for a ginvite and for session traffic', async () => {
    const h = harness({ known: new Set([STARTER]) });

    // An idle delta reduces to nothing: inert, and said so.
    await expect(
      h.co.handle(B, { tcm: 'call.gjoin', sid: ulid('SRV7'), m: B, se: 1 }, { msgId: 'm', ts: BASE }),
    ).resolves.toBe(false);

    // A ginvite owns its own placeholder on every path (ring or refusal), so
    // the controller must never sweep behind it.
    const sid = ulid('SRV8');
    await expect(
      h.co.handle(STARTER, ginvite({ sid, cid: ulid('CRV8'), r: [STARTER, SELF] }), {
        msgId: 'm',
        ts: BASE,
      }),
    ).resolves.toBe(true);
    await h.co.whenIdle();

    // With the session ringing, its deltas are live traffic.
    await expect(
      h.co.handle(STARTER, { tcm: 'call.gjoin', sid, m: C, se: 1 }, { msgId: 'm', ts: BASE }),
    ).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. THE NATIVE EVENT SEAM: a press is attributed before SQLite.
// ---------------------------------------------------------------------------

describe('a CallKit press suspended in session classification', () => {
  const sqlite = (
    jest.requireMock('@op-engineering/op-sqlite') as {
      __sqlite: {
        instances: Map<string, { execute: jest.Mock }>;
        reset: () => void;
      };
    }
  ).__sqlite;
  const events = (
    nativeModule as unknown as {
      __call: { emit: (name: string, payload: unknown) => void };
    }
  ).__call;
  const cidB = ulid('SEAMC');
  let stopCalling: (() => void) | undefined;

  async function flushSeam(): Promise<void> {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }

  async function ringB(): Promise<void> {
    const co = calling.groupCall();
    const invite = ginvite({ sid: ulid('SEAMS'), cid: cidB, r: [STARTER, SELF] });
    expect(co.handles(STARTER, invite)).toBe(true);
    await co.handle(STARTER, invite, { msgId: 'seam', ts: Date.now() });
    await co.whenIdle();
    expect(calling.groupCallView()!.phase).toBe('ringing');
  }

  beforeEach(async () => {
    calling.resetCallingForTests();
    jest.clearAllMocks();
    await db.close();
    sqlite.reset();
    db.setWorkspace('real');
    await db.initDb();

    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (String(sql).includes('SELECT key, value FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: SELF },
            { key: 'registrationId', value: '7' },
          ],
        };
      }
      // and the reason it is stated here rather than assumed: every
      // test below BEGINS with a ring, and these run through the production
      // wiring, where silence-unknown-callers defaults ON. So the starter is
      // somebody this device has exchanged a message with — which is what
      // "the phone rings" has always meant and what this file's own gate
      // section proves is now required. An inviter with no history ringing
      // anyway was the defect, never the premise of a CallKit-press test.
      if (
        String(sql).includes('FROM chats WHERE peerId = ?') &&
        Array.isArray(params) &&
        params[0] === STARTER
      ) {
        return { rows: [{ peerId: STARTER, lastMessageAt: 1 }] };
      }
      return base(sql, params);
    });
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    jest.spyOn(messaging, 'sendGroupCallEnvelope').mockResolvedValue(undefined);
    jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(false);
    jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
    stopCalling = await calling.startCalling();
    // BOTH PHASES, because production has both. `startCalling` is the ring
    // half and runs from a mount effect, before the lock screen has a verdict,
    // so it deliberately reads no database — including the profile read that
    // answers "who is this device". That read lives in
    // `adoptWorkspaceForCalling`, which App.tsx calls from each unlock arm.
    // Without this line the coordinator has no self id and every ring below is
    // dropped before it is raised.
    await calling.adoptWorkspaceForCalling();
  });

  afterEach(async () => {
    stopCalling?.();
    stopCalling = undefined;
    calling.resetCallingForTests();
    jest.restoreAllMocks();
    await db.close();
  });

  it.each([
    ['answer', 'callKitAnswer'],
    ['end', 'callKitEnd'],
  ] as const)(
    'does not let a cold %s for A act on B with the same sid',
    async (press, event) => {
      const lookupEntered = latch();
      const lookupGate = latch();
      const sid = ulid('SEAMS');
      const instance = sqlite.instances.get('tacendum.sqlite')!;
      const base = instance.execute.getMockImplementation()!;
      instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
        if (String(sql).includes('FROM call_sessions ORDER BY startedAt DESC')) {
          lookupEntered.release();
          await lookupGate.held;
          return {
            rows: [
              {
                sid,
                roomId: null,
                starterId: STARTER,
                roster: JSON.stringify([STARTER, SELF]),
                se: 0,
                video: 0,
                startedAt: Date.now() - 1_000,
              },
            ],
          };
        }
        return base(sql, params);
      });
      const ordinary =
        press === 'answer'
          ? jest.spyOn(calling.callController(), 'onCallKitAnswer')
          : jest.spyOn(calling.callController(), 'onCallKitEnd');

      // The native callback begins COLD and stops in SQLite. B then reports
      // its own ring under A's remotely reusable sid before classification
      // returns. The row is the only evidence that the null ticket belongs to
      // A; losing that provenance hands A's button to 1:1, which releases B's
      // native aggregate even though B remains the coordinator's ringing call.
      events.emit(event, { cid: sid });
      await lookupEntered.held;
      await ringB();

      lookupGate.release();
      await flushSeam();
      await calling.groupCall().whenIdle();
      await flushSeam();

      // The actual damage was microphone/camera admission on Answer and full
      // teardown on End. In both cases B must remain a ring awaiting a human.
      expect(calling.groupCallView()).not.toBeNull();
      expect(calling.groupCallView()!.phase).toBe('ringing');
      expect(nativeModule.createAnswer).not.toHaveBeenCalledWith(cidB, SDP, false);
      expect(nativeModule.endCall).not.toHaveBeenCalledWith(sid, expect.anything());
      expect(ordinary).not.toHaveBeenCalled();
      expect(
        (messaging.sendCallEnvelope as jest.Mock).mock.calls.some(
          c => c[1]?.tcm === 'call.end' && c[1]?.cid === cidB,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ['answer', 'callKitAnswer'],
    ['end', 'callKitEnd'],
  ] as const)(
    'lets a genuine 1:1 %s through when a new group ring makes the lookup true',
    async (press, event) => {
      const lookupEntered = latch();
      const lookupGate = latch();
      const sid = ulid('SEAMS');
      const instance = sqlite.instances.get('tacendum.sqlite')!;
      const base = instance.execute.getMockImplementation()!;
      instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
        if (String(sql).includes('FROM call_sessions ORDER BY startedAt DESC')) {
          lookupEntered.release();
          await lookupGate.held;
          return { rows: [] };
        }
        if (String(sql).includes('FROM call_offers WHERE cid = ?') && params?.[0] === sid) {
          return {
            rows: [
              {
                cid: sid,
                peerId: B,
                sdp: SDP,
                video: 0,
                exp: Date.now() + 60_000,
                serverTs: Date.now(),
              },
            ],
          };
        }
        return base(sql, params);
      });
      await db.saveCallOffer({
        cid: sid,
        peerId: B,
        sdp: SDP,
        video: false,
        exp: Date.now() + 60_000,
        serverTs: Date.now(),
        sid: null,
      });
      const ordinary =
        press === 'answer'
          ? jest.spyOn(calling.callController(), 'onCallKitAnswer')
          : jest.spyOn(calling.callController(), 'onCallKitEnd');

      // A's persisted 1:1 press begins cold and stops in the group-session
      // lookup. B then installs a group ring under that remotely chosen sid.
      // Classification now says "group", but the callback-time ticket still
      // belongs to A and the coordinator correctly refuses it.
      events.emit(event, { cid: sid });
      await lookupEntered.held;
      await ringB();

      lookupGate.release();
      await flushSeam();
      await calling.groupCall().whenIdle();
      await flushSeam();

      // The unconditional return swallowed this call entirely: on Answer the
      // CXCall connected with no media because its stored offer was untouched.
      expect(ordinary).toHaveBeenCalledWith(sid);
      if (press === 'answer') {
        expect(nativeModule.createAnswer).toHaveBeenCalledWith(sid, SDP, false);
      } else {
        expect(nativeModule.endCall).toHaveBeenCalledWith(sid, 'cancelled');
      }
      // B made classification true, but its ticket was never claimed.
      expect(calling.groupCallView()!.phase).toBe('ringing');
      expect(nativeModule.createAnswer).not.toHaveBeenCalledWith(cidB, SDP, false);
    },
  );

  it.each([
    ['answer', 'callKitAnswer'],
    ['end', 'callKitEnd'],
  ] as const)(
    'lets a genuine 1:1 %s through when the group ring that made the lookup true is gone by the handler',
    async (press, event) => {
      const lookupEntered = latch();
      const lookupGate = latch();
      const handlerEntered = latch();
      const sid = ulid('SEAMS');
      // NOTHING ON DISK NAMES THIS ID. It is a 1:1 cid with a stored offer
      // behind it, and the row B wrote for its own ring left with B.
      jest.spyOn(db, 'loadCallSession').mockImplementation(async () => {
        lookupEntered.release();
        await lookupGate.held;
        return null;
      });
      jest.spyOn(db, 'takeCallOffer').mockResolvedValue({
        cid: sid,
        peerId: B,
        sdp: SDP,
        video: false,
        exp: Date.now() + 60_000,
        serverTs: Date.now() - 1_000,
      });
      const co = calling.groupCall();
      const real =
        press === 'answer' ? co.onCallKitAnswer.bind(co) : co.onCallKitEnd.bind(co);
      const classified =
        press === 'answer'
          ? jest.spyOn(co, 'onCallKitAnswer')
          : jest.spyOn(co, 'onCallKitEnd');
      let viewAtHandlerEntry: GroupCallView | null | 'never-entered' = 'never-entered';
      // THE GAP, HELD OPEN ON PURPOSE — the one interleaving a test cannot ask
      // the scheduler for. B's teardown is already queued when classification
      // answers `live`, and it finishes before the awaiting callback reaches
      // the handler. Everything else is the shipped seam: the real synchronous
      // ticket, the real evidence, the real handler underneath.
      classified.mockImplementation(async (...args) => {
        handlerEntered.release();
        await co.hangup();
        await co.whenIdle();
        viewAtHandlerEntry = calling.groupCallView();
        return real(...args);
      });
      const ordinary =
        press === 'answer'
          ? jest.spyOn(calling.callController(), 'onCallKitAnswer')
          : jest.spyOn(calling.callController(), 'onCallKitEnd');

      events.emit(event, { cid: sid });
      await lookupEntered.held;
      await ringB();

      lookupGate.release();
      await handlerEntered.held;
      await classified.mock.results[0]!.value;
      await flushSeam();
      await co.whenIdle();
      await flushSeam();

      // The snapshot was true where it was read and false where it was used:
      // by the time the press was classified there was no group session at all.
      expect(viewAtHandlerEntry).toBeNull();
      // Restore adopts a PERSISTED session. Entering it on evidence that has
      // since evaporated made it release the person's incoming 1:1 call as
      // `failed_media` and report `claimed`, which is what kept the ordinary
      // handler from ever running — Answer dismissed the call without opening
      // media, End skipped the cancellation the caller is owed.
      expect(nativeModule.endCall).not.toHaveBeenCalledWith(sid, 'failed_media');
      expect(ordinary).toHaveBeenCalledWith(sid);
      if (press === 'answer') {
        expect(nativeModule.createAnswer).toHaveBeenCalledWith(sid, SDP, false);
      } else {
        expect(nativeModule.endCall).toHaveBeenCalledWith(sid, 'cancelled');
      }
      expect(await classified.mock.results[0]!.value).toBe('not-ours');
    },
  );

  it.each([
    ['answer', 'callKitAnswer'],
    ['end', 'callKitEnd'],
  ] as const)(
    'drops a stale group %s before a same-id 1:1 successor can receive it',
    async (press, event) => {
      const reportEntered = latch();
      const reportGate = latch();
      const sid = ulid('SEAMS');
      const reportIncoming = nativeModule.reportIncomingCall as jest.MockedFunction<
        typeof nativeModule.reportIncomingCall
      >;
      reportIncoming.mockImplementationOnce(async () => {
        reportEntered.release();
        await reportGate.held;
      });

      // A is installed and has claimed its CallKit aggregate, while the native
      // report holds the coordinator queue open behind it.
      const co = calling.groupCall();
      const invite = ginvite({ sid, cid: cidB, r: [STARTER, SELF] });
      const installing = co.handle(STARTER, invite, {
        msgId: 'seam-stale',
        ts: Date.now(),
      });
      await reportEntered.held;
      expect(calling.groupCallView()!.phase).toBe('ringing');

      const ordinary =
        press === 'answer'
          ? jest.spyOn(calling.callController(), 'onCallKitAnswer')
          : jest.spyOn(calling.callController(), 'onCallKitEnd');
      events.emit(event, { cid: sid });
      // `callKitNamesSession` yields once even for a live group. Queue A's end
      // in that gap, ahead of the group handler's fenced reducer input.
      const ending = co.hangup();

      // A fresh 1:1 offer already waits under the remotely minted group sid.
      // When A's queued input is refused, boolean false hands it this press.
      await db.saveCallOffer({
        cid: sid,
        peerId: B,
        sdp: SDP,
        video: false,
        exp: Date.now() + 60_000,
        serverTs: Date.now(),
        sid: null,
      });

      reportGate.release();
      await Promise.all([installing, ending]);
      await flushSeam();
      await co.whenIdle();
      await flushSeam();

      // `false` reached the ordinary handler here. Answer opened the
      // successor's media; End released it. A stale group result owns neither.
      expect(ordinary).not.toHaveBeenCalled();
      expect(nativeModule.createAnswer).not.toHaveBeenCalledWith(sid, SDP, false);
      expect(nativeModule.endCall).not.toHaveBeenCalledWith(sid, 'cancelled');
    },
  );

  it.each([
    ['answer', 'callKitAnswer', 'failed_media'],
    ['end', 'callKitEnd', 'cancelled'],
  ] as const)(
    'still lets an unmapped CallKit %s reach the 1:1 cleanup path',
    async (press, event, oneToOneReason) => {
      const sid = ulid('UNMAPPED');
      const ordinary =
        press === 'answer'
          ? jest.spyOn(calling.callController(), 'onCallKitAnswer')
          : jest.spyOn(calling.callController(), 'onCallKitEnd');
      events.emit(event, { cid: sid });
      await flushSeam();

      expect(calling.groupCallView()).toBeNull();
      expect(ordinary).toHaveBeenCalledWith(sid);
      expect(nativeModule.endCall).toHaveBeenCalledWith(sid, oneToOneReason);
    },
  );

  it.each([
    ['answer', 'callKitAnswer'],
    ['end', 'callKitEnd'],
  ] as const)(
    'still lets an ordinary cold 1:1 %s act on its own call',
    async (press, event) => {
      const cid = ulid('COLDONE');
      jest.spyOn(db, 'loadCallSession').mockResolvedValue(null);
      jest.spyOn(db, 'takeCallOffer').mockResolvedValue({
        cid,
        peerId: B,
        sdp: SDP,
        video: false,
        exp: Date.now() + 60_000,
        serverTs: Date.now() - 1_000,
      });
      const ordinary =
        press === 'answer'
          ? jest.spyOn(calling.callController(), 'onCallKitAnswer')
          : jest.spyOn(calling.callController(), 'onCallKitEnd');

      // There is no group evidence on either clock: no persisted session and
      // no live coordinator. The group classifier must leave this press alone,
      // including the stored 1:1 offer only the ordinary answer can consume.
      events.emit(event, { cid });
      await flushSeam();

      expect(calling.groupCallView()).toBeNull();
      expect(ordinary).toHaveBeenCalledWith(cid);
      if (press === 'answer') {
        expect(calling.callController().state.name).toBe('incoming_answering');
        expect(nativeModule.createAnswer).toHaveBeenCalledWith(cid, SDP, false);
        expect(nativeModule.endCall).not.toHaveBeenCalledWith(cid, 'failed_media');
      } else {
        expect(nativeModule.createAnswer).not.toHaveBeenCalled();
        expect(nativeModule.endCall).toHaveBeenCalledWith(cid, 'cancelled');
      }
    },
  );

  it.each([
    ['answer', 'callKitAnswer', 'failed_media'],
    ['end', 'callKitEnd', 'cancelled'],
  ] as const)(
    'still lets an ordinary cold group %s restore and act on its own session',
    async (press, event, fallbackReason) => {
      const sid = ulid('COLDSEAM');
      const starterCid = ulid('COLDCID');
      jest.spyOn(db, 'loadCallSession').mockResolvedValue({
        sid,
        roomId: null,
        starterId: STARTER,
        roster: [STARTER, SELF],
        se: 0,
        video: false,
        startedAt: Date.now() - 1_000,
      });
      jest.spyOn(db, 'takeCallOffersForSession').mockResolvedValue([
        {
          cid: starterCid,
          peerId: STARTER,
          sdp: SDP,
          video: false,
          exp: Date.now() + 60_000,
          serverTs: Date.now() - 1_000,
          sid,
        },
      ]);
      const ordinary =
        press === 'answer'
          ? jest.spyOn(calling.callController(), 'onCallKitAnswer')
          : jest.spyOn(calling.callController(), 'onCallKitEnd');

      // The persisted row belongs to this cold press and there is no successor
      // to protect. Preserving its provenance must still drive the normal
      // restore path rather than turning every null-ticket press into stale.
      events.emit(event, { cid: sid });
      await flushSeam();
      await calling.groupCall().whenIdle();
      await flushSeam();

      expect(ordinary).not.toHaveBeenCalled();
      expect(nativeModule.endCall).not.toHaveBeenCalledWith(sid, fallbackReason);
      if (press === 'answer') {
        expect(calling.groupCallView()!.phase).toBe('joining');
        expect(nativeModule.createAnswer).toHaveBeenCalledWith(starterCid, SDP, false);
      } else {
        expect(calling.groupCallView()).toBeNull();
        expect(
          (messaging.sendCallEnvelope as jest.Mock).mock.calls.some(
            c => c[1]?.tcm === 'call.end' && c[1]?.cid === starterCid,
          ),
        ).toBe(true);
      }
    },
  );

  it.each([
    ['answer', 'callKitAnswer', 'failed_media'],
    ['end', 'callKitEnd', 'cancelled'],
  ] as const)('still lets an unmoved CallKit %s act on its ring', async (press, event, fallbackReason) => {
    // THE LIVENESS HALF at the native seam. Capturing an opaque ticket cannot
    // turn either system button into a blanket no-op.
    await ringB();
    events.emit(event, { cid: ulid('SEAMS') });
    await flushSeam();
    await calling.groupCall().whenIdle();

    if (press === 'answer') {
      expect(calling.groupCallView()!.phase).toBe('joining');
      expect(nativeModule.createAnswer).toHaveBeenCalledWith(cidB, SDP, false);
    } else {
      expect(calling.groupCallView()).toBeNull();
      expect(
        (messaging.sendCallEnvelope as jest.Mock).mock.calls.some(
          c => c[1]?.tcm === 'call.end' && c[1]?.cid === cidB,
        ),
      ).toBe(true);
    }
    // A claimed group press has exactly one owner; the 1:1 fallback must not
    // also release the native aggregate after the group acted on it.
    expect(nativeModule.endCall).not.toHaveBeenCalledWith(ulid('SEAMS'), fallbackReason);
  });
});

// ---------------------------------------------------------------------------
// The group-call defects the coordinator owns. Each block names the behaviour
// it holds; each test went red against the coordinator that preceded it.
// ---------------------------------------------------------------------------

describe("an unknown account's crossing invite is judged even while a session is live", () => {
  /** A sid that sorts BELOW anything `mintId` produces — the forged
   * `sid: '0000…'` of the defect, which always won "lower sid wins". */
  const LOWER_SID = ulid('0');

  it('a DIFFERENT sid from an unknown account into a live session is silenced — never rung, never superseding', async () => {
    // The gate ran only when nothing was live, so the one invite the reducer
    // can answer with `supersede` — tear the call down and RING — was the one
    // invite never judged. FALSIFIER: restore `this.state === null` around
    // the gate; `ringChecks` comes back empty and a busy frame goes out.
    const h = harness({ silenceUnknown: true, known: new Set([B]) });
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    h.ringChecks.length = 0;
    h.sent.length = 0;

    await h.deliver(STRANGER, ginvite({ sid: LOWER_SID, cid: ulid('CG1'), r: [STRANGER, SELF] }));

    expect(h.ringChecks).toEqual([STRANGER]);
    // The live call is untouched: same sid, no release, no second ring.
    expect(h.co.view!.sid).toBe(sid);
    expect(h.native.endCall).not.toHaveBeenCalled();
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    // Silenced exactly as a fresh ring is: nothing back, a decline row, the
    // placeholder the push already rang dismissed.
    expect(h.sent.filter(f => f.peerId === STRANGER)).toEqual([]);
    expect(h.logs.map(r => r.reason)).toEqual(['decline']);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(STRANGER, 'declined', '');
  });

  it("a MEMBER's crossing invite from a known account passes the gate, and the reducer decides glare", async () => {
    const h = harness({ silenceUnknown: true, known: new Set([B]) });
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    h.ringChecks.length = 0;

    await h.deliver(B, ginvite({ sid: LOWER_SID, cid: ulid('CG2'), r: [B, SELF] }));

    expect(h.ringChecks).toEqual([B]);
    expect(h.co.view!.sid).toBe(LOWER_SID); // B's lower sid won a session still forming
  });

  it("a STRANGER's lower sid into a live session is busy when the gate is off — the reducer's own gate (never supersede)", async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);

    await h.deliver(STRANGER, ginvite({ sid: LOWER_SID, cid: ulid('CG3'), r: [STRANGER, SELF] }));

    expect(h.co.view!.sid).toBe(sid);
    expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('connected');
    expect(
      h.sent.filter(f => f.peerId === STRANGER && f.envelope.tcm === 'call.end' && f.envelope.r === 'busy'),
    ).toHaveLength(1);
    expect(h.native.endCall).not.toHaveBeenCalled();
  });
});

describe('the ginvite carries the epoch this device holds', () => {
  it("the starter's invite to a member added mid-call names the epoch that Add minted", async () => {
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    expect(h.frames('call.ginvite').map(f => f.envelope.se)).toEqual([0]);

    await h.co.addParticipant(C);
    await h.co.whenIdle();
    const toC = h.sent.find(f => f.peerId === C && f.envelope.tcm === 'call.ginvite')!;
    expect(toC.envelope.se).toBe(1);
    expect(toC.envelope.r).toEqual([SELF, B, C]);
  });
});

describe('the in-app Answer requests the CallKit answer for the SESSION', () => {
  it('asks native to answer the reported call by its sid, once, before the starter leg is answered', async () => {
    // The CXCall is keyed by the sid; the native `createAnswer` funnel keys
    // its CXAnswerCallAction by the LEG cid, which CallKit never heard of.
    // FALSIFIER: drop the `answerReportedCall` call from `openLegAnswer` —
    // the count below reads 0, which is the dead-audio call this pins.
    const h = harness();
    const sid = ulid('SA1');
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CA1'), r: [STARTER, SELF, B] }));
    await h.deliver(B, ginvite({ sid, cid: ulid('CA2'), r: [STARTER, SELF, B] }));
    expect(h.native.answerReportedCall).not.toHaveBeenCalled();

    await h.co.answer();
    await h.co.whenIdle();

    expect(h.native.answerReportedCall).toHaveBeenCalledTimes(1);
    expect(h.native.answerReportedCall).toHaveBeenCalledWith(sid);
    // Before the media, as the 1:1 funnel orders it: activation first.
    const at = (prefix: string) => h.trace.findIndex(t => t.startsWith(prefix));
    expect(at('answerReportedCall(')).toBeGreaterThanOrEqual(0);
    expect(at('answerReportedCall(')).toBeLessThan(at('createAnswer('));
    // Both legs are still answered, exactly once each.
    expect(h.native.createAnswer).toHaveBeenCalledTimes(2);
  });

  it('never asks for an OUTGOING session — its CXCall was reported outgoing and connects on the first leg', async () => {
    const h = harness();
    await h.co.startGroupCall([B], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    expect(h.native.answerReportedCall).not.toHaveBeenCalled();
    expect(h.native.reportOutgoingConnected).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a native that predates the method — the answer still goes through', async () => {
    const h = harness();
    delete (h.native as unknown as Record<string, unknown>).answerReportedCall;
    await h.deliver(STARTER, ginvite({ sid: ulid('SA2'), cid: ulid('CA3'), r: [STARTER, SELF] }));
    await h.co.answer();
    await h.co.whenIdle();
    expect(h.native.createAnswer).toHaveBeenCalledTimes(1);
    expect(h.co.view!.phase).toBe('joining');
  });
});

describe("a starter's pre-answer hangup is a MISSED call on the phone that rang", () => {
  it('the ring leg closed with `cancelled` writes a missed row and ends the CXCall as unanswered', async () => {
    // The starter's session-level hangup used to close a still-ringing leg
    // with `hangup`, which this side's leg machine logs as a completed call
    // — no missed row, no badge, CallKit `.remoteEnded`. The reducer now
    // cancels a leg nobody answered (`legEndReason`); this is the other end
    // of that frame, on the phone that was ringing. FALSIFIER: deliver
    // `r: 'hangup'` instead — the row's `missed` flips to false.
    const h = harness();
    const sid = ulid('S5C');
    const cid = ulid('C5C');
    await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF, B] }));
    expect(h.co.view!.phase).toBe('ringing');
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);

    await h.deliver(STARTER, { tcm: 'call.end', cid, r: 'cancelled' });

    expect(h.co.view).toBeNull();
    expect(h.native.endCall).toHaveBeenCalledWith(sid, 'cancelled');
    // ONE row, the leg's own. The leg reports `ending` before it runs its
    // effects and its row is the last of them, so the release the report
    // triggers used to find `legLogRows === 0` and write the aggregate as
    // well — two missed rows, two badge counts, for one cancelled ring.
    const rows = h.logs.filter(r => r.peerId === STARTER && r.sessionId === sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cid, direction: 'in', reason: 'cancelled', missed: true });
  });

  it('still writes the one missed row when the session ends while the leg is parked in its teardown', async () => {
    // The row is the LAST effect of the leg's teardown, behind the peer
    // connection close. The session release disposes the leg's service, and
    // a disposal stops the effect loop at its next checkpoint — so a leg
    // still standing at `close` when the release ran never wrote its row,
    // and because it had been counted, the aggregate did not either: a
    // missed call with no evidence anywhere. The coordinator now writes what
    // the leg promised before it disposes it. FALSIFIER: remove the
    // `flushPendingLegRows` call from `resetSessionScratch` — zero rows.
    const h = harness();
    const sid = ulid('S5D');
    const cid = ulid('C5D');
    await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF, B] }));
    expect(h.co.view!.phase).toBe('ringing');

    // The bridge never answers this close: the leg's loop parks there, its
    // row still queued behind it, while the coordinator ends the session.
    h.native.close.mockImplementationOnce(() => new Promise<void>(() => undefined));
    void h.deliver(STARTER, { tcm: 'call.end', cid, r: 'cancelled' });
    await h.co.whenIdle();

    expect(h.co.view).toBeNull();
    expect(h.native.endCall).toHaveBeenCalledWith(sid, 'cancelled');
    const rows = h.logs.filter(r => r.peerId === STARTER && r.sessionId === sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cid, direction: 'in', reason: 'cancelled', missed: true });
  });
});

describe('a mute fans only over legs whose media exists, and never over a departed one', () => {
  it('a mute during the paced dial of a 6-way closes nothing — legs still dialling are bound at their dial', async () => {
    // `state.legs` lists every leg from the first step while the dials run
    // one at a time behind the pacer; native answers `false` for a cid with
    // no peer connection, and §5 closed each of them: an urgent call.end to
    // a peer not yet invited, "X was dropped" over a dial that then went on.
    // FALSIFIER: drop the `mediaBound` check from `fanTrack` — with the fake
    // native now honest about unknown cids, four call.end frames go out.
    const entered = latch();
    const gate = latch();
    let held = false;
    const h = harness({
      beforeCreateOffer: async () => {
        if (held) return;
        held = true;
        entered.release();
        await gate.held;
      },
    });
    const started = h.co.startGroupCall([B, C, D, E, F], false);
    await entered.held;
    // The first dial is suspended inside createOffer; four more have not
    // begun. Every leg is already in the view.
    expect(h.co.view!.legs).toHaveLength(5);

    const outcomes = await h.co.setMuted(true);
    expect(outcomes).toEqual([]);
    expect(h.co.view!.muted).toBe(true);

    gate.release();
    await started;
    await h.co.whenIdle();

    // Nobody was closed, nobody was told anything but the invite…
    expect(h.frames('call.end')).toEqual([]);
    for (const peer of [B, C, D, E, F]) {
      expect(['inviting', 'ringing']).toContain(h.co.view!.legs.find(l => l.peerId === peer)!.phase);
      // …and every leg was muted the moment its media existed.
      expect(h.native.setAudioEnabled).toHaveBeenCalledWith(dialledCid(h, peer), false);
    }
    // No leg's mute failed: the first apply on each cid was the bind's.
    expect(h.native.setAudioEnabled.mock.results.every(r => r.value instanceof Promise)).toBe(true);
    for (const call of h.native.setAudioEnabled.mock.calls) {
      expect([B, C, D, E, F].map(p => dialledCid(h, p))).toContain(call[0]);
    }
  });

  it('re-sends no call.end to a peer who LEFT while their service is still winding down', async () => {
    // A sovereign leave closes the leaver's leg WITHOUT announcing (their
    // ends are en route from their own hangup). The leg is `left` while its
    // service tears down — peer connection closed, history row pending — and
    // a fan that reached it got `false` from native and announced a
    // `failed_media` end to someone who had already hung up.
    const entered = latch();
    const gate = latch();
    let hold = false;
    const h = harness({
      beforeWriteLog: async () => {
        if (!hold) return;
        hold = false;
        entered.release();
        await gate.held;
      },
    });
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    await connectLeg(h, B);
    await connectLeg(h, C);

    hold = true;
    void h.co.handle(B, { tcm: 'call.gleave', sid, m: B, se: 1 }, { msgId: 'm', ts: h.now() });
    await entered.held;
    expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('left');
    const before = h.frames('call.end').length;

    const outcomes = await h.co.setMuted(true);
    expect(outcomes).toEqual([{ peerId: C, cid: dialledCid(h, C), applied: true, closed: false }]);
    expect(h.frames('call.end')).toHaveLength(before);
    expect(h.sent.some(f => f.peerId === B && f.envelope.tcm === 'call.end')).toBe(false);

    gate.release();
    await h.co.whenIdle();
    expect(h.co.view!.muted).toBe(true);
    expect(h.co.view!.legs.find(l => l.peerId === C)!.phase).toBe('connected');
  });
});

describe('a re-offer into a leg still tearing down gets a fresh service', () => {
  it('the +2 s re-offer dials the fresh cid while the dead leg\'s call.end is still parked in the pacer', async () => {
    // The reducer marks the leg `failed` when its service publishes `ending`
    // — before the teardown has run. With the announce parked in the pacer,
    // the same service was still `ending` when the re-offer's `placeCall`
    // reached it: `reportBusy`, a no-op. Nothing dialled the new cid; the
    // tile read "Calling…" for the rest of the call. FALSIFIER: reuse the
    // winding-down service in `openLegDial` — one ginvite reaches B, ever.
    jest.useFakeTimers();
    try {
      const gate = latch();
      let hold = false;
      const h = harness({
        beforeSend: async tcm => {
          if (tcm === 'call.end' && hold) await gate.held;
        },
      });
      const sid = await h.co.startGroupCall([B, C], false);
      await h.co.whenIdle();
      await connectLeg(h, C); // the session outlives B's failure on its own merits
      // B is present: their sovereign announce arms R6 toward them.
      await h.deliver(B, { tcm: 'call.gjoin', sid, m: B, se: 1 });
      const cidB1 = dialledCid(h, B);
      const ginvitesToB = (): number =>
        h.sent.filter(f => f.peerId === B && f.envelope.tcm === 'call.ginvite').length;
      expect(ginvitesToB()).toBe(1);

      // B never connects: the 45 s connect timeout fails the leg, and its
      // announced call.end parks in the transport.
      hold = true;
      jest.advanceTimersByTime(CALL_CONNECT_TIMEOUT_MS);
      await flush();
      expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('failed');

      // The repair fires while that call.end is still parked.
      jest.advanceTimersByTime(GINVITE_REOFFER_DELAYS_MS[0]);
      await flush();
      await flush();
      expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('inviting');

      // The pacer drains: the parked end leaves, and the FRESH dial behind it.
      hold = false;
      gate.release();
      await flush();
      await h.co.whenIdle();
      expect(ginvitesToB()).toBe(2);
      const cidB2 = dialledCid(h, B);
      expect(cidB2).not.toBe(cidB1);
      expect(h.native.createOffer).toHaveBeenCalledWith(cidB2, false);
      // The dead attempt's end went out under ITS cid; the fresh leg lives.
      expect(
        h.sent.some(f => f.peerId === B && f.envelope.tcm === 'call.end' && f.envelope.cid === cidB1),
      ).toBe(true);
      expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('inviting');

      // …and the tile leaves "Calling…" the moment B acks the new cid.
      await h.deliver(B, { tcm: 'call.ringing', cid: cidB2 });
      expect(h.co.view!.legs.find(l => l.peerId === B)!.phase).toBe('ringing');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a blocked member's leg into a LIVE session", () => {
  /** An answered incoming session [STARTER, SELF, B] under `sid`. */
  async function joined(h: Harness, sid: string): Promise<void> {
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('CB1'), r: [STARTER, SELF, B] }));
    await h.co.answer();
    await h.co.whenIdle();
    expect(h.co.view!.phase).toBe('joining');
  }

  it('is refused as a LEG — call.end{busy}, no row under the live sid, and the tile names the skip', async () => {
    // Blocked mid-call: the starter added C by authority (no blocked check
    // sits on a roster delta), and this phone blocked C before C's leg
    // offer arrived. The whole-session refusal dismissed nothing that was
    // ringing, wrote a `blocked` row keyed by the LIVE sid and returned with
    // no verdict — so the tile read "Calling…" for the rest of the call.
    const blocked = new Set<string>();
    const h = harness({ blocked });
    const sid = ulid('SB1');
    await joined(h, sid);
    await h.deliver(STARTER, { tcm: 'call.gjoin', sid, m: C, se: 1 });
    expect(h.co.view!.roster).toContain(C);
    blocked.add(C);
    const rows = h.logs.length;
    const cidC = ulid('CB2');

    await h.deliver(C, ginvite({ sid, cid: cidC, r: [STARTER, SELF, B, C] }));

    expect(
      h.sent.filter(f => f.peerId === C && f.envelope.tcm === 'call.end' && f.envelope.r === 'busy'),
    ).toHaveLength(1);
    expect(h.logs).toHaveLength(rows);
    expect(h.native.createAnswer).toHaveBeenCalledTimes(1); // the starter's leg only
    expect(h.co.view!.sid).toBe(sid);
    expect(h.co.view!.legs.find(l => l.peerId === C)!.skipped).toBe('blocked');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith(C, 'declined', '');
  });

  it("an asserted `r` naming a blocked account does not refuse a MEMBER's leg — the roster is payload", async () => {
    // Only the dial path scans whom this device will open media to; a join
    // leg is judged on its authenticated sender. B's envelope names someone
    // this phone blocked who is not on the call at all.
    const h = harness({ blocked: new Set([STRANGER]) });
    const sid = ulid('SB2');
    await joined(h, sid);
    const rows = h.logs.length;
    const cidB = ulid('CB3');

    await h.deliver(B, ginvite({ sid, cid: cidB, r: [STARTER, SELF, B, STRANGER] }));

    expect(h.native.createAnswer).toHaveBeenCalledWith(cidB, SDP, false);
    expect(h.logs).toHaveLength(rows);
    expect(h.co.view!.legs.find(l => l.peerId === B)!.skipped).toBeNull();
    expect(h.sent.some(f => f.peerId === B && f.envelope.tcm === 'call.end')).toBe(false);
  });

  it('a blocked INVITER with a different sid is still the whole-session refusal, row and all', async () => {
    const h = harness({ blocked: new Set([STRANGER]) });
    const sid = ulid('SB3');
    await joined(h, sid);
    await h.deliver(STRANGER, ginvite({ sid: ulid('SB4'), cid: ulid('CB4'), r: [STRANGER, SELF] }));
    expect(h.logs.map(r => r.reason)).toEqual(['blocked']);
    expect(h.co.view!.sid).toBe(sid);
  });
});

// ---------------------------------------------------------------------------
// `call_offers` holds only what the reducer ADMITTED. The persist used to run
// for every ringable invite BEFORE the verdict, so a stranger's SDP —
// fingerprint and candidate addresses — sat on disk for a call this device
// refused busy, until the session's own close. The persist now rides the
// effect list, first, so the persist-before-ring ordering the session row
// already keeps is kept for the offer too.
// ---------------------------------------------------------------------------

describe('only an admitted invite reaches call_offers', () => {
  const saved = (h: Harness, cid: string) => h.trace.filter(t => t === `saveOffer(${cid})`);

  it("a stranger's ginvite into a live session is answered busy and NOT persisted", async () => {
    const h = harness();
    const sid = await h.co.startGroupCall([B, C], false);
    await h.co.whenIdle();
    const strangerCid = ulid('G14S');

    await h.deliver(STRANGER, ginvite({ sid, cid: strangerCid, r: [STRANGER, SELF] }));

    expect(
      h.sent.filter(
        f => f.peerId === STRANGER && f.envelope.tcm === 'call.end' && f.envelope.r === 'busy',
      ),
    ).toHaveLength(1);
    expect(saved(h, strangerCid)).toHaveLength(0);
    expect(h.co.view!.sid).toBe(sid);
  });

  it('a fresh ring is persisted, once, and before the CallKit report', async () => {
    const h = harness();
    const sid = ulid('G14R');
    const cid = ulid('G14C');
    await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF, B] }));

    const save = h.trace.indexOf(`saveOffer(${cid})`);
    const report = h.trace.findIndex(t => t.startsWith('reportIncomingCall('));
    expect(save).toBeGreaterThanOrEqual(0);
    expect(report).toBeGreaterThan(save);

    // A redelivered frame is normal (§5.6) and persists nothing twice.
    await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF, B] }));
    expect(saved(h, cid)).toHaveLength(1);
  });

  it("a member's leg offer into the ringing session is held AND persisted", async () => {
    const h = harness();
    const sid = ulid('G14H');
    await h.deliver(STARTER, ginvite({ sid, cid: ulid('G14C1'), r: [STARTER, SELF, B] }));
    const cidB = ulid('G14CB');

    await h.deliver(B, ginvite({ sid, cid: cidB, r: [STARTER, SELF, B] }));

    expect(h.native.createAnswer).not.toHaveBeenCalled(); // held, not answered (R2)
    expect(saved(h, cidB)).toHaveLength(1);
  });

  it("the starter's one re-offer swap is persisted; the refused second one is not", async () => {
    const h = harness();
    const sid = ulid('G14W');
    const first = ulid('G14W1');
    const second = ulid('G14W2');
    const third = ulid('G14W3');
    await h.deliver(STARTER, ginvite({ sid, cid: first, r: [STARTER, SELF] }));
    await h.deliver(STARTER, ginvite({ sid, cid: second, r: [STARTER, SELF] }));
    expect(saved(h, second)).toHaveLength(1);

    await h.deliver(STARTER, ginvite({ sid, cid: third, r: [STARTER, SELF] }));

    expect(
      h.sent.filter(
        f =>
          f.peerId === STARTER &&
          f.envelope.tcm === 'call.end' &&
          f.envelope.cid === third &&
          f.envelope.r === 'busy',
      ),
    ).toHaveLength(1);
    expect(saved(h, third)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the CallKit CONNECT report is the starter's. `reportOutgoingConnected` is
// `reportOutgoingCall(with:connectedAt:)`, a fact about an OUTGOING call; an
// incoming session's CXCall was connected by its answer, and filing the
// outgoing transition against it was wrong by contract. The reducer's guard
// is `starterId === selfId`; this is the coordinator-level half, against the
// native fake.
// ---------------------------------------------------------------------------

describe('no outgoing-connected report for an incoming session', () => {
  it("an answered incoming session's first connected leg reports nothing to CallKit, and still latches", async () => {
    const h = harness();
    const sid = ulid('G16S');
    const cid = ulid('G16C');
    await h.deliver(STARTER, ginvite({ sid, cid, r: [STARTER, SELF] }));
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    await h.co.answer();
    await h.co.whenIdle();

    await h.co.onIceStateChanged(cid, 'connected');
    await h.co.whenIdle();

    expect(h.co.view!.legs.find(l => l.peerId === STARTER)!.phase).toBe('connected');
    expect(h.co.view!.connectedAt).not.toBeNull(); // the aggregate's own latch is unchanged
    expect(h.native.reportOutgoingConnected).not.toHaveBeenCalled();
    expect(h.native.reportOutgoingCall).not.toHaveBeenCalled();
  });
});
