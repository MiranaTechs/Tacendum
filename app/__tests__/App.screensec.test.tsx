/**
 * Screen-security wiring: while the screen is captured every surface is
 * replaced by the capture cover, and a screenshot taken inside a conversation
 * discloses itself to that conversation — and nowhere else.
 */

import React from 'react';
import { AppState, Keyboard, StatusBar } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { messaging } from '../src/messaging';
import { screenSecurity } from '../src/screenSecurity';

const native = jest.requireMock('tacendum-screen-security') as {
  __screensec: {
    state: { captured: boolean; started: boolean };
    emitCaptured: (captured: boolean) => void;
    emitScreenshot: () => void;
  };
};

// NOTE: no native.__screensec.reset() here — the screenSecurity singleton
// registers its native listeners once per jest module registry, and clearing
// the mock's listener sets would orphan it for every later test in this file.

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<App />);
  });
  // Let the boot effect (workspace open, profile load) settle.
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function coverCount(tree: ReactTestRenderer.ReactTestRenderer): number {
  return tree.root.findAll(
    node => node.props.testID === 'capture-cover',
  ).length;
}

afterEach(async () => {
  // Drive the real service back to rest — mutating only the mock's state
  // field would leave the singleton still believing it is captured.
  native.__screensec.emitCaptured(false);
  await screenSecurity.setBlankEnabled(true);
});

test('recording replaces every surface with the capture cover, and restores on stop', async () => {
  const tree = await renderApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'chats' });
  });
  expect(coverCount(tree)).toBe(0);

  await ReactTestRenderer.act(async () => {
    native.__screensec.emitCaptured(true);
  });
  expect(coverCount(tree)).toBeGreaterThan(0);

  await ReactTestRenderer.act(async () => {
    native.__screensec.emitCaptured(false);
  });
  expect(coverCount(tree)).toBe(0);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a screenshot inside a conversation sends the notice for that peer only', async () => {
  const spy = jest
    .spyOn(messaging, 'sendScreenshotNotice')
    .mockResolvedValue(undefined);
  const tree = await renderApp();

  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: 'peer-9' });
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitScreenshot();
  });
  expect(spy).toHaveBeenCalledWith('peer-9');

  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'chats' });
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitScreenshot();
  });
  expect(spy).toHaveBeenCalledTimes(1);

  spy.mockRestore();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('the cover is modal to VoiceOver, keeps dark status glyphs, and dismisses the keyboard', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  const tree = await renderApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'chats' });
  });

  await ReactTestRenderer.act(async () => {
    native.__screensec.emitCaptured(true);
  });
  const cover = tree.root.findAll(
    node => node.props.testID === 'capture-cover',
  )[0];
  expect(cover.props.accessibilityViewIsModal).toBe(true);
  const darkBars = tree.root
    .findAllByType(StatusBar)
    .filter(n => n.props.barStyle === 'dark-content');
  expect(darkBars.length).toBeGreaterThanOrEqual(2);
  expect(dismiss).toHaveBeenCalled();

  dismiss.mockRestore();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('the lock screen is never blanked — a person must be able to unlock', async () => {
  const tree = await renderApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'locked' });
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitCaptured(true);
  });
  expect(coverCount(tree)).toBe(0);

  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'chats' });
  });
  expect(coverCount(tree)).toBeGreaterThan(0);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('disclosure is independent of the blanking setting', async () => {
  const spy = jest
    .spyOn(messaging, 'sendScreenshotNotice')
    .mockResolvedValue(undefined);
  const tree = await renderApp();
  await ReactTestRenderer.act(async () => {
    await screenSecurity.setBlankEnabled(false);
  });
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: 'peer-2' });
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitScreenshot();
  });
  expect(spy).toHaveBeenCalledWith('peer-2');
  spy.mockRestore();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('no notice while the capture cover is up — nothing was disclosed', async () => {
  const spy = jest
    .spyOn(messaging, 'sendScreenshotNotice')
    .mockResolvedValue(undefined);
  const tree = await renderApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: 'peer-3' });
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitCaptured(true);
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitScreenshot();
  });
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('no notice while the app is not active — the overlay hid everything', async () => {
  const spy = jest
    .spyOn(messaging, 'sendScreenshotNotice')
    .mockResolvedValue(undefined);
  const tree = await renderApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: 'peer-5' });
  });
  // currentState is a prototype getter; an own property shadows it and a
  // delete restores the original.
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => 'background',
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitScreenshot();
  });
  expect(spy).not.toHaveBeenCalled();
  delete (AppState as unknown as Record<string, unknown>).currentState;
  spy.mockRestore();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a screenshot of a full-screen photo discloses to that conversation too', async () => {
  const spy = jest
    .spyOn(messaging, 'sendScreenshotNotice')
    .mockResolvedValue(undefined);
  const tree = await renderApp();

  await ReactTestRenderer.act(async () => {
    devNav()({
      name: 'photoViewer',
      peerId: 'peer-4',
      msgId: '01PHOTO',
      direction: 'in',
    });
  });
  await ReactTestRenderer.act(async () => {
    native.__screensec.emitScreenshot();
  });
  expect(spy).toHaveBeenCalledWith('peer-4');

  spy.mockRestore();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
