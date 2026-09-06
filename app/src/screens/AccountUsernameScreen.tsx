import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as accountsUsername from '../accountsUsername';
import { ACCOUNTS_USERNAME_COPY } from '../accountsUsernameCopy';
import * as db from '../db';
import { useKeyboardInset } from '../keyboardInset';
import { onUsernameNotice } from '../linking';
import { useTheme } from '../theme';
import { USERNAME_UI_ENABLED } from '../usernameUi';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import {
  InlineError,
  InlineNotice,
  PrimaryButton,
  RuledLabel,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';

interface Props {
  onBack: () => void;
  /** Opens the email surface from the "Link an email" door beside the
   * no-identifier sentence. Optional: without it the sentence stands
   * alone, exactly as it did. */
  onOpenAccountEmail?: () => void;
}

/**
 * Username claims, renames, unlinking, and discovery consent use their own copy
 * and state machine. USERNAME_UI_ENABLED gates this screen and its entry.
 *
 * Validate syntax and reserved names locally before spending a claim attempt.
 * The 72-hour age requirement comes from this device's server-issued ID and
 * gates the button;
 * verified email or phone requirements remain server-enforced because another
 * device may hold a verification this device has not mirrored. The server's
 * 409 means taken; its 403 deliberately collapses all other refusal reasons.
 * A transport failure gets separate connection copy.
 *
 * A claim explicitly sends consent, defaulting on but permitting off. Renaming
 * preserves existing consent. The username is a discovery label, never a
 * display name; render the local value because the server stores only a keyed
 * hash. The disclosure explains this limitation without claiming the server
 * cannot infer the name. Revocation clears the local row and leaves a fixed,
 * reasonless notice for the owner to dismiss.
 */
export function AccountUsernameScreen({ onBack, onOpenAccountEmail }: Props) {
  const t = useTheme();
  const keyboardInset = useKeyboardInset();
  const [identifier, setIdentifier] = useState<db.UsernameIdentifierRow | null>(null);
  const [revoked, setRevoked] = useState<db.UsernameNoticeRow | null>(null);
  const [hasPossessionIdentifier, setHasPossessionIdentifier] = useState(true);
  // The age gate, counted from the server-minted ID: the ID is
  // kept and the hours are DERIVED at render, so the clock tick below can
  // move them — null = unknown, quiet; 0 = open; n = hours still to wait,
  // said under the button it disables.
  const [profileId, setProfileId] = useState<string | null>(null);
  // THIS device's memory of the unlink it performed: seeded
  // once from its row at mount, then moved by this screen's own verbs — the
  // unlink sets it, a successful claim clears it. Never re-read on refresh: it is
  // not account state a sibling can move, it is what this device did.
  const [unlinked, setUnlinked] = useState<db.UsernameUnlinkRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  // The consent-at-claim checkbox: DEFAULT CHECKED for a claim.
  // Plain component state, per visit — the wire carries the bit explicitly
  // on every claim/rename, so nothing here is ever implied. A rename seeds
  // it from the row's CURRENT findability (below), so every path back to
  // CLAIM mode — keep, unlink, a revocation landing mid-rename — must put
  // the default back: a claim form opened after a rename of an unfindable
  // name would otherwise inherit `false` and send it as if chosen.
  const [consent, setConsent] = useState(true);

  /** Read by the system-back handler, which is registered once and must see
   * what is open at the moment of the press, not at subscription. */
  const unlinkRef = useRef(false);
  unlinkRef.current = confirmingUnlink;

  useEffect(() => {
    // Android Back dismisses the unlink confirmation before the router leaves
    // this screen. A rename holds typed input and consent, so it remains a
    // draft handled by normal route navigation, not a dismissible question.
    // React Native asks the newest listener first; this screen mounts after
    // the router. Return false when there is no confirmation to close. The
    // ref keeps the once-registered handler current. BackHandler is inert on
    // iOS, so registration is unconditional.
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (!unlinkRef.current) return false;
        setConfirmingUnlink(false);
        return true;
      },
    );
    return () => subscription.remove();
  }, []);

  const refresh = useCallback(() => {
    void Promise.all([
      db.loadUsernameIdentifier(),
      db.loadUsernameNotice(),
      db.loadAccountIdentifier().catch(() => null),
      db.loadPhoneIdentifier().catch(() => null),
      db.loadProfile().catch(() => null),
    ])
      .then(([row, notice, email, phone, profile]) => {
        setIdentifier(row);
        setRevoked(notice);
        setHasPossessionIdentifier(email?.email != null || phone?.phone != null);
        setProfileId(profile?.userId ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    db.loadUsernameUnlink()
      .then(row => setUnlinked(row))
      .catch(() => undefined);
  }, []);
  // A revocation landing while this surface is open re-reads the row and
  // the notice — the recovery-notice precedent (LinkedDevicesScreen). The
  // row is gone, so a rename under way is moot: the form falls back to
  // CLAIM mode with the claim default, never the renamed row's old bit.
  useEffect(
    () =>
      onUsernameNotice(() => {
        setRenaming(false);
        setConsent(true);
        refresh();
      }),
    [refresh],
  );

  const run = useCallback(
    (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      void work()
        .catch(() => setError(ACCOUNTS_USERNAME_COPY.tryLater))
        .finally(() => {
          setBusy(false);
          refresh();
        });
    },
    [refresh],
  );

  /** The local syntax and reserved-name checks use this
   * device's own knowledge, rendered as the person types — never a wire
   * call, and never a repair. Empty is quiet, not wrong. */
  const localCheck =
    nameDraft.trim() === '' ? null : accountsUsername.checkUsernameLocally(nameDraft);
  const localMessage =
    localCheck === 'invalid'
      ? ACCOUNTS_USERNAME_COPY.invalid
      : localCheck === 'reserved'
        ? ACCOUNTS_USERNAME_COPY.reserved
        : null;

  const submit = () =>
    run(async () => {
      const outcome = await accountsUsername.claimUsername(nameDraft, consent);
      switch (outcome) {
        case 'claimed':
        case 'renamed':
          setNameDraft('');
          setRenaming(false);
          // A successful claim ends the unlink memory (the module cleared the row).
          setUnlinked(null);
          return;
        case 'taken':
          setError(ACCOUNTS_USERNAME_COPY.taken);
          return;
        case 'invalid':
          setError(ACCOUNTS_USERNAME_COPY.invalid);
          return;
        case 'reserved':
          setError(ACCOUNTS_USERNAME_COPY.reserved);
          return;
        case 'failed':
          setError(ACCOUNTS_USERNAME_COPY.failed);
          return;
        case 'refused':
          // The frozen 403 — global limit, budget, gate, cool-down alike:
          // one generic sentence that never says why.
          setError(ACCOUNTS_USERNAME_COPY.tryLater);
          return;
      }
    });

  const toggleDiscoverable = (on: boolean) =>
    run(async () => {
      const outcome = await accountsUsername.setUsernameDiscoverable(on);
      if (outcome !== 'ok') {
        setError(
          outcome === 'failed'
            ? ACCOUNTS_USERNAME_COPY.failed
            : ACCOUNTS_USERNAME_COPY.tryLater,
        );
      }
    });

  const unlink = () =>
    run(async () => {
      const letGo = identifier?.username ?? null;
      const outcome = await accountsUsername.unlinkUsername();
      setConfirmingUnlink(false);
      if (outcome !== 'ok') {
        setError(
          outcome === 'failed'
            ? ACCOUNTS_USERNAME_COPY.failed
            : ACCOUNTS_USERNAME_COPY.tryLater,
        );
        return;
      }
      // The row is gone: the next form is a CLAIM, with the claim default —
      // and it carries the cool-down warning, because this device knows
      // what it just did (the module persisted the same memory).
      setRenaming(false);
      setConsent(true);
      if (letGo !== null) setUnlinked({ username: letGo, unlinkedAt: Date.now() });
    });

  const dismissRevoked = () =>
    run(async () => {
      await db.clearUsernameNotice();
    });

  const claimWaitHours =
    profileId === null ? null : accountsUsername.usernameClaimWaitHours(profileId, Date.now());
  // THE AGE GATE IS THIS DEVICE'S OWN TRUTH: the server counts the CALLER's
  // createdAt, which the ULID carries — so the claim button waits it out
  // rather than inviting a tap the wire can only refuse with the same
  // reasonless 403. The identifier precondition is NOT enforced here: it is
  // group-level, and a sibling may hold the verification this device has
  // not mirrored. A wait that ends while the screen is open must re-enable
  // the button on its own: the RecoveryScreen clock tick, capped at 60 s so
  // a long wait costs a trivial timer.
  const claimGateClosed = claimWaitHours !== null && claimWaitHours > 0;
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (profileId === null || !claimGateClosed) return;
    const opensAt = accountsUsername.usernameClaimOpensAtMs(profileId);
    if (opensAt === null) return;
    const timer = setTimeout(
      () => setClockTick(n => n + 1),
      Math.max(250, Math.min(opensAt - Date.now() + 250, 60_000)),
    );
    return () => clearTimeout(timer);
  });

  // Gate the screen itself so programmatic navigation cannot expose disabled
  // username features.
  if (!USERNAME_UI_ENABLED) return null;

  const held = identifier !== null;
  const showForm = loaded && (!held || renaming);

  const form = (
    <>
      <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
        {ACCOUNTS_USERNAME_COPY.formatNote}
      </Text>
      <TextInput
        value={nameDraft}
        onChangeText={next => {
          setNameDraft(next);
          setError(null);
        }}
        placeholder={ACCOUNTS_USERNAME_COPY.fieldPlaceholder}
        placeholderTextColor={t.color.inkMuted}
        keyboardAppearance={t.scheme}
        selectionColor={t.color.pine}
        accessibilityLabel={ACCOUNTS_USERNAME_COPY.title}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={64}
        testID="account-username-input"
        style={[
          t.type.input,
          styles.input,
          {
            minHeight: t.layout.buttonHeight,
            borderRadius: t.radius.button,
            backgroundColor: t.color.paperSheet,
            color: t.color.inkStrong,
            borderWidth: 1,
            borderColor: t.color.lineStrong,
          },
        ]}
      />
      {localMessage ? (
        <InlineNotice tone="quiet" message={localMessage} testID="account-username-local" />
      ) : null}
      {/* THE CONSENT-AT-CLAIM ROW: its OWN row, the
          bit explicit on the wire, default CHECKED on a claim. */}
      <Pressable
        onPress={() => setConsent(v => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consent }}
        accessibilityLabel={ACCOUNTS_USERNAME_COPY.consentLabel}
        testID="account-username-consent"
        style={[styles.consentRow, { minHeight: t.layout.touchTarget }]}
      >
        <View
          style={[
            styles.checkbox,
            {
              borderColor: consent ? t.color.pine : t.color.lineStrong,
              backgroundColor: consent ? t.color.pine : t.color.paperSheet,
            },
          ]}
        >
          {consent ? (
            <Text
              allowFontScaling={false}
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={[styles.checkmark, { color: t.color.onPine }]}
            >
              ✓
            </Text>
          ) : null}
        </View>
        <Text style={[t.type.compactBody, styles.consentText, { color: t.color.inkBody }]}>
          {ACCOUNTS_USERNAME_COPY.consentLabel}
        </Text>
      </Pressable>
      {!consent ? (
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          {/* The CLAIM form speaks of a name not yet held;
              a RENAME keeps the held sentence — the name IS held. */}
          {held ? ACCOUNTS_USERNAME_COPY.heldUnfindable : ACCOUNTS_USERNAME_COPY.claimUnfindable}
        </Text>
      ) : null}
      <PrimaryButton
        label={held ? ACCOUNTS_USERNAME_COPY.renameSubmit : ACCOUNTS_USERNAME_COPY.claim}
        onPress={submit}
        disabled={busy || localCheck !== 'ok' || (!held && claimGateClosed)}
        testID="account-username-submit"
      />
      {/* The hours sentence sits UNDER the button it disables,
          and leaves with the wait. */}
      {!held && claimGateClosed ? (
        <InlineNotice
          tone="quiet"
          message={ACCOUNTS_USERNAME_COPY.needsAge(claimWaitHours!)}
          testID="account-username-needs-age"
        />
      ) : null}
      {held ? (
        <TextAction
          label={ACCOUNTS_USERNAME_COPY.renameKeep}
          onPress={() => {
            setRenaming(false);
            setNameDraft('');
            setError(null);
            // Keep leaves nothing of the rename behind — the box included.
            setConsent(true);
          }}
          testID="account-username-rename-cancel"
        />
      ) : null}
    </>
  );

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      <ScreenHeader
        title={ACCOUNTS_USERNAME_COPY.title}
        onBack={onBack}
        testIDBack="account-username-back"
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingHorizontal: t.layout.gutter }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* THE REVOCATION NOTICE: fixed copy, reasonless
            — the row is already gone (linking.ts cleared it in every
            binary); this is where the person is told. */}
        {revoked ? (
          <View testID="account-username-revoked">
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              {ACCOUNTS_USERNAME_COPY.revokedTitle}
            </Text>
            <InlineNotice tone="quiet" message={ACCOUNTS_USERNAME_COPY.revokedBody} />
            <TextAction
              label={ACCOUNTS_USERNAME_COPY.revokedDismiss}
              onPress={dismissRevoked}
              testID="account-username-revoked-dismiss"
            />
          </View>
        ) : null}

        <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
          {ACCOUNTS_USERNAME_COPY.intro}
        </Text>
        {/* THE HONESTY COPY, behind the ⓘ in full. */}
        <InfoDisclosure
          label={ACCOUNTS_USERNAME_COPY.infoLabel}
          lines={ACCOUNTS_USERNAME_COPY.infoLines}
          testID="account-username-info"
        />

        {error ? <InlineError message={error} testID="account-username-error" /> : null}

        {/* The claim gate's preconditions, SURFACED from this device's
            own knowledge, never enforced here: the server is the gate. The
            possession-proof identifier from this device's rows; the age from
            the server-minted ID; the cool-down from the unlink this device
            performed — each its own sentence, each BEFORE the tap,
            because every refusal the wire answers is the same reasonless
            403. */}
        {loaded && !held && !hasPossessionIdentifier ? (
          <>
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.needsIdentifier}
              testID="account-username-needs-identifier"
            />
            {/* The step the sentence names, one tap away. */}
            {onOpenAccountEmail ? (
              <TextAction
                label={ACCOUNTS_USERNAME_COPY.needsIdentifierAction}
                onPress={onOpenAccountEmail}
                testID="account-username-link-email"
              />
            ) : null}
          </>
        ) : null}
        {loaded &&
        !held &&
        unlinked !== null &&
        accountsUsername.unlinkCooldownActive(unlinked, Date.now()) ? (
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink(unlinked.username)}
            testID="account-username-cooldown"
          />
        ) : null}

        {showForm ? form : null}

        {loaded && held ? (
          <>
            <Text
              style={[t.type.body, { color: t.color.inkStrong }]}
              testID="account-username-held"
            >
              {ACCOUNTS_USERNAME_COPY.held(identifier!.username)}
            </Text>
            {/* HOW others reach this name: the finder's door,
                named — only while the name is findable; the unfindable
                sentence below says the opposite and must not sit beside it. */}
            {identifier!.discoverable ? (
              <Text
                style={[t.type.compactBody, { color: t.color.inkBody }]}
                testID="account-username-how-found"
              >
                {ACCOUNTS_USERNAME_COPY.howFound}
              </Text>
            ) : null}

            {/* Username discovery consent has its own row and is never changed
                by the email or phone toggles. */}
            <RuledLabel label={ACCOUNTS_USERNAME_COPY.discoverableLabel} heading />
            <View style={styles.toggleRow}>
              <Text
                style={[t.type.compactBody, styles.toggleLabel, { color: t.color.inkBody }]}
              >
                {ACCOUNTS_USERNAME_COPY.discoverableLabel}
              </Text>
              <Switch
                value={identifier!.discoverable}
                onValueChange={toggleDiscoverable}
                disabled={busy}
                accessibilityLabel={ACCOUNTS_USERNAME_COPY.discoverableLabel}
                // Explicit theme colors keep the switch consistent on iOS.
                // Pine against inset paper gives on/off contrast of 4.8:1 in
                // light mode and 8.9:1 in dark mode, so state remains visible
                // without relying only on knob position. The ink knob is
                // legible on both tracks; pineWash would give only 1.05:1
                // contrast and make the on track lighter than the off track.
                trackColor={{ false: t.color.paperInset, true: t.color.pine }}
                thumbColor={t.color.inkStrong}
                ios_backgroundColor={t.color.paperInset}
                testID="username-discoverable-toggle"
              />
            </View>
            {!identifier!.discoverable ? (
              <InlineNotice
                tone="quiet"
                message={ACCOUNTS_USERNAME_COPY.heldUnfindable}
                testID="account-username-unfindable"
              />
            ) : null}
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              {ACCOUNTS_USERNAME_COPY.discoverableNote}
            </Text>

            {/* Rename and unlink ride this screen with the cool-down
                surfaced. */}
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              {ACCOUNTS_USERNAME_COPY.cooldownNote}
            </Text>
            {!renaming && !confirmingUnlink ? (
              <TextAction
                label={ACCOUNTS_USERNAME_COPY.rename}
                onPress={() => {
                  // A rename's box starts at the CURRENT findability: a
                  // change of name must never flip consent on its own.
                  setConsent(identifier!.discoverable);
                  setRenaming(true);
                  setError(null);
                }}
                testID="account-username-rename"
              />
            ) : null}

            {confirmingUnlink ? (
              <>
                <Text style={[t.type.body, { color: t.color.inkStrong }]}>
                  {ACCOUNTS_USERNAME_COPY.unlinkConfirm}
                </Text>
                <PrimaryButton
                  label={ACCOUNTS_USERNAME_COPY.unlink}
                  onPress={unlink}
                  disabled={busy}
                  testID="account-username-unlink-confirm"
                />
                <TextAction
                  label={ACCOUNTS_USERNAME_COPY.unlinkKeep}
                  onPress={() => setConfirmingUnlink(false)}
                  testID="account-username-unlink-cancel"
                />
              </>
            ) : !renaming ? (
              <TextAction
                label={ACCOUNTS_USERNAME_COPY.unlink}
                onPress={() => setConfirmingUnlink(true)}
                testID="account-username-unlink"
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingTop: 8, paddingBottom: 48, gap: 14 },
  input: { paddingHorizontal: 14 },
  /** The RegisterScreen consent anatomy: 22pt box, 12pt gap, text flexed. */
  consentRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: { fontSize: 14, fontWeight: '700', lineHeight: 17 },
  consentText: { flex: 1 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: { flex: 1, marginRight: 12 },
});
