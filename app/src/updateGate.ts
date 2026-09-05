/**
 * The update gate: whenever a new version is out, let people update before
 * they use the app.
 *
 * Two halves, deliberately separated. `decide` is a pure function of one
 * build number and one policy: every boundary in this feature is decided
 * there and pinned by the unit tests, so nothing about "is this phone too
 * old" depends on storage, the network, or a screen. `updateGate` is the
 * controller around it — when to ask, what to remember, and who to tell.
 *
 * THE POSTURE IS FAIL OPEN, WITH MEMORY. A check that cannot
 * complete — no network, a timeout, a duress-shaped refusal, a response
 * shape this build cannot parse — falls back to the LAST STORED policy, and
 * with nothing stored it allows. An app that bricks itself because the
 * server was briefly unreachable is a worse outcome than an old build living
 * one more day; a phone that has already been told it is too old, however,
 * stays told, so airplane mode is not a bypass.
 *
 * NEVER IN DURESS. A coerced session does not dial this route at
 * all. Not "dials it and ignores the answer": the REST guard would throw an
 * offline-shaped error anyway, but a decoy world that ever showed the update
 * wall would be announcing that it is the decoy — the whole cover story is
 * that it behaves like an ordinary phone.
 */

import { Platform } from 'react-native';
import { getSecret, setSecret } from 'tacendum-crypto';
import { ClientPolicyResponse } from '@tacendum/shared';
import { apiClientPolicy } from './api';
import { session } from './session';
import { BUILD } from './version';

export type UpdateDecision = 'ok' | 'soft' | 'blocked';

/** Which store this device installs from, as the policy names them. */
export type PolicyPlatform = 'ios' | 'android';

/**
 * Why a check is happening. Only `foreground` is throttled: the other three
 * are moments a person is already waiting on us, and asking twice in a
 * minute because someone tapped "Check again" is the behaviour they asked
 * for.
 */
export type CheckReason =
  | 'getStarted'
  | 'enterWorkspace'
  | 'foreground'
  | 'recheck';

/** The foreground check asks at most this often. */
const FOREGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * THE GATE'S OWN DEADLINE, AND WHY IT IS NOT THE REST ONE.
 *
 * `request()` gives every REST call twenty seconds, which is the right
 * budget for a call somebody is waiting on the ANSWER to. This check is not
 * that: three of its four callers sit in front of a door, and the boot one
 * sits in the middle of `enterRealWorkspace`, so inheriting twenty seconds
 * meant any network that accepts a connection and never replies (a captive
 * portal, a DNS blackhole, a cell handoff) turned every cold launch and
 * every unlock into a twenty second brand mark with no chats, no socket and
 * no messaging behind it.
 *
 * Three seconds is a whole slow round trip and then some; past it the honest
 * reading is "no answer", and no answer already has a defined meaning here
 * (the last stored policy stands, and with nothing stored it allows). So the
 * ceiling costs a phone on a bad link nothing but a check it was not going
 * to get, and it bounds the one failure mode that had no other exit.
 */
export const GATE_REQUEST_TIMEOUT_MS = 3_000;

/** A check that ran out of time. Private: every caller treats it as the
 * same non-answer every other failure is. */
class GateTimeoutError extends Error {
  constructor() {
    super(`update check timed out after ${GATE_REQUEST_TIMEOUT_MS} ms`);
    this.name = 'GateTimeoutError';
  }
}

/**
 * Race `work` against the gate's own ceiling. The loser is left running
 * rather than aborted: `apiClientPolicy` has its own deadline underneath and
 * its late answer is still worth storing, and `Promise.race` has already
 * attached a reaction to it, so a late rejection is handled and not an
 * unhandled one.
 */
function withGateDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GateTimeoutError()), GATE_REQUEST_TIMEOUT_MS);
    // A deadline must never be what keeps a process alive; the same reason
    // `withDeadline` in api.ts unrefs its timer, and the same no-op on the
    // device, where RN timers are plain numbers.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * WHERE THE LAST POLICY LIVES, AND HOW THAT DIVERGES FROM THE DESIGN.
 *
 * The design puts these two values in the workspace-scoped `profile` kv table.
 * They are in the Keychain instead, through the same `setSecret` seam the
 * App Lock nudge and the read-receipt preference use, and the divergence is
 * recorded here rather than left for a reader to discover: device scope is
 * defensible on its own terms (the answer is about this INSTALL's build
 * number, not about any account, and it must survive a sign-out because
 * signing out does not make an old binary new), but it is NOT what the plan
 * says, and it costs three things the plan's version would not.
 *
 * These bytes survive sign-out and account deletion; `clearLocalState` and
 * `deleteAccount` do not reach them. The real and decoy worlds share one
 * copy of the file, so a dismissal made in one is read back by the other.
 * And nothing about the storage is what keeps a real session's ANSWER out of
 * a decoy: that is the session guard on the getters below, plus
 * `forgetSession()` at relock. A duress session still neither reads nor
 * writes these keys, because `checkNow` returns before either.
 */
const POLICY_KEY = 'updateGate.policy';
/** The `latestBuild` whose soft card has been dismissed, as a decimal string. */
const SOFT_DISMISSED_KEY = 'updateGate.softDismissed';

/**
 * The decision, whole. Pure and total: `undefined` is no gate, a policy for
 * the other store is not this device's business, and the floor is INCLUSIVE
 * — `minBuild` names the oldest build that still works, not the first that
 * does not.
 *
 * `platform` is a parameter rather than a read of `Platform.OS` inside the
 * comparison so the other store's answer can be asserted from either device;
 * it defaults to this one.
 */
export function decide(input: {
  build: number;
  policy: ClientPolicyResponse | undefined;
  platform?: PolicyPlatform;
}): UpdateDecision {
  const { build, policy } = input;
  if (!policy) return 'ok';
  const platform = input.platform ?? devicePlatform();
  const rule = policy[platform];
  if (!rule) return 'ok';
  if (build < rule.minBuild) return 'blocked';
  if (rule.latestBuild !== undefined && rule.latestBuild > build) return 'soft';
  return 'ok';
}

/**
 * The store link for THIS device, when the policy carried one. The screens
 * ask this rather than indexing the policy themselves, so exactly one place
 * in the app decides which half of the policy is ours.
 */
export function storeUrl(
  policy: ClientPolicyResponse | undefined,
): string | undefined {
  return policy?.[devicePlatform()]?.url;
}

