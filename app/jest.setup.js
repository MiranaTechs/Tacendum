/* eslint-env jest */
/**
 * Jest runs without the native runtime: mock the two native-backed modules.
 * The crypto mock mirrors the tacendum-crypto wrapper's surface — tests
 * exercising real crypto belong to the scripted simulator Verify block.
 *
 * The Keychain is a real in-memory Map (state persists across calls within a
 * test, reset via __keychain.clear()), because the lock feature's contract is
 * "state lives in the Keychain, not in module scope".
 */

// Without native measurements SafeAreaProvider renders nothing, which made
// every render-the-App test vacuous. The library ships a jest mock.
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);

// Install marker (NSUserDefaults via RN Settings — native, so mocked).
// Defaults to "not a fresh install"; tests flip __install.firstRun.
jest.mock('./src/install', () => {
  const state = { firstRun: false };
  return {
    isFirstRunAfterInstall: () => state.firstRun,
    markInstalled: jest.fn(() => {
      state.firstRun = false;
    }),
    __install: state,
  };
});

jest.mock('tacendum-crypto', () => {
  const secrets = new Map();
  const sharedState = new Map();
  const inbox = new Map();
  /**
   * The backup-exclusion model. The native module puts every database inside
   * ONE directory (`Library/tacendum-db`) and sets the exclusion flag on the
   * DIRECTORY — iOS backups skip an excluded directory's entire subtree, so a
   * journal SQLite mints mid-session is covered by construction. The mock
   * mirrors that: `excludedPaths` holds what got FLAGGED (the directory), and
   * db.backup.test.ts derives per-file coverage from ancestry, so a design
   * that regressed to flagging individual files fails the suite.
   */
  const backupExclusion = {
    dir: '/mock-library/tacendum-db',
    excludedPaths: new Set(),
    /** Simulates URLResourceValues.setResourceValues failing. */
    failExclusion: false,
  };
  return {
    generateAndStoreKeys: jest.fn(),
    existingKeysForUpload: jest.fn(),
    hasIdentity: jest.fn().mockResolvedValue(false),
    // Keypair accounts. Defaults describe a device
    // with NO identity yet — `null` is what identityPublicKey answers before
    // generateAndStoreKeys has ever run — so a test that means "this install
    // already has keys" has to say so, rather than getting it by accident.
    // The signature is a stand-in: real signing is XEd25519 inside libsignal
    // and is proved on the simulator through the devhook, never here.
    identityPublicKey: jest.fn().mockResolvedValue(null),
    signAuthChallenge: jest.fn(async challengeB64 => `sig(${challengeB64})`),
    // Device linking. Stand-ins like
    // signAuthChallenge: real link-op signing AND verification are libsignal
    // on-device, proved by the Swift-signed fixtures in link-vectors.test.ts
    // — never here. The FULL tuple rides into the fake signature (the
    // earlier op+nonce algebra let an omitted or
    // swapped tuple binding verify anyway), so sign-then-verify round-trips
    // only over IDENTICAL nine-field tuples while a forged string
    // ("OFFERSIG"), a substituted subject key, a re-classed wrap, or a
    // shifted epoch all fail — the same failure surface the real preimage
    // has. Tests that need signer-key discrimination override verifyLinkOp
    // with their own scheme — the TOFU suite does.
    signLinkOp: jest.fn(async (op, tuple) =>
      `linksig(${op}:${tuple.groupId}:${tuple.offererUserId}:${tuple.acceptorUserId}:${tuple.subjectIdentityPubKey}:${tuple.class}:${tuple.rosterEpoch}:${tuple.offerNonce}:${tuple.expiresAt})`,
    ),
    verifyLinkOp: jest.fn(
      async (_keyB64, op, tuple, sig) =>
        sig ===
        `linksig(${op}:${tuple.groupId}:${tuple.offererUserId}:${tuple.acceptorUserId}:${tuple.subjectIdentityPubKey}:${tuple.class}:${tuple.rosterEpoch}:${tuple.offerNonce}:${tuple.expiresAt})`,
    ),
    processPreKeyBundle: jest.fn(),
    hasSession: jest.fn().mockResolvedValue(false),
    safetyNumber: jest.fn().mockResolvedValue(null),
    resetPeer: jest.fn(),
    isIdentityChangeError: jest.fn().mockReturnValue(false),
    isStoreBusyError: jest.fn().mockReturnValue(false),
    encryptText: jest
      .fn()
      .mockResolvedValue({ msgType: 'ciphertext', payload: 'AAAA' }),
    decryptEnvelope: jest.fn(),
    blobEncrypt: jest
      .fn()
      .mockResolvedValue({ keyB64: 'a2V5', blobB64: 'YmxvYg==' }),
    blobDecrypt: jest.fn(),
    // Deterministic stand-in for libsignal PinHash. Two properties tests
    // depend on: distinct (pin, salt) pairs give distinct verifiers, and the
    // output does NOT contain the pin — otherwise "the PIN never travels"
    // could not be asserted against a payload.
    pinVerifier: jest.fn(async (pin, saltB64) => {
      let h = 5381;
      for (const ch of `${pin}|${saltB64}`) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
      return `mockverifier${h.toString(16).padStart(8, '0')}`;
    }),
    randomBytes: jest.fn(async count => {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) out[i] = (i * 37 + 11) % 256;
      return out;
    }),
    // REAL SHA-256 (node:crypto), not a stand-in like pinVerifier above. The
    // native method's whole contract is byte-equality with any other client's
    // SHA-256 — a roster digest two clients compute differently is a permanent
    // false alarm — so the mock IS the Node binding, and the known-answer test
    // pins the FIPS vectors every binding must hit. (CryptoKit's side of that
    // equality is proved on device.)
    //
    // This used to say the contract was equality with "the CLI's
    // crypto.createHash('sha256')". There is no SHA-256 under
    // packages/cli/src at all, so that named a peer that does not exist; the
    // real peer today is CryptoKit, and node:crypto here is the reference the
    // vectors are pinned against. The engineering rules carried the same
    // phantom CLI citation and was corrected in the same pass.
    sha256: jest.fn(async data => {
      const digest = require('crypto').createHash('sha256').update(data).digest();
      return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
    }),
    getSecret: jest.fn(async key => secrets.get(key) ?? null),
    setSecret: jest.fn(async (key, value) => {
      secrets.set(key, value);
    }),
    deleteSecret: jest.fn(async key => {
      secrets.delete(key);
    }),
    // Shared state is a SEPARATE map from the Keychain on purpose. The whole
    // reason it exists is that an extension cannot read the Keychain, so a
    // mock that conflated the two would hide exactly the bug it is here to
    // catch: a value written to one and read from the other.
    // The spool the notification extension writes into. A separate map again:
    // it is a different container directory and conflating it with the
    // preference files would hide a path bug rather than catch one.
    readInbox: jest.fn(async () => [...inbox.values()]),
    clearInboxEntry: jest.fn(async msgId => {
      inbox.delete(msgId);
    }),
    readSharedState: jest.fn(async name => sharedState.get(name) ?? null),
    writeSharedState: jest.fn(async (name, value) => {
      sharedState.set(name, value);
    }),
    deleteSharedState: jest.fn(async name => {
      sharedState.delete(name);
    }),
    // SYNCHRONOUS, like the native method (a TurboModule sync call): the
    // migration it performs must complete before op-sqlite's open() reaches
    // the directory, and conn() is synchronous. Mirrors the native contract:
    // validates the bare name, returns where the database must be opened and
    // whether the exclusion attribute is in place; throws only when the
    // directory itself cannot be prepared.
    prepareDatabaseDirectory: jest.fn(fileName => {
      if (
        !fileName ||
        fileName.length > 64 ||
        fileName.includes('/') ||
        fileName.includes('..')
      ) {
        throw new Error('invalid database file name');
      }
      if (!backupExclusion.failExclusion) {
        backupExclusion.excludedPaths.add(backupExclusion.dir);
      }
      return {
        location: backupExclusion.dir,
        excluded: !backupExclusion.failExclusion,
      };
    }),
    resetProtocolState: jest.fn(async () => {
      // Native reset removes files, never Keychain/Keystore values. Keeping
      // those here exercises durable deletion recovery instead of hiding it.
      sharedState.clear();
      inbox.clear();
    }),
    __keychain: secrets,
    __sharedState: sharedState,
    __inbox: inbox,
    __backupExclusion: backupExclusion,
  };
});

