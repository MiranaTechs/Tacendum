/**
 * The picture of your ID is the second reading of something already written on
 * the page, so it must never be the reason the page fails. It draws itself
 * lazily, it says so plainly when it cannot, it hands the share sheet a file
 * and nothing else — no caption, because a caption puts the plaintext ID back
 * somewhere that syncs — and it takes that file off the disk when it goes.
 */

import React from 'react';
import { Share } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { themeTokens } from '../src/theme';
import { QrPanel } from '../src/ui/QrPanel';

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

const ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

let shareSpy: jest.SpyInstance;

beforeEach(() => {
  nativeQr.__qr.reset();
  nativeQr.encodePng.mockClear();
  nativeQr.decodeFile.mockClear();
  nativeQr.writeSharePng.mockClear();
  nativeQr.clearSharePng.mockClear();
  // Share is NOT mocked by @react-native/jest-preset; the real one rejects
  // with "NativeActionSheetManager is not registered on iOS".
  shareSpy = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: 'sharedAction' } as never);
});

afterEach(() => {
  shareSpy.mockRestore();
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

/**
 * Host nodes only. A testID on a composite (InlineError, TextAction, Image)
 * also appears on the host it renders, so an unfiltered findAll counts the
 * same control twice and every `toBe(1)` below would be meaningless.
 */
function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  );
}

/**
 * The control itself. A Pressable's host View carries no `onPress` — the
 * handler lives on the composite — so presses go through this and counting
 * goes through byId.
 */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
}

/** Every string rendered anywhere in the tree, flattened. */
function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAll(n => typeof n.type === 'string')
    .flatMap(n => React.Children.toArray(n.props.children))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

