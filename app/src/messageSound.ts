import { AppState, type AppStateStatus } from 'react-native';
import * as audio from 'tacendum-audio';
import { readSharedState, writeSharedState } from 'tacendum-crypto';
import { session, type SessionMode } from './session';

/**
 * The message-arrival chime: a notification sound for incoming text, the
 * complement of the call ring.
 *
 * WHERE THE GAP WAS. The server pushes an alert only when the socket did not
 * deliver (packages/server/src/handlers/ws.ts: the `wakeRecipient` arm is the
 * ELSE of a live post), so an app with its socket up never sees a push — and
 * the app's `willPresent` presents nothing in the foreground by policy
 * (AppDelegate.swift). Background arrivals already sound: the alert's `aps`
 * carries `sound: default` and the extension keeps it. Foreground arrivals
 * over the socket were silence. This module is that one missing sound, and
 * nothing else: the background sound stays the push's, the incoming call's
 * ring stays CallKit's.
 *
 * WHEN IT MAY SOUND — the privacy doctrine on record: locked and duress states
 * gain NO new signal; a chime may only sound where a message would already
 * surface. Every gate below is that sentence applied:
 *
 *  - only from the one content switch (messaging.ts `applyContent`), after
 *    the row is stored and acked — so only for a message the thread will
 *    show, and never for transport (edits, reactions, receipts, call
 *    signalling, roster events), which never reach that line;
 *  - a started MessagingService only (`start` refuses duress; relock
 *    `stop`s the socket), so nothing chimes behind the lock or in a decoy —
 *    restated here on `session.mode` as belt to that braces;
 *  - the app ACTIVE only: backgrounded, the push (iOS) or the banner
 *    (Android, `announceIncoming`) owns the announcement — this is the exact
 *    complement of that predicate, so no arrival is announced twice;
 *  - not a spooled message: the extension decrypted it while the app was
 *    away, and the push that woke the extension already sounded;
 *  - not the reconnect backlog: a socket that has just opened is flushing
 *    what queued while the app was away, and those messages sounded as
 *    pushes too. There is no wire bit for "queued", so a short quiet window
 *    after every transport open stands in for one;
 *  - not the conversation on screen: reading it IS the announcement (the
 *    same rule ChatThreadScreen applies to read receipts — a thread mounted
 *    but backgrounded is not being read, which the active gate covers);
 *  - not during a call: the call's audio owns the route. Native is the
 *    authority where native can see the call — on iOS `CXCallObserver`
 *    sees Tacendum's calls from the moment CallKit reports them (incoming
 *    ringing included) and cellular calls alike; on Android the module's
 *    gate is the audio mode, which the Telecom connection sets only once a
 *    call is ANSWERED, so a chime under an Android ring is the devices
 *    lane's parity item. The JS probe below is the belt for both, injected
 *    rather than imported so this file — which messaging.ts imports — adds
 *    no edge to the call module; until the call module injects it, the belt
 *    answers "no call" and native alone decides;
 *  - once per burst: N legs of one exchange chime once, the extension's own
 *    continuation rule ("the burst buzzes once, not N times").
 *
 * THE PREFERENCE, default ON, stored as a FILE in the App Group container —
 * previews.ts's idiom, for previews.ts's reason: the notification extension
 * cannot reach the Keychain, and the same switch governs the sound on ITS
 * banners (`PreviewPolicy.messageSound`). A missing or unreadable file reads
 * as ON on both sides: the default is the fresh-install state, and silence
 * is the direction a preference can fail in without disclosing anything.
 * The system's notification settings and the ring/silent switch remain the
 * outer authority — this switch can only ever subtract.
 *
 * KNOWN LIMITS, recorded rather than engineered around:
 *
 *  - the App Group file is written under "protected until first user
 *    authentication" like every shared-state file, so between a reboot and
 *    the first unlock the extension cannot read an Off, and a banner in
 *    that window keeps the server's default sound — exactly the pre-feature
 *    behaviour, never a sound this feature added (the same window in which
 *    previews fall back to the generic "New message");
 *  - the reconnect window is a heuristic, not a wire fact. A frame the
 *    $connect drain posts later than CHIME_QUIET_AFTER_OPEN_MS after the
 *    open chimes although its push already sounded (double); a genuinely
 *    live message inside the window is quiet (missed); and in the
 *    FOREGROUND with the socket down the server pushes, the extension
 *    decrypts and spools, `willPresent` shows nothing, and the spooled
 *    import is quiet too — so that one arrival never sounds. Marking queued
 *    redelivery on the wire is a server change, out of this lane. None of
 *    these is a privacy edge: no sound is ever produced where no message
 *    surfaces.
 */