jest.mock('tacendum-screen-security', () => {
  /** Mirrors the native module's JS facade; tests drive capture state and
   * screenshot events through __screensec. */
  const state = { captured: false, started: false };
  const capturedListeners = new Set();
  const screenshotListeners = new Set();
  return {
    start: jest.fn(() => {
      state.started = true;
    }),
    getIsCaptured: jest.fn(async () => state.captured),
    onCapturedChanged: jest.fn(listener => {
      capturedListeners.add(listener);
      return { remove: () => capturedListeners.delete(listener) };
    }),
    onScreenshot: jest.fn(listener => {
      screenshotListeners.add(listener);
      return { remove: () => screenshotListeners.delete(listener) };
    }),
    __screensec: {
      state,
      emitCaptured(captured) {
        state.captured = captured;
        for (const cb of capturedListeners) cb(captured);
      },
      emitScreenshot() {
        for (const cb of screenshotListeners) cb();
      },
      reset() {
        state.captured = false;
        state.started = false;
        capturedListeners.clear();
        screenshotListeners.clear();
      },
    },
  };
});

/**
 * The calling module.
 *
 * Mirrors the JS facade in tacendum-call/src/index.ts. Tests drive native
 * events through `__call.emit`, so an incoming call or an ICE state change can
 * be exercised without a device — which is the whole reason the protocol lives
 * in a pure reducer above this boundary.
 */
