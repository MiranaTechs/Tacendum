/**
 * THE SHARED ROOM VAULT on the peer profile.
 *
 * Four properties are load-bearing here, and each one is a thing that would be
 * invisible in review and catastrophic in the field:
 *
 *  1. A MASKED VALUE IS NOT IN THE RENDERED TREE. Not in a Text child, not in
 *     an accessibility label, not in a placeholder. `tree.toJSON()` is the
 *     rendered host hierarchy — the same thing a screenshot captures and the
 *     same thing VoiceOver walks — so the assertion is made against that whole
 *     object rather than against the nodes this test thought to look at.
 *  2. THE CAPS ARE LIVE AND THE REFUSAL LANDS ON ITS OWN FIELD. The composer
 *     does not re-implement the cap; `assertVaultItemFits` is the only thing
 *     that decides, and the screen's job is to have somewhere to say so.
 *  3. A CONTESTED ITEM SHOWS BOTH VALUES, LABELLED BY AUTHOR, and shows no
 *     single unlabelled one. Silently rendering the collapse's winner is the
 *     precise failure this feature exists to prevent.
 *  4. RESOLUTION IS ONE ORDINARY WRITE THAT DOMINATES. The screen owns three
 *     things about it — the existing id, the chosen title, the chosen body —
 *     and the last test feeds the slot that write produces back through the
 *     REAL `collapseVaultSlots` to prove the flag actually clears.
 *
 * HARNESS follows PeerProfile.blocking.test.tsx: the fake op-sqlite from
 * jest.setup.js answers by SQL fragment, so the screen drives the real `db`
 * module — `listVaultItems`, `collapseVaultSlots` and `listVaultContenders`
 * are the shipping ones, not stubs.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo, Clipboard, Text } from 'react-native';
import * as db from '../src/db';
import { VAULT_BODY_MAX, VAULT_TITLE_MAX } from '../src/envelope';
import { VaultItemRefusedError, messaging } from '../src/messaging';
import { PASTEBOARD_TTL_MS, cancelPasteboardExpiry } from '../src/pasteboard';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';
import { MASKED_VALUE, VAULT, VAULT_LIMITS, vaultRefusal } from '../src/vault';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

const T0 = new Date('2026-07-27T09:00:00').getTime();
/** ALICE sorts below BOB, which is what makes the writerId ordering testable. */
const ME_ID = '01AAAAZ3NDEKTSV4RRFFQ69G5F';
const PEER = '01BBBBZ3NDEKTSV4RRFFQ69G5F';
const ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AB';
/** A second item, so the mask can be compared ACROSS two different lengths. */
const SHORT_ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AC';

/** Distinctive enough that a substring search for it cannot be a false hit. */
const MY_SECRET = 'HUNTER2-MY-DOOR-CODE-9184';
const THEIR_SECRET = 'CORRECT-HORSE-THEIR-CODE-5502';
const SHORT_SECRET = 'PIN-91742';

const ME: db.ProfileRow = {
  userId: ME_ID,
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

const CHAT = {
  peerId: PEER,
  displayName: 'Sam',
  lastMessageAt: T0,
  lastMessageText: 'see you',
  about: null,
  avatarB64: null,
  profileVersion: null,
  safetyCheckedAt: null,
  localName: null,
  createdAt: T0,
  lastOpenedAt: null,
  identityChangedAt: null,
  safetyMismatchAt: null,
  disappearSec: 0,
};

function slot(over: Partial<db.VaultSlotRow> = {}): db.VaultSlotRow {
  return {
    peerId: PEER,
    id: ITEM,
    writerId: ME_ID,
    seq: 1,
    ackSeq: 0,
    title: 'Wi-Fi',
    body: MY_SECRET,
    updatedAt: T0,
    deleted: 0,
    ...over,
  };
}

/** What `vault_items` holds for this Room; set per test before rendering. */
let slots: db.VaultSlotRow[] = [];
/** What `messages` holds — only ever read for announcement-row status. */
let messageRows: db.MessageRow[] = [];
/** When this iPhone blocked them, per the fake `blocked_peers` table. */
const blockedAt: { at: number | null } = { at: null };

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  slots = [];
  messageRows = [];
  blockedAt.at = null;

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) {
      return {
        rows:
          blockedAt.at === null ? [] : [{ peerId: PEER, blockedAt: blockedAt.at }],
      };
    }
    if (s.includes('FROM chats')) return { rows: [CHAT] };
    if (s.includes('FROM vault_items')) {
      // `listVaultSlots` scopes to one item, `listVaultItems` to the Room —
      // the same split the shipping SQL makes.
      const args = (params as unknown[]) ?? [];
      return {
        rows: args.length > 1 ? slots.filter(r => r.id === args[1]) : slots,
      };
    }
    if (s.includes('FROM messages WHERE peerId = ?')) return { rows: messageRows };
    return base(s, params);
  });

  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
});

