/**
 * "If this is lost or taken", on the screen.
 *
 * A second IN-SCREEN step, the Licenses idiom — not a route. That matters
 * for more than tidiness: `visibleSurface.ts` classifies by route name, so a
 * new route would move the visible-surface matrix and cost this release a
 * registration it does not need. A step costs nothing and reads the same.
 *
 * The words themselves are pinned by identity in `lossCopy.test.ts`, against
 * the modules that own each truth. This suite pins the SURFACE: that the
 * door exists where a person would look for it, that the page is reachable
 * and leaves cleanly, that the teaching line sits behind the ⓘ, and that a
 * coerced session sees exactly the same page (rule 16).
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { LOSS_COPY } from '../src/lossCopy';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { session } from '../src/session';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

let tree: ReactTestRenderer.ReactTestRenderer;
let onBack: jest.Mock;

async function render(): Promise<void> {
  onBack = jest.fn();
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={onBack}
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

const has = (testID: string): boolean =>
  tree.root.findAllByProps({ testID }).length > 0;
const rendered = (): string => JSON.stringify(tree.toJSON());

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});

test('the door sits in Privacy & security', async () => {
  await render();
  await press('settings-category-privacy');
  expect(has('settings-loss')).toBe(true);
  expect(rendered()).toContain(LOSS_COPY.row);
  // Closed: the page's own sentences are not printed down the category.
  expect(rendered()).not.toContain(LOSS_COPY.lines[0]);
});

test('it opens as a step — all four lines, and the category is not underneath it', async () => {
  await render();
  await press('settings-category-privacy');
  await press('settings-loss');

  const open = rendered();
  for (const line of LOSS_COPY.lines) expect(open).toContain(line);
  expect(open).toContain(LOSS_COPY.title);
  // A step, not an overlay: the sections it replaced are gone, and nothing
  // navigated anywhere.
  expect(has('settings-loss')).toBe(false);
  expect(has('settings-lock-enable')).toBe(false);
  expect(onBack).not.toHaveBeenCalled();
});

test('the teaching line sits behind the ⓘ and opens in place', async () => {
  await render();
  await press('settings-category-privacy');
  await press('settings-loss');
  expect(rendered()).not.toContain(LOSS_COPY.infoLines[0]);

  await press('settings-loss-info');
  expect(rendered()).toContain(LOSS_COPY.infoLines[0]);
  expect(rendered()).toContain(LOSS_COPY.infoLabel);
});

test('the way out says Done — there is nothing on this page to cancel', async () => {
  await render();
  await press('settings-category-privacy');
  await press('settings-loss');
  const page = rendered();

  // "Cancel" belongs to the PIN steps, where a person started something that
  // can be abandoned. This page is four paragraphs you read; asking someone
  // to cancel a thing they did not start is exactly the class of word this
  // release is auditing. The Licences notice takes the same link for the
  // same reason.
  expect(has('settings-step-done')).toBe(true);
  expect(has('settings-pin-cancel')).toBe(false);
  expect(page).toContain('Done');
  expect(page).not.toContain('Cancel');

  await press('settings-step-done');
  expect(has('settings-loss')).toBe(true);
  expect(has('settings-category-account')).toBe(false);
  expect(rendered()).not.toContain(LOSS_COPY.lines[0]);
  expect(onBack).not.toHaveBeenCalled();
});

test('a duress session reads the same page (rule 16)', async () => {
  await render();
  await press('settings-category-privacy');
  await press('settings-loss');
  const real = rendered();
  await ReactTestRenderer.act(async () => {
    tree.unmount();
  });

  session.setMode('duress');
  await render();
  await press('settings-category-privacy');
  await press('settings-loss');
  expect(rendered()).toBe(real);
});