jest.mock('tacendum-call', () => {
  const listeners = new Map();
  const on = name => handler => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return { remove: () => listeners.get(name).delete(handler) };
  };
  const emit = (name, payload) => {
    for (const cb of listeners.get(name) ?? []) cb(payload);
  };
  const calls = [];
  const dismissals = [];
  /** Every missed-call notice op, in order — see postMissedCall below. */
  const missed = [];
  /**
   * The placeholder CallKitCenter would have ringing, modelled so the guard
   * above has something to guard. `null` when nothing is pending.
   */
  let pendingPush = null;
  return {
    configure: jest.fn(async () => undefined),
    createOffer: jest.fn(async () => 'v=0\r\na=fingerprint:sha-256 AA\r\nOFFER'),
    createAnswer: jest.fn(async () => 'v=0\r\na=fingerprint:sha-256 BB\r\nANSWER'),
    setRemoteAnswer: jest.fn(async () => undefined),
    addIceCandidates: jest.fn(async () => undefined),
    restartIce: jest.fn(async () => 'v=0\r\nRESTART'),
    close: jest.fn(async () => undefined),
    setAccountOwner: jest.fn(async () => undefined),
    // The APPLIED VERDICT: the real module answers
    // whether that cid had a live connection whose track was changed. `true`
    // is the ordinary case; a test that means "this leg could not be
    // silenced" says so with mockResolvedValueOnce(false).
    setAudioEnabled: jest.fn(async () => true),
    setVideoEnabled: jest.fn(async () => true),
    switchCamera: jest.fn(async () => undefined),
    setSpeaker: jest.fn(async () => undefined),
    getStats: jest.fn(async () => '{}'),
    reportOutgoingCall: jest.fn(async () => undefined),
    reportOutgoingConnected: jest.fn(async () => undefined),
    reportIncomingCall: jest.fn(async (...args) => void calls.push(args)),
    updateIncomingCallDisplay: jest.fn(async () => undefined),
    /**
     * THE NATIVE GUARD, MODELLED — not a silent resolve.
     *
     * `CallKitCenter.dismissPendingIncomingCall` fires only while
     * `pendingPush` still names BOTH this caller and this exact placeholder
     * cid ('' matching whatever is pending). A mock that swallowed every
     * dismissal made a JS-side revert to the caller-keyed match invisible, and
     * made a STUCK ring — a dismissal that matches nothing — indistinguishable
     * from a successful one. Both directions are defects, so both are
     * observable here: `__call.dismissals` records what was asked for, and
     * `__call.pendingRing()` says whether a placeholder is still up.
     *
     * `cid = ''` mirrors the facade's default, so a two-argument caller
     * degrades here exactly as it does in production.
     */
    dismissPendingIncomingCall: jest.fn(async (peerId, reason, cid = '') => {
      dismissals.push({ peerId, reason, cid });
      if (!pendingPush) return undefined;
      if (peerId && pendingPush.from !== peerId) return undefined;
      if (cid && pendingPush.cid !== cid) return undefined;
      pendingPush = null;
      return undefined;
    }),
    endCall: jest.fn(async () => undefined),
    /**
     * THE MISSED-CALL NOTICES, and the answer that takes one down.
     *
     * Without these mocks missed-call notices could not be tested: `postMissedCallNotice` and
     * `clearMissedCallNotices` are both TOTAL by design — a module without
     * the method costs the notice, never the row — so a mock missing them
     * made "the notice was posted" and "the method does not exist here"
     * the same green. Recorded in `__call.missed` so a suite can say which
     * of the two it saw. `call/index.ts` reaches these through
     * `missedCallBridge`, which is what a test spies on; these exist so the
     * unspied path is the real shape rather than a TypeError.
     */
    postMissedCall: jest.fn(async (peerId, displayName) => {
      missed.push({ op: 'post', peerId, displayName });
    }),
    clearMissedCall: jest.fn(async peerId => {
      missed.push({ op: 'clear', peerId });
    }),
    /** CallKit's "answered elsewhere" acknowledgement for a reported call. */
    answerReportedCall: jest.fn(async sid => {
      missed.push({ op: 'answer', sid });
    }),
    getVoipToken: jest.fn(async () => 'voip-token'),
    /**
     * PUSHKIT, FAITHFULLY — and this mock emitting NOTHING is why an
     * every-launch leak lived in this repo undetected.
     *
     * The native side sets `registry.desiredPushTypes = [.voIP]`
     * (CallKitCenter.swift), and PKPushRegistry answers
     * `didUpdatePushCredentials` immediately — including out of a token the
     * system already holds from a previous launch — which the bridge turns
     * into `voipTokenUpdated`. So EVERY real launch fires that event, and no
     * test in this repo had ever seen it: the two listeners `startCalling`
     * attaches to it were unreachable from jest, and an assertion that
     * "nothing was uploaded" passed because nothing could have been.
     *
     * Same for the alert token one line down: a granted prompt leads to
     * `registerForRemoteNotifications`, whose delegate callback calls
     * `setAlertToken` and emits `alertTokenUpdated` (TacendumCallImpl.swift).
     * Emitted synchronously here rather than an APNs round trip later, which
     * is earlier than the device but still a moment the device reaches — and
     * the earliest moment is the one a pre-verdict guard has to survive.
     */
    registerForVoipPush: jest.fn(async () => {
      emit('voipTokenUpdated', 'voip-token');
    }),
    flushPendingEvents: jest.fn(async () => undefined),
    requestNotificationPermission: jest.fn(async () => {
      emit('alertTokenUpdated', { token: 'alert-token' });
      return 'granted';
    }),
    getAlertToken: jest.fn(async () => 'alert-token'),
    setBadgeCount: jest.fn(async () => undefined),
    bundleId: jest.fn(async () => 'com.miranatechnologies.tacendum'),
    cameraPermission: jest.fn(async () => 'granted'),
    micPermission: jest.fn(async () => 'granted'),
    requestPermissions: jest.fn(async () => ({ camera: 'granted', mic: 'granted' })),
    enableSyntheticVideo: jest.fn(async () => undefined),
    enableFingerprintFault: jest.fn(async () => undefined),
    startMonitoringPressure: jest.fn(async () => undefined),
    stopMonitoringPressure: jest.fn(async () => undefined),
    applyVideoCap: jest.fn(async () => undefined),
    sampleQuality: jest.fn(async () => -1),
    events: {
      iceState: on('iceState'),
      iceCandidate: on('iceCandidate'),
      connectionState: on('connectionState'),
      remoteTrackAdded: on('remoteTrackAdded'),
      remoteTrackRemoved: on('remoteTrackRemoved'),
      callKitAnswer: on('callKitAnswer'),
      callKitEnd: on('callKitEnd'),
      callKitMute: on('callKitMute'),
      callKitAudioActivated: on('callKitAudioActivated'),
      callKitAudioDeactivated: on('callKitAudioDeactivated'),
      voipPush: on('voipPush'),
      voipTokenUpdated: on('voipTokenUpdated'),
      alertTokenUpdated: on('alertTokenUpdated'),
      audioRouteChanged: on('audioRouteChanged'),
      devicePressure: on('devicePressure'),
    },
    // The video surface. A host component string, so a test can assert it was
    // rendered with the right cid and track without a Metal renderer.
    TacendumVideoView: 'TacendumVideoView',
    __call: {
      reported: calls,
      /** Every dismissal asked for, in order — `{peerId, reason, cid}`. */
      dismissals,
      /** Every missed-call notice op, in order — `{op, peerId, …}`. */
      missed,
      emit,
      /**
       * A VoIP push, WITH NATIVE'S OWN BOOKKEEPING.
       *
       * `alreadyRinging` (CallKitCenter): a second push for a peer already
       * ringing NEVER overwrites `pendingPush`, so the `ringCid` this publishes
       * stays the FIRST ring's cid. That asymmetry is the entire reason the
       * event carries a `ringCid` at all, and a raw `emit('voipPush', …)`
       * cannot express it — which is why this exists beside `emit` rather than
       * replacing it.
       */
      voipPush(cid, from) {
        if (!pendingPush) pendingPush = { cid, from };
        const ringCid = pendingPush.from === from ? pendingPush.cid : '';
        emit('voipPush', { cid, from, ringCid });
      },
      /** The placeholder still up, or null. A dismissal that matched nothing
       * leaves this standing: that is the stuck ring, and it is assertable. */
      pendingRing: () => pendingPush,
      reset() {
        listeners.clear();
        calls.length = 0;
        dismissals.length = 0;
        missed.length = 0;
        pendingPush = null;
      },
    },
  };
});

