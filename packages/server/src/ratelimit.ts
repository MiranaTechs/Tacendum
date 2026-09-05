/**
 * In-memory token-bucket rate limiter. Pure and injected
 * via Deps so handlers stay Lambda-shaped — in local development the state
 * lives in this process; the deployed stack swaps it for API Gateway usage
 * plans or a DynamoDB-backed counter without touching the handlers.
 *
 * Each bucket refills continuously at `refillPerSec` up to `capacity`. `take`
 * consumes one token and returns 0 when allowed, or the whole-seconds a caller
 * should wait before retrying when the bucket is empty.
 */

export interface RateLimitOpts {
  /** Max burst (tokens available when full). */
  capacity: number;
  /** Sustained rate (tokens added per second). */
  refillPerSec: number;
}

export interface RateLimiter {
  /**
   * Returns 0 if allowed (a token was consumed), else retry-after seconds.
   *
   * Async since: the production limiter is DynamoDB- backed
   * (ratelimit-ddb.ts) so limits mean something across Lambda containers,
   * not per-container. The in-memory limiter below stays for the local
   * adapter and unit tests, where one process IS the fleet.
   *
   * `count` (default 1) charges N tokens in ONE take (the attachment byte
   * window charges whole MiB per mint). A take that does not fit is refused
   * whole, never partially admitted. */
  take(bucket: string, opts: RateLimitOpts, count?: number): Promise<number>;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

/** `now` is injected so the limiter is deterministic under test. */
export function makeRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const buckets = new Map<string, Bucket>();
  // Evict buckets untouched for an hour so long-running processes don't grow
  // the map without bound (a full bucket is indistinguishable from a fresh one).
  const IDLE_EVICT_MS = 60 * 60 * 1000;
  let lastSweep = now();

  function sweep(t: number): void {
    if (t - lastSweep < IDLE_EVICT_MS) return;
    lastSweep = t;
    for (const [key, b] of buckets) {
      if (t - b.updatedMs > IDLE_EVICT_MS) buckets.delete(key);
    }
  }

  return {
    async take(bucket, opts, count = 1) {
      const t = now();
      sweep(t);
      const existing = buckets.get(bucket);
      const b: Bucket = existing ?? { tokens: opts.capacity, updatedMs: t };
      if (existing) {
        const elapsedSec = (t - b.updatedMs) / 1000;
        b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
        b.updatedMs = t;
      }
      if (b.tokens >= count) {
        b.tokens -= count;
        buckets.set(bucket, b);
        return 0;
      }
      buckets.set(bucket, b);
      // Whole seconds until `count` tokens are available.
      const deficit = count - b.tokens;
      return Math.max(1, Math.ceil(deficit / opts.refillPerSec));
    },
  };
}

