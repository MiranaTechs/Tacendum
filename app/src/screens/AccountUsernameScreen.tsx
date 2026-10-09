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
import { LINKING_COPY, onUsernameNotice } from '../linking';
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

/** The answer this screen keeps when the state read itself throws (it
 * should not — the module catches everything — but a surface never crashes
 * over a read): a transport failure, every fact unknown. */
const STATE_FAILED: accountsUsername.IdentifierState = {
  source: 'state',
  eligibility: 'failed',
  holdsUsername: null,
  emailLinked: null,
  phoneLinked: null,
  cooldownUntil: null,
  usernameSince: null,
  emailSince: null,
  usernameFindable: null,
  emailFindable: null,
};

/** What THIS device knows about its own standing for a link (the unlinked
 * second device, 2026-10-08 follow-up): whether it has ever joined an
 * account group, and whether it is still a fresh install (`pristine` is
 * null when that read failed). Read once per mount from the local database,
 * never from the wire. */
interface LinkStanding {
  grouped: boolean;
  pristine: boolean | null;
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
 * WHAT THIS SCREEN KNOWS, AND FROM WHERE (fix/username-discovery,
 * 2026-10-08 — the linked-sibling report): the NAME lives only in
 * this device's own row, because the server stores a keyed hash and never
 * echoes it (§4.9) and the rows do not sync between siblings. Whether the
 * ACCOUNT holds a name, and whether a change is still waiting out its 30
 * days, come from the caller-owned state read (accountsUsername.
 * getIdentifierState — GET /v1/identifiers/state, falling back to the
 * eligibility read against a server that does not serve it yet). So:
 *  - a row here + the group holds a name: the held state, as always;
 *  - no row + the group holds a name: HELD ELSEWHERE — the fact said, Change
 *    (the rename route, the consent bit explicit) and Remove offered, and
 *    NEVER the claim form, whose claim spelling renamed the account by
 *    accident on every sibling until now;
 *  - a row here + the group holds NO name (a definite answer from the state
 *    route, never the legacy path): a PHANTOM — the row is cleared and the
 *    person told it was changed or removed from another device;
 *  - a row here + the group holds a name WRITTEN AFTER this row (the state
 *    route's `usernameSince` is later than the row's `claimedAt`, beyond a
 *    clock-skew allowance — the gate pass, 2026-10-08): a sibling RENAMED
 *    the account, and this row is the same phantom — cleared, said, and the
 *    held-elsewhere state follows (the switch would have moved the
 *    sibling's name, and Remove would have deleted it under the old one);
 *  - the state route's answer, where it landed, is THE cool-down: null
 *    included. A memory this device wrote governs only where the server
 *    could not answer (legacy, refused, failed) — a wrong local stamp must
 *    never darken Change behind a date the server does not hold;
 *  - a refused or failed RE-read keeps the last landed facts and changes
 *    only the verdict: a sibling tapping Remove offline must not fall from
 *    the held-elsewhere state into the claim form;
 *  - the legacy path (today's production server): today's behaviour, plus
 *    the stop-gap sentence after a refused claim with no row.
 *
 * Username display and eligibility rules:
 *  - the shape, the PUBLIC denylist (exact, skeleton and the reserved
 *    affixes) and the name already held are checked LOCALLY, live, before
 *    the wire (refused, never repaired; a reserved or same name never spends
 *    a claim attempt) — and each local refusal has its OWN sentence,
 *    honestly distinguishable from the server's answers;
 *  - the claim gate's possession-proof precondition is read from the
 *    server's caller-owned state, so a verified identifier on a linked
 *    sibling qualifies; without it the reason and the door are shown ALONE,
 *    never a typeable form under a button that can never light (U6);
 *  - the server answers this class with exactly TWO shapes: the frozen 409
 *    `taken` (rendered as taken) and the frozen 403 for everything else —
 *    fleet ceiling, caller budget, gate, cool-down alike — rendered as a
 *    generic "try again later" that never says why (distinguishable
 *    by status alone). A transport failure gets the connection sentence.
 *    The ONE exception is the device's own knowledge: inside a cool-down it
 *    knows about (its own rename or unlink, or the state route's stamp) the
 *    refusal is said with the date, and the tap it knows would be refused
 *    is dark — the exact removed name stays reclaimable (U2);
 *  - a refused STATE read is not a connection problem: the frozen 403 on
 *    that read is this device's identifier-route budget or a dark flag, so
 *    it gets a neutral sentence; only a transport failure blames the
 *    connection (U3). And this device paces its own identifier-route calls:
 *    the eleventh in a minute is said before the tap, never a first call;
 *  - the consent-at-claim checkbox is DEFAULT CHECKED on a claim (a
 *    handle exists to be found), the bit rides the wire explicitly, and an
 *    unchecked claim is legal — shown honestly as held-but-unfindable. A
 *    RENAME's box starts at the current findability: changing a name must
 *    not silently flip a person from unfindable to findable; a rename from
 *    a sibling that cannot read the bit starts at the claim default, the
 *    box in plain view;
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
  // The caller-owned state read: null until the first answer lands (the
  // layout waits for it — a sibling must never see a claim form flash);
  // afterwards the LAST landed answer governs the layout while a re-read is
  // out, so a refused "taken" does not unmount the field under the keyboard.
  const [state, setState] = useState<accountsUsername.IdentifierState | null>(null);
  const [checking, setChecking] = useState(true);
  const stateSeq = useRef(0);
  // THIS device's memory of the unlink it performed and of
  // the cool-down window it started (U2): seeded once from their rows at
  // mount, then moved by this screen's own verbs — the unlink sets both, a
  // landed rename stamps the window, a successful claim clears the unlink
  // memory. Never re-read on refresh: it is not account state a sibling can
  // move, it is what this device did.
  const [unlinked, setUnlinked] = useState<db.UsernameUnlinkRow | null>(null);
  const [cooldown, setCooldown] = useState<db.UsernameCooldownRow | null>(null);
  // THIS device's standing for a link (the unlinked second device): null
  // until both local reads answer; an unknown renders no guidance.
  const [local, setLocal] = useState<LinkStanding | null>(null);
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
  // A row this device showed for a name the group no longer holds was
  // cleared this visit (U1): the person is told, once — and told WHICH
  // happened (the proof pass, 2026-10-08): a sibling removed the name, or
  // changed it.
  const [phantomCleared, setPhantomCleared] = useState<'removed' | 'renamed' | null>(null);
  // The legacy path's stop-gap (U1): shown after a refused claim with no
  // local row, against a server that cannot say whether the group holds a
  // name.
  const [stopGap, setStopGap] = useState(false);

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

  /** The caller-owned state read. The module serves a landed answer from
   * memory for a minute and never keeps a refusal or a failure, so Retry
   * reaches the wire; every verb below invalidates it before this re-reads. */
  const refreshState = useCallback(() => {
    if (!USERNAME_UI_ENABLED) return;
    const mySeq = ++stateSeq.current;
    setChecking(true);
    const land = (next: accountsUsername.IdentifierState): void => {
      if (stateSeq.current !== mySeq) return;
      // A refused or failed RE-read carries no facts: the last landed
      // answer keeps governing the layout, and only the verdict moves (it
      // darkens submit and shows its notice). Without this a sibling that
      // tapped Remove with the network gone dropped from the held-elsewhere
      // state into the claim form — the exact screen U1 removes.
      setState(prev =>
        prev === null || accountsUsername.stateLanded(next)
          ? next
          : { ...prev, source: next.source, eligibility: next.eligibility },
      );
      setChecking(false);
    };
    void accountsUsername.getIdentifierState().then(land, () => land(STATE_FAILED));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    refreshState();
    return () => {
      stateSeq.current += 1;
    };
  }, [refreshState]);
  useEffect(() => {
    db.loadUsernameUnlink()
      .then(row => setUnlinked(row))
      .catch(() => undefined);
    db.loadUsernameCooldown()
      .then(row => setCooldown(row))
      .catch(() => undefined);
  }, []);
  // THIS DEVICE'S OWN STANDING FOR A LINK (the unlinked second device,
  // 2026-10-08 follow-up): whether it has ever joined an account group, and
  // whether it is still a fresh install — the two LOCAL facts that decide
  // whether the needs-verification state may point at linking (started from
  // the other device) instead of at verifying an email the other account
  // already holds. Read once per mount, never from the wire; an unknown
  // (either read failed) renders no guidance, because wrong guidance is
  // worse than none. Under the dark pin the screen renders nothing and asks
  // nothing.
  useEffect(() => {
    if (!USERNAME_UI_ENABLED) return undefined;
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
  // A revocation landing while this surface is open re-reads the row, the
  // notice and the group's state — the recovery-notice precedent
  // (LinkedDevicesScreen). The row is gone, so a rename under way is moot:
  // the form falls back to CLAIM mode with the claim default, never the
  // renamed row's old bit.
  useEffect(
    () =>
      onUsernameNotice(() => {
        setRenaming(false);
        setConsent(true);
        refresh();
        accountsUsername.invalidateIdentifierState();
        refreshState();
      }),
    [refresh, refreshState],
  );

  // THE PHANTOM ROW (U1): this device shows a name the group no longer
  // holds — a linked sibling removed it (`holdsUsername === false`) — or a
  // name the group has since REPLACED: a sibling renamed the account, and
  // the live row's birth (`usernameSince`) is later than this row's
  // `claimedAt` beyond the skew allowance (the gate pass, 2026-10-08).
  // Only a DEFINITE answer clears it: a fact from the state route itself.
  // The legacy path and a refused or failed read leave the facts unknown
  // (null), and an unknown never erases what this device recorded. This
  // device's own claim never trips it: its row is stamped AFTER the wire
  // answered, so the server's stamp is never later than it by more than
  // the latency.
  // Judged only against a SETTLED answer (the proof pass, 2026-10-08):
  // while a re-read is out, the facts on hand may be this screen's own
  // optimistic ones beside a row the database just returned with its
  // fresh server stamp — two halves of one write, never a phantom. And a
  // row written since the proof pass carries that stamp (`since`): the
  // live stamp must EQUAL it, exactly, so a sibling's rename inside five
  // minutes of this device's own claim is seen on the next read, and a
  // slow clock never reads its own row as a phantom. An older row keeps
  // the skew rule.
  useEffect(() => {
    if (!loaded || identifier === null || state === null || checking) return;
    if (!accountsUsername.stateHasFacts(state)) return;
    const removedElsewhere = state.holdsUsername === false;
    const renamedElsewhere =
      state.holdsUsername === true &&
      accountsUsername.localRowStale(
        identifier.claimedAt,
        state.usernameSince,
        identifier.since ?? null,
      );
    if (removedElsewhere || renamedElsewhere) {
      setIdentifier(null);
      setRenaming(false);
      setConsent(true);
      setConfirmingUnlink(false);
      setPhantomCleared(removedElsewhere ? 'removed' : 'renamed');
      void accountsUsername.forgetPhantomUsername().catch(() => undefined);
      return;
    }
    // THE ROW IS THE ACCOUNT'S — two things follow, in the same write (the
    // proof pass, 2026-10-08). It ADOPTS the server's stamp when it has
    // none of its own (this device's claim that just landed, or a row from
    // a build before the stamp existed): from then on only exact equality
    // keeps it, so a sibling's rename inside five minutes is seen and a
    // slow clock never trips it. And its consent BIT follows the account's:
    // the bit is the group's — a sibling may switch it from its own
    // held-elsewhere state — and the state read carries it (a read of the
    // caller's own account; the write's 204 stays no receipt).
    const since = accountsUsername.adoptableRowStamp(
      { stamp: identifier.claimedAt, since: identifier.since ?? null },
      state,
      'username',
    );
    const bit = state.usernameFindable;
    const follow = bit !== null && identifier.discoverable !== bit;
    if (since === null && !follow) return;
    const next: db.UsernameIdentifierRow = {
      ...identifier,
      ...(since !== null ? { since } : {}),
      ...(follow ? { discoverable: bit } : {}),
    };
    setIdentifier(next);
    void db.saveUsernameIdentifier(next).catch(() => undefined);
  }, [loaded, identifier, state, checking]);

  // THE WINDOW ROW FOLLOWS THE SERVER (the gate pass, 2026-10-08): where the
  // state route answered, its window is recorded as this device's memory —
  // the end the server holds, not one this clock guessed after a verb —
  // and a memory the server contradicts (no window) is cleared. The offline
  // fallback (legacy, refused, failed) then carries the server's last word.
  useEffect(() => {
    if (state === null || !accountsUsername.stateHasFacts(state)) return;
    const serverEnd = state.cooldownUntil;
    if (serverEnd === null) {
      if (cooldown !== null) {
        setCooldown(null);
        void db.clearUsernameCooldown().catch(() => undefined);
      }
      return;
    }
    if (cooldown === null || cooldown.until !== serverEnd) {
      setCooldown({ until: serverEnd });
      void db.saveUsernameCooldown({ until: serverEnd }).catch(() => undefined);
    }
  }, [state, cooldown]);

  const run = useCallback(
    (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      void work()
        .catch(() => setError(ACCOUNTS_USERNAME_COPY.tryLater))
        .finally(() => {
          setBusy(false);
          refresh();
          // The module invalidated its memory on every wire verb: this
          // re-read reaches the server and brings the group's facts back.
          refreshState();
        });
    },
    [refresh, refreshState],
  );

  // THE COOL-DOWN WINDOW (U2): the state route's answer where it landed
  // (null included — the server's stamp is the only one it enforces); and
  // only where the server could not answer, everything this device wrote —
  // the window row and the unlink moment an older build left — the latest
  // end still ahead, or null. Computed before the gate below because
  // the tick effect under it is a hook.
  const nowMs = Date.now();
  const windowEnd = accountsUsername.knownCooldownEnd(
    state,
    [
      cooldown?.until,
      unlinked === null ? null : unlinked.unlinkedAt + accountsUsername.USERNAME_COOLDOWN_MS,
    ],
    nowMs,
  );
  // The window ends while the screen is open: nothing above re-renders at
  // the boundary on its own, so a timer re-renders once it passes and the
  // button lights without a tap (the email screen's clock-tick pattern;
  // re-armed per render, at most one).
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (windowEnd === null) return undefined;
    const timer = setTimeout(
      () => setClockTick(n => n + 1),
      Math.min(2_147_000_000, Math.max(250, windowEnd - Date.now() + 250)),
    );
    return () => clearTimeout(timer);
  });

  // Gate the screen itself so programmatic navigation cannot expose disabled
  // username features.
  if (!USERNAME_UI_ENABLED) return null;

  const landed = state !== null;
  const verdict = state?.eligibility ?? null;
  const needsVerification = verdict === 'needs_verification';
  const canSubmit = verdict === 'eligible' && !checking;

  const heldLocal = identifier !== null;
  // The group holds a name this device never recorded: a fact only the
  // state route can give (null on the legacy path, on a refusal, on a
  // failure — and null is UNKNOWN, never "no").
  const heldElsewhere = !heldLocal && state?.holdsUsername === true;
  const held = heldLocal || heldElsewhere;

  const windowLabel = windowEnd === null ? null : accountsUsername.cooldownEndLabel(windowEnd);
  // What this device KNOWS it removed (a name, or the fact alone) — said
  // only while a window is running: with the server reporting none, the
  // reclaim rule it names no longer binds anything.
  const unlinkWarned =
    !held &&
    windowEnd !== null &&
    unlinked !== null &&
    accountsUsername.unlinkCooldownActive(unlinked, nowMs);
  const normalizedDraft = accountsUsername.normalizedUsernameOrNull(nameDraft);
  // Inside the window, the taps this device knows the server would refuse:
  // every rename (a holder inside the window is refused before the budgets)
  // and, on the device that pressed Remove and still knows the name, every
  // name but the exact one removed. A device that cannot know the
  // reclaimable name (a sibling, an empty-name memory) keeps the tap live
  // and renders the refusal with the date instead.
  const reclaimable =
    unlinked !== null && unlinked.username !== '' && normalizedDraft === unlinked.username;
  const windowBlocks =
    windowEnd !== null &&
    (held || (unlinked !== null && unlinked.username !== '' && !reclaimable));

  /** The local syntax, reserved-name and same-name checks use this
   * device's own knowledge, rendered as the
   * person types — never a wire call, and never a repair. Empty is quiet,
   * not wrong. */
  const sameName = heldLocal && normalizedDraft !== null && normalizedDraft === identifier.username;
  const localCheck: accountsUsername.UsernameLocalCheck | 'same' | null =
    nameDraft.trim() === ''
      ? null
      : sameName
        ? 'same'
        : accountsUsername.checkUsernameLocally(nameDraft);
  const localMessage =
    localCheck === 'invalid'
      ? ACCOUNTS_USERNAME_COPY.invalid
      : localCheck === 'reserved'
        ? ACCOUNTS_USERNAME_COPY.reserved
        : localCheck === 'same'
          ? ACCOUNTS_USERNAME_COPY.sameName
          : null;

  /** This device's own pacing (U3): the eleventh identifier-route call in a
   * minute is said before the tap. Never a first call — the ledger starts
   * empty — and never the gate: the server stays the authority. */
  const paced = (): boolean => {
    const wait = accountsUsername.identifierRoutePacing(Date.now());
    if (wait === null) return false;
    setError(ACCOUNTS_USERNAME_COPY.paced(wait));
    return true;
  };

  const submit = () => {
    // The button is dark for each of these; a press that reaches here
    // anyway (a stale tap, a screen reader) changes nothing on the wire.
    if (localCheck !== 'ok' || !canSubmit || windowBlocks) {
      if (windowBlocks && windowLabel !== null) {
        setError(
          held
            ? ACCOUNTS_USERNAME_COPY.cooldownUntil(windowLabel)
            : ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(windowLabel),
        );
      }
      return;
    }
    if (paced()) return;
    const fromElsewhere = heldElsewhere;
    const heldNow = held;
    const hadRow = heldLocal;
    const legacy = state?.source === 'legacy';
    const window = windowLabel;
    run(async () => {
      // A sibling that cannot see the name sends the RENAME route (U1):
      // the claim spelling would rename the account by accident. A device
      // with a row lets the module spell the route from it, as always.
      const outcome = fromElsewhere
        ? await accountsUsername.renameUsername(nameDraft, consent)
        : await accountsUsername.claimUsername(nameDraft, consent);
      switch (outcome) {
        case 'claimed':
        case 'renamed': {
          const sentName = accountsUsername.normalizedUsernameOrNull(nameDraft);
          setNameDraft('');
          setRenaming(false);
          // A successful claim ends the unlink memory (the module cleared the row).
          setUnlinked(null);
          setStopGap(false);
          setPhantomCleared(null);
          // The group holds the name this device just sent — said now, so
          // the layout does not wait on the re-read — AND the row this
          // device just wrote, in the SAME batch (the gate pass: the fact
          // alone, with the row still on its way from the database, drew
          // the held-elsewhere sentence over the device that just claimed).
          // The live row's stamp is UNKNOWN until the re-read lands (the
          // proof pass): a stale stamp beside the fresh row would read as
          // a sibling's rename.
          setState(s =>
            s ? { ...s, holdsUsername: true, usernameFindable: consent, usernameSince: null } : s,
          );
          if (sentName !== null) {
            setIdentifier({ username: sentName, claimedAt: Date.now(), discoverable: consent });
          }
          // The window: a rename stamped it (the module persisted the same
          // memory) and the re-read brings the server's own end; a claim
          // kept a running one and cleared a passed one.
          if (outcome === 'renamed') {
            setCooldown({ until: Date.now() + accountsUsername.USERNAME_COOLDOWN_MS });
          } else {
            setCooldown(c => (c !== null && c.until > Date.now() ? c : null));
          }
          return;
        }
        case 'same':
          setError(ACCOUNTS_USERNAME_COPY.sameName);
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
          // one generic sentence that never says why… except where
          // THIS device already knows why: inside a window it knows about,
          // the refusal is the date (U2).
          if (window !== null) {
            setError(
              heldNow
                ? ACCOUNTS_USERNAME_COPY.cooldownUntil(window)
                : ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(window),
            );
            return;
          }
          setError(ACCOUNTS_USERNAME_COPY.tryLater);
          // The legacy path cannot say whether the group holds a name: the
          // stop-gap names the one thing this device can honestly suggest.
          if (legacy && !hadRow) setStopGap(true);
          return;
      }
    });
  };

  const toggleDiscoverable = (on: boolean) => {
    if (paced()) return;
    run(async () => {
      const outcome = await accountsUsername.setUsernameDiscoverable(on);
      if (outcome !== 'ok') {
        setError(
          outcome === 'failed'
            ? ACCOUNTS_USERNAME_COPY.failed
            : ACCOUNTS_USERNAME_COPY.tryLater,
        );
        return;
      }
      // The ACCOUNT's bit, said now in the same batch (the proof pass:
      // on a sibling the switch renders this bit, no row of its own); the
      // re-read in `run`'s finally brings the server's own answer.
      setState(s => (s ? { ...s, usernameFindable: on } : s));
      setIdentifier(row => (row ? { ...row, discoverable: on } : row));
    });
  };

  const unlink = () => {
    if (paced()) return;
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
      // what it just did (the module persisted the same memory). A name it
      // never had is recorded as the empty name — the wire never echoes
      // one (§4.9) — so the warning keeps the rule and names nothing.
      setRenaming(false);
      setConsent(true);
      const at = Date.now();
      setUnlinked({ username: letGo ?? '', unlinkedAt: at });
      setCooldown({ until: at + accountsUsername.USERNAME_COOLDOWN_MS });
      // The row goes in the SAME batch as the fact (the gate pass): the
      // fact alone, beside a row still on its way out of the database, read
      // as a sibling's removal and raised the phantom notice over this
      // device's own Remove.
      setIdentifier(null);
      setState(s => (s ? { ...s, holdsUsername: false, usernameSince: null, usernameFindable: null } : s));
      setPhantomCleared(null);
    });
  };

  const dismissRevoked = () =>
    run(async () => {
      await db.clearUsernameNotice();
    });

  // The layout waits for the first state answer: a sibling must never see
  // a claim form flash over a name its account holds (U1), and an
  // unverified account gets the reason and the door, never a form under a
  // button that cannot light (U6). A held name shows the form only while a
  // rename is under way.
  const formOpen = loaded && landed && (held ? renaming : !needsVerification);
  const showNeedsIdentifier = loaded && landed && needsVerification && (!held || renaming);
  // THE UNLINKED SECOND DEVICE (2026-10-08 follow-up): no verified
  // identifier on the account, this device never grouped, and both local
  // reads answered — the reason and the door are joined by the one thing
  // that would actually work (joining the other account, from the other
  // device) or, on a lived-in device, by why it no longer can. A grouped
  // but unverified pair keeps today's copy: there, verifying IS the answer.
  // On the legacy read too — the verdict is all it needs, and the facts it
  // uses are this device's own.
  const joinExisting =
    showNeedsIdentifier && !held && local !== null && !local.grouped && local.pristine !== null
      ? local
      : null;

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
        cursorColor={t.color.pine}
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
            borderColor: t.color.lineField,
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
              borderColor: consent ? t.color.pine : t.color.lineField,
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
        disabled={busy || localCheck !== 'ok' || !canSubmit || windowBlocks}
        // Why the button is dark, for a screen reader (the proof pass): the
        // date the window ends rides on the control itself.
        {...(windowBlocks && windowLabel !== null
          ? {
              accessibilityHint: held
                ? ACCOUNTS_USERNAME_COPY.cooldownUntil(windowLabel)
                : ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(windowLabel),
            }
          : {})}
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

  /** The door the needs-verification sentence names, one tap away.
   * Without it wired, the sentence stands alone. */
  const needsIdentifier = (
    <>
      <InlineNotice
        tone="quiet"
        message={ACCOUNTS_USERNAME_COPY.needsIdentifier}
        announce={false}
        testID="account-username-needs-identifier"
      />
      <Text
        testID="account-username-without-verification"
        style={[t.type.compactBody, { color: t.color.inkMuted }]}
      >
        {ACCOUNTS_USERNAME_COPY.withoutVerification}
      </Text>
      {onOpenAccountEmail ? (
        <TextAction
          label={ACCOUNTS_USERNAME_COPY.needsIdentifierAction}
          onPress={onOpenAccountEmail}
          testID="account-username-link-email"
        />
      ) : null}
      {/* THE UNLINKED SECOND DEVICE: under the door, the notice that fits
          this device (a fresh install can still join the other account; a
          lived-in one cannot) and, behind the ⓘ, how a link works, the
          pinned history sentence by reference and — lived-in only —
          the one way the door reopens. Copy from the linking deck: no idiom
          noun, so the handle deck's census stays clean. */}
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
            testID="account-username-join-existing"
          />
          <InfoDisclosure
            label={LINKING_COPY.joinExistingAccountInfoLabel}
            lines={[
              ...LINKING_COPY.joinExistingAccountInfo,
              LINKING_COPY.historyStance,
              ...(joinExisting.pristine ? [] : [LINKING_COPY.joinExistingAccountStartOver]),
            ]}
            testID="account-username-join-existing-info"
          />
        </>
      ) : null}
    </>
  );

  /** Change and Remove, for a name held here or on another device: the
   * cool-down rule, the date when a window is running (U2), the rename door
   * and the two-step unlink. */
  const heldActions = (
    <>
      {/* Rename and unlink ride this screen with the cool-down surfaced
          — and, inside a window this device knows about,
          its end named in plain words. */}
      <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
        {ACCOUNTS_USERNAME_COPY.cooldownNote}
      </Text>
      {windowLabel !== null ? (
        <>
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_USERNAME_COPY.cooldownUntil(windowLabel)}
            announce={false}
            testID="account-username-cooldown-until"
          />
          {/* Inside a known window Change is WITHHELD (the proof pass,
              2026-10-08): the server refuses every rename by a holder
              there, so the form it opened could never submit — the dead
              form U6 removed elsewhere. The one way back is said instead. */}
          <Text
            style={[t.type.compactBody, { color: t.color.inkMuted }]}
            testID="account-username-take-back"
          >
            {ACCOUNTS_USERNAME_COPY.takeBackNow}
          </Text>
        </>
      ) : null}
      {!renaming && !confirmingUnlink && windowLabel === null ? (
        <TextAction
          label={ACCOUNTS_USERNAME_COPY.rename}
          onPress={() => {
            // A rename's box starts at the CURRENT findability: a change of
            // name must never flip consent on its own — from this device's
            // row, or (a sibling, the gate pass) from the bit the state route
            // carries; only where neither is known does it start at the
            // claim default, the box in plain view.
            setConsent(identifier?.discoverable ?? state?.usernameFindable ?? true);
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
        {/* The reading column (the proof pass, 2026-10-08): capped at
            contentMax like Open a room, so an iPad does not run a body
            line to 190 characters. */}
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
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

        {/* A name this device showed and the group no longer holds as this
            device knew it (U1): removed, or changed from another device —
            said as WHICH (the proof pass, 2026-10-08). After a removal
            inside a window this device did not start, ONE notice carries
            the fact, the date and the exception (it used to stack two
            notices hedging "changed or removed" twice); after a change the
            held-elsewhere state follows with its own dated line. */}
        {phantomCleared !== null && !heldLocal ? (
          <InlineNotice
            tone="quiet"
            message={
              phantomCleared === 'renamed'
                ? ACCOUNTS_USERNAME_COPY.phantomRenamed
                : windowLabel !== null && !held && !unlinkWarned
                  ? ACCOUNTS_USERNAME_COPY.phantomRemovedWindow(windowLabel)
                  : ACCOUNTS_USERNAME_COPY.phantomRemoved
            }
            testID="account-username-phantom"
          />
        ) : null}

        {/* The claim/rename proof gate comes from an authoritative,
            caller-owned group read. It never describes a target and it sees
            a verified identifier held by a linked sibling. Without it the
            reason and the door stand ALONE (U6): consent and unlink remain
            usable if proof is removed. */}
        {showNeedsIdentifier ? needsIdentifier : null}
        {loaded && !landed ? (
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_USERNAME_COPY.eligibilityChecking}
            announce={false}
            testID="account-username-eligibility-checking"
          />
        ) : null}
        {/* A REFUSED read is not a connection problem (U3): the frozen 403
            on the caller-owned read is this device's identifier-route
            budget or a dark flag, so its sentence blames nothing. Only a
            transport failure blames the connection. Retry reaches the wire
            either way — the module never keeps these answers. */}
        {formOpen && verdict === 'refused' ? (
          <>
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.eligibilityRefused}
              testID="account-username-eligibility-refused"
            />
            <TextAction
              label={ACCOUNTS_USERNAME_COPY.eligibilityRetry}
              onPress={refreshState}
              testID="account-username-eligibility-retry"
            />
          </>
        ) : null}
        {formOpen && verdict === 'failed' ? (
          <>
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.eligibilityUnavailable}
              testID="account-username-eligibility-unavailable"
            />
            <TextAction
              label={ACCOUNTS_USERNAME_COPY.eligibilityRetry}
              onPress={refreshState}
              testID="account-username-eligibility-retry"
            />
          </>
        ) : null}
        {/* THE CLAIM FORM'S COOL-DOWN (§4.8, U2). The device that pressed
            Remove knows the rule, the reclaimable name and the date; a
            device inside a window it did not start (the name was changed or
            removed on another device) knows the rule and the date, and says
            so without a name — none travels. */}
        {loaded && unlinkWarned ? (
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink(unlinked!.username)}
            announce={false}
            testID="account-username-cooldown"
          />
        ) : null}
        {loaded && !held && windowLabel !== null ? (
          unlinkWarned ? (
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(windowLabel)}
              announce={false}
              testID="account-username-cooldown-claim"
            />
          ) : phantomCleared === 'removed' ? null : (
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.cooldownElsewhere(windowLabel)}
              announce={false}
              testID="account-username-cooldown-elsewhere"
            />
          )
        ) : null}

        {/* THE HELD STATES — here, or on another device — under ONE
            findability heading (the rotor contract counts it once):
            the name's line, then the switch — this device's row's bit, or
            (held elsewhere) the account's bit from the caller-owned state —
            then Change and Remove. */}
        {loaded && held ? (
          <>
            {heldLocal ? (
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
              </>
            ) : (
              /* HELD ELSEWHERE (U1): the group holds a name this device never
                 recorded. The name itself never travels (§4.9), so the fact is
                 said, Change (the rename route, the consent bit explicit) and
                 Remove are offered, and the claim form — whose claim spelling
                 renamed the account by accident on every sibling — never shows. */
              <Text
                style={[t.type.body, { color: t.color.inkStrong }]}
                testID="account-username-held-elsewhere"
              >
                {ACCOUNTS_USERNAME_COPY.heldElsewhere}
              </Text>
            )}

            {/* Username discovery consent has its own row and is never changed
                by the email or phone toggles. The ruled
                heading is the section's TITLE; the row carries the switch's
                own label (V3: the label used to print twice). */}
            <RuledLabel label={ACCOUNTS_USERNAME_COPY.discoverableTitle} heading />
            {heldLocal ? (
              <>
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
                    // Painted here, or the control paints itself iOS system
                    // green — a hue in neither palette. Pine when
                    // on; the muted ink when off (the proof pass, 2026-10-08: the
                    // inset paper measured 1.27:1 against the white page and the
                    // ink knob 2.7:1 on pine). The knob is the PAGE colour —
                    // white on light pine (6.5:1), the dark ground on dark-mode
                    // pine (7:1) — and 6:1 on the gray OFF track either way.
                    trackColor={{ false: t.color.inkMuted, true: t.color.pine }}
                    thumbColor={t.color.paperGround}
                    ios_backgroundColor={t.color.inkMuted}
                    testID="username-discoverable-toggle"
                  />
                </View>
                {!identifier!.discoverable ? (
                  <InlineNotice
                    tone="quiet"
                    message={ACCOUNTS_USERNAME_COPY.heldUnfindable}
                    announce={false}
                    testID="account-username-unfindable"
                  />
                ) : null}
                <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
                  {ACCOUNTS_USERNAME_COPY.discoverableNote}
                </Text>
              </>
            ) : state?.usernameFindable !== null && state?.usernameFindable !== undefined ? (
              /* THE SWITCH ON A SIBLING (the proof pass, 2026-10-08): the
                 account's current bit from the caller-owned state
                 (`usernameFindable`), movable from here — the consent write
                 is group-keyed — so the person can see and change whether the
                 name finds them from any device, and a lost or reinstalled
                 claiming device leaves the switch with the devices that
                 remain. */
              <>
                <View style={styles.toggleRow}>
                  <Text
                    style={[t.type.compactBody, styles.toggleLabel, { color: t.color.inkBody }]}
                  >
                    {ACCOUNTS_USERNAME_COPY.discoverableLabel}
                  </Text>
                  <Switch
                    value={state.usernameFindable}
                    onValueChange={toggleDiscoverable}
                    disabled={busy}
                    accessibilityLabel={ACCOUNTS_USERNAME_COPY.discoverableLabel}
                    trackColor={{ false: t.color.inkMuted, true: t.color.pine }}
                    thumbColor={t.color.paperGround}
                    ios_backgroundColor={t.color.inkMuted}
                    testID="username-discoverable-toggle-elsewhere"
                  />
                </View>
                <Text
                  style={[t.type.compactBody, { color: t.color.inkMuted }]}
                  testID="account-username-held-elsewhere-findability"
                >
                  {ACCOUNTS_USERNAME_COPY.heldElsewhereFindability}
                </Text>
              </>
            ) : (
              /* No switch while the bit is unreadable; the fact is said. */
              <Text
                style={[t.type.compactBody, { color: t.color.inkBody }]}
                testID="account-username-held-elsewhere-findability"
              >
                {ACCOUNTS_USERNAME_COPY.heldElsewhereFindabilityUnknown}
              </Text>
            )}
            {heldActions}
          </>
        ) : null}

        {formOpen ? form : null}

        {/* The legacy path's stop-gap (U1): against a server that cannot say
            whether the group holds a name, a refused claim with no row here
            gets the one honest suggestion. */}
        {stopGap && !held ? (
          <InlineNotice
            tone="quiet"
            message={ACCOUNTS_USERNAME_COPY.heldElsewhereStopGap}
            testID="account-username-held-elsewhere-hint"
          />
        ) : null}
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