/** The file both processes agree on. Lowercase and hyphens: it becomes a path. */
export const MESSAGE_SOUND_FILE = 'message-sound';

/** Arrivals closer together than this chime once — the burst rule. */
export const CHIME_BURST_MS = 400;

/**
 * How long after a transport open arrivals are read as the queue drain
 * rather than as news. The server's `$connect` drain posts the whole backlog
 * within moments of the handshake; five seconds covers a slow one without
 * silencing a real conversation for long.
 */
export const CHIME_QUIET_AFTER_OPEN_MS = 5_000;

let enabled = true;

/**
 * What a DURESS session shows and toggles. Never written to the file: the
 * owner's stored choice must survive a coerced session untouched (the
 * typingIndicators.ts rule), and the decoy must still appear to work (rule
 * 16) — so its toggle moves this shadow, which the next real load resets.
 * Nothing ever chimes in duress regardless; this is only about the row.
 */
let duressChoice = true;

/** The in-flight load, so a chime racing the boot-time read waits for it. */
let loading: Promise<void> | null = null;

/** Synchronous, because Settings reads it on every render. */
export function messageSoundEnabled(): boolean {
  return session.mode === 'duress' ? duressChoice : enabled;
}

/**
 * Re-read the persisted choice. Called by `messaging.start()` — which runs
 * on every REAL unlock and never in duress — so the value is loaded before
 * the socket can deliver anything, without a line in App.tsx. Never throws;
 * a failed read falls back to the DEFAULT, exactly as previews.ts does and
 * for the same reason: this value only ever governs what the app itself
 * does, and the extension reads the file with its own default.
 */
export async function loadMessageSound(): Promise<void> {
  // A duress session never touches the file — not to read it either. The
  // decoy shows its own shadow (a coercer's Off must still read
  // Off when they come back to the row), and only a REAL load may reset
  // that shadow; `messaging.start()` refuses duress, so this is the one
  // caller that could otherwise reach the file from a coerced session.
  if (session.mode === 'duress') return;
  const read = (async () => {
    try {
      enabled = (await readSharedState(MESSAGE_SOUND_FILE)) !== '0';
    } catch {
      enabled = true;
    }
    // A real session opening resets the decoy's shadow: the next coerced
    // session starts from the default, not from the last coercer's taps.
    duressChoice = true;
  })();
  loading = read;
  await read;
}

/**
 * Never throws. The in-memory value moves first and stands for this session
 * whatever the file did: the row shows what the person chose, the next
 * arrival is judged by it, and a write that failed heals at the next real
 * unlock, when `loadMessageSound` re-reads whatever the file actually holds.
 * A Settings row must not be left mid-tap by a rejected promise.
 */
export async function setMessageSound(on: boolean): Promise<void> {
  if (session.mode === 'duress') {
    duressChoice = on;
    return;
  }
  enabled = on;
  try {
    await writeSharedState(MESSAGE_SOUND_FILE, on ? '1' : '0');
  } catch {
    // The choice stands in memory; the file keeps its last value.
  }
}

/**
 * A duress session shows the DEFAULT in settings, not the owner's real
 * choice — the readReceipts/typingIndicators rule. Reads already branch on
 * `session.mode`, so this is a no-line-in-App.tsx equivalent of their reset
 * hooks; it exists for callers that want the canonical shape.
 */
export function resetMessageSoundForDuress(): void {
  duressChoice = true;
}

// --- what is on screen -------------------------------------------------------

let focused: string | null = null;

/**
 * The conversation the person is reading, registered by ChatThreadScreen on
 * mount and cleared on unmount — a 1:1's peer id or a room's group id, the
 * same key `applyContent` calls `convId`. Route state lives in App.tsx and
 * is deliberately not consumed here (visibleSurface.ts's consumer cap): the
 * thread screen is the one component that can honestly say it is open.
 */
export function setFocusedConversation(id: string): void {
  focused = id;
}

/** Only the thread that registered may clear: a stale unmount must not
 * blank the focus a newer mount just set. */
export function clearFocusedConversation(id: string): void {
  if (focused === id) focused = null;
}

export function focusedConversation(): string | null {
  return focused;
}

// --- the call probe ----------------------------------------------------------

let inCallProbe: () => boolean = () => false;

