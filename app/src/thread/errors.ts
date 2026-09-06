// Map send failures to fixed user-facing copy. Raw exception text is never
// returned; error classes and native codes choose the sentence, with message
// inspection only for legacy send-path refusals. The copy deck is passed in
// so platform wording stays in the screen without a reverse import.
import { PickDenied, PickUnavailable } from '../media';

/** What a failed send puts on the screen. */
export interface SendError {
  message: string;
  /** True when the sentence names Settings, so an action can be offered. */
  settings: boolean;
  /** Bumped per failure so an identical repeat is announced again. */
  seq: number;
}

/**
 * The deck keys a send failure can reach for. A structural type, not the
 * screen's own object: this module must not import the deck, and the screen
 * must not be able to drop a key the classifier still names.
 */
export interface SendErrorCopy {
  cameraDenied: string;
  libraryDenied: string;
  cameraUnavailable: string;
  safetyBlocked: string;
  noAccount: string;
  fileTooLarge: string;
  photoTooLarge: string;
  tooLong: string;
  micDenied: string;
  micBusyCall: string;
  locationDenied: string;
  photoUnreadable: string;
  photoFailed: string;
  fileFailed: string;
  voiceFailed: string;
  locationFailed: string;
  reactionFailed: string;
  editFailed: string;
  deleteFailed: string;
  sendFailed: string;
}

/** Map a thrown error onto fixed copy; never surface the original text. */
export function sendErrorFor(
  err: unknown,
  kind:
    | 'text'
    | 'photo'
    | 'file'
    | 'voice'
    | 'location'
    | 'reaction'
    | 'edit'
    | 'delete',
  /** The thread's COPY deck, handed in rather than imported: it stays
   * in ChatThreadScreen.tsx to keep platform-specific DEVICE_NOUN wording
   * together with the rest of the screen's copy. */
  copy: SendErrorCopy,
): Omit<SendError, 'seq'> {
  // Classes before strings: a first-ever permission denial used to be reported
  // as a connection problem, which sends the person nowhere they can fix it.
  if (err instanceof PickDenied) {
    return {
      message: err.source === 'camera' ? copy.cameraDenied : copy.libraryDenied,
      settings: true,
    };
  }
  if (err instanceof PickUnavailable) {
    return { message: copy.cameraUnavailable, settings: false };
  }
  const raw = err instanceof Error ? err.message : '';
  // Native rejections carry the reason in `code` — a TurboModule reject()
  // puts the human sentence in `message`, so matching only on message read
  // "file is 8388608 bytes" as an unclassified failure and showed the
  // generic connection error for a size problem the person can act on.
  const code =
    typeof (err as { code?: unknown })?.code === 'string'
      ? (err as { code: string }).code
      : '';
  const plain = (message: string) => ({ message, settings: false });
  if (raw.includes('safety number changed')) return plain(copy.safetyBlocked);
  if (raw.includes('no account for this id')) return plain(copy.noAccount);
  if (code === 'too_large' || raw.includes('too large to send')) {
    if (kind === 'file') return plain(copy.fileTooLarge);
    return plain(kind === 'photo' ? copy.photoTooLarge : copy.tooLong);
  }
  if (code === 'denied' && kind === 'voice') {
    return { message: copy.micDenied, settings: true };
  }
  if (code === 'call_active') return plain(copy.micBusyCall);
  if (code === 'denied' && kind === 'location') {
    return { message: copy.locationDenied, settings: true };
  }
  if (raw.includes('photo unreadable')) return plain(copy.photoUnreadable);
  if (kind === 'photo') return plain(copy.photoFailed);
  if (kind === 'file') return plain(copy.fileFailed);
  if (kind === 'voice') return plain(copy.voiceFailed);
  if (kind === 'location') return plain(copy.locationFailed);
  if (kind === 'reaction') return plain(copy.reactionFailed);
  if (kind === 'edit') return plain(copy.editFailed);
  if (kind === 'delete') return plain(copy.deleteFailed);
  return plain(copy.sendFailed);
}