describe('QrPanel draws the id', () => {
  test('mounting draws exactly one code and shows it without touching disk', async () => {
    const tree = await render(<QrPanel id={ID} />);

    expect(nativeQr.encodePng).toHaveBeenCalledTimes(1);
    const image = byId(tree, 'self-qr-image');
    expect(image.length).toBe(1);
    // A data: URI, so the plaintext picture of the owner's only reachability
    // address never lands in the filesystem just to be looked at.
    expect(image[0].props.source.uri).toMatch(/^data:image\/png;base64,/);
    expect(nativeQr.writeSharePng).not.toHaveBeenCalled();

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the ink is the light tokens, resolved — never a literal in the module', async () => {
    const t = themeTokens('light');
    const tree = await render(<QrPanel id={ID} />);

    const [text, , darkHex, lightHex] = nativeQr.encodePng.mock.calls[0];
    // Asserted against the tokens rather than a literal hex pair so a theme
    // edit moves the QR with it instead of silently passing.
    //
    // Re-cut 2026-09-05: this pinned a theme-DERIVED pair, read from whatever
    // palette the render happened to be under — and jest renders under light,
    // so the assertion was green while the dark palette handed the encoder a
    // contrast-inverted code no scanner could read. The pair is now fixed at
    // the light palette in both modes (QrPanel.tsx's QR_DARK_HEX), so this
    // names the mode explicitly and QrPanel.dark.test.tsx holds the other half.
    expect(darkHex).toBe(t.color.inkStrong);
    expect(lightHex).toBe(t.color.paperSheet);
    // And the payload is still the bare id, all the way down to the native call.
    expect(text).toBe(ID);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a code that will not draw says so, and never renders half a picture', async () => {
    nativeQr.__qr.state.failEncode = 'qr_encode_failed';
    const tree = await render(<QrPanel id={ID} />);

    expect(byId(tree, 'self-qr-image').length).toBe(0);
    expect(byId(tree, 'self-qr-error').length).toBe(1);
    // The written ID is still on the page above, and the copy has to say so.
    expect(textOf(tree)).toContain('Your ID above still works.');

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the picture is not labelled with the ID that is spelled out above it', async () => {
    const tree = await render(<QrPanel id={ID} />);

    const label: string = byId(tree, 'self-qr-image')[0].props
      .accessibilityLabel;
    // VoiceOver reads the spelled 26 characters one swipe above. Repeating
    // them on the image reads the whole ULID twice in a row.
    expect(label).not.toContain(ID);
    expect(label).not.toMatch(/\d/);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('QrPanel hands the picture over', () => {
  test('share writes the file and passes a url with no caption beside it', async () => {
    const tree = await render(<QrPanel id={ID} />);

    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });

    expect(nativeQr.writeSharePng).toHaveBeenCalledTimes(1);
    expect(nativeQr.writeSharePng.mock.calls[0][0]).toBe(
      nativeQr.__qr.state.pngB64,
    );
    // `url` and nothing else: a `message` alongside it makes iOS rank Safari
    // above Messages, and the caption would carry the plaintext ID.
    expect(Object.keys(shareSpy.mock.calls[0][0])).toEqual(['url']);
    expect(shareSpy.mock.calls[0][0].url).toBe(nativeQr.__qr.state.shareUri);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('share is inert until there is something to share', async () => {
    nativeQr.__qr.state.failEncode = 'qr_encode_failed';
    const tree = await render(<QrPanel id={ID} />);

    // The host View is what carries the state VoiceOver reads.
    expect(byId(tree, 'share-self-qr')[0].props.accessibilityState.disabled).toBe(
      true,
    );
    // And the handler itself refuses, so the disabled prop is not the only
    // thing standing between a failed draw and a share of nothing.
    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });
    expect(nativeQr.writeSharePng).not.toHaveBeenCalled();

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('dismissing the share sheet is not a failure and says nothing', async () => {
    const tree = await render(<QrPanel id={ID} />);
    shareSpy.mockRejectedValueOnce(new Error('User did not share'));

    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });

    expect(byId(tree, 'self-qr-error').length).toBe(0);
    expect(byId(tree, 'self-qr-image').length).toBe(1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a file that cannot be written says so instead of a silent dead button', async () => {
    const tree = await render(<QrPanel id={ID} />);
    nativeQr.__qr.state.failWrite = 'qr_write_failed';

    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });

    expect(byId(tree, 'self-qr-share-error').length).toBe(1);
    expect(textOf(tree)).toContain('couldn’t prepare the picture to send');

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a file that cannot be written never takes the picture off the screen', async () => {
    const tree = await render(<QrPanel id={ID} />);
    nativeQr.__qr.state.failWrite = 'qr_write_failed';

    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });

    // The whole point of the panel is a code somebody can scan. A share file
    // that would not write says nothing about the code already drawn, and
    // replacing it means showing a friend an error box instead of a QR.
    expect(byId(tree, 'self-qr-image').length).toBe(1);
    // The draw slot is untouched — that one is only ever for "there is no
    // picture at all".
    expect(byId(tree, 'self-qr-error').length).toBe(0);
    // And the button is still live, so the failure is recoverable in place.
    expect(
      byId(tree, 'share-self-qr')[0].props.accessibilityState.disabled,
    ).toBe(false);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a share that works after one that did not clears what the last one said', async () => {
    const tree = await render(<QrPanel id={ID} />);
    nativeQr.__qr.state.failWrite = 'qr_write_failed';
    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });
    expect(byId(tree, 'self-qr-share-error').length).toBe(1);

    nativeQr.__qr.state.failWrite = null;
    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });

    // Nothing else in the panel ever re-runs — the encode effect keys on
    // [id, darkHex, lightHex], none of which move — so if the retry does not
    // clear this, collapsing the panel is the only way back.
    expect(byId(tree, 'self-qr-share-error').length).toBe(0);
    expect(byId(tree, 'self-qr-image').length).toBe(1);
    expect(shareSpy).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('closing the panel takes the shared file off the disk', async () => {
    const tree = await render(<QrPanel id={ID} />);
    await ReactTestRenderer.act(async () => {
      control(tree, 'share-self-qr').props.onPress();
    });
    expect(nativeQr.__qr.calls.cleared).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });

    // Unmount, not "when Share.share resolves": AirDrop keeps reading the file
    // after the sheet dismisses.
    expect(nativeQr.__qr.calls.cleared).toBe(1);
  });
});