jest.mock('@op-engineering/op-sqlite', () => {
  /**
   * One fake FILE per name, like real files on disk — and one fresh HANDLE per
   * `open()`, like real connections to them.
   *
   * THE TWO USED TO BE THE SAME OBJECT, AND THAT MADE A WHOLE CLASS OF DEFECT
   * INVISIBLE. `close` was a no-op `jest.fn()` and a re-open handed back the
   * same instance, so a handle closed under an in-flight statement kept
   * answering: every use-after-close in this app read as green, and any
   * assertion about the door re-homing an already-open handle (`conn()` drops
   * a handle on the wrong workspace and opens another) proved nothing at all.
   * `DBHostObject.cpp` has no such courtesy — `close` sets `db = nullptr` and
   * the `execute` entry point checks neither that nor `invalidated` before
   * dispatching, so what production gets is a rejected promise, which on the
   * ring path is a DISCARDED ANSWER.
   *
   * So: `instances` still maps NAME → the file (its recording `execute`, its
   * `close`), which is what tests seed and assert against, and `open()` now
   * returns a DISTINCT handle every time — one that rejects every `execute`
   * once its own `close()` has run, while the file behind it goes on recording
   * for the next handle exactly as a file on disk would.
   *
   * THROUGH A PROXY RATHER THAN A WRAPPER FUNCTION, and that is not cleverness
   * for its own sake: fourteen suites obtain a file by calling `open()` and
   * then configure it (`instance.execute.mockImplementation(...)`) or read its
   * recorder (`instance.execute.mock.calls`). A plain closure would break every
   * one of them and would also split the recording in two, so a statement run
   * through the app's handle would stop being visible on the test's. The proxy
   * intercepts only the CALL — where the closed check belongs — and passes
   * every property through to the file's own `jest.fn`, so both stay one
   * object's worth of truth.
   */
  const instances = new Map();
  const opened = [];
  const file = name => {
    if (!instances.has(name)) {
      instances.set(name, {
        name,
        // Default rows are empty, EXCEPT the schema-inference PRAGMAs that
        // initDb's destructive-rebuild path checks: an empty answer there
        // reads as "old shape on disk" and recurses forever.
        //
        // ANSWERS WITH A VALUE RATHER THAN A PROMISE, and what that buys is
        // microtask depth, not fidelity — the handle below hands production a
        // promise either way. Several suites override this and fall through to
        // it (`return base(sql, params)` from inside their own `async`
        // function); returning a thenable there costs the override two extra
        // hops for adopting it, and leaves its own promise PENDING at return,
        // which is the one state the handle wraps. A plain answer settles the
        // override where it stands.
        //
        // WHAT IT COSTS, STATED HONESTLY BECAUSE THE PREVIOUS VERSION OF THIS
        // SENTENCE WAS FALSE: a statement that answers before `execute`
        // returns is never registered as in flight, so `close` can never cut
        // it. Inside this harness that is exact rather than forgiving — no
        // close can land under a statement that nothing awaited — but it does
        // mean the mock models production's OUTCOME here and not its timing,
        // where every `execute` suspends on a thread pool and every one of
        // them is cuttable. A suite that needs to see a cut must park its
        // statement, which is what makes it pending. Pinned by "the default
        // file answer settles where it stands" in `db.door.consume`, because
        // other lanes' fixed tick budgets are what pay for it.
        execute: jest.fn(sql => {
          const s = String(sql);
          if (s.includes('PRAGMA table_info(attachments')) {
            return { rows: [{ name: 'direction' }] };
          }
          if (s.includes('PRAGMA table_info(reactions')) {
            // Both columns the rebuild loop checks — an answer missing one
            // reads as "old shape on disk" and recurses forever (a HANG, not
            // a red test).
            return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
          }
          if (s.includes('PRAGMA table_info(pending_revisions')) {
            return { rows: [{ name: 'writerId' }] };
          }
          return { rows: [] };
        }),
        close: jest.fn(),
      });
    }
    return instances.get(name);
  };
  /**
   * IS THIS STATEMENT STILL RUNNING? — asked once, synchronously, at the
   * moment `execute` returns.
   *
   * Node has no public promise-state predicate and `process.binding('util')`
   * is not reachable under jest, so this reads the one representation that is
   * both stable and cheap (~0.5 µs): `util.inspect` renders a pending promise
   * as exactly `Promise { <pending> }` and a settled one as its value or its
   * rejection. Matched whole, at depth 0 and with strings and arrays clipped,
   * so no row a database answers with can spell the sentinel and no custom
   * inspector can be reached. Anything that is not a native promise — a plain
   * value, a hand-rolled thenable — answers false: it cannot suspend, so it
   * cannot be interrupted.
   */
  const inspect = require('util').inspect;
  const PENDING = 'Promise { <pending> }';
  const PENDING_OPTS = {
    depth: 0,
    maxArrayLength: 0,
    maxStringLength: 0,
    breakLength: Infinity,
    customInspect: false,
  };
  const isPending = p =>
    !!p && typeof p.then === 'function' && inspect(p, PENDING_OPTS) === PENDING;
  const open = jest.fn(({ name }) => {
    opened.push(name);
    const disk = file(name);
    let closed = false;
    /**
     * `sqlite3_interrupt`, MODELLED — the other half of what `close` means,
     * and the half whose absence made a whole round's tests assert a row set
     * production cannot return.
     *
     * `DBHostObject.cpp`'s `close` runs `sqlite3_interrupt(db)` FIRST, then
     * `thread_pool->waitFinished()`, then `opsqlite_close`. So a statement
     * that is ALREADY RUNNING when the handle closes does not merely lose its
     * connection afterwards: its `sqlite3_step` returns `SQLITE_INTERRUPT`,
     * `bridge.cpp` throws `[op-sqlite] statement execution error: …`, and
     * `utils.cpp`'s promisify REJECTS the JS promise that the caller is
     * awaiting. Checking a `closed` flag only at CALL time models the second
     * half and silently grants the first, which is the strictly more
     * forgiving direction — exactly the direction a harness must not invent.
     *
     * Each dispatched statement registers a cut here before it runs; `close`
     * fires every cut it finds, and whichever of the two settles first wins.
     */
    const inFlight = new Set();
    return {
      name,
      execute: new Proxy(disk.execute, {
        apply: (target, self, args) => {
          if (closed) {
            // What the native layer produces once `db` is null: a REJECTED
            // PROMISE, not a value and not a throw. Callers that swallow it
            // (`.catch(() => [])` on the door's two readers) turn that into
            // "nothing to restore", which on the ring path is a discarded
            // answer — the thing worth being able to see.
            return Promise.reject(new Error('database is closed'));
          }
          // NOT WRAPPED IN A try/catch THAT TURNS A THROW INTO A REJECTION.
          // `execute` is a JSI host function that converts its arguments
          // BEFORE it makes any promise (`DBHostObject.cpp:432-437` —
          // `args[0].asString`, `to_variant_vec`, and only then `promisify`),
          // so a query that is not a string, or a parameter it cannot bind,
          // comes back as a SYNCHRONOUS THROW and never as a rejected promise.
          // Softening that would hide the one thing a caller has to handle
          // differently from every other failure here.
          const raw = Reflect.apply(target, self, args);
          // A STATEMENT THAT HAS ALREADY ANSWERED WAS NEVER IN FLIGHT — the
          // one narrowing here, and it is a fact about this harness rather
          // than a concession in it. JS is single-threaded: if the answer is
          // settled by the time `execute` returns, no other code ran between
          // the call and the answer, so there is no interleaving in which a
          // `close` could have landed underneath it and nothing to interrupt.
          //
          // It is also what keeps the model affordable. Modelling the cut
          // means owning the promise the caller awaits, and owning it costs
          // exactly one microtask hop (measured against `then`, `race` and a
          // hand-rolled deferred: all +1). Paid on EVERY statement that would
          // be a fidelity fix here starving other lanes there — `call.relay`'s
          // cold-launch answer flushes a fixed tick count and needs 48 of them
          // that way.
          //
          // "THE WHOLE APP SUITE IS UNTOUCHED" IS WHAT THIS SAID, AND IT WAS
          // NOT TRUE. Narrowed to statements that genuinely suspend the model
          // still costs the two hops a parked statement pays, and one suite
          // felt it: `call.relay`'s cold-launch answer needed exactly 40 of
          // its 40 ticks before this file existed and needs 42 now, which is
          // why that budget was raised to 60. What IS true is the census
          // behind it: across the app suite exactly two statements are ever
          // cut, and both are the door read this file exists to describe.
          // `Promise.resolve` only for the value case, so `execute` still
          // answers production with a promise however the file answered it.
          if (!isPending(raw)) {
            return raw && typeof raw.then === 'function' ? raw : Promise.resolve(raw);
          }
          let settle;
          const out = new Promise((resolve, reject) => {
            settle = { resolve, reject };
          });
          // WHICHEVER OF THE TWO SETTLES FIRST WINS, and the thing that makes
          // that true is promise settlement being once-only, not bookkeeping
          // here: the loser reaches an already-settled promise and its
          // `resolve`/`reject` is a no-op. This used to delete its own entry
          // first, with "so the set stays bounded" as the reason — untrue, the
          // branch below already removes every statement that answers, and a
          // line that changes no outcome while claiming one is how a harness
          // starts describing something it does not do. `close` fires each cut
          // once from a snapshot, so nothing here needs guarding either.
          const cut = () => {
            settle.reject(
              new Error('[op-sqlite] statement execution error: interrupted'),
            );
          };
          inFlight.add(cut);
          // The delete is bookkeeping and nothing more — it keeps `close` from
          // walking statements that have already answered. It decides no race
          // and is deliberately not written as though it did.
          raw.then(
            v => {
              inFlight.delete(cut);
              settle.resolve(v);
            },
            e => {
              inFlight.delete(cut);
              settle.reject(e);
            },
          );
          return out;
        },
      }),
      close: new Proxy(disk.close, {
        apply: (target, self, args) => {
          // Marked before delegating, so a `close` a test makes throw still
          // leaves the handle spent: the db module nulls its reference either
          // way, so anything still holding this object is holding a corpse.
          closed = true;
          // …and the interrupt, before delegating for the same reason.
          for (const cut of [...inFlight]) cut();
          return Reflect.apply(target, self, args);
        },
      }),
    };
  });
  return {
    open,
    __sqlite: {
      opened,
      instances,
      reset() {
        opened.length = 0;
        instances.clear();
        open.mockClear();
      },
    },
  };
});

