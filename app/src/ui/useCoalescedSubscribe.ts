import { useEffect } from 'react';
import { messaging } from '../messaging';

/**
 * The notify-requery coalescing window every list and profile screen shares.
 * The chat list had it first and recorded why:
 * `messaging.notify()` fires on every receipt, inbound frame, socket
 * transition and attachment tick, and a screen subscribed raw re-read the
 * database — several queries, one native safety-number call per listed
 * device — PER notify while a backlog drained. The room profile, the peer
 * profile and the room composer were all subscribed raw.
 *
 * ONE window per burst, the same 80 ms the thread and the app's
 * ProfileWatcher hold: a window rather than a resetting debounce, so a
 * continuous drain still refreshes instead of starving. `refresh` runs once
 * on mount (and whenever its identity changes) — the posture every caller
 * already had — and the pending window is dropped with the subscription.
 *
 * A screen's OWN mutations keep calling `refresh()` directly; only the
 * notify path is delayed. */
export const COALESCE_WINDOW_MS = 80;

export function useCoalescedSubscribe(
  refresh: () => void,
  windowMs: number = COALESCE_WINDOW_MS,
): void {
  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = messaging.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, windowMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [refresh, windowMs]);
}
