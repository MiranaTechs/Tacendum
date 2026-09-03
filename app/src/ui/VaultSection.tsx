import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as db from '../db';
import { VAULT_BODY_MAX, VAULT_TITLE_MAX, parseEnvelope } from '../envelope';
import { VaultItemRefusedError, messaging } from '../messaging';
import { PASTEBOARD_TTL_MS, copyWithExpiry } from '../pasteboard';
import { useTheme } from '../theme';
import {
  MASKED_VALUE,
  VAULT,
  VAULT_CONSEQUENCE,
  VAULT_ENVELOPE_PREFIX,
  VAULT_LIMITS,
  VAULT_RELOAD_DEBOUNCE_MS,
  VAULT_REVEAL_MS,
  vaultRefusal,
  vaultStatusTone,
} from '../vault';
import { InlineError, InlineNotice, PrimaryButton, TextAction } from './primitives';

/**
 * THE SHARED ROOM VAULT, on the peer profile.
 *
 * Another stacked section in the profile's column, with the same anatomy as
 * Blocking and Disappearing messages above it — header, status rule,
 * explanation, action — because it is the same kind of thing: a per-person
 * setting that belongs to this conversation. There is no tab bar in this app
 * and this is not the screen to introduce one.
 *
 * THE PROPERTY THIS FILE EXISTS TO HOLD: a value is never on screen until
 * somebody deliberately asks for it, and while it is masked it is not in the
 * rendered tree, not in an accessibility label, and therefore not in a
 * screenshot, not in a screen recording, and not read aloud by VoiceOver in a
 * room with other people in it. `MASKED_VALUE` is a fixed width for the same
 * reason — one bullet per character would publish the length of every
 * credential in the Room to anyone glancing at the screen.
 *
 * WHAT THIS SCREEN IS NOT ALLOWED TO DO, all three of them load-bearing:
 *  - it never resolves a disagreement locally. There is no `contested` column
 *    to clear; the flag is computed from the slots on every read, so the only
 *    thing that clears it on BOTH phones is an ordinary write. No screen may
 *    call `commitVaultSlot`, `mergeVaultSlot` or `reserveVaultSeq`;
 *  - it never computes or passes `k`. `dispatchVaultWrite` derives it and there
 *    is deliberately no parameter for it — a stale `k` only shows a settled
 *    disagreement, an inflated one hides a live one;
 *  - it never reads a value out of the announcement row in `messages`. That
 *    row's body IS the envelope, credential and all. Values come from
 *    `vault_items` and nowhere else; the one thing taken from an announcement
 *    is its item id, below.
 */

/**
 * THE OTHER SURFACE A CREDENTIAL MUST NOT REACH: the keyboard.
 *
 * React Native's TextInput defaults are autocorrect ON, spell-check ON and
 * `autoCapitalize="sentences"`, and on iOS all three run through the UIKit text
 * input system — which learns typed words into the user's personal keyboard
 * dictionary, offers them back in the QuickType bar, and syncs that dictionary
 * to every device signed in to the same iCloud account. A door code typed here
 * would be suggested back to this person inside somebody else's app, forever,
 * with nothing on this screen having said so. The mask keeps a value off
 * surfaces this app does not control once it is stored; this is the same
 * property on the way in. The app already treats QuickType as in scope —
 * ScreenSecurityImpl.swift tears the keyboard down before the app-switcher
 * snapshot for exactly this reason — and every other field that takes something
 * exact (StartChatScreen's peer id, ProfileScreen's name) already sets these.
 *
 * `autoCapitalize: 'none'` is not cosmetic either: a lowercase password typed
 * into a field that capitalises its first character saves a credential that
 * looks right and is wrong, on both phones. That is the same failure the
 * `maxLength` comment below refuses to permit, arriving by a different door. It
 * applies to the name too — a name is the person's own words and the app has no
 * business changing them.
 *
 * DELIBERATELY NOT `secureTextEntry`: the value field is multiline, where iOS
 * ignores it, and the composer is the one place a person is checking what they
 * typed. Masking belongs to the row, which is where a value sits when nobody is
 * editing it.
 */
const KEYBOARD_OFF = {
  autoCapitalize: 'none',
  autoCorrect: false,
  spellCheck: false,
  autoComplete: 'off',
  textContentType: 'none',
} as const;

interface Props {
  peerId: string;
  /**
   * My own account id. This is exactly what `messaging.selfWriterId()` returns
   * on the send path, so it is the value that decides whether a slot is
   * labelled "Your value" or theirs.
   */
  meUserId: string;
  /** How this person reads in a possessive ("Sam's value"). */
  who: string;
  /** When this device blocked them, or null. A blocked Room sends nothing. */
  blockedAt: number | null;
}