/** Bucket sizes per route class (capacity = burst, refillPerSec = sustained). */
export const LIMITS = {
  /** Aggregate client call telemetry, keyed by authenticated account. */
  callMetrics: { capacity: 30, refillPerSec: 60 / 3600 },
  /**
   * The unauthenticated account challenge/response, keyed by source IP.
   *
   * Per-IP is the only ceiling these two can have, and that is accepted with
   * eyes open: a per-key limit would constrain no
   * attacker at all, because identity keys are free to mint. Note one sign-in
   * costs TWO requests against this bucket.
   */
  auth: { capacity: 30, refillPerSec: 30 / 60 }, // 30 burst, 30/min sustained
  // ^ Raised from 10/min when the limiter became durable: per-IP was previously enforced per-container, so the effective AWS
  // ceiling was 10 × warm containers; 30/min enforced globally is both
  // stricter in aggregate and roomy enough for a CI fleet behind one NAT
  // (one sign-in costs TWO requests).
  /**
   * `GET /v1/client-policy`, keyed by source IP.
   *
   * Per-IP is again the only ceiling available: the route is unauthenticated
   * by design (a phone asks it before it has an account, and at the landing
   * screen before it has anything at all), so there is no principal to key on.
   *
   * SIXTY A MINUTE, against an honest client that asks THREE times a day (the
   * landing tap, the unlock, and a foreground check throttled to six hours).
   * The gap is deliberate and it is not generosity: a whole office behind one
   * NAT shares this key, the answer is cacheable for five minutes anyway, and
   * the cost of a refusal is a phone that cannot learn it must update. The
   * aggregate ceiling that actually matters is the route-level API Gateway
   * throttle in the stack (10 rps / 20 burst), which this sits under.
   */
  clientPolicy: { capacity: 60, refillPerSec: 60 / 60 }, // 60 burst, 60/min sustained
  /**
   * PUT /v1/keys, keyed by the uploading account. It was the only
   * authenticated data-writing route with no
   * budget, and each call REPLACES the whole one-time prekey pool — a pool
   * Query, a batch delete, then up to ~80 BatchWrites for a 1 000-key body —
   * so it was loopable at whatever the stage throttle admitted. Sized to
   * honest replenishment with room to spare: one upload at registration,
   * one a day on the schedule, and a handful of lowPrekeyCount-triggered
   * top-ups (the client replenishment) all fit inside 5 burst / 10 per hour.
   */
  keyUpload: { capacity: 5, refillPerSec: 10 / 3600 }, // 5 burst, 10/hour
  /** Prekey-bundle fetch, keyed by (caller, target) — throttles pool draining. */
  prekeyFetch: { capacity: 5, refillPerSec: 5 / 60 }, // 5 burst, 5/min per pair
  /**
   * Prekey-bundle fetch where EITHER side is a linked-device group:
   * the (caller, target) key collapses to
   * (callerGroup, targetGroup), so three linked caller devices share ONE
   * budget against a target instead of multiplying the drain allowance ×3 —
   * and the ceiling is re-derived for N-device establishment, PINNED in
   * release pin: a full 3×3 mesh is 9 fetches inside one window, and 12/min
   * leaves retry headroom above it. The worst case (the whole mesh in one
   * burst) must SUCCEED — the tests drive it — so the capacity is the
   * mesh, not the average. Solo↔solo pairs keep `prekeyFetch` above under
   * the unchanged per-ULID key; with the `feature#accounts` flag OFF every
   * pair does (the kill switch restores per-ULID keys).
   */
  prekeyFetchGroupPair: { capacity: 12, refillPerSec: 12 / 60 }, // 12 burst, 12/min per group pair
  /**
   * The FAIR-SHARE decomposition of the pinned 12/min group-pair ceiling.
   * One undifferentiated 12-token bucket let a few
   * early retries from ONE device pair starve the rest of the mesh: 4
   * retries + 8 uniques exhausted the window before the 9th unique ran, so
   * the pinned worst case (a full 3×3 mesh succeeding in one
   * window) held only for the polite ordering. The ceiling is therefore
   * taken as RESERVE-then-SHARED: every (caller device, target device) pair
   * inside a collapsed group scope holds ONE reserved fetch per window —
   * 3×3 = 9 reservations, so the mesh completes under ANY interleaving —
   * and the retry headroom is the shared remainder. The aggregate is
   * unchanged: 9 × 1 + 3 = 12, the release pin exactly (the mesh suite
   * asserts the sum against `prekeyFetchGroupPair.capacity` itself), and
   * smaller rosters sit UNDER the ceiling, never over it.
   */
  prekeyFetchGroupPairReserve: { capacity: 1, refillPerSec: 1 / 60 }, // 1/min reserved per device pair
  prekeyFetchGroupPairShared: { capacity: 3, refillPerSec: 3 / 60 }, // 3/min shared retry headroom
  /** Outbound WS sends, keyed by sender userId. */
  wsSend: { capacity: 30, refillPerSec: 5 }, // 30 burst, 5/sec sustained
  /** Relay-only typing frames, keyed by sender userId. Capacity covers one
   * full-room burst (GROUP_MAX_MEMBERS is 12 → ≤11 legs) plus a concurrent
   * 1:1; sustained refill sits under wsSend's 5/sec so typing can never
   * crowd out real messages even from a hostile client. */
  typing: { capacity: 15, refillPerSec: 3 }, // 15 burst, 3/sec sustained
  /**
   * `ack` frames, keyed by the acking userId. Each ack costs a strongly
   * consistent session read, a strongly consistent message read and a
   * TransactWrite, and until this bucket existed nothing per-user bounded it
   * — the only ceiling was the WS stage throttle, which is AGGREGATE across
   * every client, so one socket spraying acks 429'd everyone else's frames.
   *
   * SIZED TO THE DRAIN, not to a typing-shaped guess: a recipient acks every
   * frame the server posts, and the reconnect drain posts up to
   * DRAIN_SLICE_BUDGET.maxItems (2000, handlers/ws.ts) per slice, then
   * continues. A bucket smaller than what the drain can post inside one
   * limiter window would refuse the acks of an honest backlog — and a
   * refused ack is not retried (error frames carry no msgId), so the row
   * would linger until the next reconnect re-drained it.
   *
   * TWO slices per window: the production limiter is the
   * DDB FIXED WINDOW of capacity / refillPerSec seconds (ratelimit-ddb.ts),
   * and a slice has NO minimum duration — it ends on maxItems and the drain
   * Lambda self-invokes the next at once — so at the ~10-20 ms per
   * sequential post the management API costs, a 30 s window carries ~3000
   * posts, past the one slice the bucket first admitted. Capacity is
   * therefore two full slices with the window held at 30 s (the refill is
   * two slices per 30 s); ratelimit.test.ts pins both relationships. A
   * hostile socket is bounded at twice the server's own delivery ceiling
   * instead of at nothing. An over-bound ack is refused with the standard
   * error frame but does NOT charge `wsRefused` below: a well-formed ack
   * from a live client is not a malformed frame, and the hang-up lever must
   * never reach an honest client whose drain merely outran the window. */
  wsAck: { capacity: 4000, refillPerSec: 4000 / 30 }, // two drain slices per 30 s window, ~133/sec sustained
  /**
   * REFUSED frames on one socket, keyed by userId: unparseable JSON or a
   * frame the schema rejects — NOT an ack over `wsAck`, which is refused
   * without charging this bucket (above). Every refusal still costs the
   * session recheck plus an error post, and API Gateway offers no
   * per-connection throttle — server-side DeleteConnection is the only
   * per-client lever. When this bucket is empty the socket is hung up
   * (`$default`, handlers/ws.ts) and the client redials on its own backoff.
   * Twenty per minute is far past anything a shipped client emits (both
   * clients validate frames before sending) and far below a spray. */
  wsRefused: { capacity: 20, refillPerSec: 20 / 60 }, // 20 burst, 20/min sustained
  /** Attachment upload-URL mints, keyed by sender userId — bounds blob-store
   * write abuse (each mint is a ≤10 MiB S3 PUT capability). */
  attachmentCreate: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min
  /**
   * Attachment upload BYTES per account per day, in whole-MiB tokens —
   * taken beside `attachmentCreate`, charging ceil(contentLength / 1 MiB)
   * per mint. The count bucket alone handed every free account ~144 GB/day
   * of S3 PUT capability (10/min × 10 MiB, retained 30 days) with nothing
   * recording who minted what. 2 GiB/day is ~200 full-size attachments or
   * thousands of small ones: past any person's day, far under a dump.
   * Caller-keyed, so refusal is the ordinary 429 + retry-after. */
  attachmentBytesDaily: { capacity: 2048, refillPerSec: 2048 / 86400 }, // 2 GiB/day in MiB tokens
  /** Attachment download-URL fetches, keyed by caller userId. */
  attachmentFetch: { capacity: 30, refillPerSec: 30 / 60 }, // 30 burst, 30/min
  /** Account deletion, keyed by caller userId — idempotent, so retries are
   * legitimate, but nobody needs more than a few per minute. */
  accountDelete: { capacity: 3, refillPerSec: 1 / 60 }, // 3 burst, 1/min
  /**
   * Abuse reports, keyed by reporter userId.
   *
   * Tight on purpose, and the reasoning runs opposite to most limits here.
   * The usual worry is a legitimate user hammering a control; nobody files
   * five genuine reports a minute. The worry here is the report endpoint
   * being turned into a harassment tool of its own — mass-reporting an
   * account, or using the excerpt field as a write-anything channel into an
   * abuse queue a human then has to read. Five an hour is more than any real
   * reporter needs and far less than either abuse pattern wants.
   */
  reportCreate: { capacity: 5, refillPerSec: 5 / 3600 }, // 5 burst, 5/hour
  /** Session revocation, keyed by caller userId. Deliberately roomier than
   * account deletion: signing out is a panic action, and a person hammering
   * it because they think it did not work must not be locked out of the one
   * control that stops a leaked token. */
  sessionRevoke: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min
  /**
   * Link-offer ceremony legs keyed by the OFFERER —
   * init and submit draw the same bucket, so one sign-in-grade budget covers
   * the whole two-leg call. Ceremonies are human-paced and rare (a person
   * links a device a handful of times per device lifetime); the burst covers
   * honest retries of a fumbled QR scan, and the sustained rate makes
   * offer-row minting useless as a write amplifier or as fuel for the
   * tolerated reverse-pointer residue (data.ts's link-offer row note).
   */
  linkOffer: { capacity: 5, refillPerSec: 10 / 3600 }, // 5 burst, 10/hour
  /** The acceptance leg, keyed by the ACCEPTOR — same human pacing, its own
   * bucket so a flooding offerer cannot starve the acceptor's one call. */
  linkAccept: { capacity: 5, refillPerSec: 10 / 3600 }, // 5 burst, 10/hour
  /**
   * Link ceremonies AIMED AT one account, keyed by the ACCEPTOR — taken at
   * init and again at submit, beside the offerer's own bucket above. That
   * bucket bounds one attacker; this bounds what N free identities can do to
   * ONE victim: the submit leg writes the acceptor's reverse pointer on the
   * OFFERER's signature, so without a recipient-side ceiling any account
   * that knew a solo user's ULID could grow that user's row 10×/hour per
   * Sybil. Sized as the acceptor's own accept budget (a person is offered a
   * slot about as often as it accepts one). Refused through the COLLAPSED
   * exit, never a 429: the key is not the caller's own, and a
   * distinguishable refusal would disclose B's inbound ceremony traffic to
   * whoever probes it. */
  linkOfferRecipient: { capacity: 5, refillPerSec: 10 / 3600 }, // 5 burst, 10/hour per acceptor
  /** Roster mutations (unlink/revoke), keyed by the ACTING member. The
   * sessionRevoke shape and reasoning verbatim: revoking a lost phone is a
   * panic action, and the person hammering it must not be locked out of the
   * control that kills the stolen device. */
  rosterMutation: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min
  // --- Email linking + recovery. The
  // four pinned budgets below are RELEASE values the suite asserts
  // verbatim (never a test shadow); loosening any is a deliberate decision.
  /** Identifier sends per RECIPIENT ADDRESS, keyed by the identifier HMAC —
   * the plaintext never enters a rate-limit key. release pin: ≤5/day.
   * Refusal is the COLLAPSED error, never a 429: this bucket's key is not
   * the caller's own, and a distinguishable refusal would disclose send
   * traffic against an address the caller may only be probing. */
  identifierSendRecipient: { capacity: 5, refillPerSec: 5 / 86400 }, // 5/day per address (HMAC-keyed)
  /** Resend cool-down, same HMAC key: one code per address per 60 s
   * (release-pinned). Collapsed refusal, same reasoning as above. */
  identifierResend: { capacity: 1, refillPerSec: 1 / 60 }, // 1 per 60 s per address (HMAC-keyed)
  /** Attach attempts per GROUP (per requesting account while still solo) —
   * release pin: ≤10/day. Caller-scoped, so exhaustion may answer 429. */
  identifierAttach: { capacity: 10, refillPerSec: 10 / 86400 }, // 10/day per group
  /** The fleet-wide daily send ceiling (release pin: 1,000/day, alarm at 50%
   * the CloudWatch metric-filter alarm rides the `identifier_code_sent`
   * log event; infra pins it). ONE bucket for the whole fleet. */
  identifierSendFleet: { capacity: 1000, refillPerSec: 1000 / 86400 }, // 1,000/day fleet-wide
  /** Caller-keyed route budget for the code-request/verify legs — the
   * linkOffer reasoning: attaching an email is human-paced and rare, the
   * burst covers honest typos, and the caller's OWN budget may answer 429
   * (the one named non-member of the collapse). Shared by the phone attach
   * legs — one caller, one route budget. */
  identifierRoute: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min per caller
  // --- Phone linking + recovery (the phone release
  // pins). RELEASE values the suites assert verbatim; the
  // attach budget is deliberately NOT here: phone attach draws the SAME
  // `identifierAttach` bucket email draws (ONE 10/day budget across
  // identifier classes — a second class must never double the probe
  // budget), keyed `emailattach:<scope>` in the handlers.
  /** OTP sends per recipient NUMBER, HMAC-keyed, charged uniformly hit and
   * miss (the anti-probing budget). Tighter than email's 5/day because each
   * SMS spends real money to an attacker-chosen number. Collapsed
   * refusal, never a 429 — identifier-keyed, exactly as email's. */
  phoneSendRecipient: { capacity: 3, refillPerSec: 3 / 86400 }, // 3/day per number (HMAC-keyed)
  /** Resend cool-down, same HMAC key: one code per number per 60 s
   * (unchanged from email's pin). Collapsed refusal. */
  phoneResend: { capacity: 1, refillPerSec: 1 / 60 }, // 1 per 60 s per number (HMAC-keyed)
  /** Fleet-wide SMS burst brake (new beside email because SMS spend
   * is real-time money: this caps the worst hour at pocket change). Charged
   * on VENDOR SENDS ONLY: a recovery miss never spends it —
   * with ONE bounded exception, stated where the takes run (identifiers.ts): a burst token granted just before the daily ceiling
   * refuses is spent on a non-send — ≤5/min, self-healing in ≤12 s/token,
   * daily window untouched; the reverse order would reopen a
   * zero-spend exhaustion. */
  phoneSendFleetBurst: { capacity: 5, refillPerSec: 5 / 60 }, // 5/min fleet-wide, sends only
  /** Fleet-wide daily SMS send ceiling (release pin: 200/day, alarm at 50% —
   * the CloudWatch metric-filter alarm rides the `sms_code_sent` event;
   * infra pins it). Charged on VENDOR SENDS ONLY (the named,
   * deliberate divergence from the email twin's pre-branch accounting: at
   * this 5×-smaller ceiling, miss-charging would hand twenty pristine
   * accounts a zero-vendor-spend exhaustion of the whole SMS lane). */
  phoneSendFleet: { capacity: 200, refillPerSec: 200 / 86400 }, // 200/day fleet-wide, sends only
  /** Recovery completion, keyed by the recovering device — panic-friendly
   * like rosterMutation: the person hammering "finish recovery" must not be
   * locked out of it. */
  recoveryComplete: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min per caller
  // --- Contact discovery. The four
  // pinned budgets below are RELEASE values the suites assert verbatim
  // (never a test shadow); loosening any is a deliberate decision. UNLIKE every
  // other caller-keyed budget in this file, the three lookup buckets refuse
  // in the program's ONE uniform shape, never a 429: on the lookup route the
  // refusal shape is itself the oracle surface (miss,
  // non-consented, gate, and budget must be indistinguishable), so the
  // "caller budgets keep their 429s" rule is deliberately set aside there.
  /** Per-account daily lookup budget (release pin: 20/day). In AWS this rides
   * the DDB fixed-window limiter, so the count is fleet-wide by
   * construction — two warm containers share one window. */
  discoveryLookup: { capacity: 20, refillPerSec: 20 / 86400 }, // 20/day per account
  /** Per-account lookup burst (release pin: 5/min). */
  discoveryLookupBurst: { capacity: 5, refillPerSec: 5 / 60 }, // 5 burst, 5/min per account
  /** The fleet-wide global lookup ceiling (release pin: 2,000/day): ONE
   * bucket for the whole fleet, taken AFTER the anti-Sybil caller gate so
   * free identities can never draw the shared budget down; beyond it,
   * uniform refusals + the `discovery_lookup_fleet_refused` scrape-alarm
   * event (infra pins the alarm). */
  discoveryLookupFleet: { capacity: 2000, refillPerSec: 2000 / 86400 }, // 2,000/day fleet-wide
  // --- Username claims. RELEASE
  // values the suites assert verbatim. Both refuse in the program's ONE
  // frozen shape, never a 429 (the lookup lane's rule, for the same reason:
  // on the claim verb the refusal shape sits beside the ONE distinguishable
  // `taken` answer, and "my budget ran out" must never read as a second
  // bit about the namespace).
  /** Claim attempts per CLAIMING GROUP per day — its OWN 10/day bucket
   * (`unameclaim:<group>`), deliberately NOT the shared `emailattach:`
   * window (a send-nothing verb; sharing would let "taken, pick another"
   * loops exhaust the email/phone attach budget). Charged per attempt,
   * claim and rename alike. */
  usernameClaim: { capacity: 10, refillPerSec: 10 / 86400 }, // 10/day per group
  /** The fleet-wide daily claim ceiling (2,000/day, alarm at 50% — the
   * `username_claim_admitted` counter is the alarm's metric; the over-cap
   * refusal emits `username_claim_fleet_refused`). Taken AFTER the
   * claim gate so free identities can never draw the shared budget down. */
  usernameClaimFleet: { capacity: 2000, refillPerSec: 2000 / 86400 }, // 2,000/day fleet-wide
  /** Per-TARGET aggregate one-time-prekey budget across ALL requesters
   * (release pin: 30/day, then signed-prekey-only degrade — anti-Sybil
   * drain floor: N free attacker identities exhaust a budget that does not
   * reset with N). Keyed by the SERVED user, charged in keys.ts before the
   * one-time-prekey consume, only while `feature#accounts` is ON (flag
   * row — the kill switch restores the shipped surface byte-identically). */
  prekeyTargetDaily: { capacity: 30, refillPerSec: 30 / 86400 }, // 30/day per target, all requesters
  /** TURN credential mints, keyed by userId. Cheap to serve, but each one is
   * a relay capability with a 12 h life. */
  turnCredentials: { capacity: 5, refillPerSec: 5 / 3600 }, // 5 burst, 5/hour
  /** Push-token writes, keyed by userId. A client re-PUTs on launch and on
   * token change; anything beyond that is noise. */
  pushToken: { capacity: 10, refillPerSec: 10 / 3600 }, // 10 burst, 10/hour
  /** VoIP pushes emitted on a SENDER's behalf — the ring-bomb bound.
   * Keyed by the sender so one hostile caller cannot wake a victim's phone
   * repeatedly, while everyone else's calls still ring.
   *
   * DERIVED FOR 1:1 AND NOT RE-DERIVED when small-group calls shipped —
   * stated here (v1.0 ships as-is) so it is not mistaken for
   * considered. A group start fans out one urgent `call.ginvite` per
   * co-member (≤5 legs at SMALL_GROUP_CALL_MAX_PARTICIPANTS = 6) and an
   * announced cancel one urgent `call.end` each, so one start+cancel against
   * an all-offline roster spends exactly this 10-token burst. A REDIAL inside
   * the same minute then rings only as the refill allows (1 token / 6 s):
   * some members' phones stay silent, and which ones is iteration-order
   * luck. Mitigations already in place: THIS bucket is drawn only on the
   * offline/dead-socket paths — a leg DELIVERED into a live socket takes an
   * ack-verify probe billed to `pushVerify` below, never to this budget
   * (an earlier fix briefly charged those probes here, and a few
   * healthy ANSWERED calls silenced the sender's next genuine ring) — and
   * the caller's UI honestly degrades an unrung leg to "they may be
   * offline" (shared/call.ts). Resizing is not a build-time
   * tweak: this bucket is per-sender, so its capacity IS the ceiling on
   * rings-per-minute a hostile caller can aim at one victim — raising it for
   * group redials weakens the ring-bomb bound one-for-one. Like the
   * pushMessageRecipient 10 -> 12 raise below, re-deriving it is the product
   * owner's decision to sign, not this file's to assume. */
  pushSend: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min
  /** VoIP pushes from UNKNOWN callers — senders the recipient has never
   * written to — keyed by the RECIPIENT and shared by every such caller (S3).
   *
   * This is deliberately NOT the recipient-keyed call bucket the pushSend
   * comment above rejects. That bucket would be drawn by EVERY caller, so
   * exhausting it silenced real calls — a denial-of-RING primitive. This one
   * is drawn only by callers with no reverse correspondence
   * (`hasQueuedCorrespondence`, the quota ledger the queue already keeps):
   * established callers never touch it, so no fleet can ring-starve the
   * people the recipient actually knows. What a fleet CAN do is exhaust this
   * budget and suppress OTHER strangers' first rings — the accepted residual,
   * chosen over CallKit ringing on arbitrary ciphertext from N free
   * registrations. The suppressed ring loses only earliness: the offer is
   * durably queued either way and drains on next connect.
   *
   * Sizing: legitimate never-written-back callers are rare (one QR-scan
   * introduction, a group leg from a silent co-member), and one ring each is
   * plenty — 5 burst covers a full small-group start from all-stranger
   * co-members, 5/hour keeps a fleet at statistical silence. The moment the
   * recipient sends the caller ANYTHING (a reply, a read receipt), the caller
   * leaves this bucket for good. */
  pushCallUnknown: { capacity: 5, refillPerSec: 5 / 3600 }, // 5 burst, 5/hour
  /** ACK-VERIFY probes on a sender's behalf — the DELIVERED-path shadow of
   * `pushSend`. A verify wake fires when an urgent frame was
   * handed to a socket that TOOK the bytes (ws.ts): the worker waits out the
   * ack grace and rings only if the recipient never acked (push-worker.ts).
   * Most probes are therefore silenced by the ack — and charging them to
   * `pushSend` was a real defect: `call.offer` and `call.end` are both
   * urgent, so healthy ANSWERED calls drained the ring budget two tokens at
   * a time, and the sender's next GENUINE ring to the then-offline recipient
   * was refused. Probes draw THIS bucket instead: an acked call spends no
   * ring token, while the probe path — attacker-triggerable over a live
   * socket, each probe a worker invocation that sleeps the grace plus one
   * strongly consistent DynamoDB read — stays bounded per sender.
   *
   * SIZED IDENTICALLY to `pushSend`, deliberately: a probe that SURVIVES is
   * a ring, so this capacity is the ceiling on delivered-path rings one
   * hostile caller can aim at one frozen-socket victim — resize it and you
   * resize that ring-bomb bound one-for-one (the pairing is pinned red-first
   * in ws.urgent.verify-budget.test.ts). Residual, stated: the ring buckets
   * and their probe shadows are independent budgets, so a hostile caller can
   * draw BOTH across a victim's socket-state change — worst case double the
   * old burst — but each ring still requires the matching victim state
   * (half-open socket vs none), and the alternative accounting silenced
   * genuine rings, which is the rejected remedy. */
  pushVerify: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min
  /** The DELIVERED-path shadow of `pushCallUnknown`, same split and same
   * sizing discipline as `pushVerify` above. Kept separate from the ring
   * bucket it shadows so a stranger fleet whose delivered calls are all
   * ACKED — a healthy victim answering — drains only probe budget, and a
   * genuine stranger's first ring to the later-offline victim still finds
   * `pushCallUnknown` full. Residual, unchanged in KIND from the one already
   * accepted on `pushCallUnknown`: a fleet can exhaust THIS budget too and
   * suppress OTHER strangers' verify rings while the victim's socket is
   * half-open — narrower than the accepted residual (established callers'
   * probes are per-sender and cannot be fleet-starved), and the suppressed
   * ring loses only earliness, as ever: the offer is durably queued and
   * drains on next connect. */
  pushVerifyUnknown: { capacity: 5, refillPerSec: 5 / 3600 }, // 5 burst, 5/hour
  /** MESSAGE pushes on a sender's behalf — a separate bucket from the call
   * bound above, and the separation is the point: these started sharing
   * `pushSend` when message notifications landed, so a burst of ordinary
   * texting drained the bucket and then the same sender's CALL would not
   * ring — the tight ring-bomb bound, designed for a hostile caller,
   * silencing a friendly one. Messages get a chattier budget; each push
   * still only fires when the recipient is offline. */
  pushMessage: { capacity: 30, refillPerSec: 30 / 60 }, // 30 burst, 30/min
  /** Integration outbound sends, keyed by sender userId — taken IN ADDITION
   * to wsSend for integration-class senders. A human's
   * typing budget (5/sec sustained) is a flood budget for a bot that exists
   * to say "build done": sizes the class at low
   * double digits per minute. */
  integrationSend: { capacity: 10, refillPerSec: 30 / 60 }, // 10 burst, 30/min
  /** Owner-bind attempts, keyed by caller userId. The bind is write-once, so
   * retries are cheap and nobody legitimate needs more than a few. */
  integrationBind: { capacity: 3, refillPerSec: 1 / 60 }, // 3 burst, 1/min
  /** Crew adoptions, keyed by the OWNER's userId. Adoption is a
   * deliberate human act against a cap of 8, so the budget only has to permit
   * building a crew and replacing a revoked member — not iterating. */
  crewAdopt: { capacity: 5, refillPerSec: 5 / 60 }, // 5 burst, 5/min
  /** Consent-edge writes, keyed by the consenting human. Sized like crewAdopt and for the same reason: a deliberate human
   * act against a cap of CONSENT_MAX_EDGES. This quota is ALSO the price on
   * the route's non-oracle — every uniform 204 costs a token, so probing the
   * answer that teaches nothing still costs something (the intsend
   * quota-before-read precedent, taken before even the body parse). */
  consentWrite: { capacity: 5, refillPerSec: 5 / 60 }, // 5 burst, 5/min
  /** Consent-edge deletions, keyed the same way but SEPARATE and roomier
   * (the sessionRevoke reasoning): revocation is the panic action — a human
   * who wants an agent out of their frames must never find that control
   * exhausted by their own earlier consent writes. */
  consentDelete: { capacity: 10, refillPerSec: 10 / 60 }, // 10 burst, 10/min
  /** MESSAGE pushes keyed by the RECIPIENT taken in addition
   * to the sender-keyed `pushMessage` above.
   *
   * The sender-keyed bucket was built so one hostile caller could not silence
   * everyone else reaching the same person, and for 1:1 that is the right
   * shape. A crew inverts the assumption it rests on: N senders that are all
   * legitimate, all owned by one operator, each holding an INDEPENDENT full
   * budget, all aimed at ONE phone. At the crew cap that is ~240 banners a
   * minute — a flood assembled entirely out of within-budget senders, which no
   * per-sender bound can see. Client pacing cannot substitute: a looping or
   * compromised worker ignores it, which is precisely why the ceiling has to
   * be here. This suppresses the WAKE only; the ciphertext is already durably
   * queued and still delivers. */
  /**
   * RAISED 10 -> 12 for rooms — a deliberate product decision.
   *
   * The number is not a guess and not a round-up: it is `GROUP_MAX_MEMBERS`.
   * A room holds 12, so a member can have eleven other people legitimately
   * trying to wake them, and a ceiling of 10 silently suppressed the last of
   * them. Ten was derived for crew — `CREW_MAX_MEMBERS` is 8, so eight
   * senders fit under ten with room to spare — and nobody re-derived it when
   * rooms shipped with a larger cap. Tying it to the cap rather than to a
   * literal is what stops the two drifting apart again: raise the room cap
   * and this follows.
   *
   * What it does NOT fix, stated so it is not mistaken for fixed: the
   * per-pair bucket below still bounds any ONE sender to 4 wakes a minute, so
   * a person sending five messages in a minute still loses the fifth banner.
   * That is deliberate for now — four banners a minute from one human is
   * already a lot, and banner-collapse (`apns-collapse-id` = the
   * sender, alert arm of push/apns.ts) now folds the banners that DO fire
   * into one per sender on the device. Wake emission and every number here
   * are unchanged; re-deriving these budgets under collapse remains open,
   * deliberately.
   *
   * The cost is real and was paid knowingly: the linked-device work changes
   * server behavior here, so the zero-server-change property no longer
   * holds unqualified.
   */
  pushMessageRecipient: { capacity: 12, refillPerSec: 12 / 60 }, // 12 burst, 12/min
  /** One sender's FAIR SHARE of a recipient's message-push ceiling, keyed by
   * the (sender, recipient) pair and taken alongside `pushMessageRecipient`
   *.
   *
   * The shared recipient bucket alone was a denial-of-notification primitive
   * this change set introduced: it refills at 10/min while a single sender's
   * own `pushMessage` allowance is 30/min, so ONE compromised crew member
   * could drain the shared bucket and then eat every refill token — silencing
   * every OTHER agent's wakes while their messages sat queued. The pair
   * bucket bounds each sender's draw on the shared ceiling.
   *
   * Sizing, against CREW_MAX_MEMBERS = 8 and the 10/min ceiling: the exact
   * fair share (10/8 = 1.25/min) would throttle a legitimately busy pair —
   * one agent reporting a build's stages loses banners while the rest of the
   * crew is silent, which punishes the common case to stop the rare one.
   * 4 burst / 4-per-minute instead: a hostile sender can take at most 4 of a
   * full 10-token bucket (6 left, immediately, for everyone else) and at most
   * 4 of every 10 refill tokens per minute — it can never consume the whole
   * ceiling — while a chatty-but-honest pair keeps a usable notification
   * rate. Two colluding members could take 8/10, but two compromised members
   * is a compromised operator; the bound this exists to hold is one bad node.
   * The aggregate ceiling is still `pushMessageRecipient`, taken after this.
   *
   * MEASURED BEHAVIOUR AT v1.0 (verified end to end, shipped
   * as-is) — what this cap actually does, not what it intends:
   *
   * - It suppresses WAKES only, never delivery. `handleSend` (ws.ts) durably
   * enqueues the ciphertext BEFORE any wake decision, only the recipient's
   * ack deletes a queued row, and every $connect re-drains the whole queue
   * (`drainQueuedMessages` — re-drains are idempotent, clients dedupe by
   * msgId). A suppressed wake therefore delays the recipient LEARNING of a
   * message — until their next connect (opening the app, tapping an earlier
   * banner) or a later successful wake — never its delivery. The only
   * absolute bound is the queue's own MESSAGE_TTL_SECONDS (30 days), the
   * same bound an unwoken message always had (e.g. a device with no push
   * token). There is no wake retry or reconciliation job.
   *
   * - One sender texting 10 messages in a minute at a sleeping phone: the
   * sender bucket (30/min) passes all ten; THIS bucket fires 4 banners on a
   * tight burst, up to ~7 if the ten are spread across the minute (4 burst
   * plus one refill per 15 s). The rest queue silently; the unread badge
   * under-reports until the app next opens and drains.
   *
   * - A CALL can never be lost to this bucket. Both this take and the
   * recipient take are gated on `kind === 'message'` in `wakeRecipient`
   * (ws.ts); urgent frames — `call.offer`, `call.ginvite` (a group leg's
   * offer rewritten, urgent bit preserved), announced `call.end` — ride the
   * separate `pushSend` bucket only. Pinned by "a spent PAIR banner budget
   * never silences a RING either" (ws.urgent.test.ts) and its
   * recipient-bucket sibling (crew.ws.test.ts).
   *
   * Banner-collapse ships at the ALERT arm (deliberate:
   * `apns-collapse-id` = the sender in push/apns.ts, the same value as
   * `thread-id`), so the banners one sender DOES land now collapse to one on
   * the device — presentation, never emission: every measurement above still
   * holds and every number in this file is unchanged. Re-deriving this
   * budget under collapse remains open, deliberately; v1.0 shipped the
   * behaviour above, recorded here so the next reader inherits the
   * measurement rather than the intention. */
  pushMessagePair: { capacity: 4, refillPerSec: 4 / 60 }, // 4 burst, 4/min per pair
} as const;
