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
 * Username display and eligibility rules:
 *  - the shape and the PUBLIC denylist are checked LOCALLY, live, before
 *    the wire (refused, never repaired; a reserved name never spends a
 *    claim attempt) — and each local refusal has its OWN sentence,
 *    honestly distinguishable from the server's answers;
 *  - the claim gate's possession-proof precondition is read from the
 *    server's caller-owned eligibility endpoint, so a verified identifier
 *    on a linked sibling qualifies and the action is disabled honestly;
 *  - the server answers this class with exactly TWO shapes: the frozen 409
 *    `taken` (rendered as taken) and the frozen 403 for everything else —
 *    fleet ceiling, caller budget, gate, cool-down alike — rendered as a
 *    generic "try again later" that never says why (distinguishable
 *    by status alone). A transport failure gets the connection sentence;
 *  - the consent-at-claim checkbox is DEFAULT CHECKED on a claim (a
 *    handle exists to be found), the bit rides the wire explicitly, and an
 *    unchecked claim is legal — shown honestly as held-but-unfindable. A
 *    RENAME's box starts at the current findability: changing a name must
 *    not silently flip a person from unfindable to findable;
 *  - the handle is a FINDING label, never a name layer: no `@` sigil, and
 *    the held name is rendered from this device's own row (the server
 *    stores a keyed hash and never echoes it);
 *  - the disclosure sits behind the ⓘ in full, and nothing here
 *    claims the server is blind to the name;
 *  - a `usernameRevoked` notice renders its FIXED, reasonless copy here —
 *    the parser (linking.ts) already cleared the row in every binary; this
 *    screen is where the person is told, and the dismiss clears the notice.
 */
export function AccountUsernameScreen({ onBack, onOpenAccountEmail }: Props) {
  const t = useTheme();
  const keyboardInset = useKeyboardInset();
  const [identifier, setIdentifier] = useState<db.UsernameIdentifierRow | null>(null);
  const [revoked, setRevoked] = useState<db.UsernameNoticeRow | null>(null);
  const [eligibility, setEligibility] = useState<
    'checking' | accountsUsername.UsernameEligibilityOutcome
  >('checking');
  const eligibilitySeq = useRef(0);
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
    void Promise.all([db.loadUsernameIdentifier(), db.loadUsernameNotice()])
      .then(([row, notice]) => {
        setIdentifier(row);
        setRevoked(notice);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const refreshEligibility = useCallback(() => {
    if (!USERNAME_UI_ENABLED) return;
    const mySeq = ++eligibilitySeq.current;
    setEligibility('checking');
    void accountsUsername.getUsernameEligibility().then(outcome => {
      if (eligibilitySeq.current === mySeq) setEligibility(outcome);
    });
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    refreshEligibility();
    return () => {
      eligibilitySeq.current += 1;
    };
  }, [refreshEligibility]);
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
        disabled={busy || localCheck !== 'ok' || eligibility !== 'eligible'}
        testID="account-username-submit"
      />
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

        {/* The claim/rename proof gate comes from an authoritative,
            caller-owned group read. It never describes a target and it sees
            a verified identifier held by a linked sibling. Only this form is
            disabled: consent and unlink remain usable if proof is removed. */}
        {showForm && eligibility === 'needs_verification' ? (
          <>
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.needsIdentifier}
              testID="account-username-needs-identifier"
            />
            <Text
              testID="account-username-without-verification"
              style={[t.type.compactBody, { color: t.color.inkMuted }]}
            >
              {ACCOUNTS_USERNAME_COPY.withoutVerification}
            </Text>
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
        {showForm && eligibility === 'checking' ? (
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_USERNAME_COPY.eligibilityChecking}
            testID="account-username-eligibility-checking"
          />
        ) : null}
        {showForm && eligibility === 'unavailable' ? (
          <>
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.eligibilityUnavailable}
              testID="account-username-eligibility-unavailable"
            />
            <TextAction
              label={ACCOUNTS_USERNAME_COPY.eligibilityRetry}
              onPress={refreshEligibility}
              testID="account-username-eligibility-retry"
            />
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