/**
 * Which items are saved here and never arrived there — the third thing V1
 * deferred to V3, and the only one of the four that needed a new read.
 *
 * The content of a vault write commits from `onEnqueued`, so it is durable on
 * this phone the moment the outbox row lands. If the send then exhausts
 * MAX_SEND_ATTEMPTS the envelope is deleted and the message row is marked
 * `error`, and `reconcileLocalState` skips `error` rows — so the item reads as
 * saved here and the other phone never heard about it. Nothing on any screen
 * said so, because there was no screen.
 *
 * The signal is the announcement row's status, which lives in a different
 * table from the item, so it has to be joined here. THE ONLY FIELDS TAKEN FROM
 * THE ENVELOPE ARE `id` AND `op`: the rest of that body is the credential in
 * plaintext, and it must not reach a rendered string, a label, or the
 * pasteboard. `op` is 'set' or 'del' and carries no content — it is here
 * because a save that never arrived and a REMOVAL that never arrived are
 * different failures with different repairs, and a removal has no row left to
 * hang a warning on (`listVaultItems` hides tombstones), so it would otherwise
 * be the one failure this screen stayed silent about after a button that said
 * "Remove from both phones".
 *
 * `listMessages` orders by (ts, msgId), so the last vault row for an id is the
 * latest attempt — which is what makes this self-clearing. A successful resend
 * appends a newer row, the map keeps that one, and the warning goes away
 * without anything having to remember it was ever shown.
 */
type StuckOp = 'set' | 'del';

async function undeliveredVaultIds(
  peerId: string,
): Promise<Map<string, StuckOp>> {
  const rows = await db.listMessages(peerId);
  const latest = new Map<string, { status: db.MessageStatus; op: StuckOp }>();
  for (const row of rows) {
    // Prefix first, parse second: a thread of photos, voice notes and text
    // used to be fully parsed on every notification for the
    // one-in-a-hundred vault row. The prefix is exactly the sentinel
    // `parseEnvelope` itself requires, so nothing parseable is skipped.
    if (row.direction !== 'out' || !row.body.startsWith(VAULT_ENVELOPE_PREFIX)) continue;
    const envelope = parseEnvelope(row.body);
    if (envelope?.tcm !== 'vault') continue;
    latest.set(envelope.id, { status: row.status, op: envelope.op });
  }
  const stuck = new Map<string, StuckOp>();
  for (const [id, last] of latest) {
    if (last.status === 'error') stuck.set(id, last.op);
  }
  return stuck;
}

