import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * TurboModule spec for voice notes (codegen input).
 *
 * Two jobs JS cannot do, and the properties that make them safe:
 *
 *  - RECORDING writes to a protected temp file because `AVAudioRecorder`
 *    requires a filesystem URL — there is no buffer API. That plaintext is
 *    the one durable copy outside SQLite, so its lifetime is the module's
 *    central responsibility: deleted on stop, on cancel, on failure, and
 *    swept at launch for anything a kill left behind.
 *  - PLAYBACK is memory-only. `AVAudioPlayer(data:)` plays the decrypted
 *    bytes with no file ever written, which is why a received voice note
 *    never touches the disk in the clear.
 *
 * The audio session is shared with CallKit, so every voice-note entry point
 * refuses while a call is up rather than fighting `tacendum-call` for the
 * session. The RINGBACK pair below is the deliberate inverse: it exists only
 * DURING a call, and it never configures the session — it mixes into the one
 * CallKit activated, which is what makes it behave like a call tone (the
 * call's route, the in-call volume, audible through the silent switch).
 */

export interface RecordingResult {
  /** The recorded audio, base64. AAC-LC in an MPEG-4 container. */
  dataB64: string;
  /** Decoded duration in whole seconds — the truth, not a claim. */
  durationSec: number;
}

export interface Spec extends TurboModule {
  /**
   * Begin recording. Rejects 'call_active' when a call is up, 'denied' when
   * microphone permission is refused, 'busy' when already recording.
   * Auto-stops at `maxSeconds`, emitting `onRecordingFinished`.
   */
  startRecording(maxSeconds: number): Promise<void>;

  /** Stop and return the bytes. Rejects 'not_recording' when idle. */
  stopRecording(): Promise<RecordingResult>;

  /** Stop and DELETE — the bytes never reach JS. Safe to call when idle. */
  cancelRecording(): Promise<void>;

  /**
   * Play decrypted bytes from memory. Any previous playback stops first —
   * one player at a time, so two voice notes can never overlap.
   *
   * Resolves with the DECODED duration in seconds, which is the only
   * trustworthy length: the envelope's `dur` is a sender claim. Rejects
   * 'call_active', 'bad_data', and 'too_long' for audio past the cap —
   * enforced on the decoder's answer, not on the claim.
   */
  startPlayback(dataB64: string): Promise<number>;

  /** Stop playback and release the retained bytes. Safe when idle. */
  stopPlayback(): Promise<void>;

  /**
   * Begin the outgoing-call ringback loop — the tone the CALLER hears while
   * the far phone rings. Synthesized natively (no bundled asset); loops
   * until stopped. Rejects 'no_call' when no call exists to carry it;
   * resolves quietly when the loop is already playing.
   */
  startRingback(): Promise<void>;

  /** Stop the ringback loop and release it. Safe when idle. */
  stopRingback(): Promise<void>;

  /**
   * Play the message-arrival tone ONCE — the short chime for a text that
   * lands while the app is open. Synthesized
   * natively like the ringback (no bundled asset) and played as a SYSTEM
   * sound: it never configures the audio session, it obeys the ring/silent
   * switch and the ringer volume, and it mixes over whatever else is
   * playing, exactly as every messenger's chime does.
   *
   * NEVER REJECTS. It is fired from the receive path with `void`, and a
   * delivery must not fail over a sound: a call up (native sees Tacendum's
   * and cellular calls alike — the same observer the voice-note gate
   * uses), a tone file that would not write, a player that refused — every
   * one resolves quietly. JS decides WHEN (app/src/messageSound.ts); this
   * end enforces only what native can see.
   */
  playMessageTone(): Promise<void>;

  /**
   * Delete every recording temp file. Called at launch: dismissal cleanup
   * cannot run if the process was killed mid-recording.
   */
  sweepTemp(): Promise<void>;

  /** Metering, 0..1, for the recording level indicator. */
  readonly onLevel: EventEmitter<number>;

  /** Fired when the cap auto-stops a recording, or an interruption ends it. */
  readonly onRecordingFinished: EventEmitter<RecordingResult>;

  /** Fired when playback reaches the end, so the UI can reset its control. */
  readonly onPlaybackFinished: EventEmitter<void>;

  /**
   * The play head in seconds, four times a second, while a note is actually
   * playing. Native rather than a JS timer because a timer keeps counting
   * when the audio has stopped — an interruption, a call, a route change —
   * and a progress bar advancing over silence is a lie.
   */
  readonly onPlaybackProgress: EventEmitter<number>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('TacendumAudio');
