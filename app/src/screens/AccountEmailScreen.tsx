import React, { useCallback, useEffect, useState } from 'react';
import {
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
 * The email + discoverability surface (the design
 * attach/verify/unlink flows, the consent toggle, and the
 * downgrade). The Settings row that OPENS this screen landed under a
 * scoped override — the route,
 * screen, and back mapping were already in place, so the entry was the
 * promised one line.
 *
 * Honesty rules on this glass:
 *  - the code-sent line promises only what this device knows (the wire's
 *    200 is uniform by design);
 *  - the toggle renders the LOCAL consent record and defaults OFF — a
 *    freshly verified identifier is not findable until its owner throws
 *    this switch, and the teaching copy states what ON discloses plus the honest weakness in plain words;
 *  - the refusal sentences say the server deliberately collapsed the
 *    reason, instead of guessing one.
 */
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

  const refresh = useCallback(() => {
    void db
      .loadAccountIdentifier()
      .then(row => {
        setIdentifier(row);
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
        setNotice(ACCOUNTS_COPY.emailCodeSent(emailDraft.trim().toLowerCase()));
      } else {
        setNotice(null);
        setError(ACCOUNTS_COPY.emailRefused);
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
        setError(ACCOUNTS_COPY.emailRefused);
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
              label={pending ? ACCOUNTS_COPY.emailRequestAgain : ACCOUNTS_COPY.emailRequest}
              onPress={requestCode}
              disabled={busy || emailDraft.trim() === ''}
              testID="account-email-request"
            />
            {/* TEACHING, behind the ⓘ (house style): the recipient budget
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
            {pending ? (
              <>
                <TextInput
                  value={codeDraft}
                  onChangeText={setCodeDraft}
                  placeholder={ACCOUNTS_COPY.codePlaceholder}
                  placeholderTextColor={t.color.inkMuted}
                  accessibilityLabel={ACCOUNTS_COPY.codePlaceholder}
                  keyboardType="number-pad"
                  maxLength={6}
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
            <RuledLabel label={ACCOUNTS_COPY.discoverableTitle} />
            {/* The restored-placeholder honesty:
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
                testID="discoverable-toggle"
              />
            </View>
            {/* PER-CLASS truth on the email toggle too: with the phone class live, "by this email or
                anything else" would overpromise — the pin-gated variant
                scopes the sentence to THIS class and says the per-class mirror.
                Pin false (every release binary until phone ships): the
                landed lines, byte-for-byte — the recoverScopeBoth pattern. */}
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
        <RuledLabel label={ACCOUNTS_COPY.downgradeTitle} />
        {/* The downgrade names EVERY identifier it removes: the dissolve takes the phone claim and the local
            phone row too, so the pin-gated variant discloses the class
            pair. Pin false: the landed email-only sentences. */}
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
