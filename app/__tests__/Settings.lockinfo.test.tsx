/**
 * The two App Lock disclosures.
 *
 * - "One code, two doors" used to render ONLY at `flow.step === 'explain'`,
 * which is inside the enable/change ceremony. Re-reading how the second
 * door works therefore meant entering your current code and inventing a
 * new one twice — under pressure, the worst possible moment to be asked
 * to change a code. The same strings now render at a second site behind
 * the house ⓘ, with no new copy.
 * - Auto-lock had no ⓘ at all, while its `Right away` default is the direct
 * cause of relocking during the Android picker excursion. The disclosure
 * explains that behavior without overstating what `Right away` means,
 * and it is a DIFFERENT sentence per platform, so both arms are exported
 * and this suite walks the one that did not compile in.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as lock from '../src/lock';
import {
  AUTOLOCK_INFO_LINES,
  SettingsScreen,
} from '../src/screens/SettingsScreen';
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

const has = (testID: string): boolean =>
  tree.root.findAllByProps({ testID }).length > 0;
const rendered = (): string => JSON.stringify(tree.toJSON());

const SECOND_DOOR = 'Enter the same code backwards';

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});

describe('"One code, two doors", re-readable without changing your code', () => {
  it('sits in Privacy & security behind a ⓘ while App Lock is on — closed, then open in place', async () => {
    await lock.setup('123456');
    await render();
    await press('settings-category-privacy');

    expect(has('settings-lock-info')).toBe(true);
    expect(rendered()).not.toContain(SECOND_DOOR);
    await press('settings-lock-info');
    expect(rendered()).toContain(SECOND_DOOR);
    expect(rendered()).toContain('One code, two doors');
  });

  it('is absent while App Lock is off — there is no second door to describe yet', async () => {
    await render();
    await press('settings-category-privacy');
    expect(has('settings-lock-enable')).toBe(true);
    expect(has('settings-lock-info')).toBe(false);
  });

  it('renders the SAME sentence the ceremony renders — no second copy of it', async () => {
    await lock.setup('123456');
    await render();
    await press('settings-category-privacy');
    await press('settings-lock-info');
    const inCategory = rendered();
    // The exact clause the ceremony has always shown, plus the true
    // forgotten-code cost that rides with it.
    expect(inCategory).toContain(SECOND_DOOR);
    expect(inCategory).toContain(
      'There is no way to recover a forgotten code.',
    );
  });
});

describe('the Auto-lock ⓘ (AD-6: "Right away" stops overclaiming)', () => {
  it('sits beside Auto-lock and says what each choice really does', async () => {
    await lock.setup('123456');
    await render();
    await press('settings-category-privacy');

    expect(has('settings-autolock-info')).toBe(true);
    expect(rendered()).not.toContain('locks Tacendum the moment you leave it');
    await press('settings-autolock-info');
    const open = rendered();
    expect(open).toContain('When Tacendum locks itself');
    expect(open).toContain(AUTOLOCK_INFO_LINES.ios);
    expect(open).toContain(
      'One minute and five minutes give you that long to come back',
    );
  });

  it('exports both arms, so the one that did not compile in is still walkable', () => {
    expect(Object.keys(AUTOLOCK_INFO_LINES).sort()).toEqual(['android', 'ios']);
    // The iOS arm is the honest one for a platform where a picker does not
    // hand the screen away; the Android arm says the opposite, because
    // there it does. No excursion latch changes that behavior.
    expect(AUTOLOCK_INFO_LINES.ios).toContain('does not count as leaving');
    expect(AUTOLOCK_INFO_LINES.android).toContain(
      'hand the screen to another app for a moment',
    );
    expect(AUTOLOCK_INFO_LINES.android).toContain(
      'one minute is the smaller step',
    );
  });

  it('neither arm names a device or carries a capture word — so neither owes an inventory row', () => {
    for (const line of Object.values(AUTOLOCK_INFO_LINES)) {
      expect(line).not.toMatch(/iphone|ipad|icloud|apple|tablet/i);
      expect(line).not.toMatch(/\bphones?\b(?!\s(?:call|number))/i);
      // The scanner cautions the App Lock copy is written under: this
      // feature says duress and decoy, or nothing.
      expect(line).not.toMatch(/\bsecret\b|\bhidden\b|\bstealth\b/i);
    }
    // The falsifier: the same predicates reject a planted sentence, so a
    // green sweep above means the sweep really ran.
    expect('kept on this phone').toMatch(/\bphones?\b(?!\s(?:call|number))/i);
    expect('a hidden workspace').toMatch(/\bsecret\b|\bhidden\b|\bstealth\b/i);
  });
});
