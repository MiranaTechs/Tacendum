import { Clipboard } from 'react-native';

/**
 * Copying a credential, with an expiry.
 *
 * The vault design is blunt about this: the pasteboard is the one place this
 * app hands a value to software it does not control. Every app on the phone
 * can read it without asking, and with Universal Clipboard on, so can every
 * other device signed in to the same iCloud account. Copy is still offered —
 * a value you cannot paste is a value you will re-type in the chat, which is
 * worse — so the requirement is that it does not sit there forever.
 *
 * WHAT THIS IS NOT. iOS has a real expiry: `UIPasteboard.setItems(_:options:)`
 * with `.expirationDate`, enforced by the OS whether or not this process is
 * still alive. That is the right primitive and it is not reachable from here:
 * React Native's `Clipboard` has `setString` and nothing else, and adding it
 * would mean a new method on a TurboModule spec, regenerated codegen, and a
 * pod install — on a build another workstream is currently shipping to real
 * hardware. So this is a software expiry, and its limits are honest ones:
 *
 *  - it needs this process to still be running, so force-quitting the app
 *    before the timer fires leaves the value on the pasteboard;
 *  - it clears the pasteboard, it does not un-read it. Anything that already
 *    read the value keeps it.
 *
 * Both are stated rather than papered over, and the copy on screen promises
 * only what this actually does ("Tacendum clears the pasteboard in a minute").
 * If the native module ever opens up, `copyWithExpiry` is the one call site to
 * change.
 */

/**
 * Long enough to switch to another app and paste; short enough that a phone
 * handed over ten minutes later is not still holding a door code.
 */
export const PASTEBOARD_TTL_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * Which copy owns the pasteboard right now.
 *
 * The read-back below is asynchronous — `getString()` crosses the bridge — and
 * a copy made while it is in flight would otherwise be wiped by an answer that
 * was true a moment ago: the timer reads, the person copies something new, the
 * read resolves with the OLD string, and the clear fires on the NEW one. Every
 * copy and every cancel takes a fresh number, and a read that comes back
 * holding a stale one clears nothing.
 */
let generation = 0;

/**
 * Put a value on the pasteboard and take it back off after `PASTEBOARD_TTL_MS`.
 *
 * THE READ-BACK IS THE POINT, and it is the reason this is not three lines.
 * Clearing blindly on a timer destroys whatever the person copied in the
 * meantime — they copy the Wi-Fi password, switch to another app, copy an
 * address there, come back, and Tacendum silently wipes the address. So the
 * expiry only fires when the pasteboard still holds the exact value this
 * function put there. On iOS 16 and later, reading content another app wrote
 * can raise the system paste prompt; that happens only in the case where
 * clearing would have been wrong, and a refused read is treated as "not ours"
 * and clears nothing. Failing closed on somebody else's clipboard is the right
 * side to fail on.
 *
 * A second copy replaces the first one's expiry rather than stacking with it,
 * so two copies in a minute do not leave one timer clearing the other's value.
 */
export function copyWithExpiry(value: string): void {
  cancelPasteboardExpiry();
  const mine = ++generation;
  Clipboard.setString(value);
  timer = setTimeout(() => {
    timer = null;
    void Promise.resolve(Clipboard.getString())
      .then(current => {
        // A later copy (or a cancel) happened while the read was in flight, so
        // `current` describes a pasteboard this timer no longer owns.
        if (mine !== generation) return;
        if (current === value) Clipboard.setString('');
      })
      .catch(() => {
        // A read that failed or was refused tells us nothing about whose value
        // is on the pasteboard, so nothing is cleared.
      });
  }, PASTEBOARD_TTL_MS);
}

/**
 * Drop a pending expiry without touching the pasteboard.
 *
 * DELIBERATELY NOT CALLED ON UNMOUNT. The obvious place for this is a screen's
 * cleanup, and that would be exactly backwards: leaving the vault is the most
 * likely thing to happen right after a copy, and cancelling there would mean
 * the expiry never fires for the one case it was written for. The timer
 * outlives the screen on purpose. This exists so a second copy can replace the
 * first one's timer rather than stack with it, and so a test can leave no
 * pending work behind.
 */
export function cancelPasteboardExpiry(): void {
  // Bumped even when no timer is armed, because a timer that has already fired
  // can still have a read in flight, and this is what stops that read's answer
  // from clearing a pasteboard nobody asked it to touch.
  generation++;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
