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
import { EmailIdentifier, normalizeEmailIdentifier } from '@tacendum/shared';
import * as accounts from '../accounts';
import { ACCOUNTS_COPY } from '../accountsCopy';
import { ACCOUNTS_PHONE_COPY } from '../accountsPhoneCopy';
import * as db from '../db';
import { useKeyboardInset } from '../keyboardInset';
import { LINKING_COPY } from '../linkingCopy';
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
 *
 * THE ACCOUNT, NOT ONLY THIS DEVICE (D2, the 2026-10-08 fix train). The
 * local row is written only by this device's own attach, toggle or
 * recovery, and the rows never sync — so on a linked sibling (the iPad, a
 * reinstalled phone) this screen offered to attach an email the account
 * already held, and answered the request with the VERIFY step's sentence.
 * The screen now also reads the account group's own facts
 * (accounts.loadIdentifierState — never a name, never an address):
 *  - `emailLinked: true` with no local row is the HELD-ELSEWHERE state:
 *    the fact, where the switch lives, and the two verbs that need no
 *    address (Remove — the unlink route carries none — and the downgrade);
 *  - `emailLinked: false` beside a verified local row is a PHANTOM — the
 *    address was removed from another device — cleared once, and said;
 *  - `emailLinked: true` beside a verified local row WRITTEN BEFORE the
 *    account's live email row (`emailSince`, the gate pass 2026-10-08) is
 *    the same phantom: a sibling removed the address and linked another,
 *    and the switch here would have moved that other address's consent —
 *    cleared once, said, and the held-elsewhere state follows;
 *  - null is UNKNOWN (the legacy read against a server without the route,
 *    a refusal, a failure): nothing is cleared, and on the legacy read a
 *    stop-gap sentence beside the form says where the address can be
 *    changed. A refused or failed RE-read keeps the last landed facts and
 *    moves only the verdict. The read is dropped by every write.
 *  - The attach form waits for the first state answer (a quiet checking
 *    line meanwhile — the handle screen's rule): a linked sibling must
 *    never see an attach form flash, ready to use, over an address its
 *    account already holds. A pending code shows at once: that row is this
 *    device's own.
 *  - "Email me a code" lights only for a complete address (the shared
 *    schema's shape): a typo must never reach the server's collapsed 403
 *    and be blamed on the account. And every tap asks this device's own
 *    identifier-route pacing first (U3), as the handle screen does.
 *
 * THE UNLINKED SECOND DEVICE (the 2026-10-08 follow-up — the reported
 * second device, read from production: a separate account that never
 * linked and holds no verified identifier). Here it met the attach form,
 * typed the address its other account already holds, received a real code
 * and was refused at the verify step with the uniform 403 — a loop that
 * never named the thing that would work: joining the other account, started
 * FROM the other device, while this one is still a fresh install and a
 * different kind of device. With `needs_verification` on the state read
 * (the new route or the legacy fallback — no server dependency) and two
 * LOCAL facts — no group row (db.loadLinkGroup) and the fresh-install check
 * (db.pristineForLink) that chooses the sentence — the form carries that
 * pointer above the field, before and after the refusal. The form stays (a
 * different address is a legal choice), `emailRefused` keeps its bytes, and
 * an unknown (either local read failed) renders nothing.
 */
/** Whether a state answer carries facts (eligible or needs_verification);
 * a refusal or a failure carries none. */
function landed(state: accounts.IdentifierState): boolean {
  return state.eligibility === 'eligible' || state.eligibility === 'needs_verification';
}

/** What THIS device knows about its own standing for a link: whether it
 * has ever joined an account group, and whether it is still a fresh install
 * (`pristine` is null when that read failed). Local, once per mount. */
interface LinkStanding {
  grouped: boolean;
  pristine: boolean | null;
}

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
  /** The account group's own facts (the header's D2 paragraph), with the
   * moment the read was ASKED: an answer requested before this device's
   * own attach landed cannot know about the row it would otherwise read as
   * a phantom. Null until the first answer lands; the form renders meanwhile
   * (the module's 60 s cache makes a re-open instant). */
  const [groupState, setGroupState] = useState<{
    state: accounts.IdentifierState;
    requestedAt: number;
  } | null>(null);
  /** The newest state read wins; an older in-flight answer is dropped —
   * bumped on unmount so a late answer never lands on a dead screen. */
  const stateSeq = useRef(0);
  /** The phantom row is cleared at most once per mount. */
  const phantomCleared = useRef(false);
  /** THIS device's standing for a link (the unlinked second device): null
   * until both local reads answer; an unknown renders no guidance. */
  const [local, setLocal] = useState<LinkStanding | null>(null);

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
    // The account's own facts, beside the row (D2): asked on mount and
    // after every write this screen makes (`run` refreshes), so the
    // held-elsewhere and phantom states follow the server, not the cache
    // the write just invalidated.
    const seq = ++stateSeq.current;
    const requestedAt = Date.now();
    void accounts
      .loadIdentifierState()
      .then(state => {
        if (stateSeq.current !== seq) return;
        // A refused or failed re-read carries no facts: the last landed
        // answer keeps governing the layout (the held-elsewhere state must
        // not fall into the attach form because Remove was tapped offline);
        // only the verdict moves with it.
        setGroupState(prev =>
          prev === null || landed(state)
            ? { state, requestedAt }
            : {
                state: { ...prev.state, source: state.source, eligibility: state.eligibility },
                requestedAt: prev.requestedAt,
              },
        );
      })
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(
    () => () => {
      stateSeq.current += 1;
    },
    [],
  );
  // THIS DEVICE'S OWN STANDING FOR A LINK (the header's last paragraph):
  // the group row and the fresh-install check, read once per mount from the
  // local database and never from the wire. An unknown (either read failed)
  // renders no guidance — wrong guidance is worse than none.
  useEffect(() => {
    let live = true;
    void Promise.all([db.loadLinkGroup(), db.pristineForLink().catch(() => null)])
      .then(([group, pristine]) => {
        if (live) setLocal({ grouped: group !== null, pristine });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

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

  // The typed address, as the wire would read it: only a complete one
  // lights the button (the shared schema is the one check, never a repair).
  const draftComplete = EmailIdentifier.safeParse(normalizeEmailIdentifier(emailDraft)).success;

  /** This device's own pacing (U3): the eleventh identifier-route call in
   * a minute is said before the tap — the email legs draw the same window
   * the handle verbs do. Never a first call, never the gate. */
  const paced = (): boolean => {
    const wait = accounts.identifierRoutePacingNow(Date.now());
    if (wait === null) return false;
    setError(ACCOUNTS_COPY.paced(wait));
    return true;
  };

  const requestCode = () => {
    // The button is dark for an incomplete address; a press that reaches
    // here anyway (a stale tap, a screen reader) sends nothing.
    if (!draftComplete || paced()) return;
    run(async () => {
      const outcome = await accounts.requestAttachCode(emailDraft);
      if (outcome === 'sent') {
        setSentAt(Date.now());
        setNotice(ACCOUNTS_COPY.emailCodeSent(emailDraft.trim().toLowerCase()));
      } else {
        setNotice(null);
        // A transport failure is not a refusal: nothing was checked, so
        // the refusal sentence would lie. And the REQUEST
        // step's refusals are its own (D2): no code exists yet, so the
        // verify sentence ("the code may be wrong or expired") would lie
        // too — the 403 is about the caller's account (its one email may
        // already be linked, from any of its devices), the 429s about the
        // caller's own budgets: the minute's burst, or the day's allowance
        // (told apart by Retry-After, the gate pass 2026-10-08).
        setError(
          outcome === 'failed'
            ? ACCOUNTS_COPY.failed
            : outcome === 'rate_limited'
              ? ACCOUNTS_COPY.emailRequestRateLimited
              : outcome === 'rate_limited_today'
                ? ACCOUNTS_COPY.emailRequestRateLimitedToday
                : ACCOUNTS_COPY.emailRequestRefused,
        );
      }
    });
  };

  const verifyCode = () => {
    if (paced()) return;
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
  };

  const toggleDiscoverable = (on: boolean) => {
    if (paced()) return;
    run(async () => {
      const outcome = await accounts.setDiscoverable(on);
      if (outcome !== 'ok') {
        setError(ACCOUNTS_COPY.discoverableFailed);
        return;
      }
      // On a sibling the switch renders the ACCOUNT's bit (no row of its
      // own): said now, in the same batch; the re-read in `run`'s finally
      // brings the server's own answer (the proof pass, 2026-10-08).
      setGroupState(prev =>
        prev === null ? prev : { ...prev, state: { ...prev.state, emailFindable: on } },
      );
    });
  };

  const unlink = () => {
    if (paced()) return;
    run(async () => {
      const outcome = await accounts.unlinkIdentifier();
      setConfirmingUnlink(false);
      if (outcome !== 'ok') setError(ACCOUNTS_COPY.emailUnlinkRefused);
    });
  };

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
  // THE ACCOUNT'S FACTS beside the row (D2). `emailLinked` is a FACT from
  // the state route (false included); null is UNKNOWN and decides nothing.
  const facts = groupState?.state ?? null;
  // The first state answer has landed (any verdict): until then the attach
  // form is withheld — unless this device's own pending code is waiting.
  const stateAnswered = groupState !== null;

  // No row of our own, and the account holds a verified email: a linked
  // sibling linked it. The form would offer to attach an address the
  // account already has (and the server would refuse it).
  const heldElsewhere = !verified && facts?.emailLinked === true;
  // The legacy read (a server without the state route, or ahead of this
  // build): the eligibility read says the account holds a verified
  // identifier and this device holds no row — in practice the email a
  // sibling linked (the phone class is dark). The form stays, honestly
  // captioned, because the fact is not on this wire.
  const maybeHeldElsewhere =
    !verified &&
    !heldElsewhere &&
    facts?.source === 'legacy' &&
    facts.eligibility === 'eligible';
  // THE UNLINKED SECOND DEVICE (the header's last paragraph): no verified
  // identifier on the account (the verdict, on either read), this device
  // never grouped, and both local reads answered — the attach form gets the
  // pointer the refusal deliberately cannot give. Mutually exclusive with
  // the sentence above (that one needs `eligible`); a grouped but
  // unverified pair keeps the plain form — there, verifying IS the answer.
  const joinExisting =
    facts?.eligibility === 'needs_verification' &&
    local !== null &&
    !local.grouped &&
    local.pristine !== null
      ? local
      : null;

  // THE PHANTOM ROW: this device says "linked", the account says no email —
  // it was removed from another device — or says a DIFFERENT email, linked
  // after this row was written (the live row's `emailSince` later than the
  // row's `verifiedAt` beyond the skew allowance; the gate pass): a sibling
  // removed this address and linked its own, and the switch here would
  // have moved that one. Cleared once per mount, and only on an answer
  // asked AFTER the row was written (an older in-flight answer cannot know
  // about this device's own fresh attach), then the form — or the
  // held-elsewhere state — is back with a sentence saying why.
  useEffect(() => {
    if (!loaded || groupState === null || phantomCleared.current) return;
    if (identifier?.email == null || identifier.verifiedAt == null) return;
    if (groupState.requestedAt < identifier.verifiedAt) return;
    const removed = groupState.state.emailLinked === false;
    // A row written since the proof pass carries the server's own stamp
    // (`since`): the live stamp must EQUAL it — a sibling's replacement
    // inside five minutes is seen, and a slow clock never reads its own
    // fresh row as a phantom. An older row keeps the skew rule.
    const replaced =
      groupState.state.emailLinked === true &&
      accounts.localRowStale(
        identifier.verifiedAt,
        groupState.state.emailSince,
        identifier.since ?? null,
      );
    if (removed || replaced) {
      phantomCleared.current = true;
      void db
        .clearAccountIdentifier()
        .then(() => {
          setNotice(removed ? ACCOUNTS_COPY.emailRemovedElsewhere : ACCOUNTS_COPY.emailChangedElsewhere);
          refresh();
        })
        .catch(() => undefined);
      return;
    }
    // THE ROW IS THE ACCOUNT'S — two things follow, in one write (the proof
    // pass, 2026-10-08). It ADOPTS the live email row's stamp when it has
    // none (this device's attach that just landed, or a row from a build
    // before the stamp existed): from then on exact equality governs. And
    // its consent BIT follows the account's — a sibling may switch it from
    // its own held-elsewhere state, and the state read carries it — while a
    // RESTORED placeholder (a recovery wrote the row without knowing the
    // bit) settles the same way, since the bit can now be read back.
    const own = groupState.state;
    const since = accounts.adoptableRowStamp(
      { stamp: identifier.verifiedAt, since: identifier.since ?? null },
      own,
      'email',
    );
    const bit = own.source === 'state' && own.emailLinked === true ? own.emailFindable : null;
    const settles = bit !== null && identifier.restoredAt != null;
    const follow = bit !== null && (settles || identifier.discoverable !== bit);
    if (since === null && !follow) return;
    const next: db.AccountIdentifierRow = {
      ...identifier,
      ...(since !== null ? { since } : {}),
      ...(follow ? { discoverable: bit, restoredAt: null } : {}),
    };
    setIdentifier(next);
    void db.saveAccountIdentifier(next).catch(() => undefined);
  }, [loaded, identifier, groupState, refresh]);
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

  /** The two-step Remove, shared by the verified surface (the question
   * names the address) and the held-elsewhere surface (it cannot). */
  const unlinkControls = (question: string) =>
    confirmingUnlink ? (
      <>
        <Text style={[t.type.body, { color: t.color.inkStrong }]}>{question}</Text>
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
    );

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
        {/* The reading column (the proof pass, 2026-10-08): capped at
            contentMax like Open a room, so an iPad does not run a body
            line to 190 characters. */}
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
        <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
          {ACCOUNTS_COPY.emailIntro}
        </Text>

        {error ? <InlineError message={error} testID="account-email-error" /> : null}
        {notice ? (
          <InlineNotice tone="pine" message={notice} testID="account-email-notice" />
        ) : null}

        {loaded && !verified && !heldElsewhere && !stateAnswered && !pending ? (
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_COPY.emailChecking}
            announce={false}
            testID="account-email-checking"
          />
        ) : null}

        {loaded && !verified && !heldElsewhere && (stateAnswered || pending) ? (
          <>
            {/* THE UNLINKED SECOND DEVICE: above the field, the notice that
                fits this device (a fresh install can still join the other
                account; a lived-in one cannot) and, behind the ⓘ, how a
                link works, the pinned history sentence by reference
                and — lived-in only — the one way the door reopens. Its own
                testIDs: the code-sent notice's slot stays its own. */}
            {joinExisting ? (
              <>
                <InlineNotice
                  tone="quiet"
                  message={
                    joinExisting.pristine
                      ? LINKING_COPY.joinExistingAccount
                      : LINKING_COPY.joinExistingAccountLivedIn
                  }
                  announce={false}
                  testID="account-email-join-existing"
                />
                <InfoDisclosure
                  label={LINKING_COPY.joinExistingAccountInfoLabel}
                  lines={[
                    ...LINKING_COPY.joinExistingAccountInfo,
                    LINKING_COPY.historyStance,
                    ...(joinExisting.pristine ? [] : [LINKING_COPY.joinExistingAccountStartOver]),
                  ]}
                  testID="account-email-join-existing-info"
                />
              </>
            ) : null}
            {maybeHeldElsewhere ? (
              <InlineNotice
                tone="quiet"
                message={ACCOUNTS_COPY.emailMaybeHeldElsewhere}
                announce={false}
                testID="account-email-maybe-elsewhere"
              />
            ) : null}
            <TextInput
              value={emailDraft}
              onChangeText={setEmailDraft}
              placeholder={ACCOUNTS_COPY.emailPlaceholder}
              placeholderTextColor={t.color.inkMuted}
              keyboardAppearance={t.scheme}
              selectionColor={t.color.pine}
              cursorColor={t.color.pine}
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
                  borderColor: t.color.lineField,
                },
              ]}
            />
            {emailDraft.trim() !== '' && !draftComplete ? (
              <Text
                style={[t.type.compactBody, { color: t.color.inkMuted }]}
                testID="account-email-unfinished"
              >
                {ACCOUNTS_COPY.emailUnfinished}
              </Text>
            ) : null}
            <PrimaryButton
              label={
                resendWait > 0
                  ? ACCOUNTS_COPY.requestAgainIn(accounts.formatResendClock(resendWait))
                  : pending
                    ? ACCOUNTS_COPY.emailRequestAgain
                    : ACCOUNTS_COPY.emailRequest
              }
              onPress={requestCode}
              disabled={busy || !draftComplete || resendWait > 0}
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
                  cursorColor={t.color.pine}
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
                      borderColor: t.color.lineField,
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
          <Text
            style={[t.type.body, { color: t.color.inkStrong }]}
            testID="account-email-verified"
          >
            {ACCOUNTS_COPY.emailVerified(identifier!.email!)}
          </Text>
        ) : null}
        {/* HELD ELSEWHERE (D2): the account holds a verified email this
            device has no row for — a linked sibling linked it. No input
            (the server would refuse the attach), no switch (it records
            the linking device's own decision and lives there), the fact
            said plainly, and under the same findability heading the one
            verb that needs no address: Remove (the unlink route carries
            none). The downgrade below stays. */}
        {loaded && heldElsewhere ? (
          <Text
            style={[t.type.body, { color: t.color.inkStrong }]}
            testID="account-email-held-elsewhere"
          >
            {ACCOUNTS_COPY.emailHeldElsewhere}
          </Text>
        ) : null}

        {loaded && (verified || heldElsewhere) ? (
          <>
            {/* The consent toggle — DEFAULT OFF. What it renders is the
                LOCAL consent record; the wire's 204 is uniform by design
                and is never treated as a receipt. ONE section heading for
                both surfaces (the rotor contract counts it once). */}
            <RuledLabel label={ACCOUNTS_COPY.discoverableTitle} heading />
            {/* HELD ELSEWHERE (the proof pass, 2026-10-08): the switch shows
                the ACCOUNT's current bit from the caller-owned state and
                moves it from here — the consent write is group-keyed — so a
                lost, reinstalled or recovered linking device leaves the
                switch with the devices that remain. Only while the bit is
                readable; otherwise the fact is said and no switch is drawn. */}
            {!verified && facts?.emailFindable !== null && facts?.emailFindable !== undefined ? (
              <>
                <View style={styles.toggleRow}>
                  <Text
                    style={[t.type.compactBody, styles.toggleLabel, { color: t.color.inkBody }]}
                  >
                    {ACCOUNTS_COPY.discoverableLabel}
                  </Text>
                  <Switch
                    value={facts.emailFindable}
                    onValueChange={toggleDiscoverable}
                    disabled={busy}
                    accessibilityLabel={ACCOUNTS_COPY.discoverableLabel}
                    trackColor={{ false: t.color.inkMuted, true: t.color.pine }}
                    thumbColor={t.color.paperGround}
                    ios_backgroundColor={t.color.inkMuted}
                    testID="discoverable-toggle-elsewhere"
                  />
                </View>
                <Text
                  style={[t.type.compactBody, { color: t.color.inkMuted }]}
                  testID="account-email-held-findability"
                >
                  {ACCOUNTS_COPY.emailHeldElsewhereFindability}
                </Text>
              </>
            ) : null}
            {!verified && (facts?.emailFindable === null || facts?.emailFindable === undefined) ? (
              <Text
                style={[t.type.compactBody, { color: t.color.inkBody }]}
                testID="account-email-held-findability"
              >
                {ACCOUNTS_COPY.emailHeldElsewhereFindabilityUnknown}
              </Text>
            ) : null}
            {verified ? (
              <>
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
                    // Painted here, or the control paints itself iOS system
                    // green — a hue in neither palette. Pine when
                    // on; when off, the muted ink (the proof pass, 2026-10-08:
                    // the inset paper's OFF track measured 1.27:1 against the
                    // white page, and the ink knob 2.7:1 on pine). The knob is
                    // the PAGE colour — white on light pine (6.5:1), the dark
                    // ground on the lighter dark-mode pine (7:1) — and reads on
                    // the gray OFF track at 6:1 either way.
                    trackColor={{ false: t.color.inkMuted, true: t.color.pine }}
                    thumbColor={t.color.paperGround}
                    ios_backgroundColor={t.color.inkMuted}
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
              </>
            ) : null}

            {unlinkControls(
              verified
                ? ACCOUNTS_COPY.emailUnlinkConfirm(identifier!.email!)
                : ACCOUNTS_COPY.emailHeldElsewhereUnlinkConfirm,
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
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingTop: 8, paddingBottom: 48, alignItems: 'center' },
  /** Full width until contentMax caps it — the Open a room pattern. */
  column: { width: '100%', gap: 14 },
  input: { paddingHorizontal: 14 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: { flex: 1, marginRight: 12 },
});
