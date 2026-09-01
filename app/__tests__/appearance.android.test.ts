/**
 * The Android appearance branch: RN
 * `Settings` is iOS-only — its Android fallback warn-and-returns-null reset
 * the theme to light on every launch — so the choice persists through the
 * SharedPreferences-backed native accessor (`TacendumAppearance`). The read
 * is async: the module boots on the default and re-announces the stored
 * choice to subscribers when hydration lands; a choice made in this session
 * always beats a hydration that arrives late.
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

function accessorWith(stored: Promise<string>): AccessorMock {
  return {
    getAppearance: jest.fn(() => stored),
    setAppearance: jest.fn(async () => undefined),
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

test('a stored choice applies even when hydration lands before anyone subscribes', async () => {
  // The ordering App actually boots with: useState snapshots the choice
  // first, and only a passive effect subscribes — hydration resolving in
  // that gap used to update module state with NO listener, leaving the app
  // light for the whole session despite a stored dark. Snapshot replay on
  // subscribe closes the gap: the late subscriber immediately hears the
  // hydrated state.
  const accessor = accessorWith(Promise.resolve('dark'));
  const { appearance } = loadAppearance(accessor);

  expect(appearance.appearanceChoice()).toBe('light'); // the boot snapshot
  await flush(); // hydration lands while nobody is subscribed

  const seen: string[] = [];
  const unsubscribe = appearance.subscribeAppearance(next => seen.push(next));
  expect(seen).toEqual(['dark']); // replayed synchronously on subscribe
  expect(appearance.appearanceChoice()).toBe('dark');
  unsubscribe();
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
