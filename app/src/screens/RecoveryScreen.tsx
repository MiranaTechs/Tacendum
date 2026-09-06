import React, { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
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
  ScreenHeader,
  TextAction,
} from '../ui/primitives';

interface Props {
  /** Null pre-registration: the screen then explains and hands off to the
   * ORDINARY registration (which asks for no email), returning
   * here after it completes. */
  profile: db.ProfileRow | null;
  onBack: () => void;
  /** Route to the untouched register screen (recovery sits BESIDE it). */
  onCreateIdentity: () => void;
  /** Recovery finished (or was abandoned post-registration): to the chats. */
  onDone: () => void;
}

/** When completion becomes possible, in a person's words. */
function completesLabel(completesAtSeconds: number): string {
  return new Date(completesAtSeconds * 1000).toLocaleString(undefined, {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * "Recover my account grouping" — BESIDE
 * registration, never inside it (registration stays
 * identifier-free, structurally; this screen is a different route with its
 * own door on the landing surface).
 *
 * THE SCOPE SENTENCE LEADS. Before any field: recovery restores the
 * account grouping and findability ONLY — never messages (they lived only
 * on the old devices), never keys (never escrowed), and every contact sees
 * a full safety reset. The scope is stated as the design it is, not as an
 * apology.
 *
 * Refusals render as the collapses they are: the code-request answer is
 * uniform (only the inbox knows), and a refused completion deliberately
 * does not say whether a surviving device cancelled — the device the
 * survivors refused must not learn which device refused it.
 *
 * THE PHONE ENTRY, dark
 * behind `PHONE_UI_ENABLED`: under the pin the door offers email OR phone
 * entry — the class chosen, never inferred — with the SAME scope honesty
 * (the scope sentence widens its identifier clause to the class pair and
 * concedes nothing else), the same durable `recovery_local` row (now
 * typed: the row records which class proved the code), and the same
 * uniform-answer copy. With the pin false nothing here changes.
 */
export function RecoveryScreen({ profile, onBack, onCreateIdentity, onDone }: Props) {
  const t = useTheme();
  const keyboardInset = useKeyboardInset();
  const [pending, setPending] = useState<db.LocalRecoveryRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [classSel, setClassSel] = useState<db.IdentifierKind>(db.EMAIL_KIND);
  const [emailDraft, setEmailDraft] = useState('');
  const [codeDraft, setCodeDraft] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  /** When a code was last asked for — this mount's own send, or the memo's
   * stamp after a relock: the resend minute counts from it. */
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const byNumber = PHONE_UI_ENABLED && classSel === db.PHONE_KIND;

  const refresh = useCallback(() => {
    void db
      .loadLocalRecovery()
      .then(async row => {
        // THE DARK PIN HOLDS ON THE PERSISTED ROW TOO:
        // a kind='phone' recovery row in a false-pin binary renders NOTHING
        // — not the pending wait, not the complete button — exactly as
        // every other phone surface renders nothing. The durable row is
        // PRESERVED, never cleared: kill-switch dominance,
        // mirrored client-side — a pin-ON binary resumes
        // the wait from the same row. `completeRecovery` refuses the same
        // row independently, so this gate is rendering, not the guard.
        const visible = accounts.recoveryRowVisible(row) ? row : null;
        setPending(visible);
        // A CODE WAS ASKED FOR AND NOT YET PROVEN: the memo restores the
        // class, the address and the code field for the code's own
        // 5-minute life, so a relock ("Right away" is the default) or a
        // relaunch between the tap and the inbox no longer throws the
        // person back to an empty form — where a re-request inside the
        // resend minute sends nothing. A typed draft is never
        // overwritten. A phone memo in a dark-pin binary stays dark, like
        // the phone row above.
        if (visible === null) {
          const memo = await accounts.loadRecoveryRequest();
          if (memo !== null && (PHONE_UI_ENABLED || memo.kind !== db.PHONE_KIND)) {
            setClassSel(memo.kind);
            setEmailDraft(draft => (draft === '' ? memo.address : draft));
            setCodeRequested(true);
            setRequestedAt(memo.requestedAt);
            setNotice(
              current =>
                current ??
                (memo.kind === db.PHONE_KIND
                  ? ACCOUNTS_PHONE_COPY.recoverCodeSentNumber(memo.address)
                  : ACCOUNTS_COPY.recoverCodeSent(memo.address)),
            );
          }
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);

  const run = useCallback((work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void work()
      .catch(() => setError(ACCOUNTS_COPY.recoverRefused))
      .finally(() => setBusy(false));
  }, []);

  const requestCode = () =>
    run(async () => {
      const outcome = byNumber
        ? await accounts.requestRecoveryCodeByPhone(emailDraft)
        : await accounts.requestRecoveryCode(emailDraft);
      if (outcome === 'sent') {
        setCodeRequested(true);
        setRequestedAt(Date.now());
        setNotice(
          byNumber
            ? ACCOUNTS_PHONE_COPY.recoverCodeSentNumber(emailDraft.trim())
            : ACCOUNTS_COPY.recoverCodeSent(emailDraft.trim().toLowerCase()),
        );
      } else if (outcome === 'invalid') {
        // The honest LOCAL refusal: this device's own knowledge of the
        // E.164 shape — never dressed up as the server's collapse.
        setError(ACCOUNTS_PHONE_COPY.numberInvalid);
      } else if (outcome === 'failed') {
        // A transport failure is not a refusal: nothing was checked, so
        // the collapsed-refusal sentence would lie.
        setError(ACCOUNTS_COPY.failed);
      } else {
        setError(ACCOUNTS_COPY.recoverRefused);
      }
    });

  const verifyCode = () =>
    run(async () => {
      const result = byNumber
        ? await accounts.confirmRecoveryCodeByPhone(emailDraft, codeDraft.trim())
        : await accounts.confirmRecoveryCode(emailDraft, codeDraft.trim());
      if (result.outcome === 'pending') {
        setNotice(null);
        refresh();
      } else if (result.outcome === 'invalid') {
        setError(ACCOUNTS_PHONE_COPY.numberInvalid);
      } else if (result.outcome === 'failed') {
        setError(ACCOUNTS_COPY.failed);
      } else {
        setError(ACCOUNTS_COPY.recoverRefused);
      }
    });

  const complete = () =>
    run(async () => {
      const outcome = await accounts.completeRecovery();
      if (outcome === 'completed') {
        setDone(true);
      } else if (outcome === 'not_ready') {
        setError(ACCOUNTS_COPY.recoverNotYet);
      } else if (outcome === 'failed') {
        setError(ACCOUNTS_COPY.failed);
      } else {
        setError(ACCOUNTS_COPY.recoverCompleteRefused);
      }
    });

  const abandon = () =>
    run(async () => {
      await accounts.abandonRecovery();
      refresh();
    });

  const readyToComplete =
    pending !== null && Math.floor(Date.now() / 1000) >= pending.completesAt;

  // THE CLOCK CROSSES THE BOUNDARY WHILE THE SCREEN IS OPEN: `readyToComplete` is a render-time comparison, and nothing
  // above re-renders when the 72-hour mark passes — the disabled button
  // would stay disabled until some unrelated state moved. Re-arm a short
  // timer until the boundary is crossed; each tick re-renders and the
  // comparison above does the rest. Capped at 60 s so a long wait costs a
  // trivial timer, not an interval storm.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (pending === null || done || readyToComplete) return;
    const remainingMs = pending.completesAt * 1000 - Date.now();
    const timer = setTimeout(
      () => setClockTick(n => n + 1),
      Math.max(250, Math.min(remainingMs + 250, 60_000)),
    );
    return () => clearTimeout(timer);
  });

  // THE RESEND MINUTE, counted down on the button: the server sends
  // nothing inside it and answers the same, so the button refuses visibly
  // instead of inviting the tap — the attach screens' countdown, from the
  // memo here (it survives the relock). One-second ticks while it runs;
  // the effect above keeps its own, longer clock for the wait.
  const resendWait = accounts.resendWaitMs(requestedAt, Date.now());
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
        title={ACCOUNTS_COPY.recoverTitle}
        onBack={onBack}
        testIDBack="recovery-back"
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingHorizontal: t.layout.gutter }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* THE SCOPE, FIRST, in the open, not behind the ⓘ. With
            the phone door open the identifier clause names the class
            pair; the two-things-only commitment is the same sentence. */}
        <Text style={[t.type.body, { color: t.color.inkStrong }]} testID="recovery-scope">
          {PHONE_UI_ENABLED
            ? ACCOUNTS_PHONE_COPY.recoverScopeBoth
            : ACCOUNTS_COPY.recoverScope}
        </Text>
        {/* The narrow-scope lines follow the door:
            with the phone entry open, the findability-pause line names the
            class pair — the pause covers every class the account holds.
            Pin false: the landed email-only lines, byte-for-byte. */}
        <InfoDisclosure
          label={ACCOUNTS_COPY.recoverExplainLabel}
          lines={
            PHONE_UI_ENABLED
              ? ACCOUNTS_PHONE_COPY.recoverExplainBoth
              : ACCOUNTS_COPY.recoverExplain
          }
          testID="recovery-info"
        />

        {error ? <InlineError message={error} testID="recovery-error" /> : null}
        {notice ? (
          <InlineNotice tone="pine" message={notice} testID="recovery-notice" />
        ) : null}

        {profile === null ? (
          <>
            <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
              {/* The handoff names what can attach the fresh identity (fix
                  pass): with the phone door open, either class
                  can. Pin false: the landed email-only sentence. */}
              {PHONE_UI_ENABLED
                ? ACCOUNTS_PHONE_COPY.recoverNeedsIdentityBoth
                : ACCOUNTS_COPY.recoverNeedsIdentity}
            </Text>
            <PrimaryButton
              label={ACCOUNTS_COPY.recoverCreateIdentity}
              onPress={onCreateIdentity}
              testID="recovery-create-identity"
            />
          </>
        ) : null}

        {profile !== null && loaded && done ? (
          <>
            <InlineNotice
              tone="pine"
              message={ACCOUNTS_COPY.recoverDone}
              testID="recovery-done"
            />
            <PrimaryButton label="Open my chats" onPress={onDone} testID="recovery-open-chats" />
          </>
        ) : null}

        {profile !== null && loaded && !done && pending === null ? (
          <>
            {/* The class chooser: email OR
                phone entry — chosen, never inferred. Switching classes
                clears the drafts; the request/verify legs and the durable
                row are typed off this choice. */}
            {PHONE_UI_ENABLED ? (
              <View style={styles.classRow}>
                {(
                  [
                    [db.EMAIL_KIND, ACCOUNTS_PHONE_COPY.classLabelEmail, 'recovery-class-email'],
                    [db.PHONE_KIND, ACCOUNTS_PHONE_COPY.classLabelNumber, 'recovery-class-number'],
                  ] as const
                ).map(([kind, label, testID]) => {
                  const selected = classSel === kind;
                  return (
                    <Pressable
                      key={kind}
                      onPress={() => {
                        if (classSel === kind) return;
                        setClassSel(kind);
                        setEmailDraft('');
                        setCodeDraft('');
                        setCodeRequested(false);
                        // The budget is per address: another class is
                        // another address, so its minute is not this one's.
                        setRequestedAt(null);
                        setNotice(null);
                        setError(null);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={label}
                      testID={testID}
                      style={[
                        styles.classChip,
                        {
                          borderRadius: t.radius.button,
                          borderWidth: 1,
                          borderColor: selected ? t.color.pine : t.color.lineStrong,
                          backgroundColor: selected
                            ? t.color.pineWash
                            : t.color.paperSheet,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          t.type.buttonCompact,
                          { color: selected ? t.color.pine : t.color.inkMuted },
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
              {byNumber
                ? ACCOUNTS_PHONE_COPY.recoverNumberLabel
                : ACCOUNTS_COPY.recoverEmailLabel}
            </Text>
            <TextInput
              value={emailDraft}
              onChangeText={setEmailDraft}
              placeholder={
                byNumber
                  ? ACCOUNTS_PHONE_COPY.numberPlaceholder
                  : ACCOUNTS_COPY.emailPlaceholder
              }
              placeholderTextColor={t.color.inkMuted}
              keyboardAppearance={t.scheme}
              selectionColor={t.color.pine}
              accessibilityLabel={
                byNumber
                  ? ACCOUNTS_PHONE_COPY.recoverNumberLabel
                  : ACCOUNTS_COPY.recoverEmailLabel
              }
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={byNumber ? 'phone-pad' : 'email-address'}
              testID="recovery-email-input"
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
              // The verb follows the class: the phone
              // door must not promise an email.
              label={
                resendWait > 0
                  ? ACCOUNTS_COPY.requestAgainIn(accounts.formatResendClock(resendWait))
                  : byNumber
                    ? ACCOUNTS_PHONE_COPY.recoverRequestNumber
                    : ACCOUNTS_COPY.recoverRequest
              }
              onPress={requestCode}
              disabled={busy || emailDraft.trim() === '' || resendWait > 0}
              testID="recovery-request-code"
            />
            {/* The code field without a request: a code already
                in the inbox — asked for on another device, or by a screen
                that has since forgotten. */}
            {!codeRequested ? (
              <TextAction
                label={ACCOUNTS_COPY.recoverHaveCode}
                onPress={() => setCodeRequested(true)}
                testID="recovery-have-code"
              />
            ) : null}
            {codeRequested ? (
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
                  testID="recovery-code-input"
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
                  label={ACCOUNTS_COPY.recoverVerify}
                  onPress={verifyCode}
                  // The address is the verify's other half: a revealed code
                  // field over an empty address must not fire a request
                  // the server can only refuse.
                  disabled={busy || codeDraft.trim().length !== 6 || emailDraft.trim() === ''}
                  testID="recovery-verify"
                />
              </>
            ) : null}
          </>
        ) : null}

        {profile !== null && loaded && !done && pending !== null ? (
          <>
            <Text
              style={[t.type.body, { color: t.color.inkStrong }]}
              testID="recovery-pending"
            >
              {ACCOUNTS_COPY.recoverPending(completesLabel(pending.completesAt))}
            </Text>
            {/* The wait, relatively: the date above is the
                fact, this is how long it is from here — re-rendered by the
                clock tick above while the screen is open. And what leaving
                costs: nothing — App.tsx re-enters this surface at every
                launch while the row exists. */}
            {!readyToComplete ? (
              <Text
                style={[t.type.body, { color: t.color.inkStrong }]}
                testID="recovery-pending-relative"
              >
                {ACCOUNTS_COPY.recoverPendingIn(
                  ACCOUNTS_COPY.waitLabel(pending.completesAt * 1000 - Date.now()),
                )}
              </Text>
            ) : null}
            <Text
              style={[t.type.compactBody, { color: t.color.inkMuted }]}
              testID="recovery-pending-return"
            >
              {ACCOUNTS_COPY.recoverPendingReturn}
            </Text>
            <PrimaryButton
              label={ACCOUNTS_COPY.recoverComplete}
              onPress={complete}
              disabled={busy || !readyToComplete}
              testID="recovery-complete"
            />
            {!readyToComplete ? (
              <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
                {ACCOUNTS_COPY.recoverNotYet}
              </Text>
            ) : null}
            <TextAction
              label={ACCOUNTS_COPY.recoverAbandon}
              onPress={abandon}
              testID="recovery-abandon"
            />
            {/* The verb's honest reach: this
                device is not a member, so the member-authorized cancel
                route refuses it by design — setting the attempt aside is
                LOCAL, and the sentence says what keeps running. */}
            <Text
              style={[t.type.compactBody, { color: t.color.inkMuted }]}
              testID="recovery-abandon-note"
            >
              {ACCOUNTS_COPY.recoverAbandonNote}
            </Text>
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
  classRow: { flexDirection: 'row', gap: 10 },
  classChip: { paddingHorizontal: 14, paddingVertical: 8 },
});
