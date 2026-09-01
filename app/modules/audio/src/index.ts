import NativeTacendumAudio, {
  type RecordingResult,
} from './NativeTacendumAudio';

export type { RecordingResult };

/** Begin recording; auto-stops at the cap. Rejects 'call_active'/'denied'. */
export function startRecording(maxSeconds: number): Promise<void> {
  return NativeTacendumAudio.startRecording(maxSeconds);
}

/** Stop and take the bytes plus the DECODED duration. */
export function stopRecording(): Promise<RecordingResult> {
  return NativeTacendumAudio.stopRecording();
}

/** Stop and delete — the bytes never reach JS. */
export function cancelRecording(): Promise<void> {
  return NativeTacendumAudio.cancelRecording();
}

/** Play decrypted bytes from memory; resolves the DECODED duration. */
export function startPlayback(dataB64: string): Promise<number> {
  return NativeTacendumAudio.startPlayback(dataB64);
}

export function stopPlayback(): Promise<void> {
  return NativeTacendumAudio.stopPlayback();
}

/** The outgoing-call ringback loop. Rejects 'no_call' outside a call. */
export function startRingback(): Promise<void> {
  return NativeTacendumAudio.startRingback();
}

/** Stop the ringback loop. Safe when idle. */
export function stopRingback(): Promise<void> {
  return NativeTacendumAudio.stopRingback();
}

/** The message-arrival chime, once. Resolves quietly during a call. */
export function playMessageTone(): Promise<void> {
  return NativeTacendumAudio.playMessageTone();
}

/** Launch sweep for recordings a kill left behind. */
export function sweepTemp(): Promise<void> {
  return NativeTacendumAudio.sweepTemp();
}

export const onLevel = NativeTacendumAudio.onLevel;
export const onRecordingFinished = NativeTacendumAudio.onRecordingFinished;
export const onPlaybackFinished = NativeTacendumAudio.onPlaybackFinished;
export const onPlaybackProgress = NativeTacendumAudio.onPlaybackProgress;
