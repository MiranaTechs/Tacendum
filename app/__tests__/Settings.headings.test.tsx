/**
 * The eight Settings sections become rotor stops.
 *
 * `RuledLabel` renders a plain row, so every section label on the longest
 * scroll in the app was invisible to the VoiceOver rotor's Headings
 * navigator: reaching APPEARANCE meant swiping past every row above it.
 * Cluster 1 gave the component an opt-in `heading` prop; this screen is the
 * first owner to pass it, on its own eight labels and nowhere else.
 *
 * OPT-IN IS THE POINT. The same component draws the thread's date dividers
 * and Register's consent labels, where a heading per day would flood the
 * rotor the prop exists to make useful — so this suite asserts the exact
 * SET of headings, not merely that some exist. A ninth would be a
 * regression, and so would a missing one.
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
    if (n.props?.accessibilityRole === 'header' && n.props?.accessible === true) {
      out.push(textOf(n).join(' '));
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(tree.toJSON());
  return out;
}

const SECTIONS = [
  'FIELD MODE',
  'APP LOCK',
  'ACCOUNT',
  'SCREEN',
  'CALLS',
  'NOTIFICATIONS',
  'APPEARANCE',
  'ABOUT',
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

test('all eight sections are rotor headings, in the order they are read', async () => {
  await lock.setup('123456');
  await render();
  expect(headings()).toEqual(SECTIONS);
});

test('nothing else on the screen claims to be one', async () => {
  await lock.setup('123456');
  await render();
  // Exactly eight — a ninth heading would be a row or a note that took the
  // role it should not have, and the rotor's value is that it is short.
  expect(headings()).toHaveLength(8);
});

test('a sub-step offers no section stops at all', async () => {
  // The falsifier the opt-in argument needs: the role travels with the
  // labels this screen renders, not with the component. On the Licenses
  // step there are no section labels, so there are no heading stops — and
  // the walker above would have said so if it were counting something else.
  await lock.setup('123456');
  await render();
  expect(headings()).toHaveLength(8);

  await ReactTestRenderer.act(async () => {
    (tree.root
      .findAllByProps({ testID: 'settings-licenses' })
      .find(n => n.props.onPress !== undefined)!.props.onPress as () => void)();
  });
  expect(headings()).toEqual([]);
});
