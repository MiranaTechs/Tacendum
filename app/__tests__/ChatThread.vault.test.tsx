/**
 * A Shared Room Vault change renders as an event in the room — a full-width
 * quiet ruled line, on BOTH sides — never as a speech bubble, never as raw
 * envelope JSON, and NEVER carrying the value it announces.
 *
 * THE DEFECT THIS FILE INHERITS. `vault` is not in `isCarrierEnvelope` (that is
 * deliberate: a peer changing the door code is a thing I am entitled to be told
 * about), so the thread filter keeps its row. That is exactly the position the
 * timer was in when it shipped without a render branch — the sender was shown
 * `{"tcm":"timer",...}` in their own conversation and the recipient was shown
 * nothing. For the vault the same defect would be strictly worse, because the
 * body of a vault row is the CREDENTIAL: a missed render branch would print a
 * door code into a scrolling thread and, in the failed-send case, hand it to
 * `sendText` as ordinary words on Try again.
 *
 * So there are two load-bearing negatives here, and both are asserted over
 * EVERY Text node on screen rather than over the vault rows specifically —
 * because the failure mode is a row nobody thought about reaching a renderer
 * nobody checked:
 *
 *   1. no rendered string may contain `"tcm"`;
 *   2. no rendered string may contain the secret.
 *
 * Harness copied from ChatThread.timer.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { clockLabel } from '../src/time';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const T0 = new Date('2026-07-25T12:00:00').getTime();
const ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AB';
const OTHER = '02WFXZ3NDEKTSV4RRFFQ69G5AB';

/** The string that must not be anywhere on screen. Distinctive on purpose. */
const SECRET = 'HUNTER2-DOORCODE-4417';

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'what was the door code again',
  ts: T0,
  status: 'received',
};
/** Their write, 10s after a message of theirs — the exact adjacency that made a
 * neighbour's clock vanish before shot rows became group-transparent. */
const VAULT_IN = {
  msgId: '01VAULTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({
    tcm: 'vault',
    op: 'set',
    id: ITEM,
    title: 'Front door',
    body: SECRET,
    n: 1,
    k: 0,
  }),
  ts: T0 + 10_000,
  status: 'received',
};
/** Mine — the row the timer bug showed its sender as raw JSON. */
const VAULT_OUT = {
  msgId: '01VAULTOUT',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({
    tcm: 'vault',
    op: 'set',
    id: OTHER,
    title: 'Wi-Fi',
    body: SECRET,
    n: 1,
    k: 1,
  }),
  ts: T0 + 60_000,
  status: 'sent',
};
/** A retraction names nothing: the envelope carries no title, deliberately, so
 * that deleting a credential cannot re-transmit it. */
const VAULT_DEL = {
  msgId: '01VAULTDEL',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({ tcm: 'vault', op: 'del', id: OTHER, n: 2, k: 1 }),
  ts: T0 + 120_000,
  status: 'sent',
};
/** Never receipted. The failed-bubble path prints `previewFor(body) || body`,
 * which is how this row would put the CREDENTIAL on screen next to a Try again
 * button — and hand it to sendText when the button is pressed. */
const VAULT_ERR = {
  msgId: '01VAULTERR',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({
    tcm: 'vault',
    op: 'set',
    id: ITEM,
    title: 'Bank ref',
    body: SECRET,
    n: 3,
    k: 1,
  }),
  ts: T0 + 180_000,
  status: 'error',
};
/**
 * A vault frame this build CANNOT PARSE, and the reason it belongs in this
 * file rather than in a forward-compatibility one.
 *
 * Every defence above is keyed on `parseEnvelope` succeeding: the render branch
 * tests `envelope?.tcm === 'vault'`, `previewFor` tests it, `displayText`
 * tests it. A frame that declares `{"tcm":"vault"` and then fails the schema
 * satisfies NONE of them, matches no other branch either, and reaches the
 * generic bubble — which used to print `row.body`, i.e. the whole envelope with
 * the credential in it.
 *
 * This is a live shape, not a thought experiment. `VAULT_BODY_MAX` was raised
 * 2048 -> 8192 because real values (SSH keys, WireGuard configs, blocks of
 * backup codes) are 1.7-3.4 KB, so every peer still on the older build renders
 * this exact row for an ordinary item — and a hostile peer reaches it on
 * purpose with one byte over the current cap.
 */