/**
 * Inject "is a call up" from the call module, which may not be imported here
 * (messaging.ts imports this file, and messaging stays free of call symbols
 * by doctrine — the CallService is its subscriber, never its import).
 * Unwired, the answer is "no" and the native gate alone decides: on iOS
 * that is `CXCallObserver`, which sees every CallKit-reported call
 * (Tacendum's, ringing or answered, and cellular); on Android it is the
 * audio mode, which sees only an ANSWERED Telecom call. The call module's
 * one wiring line (`setInCallProbe(() => <1:1 or group call not idle>)`
 * inside `startCalling`) closes the Android pre-answer gap and is the call
 * lane's to land; nothing here assumes it has.
 */
export function setInCallProbe(probe: () => boolean): void {
  inCallProbe = probe;
}

// --- the transport clock -----------------------------------------------------

let transportOpenedAt = 0;

/** Called by messaging on every socket open, so the drain that follows is
 * read as backlog rather than news. */
export function noteTransportOpen(now = Date.now()): void {
  transportOpenedAt = now;
}

// --- the decision ------------------------------------------------------------

export type ChimeVerdict =
  | 'chime'
  | 'off'
  | 'duress'
  | 'not_active'
  | 'spooled'
  | 'reconnect_backlog'
  | 'focused'
  | 'in_call'
  | 'burst'
  | 'failed';

export interface ChimeFacts {
  enabled: boolean;
  mode: SessionMode;
  appState: AppStateStatus | undefined;
  spooled: boolean;
  focused: boolean;
  inCall: boolean;
  /** ms since the socket last opened. */
  sinceOpenMs: number;
  /** ms since the last chime this process played. */
  sinceLastChimeMs: number;
}

/**
 * The pure rule, in the order the class comment states it. The app-state
 * axis is written as background.ts writes its own — 'background' and
 * 'inactive' are away, ANYTHING else (including the `undefined` of a test
 * environment with no AppState) is here — so the two predicates are exact
 * complements by construction and no arrival is ever both announced and
 * chimed. 'inactive' counts as away on purpose: it is the state under a
 * notification pull-down or the app switcher, where the banner is the
 * honest announcement and a chime under it would double it.
 */
export function chimeVerdict(f: ChimeFacts): ChimeVerdict {
  if (!f.enabled) return 'off';
  if (f.mode !== 'real') return 'duress';
  if (f.appState === 'background' || f.appState === 'inactive') return 'not_active';
  if (f.spooled) return 'spooled';
  if (f.sinceOpenMs < CHIME_QUIET_AFTER_OPEN_MS) return 'reconnect_backlog';
  if (f.focused) return 'focused';
  if (f.inCall) return 'in_call';
  if (f.sinceLastChimeMs < CHIME_BURST_MS) return 'burst';
  return 'chime';
}

let lastChimeAt = 0;

// Resolved through the namespace and tolerated when absent — ringback.ts's
// precedent: a suite whose tacendum-audio mock predates this method must get
// a silent no-op, not a crash. The app's real module always has it.
const { playMessageTone } = audio as Partial<typeof audio>;

/**
 * Chime for one delivered message, if every gate agrees.
 *
 * Called with `void` from the single content switch in messaging.ts, after
 * the row is durably stored and acked — beside `announceIncoming`, under its
 * contract: never throws, never rejects, never fails a delivery. Returns the
 * verdict so a test can say WHY it stayed quiet.
 */
export async function chimeForArrival(entry: {
  convId: string;
  spooled: boolean;
}): Promise<ChimeVerdict> {
  try {
    if (loading) await loading;
    let inCall = false;
    try {
      inCall = inCallProbe();
    } catch {
      inCall = false;
    }
    const now = Date.now();
    const verdict = chimeVerdict({
      enabled: messageSoundEnabled(),
      mode: session.mode,
      appState: AppState.currentState,
      spooled: entry.spooled,
      focused: focused === entry.convId,
      inCall,
      sinceOpenMs: now - transportOpenedAt,
      sinceLastChimeMs: now - lastChimeAt,
    });
    if (verdict !== 'chime') return verdict;
    lastChimeAt = now;
    await playMessageTone?.();
    return 'chime';
  } catch {
    return 'failed';
  }
}

/** Test seam: back to a launched process's state. */
export function resetMessageSoundForTests(): void {
  enabled = true;
  duressChoice = true;
  loading = null;
  focused = null;
  inCallProbe = () => false;
  transportOpenedAt = 0;
  lastChimeAt = 0;
}
