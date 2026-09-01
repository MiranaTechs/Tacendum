/**
 * screenSecurity service: one place that knows the capture state, the blank
 * setting, and who wants to hear about screenshots. Policy lives here — the
 * native module only observes (it cannot prevent; see the module's spec).
 */

import { AppState } from 'react-native';

import { ScreenSecurityService } from '../src/screenSecurity';
import { session } from '../src/session';

const native = jest.requireMock('tacendum-screen-security') as {
  start: jest.Mock;
  getIsCaptured: jest.Mock;
  onCapturedChanged: jest.Mock;
  onScreenshot: jest.Mock;
  __screensec: {
    state: { captured: boolean; started: boolean };
    emitCaptured: (captured: boolean) => void;
    emitScreenshot: () => void;
    reset: () => void;
  };
};
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  setSecret: jest.Mock;
};

beforeEach(() => {
  native.__screensec.reset();
  native.start.mockClear();
  native.onCapturedChanged.mockClear();
  native.onScreenshot.mockClear();
  crypto.__keychain.clear();
  crypto.setSecret.mockClear();
  session.setMode('real');
});

afterEach(() => {
  session.setMode('real');
});

describe('init', () => {
  test('defaults to blanking on, seeds capture state, and starts the native observer', async () => {
    native.__screensec.state.captured = true;
    const svc = new ScreenSecurityService();
    await svc.init();
    expect(svc.blankEnabled).toBe(true);
    expect(svc.captured).toBe(true);
    expect(svc.shouldBlank).toBe(true);
    expect(native.start).toHaveBeenCalled();
  });

  test('attaches listeners before starting the native side, so no event can drop', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    const listenerOrder = native.onCapturedChanged.mock.invocationCallOrder[0];
    const startOrder = native.start.mock.invocationCallOrder[0];
    expect(listenerOrder).toBeLessThan(startOrder);
  });

  test('is idempotent — a second init never doubles the listeners', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    await svc.init();
    expect(native.onCapturedChanged).toHaveBeenCalledTimes(1);
    expect(native.onScreenshot).toHaveBeenCalledTimes(1);
  });

  test('loads a persisted off state', async () => {
    crypto.__keychain.set('screensec.blank', '0');
    const svc = new ScreenSecurityService();
    await svc.init();
    expect(svc.blankEnabled).toBe(false);
  });
});

describe('capture state', () => {
  test('capture events update state and wake subscribers', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    const woke = jest.fn();
    svc.subscribe(woke);
    native.__screensec.emitCaptured(true);
    expect(svc.captured).toBe(true);
    expect(svc.shouldBlank).toBe(true);
    expect(woke).toHaveBeenCalled();
    native.__screensec.emitCaptured(false);
    expect(svc.shouldBlank).toBe(false);
  });

  test('blanking disabled means captured never blanks', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    await svc.setBlankEnabled(false);
    native.__screensec.emitCaptured(true);
    expect(svc.captured).toBe(true);
    expect(svc.shouldBlank).toBe(false);
  });
});

describe('blank setting', () => {
  test('persists to the keychain', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    await svc.setBlankEnabled(false);
    expect(crypto.__keychain.get('screensec.blank')).toBe('0');
    await svc.setBlankEnabled(true);
    expect(crypto.__keychain.get('screensec.blank')).toBe('1');
  });

  test('a duress session changes the setting in memory only (rule 15 family)', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    session.setMode('duress');
    await svc.setBlankEnabled(false);
    expect(svc.blankEnabled).toBe(false);
    expect(crypto.__keychain.has('screensec.blank')).toBe(false);
  });
});

