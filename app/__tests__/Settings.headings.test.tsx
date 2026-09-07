/**
 * The Settings detail sections remain rotor stops.
 *
 * `RuledLabel` renders a plain row, so every section label on the longest
 * scroll in the app was invisible to the VoiceOver rotor's Headings
 * navigator: reaching APPEARANCE meant swiping past every row above it.
 * The component has an opt-in `heading` prop; this screen is the
 * first owner to pass it. The category home is a set of buttons. Details
 * with multiple sections expose only the section headings that belong to
 * them; a single-section detail already has its ScreenHeader title.
 *
 * OPT-IN IS THE POINT. The same component draws the thread's date dividers
 * and Register's consent labels, where a heading per day would flood the
 * rotor the prop exists to make useful — so this suite asserts the exact
 * SET of headings, not merely that some exist. An unrelated row claiming
 * this role would be a regression, and so would a missing section.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as lock from '../src/lock';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { session } from '../src/session';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

let tree: ReactTestRenderer.ReactTestRenderer;

async function render(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={() => {}}
        onOpenLinkedDevices={() => {}}
        onOpenAccountEmail={() => {}}
      />,
    );
  });
}

async function press(testID: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    (
      tree.root
        .findAllByProps({ testID })
        .find(node => node.props.onPress !== undefined)!.props
        .onPress as () => void
    )();
  });
}

interface Rendered {
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}

/** The text under a rendered node, in order. */
function textOf(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node === null || typeof node !== 'object') return [];
  const n = node as Rendered;
  return (n.children ?? []).flatMap(textOf);
}

/** Every node the rotor would offer as a heading, by the label it reads. */
function headings(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const n = node as Rendered;
    if (
      n.props?.accessibilityRole === 'header' &&
      n.props?.accessible === true
    ) {
      out.push(textOf(n).join(' '));
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(tree.toJSON());
  return out;
}

const CATEGORY_SECTIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['settings-category-account', []],
  ['settings-category-privacy', ['FIELD MODE', 'APP LOCK', 'SCREEN']],
  ['settings-category-chats', ['CHATS', 'CALLS']],
  ['settings-category-notifications', []],
  ['settings-category-appearance', []],
  ['settings-category-writing', []],
  ['settings-category-about', []],
];

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});

test('each category detail exposes its exact rotor headings in reading order', async () => {
  await lock.setup('123456');
  await render();

  for (const [category, sections] of CATEGORY_SECTIONS) {
    await press(category);
    expect(headings()).toEqual(sections);
    await press('settings-back');
  }
});

test('category tiles are not headings, and nothing else in a detail claims to be one', async () => {
  await lock.setup('123456');
  await render();
  expect(headings()).toEqual([]);

  for (const [category, sections] of CATEGORY_SECTIONS) {
    await press(category);
    expect(headings()).toHaveLength(sections.length);
    await press('settings-back');
  }
});

test('a sub-step offers no section stops at all', async () => {
  // The falsifier the opt-in argument needs: the role travels with the
  // labels this screen renders, not with the component. On the Licenses
  // step there are no section labels, so there are no heading stops — and
  // the walker above would have said so if it were counting something else.
  await lock.setup('123456');
  await render();
  await press('settings-category-about');
  expect(headings()).toEqual([]);

  await press('settings-licenses');
  expect(headings()).toEqual([]);
});
