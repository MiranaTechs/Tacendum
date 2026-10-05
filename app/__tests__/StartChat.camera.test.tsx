/**
 * A REFUSED CAMERA IS EXPLAINED (Start a chat, build 33).
 *
 * Until now, tapping Scan with the camera refused did nothing: both native
 * scanners hand back an empty result for a refusal, exactly as for a cancel,
 * and the screen swallowed it. Now the screen reads the camera permission
 * after an EMPTY scan, through the read the calls feature already ships
 * (`tacendum-call`'s cameraPermission, which never prompts), and only then:
 *
 *  - granted: it was a cancel (or no usable camera, which both scanners
 *    report as a cancel) — silent, and nothing on screen changes;
 *  - refused on iOS: the Link-device sentence, word for word, and Open
 *    Settings;
 *  - refused on Android: Try again first, which asks the system directly
 *    (RN core's PermissionsAndroid) and turns into Open Settings in place
 *    once Android will not ask any more — without launching the scanner, so
 *    a permanent refusal never flashes the black secure scanner screen.
 *
 * A camera answer sits at the photo anchor and never drops a found card or a
 * miss: those belong to the field's text, which a scan that read nothing did
 * not change.
 */

import React from 'react';
import { AccessibilityInfo, Linking, PermissionsAndroid, Platform } from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import * as accounts from '../src/accounts';
import * as db from '../src/db';
import { LINKING_COPY } from '../src/linkingCopy';
import { COPY, StartChatScreen } from '../src/screens/StartChatScreen';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));
const picker = jest.requireMock('react-native-image-picker') as {
  launchImageLibrary: jest.Mock;
  launchCamera: jest.Mock;
};

const nativeQr = jest.requireMock('tacendum-qr') as {
  scanWithCamera: jest.Mock;
  __qr: {
    state: { payloads: string[]; failScan: string | null };
    reset: () => void;
  };
};
const nativeCall = jest.requireMock('tacendum-call') as {
  cameraPermission: jest.Mock;
};

/** The raw module object, so redefining `findNodeHandle` lands where the
 * screen reads it. */
const RN: typeof import('react-native') = require('react-native');

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { reset: () => void };
  }
).__sqlite;

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};
const PEER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const PHOTO = 'file:///tmp/picked/IMG_0042.HEIC';

const REAL_OS = Platform.OS;
function setPlatform(os: string): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

type Tree = ReactTestRenderer.ReactTestRenderer;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  nativeQr.__qr.reset();
  nativeQr.__qr.state.failScan = null;
  nativeQr.scanWithCamera.mockClear();
  nativeCall.cameraPermission.mockClear();
  picker.launchImageLibrary.mockReset();
});

afterEach(async () => {
  setPlatform(REAL_OS);
  // The preset's mock keeps a default answer; put it back for later suites.
  nativeCall.cameraPermission.mockImplementation(async () => 'granted');
  jest.restoreAllMocks();
  await db.close();
});