afterEach(async () => {
  await db.close();
  // Copy arms a real 60-second timer that outlives the screen on purpose, so
  // it has to be disarmed here or it fires after the environment is gone.
  cancelPasteboardExpiry();
  jest.restoreAllMocks();
});

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={jest.fn()} />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}
function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return byId(tree, id).length > 0;
}
async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, id)[0].props.onPress();
  });
}
async function type(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
  value: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, id)[0].props.onChangeText(value);
  });
}
/**
 * A testID reaches every instance carrying it — the composite that was handed
 * the prop and the host node it renders — so these pick the one that actually
 * holds the thing being asserted rather than trusting index 0.
 */
function textOf(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): string | undefined {
  const node = byId(tree, id).find(n => typeof n.props.children === 'string');
  return node?.props.children as string | undefined;
}
function labelOf(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): string | undefined {
  const node = byId(tree, id).find(
    n => typeof n.props.accessibilityLabel === 'string',
  );
  return node?.props.accessibilityLabel as string | undefined;
}
function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

/**
 * EVERYTHING THE PHONE WOULD PUT IN FRONT OF A PERSON. `toJSON()` is the
 * rendered host tree with every prop on it, so this covers text children,
 * accessibilityLabel, accessibilityHint, placeholder and a TextInput's value
 * in one object — including any node this test never thought to look for.
 */
