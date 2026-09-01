/**
 * Who is allowed to make this phone ring.
 *
 * Pure decisions, separated from the controller that enforces them, so the
 * rules can be read and tested without a database, a socket, or a reducer.
 * The controller supplies the facts; this decides what they mean.
 */

export interface RingDecision {
  ring: boolean;
  /** Why not, when not. Becomes the call-log row's reason. */
  reason?: 'unknown_caller';
}

export interface RingInputs {
  /** The setting. Default ON — see below. */
  silenceUnknownCallers: boolean;
  /** True when this peer has ever exchanged a message with us. */
  hasHistory: boolean;
  /** True when the peer is blocked. Blocked always wins, setting or not. */
  blocked: boolean;
}

/**
 * **Silence unknown callers defaults to ON**, which is a deliberate departure
 * from how phones normally behave.
 *
 * A ringing phone is an interrupt anyone who knows your identifier can trigger,
 * at any hour, as often as they like. On a network where identifiers are handed
 * out by QR code that is a small risk; it stops being small the moment a
 * directory or an invite link leaks. Someone with no message history has no
 * established reason to interrupt you, and the cost of being wrong is
 * asymmetric: a silenced first call leaves a missed-call row they can see and
 * answer, while an unsilenced one is a phone ringing at 3am.
 *
 * A blocked peer never rings regardless — that is not a preference.
 */
export function decideRing(inputs: RingInputs): RingDecision {
  if (inputs.blocked) return { ring: false, reason: 'unknown_caller' };
  if (!inputs.silenceUnknownCallers) return { ring: true };
  if (inputs.hasHistory) return { ring: true };
  return { ring: false, reason: 'unknown_caller' };
}

/**
 * Always-relay, per peer.
 *
 * **Defaults ON for a peer's FIRST call**, then follows whatever was chosen
 * afterwards. The first call is the one where the two sides have never
 * exchanged media, so it is the one where a direct connection would reveal a
 * home IP address to someone who has never had it. Paying a relay hop once, on
 * the call where the disclosure would be new information, is a better default
 * than optimising latency for a stranger.
 *
 * `global` is the app-wide switch; when a person turns it on, it wins
 * everywhere and no per-peer memory can weaken it.
 */
export function relayForPeer(inputs: {
  global: boolean;
  remembered: boolean | null;
  hasCalledBefore: boolean;
}): boolean {
  if (inputs.global) return true;
  if (inputs.remembered !== null) return inputs.remembered;
  return !inputs.hasCalledBefore;
}

// --- the design thermal, battery and low power -------------------------------------

/** What the device is telling us about its own headroom. */
export interface PressureInputs {
  /** `ProcessInfo.thermalState`, verbatim. */
  thermal: 'nominal' | 'fair' | 'serious' | 'critical';
  /** `ProcessInfo.isLowPowerModeEnabled`. */
  lowPower: boolean;
  /** 0–1, or null when the device will not say (a Simulator, mainly). */
  battery: number | null;
  /** Whether the call is carrying video at all. Everything below is moot for
   * a voice call, and telling someone their voice call is "reduced quality"
   * because the phone is warm would be alarming and useless. */
  video: boolean;
  /** The person tapped the in-call notice to lift the Low Power cap. A fact
   * about THIS call, not the device — the caller resets it when the next call
   * starts, so a phone still in Low Power Mode starts capped again. */
  restored?: boolean;
}

export interface PressureDecision {
  /**
   * Longest edge to encode at, or null for no cap.
   *
   * A cap, not a resolution: the encoder still adapts downward on its own when
   * the network is poor. This only stops it adapting back UP into heat.
   */
  maxLongEdge: number | null;
  maxFps: number | null;
  /** False means stop sending video entirely and tell the peer. */
  videoAllowed: boolean;
  /** Shown in-call. null shows nothing — the ordinary case. */
  notice: string | null;
  /**
   * True when the person should be OFFERED a switch to voice, never moved to
   * it. Dropping someone out of a video call to save battery is a decision
   * about their conversation, and it is not ours to make.
   */
  offerVoice: boolean;
  /**
   * True when tapping the notice would lift the cap — Low Power Mode only.
   * A tap cannot cool a phone down, so a thermal cap never offers one: that
   * would be a button that does nothing.
   */
  restorable: boolean;
}

/** Below this the phone is close enough to dying that a video call is worth
 * mentioning. Apple surfaces its own warning at 20%; 10% is late enough not
 * to duplicate that for a call that may last two minutes. */
const LOW_BATTERY = 0.1;

/**
 * What to do about a hot or tired phone.
 *
 * Pure, because every branch is otherwise reachable only by heating a real
 * device — the reason the table in the design had gone unimplemented.
 *
 * **Nothing here restores quality on its own.** Under low power the cap stays
 * until the user taps — `restored` is that tap arriving back here, and it
 * lifts ONLY the Low Power cap: a device in Low Power Mode is one the owner
 * put there, so the owner tapping through the notice is the same authority
 * revoking the request for this call. Thermal caps lift when the state falls
 * back, because the phone cooling down is a fact about the world rather than
 * a preference — and they hold through a tap for the same reason.
 */
export function decidePressure(inputs: PressureInputs): PressureDecision {
  const none: PressureDecision = {
    maxLongEdge: null,
    maxFps: null,
    videoAllowed: true,
    notice: null,
    offerVoice: false,
    restorable: false,
  };
  if (!inputs.video) return none;

  const offerVoice = inputs.battery !== null && inputs.battery < LOW_BATTERY;

  // Critical first: it outranks everything, including a user who has tapped
  // to restore quality under low power. At `.critical` iOS is already
  // throttling the CPU and the next step is a thermal shutdown.
  if (inputs.thermal === 'critical') {
    return {
      maxLongEdge: 640,
      maxFps: 24,
      videoAllowed: false,
      notice: 'Video paused to cool down',
      offerVoice,
      restorable: false,
    };
  }

  if (inputs.thermal === 'serious') {
    return {
      maxLongEdge: 640,
      maxFps: 24,
      videoAllowed: true,
      notice: 'Reduced quality',
      offerVoice,
      restorable: false,
    };
  }

  if (inputs.lowPower && !inputs.restored) {
    return {
      maxLongEdge: 640,
      maxFps: 24,
      videoAllowed: true,
      // Named for the cause, because the fix is in the user's hands: someone
      // who sees "Low Power Mode" knows what to turn off, where "Reduced
      // quality" reads as the app being bad at its job.
      notice: 'Low Power Mode',
      offerVoice,
      restorable: true,
    };
  }

  return { ...none, offerVoice };
}
