import React, { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { PENDING_CODE_TTL_MS, formatResendClock, resendWaitMs } from '../accounts';
import * as accountsPhone from '../accountsPhone';
import { ACCOUNTS_PHONE_COPY } from '../accountsPhoneCopy';
import * as db from '../db';
import { useKeyboardInset } from '../keyboardInset';
import { PHONE_UI_ENABLED } from '../phoneUi';
import { useTheme } from '../theme';
import { PRIVACY_URL, TERMS_URL } from '../version';
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
 * The phone-number + discoverability surface —
 * AccountEmailScreen's SIBLING, deliberately not surgery on it: that
 * screen stays email-specific with its decisions exactly as
 * landed, and this one carries the phone class through its own deck
 * (accountsPhoneCopy.ts) and its own state machine (accountsPhone.ts).
 *
 * DARK BEHIND `PHONE_UI_ENABLED`:
 * while the build pin is false this screen renders NOTHING,
 * even entered programmatically — no store binary shows phone UI before
 * the declarations that flip WITH the binary that turns it on. Its
 * one-line Settings row is additionally DEFERRED behind the devices
 * program's Settings reservation (the honest-ledger pattern).
 *
 * Honesty rules on this glass, beyond the email screen's:
 *  - entry is country-code-explicit: the + is part of the number,
 *    and a malformed number is refused LOCALLY with its own sentence —
 *    never repaired, never guessed, never blamed on the server;
 *  - the toggle's teaching copy is at FULL sharpness (a ~10^10
 *    keyspace: leak-resistance, never server-blindness) and states the
 *    per-class fact (this switch never moves the email one);
 *  - the attach form carries the US toll-free registration's DIGITAL_FORM
 *    opt-in as a SEPARATE, UNCHECKED consent checkbox: the send affordance
 *    is disabled until it is checked, the checked state is plain component
 *    state living per SCREEN VISIT (never persisted — every visit to this
 *    form starts unchecked), its sentence is ONE deck string the carrier
 *    registration quotes byte-for-byte, and the Terms / Privacy policy
 *    links sit BESIDE the checkbox as their own tappable references (the
 *    toll-free review criteria list their absence at the opt-in as a
 *    denial reason).
 */
/** Whether a code requested at `requestedAt` can still be entered — the
 * AccountEmailScreen helper, per class. */
function codeWindowOpenAt(requestedAt: number | null, now: number): boolean {
  if (requestedAt == null) return false;
  const age = now - requestedAt;
  return age >= 0 && age < PENDING_CODE_TTL_MS;
}