function onScreen(tree: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

/** Every string VoiceOver would read out loud, on its own. */
function spoken(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll(n => typeof n.props?.accessibilityLabel === 'string')
    .map(n => String(n.props.accessibilityLabel));
}

describe('the vault section — masking', () => {
  test('a value is not on screen and not spoken until it is asked for', async () => {
    // Two items whose values are nowhere near the same length: the mask has to
    // be the same width for both, or the screen publishes how long every
    // credential in the Room is.
    slots = [slot(), slot({ id: SHORT_ITEM, title: 'Gate', body: SHORT_SECRET })];
    const tree = await render();

    expect(has(tree, `peer-vault-item-${ITEM}`)).toBe(true);
    // The NAME is not the secret and is shown — it is how you find the thing.
    expect(texts(tree)).toContain('Wi-Fi');

    // THE PROPERTY. Nowhere in the rendered hierarchy, which is what a
    // screenshot captures and what VoiceOver walks.
    expect(onScreen(tree)).not.toContain(MY_SECRET);
    for (const label of spoken(tree)) expect(label).not.toContain(MY_SECRET);

    // What stands there instead, and what is said instead.
    expect(textOf(tree, `peer-vault-value-${ITEM}`)).toBe(MASKED_VALUE);
    expect(labelOf(tree, `peer-vault-value-${ITEM}`)).toBe(VAULT.hidden);

    // FIXED WIDTH, asserted across two different secrets rather than against
    // `MASKED_VALUE.length`, which is the mask compared to itself. A nine-
    // character PIN and a twenty-five character door code look identical.
    expect(onScreen(tree)).not.toContain(SHORT_SECRET);
    expect(SHORT_SECRET.length).not.toBe(MY_SECRET.length);
    expect(textOf(tree, `peer-vault-value-${SHORT_ITEM}`)).toBe(
      textOf(tree, `peer-vault-value-${ITEM}`),
    );

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('it appears only after a deliberate tap, and hides again', async () => {
    slots = [slot()];
    const tree = await render();

    await press(tree, `peer-vault-reveal-${ITEM}`);
    expect(onScreen(tree)).toContain(MY_SECRET);
    // Once revealed the value carries itself; the stand-in label is gone, so
    // VoiceOver reads the value rather than "Value hidden".
    expect(labelOf(tree, `peer-vault-value-${ITEM}`)).toBeUndefined();
    expect(textOf(tree, `peer-vault-value-${ITEM}`)).toBe(MY_SECRET);

    await press(tree, `peer-vault-reveal-${ITEM}`);
    expect(onScreen(tree)).not.toContain(MY_SECRET);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the announcement row’s body never reaches this screen', async () => {
    // That row IS the envelope, credential included, and it is what the vault
    // reads for delivery state. Only the id may be taken out of it.
    slots = [slot()];
    messageRows = [
      {
        msgId: '01MSGZ3NDEKTSV4RRFFQ69G5AB',
        peerId: PEER,
        direction: 'out',
        body: JSON.stringify({
          tcm: 'vault',
          op: 'set',
          id: ITEM,
          title: 'Wi-Fi',
          body: MY_SECRET,
          n: 1,
          k: 0,
        }),
        ts: T0,
        status: 'error',
      },
    ];
    const tree = await render();

    // The delivery state was read out of that row…
    expect(has(tree, `peer-vault-unsent-panel-${ITEM}`)).toBe(true);
    expect(texts(tree)).toContain(VAULT.unsent);
    // …and nothing else was.
    expect(onScreen(tree)).not.toContain(MY_SECRET);
    expect(onScreen(tree)).not.toContain('"tcm"');

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('the vault section — the composer', () => {
  test('both caps are counted live, and an overshoot names itself', async () => {
    const tree = await render();
    await press(tree, 'peer-vault-add');
    expect(has(tree, 'peer-vault-composer')).toBe(true);

    // From the first character, not near the limit.
    await type(tree, 'peer-vault-name-input', 'Wi-Fi');
    expect(textOf(tree, 'peer-vault-name-counter')).toBe(`5/${VAULT_TITLE_MAX}`);
    expect(textOf(tree, 'peer-vault-value-counter')).toBe(`0/${VAULT_BODY_MAX}`);

    await type(tree, 'peer-vault-name-input', 'x'.repeat(VAULT_TITLE_MAX + 1));
    expect(textOf(tree, 'peer-vault-name-counter')).toBe('1 over');

    await type(tree, 'peer-vault-value-input', 'k'.repeat(VAULT_BODY_MAX + 412));
    expect(textOf(tree, 'peer-vault-value-counter')).toBe('412 over');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the field is never clipped, so a pasted key is not silently truncated', async () => {
    const tree = await render();
    await press(tree, 'peer-vault-add');
    // A maxLength here would produce a credential that looks right and is
    // wrong; the send path refuses instead.
    expect(byId(tree, 'peer-vault-value-input')[0].props.maxLength).toBeUndefined();
    expect(byId(tree, 'peer-vault-name-input')[0].props.maxLength).toBeUndefined();
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a credential is never handed to the keyboard', async () => {
    // The other end of the masking property, and the one that does not undo
    // itself when the screen closes. React Native's defaults are autocorrect
    // ON, spell-check ON and autoCapitalize "sentences"; on iOS all three run
    // through the UIKit text input system, which learns typed words into the
    // personal keyboard dictionary, offers them back in the QuickType bar and
    // syncs that dictionary across the iCloud account. A door code typed here
    // would be suggested back inside somebody else's app.
    //
    // `autoCapitalize` is also a correctness rule: "sentences" turns a typed
    // lowercase password into a capitalised one on BOTH phones — a credential
    // that looks right and is wrong, which is the same failure the missing
    // maxLength above exists to avoid.
    const tree = await render();
    await press(tree, 'peer-vault-add');

    for (const id of ['peer-vault-name-input', 'peer-vault-value-input']) {
      const props = byId(tree, id)[0].props;
      expect(props.autoCorrect).toBe(false);
      expect(props.spellCheck).toBe(false);
      expect(props.autoCapitalize).toBe('none');
      expect(props.autoComplete).toBe('off');
      expect(props.textContentType).toBe('none');
    }

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a refusal renders against the field it names, and only that field', async () => {
    const cases = [
      { field: 'body', reason: 'too-long', limit: VAULT_BODY_MAX },
      { field: 'title', reason: 'empty', limit: VAULT_TITLE_MAX },
      { field: 'body', reason: 'envelope', limit: VAULT_BODY_MAX },
      { field: 'title', reason: 'too-long', limit: VAULT_TITLE_MAX },
    ] as const;

    for (const c of cases) {
      const tree = await render();
      jest
        .spyOn(messaging, 'saveVaultItem')
        .mockRejectedValue(new VaultItemRefusedError(c.field, c.reason));

      await press(tree, 'peer-vault-add');
      await type(tree, 'peer-vault-name-input', 'Wi-Fi');
      await type(tree, 'peer-vault-value-input', MY_SECRET);
      await press(tree, 'peer-vault-save');

      const mine = c.field === 'title' ? 'name' : 'value';
      const other = c.field === 'title' ? 'value' : 'name';
      expect(has(tree, `peer-vault-${mine}-error`)).toBe(true);
      // One box named, never both: two errors would tell somebody staring at
      // two fields nothing about which one to fix.
      expect(has(tree, `peer-vault-${other}-error`)).toBe(false);
      expect(texts(tree)).toContain(vaultRefusal(c.field, c.reason, c.limit));

      const refusal = vaultRefusal(c.field, c.reason, c.limit);
      if (c.reason === 'too-long') expect(refusal).toContain(String(c.limit));

      // The composer stays open on a refusal — the typed value is not thrown
      // away by the thing that refused it.
      expect(has(tree, 'peer-vault-composer')).toBe(true);
      expect(byId(tree, 'peer-vault-value-input')[0].props.value).toBe(MY_SECRET);

      // THE SENTENCE IS A FUNCTION OF (field, reason, limit) AND NOTHING ELSE.
      // Type a completely different credential, refuse it again, and the words
      // on screen are byte-identical — which is the assertion `expect(refusal)
      // .not.toContain(MY_SECRET)` looked like it was making and could not: a
      // pure function of three parameters, none of them the value, cannot fail
      // it for any mutation of its body. The value belongs in the field the
      // person is looking at, never in a string that gets announced aloud,
      // logged, and sometimes copied.
      const OTHER_SECRET = 'ZEBRA7-A-DIFFERENT-CODE-4471';
      await type(tree, 'peer-vault-value-input', OTHER_SECRET);
      await press(tree, 'peer-vault-save');
      expect(texts(tree)).toContain(refusal);
      expect(texts(tree).join(' ')).not.toContain(OTHER_SECRET);
      expect(texts(tree).join(' ')).not.toContain(MY_SECRET);

      await ReactTestRenderer.act(() => tree.unmount());
      jest.restoreAllMocks();
      jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
      jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
    }
  });

  test('typing in a field clears that field’s refusal', async () => {
    const tree = await render();
    jest
      .spyOn(messaging, 'saveVaultItem')
      .mockRejectedValue(new VaultItemRefusedError('title', 'empty'));
    await press(tree, 'peer-vault-add');
    await press(tree, 'peer-vault-save');
    expect(has(tree, 'peer-vault-name-error')).toBe(true);

    await type(tree, 'peer-vault-name-input', 'W');
    expect(has(tree, 'peer-vault-name-error')).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a save carries what was typed, and an edit carries the id', async () => {
    const save = jest.spyOn(messaging, 'saveVaultItem').mockResolvedValue(ITEM);
    const tree = await render();

    await press(tree, 'peer-vault-add');
    await type(tree, 'peer-vault-name-input', 'Wi-Fi');
    await type(tree, 'peer-vault-value-input', MY_SECRET);
    await press(tree, 'peer-vault-save');

    // No id on a create: `saveVaultItem` mints the ULID.
    expect(save).toHaveBeenCalledWith(PEER, {
      title: 'Wi-Fi',
      body: MY_SECRET,
    });
    expect(has(tree, 'peer-vault-composer')).toBe(false);

    // An edit is the same call with the existing id — a forgotten id would
    // create a second item rather than change this one.
    slots = [slot()];
    await ReactTestRenderer.act(async () => {});
    const again = await render();
    await press(again, `peer-vault-edit-${ITEM}`);
    await type(again, 'peer-vault-value-input', 'a-new-code');
    await press(again, 'peer-vault-save');
    expect(save).toHaveBeenLastCalledWith(PEER, {
      id: ITEM,
      title: 'Wi-Fi',
      body: 'a-new-code',
    });

    await ReactTestRenderer.act(() => tree.unmount());
    await ReactTestRenderer.act(() => again.unmount());
  });
});

describe('the vault section — a contested item', () => {
  /** Neither writer had seen the other: both ackSeq 0, both seq 1, contents
   * differ. That is exactly `contested`, and it is the one state in which the
   * losing value has NOT been blanked.
   *
   * THE TWO TITLES DIFFER ON PURPOSE. They used to be identical, which made
   * every assertion about which title a Keep carries vacuous: taking the
   * collapse winner's name instead of the chosen slot's passed just as well.
   * The two sides can disagree about the name as well as the value, so the
   * fixture disagrees about both. */
  function contestedSlots(): db.VaultSlotRow[] {
    return [
      slot({ writerId: ME_ID, seq: 1, ackSeq: 0, title: 'Wi-Fi', body: MY_SECRET }),
      slot({
        writerId: PEER,
        seq: 1,
        ackSeq: 0,
        title: 'Wi-Fi (guest)',
        body: THEIR_SECRET,
      }),
    ];
  }

  test('the fixture really is contested — otherwise everything below is vacuous', () => {
    const item = db.collapseVaultSlots(contestedSlots());
    expect(item?.contested).toBe(true);
  });

  test('BOTH values are shown, labelled by author, and neither is unmasked', async () => {
    slots = contestedSlots();
    const tree = await render();

    expect(has(tree, `peer-vault-contested-panel-${ITEM}`)).toBe(true);
    const shown = texts(tree);
    expect(shown).toContain(VAULT.contested);
    expect(shown).toContain(VAULT.yours);
    expect(shown).toContain(VAULT.theirs('Sam'));

    // Both slots have a value node…
    expect(has(tree, `peer-vault-slot-value-${ITEM}-${ME_ID}`)).toBe(true);
    expect(has(tree, `peer-vault-slot-value-${ITEM}-${PEER}`)).toBe(true);
    // …each under its OWN name, because the two sides can disagree about that
    // too and Keep takes the name with the value.
    expect(textOf(tree, `peer-vault-slot-name-${ITEM}-${ME_ID}`)).toBe('Wi-Fi');
    expect(textOf(tree, `peer-vault-slot-name-${ITEM}-${PEER}`)).toBe(
      'Wi-Fi (guest)',
    );
    // …and NO single unlabelled one. Drawing the collapse's winner with no
    // marker is the silent coin flip this whole design exists to prevent.
    expect(has(tree, `peer-vault-value-${ITEM}`)).toBe(false);
    expect(has(tree, `peer-vault-copy-${ITEM}`)).toBe(false);

    // Still credentials: both masked, neither spoken.
    expect(onScreen(tree)).not.toContain(MY_SECRET);
    expect(onScreen(tree)).not.toContain(THEIR_SECRET);
    for (const label of spoken(tree)) {
      expect(label).not.toContain(MY_SECRET);
      expect(label).not.toContain(THEIR_SECRET);
    }

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('revealing one side does not reveal the other', async () => {
    slots = contestedSlots();
    const tree = await render();

    await press(tree, `peer-vault-slot-reveal-${ITEM}-${PEER}`);
    expect(onScreen(tree)).toContain(THEIR_SECRET);
    expect(onScreen(tree)).not.toContain(MY_SECRET);

    await press(tree, `peer-vault-slot-reveal-${ITEM}-${ME_ID}`);
    expect(onScreen(tree)).toContain(MY_SECRET);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a reservation is never offered as a third value', async () => {
    // `deleted === 2` is a counter being held while a frame is composed. It is
    // not a value, and the sentinel is module-private — the screen asks
    // `listVaultContenders` rather than hardcoding a 2.
    slots = [
      ...contestedSlots(),
      slot({ writerId: 'someone-else', seq: 3, deleted: 2, body: 'RESERVED' }),
    ];
    const tree = await render();
    expect(has(tree, `peer-vault-slot-value-${ITEM}-someone-else`)).toBe(false);
    expect(onScreen(tree)).not.toContain('RESERVED');
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('THE RESOLUTION: one ordinary write, and it dominates on both phones', async () => {
    const save = jest.spyOn(messaging, 'saveVaultItem').mockResolvedValue(ITEM);
    const remove = jest
      .spyOn(messaging, 'deleteVaultItem')
      .mockResolvedValue(undefined);
    slots = contestedSlots();
    const tree = await render();

    await press(tree, `peer-vault-keep-${ITEM}-${PEER}`);

    // EXACTLY ONE WRITE, never a delete followed by a set: two frames leave a
    // window in which the peer's item is simply gone.
    expect(save).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    // The EXISTING id — a forgotten one creates a second item and leaves the
    // contested one contested — and THEIR strings, BOTH of them, because Keep
    // takes the name as well as the value. The fixture's two names differ, so
    // taking the collapse winner's title here would fail rather than pass by
    // coincidence.
    expect(save).toHaveBeenCalledWith(PEER, {
      id: ITEM,
      title: 'Wi-Fi (guest)',
      body: THEIR_SECRET,
    });
    // The screen does not compute `k`. There is no parameter for it, and there
    // must not be: an inflated one hides a live disagreement.
    expect(Object.keys(save.mock.calls[0][1])).toEqual(['id', 'title', 'body']);

    // NOW THE PROPERTY THE TAP CLAIMS. `dispatchVaultWrite` derives the frame's
    // `k` from the peer's slot seq and floors the reservation at the peer's
    // ackSeq, so the slot this write produces is (n = max(mine.seq, floor) + 1,
    // k = theirs.seq). Feed that back through the REAL collapse.
    const theirs = contestedSlots().find(s => s.writerId === PEER)!;
    const mine = contestedSlots().find(s => s.writerId === ME_ID)!;
    const resolved: db.VaultSlotRow = {
      ...mine,
      seq: Math.max(mine.seq, theirs.ackSeq) + 1,
      ackSeq: theirs.seq,
      title: 'Wi-Fi (guest)',
      body: THEIR_SECRET,
    };

    // Strict dominance, by construction rather than by luck.
    expect(db.vaultSlotDominates(resolved, theirs)).toBe(true);
    expect(db.vaultSlotDominates(theirs, resolved)).toBe(false);

    // …so the flag clears and the kept value is the one on screen. Asserted in
    // both slot orders, because convergence is the claim that order cannot
    // matter — this is what the OTHER phone computes too.
    for (const pair of [
      [resolved, theirs],
      [theirs, resolved],
    ]) {
      const after = db.collapseVaultSlots(pair);
      expect(after?.contested).toBe(false);
      expect(after?.body).toBe(THEIR_SECRET);
      // The name they chose travels with the value they chose.
      expect(after?.title).toBe('Wi-Fi (guest)');
    }

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an undelivered contested item is never offered "Send again"', async () => {
    // Both panels can be true at once: my write committed locally from
    // onEnqueued, its send then exhausted MAX_SEND_ATTEMPTS, and their write
    // arrived without having seen mine.
    const save = jest.spyOn(messaging, 'saveVaultItem').mockResolvedValue(ITEM);
    slots = contestedSlots();
    messageRows = [
      {
        msgId: '01MSGZ3NDEKTSV4RRFFQ69G5AB',
        peerId: PEER,
        direction: 'out',
        body: JSON.stringify({
          tcm: 'vault',
          op: 'set',
          id: ITEM,
          title: 'Wi-Fi',
          body: MY_SECRET,
          n: 1,
          k: 0,
        }),
        ts: T0,
        status: 'error',
      },
    ];
    const tree = await render();

    // The item is still contested and the delivery still failed…
    expect(has(tree, `peer-vault-contested-panel-${ITEM}`)).toBe(true);
    expect(has(tree, `peer-vault-unsent-panel-${ITEM}`)).toBe(true);

    // …and there is NO control that re-sends it. "Send again" re-dispatches
    // the stored value, which for a contested item is the collapse's
    // deterministic winner — a string nobody on this screen has been shown.
    // One tap would publish it to both phones and let `blankSupersededSlots`
    // destroy the other: the silent coin flip, arriving through the back door.
    expect(has(tree, `peer-vault-retry-${ITEM}`)).toBe(false);
    expect(texts(tree)).toContain(VAULT.unsentContested);
    // The thing that tap would have sent really is a live credential.
    const winner = db.collapseVaultSlots(contestedSlots());
    expect([MY_SECRET, THEIR_SECRET]).toContain(winner?.body);

    // Keep is still there, and it is a write — so choosing repairs the
    // delivery and the disagreement in one frame.
    await press(tree, `peer-vault-keep-${ITEM}-${PEER}`);
    expect(save).toHaveBeenCalledWith(PEER, {
      id: ITEM,
      title: 'Wi-Fi (guest)',
      body: THEIR_SECRET,
    });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the contested row’s spoken labels name the side AND the item', async () => {
    slots = contestedSlots();
    const tree = await render();

    // "Show the value of Your value" is what reusing the row's label produced,
    // and four identical labels across two contested items is what it produced
    // next. Each one names whose value it is and which item it belongs to.
    expect(labelOf(tree, `peer-vault-slot-reveal-${ITEM}-${ME_ID}`)).toBe(
      VAULT.showSlotLabel(VAULT.yoursSpoken, 'Wi-Fi'),
    );
    expect(labelOf(tree, `peer-vault-slot-reveal-${ITEM}-${PEER}`)).toBe(
      VAULT.showSlotLabel(VAULT.theirsSpoken('Sam'), 'Wi-Fi (guest)'),
    );
    expect(labelOf(tree, `peer-vault-keep-${ITEM}-${ME_ID}`)).toBe(
      VAULT.keepLabel(VAULT.yoursSpoken, 'Wi-Fi'),
    );
    expect(labelOf(tree, `peer-vault-keep-${ITEM}-${PEER}`)).toBe(
      VAULT.keepLabel(VAULT.theirsSpoken('Sam'), 'Wi-Fi (guest)'),
    );

    // Four controls, four different sentences.
    const four = [
      labelOf(tree, `peer-vault-slot-reveal-${ITEM}-${ME_ID}`),
      labelOf(tree, `peer-vault-slot-reveal-${ITEM}-${PEER}`),
      labelOf(tree, `peer-vault-keep-${ITEM}-${ME_ID}`),
      labelOf(tree, `peer-vault-keep-${ITEM}-${PEER}`),
    ];
    expect(new Set(four).size).toBe(4);
    // None of them says a credential out loud in a room with people in it.
    for (const label of four) {
      expect(label).not.toContain(MY_SECRET);
      expect(label).not.toContain(THEIR_SECRET);
    }

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('keeping MY value dominates just as hard — the tiebreak favours nobody', async () => {
    const save = jest.spyOn(messaging, 'saveVaultItem').mockResolvedValue(ITEM);
    slots = contestedSlots();
    const tree = await render();

    await press(tree, `peer-vault-keep-${ITEM}-${ME_ID}`);
    expect(save).toHaveBeenCalledWith(PEER, {
      id: ITEM,
      title: 'Wi-Fi',
      body: MY_SECRET,
    });

    const theirs = contestedSlots().find(s => s.writerId === PEER)!;
    const mine = contestedSlots().find(s => s.writerId === ME_ID)!;
    const resolved: db.VaultSlotRow = {
      ...mine,
      seq: Math.max(mine.seq, theirs.ackSeq) + 1,
      ackSeq: theirs.seq,
      body: MY_SECRET,
    };
    const after = db.collapseVaultSlots([theirs, resolved]);
    expect(after?.contested).toBe(false);
    expect(after?.body).toBe(MY_SECRET);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('the vault section — the rest of the surface', () => {
  test('an empty vault invites the first item rather than apologising', async () => {
    const tree = await render();

    expect(has(tree, 'peer-vault-invite')).toBe(true);
    const shown = texts(tree);
    expect(shown).toContain(VAULT.invite);
    expect(shown).toContain(VAULT.status(0));
    // The action names the first step rather than a generic Add.
    expect(labelOf(tree, 'peer-vault-add')).toBe(VAULT.addFirst);
    expect(shown).toContain(VAULT.addFirst);
    expect(shown).not.toContain(VAULT.add);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the consequence is in the open; "what this is" is behind the toggle', async () => {
    slots = [slot()];
    const tree = await render();

    // Tier one — the retention increase and the pasteboard, above the controls.
    const open = texts(tree).join(' ');
    expect(open).toContain('kept until one of you removes it');
    expect(open).toContain('pasteboard');

    // Tier two — not dumped on the screen.
    for (const line of VAULT_LIMITS) expect(texts(tree)).not.toContain(line);
    await press(tree, 'peer-vault-explain');
    for (const line of VAULT_LIMITS) expect(texts(tree)).toContain(line);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Copy hands the value to the pasteboard and says where it went', async () => {
    slots = [slot()];
    const tree = await render();

    await press(tree, `peer-vault-copy-${ITEM}`);
    expect(Clipboard.setString).toHaveBeenCalledWith(MY_SECRET);
    // The one place this app hands a credential to software it does not
    // control, so it says so rather than flashing a checkmark.
    expect(texts(tree)).toContain(VAULT.copied);
    // Copying does not unmask.
    expect(textOf(tree, `peer-vault-value-${ITEM}`)).toBe(MASKED_VALUE);
    expect(onScreen(tree)).not.toContain(MY_SECRET);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Remove is two steps with three ways out, and names its consequence', async () => {
    const remove = jest
      .spyOn(messaging, 'deleteVaultItem')
      .mockResolvedValue(undefined);
    slots = [slot()];
    const tree = await render();

    expect(has(tree, `peer-vault-remove-confirm-${ITEM}`)).toBe(false);
    await press(tree, `peer-vault-remove-${ITEM}`);

    expect(texts(tree)).toContain(VAULT.removeQuestion('Wi-Fi'));
    expect(texts(tree)).toContain(VAULT.removeBody);
    // Three controls, never two.
    expect(has(tree, `peer-vault-remove-confirm-${ITEM}`)).toBe(true);
    expect(has(tree, `peer-vault-remove-cancel-${ITEM}`)).toBe(true);
    // The confirm does not repeat the word that opened it.
    expect(VAULT.removeConfirm).not.toBe(VAULT.remove);

    await press(tree, `peer-vault-remove-cancel-${ITEM}`);
    expect(remove).not.toHaveBeenCalled();

    await press(tree, `peer-vault-remove-${ITEM}`);
    await press(tree, `peer-vault-remove-confirm-${ITEM}`);
    expect(remove).toHaveBeenCalledWith(PEER, ITEM);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an unverified safety number stops the write and says which one', async () => {
    jest
      .spyOn(messaging, 'saveVaultItem')
      .mockRejectedValue(
        new Error('safety number changed — verify and accept it before sending'),
      );
    const tree = await render();

    await press(tree, 'peer-vault-add');
    await type(tree, 'peer-vault-name-input', 'Wi-Fi');
    await type(tree, 'peer-vault-value-input', MY_SECRET);
    await press(tree, 'peer-vault-save');

    expect(has(tree, 'peer-vault-error')).toBe(true);
    expect(texts(tree)).toContain(VAULT.safetyChanged);
    // Not swallowed into a generic failure — this one is not a retry.
    expect(texts(tree)).not.toContain(VAULT.failed);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a blocked Room says why it sends nothing, and still reads', async () => {
    blockedAt.at = T0;
    slots = [slot()];
    const tree = await render();

    // The sentence, not just a dead control.
    expect(has(tree, 'peer-vault-blocked')).toBe(true);
    expect(texts(tree)).toContain(VAULT.blocked);
    // Every control that would put a frame on the wire is off…
    expect(byId(tree, 'peer-vault-add')[0].props.disabled).toBe(true);
    expect(byId(tree, `peer-vault-edit-${ITEM}`)[0].props.disabled).toBe(true);
    expect(byId(tree, `peer-vault-remove-${ITEM}`)[0].props.disabled).toBe(true);
    // …and the ones that touch only this phone are not. What was already
    // saved is already here; hiding it would punish them twice.
    expect(byId(tree, `peer-vault-reveal-${ITEM}`)[0].props.disabled).toBeFalsy();
    await press(tree, `peer-vault-reveal-${ITEM}`);
    expect(onScreen(tree)).toContain(MY_SECRET);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a REMOVAL that never reached them says so, and can be repaired', async () => {
    // The failure with nowhere to live: the item is a tombstone here, so
    // `listVaultItems` hides it and there is no row left to hang a warning on.
    // Silence would mean "Remove from both phones" removed it from one.
    const remove = jest
      .spyOn(messaging, 'deleteVaultItem')
      .mockResolvedValue(undefined);
    slots = [slot({ deleted: 1, title: '', body: '' })];
    messageRows = [
      // The save that DID arrive, credential and all — this row is the vault's
      // write-ahead log and stays in the chat.
      {
        msgId: '01MSGZ3NDEKTSV4RRFFQ69G5AB',
        peerId: PEER,
        direction: 'out',
        body: JSON.stringify({
          tcm: 'vault',
          op: 'set',
          id: ITEM,
          title: 'Wi-Fi',
          body: MY_SECRET,
          n: 1,
          k: 0,
        }),
        ts: T0,
        status: 'sent',
      },
      // …and the removal that did not. Last row for the id wins, which is what
      // makes a successful repair clear this without anything remembering.
      {
        msgId: '01MSGZ3NDEKTSV4RRFFQ69G5AC',
        peerId: PEER,
        direction: 'out',
        body: JSON.stringify({ tcm: 'vault', op: 'del', id: ITEM, n: 2, k: 0 }),
        ts: T0 + 1000,
        status: 'error',
      },
    ];
    const tree = await render();

    // The item is gone from the list, and the failure is not.
    expect(has(tree, `peer-vault-item-${ITEM}`)).toBe(false);
    expect(has(tree, `peer-vault-unsent-removal-${ITEM}`)).toBe(true);
    expect(texts(tree)).toContain(VAULT.removeUnsent);
    // Reading those rows for a status does not bring their contents along.
    expect(onScreen(tree)).not.toContain(MY_SECRET);
    expect(onScreen(tree)).not.toContain('"tcm"');

    // The repair is the removal again — never a save, which would put the
    // credential back on the wire to delete it.
    await press(tree, `peer-vault-retry-removal-${ITEM}`);
    expect(remove).toHaveBeenCalledWith(PEER, ITEM);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed SAVE keeps its warning on the row it belongs to', async () => {
    // The counterpart of the test above: an id whose latest failed frame was a
    // `set` and whose item is still here gets the in-row panel, not the
    // removal one — the two failures have different repairs.
    slots = [slot()];
    messageRows = [
      {
        msgId: '01MSGZ3NDEKTSV4RRFFQ69G5AB',
        peerId: PEER,
        direction: 'out',
        body: JSON.stringify({
          tcm: 'vault',
          op: 'set',
          id: ITEM,
          title: 'Wi-Fi',
          body: MY_SECRET,
          n: 1,
          k: 0,
        }),
        ts: T0,
        status: 'error',
      },
    ];
    const save = jest.spyOn(messaging, 'saveVaultItem').mockResolvedValue(ITEM);
    const tree = await render();

    expect(has(tree, `peer-vault-unsent-panel-${ITEM}`)).toBe(true);
    expect(has(tree, `peer-vault-unsent-removal-${ITEM}`)).toBe(false);

    await press(tree, `peer-vault-retry-${ITEM}`);
    // A vault write, not `sendText` on the announcement row's body.
    expect(save).toHaveBeenCalledWith(PEER, {
      id: ITEM,
      title: 'Wi-Fi',
      body: MY_SECRET,
    });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a removal the peer wrote over is not reported as an unsent save', async () => {
    // My `del` never arrived and their later `set` did, so the item is live
    // here again. The local truth is "this item exists": there is nothing to
    // repair, and an in-row "Send again" would offer to re-publish a VALUE on
    // the strength of a failed removal.
    slots = [slot()];
    messageRows = [
      {
        msgId: '01MSGZ3NDEKTSV4RRFFQ69G5AC',
        peerId: PEER,
        direction: 'out',
        body: JSON.stringify({ tcm: 'vault', op: 'del', id: ITEM, n: 2, k: 0 }),
        ts: T0,
        status: 'error',
      },
    ];
    const tree = await render();

    expect(has(tree, `peer-vault-item-${ITEM}`)).toBe(true);
    expect(has(tree, `peer-vault-unsent-panel-${ITEM}`)).toBe(false);
    // Nor the removal panel, which is for ids with no item left.
    expect(has(tree, `peer-vault-unsent-removal-${ITEM}`)).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('VoiceOver hears the copy notice once per copy — not twice, not never', async () => {
    // `InlineNotice` announces its own message in an effect, because iOS has
    // no live regions. The tap used to announce it as well, so VoiceOver read
    // the whole sentence twice; deleting that call without passing `seq` would
    // have gone the other way, and a second Copy of the SAME item would say
    // nothing at all because the notice is already mounted with the same text.
    const said = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});
    // React Native's own jest preset already mocks this method, and `spyOn`
    // over an existing mock hands back that mock with its call log intact — so
    // without this the count starts at whatever every earlier test in the file
    // announced (vault.copy.test.ts:156-159 has the same footnote).
    said.mockClear();
    slots = [slot()];
    const tree = await render();
    const times = () =>
      said.mock.calls.filter(c => c[0] === VAULT.copied).length;

    await press(tree, `peer-vault-copy-${ITEM}`);
    expect(times()).toBe(1);

    await press(tree, `peer-vault-copy-${ITEM}`);
    expect(times()).toBe(2);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the copy notice leaves when what it promises has happened', async () => {
    slots = [slot()];
    const tree = await render();
    // Armed under fake timers, so the minute can pass without waiting one.
    jest.spyOn(Clipboard, 'getString').mockResolvedValue('');
    jest.useFakeTimers();

    await press(tree, `peer-vault-copy-${ITEM}`);
    expect(texts(tree)).toContain(VAULT.copied);

    // "Tacendum clears the pasteboard in a minute" stops being true a minute
    // later, so the sentence goes with it rather than sitting there in the
    // present tense over an empty pasteboard.
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(PASTEBOARD_TTL_MS);
    });
    expect(texts(tree)).not.toContain(VAULT.copied);

    await ReactTestRenderer.act(() => tree.unmount());
    jest.useRealTimers();
  });

  test('a failed removal says removal, not save', async () => {
    jest
      .spyOn(messaging, 'deleteVaultItem')
      .mockRejectedValue(new Error('nope'));
    slots = [slot()];
    const tree = await render();

    await press(tree, `peer-vault-remove-${ITEM}`);
    await press(tree, `peer-vault-remove-confirm-${ITEM}`);

    expect(texts(tree)).toContain(VAULT.removeFailed);
    expect(texts(tree)).not.toContain(VAULT.failed);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed write says so — a vault write changes what THEY hold', async () => {
    jest
      .spyOn(messaging, 'saveVaultItem')
      .mockRejectedValue(new Error('the disk fell off'));
    const tree = await render();

    await press(tree, 'peer-vault-add');
    await type(tree, 'peer-vault-name-input', 'Wi-Fi');
    await type(tree, 'peer-vault-value-input', MY_SECRET);
    await press(tree, 'peer-vault-save');

    expect(texts(tree)).toContain(VAULT.failed);
    // An internal message is never rendered raw.
    expect(onScreen(tree)).not.toContain('the disk fell off');

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
