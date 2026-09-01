import { AppState } from 'react-native';
import * as native from 'tacendum-screen-security';
import { getSecret, setSecret } from 'tacendum-crypto';
import { session } from './session';

/**
 * Screen-security policy, one place (module singleton, same shape as
 * `messaging`): the capture state, the blank setting, and the screenshot
 * fan-out live here; the native module only observes. What iOS supports —
 * and what it doesn't (screenshots cannot be blocked, only disclosed) — is
 * documented on the native spec.
 *
 * Blanking is the person's own protection and is toggleable in Settings.
 * Screenshot *disclosure* is deliberately not routed through any setting —
 * see messaging.sendScreenshotNotice.
 */

const BLANK_KEY = 'screensec.blank';

export class ScreenSecurityService {
  /** Live UIScreen capture state (recording / AirPlay / mirroring). */
  captured = false;
  /** Setting: hide conversations while the screen is captured. Default on. */
  blankEnabled = true;

  private started = false;
  /** Count of native change events heard — the freshness guard the seed
   * and the cold-start re-ask share (an event is always fresher than a
   * read that started before it). */
  private captureEvents = 0;
  private listeners = new Set<() => void>();
  private screenshotListeners = new Set<() => void>();

  /** True when the UI must replace content with the capture cover. */
  get shouldBlank(): boolean {
    return this.captured && this.blankEnabled;
  }

  /** Load the setting, attach native listeners, seed capture state. Every
   * step is independently fault-tolerant: one failed Keychain read must not
   * disarm capture blanking or screenshot disclosure for the whole process. */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Listeners attach first, synchronously, before anything can await or
    // throw — so no event can fall through and no failure can orphan them.
    native.onCapturedChanged(captured => {
      this.captureEvents += 1;
      this.captured = captured;
      this.notify();
    });
    native.onScreenshot(() => {
      for (const cb of [...this.screenshotListeners]) cb();
    });
    native.start();

    // The seed below can run before any window scene exists (a VoIP wake
    // cold-starts the process UI-less; native answers that beat from its
    // no-scene fallback), and a capture that is ALREADY running fires no
    // change event — it simply continues. Re-ask ONCE on the first
    // 'active' transition, the moment a UI exists and the scenes answer is
    // authoritative. One re-ask, not a poll: the native scene-connect
    // recompute is the other half of this convergence, and every later
    // beat belongs to the change events.
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      sub.remove();
      void this.refreshCaptured();
    });

    await this.reloadSetting();

    // Seed the initial state — unless a live event already beat the read.
    await this.refreshCaptured();
    this.notify();
  }

  /** Ask native for the live capture state and apply it through the same
   * boolean the change events update — unless an event lands mid-ask,
   * which is fresher and wins. A failed read keeps the event-driven value;
   * the next change event corrects it. */
  private async refreshCaptured(): Promise<void> {
    const eventsBefore = this.captureEvents;
    try {
      const captured = await native.getIsCaptured();
      if (this.captureEvents === eventsBefore) {
        this.captured = captured;
        this.notify();
      }
    } catch {
      // Stay with the event-driven value; the next change event corrects it.
    }
  }

  /** Re-read the persisted setting — called at init and on every REAL unlock,
   * so an in-memory duress-session flip can never bleed into a real session.
   * A failed read fails closed (blanking on). */
  async reloadSetting(): Promise<void> {
    try {
      this.blankEnabled = (await getSecret(BLANK_KEY)) !== '0';
    } catch {
      this.blankEnabled = true;
    }
    this.notify();
  }

  /** Entering a duress session shows the DEFAULT, not the owner's persisted
   * choice — the real preference is real state and stays sealed. */
  resetForDuress(): void {
    this.blankEnabled = true;
    this.notify();
  }

  async setBlankEnabled(enabled: boolean): Promise<void> {
    this.blankEnabled = enabled;
    this.notify();
    // Same family as lock.ts rule 15: a duress session never writes real
    // Keychain state — the change holds for this session only.
    if (session.mode !== 'duress') {
      await setSecret(BLANK_KEY, enabled ? '1' : '0');
    }
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Hear about screenshots (fires after the fact — iOS cannot pre-empt). */
  onScreenshot(cb: () => void): () => void {
    this.screenshotListeners.add(cb);
    return () => {
      this.screenshotListeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

export const screenSecurity = new ScreenSecurityService();
