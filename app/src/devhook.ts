import { NativeModules, TurboModuleRegistry } from 'react-native';
import * as crypto from 'tacendum-crypto';
import * as api from './api';
import * as appearance from './appearance';
import * as background from './background';
import * as call from './call';
import * as config from './config';
import * as nativeCall from 'tacendum-call';
import * as db from './db';
import * as decoy from './decoy';
import { encodeEnvelope } from './envelope';
import * as lock from './lock';
import { messaging } from './messaging';
import * as registration from './registration';
import * as screenSecurity from 'tacendum-screen-security';
import { session } from './session';

/**
 * Dev-only automation hook: exposes the exact modules the UI calls so the
 * scripted simulator harness (driven over the Hermes inspector) exercises
 * the real code paths. Never attached outside __DEV__.
 */
declare const __DEV__: boolean;

/**
 * THE COLD-LAUNCH FLUSH COUNTER (`LEG: cold-launch-flush`).
 *
 * What the device leg has to prove is DELIVERY, and only a counter can prove
 * it: `startCalling` swallows a flush rejection on purpose
 * (`native.flushPendingEvents().catch(() => undefined)` — a failed flush must
 * not abort boot), so an error-free launch says nothing at all about whether
 * a single buffered event reached JS. The semantics of the buffer itself —
 * retention, the 32-deep drop-oldest overflow, in-order delivery — are pinned
 * on the host JVM by `BufferSemanticsTest`; this is the other layer, and it
 * only exists on a device.
 *
 * TWO HALVES, and the arming half is the one that is easy to miss. A count of
 * zero is what a correct build reports on this rig if nothing ever raises a
 * native call event before JS is ready — on Android nothing does
 * (`registerForVoipPush` is a no-op, and a Telecom ring cannot survive
 * the process death a cold launch begins with), so a leg that only COUNTED
 * would assert a number that is honestly zero and would fail a healthy build.
 * So this module raises one itself, at the only moment that makes it a
 * pre-JS-ready event: `startMonitoringPressure` emits `onThermalStateChanged`
 * synchronously (PressureMonitor.start's "once immediately"), and this file
 * runs at bundle evaluation — App.tsx imports it at line 28, while
 * `flushPendingEvents` is not reached until the mount effect calls
 * `startCalling`. The event therefore lands in `PendingEventBuffer` exactly
 * as a lock-screen answer would, and the count below moves only when the
 * flush hands it back.
 *
 * `armedToFirstMs` is reported as EVIDENCE and asserted on by nothing: the
 * delay between arming and delivery is a fact about this boot, not a
 * contract, and a gate that asserted a latency would be tuned to an idle
 * machine.
 */
let flushedEvents = 0;
const flushedEventNames: string[] = [];
let flushArmedAt = 0;
let firstFlushedAt = 0;

/** Every event the module can raise; each one goes through the same buffer. */
const COUNTED_CALL_EVENTS = [
  'iceState',
  'iceCandidate',
  'connectionState',
  'remoteTrackAdded',
  'remoteTrackRemoved',
  'callKitAnswer',
  'callKitEnd',
  'callKitMute',
  'callKitAudioActivated',
  'callKitAudioDeactivated',
  'voipPush',
  'voipTokenUpdated',
  'alertTokenUpdated',
  'audioRouteChanged',
  'devicePressure',
] as const;

if (__DEV__) {
  const subscribeCounted = nativeCall.events as unknown as Record<
    string,
    ((handler: (value: unknown) => void) => { remove(): void }) | undefined
  >;
  for (const name of COUNTED_CALL_EVENTS) {
    try {
      subscribeCounted[name]?.(() => {
        flushedEvents += 1;
        if (firstFlushedAt === 0) firstFlushedAt = Date.now();
        // Bounded: a long-lived dev session must not accumulate a list, and
        // the first few names are all a diagnosis ever reads.
        if (flushedEventNames.length < 16) flushedEventNames.push(name);
      });
    } catch {
      // A build whose module never registered answers nothing here; the leg
      // reports a count of zero, which is the failure it exists to catch.
    }
  }
  flushArmedAt = Date.now();
  // Started and stopped in one breath: the emit has already happened by the
  // time `start()` returns, and leaving a broadcast receiver and a thermal
  // listener running for the life of every dev launch would be this hook
  // changing the app's behaviour rather than observing it. A later real call
  // re-starts the same monitor, which is what `PressureMonitor.start`'s
  // `monitoring` flag is for.
  void nativeCall
    .startMonitoringPressure()
    .then(() => nativeCall.stopMonitoringPressure())
    .catch(() => undefined);
}

