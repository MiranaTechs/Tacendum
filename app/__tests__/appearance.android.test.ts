/**
 * The Android appearance branch: RN
 * `Settings` is iOS-only — its Android fallback warn-and-returns-null reset
 * the theme to light on every launch — so the choice persists through the
 * SharedPreferences-backed native accessor (`TacendumAppearance`).
 *
 * The accessor answers TWICE. `getConstants()` puts the stored choice on the
 * module object before the bundle runs, so the branch boots straight into the
 * chosen palette — the thing that stops a dark-mode launch flashing light.
 * `getAppearance()` stays as the async fallback for any build where the
 * constant is absent or unreadable: the module boots on the default and
 * re-announces the stored choice to subscribers when hydration lands. A
 * choice made in THIS session beats a hydration that arrives late, either
 * way.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
    Version: 35,
    isTesting: true,
  },
}));

// The real RN Settings module throws at require in jest (its TurboModule is
// absent). Mock it observable, so "never touches Settings" is an assertion
// rather than an accident of not crashing.
jest.mock('react-native/Libraries/Settings/Settings', () => ({
  __esModule: true,
  default: { get: jest.fn(() => null), set: jest.fn() },
}));

type AppearanceModule = typeof import('../src/appearance');

interface AccessorMock {
  getAppearance: jest.Mock;
  setAppearance: jest.Mock;
  /** The `getConstants()` value, present on any build that exposes it —
   * a plain property on the NativeModules object, exactly as
   * `TacendumMessaging`'s `pushTransport` constant arrives. */
  initialAppearance?: string;
}

/**
 * Fresh module instance per case (the module hydrates at import), with the
 * accessor installed BEFORE the import so the branch can see it — exactly
 * the load order on a device, where the native module precedes the bundle.
 */
function loadAppearance(
  accessor: AccessorMock | null,
): { appearance: AppearanceModule; settingsSet: jest.Mock } {
  jest.resetModules();
  const rn = require('react-native') as {
    NativeModules: Record<string, unknown>;
  };
  if (accessor) {
    rn.NativeModules.TacendumAppearance = accessor;
  } else {
    delete rn.NativeModules.TacendumAppearance;
  }
  // The fresh registry re-ran the Settings mock factory: fetch ITS fns.
  const settings = (
    jest.requireMock('react-native/Libraries/Settings/Settings') as {
      default: { set: jest.Mock };
    }
  ).default;
  return {
    appearance: require('../src/appearance') as AppearanceModule,
    settingsSet: settings.set,
  };
}

/** The accessor with NO constant: the async-only fallback path. */
function accessorWith(stored: Promise<string>): AccessorMock {
  return {
    getAppearance: jest.fn(() => stored),
    setAppearance: jest.fn(async () => undefined),
  };
}

/** The accessor a shipped build presents: the constant carries the stored
 * choice, and the async read agrees with it. */
