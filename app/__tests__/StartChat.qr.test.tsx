/**
 * The picture path fills the field. It does not start the chat.
 *
 * There is no directory, so nothing downstream can catch a wrong ID: it
 * addresses a stranger, or nobody, and either way silently. So a photo is only
 * ever allowed to type 26 characters into the box the person is already
 * looking at — the counter, the enabled button and the spelled-out ID are the
 * confirmation, and they already existed. Every refusal below is a refusal to
 * guess on someone's behalf.
 */

import React from 'react';
import { AccessibilityInfo } from 'react-native';
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
  writeSharePng: jest.Mock;
  clearSharePng: jest.Mock;
  __qr: {
    state: {
      pngB64: string;
      shareUri: string;
      payloads: string[];
      failEncode: string | null;
      failDecode: string | null;
      failWrite: string | null;
    };
    calls: { cleared: number };
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

/**
 * Every `INSERT INTO chats` the screen has actually issued.
 *
 * The op-sqlite mock is a stub whose execute always answers `{rows: []}`, so
 * `listChats()` is empty no matter what happened — asserting on it would pass
 * whether or not a chat was created. The recorded SQL is the only honest
 * evidence of a write in this harness.
 */
function chatWrites(): string[] {
  const out: string[] = [];
  for (const inst of sqlite.instances.values()) {
    for (const call of inst.execute.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes('INSERT INTO chats')) out.push(sql);
    }
  }
  return out;
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
const OTHER_ID = '01J0A2B3C4D5E6F7G8H9JKMNPQ';
const PHOTO = 'file:///tmp/picked/IMG_0042.HEIC';

/** The picker handing back one usable original. */
function pickedOk() {
  picker.launchImageLibrary.mockResolvedValue({
    assets: [{ uri: PHOTO, width: 3024, height: 4032, fileSize: 2_400_000 }],
  });
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();

  nativeQr.__qr.reset();
  nativeQr.encodePng.mockClear();
  nativeQr.decodeFile.mockClear();
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

/** The control itself: a Pressable's host View carries no `onPress`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
}

function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

function screen() {
  return (
    <StartChatScreen
      profile={PROFILE}
      onBack={jest.fn()}
      onOpenChat={jest.fn()}
      onFindByEmail={jest.fn()}
    />
  );
}

/** The message an inline region is currently showing. */
function messageOf(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return byId(tree, id)[0]
    .findAll(n => typeof n.type === 'string')
    .flatMap(n => React.Children.toArray(n.props.children))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

/** The `seq` the error region is currently carrying. */
function seqOf(tree: ReactTestRenderer.ReactTestRenderer): number {
  return tree.root.find(
    n => n.props.testID === 'start-chat-error' && typeof n.props.seq === 'number',
  ).props.seq;
}

/** Read a photo containing exactly these payloads. */
async function readPhoto(
  tree: ReactTestRenderer.ReactTestRenderer,
  payloads: string[],
) {
  pickedOk();
  nativeQr.__qr.state.payloads = payloads;
  await press(tree, 'scan-qr-photo');
}

describe('showing your own code', () => {
  test('the panel is collapsed until asked for, and nothing is drawn before then', async () => {
    const tree = await render(screen());
    // The own-ID block itself waits behind "Show my ID"; the QR
    // disclosure sits inside it.
    await press(tree, 'show-self-id');

    expect(byId(tree, 'show-self-qr').length).toBe(1);
    expect(byId(tree, 'self-qr-image').length).toBe(0);
    // Collapsed by default is a reliability property, not only a visual one:
    // a CoreImage failure cannot degrade the screen every new chat starts from.
    expect(nativeQr.encodePng).not.toHaveBeenCalled();

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the disclosure opens, closes, and says which it is', async () => {
    const tree = await render(screen());
    await press(tree, 'show-self-id');
    expect(byId(tree, 'show-self-qr')[0].props.accessibilityState.expanded).toBe(
      false,
    );

    await press(tree, 'show-self-qr');
    expect(byId(tree, 'self-qr-image').length).toBe(1);
    expect(byId(tree, 'show-self-qr')[0].props.accessibilityState.expanded).toBe(
      true,
    );

    await press(tree, 'show-self-qr');
    expect(byId(tree, 'self-qr-image').length).toBe(0);
    expect(byId(tree, 'show-self-qr')[0].props.accessibilityState.expanded).toBe(
      false,
    );

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the written ID and its existing actions are untouched by any of this', async () => {
    const tree = await render(screen());

    // The QR is additive. The written id and its actions are exactly what
    // they were — behind "Show my ID" since this screen is for reaching
    // THEM, so your own id waits behind one tap rather than a scroll.
    // (Rewritten deliberately: the earlier version pinned the block open
    // by default.)
    expect(byId(tree, 'self-user-id').length).toBe(0);
    await press(tree, 'show-self-id');
    expect(byId(tree, 'self-user-id').length).toBe(1);
    expect(byId(tree, 'copy-self-id').length).toBe(1);
    expect(byId(tree, 'share-self-id').length).toBe(1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('reading their code out of a photo', () => {
  test('a good photo fills the field and stops there', async () => {
    const tree = await render(screen());
    await readPhoto(tree, [PEER_ID]);

    expect(byId(tree, 'new-peer-input')[0].props.value).toBe(PEER_ID);
    expect(byId(tree, 'start-chat-notice').length).toBe(1);
    // The whole point: no chat row, no navigation, no "hello" on the wire.
    expect(chatWrites()).toEqual([]);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the confirmation is the UI that already existed', async () => {
    const tree = await render(screen());
    await readPhoto(tree, [PEER_ID]);

    expect(
      byId(tree, 'start-chat')[0].props.accessibilityState.disabled,
    ).toBe(false);
    // The counter is the person's own check on the 26 characters.
    const counter = tree.root.findAll(
      n => typeof n.type === 'string' && n.props.children === '26 of 26',
    );
    expect(counter.length).toBe(1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('and the person committing is what creates the chat', async () => {
    const tree = await render(screen());

    await readPhoto(tree, [PEER_ID]);
    expect(chatWrites()).toEqual([]);

    // The positive control for the assertion above: the same probe DOES see a
    // write once a person presses the button, so an empty list after a photo
    // is a real observation and not a probe that never sees anything.
    await press(tree, 'start-chat');
    await ReactTestRenderer.act(async () => {});
    expect(chatWrites().length).toBe(1);
    // And the flow lands where it always did — naming the person you just
    // committed to, not straight into the thread.
    expect(byId(tree, 'peer-nickname-save').length).toBe(1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the ID survives a payload with a sentence wrapped around it', async () => {
    const tree = await render(screen());
    await readPhoto(tree, [`My Tacendum ID is ${PEER_ID}`]);

    expect(byId(tree, 'new-peer-input')[0].props.value).toBe(PEER_ID);
    expect(byId(tree, 'start-chat-error').length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('backing out of the picker says nothing at all', async () => {
    const tree = await render(screen());
    picker.launchImageLibrary.mockResolvedValue({ didCancel: true });

    await press(tree, 'scan-qr-photo');

    expect(byId(tree, 'start-chat-error').length).toBe(0);
    expect(byId(tree, 'start-chat-notice').length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('every way a photo can refuse, in our own words', () => {
  const cases: Array<[string, string[], string]> = [
    [
      'no code at all',
      [],
      'There’s no QR code in that photo. Choose the picture they sent you, or type their ID instead.',
    ],
    [
      'two different codes',
      [PEER_ID, OTHER_ID],
      'That photo has more than one QR code. Tacendum won’t guess which one is theirs — choose a photo with a single code.',
    ],
    [
      'a Wi-Fi code',
      ['WIFI:S:home;T:WPA;P:01BX5ZZKBKACTAV9WEVGEMMVRZ;;'],
      'That QR code isn’t a Tacendum ID. It might be a Wi-Fi code or a web link — check you picked the right picture.',
    ],
    [
      'your own code',
      [PROFILE.userId],
      'That’s your own QR code. Ask them for theirs — yours is just below.',
    ],
  ];

  test.each(cases)('%s', async (_name, payloads, sentence) => {
    const tree = await render(screen());
    await readPhoto(tree, payloads);

    expect(byId(tree, 'start-chat-error').length).toBe(1);
    expect(messageOf(tree, 'start-chat-error')).toContain(sentence);
    // Settings is offered only for the one condition a person can act on.
    expect(byId(tree, 'start-chat-open-photo-settings').length).toBe(0);
    // A refusal never leaves a half-filled field behind.
    expect(byId(tree, 'new-peer-input')[0].props.value).toBe('');

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a photo too large to read is refused before it is decoded', async () => {
    const tree = await render(screen());
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: PHOTO, width: 30_000, height: 30_000 }],
    });

    await press(tree, 'scan-qr-photo');

    expect(messageOf(tree, 'start-chat-error')).toContain(
      'That photo is too large to read. Choose a smaller one.',
    );
    expect(nativeQr.decodeFile).not.toHaveBeenCalled();

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a denied library is the one failure that offers Settings', async () => {
    const tree = await render(screen());
    picker.launchImageLibrary.mockResolvedValue({ errorCode: 'permission' });

    await press(tree, 'scan-qr-photo');

    expect(messageOf(tree, 'start-chat-error')).toContain(
      'Tacendum doesn’t have access to your photos. You can turn it on in Settings.',
    );
    expect(byId(tree, 'start-chat-open-photo-settings').length).toBe(1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('an unreadable file falls back to the general sentence', async () => {
    const tree = await render(screen());
    pickedOk();
    nativeQr.__qr.state.failDecode = 'qr_unreadable';

    await press(tree, 'scan-qr-photo');

    expect(messageOf(tree, 'start-chat-error')).toContain(
      'Tacendum couldn’t read that photo. Choose another one.',
    );

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

/**
 * The paste path is the third way to fill the field, and it obeys the photo
 * path's rules to the letter: one id fills the box and stops there; more than
 * one is a refusal, not a guess; an id that only lives inside a link is
 * somebody else's payload. Detection is the shape of the change — many
 * characters arriving in one keystroke — so the clipboard is never READ
 * (`Clipboard.getString` raises the iOS paste prompt, and pasteboard.ts
 * treats reads as a leak surface). No Paste button, for the same reason.
 */
describe('pasting their ID', () => {
  const SHARED = `My Tacendum ID:\n${PEER_ID}\nAdd me in Tacendum → Start a chat.`;

  function type(tree: ReactTestRenderer.ReactTestRenderer, text: string) {
    return ReactTestRenderer.act(async () => {
      byId(tree, 'new-peer-input')[0].props.onChangeText(text);
    });
  }

  function field(tree: ReactTestRenderer.ReactTestRenderer): string {
    return byId(tree, 'new-peer-input')[0].props.value;
  }

  test('the shared message collapses to the bare id, and nothing else happens', async () => {
    const tree = await render(screen());
    await type(tree, SHARED);

    expect(field(tree)).toBe(PEER_ID);
    expect(byId(tree, 'start-chat-error').length).toBe(0);
    expect(messageOf(tree, 'start-chat-notice')).toBe(
      'Pasted. Check the ID above, then start the chat.',
    );
    expect(byId(tree, 'start-chat')[0].props.accessibilityState.disabled).toBe(
      false,
    );
    // Never auto-started: the human still confirms.
    expect(chatWrites()).toEqual([]);
    expect(byId(tree, 'peer-nickname-save').length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('an id spaced into fours, or wrapped in a lower-case sentence, lands the same way', async () => {
    const tree = await render(screen());
    await type(tree, '01BX 5ZZK BKAC TAV9 WEVG EMMV RZ');
    expect(field(tree)).toBe(PEER_ID);

    await type(tree, '');
    await type(tree, `here you go: ${PEER_ID.toLowerCase()} — see you`);
    expect(field(tree)).toBe(PEER_ID);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('two ids in one paste empty the field and refuse to choose', async () => {
    const tree = await render(screen());
    await type(tree, `${PEER_ID} or ${OTHER_ID}`);

    expect(field(tree)).toBe('');
    expect(byId(tree, 'start-chat-notice').length).toBe(0);
    expect(messageOf(tree, 'start-chat-error')).toContain(
      'more than one Tacendum ID',
    );
    expect(messageOf(tree, 'start-chat-error')).toContain('won’t guess');
    expect(chatWrites()).toEqual([]);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('an id that only appears inside a link is refused — the id is never a URL', async () => {
    const tree = await render(screen());
    await type(tree, `https://example.com/${PEER_ID}`);

    expect(field(tree)).toBe('');
    expect(messageOf(tree, 'start-chat-error')).toContain('link');
    expect(messageOf(tree, 'start-chat-error')).toContain('Tacendum ID');
    expect(chatWrites()).toEqual([]);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a paste with no id in it is treated exactly as typing', async () => {
    const tree = await render(screen());
    await type(tree, 'see you soon');

    // Folded and stripped like keystrokes — no notice, no error, no guess.
    expect(field(tree)).toBe('SEE Y0U S00N');
    expect(byId(tree, 'start-chat-notice').length).toBe(0);
    expect(byId(tree, 'start-chat-error').length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('keystrokes are never mistaken for a paste', async () => {
    const tree = await render(screen());
    let typed = '';
    for (const ch of PEER_ID) {
      typed += ch;
      await type(tree, typed);
    }
    expect(field(tree)).toBe(PEER_ID);
    expect(byId(tree, 'start-chat-notice').length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a short id wrapped in prose is reported by its length, not by the U in Tacendum', async () => {
    const tree = await render(screen());
    await type(tree, `My Tacendum ID is ${PEER_ID.slice(0, 25)}`);
    await press(tree, 'start-chat');

    expect(messageOf(tree, 'start-chat-error')).toContain('25 of 26');
    expect(messageOf(tree, 'start-chat-error')).not.toContain('letter U');

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('the region that carries the answer', () => {
  test('an error and a notice are never on screen together', async () => {
    const tree = await render(screen());

    await readPhoto(tree, [PEER_ID]);
    expect(byId(tree, 'start-chat-notice').length).toBe(1);
    expect(byId(tree, 'start-chat-error').length).toBe(0);

    await readPhoto(tree, []);
    expect(byId(tree, 'start-chat-error').length).toBe(1);
    expect(byId(tree, 'start-chat-notice').length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('typing is a fresh attempt: it clears both the error and the notice', async () => {
    const tree = await render(screen());

    await readPhoto(tree, [PEER_ID]);
    expect(byId(tree, 'start-chat-notice').length).toBe(1);
    await ReactTestRenderer.act(async () => {
      byId(tree, 'new-peer-input')[0].props.onChangeText('01B');
    });
    expect(byId(tree, 'start-chat-notice').length).toBe(0);

    await readPhoto(tree, []);
    expect(byId(tree, 'start-chat-error').length).toBe(1);
    await ReactTestRenderer.act(async () => {
      byId(tree, 'new-peer-input')[0].props.onChangeText('01BX');
    });
    expect(byId(tree, 'start-chat-error').length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the same failure twice in a row is announced twice', async () => {
    // AccessibilityInfo is already a mock from @react-native/jest-preset, and
    // jest.spyOn hands back an existing mock untouched — so without this clear
    // the calls of every earlier test in this file are still on it.
    const announce = jest.spyOn(
      AccessibilityInfo,
      'announceForAccessibilityWithOptions',
    );
    announce.mockClear();
    const tree = await render(screen());

    await readPhoto(tree, []);
    const first = seqOf(tree);
    await readPhoto(tree, []);
    const second = seqOf(tree);

    // The message is byte-identical both times, so React re-renders the same
    // InlineError and its effect only re-fires because `seq` moved.
    expect(messageOf(tree, 'start-chat-error')).toContain('There’s no QR code');
    expect(second).not.toBe(first);

    // accessibilityLiveRegion is Android-only, so on iOS an identical message
    // is silent on the second try unless `seq` moves. Without it a person who
    // picks two photos with no QR in either hears nothing the second time.
    const noCode = announce.mock.calls.filter(([m]) =>
      String(m).startsWith('There’s no QR code'),
    );
    expect(noCode.length).toBe(2);

    announce.mockClear();
    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('backing out of the picker does not re-announce the last failure', async () => {
    const announce = jest.spyOn(
      AccessibilityInfo,
      'announceForAccessibilityWithOptions',
    );
    announce.mockClear();
    const tree = await render(screen());

    await readPhoto(tree, []);
    const afterFailure = seqOf(tree);
    announce.mockClear();

    picker.launchImageLibrary.mockResolvedValue({ didCancel: true });
    await press(tree, 'scan-qr-photo');

    // A cancelled pick produces no new outcome: the error on screen is still
    // the previous photo's. Moving `seq` would make InlineError read it out
    // again, telling someone there is no QR code in a photo they never chose.
    expect(seqOf(tree)).toBe(afterFailure);
    expect(announce).not.toHaveBeenCalled();

    announce.mockClear();
    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
