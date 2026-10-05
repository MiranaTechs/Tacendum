import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { normalizeEmailIdentifier } from '@tacendum/shared';
import * as accounts from '../../accounts';
import * as accountsUsername from '../../accountsUsername';
import * as db from '../../db';
import { messaging } from '../../messaging';
import { PHONE_UI_ENABLED } from '../../phoneUi';
import type { SelfKeys } from '../../reachClassifier';
import { USERNAME_UI_ENABLED } from '../../usernameUi';

/**
 * Open a room's inline find: DiscoveryScreen's lookup machine, ported so the
 * result can appear under the one smart field instead of on a second screen.
 * The behaviour is the discovery behaviour, kept on purpose:
 *
 *  - lookups run only when the screen calls `find` (an explicit Find or the
 *    go key), one at a time; every edit supersedes the one in flight, and a
 *    superseded answer is dropped, never rendered over newer text;
 *  - a username lookup runs the eligibility preflight first, and a missing
 *    proof is its own door ("verify an email first"), never a miss;
 *  - every server refusal is one uniform miss; only a transport failure is
 *    told apart;
 *  - the own-email hint is computed for an email lookup only;
 *  - leaving retires everything, so a late "eligible" can never start a
 *    lookup for a screen that is gone.
 *
 * New here: a found result is remembered for the life of the screen under its
 * normalized target, so finding the same person again costs no lookup (the
 * day's searches are few, and with them spent the person just found would
 * read as a miss); misses are never remembered, because the other person may
 * have just turned findability on. And starting the found chat is local work
 * whose failure stays on the card — it never becomes the transport error.
 *
 * Every module is reached through its namespace (db.x, accounts.x, …) so the
 * suites can spy on it, and the build pins are read when a call runs, never
 * at module load.
 */

export type FindKind = 'email' | 'handle';
export type FindTarget = { kind: FindKind; label: string };

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
  | { name: 'none'; kind: FindKind; ownEmailHint: boolean }
  /** Defensive: the screen refuses malformed input before it ever asks. */
  | { name: 'invalid' }
  | { name: 'needsVerification' }
  | { name: 'unavailable'; target: FindTarget }
  /** A transport failure: the one distinguishable answer, and retryable. */
  | { name: 'error'; target: FindTarget };

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

  /** One live lookup at a time: every edit and every new lookup claims a new
   * number, and an answer whose number is no longer current is dropped. */
  const searchSeq = useRef(0);
  /** Each preflight's generation: an answer from an older one is never acted
   * on, and leaving moves it on so a pending answer can start nothing. */
  const eligibilitySeq = useRef(0);
  const eligibilityPending = useRef<Promise<accountsUsername.UsernameEligibilityOutcome> | null>(
    null,
  );
  const foundCache = useRef(new Map<string, { anchor: string; deviceCount: number }>());
  const opening = useRef(false);

  // Who "you" are, once per visit and never fatal: the VERIFIED email only (a
  // pending one may be a typo of somebody else's address), and the claimed
  // username only while that class is live. Until both reads are back
  // nothing is looked up: the window is short, but a press in it (likeliest
  // when the screen opens on a returned draft) spent one of the day's
  // searches on yourself and showed it as a miss.
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
      eligibilityPending.current = null;
      // A username lookup may be awaiting the preflight: retire the lookup
      // too, so an "eligible" answer cannot start one after the screen left.
      searchSeq.current += 1;
    },
    [],
  );

  const refreshEligibility = useCallback(
    (force: boolean): Promise<accountsUsername.UsernameEligibilityOutcome> => {
      if (!force && eligibilityPending.current) return eligibilityPending.current;
      eligibilitySeq.current += 1;
      const request: Promise<accountsUsername.UsernameEligibilityOutcome> = accountsUsername
        .getUsernameEligibility()
        .finally(() => {
          if (eligibilityPending.current === request) eligibilityPending.current = null;
        });
      eligibilityPending.current = request;
      return request;
    },
    [],
  );

  const run = useCallback(
    async (target: FindTarget, mySeq: number, forceEligibility: boolean): Promise<void> => {
      const byHandle = target.kind === 'handle';
      try {
        if (byHandle) {
          setPhase({ name: 'checking' });
          const preflight = refreshEligibility(forceEligibility);
          const generation = eligibilitySeq.current;
          const eligibility = await preflight;
          if (searchSeq.current !== mySeq || eligibilitySeq.current !== generation) return;
          if (eligibility === 'needs_verification') {
            setPhase({ name: 'needsVerification' });
            return;
          }
          if (eligibility !== 'eligible') {
            setPhase({ name: 'unavailable', target });
            return;
          }
        }
        setPhase({ name: 'searching', kind: target.kind });
        // The honest local hint (the caller gate is server-enforced and its
        // refusal uniform by design; this device still knows its OWN state):
        // searching needs a verified identifier here too. Email lookups only.
        const own = byHandle ? null : await db.loadAccountIdentifier().catch(() => null);
        const ownNumber =
          !byHandle && PHONE_UI_ENABLED ? await db.loadPhoneIdentifier().catch(() => null) : null;
        const result = byHandle
          ? await accountsUsername.discoverySearchByUsername(target.label)
          : await accounts.discoverySearch(target.label);
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
          setPhase({
            name: 'none',
            kind: target.kind,
            ownEmailHint: !byHandle && own?.email == null && ownNumber?.phone == null,
          });
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
    [refreshEligibility, setPhase],
  );

  const find = useCallback(
    (target: FindTarget) => {
      // Your own email or name cannot be recognised yet: look nothing up.
      if (!selfKeysLoadedRef.current) return;
      const current = phaseRef.current.name;
      if (current === 'checking' || current === 'searching') return;
      Keyboard.dismiss();
      const mySeq = ++searchSeq.current;
      const key = cacheKey(target);
      const cached = key === null ? undefined : foundCache.current.get(key);
      if (cached) {
        // Found earlier in this visit: no lookup, no preflight. Only the local
        // name is read again, and the label is the text as typed now.
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
      void run(target, mySeq, false);
    },
    [run, setPhase],
  );

  const retry = useCallback(() => {
    const current = phaseRef.current;
    if (current.name !== 'error') return;
    const mySeq = ++searchSeq.current;
    void run(current.target, mySeq, false);
  }, [run]);

  const retryEligibility = useCallback(() => {
    const current = phaseRef.current;
    if (current.name !== 'unavailable') return;
    const mySeq = ++searchSeq.current;
    void run(current.target, mySeq, true);
  }, [run]);

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
    openFound,
    supersede,
    handleShape,
  };
}