function accessorBooting(stored: string): AccessorMock {
  return {
    getAppearance: jest.fn(async () => stored),
    setAppearance: jest.fn(async () => undefined),
    initialAppearance: stored,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('hydration applies the stored choice and notifies subscribers', async () => {
  const accessor = accessorWith(Promise.resolve('dark'));
  const { appearance } = loadAppearance(accessor);

  // Before hydration lands: the default — never a crash, never a null.
  expect(appearance.appearanceChoice()).toBe('light');

  const seen: string[] = [];
  const unsubscribe = appearance.subscribeAppearance(next => seen.push(next));
  await flush();

  expect(appearance.appearanceChoice()).toBe('dark');
  // Subscribe replays the pre-hydration state at once, then hydration lands.
  expect(seen).toEqual(['light', 'dark']);
  expect(accessor.getAppearance).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test('the boot snapshot IS the stored choice when the constant is there', async () => {
  // THE RE-CUT PIN (build 27). This line used to read `toBe('light')` and
  // called it "the boot snapshot" — which it was, whatever the person had
  // chosen, because the only Android read was async. That pin described a
  // defect rather than a decision: a person who chose dark got a light
  // first frame on every cold launch and on every unlock that restarts the
  // process. `getConstants()` now carries the stored choice onto the module
  // object before the bundle runs, so the first frame is already dark and
  // there is nothing left to heal. The pin moved because the behaviour it
  // pinned was the flash.
  const accessor = accessorBooting('dark');
  const { appearance } = loadAppearance(accessor);

  expect(appearance.appearanceChoice()).toBe('dark'); // the boot snapshot
  await flush(); // the async read agrees; nothing changes

  const seen: string[] = [];
  const unsubscribe = appearance.subscribeAppearance(next => seen.push(next));
  expect(seen).toEqual(['dark']); // one value — never a light-then-dark pair
  expect(appearance.appearanceChoice()).toBe('dark');
  unsubscribe();
});

test('without the constant, a hydration landing before anyone subscribes is replayed', async () => {
  // What the pin above used to prove, kept whole for the fallback path.
  // The ordering App actually boots with: useState snapshots the choice
  // first, and only a passive effect subscribes — hydration resolving in
  // that gap used to update module state with NO listener, leaving the app
  // light for the whole session despite a stored dark. Snapshot replay on
  // subscribe closes the gap: the late subscriber immediately hears the
  // hydrated state.
  const accessor = accessorWith(Promise.resolve('dark'));
  const { appearance } = loadAppearance(accessor);

  expect(appearance.appearanceChoice()).toBe('light'); // no constant to read
  await flush(); // hydration lands while nobody is subscribed

  const seen: string[] = [];
  const unsubscribe = appearance.subscribeAppearance(next => seen.push(next));
  expect(seen).toEqual(['dark']); // replayed synchronously on subscribe
  expect(appearance.appearanceChoice()).toBe('dark');
  unsubscribe();
});

test('an absent or unrecognized constant leaves the async read to answer', async () => {
  // '' is the accessor's "never stored"; 'blue' models a corrupt write.
  // Neither may boot the app into a palette nobody chose, and neither may
  // suppress the async path that can still answer.
  for (const constant of ['', 'blue']) {
    const accessor: AccessorMock = {
      ...accessorWith(Promise.resolve('dark')),
      initialAppearance: constant,
    };
    const { appearance } = loadAppearance(accessor);

    expect(appearance.appearanceChoice()).toBe('light');
    await flush();
    expect(appearance.appearanceChoice()).toBe('dark');
  }
});

test('a choice made this session still beats the constant it disagrees with', async () => {
  // The constant is yesterday's answer, read once at init. A person who
  // switches to light in Settings and never leaves the screen must not be
  // pulled back to the stored dark by anything.
  const accessor = accessorBooting('dark');
  const { appearance } = loadAppearance(accessor);
  expect(appearance.appearanceChoice()).toBe('dark');

  appearance.setAppearanceChoice('light');
  await flush(); // the async read still resolves 'dark' behind it

  expect(appearance.appearanceChoice()).toBe('light');
  expect(accessor.setAppearance).toHaveBeenCalledWith('light');
});

test('a choice made this session beats a hydration that arrives late', async () => {
  let resolveStored!: (value: string) => void;
  const accessor = accessorWith(
    new Promise<string>(resolve => {
      resolveStored = resolve;
    }),
  );
  const { appearance } = loadAppearance(accessor);

  appearance.setAppearanceChoice('system');
  expect(appearance.appearanceChoice()).toBe('system');

  resolveStored('dark'); // yesterday's stored value lands AFTER the choice
  await flush();

  expect(appearance.appearanceChoice()).toBe('system');
  // ...and the person's choice was persisted, so the store agrees by now.
  expect(accessor.setAppearance).toHaveBeenCalledWith('system');
});

test('persistence goes through the accessor, never RN Settings', async () => {
  const accessor = accessorWith(Promise.resolve(''));
  const { appearance, settingsSet } = loadAppearance(accessor);
  await flush();

  appearance.setAppearanceChoice('dark');

  expect(accessor.setAppearance).toHaveBeenCalledWith('dark');
  expect(settingsSet).not.toHaveBeenCalled();
  expect(appearance.appearanceChoice()).toBe('dark');
});

test('an unrecognized or absent stored value leaves the default standing', async () => {
  // '' is the accessor's "never stored"; 'blue' models a corrupt write.
  for (const stored of ['', 'blue']) {
    const accessor = accessorWith(Promise.resolve(stored));
    const { appearance } = loadAppearance(accessor);
    await flush();
    expect(appearance.appearanceChoice()).toBe('light');
  }
});

test('a missing accessor degrades to in-memory, never a crash', async () => {
  // jest and any build where the native module fails to link: the branch
  // must boot on the default and still honor in-session choices.
  const { appearance, settingsSet } = loadAppearance(null);
  await flush();

  expect(appearance.appearanceChoice()).toBe('light');
  appearance.setAppearanceChoice('dark');
  expect(appearance.appearanceChoice()).toBe('dark');
  // No accessor and not iOS: nothing is written anywhere.
  expect(settingsSet).not.toHaveBeenCalled();
});

/**
 * THE PRE-JS FRAME.
 *
 * Before the bundle runs there is no JS palette at all: the window is
 * whatever the Android theme says, and AppCompat's default is white. iOS
 * cold-launches into the light ground from the colour literal in
 * LaunchScreen.storyboard (no colour asset is involved); Android had no
 * `android:windowBackground` and no `values-night/` directory existed at
 * all, so a dark-mode launch went white → light → dark. The constant above
 * removes the second jump; these resources remove the first.
 *
 * Read from the shipped XML because a stylesheet is not reachable from jest
 * any other way, and compared against theme.ts so the two grounds cannot
 * drift apart in a palette pass.
 */
describe('the launch window is painted in the chosen ground', () => {
  const { readFileSync, existsSync } = require('fs') as {
    readFileSync: (path: string, encoding: string) => string;
    existsSync: (path: string) => boolean;
  };
  const { join } = require('path') as { join: (...parts: string[]) => string };
  // This file is a global SCRIPT, not a module — privacy.manifest.test.ts
  // declares `__dirname` in that same shared scope, so declaring it here
  // too is a redeclaration. android.foundation.test.ts's idiom instead:
  // ask jest where the test file is.
  const testPath = expect.getState().testPath ?? '';
  const APP_ROOT = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
  const RES = join(APP_ROOT, 'android', 'app', 'src', 'main', 'res');
  const windowBackgroundIn = (xml: string): string | null => {
    const m = xml.match(
      /<item\s+name="android:windowBackground"\s*>\s*([^<\s]+)\s*<\/item>/,
    );
    return m ? m[1]! : null;
  };

  it('the day theme paints the light paperGround before JS exists', () => {
    const { themeTokens } = require('../src/theme') as typeof import('../src/theme');
    const xml = readFileSync(join(RES, 'values', 'styles.xml'), 'utf8');
    expect(windowBackgroundIn(xml)).toBe(themeTokens('light').color.paperGround);
  });

  it('a night qualifier exists and paints the dark paperGround', () => {
    const nightStyles = join(RES, 'values-night', 'styles.xml');
    expect(existsSync(nightStyles)).toBe(true);
    const { themeTokens } = require('../src/theme') as typeof import('../src/theme');
    const xml = readFileSync(nightStyles, 'utf8');
    expect(windowBackgroundIn(xml)).toBe(themeTokens('dark').color.paperGround);
    // Same style name, or the DayNight parent resolves the day one anyway.
    expect(xml).toContain('name="AppTheme"');
  });

  it('the reader can actually fail (a missing or stale override is caught)', () => {
    // The AiDisclosure idiom: prove the comparison compares. The real
    // predicate, fed the shape it must reject.
    expect(
      windowBackgroundIn(
        '<resources><style name="AppTheme" parent="x"></style></resources>',
      ),
    ).toBeNull();
    expect(
      windowBackgroundIn(
        '<item name="android:windowBackground">#FFFFFF</item>',
      ),
    ).toBe('#FFFFFF');
  });
});
