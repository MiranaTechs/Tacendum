/**
 * Typing cadence — pure, clock-injected, one instance
 * per open thread.
 *
 * `start` on the first human keystroke, refreshed at most every
 * TYPING_REFRESH_MS while composing continues; `stop` when the draft
 * empties or a message is sent. A receiver expires the indicator at
 * TYPING_EXPIRY_MS on its own, so a lost stop (app killed mid-draft, frame
 * dropped by the pacer) needs no repair here — refresh < expiry is the
 * invariant that keeps a live typist continuously visible.
 */
export const TYPING_REFRESH_MS = 10_000;
export const TYPING_EXPIRY_MS = 15_000;

export interface TypingSignaler {
  /**
   * Call on every HUMAN draft change (ChatThreadScreen.changeDraft) with
   * whether the draft is now non-empty. Programmatic setDraft writes must
   * not come through here — they are not a person composing.
   */
  onDraftChange(nonEmpty: boolean): void;
  /** Call when a message is sent: the composing this signaler was
   * narrating is over, whatever the draft momentarily holds. */
  stop(): void;
}

export function createTypingSignaler(
  send: (state: 'start' | 'stop') => void,
  now: () => number = Date.now,
): TypingSignaler {
  let active = false;
  let lastStartAt = 0;

  function stop(): void {
    if (!active) return;
    active = false;
    send('stop');
  }

  function onDraftChange(nonEmpty: boolean): void {
    if (!nonEmpty) {
      stop();
      return;
    }
    const t = now();
    if (!active || t - lastStartAt >= TYPING_REFRESH_MS) {
      active = true;
      lastStartAt = t;
      send('start');
    }
  }

  return { onDraftChange, stop };
}
