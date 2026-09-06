import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as accounts from '../accounts';
import { ACCOUNTS_COPY } from '../accountsCopy';
import { ACCOUNTS_PHONE_COPY } from '../accountsPhoneCopy';
import * as db from '../db';
import { useKeyboardInset } from '../keyboardInset';
import { PHONE_UI_ENABLED } from '../phoneUi';
import { useTheme } from '../theme';
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
}

/**
 * Email attachment, verification, unlinking, discoverability, and downgrade.
 * A uniform success response does not prove delivery or server-side consent:
 * the code-sent notice describes the request, and the toggle shows this
 * device's consent record, defaulting off. Refusal copy preserves the server's
 * deliberately collapsed reasons instead of guessing which limit applied.
 */
/** Whether a code requested at `requestedAt` can still be entered: inside
 * the server's 5-minute window, and never for a clock that moved
 * backwards. */
function codeWindowOpenAt(requestedAt: number | null, now: number): boolean {
  if (requestedAt == null) return false;
  const age = now - requestedAt;
  return age >= 0 && age < accounts.PENDING_CODE_TTL_MS;
}

export function AccountEmailScreen({ onBack }: Props) {
  const t = useTheme();
  const keyboardInset = useKeyboardInset();
  const [identifier, setIdentifier] = useState<db.AccountIdentifierRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const [codeDraft, setCodeDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [confirmingDowngrade, setConfirmingDowngrade] = useState(false);
  /** When THIS mount last sent a code: the row records the same moment
   * once the refresh lands, and a duress session's row may not — so the
   * countdown starts from whichever is later. */
  const [sentAt, setSentAt] = useState<number | null>(null);

  /** Read by the system-back handler, which is registered once and must see
   * what is open at the moment of the press, not at subscription. */
  const unlinkRef = useRef(false);
  const downgradeRef = useRef(false);
  unlinkRef.current = confirmingUnlink;
  downgradeRef.current = confirmingDowngrade;

  useEffect(() => {
    // Android Back dismisses one confirmation before the router leaves this
    // screen. Both can be open, so unlinking one address takes precedence over
    // downgrading the whole account. This listener mounts after the router's;
    // React Native asks the newest listener first and stops at the first true.
    // With neither question open, return false to allow normal navigation.
    // Refs keep the once-registered handler current without resubscribing.
    // BackHandler is inert on iOS, so registration is unconditional.
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (unlinkRef.current) {
          setConfirmingUnlink(false);
          return true;
        }
        if (downgradeRef.current) {
          setConfirmingDowngrade(false);
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, []);

  const refresh = useCallback(() => {
    void db
      .loadAccountIdentifier()
      .then(row => {
        setIdentifier(row);
        // The durable pending row is this screen's context after a
        // relaunch: the address it asked for prefills an EMPTY draft —
        // never overwrites a typed one — and while the code is still inside
        // its window the code-sent notice names it again, from the row.
        if (row?.email == null && row?.pendingEmail != null) {
          const pendingEmail = row.pendingEmail;
          setEmailDraft(draft => (draft === '' ? pendingEmail : draft));
          if (codeWindowOpenAt(row.pendingRequestedAt, Date.now())) {
            setNotice(current => current ?? ACCOUNTS_COPY.emailCodeSent(pendingEmail));
          }
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);

  const run = useCallback(
    (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      void work()
        .catch(() => setError(ACCOUNTS_COPY.emailUnlinkRefused))
        .finally(() => {
          setBusy(false);
          refresh();
        });
    },
    [refresh],
  );

  const requestCode = () =>
    run(async () => {
      const outcome = await accounts.requestAttachCode(emailDraft);
      if (outcome === 'sent') {
        setSentAt(Date.now());
        setNotice(ACCOUNTS_COPY.emailCodeSent(emailDraft.trim().toLowerCase()));
      } else {
        setNotice(null);
        // A transport failure is not a refusal: nothing was checked, so
        // the refusal sentence would lie.
        setError(outcome === 'failed' ? ACCOUNTS_COPY.failed : ACCOUNTS_COPY.emailRefused);
      }
    });

  const verifyCode = () =>
    run(async () => {
      const pending = identifier?.pendingEmail;
      if (!pending) return;
      const outcome = await accounts.confirmAttach(pending, codeDraft.trim());
      if (outcome === 'attached') {
        setNotice(null);
        setCodeDraft('');
      } else {
        setError(outcome === 'failed' ? ACCOUNTS_COPY.failed : ACCOUNTS_COPY.emailRefused);
      }
    });

  const toggleDiscoverable = (on: boolean) =>
    run(async () => {
      const outcome = await accounts.setDiscoverable(on);
      if (outcome !== 'ok') setError(ACCOUNTS_COPY.discoverableFailed);
    });

  const unlink = () =>
    run(async () => {
      const outcome = await accounts.unlinkIdentifier();
      setConfirmingUnlink(false);
      if (outcome !== 'ok') setError(ACCOUNTS_COPY.emailUnlinkRefused);
    });

  const downgrade = () =>
    run(async () => {
      const outcome = await accounts.downgradeToAnonymous();
      setConfirmingDowngrade(false);
      if (outcome === 'downgraded') {
        setNotice(ACCOUNTS_COPY.downgradeDone);
      } else {
        setError(ACCOUNTS_COPY.downgradeFailed);
      }
    });

  const verified = identifier?.email != null;
  const pending = !verified && identifier?.pendingEmail != null;
  // The code field exists only while the code can still be entered: the
  // row records WHEN it asked and the server's window is 5 minutes — a
  // field for a code that expired days ago is a dead end, while "Send
  // another code" stays live from the same row.
  const codeWindowOpen =
    pending && codeWindowOpenAt(identifier?.pendingRequestedAt ?? null, Date.now());

  // The window closes while the screen is open: nothing above re-renders at
  // the boundary on its own, so a timer re-renders once it passes (the
  // RecoveryScreen clock-tick pattern; re-armed per render, at most one).
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!codeWindowOpen) return;
    const closesAt = (identifier?.pendingRequestedAt ?? 0) + accounts.PENDING_CODE_TTL_MS;
    const timer = setTimeout(
      () => setClockTick(n => n + 1),
      Math.max(250, closesAt - Date.now() + 250),
    );
    return () => clearTimeout(timer);
  });

  // THE RESEND MINUTE, counted down on the button: the server sends
  // nothing inside it and answers the same, so the button refuses visibly
  // instead of inviting the tap. From the row (it survives a remount) or
  // this mount's own send, whichever is later; one-second ticks re-render
  // the clock while it runs and stop with it.
  const resendFrom =
    Math.max(sentAt ?? 0, identifier?.pendingRequestedAt ?? 0) || null;
  const resendWait = accounts.resendWaitMs(resendFrom, Date.now());
  useEffect(() => {
    if (resendWait <= 0) return;
    const timer = setTimeout(() => setClockTick(n => n + 1), Math.min(1_000, resendWait));
    return () => clearTimeout(timer);
  });

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      <ScreenHeader
        title={ACCOUNTS_COPY.emailTitle}
        onBack={onBack}
        testIDBack="account-email-back"
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingHorizontal: t.layout.gutter }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
          {ACCOUNTS_COPY.emailIntro}
        </Text>

        {error ? <InlineError message={error} testID="account-email-error" /> : null}
        {notice ? (
          <InlineNotice tone="pine" message={notice} testID="account-email-notice" />
        ) : null}

        {loaded && !verified ? (
          <>
            <TextInput
              value={emailDraft}
              onChangeText={setEmailDraft}
              placeholder={ACCOUNTS_COPY.emailPlaceholder}
              placeholderTextColor={t.color.inkMuted}
              keyboardAppearance={t.scheme}
              selectionColor={t.color.pine}
              accessibilityLabel={ACCOUNTS_COPY.emailTitle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              testID="account-email-input"
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
            <PrimaryButton
              label={
                resendWait > 0
                  ? ACCOUNTS_COPY.requestAgainIn(accounts.formatResendClock(resendWait))
                  : pending
                    ? ACCOUNTS_COPY.emailRequestAgain
                    : ACCOUNTS_COPY.emailRequest
              }
              onPress={requestCode}
              disabled={busy || emailDraft.trim() === '' || resendWait > 0}
              testID="account-email-request"
            />
            {/* The help text behind ⓘ explains the recipient budget
                the uniform answer deliberately hides — a tap past 5/day or
                inside the minute sends nothing and answers the same, so the
                numbers sit HERE beside the button. Never in the error
                banner: the refusal stays collapsed (the server does not say
                which), and emailCodeSent's own clause says only the maybe. */}
            <InfoDisclosure
              label={ACCOUNTS_COPY.emailCodeBudgetLabel}
              lines={ACCOUNTS_COPY.emailCodeBudget}
              testID="account-email-code-budget"
            />
            {codeWindowOpen ? (
              <>
                <TextInput
                  value={codeDraft}
                  onChangeText={setCodeDraft}
                  placeholder={ACCOUNTS_COPY.codePlaceholder}
                  placeholderTextColor={t.color.inkMuted}
                  keyboardAppearance={t.scheme}
                  selectionColor={t.color.pine}
                  accessibilityLabel={ACCOUNTS_COPY.codePlaceholder}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  testID="account-email-code"
                  style={[
                    t.type.utilityData,
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
                <PrimaryButton
                  label={ACCOUNTS_COPY.emailVerify}
                  onPress={verifyCode}
                  disabled={busy || codeDraft.trim().length !== 6}
                  testID="account-email-verify"
                />
              </>
            ) : null}
          </>
        ) : null}

        {loaded && verified ? (
          <>
            <Text
              style={[t.type.body, { color: t.color.inkStrong }]}
              testID="account-email-verified"
            >
              {ACCOUNTS_COPY.emailVerified(identifier!.email!)}
            </Text>

            {/* The consent toggle — DEFAULT OFF. What it renders is the
                LOCAL consent record; the wire's 204 is uniform by design
                and is never treated as a receipt. */}
            <RuledLabel label={ACCOUNTS_COPY.discoverableTitle} heading />
            {/* The restored consent is a placeholder:
                a recovery restored the server-side consent, which this
                device cannot read back — until the owner throws the switch
                the row is a placeholder, and this sentence says so. */}
            {identifier!.restoredAt != null ? (
              <InlineNotice
                tone="quiet"
                message={ACCOUNTS_COPY.discoverableRestored}
                testID="discoverable-restored"
              />
            ) : null}
            <View style={styles.toggleRow}>
              <Text
                style={[t.type.compactBody, styles.toggleLabel, { color: t.color.inkBody }]}
              >
                {ACCOUNTS_COPY.discoverableLabel}
              </Text>
              <Switch
                value={identifier!.discoverable}
                onValueChange={toggleDiscoverable}
                disabled={busy}
                accessibilityLabel={ACCOUNTS_COPY.discoverableLabel}
                // Explicit theme colors keep the switch consistent on iOS.
                // Pine against inset paper gives on/off contrast of 4.8:1 in
                // light mode and 8.9:1 in dark mode, so state remains visible
                // without relying only on knob position. The ink knob is
                // legible on both tracks; pineWash would give only 1.05:1
                // contrast and make the on track lighter than the off track.
                trackColor={{ false: t.color.paperInset, true: t.color.pine }}
                thumbColor={t.color.inkStrong}
                ios_backgroundColor={t.color.paperInset}
                testID="discoverable-toggle"
              />
            </View>
            {/* PER-CLASS truth on the email toggle too: with the phone class live, "by this email or
                anything else" would overpromise — the feature-gated variant
                scopes the sentence to THIS class and says the per-class mirror.
                When phone UI is disabled, the email-only wording applies. */}
            <InfoDisclosure
              label={ACCOUNTS_COPY.discoverableExplainLabel}
              lines={
                PHONE_UI_ENABLED
                  ? ACCOUNTS_PHONE_COPY.emailDiscoverableExplainBoth
                  : ACCOUNTS_COPY.discoverableExplain
              }
              testID="discoverable-info"
            />

            {confirmingUnlink ? (
              <>
                <Text style={[t.type.body, { color: t.color.inkStrong }]}>
                  {ACCOUNTS_COPY.emailUnlinkConfirm(identifier!.email!)}
                </Text>
                <PrimaryButton
                  label={ACCOUNTS_COPY.emailUnlink}
                  onPress={unlink}
                  disabled={busy}
                  testID="account-email-unlink-confirm"
                />
                <TextAction
                  label="Keep it"
                  onPress={() => setConfirmingUnlink(false)}
                  testID="account-email-unlink-cancel"
                />
              </>
            ) : (
              <TextAction
                label={ACCOUNTS_COPY.emailUnlink}
                onPress={() => setConfirmingUnlink(true)}
                testID="account-email-unlink"
              />
            )}
          </>
        ) : null}

        {/* Downgrade to anonymous: offered whenever anything
            account-shaped exists to shed. */}
        <RuledLabel label={ACCOUNTS_COPY.downgradeTitle} heading />
        {/* The downgrade names every identifier it removes: it takes the
            phone claim and the local
            phone row too, so the feature-gated variant discloses the class
            pair. When phone UI is disabled, only email is named. */}
        <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
          {PHONE_UI_ENABLED
            ? ACCOUNTS_PHONE_COPY.downgradeIntroBoth
            : ACCOUNTS_COPY.downgradeIntro}
        </Text>
        {confirmingDowngrade ? (
          <>
            <Text style={[t.type.body, { color: t.color.inkStrong }]}>
              {PHONE_UI_ENABLED
                ? ACCOUNTS_PHONE_COPY.downgradeConfirmBoth
                : ACCOUNTS_COPY.downgradeConfirm}
            </Text>
            <PrimaryButton
              label={ACCOUNTS_COPY.downgradeAction}
              onPress={downgrade}
              disabled={busy}
              testID="account-downgrade-confirm"
            />
            <TextAction
              label="Keep my account as it is"
              onPress={() => setConfirmingDowngrade(false)}
              testID="account-downgrade-cancel"
            />
          </>
        ) : (
          <TextAction
            label={ACCOUNTS_COPY.downgradeAction}
            onPress={() => setConfirmingDowngrade(true)}
            testID="account-downgrade"
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingTop: 8, paddingBottom: 48, gap: 14 },
  input: { paddingHorizontal: 14 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: { flex: 1, marginRight: 12 },
});