export function VaultSection({ peerId, meUserId, who, blockedAt }: Props) {
  const t = useTheme();
  const [items, setItems] = useState<db.VaultItemRow[]>([]);
  /** Both live values of a contested item, by item id. Read only for the items
   * that are actually contested — every other item has exactly one. */
  const [contenders, setContenders] = useState<Map<string, db.VaultSlotRow[]>>(
    new Map(),
  );
  const [undelivered, setUndelivered] = useState<Map<string, StuckOp>>(
    new Map(),
  );
  /**
   * What is currently unmasked. Keyed by item id, and by `id:writerId` for the
   * two halves of a contested item, so revealing one side of a disagreement
   * does not reveal the other. Never persisted: every render of this screen
   * starts masked.
   */
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState<{
    id?: string;
    title: string;
    body: string;
  } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [errSeq, setErrSeq] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  /**
   * Which item was just copied, and how many copies ago that was — ONE piece of
   * state, not two. `InlineNotice` announces its message in an effect keyed on
   * (message, seq), because iOS has no live regions; splitting the id and the
   * counter into two `useState`s let a render land between them, and the effect
   * then fired twice for one tap. VoiceOver reading a whole sentence twice is
   * the bug this replaced.
   */
  const [copied, setCopied] = useState<{ id: string; seq: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [valueFocused, setValueFocused] = useState(false);
  /** Set while this screen is mounted, so a load that resolves after a peer
   * change or an unmount cannot write a different Room's items into state. */
  const alive = useRef(true);
  /** One re-mask timer per revealed key: cleared when the key is hidden by
   * hand, on peer change, on backgrounding, and on unmount. */
  const revealTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** The coalescing timer for messaging notifications. */
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideKey = useCallback((key: string) => {
    const timer = revealTimers.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    revealTimers.current.delete(key);
    setShown(open => {
      if (!open.has(key)) return open;
      const next = new Set(open);
      next.delete(key);
      return next;
    });
  }, []);

  const hideAll = useCallback(() => {
    for (const timer of revealTimers.current.values()) clearTimeout(timer);
    revealTimers.current.clear();
    setShown(open => (open.size === 0 ? open : new Set()));
  }, []);

  const load = useCallback(async () => {
    const rows = await db.listVaultItems(peerId);
    const pairs = await Promise.all(
      rows
        .filter(row => row.contested)
        .map(
          async row =>
            [row.id, await db.listVaultContenders(peerId, row.id)] as const,
        ),
    );
    const stuck = await undeliveredVaultIds(peerId);
    if (!alive.current) return;
    setItems(rows);
    setContenders(new Map(pairs));
    setUndelivered(stuck);
  }, [peerId]);

  useEffect(() => {
    alive.current = true;
    // The Map itself is never reassigned, so the cleanup may hold it directly
    // (the exhaustive-deps rule's own remedy for a ref read at cleanup).
    const timers = revealTimers.current;
    // A masked value must not survive a change of person, and neither must a
    // half-typed one: both belong to the Room that was on screen a moment ago.
    hideAll();
    setComposing(null);
    setRemoving(null);
    setCopied(null);
    setNameError(null);
    setValueError(null);
    setFailure(null);
    void load().catch(() => {});
    // The other phone can save, edit or remove an item while this is open, and
    // an inbound merge notifies exactly like an outbound enqueue does. The
    // subscription is GLOBAL, though — a typing frame, a read mark, a message
    // in some other Room all land here — so a burst is coalesced into one
    // re-read per quiet beat. The mount read above and the post-write read in
    // `runWrite` stay immediate: those are this screen's own acts, and their
    // answer should not wait.
    const off = messaging.subscribe(() => {
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        void load().catch(() => {});
      }, VAULT_RELOAD_DEBOUNCE_MS);
    });
    return () => {
      alive.current = false;
      off();
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
      reloadTimer.current = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [load, hideAll]);

  // A revealed value must not be on glass when the app comes back from the
  // switcher, the lock screen or a call: re-mask the moment the app leaves
  // the foreground — 'inactive' included, which is when iOS takes the
  // app-switcher snapshot.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'background' || next === 'inactive') hideAll();
    });
    return () => subscription.remove();
  }, [hideAll]);

  const blocked = blockedAt != null;
  const tone = vaultStatusTone(items.length);

  /**
   * Every vault write goes through here, and every one of them surfaces its
   * failure. This is `runBlockWrite`'s side of the split PeerProfileScreen
   * documents, not `write`'s: a vault write changes what the OTHER phone holds,
   * so a silent failure would leave someone believing a door code was shared
   * when it was not.
   *
   * The refusal is rendered against the field it names. `VaultItemRefusedError`
   * carries `field`, `reason` and `limit` and deliberately never carries the
   * value, so there is enough to write a real sentence and nothing to leak.
   * Matched by `name` as well as `instanceof`, for the reason messaging.ts
   * gives about module mocks.
   */
  const runWrite = async (
    work: () => Promise<void>,
    fallback: string = VAULT.failed,
  ) => {
    setBusy(true);
    setNameError(null);
    setValueError(null);
    setFailure(null);
    setCopied(null);
    try {
      await work();
    } catch (err) {
      const e = err as Partial<VaultItemRefusedError> & { name?: string; message?: string };
      if (e?.name === 'VaultItemRefusedError' && e.field && e.reason && e.limit) {
        const message = vaultRefusal(e.field, e.reason, e.limit);
        if (e.field === 'title') setNameError(message);
        else setValueError(message);
      } else if (e?.name === 'BlockedPeerError') {
        setFailure(VAULT.blocked);
      } else if (/safety number/i.test(e?.message ?? '')) {
        // Deliberately not caught by messaging (messaging.ts:1147-1149): a
        // vault write is the last thing that should go quietly to a key nobody
        // has checked. Matched on the message because the send path throws a
        // plain Error; the sentence shown is this deck's, not that string's.
        setFailure(VAULT.safetyChanged);
      } else {
        setFailure(fallback);
      }
      setErrSeq(n => n + 1);
    } finally {
      setBusy(false);
      await load().catch(() => {});
    }
  };

  const saveComposed = () => {
    const draft = composing;
    if (!draft) return;
    return runWrite(async () => {
      await messaging.saveVaultItem(peerId, {
        ...(draft.id ? { id: draft.id } : {}),
        title: draft.title,
        body: draft.body,
      });
      if (alive.current) setComposing(null);
    });
  };

  const removeItem = (id: string) =>
    runWrite(async () => {
      await messaging.deleteVaultItem(peerId, id);
      if (alive.current) setRemoving(null);
    }, VAULT.removeFailed);

  /**
   * ONE-TAP RESOLUTION, and it is an ordinary write.
   *
   * Choosing their value means republishing their string under MY writer id —
   * there is no "select their slot" operation and there must not be one. The
   * write reserves a counter above their `ackSeq` and carries `k` = their
   * `seq`, so it strictly dominates their slot by construction rather than by
   * luck: `collapseVaultSlots` then returns it with `contested: false` here,
   * and the same frame does the same on their phone. Exactly one write, never
   * a delete followed by a set.
   *
   * The two strings are captured from state BEFORE the tap, because the write
   * that resolves this is also the write that lets `blankSupersededSlots` wipe
   * the value that lost.
   */
  const keepValue = (item: db.VaultItemRow, slot: db.VaultSlotRow) => {
    const title = slot.title;
    const body = slot.body;
    return runWrite(async () => {
      await messaging.saveVaultItem(peerId, { id: item.id, title, body });
    });
  };

  /**
   * Re-dispatches a vault write — never `sendText` on the announcement row's
   * body, which is the envelope. Same path as any other save, so the counter
   * and the ack are derived the same way.
   *
   * OFFERED FOR A CONTESTED ITEM: never. `item.body` there is the collapse's
   * deterministic winner, a string this screen deliberately refuses to draw,
   * and sending it would publish a value nobody chose to both phones and let
   * `blankSupersededSlots` destroy the other. The panel says so and points at
   * Keep, which is a write and therefore repairs the delivery too. The guard is
   * at the call site AND stated here because the two are far apart on screen.
   */
  const resend = (item: db.VaultItemRow) =>
    runWrite(async () => {
      await messaging.saveVaultItem(peerId, {
        id: item.id,
        title: item.title,
        body: item.body,
      });
    });

  /**
   * The same repair for a removal, which has no item left to re-send: the
   * tombstone is the local state, so this re-dispatches the `del` itself.
   * `deleteVaultItem` carries no title and no value, so nothing about the
   * credential goes back on the wire to delete it.
   */
  const resendRemoval = (id: string) =>
    runWrite(async () => {
      await messaging.deleteVaultItem(peerId, id);
    }, VAULT.removeFailed);

  /** Reveal for `VAULT_REVEAL_MS`, then re-mask on its own; hiding by hand
   * cancels the window, and a fresh reveal gets a fresh one. */
  const toggleShown = (key: string) => {
    if (shown.has(key)) {
      hideKey(key);
      return;
    }
    const timer = setTimeout(() => hideKey(key), VAULT_REVEAL_MS);
    revealTimers.current.set(key, timer);
    setShown(open => new Set(open).add(key));
  };

  const copyValue = (item: db.VaultItemRow) => {
    copyWithExpiry(item.body);
    // No announce call here: `InlineNotice` says its own message. The bumped
    // `seq` is what makes a SECOND copy of the same item speak at all — the
    // notice is already mounted with identical text, and without it the effect
    // has nothing to notice.
    setCopied(prev => ({ id: item.id, seq: (prev?.seq ?? 0) + 1 }));
  };

  /**
   * The notice promises something with a deadline — "Tacendum clears the
   * pasteboard in a minute" — so it stops being true a minute later. It leaves
   * exactly when the thing it describes happens, rather than sitting there in
   * the present tense over a pasteboard that is already empty.
   */
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), PASTEBOARD_TTL_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <View style={styles.section}>
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {VAULT.title}
      </Text>

      <View style={styles.statusRow}>
        <View
          style={[styles.statusRule, { backgroundColor: t.color[tone.rule] }]}
        />
        <Text
          style={[t.type.utilityLabel, { color: t.color[tone.ink] }]}
          testID="peer-vault-status"
        >
          {VAULT.status(items.length)}
        </Text>
      </View>

      {/* A blocked Room sends nothing, so every control that would put a frame
          on the wire is disabled — and a disabled control with no sentence
          beside it is the app refusing without saying why. The items stay
          readable: what was already saved is already on this phone, and
          hiding it would be a second punishment for a decision about them. */}
      {blocked ? (
        <Text
          testID="peer-vault-blocked"
          style={[
            t.type.compactBody,
            styles.explainerLine,
            { color: t.color.inkBody },
          ]}
        >
          {VAULT.blocked}
        </Text>
      ) : null}

      {items.length === 0 ? (
        // An invitation, not an apology: it names the things people actually
        // keep re-asking each other for, in their words.
        <Text
          testID="peer-vault-invite"
          style={[
            t.type.compactBody,
            styles.explainerLine,
            { color: t.color.inkBody },
          ]}
        >
          {VAULT.invite}
        </Text>
      ) : null}

      {/* TIER ONE: the consequence, ABOVE the controls — what keeping a thing
          here costs, and what leaves the app on a Copy. It used to sit at the
          bottom of the section, which put it under the item list, under the
          composer and under Save: tapping "Add the first item" with the
          keyboard up pushed both sentences off screen, so a first credential
          could be saved without the retention increase ever having been
          visible. RegisterScreen's consent card puts the trade above the
          button it arms for the same reason, and the section's own anatomy — header, status
          rule, explanation, action — wants the explanation here. */}
      {VAULT_CONSEQUENCE.map(line => (
        <Text
          key={line}
          style={[
            t.type.compactBody,
            styles.explainerLine,
            { color: t.color.inkMuted },
          ]}
        >
          {line}
        </Text>
      ))}

      {items.map(item => {
        const open = shown.has(item.id);
        const pair = contenders.get(item.id) ?? [];
        return (
          <View
            key={item.id}
            testID={`peer-vault-item-${item.id}`}
            style={[
              styles.item,
              {
                backgroundColor: t.color.paperSheet,
                borderColor: t.color.lineSoft,
                // A card is a SURFACE, so it takes the app's surface weight —
                // QrPanel's hairline and drawer radius — rather than the 1pt
                // outline this palette uses for controls. `radius.small` is
                // documented in theme.ts as reaction annotations.
                borderWidth: t.hairline,
                borderRadius: t.radius.drawer,
              },
            ]}
          >
            <Text
              style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
              testID={`peer-vault-name-${item.id}`}
            >
              {item.title}
            </Text>

            {/* A CONTESTED ITEM HAS NO SINGLE VALUE, so it is not given one.
                The collapse still picks a deterministic winner for storage, but
                drawing that winner here with no marker is precisely the silent
                coin flip this whole design exists to prevent — and Copy would
                have to pick one too. Both values are below instead, labelled by
                whoever wrote them, and the row's actions come back once one has
                been kept. */}
            {item.contested ? null : (
              <>
                <Text
                  selectable={open}
                  testID={`peer-vault-value-${item.id}`}
                  style={[
                    open ? t.type.utilityData : t.type.body,
                    styles.value,
                    { color: open ? t.color.inkStrong : t.color.inkMuted },
                  ]}
                  {...(open ? {} : { accessibilityLabel: VAULT.hidden })}
                >
                  {open ? item.body : MASKED_VALUE}
                </Text>
                <View style={styles.itemActions}>
                  <RowAction
                    label={open ? VAULT.hide : VAULT.show}
                    a11y={
                      open
                        ? VAULT.hideLabel(item.title)
                        : VAULT.showLabel(item.title)
                    }
                    onPress={() => toggleShown(item.id)}
                    testID={`peer-vault-reveal-${item.id}`}
                  />
                  <RowAction
                    label={VAULT.copy}
                    a11y={VAULT.copyLabel(item.title)}
                    onPress={() => copyValue(item)}
                    testID={`peer-vault-copy-${item.id}`}
                  />
                  <RowAction
                    label={VAULT.edit}
                    a11y={VAULT.editLabel(item.title)}
                    disabled={busy || blocked}
                    onPress={() => {
                      setRemoving(null);
                      setNameError(null);
                      setValueError(null);
                      setComposing({
                        id: item.id,
                        title: item.title,
                        body: item.body,
                      });
                    }}
                    testID={`peer-vault-edit-${item.id}`}
                  />
                  <RowAction
                    label={VAULT.remove}
                    a11y={VAULT.removeLabel(item.title)}
                    disabled={busy || blocked}
                    onPress={() => {
                      setComposing(null);
                      setRemoving(item.id);
                    }}
                    testID={`peer-vault-remove-${item.id}`}
                  />
                </View>
              </>
            )}

            {copied?.id === item.id ? (
              <InlineNotice
                message={VAULT.copied}
                tone="pine"
                seq={copied.seq}
                testID={`peer-vault-copied-${item.id}`}
              />
            ) : null}

            {/* BOTH VALUES, LABELLED BY AUTHOR. `contested` is true exactly
                when neither writer had seen the other and the two differ, and
                it is the one state in which `blankSupersededSlots` has NOT run
                — so both strings are guaranteed to still be on disk here. */}
            {item.contested ? (
              <View
                testID={`peer-vault-contested-panel-${item.id}`}
                style={[
                  styles.panel,
                  {
                    backgroundColor: t.color.paperLayer,
                    borderLeftColor: t.color.warningMark,
                  },
                ]}
              >
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  {VAULT.contested}
                </Text>
                <Text
                  style={[
                    t.type.compactBody,
                    styles.panelLine,
                    { color: t.color.inkBody },
                  ]}
                >
                  {VAULT.contestedBody}
                </Text>
                <Text
                  style={[
                    t.type.compactBody,
                    styles.panelLine,
                    { color: t.color.inkBody },
                  ]}
                >
                  {VAULT.contestedChoose}
                </Text>
                {pair.map(slot => {
                  const key = `${item.id}:${slot.writerId}`;
                  const seen = shown.has(key);
                  const mine = slot.writerId === meUserId;
                  const whose = mine ? VAULT.yours : VAULT.theirs(who);
                  // The spoken form is a second string rather than this one
                  // reused: "Show the value of Your value" is what reusing it
                  // produced, and four identical labels across two contested
                  // items is what it produced next. The item's name goes in
                  // every one of them.
                  const said = mine ? VAULT.yoursSpoken : VAULT.theirsSpoken(who);
                  return (
                    <View key={slot.writerId} style={styles.contender}>
                      <Text
                        style={[
                          t.type.utilityLabel,
                          { color: t.color.inkMuted },
                        ]}
                      >
                        {whose}
                      </Text>
                      {/* The two sides can disagree about the NAME as well as
                          the value, and Keep takes both — so both are shown. */}
                      <Text
                        style={[
                          t.type.bodyStrong,
                          styles.contenderName,
                          { color: t.color.inkStrong },
                        ]}
                        testID={`peer-vault-slot-name-${item.id}-${slot.writerId}`}
                      >
                        {slot.title}
                      </Text>
                      <Text
                        selectable={seen}
                        testID={`peer-vault-slot-value-${item.id}-${slot.writerId}`}
                        style={[
                          seen ? t.type.utilityData : t.type.body,
                          styles.value,
                          { color: seen ? t.color.inkStrong : t.color.inkMuted },
                        ]}
                        {...(seen ? {} : { accessibilityLabel: VAULT.hidden })}
                      >
                        {seen ? slot.body : MASKED_VALUE}
                      </Text>
                      <View style={styles.itemActions}>
                        <RowAction
                          label={seen ? VAULT.hide : VAULT.show}
                          a11y={
                            seen
                              ? VAULT.hideSlotLabel(said, slot.title)
                              : VAULT.showSlotLabel(said, slot.title)
                          }
                          onPress={() => toggleShown(key)}
                          testID={`peer-vault-slot-reveal-${item.id}-${slot.writerId}`}
                        />
                        <RowAction
                          label={VAULT.keep}
                          a11y={VAULT.keepLabel(said, slot.title)}
                          disabled={busy || blocked}
                          onPress={() => void keepValue(item, slot)}
                          testID={`peer-vault-keep-${item.id}-${slot.writerId}`}
                        />
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/* A SAVE that never arrived. `=== 'set'` rather than `.has`: a
                failed REMOVAL leaves no row here to hang a warning on, and it
                gets its own panel below the list. A failed `del` whose item is
                still listed means the peer's later save won it back, so the
                local state is "this item is live" and there is nothing to
                repair. */}
            {undelivered.get(item.id) === 'set' ? (
              <View
                testID={`peer-vault-unsent-panel-${item.id}`}
                style={[
                  styles.panel,
                  {
                    backgroundColor: t.color.paperLayer,
                    borderLeftColor: t.color.warningMark,
                  },
                ]}
              >
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  {VAULT.unsent}
                </Text>
                <Text
                  style={[
                    t.type.compactBody,
                    styles.panelLine,
                    { color: t.color.inkBody },
                  ]}
                >
                  {VAULT.unsentBody}
                </Text>
                {/* NO "Send again" WHILE CONTESTED. `item.body` is the
                    collapse's winner, which is the one string on this screen
                    nobody has been shown; re-sending it would resolve the
                    disagreement to a value the person never saw and let the
                    other be blanked. Keep, above, is itself a write, so
                    choosing repairs the delivery in the same frame. */}
                {item.contested ? (
                  <Text
                    testID={`peer-vault-unsent-contested-${item.id}`}
                    style={[
                      t.type.compactBody,
                      styles.panelLine,
                      { color: t.color.inkBody },
                    ]}
                  >
                    {VAULT.unsentContested}
                  </Text>
                ) : (
                  <View style={styles.itemActions}>
                    <RowAction
                      label={VAULT.retry}
                      a11y={VAULT.retryLabel(item.title)}
                      disabled={busy || blocked}
                      onPress={() => void resend(item)}
                      testID={`peer-vault-retry-${item.id}`}
                    />
                  </View>
                )}
              </View>
            ) : null}

            {/* Removing a credential from two phones is irreversible, so it
                gets the outline-red step and three controls, never two. The
                confirm names its consequence and does not repeat the word that
                opened it. */}
            {removing === item.id ? (
              <View style={styles.confirm}>
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  {VAULT.removeQuestion(item.title)}
                </Text>
                <Text
                  style={[
                    t.type.compactBody,
                    styles.panelLine,
                    { color: t.color.inkBody },
                  ]}
                >
                  {VAULT.removeBody}
                </Text>
                <DangerAction
                  label={VAULT.removeConfirm}
                  onPress={() => void removeItem(item.id)}
                  disabled={busy}
                  testID={`peer-vault-remove-confirm-${item.id}`}
                />
                <View style={styles.confirmOut}>
                  <TextAction
                    label={VAULT.cancel}
                    onPress={() => setRemoving(null)}
                    disabled={busy}
                    testID={`peer-vault-remove-cancel-${item.id}`}
                  />
                </View>
              </View>
            ) : null}
          </View>
        );
      })}

      {/* A REMOVAL THAT NEVER ARRIVED, which has nothing above to attach to:
          the item is a tombstone here, so `listVaultItems` hides it and the
          only thing left of it is a failed announcement row. Silence here is
          the worst kind this section can produce — the button said "Remove from
          both phones" and one of the two still has it. Unnamed on purpose: a
          tombstone drops the title along with the value, and inventing a name
          would mean keeping one, which is the thing removal was for. */}
      {[...undelivered]
        .filter(([id, op]) => op === 'del' && !items.some(item => item.id === id))
        .map(([id]) => id)
        .sort()
        .map(id => (
          <View
            key={id}
            testID={`peer-vault-unsent-removal-${id}`}
            style={[
              styles.panel,
              {
                backgroundColor: t.color.paperLayer,
                borderLeftColor: t.color.warningMark,
              },
            ]}
          >
            <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
              {VAULT.removeUnsent}
            </Text>
            <Text
              style={[
                t.type.compactBody,
                styles.panelLine,
                { color: t.color.inkBody },
              ]}
            >
              {VAULT.removeUnsentBody}
            </Text>
            <View style={styles.itemActions}>
              <RowAction
                label={VAULT.retryRemoval}
                disabled={busy || blocked}
                onPress={() => void resendRemoval(id)}
                testID={`peer-vault-retry-removal-${id}`}
              />
            </View>
          </View>
        ))}

      {composing ? (
        <View style={styles.composer} testID="peer-vault-composer">
          <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
            {composing.id ? VAULT.editTitle : VAULT.composeTitle}
          </Text>

          <FieldHeader
            label={VAULT.nameLabel}
            used={composing.title.length}
            max={VAULT_TITLE_MAX}
            testID="peer-vault-name-counter"
          />
          <TextInput
            value={composing.title}
            onChangeText={title => {
              setNameError(null);
              setComposing(draft => (draft ? { ...draft, title } : draft));
            }}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
            editable={!busy}
            {...KEYBOARD_OFF}
            placeholder={VAULT.namePlaceholder}
            placeholderTextColor={t.color.inkMuted}
            accessibilityLabel={VAULT.nameLabel}
            testID="peer-vault-name-input"
            style={[
              t.type.input,
              styles.field,
              {
                borderRadius: t.radius.button,
                color: t.color.inkStrong,
                backgroundColor: t.color.paperSheet,
                borderColor: nameError
                  ? t.color.danger
                  : nameFocused
                    ? t.color.pine
                    : t.color.lineStrong,
                borderWidth: nameError || nameFocused ? 2 : 1,
              },
            ]}
          />
          {nameError ? (
            <InlineError
              message={nameError}
              seq={errSeq}
              testID="peer-vault-name-error"
            />
          ) : null}

          <FieldHeader
            label={VAULT.valueLabel}
            used={composing.body.length}
            max={VAULT_BODY_MAX}
            testID="peer-vault-value-counter"
            marginTop={16}
          />
          <TextInput
            value={composing.body}
            onChangeText={body => {
              setValueError(null);
              setComposing(draft => (draft ? { ...draft, body } : draft));
            }}
            onFocus={() => setValueFocused(true)}
            onBlur={() => setValueFocused(false)}
            editable={!busy}
            multiline
            {...KEYBOARD_OFF}
            placeholder={VAULT.valuePlaceholder}
            placeholderTextColor={t.color.inkMuted}
            accessibilityLabel={VAULT.valueLabel}
            testID="peer-vault-value-input"
            style={[
              t.type.input,
              styles.field,
              styles.valueField,
              {
                borderRadius: t.radius.button,
                color: t.color.inkStrong,
                backgroundColor: t.color.paperSheet,
                borderColor: valueError
                  ? t.color.danger
                  : valueFocused
                    ? t.color.pine
                    : t.color.lineStrong,
                borderWidth: valueError || valueFocused ? 2 : 1,
              },
            ]}
          />
          {valueError ? (
            <InlineError
              message={valueError}
              seq={errSeq}
              testID="peer-vault-value-error"
            />
          ) : null}

          {/* SAVE IS NOT DISABLED ON A LONG VALUE, and that is deliberate. The
              caps belong to `assertVaultItemFits`, which refuses before an id
              is minted, a counter is reserved or the ratchet moves — one place
              decides. Re-implementing the rule here to grey out a button would
              make two places decide, and the day they disagree the person is
              told nothing at all. So the counter warns while typing, and the
              refusal above says which box and by how much. Nor is the field
              given a `maxLength`: silently clipping a pasted SSH key produces a
              credential that looks right and is wrong. */}
          <PrimaryButton
            label={VAULT.save}
            onPress={() => void saveComposed()}
            disabled={busy}
            testID="peer-vault-save"
            style={styles.action}
          />
          <View style={styles.confirmOut}>
            <TextAction
              label={VAULT.cancel}
              onPress={() => {
                setComposing(null);
                setNameError(null);
                setValueError(null);
              }}
              disabled={busy}
              testID="peer-vault-cancel"
            />
          </View>
        </View>
      ) : (
        <View style={styles.addOut}>
          <TextAction
            label={items.length === 0 ? VAULT.addFirst : VAULT.add}
            onPress={() => {
              setRemoving(null);
              setNameError(null);
              setValueError(null);
              setFailure(null);
              setComposing({ title: '', body: '' });
            }}
            disabled={busy || blocked}
            testID="peer-vault-add"
          />
        </View>
      )}

      {failure ? (
        <InlineError message={failure} seq={errSeq} testID="peer-vault-error" />
      ) : null}

      {/* TIER TWO: "what this is", behind the QrPanel affordance. The
          consequence above the list is not optional reading; this is. */}
      <View style={styles.explainOut}>
        <TextAction
          label={VAULT.explainToggle}
          onPress={() => setExplain(o => !o)}
          testID="peer-vault-explain"
        />
      </View>
      {explain
        ? VAULT_LIMITS.map(line => (
            <Text
              key={line}
              style={[
                t.type.compactBody,
                styles.explainerLine,
                { color: t.color.inkMuted },
              ]}
            >
              {line}
            </Text>
          ))
        : null}
    </View>
  );
}

/**
 * A field's label and its live count, on one line.
 *
 * The count is shown from the first character rather than appearing near the
 * limit, because a person pasting a key wants to know the cap exists BEFORE
 * they find out they are past it. Over the cap it names the overshoot instead
 * of the total: "412 over" is the number to act on; "8604/8192" is arithmetic
 * homework.
 */
function FieldHeader({
  label,
  used,
  max,
  testID,
  marginTop = 12,
}: {
  label: string;
  used: number;
  max: number;
  testID: string;
  marginTop?: number;
}) {
  const t = useTheme();
  const over = used > max;
  return (
    <View style={[styles.fieldHeader, { marginTop }]}>
      <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
        {label}
      </Text>
      <Text
        testID={testID}
        style={[
          t.type.counter,
          { color: over ? t.color.danger : t.color.inkMuted },
        ]}
      >
        {over ? VAULT.over(used - max) : VAULT.counter(used, max)}
      </Text>
    </View>
  );
}

/**
 * A compact pine text action inside a vault row. Local for the same reason
 * PeerProfileScreen's three are: it exists for one section, it takes a
 * REQUIRED testID because every instance is addressable, and it takes an
 * explicit accessibility label because "Show" four times over tells VoiceOver
 * nothing about which item is being shown.
 */
function RowAction({
  label,
  a11y,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  a11y?: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      style={({ pressed }) => [
        styles.rowAction,
        { minHeight: t.layout.touchTarget, borderRadius: t.radius.button },
        pressed && !disabled && { backgroundColor: t.color.pineWash },
      ]}
    >
      <Text
        style={[
          t.type.buttonCompact,
          { color: disabled ? t.color.inkMuted : t.color.pine },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The outline-red step. Removing an item clears the value on both phones and
 * there is no undo, which is the one thing this palette reserves red for. An
 * outline rather than a fill, for the reason PeerProfileScreen states: a
 * destructive step is a considered answer, not the page's happy path.
 */
function DangerAction({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      style={({ pressed }) => [
        styles.dangerAction,
        {
          minHeight: t.layout.buttonHeight,
          borderRadius: t.radius.button,
          borderWidth: 1,
          borderColor: disabled ? t.color.lineSoft : t.color.danger,
          backgroundColor: disabled
            ? t.color.paperInset
            : pressed
              ? t.color.dangerWash
              : 'transparent',
        },
      ]}
    >
      <Text
        style={[
          t.type.button,
          { color: disabled ? t.color.inkMuted : t.color.danger },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 28 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  statusRule: { width: 3, alignSelf: 'stretch', minHeight: 15, marginRight: 12 },
  explainerLine: { marginTop: 8 },

  item: { marginTop: 12, padding: 12 },
  value: { marginTop: 6 },
  // Negative margins keep the first label optically on the row's own padding
  // despite each pressable's 8pt of it, as the shared inline actions do.
  itemActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
    marginLeft: -8,
  },
  rowAction: { justifyContent: 'center', paddingHorizontal: 8 },

  panel: { marginTop: 12, borderLeftWidth: 3, padding: 12 },
  panelLine: { marginTop: 8 },
  contender: { marginTop: 16 },
  contenderName: { marginTop: 4 },

  composer: { marginTop: 16 },
  fieldHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  field: { marginTop: 8, minHeight: 52, paddingHorizontal: 14 },
  valueField: { minHeight: 96, paddingTop: 14, textAlignVertical: 'top' },
  action: { marginTop: 12 },
  confirm: { marginTop: 16 },
  confirmOut: { marginTop: 4, marginLeft: -8, alignSelf: 'flex-start' },
  addOut: { marginTop: 8, marginLeft: -8, alignSelf: 'flex-start' },
  explainOut: { marginTop: 4, marginLeft: -8, alignSelf: 'flex-start' },
  dangerAction: {
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
});