describe('session seams', () => {
  test('reloadSetting restores the persisted value after a duress flip', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    expect(svc.blankEnabled).toBe(true);
    session.setMode('duress');
    await svc.setBlankEnabled(false);
    expect(svc.blankEnabled).toBe(false);
    expect(crypto.__keychain.has('screensec.blank')).toBe(false);
    session.setMode('real');
    await svc.reloadSetting();
    expect(svc.blankEnabled).toBe(true);
  });

  test('resetForDuress presents the default, never the owner’s persisted choice', async () => {
    crypto.__keychain.set('screensec.blank', '0');
    const svc = new ScreenSecurityService();
    await svc.init();
    expect(svc.blankEnabled).toBe(false);
    svc.resetForDuress();
    expect(svc.blankEnabled).toBe(true);
    expect(crypto.__keychain.get('screensec.blank')).toBe('0');
  });

  test('a failed Keychain read fails closed and still arms the listeners', async () => {
    const cryptoMock = jest.requireMock('tacendum-crypto') as {
      getSecret: jest.Mock;
    };
    cryptoMock.getSecret.mockRejectedValueOnce(new Error('keychain sad'));
    const svc = new ScreenSecurityService();
    await expect(svc.init()).resolves.toBeUndefined();
    expect(svc.blankEnabled).toBe(true);
    const heard = jest.fn();
    svc.onScreenshot(heard);
    native.__screensec.emitScreenshot();
    expect(heard).toHaveBeenCalled();
    native.__screensec.emitCaptured(true);
    expect(svc.captured).toBe(true);
  });
});

describe('cold-start re-ask (the no-scene beat)', () => {
  /** The test is the OS: it holds every AppState subscriber and honors
   * remove(), so the one-shot really is one-shot only if the service
   * removes itself (App.foreground.failclosed.test.tsx convention). */
  let appStateListeners: ((next: string) => void)[] = [];

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  const transition = (state: string): void => {
    for (const fn of [...appStateListeners]) fn(state);
  };

  beforeEach(() => {
    appStateListeners = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      fn: (next: string) => void,
    ) => {
      appStateListeners.push(fn);
      return {
        remove: () => {
          appStateListeners = appStateListeners.filter(f => f !== fn);
        },
      };
    }) as unknown as typeof AppState.addEventListener);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a capture already running at a UI-less cold start lands on the first active transition', async () => {
    // The reviewed fail-open: the process cold-starts with no scene, the
    // seed answers false, and the recording — already running — never
    // fires a change event, because nothing changes.
    native.__screensec.state.captured = false;
    const svc = new ScreenSecurityService();
    await svc.init();
    expect(svc.captured).toBe(false);

    native.__screensec.state.captured = true; // true all along, no event
    const woke = jest.fn();
    svc.subscribe(woke);
    transition('active');
    await flush();
    expect(svc.captured).toBe(true);
    expect(svc.shouldBlank).toBe(true);
    expect(woke).toHaveBeenCalled();
  });

  test('one re-ask, not a poll — and background transitions ask nothing', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    const asksAfterInit = native.getIsCaptured.mock.calls.length;
    transition('background');
    await flush();
    expect(native.getIsCaptured.mock.calls.length).toBe(asksAfterInit);
    transition('active');
    await flush();
    expect(native.getIsCaptured.mock.calls.length).toBe(asksAfterInit + 1);
    transition('background');
    transition('active');
    await flush();
    expect(native.getIsCaptured.mock.calls.length).toBe(asksAfterInit + 1);
  });

  test('a change event racing the re-ask wins — the event is fresher', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    let answer!: (captured: boolean) => void;
    native.getIsCaptured.mockImplementationOnce(
      () => new Promise<boolean>(resolve => (answer = resolve)),
    );
    transition('active');
    native.__screensec.emitCaptured(true); // capture starts mid-ask
    answer(false); // the stale pre-event answer arrives late
    await flush();
    expect(svc.captured).toBe(true);
    expect(svc.shouldBlank).toBe(true);
  });
});

describe('screenshots', () => {
  test('forwards native screenshot events to registered listeners', async () => {
    const svc = new ScreenSecurityService();
    await svc.init();
    const heard = jest.fn();
    const off = svc.onScreenshot(heard);
    native.__screensec.emitScreenshot();
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    native.__screensec.emitScreenshot();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