jest.mock('tacendum-audio', () => {
  /** Mirrors the native facade. AVAudioRecorder/AVAudioPlayer are device-only,
   * so tests drive outcomes and events through __audio. */
  const listeners = { level: [], recorded: [], played: [], progress: [] };
  const state = {
    recording: null, // an Error rejects startRecording; else it resolves
    result: { dataB64: 'YXVkaW8=', durationSec: 3 },
    /** What the decoder reports — the truth a claimed `dur` is corrected to. */
    decodedSeconds: 3,
    playback: null, // an Error rejects startPlayback
    started: 0,
    cancelled: 0,
    played: [],
    emitLevel: v => listeners.level.forEach(f => f(v)),
    emitRecordingFinished: r => listeners.recorded.forEach(f => f(r)),
    emitPlaybackFinished: () => listeners.played.forEach(f => f()),
    emitPlaybackProgress: v => listeners.progress.forEach(f => f(v)),
  };
  const sub = bucket => ({
    // Matches the codegen EventEmitter surface the other modules expose.
    remove: () => {
      const at = listeners[bucket].indexOf(sub);
      if (at >= 0) listeners[bucket].splice(at, 1);
    },
  });
  return {
    __audio: state,
    startRecording: jest.fn(async () => {
      if (state.recording instanceof Error) throw state.recording;
      state.started += 1;
    }),
    stopRecording: jest.fn(async () => state.result),
    cancelRecording: jest.fn(async () => {
      state.cancelled += 1;
    }),
    startPlayback: jest.fn(async b64 => {
      if (state.playback instanceof Error) throw state.playback;
      state.played.push(b64);
      return state.decodedSeconds;
    }),
    stopPlayback: jest.fn(async () => {}),
    /** The message-arrival chime (app/src/messageSound.ts). Never rejects
     * natively; the mock mirrors that — tests assert on the call. */
    playMessageTone: jest.fn(async () => {}),
    sweepTemp: jest.fn(async () => {}),
    onLevel: jest.fn(f => {
      listeners.level.push(f);
      return sub('level');
    }),
    onRecordingFinished: jest.fn(f => {
      listeners.recorded.push(f);
      return sub('recorded');
    }),
    onPlaybackFinished: jest.fn(f => {
      listeners.played.push(f);
      return sub('played');
    }),
    onPlaybackProgress: jest.fn(f => {
      listeners.progress.push(f);
      return sub('progress');
    }),
  };
});