const VAULT_UNPARSEABLE = {
  msgId: '01VAULTBIG',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({
    tcm: 'vault',
    op: 'set',
    id: ITEM,
    title: 'Front door',
    body: `${SECRET}${'x'.repeat(9000)}`, // over VAULT_BODY_MAX
    n: 1,
    k: 0,
  }),
  ts: T0 + 240_000,
  status: 'received',
};

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return {
        rows: [
          TEXT_IN,
          VAULT_IN,
          VAULT_OUT,
          VAULT_DEL,
          VAULT_ERR,
          VAULT_UNPARSEABLE,
        ],
      };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  await db.close();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** Every string this screen actually draws. */
function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
}

test('no rendered row ever contains the envelope sentinel', async () => {
  // THE REGRESSION GUARD, deliberately not scoped to vault rows: the timer bug
  // was a body nobody had claimed reaching the generic bubble.
  const tree = await renderThread();
  const leaked = renderedText(tree).filter(s => s.includes('"tcm"'));
  expect(leaked).toEqual([]);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('the value never reaches the screen — not in a row, not in a label', async () => {
  // The row's body IS the envelope, credential included, because that is how
  // the state travels. The thread draws the title and nothing else. Accessibility labels are checked too: a value spoken aloud is a
  // value disclosed.
  const tree = await renderThread();
  expect(renderedText(tree).filter(s => s.includes(SECRET))).toEqual([]);
  const labels = tree.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => String(n.props.accessibilityLabel));
  expect(labels.filter(s => s.includes(SECRET))).toEqual([]);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a vault frame this build cannot parse still never shows its value', async () => {
  // The two negatives above already cover this row, because they scan EVERY
  // Text node — but they would pass for the wrong reason if the row were
  // silently dropped, so this test pins that the row is kept, is a bubble
  // (nothing recognised it as a vault notice, because nothing could), and says
  // the unsupported sentence instead of its contents.
  const tree = await renderThread();
  expect(
    tree.root.findAll(n => n.props.testID === 'msg-01VAULTBIG').length,
  ).toBeGreaterThan(0);
  const texts = renderedText(tree);
  expect(texts).toContain('Unsupported message — update Tacendum');
  expect(texts.filter(s => s.includes(SECRET))).toEqual([]);
  expect(texts.filter(s => s.includes('"tcm"'))).toEqual([]);
  // Nine thousand peer-chosen characters is a layout weapon as well as a leak:
  // nothing this long may reach a Text node at all.
  expect(texts.filter(s => s.length > 2000)).toEqual([]);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a vault change renders as a system row on both sides, never a bubble', async () => {
  const tree = await renderThread();

  for (const id of ['01VAULTIN', '01VAULTOUT', '01VAULTDEL']) {
    expect(
      tree.root.findAll(n => n.props.testID === `vault-${id}`).length,
    ).toBeGreaterThan(0);
    expect(tree.root.findAll(n => n.props.testID === `msg-${id}`).length).toBe(0);
  }

  const texts = renderedText(tree);
  // Mine speaks in the first person; theirs names them. An unnamed peer's ref
  // is the pronoun 'them', which cannot hold a sentence-initial subject slot.
  expect(texts).toContain('You saved “Wi-Fi” to the vault.');
  expect(texts).toContain('They saved “Front door” to the vault.');
  // A retraction cannot name the item — nothing on the wire says what it was.
  expect(texts).toContain('You removed an item from the vault.');

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('an errored vault notice still renders the quiet row — no JSON, no retry', async () => {
  // Placement, not decoration: the notice branch sits ahead of the error branch
  // precisely so the credential never reaches the failed bubble, whose Try
  // again would hand the whole envelope to sendText as ordinary words.
  const tree = await renderThread();
  expect(
    tree.root.findAll(n => n.props.testID === 'vault-01VAULTERR').length,
  ).toBeGreaterThan(0);
  expect(tree.root.findAll(n => n.props.testID === 'error-01VAULTERR').length).toBe(
    0,
  );
  expect(tree.root.findAll(n => n.props.testID === 'retry-01VAULTERR').length).toBe(
    0,
  );
  expect(renderedText(tree)).toContain('You saved “Bank ref” to the vault.');
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('nothing on a vault row can be long-pressed into a Copy', async () => {
  // TWO DEFENCES, both asserted, because either alone would put a door code on
  // the iOS pasteboard.
  //
  // Outer: the rail (with its Copy control and its a11y `copy` action) hangs
  // off the message bubble, and the vault branch returns before the bubble
  // exists — so there is no node for these rows carrying onLongPress at all.
  // A `copy-` testID assertion alone would be VACUOUS, since the rail only
  // renders for the row that is currently long-pressed.
  //
  // Inner: displayText — what the rail would hand the clipboard — yields '' for
  // a vault envelope, asserted in envelope.test.ts.
  const tree = await renderThread();
  for (const id of ['01VAULTIN', '01VAULTOUT', '01VAULTDEL', '01VAULTERR']) {
    expect(tree.root.findAll(n => n.props.testID === `msg-${id}`).length).toBe(0);
  }
  const pressable = tree.root.findAll(
    n =>
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('vault-') &&
      typeof n.props.onLongPress === 'function',
  );
  expect(pressable).toEqual([]);
  // And the ordinary text row in the same thread DOES have one, so the check
  // above is looking for something this screen really does render.
  expect(
    tree.root.findAll(n => n.props.testID === 'msg-01TEXTIN').length,
  ).toBeGreaterThan(0);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a vault row is transparent to grouping: the neighbour keeps its clock', async () => {
  // TEXT_IN is followed 10s later by a same-direction vault row; a system row
  // prints no clock, so it must never suppress the neighbour's. Missing from
  // the `system[]` map, this fails on the NEIGHBOUR — which is why it has a
  // test of its own.
  const tree = await renderThread();
  expect(renderedText(tree).some(s => s.includes(clockLabel(T0)))).toBe(true);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a vault notice can be removed like any other row', async () => {
  // Local only: clearing the notice never touches the item, which lives in
  // vault_items and is reached from the vault, not the thread.
  const tree = await renderThread();
  const remove = tree.root.findAll(
    n => n.props.testID === 'remove-01VAULTIN' && !!n.props.onPress,
  )[0];
  expect(remove).toBeTruthy();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  // A DELTA, not a total. The screen's mount-time disappearing-message sweep
  // already issues a `DELETE FROM messages` of its own, so a total of
  // "> 0" is satisfied before the press ever happens — which made the
  // behavioural half of this test unfalsifiable: replacing the handler with a
  // no-op left the whole suite green.
  const deletesSoFar = () =>
    instance.execute.mock.calls.filter(c =>
      String(c[0]).includes('DELETE FROM messages'),
    ).length;
  const before = deletesSoFar();
  await ReactTestRenderer.act(async () => {
    remove.props.onPress();
  });
  expect(deletesSoFar()).toBeGreaterThan(before);
  // And nothing that touches the ITEM: the row and the credential are separate
  // objects with separate lifetimes. (The schema pass names the table, so the
  // filter is on writes rather than on the word.)
  expect(
    instance.execute.mock.calls
      .map(c => String(c[0]))
      .filter(s => /(DELETE FROM|INSERT INTO|UPDATE) vault_items/.test(s)),
  ).toEqual([]);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