async function render(
  createNodeMock?: (element: React.ReactElement<{ testID?: string }>) => unknown,
): Promise<Tree> {
  let tree!: Tree;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <StartChatScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenChat={jest.fn()}
        onOpenAccountEmail={jest.fn()}
      />,
      createNodeMock ? { createNodeMock } : undefined,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function hosts(tree: Tree, id: string): ReactTestInstance[] {
  return tree.root.findAll(n => n.props.testID === id && typeof n.type === 'string');
}

function has(tree: Tree, id: string): boolean {
  return hosts(tree, id).length > 0;
}

function control(tree: Tree, id: string): ReactTestInstance {
  const node = tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no control with testID ${id}`);
  return node;
}

async function press(tree: Tree, id: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

function textIn(node: ReactTestInstance): string {
  return node
    .findAll(n => typeof n.type === 'string')
    .flatMap(n => React.Children.toArray(n.props.children))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function messageOf(tree: Tree, id: string): string {
  const node = hosts(tree, id)[0];
  if (!node) throw new Error(`nothing with testID ${id} is on screen`);
  return textIn(node);
}

/** The `seq` the error region carries, or null with no error on screen. */
function seqOf(tree: Tree): number | null {
  const node = tree.root.findAll(
    n => n.props.testID === 'start-chat-error' && typeof n.props.seq === 'number',
  )[0];
  return node ? node.props.seq : null;
}

/** A scan that reads nothing — a cancel, or a refusal; the permission read
 * after it tells the two apart. */
async function emptyScan(tree: Tree, permission: string): Promise<void> {
  nativeCall.cameraPermission.mockImplementation(async () => permission);
  nativeQr.__qr.state.payloads = [];
  await press(tree, 'scan-qr-camera');
}

describe('a scan that reads nothing', () => {
  test('a cancel (the camera is allowed) is silent: no message, no announcement, the seq unchanged', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    announce.mockClear();
    const tree = await render();
    await emptyScan(tree, 'granted');

    expect(has(tree, 'start-chat-error')).toBe(false);
    expect(seqOf(tree)).toBeNull();
    expect(announce).not.toHaveBeenCalled();
    // The read happened: silence is a decision, not a missed branch.
    expect(nativeCall.cameraPermission).toHaveBeenCalledTimes(1);
  });

  test('iOS, refused: the Link-device sentence and Open Settings, which opens Settings', async () => {
    setPlatform('ios');
    const settings = jest.spyOn(Linking, 'openSettings');
    const tree = await render();
    await emptyScan(tree, 'denied');

    expect(messageOf(tree, 'start-chat-error')).toBe(LINKING_COPY.cameraFailed);
    expect(has(tree, 'start-chat-open-camera-settings')).toBe(true);
    expect(has(tree, 'start-chat-camera-retry')).toBe(false);
    await press(tree, 'start-chat-open-camera-settings');
    expect(settings).toHaveBeenCalledTimes(1);
  });

  test('iOS, not yet asked: silent — the scanner itself asks first, so an empty result was a cancel', async () => {
    setPlatform('ios');
    const tree = await render();
    await emptyScan(tree, 'undetermined');

    expect(has(tree, 'start-chat-error')).toBe(false);
  });

  test.each(['undetermined', 'denied'])(
    'Android, %s: the first refusal offers Try again; a second refused scan offers Open Settings',
    async permission => {
      setPlatform('android');
      const tree = await render();
      await emptyScan(tree, permission);

      expect(messageOf(tree, 'start-chat-error')).toBe(LINKING_COPY.cameraFailed);
      expect(has(tree, 'start-chat-camera-retry')).toBe(true);
      expect(has(tree, 'start-chat-open-camera-settings')).toBe(false);

      await emptyScan(tree, permission);
      expect(has(tree, 'start-chat-camera-retry')).toBe(false);
      expect(has(tree, 'start-chat-open-camera-settings')).toBe(true);
    },
  );
});

describe('Android Try again asks the system directly', () => {
  test('granted: the scan runs once more', async () => {
    setPlatform('android');
    const ask = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('granted');
    const tree = await render();
    await emptyScan(tree, 'denied');
    expect(nativeQr.scanWithCamera).toHaveBeenCalledTimes(1);

    nativeQr.__qr.state.payloads = [PEER];
    await press(tree, 'start-chat-camera-retry');

    expect(ask).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.CAMERA);
    expect(nativeQr.scanWithCamera).toHaveBeenCalledTimes(2);
    expect(hosts(tree, 'new-peer-input')[0]!.props.value).toBe('01BX 5ZZK BKAC TAV9 WEVG EMMV RZ');
    expect(has(tree, 'start-chat-error')).toBe(false);
  });

  test('never ask again: Open Settings replaces it in place, the scanner is not launched, and focus moves to the new button', async () => {
    setPlatform('android');
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('never_ask_again');
    const focusSpy = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus');
    focusSpy.mockClear();
    // The preset's View is a mock class, so the slot's ref holds its
    // instance, testID on its props; a host ref would hold the node mock.
    const handle = jest.fn((node: unknown) => {
      const n = node as { testID?: string; props?: { testID?: string } } | null;
      return (n?.props?.testID ?? n?.testID) === 'start-chat-open-camera-settings' ? 44 : null;
    });
    const original = Object.getOwnPropertyDescriptor(RN, 'findNodeHandle')!;
    Object.defineProperty(RN, 'findNodeHandle', { configurable: true, get: () => handle });
    try {
      const tree = await render(element => ({ testID: element.props.testID }));
      await emptyScan(tree, 'denied');
      await press(tree, 'start-chat-camera-retry');

      expect(has(tree, 'start-chat-camera-retry')).toBe(false);
      expect(has(tree, 'start-chat-open-camera-settings')).toBe(true);
      expect(messageOf(tree, 'start-chat-error')).toBe(LINKING_COPY.cameraFailed);
      expect(nativeQr.scanWithCamera).toHaveBeenCalledTimes(1);
      expect(focusSpy).toHaveBeenCalledWith(44);
    } finally {
      Object.defineProperty(RN, 'findNodeHandle', original);
    }
  });

  test('denied: Try again stays and nothing else changes', async () => {
    setPlatform('android');
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('denied');
    const tree = await render();
    await emptyScan(tree, 'denied');
    const before = seqOf(tree);
    await press(tree, 'start-chat-camera-retry');

    expect(has(tree, 'start-chat-camera-retry')).toBe(true);
    expect(has(tree, 'start-chat-open-camera-settings')).toBe(false);
    expect(seqOf(tree)).toBe(before);
    expect(nativeQr.scanWithCamera).toHaveBeenCalledTimes(1);
  });
});

describe('the other camera outcomes', () => {
  test('the scanner module rejected: its own sentence, never the photo one, and no Settings button', async () => {
    const tree = await render();
    nativeQr.__qr.state.failScan = 'scanner_failed';
    await press(tree, 'scan-qr-camera');

    expect(messageOf(tree, 'start-chat-error')).toBe(
      'Tacendum couldn’t open the camera. Choose a photo of their QR code instead.',
    );
    expect(messageOf(tree, 'start-chat-error')).not.toContain('read that photo');
    expect(has(tree, 'start-chat-open-camera-settings')).toBe(false);
    expect(has(tree, 'start-chat-open-photo-settings')).toBe(false);
  });

  // Added for build 33: the camera half of these refusals was tested
  // only through the photo path.
  test.each([
    ['two different codes', [PEER, '01J0A2B3C4D5E6F7G8H9JKMNPQ'], COPY.qrMultiple],
    ['a code that is not an ID', ['WIFI:S:home;T:WPA;P:hunter2;;'], COPY.qrNotAnId],
  ])(
    'a camera read of %s: the sentence at the photo anchor, the field untouched, the permission never read',
    async (_name, payloads, sentence) => {
      const tree = await render();
      await ReactTestRenderer.act(async () => {
        hosts(tree, 'new-peer-input')[0]!.props.onChangeText('01BX');
      });
      nativeQr.__qr.state.payloads = payloads;
      await press(tree, 'scan-qr-camera');

      expect(messageOf(tree, 'start-chat-error')).toBe(sentence);
      expect(hosts(tree, 'new-peer-input')[0]!.props.value).toBe('01BX');
      // The photo anchor: below Scan and the photo link in reading order.
      const order = tree.root
        .findAll(n => typeof n.type === 'string' && typeof n.props.testID === 'string')
        .map(n => n.props.testID as string);
      expect(order.indexOf('start-chat-error')).toBeGreaterThan(order.indexOf('scan-qr-photo'));
      expect(nativeCall.cameraPermission).not.toHaveBeenCalled();
    },
  );

  test('a successful scan never reads the permission', async () => {
    const tree = await render();
    nativeQr.__qr.state.payloads = [PEER];
    await press(tree, 'scan-qr-camera');

    expect(has(tree, 'start-chat-notice')).toBe(true);
    expect(nativeCall.cameraPermission).not.toHaveBeenCalled();
  });

  test('a camera attempt replaces a lingering photo Settings link', async () => {
    const tree = await render();
    picker.launchImageLibrary.mockResolvedValue({ errorCode: 'permission' });
    await press(tree, 'scan-qr-photo');
    expect(has(tree, 'start-chat-open-photo-settings')).toBe(true);

    nativeQr.__qr.state.failScan = 'scanner_failed';
    await press(tree, 'scan-qr-camera');
    expect(has(tree, 'start-chat-open-photo-settings')).toBe(false);
    expect(messageOf(tree, 'start-chat-error')).toContain('couldn’t open the camera');

    picker.launchImageLibrary.mockResolvedValue({ errorCode: 'permission' });
    await press(tree, 'scan-qr-photo');
    expect(has(tree, 'start-chat-open-photo-settings')).toBe(true);
    nativeQr.__qr.state.failScan = null;
    nativeQr.__qr.state.payloads = [PEER];
    await press(tree, 'scan-qr-camera');
    expect(has(tree, 'start-chat-open-photo-settings')).toBe(false);
    expect(has(tree, 'start-chat-notice')).toBe(true);
  });

  test('a camera refusal while a miss is showing keeps the miss and adds the photo-anchored error', async () => {
    setPlatform('ios');
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await ReactTestRenderer.act(async () => {
      hosts(tree, 'new-peer-input')[0]!.props.onChangeText('lena@studio.co');
    });
    await press(tree, 'discovery-search');
    expect(has(tree, 'discovery-no-match')).toBe(true);

    await emptyScan(tree, 'denied');
    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(messageOf(tree, 'start-chat-error')).toBe(LINKING_COPY.cameraFailed);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('the refusal sentence is the Link-device one, imported, never retyped', () => {
    expect(COPY.cameraFailed).toBe(LINKING_COPY.cameraFailed);
  });

  test('a photo refusal leaves the field untouched', async () => {
    const tree = await render();
    await ReactTestRenderer.act(async () => {
      hosts(tree, 'new-peer-input')[0]!.props.onChangeText('01BX');
    });
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: PHOTO, width: 3024, height: 4032, fileSize: 2_400_000 }],
    });
    nativeQr.__qr.state.payloads = [];
    await press(tree, 'scan-qr-photo');

    expect(hosts(tree, 'new-peer-input')[0]!.props.value).toBe('01BX');
    expect(has(tree, 'start-chat-error')).toBe(true);
  });
});
