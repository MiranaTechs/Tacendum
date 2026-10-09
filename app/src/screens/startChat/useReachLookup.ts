import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { normalizeEmailIdentifier } from '@tacendum/shared';
import { accountRequestGeneration } from '../../accountLifecycle';
import * as accounts from '../../accounts';
import * as accountsUsername from '../../accountsUsername';
import * as db from '../../db';
import { messaging } from '../../messaging';
import type { SelfKeys } from '../../reachClassifier';
import { session } from '../../session';
import { USERNAME_UI_ENABLED } from '../../usernameUi';

/**
 * Open a room's inline find: DiscoveryScreen's lookup machine, ported so the
 * result can appear under the one smart field instead of on a second screen.
 * The behaviour is the discovery behaviour, kept on purpose:
 *
 *  - lookups run only when the screen calls `find` (an explicit Find or the
 *    go key), one at a time; every edit supersedes the one in flight, and a
 *    superseded answer is dropped, never rendered over newer text;
 *  - a username lookup runs the caller-owned preflight first, and a missing
 *    proof is its own door ("verify an email first"), never a miss;
 *  - every server refusal is one uniform miss; only a transport failure is
 *    told apart;
 *  - leaving retires everything, so a late "eligible" can never start a
 *    lookup for a screen that is gone.
 *
 * THE ONE GROUP-LEVEL READ (fix/username-discovery, 2026-10-08): the
 * preflight and the own-email door both read `getIdentifierState()` — the
 * facts about the caller's OWN account group — never this device's local
 * rows. The rows are written only by this device's own attach or claim, so
 * on a linked sibling (the iPad, a reinstalled phone) they are empty while
 * the account is verified: the door "To search, verify an email on your
 * account first" used to show on every email miss there, and it led to a
 * dead end (D1). A landed answer ('eligible' or 'needs_verification', from
 * the state route or the legacy eligibility read) is kept for the visit, so
 * an email miss, a username Find and the next miss cost one read; a refused
 * or failed read is asked again on the next Find. The read tells a REFUSAL
 * (the frozen 403: the caller's budget or a dark flag) from a transport
 * FAILURE, and the screen says which (U3).
 *
 * THE BUDGETS, PACED HERE (D3, 2026-10-08): the server keeps 5 lookups per
 * clock minute per device and 20 per UTC day (per device AND per account
 * group), fixed windows aligned to the clock, and refuses the rest as the
 * uniform miss — so six quick presses turned a real, consented target into
 * "No match", and fast testing read as "broken". The DEVICE keeps a ledger
 * of the lookups the server ANSWERED (a transport failure was never seen
 * there; a remembered found answer and a locally refused shape send
 * nothing) and refuses the sixth of a minute and the twenty-first of a day
 * here, with the reason. Per device and per process, not per visit (the
 * gate pass, 2026-10-08): Open a room unmounts on every found room, every
 * Link-an-email door and every Back, so a per-visit count never saw the
 * day's real usage and the day's brake could only trip inside one visit.
 * Keyed like the state read's memory — the account request generation and
 * the session mode — so a new identity and a duress session never inherit
 * another's count; the wire still holds the line.
 *
 * New here: a found result is remembered for the life of the screen under its
 * normalized target, so finding the same person again costs no lookup (the
 * day's searches are few, and with them spent the person just found would
 * read as a miss); misses are never remembered, because the other person may
 * have just turned findability on — a miss carries Search again instead
 * (D6), one more lookup for the same text. And starting the found chat is
 * local work whose failure stays on the card — it never becomes the
 * transport error.
 *
 * Every module is reached through its namespace (db.x, accounts.x, …) so the
 * suites can spy on it, and the build pins are read when a call runs, never
 * at module load.
 */

export type FindKind = 'email' | 'handle';
export type FindTarget = { kind: FindKind; label: string };

/** Why the preflight could not answer: an http refusal, or no answer at all. */
export type PreflightFailure = 'refused' | 'failed';

/** The server's lookup budgets (the release pins; ratelimit.ts
 * discoveryLookupBurst and discoveryLookup), as this device paces them. */
export const LOOKUPS_PER_MINUTE = 5;
export const LOOKUPS_PER_DAY = 20;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Which window the brake is on. The minute returns by itself; the day does
 * not — the person can do nothing about it before midnight UTC. */
export type PaceScope = 'minute' | 'day';

/** The lookups the server answered in the current clock minute and UTC
 * day, counted from the window's own number so a roll resets it. */