jest.mock('tacendum-attach', () => {
  /** Mirrors the native facade. Pickers and CoreLocation are device-only;
   * tests drive outcomes through __attach. */
  const state = {
    document: null, // null = cancel; an object = the pick; an Error = reject
    location: { lat: 37.33182, lng: -122.03118, acc: 25 },
    locationError: null,
    previews: [],
  };
  return {
    __attach: state,
    pickDocument: jest.fn(async () => {
      if (state.document instanceof Error) throw state.document;
      return state.document;
    }),
    currentLocation: jest.fn(async () => {
      if (state.locationError) throw state.locationError;
      return state.location;
    }),
    previewFile: jest.fn(async (dataB64, name) => {
      state.previews.push({ dataB64, name });
    }),
  };
});

jest.mock('tacendum-qr', () => {
  /** Mirrors the native module's JS facade. CoreImage and Vision are only
   * provable on a device (see the app-verify round trip), so tests drive what
   * the encoder returns and what the decoder finds through __qr. */
  const state = {
    pngB64: 'iVBORw0KGgo=',
    shareUri: 'file:///Caches/tacendum-qr/tacendum-id.png',
    payloads: [],
    failScan: null,
    failEncode: null,
    failDecode: null,
    failWrite: null,
  };
  const calls = { cleared: 0 };
  const boom = code => Object.assign(new Error(code), { code });
  return {
    encodePng: jest.fn(async () => {
      if (state.failEncode) throw boom(state.failEncode);
      return state.pngB64;
    }),
    decodeFile: jest.fn(async () => {
      if (state.failDecode) throw boom(state.failDecode);
      return state.payloads.slice();
    }),
    // The live scanner. Drives off the SAME `state.payloads` as decodeFile, so
    // a test that sets up two visible codes exercises both paths identically —
    // which is the point of them sharing `idFromPayloads`.
    scanWithCamera: jest.fn(async () => {
      if (state.failScan) throw boom(state.failScan);
      return state.payloads.slice();
    }),
    writeSharePng: jest.fn(async () => {
      if (state.failWrite) throw boom(state.failWrite);
      return state.shareUri;
    }),
    clearSharePng: jest.fn(async () => {
      calls.cleared += 1;
    }),
    __qr: {
      state,
      calls,
      reset() {
        state.pngB64 = 'iVBORw0KGgo=';
        state.shareUri = 'file:///Caches/tacendum-qr/tacendum-id.png';
        state.payloads = [];
        // The live scanner's failure too, so a camera-failure test cannot
        // leak a broken scanner into the next one.
        state.failScan = null;
        state.failEncode = null;
        state.failDecode = null;
        state.failWrite = null;
        calls.cleared = 0;
      },
    },
  };
});