if (__DEV__) {
  const fixtureTargetIsLocal =
    config.DEV_TARGET === 'local' &&
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(
      config.API_BASE,
    );
  const requireLocalFixtureTarget = (): void => {
    if (!fixtureTargetIsLocal || session.mode !== 'real') {
      throw new Error(
        'AI fixtures require a real workspace on the local debug target',
      );
    }
  };
  // Fixed synthetic ids. They name no real account and are only ever written
  // after the local-target guard above succeeds.
  const attentionFixture = {
    peerId: '01HATTN0000000000000000000',
    execQ: '01HATTNREQ0000000000000001',
    fileQ: '01HATTNREQ0000000000000002',
  } as const;
  const workFixture = {
    peerId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    completionMessageId: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
    completionEventId: '01J8MEAPPR0VAQ4X2C6TKN9RFX',
    failureMessageId: '01J8MEAPPR0VAQ4X2C6TKN9RFY',
    failureEventId: '01J8MEAPPR0VAQ4X2C6TKN9RFZ',
    preferenceQ: '01J8MEAPPR0VAQ4X2C6TKN9RFP',
  } as const;
  const secondOpinionFixture = {
    roomId: '01J8MEAPPR0VAQ4X2C6TKN9RFQ',
    claudeId: '01J8MEAPPR0VAQ4X2C6TKN9RFA',
    codexId: '01J8MEAPPR0VAQ4X2C6TKN9RFB',
    answerId: '01J8MEAPPR0VAQ4X2C6TKN9RFC',
    claudeProfileOrigin: '01J8MEAPPR0VAQ4X2C6TKN9RFD',
    codexProfileOrigin: '01J8MEAPPR0VAQ4X2C6TKN9RFE',
  } as const;

  (globalThis as unknown as Record<string, unknown>).TacendumDev = {
    registration,
    db,
    messaging,
    api,
    /**
     * The resolved backend (API_BASE / WS_URL / DEV_TARGET), exposed so
     * scripts/app-verify.sh can assert — over CDP, before it registers
     * anything — that the RUNNING app is pointed at the script's own local
     * server. The bundle target is baked in at babel time and otherwise
     * invisible until real accounts appear somewhere unexpected; this gate was
     * once about to register against production because nothing looked.
     */
    config,
    /**
     * The same three values as plain data, read by scripts/app-verify.sh.
     *
     * This block used to blame ES-module namespace getters for the segfault
     * that kills the app mid-`Runtime.evaluate`. That was wrong, and wrong in
     * the direction that wastes someone's afternoon: it implied a safe SHAPE of
     * expression exists. Disassembling the shipped hermesvm against the crash
     * reports says otherwise — the faulting instruction reads a
     * NULL `this` in `CodeBlock::getSourceLocation`, and the caller,
     * `Debugger::runUntilValidPauseLocation`, takes that pointer from the
     * Debugger's own `preStepState_` field, not from anything the expression
     * touched. No JS can influence it. What arms it is `Runtime.evaluate`
     * compiling a NEW script while the runtime-global `pauseOnScriptLoad_` flag
     * is set by some other CDP session; scripts/app/cdp-eval.mjs now disarms
     * that flag before evaluating, and carries the full account.
     *
     * So this object survives on its merits, not as a workaround: it is a
     * smaller compiled script than a namespace walk, and app-verify asserting
     * the app's resolved endpoints is worth keeping either way.
     */
    configSnapshot: {
      API_BASE: config.API_BASE,
      WS_URL: config.WS_URL,
      DEV_TARGET: config.DEV_TARGET,
    },
    appearance,
    crypto,
    /**
     * tacendum-qr is the ONE module whose absence throws nothing: its spec
     * uses `TurboModuleRegistry.get`, not `getEnforcing`, so a build that
     * silently dropped the native module still evaluates the bundle. The
     * Android boot verification asserts this probe instead of
     * assuming; on a healthy build it is true on both platforms.
     */
    nativeQrPresent: TurboModuleRegistry.get('TacendumQr') != null,
    /**
     * The screen-security NATIVE module, not the policy service in
     * `./screenSecurity` — the point is to reach the platform answer.
     *
     * A device probe drives `getIsCaptured()` over CDP after a fresh install,
     * and it is the real module resolving that is being asserted: the early
     * stub rejected `crypto_error("unimplemented")` here, so the probe fails
     * loudly against a build where the Kotlin never landed rather than
     * reporting a comfortable `false` from a module that does nothing. On
     * Android the answer comes from the API-35 recording callback (constant
     * false below that); on iOS from `UIScreen.isCaptured`.
     */
    screenSecurity,
    lock,
    decoy,
    session,
    /**
     * B1 AI-attention simulator scene. This writes through the real database
     * APIs and renders through the ordinary subscription/router paths. The
     * target and session guards keep synthetic rows away from AWS, release
     * builds, and the decoy workspace.
     */
    aiAttention: {
      setup: async (): Promise<string> => {
        requireLocalFixtureTarget();
        const now = Date.now();
        await db.deleteChat(attentionFixture.peerId);
        await db.upsertChat(attentionFixture.peerId, 'Claude Code · local demo');
        const capturedWork = {
          provider: 'claude' as const,
          updatedAt: now,
          requestId: attentionFixture.execQ,
          project: 'Tacendum',
          runTag: 's-b1a1',
          context: {
            availability: 'captured' as const,
            capturedAt: now,
            repository: 'natln/Tacendum',
            branch: 'feature/chat-review',
            resultSummary: 'The agent reported that the requested review is ready.',
          },
        };
        const staleWork = {
          provider: 'claude' as const,
          updatedAt: now - 10 * 60_000,
          requestId: attentionFixture.fileQ,
          project: 'Tacendum',
          runTag: 's-b1a2',
          context: {
            availability: 'stale' as const,
            capturedAt: now - 10 * 60_000,
            repository: 'natln/Tacendum',
            branch: 'feature/chat-review',
            resultSummary: 'This context was captured earlier and may have changed.',
          },
        };
        const exec = await db.insertApproval({
          peerId: attentionFixture.peerId,
          q: attentionFixture.execQ,
          wireMsgId: '01HATTNWIRE000000000000001',
          kind: 'exec',
          payload: 'pnpm --filter @tacendum/app test',
          ttlSec: 15 * 60,
          sessionTag: 's-b1a1',
          verbs: ['approve', 'deny'],
          ts: now,
          arrivedAt: now,
          work: capturedWork,
        });
        const file = await db.insertApproval({
          peerId: attentionFixture.peerId,
          q: attentionFixture.fileQ,
          wireMsgId: '01HATTNWIRE000000000000002',
          kind: 'file',
          payload: 'app/src/screens/AttentionScreen.tsx',
          ttlSec: 20 * 60,
          sessionTag: 's-b1a2',
          verbs: ['approve', 'deny'],
          ts: now + 1,
          arrivedAt: now,
          work: staleWork,
        });
        if (!exec || !file) {
          throw new Error('AI attention fixture rows were not stored');
        }
        messaging.debugNotifyForFixtures();
        return JSON.stringify(attentionFixture);
      },
      observe: async (
        q: string,
        observation:
          | 'answer-received'
          | 'decision-returned'
          | 'provider-received'
          | 'expired' = 'decision-returned',
      ): Promise<void> => {
        requireLocalFixtureTarget();
        if (q !== attentionFixture.execQ && q !== attentionFixture.fileQ) {
          throw new Error('Unknown AI attention fixture request');
        }
        const now = Date.now();
        await db.recordAiWork(attentionFixture.peerId, `fixture-observation-${now}`, now, {
          provider: 'claude',
          updatedAt: now,
          requestId: q,
          approvalObservation: observation,
        });
        messaging.debugNotifyForFixtures();
      },
      clear: async (): Promise<void> => {
        requireLocalFixtureTarget();
        await db.deleteChat(attentionFixture.peerId);
        messaging.debugNotifyForFixtures();
      },
    },
    /**
     * A3/B3–B5 source-backed scenes. Every variant reaches the same database
     * APIs as an authenticated profile/message carrier; none inserts a UI
     * object or bypasses retention. The fixed peer is synthetic and the
     * debug/local/real-workspace guard above applies to every entrypoint.
     */
    aiWork: {
      setup: async (
        scenario:
          | 'reports'
          | 'notifications-only'
          | 'tasks'
          | 'preference-pending'
          | 'preference-quiet'
          | 'usage-exhausted'
          | 'usage-stale'
          | 'usage-unavailable' = 'reports',
      ): Promise<string> => {
        requireLocalFixtureTarget();
        if (
          ![
            'reports',
            'notifications-only',
            'tasks',
            'preference-pending',
            'preference-quiet',
            'usage-exhausted',
            'usage-stale',
            'usage-unavailable',
          ].includes(scenario)
        ) {
          throw new Error('Unknown AI work fixture scenario');
        }
        const now = Date.now();
        const receivedAt = scenario === 'usage-stale' ? now - 10 * 60_000 : now;
        await db.deleteChat(workFixture.peerId);
        await db.upsertChat(workFixture.peerId, 'Codex · local demo');
        await db.recordAiWork(
          workFixture.peerId,
          `fixture-profile-${scenario}`,
          receivedAt,
          {
            provider: 'codex',
            updatedAt: receivedAt,
            project: 'Tacendum',
            capabilities:
              scenario === 'notifications-only'
                ? { notifications: true, approvals: false, tasks: false }
                : { notifications: true, approvals: true, tasks: true },
            context: {
              availability: 'captured',
              capturedAt: receivedAt,
              repository: 'natln/Tacendum',
              branch: 'feature/chat-review',
            },
            ...(scenario === 'usage-exhausted'
              ? {
                  usage: [
                    {
                      source: 'local-budget' as const,
                      unit: 'turns' as const,
                      period: 'session' as const,
                      observedAt: receivedAt,
                      remaining: 0,
                      limit: 12,
                    },
                  ],
                }
              : scenario === 'usage-stale' || scenario === 'tasks'
                ? {
                    usage: [
                      {
                        source: 'local-budget' as const,
                        unit: 'turns' as const,
                        period: 'session' as const,
                        observedAt: receivedAt,
                        remaining: 4,
                        limit: 12,
                      },
                    ],
                  }
                : {}),
          },
          'profile',
        );

        if (
          scenario === 'preference-pending' ||
          scenario === 'preference-quiet'
        ) {
          const stored = await db.beginAiNotifyPreference(
            workFixture.peerId,
            workFixture.preferenceQ,
            'quiet',
            now,
          );
          if (!stored) {
            throw new Error('AI notification preference fixture was not stored');
          }
          if (scenario === 'preference-quiet') {
            const applied = await db.applyAiNotifyPreferenceAck(
              workFixture.peerId,
              workFixture.preferenceQ,
              'quiet',
              now + 1,
            );
            if (!applied) {
              throw new Error('AI notification preference fixture ack was not applied');
            }
          }
        }

        if (scenario === 'reports') {
          await db.insertMessage({
            msgId: workFixture.completionMessageId,
            peerId: workFixture.peerId,
            direction: 'in',
            body: 'I finished the requested review. Open this conversation for the details.',
            ts: now - 2_000,
            status: 'received',
          });
          await db.recordAiWork(
            workFixture.peerId,
            workFixture.completionMessageId,
            now - 2_000,
            {
              provider: 'codex',
              updatedAt: now - 2_000,
              event: 'turn-complete',
              eventId: workFixture.completionEventId,
              project: 'Tacendum',
              runTag: 's-7c2e',
              context: {
                availability: 'captured',
                capturedAt: now - 2_000,
                resultSummary: 'The agent reported that its review turn finished.',
              },
            },
            'message',
          );
          await db.insertMessage({
            msgId: workFixture.failureMessageId,
            peerId: workFixture.peerId,
            direction: 'in',
            body: 'The check could not complete. Open this conversation for the reported failure.',
            ts: now - 1_000,
            status: 'received',
          });
          await db.recordAiWork(
            workFixture.peerId,
            workFixture.failureMessageId,
            now - 1_000,
            {
              provider: 'codex',
              updatedAt: now - 1_000,
              event: 'turn-failed',
              eventId: workFixture.failureEventId,
              project: 'Tacendum',
              runTag: 's-91af',
              context: {
                availability: 'captured',
                capturedAt: now - 1_000,
                resultSummary: 'The agent reported that a check failed.',
              },
            },
            'message',
          );
        }
        messaging.debugNotifyForFixtures();
        return JSON.stringify({ ...workFixture, scenario });
      },
      ackPreference: async (): Promise<void> => {
        requireLocalFixtureTarget();
        const applied = await db.applyAiNotifyPreferenceAck(
          workFixture.peerId,
          workFixture.preferenceQ,
          'quiet',
          Date.now(),
        );
        if (!applied) {
          throw new Error('No matching AI notification preference is waiting');
        }
        messaging.debugNotifyForFixtures();
      },
      clear: async (): Promise<void> => {
        requireLocalFixtureTarget();
        await db.deleteChat(workFixture.peerId);
        messaging.debugNotifyForFixtures();
      },
    },
    /**
     * B4 room scene. It creates an ordinary owner-authored roster, two
     * server-recorded machine peers with current task capability snapshots,
     * and one first-hand AI-marked room answer. The screen still has to fold
     * the roster, recognize eligible agents, prepare a mention, and use the
     * ordinary reviewed Send path; this hook never calls that action itself.
     */
    secondOpinion: {
      setup: async (): Promise<string> => {
        requireLocalFixtureTarget();
        const me = await db.loadProfile();
        if (!me) throw new Error('A local profile is required for this fixture');
        const now = Date.now();
        const oldStore = await db.loadGroupStore(secondOpinionFixture.roomId);
        oldStore.clear();
        await oldStore.persist();
        await db.deleteChat(secondOpinionFixture.claudeId);
        await db.deleteChat(secondOpinionFixture.codexId);

        const store = await db.loadGroupStore(secondOpinionFixture.roomId);
        store.anchorName = 'Second opinion demo';
        store.setOwner(me.userId);
        store.putSlot({
          memberId: me.userId,
          writerId: me.userId,
          seq: 1,
          state: 'in',
        });
        for (const memberId of [
          secondOpinionFixture.claudeId,
          secondOpinionFixture.codexId,
        ]) {
          store.putSlot({
            memberId,
            writerId: me.userId,
            seq: 1,
            state: 'in',
            class: 'integration',
          });
        }
        store.setPresent(true);
        await store.persist();
        await db.setLocalName(secondOpinionFixture.roomId, 'Second opinion demo');
        await db.upsertChat(secondOpinionFixture.claudeId, 'Claude · fixture');
        await db.upsertChat(secondOpinionFixture.codexId, 'Codex · fixture');
        await db.recordMachinePeer(secondOpinionFixture.claudeId, now);
        await db.recordMachinePeer(secondOpinionFixture.codexId, now);
        await db.recordAiWork(
          secondOpinionFixture.claudeId,
          secondOpinionFixture.claudeProfileOrigin,
          now,
          {
            provider: 'claude',
            updatedAt: now,
            project: 'Tacendum',
            capabilities: {
              notifications: true,
              approvals: true,
              tasks: true,
            },
          },
          'profile',
        );
        await db.recordAiWork(
          secondOpinionFixture.codexId,
          secondOpinionFixture.codexProfileOrigin,
          now,
          {
            provider: 'codex',
            updatedAt: now,
            project: 'Tacendum',
            capabilities: {
              notifications: true,
              approvals: true,
              tasks: true,
            },
          },
          'profile',
        );
        const roomMessageId = `${secondOpinionFixture.claudeId}.${secondOpinionFixture.answerId}`;
        await db.insertMessage({
          msgId: roomMessageId,
          peerId: secondOpinionFixture.roomId,
          direction: 'in',
          body: encodeEnvelope({
            tcm: 'msg',
            text: 'The approval cleanup now shares one maintenance path.',
            d: 'Deletion, expiration, and revocation all remove the request and its supplementary context in the same database boundary.',
            ai: true,
          }),
          ts: now,
          arrivedAt: now,
          status: 'received',
          authorId: secondOpinionFixture.claudeId,
          sq: 1,
          ai: 1,
        });
        await db.touchChat(
          secondOpinionFixture.roomId,
          'The approval cleanup now shares one maintenance path.',
          now,
        );
        messaging.debugNotifyForFixtures();
        return JSON.stringify({
          ...secondOpinionFixture,
          ownerId: me.userId,
          roomMessageId,
        });
      },
      clear: async (): Promise<void> => {
        requireLocalFixtureTarget();
        const store = await db.loadGroupStore(secondOpinionFixture.roomId);
        store.clear();
        await store.persist();
        await db.deleteChat(secondOpinionFixture.claudeId);
        await db.deleteChat(secondOpinionFixture.codexId);
        messaging.debugNotifyForFixtures();
      },
    },
    /**
     * Calling, for a scripted media run.
     *
     * `call` is the app-level surface — `startCalling`, `callController`,
     * `localMediaState` — and `nativeCall` is the module underneath it, which
     * is where `enableSyntheticVideo` and `enableFingerprintFault` live. Both
     * are needed: a media test has to turn on the synthetic capturer (the
     * Simulator has no camera, so without it there is nothing to encode) and
     * then drive a real call through the real reducer.
     *
     * Exposed rather than reimplemented, for the same reason as everything
     * else here: a hook that duplicated the call setup would verify the
     * duplicate.
     */
    call,
    /**
     * Spread rather than passed through, so `flushedEventCount` can sit
     * beside the module's own exports at its published name
     * (`TacendumDev.nativeCall.flushedEventCount()`). An ES module
     * namespace object is sealed — nothing can be added to it in place — and
     * every export here is a function, so the copy and the namespace resolve
     * to the same implementations.
     */
    nativeCall: {
      ...nativeCall,
      /** How many native call events the flush has handed to JS this
       * process, counted at the JS end. See the block above. */
      flushedEventCount: (): number => flushedEvents,
      /** The same number with the context a failure needs: what arrived, and
       * how long after the pre-JS event was raised. */
      flushDiagnostics: (): string =>
        JSON.stringify({
          count: flushedEvents,
          events: flushedEventNames,
          armedAt: flushArmedAt,
          firstAt: firstFlushedAt,
          armedToFirstMs: firstFlushedAt === 0 ? null : firstFlushedAt - flushArmedAt,
        }),
    },
    /**
     * Background delivery's three read-outs.
     *
     * None of this is required — every step of `LEG: background-delivery` has
     * a `run-as` route on the debug build — but a leg that can ask the app
     * directly is shorter, and the third answer is one `adb` cannot give at
     * all: `idlePolicy` is the JS policy's OWN view of device idle, which is
     * what separates "the app paused its socket" from "Android suspended the
     * process" when the Doze sub-leg fails. (It cannot separate them when the
     * leg PASSES — that attribution lives in `app/__tests__/doze.android.test.ts`,
     * by design.)
     *
     * The shared-state trio is the same surface `run-as` reaches, exposed
     * verbatim from the crypto module: the leg uses it to read the lease and
     * the mirrors back through the app's own writer rather than trusting a
     * shell redirect to have produced the same bytes.
     */
    background: {
      serviceRunning: (): Promise<boolean> =>
        (
          NativeModules as unknown as Record<
            string,
            { serviceRunning(): Promise<boolean> } | undefined
          >
        ).TacendumMessaging?.serviceRunning() ?? Promise.resolve(false),
      deviceIdle: (): Promise<boolean> =>
        (
          NativeModules as unknown as Record<
            string,
            { deviceIdle(): Promise<boolean> } | undefined
          >
        ).TacendumMessaging?.deviceIdle() ?? Promise.resolve(false),
      idlePolicy: (): boolean => background.deviceIsIdle(),
      readSharedState: crypto.readSharedState,
      writeSharedState: crypto.writeSharedState,
      deleteSharedState: crypto.deleteSharedState,
    },
    /**
     * Registration-lock derivation, natively. Jest mocks PinHash, so this is
     * the only place the real libsignal Argon2 path is exercised: same inputs
     * must give the same verifier, a different PIN or salt a different one,
     * and the PIN must not appear in the output.
     */
    /**
     * Keypair account auth, natively, against the REAL deployed server.
     *
     * The one thing no test on either side can catch: the Swift signer and the
     * Node verifier must agree byte for byte on what gets signed — the UTF-8
     * domain tag followed by the RAW DECODED challenge. Sign the base64 text
     * instead and both halves still pass their own suites while nobody on
     * earth can log in. So this hook does the whole exchange for real and
     * reports the server's verdict.
     *
     * Signatures are XEdDSA and use a random nonce, so two signatures over the
     * same challenge differ — that is expected and is why determinism is not
     * asserted here.
     */
    keypairAuth: async (): Promise<string> => {
      const c = require('tacendum-crypto') as typeof import('tacendum-crypto');
      const cfg = require('./config') as typeof import('./config');

      if (!(await c.hasIdentity())) await c.generateAndStoreKeys();
      const identityKey = await c.identityPublicKey();
      if (identityKey === null) return JSON.stringify({ error: 'no identity after keygen' });

      const chRes = await fetch(`${cfg.API_BASE}/v1/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identityKey }),
      });
      const chBody = (await chRes.json()) as { challenge?: string };
      if (chRes.status !== 200 || !chBody.challenge) {
        return JSON.stringify({ step: 'challenge', status: chRes.status, body: chBody });
      }

      const signature = await c.signAuthChallenge(chBody.challenge, cfg.API_BASE);
      const authRes = await fetch(`${cfg.API_BASE}/v1/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identityKey, challenge: chBody.challenge, signature }),
      });
      const authBody = (await authRes.json()) as { userId?: string; authToken?: string };

      // A tampered signature must be refused, or "it verified" proves nothing.
      const flipped =
        signature.slice(0, -2) + (signature.slice(-2, -1) === 'A' ? 'B' : 'A') + signature.slice(-1);
      const badRes = await fetch(`${cfg.API_BASE}/v1/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identityKey, challenge: chBody.challenge, signature: flipped }),
      });

      return JSON.stringify({
        identityKeyChars: identityKey.length,
        signatureChars: signature.length,
        authStatus: authRes.status,
        gotUserId: typeof authBody.userId === 'string',
        gotToken: typeof authBody.authToken === 'string',
        tamperedStatus: badRes.status,
        ok: authRes.status === 200 && badRes.status !== 200,
      });
    },
    pinDerive: async (): Promise<string> => {
      // Decoded byte count without atob: Hermes has it, but the arithmetic is
      // two lines and this hook must not fail for a polyfill reason.
      const b64Len = (b64: string): number =>
        (b64.length * 3) / 4 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
      const rl = require('./registrationLock') as typeof import('./registrationLock');
      const saltA = await rl.newSalt();
      const saltB = await rl.newSalt();
      const started = Date.now();
      const one = await rl.deriveVerifier('4817', saltA);
      const elapsedMs = Date.now() - started;
      const again = await rl.deriveVerifier('4817', saltA);
      const otherPin = await rl.deriveVerifier('9264', saltA);
      const otherSalt = await rl.deriveVerifier('4817', saltB);
      return JSON.stringify({
        saltBytes: b64Len(saltA),
        deterministic: one === again,
        pinMatters: one !== otherPin,
        saltMatters: one !== otherSalt,
        leaksPin: one.includes('4817'),
        verifierBytes: b64Len(one),
        elapsedMs,
      });
    },
    /**
     * QR native round trip: encode an id → write the share PNG → decode that
     * file with Vision → validate. Proves the whole picture path — CoreImage
     * raster, nearest-neighbour upscale, quiet zone, file write, Vision read —
     * in one call, which Jest cannot (the native module is mocked there).
     * Lazy require, same reason as webrtcSpike.
     */
    qrRoundTrip: async (): Promise<string> => {
      const qr = require('./qr') as typeof import('./qr');
      // Two fixed, distinct, canonical-alphabet ULIDs: the second exists so
      // readIdFromImage's own-id guard sees a DIFFERENT self and stays out of
      // the way of what this proves.
      const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const notMe = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
      const drawn = await qr.encodeSelfQr(id, {
        darkHex: '#181818',
        lightHex: '#FFFFFF',
      });
      const fileUri = await qr.writeShareImage(drawn.pngB64);
      try {
        // The raw native call first: when this fails, the policy layer's
        // deliberate flattening (everything → QrImageUnreadable) is exactly
        // what we need to see PAST here.
        const nat = require('tacendum-qr') as typeof import('tacendum-qr');
        let raw: string;
        try {
          raw = JSON.stringify(await nat.decodeFile(fileUri));
        } catch (err) {
          const e = err as { code?: string; message?: string };
          return JSON.stringify({
            stage: 'native-decode',
            fileUri,
            err: `code=${e?.code} msg=${e?.message}`,
          });
        }
        const decoded = await qr.readIdFromImage(fileUri, notMe);
        return JSON.stringify({
          pngBytes: Math.floor((drawn.pngB64.length * 3) / 4),
          fileUri,
          raw,
          decoded,
          match: decoded === id,
        });
      } finally {
        await qr.clearShareImage();
      }
    },
    /**
     * THE EMULATOR LOOPBACK CALL.
     *
     * Two cids through the REAL module in one process: `configure` with the
     * relay-only policy, `createOffer` on A, `createAnswer` on B,
     * `setRemoteAnswer` on A, candidates routed both ways, and then the two
     * things only a device can answer — that both sides reach `connected`,
     * and that bytes actually move.
     *
     * WHY ONE CALL RATHER THAN A SEQUENCE OF CDP EVALUATIONS. Candidates
     * trickle: `GATHER_CONTINUALLY` means each side keeps producing them
     * after its description is set, and each one has to be handed to the
     * other cid within the same JS runtime that received the event. A leg
     * driving that from bash would have to hold the subscription across
     * evaluations, and the shape it would reach for — a global the shell
     * polls — is the object this function already is.
     *
     * WHAT IS DELIBERATELY NOT ASSERTED HERE: the codec's IDENTITY. The
     * negotiated mime type is returned so the leg can prove the field is
     * present and non-empty, and no further, because emulator codecs are
     * software and a VP8 result says nothing about H.264 on real hardware —
     * that row is physical-device matrix work, still pending on real
     * hardware.
     *
     * `nonRelayCandidates` is the claim measured rather than assumed:
     * under the relay-only policy no host or server-reflexive candidate may
     * ever be offered, because the whole point is that the peer never learns
     * this device's address.
     */
    loopbackCall: async (iceServersJson: string, relayOnly: boolean): Promise<string> => {
      const nc = require('tacendum-call') as typeof import('tacendum-call');
      const stamp = `${Date.now().toString(36)}`;
      const A = `loopback-a-${stamp}`;
      const B = `loopback-b-${stamp}`;
      const peerOf = (cid: string): string => (cid === A ? B : A);

      const conn: Record<string, string> = { [A]: 'new', [B]: 'new' };
      const ice: Record<string, string> = { [A]: 'new', [B]: 'new' };
      const gathered: Record<string, number> = { [A]: 0, [B]: 0 };
      const tracks: Record<string, string[]> = { [A]: [], [B]: [] };
      const queued: Record<string, { cand: string; mid: string; idx: number }[]> = {
        [A]: [],
        [B]: [],
      };
      // A candidate handed to a cid whose peer connection does not exist yet
      // is DROPPED by the module (an ordinary case: candidates outlive their
      // call). So they are held here until the far side has been created, and
      // only then delivered.
      const created: Record<string, boolean> = { [A]: false, [B]: false };
      const nonRelay: string[] = [];
      let candidateError = '';

      const drain = (): void => {
        for (const cid of [A, B]) {
          if (!created[cid] || queued[cid].length === 0) continue;
          const batch = queued[cid].splice(0, queued[cid].length);
          void nc.addIceCandidates(cid, batch).catch((err: unknown) => {
            const e = err as { message?: string };
            candidateError = String(e?.message ?? err);
          });
        }
      };

      const subs = [
        nc.events.iceCandidate(e => {
          if (e.cid !== A && e.cid !== B) return;
          gathered[e.cid] += 1;
          const typ = / typ ([a-z]+)/.exec(e.cand)?.[1] ?? 'unknown';
          if (relayOnly && typ !== 'relay') nonRelay.push(typ);
          queued[peerOf(e.cid)].push({ cand: e.cand, mid: e.mid, idx: e.idx });
          drain();
        }),
        nc.events.connectionState(e => {
          if (e.cid === A || e.cid === B) conn[e.cid] = e.state;
        }),
        nc.events.iceState(e => {
          if (e.cid === A || e.cid === B) ice[e.cid] = e.state;
        }),
        nc.events.remoteTrackAdded(e => {
          if (e.cid === A || e.cid === B) tracks[e.cid].push(e.kind);
        }),
      ];

      const sleep = (ms: number): Promise<void> =>
        new Promise<void>(resolve => setTimeout(resolve, ms));
      const number = (value: unknown): number => (typeof value === 'number' ? value : 0);
      // Inside the 60s cdp-eval budget with room for the round trips either
      // side of it: a leg that returned a diagnosis is always better than one
      // that returned "the app stopped answering".
      const deadline = Date.now() + 35_000;
      const started = Date.now();
      let stage = 'configure';
      let offerHasFingerprint = false;
      let statsA: Record<string, unknown> = {};
      let statsB: Record<string, unknown> = {};
      let flowing = false;

      try {
        // The emulator has no dependable camera; without the synthetic
        // capturer there is nothing to encode and "media flowing" could only
        // ever mean audio, which manual audio deliberately holds off
        // until Telecom activates it.
        await nc.enableSyntheticVideo(true);
        await nc.configure(JSON.parse(iceServersJson), relayOnly);

        stage = 'createOffer';
        const offer = await nc.createOffer(A, true);
        created[A] = true;
        offerHasFingerprint = /a=fingerprint:sha-256 /.test(offer);
        drain();

        stage = 'createAnswer';
        const answer = await nc.createAnswer(B, offer, true);
        created[B] = true;
        drain();

        stage = 'setRemoteAnswer';
        await nc.setRemoteAnswer(A, answer);

        stage = 'connect';
        while (Date.now() < deadline && !(conn[A] === 'connected' && conn[B] === 'connected')) {
          drain();
          await sleep(250);
        }

        stage = 'media';
        // `framesPerSecond` RATHER THAN `bytesSent`, and the reason is a
        // collision in the stats shape both platforms share: `statsJson`
        // writes one key per `<type>.<field>`, so the audio and video
        // `outbound-rtp` entries land on the SAME key and the last one
        // iterated wins. The audio unit is held off by manual audio
        // until Telecom activates it, which never happens in a loopback, so
        // an audio entry that wins the collision reports zero bytes on a call
        // whose video is flowing perfectly. `framesPerSecond` exists only on
        // a video entry, so it cannot be the audio one — a positive value is
        // unambiguously this side's encoder producing frames. Every raw key
        // is returned below, so a failure shows the whole picture rather than
        // the one number this line read.
        while (Date.now() < deadline) {
          statsA = JSON.parse(await nc.getStats(A)) as Record<string, unknown>;
          statsB = JSON.parse(await nc.getStats(B)) as Record<string, unknown>;
          flowing =
            number(statsA['outbound-rtp.framesPerSecond']) > 0 &&
            number(statsB['outbound-rtp.framesPerSecond']) > 0 &&
            number(statsA['inbound-rtp.bytesReceived']) > 0 &&
            number(statsB['inbound-rtp.bytesReceived']) > 0;
          if (flowing) break;
          await sleep(500);
        }

        return JSON.stringify({
          stage,
          connectedA: conn[A],
          connectedB: conn[B],
          iceA: ice[A],
          iceB: ice[B],
          gatheredA: gathered[A],
          gatheredB: gathered[B],
          nonRelayCandidates: nonRelay,
          remoteTracksA: tracks[A],
          remoteTracksB: tracks[B],
          offerHasFingerprint,
          flowing,
          // Every key, verbatim: a media assertion that fails should hand the
          // transcript the whole stats object rather than the one field it
          // happened to read.
          statsA,
          statsB,
          // The codec field: present and non-empty is the whole claim.
          codecA: statsA['outbound-rtp.codec'] ?? '',
          codecB: statsB['outbound-rtp.codec'] ?? '',
          relayOnly,
          candidateError,
          elapsedMs: Date.now() - started,
        });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return JSON.stringify({
          stage,
          err: `code=${e?.code} msg=${e?.message}`,
          connectedA: conn[A],
          connectedB: conn[B],
          gatheredA: gathered[A],
          gatheredB: gathered[B],
          nonRelayCandidates: nonRelay,
          candidateError,
          relayOnly,
          elapsedMs: Date.now() - started,
        });
      } finally {
        for (const s of subs) s.remove();
        await nc.close(A).catch(() => undefined);
        await nc.close(B).catch(() => undefined);
        await nc.enableSyntheticVideo(false).catch(() => undefined);
      }
    },
    /**
     * The link spike: prove libwebrtc (BoringSSL) and
     * LibSignalClient (ring/rustls) coexist in one process — create a peer
     * connection and drive it to ICE gathering. Lazy require: the module
     * only loads when the spike is invoked, never at bundle start.
     */
    webrtcSpike: async (): Promise<string> => {
      const { RTCPeerConnection } = require('react-native-webrtc') as {
        RTCPeerConnection: new (config: unknown) => {
          createOffer: (o?: unknown) => Promise<{ sdp: string }>;
          setLocalDescription: (d: unknown) => Promise<void>;
          iceGatheringState: string;
          close: () => void;
        };
      };
      const pc = new RTCPeerConnection({ iceServers: [] });
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        const hasFingerprint = /a=fingerprint:sha-256 /.test(offer.sdp);
        return JSON.stringify({
          gathering: pc.iceGatheringState,
          hasFingerprint,
          sdpBytes: offer.sdp.length,
        });
      } finally {
        pc.close();
      }
    },
  };
}

export {};