interface LookupLedger {
  minute: number;
  inMinute: number;
  day: number;
  inDay: number;
}

/** The device's ledgers, by whose count it is (the state read's key: a
 * new identity after a deletion and a duress session each start empty). */
const lookupLedgers = new Map<string, LookupLedger>();
const EMPTY_LEDGER: LookupLedger = { minute: -1, inMinute: 0, day: -1, inDay: 0 };

function ledgerKey(): string {
  return `${accountRequestGeneration()}:${session.mode}`;
}

function currentLedger(): LookupLedger {
  return lookupLedgers.get(ledgerKey()) ?? EMPTY_LEDGER;
}

/** Record one lookup the server answered, in the current windows. */
function recordAnsweredLookup(now: number): void {
  const current = ledgerAt(currentLedger(), now);
  lookupLedgers.set(ledgerKey(), {
    ...current,
    inMinute: current.inMinute + 1,
    inDay: current.inDay + 1,
  });
}

/** Forget every count (tests, and a dissolved identity). */
export function resetLookupPacing(): void {
  lookupLedgers.clear();
}

function ledgerAt(ledger: LookupLedger, now: number): LookupLedger {
  const minute = Math.floor(now / MINUTE_MS);
  const day = Math.floor(now / DAY_MS);
  return {
    minute,
    inMinute: minute === ledger.minute ? ledger.inMinute : 0,
    day,
    inDay: day === ledger.day ? ledger.inDay : 0,
  };
}

/** The brake, if the next lookup would be refused: which window, and when
 * it ends. The day before the minute — the longer wait is the true one. */
function brakeOn(ledger: LookupLedger, now: number): { scope: PaceScope; until: number } | null {
  const current = ledgerAt(ledger, now);
  if (current.inDay >= LOOKUPS_PER_DAY) {
    return { scope: 'day', until: (current.day + 1) * DAY_MS };
  }
  if (current.inMinute >= LOOKUPS_PER_MINUTE) {
    return { scope: 'minute', until: (current.minute + 1) * MINUTE_MS };
  }
  return null;
}

export type FindPhase =
  | { name: 'idle' }
  | { name: 'checking' }
  | { name: 'searching'; kind: FindKind }
  | {
      name: 'found';
      kind: FindKind;
      /** What the person typed (trimmed, the sigil dropped): the card label
       * and the nickname. Never the account ID. */
      label: string;
      anchor: string;
      deviceCount: number;
      /** The name already on this device's chat with them, if any. */
      namedAs: string | null;
      /** Starting the chat failed on this device; the card says so. */
      openFailed: boolean;
    }
  | {
      name: 'none';
      kind: FindKind;
      /** The text that missed, so the screen can offer one more lookup. */
      target: FindTarget;
      /** The account group holds no verified email or phone (a FACT from
       * the state read, never this device's rows): the door shows. */
      ownEmailHint: boolean;
      /** The account HOLDS a row of this class that THIS device cannot
       * match the typed text against — a linked sibling (names never
       * travel), so a search for your own name or address reads as an
       * ordinary miss unless the line says the self case too (the proof
       * pass, 2026-10-08). A FACT from the state read; false until it lands. */
      maybeSelf: boolean;
    }
  /** Defensive: the screen refuses malformed input before it ever asks. */
  | { name: 'invalid' }
  | { name: 'needsVerification' }
  | { name: 'unavailable'; target: FindTarget; reason: PreflightFailure }
  /** A transport failure: the one distinguishable answer, and retryable. */
  | { name: 'error'; target: FindTarget }
  /** Refused on the device: the window's budget is spent. No wire call. */
  | { name: 'paced'; target: FindTarget; scope: PaceScope; until: number };

export interface ReachLookup {
  selfKeys: SelfKeys;
  /** False until the verified email and the claimed name have been read:
   * until then an email or a name cannot be told apart from your own, so the
   * screen offers no Find for one and `find` refuses. */
  selfKeysLoaded: boolean;
  phase: FindPhase;
  find(target: FindTarget): void;
  retry(): void;
  retryEligibility(): void;
  /** One more lookup for the text that just missed. */
  searchAgain(): void;
  openFound(): void;
  supersede(): void;
  handleShape: (raw: string) => string | null;
}

const IDLE: FindPhase = { name: 'idle' };

/** Where a found result is remembered: the target as the server reads it. */
function cacheKey(target: FindTarget): string | null {
  if (target.kind === 'email') return `email:${normalizeEmailIdentifier(target.label)}`;
  const normalized = accountsUsername.normalizedUsernameOrNull(target.label);
  return normalized === null ? null : `handle:${normalized}`;
}