export function AccountPhoneScreen({ onBack }: Props) {
  const t = useTheme();
  const keyboardInset = useKeyboardInset();
  const [identifier, setIdentifier] = useState<db.PhoneIdentifierRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [numberDraft, setNumberDraft] = useState('');
  const [codeDraft, setCodeDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  // The SMS consent checkbox (the toll-free DIGITAL_FORM opt-in): UNCHECKED
  // by default, and PER SCREEN VISIT on purpose — plain component state,
  // never persisted, so every visit to this form re-asks. Within one visit
  // the box stays live and visible beside the button (a resend renders it
  // still checked, and unchecking it re-darkens the send) — consent here is
  // per visit, not per send.
  const [smsConsent, setSmsConsent] = useState(false);
  /**
   * When THIS mount last sent a code — the email screen's memory, per class;
   * the row carries the same moment after the refresh. */
  const [sentAt, setSentAt] = useState<number | null>(null);

  const refresh = useCallback(() => {
    void db
      .loadPhoneIdentifier()
      .then(row => {
        setIdentifier(row);
        // The durable pending row is this screen's context after a relaunch
        // — the email screen's restore, per class: prefill an EMPTY draft,
        // and re-say the code-sent notice while the code lives.
        if (row?.phone == null && row?.pendingPhone != null) {
          const pendingPhone = row.pendingPhone;
          setNumberDraft(draft => (draft === '' ? pendingPhone : draft));
          if (codeWindowOpenAt(row.pendingRequestedAt, Date.now())) {
            setNotice(current => current ?? ACCOUNTS_PHONE_COPY.numberCodeSent(pendingPhone));
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
        .catch(() => setError(ACCOUNTS_PHONE_COPY.numberUnlinkRefused))
        .finally(() => {
          setBusy(false);
          refresh();
        });
    },
    [refresh],
  );

  const requestCode = () =>
    run(async () => {
      const outcome = await accountsPhone.requestPhoneAttachCode(numberDraft);
      if (outcome === 'sent') {
        setSentAt(Date.now());
        setNotice(ACCOUNTS_PHONE_COPY.numberCodeSent(numberDraft.trim()));
      } else {
        setNotice(null);
        // A transport failure is not a refusal: nothing was checked, so
        // the refusal sentence would lie.
        setError(
          outcome === 'invalid'
            ? ACCOUNTS_PHONE_COPY.numberInvalid
            : outcome === 'failed'
              ? ACCOUNTS_PHONE_COPY.failed
              : ACCOUNTS_PHONE_COPY.numberRefused,
        );
      }
    });

  const verifyCode = () =>
    run(async () => {
      const pendingNumber = identifier?.pendingPhone;
      if (!pendingNumber) return;
      const outcome = await accountsPhone.confirmPhoneAttach(pendingNumber, codeDraft.trim());
      if (outcome === 'attached') {
        setNotice(null);
        setCodeDraft('');
      } else {
        setError(
          outcome === 'failed' ? ACCOUNTS_PHONE_COPY.failed : ACCOUNTS_PHONE_COPY.numberRefused,
        );
      }
    });

  const toggleDiscoverable = (on: boolean) =>
    run(async () => {
      const outcome = await accountsPhone.setPhoneDiscoverable(on);
      if (outcome !== 'ok') setError(ACCOUNTS_PHONE_COPY.discoverableFailed);
    });

  const unlink = () =>
    run(async () => {
      const outcome = await accountsPhone.unlinkPhoneIdentifier();
      setConfirmingUnlink(false);
      if (outcome !== 'ok') setError(ACCOUNTS_PHONE_COPY.numberUnlinkRefused);
    });

  /**
   * Open a policy page — RegisterScreen's openPolicy verbatim, same silent
   * reasoning: these are reference links, the URLs are compile-time
   * constants, and the only realistic failure is a device with no https
   * handler, where an error banner would only scare someone off a page they
   * were opening voluntarily.
   */
  const openPolicy = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      // Intentionally silent — see above.
    }
  };

  const verified = identifier?.phone != null;
  const pending = !verified && identifier?.pendingPhone != null;
  // The code field exists only while the code can still be entered: a
  // field for a code that expired days ago is a dead end, while "Send
  // another code" stays live from the same row.
  const codeWindowOpen =
    pending && codeWindowOpenAt(identifier?.pendingRequestedAt ?? null, Date.now());
  // The boundary re-render (the email screen's timer), ABOVE the dark-pin
  // return: a hook after a conditional return breaks the rules of hooks.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!codeWindowOpen) return;
    const closesAt = (identifier?.pendingRequestedAt ?? 0) + PENDING_CODE_TTL_MS;
    const timer = setTimeout(
      () => setClockTick(n => n + 1),
      Math.max(250, closesAt - Date.now() + 250),
    );
    return () => clearTimeout(timer);
  });
  // THE RESEND MINUTE on the button — the email screen's countdown, per
  // class (the server's phoneResend budget is the same 60 s).
  const resendFrom =
    Math.max(sentAt ?? 0, identifier?.pendingRequestedAt ?? 0) || null;
  const resendWait = resendWaitMs(resendFrom, Date.now());
  useEffect(() => {
    if (resendWait <= 0) return;
    const timer = setTimeout(() => setClockTick(n => n + 1), Math.min(1_000, resendWait));
    return () => clearTimeout(timer);
  });

  // THE BUILD-PIN GATE, on the surface itself as well as its doors: a dark build
  // renders NOTHING here even when the route is entered programmatically.
  if (!PHONE_UI_ENABLED) return null;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      <ScreenHeader
        title={ACCOUNTS_PHONE_COPY.numberTitle}
        onBack={onBack}
        testIDBack="account-number-back"
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingHorizontal: t.layout.gutter }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
          {ACCOUNTS_PHONE_COPY.numberIntro}
        </Text>

        {error ? <InlineError message={error} testID="account-number-error" /> : null}
        {notice ? (
          <InlineNotice tone="pine" message={notice} testID="account-number-notice" />
        ) : null}

        {loaded && !verified ? (
          <>
            {/* Before the field: the + is part of the number. */}
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              {ACCOUNTS_PHONE_COPY.numberFormatNote}
            </Text>
            <TextInput
              value={numberDraft}
              onChangeText={setNumberDraft}
              placeholder={ACCOUNTS_PHONE_COPY.numberPlaceholder}
              placeholderTextColor={t.color.inkMuted}
              accessibilityLabel={ACCOUNTS_PHONE_COPY.numberTitle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="phone-pad"
              testID="account-number-input"
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
            {/* THE SMS CONSENT ROW (the US toll-free registration's
                DIGITAL_FORM opt-in): its OWN row, never bundled into any
                other consent, unchecked until the owner checks it — a typed
                number alone is not consent. The sentence is the ONE deck
                string the carrier registration quotes byte-for-byte. */}
            <Pressable
              onPress={() => setSmsConsent(v => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: smsConsent }}
              accessibilityLabel={ACCOUNTS_PHONE_COPY.smsConsentLabel}
              testID="account-number-sms-consent"
              style={[styles.consentRow, { minHeight: t.layout.touchTarget }]}
            >
              <View
                style={[
                  styles.checkbox,
                  {
                    borderColor: smsConsent ? t.color.pine : t.color.lineStrong,
                    backgroundColor: smsConsent ? t.color.pine : t.color.paperSheet,
                  },
                ]}
              >
                {smsConsent ? (
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
              <Text
                style={[t.type.compactBody, styles.consentText, { color: t.color.inkBody }]}
              >
                {ACCOUNTS_PHONE_COPY.smsConsentLabel}
              </Text>
            </Pressable>
            {/* THE POLICY LINKS, ADJACENT TO THE OPT-IN (toll-free review
                criteria: their absence at the opt-in point is a denial
                reason): their OWN tappable references BESIDE the checkbox,
                deliberately outside its press target — tapping Terms or
                Privacy must never toggle consent. */}
            <View style={styles.consentPolicyRow}>
              <TextAction
                label={ACCOUNTS_PHONE_COPY.smsConsentTermsLabel}
                onPress={() => void openPolicy(TERMS_URL)}
                testID="account-number-sms-terms"
              />
              <Text
                style={[t.type.compactBody, styles.policySep, { color: t.color.inkMuted }]}
              >
                ·
              </Text>
              <TextAction
                label={ACCOUNTS_PHONE_COPY.smsConsentPrivacyLabel}
                onPress={() => void openPolicy(PRIVACY_URL)}
                testID="account-number-sms-privacy"
              />
            </View>
            <PrimaryButton
              label={
                resendWait > 0
                  ? ACCOUNTS_PHONE_COPY.numberRequestAgainIn(formatResendClock(resendWait))
                  : pending
                    ? ACCOUNTS_PHONE_COPY.numberRequestAgain
                    : ACCOUNTS_PHONE_COPY.numberRequest
              }
              onPress={requestCode}
              disabled={busy || numberDraft.trim() === '' || !smsConsent || resendWait > 0}
              testID="account-number-request"
            />
            {/* TEACHING, behind the ⓘ (house style): the phone class's
                recipient budget — the email surface's pattern at this
                class's own numbers (3/day, one per minute). Never in the
                error banner: the refusal stays collapsed by design. */}
            <InfoDisclosure
              label={ACCOUNTS_PHONE_COPY.numberCodeBudgetLabel}
              lines={ACCOUNTS_PHONE_COPY.numberCodeBudget}
              testID="account-number-code-budget"
            />
            {codeWindowOpen ? (
              <>
                <TextInput
                  value={codeDraft}
                  onChangeText={setCodeDraft}
                  placeholder={ACCOUNTS_PHONE_COPY.codePlaceholder}
                  placeholderTextColor={t.color.inkMuted}
                  accessibilityLabel={ACCOUNTS_PHONE_COPY.codePlaceholder}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  testID="account-number-code"
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
                  label={ACCOUNTS_PHONE_COPY.numberVerify}
                  onPress={verifyCode}
                  disabled={busy || codeDraft.trim().length !== 6}
                  testID="account-number-verify"
                />
              </>
            ) : null}
          </>
        ) : null}

        {loaded && verified ? (
          <>
            <Text
              style={[t.type.body, { color: t.color.inkStrong }]}
              testID="account-number-verified"
            >
              {ACCOUNTS_PHONE_COPY.numberVerified(identifier!.phone!)}
            </Text>

            {/* The PHONE class's the design consent toggle — DEFAULT OFF, its own
                row (made structural by the per-class migration). */}
            <RuledLabel label={ACCOUNTS_PHONE_COPY.discoverableTitle} />
            {identifier!.restoredAt != null ? (
              <InlineNotice
                tone="quiet"
                message={ACCOUNTS_PHONE_COPY.discoverableRestored}
                testID="number-discoverable-restored"
              />
            ) : null}
            <View style={styles.toggleRow}>
              <Text
                style={[t.type.compactBody, styles.toggleLabel, { color: t.color.inkBody }]}
              >
                {ACCOUNTS_PHONE_COPY.discoverableLabel}
              </Text>
              <Switch
                value={identifier!.discoverable}
                onValueChange={toggleDiscoverable}
                disabled={busy}
                accessibilityLabel={ACCOUNTS_PHONE_COPY.discoverableLabel}
                testID="number-discoverable-toggle"
              />
            </View>
            {/* The honest-weakness and per-class facts, behind the ⓘ in full. */}
            <InfoDisclosure
              label={ACCOUNTS_PHONE_COPY.discoverableExplainLabel}
              lines={ACCOUNTS_PHONE_COPY.discoverableExplain}
              testID="number-discoverable-info"
            />

            {confirmingUnlink ? (
              <>
                <Text style={[t.type.body, { color: t.color.inkStrong }]}>
                  {ACCOUNTS_PHONE_COPY.numberUnlinkConfirm(identifier!.phone!)}
                </Text>
                <PrimaryButton
                  label={ACCOUNTS_PHONE_COPY.numberUnlink}
                  onPress={unlink}
                  disabled={busy}
                  testID="account-number-unlink-confirm"
                />
                <TextAction
                  label={ACCOUNTS_PHONE_COPY.numberUnlinkKeep}
                  onPress={() => setConfirmingUnlink(false)}
                  testID="account-number-unlink-cancel"
                />
              </>
            ) : (
              <TextAction
                label={ACCOUNTS_PHONE_COPY.numberUnlink}
                onPress={() => setConfirmingUnlink(true)}
                testID="account-number-unlink"
              />
            )}
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
  /** The policy references under the consent text: left-aligned with the
   * sentence (past the 22pt box + 12pt gap), the RegisterScreen dot
   * between them. */
  consentPolicyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 34,
    marginTop: -6,
  },
  policySep: { marginHorizontal: 2 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: { flex: 1, marginRight: 12 },
});
