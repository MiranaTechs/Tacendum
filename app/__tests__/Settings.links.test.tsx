/**
 * The Links ⓘ.
 *
 * `stripTracking` makes the address that OPENS differ from the address that
 * is SHOWN. That difference is a good one, but a difference a person
 * discovers is a bug and a difference a person is told about is a feature —
 * so it is disclosed on the surface where the app's own behaviour is
 * described, in one sentence, behind the house ⓘ.
 *
 * The sentence is checked against the shipped predicate here rather than
 * asserted on its own: a claim in Settings that the module does not keep is
 * exactly the failure mode this deck's other rows spend their length
 * avoiding.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { linkRuns } from '../src/linkRuns';
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

const propOf = (testID: string, prop: string): unknown => {
  const node = tree.root
    .findAllByProps({ testID })
    .find(n => n.props[prop] !== undefined);
  if (!node) throw new Error(`no node with testID ${testID} carries ${prop}`);
  return node.props[prop];
};

async function press(testID: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    (propOf(testID, 'onPress') as () => void)();
  });
}

const rendered = (): string => JSON.stringify(tree.toJSON());

const CLAIM_SEEN = 'the link you see is the one you were sent';
const CLAIM_REST = 'The rest of the address is untouched';

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});

test('the difference between the address shown and the address opened is disclosed, not discovered', async () => {
  await render();
  expect(rendered()).not.toContain(CLAIM_SEEN);
  await press('settings-category-privacy');
  await press('settings-links-info');
  const open = rendered();
  expect(open).toContain('tracking tags off a link before it opens');
  expect(open).toContain(CLAIM_REST);
  expect(open).toContain(CLAIM_SEEN);
});

test('the sentence is true of the shipped module, clause by clause', () => {
  const runs = linkRuns('https://example.com/a?utm_source=news&id=7');
  const link = runs[0] as { kind: 'link'; text: string; url: string };
  // "takes the tracking tags off a link before it opens"
  expect(link.url).not.toContain('utm_source');
  // "the rest of the address is untouched"
  expect(link.url).toBe('https://example.com/a?id=7');
  // "the link you see is the one you were sent"
  expect(link.text).toBe('https://example.com/a?utm_source=news&id=7');
});
