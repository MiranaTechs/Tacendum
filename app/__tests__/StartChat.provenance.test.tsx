/**
 * THE HAND-OFF RAILS RECORD THEIR PROVENANCE. Both rails on this screen end at the same button — a QR only ever
 * fills the field (StartChat.qr.test.tsx) — so the screen has to remember
 * where the 26 characters came from at the moment the person commits:
 *
 *  - typed by hand → 'manual';
 *  - read from a photo or the live camera → 'qr';
 *  - read from a code and then EDITED → 'manual': the id in the field is no
 *    longer the one the code carried, and a provenance that survived the
 *    edit would vouch for characters nobody scanned.
 *
 * Neither rail is a server introduction, so neither ever earns the
 * discovery reminder — that is the whole point of telling them apart. And
 * the build-33 tidy-up that regroups a typed ID on blur is display only: it
 * never launders a provenance in either direction.
 *
 * Harness follows StartChat.qr.test.tsx: the fake op-sqlite records
 * statements; the recorded INSERT is the only honest evidence of a write.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { StartChatScreen } from '../src/screens/StartChatScreen';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));
const picker = jest.requireMock('react-native-image-picker') as {
  launchImageLibrary: jest.Mock;
  launchCamera: jest.Mock;
};

const nativeQr = jest.requireMock('tacendum-qr') as {
  encodePng: jest.Mock;
  decodeFile: jest.Mock;
  scanWithCamera: jest.Mock;
  __qr: {
    state: { payloads: string[] };
    reset: () => void;
  };
};

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      reset: () => void;
      instances: Map<string, { execute: jest.Mock }>;
    };
  }
).__sqlite;

/** Every `INSERT INTO chats` the screen has issued, with its parameters. */
function chatInserts(): Array<[string, unknown[]]> {
  const out: Array<[string, unknown[]]> = [];
  for (const inst of sqlite.instances.values()) {
    for (const call of inst.execute.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes('INSERT INTO chats')) {
        out.push([sql, (call[1] ?? []) as unknown[]]);
      }
    }
  }
  return out;
}

/** The provenance the one recorded INSERT carries. */
function recordedProvenance(): unknown {
  const inserts = chatInserts();
  expect(inserts).toHaveLength(1);
  const [sql, params] = inserts[0]!;
  expect(sql).toMatch(/introducedBy/);
  return params[3];
}

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

const PEER_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
/** The field's value once a picture or a paste fills it (build 33). */
const PEER_GROUPED = '01BX 5ZZK BKAC TAV9 WEVG EMMV RZ';
const PHOTO = 'file:///tmp/picked/IMG_0042.HEIC';

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();

  nativeQr.__qr.reset();
  nativeQr.decodeFile.mockClear();
  nativeQr.scanWithCamera.mockClear();
  picker.launchImageLibrary.mockReset();
  picker.launchCamera.mockReset();
});

afterEach(async () => {
  await db.close();
});

async function render(
  element: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** Host nodes only — a testID on a composite also lands on the host it renders. */
function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  );
}

/** The control itself. Harness change for build 33: PrimaryButton,
 * OutlineButton and TextAction put testID and onPress on the composite AND
 * its Pressable, so the first match is taken rather than a `find`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0]!;
}

function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

function type(tree: ReactTestRenderer.ReactTestRenderer, text: string) {
  return ReactTestRenderer.act(async () => {
    byId(tree, 'new-peer-input')[0]!.props.onChangeText(text);
  });
}

/** Keystrokes: one character per change, so nothing reads as a paste. */
async function typeEach(tree: ReactTestRenderer.ReactTestRenderer, text: string) {
  for (const ch of text) {
    await type(tree, `${byId(tree, 'new-peer-input')[0]!.props.value ?? ''}${ch}`);
  }
}

function blur(tree: ReactTestRenderer.ReactTestRenderer) {
  return ReactTestRenderer.act(async () => {
    byId(tree, 'new-peer-input')[0]!.props.onBlur();
  });
}

function screen() {
  return (
    <StartChatScreen
      profile={PROFILE}
      onBack={jest.fn()}
      onOpenChat={jest.fn()}
      onOpenAccountEmail={jest.fn()}
    />
  );
}

/** Read a photo containing exactly these payloads. */
async function readPhoto(
  tree: ReactTestRenderer.ReactTestRenderer,
  payloads: string[],
) {
  picker.launchImageLibrary.mockResolvedValue({
    assets: [{ uri: PHOTO, width: 3024, height: 4032, fileSize: 2_400_000 }],
  });
  nativeQr.__qr.state.payloads = payloads;
  await press(tree, 'scan-qr-photo');
}

/** Point the live camera at exactly these payloads. */
async function scanCamera(
  tree: ReactTestRenderer.ReactTestRenderer,
  payloads: string[],
) {
  nativeQr.__qr.state.payloads = payloads;
  await press(tree, 'scan-qr-camera');
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

test('an id typed by hand is recorded as manual', async () => {
  const tree = await render(screen());
  await type(tree, PEER_ID);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('manual');
  await unmount(tree);
});

test('an id read from a photo is recorded as qr', async () => {
  const tree = await render(screen());
  await readPhoto(tree, [PEER_ID]);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('qr');
  await unmount(tree);
});

test('an id read by the live camera is recorded as qr', async () => {
  const tree = await render(screen());
  await scanCamera(tree, [PEER_ID]);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('qr');
  await unmount(tree);
});

test('an id pasted out of a message is recorded as manual — nobody scanned it', async () => {
  const tree = await render(screen());
  await type(tree, `My Tacendum ID:\n${PEER_ID}\nAdd me in Tacendum → Start a chat.`);
  // The paste collapsed to the id, grouped since build 33; the person
  // still presses the button.
  expect(byId(tree, 'new-peer-input')[0]!.props.value).toBe(PEER_GROUPED);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('manual');
  await unmount(tree);
});

test('a scanned id, replaced by a paste, is recorded as manual — the code did not carry what is in the field', async () => {
  const tree = await render(screen());
  await readPhoto(tree, [PEER_ID]);
  await type(tree, '');
  await type(tree, `id: ${PEER_ID}`);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('manual');
  await unmount(tree);
});

test('a scanned id that the person then edits is recorded as manual — the code did not carry what is in the field', async () => {
  const tree = await render(screen());
  await readPhoto(tree, [PEER_ID]);
  // Delete the last character and retype it: the field ends up spelling the
  // same id, but the person, not the code, put the final character there.
  // (The fill is grouped since build 33, so the edit is on the grouped text.)
  await type(tree, PEER_GROUPED.slice(0, -1));
  await type(tree, PEER_GROUPED);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('manual');
  await unmount(tree);
});

// Added for build 33: the blur regroup is display only, and must not
// launder provenance in either direction.
test('a typed id regrouped on blur is still recorded as manual', async () => {
  const tree = await render(screen());
  await typeEach(tree, PEER_ID);
  await blur(tree);
  expect(byId(tree, 'new-peer-input')[0]!.props.value).toBe(PEER_GROUPED);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('manual');
  await unmount(tree);
});

test('a scanned id stays qr through a blur, until the person edits it', async () => {
  const tree = await render(screen());
  await scanCamera(tree, [PEER_ID]);
  expect(byId(tree, 'new-peer-input')[0]!.props.value).toBe(PEER_GROUPED);
  await blur(tree);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});

  expect(recordedProvenance()).toBe('qr');
  await unmount(tree);
});
