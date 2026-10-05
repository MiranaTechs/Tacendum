import { NativeModules, Platform, Settings } from 'react-native';

/**
 * The appearance choice: light (the default the app has always had), dark
 * (charcoal), or system (follow the phone).
 *
 * Stored OUTSIDE the workspace database for two reasons: it must be
 * readable before unlock so the lock screen renders in the chosen mode, and
 * it must be identical in the real and duress workspaces, because a theme
 * that changed with the code entered would fingerprint the decoy.
 *
 * iOS: NSUserDefaults via RN `Settings`. The key was recorded here as
 * "shared verbatim with ScreenSecurityImpl.swift" and it is not: no Swift
 * file in this repository reads it, and the app-switcher cover paints the
 * LIGHT paperGround from a literal (ScreenSecurityImpl.swift:158). A cover
 * that follows the choice is owed; the record is corrected here rather than
 * left standing.
 *
 * ANDROID: RN `Settings` is iOS-only — its Android fallback
 * warn-and-returns-null, which silently reset the theme to light every
 * launch — so the choice persists through the SharedPreferences-backed
 * native accessor (`TacendumAppearance`, AppearancePrefsModule.kt). The
 * accessor answers twice. Its `getConstants()` value rides on the module
 * object before the bundle runs, so `read()` below is SYNCHRONOUS on
 * Android too and the first frame is already in the chosen palette — the
 * async read alone meant a person who chose dark watched a light frame on
 * every cold launch. The async `getAppearance()` stays as the fallback for
 * a build where the constant is absent or unreadable: the module boots on
 * the default and re-announces the stored choice to subscribers the moment
 * hydration lands (App re-renders through `subscribeAppearance`, ahead of
 * anything meaningful painting); a subscriber that arrives AFTER hydration
 * is replayed the current state on subscribe, so no ordering can lose the
 * stored choice; and a choice made in this session always beats a
 * hydration that arrives late.
 */
export type AppearanceChoice = 'light' | 'dark' | 'system';

/** One key, shared verbatim with ScreenSecurityImpl.swift (iOS) and
 * AppearancePrefsModule.kt (Android). */
const KEY = 'tacendum.appearance';

/** The Android accessor's surface (Android only; null elsewhere or when the
 * native module is absent — jest, or a build without the package). */
type AndroidAppearanceStore = {
  getAppearance(): Promise<string>;
  setAppearance(value: string): Promise<void>;
  /** The `getConstants()` value: the stored choice, already on the module
   * object at require time, or '' when none was ever stored. OPTIONAL —
   * a build predating the constant simply does not carry it, and the
   * async read below still answers. */
  readonly initialAppearance?: string;
};

const androidStore: AndroidAppearanceStore | null =
  Platform.OS === 'android'
    ? (((NativeModules as Record<string, unknown>).TacendumAppearance as
        | AndroidAppearanceStore
        | undefined) ?? null)
    : null;

const listeners = new Set<(next: AppearanceChoice) => void>();

function isChoice(value: unknown): value is AppearanceChoice {
  return value === 'dark' || value === 'system' || value === 'light';
}

function read(): AppearanceChoice {
  if (Platform.OS === 'android') {
    // The accessor's getConstants() value, read once at module init. It is
    // a SharedPreferences getString taken on the JS thread, which is why
    // the native side keeps it to exactly one key and no parsing. Absent
    // or unrecognized ('' means never stored): the default stands and
    // hydrate() below answers, asynchronously, as it always did.
    const initial = androidStore?.initialAppearance;
    return isChoice(initial) ? initial : 'light';
  }
  try {
    const stored = Settings.get(KEY) as unknown;
    if (isChoice(stored)) {
      return stored;
    }
  } catch {
    // Jest's react-native mock has no UserDefaults behind Settings.
  }
  return 'light';
}

let current: AppearanceChoice = read();
/** True once a caller chose in THIS session — hydration must not clobber a
 * choice the person just made. */
let chosenThisSession = false;

function hydrate(): void {
  if (!androidStore) return;
  void androidStore
    .getAppearance()
    .then(stored => {
      if (chosenThisSession) return;
      if (!isChoice(stored)) {
        return; // never stored (or unrecognized): the default stands
      }
      if (stored === current) return;
      current = stored;
      listeners.forEach(listener => listener(stored));
    })
    .catch(() => undefined); // best-effort: the default stands
}
hydrate();

export function appearanceChoice(): AppearanceChoice {
  return current;
}

export function setAppearanceChoice(next: AppearanceChoice): void {
  chosenThisSession = true;
  if (androidStore) {
    // Persist even a re-pick of the current value: hydration may still be
    // in flight, and the store must end up saying what the person said.
    void androidStore.setAppearance(next).catch(() => undefined);
  }
  if (next === current) return;
  current = next;
  if (!androidStore && Platform.OS !== 'android') {
    try {
      Settings.set({ [KEY]: next });
    } catch {
      // Persistence is best-effort; the in-memory value still drives this run.
    }
  }
  listeners.forEach(listener => listener(next));
}

/**
 * Notifies on every change; returns the unsubscribe. The listener is ALSO
 * called synchronously with the CURRENT choice on subscribe — snapshot
 * replay. Android's hydration is async, and App's boot order is "snapshot
 * the choice, render, then subscribe from a passive effect": a hydration
 * that resolved in that gap updated module state with no listener, and the
 * app stayed light for the whole session despite a stored dark. Replay
 * closes the gap for every such ordering; subscribers use it to setState,
 * where an unchanged value is a no-op.
 */
export function subscribeAppearance(
  listener: (next: AppearanceChoice) => void,
): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
