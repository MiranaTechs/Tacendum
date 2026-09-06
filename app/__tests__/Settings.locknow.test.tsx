/**
 * Lock now.
 *
 * `lock.ts` exports `status`, `setup`, `setAutolock`, `disable`, `clearAll`,
 * `verify` and `cooldownRemainingMs` — and no manual lock. Locking happens
 * only through App.tsx's `relock()`, driven by AppState and the auto-lock
 * timer, so with Auto-lock at 1 or 5 minutes there is no way to lock
 * deliberately at all. This row is the cheapest bad-day control in the
 * backlog, it is not destructive, and it reuses the exact teardown a
 * background lock takes rather than inventing a second one.
 *
 * RULE 16 IS THE POINT OF THE LAST CASE. A coerced tap must lock the decoy
 * the same way it locks the real workspace, and the lock screen that comes
 * back is already pixel-identical for both codes (`LockScreen.tsx:17-21`).
 * A row that rendered differently in a duress session would be a one-glance
 * discriminator on a shipped surface — exactly the class of tell this
 * release is closing elsewhere.
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
let onLockNow: jest.Mock;

async function render(opts: { withProp?: boolean } = {}): Promise<void> {
  const withProp = opts.withProp ?? true;
  onLockNow = jest.fn();
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={() => {}}
        onOpenLinkedDevices={() => {}}
        onOpenAccountEmail={() => {}}
        {...(withProp ? { onLockNow } : {})}
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

/** The rendered subtree of one testID, as text — what a person (or a
 * coercer) can actually see of that row. */
function subtree(testID: string): string {
  type Node = { props?: Record<string, unknown>; children?: unknown[] } | null;
  const find = (node: unknown): Node => {
    if (node === null || typeof node !== 'object') return null;
    const n = node as { props?: Record<string, unknown>; children?: unknown[] };
    if (n.props?.testID === testID) return n;
    for (const child of n.children ?? []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const found = find(tree.toJSON());
  if (!found) throw new Error(`no rendered node with testID ${testID}`);
  return JSON.stringify(found);
}

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});

test('the row is absent while App Lock is off — there is nothing to lock', async () => {
  await render();
  expect(has('settings-lock-enable')).toBe(true);
  expect(has('settings-lock-now')).toBe(false);
});

test('with App Lock on the row appears, says what it costs, and calls the handler once', async () => {
  await lock.setup('123456');
  await render();

  expect(has('settings-lock-now')).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain(
    'Locking now also ends a call in progress.',
  );

  await press('settings-lock-now');
  expect(onLockNow).toHaveBeenCalledTimes(1);
});

test('without the handler the row does not exist — never a control that does nothing', async () => {
  await lock.setup('123456');
  await render({ withProp: false });
  expect(has('settings-lock-disable')).toBe(true);
  expect(has('settings-lock-now')).toBe(false);
});

test('a duress session renders the row byte-identically (rule 16)', async () => {
  await lock.setup('123456');
  await render();
  const real = subtree('settings-lock-now');
  // The NOTE is a sibling of the row, not a child of it, so the row's own
  // subtree cannot see it — and the note is the half most likely to be
  // "helpfully" branched one day ("Locking now also ends a call in
  // progress." reads differently if you think a decoy session should be
  // told less). Both halves are pinned, so a `session.mode` branch on
  // either one fails here.
  const realNote = subtree('settings-lock-now-note');
  await ReactTestRenderer.act(async () => {
    tree.unmount();
  });

  session.setMode('duress');
  await render();
  expect(subtree('settings-lock-now')).toBe(real);
  expect(subtree('settings-lock-now-note')).toBe(realNote);
  // The second pin is not redundant: the note is genuinely OUTSIDE the row's
  // own subtree, so the first assertion cannot see it.
  expect(realNote.length).toBeGreaterThan(0);
  expect(real).not.toContain(realNote);
  // …and it still works, because a coerced tap must lock the decoy the same
  // way it locks the real workspace.
  await press('settings-lock-now');
  expect(onLockNow).toHaveBeenCalledTimes(1);
});
