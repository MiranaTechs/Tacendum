/**
 * TalkBack hears an inline notice once.
 *
 * InlineError and InlineNotice are the two components every inline failure and
 * confirmation in the app runs through. Both set accessibilityLiveRegion
 * ="polite" — which is Android-only — AND called
 * announceForAccessibilityWithOptions on every platform, which RN maps to
 * Android's TYPE_ANNOUNCEMENT. Each component's own comment says the announce
 * exists BECAUSE live regions are Android-only, which is exactly the argument
 * for not firing it there: on Android the live region already speaks, and the
 * announce speaks over it.
 *
 * The app already gates precisely this, twice — PinPad's announceCount and
 * CallScreen both announce only `if (Platform.OS === 'ios')`. These two
 * primitives now match.
 *
 * A device pass is still needed to establish whether Android speaks once
 * or twice: TYPE_ANNOUNCEMENT may be ignored at targetSdk 36. This suite
 * verifies the platform branch and its calls, not the speech heard on-device.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => {
  // OS is mutable so one file can hold both halves of the contract: the same
  // render path, twice, differing only in what the platform says it is.
  const platform: {
    OS: string;
    Version: number;
    isTesting: boolean;
    select: (spec: Record<string, unknown>) => unknown;
  } = {
    OS: 'ios',
    Version: 35,
    isTesting: true,
    select: (spec: Record<string, unknown>) =>
      platform.OS in spec
        ? spec[platform.OS]
        : 'native' in spec
          ? spec.native
          : spec.default,
  };
  return { __esModule: true, default: platform };
});

import React from 'react';
import { AccessibilityInfo } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { InlineError, InlineNotice } from '../src/ui/primitives';

const platform = (
  jest.requireMock('react-native/Libraries/Utilities/Platform') as {
    default: { OS: string };
  }
).default;

let announce: jest.SpyInstance;

beforeEach(() => {
  platform.OS = 'ios';
  announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  announce.mockRestore();
  platform.OS = 'ios';
});

function render(element: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  return tree;
}

/** The notice's own host View — where the live region and role live. */
function host(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.find(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

describe('on Android the live region speaks, and nothing speaks over it', () => {
  test('an inline error announces nothing and keeps its live region', () => {
    platform.OS = 'android';
    const tree = render(
      <InlineError message="That code did not work." testID="err" />,
    );

    expect(announce).not.toHaveBeenCalled();
    expect(host(tree, 'err').props.accessibilityLiveRegion).toBe('polite');
    expect(host(tree, 'err').props.accessibilityRole).toBe('alert');

    unmount(tree);
  });

  test('an inline notice announces nothing and keeps its live region', () => {
    platform.OS = 'android';
    const tree = render(
      <InlineNotice message="App Lock is on." testID="notice" />,
    );

    expect(announce).not.toHaveBeenCalled();
    expect(host(tree, 'notice').props.accessibilityLiveRegion).toBe('polite');
    expect(host(tree, 'notice').props.accessibilityRole).toBe('alert');

    unmount(tree);
  });

  test('a repeated identical message still announces nothing', () => {
    platform.OS = 'android';
    const tree = render(
      <InlineNotice message="Code changed." testID="notice" seq={1} />,
    );
    ReactTestRenderer.act(() => {
      tree.update(
        <InlineNotice message="Code changed." testID="notice" seq={2} />,
      );
    });

    // seq exists so an identical repeat re-announces on iOS. On Android the
    // live region re-reads the node itself, so the seq path must stay quiet
    // too — this is the case a naive `if (Platform.OS === 'ios')` around only
    // the first render would miss.
    expect(announce).not.toHaveBeenCalled();

    unmount(tree);
  });
});

describe('on iOS the announce is the only voice there is', () => {
  test('an inline error announces once, queued', () => {
    const tree = render(
      <InlineError message="That code did not work." testID="err" />,
    );

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('That code did not work.', {
      queue: true,
    });
    // The live region prop stays on the node: it is inert on iOS, and
    // stripping it would take Android's only voice away.
    expect(host(tree, 'err').props.accessibilityLiveRegion).toBe('polite');

    unmount(tree);
  });

  test('an inline notice announces once, and a seq bump re-announces', () => {
    const tree = render(
      <InlineNotice message="Code changed." testID="notice" seq={1} />,
    );
    expect(announce).toHaveBeenCalledTimes(1);

    ReactTestRenderer.act(() => {
      tree.update(
        <InlineNotice message="Code changed." testID="notice" seq={2} />,
      );
    });

    expect(announce).toHaveBeenCalledTimes(2);

    unmount(tree);
  });
});