/** Whether a state answer is one worth keeping for the visit. */
function landed(state: accountsUsername.IdentifierState): boolean {
  return state.eligibility === 'eligible' || state.eligibility === 'needs_verification';
}

/** The typed label rides to this account's other devices like any nickname:
 * best-effort, and never a reason the chat did not open. */
function syncLabel(anchor: string, label: string): void {
  try {
    void messaging.syncLocalName(anchor, label).catch(() => undefined);
  } catch {
    // A label is a convenience.
  }
}

export function useReachLookup({
  userId,
  onOpenChat,
  onOpenFailed,
}: {
  userId: string;
  onOpenChat: (id: string) => void;
  /** Called in the same update that marks the card failed, so the screen's
   * announce counter moves with it (a counter moved a render later would
   * make the first failure speak twice). */
  onOpenFailed?: () => void;
}): ReachLookup {
  const [phase, setPhaseState] = useState<FindPhase>(IDLE);
  /** The phase as of the last write, for the guards a press runs before React
   * re-renders (two presses in one frame see the first one's phase). */
  const phaseRef = useRef<FindPhase>(IDLE);
  const setPhase = useCallback((next: FindPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const [selfKeys, setSelfKeys] = useState<SelfKeys>(() => ({
    userId,
    emails: [],
    handle: null,
  }));
  const [selfKeysLoaded, setSelfKeysLoaded] = useState(false);
  /** The same fact for `find`, which can run before React re-renders. */
  const selfKeysLoadedRef = useRef(false);
  /** The keys themselves for `run`, which reads them when a miss lands. */
  const selfKeysRef = useRef<SelfKeys>({ userId, emails: [], handle: null });

  /** One live lookup at a time: every edit and every new lookup claims a new
   * number, and an answer whose number is no longer current is dropped. */
  const searchSeq = useRef(0);
  /** Each preflight's generation: an answer from an older one is never acted
   * on, and leaving moves it on so a pending answer can start nothing. */
  const eligibilitySeq = useRef(0);
  /** The visit's one landed state answer, and the read in flight. */
  const stateHeld = useRef<accountsUsername.IdentifierState | null>(null);
  const statePending = useRef<Promise<accountsUsername.IdentifierState> | null>(null);
  const foundCache = useRef(new Map<string, { anchor: string; deviceCount: number }>());
  const opening = useRef(false);

  // The brake lifts itself: when the window rolls — the minute's, or the
  // UTC day's at midnight — the Find button is back without a press. The
  // timer dies with the phase or the screen; a day's wait fits a timer
  // (under 24 h, far inside the 2^31 ms a timer can hold).
  useEffect(() => {
    if (phase.name !== 'paced') return undefined;
    const timer = setTimeout(
      () => {
        if (phaseRef.current === phase) setPhase(IDLE);
      },
      Math.max(0, phase.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [phase, setPhase]);

  // Who "you" are, once per visit and never fatal: the VERIFIED email only (a
  // pending one may be a typo of somebody else's address), and the claimed
  // username only while that class is live. Until both reads are back
  // nothing is looked up: the window is short, but a press in it (likeliest
  // when the screen opens on a returned draft) spent one of the day's
  // searches on yourself and showed it as a miss. These rows are what THIS
  // device wrote; a sibling has none, and the text it types cannot be
  // matched (names never travel) — its own-email question is the state
  // read's, below.
  useEffect(() => {
    let live = true;
    void (async () => {
      let emails: string[] = [];
      let handle: string | null = null;
      try {
        const row = await db.loadAccountIdentifier().catch(() => null);
        emails =
          row?.email && row.verifiedAt != null ? [normalizeEmailIdentifier(row.email)] : [];
        const named = USERNAME_UI_ENABLED
          ? await db.loadUsernameIdentifier().catch(() => null)
          : null;
        handle = named ? accountsUsername.normalizedUsernameOrNull(named.username) : null;
      } catch {
        // Never fatal: whatever was read before a failure is what "you" are.
      }
      if (live) {
        selfKeysRef.current = { userId, emails, handle };
        setSelfKeys({ userId, emails, handle });
        selfKeysLoadedRef.current = true;
        setSelfKeysLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  useEffect(
    () => () => {
      eligibilitySeq.current += 1;
      statePending.current = null;
      // A username lookup may be awaiting the preflight: retire the lookup
      // too, so an "eligible" answer cannot start one after the screen left.
      searchSeq.current += 1;
    },
    [],
  );

  /** The group-level answer for this visit: the one kept, the one in
   * flight, or a new read. Only a landed answer is kept, so a refused or
   * failed read is asked again by the next Find (and by Try again). The
   * module never throws; a surprise reads as a failure, never a crash. */
  const readState = useCallback((): Promise<accountsUsername.IdentifierState> => {
    if (stateHeld.current) return Promise.resolve(stateHeld.current);
    if (statePending.current) return statePending.current;
    const request: Promise<accountsUsername.IdentifierState> = accountsUsername
      .getIdentifierState()
      .catch(
        (): accountsUsername.IdentifierState => ({
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
        }),
      )
      .then(state => {
        if (statePending.current === request) {
          statePending.current = null;
          if (landed(state)) stateHeld.current = state;
        }
        return state;
      });
    statePending.current = request;
    return request;
  }, []);

  const run = useCallback(
    async (target: FindTarget, mySeq: number): Promise<void> => {
      const byHandle = target.kind === 'handle';
      try {
        if (byHandle) {
          setPhase({ name: 'checking' });
          eligibilitySeq.current += 1;
          const generation = eligibilitySeq.current;
          const state = await readState();
          if (searchSeq.current !== mySeq || eligibilitySeq.current !== generation) return;
          if (state.eligibility === 'needs_verification') {
            setPhase({ name: 'needsVerification' });
            return;
          }
          if (state.eligibility !== 'eligible') {
            setPhase({ name: 'unavailable', target, reason: state.eligibility });
            return;
          }
        }
        setPhase({ name: 'searching', kind: target.kind });
        // The honest own-account hint for an email miss (the caller gate is
        // server-enforced and its refusal uniform by design; the account
        // group still knows its OWN state): read beside the lookup, never
        // before it (a found answer needs no hint) and never waited for —
        // the miss renders when the lookup answers, and the door joins it
        // if the answer lands later.
        const ownState = byHandle ? null : readState();
        const result = byHandle
          ? await accountsUsername.discoverySearchByUsername(target.label)
          : await accounts.discoverySearch(target.label);
        if (result.outcome === 'found' || result.outcome === 'no_match') {
          // The server answered, so it counted this one — superseded or not.
          recordAnsweredLookup(Date.now());
        }
        if (searchSeq.current !== mySeq) return; // superseded: drop it, silently
        if (result.outcome === 'found') {
          const namedAs =
            (await db.getChat(result.anchor).catch(() => null))?.localName ?? null;
          if (searchSeq.current !== mySeq) return;
          const key = cacheKey(target);
          if (key !== null) {
            foundCache.current.set(key, {
              anchor: result.anchor,
              deviceCount: result.deviceCount,
            });
          }
          setPhase({
            name: 'found',
            kind: target.kind,
            label: target.label,
            anchor: result.anchor,
            deviceCount: result.deviceCount,
            namedAs,
            openFailed: false,
          });
        } else if (result.outcome === 'no_match') {
          // The door is a FACT from either source — the account holds no
          // verified email or phone; unknown (refused, failed) is no door.
          const needsOwn = (state: accountsUsername.IdentifierState | null) =>
            state !== null && state.eligibility === 'needs_verification';
          // The self case on the LINE (the proof pass): the account holds a
          // row of this class and this device holds none to match the text
          // against — a linked sibling — so "it's your own" is one of the
          // causes the line names. The device that holds the row catches
          // its own name or address BEFORE sending (the That's you status),
          // so the line never says it there.
          const maybeSelf = (state: accountsUsername.IdentifierState | null): boolean => {
            if (state === null || !landed(state)) return false;
            return byHandle
              ? state.holdsUsername === true && selfKeysRef.current.handle === null
              : state.emailLinked === true && selfKeysRef.current.emails.length === 0;
          };
          const miss: FindPhase = {
            name: 'none',
            kind: target.kind,
            target,
            ownEmailHint: ownState !== null && needsOwn(stateHeld.current),
            maybeSelf: maybeSelf(stateHeld.current),
          };
          setPhase(miss);
          if (ownState === null || miss.ownEmailHint) return;
          const state = await ownState;
          if (searchSeq.current !== mySeq || phaseRef.current !== miss) return;
          if (needsOwn(state) || maybeSelf(state)) {
            setPhase({ ...miss, ownEmailHint: needsOwn(state), maybeSelf: maybeSelf(state) });
          }
        } else if (result.outcome === 'invalid') {
          setPhase({ name: 'invalid' });
        } else {
          setPhase({ name: 'error', target });
        }
      } catch {
        // The lookup modules answer instead of throwing; anything that still
        // escapes is told the way a transport failure is, so the screen is
        // never left waiting.
        if (searchSeq.current === mySeq) setPhase({ name: 'error', target });
      }
    },
    [readState, setPhase],
  );

  /** Every way to the wire goes through here: the brake first, then the
   * lookup under a new sequence number. */
  const launch = useCallback(
    (target: FindTarget) => {
      const mySeq = ++searchSeq.current;
      const brake = brakeOn(currentLedger(), Date.now());
      if (brake) {
        setPhase({ name: 'paced', target, scope: brake.scope, until: brake.until });
        return;
      }
      void run(target, mySeq);
    },
    [run, setPhase],
  );

  const find = useCallback(
    (target: FindTarget) => {
      // Your own email or name cannot be recognised yet: look nothing up.
      if (!selfKeysLoadedRef.current) return;
      const current = phaseRef.current.name;
      if (current === 'checking' || current === 'searching') return;
      Keyboard.dismiss();
      const key = cacheKey(target);
      const cached = key === null ? undefined : foundCache.current.get(key);
      if (cached) {
        // Found earlier in this visit: no lookup, no preflight, no brake.
        // Only the local name is read again, and the label is the text as
        // typed now.
        const mySeq = ++searchSeq.current;
        setPhase({ name: 'searching', kind: target.kind });
        void (async () => {
          const namedAs =
            (await db.getChat(cached.anchor).catch(() => null))?.localName ?? null;
          if (searchSeq.current !== mySeq) return;
          setPhase({
            name: 'found',
            kind: target.kind,
            label: target.label,
            anchor: cached.anchor,
            deviceCount: cached.deviceCount,
            namedAs,
            openFailed: false,
          });
        })();
        return;
      }
      launch(target);
    },
    [launch, setPhase],
  );

  const retry = useCallback(() => {
    const current = phaseRef.current;
    if (current.name !== 'error') return;
    launch(current.target);
  }, [launch]);

  /** Try again under the preflight's notice: a fresh read (nothing refused
   * or failed is ever kept, here or in the module), then the lookup. */
  const retryEligibility = useCallback(() => {
    const current = phaseRef.current;
    if (current.name !== 'unavailable') return;
    launch(current.target);
  }, [launch]);

  /** Search again under a miss: the same text, one more lookup (a miss is
   * never remembered — the other person may have just turned findability
   * on). Two presses in one frame are one lookup: the first moves the phase
   * on, and the second finds no miss to repeat. */
  const searchAgain = useCallback(() => {
    const current = phaseRef.current;
    if (current.name !== 'none') return;
    launch(current.target);
  }, [launch]);

  const supersede = useCallback(() => {
    searchSeq.current += 1;
    if (phaseRef.current.name !== 'idle') setPhase(IDLE);
  }, [setPhase]);

  const openFound = useCallback(() => {
    const current = phaseRef.current;
    if (current.name !== 'found' || opening.current) return;
    opening.current = true;
    const { anchor, label, kind } = current;
    // A server introduction either way; the username class has its own mark.
    const mark: db.IntroducedBy =
      kind === 'email' ? 'discovery' : db.DISCOVERY_USERNAME_INTRODUCED;
    void (async () => {
      try {
        const chat = await db.getChat(anchor);
        if (chat?.localName) {
          // Someone already named here: open, and fill a missing provenance
          // only (the upsert COALESCEs it) — never rename them.
          await db.upsertChat(anchor, undefined, mark);
        } else {
          await accounts.startDiscoveredChat(label, anchor, undefined, mark);
          syncLabel(anchor, label);
        }
        onOpenChat(anchor);
      } catch {
        const now = phaseRef.current;
        if (now.name === 'found' && now.anchor === anchor) {
          setPhase({ ...now, openFailed: true });
          onOpenFailed?.();
        }
      } finally {
        opening.current = false;
      }
    })();
  }, [onOpenChat, onOpenFailed, setPhase]);

  const handleShape = useCallback(
    (raw: string) => accountsUsername.normalizedUsernameOrNull(raw),
    [],
  );

  return {
    selfKeys,
    selfKeysLoaded,
    phase,
    find,
    retry,
    retryEligibility,
    searchAgain,
    openFound,
    supersede,
    handleShape,
  };
}
