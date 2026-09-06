/**
 * The QR under the dark palette.
 *
 * A QR code is a printed artefact, not a themed surface. Handed the dark
 * palette's ink and paper, the encoder draws pale modules on a near-black
 * quiet zone — a contrast-inverted code. Both of this product's scanners are
 * its own and are inversion-blind, and deep links are refused, so the system
 * camera cannot complete the exchange either: the panel's whole job fails for
 * everyone who chose dark, and the light-theme test suite stays green while it
 * does (QrPanel.test.tsx asserts the two hexes against the light tokens).
 *
 * So: the code is encoded against the LIGHT palette unconditionally, and the
 * panel around it stays themed. Those are the two halves asserted here — one
 * file, because either half alone is a different bug.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ThemeProvider, themeTokens } from '../src/theme';
import { QrPanel } from '../src/ui/QrPanel';

const nativeQr = jest.requireMock('tacendum-qr') as {
  encodePng: jest.Mock;
  __qr: { reset: () => void };
};

const ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

const light = themeTokens('light');
const dark = themeTokens('dark');

beforeEach(() => {
  nativeQr.__qr.reset();
  nativeQr.encodePng.mockClear();
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

/** The panel's own View — the first host node the component renders. */
function panelStyle(
  tree: ReactTestRenderer.ReactTestRenderer,
): Record<string, unknown> {
  const host = tree.root.findAll(n => typeof n.type === 'string')[0]!;
  return StyleSheet.flatten(host.props.style) as Record<string, unknown>;
}

describe('QrPanel encodes a scannable code in either palette', () => {
  test('under dark, the encoder still receives the LIGHT ink and paper', async () => {
    const tree = await render(
      <ThemeProvider mode="dark">
        <QrPanel id={ID} />
      </ThemeProvider>,
    );

    const [text, , darkHex, lightHex] = nativeQr.encodePng.mock.calls[0];
    expect(darkHex).toBe(light.color.inkStrong);
    expect(lightHex).toBe(light.color.paperSheet);
    // The failure this pins: handing the dark tokens over inverts the code.
    expect(darkHex).not.toBe(dark.color.inkStrong);
    expect(lightHex).not.toBe(dark.color.paperSheet);
    // And the payload is still the bare id — no URL, no scheme (QR guardrail).
    expect(text).toBe(ID);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the panel around the code is still dark', async () => {
    const tree = await render(
      <ThemeProvider mode="dark">
        <QrPanel id={ID} />
      </ThemeProvider>,
    );

    // Pinned as the other half of the fix: the code is printed on paper, the
    // card it sits on is not. A regression that themed the code by theming
    // the panel would fail the assertion above and pass this one.
    expect(panelStyle(tree).backgroundColor).toBe(dark.color.paperSheet);
    expect(panelStyle(tree).borderColor).toBe(dark.color.lineSoft);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('under light, the panel takes the light surface and the same ink', async () => {
    const tree = await render(
      <ThemeProvider mode="light">
        <QrPanel id={ID} />
      </ThemeProvider>,
    );

    const [, , darkHex, lightHex] = nativeQr.encodePng.mock.calls[0];
    expect(darkHex).toBe(light.color.inkStrong);
    expect(lightHex).toBe(light.color.paperSheet);
    expect(panelStyle(tree).backgroundColor).toBe(light.color.paperSheet);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('flipping the theme under an open panel does not re-encode', async () => {
    const tree = await render(
      <ThemeProvider mode="light">
        <QrPanel id={ID} />
      </ThemeProvider>,
    );
    expect(nativeQr.encodePng).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      tree.update(
        <ThemeProvider mode="dark">
          <QrPanel id={ID} />
        </ThemeProvider>,
      );
    });

    // The encode effect's deps are the id and the two hexes; with the hexes
    // now constants, a theme flip cannot restart a CoreImage draw of a code
    // somebody may be pointing a phone at.
    expect(nativeQr.encodePng).toHaveBeenCalledTimes(1);
    expect(panelStyle(tree).backgroundColor).toBe(dark.color.paperSheet);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