/** This device's store, in the policy's own words. */
function devicePlatform(): PolicyPlatform {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

/** This binary's build number. `BUILD` is the string both stores count in. */
function thisBuild(): number {
  return Number(BUILD);
}

async function readStoredPolicy(): Promise<ClientPolicyResponse | undefined> {
  let raw: string | null;
  try {
    raw = await getSecret(POLICY_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    // Parsed through the SAME schema the wire is parsed through: a blob
    // written by a build that spoke a different shape is not evidence, and
    // the one thing a stored policy may never do is invent a floor.
    const parsed = ClientPolicyResponse.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function storePolicy(policy: ClientPolicyResponse): Promise<void> {
  try {
    await setSecret(POLICY_KEY, JSON.stringify(policy));
  } catch {
    // Best effort by contract: an unwritable Keychain costs the offline
    // memory of one check, never the check itself.
  }
}

/** Whether the soft card for this store build has already been waved away. */
export async function isSoftUpdateDismissed(
  latestBuild: number,
): Promise<boolean> {
  try {
    return (await getSecret(SOFT_DISMISSED_KEY)) === String(latestBuild);
  } catch {
    return false;
  }
}

/**
 * Dismiss the soft card for one store build. Keyed to the VALUE, not to a
 * flag, so the next release asks exactly once more.
 */
export async function dismissSoftUpdate(latestBuild: number): Promise<void> {
  try {
    await setSecret(SOFT_DISMISSED_KEY, String(latestBuild));
  } catch {
    // The card comes back next launch. That is the failure this app wants.
  }
}

class UpdateGate {
  private decision: UpdateDecision = 'ok';
  private current: ClientPolicyResponse | undefined;
  private lastAskedAt = 0;
  private inFlight: Promise<UpdateDecision> | null = null;
  private readonly listeners = new Set<() => void>();

  /**
   * NONE OF THE THREE READERS BELOW ANSWERS A NON-REAL SESSION.
   *
   * `checkNow` refuses to dial in duress, which was mistaken for the whole of
   * rule 15 here. It is not: this is a process singleton, so a real session
   * that settled on 'soft' and was then relocked left its answer standing in
   * memory, and the decoy chat list read it straight out of the module and
   * raised the real session's "Update available" card. One guard on the
   * getters closes every reader at once, including any future one, and it is
   * a second lock rather than the only one: `forgetSession()` clears the
   * answer at relock as well.
   */
  private answersThisSession(): boolean {
    return session.mode === 'real';
  }

  /** The decision as of the last completed check. `'ok'` before any. */
  get lastDecision(): UpdateDecision {
    return this.answersThisSession() ? this.decision : 'ok';
  }

  /** The policy the decision was made from, for the screens to read. */
  get policy(): ClientPolicyResponse | undefined {
    return this.answersThisSession() ? this.current : undefined;
  }

  /** The store's newest build when there is a soft nudge owed, else undefined. */
  get softLatestBuild(): number | undefined {
    if (!this.answersThisSession()) return undefined;
    if (this.decision !== 'soft') return undefined;
    return this.current?.[devicePlatform()]?.latestBuild;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Ask the server, and decide. Single-flight: three check points can fire
   * within a second of each other on a cold launch, and one answer serves
   * them all.
   */
  checkNow(reason: CheckReason): Promise<UpdateDecision> {
    // Rule 15 at this seam, before anything can await: no fetch, no stored
    // read, no state change. A coerced phone is an ordinary phone.
    if (session.mode === 'duress') return Promise.resolve('ok');
    if (
      reason === 'foreground' &&
      this.lastAskedAt !== 0 &&
      Date.now() - this.lastAskedAt < FOREGROUND_INTERVAL_MS
    ) {
      return Promise.resolve(this.decision);
    }
    if (this.inFlight) return this.inFlight;
    // Stamped on the ATTEMPT, not on success: a phone with no signal must
    // not re-dial on every foreground for the whole flight.
    this.lastAskedAt = Date.now();
    const run = this.ask(reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /**
   * The reason travels all the way to the URL, and it is not decoration: the
   * route is cacheable for five minutes, and the two check points a person is
   * standing in front of must not be answered out of that cache with the
   * verdict that put them there (`apiClientPolicy`). Single-flight is
   * unchanged and deliberately coarser than this — a check already on the
   * wire is a fresher answer than a second one would be, whatever asked for
   * it.
   */
  private async ask(reason: CheckReason): Promise<UpdateDecision> {
    let policy: ClientPolicyResponse | undefined;
    try {
      policy = await withGateDeadline(apiClientPolicy(reason));
      await storePolicy(policy);
    } catch {
      // EVERY failure is the same failure here, on purpose: offline, a
      // timeout, a 429, a duress-shaped TypeError, a ServerAheadError from
      // the DTO parse, the gate's own three second ceiling. None of them is
      // an answer, so none may manufacture one: the last stored answer
      // stands instead.
      policy = await readStoredPolicy();
    }
    this.current = policy;
    this.settle(decide({ build: thisBuild(), policy }));
    return this.decision;
  }

  private settle(next: UpdateDecision): void {
    if (next === this.decision) return;
    this.decision = next;
    for (const cb of this.listeners) cb();
  }

  /**
   * Forget the answer, keeping the throttle. Called from `relock()`, beside
   * the other per-session state that is re-read on the next real unlock: the
   * decision and the policy belong to the session that asked for them, and
   * whatever unlocks next (a decoy above all) must inherit neither.
   *
   * `lastAskedAt` deliberately survives. It is not an answer, it is this
   * device's rate limit on an anonymous fleet-wide route, and clearing it
   * would make a lock-and-unlock loop a way to dial that route at will.
   * `inFlight` survives too: a request already on the wire is one the next
   * session may as well share, and its result lands through `ask`, which
   * writes state the getters then refuse to a non-real session anyway.
   */
  forgetSession(): void {
    this.settle('ok');
    this.current = undefined;
  }

  /** Process-lifetime state, reset between tests the way `call` is. */
  resetForTests(): void {
    this.decision = 'ok';
    this.current = undefined;
    this.lastAskedAt = 0;
    this.inFlight = null;
    this.listeners.clear();
  }
}

export const updateGate = new UpdateGate();
