import { createHash, randomUUID } from 'node:crypto';
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

/** One member of a TransactWriteItems call — the SDK exports the array type,
 * not the element, and the queue quota code builds these piecewise. */
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
import {
  ACCOUNT_GROUP_MAX_MEMBERS,
  CONSENT_MAX_EDGES,
  CREW_MAX_MEMBERS,
  EMAIL_CODE_ATTEMPT_CAP,
  EMAIL_SUPPRESSION_TTL_SECONDS,
  MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
  PHONE_SUPPRESSION_TTL_SECONDS,
  SESSIONS_USER_INDEX,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TOMBSTONE_TTL_SECONDS,
  type DeviceClass,
  type KyberPrekey,
  type OneTimePrekey,
  type SignedPrekey,
  type WsTicketRole,
} from '@tacendum/shared';

/** Re-exported so the data layer's own consumers (handlers, tests) name the
 * class taxonomy through one import beside the group types it keys. */
export type { DeviceClass } from '@tacendum/shared';
import { activityRecord, activityTombstone } from '../activity.js';
import { TABLES } from './tables.js';

/**
 * DynamoDB access layer. Stores only public keys and ciphertext;
 * no plaintext ever. Pending auth challenges and session tokens both live in
 * the `sessions` table, distinguished by a `kind` attribute (note).
 *
 * Session tokens are stored as SHA-256 digests: a server-DB compromise
 * yields no usable bearer tokens. Auth challenges are stored in the clear and
 * need no such treatment — a challenge is a nonce, not a credential, and
 * reading one gains an attacker nothing without the identity private key.
 *
 * PHONE NUMBERS.
 * An earlier revision of this header declared that nothing in
 * this file knew about phone numbers; phone linking joined the accounts
 * program and made that sentence false. What survives is the REAL invariant that sentence was
 * carrying: there is no phone column, no plaintext identifier anywhere, and
 * above all no index on the users table — see the note in shared/src/tables.ts
 * for why an identifier index must never come back. A `phonehash#v<K>#` claim
 * row keeps that invariant true: it is a caller-supplied-key GetItem under
 * the server-keyed HMAC, not an index — the legacy `phone#` rows
 * were the server holding the identifier space; a claim row is the server
 * holding a keyed pseudonym its own key must unlock.
 */

export interface UserRecord {
  userId: string;
  createdAt: number;
  // Populated at key distribution:
  registrationId?: number;
  identityKeyPub?: string;
  signedPrekey?: SignedPrekey;
  /** Signed last-resort Kyber prekey (PQXDH; required by current libsignal). */
  kyberPrekey?: KyberPrekey;
  /**
   * Account class, set at birth and never.
   * Absent = human. An integration account is send-restricted server-side:
   * it may only message its bound owner, never `urgent`, never a push token.
   */
  accountClass?: 'integration';
  /**
   * The one account this integration may message, set by the write-once bind
   * Only ever present on integration-class rows.
   */
  ownerUserId?: string;
  /**
   * The crew this account belongs to. On a human row it is the
   * crew the human owns; on an integration row it is the crew the human
   * ADOPTED it into. Explicit rather than derived from `ownerUserId` equality,
   * because equality would retroactively widen every already-deployed
   * integration on the day this ships — two crewless rows comparing
   * `undefined === undefined` is `true`. Written only by the owner-called
   * adopt transaction; absent means today's single-recipient behaviour,
   * byte-identical.
   */
  crewId?: string;
  /**
   * How many integrations this (human) owner has adopted, maintained inside
   * the adopt transaction so the CREW_MAX_MEMBERS cap is a condition a
   * concurrent adopt cannot slip past — a handler read-then-check could
   * Only ever present on human rows.
   */
  crewCount?: number;
  /**
   * The account group this device belongs to: set/cleared
   * ONLY inside the link/unlink/revoke transactions, never by a handler
   * write. Absent = solo/anonymous — the shipped default, and an account
   * that never opts in never gains this attribute.
   */
  groupId?: string;
  /**
   * Set by revoke-lost/stolen: the row is dead — auth
   * refuses the tombstoned identity key, sends refuse at enqueue (the
   * read sites landed separately). The ROW tombstone and the idkey-claim tombstone
   * are written in the same transaction; the record is the enforcement,
   * teardown is cleanup.
   */
  tombstoned?: boolean;
  /**
   * Non-authoritative forwarding hint on a revoked device's dead row
   * a peer holding ONLY the dead ULID resolves the
   * surviving roster through it and re-targets, verifying certificates
   * client-side. Same disclosure class as recorded there.
   */
  formerGroupId?: string;
  /**
   * Reverse pointer from a RECOVERING device to its pending `recovery#` row
   * written at recovery-verify under the device's
   * own pristineness condition, cleared by completion, walked by the
   * deletion sweep (the linkOfferNonces reverse-pointer discipline — the
   * GetItem-only sweep must be able to find the row). Never authoritative:
   * completion re-reads the recovery row and conditions on its contents.
   */
  recoveryGroupId?: string;
  /**
   * Reverse pointers to pending link-offer/init rows this account is a party
   * to (written by putLinkOffer /
   * putLinkOfferInit, consumed nonces removed by the link transaction).
   * Surfaced on the record so the deletion sweep can walk them —
   * a GetItem per nonce, never a Query. A DEAD nonce (its rows expired or
   * already swept from the other party's side) is tolerated residue: the
   * walk deletes nothing for it, and the set dies with this row.
   */
  linkOfferNonces?: Set<string>;
}

/** The identity + signed-prekey material stored on the user row. */
export interface CoreKeys {
  registrationId: number;
  identityKeyPub: string;
  signedPrekey: SignedPrekey;
  kyberPrekey: KyberPrekey;
}

/**
 * A pending account challenge. Not a credential —
 * it is a nonce, and reading one gains an attacker nothing without the
 * identity private key. It carries no attempt counter for that reason: there
 * is nothing to guess, only a signature to produce.
 */
export interface AuthChallengeRecord {
  identityKeyPub: string;
  challenge: string;
  expiresAt: number; // unix seconds
}

/**
 * Result of resolving an identity key to an account.
 *
 * `conflict` is not a hypothetical: a partially-failed deletion leaves a claim
 * row pointing at a user row that is gone. Modelled explicitly so the handler
 * has to decide what to do about it, instead of a stray `undefined` being read
 * as "new account" and quietly minting a second one for the same key.
 */
export type AccountResolution =
  | {
      kind: 'ok';
      user: UserRecord;
      /** True when this call MINTED the account (the mint-alarm counter and
       * the only moment `accountClass` is honored). */
      created: boolean;
    }
  | { kind: 'conflict' }
  /** The claim row is tombstoned: this identity key has been revoked by the
   * integration's owner and never authenticates again. */
  | { kind: 'tombstoned' };

// --- Optional account grouping (phase) ---

/** One member entry on a `group#` row (schema). */
export interface AccountGroupMember {
  userId: string;
  /** Exactly one member per class per group `desktop` is
   * schema-reserved, refused at the link transaction. */
  class: DeviceClass;
  linkedAt: number; // unix ms
  /** The two ceremony signatures — the link certificates — PLUS the
   * signed-tuple context that makes them verifiable: the link transaction consumes the offer row that held the
   * tuple, so the certificate must carry every pinned preimage field
   * except `subjectIdentityPubKey`, which the verifier supplies from its own
   * pins (deliberately not stored — server copy verified against server
   * copy is no verification). Availability copy, never authority: peers
   * verify CLIENT-side against keys they already pinned.
   * Signatures stay opaque here; the data layer never verifies one (that is
   * the auth Lambda's libsignal call). The wire shape is
   * `GroupMemberCerts` in shared dto.ts — one field set, two spellings
   * would drift.
   *
   * OPTIONAL honestly: two member classes exist that no
   * ceremony ever ran for — the founding member of a solo group lazily
   * created by an identifier attach and a recovery-attached device
   * (recovery restores grouping only; peers owe it full TOFU).
   * Fabricating cert bytes for either would be forging signatures; absence
   * is the truth, and standing client rule (no verifiable
   * cross-signature ⇒ block-and-warn) is exactly the posture such a member
   * deserves. Every ceremony-linked member still carries them. */
  certs?: {
    offerSig: string;
    acceptSig: string;
    groupId: string;
    offererUserId: string;
    acceptorUserId: string;
    /** The tuple's class = the JOINING device's slot — on a first link both
     * member entries carry the same ceremony, so this is NOT always the
     * entry's own `class`. */
    class: DeviceClass;
    rosterEpoch: number;
    offerNonce: string;
    expiresAt: number;
  };
}

/**
 * The `group#<groupId>` row: ≤3 members ⇒ one row, one
 * GetItem, no index — device→group and identifier→group resolution are
 * GetItems on caller-supplied keys, the idkey# pattern.
 */
export interface AccountGroupRecord {
  groupId: string;
  members: AccountGroupMember[];
  /** Reverse list of identifier claim keys, walked by the deletion sweep as
   * GetItems — never a Query. Born empty; the attach writes it. */
  identifierRefs: string[];
  /** The roster version every link-op preimage binds. Every roster mutation
   * conditions on it and bumps it: of two mutations signed at epoch
   * N, exactly one commits. */
  epoch: number;
  createdAt: number; // unix ms
  /** Unix seconds. The GROUP-LEVEL carrier of the recovery discovery
   * cool-down:
   * stamped by `completeRecovery` beside the per-claim stamps, and copied by
   * `attachIdentifier` onto any claim RE-MINTED for this group while it
   * is still in the future — so unlink-then-re-attach re-arms the cool-down
   * instead of shedding it. The claim row stays the read-time authority
   * (`identifierClaimDiscoverable`); this attribute only survives the claim
   * row's deletion. Absent = no cool-down ever armed. */
  discoverableAfter?: number;
  /**
   * True on a group LAZILY CREATED by an identifier attach — the
   * never-ceremonially-grouped founder class. Load-bearing for the downgrade reap: such a group's client can never learn the
   * server-minted groupId (the attach wire answers uniformly), so no client
   * verb can ever reach the roster walk — the identifier unlink IS
   * this class's downgrade, and the unlink transaction reaps the group row
   * + the founder's groupId when it empties the refs of a STILL-UNMUTATED
   * (epoch 1, sole founding member) attach-created group. A ceremony-linked
   * group never carries this marker's reap: its members know their groupId
   * and dissolve deliberately.
   */
  attachCreated?: boolean;
  /** Unix seconds of the group's last SUCCESSFUL username NAME CHANGE
   * (the anti-hoarding rule): stamped by the
   * five-item rename AND by the username unlink (an unlink followed by a
   * claim of another name IS a rename spelled in two verbs), and
   * condition-checked for the 30-day cool-down by the rename transaction
   * AND by the claim transaction — except a claim that reclaims this
   * group's OWN live tombstone at the exact-name row, which the
   * former-owner right keeps free. Consumed on success only (a refused
   * rename, unlink, or claim never stamps it). Absent = never changed.
   * Rides the group row, not the claim row, so neither unlink-then-claim
   * nor unlink-then-reclaim can launder a standing cool-down into a fresh
   * one — and without the unlink stamp one group could mint a fresh
   * former-owner tombstone per attempt, hoarding hundreds of names a month
   * against strangers at the price of the 10/min route budget. */
  usernameRenamedAt?: number;
}

/**
 * A pending link offer (the challenge-row shape):
 * TTL'd, single-use, consumed by conditional delete INSIDE the link
 * transaction. Lives in the sessions table beside the auth-challenge rows —
 * deliberately with NO `userId` attribute, exactly like them: the sessions
 * user-index is partitioned on `userId`, and carrying one would put every
 * live offer into that index for `deleteSessionsForUser` to batch-delete on
 * any sign-in.
 *
 * Findable for deletion WITHOUT that index:
 * `putLinkOffer` writes the nonce into a `linkOfferNonces` string set on
 * BOTH named users' rows in the same transaction — the identifierRefs
 * reverse-list pattern, — so the account-deletion sweep walks a
 * GetItem per nonce and deletes every pending offer naming the deleted
 * member ("it expires eventually" is not deletion). The consuming link
 * transaction removes the nonce from both sets; an offer that merely
 * EXPIRES leaves its pointers behind as tolerated residue — the sweep
 * GetItems a dead nonce and deletes nothing, the set's growth is priced by
 * the offer rate buckets, and the row that carries it is itself deleted
 * by the sweep.
 */
export interface LinkOfferRecord {
  /** Server-minted single-use nonce; the row key binds it. */
  offerNonce: string;
  groupId: string;
  offererUserId: string;
  acceptorUserId: string;
  /** The joining device's declared slot (release pin: class = the joining
   * device's slot). */
  acceptorClass: DeviceClass;
  /** The offerer's self-declared class — present exactly when rosterEpoch
   * is 0 (a FIRST link): the group row is born with both
   * members, so the birth needs both classes. `putLinkOffer` enforces the
   * exactly-when. */
  offererClass?: DeviceClass;
  /** The epoch the offer's signature binds: 0 for a first link (the group
   * row does not exist yet; the minted groupId is a name, not state). */
  rosterEpoch: number;
  /** Unix seconds. The EXPLICIT expiry checked at consume — DynamoDB TTL is
   * asynchronous reaping, never the enforcement. */
  expiresAt: number;
  /** ULID_A's op="offer" identity signature, verified by the auth Lambda
   * BEFORE this row is written stored to become the joiner's cert
   * material. Opaque to the data layer. */
  offerSig: string;
}

/**
 * The INIT-leg row of a link ceremony: the
 * tuple the server minted for ULID_A to sign — recorded BEFORE any signature
 * exists, so the submit leg can verify A's signature against what the SERVER
 * chose rather than what the client claims (the first-link
 * circularity fix). Same challenge-row discipline as the
 * offer row it precedes: TTL'd, single-use, consumed by conditional delete
 * inside the promote transaction, explicit `expiresAt` the enforcement.
 * Exactly `LinkOfferRecord` minus the signature it exists to obtain.
 *
 * Reverse pointer, OFFERER ONLY: the init leg is unsigned, so its
 * write carries the nonce into the OFFERER's `linkOfferNonces` set alone — the
 * acceptor's pointer waits for `promoteLinkOfferInit`, where A's signature has
 * verified (the "reverse pointer only after a signature" rule). An
 * unsigned bearer therefore cannot append residue to a stranger's row.
 */
export type LinkOfferInitRecord = Omit<LinkOfferRecord, 'offerSig'>;

/**
 * Every refusal is DISTINCT (the pinned claim: "second phone REFUSED with a
 * distinct error") so the handler can collapse them deliberately at the
 * oracle boundary rather than this layer collapsing them accidentally.
 */
export type LinkDeviceResult =
  | 'linked'
  /** class = desktop: the slot is schema-reserved in v1; occupancy refuses
   * until a later release lifts it. */
  | 'desktop_reserved'
  /** The offer row is gone — already consumed by the link that won, or never
   * issued. Single-use is a transaction condition, not a read. */
  | 'offer_consumed'
  /** The offer row exists but its explicit expiresAt has passed (TTL reaping
   * is cleanup, never the enforcement). */
  | 'offer_expired'
  /** The group row moved (or dissolved) after the offer was signed — an
   * acceptance never lands over a roster that moved. */
  | 'stale_epoch'
  /** The declared class slot is occupied (the crew-adopt conditional-
   * transaction precedent). */
  | 'class_occupied'
  /** size(members) would exceed ACCOUNT_GROUP_MAX_MEMBERS — belt-and-braces
   * beside the class condition, enforced independently. */
  | 'group_full'
  /** The acceptor already carries a groupId — the raceable pristineness
   * classes land HERE as transaction refusals. */
  | 'already_grouped'
  /** A named user row is missing (deleted mid-ceremony). */
  | 'unknown_member'
  /** A ceremony party is integration-class: agents never occupy
   * device slots — refused by the transaction's own
   * `attribute_not_exists(accountClass)` conditions (the human-class
   * transaction precedent), never only by a handler precheck. */
  | 'integration_class'
  /** The merged-cap condition (belt-and-braces for any future
   * pristineness relaxation): the link would put the merged group's crew
   * adoptions over CREW_MAX_MEMBERS or its consent edges over
   * CONSENT_MAX_EDGES. Enforced by count pins riding the transaction —
   * every party's `crewCount` and consent `#count` is conditioned at its
   * read value, so a concurrent adopt/consent write cancels the link
   * instead of slipping past the sum. */
  | 'cap_exceeded'
  /** A count pin lost twice to concurrent adopt/consent traffic — transient;
   * the offer row is untouched, so the caller may simply retry the accept. */
  | 'cap_contended';

export interface RosterMutationInput {
  groupId: string;
  /** The member whose identity signature authorizes the mutation.
   * Signature verification is the auth Lambda's the data layer
   * enforces that the actor IS a current member under the epoch condition. */
  actingUserId: string;
  targetUserId: string;
  /** The epoch the mutation's signature binds; the transaction conditions on
   * it and bumps it. */
  rosterEpoch: number;
  /** The caller's clock: a LAST member's exit tombstones the group's
   * username claim rows (no orphaned live claim, no instant re-claim
   * of a dissolved group's name), and the tombstone's `freesAt` is stamped
   * from THIS clock. Handlers pass `deps.now`; absent, the store's own
   * wall clock (`DataLayerHooks.nowMs`, production `Date.now`) stamps it —
   * a fallback for the landed call sites, whose groups hold no username, so
   * every clocked path in the suites passes the advancing clock explicitly. */
  nowMs?: number;
}

/**
 * A victim's bound integration account, named by the revoke caller. Both fields are tombstoned when the device is revoked — the USER
 * row (`userId`) so the read-time enforcement (auth.ts `isUserTombstoned`,
 * the ws send/enqueue tombstone checks) refuses the agent's already-issued
 * bearer the instant the transaction commits, and the idkey CLAIM row
 * (`identityKeyPub`) so the key can never re-auth. Tombstoning only the claim
 * row leaves the agent's live bearer working through the crash window until
 * teardown — the exact enforcement-vs-cleanup inversion this transaction exists
 * to close, now applied to the victim's AGENTS as well as the victim itself.
 * Ownership (integration class, `ownerUserId` === the revoked device) is
 * verified by the handler before either tombstone is written.
 */
export interface AgentBinding {
  userId: string;
  identityKeyPub: string;
}

export type UnlinkDeviceResult =
  | 'unlinked'
  | 'unknown_group'
  | 'stale_epoch'
  | 'not_member'
  | 'not_acting_member';

/**
 * The member-DELETION roster removal: the amicable-unlink
 * transaction FUSED with the guarded user-row delete, so a refused deletion
 * destroys nothing (the account.ts row-goes-first discipline holds — the
 * roster mutation and the row delete commit atomically or not at all).
 */
export type DeleteGroupedUserResult =
  | 'deleted'
  /** The crew guard refused ON the row delete (an adopt raced the read-time
   * check) — nothing committed, roster untouched ('s
   * backstop, riding inside the roster transaction). */
  | 'crew_not_empty'
  /** The roster (or the caller's membership/groupId) moved between snapshot
   * and commit past the bounded retry — re-read and re-drive. */
  | 'stale'
  | 'unknown_group';

// --- Optional email linking + recovery (phase) ---

/**
 * The `emailhash#v<K>#<hmac>` claim row (schema): identifier→group, the
 * idkey# pattern — resolved by strongly consistent GetItem on a
 * caller-supplied (handler-derived) key, never a Query. The row's KEY is the
 * versioned HMAC output; the identifier plaintext exists in NO attribute of
 * this row and in no other row, ever.
 */
export interface IdentifierClaimRecord {
  /** The full versioned claim key (`emailhash#v<K>#<hash>`). */
  claimKey: string;
  groupId: string;
  createdAt: number; // unix ms
  verifiedAt: number; // unix ms
  /** Owner-written discovery consent (wires the route; default OFF). */
  discoverable: boolean;
  /** Unix seconds. Set by recovery completion: the lookup path resolves
   * only when `discoverable AND now ≥ discoverableAfter` — a read-time rule,
   * no scheduler. Absent = no cool-down pending. */
  discoverableAfter?: number;
  /** Username class only: the `nameskel#` row
   * this claim's anti-squat twin lives — carried on the claim row so
   * every lifecycle site (rename, unlink, revoke, the deletion sweep) finds
   * the skeleton row by GetItem off the group's ref, never by a Query and
   * never by re-deriving a skeleton the server does not hold. Absent on the
   * email and phone classes, which have no skeleton row. */
  skeletonKey?: string;
}

/**
 * A username TOMBSTONE: what a rename, unlink,
 * deletion, or operator revocation leaves AT the claim key (and at the
 * skeleton key) — a Put-OVERWRITE of the row, never a delete, so the name
 * stays held against strangers for `USERNAME_TOMBSTONE_TTL_SECONDS` and the
 * former owner keeps a reclaim right for the same window. The row has NO
 * `groupId` (every owner-pinned write — consent toggle, recovery liveness,
 * migration, unlink — refuses it by construction) and NO plaintext, exactly
 * like the live row. `formerGroupId` ABSENT is the nobody-reclaims shape:
 * operator revocation and the dissolve paths (the group is gone, so
 * no reclaim right could ever be exercised) both write it absent.
 */
export interface UsernameTombstoneRecord {
  claimKey: string;
  tombstoned: true;
  /** Unix seconds: from here on ANYONE may claim the name (the tombstone
   * reads as absent to the claim condition, and the lookup-facing read reaps
   * it physically). */
  freesAt: number;
  /** The group that held the name — the ONLY group whose claim passes the
   * tombstone-aware condition before `freesAt`. Absent: nobody does. */
  formerGroupId?: string;
  /** The skeleton row tombstoned beside this one (reaped together). */
  skeletonKey?: string;
}

/** The claim shape the read-time rule inspects — consent and the
 * recovery cool-down; a live claim carries both, a tombstone neither. */
type DiscoverableClaim = Pick<IdentifierClaimRecord, 'discoverable' | 'discoverableAfter'>;

/**
 * The read-time discoverability rule, in ONE place so the lookup and
 * the suites cannot drift: consent ON and any recovery cool-down elapsed.
 *
 * Tombstone-aware from: a username tombstone is
 * NON-CONSENTED — `false`, through this same call, identical work into the
 * lookup's single exit, no timing signature. Typed as a guard so the lookup
 * can read `groupId` off a claim this answered `true` for: only a LIVE
 * claim ever passes. (A live-but-non-consented claim also answers `false`;
 * the guard's negative narrowing is TypeScript's inference, not a promise
 * that the row was a tombstone — callers return on `false`, never inspect.)
 */
export function identifierClaimDiscoverable(
  claim: DiscoverableClaim | Pick<UsernameTombstoneRecord, 'tombstoned'>,
  nowSeconds: number,
): claim is DiscoverableClaim {
  if ('tombstoned' in claim && claim.tombstoned === true) return false;
  const live = claim as DiscoverableClaim;
  return (
    live.discoverable === true &&
    (live.discoverableAfter === undefined || nowSeconds >= live.discoverableAfter)
  );
}

/**
 * A pending email verification code: TTL 5 min + EXPLICIT `expiresAt`
 * checked at validation (reaping is cleanup, never the enforcement), attempt
 * cap, deliberately NOT hashed (the shipped precedent).
 * One row per requesting device (`emailcode#<userId>`, sessions table) — a
 * re-request replaces it, priced by the resend cool-down. The row carries the
 * HMAC-derived claim key(s), NEVER the identifier plaintext: the address
 * exists in SES transit at send time and nowhere durable.
 */
export interface EmailCodeRecord {
  /** The requesting account (the attach target / the recovering device). */
  userId: string;
  /** What proving this code authorizes. */
  purpose: 'attach' | 'recovery';
  /** The claim key the attach will write (newest version), or the claim key
   * that RESOLVED for a recovery request. For a recovery MISS the row is
   * simply never written (uniform bytes either way). */
  claimKey: string;
  /** Recovery only: the group the resolved claim named at request time. */
  targetGroupId?: string;
  /** The declared device class (attach: the lazily-created solo group's slot;
   * recovery: the slot the recovering device will take). */
  deviceClass: DeviceClass;
  /** The 6-digit code, plaintext by decided precedent. */
  code: string;
  /** Validation attempts consumed so far (cap: EMAIL_CODE_ATTEMPT_CAP). */
  attempts: number;
  createdAt: number; // unix ms
  expiresAt: number; // unix seconds — the ENFORCED expiry
}

export type EmailAttachResult =
  | 'attached'
  /** The claim row already exists — this identifier belongs to a group
   * (possibly the caller's own). Collapsed upstream. */
  | 'claim_exists'
  /** The group already holds its ONE verified identifier OF THIS CLASS (the
   * per-class one-slot cap). The
   * CLASS half lives in the handler precheck composed with the transaction's
   * `identifierRefs =:snapshot` CAS (one read feeds both, so a racing
   * same-class attach loses atomically); the transaction's own
   * `size(identifierRefs) <:cap` backstop (MAX_VERIFIED_IDENTIFIERS_PER_GROUP)
   * refuses any growth past the pinned
   * total no matter what snapshot a caller supplies. */
  | 'identifier_cap'
  /** The refs snapshot moved between the handler's read and commit for a
   * reason other than this class's slot filling (a concurrent OTHER-class
   * attach or an unlink) — the losing side of the snapshot condition.
   * Collapsed upstream like every attach refusal. */
  | 'stale'
  /** Solo path only: the caller stopped being solo between precheck and
   * commit (a racing link) — the attribute_not_exists(groupId) condition. */
  | 'already_grouped'
  /** The code row was consumed/replaced/expired between validation and
   * commit — single-use is a transaction condition, not a read. */
  | 'code_gone'
  /** The caller's row (or its group row) is missing. */
  | 'unknown_member';

export type EmailUnlinkResult = 'unlinked' | 'stale' | 'not_member' | 'unknown_group';

/**
 * The username CLAIM transaction's outcomes.
 * `taken` is the ONE identifier-keyed answer the handler may distinguish
 * (the frozen 409 — occupancy of a self-chosen public label, never linkage);
 * everything else collapses upstream into the frozen refusal.
 */
export type UsernameClaimResult =
  | 'claimed'
  /** The name — its exact row OR its skeleton row, under the newest OR a
   * retiring key version — is held: a live claim, or a tombstone still
   * inside its window whose former owner is not the caller. One bit. */
  | 'taken'
  /** The group already holds its ONE username (the per-class one-slot cap,
   * structural): the handler routes to rename instead. */
  | 'identifier_cap'
  /** `usernameRenamedAt` (stamped by rename AND unlink) is inside the
   * 30-day cool-down and this claim is not the reclaim of the group's own
   * live tombstone: refused WITHOUT consuming anything (the hoarding fix —
   * unlink-then-claim-another is a rename spelled in two verbs). */
  | 'cooldown'
  /** The refs snapshot moved between the handler's read and commit. */
  | 'stale'
  /** The caller's row (or its group) is missing, or the caller is not a live
   * human member of the group. */
  | 'unknown_member';

/** The five-item RENAME transaction's outcomes. */
export type UsernameRenameResult =
  | 'renamed'
  | 'taken'
  /** `usernameRenamedAt` is inside the 30-day cool-down: refused WITHOUT
   * consuming anything (success-only consumption). */
  | 'cooldown'
  /** The new name IS the held name (under any active key version): no
   * transaction runs — two operations on one item would reject wholesale,
   * and a no-op rename must not consume the cool-down. */
  | 'same_name'
  | 'stale'
  | 'unknown_member';

/** The operator revocation primitive's outcomes (the ops lane). */
export type UsernameRevokeResult =
  /** Both rows tombstoned (nobody-reclaims) and the holder's ref shrunk.
   * Carries the (former) holder's groupId — the ONE fact the ops lane
   * needs after the commit, to fan the `usernameRevoked` notice to that
   * group's members. The script
   * prints the outcome word only; the id never reaches a terminal. */
  | { outcome: 'revoked'; groupId: string }
  /** No live claim at this key (already tombstoned, or never claimed). */
  | { outcome: 'gone' }
  /** The holder's refs kept moving under the bounded retry — re-run. */
  | { outcome: 'stale' };

/**
 * The `recovery#<groupId>` pending row: born at recovery-verify, TTL'd
 * past its own completion window, cancellable by any surviving member — and
 * the CANCEL WINS by construction: completion's transaction conditions on
 * `attribute_not_exists(canceled)`, so of a racing cancel and completion
 * exactly one commits (DynamoDB serializes the two writes).
 */
export interface RecoveryPendingRecord {
  groupId: string;
  /** The recovering device — a brand-new pristine keypair account. */
  newUserId: string;
  /** The declared slot; an occupied slot makes completion the replace
   * transaction (revoke incumbent + attach, one TransactWrite). */
  deviceClass: DeviceClass;
  /** The claim key that proved the identifier at request time. */
  claimKey: string;
  /**
   * The identifier CLASS recorded at birth — what lets the phone kill switch DOMINATE the shared
   * completion path (`/v1/recovery/complete` refuses a phone-class row while
   * `feature#accounts-phone` is absent; email rows and the cancel leg are
   * untouched). Derived by `putRecoveryPending` from the claim-key PREFIX
   * that proved the code — a caller-supplied value here is IGNORED, never
   * client-asserted. Always present on rows read back: a previous row
   * without the stored attribute reads as 'email', the only class that
   * existed when it was born.
   */
  identifierClass?: 'email' | 'phone';
  requestedAt: number; // unix ms
  /** Unix seconds: completion refuses before this moment — the pinned
   * 72 h delay, checked as a transaction condition against the injected
   * clock, never a scheduler. */
  completesAt: number;
  /** Present (true) once a surviving member cancelled. The row is kept, not
   * deleted, so a late completion attempt meets the refusal rather than an
   * absent row it might race. */
  canceled?: boolean;
  expiresAt: number; // unix seconds — TTL cleanup horizon
}

export type RecoveryCreateResult = 'created' | 'exists' | 'not_pristine' | 'unknown_member' | 'stale';

export type RecoveryCompleteResult =
  | 'completed'
  /** A surviving member cancelled — the cancel WINS. */
  | 'canceled'
  /** The delay has not elapsed (completesAt in the future). */
  | 'not_ready'
  /** No pending recovery for this group naming this caller. */
  | 'gone'
  /** The group row moved (epoch) or is missing, or a named row's condition
   * refused — the losing side of the serialization; re-read and retry. */
  | 'stale'
  /** The merged-cap condition: attaching the
   * recovering device would put the post-recovery roster's crew adoptions
   * over CREW_MAX_MEMBERS or its consent edges over CONSENT_MAX_EDGES.
   * Recovery admission never checked crew/consent state — "pristine" meant
   * only ungrouped/untombstoned/human — so a lived-in solo account could
   * recover into a group and mint over-cap capacity. Same sum-fresh-and-pin
   * shape as the link transaction, ONE cap discipline for every verb that
   * adds a member. */
  | 'cap_exceeded';

export type RevokeDeviceResult =
  | 'revoked'
  | 'unknown_group'
  | 'stale_epoch'
  | 'not_member'
  | 'not_acting_member'
  /** A named agent's idkey claim vanished between the handler's ownership
   * check and commit (a racing self-deletion) — retry re-reads and re-lists
   * (binding fate). */
  | 'binding_conflict';

export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: number; // unix ms
  expiresAt: number; // unix seconds (TTL)
}

export interface ConnectionRecord {
  userId: string;
  connectionId: string;
  connectedAt: number; // unix ms
  /**
   * The SHA-256 digest (hex) of the session token that authorized this socket
   * The socket is opened with a single-use ticket
   * minted over an authenticated HTTPS request; that request's bearer digest
   * rides the ticket into this row, so revoking the session can find the exact
   * live connection it opened and tear it down — and a surviving frame can be
   * matched back to a session that no longer exists.
   *
   * The DIGEST, never the token: this row is no more allowed to hold a usable
   * bearer than the sessions table is. Optional in the TYPE because a
   * row written before could lack it — but such a row is now INVALID, not
   * legacy: on a session-enforcing host every reader refuses it (frames are
   * refused, live delivery is withheld, the drain refuses, a dial cannot
   * create one, an incumbent claim displaces it, and every revoke shape tears
   * it down). A socket that no session can revoke fails CLOSED.
   */
  sessionDigest?: string;
  /**
   * DynamoDB TTL (unix seconds) — the BACKSTOP on a never-disconnected row,
   * never the cleanup. Stamped by the STORE on every connection write
   * (`putConnection`/`claimConnection` compute it from `connectedAt`, see
   * `connectionExpiresAt`), so no caller can forget it and no caller can set
   * it. The conditional deletes ($disconnect, the send-path reap, revoke
   * teardown) remain authoritative and always run first; TTL exists for the
   * one row they can never see — a socket that half-died without a
   * $disconnect and that nothing ever displaces.
   * Optional on the TYPE because rows written before this landed lack it;
   * readers never consult it. It marks ELIGIBILITY for the lazy reaper, never
   * a read-time bound — see `CONNECTION_ROW_TTL_SECONDS`.
   */
  expiresAt?: number;
}

/**
 * When a connection row becomes ELIGIBLE for DynamoDB's TTL reaper: API
 * Gateway's 2-hour connection hard cap plus 15 minutes of slack past
 * `connectedAt`. No live socket can outlast the cap, so a row this old is a
 * ghost by construction — TTL deleting it can never unroute anything. The
 * slack keeps eligibility strictly behind every path that reasons about row
 * age.
 *
 * ELIGIBLE, not deleted: DynamoDB applies TTL asynchronously with no deadline
 * (typically within days, occasionally longer), and readers deliberately never
 * consult `expiresAt` — so an orphan row can still be READ well past this
 * bound. What the stamp guarantees is only that a ghost row is EVENTUALLY
 * reaped instead of immortal; anything needing a read-time bound must use the
 * conditional deletes, which remain the authority.
 */
export const CONNECTION_ROW_TTL_SECONDS = 2 * 60 * 60 + 15 * 60;

/** The `expiresAt` every connection-row write stamps (unix seconds). */
export function connectionExpiresAt(connectedAtMs: number): number {
  return Math.floor(connectedAtMs / 1000) + CONNECTION_ROW_TTL_SECONDS;
}

/**
 * A device's VoIP push token. One row per user — the token
 * is the capability to make a phone ring, so nothing outside the push sender
 * ever reads it and there is no read route on the API.
 */
export interface PushTokenRecord {
  userId: string;
  /**
   * Which push network wakes this device. ABSENT MEANS `'ios'` — every row
   * written before Android support predates the field, and the compatibility
   * rule is the same one the DTO carries: absence is the legacy platform, so
   * old rows keep routing to APNs without a migration. The router
   * (push/route.ts) is the only reader that branches on it.
   */
  platform?: 'ios' | 'android';
  /** APNs VoIP device token, hex. Rings the phone for a call (PushKit).
   * Optional for the same reason `alertToken` is: a device may have one and
   * not the other. iOS rows only. */
  voipToken?: string;
  /**
   * APNs ALERT device token, hex, or absent on a build that never registered
   * one.
   *
   * A distinct token from the VoIP one — PushKit and UNUserNotificationCenter
   * issue different tokens for the same device, and sending an alert to the
   * VoIP token fails silently. Optional so a client that predates message
   * notifications keeps working: no alert token means no message push, which
   * is exactly the old behaviour. iOS rows only.
   */
  alertToken?: string;
  /**
   * The ONE FCM registration token: firebase-messaging
   * issues a single token per app instance, and it serves BOTH the call-wake
   * and message-wake lanes — the iOS dual-token split is an Apple fact with
   * no Google analogue. Present exactly on `platform: 'android'` rows.
   */
  fcmToken?: string;
  /** Which APNs host the iOS tokens belong to; sending to the wrong one
   * silently fails. iOS rows only — FCM has no host split, so an Android row
   * carries no `env` rather than a made-up one. */
  env?: 'sandbox' | 'production';
  bundleId: string;
  updatedAt: number; // unix ms
  expiresAt: number; // unix SECONDS (DynamoDB TTL)
}

/**
 * An abuse report.
 *
 * The only row in this system that can contain readable user text, and it
 * gets there one way: a person selected specific messages and chose to send
 * them. Nothing writes an excerpt automatically, and a report with none is
 * the normal case.
 *
 * Note what is deliberately NOT here. No msgId — carrying one would let this
 * table be joined to the envelope the relay already forwarded, which is the
 * correlation the whole design exists to prevent. No ciphertext — the server
 * holds no key, so a copy would be dead weight that still looked like
 * evidence.
 */
export interface ReportRecord {
  /** Opaque ULID. The partition key, so the table's shape reveals nothing
   * about who reported whom. */
  reportId: string;
  reporterId: string;
  reportedUserId: string;
  reason: string;
  /** Present only when the reporter attached messages by hand. */
  excerpts?: { body: string; direction: 'in' | 'out'; sentAt: number }[];
  createdAt: number; // unix ms
  expiresAt: number; // unix seconds (TTL)
}

export interface QueuedMessage {
  recipientId: string;
  msgId: string; // ULID (sort key -> drain order)
  senderId: string;
  /**
   * 'prekey' | 'ciphertext' are the client-mintable `MsgType` pair (frames).
   * 'accounts' is SERVER-ONLY: a link-offer or roster
   * notice fanned to a member's queue — `SendFrame.msgType` cannot spell it,
   * so no client can forge one; the drain emits it as an
   * `AccountsNoticeFrame` instead of a `msg` frame.
   */
  type: 'prekey' | 'ciphertext' | 'accounts';
  payload: string; // b64 ciphertext — never logged
  ts: number; // unix ms
  expiresAt: number; // unix seconds (TTL)
}

/**
 * The offline-queue cap, per (SENDER, recipient) pair (completing the
 * streaming-drain fix). The drain now streams, so a flood no longer
 * black-holes the backlog — but nothing bounded what could be ENQUEUED, so one
 * account could pile ~5 near-30 KB messages/sec at a single victim for the
 * 30-day TTL. This bounds what any ONE sender may leave undelivered for any ONE
 * recipient at a time.
 *
 * PER (SENDER, recipient), NEVER a per-recipient TOTAL. A total cap would be an
 * eviction primitive: an attacker fills the victim's global quota and every
 * legitimate sender is then refused. Keyed by the pair, a flooder exhausts only
 * its OWN allowance against that victim; everyone else is untouched.
 *
 * Sizing (justified in the commit body):
 * - `items` 5000. A legitimate worst case — a chatty single correspondent
 * while the recipient is offline for days — sits in the low thousands; 5000
 * clears it with headroom while turning the attacker's 13M-item ambition
 * into 5000.
 * - `bytes` 32 MiB. At the 30 KB max envelope that is ~1090 max-size messages
 * (~3.6 min of the 5/s attack) versus the ~3.9 TB it was aiming — a
 * >100000x reduction — while 32 MiB / 5000 ≈ 6.5 KB per item is far above a
 * typical text ciphertext, so ordinary use never approaches it.
 *
 * Enforced at ENQUEUE and refusing the NEW send; already-queued messages are
 * NEVER dropped or evicted (that would hand back the very primitive this
 * avoids).
 */
export interface QueueQuota {
  /** Max simultaneously-queued items from one sender to one recipient. */
  items: number;
  /** Max simultaneously-queued payload bytes from one sender to one recipient. */
  bytes: number;
  /**
   * The UNKNOWN-sender bounds (S2a). The per-pair cap alone left the recipient
   * partition unbounded in the number of SENDERS: accounts are free to mint,
   * so N Sybil registrations were N full allowances aimed at one victim.
   *
   * A sender is ESTABLISHED when the recipient has itself enqueued anything to
   * that sender within the trailing message-TTL window (any frame — a reply, a
   * read receipt, a profile card — leaves a pair-ledger row; see
   * `hasQueuedCorrespondence`). Established senders keep the full per-pair
   * allowance above, and their aggregate is bounded by the RECIPIENT's own
   * behaviour — 32 MiB times the number of people the recipient has written to
   * — which an attacker cannot mint.
   *
   * A sender with no such reverse correspondence is UNKNOWN: its per-pair
   * allowance is the tighter `unknownItems`/`unknownBytes` (effective bound =
   * min with the pair cap), and every unknown sender together shares the
   * per-recipient `unknownTotalItems`/`unknownTotalBytes` ceiling. A Sybil
   * fleet of any size therefore holds ONE small allowance, not N large ones.
   *
   * DELIBERATELY NOT a per-recipient TOTAL cap: a prior validation established
   * that shape is an eviction/denial primitive — fill the victim's global
   * quota and every legitimate sender is refused. Here the refusal falls on
   * the marginal (unknown) sender only; nobody the recipient corresponds with
   * can ever be refused by a stranger's flood.
   *
   * Refusals surface as the SAME QueuedQuotaExceededError either way: a
   * distinct stranger refusal would let any sender probe whether the recipient
   * has ever written to them.
   *
   * Optional so existing callers and injected test quotas are unchanged;
   * absent fields take the DEFAULT_QUEUE_QUOTA values.
   */
  unknownItems?: number;
  unknownBytes?: number;
  unknownTotalItems?: number;
  unknownTotalBytes?: number;
}

export const DEFAULT_QUEUE_QUOTA: Required<QueueQuota> = {
  items: 5000,
  bytes: 32 * 1024 * 1024,
  /**
   * Sizing (S2a): 500 items / 4 MiB per unknown pair — a courting stranger
   * (someone messaging first, before any reply) sits in the tens of messages,
   * so 500 clears legitimate first contact by an order of magnitude while one
   * flooder can take at most 1/5 of the shared item ceiling below. 2500 items
   * / 16 MiB across ALL unknown senders: with the per-pair bound, filling it
   * takes >=5 coordinated accounts, and the victim's total exposure to
   * strangers is 16 MiB — where at HEAD it was 32 MiB times an unbounded
   * account count. Residual, stated honestly: Sybil cannot be fully solved
   * without account cost — a >=5-account fleet can still fill the stranger
   * ceiling and refuse OTHER first-contact senders queueing to an offline
   * victim until acks or TTL free it. Established correspondents are
   * untouched by construction.
   */
  unknownItems: 500,
  unknownBytes: 4 * 1024 * 1024,
  unknownTotalItems: 2500,
  unknownTotalBytes: 16 * 1024 * 1024,
};

/** Injected quotas may name only the per-pair fields; the unknown-sender
 * bounds default. One resolver, used by BOTH data layers, so the twins cannot
 * drift on what an absent field means. */
export function resolveQueueQuota(quota: QueueQuota): Required<QueueQuota> {
  return {
    items: quota.items,
    bytes: quota.bytes,
    unknownItems: quota.unknownItems ?? DEFAULT_QUEUE_QUOTA.unknownItems,
    unknownBytes: quota.unknownBytes ?? DEFAULT_QUEUE_QUOTA.unknownBytes,
    unknownTotalItems: quota.unknownTotalItems ?? DEFAULT_QUEUE_QUOTA.unknownTotalItems,
    unknownTotalBytes: quota.unknownTotalBytes ?? DEFAULT_QUEUE_QUOTA.unknownTotalBytes,
  };
}

/**
 * The group-aware quota collapse for ONE send:
 * resolved by the HANDLER — which already holds both user rows and reads the
 * `feature#accounts` flag — and passed down so this layer stays free of user
 * table reads on the queue path. ABSENT means per-ULID keys exactly as
 * shipped: the solo↔solo hot path, every send while the flag is OFF or
 * deleted (the kill switch restores the shipped keys), and
 * every legacy caller.
 *
 * What it collapses, and why each field exists:
 * - `senderScope`: the pair-ledger KEY the send bills to
 * (`#quota#<senderScope>` in the recipient's partition) — the sender's
 * groupId when grouped, else the sender ULID. Three linked sender devices
 * therefore share ONE pair allowance against a recipient instead of
 * holding three (a peer's new device must not multiply anyone's
 * abuse budget ×3).
 * - `recipientRosterSize`: divides the recipient-side caps per member queue
 * (⌊cap/N⌋, min 1 item), so a 3-device recipient's TOTAL inbound budget
 * from one correspondent — three per-device queues taken together —
 * equals the 1-device budget, not 3×. Ledger rows stay co-located with
 * the message rows they count (same partition), so release, TTL and the
 * reconciler keep their shapes; the SHARE, not the row, is what collapses.
 * Honest residual, stated: an old client that does not fan out sends to
 * only one member queue and sees ⌊cap/N⌋ for the update window — the
 * old-client skew, wrong-feeling but not unsafe, resolved by app updates.
 * - `senderMembers` × `recipientKeys`: the reverse-correspondence walk. The
 * relationship signal ("has the recipient ever user-authored to this
 * sender?") goes group-aware by probing every (recipient scope key,
 * sender member partition) pair — a bounded GetItem walk (≤3 partitions ×
 * ≤4 keys), never a Query — so linking a device NEVER resets an
 * established pair to stranger: the reply that established it sits in the
 * OLD device's partition under the OLD scope key, and the walk still
 * finds it. `recipientKeys` carries the recipient's groupId AND its
 * member ULIDs because rows billed before the collapse (or before the
 * link) are keyed by bare ULIDs.
 */
export interface GroupQuotaContext {
  /** Pair-ledger key scope for the sender side; the sender ULID when solo. */
  senderScope: string;
  /** Member ULIDs of the sender's group, the sender itself included. */
  senderMembers: readonly string[];
  /** The recipient's scope candidates: groupId (when grouped) + member
   * ULIDs — every key the recipient's own past sends may be billed under. */
  recipientKeys: readonly string[];
  /** Member ULIDs of the recipient's group — the queue PARTITIONS the
   * relationship's rows live in (`[recipientId]` when solo). Distinct from
   * `recipientKeys`, which mixes in the groupId (a ledger SCOPE key, never a
   * partition): the -gate admission walk sums ledgers across these
   * partitions, and summing against the groupId "partition" would read rows
   * that cannot exist. */
  recipientMembers: readonly string[];
  /** Member count of the recipient's group (1 when solo): the divisor that
   * keeps the recipient's TOTAL inbound budget at 1× across N queues. */
  recipientRosterSize: number;
}

/**
 * Quota LEDGER rows (S1) share the messages table, keyed under a sort-key
 * namespace no message can collide with: every msgId is a ULID (Crockford
 * base32, first char >= '0'), and every ledger key starts with '#' (0x23).
 * `QUEUE_CONTROL_CEILING` ('/', 0x2F) sits between the two, so one key-range
 * comparison both hides ledger rows from the drain and doubles as the pager's
 * exclusive-start cursor.
 *
 * - `#quota#<senderId>` — the (sender -> recipient) pair ledger: qItems /
 *   qBytes maintained transactionally with the message rows, expiresAt riding
 *   the newest message's TTL. The row SURVIVES its count reaching zero: its
 *   existence is the reverse-correspondence signal `hasQueuedCorrespondence`
 *   reads, and it self-reaps ~MESSAGE_TTL after the pair's last send.
 * - `#quota-strangers` — the per-recipient unknown-sender aggregate (S2a).
 */
const QUEUE_PAIR_LEDGER_PREFIX = '#quota#';
const QUEUE_STRANGER_LEDGER_KEY = '#quota-strangers';
const QUEUE_CONTROL_CEILING = '/';

export function queuePairLedgerKey(senderId: string): string {
  return `${QUEUE_PAIR_LEDGER_PREFIX}${senderId}`;
}

/** True for sort keys in the bookkeeping namespace (below the ULID alphabet).
 * Enqueue refuses them and ack ignores them, so no client-supplied msgId can
 * ever read, replace or delete a ledger row — the frame schema's ULID shape
 * already refuses these, but the store must not rely on exactly one guard. */
export function isQueueControlKey(msgId: string): boolean {
  return msgId < '0';
}

/**
 * `enqueueMessage` refused because the (sender, recipient) queue is at its cap
 * A typed error, not a boolean, so the caller answers a specific 429 and
 * a bug that swallowed it would surface as an unhandled throw rather than a
 * silently dropped message. Both data-layer implementations throw exactly this.
 */
export class QueuedQuotaExceededError extends Error {
  constructor() {
    super('queued message quota exceeded for this sender/recipient pair');
    this.name = 'QueuedQuotaExceededError';
  }
}

/**
 * `enqueueMessage` refused at COMMIT TIME because a participant's user row is
 * tombstoned. The handler prechecks both rows,
 * but a precheck is UX — a revoke transaction committing between the read and
 * the enqueue commit (or a stale eventually-consistent read resuming after
 * it) would otherwise let a send commit FROM or TO a revoked device. The
 * refusal is enforced as ConditionCheck items on both user rows inside the
 * enqueue TransactWriteItems, so it holds under every interleaving: after
 * the revoke's roster/tombstone transaction commits, no send commits either
 * way. `side` names which condition refused so the handler can answer the
 * SAME bytes its precheck answers (`unknown_sender` / `recipient_revoked`) —
 * never a new discriminator.
 */
export class QueueParticipantTombstonedError extends Error {
  constructor(public readonly side: 'sender' | 'recipient') {
    super(`queued message refused: ${side} account is tombstoned`);
    this.name = 'QueueParticipantTombstonedError';
  }
}

/**
 * The WIDENED owner-group admission, pinned to DELIVERY. `ownerGroupAdmits` authorizes an
 * integration-involved send off a strongly consistent roster read — but a
 * read is a precheck, and an AMICABLE unlink committing between that read
 * and the enqueue commit leaves BOTH user rows live, so the tombstone
 * ConditionChecks alone would let the send land after group reach died.
 * When (and only when) the admission rode the widened clause, the handler
 * threads this pin and the enqueue transaction carries a ConditionCheck on
 * the GROUP row — `contains(memberIds, owner) AND contains(memberIds,
 * member)` — so the roster membership that authorized the send still holds
 * when the row commits, under every interleaving (the tombstone-check
 * precedent, one transaction over). The exact-owner clause never pins:
 * the bind is write-once and rides unlink by design.
 */
export interface GroupReachPin {
  groupId: string;
  /** The integration's bound owner ULID — must still be in the roster. */
  ownerUserId: string;
  /** The widened counterparty ULID — must still be in the roster. */
  memberUserId: string;
  /** Which predicate arm granted the widened admission, so the handler can
   * answer that arm's own FROZEN refusal bytes when the pin cancels (:
   * the race must not mint a third refusal shape). */
  arm: 'send' | 'inbox';
}

/** `enqueueMessage` refused at COMMIT TIME because the group membership that
 * authorized a WIDENED integration send no longer holds (see GroupReachPin). */
export class QueueGroupReachRevokedError extends Error {
  constructor(public readonly arm: 'send' | 'inbox') {
    super('queued message refused: owner-group reach was revoked before commit');
    this.name = 'QueueGroupReachRevokedError';
  }
}

/**
 * Which quota ledger a refusal wants healed (quota-repair
 * durability). A DISCRIMINATOR, deliberately not the ledger key or a
 * filter expression: this value crosses a process boundary (the AWS host
 * serializes it into an async worker invoke), and an event that carried a raw
 * key or FilterExpression would let a mis-routed or replayed event aim the
 * reconciler at arbitrary rows. The worker rebuilds both from the same
 * constants the enqueue path uses, so filter and stamp cannot drift apart.
 */
export type LedgerReconcileTarget =
  | { kind: 'pair'; senderId: string }
  | { kind: 'stranger' };

/** One scheduled repair: heal `target`'s ledger for `recipientId`. */
export interface LedgerReconcileRequest {
  recipientId: string;
  target: LedgerReconcileTarget;
}

/**
 * What one reconcile slice achieved, for the out-of-band worker's
 * continuation decision:
 *  - 'complete'   — the scan reached the end of the partition and the ledger
 *                   is settled (verified truthful, or reset downward);
 *  - 'continue'   — more work remains (budget exhausted with a persisted
 *                   cursor, or a binding race voided the scan): another slice
 *                   is needed;
 *  - 'stood_down' — another reconciler holds the lease; it owns the work.
 */
export type LedgerReconcileOutcome = 'complete' | 'continue' | 'stood_down';

/**
 * Host-provided seams for work that must not die with the request.
 *
 * `scheduleReconcile`: hand the ledger repair to something DURABLE before the
 * refusal returns. Under AWS this is an async (Event) Lambda invoke of the
 * reconcile worker — Lambda's internal async queue survives the container
 * freezing the moment the 429 goes out, which a floating promise on this
 * event loop does not. The data layer AWAITS the handoff (one fast queueing
 * call), never the repair itself. When absent (the LOCAL adapter's long-lived
 * process, unit tests), the repair runs in-process as before — a floating
 * promise genuinely survives there because the process does.
 */
export interface DataLayerHooks {
  scheduleReconcile?: (req: LedgerReconcileRequest) => Promise<void>;
  /** The store's own wall clock (defaults to `Date.now`) — injected only so
   * the wire tests can pin the connection-TTL clamp deterministically. It
   * exists to keep a caller-supplied timestamp from ever shrinking a TTL
   * bound; see the `expiresAt` stamp in `putConnection`. */
  nowMs?: () => number;
}

export interface DataLayer {
  /** `opts.consistent`: a strongly consistent read,
   * for the ENFORCEMENT reads — a tombstone decision served from a stale
   * replica can resurrect a revoked device for the lag window. Default stays
   * eventually consistent: prechecks are UX and hot paths keep their cost. */
  getUserById(
    userId: string,
    signal?: AbortSignal,
    opts?: { consistent?: boolean },
  ): Promise<UserRecord | undefined>;
  touchActivity(userId: string, nowMs: number, signal?: AbortSignal): Promise<void>;
  deleteActivity(userId: string, nowMs: number): Promise<void>;
  createUser(user: UserRecord): Promise<void>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(token: string): Promise<SessionRecord | undefined>;
  /**
   * The session behind a token DIGEST for the WebSocket per-frame
   * recheck. A live socket carries the digest of the session that opened it
   * (never the token), so this is the only way to ask "is that session
   * still there?" without the plaintext. Returns identity and expiry, not a
   * token, because the caller has none to round-trip and needs none.
   */
  getSessionByDigest(
    digest: string,
  ): Promise<Pick<SessionRecord, 'userId' | 'createdAt' | 'expiresAt'> | undefined>;

  // --- Key distribution ---
  /**
   * Set the caller's identity/signed/kyber prekey and REPLACE the one-time
   * prekey pool (a re-upload after reinstall must not serve stale prekeys).
   *
   * Returns **false** when the account already carries a DIFFERENT identity
   * key — rotation is not supported, a new key is a new account
   * An identical re-upload returns true.
   * Reported rather than thrown so the handler can answer 4xx: attempting a
   * rotation is a client error, not a server fault.
   */
  storeKeys(
    userId: string,
    core: CoreKeys,
    oneTimePrekeys: OneTimePrekey[],
  ): Promise<boolean>;

  // --- Keypair-only accounts ---
  /**
   * Return the existing account for an identity key, or create one atomically
   * with `candidateUserId`. A claim item on the base table (strongly
   * consistent) pins exactly one userId per key even under concurrent auth
   * calls, with no index to enumerate.
   */
  getOrCreateUserByIdentityKey(
    identityKeyPub: string,
    candidateUserId: string,
    createdAtMs: number,
    /** Honored only when this call creates the account; resolution ignores it
     * (the row is the authority). */
    accountClass?: 'integration',
  ): Promise<AccountResolution>;
  /**
   * Write-once owner binding for an integration account.
   * 'bound' on first success, 'already' when the same owner is re-bound
   * (idempotent retry), 'owner_conflict' when a DIFFERENT owner is already
   * bound (bindings are immutable), 'not_integration' when the row is missing
   * or not integration-class, 'unknown_owner' when the owner row is missing
   * or tombstoned AT COMMIT (an in-transaction liveness pin:
   * a dead ULID must never GAIN a binding).
   */
  bindIntegrationOwner(
    integrationUserId: string,
    ownerUserId: string,
  ): Promise<'bound' | 'already' | 'owner_conflict' | 'not_integration' | 'unknown_owner'>;
  /**
   * Owner-called crew adoption: one transaction that stamps
   * `crewId` on the member and mints-or-reuses it on the owner while taking a
   * `crewCount` slot under the CREW_MAX_MEMBERS cap. `mintCrewId` is the
   * server-minted id used ONLY when the owner has no crew yet — a
   * client-chosen scope is a scope an attacker can choose.
   *
   * THE CAP COUNTS PER GROUP since: a grouped owner's
   * slots are CREW_MAX_MEMBERS across the WHOLE device group — otherwise a
   * 3-device owner silently holds 24. The per-ULID `crewCount` rows stay the
   * authoritative counters (they ride each member through unlink, so the
   * binding fate needs no aggregate maintenance); this call resolves the
   * owner's group, sums the members' counts, and pins every sibling count
   * plus the group's epoch inside the transaction, so a concurrent sibling
   * adopt or roster change cancels the adopt instead of slipping past the
   * sum. A solo owner keeps the shipped single-row condition byte-identical.
   * NOT flag-gated: caps are enforcement, and a kill switch must not hand an
   * existing group extra slots (the prekey-floor rule).
   *
   * 'adopted' on success, 'already' when this member is already in this
   * owner's crew (idempotent retry — and the transaction refuses rather than
   * double-counting the slot), 'cap_reached' when the owner is out of slots,
   * 'not_integration' when the member is missing or human-class,
   * 'owner_conflict' when the member is bound to a different owner,
   * 'crew_conflict' when the member already carries a different crewId,
   * 'unknown_owner' when the owner row is missing or is not a human account
   * (an integration can never be an admission authority), 'crew_contended'
   * when a concurrent adopt changed which crew the owner is minting under
   * this call TWICE — transient, and the only retryable outcome: the caller
   * may simply call again.
   */
  adoptCrewMember(
    ownerUserId: string,
    memberUserId: string,
    mintCrewId: string,
  ): Promise<
    | 'adopted'
    | 'already'
    | 'cap_reached'
    | 'not_integration'
    | 'owner_conflict'
    | 'crew_conflict'
    | 'unknown_owner'
    | 'crew_contended'
  >;
  /**
   * Give one adopted slot back. This is NOT called on member teardown — that is
   * `deleteCrewMemberAndReleaseSlot`, which makes the release atomic with the
   * row's removal. This remains for release-without-delete uses (and tests).
   * Idempotent; a release against a deleted or never-counted owner is a
   * swallowed no-op — NOT a write, because `ADD` on a missing item would mint
   * a ghost user row at crewCount = -1.
   */
  releaseCrewSlot(ownerUserId: string): Promise<void>;
  /**
   * Tear down an adopted crew member: delete its user row AND release its
   * owner's slot in ONE TransactWriteItems, so the release is exactly-once BY
   * CONSTRUCTION (superseding the ordered two-step).
   *
   * Ordering could not fix what this fixes: two concurrent revokes both
   * pre-read the member, the old unconditional delete succeeded twice, and
   * BOTH decremented — eight members, two parallel revokes of one → seven
   * rows at crewCount = 6, so two replacement adopts put nine live members
   * under a reported eight. Here the delete carries
   * `attribute_exists(userId)`: the loser's transaction cancels on the row
   * being gone and its decrement never happens. The same mechanism closes the
   * crash-retry leak — a retry either finds the row and runs delete+decrement
   * as one unit, or finds it gone and releases nothing.
   *
   * When the member row exists but the OWNER refuses (row gone, or count
   * already 0 — legacy drift), the member row is still deleted, alone: the
   * teardown must never be blocked by having nothing to release, and
   * releasing what is not held would be the widening direction.
   */
  deleteCrewMemberAndReleaseSlot(memberUserId: string, ownerUserId: string): Promise<void>;
  /**
   * Permanently revoke an identity key: its claim row gains `tombstoned` and
   * `getOrCreateUserByIdentityKey` refuses it forever after. Idempotent. There
   * is deliberately NO method that clears a tombstone.
   * No-op when the key has no claim row.
   */
  tombstoneIdentityKey(identityKeyPub: string): Promise<void>;
  /**
   * The account holding this identity key, resolved through the CLAIM row:
   * two point GetItems, no Query.
   *
   * The shape matters as much as the result. No execution role in this stack
   * holds `dynamodb:Query` on the users table, and none may ever get one — a
   * Query there is a bulk "who is registered" oracle, which is precisely the
   * primitive the deleted phone GSI was. Resolving through a claim row answers
   * the same question for exactly one caller-supplied key at a time. Enforced
   * in infra/test/tacendum-security.test.ts.
   */
  getUserByIdentityKeyClaim(identityKeyPub: string): Promise<UserRecord | undefined>;
  /** Store the challenge issued for a key. Concurrent challenges COEXIST —
   * each (key, nonce) pair is its own row — so issuing one can never invalidate
   * another that is mid-flight. Banking nonces buys an attacker nothing: a
   * nonce is worthless without the private key, each row lives 2 minutes, and
   * issuance is per-IP rate limited. */
  putAuthChallenge(rec: AuthChallengeRecord): Promise<void>;
  /** The pending challenge row for exactly this (key, nonce) pair, if any. */
  getAuthChallenge(
    identityKeyPub: string,
    challenge: string,
  ): Promise<AuthChallengeRecord | undefined>;
  /**
   * Atomically consume the pending challenge row for this (key, nonce) pair.
   * True for the single caller that wins; false if already spent or never
   * issued.
   */
  consumeAuthChallengeIfMatches(identityKeyPub: string, challenge: string): Promise<boolean>;

  /**
   * WebSocket tickets: mint one bound to a user, then spend it
   * exactly once at `$connect`.
   *
   * They exist so a socket URL never carries the 30-day bearer, because a URL
   * is written to proxy logs, access logs and crash reporters and a month-long
   * credential in one of those is a slow leak with no expiry to save you.
   */
  putWsTicket(rec: {
    ticket: string;
    userId: string;
    expiresAt: number;
    role: WsTicketRole;
    /**
     * The digest of the session that minted this ticket. It is carried
     * onto the connection row the socket eventually writes, so revocation can
     * bind socket→session. Optional so a mint that predates (or a test that
     * does not care about revocation) omits it and the socket is simply not
     * session-revocable, exactly as before.
     */
    sessionDigest?: string;
  }): Promise<void>;
  /**
   * Spend a ticket. Returns the userId AND the role it was minted for, or
   * undefined if it never existed, was already spent, or has expired.
   *
   * Atomic, for the same reason `consumeAuthChallengeIfMatches` is: two
   * `$connect`s racing on one ticket must not both succeed, and a
   * read-then-delete lets them.
   *
   * THE ROLE COMES BACK FROM HERE AND NOT FROM THE SOCKET URL. It is decided
   * once, over HTTPS, on a request the caller authenticated with its bearer,
   * and it is then server-held state for the sixty seconds the ticket lives.
   * A role read out of the dial's query string would be a second, unauthenticated
   * place the same fact is declared — and on AWS the ticket is spent by the
   * authorizer, so $connect could not check the two agreed even if it wanted to.
   */
  consumeWsTicket(
    ticket: string,
    nowSeconds: number,
  ): Promise<{ userId: string; role: WsTicketRole; sessionDigest?: string } | undefined>;

  /** Atomically remove and return one one-time prekey, or undefined if none. */
  consumeOneTimePrekey(userId: string): Promise<OneTimePrekey | undefined>;
  /** Count remaining one-time prekeys for a user. */
  countOneTimePrekeys(userId: string): Promise<number>;

  // --- Real-time routing ---
  /** Account deletion (DELETE /v1/account). Each is idempotent — the handler
   * re-runs the whole sequence on retry.
   *
   * `guard.requireEmptyCrew` ('s backstop): when set,
   * the user-row delete itself carries `attribute_not_exists(crewCount) OR
   * crewCount =:zero`, and a refusal answers 'crew_not_empty' with NOTHING
   * deleted. The handler's read-time crewCount check is the good error
   * message; this is what makes it TRUE — an adopt that commits in the gap
   * between that read and this delete fails the condition instead of
   * orphaning a crew nobody can ever revoke (the same orphaned-crew shape,
   * reopened through a narrower window). Only the human self-delete passes
   * it; every guardless call keeps today's behaviour exactly and always
   * answers 'deleted'.
   *
   * `guard.requireNoCrewId` is the mirror image,
   * and it is what makes `requireEmptyCrew` above *sound*. A teardown decides
   * "is this an adopted member?" from a READ, then deletes. Because `crewId`
   * only ever goes absent→present (nothing clears it but the row's own
   * deletion), an adopt committing in that gap sent the teardown down the
   * no-release path: the member row went, the owner's `crewCount` did not come
   * down, and the slot was leaked with no ULID left to revoke. Eight of those
   * and the owner is capped out of adopting AND refused account deletion,
   * permanently — the very lockout `requireEmptyCrew` depends on being
   * impossible. So the no-release delete now carries
   * `attribute_not_exists(crewId)` and answers 'crew_appeared' instead of
   * silently succeeding, and the caller re-reads and takes the atomic
   * delete-and-release path.
   *
   * The two guards are mutually exclusive by construction: a human never has a
   * `crewId`, an integration never has a `crewCount`. */
  /** `pendingRecoveryGroupId`: the caller's
   * pre-delete read saw the row as a pending RECOVERING device — the
   * `recovery#` row it points at joins the SAME TransactWrite as the row
   * delete (conditioned on still naming this device), because the hint
   * lives ONLY in the row being deleted: a crash between a non-fused row
   * delete and a later purge left a retry with no way to ever find the
   * recovery row again (the group's members could still cancel or replace
   * it, but nothing was OWED to — an orphan candidate). Fused, the two die
   * together or not at all. A recovery row re-minted for a DIFFERENT
   * device cancels the fused item; the retry drops the hint and deletes
   * the row alone (that row is no longer this account's to take). */
  deleteUser(
    userId: string,
    claims: { identityKeyPub?: string; pendingRecoveryGroupId?: string },
    guard?: { requireEmptyCrew?: boolean; requireNoCrewId?: boolean },
  ): Promise<'deleted' | 'crew_not_empty' | 'crew_appeared'>;
  deleteOneTimePrekeys(userId: string): Promise<void>;
  deleteSession(token: string): Promise<void>;
  /**
   * Delete every session belonging to `userId`, optionally sparing the one
   * presented as `exceptToken` (the caller's own, for "sign out everywhere
   * else"). Returns how many were revoked, not counting the spared one.
   *
   * Queries SESSIONS_USER_INDEX keys-only: a session row is a credential, and
   * nothing here needs to read one to destroy it.
   */
  deleteSessionsForUser(userId: string, exceptToken?: string): Promise<number>;
  purgeQueuedMessages(recipientId: string): Promise<void>;
  putConnection(rec: ConnectionRecord): Promise<void>;
  /**
   * Claim the connection row for a user, but ONLY if it still holds
   * `expectedConnectionId` (or is absent when that is undefined).
   *
   * The compare-and-swap the WebSocket $connect path needs, and the reason it
   * cannot be done above the store: every read here is a separate round trip,
   * and DynamoDB's default read is eventually consistent, so a re-read next to
   * an unconditional Put narrows the overwrite window without closing it. A
   * one-shot `send` that lost that race overwrote a live listener's row and
   * then deleted it on disconnect, leaving a socket that believed it was
   * listening while every message queued to the 30-day TTL.
   *
   * Returns false when the row has moved on — the caller has been superseded
   * and must not write.
   */
  claimConnection(
    rec: ConnectionRecord,
    expectedConnectionId: string | undefined,
  ): Promise<boolean>;
  getConnection(userId: string): Promise<ConnectionRecord | undefined>;

  // --- Abuse reports ---
  /**
   * Write-only from the API's point of view: there is no `getReport`, and
   * none should be added. Nothing in the request path ever needs to read a
   * report back, and an endpoint that could would be an endpoint that leaks
   * who reported whom. Reports are read out of band, by a human, through the
   * console.
   */
  putReport(rec: ReportRecord): Promise<void>;

  // --- VoIP push tokens ---
  putPushToken(rec: PushTokenRecord): Promise<void>;
  getPushToken(userId: string): Promise<PushTokenRecord | undefined>;
  deletePushToken(userId: string): Promise<void>;
  /** Delete ONLY if the stored token still matches the one that was found
   * dead. A device that re-registered while a push was in flight must not
   * have its fresh row deleted by a stale 410. */
  deletePushTokenIfMatches(userId: string, voipToken: string): Promise<void>;
  /** Remove ONE dead token from the row, conditional on its exact value, and
   * the row itself only when nothing usable remains. Deleting the whole row
   * for one dead token was erasing the OTHER, still-working registration —
   * a freshly rotated VoIP token gone because the stale alert token 410'd. */
  removePushTokenField(
    userId: string,
    field: 'voipToken' | 'alertToken' | 'fcmToken',
    expectedValue: string,
  ): Promise<void>;
  /** Register tokens WITHOUT reading the row. Provided tokens overwrite,
   * missing ones keep whatever is stored — but only while env and bundleId
   * match; a mismatch replaces the row wholesale, because a token minted for
   * the other APNs host is not a token. One conditional UpdateItem (plus a
   * Put fallback for the first write / env switch), so it is write-only under
   * IAM — the register handler holds no read on this table, deliberately —
   * and atomic, so two token rotations racing cannot resurrect old values.
   * An Android registration (`platform: 'android'`, one FCM token) is a
   * plain replacing Put: one token means no half-row race to merge around,
   * and a platform switch must be total in both directions. */
  mergePushToken(rec: PushTokenRecord): Promise<void>;
  /**
   * HAS THIS WAKE ALREADY RUNG? (the platform-redelivery guard).
   *
   * Lambda's async queue is at-least-once and the push function carries the
   * default retry count, so ONE scheduling decision can be delivered to the
   * worker more than once — a duplicate the process cannot see, because a
   * timed-out invocation is redelivered by the platform with nothing left
   * running to notice. The event bytes are identical, the VoIP payload
   * carries no identifier, and a delivered push IS a native ring: the device
   * cannot absorb the second one either.
   *
   * `wakeId` is minted per SCHEDULE, never derived from the frame. A
   * msgId-keyed check would silence a client's legitimate call-offer resend
   * (same msgId, genuinely needs to ring) — denial-of-RING wearing an
   * idempotency costume, and denial-of-RING is on this project's rejected
   * remedies list. That rule lives at the mint (handlers/ws.ts,
   * `wakeRecipient`) and is pinned by push.wakeid.mint.test.ts; nothing this
   * layer can check would notice a derived key, so do not read this
   * paragraph as an enforcement point.
   *
   * FAILS TOWARD RINGING, and swallows its own errors to guarantee it: an
   * unavailable store, a missing grant, a throttle — all answer `false`, so
   * the wake proceeds. A duplicate ring is a bad minute; a missed ring is a
   * missed call.
   */
  wakeAlreadyRang(wakeId: string): Promise<boolean>;
  /**
   * Claim a wake id, AFTER the push has actually reached Apple — never
   * before. A pre-send claim would permanently silence the redelivery of an
   * invocation that timed out on the way to APNs, converting the fix into
   * the missed call it exists to prevent.
   *
   * `expiresAt` is the row's TTL in unix seconds; the caller sizes it past
   * Lambda's maximum event age so no redelivery can outlive its claim.
   * Swallows its own errors like the read: an unwritten claim costs at most
   * one duplicate ring on a redelivery that may never come.
   */
  markWakeRang(wakeId: string, expiresAt: number): Promise<void>;
  /** Delete only if the stored connectionId matches (a reconnect may have
   * already overwritten the row; a stale disconnect must not clobber it). */
  deleteConnection(userId: string, connectionId: string): Promise<void>;
  /**
   * Durably queue one message under the per-pair quota — ATOMICALLY (S1).
   *
   * Enforcement is a pair-ledger item updated under a ConditionExpression in
   * the same TransactWriteItems as the message row's Put, so the count and the
   * rows cannot diverge and two concurrent sends cannot both slip under the
   * cap. Throws QueuedQuotaExceededError when the send would exceed either the
   * pair bound or (for a sender the recipient has never written to) the shared
   * unknown-sender bound — see QueueQuota. A re-send of an already-queued
   * msgId is an idempotent no-op, resolved (not thrown) with
   * `inserted: false`.
   *
   * `inserted` — did THIS call store a new row? False for the
   * idempotent duplicate. The caller must spend push/notification budgets
   * only when it is true: a duplicate stores nothing, so charging the
   * recipient's shared wake allowance for it let three senders replaying one
   * msgId exhaust a victim's notifications without ever adding a message.
   * SERVER-INTERNAL — the sender-visible response must never reflect it, or
   * it becomes an oracle for whether a given msgId already exists.
   *
   * `opts.establishesCorrespondence` — does THIS send count as
   * user-authored correspondence, and so mint the reverse-correspondence
   * signal `hasQueuedCorrespondence` reads? The handler passes `false` for
   * automatic carriers (call.end/busy, read receipts, reactions, edits,
   * profile syncs — anything `urgent` or `notify:false`), which still queue
   * and count for the quota but must not grant a relationship the user never
   * chose. Absent (or true) means user-authored; the sole production caller
   * classifies explicitly, so absence is only direct test/legacy traffic.
   */
  /**
   * `opts.groupCtx` — the group-aware quota
   * collapse, resolved by the handler (flag + both group rows) and absent on
   * every per-ULID path: see GroupQuotaContext for the full contract. With
   * it, the pair ledger bills under `#quota#<senderScope>`, the recipient
   * caps divide by roster size, the established classification walks the
   * group-aware reverse-correspondence keys, and the message row is stamped
   * `qPair` so release and the refusal-path recount target exactly the
   * ledger billing chose even after rosters change.
   */
  /**
   * `opts.serverMinted` — this row is a
   * SERVER-minted bookkeeping notice attributed to `senderId`, not that
   * account acting: skip the sender-side tombstone ConditionCheck ONLY (the
   * recipient-side check always holds). Exists for exactly one caller —
   * `deliverAccountsNotice`, whose revoke notices are attributed to the
   * REVOKED (tombstoned) member so survivors learn who left. Never set it
   * on a client-originated send.
   */
  enqueueMessage(
    msg: QueuedMessage,
    opts?: {
      establishesCorrespondence?: boolean;
      groupCtx?: GroupQuotaContext;
      serverMinted?: boolean;
      /** Present iff the send was authorized by the WIDENED owner-group
       * clause: the enqueue transaction then
       * carries a group-row membership ConditionCheck and throws
       * QueueGroupReachRevokedError when it no longer holds at commit. */
      groupReachPin?: GroupReachPin;
    },
  ): Promise<{ inserted: boolean }>;
  /**
   * Run ONE leased, budgeted slice of the quota-ledger repair for `target`.
   * This is the entry the out-of-band worker calls;
   * a refusal never runs it inline — it only SCHEDULES it (DataLayerHooks).
   * All four load-bearing properties live in the slice itself: budgeted,
   * never lowered from an incomplete scan, single-flight via the row lease,
   * resumable under an unchanged (qGen, qVer). The outcome tells the worker
   * whether to schedule another slice ('continue') or stop.
   */
  reconcileQueueLedger(
    recipientId: string,
    target: LedgerReconcileTarget,
  ): Promise<LedgerReconcileOutcome>;
  /** Queued messages for a recipient in msgId (ULID -> chronological) order,
   * yielded one query page at a time. A stream, deliberately not an array: the
   * queue's size is attacker-controlled, so no consumer may ever be required
   * to hold the whole backlog to make progress. `afterMsgId` resumes the
   * stream strictly after that key — the drain's continuation cursor (S2b);
   * quota ledger rows never surface here regardless. */
  listQueuedMessages(recipientId: string, afterMsgId?: string): AsyncIterable<QueuedMessage[]>;
  /**
   * Delete a queued row AND release its quota (S1): the pair ledger — and the
   * unknown-sender aggregate when the row was billed there — comes down in
   * the same transaction as the delete, so a double ack can never
   * double-release and a crash can never release without deleting. Without
   * this the cap would decay into a permanent lockout for the pair. Ledger
   * keys are ignored: an ack can never delete bookkeeping.
   */
  deleteQueuedMessage(recipientId: string, msgId: string): Promise<void>;
  /**
   * ONE queued row, by its exact key — the ack-liveness probe (push-worker.ts).
   * Strongly consistent, because the whole question it answers is whether an
   * ack that may have committed milliseconds ago is visible yet: an eventually
   * consistent read would report "still queued" for a recipient that already
   * processed the frame, and spend a redundant ring on a live phone.
   */
  getQueuedMessage(recipientId: string, msgId: string): Promise<QueuedMessage | undefined>;
  /**
   * Has `senderId` sent USER-AUTHORED correspondence to `recipientId` within
   * the trailing message-TTL window? True exactly when the
   * (senderId -> recipientId) pair ledger is unexpired AND carries the
   * `qEstab` marker — a marker only a user-authored send sets. The row every
   * send creates (and no ack removes, only its own TTL ~MESSAGE_TTL after the
   * pair's last send) is NECESSARY but no longer SUFFICIENT: automatic
   * carriers create and count it for the quota without minting a relationship.
   *
   * This is the system's only relationship signal, and deliberately so: the
   * server keeps no contact list or roster, and this adds none — it reads
   * state the quota already maintains. Consumers: the unknown-sender queue
   * bounds (S2a) and the unknown-caller ring budget (S3), both asking "has
   * the RECIPIENT ever CHOSEN to write to this sender?" — the one fact an
   * attacker cannot mint, because only the recipient's own USER-AUTHORED sends
   * create it. It was mintable before: an attacker's call offer made the
   * victim's device auto-send call.end/busy back, and that involuntary carrier
   * (like any read receipt) minted the attacker as established.
   *
   * Known slack, stated: the signal lives ~30 days past the recipient's last
   * user-authored send to that party (plus DynamoDB TTL lag, which errs
   * generous). A pair dormant longer than that reverts to unknown until the
   * recipient writes a real message again — automatic carriers no longer renew
   * it for the purpose of this signal, though they still ride its TTL.
   */
  hasQueuedCorrespondence(
    senderId: string,
    recipientId: string,
    nowSeconds: number,
  ): Promise<boolean>;
  /**
   * The GROUP-AWARE form of `hasQueuedCorrespondence`: has ANY of `writerKeys` (the peer's scope candidates — groupId +
   * member ULIDs) user-authored to ANY of `receiverPartitions` (the other
   * side's member ULIDs) within the establishment window? A bounded GetItem
   * walk over ≤(4×3) pair-ledger rows — never a Query, never a new stored
   * graph: it reads the same rows the quota already maintains, across every
   * key the correspondence may have been billed under, which is exactly why
   * linking a device does not reset an established pair to stranger. The
   * legacy single-key call is the (writerKeys=[w], receiverPartitions=[r])
   * degenerate case; callers without group context keep using it.
   */
  hasQueuedCorrespondenceAny(
    writerKeys: readonly string[],
    receiverPartitions: readonly string[],
    nowSeconds: number,
  ): Promise<boolean>;
  /**
   * Write the directed consent edge (userId -> agentId) under the
   * CONSENT_MAX_EDGES cap. One transaction: the edge row
   * (conditional on absence, so a re-consent never double-counts) and the
   * partition's `#count` control row (conditional on the cap, so two
   * concurrent writes cannot both pass — the adoptCrewMember precedent).
   *
   * THE CAP COUNTS PER GROUP since: a grouped
   * caller's slots are CONSENT_MAX_EDGES across the WHOLE device group —
   * otherwise a 3-device owner silently holds 3×16. The write resolves the
   * caller's group, sums every member's `#count`, and pins each count (plus
   * the group's epoch and the caller's membership) inside the transaction,
   * so a concurrent sibling write or roster change cancels the write instead
   * of slipping past the sum. A solo caller keeps the shipped per-partition
   * transaction byte-identical, plus one ConditionCheck on its own user row
   * (`attribute_not_exists(groupId)`) so a link committing mid-write cannot
   * strand an uncounted edge. NOT flag-gated: caps are enforcement, and a
   * kill switch must not multiply an existing group's slots (the
   * prekey-floor rule).
   *
   * 'written' on success, 'already' on the idempotent re-consent,
   * 'cap_reached' when the group (or solo partition) is out of slots,
   * 'contended' when a count/roster pin lost past the retry bound —
   * transient; the caller may retry. EVERY outcome maps to the
   * same uniform 204 at the route the distinction exists for the
   * operator log and the tests, never for the wire.
   *
   * `agentId` is any well-formed ULID — deliberately NOT validated against
   * the users table here or at the route: an edge to a nonexistent,
   * human-class, or since-revoked id is inert (the ws predicate re-reads
   * both live rows and fails closed on class), and never reading the target
   * is what makes the route's answer uniform in time as well as in bytes.
   */
  writeConsentEdge(userId: string, agentId: string, nowMs: number): Promise<'written' | 'already' | 'cap_reached' | 'contended'>;
  /**
   * Delete the edge and release its cap slot — revocation is deletion, and
   * the NEXT send is refused (`hasConsentEdge` reads strongly
   * consistent). Idempotent: deleting an absent edge releases nothing and
   * answers nothing. Deletion is never blocked by counter drift: when the
   * edge exists but the counter refuses (row gone, count already 0), the
   * edge is still deleted, alone — the deleteCrewMemberAndReleaseSlot rule,
   * because refusing the delete would be the widening direction.
   */
  deleteConsentEdge(userId: string, agentId: string): Promise<void>;
  /**
   * Does the directed edge (userId -> agentId) exist? A strongly consistent
   * point GetItem — the enforcement read at the ws send/inbox/typing arms,
   * and it MUST be strongly consistent: an eventually-consistent read after
   * a revoke would deliver a frame the edge no longer authorizes, and
   * "revocation = the next send is refused" is the intended semantic. Control
   * keys are refused (a `#count` probe is not an edge).
   */
  hasConsentEdge(userId: string, agentId: string): Promise<boolean>;
  /**
   * Drop every consent row in this human's partition — edges and the
   * `#count` control row — on account deletion (the purgeQueuedMessages
   * precedent: a destructive Query over the caller's OWN partition, the one
   * partition read this table ever takes). Edges POINTING AT a deleted
   * integration are deliberately not findable from here: that would need
   * the agentId index refuses to exist. They stay, inert (the arms
   * re-read both live rows), until their writers delete them.
   */
  purgeConsentEdges(userId: string): Promise<void>;

  // --- Optional account grouping (data model, no handlers) ---
  /**
   * The `group#<groupId>` row, strongly consistent — ≤3 members ⇒ one row,
   * one GetItem, no index. Undefined when the account never opted in or
   * the group dissolved: optionality is structural, not a setting.
   */
  getAccountGroup(groupId: string): Promise<AccountGroupRecord | undefined>;
  /**
   * The `feature#accounts` flag row: true ONLY for an
   * operator-written row with `enabled: true`. Absent = OFF (the shipped
   * default), malformed = OFF — the dark deploy fails closed, and one
   * operator delete is the kill switch. Strongly consistent: a kill
   * switch that lags its write is not a kill switch.
   */
  isAccountsFeatureEnabled(): Promise<boolean>;
  /**
   * The `feature#accounts-phone` flag row: the phone train's
   * dark gate and class kill switch, AND-ed with the master flag on every
   * ACP route and DOMINANT over the shared recovery completion path. Same
   * contract as the master read: true ONLY for an operator-written row with
   * `enabled: true`; absent = OFF (the shipped default), malformed = OFF;
   * strongly consistent, because a kill switch that lags its write is not a
   * kill switch. Deliberately NO write method (the master flag's rule).
   */
  isAccountsPhoneFeatureEnabled(): Promise<boolean>;
  /**
   * The `feature#accounts-username` flag row: the username class's dark gate and kill switch, AND-ed with the
   * master flag on every username route. Same contract as the master read:
   * true ONLY for an operator-written row with `enabled: true`; absent =
   * OFF (the shipped default), malformed = OFF; strongly consistent. This
   * row is ALSO the K_id rotation-window brake (mixed-fleet pin):
   * the operator deletes it for the rollout and restores it after fleet
   * convergence. Deliberately NO write method.
   */
  isAccountsUsernameFeatureEnabled(): Promise<boolean>;
  /**
   * Write a pending link offer (written by the auth Lambda
   * AFTER verifying A's signature). ONE transaction: the offer row
   * plus the nonce added to both named users' `linkOfferNonces` reverse
   * sets, so the deletion sweep can find every offer naming a member
   * without a scan or index. 'exists' when
   * the nonce is already claimed: a nonce is single-mint as well as
   * single-use, and the loser must never overwrite the winner's tuple.
   * 'unknown_member' when either named user row is missing — refused so the
   * pointer write can never mint a ghost user row. Throws on a malformed
   * tuple (first-link without offererClass, class self-collision,
   * self-link) — those are programming errors at the caller, not refusable
   * states.
   */
  putLinkOffer(rec: LinkOfferRecord): Promise<'created' | 'exists' | 'unknown_member'>;
  /**
   * Write the INIT-leg row for a ceremony: the tuple the
   * server minted for A to sign, recorded before any signature exists. The
   * SAME one-transaction shape as `putLinkOffer` — init row plus the nonce
   * ADDed to both named users' `linkOfferNonces` reverse sets (the ADD is
   * idempotent, so the later promote re-asserting the same nonce costs
   * nothing) — because an init row carries the same ULIDs an offer row does
   * and owes the sweep the same findability.
   */
  putLinkOfferInit(rec: LinkOfferInitRecord): Promise<'created' | 'exists' | 'unknown_member'>;
  /**
   * The pending init row for exactly this nonce, or undefined when absent OR
   * past its explicit `expiresAt` (TTL reaping is never the enforcement).
   */
  getLinkOfferInit(offerNonce: string, nowSeconds: number): Promise<LinkOfferInitRecord | undefined>;
  /**
   * Promote a verified init row into the pending-offer row — called by the
   * auth Lambda AFTER verifying A's signature over the recorded tuple, and
   * ONLY then (no offer row exists before the signature
   * verifies). ONE transaction: conditional delete of the init row (kind +
   * unexpired — single-use, the challenge-row consume) plus the offer-row
   * Put under `attribute_not_exists`. 'gone' when the init row was already
   * consumed, expired, or never existed — the collapsed refusal upstream.
   */
  promoteLinkOfferInit(
    offerNonce: string,
    offerSig: string,
    nowSeconds: number,
  ): Promise<'promoted' | 'gone'>;
  /**
   * Is this user row revoked-with-tombstone ? Strongly consistent and
   * projection-thin: this is the READ-TIME ENFORCEMENT bearer-session
   * validation runs on every authenticated request (the
   * roster/tombstone transaction is the enforcement; session teardown is
   * cleanup a crash may have skipped), so it must see a commit the moment it
   * lands, and it must stay cheap. False for a missing row: absence is the
   * deleted-account path, refused elsewhere on its own terms.
   */
  isUserTombstoned(userId: string): Promise<boolean>;
  /**
   * The pending offer for exactly this nonce, or undefined when absent OR
   * expired — the explicit `expiresAt` decides, not the TTL reaper (the
   * pair-ledger discipline).
   */
  getLinkOffer(offerNonce: string, nowSeconds: number): Promise<LinkOfferRecord | undefined>;
  /**
   * The step-7 link TransactWrite. ONE transaction: group row
   * create-or-update under the class-slot condition, the epoch condition,
   * and the ≤3-member cap condition; `groupId` stamped on the joiner (and,
   * first link, the offerer) under `attribute_not_exists(groupId)`; the
   * offer row consumed by conditional delete. The conditions are the
   * authorization — a lost race is a refusal, never a precheck bypass — and
   * every refusal is distinct (see LinkDeviceResult).
   * The signed tuple comes from the OFFER ROW, not the caller, so a replayed
   * nonce cannot smuggle different parameters.
   */
  linkDeviceToGroup(input: {
    offerNonce: string;
    /** ULID_B's op="accept" identity signature, verified by the auth Lambda
     * before this call stored as the joiner's cert material. */
    acceptSig: string;
    nowSeconds: number;
    linkedAtMs: number;
  }): Promise<LinkDeviceResult>;
  /**
   * Amicable unlink: remove the member entry AND clear the user
   * row's `groupId` in one transaction under the epoch + acting-membership
   * ConditionExpressions — the acting member is bound INSIDE the transaction
   * via `contains(memberIds,:actor)`, never by the precheck alone
   *. The last member's departure deletes
   * the group row AND every identifier claim row its `identifierRefs`
   * reverse list names, in the same transaction, conditioned on the list
   * not having moved —: only the last member's exit takes
   * the identifiers with it. The device continues as a standalone anonymous
   * account — which it always was. Session/socket/push teardown is the cleanup, not this record.
   */
  unlinkDeviceFromGroup(input: RosterMutationInput): Promise<UnlinkDeviceResult>;
  /**
   * Revoke-lost/stolen: the unlink shape PLUS the enforcement
   * record — the victim's user row tombstoned with a `formerGroupId`
   * forwarding hint, and its idkey claim row tombstoned so the key never
   * re-auths (403 identity_tombstoned at the auth path). The transaction IS
   * the enforcement; teardown is idempotent cleanup re-driven by retry
   *.
   *
   * `agents` (binding fate): the victim's OWN integration-class
   * accounts — ownership verified by the handler before this call — each with
   * its USER row AND its idkey claim row tombstoned in the SAME transaction as
   * the roster removal, so a stolen or dead device never keeps agent reach,
   * and the record (not the teardown) is the enforcement for agents too. The caller supplies them because the
   * server deliberately cannot enumerate an owner's integrations (no index,
   * ever; the sibling-synced client roster is the enumeration).
   */
  revokeDeviceFromGroup(
    input: RosterMutationInput & { agents?: readonly AgentBinding[] },
  ): Promise<RevokeDeviceResult>;
  /**
   * THE MEMBER-DELETION TRANSACTION: the amicable-unlink roster
   * removal FUSED with the guarded user-row delete and the idkey-claim
   * delete — ONE TransactWrite, so account deletion of a grouped member
   * cannot half-happen: either the roster loses the member AND the row (and
   * claim) go, or nothing moves. The crew backstop
   * (`attribute_not_exists(crewCount) OR crewCount = 0`) rides the row's
   * own Delete condition, so an adopt racing the handler's read-time check
   * cancels the WHOLE transaction — a `crew_not_empty` refusal has
   * destroyed nothing, roster included. The LAST member's exit additionally
   * takes the group row, every identifier claim the `identifierRefs`
   * reverse list names (whatever key versions they carry — the list holds
   * full versioned keys, so the walk is version-complete by construction),
   * and the pending `recovery#` row; the recovering device's non-
   * authoritative `recoveryGroupId` pointer is cleared post-commit as
   * best-effort cleanup (the stale-pointer class). Tombstoned idkey claims
   * survive, exactly as `deleteUser`'s conditional does. Epoch is read and
   * pinned internally with the bounded roster retry. NO signed notice fans
   * out: deletion is bearer-authorized (there is no identity key server-side
   * to sign a memberUnlinked notice, and clients drop unsigned member*
   * notices BY DESIGN); survivors converge on the served
   * rosterVersion signals instead.
   */
  deleteGroupedUser(
    userId: string,
    groupId: string,
    claims: { identityKeyPub?: string },
    /** The caller's clock — the LAST member's exit tombstones the
     * group's username rows with `freesAt` from it (`RosterMutationInput.nowMs`
     * carries the same rule and the same fallback). */
    nowMs?: number,
  ): Promise<DeleteGroupedUserResult>;
  /**
   * the offer-row sweep half: delete the pending `linkoffer#` AND
   * `linkinit#` rows for each nonce the deleted member's `linkOfferNonces`
   * reverse set names — a GetItem-free unconditional Delete per key, never
   * a Query (the reverse-pointer discipline, consumed here). A dead
   * nonce deletes nothing; the counterparty's own pointer to it becomes the
   * stated tolerated residue and dies with that row. Idempotent; the
   * crash-retry path after the row delete is hintless and leaves merely-
   * expired rows to the sessions-table TTL backstop (explicit expiry
   * already refuses them at every read).
   */
  purgeLinkOffersForUser(offerNonces: readonly string[]): Promise<void>;
  /**
   * Tombstone a set of the victim's bound agents OUTSIDE the roster
   * transaction — the idempotent-completion path of a revoke,
   * where the roster/tombstone TransactWrite already committed but named none
   * of these agents (the first revoke call omitted them; the retry supplies
   * them). Each agent's USER row and idkey claim row are tombstoned under
   * `attribute_exists`, so the write is idempotent and a vanished agent
   * classifies as a retryable `binding_conflict`, never a partial revoke. On
   * the NORMAL path the roster transaction tombstones the agents in-band; this
   * exists only for the retry that names agents the committed call did not.
   */
  tombstoneAgentBindings(agents: readonly AgentBinding[]): Promise<'done' | 'binding_conflict'>;

  // --- Email linking + recovery ---
  /** Write (replace) the caller's pending verification-code row — one row per
   * requesting device, priced upstream by the resend cool-down + send
   * budgets. Never stores an identifier: the row carries claim KEYS only. */
  putEmailCode(rec: EmailCodeRecord): Promise<void>;
  /**
   * Consume ONE validation attempt and return the row, atomically: the
   * conditional increment (`attempts < cap AND expiresAt > :now`) IS the
   * attempt-cap enforcement, so concurrent guesses cannot share an attempt —
   * and an expired-but-unreaped row refuses HERE, by the clock, never by the
   * TTL reaper. `undefined` for absent, expired, or cap-exhausted alike (one
   * collapsed answer upstream).
   */
  takeEmailCodeAttempt(
    userId: string,
    purpose: EmailCodeRecord['purpose'],
    nowSeconds: number,
  ): Promise<EmailCodeRecord | undefined>;
  /** Sweep half: delete the caller's pending code row for ONE purpose,
   * unconditionally and idempotently (the deletion-sweep shape). Attach and
   * recovery codes occupy SEPARATE per-(caller, purpose) slots so a recovery
   * request can never clobber the caller's own pending attach row — the
   * registered-vs-not oracle that clobber opened. */
  deleteEmailCode(userId: string, purpose: EmailCodeRecord['purpose']): Promise<void>;
  /** The claim row for a handler-derived versioned claim key — strongly
   * consistent GetItem, the identifier→group resolution (≤2 calls inside
   * a rotation window, zero Queries). */
  getIdentifierClaim(claimKey: string): Promise<IdentifierClaimRecord | undefined>;
  /** OPPORTUNISTIC FORWARD-MIGRATION (rotation window): a claim that
   * resolved under a RETIRING key version is re-written under the newest
   * version — new claim row born, the group's `identifierRef` re-pointed, the
   * old row deleted, ONE TransactWrite under the group's `identifierRefs`
   * snapshot. Best-effort: a racing writer (unlink, a concurrent migration)
   * leaves the old row for the next resolution, never a partial commit. NOOP
   * in v1 (one version), so this only fires once a second version is wired.
   * CLASS-BLIND at the site, class-aware here: a username claim
   * carries its skeleton row (`claim.skeletonKey`), and the skeleton is
   * versioned with the namespace — so the caller supplies the
   * newest-version skeleton key and the SAME transaction moves both rows
   * (new skeleton born once, old skeleton deleted under its claim pin). A
   * username claim migrated without `newSkeletonKey` is a programming error
   * that throws: a name whose skeleton row silently stayed behind on a
   * retiring version would be squattable the day that version retires. */
  migrateIdentifierClaimForward(input: {
    oldClaimKey: string;
    newClaimKey: string;
    claim: IdentifierClaimRecord;
    newSkeletonKey?: string;
  }): Promise<'migrated' | 'noop'>;
  /** True when a LIVE suppression shadow row exists for this ref: the
   * send path skips the vendor for a suppressed ref, uniformly and silently.
   * Class-general — the key's prefix (emailsupp#/phonesupp#) is
   * the class, and each class's rows carry their own `kind`. The explicit
   * `expiresAt` decides: an elapsed shadow answers false AND is
   * physically deleted at this read — the users table has no TTL attribute,
   * so the refusing/absolving read IS the reaper. A previous row without
   * the attribute reads as elapsed (none can exist in a deployed store: the
   * class shipped dark behind the default-OFF flag), and the vendor's own
   * durable suppression (SES account-level; carrier/AWS STOP lists) remains
   * the authority either way. */
  isIdentifierSuppressed(suppressionKey: string, nowSeconds: number): Promise<boolean>;
  /**
   * The still-LIVE recovery cool-down for an identifier, read from the
   * identifier-keyed shadow rows across every active claim-key version
   * (class-general — each claim key maps to
   * its OWN class's shadow via `cooldownKeyFromClaimKey`, so phonecool#
   * carries the second class from day one): the max `discoverableAfter` strictly in the
   * future, or undefined when none is armed. Consumed by the attach leg so
   * a re-minted claim — same group, new solo group, or a brand-new account
   * is born already carrying the cool-down the recovery armed. ≤2
   * strongly consistent GetItems, zero Queries (the walk shape). An
   * ELAPSED shadow is inert by its own clock (unchanged) and,
   * physically deleted by this walk — the read is the reaper on the
   * TTL-less users table.
   */
  getIdentifierRecoveryCooldown(
    claimKeys: readonly string[],
    nowSeconds: number,
  ): Promise<number | undefined>;
  /** Record a suppression (the vendor's hard SYNCHRONOUS rejection — SES
   * MessageRejected, or the SMS opted-out refusal; never an async pipe),
   * keyed by the HMAC ref — never the identifier. Class-general from
   * (the key's prefix is the class). Idempotent replace, stamped with the
   * pinned explicit expiry (the shared 90-day release pin): the
   * shadow is a cache of the vendor's synchronous answer, and the reading
   * walk reaps it once elapsed, so nothing in this class joins the
   * unreaped-forever bucket. */
  putIdentifierSuppression(suppressionKey: string, nowMs: number): Promise<void>;
  /**
   * THE ATTACH TRANSACTION (per-CLASS from): claim row born
   * (attribute_not_exists — one group per identifier), the group row takes
   * the identifierRef under the PER-CLASS one-slot cap — the CLASS half is
   * the HANDLER's class check over the snapshot COMPOSED with the
   * `identifierRefs =:refsSnapshot` transaction CAS (one read feeds both,
   * so a racing same-class attach loses atomically while the other class's
   * standing ref survives untouched; a `size` cap cannot see class
   * prefixes, so the transaction ALONE does not enforce the class half —
   * stated plainly) — PLUS the storage layer's own
   * `size(identifierRefs) < MAX_VERIFIED_IDENTIFIERS_PER_GROUP` backstop,
   * which bounds total growth for ANY
   * caller-supplied snapshot — the code row is consumed single-use, and —
   * for a solo caller — the group row is lazily CREATED with the declared
   * class (there is no classless member state) under the caller's own
   * `attribute_not_exists(groupId)` pristineness condition. Class-general:
   * the claim key's prefix IS the class (emailhash# / phonehash#), and the
   * single-class email case behaves exactly as the landed transaction did.
   */
  attachIdentifier(input: {
    userId: string;
    deviceClass: DeviceClass;
    /** The caller's current groupId, or undefined for the lazy solo path. */
    existingGroupId?: string;
    /** Server-minted name for the lazy solo group (unused when grouped). */
    newGroupId: string;
    /** The versioned claim key to write (newest active version). */
    claimKey: string;
    /** The group's identifierRefs as the handler read them (existing-group
     * branch only; the handler already refused if a ref of THIS class was
     * present). The transaction conditions on exact equality — the per-class
     * cap's atomic arm. Ignored on the lazy solo path. */
    refsSnapshot?: readonly string[];
    /** Every OLDER active-version claim key for the same identifier:
     * each is condition-checked ABSENT in the same
     * transaction, so "one group per identifier, ever" holds across the
     * whole rotation window — a retiring-version claim held by another
     * group refuses this attach instead of being shadowed by a
     * newest-version duplicate. Empty outside a rotation window. */
    retiringClaimKeys?: readonly string[];
    nowMs: number;
    /** The still-live recovery cool-down carried onto the fresh claim (the re-arm rule: a re-minted claim may not shed a cool-down the
     * recovery armed). The handler takes the max of the group-row carrier
     * and the identifier-keyed shadow (`getIdentifierRecoveryCooldown`). Absent =
     * no cool-down carries. */
    discoverableAfter?: number;
  }): Promise<EmailAttachResult>;
  /**
   * Unlink ONE CLASS's identifier claim(s) — per-class inside the
   * transaction (the landed
   * whole-list email unlink is the `claimKeys === refsSnapshot` case and
   * behaves identically): the class's claim rows deleted (their `groupId`
   * pinned in the condition), the group row's `identifierRefs` set to the
   * snapshot MINUS exactly those keys under the UNCHANGED full-snapshot
   * condition, the caller's membership enforced in-transaction
   * (`contains(memberIds,:caller)`). The OTHER class's claim, its consent
   * (it lives ON the claim row), and its ref survive by construction:
   * the Deletes take only the named keys and the Update writes the exact
   * remainder. THE LAZY-SOLO REAP fires ONLY when the
   * remainder is EMPTY and the group is a still-unmutated attach-created
   * solo group (`attachCreated` present, epoch still 1, the caller its sole
   * founding member): the same transaction deletes the group row, clears
   * the founder's `groupId`, and reaps any pending `recovery#` row,
   * returning the account to never-opted-in exactly. A ceremony-linked
   * group (epoch moved, or no marker) keeps today's behavior: members
   * dissolve deliberately.
   */
  unlinkIdentifierClass(input: {
    userId: string;
    groupId: string;
    /** The group's FULL identifierRefs as the handler read them — the
     * unchanged snapshot the transaction conditions on. */
    refsSnapshot: readonly string[];
    /** The refs to remove: the CLASS's own claim keys, prefix-filtered from
     * the snapshot by the handler (every active version). Must be a subset
     * of `refsSnapshot`. */
    claimKeys: readonly string[];
  }): Promise<EmailUnlinkResult>;
  /** Owner-written discovery consent on the claim row (wires the
   * route, lands the write so the cool-down rule is drivable). The
   * `groupId` pin keeps a stale caller from toggling a re-claimed key, and
   * the acting caller's CURRENT membership is bound in-transaction via a
   * `contains(memberIds,:actor)` ConditionCheck on the group row (the discipline:
   * the handler's snapshot reads are
   * UX, this condition is the authorization, so a member removed after the
   * handler read, or seen through a stale user-row read, cannot toggle the
   * surviving group's discoverability). */
  setIdentifierDiscoverable(
    claimKey: string,
    groupId: string,
    actingUserId: string,
    discoverable: boolean,
  ): Promise<'set' | 'gone'>;

  // --- Username claims (data layer; the
  // routes land in the same phase behind `feature#accounts-username`) ---
  /**
   * The username class's OWN read — the exact-name row, tombstone-aware and
   * tombstone-REAPING (the suppression-shadow rule: the users table has no
   * TTL attribute, so the lookup-facing read is the reaper). A live claim
   * answers as `getIdentifierClaim` would; a tombstone still inside its
   * window answers the tombstone record (the lookup's read-time rule
   * refuses it as non-consented, identical work into the single exit); an
   * ELAPSED tombstone answers `undefined` AND is physically deleted at this
   * read, its skeleton tombstone with it (each under a condition that takes
   * only a still-elapsed tombstone, so a concurrent re-claim's fresh live
   * row is never collateral). Strongly consistent, one GetItem per version
   * (the caller walks `activeUsernameClaimKeys`), zero Queries.
   */
  getUsernameClaim(
    claimKey: string,
    nowSeconds: number,
  ): Promise<IdentifierClaimRecord | UsernameTombstoneRecord | undefined>;
  /**
   * THE CLAIM TRANSACTION (tombstone-corrected): ONE TransactWrite —
   * the exact-name row AND the skeleton row Put under the NEWEST key version,
   * each under THE SAME tombstone-aware condition (`attribute_not_exists OR
   * (tombstoned AND (freesAt <= now OR formerGroupId = caller))`), a
   * ConditionCheck with that SAME expression on every RETIRING-version
   * candidate of both rows (uniqueness across the whole rotation window —
   * and a former owner's reclaim survives a tombstone sitting on a retiring
   * version, the corrected spelling), the group row's refs CAS + the
   * per-class one-slot cap (structural: a snapshot already holding a
   * username ref refuses before the transaction, and the `size` backstop
   * rides the Update), and the caller's live-human membership pinned
   * in-transaction. The consent bit is the request's EXPLICIT `discoverable`
   * (the wire always carries it; the row's structural default stays
   * OFF, so only this write ever sets it ON at birth). `discoverableAfter`
   * is the group-row recovery cool-down carrier the handler re-arms from
   * (the attach lane's rule, identical). No lazy-solo branch: gates
   * a claim on a verified possession-proof identifier, so the claimant is
   * grouped by construction. THE COOL-DOWN RIDES THE CLAIM TOO (the
   * anti-hoarding rule): the group Update carries the same
   * `usernameRenamedAt` condition the rename does — unlink stamps it, so
   * unlink-then-claim-another is priced exactly as a rename — dropped only
   * when the handler's walk over every active version of the exact-name
   * row found this group's OWN live tombstone (`reclaimingOwn`: the
   * former-owner reclaim of the SAME name stays free, on a retiring
   * version too, and the rows' tombstone-aware condition is what admits
   * it). A claim never stamps the cool-down: a first name is not a change
   * of name.
   */
  claimUsername(input: {
    userId: string;
    groupId: string;
    /** The group's identifierRefs as the handler read them — the CAS. */
    refsSnapshot: readonly string[];
    /** Newest-version `usernamehash#` key. */
    claimKey: string;
    /** Newest-version `nameskel#` key. */
    skeletonKey: string;
    /** Every OLDER active-version key of each row — condition-checked with
     * the tombstone-aware expression. Empty outside a rotation window. */
    retiringClaimKeys: readonly string[];
    retiringSkeletonKeys: readonly string[];
    discoverable: boolean;
    discoverableAfter?: number;
    /** True when the handler's pre-read found the caller's own live
     * tombstone at `claimKey` or at one of `retiringClaimKeys`: the
     * cool-down clause is dropped. */
    reclaimingOwn?: boolean;
    nowMs: number;
  }): Promise<UsernameClaimResult>;
  /**
   * THE FIVE-ITEM RENAME: ONE TransactWrite, no item touched twice —
   * (1) Put-OVERWRITE the old claim key with its tombstone (formerGroupId =
   * this group, freesAt = now + 30d), (2) Put-overwrite the old skeleton
   * key likewise, (3) conditional Put of the new claim key and (4) of the
   * new skeleton key under the tombstone-aware condition, (5) the group
   * Update re-pointing the ref under the refs CAS AND the `usernameRenamedAt`
   * cool-down condition (absent OR <= now - 30d), stamping the new
   * `usernameRenamedAt` — so the cool-down is consumed on SUCCESS only. Plus
   * the caller pin and the retiring-version ConditionChecks (minus the old
   * rows themselves, which items 1-2 already own). When the new name's
   * skeleton equals the old one (`alice` → `al1ce`), item 2 becomes a
   * re-point of the one skeleton row and item 4 is dropped — never a
   * tombstone and a Put on one item. A new name that IS the held name (under
   * any active version) answers `same_name` without a transaction. The
   * recovery cool-down (`discoverableAfter`) is carried from the old row.
   */
  renameUsername(input: {
    userId: string;
    groupId: string;
    refsSnapshot: readonly string[];
    /** The held `usernamehash#` ref (from the snapshot). */
    oldClaimKey: string;
    /** The new name's candidate keys, NEWEST FIRST, every active version
     * (the `same_name` check walks all of them). Index 0 is written. */
    claimKeys: readonly string[];
    /** The new skeleton's candidate keys, newest first. Index 0 is written. */
    skeletonKeys: readonly string[];
    discoverable: boolean;
    nowMs: number;
  }): Promise<UsernameRenameResult>;
  /**
   * The per-class unlink for the username class: the
   * `unlinkIdentifierClass` shape exactly — refs shrink under the unchanged
   * full-snapshot CAS, membership in-transaction, the lazy-solo reap on an
   * empty remainder — except the class's rows are TOMBSTONED (Put-overwrite,
   * 30-day former-owner window) rather than deleted: the name stays held
   * against strangers and reclaimable by this group. The surviving group
   * row is STAMPED `usernameRenamedAt = now` in the same Update (the
   * anti-hoarding rule): an unlink is a name change, so the next claim of
   * a DIFFERENT name waits out the rename cool-down while the reclaim of
   * this same name stays free — without the stamp one group could loop
   * claim→unlink→claim and hold a fresh former-owner tombstone per attempt.
   * When the unlink DISSOLVES the group (the lazy-solo reap) the tombstone
   * carries no `formerGroupId` (the group that could reclaim no longer
   * exists, and a dangling group id must not outlive its row) and there is
   * no group row left to stamp.
   */
  unlinkUsername(input: {
    userId: string;
    groupId: string;
    refsSnapshot: readonly string[];
    /** The held `usernamehash#` ref (from the snapshot). */
    claimKey: string;
    nowMs: number;
  }): Promise<EmailUnlinkResult>;
  /**
   * OPERATOR REVOCATION, the data primitive (the ops lane — NO HTTP
   * route ever calls this): ONE TransactWrite tombstoning the claim row AND
   * its skeleton row with `formerGroupId` UNSET (the revoked holder never
   * reclaims early; the name frees for everyone at now + 30d) and shrinking
   * the holder's group refs under the CAS, so the slot reopens and no live
   * ref names a dead row. Detaches the NAME only — account, messages,
   * other identifiers, consent untouched; nothing is transferred and the
   * holder is not identified in the answer beyond the groupId the ops lane
   * fans the `usernameRevoked` notice to (handlers/username.ts
   * `notifyUsernameRevoked`, AFTER this commit — best-effort, armed only
   * after fleet coverage).
   */
  revokeUsername(input: { claimKey: string; nowMs: number }): Promise<UsernameRevokeResult>;
  /**
   * Born at recovery-verify: the pending row (attribute_not_exists — one
   * pending recovery per group) PLUS the recovering device's reverse pointer
   * (`recoveryGroupId`, written under its own pristineness condition so a
   * grouped device can never hold a pending recovery).
   */
  putRecoveryPending(rec: RecoveryPendingRecord): Promise<RecoveryCreateResult>;
  /** Strongly consistent read of the pending row. Expiry is NOT applied here:
   * the completion transaction enforces its own clock conditions, and a
   * cancel must land even on a row mid-completion. */
  getRecoveryPending(groupId: string): Promise<RecoveryPendingRecord | undefined>;
  /**
   * THE CANCEL, and it WINS: sets `canceled` on the pending row —
   * conditioned only on existence and the row's own explicit expiry, so it
   * lands at ANY point inside (or after) the delay while the row is live;
   * completion's `attribute_not_exists(canceled)` condition means of a
   * racing cancel and completion exactly one commits. A cancelled row is
   * KEPT until its `expiresAt` (a late completion must meet the refusal,
   * never an absent row it might race); past it, the cancel-shaped read
   * REAPS the row physically (the users table has no TTL attribute)
   * and answers 'gone'.
   */
  cancelRecoveryPending(groupId: string, nowSeconds: number): Promise<'canceled' | 'gone'>;
  /**
   * THE COMPLETION TRANSACTION: the link transaction with the recovery
   * guards. ONE TransactWrite: pending-row consume (conditioned on
   * `newUserId = caller AND completesAt <= now AND attribute_not_exists(
   * canceled)` — delay and cancel are CONDITIONS, never advisory), group row
   * epoch-pinned member replace/append (the incumbent case is the
   * replace shape: tombstone incumbent + its idkey claim + attach the new
   * member, one transaction), the new device's `groupId` under its
   * pristineness condition, and `discoverableAfter` stamped on every claim
   * row AND the group row (the 7-day cool-down as schema, the group-row
   * copy is the carrier that survives an unlink so a re-minted claim
   * re-arms).
   */
  completeRecovery(input: {
    groupId: string;
    newUserId: string;
    nowSeconds: number;
    linkedAtMs: number;
    /** Unix seconds the claim rows regain discoverability (now + cool-down). */
    discoverableAfter: number;
  }): Promise<
    | { outcome: Exclude<RecoveryCompleteResult, 'completed'> }
    | {
        outcome: 'completed';
        deviceClass: DeviceClass;
        rosterEpoch: number;
        /** The replaced incumbent (tombstoned in this transaction), if the
         * declared slot was occupied — the caller owes it teardown. */
        incumbent?: { userId: string; identityKeyPub: string };
        survivors: string[];
      }
  >;
  /**
   * The per-account slice of the deletion sweep:
   * the deleted account's pending code row, its pending recovery (as the
   * RECOVERING device — found via the `recoveryGroupId` reverse pointer), and
   * when it was the SOLE member of a solo group — the group row, its claim
   * rows, and any pending recovery against it, so the attach-created row
   * classes never join the unreaped-forever class. Idempotent;
   * multi-member groups keep per-member semantics.
   */
  purgeIdentifierArtifactsForUser(
    userId: string,
    hints: { groupId?: string; recoveryGroupId?: string },
    /** The caller's clock: a sole-member solo group's username rows
     * are tombstoned, `freesAt` stamped from it (the roster-input rule and
     * fallback). */
    nowMs?: number,
  ): Promise<void>;
}

/**
 * The SHA-256 digest (hex) of a bearer token — what the sessions table is
 * keyed by, so the plaintext is never persisted. Exported because the
 * WebSocket ticket and connection rows carry this same digest to bind a socket
 * to its session: the ws-ticket handler computes it from the caller's
 * bearer, and the session-revoke handlers compute it to match the caller's own
 * socket. One definition, so the digest a socket stores and the digest a
 * revoke computes cannot drift.
 */
export function sessionTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Session lookup key: the token digest under its own `sess:` namespace,
 * disjoint from the claim and challenge prefixes below. */
const sessionKey = (token: string): string => `sess:${sessionTokenDigest(token)}`;
/** The same key built from a digest already in hand (recheck / socket row). */
const sessionKeyFromDigest = (digest: string): string => `sess:${digest}`;

/**
 * Synthetic users-table key claiming an identity key
 * It pins one account per key under concurrency
 * using a base-table conditional write, with NO index — an index on identity
 * keys would be exactly the enumeration primitive the deleted phone GSI was.
 *
 * ULIDs are Crockford base32 and never contain '#', so a claim key can never
 * collide with a real userId. Base64 keys may contain '+', '/' and '=', none of
 * which appear in a ULID either.
 */
export const IDKEY_CLAIM_PREFIX = 'idkey#';
const idkeyClaimKey = (identityKeyPub: string): string =>
  `${IDKEY_CLAIM_PREFIX}${identityKeyPub}`;

/**
 * Synthetic push-tokens-table key for one wake's ring claim.
 *
 * IT LIVES IN THE PUSH TOKENS TABLE ON PURPOSE, and nowhere else. The push
 * worker's role holds GetItem + UpdateItem on exactly that table already, no
 * write on the messages table, and — deliberately, pinned in the stack's
 * security test — no rate-bucket grant at all. Building this on either of
 * those would pass every local test (DynamoDB Local enforces no IAM) and
 * AccessDeny in production, failing CLOSED into a missed ring. So: zero infra
 * change, and the pinned IAM signature stays byte-identical.
 *
 * The row holds this key, `rang` and `expiresAt` — no userId, no sender, no
 * token. `expiresAt` is already that table's TTL attribute, so claims
 * self-reap; the '#' cannot collide with a ULID userId (Crockford base32 has
 * no '#'), and nothing anywhere Scans this table.
 */
export const WAKE_CLAIM_PREFIX = 'wake#';
const wakeKey = (wakeId: string): string => `${WAKE_CLAIM_PREFIX}${wakeId}`;

/**
 * Synthetic users-table key claiming a phone number. NOTHING WRITES THIS ANY
 * MORE — the phone path is gone — but rows written
 * by it are still sitting in the deployed users table, which is RETAIN and was
 * never purged.
 *
 * KEPT ON PURPOSE, as a guard over that residue. The reason the guard existed
 * has NOT gone away with the feature: a `phone#<E.164>` row still resolves as a
 * users-table item, so dropping it from the refusal set below would make every
 * surviving legacy claim addressable — `GET /v1/keys/phone#+1555…` and WS
 * `send.to` would answer 200-vs-404 as a registered-phone oracle over the old
 * user base, and the send path would queue ciphertext to a recipientId nothing
 * ever drains.
 *
 * Delete this constant only after those rows are gone from every deployed
 * table, not merely after the last line of phone CODE was deleted. Named
 * "LEGACY" so it cannot be mistaken for a live identifier namespace.
 */
const LEGACY_PHONE_CLAIM_PREFIX = 'phone#';

/**
 * Synthetic users-table key for one account group's row:
 * `group#<groupId>`, written ONLY by the link/unlink/revoke transactions.
 * The users table on purpose — the group row is durable account state with
 * no TTL, and a new table would buy nothing but a second IAM surface. The
 * '#' keeps it collision-free with real ULIDs (Crockford base32 has no '#'),
 * and CLAIM_PREFIXES below keeps it unaddressable as a user.
 */
export const GROUP_ROW_PREFIX = 'group#';
export const groupRowKey = (groupId: string): string => `${GROUP_ROW_PREFIX}${groupId}`;

/**
 * Operator-written feature-flag rows: `feature#accounts`
 * gates EVERY route the accounts program adds and every group-aware behavior
 * it lays over existing routes. ABSENT = OFF — the shipped default — and
 * deleting the row is the kill switch, so there is deliberately NO
 * DataLayer write method for it: one operator console write, never a code
 * path.
 */
export const FEATURE_FLAG_PREFIX = 'feature#';
export const ACCOUNTS_FEATURE_FLAG_KEY = `${FEATURE_FLAG_PREFIX}accounts`;
/**
 * The phone train's own dark gate and class kill switch: `feature#accounts-phone`, operator-written, ABSENT =
 * OFF, AND-ed with `feature#accounts` on every ACP route — the master flag
 * kills everything, this one keeps the phone train dark inside a LIVE
 * email-v1 deploy. DOMINANT over the shared recovery completion path: a
 * pending row born of a phone-class claim refuses completion while this row
 * is absent (the cancel leg stays master-flag-only — a surviving member's
 * safety-critical cancel lands even with the phone train dark). Same
 * no-write-method rule as the master flag: one operator console write, never
 * a code path.
 */
export const ACCOUNTS_PHONE_FEATURE_FLAG_KEY = `${FEATURE_FLAG_PREFIX}accounts-phone`;
/**
 * The username class's own dark gate and kill switch: `feature#accounts-username`, operator-written, ABSENT = OFF, AND-ed
 * with `feature#accounts` on every username route. Doubles as the K_id
 * rotation-window brake (mixed-fleet pin — deleted for the rollout,
 * restored after convergence). Same no-write-method
 * rule as the other flags: one operator console write, never a code path.
 */
export const ACCOUNTS_USERNAME_FEATURE_FLAG_KEY = `${FEATURE_FLAG_PREFIX}accounts-username`;

/**
 * Identifier claim rows (`emailhash#v<K>#<hmac>`),
 * their suppression shadow (`emailsupp#…`), and pending recovery rows
 * (`recovery#<groupId>`) all live in the users table and are NOT
 * addressable identities — the same row-existence-oracle / dead-letter-mint
 * refusal the group and flag prefixes carry. The claim-key HMAC derivation
 * itself lives in opaque-ref.ts (the one-module rule); this file only ever
 * receives finished keys.
 */
export const EMAIL_CLAIM_KEY_PREFIX = 'emailhash#';
export const EMAIL_SUPPRESSION_PREFIX = 'emailsupp#';
/** The ADDRESS-keyed recovery cool-down shadow:
 * `emailcool#v<K>#<hash>` — written by recovery completion beside the
 * claim/group stamps, read at attach, so DELETING the claim row (unlink,
 * dissolve, the last member's exit) and re-minting it under ANY group — the
 * original, a fresh solo group, a brand-new account — re-arms the cool-down
 * instead of shedding it. The cool-down follows the ADDRESS, not the group
 * or the device. Versioned with the claim namespace like the suppression
 * shadow, so a K_id rotation retires cool-down state together with the
 * claims it shadowed (the f15 coupling, accepted); physically reaped by
 * the sweep like the suppression rows (inert past its own clock — the
 * read applies the explicit `discoverableAfter` rule, never the reaper). */
export const EMAIL_COOLDOWN_PREFIX = 'emailcool#';
/** Pure prefix swap `emailhash#…` → `emailcool#…`: the shadow shares the
 * claim key's version+hash exactly, so the attach-time walk over the active
 * claim keys is also the walk over their shadows. Exported for the mirror
 * store and the suites. */
export const emailCooldownKeyFromClaimKey = (claimKey: string): string =>
  `${EMAIL_COOLDOWN_PREFIX}${claimKey.slice(EMAIL_CLAIM_KEY_PREFIX.length)}`;
/**
 * The phone claim class: `phonehash#v<K>#<hmac>` claim
 * rows under the SAME derived-subkey construction (opaque-ref.ts owns the
 * derivation and the disjointness argument), the `phonesupp#` vendor-refusal
 * shadow (synchronous refusals only: no DLR pipe exists to
 * feed it), and the `phonecool#` recovery cool-down shadow (the emailcool#
 * shape, so the re-attach shed stays closed for the second class from
 * day one). Same users-table-resident, never-a-user row discipline.
 */
export const PHONE_CLAIM_KEY_PREFIX = 'phonehash#';
export const PHONE_SUPPRESSION_PREFIX = 'phonesupp#';
export const PHONE_COOLDOWN_PREFIX = 'phonecool#';
/**
 * The username claim class (DARK: no route writes
 * or reads these yet): `usernamehash#v<K>#<hmac>` claim rows under the SAME
 * derived-subkey construction (opaque-ref.ts owns the derivation and the
 * three-way disjointness argument), plus the `nameskel#` confusable-skeleton
 * anti-squat row (the username class's SECOND claim row, never a
 * lookup class or a class of its own). Same users-table-resident,
 * never-a-user row discipline. Deliberately NO suppression and NO recovery
 * cool-down prefix for this class: a username is never a send target and
 * never a recovery proof (recovery-excluded absolutely), so neither
 * shadow can exist.
 */
export const USERNAME_CLAIM_KEY_PREFIX = 'usernamehash#';
export const NAMESKEL_CLAIM_KEY_PREFIX = 'nameskel#';
/** The phonecool# twin of the email prefix swap above. */
export const phoneCooldownKeyFromClaimKey = (claimKey: string): string =>
  `${PHONE_COOLDOWN_PREFIX}${claimKey.slice(PHONE_CLAIM_KEY_PREFIX.length)}`;
/** Class-aware cool-down shadow key for ANY claim key — the one mapping the
 * recovery completion and the attach-time walk share, so neither can pair a
 * phone claim with an email shadow. Throws on an unknown prefix: a
 * claim key outside the named classes is a programming error, never a
 * refusable state — and throws BY NAME for the username class which
 * is known and deliberately shadowless (recovery-excluded). */
export function cooldownKeyFromClaimKey(claimKey: string): string {
  if (claimKey.startsWith(EMAIL_CLAIM_KEY_PREFIX)) return emailCooldownKeyFromClaimKey(claimKey);
  if (claimKey.startsWith(PHONE_CLAIM_KEY_PREFIX)) return phoneCooldownKeyFromClaimKey(claimKey);
  // The username class is KNOWN here and deliberately SHADOWLESS:
  // no recovery ever completes off a username
  // claim, so no usernamecool# row class exists to map to. Taught by name so
  // the generic throw below keeps its meaning — it fires ONLY for a prefix
  // outside every named class, never misreporting a known class as unknown.
  if (
    claimKey.startsWith(USERNAME_CLAIM_KEY_PREFIX) ||
    claimKey.startsWith(NAMESKEL_CLAIM_KEY_PREFIX)
  ) {
    throw new Error(
      'cooldown shadow: username claims are recovery-excluded and bear no cool-down shadow',
    );
  }
  throw new Error('cooldown shadow: claim key outside the named identifier classes');
}
/** The identifier class a claim key belongs to, read off its PREFIX — the
 * ONE derivation `putRecoveryPending` records at birth
 * (claim-prefix-derived, never client-asserted). The username
 * class joined with BOTH its prefixes reading 'username' — the nameskel#
 * skeleton row is that class's second claim row never a class of
 * its own — and a username-class answer can never reach a recovery row
 * (recovery wires refuse the key .strict; recovery birth narrows and
 * throws, see `recoveryIdentifierClassForClaimKey` below). */
export function identifierClassForClaimKey(claimKey: string): 'email' | 'phone' | 'username' {
  if (claimKey.startsWith(PHONE_CLAIM_KEY_PREFIX)) return 'phone';
  if (claimKey.startsWith(EMAIL_CLAIM_KEY_PREFIX)) return 'email';
  if (
    claimKey.startsWith(USERNAME_CLAIM_KEY_PREFIX) ||
    claimKey.startsWith(NAMESKEL_CLAIM_KEY_PREFIX)
  ) {
    return 'username';
  }
  throw new Error('identifier class: claim key outside the named identifier classes');
}
/** The recovery-lane narrowing of the class read: a recovery row's
 * class is 'email' | 'phone' FOREVER — a handle possesses nothing
 * (the recovery exclusion) — so a username-class claim
 * key reaching recovery birth is a programming error that 500s, exactly as
 * an untaught prefix would, never a recordable state. */
export function recoveryIdentifierClassForClaimKey(claimKey: string): 'email' | 'phone' {
  const identifierClass = identifierClassForClaimKey(claimKey);
  if (identifierClass === 'username') {
    throw new Error('recovery: username claims are recovery-excluded and never prove a code');
  }
  return identifierClass;
}
/** The completion walk's form of the shadow mapping: the
 * cool-down shadow to arm for a claim key a GROUP holds — or null for the
 * username class, which bears none. The cross-class walk maps EVERY
 * ref on the group, so a group that also holds a username claim
 * must still complete an email- or phone-proved recovery: the
 * shadowless class is FILTERED here, never thrown on — a throw would brick
 * recovery for everyone holding a handle. The generic unknown-prefix throw
 * survives underneath (the class read fires it first). */
export function cooldownShadowKeyForClaimKey(claimKey: string): string | null {
  if (identifierClassForClaimKey(claimKey) === 'username') return null;
  return cooldownKeyFromClaimKey(claimKey);
}
/** The claim-key prefix an ATTACH classifies its per-class slot by:
 * exhaustive over the possession-proof classes, and a throw BY NAME for
 * the username class — a handle is claimed through its own transaction
 * never through the code-proved attach lane, so a username key
 * reaching this classification is a programming error, exactly as an
 * untaught prefix would be. Never a silent fall-through to email. */
export function attachClassPrefixForClaimKey(claimKey: string): string {
  const identifierClass = identifierClassForClaimKey(claimKey);
  switch (identifierClass) {
    case 'phone':
      return PHONE_CLAIM_KEY_PREFIX;
    case 'email':
      return EMAIL_CLAIM_KEY_PREFIX;
    case 'username':
      throw new Error('attach: username claims never attach through the possession-proof lane');
  }
}
/** Per-class row `kind` attributes for the suppression and cool-down
 * shadows: the key prefix decides, so a phone shadow can never satisfy an
 * email-kind condition (and deployed email rows keep their landed kind). */
const suppressionKindForKey = (suppressionKey: string): string =>
  suppressionKey.startsWith(PHONE_SUPPRESSION_PREFIX) ? 'phoneSuppression' : 'emailSuppression';
const cooldownKindForKey = (cooldownKey: string): string =>
  cooldownKey.startsWith(PHONE_COOLDOWN_PREFIX) ? 'phoneCooldown' : 'emailCooldown';
export const RECOVERY_ROW_PREFIX = 'recovery#';
export const recoveryRowKey = (groupId: string): string => `${RECOVERY_ROW_PREFIX}${groupId}`;

/**
 * Synthetic consent-edges-table SORT key for one human's edge counter
 * Lives in the SAME partition as the human's edges —
 * the cap transaction needs both rows, and the account-deletion purge
 * sweeps them together. A ULID never contains '#' (Crockford base32), and
 * the route additionally validates `agent` as a ULID, so no caller-supplied
 * agentId can ever address this row; `hasConsentEdge` refuses it as belt.
 */
export const CONSENT_COUNT_KEY = '#count';

/**
 * How many times a consent write/delete transaction re-attempts a pure
 * TransactionConflict before the honest throw (a remediation). Every
 * write and delete for one human serializes on the shared `#count` item, so
 * concurrent requests from one account collide as a matter of course; the
 * conflict is transient by construction (the collider has settled by the
 * time the exception surfaces) and one or two immediate re-attempts settle
 * it. Bounded, because retrying forever under sustained contention would
 * turn one hot account's traffic into an unbounded write amplifier.
 */
export const CONSENT_TXN_ATTEMPTS = 3;

/**
 * The same bounded re-attempt for the account-group roster transactions
 * (the .2 CONSENT_TXN_ATTEMPTS remediation, applied to
 * the same failure class): two concurrent TransactWriteItems touching the
 * same group/user rows can BOTH cancel with pure `TransactionConflict` — no
 * condition failed, nothing committed — and classifying that transient as a
 * refusal would be a lie ('offer_consumed' for a live offer). A pure
 * conflict re-attempts from a FRESH snapshot, so the loser of a real race
 * re-reads the committed state and refuses honestly; a conflict that
 * persists past the bound throws, never masquerading as a refusal.
 */
export const ROSTER_TXN_ATTEMPTS = 3;

/**
 * Every synthetic prefix that lives in the users table but is NOT an
 * addressable identity. `getUserById` refuses all of them.
 *
 * A SET rather than a single check, so adding a claim namespace cannot
 * accidentally ship without its guard: a caller-supplied `idkey#…` reaching
 * `GET /v1/keys/{userId}` or WS `send.to` would be an is-this-key-registered
 * oracle, and would enqueue ciphertext to a recipientId nothing ever drains.
 */
export const CLAIM_PREFIXES = [
  LEGACY_PHONE_CLAIM_PREFIX,
  IDKEY_CLAIM_PREFIX,
  //group rows and feature-flag rows live in the users
  // table and are NOT addressable identities — a caller-supplied `group#…`
  // or `feature#…` reaching GET /v1/keys/{userId} or WS `send.to` would be
  // a row-existence oracle and a dead-letter queue mint, exactly the class
  // this set exists to refuse.
  GROUP_ROW_PREFIX,
  FEATURE_FLAG_PREFIX,
  //identifier claims, their suppression shadow, and
  // pending recovery rows — same users-table-resident, never-a-user classes.
  EMAIL_CLAIM_KEY_PREFIX,
  EMAIL_SUPPRESSION_PREFIX,
  RECOVERY_ROW_PREFIX,
  // The address-keyed cool-down shadow.
  EMAIL_COOLDOWN_PREFIX,
  // The phone claim class — claim rows, the vendor-
  // refusal shadow, and the cool-down shadow, guarded the moment they exist
  // (the SET-not-check rule this constant exists for).
  PHONE_CLAIM_KEY_PREFIX,
  PHONE_SUPPRESSION_PREFIX,
  PHONE_COOLDOWN_PREFIX,
  // the username claim row and its skeleton twin — the guard lands with
  // the rows themselves (the SET-not-check rule). A caller-supplied `usernamehash#…` reaching a user
  // route would be an is-this-name-claimed oracle outside the one priced
  // verb that may answer it.
  USERNAME_CLAIM_KEY_PREFIX,
  NAMESKEL_CLAIM_KEY_PREFIX,
] as const;

/** True when a caller-supplied id is really a claim row rather than a user. */
export function isClaimKey(userId: string): boolean {
  return CLAIM_PREFIXES.some((prefix) => userId.startsWith(prefix));
}

/** Pending auth-challenge row in the sessions table. Its own namespace beside
 * `sess:` and the claim prefixes; all are mutually prefix-disjoint, and every
 * reader re-checks the `kind` attribute rather than trusting the key shape
 * alone. (A fourth namespace, `verify:`, held SMS codes and is gone.)
 *
 * ONE ROW PER OUTSTANDING NONCE, keyed by a digest binding the identity key
 * AND the challenge. Keyed by identity key alone — as it first was — issuing
 * was an overwrite, and /v1/auth/challenge takes nothing but the PUBLIC key,
 * so anyone holding a victim's key could clobber their in-flight sign-in at
 * will. The digest (not raw concatenation) keeps the key bounded and free of
 * delimiter ambiguity, same trick as `sessionKey` above. */
const authChallengeKey = (identityKeyPub: string, challenge: string): string =>
  `chal#${createHash('sha256').update(identityKeyPub).update('|').update(challenge).digest('hex')}`;
const wsTicketKey = (ticket: string): string => `wst#${ticket}`;

/**
 * Pending link-offer rows in the SESSIONS table (the
 * challenge-row shape): their own namespace beside `chal#`/`wst#`/`sess:`,
 * all mutually prefix-disjoint, every reader re-checking the `kind`
 * attribute rather than trusting key shape alone. Keyed by the server-minted
 * single-use nonce — high-entropy, so per-nonce keying is the same
 * no-clobber property the challenge digest key buys. Exported for tests that
 * must prove the winning transaction consumed the row itself.
 */
export const LINK_OFFER_KEY_PREFIX = 'linkoffer#';
const linkOfferKey = (offerNonce: string): string => `${LINK_OFFER_KEY_PREFIX}${offerNonce}`;

/**
 * INIT-leg rows their own prefix-disjoint namespace beside
 * `linkoffer#`: the same nonce keys first an init row and then — only after
 * A's signature verifies — the offer row, so one `linkOfferNonces` reverse
 * pointer finds whichever of the two the sweep encounters. Exported for the
 * same must-prove-the-consume tests as the offer prefix.
 */
export const LINK_INIT_KEY_PREFIX = 'linkinit#';
const linkInitKey = (offerNonce: string): string => `${LINK_INIT_KEY_PREFIX}${offerNonce}`;

/**
 * Pending email verification-code rows in the SESSIONS table: their own prefix-disjoint namespace beside the challenge/ticket/
 * offer rows, every reader re-checking the `kind` attribute. Keyed by the
 * REQUESTING account — one pending code per device, replaced on re-request
 * (priced by the resend cool-down) — and deliberately with NO `userId`
 * attribute, the linkoffer# rule: the sessions user-index is partitioned on
 * `userId`, and carrying one would have `deleteSessionsForUser` batch-delete
 * pending codes on every sign-in. Exported for the sweep tests.
 */
export const EMAIL_CODE_KEY_PREFIX = 'emailcode#';
/** The pending-code row token — keyed by (requester, PURPOSE). Attach and
 * recovery codes live in SEPARATE slots so a recovery request-code can never
 * overwrite the caller's own pending attach row: that clobber let a recovery
 * HIT (registered) flip a pending attach row's purpose while a MISS
 * (unregistered) left it, which a downstream attach-verify then answered 200
 * vs the collapsed refusal — a registered-vs-not oracle in bytes/status, not
 * timing. */
const emailCodeKey = (userId: string, purpose: EmailCodeRecord['purpose']): string =>
  `${EMAIL_CODE_KEY_PREFIX}${userId}#${purpose}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errName(err: unknown): string {
  return (err as { name?: string }).name ?? '';
}

/**
 * Best-effort clear of a recovering device's non-authoritative
 * `recoveryGroupId` reverse pointer once the `recovery#` row it points at is
 * gone (the stale-pointer class). CLEANUP, never enforcement —
 * completion re-reads the recovery row, so a surviving pointer authorizes
 * nothing — but a pointer left standing would keep naming a dead groupId
 * from a live row, exactly the residue class the sweep exists to keep out of
 * the store. Conditioned on the pointer still naming THIS group (a device
 * that re-entered a fresh recovery keeps its new pointer), and a lost
 * condition or missing row is the no-op it should be.
 */
async function clearRecoveryPointer(
  doc: DynamoDBDocumentClient,
  groupId: string,
  recovererUserId: string,
): Promise<void> {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLES.users,
        Key: { userId: recovererUserId },
        UpdateExpression: 'REMOVE recoveryGroupId',
        ConditionExpression: 'attribute_exists(userId) AND recoveryGroupId = :g',
        ExpressionAttributeValues: { ':g': groupId },
      }),
    );
  } catch (err) {
    if (errName(err) !== 'ConditionalCheckFailedException') throw err;
  }
}

/**
 * Send one account-group roster TransactWrite, re-attempting PURE
 * TransactionConflict cancellations (no condition failed, nothing committed)
 * up to ROSTER_TXN_ATTEMPTS times — the .2 consent-transaction
 * remediation applied to the same failure class. Re-sending the SAME items
 * is sound because every item is condition-pinned to its snapshot (epoch,
 * refs, attribute existence): a re-send can only commit where the snapshot
 * is still exact, or fail its conditions into the caller's honest
 * classification. Returns undefined on commit, the CancellationReasons when
 * a condition refused, and throws on anything else — including a conflict
 * persisting past the bound, which must never masquerade as a refusal.
 */
async function sendRosterTransact(
  doc: DynamoDBDocumentClient,
  transactItems: TransactItem[],
): Promise<Array<{ Code?: string }> | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
      return undefined;
    } catch (err) {
      if (errName(err) !== 'TransactionCanceledException') throw err;
      const reasons =
        (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
      if (reasons.some((r) => r?.Code === 'ConditionalCheckFailed')) return reasons;
      if (attempt >= ROSTER_TXN_ATTEMPTS) throw err;
    }
  }
}

/**
 * THE TOMBSTONE-AWARE CLAIM CONDITION (the corrected
 * spelling), ONE string so the newest-version Puts and every
 * retiring-version ConditionCheck carry byte-identical logic: the key is
 * free when no row stands there, OR a tombstone stands there that has
 * elapsed, OR a tombstone stands there that this group left. Plain ABSENT
 * (the phonehash# spelling) is deliberately NOT reused: that pattern never
 * had tombstones, and a rename/unlink tombstone on a retiring version would
 * otherwise refuse everyone — the former owner's 30-day reclaim included —
 * for the whole ≥90-day key-retirement window. A row with `tombstoned`
 * absent (a LIVE claim, or a live skeleton) fails every arm; a tombstone
 * with `formerGroupId` absent (revocation, dissolve) frees only by clock.
 */
const USERNAME_CLAIM_FREE_CONDITION =
  'attribute_not_exists(userId) OR (tombstoned = :tomb AND (freesAt <= :nowS OR formerGroupId = :owner))';
const usernameClaimFreeValues = (
  nowSeconds: number,
  groupId: string,
): Record<string, unknown> => ({ ':tomb': true, ':nowS': nowSeconds, ':owner': groupId });

/** `freesAt` for a tombstone written now (unix seconds). */
const usernameFreesAt = (nowMs: number): number =>
  Math.floor(nowMs / 1000) + USERNAME_TOMBSTONE_TTL_SECONDS;

/** A username ref on a group's `identifierRefs` — the exact-name row; the
 * skeleton row is reached through it, never listed as a ref of its own (the
 * per-class slot counts refs, and the skeleton is not a second name). */
const isUsernameClaimRef = (ref: string): boolean => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX);

/**
 * The tombstone Put-OVERWRITE for one username row: the row at
 * `key` — claim or skeleton — REPLACED wholesale by its tombstone, never
 * deleted (the tombstone lives AT the key so the claim condition can read
 * it), pinned to the group that holds it (`kind` + `groupId`: a row that
 * moved to another group since the caller's snapshot is never overwritten
 * by a stale caller). `formerGroupId` present = the 30-day former-owner
 * reclaim right; absent = nobody reclaims early. The claim-row tombstone
 * remembers its skeleton key so the reaping read takes both.
 */
function usernameTombstoneItem(input: {
  key: string;
  kind: 'identifierClaim' | 'usernameSkeleton';
  groupId: string;
  nowMs: number;
  formerGroupId?: string;
  skeletonKey?: string;
}): TransactItem {
  return {
    Put: {
      TableName: TABLES.users,
      Item: {
        userId: input.key,
        kind: input.kind,
        tombstoned: true,
        tombstonedAt: input.nowMs,
        freesAt: usernameFreesAt(input.nowMs),
        ...(input.formerGroupId !== undefined ? { formerGroupId: input.formerGroupId } : {}),
        ...(input.skeletonKey !== undefined ? { skeletonKey: input.skeletonKey } : {}),
      },
      ConditionExpression: 'kind = :k AND groupId = :g',
      ExpressionAttributeValues: { ':k': input.kind, ':g': input.groupId },
    },
  };
}

/** The LIVE username claim row at `claimKey` (kind-checked, untombstoned),
 * or undefined — the pre-read every lifecycle transaction takes to learn the
 * skeleton key it must move with the claim. Strongly consistent. */
async function readLiveUsernameClaim(
  doc: DynamoDBDocumentClient,
  claimKey: string,
): Promise<{ groupId: string; skeletonKey: string; discoverableAfter?: number } | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLES.users, Key: { userId: claimKey }, ConsistentRead: true }),
  );
  const item = res.Item;
  if (!item || item.kind !== 'identifierClaim' || item.tombstoned === true) return undefined;
  if (typeof item.skeletonKey !== 'string') {
    // A username claim row without its skeleton twin is store drift the
    // claim transaction makes impossible — loud, never a half-tombstone.
    throw new Error('username claim: live row carries no skeleton key');
  }
  return {
    groupId: item.groupId as string,
    skeletonKey: item.skeletonKey,
    ...(item.discoverableAfter !== undefined
      ? { discoverableAfter: item.discoverableAfter as number }
      : {}),
  };
}

/**
 * THE DISSOLVE TOMBSTONES ("account deletion / group dissolve: the
 * dissolve transaction writes the same tombstones"): for every username ref
 * a dying group's reverse list names, the claim row AND its skeleton row
 * tombstoned in the caller's transaction — no orphaned live claim, no
 * instant re-claim of a deleted person's name. NO `formerGroupId`: the
 * group that could reclaim dies in this same transaction, and a dangling
 * group id must not outlive its row. A ref whose live row is already gone
 * (drift the refs CAS makes impossible) contributes nothing rather than
 * minting a tombstone for a name nobody held. One GetItem per username ref
 * (a group holds at most one), never a Query.
 */
async function usernameDissolveTombstones(
  doc: DynamoDBDocumentClient,
  identifierRefs: readonly string[],
  groupId: string,
  nowMs: number,
): Promise<TransactItem[]> {
  const items: TransactItem[] = [];
  for (const ref of identifierRefs) {
    if (!isUsernameClaimRef(ref)) continue;
    const live = await readLiveUsernameClaim(doc, ref);
    if (!live || live.groupId !== groupId) continue;
    items.push(
      usernameTombstoneItem({
        key: ref,
        kind: 'identifierClaim',
        groupId,
        nowMs,
        skeletonKey: live.skeletonKey,
      }),
      usernameTombstoneItem({ key: live.skeletonKey, kind: 'usernameSkeleton', groupId, nowMs }),
    );
  }
  return items;
}

/**
 * The per-class unlink body SHARED by the email/phone unlink and the
 * username unlink (one copy of the refs CAS, the membership pin, and
 * the lazy-solo reap decision is where drift would otherwise live): the
 * group side is identical for every class; only how the class's rows are
 * DISPOSED differs (deleted for the possession-proof classes, tombstoned for
 * the username class), so the caller supplies those items — as a function
 * of the dissolve decision, because a tombstone's former-owner right depends
 * on whether the group survives. `stampUsernameRenamedAt` (unix seconds)
 * is the username class's addition: the SURVIVING group row takes the
 * rename cool-down stamp in the same Update (an unlink is a name change —
 * the hoarding fix); a dissolving group has no row left to stamp.
 */
async function unlinkIdentifierRefs(
  doc: DynamoDBDocumentClient,
  {
    userId,
    groupId,
    refsSnapshot,
    claimKeys,
    stampUsernameRenamedAt,
  }: {
    userId: string;
    groupId: string;
    refsSnapshot: readonly string[];
    claimKeys: readonly string[];
    stampUsernameRenamedAt?: number;
  },
  claimItems: (dissolve: boolean) => Promise<TransactItem[]>,
  readPendingRecoverer: () => Promise<string | undefined>,
): Promise<EmailUnlinkResult> {
  // THE LAZY-SOLO REAP DECISION — a snapshot read,
  // never the authorization: the transaction below re-binds everything
  // it decides on (epoch, refs, membership, the marker) in its own
  // conditions, so a raced link/attach refuses rather than reaping a
  // group that stopped being the never-ceremonially-grouped founder
  // class between read and commit.
  const gkey = groupRowKey(groupId);
  const snapshot = await doc.send(
    new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
  );
  const row = snapshot.Item;
  if (!row) return 'unknown_group';
  const members = (row.members ?? []) as AccountGroupMember[];
  // PER-CLASS SUBTRACTION: the remainder is the full
  // snapshot MINUS exactly the class's own keys — the other class's ref
  // survives by construction, and the dissolve can only fire when the
  // remainder is EMPTY (the LAST class's unlink).
  const removed = new Set(claimKeys);
  const remainder = refsSnapshot.filter((ref) => !removed.has(ref));
  const dissolve =
    remainder.length === 0 &&
    row.attachCreated === true &&
    (row.epoch as number) === 1 &&
    members.length === 1 &&
    members[0]!.userId === userId;
  const groupItem: TransactItem = dissolve
    ? {
        // The founder's whole downgrade (for this class): the group
        // row dies with its LAST identifier (empty remainder — a
        // surviving other-class claim refuses this branch above). Epoch
        // pinned at the birth value — a ceremony that joined (or a
        // mutation that ran) since the snapshot moved it and refuses the
        // reap; the FULL refs-snapshot condition is the same
        // last-member-exit rule as the subtract branch.
        Delete: {
          TableName: TABLES.users,
          Key: { userId: gkey },
          ConditionExpression:
            'attribute_exists(attachCreated) AND epoch = :birth AND identifierRefs = :refs AND contains(memberIds, :caller)',
          ExpressionAttributeValues: {
            ':birth': 1,
            ':refs': [...refsSnapshot],
            ':caller': userId,
          },
        },
      }
    : {
        Update: {
          TableName: TABLES.users,
          Key: { userId: gkey },
          UpdateExpression:
            stampUsernameRenamedAt === undefined
              ? 'SET identifierRefs = :remaining'
              : 'SET identifierRefs = :remaining, usernameRenamedAt = :renamedAt',
          // UNCHANGED-full-snapshot condition on the refs (the
          // last-member-exit rule, applied per class): the
          // disposals below take exactly the class's snapshot rows, the
          // update writes exactly the remainder, and a raced
          // re-attach/unlink of EITHER class refuses the whole
          // transaction rather than orphaning an unreachable claim row.
          // Caller's membership enforced in-transaction, as every
          // roster-adjacent write is.
          ConditionExpression:
            'attribute_exists(userId) AND identifierRefs = :refs AND contains(memberIds, :caller)',
          ExpressionAttributeValues: {
            ':remaining': remainder,
            ':refs': [...refsSnapshot],
            ':caller': userId,
            ...(stampUsernameRenamedAt === undefined ? {} : { ':renamedAt': stampUsernameRenamedAt }),
          },
        },
      };
  const items: TransactItem[] = [
    groupItem,
    ...(await claimItems(dissolve)),
    ...(dissolve
      ? [
          {
            // The founder returns to never-opted-in: groupId cleared
            // under its own pin (a row that re-grouped elsewhere is
            // never touched).
            Update: {
              TableName: TABLES.users,
              Key: { userId },
              UpdateExpression: 'REMOVE groupId',
              ConditionExpression: 'attribute_exists(userId) AND groupId = :g',
              ExpressionAttributeValues: { ':g': groupId },
            },
          } satisfies TransactItem,
          {
            // Any pending recovery against the dissolving solo group is
            // an orphan the moment the claim dies (completion re-checks
            // the claim names the group) — reaped here, the last-member-
            // exit rule.
            Delete: { TableName: TABLES.users, Key: { userId: recoveryRowKey(groupId) } },
          } satisfies TransactItem,
        ]
      : []),
  ];
  // Snapshot the pending recovery's recovering device BEFORE the reap so
  // its non-authoritative reverse pointer can be cleared post-commit
  // (best-effort cleanup, the stale-pointer class — never enforcement).
  const pendingRecoverer = dissolve ? await readPendingRecoverer() : undefined;
  const reasons = await sendRosterTransact(doc, items);
  if (!reasons) {
    if (pendingRecoverer !== undefined) {
      await clearRecoveryPointer(doc, groupId, pendingRecoverer);
    }
    return 'unlinked';
  }
  const after = await doc.send(
    new GetCommand({
      TableName: TABLES.users,
      Key: { userId: groupRowKey(groupId) },
      ConsistentRead: true,
    }),
  );
  if (!after.Item) return 'unknown_group';
  const ids = after.Item.memberIds as Set<string> | undefined;
  if (!ids || !ids.has(userId)) return 'not_member';
  return 'stale';
}

type WriteRequest = { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } };

/** All one-time-prekey keyIds for a user (strongly consistent, paginated). */
async function listOneTimePrekeyIds(
  doc: DynamoDBDocumentClient,
  userId: string,
): Promise<number[]> {
  const ids: number[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLES.prekeys,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ProjectionExpression: 'keyId',
        ConsistentRead: true,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) ids.push(item.keyId as number);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return ids;
}

/** BatchWrite in chunks of 25, retrying UnprocessedItems with backoff so no
 * item is ever silently dropped under throttling. */
async function chunkedBatchWrite(
  doc: DynamoDBDocumentClient,
  table: string,
  requests: WriteRequest[],
): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let batch = requests.slice(i, i + 25);
    for (let attempt = 0; batch.length > 0; attempt++) {
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: batch } }));
      const unprocessed = (res.UnprocessedItems?.[table] ?? []) as WriteRequest[];
      if (unprocessed.length === 0) break;
      if (attempt >= 8) {
        throw new Error(`batch write left ${unprocessed.length} unprocessed after retries`);
      }
      await sleep(25 * (attempt + 1));
      batch = unprocessed;
    }
  }
}

export function makeDataLayer(
  doc: DynamoDBDocumentClient,
  // The per-pair offline-queue cap. Injected so tests can drive small,
  // exhaustible caps against the REAL store cheaply; production takes the
  // defaults. Not a runtime concern — it is fixed for a deployment.
  queueQuota: QueueQuota = DEFAULT_QUEUE_QUOTA,
  // Host seams (DataLayerHooks). The AWS adapter passes a durable
  // scheduleReconcile; the local adapter and tests pass nothing and keep the
  // in-process repair.
  hooks: DataLayerHooks = {},
): DataLayer {
  const quota = resolveQueueQuota(queueQuota);
  // The store's OWN clock for the connection-TTL clamp (DataLayerHooks.nowMs
  // is a test seam; production always runs on Date.now).
  const wallNowMs = hooks.nowMs ?? Date.now;

  /** The (senderId -> recipientId) pair-ledger item, or undefined when absent
   * OR expired — TTL deletion is eventual, so the clock decides, not the
   * reaper. Erring PAST expiry would err generous on the correspondence
   * signal; checking here keeps both consumers exact and both twins equal.
   *
   * `established` is the reverse-correspondence signal proper: TRUE only
   * when a USER-AUTHORED frame has ridden this ledger (the `qEstab` marker set
   * at enqueue). The row's mere EXISTENCE no longer means correspondence —
   * automatic carriers (call.end/busy, read receipts, profile syncs) create
   * and count the ledger for the quota, but must not mint a relationship the
   * user never chose. A row with `qItems`/`qBytes` but no `qEstab` is a pair
   * that has exchanged only automatic traffic: it bounds the queue but confers
   * no ring exemption and no stranger-cap exemption.
   *
   * ESTABLISHMENT AGES ON ITS OWN CLOCK. `qEstab`
   * once shared the ledger's single `expiresAt`, and EVERY enqueue — automatic
   * carriers included — pushed that expiry forward, so one real reply could be
   * kept "established" indefinitely through induced automatic responses. The
   * establishment now carries a SEPARATE `qEstabExpiresAt`, refreshed ONLY by a
   * user-authored send, and is live only while THAT clock is in the future:
   * automatic carriers still ride the ledger's general `expiresAt` (quota TTL)
   * but can no longer renew a relationship the recipient never re-chose. A
   * legacy row with `qEstab` but no `qEstabExpiresAt` reads as NOT established
   * (it reverts to unknown until the next user-authored send) — safe, and moot
   * pre-v1.0. */
  const getPairLedger = async (
    senderId: string,
    recipientId: string,
    nowSeconds: number,
  ): Promise<{ qItems: number; qBytes: number; established: boolean } | undefined> => {
    const res = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId, msgId: queuePairLedgerKey(senderId) },
      }),
    );
    const item = res.Item;
    if (!item || typeof item.expiresAt !== 'number' || item.expiresAt <= nowSeconds) {
      return undefined;
    }
    return {
      qItems: typeof item.qItems === 'number' ? item.qItems : 0,
      qBytes: typeof item.qBytes === 'number' ? item.qBytes : 0,
      established:
        item.qEstab === true &&
        typeof item.qEstabExpiresAt === 'number' &&
        item.qEstabExpiresAt > nowSeconds,
    };
  };

  /** The group-aware establishment walk: OR of
   * `established` over every (writer key, receiver partition) pair-ledger —
   * bounded GetItems (≤4×3), never a Query. Shared by the enqueue
   * classification and `hasQueuedCorrespondenceAny`, so the queue caps and
   * the ring budget cannot drift on what "established" means. */
  const pairEstablishedAny = async (
    writerKeys: readonly string[],
    receiverPartitions: readonly string[],
    nowSeconds: number,
  ): Promise<boolean> => {
    for (const partition of receiverPartitions) {
      for (const writer of writerKeys) {
        if ((await getPairLedger(writer, partition, nowSeconds))?.established === true) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * The condition that binds a ledger MUTATION to the exact ledger state a
   * decision was read against.
   *
   * `qVer` alone is NOT that binding: a version is monotonic only within one
   * INCARNATION of the row. The zero-ledger reap and DynamoDB TTL
   * both DELETE ledger rows, and a recreation restarts `qVer` at 1 — so a
   * reconciler that read version V from a doomed incarnation would find its
   * stale condition SATISFIED by any new incarnation that merely accumulated V
   * mutations (schedulable at will against the shared stranger ledger by a
   * fleet of free accounts). Every incarnation therefore carries `qGen`, a
   * random generation minted with `if_not_exists` by whichever mutation
   * creates the row, and every state-bound write conditions on the (qGen,
   * qVer) PAIR it observed. The two legacy arms below die out with the rows
   * they describe: a pre-qGen row is bound exactly as it was before (its
   * version, or its literal counts), plus the requirement that no generation
   * has appeared — the first post-deploy mutation mints one, and a recreation
   * always has one, so neither can satisfy a stale legacy binding.
   */
  const ledgerBind = (
    item: Record<string, unknown>,
  ): { cond: string; values: Record<string, unknown> } => {
    const ver = typeof item.qVer === 'number' ? item.qVer : undefined;
    const gen = typeof item.qGen === 'string' ? item.qGen : undefined;
    if (ver !== undefined && gen !== undefined) {
      return { cond: 'qGen = :bg AND qVer = :bv', values: { ':bg': gen, ':bv': ver } };
    }
    if (ver !== undefined) {
      return { cond: 'attribute_not_exists(qGen) AND qVer = :bv', values: { ':bv': ver } };
    }
    return {
      cond: 'attribute_not_exists(qGen) AND attribute_not_exists(qVer) AND qItems = :bi AND qBytes = :bb',
      values: {
        ':bi': typeof item.qItems === 'number' ? item.qItems : 0,
        ':bb': typeof item.qBytes === 'number' ? item.qBytes : 0,
      },
    };
  };

  /**
   * Heal a ledger that drifted ABOVE the truth (crash consistency) —
   * asynchronously, single-flight, in budgeted resumable slices.
   *
   * The one writer this layer cannot transact with is DynamoDB TTL: it reaps
   * expired message rows without running any code here, so a pair that queued
   * to its cap and went unread for the 30-day TTL would leave the ledger
   * claiming a full queue over an empty partition — a permanent lockout for a
   * legitimate correspondent. The refusal path schedules this reconciliation;
   * the drifted ledger heals within a few refusals, never forever.
   *
   * WHY NOT SYNCHRONOUS ON THE REFUSAL PATH: the previous shape
   * ran a full strongly-consistent partition recount — twice, pair AND
   * stranger — inside every refused send. A refusal is FREE for the sender
   * (their frame was rejected; nothing was stored, no quota consumed), so
   * four free accounts holding the shared stranger ledger at its cap could
   * bill the victim's partition ~32 MiB of evaluated reads per rejected
   * request at request rate: a read-amplification DoS priced at zero. The
   * refusal now returns immediately and the recount runs out of band, one
   * leased, budgeted slice at a time.
   *
   * THE FOUR PROPERTIES, each load-bearing:
   *
   * 1. BUDGETED (the DrainBudget idiom, ws.ts): a slice stops at
   *    RECONCILE_MAX_PAGES pages or RECONCILE_SLICE_MS of wall clock,
   *    whichever binds first — never an unbounded partition walk inside one
   *    trigger, however large the attacker grows the partition.
   *
   * 2. NEVER LOWER FROM AN INCOMPLETE SCAN. A partial count is a LOWER bound
   *    on the truth; resetting the ledger to it would hand the attacker the
   *    inverse primitive — drive an established ledger BELOW its live rows
   *    (quota underflow, cap defeated from below), strictly worse than the
   *    drift-UP being healed. A slice that spends its budget persists a
   *    cursor and its partial sums; ONLY a scan that reached the end of the
   *    partition may write the ledger downward. Drift-UP is the safe
   *    direction to wait in: it only over-refuses, and the next completed
   *    scan corrects it.
   *
   * 3. SINGLE-FLIGHT, via a short lease (`qReconUntil`/`qReconTok`) on the
   *    ledger row itself — the natural home, since the (qGen, qVer) binding
   *    the reset must respect already lives there. Concurrent refusals for
   *    the same ledger find the lease held and skip; N rejected requests cost
   *    at most one in-flight scan per ledger, not N. The lease write
   *    deliberately does NOT bump `qVer` (the bumpLedgerClock rule): it is
   *    not counted state, and bumping would invalidate every concurrent
   *    release's (qGen, qVer) binding — a self-inflicted livelock.
   *
   * 4. RESUMABLE ACROSS TRIGGERS, bound to one incarnation+version. The
   *    cursor and partial sums are valid only while the (qGen, qVer) they
   *    were read under is unchanged — persisted beside them and re-checked on
   *    resume and again by the final conditional reset. ANY ledger mutation
   *    (enqueue, release, a competing reset) bumps `qVer` and voids the scan,
   *    so a multi-slice scan can never mix rows from two ledger states; it
   *    simply restarts. Restarts terminate in practice because a ledger being
   *    reconciled is at its cap: new pair/stranger rows are being refused, so
   *    the partition under the filter is not growing under the scan.
   */
  const RECONCILE_LEASE_MS = 30_000;
  const RECONCILE_SLICE_MS = 2_000;
  const RECONCILE_MAX_PAGES = 4;
  /** Every reconcile bookkeeping attribute, for the REMOVE clauses: state
   * must never outlive the scan it describes, or a stale cursor could seed a
   * later scan with another incarnation's partial sums. */
  const RECON_STATE_ATTRS =
    'qReconUntil, qReconTok, qReconGen, qReconVer, qReconCursor, qReconItems, qReconBytes';
  // Container-local fast path for the same single-flight rule: a burst of
  // refusals inside ONE container must not even attempt N lease writes.
  // The lease on the row is what holds across containers.
  const reconcileInFlight = new Set<string>();
  // Durable-hook debounce: with a scheduleReconcile
  // hook, each schedule is a real out-of-band invoke, so a flood of refusals
  // against one ledger must not become a flood of invokes. One handoff per
  // ledger per lease window per container; the worker's row lease is what
  // holds across containers. Bounded: expired entries are pruned in place.
  const reconcileScheduledUntil = new Map<string, number>();
  const RECONCILE_DEBOUNCE_MAX_KEYS = 512;

  /** The ledger row key and recount filter a reconcile target denotes —
   * derived HERE, from the same constants the enqueue path stamps, never
   * carried inside a cross-process event (LedgerReconcileTarget's contract). */
  const reconcileTargetFacts = (
    target: LedgerReconcileTarget,
  ): {
    ledgerMsgId: string;
    filter: { FilterExpression: string; values: Record<string, unknown> };
  } =>
    target.kind === 'pair'
      ? {
          ledgerMsgId: queuePairLedgerKey(target.senderId),
          filter: pairRecountFilter(target.senderId),
        }
      : { ledgerMsgId: QUEUE_STRANGER_LEDGER_KEY, filter: strangerRecountFilter() };

  /**
   * Get the repair on its way — DURABLY when the host provides the seam.
   *
   * With a hook (the AWS adapter): AWAIT the handoff, then return, and run
   * nothing in-process. The await is load-bearing:
   * an unawaited invoke is the same floating promise this replaces — Lambda
   * can freeze the container the instant the refusal's response returns, so
   * only work already accepted by something outside the container survives.
   * The handoff is one fast queueing call; the refusal never waits on the
   * repair itself. A FAILED handoff is swallowed (the hook logs loudly): the
   * sender's answer is 429 either way, the ledger merely stays drifted HIGH
   * (over-refusal only) until a later refusal retries the schedule.
   *
   * Without a hook (the LOCAL adapter's long-lived process, tests): the
   * in-process slice, fire-and-forget, exactly as before — the process
   * outlives the response, so the floating promise genuinely runs. A
   * reconcile failure is safe to swallow here for the same reason: drift-HIGH
   * only over-refuses, and the next refusal's slice resumes healing.
   */
  const scheduleLedgerReconcile = async (
    recipientId: string,
    target: LedgerReconcileTarget,
  ): Promise<void> => {
    const { ledgerMsgId, filter } = reconcileTargetFacts(target);
    const key = `${recipientId}\u0000${ledgerMsgId}`;
    const durable = hooks.scheduleReconcile;
    if (durable) {
      const nowMs = Date.now();
      const until = reconcileScheduledUntil.get(key);
      if (until !== undefined && until > nowMs) return;
      if (reconcileScheduledUntil.size >= RECONCILE_DEBOUNCE_MAX_KEYS) {
        for (const [k, t] of reconcileScheduledUntil) {
          if (t <= nowMs) reconcileScheduledUntil.delete(k);
        }
      }
      reconcileScheduledUntil.set(key, nowMs + RECONCILE_LEASE_MS);
      try {
        await durable({ recipientId, target });
      } catch {
        // The hook does its own loud logging. Clear the debounce so the NEXT
        // refusal retries the handoff instead of waiting the window out.
        reconcileScheduledUntil.delete(key);
      }
      return;
    }
    if (reconcileInFlight.has(key)) return;
    reconcileInFlight.add(key);
    void reconcileLedgerSlice(recipientId, ledgerMsgId, filter)
      .catch(() => {})
      .finally(() => {
        reconcileInFlight.delete(key);
      });
  };

  const reconcileLedgerSlice = async (
    recipientId: string,
    ledgerMsgId: string,
    filter: { FilterExpression: string; values: Record<string, unknown> },
  ): Promise<LedgerReconcileOutcome> => {
    const nowMs = Date.now();
    const tok = randomUUID();
    // 1. Take the lease — or stand down. The conditional write is the
    // single-flight arbiter: exactly one reconciler per ledger row may pass
    // it per lease window, and an expired lease (a crashed or frozen
    // predecessor) is claimable. `attribute_exists(qItems)` keeps a lease
    // from MINTING a ledger row that TTL (or the zero-count reap) already
    // removed — the releaseCrewSlot ghost-row lesson. ALL_NEW hands back the
    // row this slice is bound to: its (qGen, qVer), the counts the refusal
    // saw, and any persisted scan state — one round trip, and the same write
    // that fenced out every other reconciler.
    let leased;
    try {
      leased = await doc.send(
        new UpdateCommand({
          TableName: TABLES.messages,
          Key: { recipientId, msgId: ledgerMsgId },
          UpdateExpression: 'SET qReconUntil = :until, qReconTok = :tok',
          ConditionExpression:
            'attribute_exists(qItems) AND (attribute_not_exists(qReconUntil) OR qReconUntil <= :nowMs)',
          ExpressionAttributeValues: {
            ':until': nowMs + RECONCILE_LEASE_MS,
            ':tok': tok,
            ':nowMs': nowMs,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
    } catch (err) {
      if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      // Lease held by a live reconciler (single-flight: skip, it is already
      // doing this work) or the row is gone (nothing to heal).
      return 'stood_down';
    }
    const item = (leased.Attributes ?? {}) as Record<string, unknown>;
    const seenItems = typeof item.qItems === 'number' ? item.qItems : 0;
    const seenBytes = typeof item.qBytes === 'number' ? item.qBytes : 0;
    // The FULL binding — generation AND version. The version
    // alone was defeated by recreation: the reap (or TTL) deleted the row a
    // scan observed, a new incarnation accumulated the same qVer, and a
    // stale reset landed BELOW the new incarnation's live rows.
    const bind = ledgerBind(item);
    const gen = typeof item.qGen === 'string' ? item.qGen : undefined;
    const ver = typeof item.qVer === 'number' ? item.qVer : undefined;
    // Resume ONLY when the persisted scan state was recorded under exactly
    // this (qGen, qVer): a mutation since then voids the partial sums (rows
    // may have been added or released behind the cursor), and mixing them
    // with fresh pages would produce a count of no ledger state that ever
    // existed. A legacy pre-qGen row never resumes — its first post-deploy
    // mutation mints a generation, and until then a fresh bounded scan is
    // cheap and correct.
    const resumable =
      gen !== undefined &&
      ver !== undefined &&
      item.qReconGen === gen &&
      item.qReconVer === ver &&
      typeof item.qReconCursor === 'string';
    const carried = resumable
      ? {
          items: typeof item.qReconItems === 'number' ? item.qReconItems : 0,
          bytes: typeof item.qReconBytes === 'number' ? item.qReconBytes : 0,
        }
      : { items: 0, bytes: 0 };
    const truth = await recountRows(
      recipientId,
      Math.floor(nowMs / 1000),
      filter,
      { maxPages: RECONCILE_MAX_PAGES, deadlineMs: nowMs + RECONCILE_SLICE_MS },
      resumable ? (item.qReconCursor as string) : undefined,
      carried,
    );

    // Release the lease (and drop any scan state) — conditioned on OUR token,
    // so a successor that claimed an expired lease is never clobbered.
    const releaseLease = async (): Promise<void> => {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.messages,
            Key: { recipientId, msgId: ledgerMsgId },
            UpdateExpression: `REMOVE ${RECON_STATE_ATTRS}`,
            ConditionExpression: 'qReconTok = :tok',
            ExpressionAttributeValues: { ':tok': tok },
          }),
        );
      } catch (err) {
        // Token gone or replaced: the row was reaped, or a successor owns the
        // lease now. Either way there is nothing of ours left to clear.
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      }
    };

    if (truth.outcome === 'complete') {
      if (seenItems <= truth.items && seenBytes <= truth.bytes) {
        // The ledger told the truth (or drifted LOW — the safe direction the
        // release path deliberately errs toward): genuinely full, no reset.
        await releaseLease();
        return 'complete';
      }
      // 2. Reconcile DOWN — permitted ONLY here, behind a scan that provably
      // reached the end of the partition (invariant 2 above). Conditioned on
      // the (qGen, qVer) the scan started under AND on our lease token, so a
      // ledger that moved mid-scan (enqueue, release, competing reset)
      // refuses the write — never lower over concurrent movement.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.messages,
            Key: { recipientId, msgId: ledgerMsgId },
            // Bump `qVer` as it resets, so anything bound to the pre-reset
            // state observes the change and stands down — and mint the row's
            // generation if this incarnation predates `qGen`.
            UpdateExpression: `SET qItems = :ti, qBytes = :tb, qGen = if_not_exists(qGen, :gen) ADD qVer :one REMOVE ${RECON_STATE_ATTRS}`,
            ConditionExpression: `${bind.cond} AND qReconTok = :tok`,
            ExpressionAttributeValues: {
              ':ti': truth.items,
              ':tb': truth.bytes,
              ':one': 1,
              ':gen': randomUUID(),
              ':tok': tok,
              ...bind.values,
            },
          }),
        );
        return 'complete';
      } catch (err) {
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        // Lost the binding race — a concurrent writer moved the ledger, or
        // the incarnation this scan observed no longer exists. The completed
        // count describes a state that is gone; discard it, do not lower.
        // 'continue': the drift (if any survives the movement) still needs a
        // fresh scan — the worker may retry within its hop budget.
        await releaseLease();
        return 'continue';
      }
    }
    // 3. Budget spent with partition remaining: persist the cursor and the
    // partial sums, bound to the (qGen, qVer) they were read under, and hand
    // back the lease so the NEXT slice — the worker's continuation under the
    // AWS host, or a later refusal's slice locally — resumes instead of
    // restarting. The persist itself conditions on that binding — if the
    // ledger moved while this slice scanned, the partials are already void
    // and only the lease is cleared. NO ledger count is touched here: a
    // partial scan may never lower (invariant 2).
    if (gen !== undefined && ver !== undefined && truth.cursor !== undefined) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.messages,
            Key: { recipientId, msgId: ledgerMsgId },
            UpdateExpression:
              'SET qReconGen = :g, qReconVer = :v, qReconCursor = :c, qReconItems = :pi, qReconBytes = :pb REMOVE qReconUntil, qReconTok',
            ConditionExpression: `${bind.cond} AND qReconTok = :tok`,
            ExpressionAttributeValues: {
              ':g': gen,
              ':v': ver,
              ':c': truth.cursor,
              ':pi': truth.items,
              ':pb': truth.bytes,
              ':tok': tok,
              ...bind.values,
            },
          }),
        );
        return 'continue';
      } catch (err) {
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        // Binding (or lease) moved mid-scan: the partials describe a dead
        // state. Fall through to clear whatever of ours remains.
      }
    }
    // Budget spent, nothing persisted (legacy pre-qGen row, or the binding
    // moved): the scan restarts from the head next slice. Still 'continue' —
    // the partition remains unscanned and the ledger unverified.
    await releaseLease();
    return 'continue';
  };

  /** The live truth for one pair (unexpired rows from this sender) or the
   * unknown-sender aggregate (rows stamped qUnknown at enqueue) — the two
   * refusal-path recount filters. Built here, next to the enqueue that
   * stamps the attributes they read, so filter and stamp cannot drift. */
  const pairRecountFilter = (
    senderId: string,
  ): { FilterExpression: string; values: Record<string, unknown> } => ({
    // `senderId` here is the ledger's PAIR KEY — since a group-collapsed
    // scope, not always a device ULID. A group-billed row is stamped `qPair`
    // with the scope it was billed under (the stamp travels with the row, so
    // roster changes after billing cannot misroute the recount); an
    // unstamped row was billed per-ULID and matches by its literal sender.
    // One filter, both generations, and stamp and filter live in one file so
    // they cannot drift (the reconcileTargetFacts contract).
    FilterExpression: '(qPair = :s OR (attribute_not_exists(qPair) AND senderId = :s)) AND expiresAt > :now',
    values: { ':s': senderId },
  });
  const strangerRecountFilter = (): {
    FilterExpression: string;
    values: Record<string, unknown>;
  } => ({
    FilterExpression: 'qUnknown = :u AND expiresAt > :now',
    values: { ':u': true },
  });

  /** One BOUNDED slice of the recount — the DrainBudget /
   * DrainResult idiom from ws.ts: a page and deadline budget that binds
   * BEFORE every fetch (the first included — the rule), a
   * 'complete' | 'budget_exhausted' outcome, and on exhaustion a cursor to
   * resume strictly after. The partition is attacker-sized; the budget, not
   * the partition, decides what one slice costs. `carried` folds in a prior
   * slice's partial sums — validity of that carry is the CALLER's contract
   * (the (qGen, qVer) binding above). */
  const recountRows = async (
    recipientId: string,
    nowSeconds: number,
    filter: { FilterExpression: string; values: Record<string, unknown> },
    budget: { maxPages: number; deadlineMs: number },
    cursor: string | undefined,
    carried: { items: number; bytes: number },
  ): Promise<
    | { outcome: 'complete'; items: number; bytes: number }
    | { outcome: 'budget_exhausted'; items: number; bytes: number; cursor?: string }
  > => {
    let items = carried.items;
    let bytes = carried.bytes;
    let resume: string | undefined = cursor;
    let pages = 0;
    while (pages < budget.maxPages && Date.now() < budget.deadlineMs) {
      const res = await doc.send(
        new QueryCommand({
          TableName: TABLES.messages,
          KeyConditionExpression: 'recipientId = :r AND msgId > :ctl',
          FilterExpression: filter.FilterExpression,
          ProjectionExpression: 'msgBytes',
          ExpressionAttributeValues: {
            ':r': recipientId,
            ':ctl': QUEUE_CONTROL_CEILING,
            ':now': nowSeconds,
            ...filter.values,
          },
          // #6 — STRONGLY CONSISTENT. This recount IS the truth the reconciler
          // resets the ledger to. Served from a stale replica it can MISS a
          // just-committed row (A commits, B's refusal recounts 0), the reset
          // lands below the real count, and the cap admits a second sender it
          // should have refused. The recount only runs off the refusal path
          // (leased and budgeted), so the read cost is bounded AND off the
          // hot path.
          ConsistentRead: true,
          ...(resume !== undefined
            ? { ExclusiveStartKey: { recipientId, msgId: resume } }
            : {}),
        }),
      );
      pages += 1;
      for (const it of res.Items ?? []) {
        items += 1;
        bytes += typeof it.msgBytes === 'number' ? (it.msgBytes as number) : 0;
      }
      const lastKey = res.LastEvaluatedKey as { msgId?: string } | undefined;
      if (lastKey?.msgId === undefined) return { outcome: 'complete', items, bytes };
      resume = lastKey.msgId;
    }
    return {
      outcome: 'budget_exhausted',
      items,
      bytes,
      ...(resume !== undefined ? { cursor: resume } : {}),
    };
  };

  return {
    // NO findUserByPhone, and no Query on the users table at all. The phone GSI
    // it read is deleted and nothing replaces it —
    // identifier -> account goes through the claim row below.
    async getUserById(userId, signal, opts) {
      // Claim bookkeeping rows share the users table but are not addressable
      // identities. Refusing them here keeps a caller-supplied 'phone#+1…' or
      // 'idkey#…' (WS send.to, GET /v1/keys/{userId}) from acting as a
      // registered-phone / registered-key oracle, or enqueueing to a
      // recipientId nothing ever drains.
      if (isClaimKey(userId)) return undefined;
      const command = new GetCommand({
        TableName: TABLES.users,
        Key: { userId },
        ...(opts?.consistent === true ? { ConsistentRead: true } : {}),
      });
      const res = signal
        ? await doc.send(command, { abortSignal: signal })
        : await doc.send(command);
      return res.Item ? (res.Item as UserRecord) : undefined;
    },

    async touchActivity(userId, nowMs, signal) {
      const record = activityRecord(userId, nowMs);
      try {
        const command = new UpdateCommand({
          TableName: TABLES.activity,
          Key: { actorHash: record.actorHash },
          UpdateExpression:
            'SET activityDay = :day, activityHourActor = :hour, expiresAt = :expires',
          ConditionExpression:
            'attribute_not_exists(actorHash) OR expiresAt <= :now OR activityHourActor < :hour',
          ExpressionAttributeValues: {
            ':day': record.activityDay,
            ':hour': record.activityHourActor,
            ':expires': record.expiresAt,
            ':now': Math.floor(nowMs / 1000),
          },
        });
        if (signal) {
          await doc.send(command, { abortSignal: signal });
        } else {
          await doc.send(command);
        }
      } catch (err) {
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      }
    },

    async deleteActivity(userId, nowMs) {
      const tombstone = activityTombstone(userId, nowMs);
      await doc.send(
        new UpdateCommand({
          TableName: TABLES.activity,
          Key: { actorHash: tombstone.actorHash },
          UpdateExpression:
            'SET expiresAt = :expires REMOVE activityDay, activityHourActor',
          ExpressionAttributeValues: {
            ':expires': tombstone.expiresAt,
          },
        }),
      );
    },

    async createUser(user) {
      await doc.send(
        new PutCommand({
          TableName: TABLES.users,
          Item: user,
          ConditionExpression: 'attribute_not_exists(userId)',
        }),
      );
    },

    async createSession(session) {
      // Store the token's SHA-256 digest as the key; the plaintext token
      // (returned to the client) is never persisted.
      await doc.send(
        new PutCommand({
          TableName: TABLES.sessions,
          Item: {
            token: sessionKey(session.token),
            kind: 'session',
            userId: session.userId,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
          },
        }),
      );
    },

    async getSession(token) {
      const res = await doc.send(
        new GetCommand({ TableName: TABLES.sessions, Key: { token: sessionKey(token) } }),
      );
      const item = res.Item;
      if (!item || item.kind !== 'session') return undefined;
      return {
        // Return the presented token so the record round-trips for callers that
        // need it; the stored key is only its digest.
        token,
        userId: item.userId as string,
        createdAt: item.createdAt as number,
        expiresAt: item.expiresAt as number,
      };
    },

    async getSessionByDigest(digest) {
      // The digest IS the key material — one point GetItem, no scan, no token.
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.sessions,
          Key: { token: sessionKeyFromDigest(digest) },
          // Strongly consistent: the recheck runs against a revoke that may be
          // seconds old, and the whole point is to observe it promptly.
          ConsistentRead: true,
        }),
      );
      const item = res.Item;
      if (!item || item.kind !== 'session') return undefined;
      return {
        userId: item.userId as string,
        createdAt: item.createdAt as number,
        expiresAt: item.expiresAt as number,
      };
    },

    // --- account deletion (DELETE /v1/account) ---

    async deleteUser(userId, claims, guard) {
      // User row + its claim row removed together, mirroring how they were
      // written: either both go or neither, so a key can always either resolve
      // or be registered afresh — never a claim pointing at nobody.
      // Still a claim BAG rather than a bare string, even though there is only
      // one namespace left: a row created before the first key upload has no
      // `identityKeyPub` at all, so the caller genuinely may have nothing to
      // pass. Deleting the wrong claim (or silently skipping one that exists)
      // strands a live claim against a deleted user.
      // The identity key is safe to key off precisely because it is immutable
      // (see `storeKeys`) and is written at account birth.
      const requireEmptyCrew = guard?.requireEmptyCrew === true;
      const requireNoCrewId = guard?.requireNoCrewId === true;
      // The backstop condition (interface doc): the
      // row goes ONLY while it holds no crew. `attribute_not_exists` covers
      // the never-adopted common case; `=:zero` covers an owner whose crew
      // came and went (releases park the count at zero, never remove it).
      const emptyCrewCondition = {
        ConditionExpression: 'attribute_not_exists(crewCount) OR crewCount = :zero',
        ExpressionAttributeValues: { ':zero': 0 },
      };
      // The mirror guard: this row is being deleted WITHOUT
      // releasing a slot, which is only correct while it holds no crewId. An
      // adopt that commits after the caller's read must refuse this delete, not
      // ride through it and leak the slot.
      const noCrewIdCondition = { ConditionExpression: 'attribute_not_exists(crewId)' };
      const rowCondition = requireEmptyCrew
        ? emptyCrewCondition
        : requireNoCrewId
          ? noCrewIdCondition
          : {};
      const claimKeys =
        claims.identityKeyPub === undefined ? [] : [idkeyClaimKey(claims.identityKeyPub)];
      // The FUSED pending-recovery delete: when
      // the caller's pre-delete read carried the reverse pointer, the
      // recovery row dies in the SAME transaction as the user row — the
      // pointer exists nowhere else, so a crash window between the row
      // delete and a separate purge stranded the recovery row for any
      // hintless retry. Conditioned to take only a row still naming THIS
      // device: a row re-minted for another device cancels the item, and the
      // bounded second attempt below re-runs WITHOUT it (nothing is owed —
      // that row belongs to the replacement's own lifecycle).
      let recoveryKey =
        claims.pendingRecoveryGroupId === undefined
          ? undefined
          : recoveryRowKey(claims.pendingRecoveryGroupId);
      for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: TABLES.users,
                  Key: { userId },
                  ...rowCondition,
                },
              },
              ...claimKeys.map((claimKey) => ({
                Delete: {
                  TableName: TABLES.users,
                  Key: { userId: claimKey },
                  // A tombstoned claim survives EVERY deletion: without this condition, a self-delete racing
                  // an owner revoke erased the tombstone the revoke had just
                  // written, and the revoked key could register again.
                  ConditionExpression: 'attribute_not_exists(tombstoned)',
                },
              })),
              ...(recoveryKey === undefined
                ? []
                : [
                    {
                      Delete: {
                        TableName: TABLES.users,
                        Key: { userId: recoveryKey },
                        ConditionExpression:
                          'attribute_not_exists(userId) OR (kind = :rk AND newUserId = :ru)',
                        ExpressionAttributeValues: { ':rk': 'recoveryPending', ':ru': userId },
                      },
                    },
                  ]),
            ],
          }),
        );
      } catch (err) {
        // TransactionCanceledException alone does NOT mean "the tombstone
        // guard refused" — DynamoDB raises the same exception for
        // TransactionConflict, ThrottlingError, ProvisionedThroughputExceeded
        // and friends. Treating those as the guard was a defect in
        // the first version of this fix: a human
        // self-delete racing any concurrent write to either row would fall
        // into the fallback, delete the user row alone, and leave an
        // UNTOMBSTONED claim pointing at a userId that no longer exists —
        // the `{kind:'conflict'}` state, which answers 409 forever and which
        // nothing in this system can clear. That is a permanently bricked
        // identity key, on the common path.
        //
        // So the reasons are read, and only a genuine ConditionalCheckFailed
        // on the CLAIM item takes the fallback. Anything else propagates and
        // the caller retries the whole idempotent deletion.
        if (errName(err) !== 'TransactionCanceledException') throw err;
        const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
        // Item 0 is the user row (conditioned only under the guard), item 1+
        // are the claims. The user leg is read FIRST: when it refused, the
        // transaction deleted NOTHING — the both-or-neither shape intact, a
        // tombstone (if one also refused) untouched — and the caller owes its
        // operator a 409, not a fallback that deletes the row anyway.
        if ((reasons ?? [])[0]?.Code === 'ConditionalCheckFailed') {
          if (requireEmptyCrew) return 'crew_not_empty';
          // A crewId appeared between the caller's read and this delete. NOTHING was deleted — both-or-neither holds — so the
          // caller re-reads and takes the atomic delete-and-release path.
          if (requireNoCrewId) return 'crew_appeared';
        }
        const claimRefused = (reasons ?? [])
          .slice(1, 1 + claimKeys.length)
          .some((r) => r.Code === 'ConditionalCheckFailed');
        // The recovery item (last, when hinted) refused alone: the row was
        // re-minted for a different device. Nothing committed; drop the hint
        // and re-run the transaction whole — bounded, because the item is
        // simply omitted the second time.
        if (
          !claimRefused &&
          recoveryKey !== undefined &&
          (reasons ?? [])[1 + claimKeys.length]?.Code === 'ConditionalCheckFailed'
        ) {
          recoveryKey = undefined;
          continue;
        }
        if (!claimRefused) throw err;
        // The claim is tombstoned and must stay. Delete the user row alone —
        // still under the crew condition when the guard is up: this retry IS
        // the read-then-delete gap again, just narrower, and an adopt landing
        // in it would orphan its crew exactly as one landing before the
        // transaction would.
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.users,
              Key: { userId },
              ...(requireEmptyCrew ? emptyCrewCondition : {}),
            }),
          );
        } catch (fallbackErr) {
          if (errName(fallbackErr) === 'ConditionalCheckFailedException') {
            if (requireEmptyCrew) return 'crew_not_empty';
            if (requireNoCrewId) return 'crew_appeared';
          }
          throw fallbackErr;
        }
        // The fallback path lost the transaction's atomicity for the claim;
        // the hinted recovery row still goes, as the same conditional shape
        // the fused item carries (best-effort here — the purge backstop and
        // the group verbs remain the idempotent re-drivers).
        if (recoveryKey !== undefined) {
          try {
            await doc.send(
              new DeleteCommand({
                TableName: TABLES.users,
                Key: { userId: recoveryKey },
                ConditionExpression: 'kind = :rk AND newUserId = :ru',
                ExpressionAttributeValues: { ':rk': 'recoveryPending', ':ru': userId },
              }),
            );
          } catch (recErr) {
            if (errName(recErr) !== 'ConditionalCheckFailedException') throw recErr;
          }
        }
      }
      return 'deleted';
      }
      return 'deleted';
    },

    async deleteOneTimePrekeys(userId) {
      const keyIds = await listOneTimePrekeyIds(doc, userId);
      await chunkedBatchWrite(
        doc,
        TABLES.prekeys,
        keyIds.map((keyId) => ({ DeleteRequest: { Key: { userId, keyId } } })),
      );
    },

    async deleteSession(token) {
      await doc.send(
        new DeleteCommand({ TableName: TABLES.sessions, Key: { token: sessionKey(token) } }),
      );
    },

    async deleteSessionsForUser(userId, exceptToken) {
      const spared = exceptToken === undefined ? undefined : sessionKey(exceptToken);
      const keys: string[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            TableName: TABLES.sessions,
            IndexName: SESSIONS_USER_INDEX,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
            // Keys-only: the index projects nothing else, and a session row is
            // a credential we have no reason to read in order to delete.
            ProjectionExpression: '#t',
            ExpressionAttributeNames: { '#t': 'token' },
            ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
          }),
        );
        for (const item of page.Items ?? []) {
          const key = item.token as string;
          if (key !== spared) keys.push(key);
        }
        lastKey = page.LastEvaluatedKey;
      } while (lastKey);

      if (keys.length > 0) {
        await chunkedBatchWrite(
          doc,
          TABLES.sessions,
          keys.map((token) => ({ DeleteRequest: { Key: { token } } })),
        );
      }
      return keys.length;
    },

    async purgeQueuedMessages(recipientId) {
      // Page through the queue keys-only and batch-delete; ciphertext never
      // needs to be read to be destroyed.
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await doc.send(
          new QueryCommand({
            TableName: TABLES.messages,
            KeyConditionExpression: 'recipientId = :r',
            ExpressionAttributeValues: { ':r': recipientId },
            ProjectionExpression: 'recipientId, msgId',
            ExclusiveStartKey: lastKey,
          }),
        );
        await chunkedBatchWrite(
          doc,
          TABLES.messages,
          (res.Items ?? []).map((item) => ({
            DeleteRequest: { Key: { recipientId, msgId: item.msgId } },
          })),
        );
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
    },

    async getOrCreateUserByIdentityKey(identityKeyPub, candidateUserId, createdAtMs, accountClass) {
      const claimKey = idkeyClaimKey(identityKeyPub);
      try {
        // User row + identity-key claim written together; either both land or
        // neither. The property wanted is exactly one account per identity
        // key, and it is held by a base-table conditional write rather than by
        // an index — an index over account identifiers is the enumeration
        // primitive this whole plan exists to delete.
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: TABLES.users,
                  // identityKeyPub is set AT BIRTH, in the same transaction as
                  // the claim. This is what actually closes and it is
                  // stronger than checking an upload: without it the fresh row
                  // has no identityKeyPub, so `storeKeys`'s
                  // `attribute_not_exists(identityKeyPub)` branch would let a
                  // stolen token publish a DIFFERENT key — leaving the claim
                  // saying one key and the row advertising another, which is
                  // exactly the split state the immutability rule forbids.
                  // Written together, the two can never disagree.
                  Item: {
                    userId: candidateUserId,
                    identityKeyPub,
                    createdAt: createdAtMs,
                    // Class is written at birth or never — the resolution path below never touches it.
                    ...(accountClass ? { accountClass } : {}),
                  },
                  ConditionExpression: 'attribute_not_exists(userId)',
                },
              },
              {
                Put: {
                  TableName: TABLES.users,
                  Item: {
                    userId: claimKey,
                    claimedUserId: candidateUserId,
                    createdAt: createdAtMs,
                  },
                  // A tombstoned claim must also refuse this Put: the delete
                  // path keeps the claim row precisely so a revoked key cannot
                  // re-mint through the "row gone, claim gone" branch.
                  ConditionExpression: 'attribute_not_exists(userId)',
                },
              },
            ],
          }),
        );
        return {
          kind: 'ok',
          user: {
            userId: candidateUserId,
            identityKeyPub,
            createdAt: createdAtMs,
            ...(accountClass ? { accountClass } : {}),
          },
          created: true,
        };
      } catch (err) {
        const name = errName(err);
        if (name !== 'TransactionCanceledException' && name !== 'ConditionalCheckFailedException') {
          throw err;
        }
        // Key already claimed: resolve the existing account (strongly
        // consistent, so a claim written microseconds ago is visible).
        const claim = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: claimKey },
            ConsistentRead: true,
          }),
        );
        // Tombstone check FIRST: a revoked integration's user row is deleted
        // but its claim row is kept exactly so this key answers "revoked",
        // not "conflict" — and above all not "fresh account".
        if (claim.Item?.tombstoned === true) return { kind: 'tombstoned' };
        const existingId = claim.Item?.claimedUserId as string | undefined;
        if (existingId) {
          const existing = await doc.send(
            new GetCommand({
              TableName: TABLES.users,
              Key: { userId: existingId },
              ConsistentRead: true,
            }),
          );
          if (existing.Item) {
            return { kind: 'ok', user: existing.Item as UserRecord, created: false };
          }
          // Claim resolves but the user row is gone — only reachable through a
          // partially-failed deletion. Report it rather than deleting the claim
          // and recreating: a lost race there would mint a SECOND account for
          // one key, destroying the exact invariant the claim row exists for.
          return { kind: 'conflict' };
        }
        throw err;
      }
    },

    async bindIntegrationOwner(integrationUserId, ownerUserId) {
      // ONE TransactWrite: the write-once bind
      // beside a ConditionCheck that the OWNER row is live at commit. The
      // handler's owner read is UX — a revoke or account deletion committing
      // between that read and this write would otherwise mint a binding to a
      // tombstoned or deleted ULID (a stolen device re-acquiring an agent the
      // roster transaction just cut off; "the bound ULID is either
      // alive… or its bindings died" holds only if a dead ULID can never
      // GAIN a binding either).
      const reasons = await sendRosterTransact(doc, [
        {
          Update: {
            TableName: TABLES.users,
            Key: { userId: integrationUserId },
            UpdateExpression: 'SET ownerUserId = :owner',
            // Write-once, integration-only: the row must exist, be
            // integration-class, and either have no owner yet or already
            // have exactly this one (idempotent retry).
            ConditionExpression:
              'attribute_exists(userId) AND accountClass = :int AND ' +
              '(attribute_not_exists(ownerUserId) OR ownerUserId = :owner)',
            ExpressionAttributeValues: { ':owner': ownerUserId, ':int': 'integration' },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: ownerUserId },
            ConditionExpression: 'attribute_exists(userId) AND attribute_not_exists(tombstoned)',
          },
        },
      ]);
      if (!reasons) return 'bound';
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        // One read to say WHICH invariant refused the write.
        const row = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: integrationUserId },
            ConsistentRead: true,
          }),
        );
        const user = row.Item as UserRecord | undefined;
        if (!user || user.accountClass !== 'integration') return 'not_integration';
        if (user.ownerUserId === ownerUserId) return 'already';
        return 'owner_conflict';
      }
      // Only the owner-liveness check refused: dead or missing owner — the
      // handler answers the same 404 a never-existing owner draws.
      return 'unknown_owner';
    },

    async adoptCrewMember(ownerUserId, memberUserId, mintCrewId) {
      // THE INVARIANT: a member's crewId is always its owner's crewId. Every
      // later phase's security argument rests on that equality — the send
      // and inbox predicates are nothing more than it.
      // The owner's crewId is read BEFORE the transaction so the member is
      // stamped with a stable:crew value; when the owner has none yet the
      // server-minted candidate is used, and the `if_not_exists` inside the
      // transaction keeps the owner write idempotent.
      const ownerRead = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: ownerUserId },
          ConsistentRead: true,
        }),
      );
      let ownerRow = ownerRead.Item as UserRecord | undefined;
      let crewId = ownerRow?.crewId ?? mintCrewId;
      // Attempt 0, plus AT MOST one retry when a pin below reveals the
      // pre-read went stale. Bounded, never a loop: a second pin conflict is
      // genuine contention and is reported, not chased.
      for (let attempt = 0; ; attempt++) {
        // THE PER-GROUP CAP: a grouped owner's 8
        // slots are the GROUP's, summed fresh from every member's own
        // `crewCount` — never a stored aggregate that could rot apart from
        // its source (per-ULID counters also ride each member through
        // unlink, which is the binding fate for free). The transaction
        // pins the group epoch + the owner's membership (a ConditionCheck)
        // and every SIBLING's count (more ConditionChecks; the owner's own
        // count pins on its own Update item), so the committed state
        // provably satisfied sum + 1 <= cap: a concurrent sibling adopt or
        // roster change cancels this one instead of slipping past the sum.
        // An owner whose groupId no longer resolves (removal committed
        // between the two reads) is genuinely solo — the fall-through is
        // correct, not lenient: its row-level cap condition still holds.
        // NOT flag-gated: caps are enforcement, and a
        // kill switch must not hand an existing group 3x the slots.
        let groupPin:
          | {
              epoch: number;
              ownerCrew: number | undefined;
              siblings: Array<{ userId: string; crew: number | undefined }>;
            }
          | undefined;
        if (ownerRow?.groupId !== undefined) {
          const groupRes = await doc.send(
            new GetCommand({
              TableName: TABLES.users,
              Key: { userId: groupRowKey(ownerRow.groupId) },
              ConsistentRead: true,
            }),
          );
          const groupItem = groupRes.Item;
          const members = (groupItem?.members ?? []) as AccountGroupMember[];
          if (groupItem && members.some((m) => m.userId === ownerUserId)) {
            const siblings: Array<{ userId: string; crew: number | undefined }> = [];
            let total = ownerRow.crewCount ?? 0;
            for (const member of members) {
              if (member.userId === ownerUserId) continue;
              const sibRes = await doc.send(
                new GetCommand({
                  TableName: TABLES.users,
                  Key: { userId: member.userId },
                  ConsistentRead: true,
                }),
              );
              const crew = (sibRes.Item as UserRecord | undefined)?.crewCount;
              siblings.push({ userId: member.userId, crew });
              total += crew ?? 0;
            }
            // The precheck half — UX for the caller; the pins below are what
            // make the refusal atomic (the discipline: the precheck is
            // UX, the condition is the authorization — here the pins ARE the
            // condition, because a commit under unmoved pins is a commit
            // under this very sum).
            if (total >= CREW_MAX_MEMBERS) return 'cap_reached';
            groupPin = {
              epoch: groupItem.epoch as number,
              ownerCrew: ownerRow.crewCount,
              siblings,
            };
          }
        }
        // A count pin: absent-at-read must still be absent, present-at-read
        // must still equal its read value. `crewCount` only ever moves by
        // ADD, so equality is the whole pin (0 and absent both pin exactly).
        const countPin = (value: number | undefined, name: string): string =>
          value === undefined ? 'attribute_not_exists(crewCount)' : `crewCount = ${name}`;
        try {
          // One transaction, both rows or neither: a member must never carry
          // a crewId no owner's slot was taken for, and a slot must never be
          // taken for a member the write refused.
          await doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: TABLES.users,
                    Key: { userId: ownerUserId },
                    UpdateExpression:
                      'SET crewId = if_not_exists(crewId, :new) ADD crewCount :one',
                    // The owner must exist, be HUMAN — attribute_not_exists(
                    // accountClass) is injectable-node rule enforced in
                    // the condition rather than a handler branch — hold a
                    // slot under the cap (the cap lives HERE, not in a
                    // handler read, so two concurrent adopts cannot both
                    // pass it) — and still be in
                    // the crew the pre-read saw. The crewId PIN is what
                    // upholds the invariant: without it, two concurrent
                    // FIRST adopts each pre-read "no crewId" and mint
                    // different candidates, and the loser's owner update
                    // no-ops through if_not_exists while its member update
                    // still stamps the stale candidate — a member stranded
                    // in a crew its owner is not in. A GROUPED owner's item
                    // additionally pins its own crewCount at the read value
                    //the sibling pins cover the rest of the sum.
                    ConditionExpression:
                      'attribute_exists(userId) AND attribute_not_exists(accountClass) AND ' +
                      '(attribute_not_exists(crewCount) OR crewCount < :cap) AND ' +
                      '(attribute_not_exists(crewId) OR crewId = :new)' +
                      (groupPin ? ` AND (${countPin(groupPin.ownerCrew, ':ownerCrew')})` : ''),
                    ExpressionAttributeValues: {
                      ':new': crewId,
                      ':one': 1,
                      ':cap': CREW_MAX_MEMBERS,
                      ...(groupPin && groupPin.ownerCrew !== undefined
                        ? { ':ownerCrew': groupPin.ownerCrew }
                        : {}),
                    },
                  },
                },
                {
                  Update: {
                    TableName: TABLES.users,
                    Key: { userId: memberUserId },
                    UpdateExpression: 'SET crewId = :crew',
                    // The member must exist, be integration-class, be ALREADY
                    // PAIRED TO THIS OWNER, and be in no crew at all.
                    // "Already paired" is load-bearing, and its previous
                    // shape — `attribute_not_exists(ownerUserId) OR
                    // ownerUserId =:owner`, "unowned or already this
                    // owner's" — was an account-theft primitive: adoption of
                    // an UNPAIRED integration CLAIMED it, assigning
                    // ownerUserId to whoever adopted first, and the intended
                    // owner's later bind then failed owner_conflict forever.
                    // Binding is the INTEGRATION's call and write-once
                    // (integrations.ts); adoption must never substitute for
                    // it, so this update no longer touches ownerUserId at
                    // all — it can only tag a crew onto a pairing that
                    // already names this caller.
                    // attribute_not_exists(crewId) is what makes a racing
                    // second adopt of the same member fail rather than
                    // double-count the owner's slot.
                    ConditionExpression:
                      'attribute_exists(userId) AND accountClass = :int AND ' +
                      'ownerUserId = :owner AND ' +
                      'attribute_not_exists(crewId)',
                    ExpressionAttributeValues: {
                      ':owner': ownerUserId,
                      ':crew': crewId,
                      ':int': 'integration',
                    },
                  },
                },
                // The group pins (items 2..N, present only for a grouped
                // owner): the roster still at the epoch the sum was taken
                // over with the owner still a member, and every sibling's
                // count still at its read value. A ConditionCheck reads one
                // row inside the transaction and can mutate nothing — the
                // enqueue-tombstone precedent.
                ...(groupPin
                  ? ([
                      {
                        ConditionCheck: {
                          TableName: TABLES.users,
                          Key: { userId: groupRowKey(ownerRow!.groupId!) },
                          ConditionExpression:
                            'attribute_exists(userId) AND epoch = :gEpoch AND contains(memberIds, :ownerId)',
                          ExpressionAttributeValues: {
                            ':gEpoch': groupPin.epoch,
                            ':ownerId': ownerUserId,
                          },
                        },
                      },
                      ...groupPin.siblings.map(
                        (sibling, i): TransactItem => ({
                          ConditionCheck: {
                            TableName: TABLES.users,
                            Key: { userId: sibling.userId },
                            ConditionExpression: countPin(sibling.crew, `:sib${i}`),
                            ...(sibling.crew !== undefined
                              ? { ExpressionAttributeValues: { [`:sib${i}`]: sibling.crew } }
                              : {}),
                          },
                        }),
                      ),
                    ] as TransactItem[])
                  : []),
              ],
            }),
          );
          return 'adopted';
        } catch (err) {
          if (errName(err) !== 'TransactionCanceledException') throw err;
          // The reasons must be read, not assumed — DynamoDB raises the same
          // exception for TransactionConflict and throttling, and mapping
          // those to a terminal outcome repeats the deleteUser defect
          // above. Item 0 is the owner update, item 1 the member update.
          const reasons = (err as { CancellationReasons?: { Code?: string }[] })
            .CancellationReasons ?? [];
          const ownerRefused = reasons[0]?.Code === 'ConditionalCheckFailed';
          const memberRefused = reasons[1]?.Code === 'ConditionalCheckFailed';
          // Items 2..N are the group pins: epoch/membership or a sibling
          // count moved after the sum was taken — transient, retried once.
          const pinRefused = reasons
            .slice(2)
            .some((r) => r?.Code === 'ConditionalCheckFailed');
          if (!ownerRefused && !memberRefused && !pinRefused) throw err;
          // The owner is read FIRST when it refused — not for outcome
          // precedence (member-first still wins below) but because a pin
          // refusal means every comparison in this round was made against a
          // crewId that is no longer the owner's, member disambiguation
          // included. The retry re-runs the whole adopt against the crew
          // that actually won, and its second round reports truthfully.
          let ownerOutcome: 'unknown_owner' | 'cap_reached' | undefined;
          if (ownerRefused) {
            const row = await doc.send(
              new GetCommand({
                TableName: TABLES.users,
                Key: { userId: ownerUserId },
                ConsistentRead: true,
              }),
            );
            const owner = row.Item as UserRecord | undefined;
            if (!owner || owner.accountClass !== undefined) {
              // Missing, or integration-class: not a valid crew owner. ONE
              // outcome for both — an integration can never be an admission
              // authority so as an owner the id simply does
              // not resolve, and the two cases are not worth an oracle that
              // distinguishes them.
              ownerOutcome = 'unknown_owner';
            } else if (owner.crewId !== undefined && owner.crewId !== crewId) {
              // The pin refused: a concurrent adopt won the mint between the
              // pre-read and the transaction. Once, adopt the winner's crew
              // and retry; twice, report honest contention — retryable by
              // the caller, never silently mapped onto a terminal outcome.
              if (attempt > 0) return 'crew_contended';
              ownerRow = owner;
              crewId = owner.crewId;
              continue;
            } else if (groupPin !== undefined && owner.crewCount !== groupPin.ownerCrew) {
              // The own-count pin refused: a concurrent adopt on THIS
              // member ULID moved the count after the group sum was taken.
              // Same bounded-retry rule as the crewId pin — the next round
              // re-sums against the count that actually won.
              if (attempt > 0) return 'crew_contended';
              ownerRow = owner;
              crewId = owner.crewId ?? crewId;
              continue;
            } else {
              ownerOutcome = 'cap_reached';
            }
          }
          // MEMBER-side outcomes take precedence. When BOTH items refuse —
          // the idempotent re-adopt of an existing member by an owner
          // sitting at the cap — the member's answer ('already') is the
          // truthful one; owner-first would report 'cap_reached' for an
          // adopt that needs no slot because it already happened.
          if (memberRefused) {
            // One read to say WHICH member invariant refused.
            const row = await doc.send(
              new GetCommand({
                TableName: TABLES.users,
                Key: { userId: memberUserId },
                ConsistentRead: true,
              }),
            );
            const member = row.Item as UserRecord | undefined;
            if (!member || member.accountClass !== 'integration') return 'not_integration';
            if (member.crewId !== undefined) {
              // Already in THIS crew under THIS owner: the idempotent retry,
              // and the refusal is what kept it from double-counting the slot.
              return member.crewId === crewId && member.ownerUserId === ownerUserId
                ? 'already'
                : 'crew_conflict';
            }
            if (member.ownerUserId === undefined) {
              // UNPAIRED. Terminal, not a race: adoption never claims (the
              // previous condition
              // assigned ownerUserId to whoever adopted first, and the true
              // owner's later bind then failed owner_conflict forever).
              // Binding is the integration's own write-once call. The same
              // collapsed refusal as bound-to-someone-else, because "not an
              // integration you own" is the truth in both and a distinct
              // answer would be the ownership oracle the handler refuses to
              // be.
              return 'owner_conflict';
            }
            if (member.ownerUserId !== ownerUserId) {
              return 'owner_conflict';
            }
            // Refused at write time, adoptable at read time: a race resolved
            // underneath us. Fall through to the owner's refusal if it has
            // one (or to an pin retry); otherwise propagate so the
            // caller retries the whole adopt.
            if (ownerOutcome === undefined && !pinRefused) throw err;
          }
          if (ownerOutcome !== undefined) return ownerOutcome;
          if (pinRefused) {
            // A group pin alone refused (epoch/membership moved, or a sibling
            // adopted concurrently). Once, re-read and re-sum; twice, honest
            // contention — the crewId-pin rule.
            if (attempt > 0) return 'crew_contended';
            const row = await doc.send(
              new GetCommand({
                TableName: TABLES.users,
                Key: { userId: ownerUserId },
                ConsistentRead: true,
              }),
            );
            ownerRow = row.Item as UserRecord | undefined;
            crewId = ownerRow?.crewId ?? crewId;
            continue;
          }
          throw err;
        }
      }
    },

    async releaseCrewSlot(ownerUserId) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.users,
            Key: { userId: ownerUserId },
            UpdateExpression: 'ADD crewCount :minusOne',
            // BOTH halves are load-bearing. `ADD` on a MISSING item creates
            // it, so without attribute_exists a release against a deleted
            // owner mints a ghost user row holding nothing but crewCount = -1;
            // and crewCount > :zero keeps a crash-retried teardown's double
            // release parked at zero instead of banking negative slots.
            ConditionExpression: 'attribute_exists(userId) AND crewCount > :zero',
            ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
          }),
        );
      } catch (err) {
        // Owner gone, count already zero, or never counted: the slot is as
        // released as it is ever going to be. Idempotent no-op by contract —
        // teardown re-runs this on retry.
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      }
    },

    async deleteCrewMemberAndReleaseSlot(memberUserId, ownerUserId) {
      // One transaction, delete + decrement or neither. The `attribute_exists` on the DELETE is the whole
      // fix: it is what makes a second concurrent
      // teardown of the same member cancel instead of decrementing again —
      // exactly-once by construction, where ordering could only choose which
      // failure to accept. No claim leg: a crew member is integration-class,
      // and its (tombstoned-on-revoke) claim row deliberately survives the
      // user row.
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: TABLES.users,
                  Key: { userId: memberUserId },
                  ConditionExpression: 'attribute_exists(userId)',
                },
              },
              {
                Update: {
                  TableName: TABLES.users,
                  Key: { userId: ownerUserId },
                  UpdateExpression: 'ADD crewCount :minusOne',
                  // Same two guards as releaseCrewSlot, and both still
                  // load-bearing: ADD on a missing item would mint a ghost
                  // owner row at -1, and crewCount > 0 keeps drifted state
                  // from banking negative slots.
                  ConditionExpression: 'attribute_exists(userId) AND crewCount > :zero',
                  ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
                },
              },
            ],
          }),
        );
      } catch (err) {
        if (errName(err) !== 'TransactionCanceledException') throw err;
        // Read the reasons, never assume them (the deleteUser lesson): the
        // same exception covers TransactionConflict and throttling, which must
        // propagate so the caller retries the idempotent teardown. Item 0 is
        // the member delete, item 1 the owner update.
        const reasons =
          (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
        const memberRefused = reasons[0]?.Code === 'ConditionalCheckFailed';
        const ownerRefused = reasons[1]?.Code === 'ConditionalCheckFailed';
        if (memberRefused) {
          // The member row is already gone: a concurrent teardown's
          // transaction deleted it AND took the one release. Nothing left to
          // delete, nothing further to release — returning without a
          // decrement IS the fix.
          return;
        }
        if (ownerRefused) {
          // Member present, owner unreleasable (row gone, or count already
          // 0). The teardown still owes the row's deletion; the slot release
          // is moot — there is no held slot to give back, and decrementing
          // anyway would be the widening direction.
          await doc.send(
            new DeleteCommand({ TableName: TABLES.users, Key: { userId: memberUserId } }),
          );
          return;
        }
        throw err;
      }
    },

    async tombstoneIdentityKey(identityKeyPub) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.users,
            Key: { userId: idkeyClaimKey(identityKeyPub) },
            UpdateExpression: 'SET tombstoned = :true',
            // Only an EXISTING claim can be tombstoned — this must never mint
            // a bare tombstone row for a key that was never registered.
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':true': true },
          }),
        );
      } catch (err) {
        // No claim row: nothing to revoke; idempotent no-op by contract.
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      }
    },

    async getUserByIdentityKeyClaim(identityKeyPub) {
      const claim = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: idkeyClaimKey(identityKeyPub) },
          ConsistentRead: true,
        }),
      );
      const claimedUserId = claim.Item?.claimedUserId as string | undefined;
      if (!claimedUserId) return undefined;
      const user = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: claimedUserId },
          ConsistentRead: true,
        }),
      );
      return user.Item as UserRecord | undefined;
    },

    async putAuthChallenge(rec) {
      // Unconditional Put onto a key that already binds THIS nonce: writing a
      // fresh challenge can only ever create its own row, never overwrite a
      // sibling's. (Keyed by identity key alone, this Put was the overwrite an
      // attacker could aim at anyone's in-flight sign-in.) Rows self-expire
      // via TTL two minutes out, and issuance is per-IP rate limited, so the
      // coexistence is bounded.
      //
      // NO `userId` ATTRIBUTE ON THIS ROW. The sessions table's user-index is
      // keyed on userId, so adding one would put challenges in that index and
      // `deleteSessionsForUser` would batch-delete them on every sign-in.
      await doc.send(
        new PutCommand({
          TableName: TABLES.sessions,
          Item: {
            token: authChallengeKey(rec.identityKeyPub, rec.challenge),
            kind: 'authChallenge',
            identityKeyPub: rec.identityKeyPub,
            challenge: rec.challenge,
            expiresAt: rec.expiresAt,
          },
        }),
      );
    },

    async getAuthChallenge(identityKeyPub, challenge) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.sessions,
          Key: { token: authChallengeKey(identityKeyPub, challenge) },
        }),
      );
      const item = res.Item;
      if (!item || item.kind !== 'authChallenge') return undefined;
      return {
        identityKeyPub: item.identityKeyPub as string,
        challenge: item.challenge as string,
        expiresAt: item.expiresAt as number,
      };
    },

    async consumeAuthChallengeIfMatches(identityKeyPub, challenge) {
      try {
        // Atomic single-use. Read-then-delete would let two concurrent auths
        // both pass the read and both proceed; the conditional delete means
        // exactly one wins and the loser is indistinguishable from a replay.
        // The condition re-checks kind and challenge even though the digest
        // key already binds them — every reader of this namespace checks the
        // attributes rather than trusting key shape alone.
        await doc.send(
          new DeleteCommand({
            TableName: TABLES.sessions,
            Key: { token: authChallengeKey(identityKeyPub, challenge) },
            ConditionExpression: 'kind = :k AND challenge = :c',
            ExpressionAttributeValues: { ':k': 'authChallenge', ':c': challenge },
          }),
        );
        return true;
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    async putWsTicket(rec) {
      await doc.send(
        new PutCommand({
          TableName: TABLES.sessions,
          Item: {
            token: wsTicketKey(rec.ticket),
            kind: 'wsTicket',
            // DELIBERATELY `ticketUserId` AND NOT `userId`. The sessions table's
            // user-index is partitioned on `userId`, so naming it that would put
            // every live ticket into that index — where `deleteSessionsForUser`
            // would batch-delete them on any sign-in, and count them as revoked
            // sessions while it did. The same trap the auth-challenge row avoids
            // by carrying no userId at all; this row needs one, so it hides.
            ticketUserId: rec.userId,
            ticketRole: rec.role,
            // The minting session's digest carried so the socket this
            // ticket opens can be bound to that session. Omitted, never a null:
            // a row without it authorizes a socket that is simply not
            // session-revocable — the earlier status quo.
            ...(rec.sessionDigest !== undefined ? { ticketSessionDigest: rec.sessionDigest } : {}),
            expiresAt: rec.expiresAt,
          },
        }),
      );
    },

    async consumeWsTicket(ticket, nowSeconds) {
      let spent;
      try {
        // Conditional delete with ReturnValues: one caller wins, and the winner
        // gets the row. A read-then-delete would let two concurrent $connects
        // both pass the read.
        spent = await doc.send(
          new DeleteCommand({
            TableName: TABLES.sessions,
            Key: { token: wsTicketKey(ticket) },
            ConditionExpression: 'kind = :k',
            ExpressionAttributeValues: { ':k': 'wsTicket' },
            ReturnValues: 'ALL_OLD',
          }),
        );
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') return undefined;
        throw err;
      }
      const item = spent.Attributes;
      if (!item) return undefined;
      // Expiry is checked HERE rather than left to DynamoDB's TTL sweep, which
      // lags by up to 48 hours — an expired row is routinely still readable.
      // The row is already deleted either way, so a late ticket is spent, not
      // merely refused.
      // `<=`, not `<`: at expiresAt the ticket's sixty seconds are over. Strict
      // `<` kept it valid for the whole of its expiry second, making the real
      // lifetime up to 61s. Harmless, but the boundary should mean what the
      // constant says.
      if (typeof item.expiresAt === 'number' && item.expiresAt <= nowSeconds) return undefined;
      if (typeof item.ticketUserId !== 'string') return undefined;
      // /#3 — a ticket BOUND to a session is worthless once that session is
      // gone. Without this an attacker pre-mints a ticket, the victim signs
      // that session out, and the ticket still opens a socket as the victim
      // for the rest of its 60s life — draining the queue, claiming the
      // routing row. The ticket is already SPENT by the conditional delete
      // above (single-use whatever we decide here), so a revoked-before-spend
      // dial is REFUSED rather than admitted, and the spent ticket cannot be
      // retried. Strongly consistent, because the whole point is to observe a
      // revoke that may be seconds old. A revoke that lands AFTER this read
      // (truly concurrent with the dial) is caught by the $default session
      // recheck and the proactive disconnect, exactly as a mid-session revoke
      // already is (session-guard.ts, session-revoke.ts). A ticket with NO
      // bound digest predates digest binding and stays ungated — the status quo for a
      // credential that cannot be matched to a session.
      if (typeof item.ticketSessionDigest === 'string') {
        const sess = await doc.send(
          new GetCommand({
            TableName: TABLES.sessions,
            Key: { token: sessionKeyFromDigest(item.ticketSessionDigest) },
            ConsistentRead: true,
          }),
        );
        const srow = sess.Item;
        if (
          !srow ||
          srow.kind !== 'session' ||
          typeof srow.expiresAt !== 'number' ||
          srow.expiresAt <= nowSeconds
        ) {
          return undefined;
        }
      }
      // A row with no `ticketRole` was minted by the deploy before roles
      // existed and is still inside its sixty seconds. 'listen' is what that
      // ticket meant, and defaulting to it keeps the connect it authorises
      // behaving exactly as it did — the alternative (refuse, or silently make
      // it send-only) breaks live sockets for one deploy-minute over a field
      // whose absence is unambiguous.
      return {
        userId: item.ticketUserId,
        role: item.ticketRole === 'send' ? 'send' : 'listen',
        ...(typeof item.ticketSessionDigest === 'string'
          ? { sessionDigest: item.ticketSessionDigest }
          : {}),
      };
    },

    async storeKeys(userId, core, oneTimePrekeys) {
      // Set identity/signed/kyber prekey on the user row (must exist).
      // THE IDENTITY KEY IS IMMUTABLE. This
      // condition is the whole reason the keypair account model holds:
      // - Without it a stolen bearer token still owns the account outright —
      // the attacker uploads their own identity key and peers see nothing
      // but a safety-number change, which is the last line, not a lock.
      // - The `idkey#` claim row would rot: after a rotation the claim points
      // at the OLD key, so whoever holds that key keeps minting sessions
      // while the key peers actually pin cannot.
      // - Deletion would orphan the claim, because `deleteUser` keys it off
      // the current `identityKeyPub`.
      // So: the first upload sets the key, an identical re-upload (reinstall,
      // retry) is allowed through, and a DIFFERENT key is refused. Rotation is
      // not a supported operation — a new key is a new account, which is what
      // "the keypair is the identity" actually means.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.users,
            Key: { userId },
            UpdateExpression:
              'SET registrationId = :r, identityKeyPub = :ik, signedPrekey = :sp, kyberPrekey = :kp',
            ExpressionAttributeValues: {
              ':r': core.registrationId,
              ':ik': core.identityKeyPub,
              ':sp': core.signedPrekey,
              ':kp': core.kyberPrekey,
            },
            ConditionExpression:
              'attribute_exists(userId) AND (attribute_not_exists(identityKeyPub) OR identityKeyPub = :ik)',
          }),
        );
      } catch (err) {
        // Reported rather than thrown so the handler can answer 4xx: an
        // attempted rotation is a client error, not a server fault, and the
        // adapter's generic 500 would say nothing useful.
        if (errName(err) === 'ConditionalCheckFailedException') return false;
        throw err;
      }

      // Replace the pool: delete any prekeys from a prior identity first, so a
      // re-upload after reinstall never serves a stale prekey under the new key.
      const stale = await listOneTimePrekeyIds(doc, userId);
      await chunkedBatchWrite(
        doc,
        TABLES.prekeys,
        stale.map((keyId) => ({ DeleteRequest: { Key: { userId, keyId } } })),
      );

      // Dedupe by keyId (a duplicate keyId in one BatchWrite request is a hard
      // ValidationException), then write with UnprocessedItems retry.
      const byKeyId = new Map<number, OneTimePrekey>();
      for (const pk of oneTimePrekeys) byKeyId.set(pk.keyId, pk);
      await chunkedBatchWrite(
        doc,
        TABLES.prekeys,
        [...byKeyId.values()].map((pk) => ({
          PutRequest: { Item: { userId, keyId: pk.keyId, pub: pk.pub } },
        })),
      );
      return true;
    },

    async consumeOneTimePrekey(userId) {
      // Correctness under concurrency comes from the conditional DeleteItem:
      // if a racing request already took a candidate, the condition fails and we
      // try the next one. No one-time prekey is ever handed out twice.
      for (let outer = 0; outer < 50; outer++) {
        const res = await doc.send(
          new QueryCommand({
            TableName: TABLES.prekeys,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
            // Strong read: an eventually-consistent empty result must not be
            // mistaken for an empty pool while keys still exist.
            ConsistentRead: true,
            Limit: 10,
          }),
        );
        const candidates = res.Items ?? [];
        if (candidates.length === 0) return undefined; // pool empty

        for (const candidate of candidates) {
          try {
            const del = await doc.send(
              new DeleteCommand({
                TableName: TABLES.prekeys,
                Key: { userId, keyId: candidate.keyId },
                ConditionExpression: 'attribute_exists(keyId)',
                ReturnValues: 'ALL_OLD',
              }),
            );
            if (del.Attributes) {
              return {
                keyId: del.Attributes.keyId as number,
                pub: del.Attributes.pub as string,
              };
            }
          } catch (err) {
            if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
              continue; // raced with another consumer; try the next candidate
            }
            throw err;
          }
        }
      }
      return undefined; // extreme contention only (not expected locally)
    },

    async countOneTimePrekeys(userId) {
      let count = 0;
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await doc.send(
          new QueryCommand({
            TableName: TABLES.prekeys,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
            Select: 'COUNT',
            ConsistentRead: true,
            ExclusiveStartKey: lastKey,
          }),
        );
        count += res.Count ?? 0;
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
      return count;
    },

    async putConnection(rec) {
      // The TTL backstop is stamped HERE, not by callers: every write path —
      // this one and the claim below — computes it, so a row without it cannot
      // be written and a caller-supplied `expiresAt` is overwritten by the
      // spread order (see `connectionExpiresAt`). CLAMPED to the store's own
      // clock: `connectedAt` is caller data, and a stale timestamp, a reused
      // record, or a seconds-for-millis slip must not make a row born
      // TTL-eligible while its socket lives — the bound always runs from at
      // least the moment of the write, which is when the socket provably
      // exists. A FUTURE `connectedAt` only lengthens the bound, which is the
      // safe direction (readers never consult it; a longer wait reaps late,
      // never unroutes).
      await doc.send(
        new PutCommand({
          TableName: TABLES.connections,
          Item: { ...rec, expiresAt: connectionExpiresAt(Math.max(rec.connectedAt, wallNowMs())) },
        }),
      );
    },

    async claimConnection(rec, expectedConnectionId) {
      try {
        await doc.send(
          new PutCommand({
            TableName: TABLES.connections,
            // Same store-stamped, store-clocked TTL backstop as
            // `putConnection` — see there.
            Item: { ...rec, expiresAt: connectionExpiresAt(Math.max(rec.connectedAt, wallNowMs())) },
            // The arbitration happens INSIDE the store, which is the only
            // place it can: a conditional write is evaluated against the item
            // as it is at write time, so nothing can slip between the check
            // and the put the way it can between a read and a put.
            ConditionExpression:
              expectedConnectionId === undefined
                ? 'attribute_not_exists(userId)'
                : 'attribute_not_exists(userId) OR connectionId = :expected',
            ...(expectedConnectionId === undefined
              ? {}
              : { ExpressionAttributeValues: { ':expected': expectedConnectionId } }),
          }),
        );
        return true;
      } catch (err) {
        // Superseded — someone else owns the row now. Not an error: the caller
        // is expected to stand down rather than overwrite them.
        if (errName(err) === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    async getConnection(userId) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.connections,
          Key: { userId },
          // CONSISTENT, like every other read in this file — this was the one
          // that was not, and it is the read the whole $connect arbitration is
          // built out of.
          //
          // The failure it allows: `$connect` claims the row, then re-reads it
          // microseconds later to confirm it still owns it, and an eventually
          // consistent GetItem is permitted to answer with the pre-claim state.
          // The connect then refuses itself as displaced when nothing displaced
          // it, and the client redials for no reason — or, in the recovery
          // direction, a connect that WAS displaced reads its own stale row,
          // believes it owns the route and returns 200, which is precisely the
          // live-socket-with-no-row outage the re-read exists to prevent.
          // Every recovery path here re-reads a row written microseconds
          // earlier, which is the exact interval a default read may not show.
          ConsistentRead: true,
        }),
      );
      return res.Item ? (res.Item as ConnectionRecord) : undefined;
    },

    async putPushToken(rec) {
      // Unconditional Put: a re-registration REPLACES the row. One row per
      // user, so a reinstalled app's new token must supersede the dead one.
      await doc.send(new PutCommand({ TableName: TABLES.pushTokens, Item: rec }));
    },

    async getPushToken(userId) {
      const res = await doc.send(
        new GetCommand({ TableName: TABLES.pushTokens, Key: { userId } }),
      );
      return res.Item ? (res.Item as PushTokenRecord) : undefined;
    },

    async wakeAlreadyRang(wakeId) {
      try {
        const res = await doc.send(
          new GetCommand({
            TableName: TABLES.pushTokens,
            Key: { userId: wakeKey(wakeId) },
            // STRONGLY CONSISTENT, not an optimisation. The claim is written
            // seconds before a redelivery can arrive; an eventually
            // consistent read is exactly the read that misses it.
            ConsistentRead: true,
          }),
        );
        return Boolean((res.Item as { rang?: boolean } | undefined)?.rang);
      } catch {
        // FAIL TOWARD RINGING (see the interface). Swallowed HERE, inside the
        // data layer, and not by the worker's outer catch — that catch
        // returns 'failed' and skips the send, which would turn a DynamoDB
        // blip into a missed call.
        return false;
      }
    },

    async markWakeRang(wakeId, expiresAt) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.pushTokens,
            Key: { userId: wakeKey(wakeId) },
            UpdateExpression: 'SET rang = :t, expiresAt = :e',
            ExpressionAttributeValues: { ':t': true, ':e': expiresAt },
          }),
        );
      } catch {
        // An unclaimed wake rings again if the platform redelivers it. That
        // is the safe direction, and the only one.
      }
    },

    async deletePushTokenIfMatches(userId, voipToken) {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: TABLES.pushTokens,
            Key: { userId },
            ConditionExpression: 'voipToken = :t',
            ExpressionAttributeValues: { ':t': voipToken },
          }),
        );
      } catch (err) {
        // The row changed under us — a re-registration won the race, and its
        // token is the live one. Nothing to do, and certainly nothing to
        // delete.
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
          throw err;
        }
      }
    },

    async mergePushToken(rec) {
      // ANDROID: a whole-row replace, deliberately not a merge. The iOS merge
      // below exists because two tokens land in two racing PUTs; Android has
      // ONE token so there is no half-row to protect and no stale half
      // to resurrect. The Put also makes a platform switch total in either
      // direction: an Android registration replaces an iOS row outright, and
      // an iOS registration falls through its own merge condition on an
      // Android row (no `env` attribute) into the replacing Put below —
      // either way the old platform's tokens die with the row.
      if (rec.platform === 'android') {
        await doc.send(
          new PutCommand({
            TableName: TABLES.pushTokens,
            Item: {
              userId: rec.userId,
              platform: 'android',
              ...(rec.fcmToken ? { fcmToken: rec.fcmToken } : {}),
              bundleId: rec.bundleId,
              updatedAt: rec.updatedAt,
              expiresAt: rec.expiresAt,
            },
          }),
        );
        return;
      }
      const sets = [
        '#env = :env',
        'bundleId = :b',
        'updatedAt = :u',
        'expiresAt = :x',
        ...(rec.voipToken ? ['voipToken = :v'] : []),
        ...(rec.alertToken ? ['alertToken = :a'] : []),
      ];
      try {
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.pushTokens,
            Key: { userId: rec.userId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // Merge only into a row for the SAME APNs world. The condition
            // also fails when no row exists, which the Put below handles.
            ConditionExpression: '#env = :env AND bundleId = :b',
            ExpressionAttributeNames: { '#env': 'env' },
            ExpressionAttributeValues: {
              ':env': rec.env,
              ':b': rec.bundleId,
              ':u': rec.updatedAt,
              ':x': rec.expiresAt,
              ...(rec.voipToken ? { ':v': rec.voipToken } : {}),
              ...(rec.alertToken ? { ':a': rec.alertToken } : {}),
            },
          }),
        );
        return;
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
          throw err;
        }
      }
      // First registration, or an env/bundle switch: whole-row replace, and
      // deliberately no carry — the old world's tokens die with it.
      await doc.send(
        new PutCommand({
          TableName: TABLES.pushTokens,
          Item: {
            userId: rec.userId,
            ...(rec.voipToken ? { voipToken: rec.voipToken } : {}),
            ...(rec.alertToken ? { alertToken: rec.alertToken } : {}),
            env: rec.env,
            bundleId: rec.bundleId,
            updatedAt: rec.updatedAt,
            expiresAt: rec.expiresAt,
          },
        }),
      );
    },

    async removePushTokenField(userId, field, expectedValue) {
      try {
        // REMOVE one attribute, conditional on its exact value — a rotation
        // that landed mid-flight keeps its fresh token. UpdateItem, not a
        // read-modify-write, so two concurrent prunes cannot resurrect
        // anything.
        await doc.send(
          new UpdateCommand({
            TableName: TABLES.pushTokens,
            Key: { userId },
            UpdateExpression: `REMOVE #f`,
            ConditionExpression: '#f = :t',
            ExpressionAttributeNames: { '#f': field },
            ExpressionAttributeValues: { ':t': expectedValue },
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
          throw err;
        }
        return;
      }
      // Best-effort tidy: a row with no token at all serves nothing and costs
      // a lookup per message. Conditional on every token field being absent,
      // so a concurrent registration that just added one survives.
      try {
        await doc.send(
          new DeleteCommand({
            TableName: TABLES.pushTokens,
            Key: { userId },
            ConditionExpression:
              'attribute_not_exists(voipToken) AND attribute_not_exists(alertToken) AND attribute_not_exists(fcmToken)',
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
          throw err;
        }
      }
    },

    async putReport(rec) {
      // Plain Put, no condition: the id is a fresh ULID minted per call, so
      // there is nothing to collide with and nothing to overwrite.
      await doc.send(new PutCommand({ TableName: TABLES.reports, Item: rec }));
    },

    async deletePushToken(userId) {
      // Unconditional and idempotent: logout retries, and a token APNs has
      // already rejected as gone must be removable without a read first.
      await doc.send(
        new DeleteCommand({ TableName: TABLES.pushTokens, Key: { userId } }),
      );
    },

    async deleteConnection(userId, connectionId) {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: TABLES.connections,
            Key: { userId },
            ConditionExpression: 'connectionId = :c',
            ExpressionAttributeValues: { ':c': connectionId },
          }),
        );
      } catch (err) {
        // Row absent or already replaced by a newer connection: both fine.
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    },

    async enqueueMessage(msg, opts) {
      // /S1 — refuse a NEW send that would push THIS sender past its cap
      // against THIS recipient, ATOMICALLY. The first shape of this cap was a
      // Query-count followed by an unconditional Put, and it raced: two
      // concurrent sends both counted before either wrote, and a one-item
      // limit admitted both (reproduced by the external scan, and by
      // queue.quota.atomic.integration.test.ts against this very store). The
      // count now lives in a pair-ledger item updated under a
      // ConditionExpression in the SAME TransactWriteItems as the row's Put,
      // so admission and the rows it admits cannot diverge under any
      // interleaving. Never evicts; the refusal is the newcomer's alone.
      if (isQueueControlKey(msg.msgId)) {
        throw new Error('msgId collides with the quota ledger namespace');
      }
      const newBytes = Buffer.byteLength(msg.payload, 'utf8');
      const nowSeconds = Math.floor(msg.ts / 1000);
      // Whether THIS send establishes reverse correspondence. Only a
      // user-authored frame does; automatic carriers (call.end/busy, read
      // receipts, profile syncs — `urgent` or `notify:false` at the handler)
      // still queue and count for the quota but must NOT mint a relationship
      // the user never chose. Absent opts default to establishing: the sole
      // production caller (handleSend) always classifies explicitly, and a
      // direct enqueue with no opts is test/legacy traffic keeping the prior
      // meaning.
      const establishesCorrespondence = opts?.establishesCorrespondence ?? true;
      // The group-aware quota collapse (see
      // GroupQuotaContext): absent on every per-ULID path, in which case
      // every line below reads exactly as it always did.
      const ctx = opts?.groupCtx;
      const senderScope = ctx?.senderScope ?? msg.senderId;
      const pairLedgerId = queuePairLedgerKey(senderScope);
      const rosterSize = Math.max(1, Math.floor(ctx?.recipientRosterSize ?? 1));
      /** ⌊cap/N⌋ (min 1 item / 1 byte) per member queue, so the recipient's
       * TOTAL inbound budget across N per-device queues is the 1-device
       * budget, never N× (the pinned assertion). N=1 is the identity. */
      const shareOf = (cap: number): number =>
        rosterSize > 1 ? Math.max(1, Math.floor(cap / rosterSize)) : cap;
      // The relationship classification (S2a): established senders answer to
      // the pair cap alone; unknown senders also share the stranger ceiling.
      // Advisory-read-then-transact is fine HERE because the classification
      // only picks which caps apply — the caps themselves are enforced in the
      // transaction. A status flip mid-flight misbills one message, and the
      // qUnknown flag on the row keeps release symmetric with billing.
      // ESTABLISHED now means the recipient has itself USER-AUTHORED to this
      // sender (the reverse ledger's `qEstab`), not merely that a ledger row
      // exists — that existence-only signal was mintable by the victim's own
      // automatic carriers. With group context the check walks every
      // (recipient scope key, sender member partition) — the rule that
      // linking a device never resets an established pair to stranger.
      const established = await pairEstablishedAny(
        ctx ? ctx.recipientKeys : [msg.recipientId],
        ctx ? ctx.senderMembers : [msg.senderId],
        nowSeconds,
      );
      const effItems = shareOf(
        established ? quota.items : Math.min(quota.items, quota.unknownItems),
      );
      const effBytes = shareOf(
        established ? quota.bytes : Math.min(quota.bytes, quota.unknownBytes),
      );
      const strangerTotalItems = shareOf(quota.unknownTotalItems);
      const strangerTotalBytes = shareOf(quota.unknownTotalBytes);
      // Degenerate bounds the ConditionExpression cannot express (a payload
      // alone over the byte cap; a zero item cap): refuse before writing,
      // exactly as the counting implementation did.
      if (effItems < 1 || newBytes > effBytes) throw new QueuedQuotaExceededError();
      if (!established && (strangerTotalItems < 1 || newBytes > strangerTotalBytes)) {
        throw new QueuedQuotaExceededError();
      }

      // THE GROUP ADMISSION WALK: the
      // scope collapse alone FORKED the allowance rather than collapsing it —
      // rows billed before a link (per-ULID keys) or under a larger
      // pre-transition share survived beside the fresh `#quota#<groupId>`
      // ledger, so two accounts could each fill a pair quota standalone, link,
      // and hold a third full allowance. Admission therefore sums EVERY ledger
      // this logical relationship may be billed — writer keys =
      // {senderScope} ∪ sender member ULIDs, partitions = the recipient's
      // member queues — a bounded GetItem walk (≤4 keys × ≤3 partitions, the
      // pairEstablishedAny cost shape, never a Query) — and refuses when the
      // TOTAL would exceed the ONE-account allowance. Advisory-read-then-
      // transact, deliberately: a cross-partition sum cannot be a
      // ConditionExpression, so the per-partition share below stays the
      // transactional backstop and a concurrent-legs race can overshoot by at
      // most the in-flight count — the same discipline as the classification
      // read above, priced only on grouped sends. Same-partition residue
      // (legacy writer keys in THIS partition) additionally SHRINKS the
      // transactional headroom, so that fork is refused by the
      // condition itself where one partition can express it. Residual, stated:
      // ledgers keyed by DISSOLVED groupIds from earlier link/unlink cycles
      // are not enumerable from current state and are not summed — bounded by
      // the link-ceremony rate buckets and healed by message TTL; stated here
      // rather than silently shipped.
      let txnMaxItems = effItems;
      let txnMaxBytes = effBytes;
      if (ctx) {
        const writerKeys = [...new Set([senderScope, ...ctx.senderMembers])];
        const partitions = [...new Set(ctx.recipientMembers)];
        const capTotalItems = established
          ? quota.items
          : Math.min(quota.items, quota.unknownItems);
        const capTotalBytes = established
          ? quota.bytes
          : Math.min(quota.bytes, quota.unknownBytes);
        let totalItems = 0;
        let totalBytes = 0;
        let samePartitionLegacyItems = 0;
        let samePartitionLegacyBytes = 0;
        for (const partition of partitions) {
          for (const writer of writerKeys) {
            const row = await getPairLedger(writer, partition, nowSeconds);
            if (row === undefined) continue;
            totalItems += row.qItems;
            totalBytes += row.qBytes;
            if (partition === msg.recipientId && writer !== senderScope) {
              samePartitionLegacyItems += row.qItems;
              samePartitionLegacyBytes += row.qBytes;
            }
          }
        }
        if (totalItems + 1 > capTotalItems || totalBytes + newBytes > capTotalBytes) {
          throw new QueuedQuotaExceededError();
        }
        txnMaxItems = effItems - samePartitionLegacyItems;
        txnMaxBytes = effBytes - samePartitionLegacyBytes;
        if (txnMaxItems < 1 || newBytes > txnMaxBytes) throw new QueuedQuotaExceededError();
      }

      const ledgerUpdate = (
        msgId: string,
        maxItems: number,
        maxBytes: number,
        // Stamp `qEstab` on this ledger. Set ONLY on the PAIR ledger and
        // ONLY for a user-authored send; never on the stranger aggregate. The
        // marker is sticky — once true it stays true for the row's TTL — so a
        // later automatic carrier over an already-established pair never clears
        // it, and a pair that has only ever carried automatic traffic never
        // gains it. Alongside it, `qEstabExpiresAt` carries establishment's OWN
        // expiry: also set only by a user-authored send, so
        // automatic carriers cannot renew the relationship even as they refresh
        // the general `expiresAt` below.
        markEstablished: boolean,
      ): TransactItem => ({
        Update: {
          TableName: TABLES.messages,
          Key: { recipientId: msg.recipientId, msgId },
          // The ledger's TTL rides the NEWEST expiry it has ever carried, so a
          // pair that goes quiet self-reaps with its queue (and with it the
          // correspondence signal — see hasQueuedCorrespondence). `qVer` bumps
          // on EVERY mutation so the refusal-path reconcile can
          // condition its downward reset on an unchanged version, and `qGen`
          // marks the INCARNATION: minted here iff this update
          // creates the row, immutable for the row's lifetime, so a stale
          // reset read against a reaped incarnation can never land on this
          // one.
          //
          // THE CLOCKS ARE CREATION-ONLY IN THIS TRANSACTION.
          // `SET expiresAt = :exp` unconditionally was last-committer-wins: a
          // NEWER send committing first and an OLDER in-flight send committing
          // second moved the clock BACKWARD, the row then read expired at a
          // time the correspondence was plainly live, and the legitimate
          // caller was billed to the exhausted stranger ring bucket. Max
          // semantics need the stored value, which one write expression cannot
          // read — so creation seeds the clock here and the FORWARD-only bump
          // after the commit (bumpLedgerClock) advances it, refusing any
          // regression. Same rule for the establishment's own clock.
          UpdateExpression: markEstablished
            ? 'SET expiresAt = if_not_exists(expiresAt, :exp), qGen = if_not_exists(qGen, :gen), qEstab = :estab, qEstabExpiresAt = if_not_exists(qEstabExpiresAt, :exp) ADD qItems :one, qBytes :nb, qVer :one'
            : 'SET expiresAt = if_not_exists(expiresAt, :exp), qGen = if_not_exists(qGen, :gen) ADD qItems :one, qBytes :nb, qVer :one',
          // Admission: the count AFTER this send fits both bounds. Integer
          // qItems < :maxI is qItems + 1 <= maxItems; the byte headroom is
          // precomputed (>= 0 — the oversized-payload case was refused above).
          ConditionExpression:
            'attribute_not_exists(qItems) OR (qItems < :maxI AND qBytes <= :maxBHead)',
          ExpressionAttributeValues: {
            ':exp': msg.expiresAt,
            ':one': 1,
            ':nb': newBytes,
            ':gen': randomUUID(),
            ':maxI': maxItems,
            ':maxBHead': maxBytes - newBytes,
            ...(markEstablished ? { ':estab': true } : {}),
          },
        },
      });

      // The forward-only half of the clock's max semantics,
      // run AFTER the admission transaction commits. Strictly monotonic
      // (`< :exp`), so however two in-flight sends' commits are ordered the
      // ledger keeps the NEWER instant — the memory twin's Math.max, which had
      // been masking the store's last-committer-wins. Best-effort by design:
      // the refused CCF is simply the clock already being current, and any
      // other failure (or a crash between the commit and this write) leaves
      // the clock LOW, which errs conservative on every consumer — the row
      // reads expired EARLIER than it should, correspondence under-grants,
      // TTL reaps sooner, and the quota's arbiter is the refusal-path recount
      // either way. Never left ahead of the truth, and the next enqueue's
      // bump heals the lag.
      const bumpLedgerClock = async (
        msgId: string,
        attr: 'expiresAt' | 'qEstabExpiresAt',
      ): Promise<void> => {
        try {
          await doc.send(
            new UpdateCommand({
              TableName: TABLES.messages,
              Key: { recipientId: msg.recipientId, msgId },
              UpdateExpression: `SET ${attr} = :exp`,
              // Never CREATE a ledger from a clock bump (the row may have been
              // reaped between the commit and here), and never move a clock
              // backward or touch an attribute the transaction did not seed.
              ConditionExpression: `attribute_exists(qItems) AND ${attr} < :exp`,
              ExpressionAttributeValues: { ':exp': msg.expiresAt },
            }),
          );
        } catch {
          // Clock already current, row reaped, or transient: all leave the
          // conservative state described above. qVer is deliberately NOT
          // bumped here — the clocks are not counted state, and a clock bump
          // must not invalidate a concurrent release's (qGen, qVer) binding.
        }
      };
      const bumpLedgerClocks = async (): Promise<void> => {
        await bumpLedgerClock(pairLedgerId, 'expiresAt');
        if (establishesCorrespondence) {
          await bumpLedgerClock(pairLedgerId, 'qEstabExpiresAt');
        }
        if (!established) await bumpLedgerClock(QUEUE_STRANGER_LEDGER_KEY, 'expiresAt');
      };

      const transactItems: TransactItem[] = [
        ledgerUpdate(
          pairLedgerId,
          txnMaxItems,
          txnMaxBytes,
          establishesCorrespondence,
        ),
        ...(established
          ? []
          : [
              ledgerUpdate(
                QUEUE_STRANGER_LEDGER_KEY,
                strangerTotalItems,
                strangerTotalBytes,
                false,
              ),
            ]),
        {
          Put: {
            TableName: TABLES.messages,
            // `msgBytes` so refusal-path recounts read a small projection;
            // `qUnknown` so release decrements exactly what billing added;
            // `qNonce` is the row's SERVER-minted identity —
            // `msgId` is sender-controlled and reusable the instant the row is
            // acked away, so a stale duplicate ack conditioning its delete on
            // mere existence could destroy a DIFFERENT sender's replacement
            // queued at the same id while decrementing the original sender's
            // ledger. Every release delete is conditioned on the nonce its
            // read captured; the nonce never changes and never reaches the
            // wire (drain frames are built field-by-field).
            Item: {
              ...msg,
              msgBytes: newBytes,
              qNonce: randomUUID(),
              ...(established ? {} : { qUnknown: true }),
              // The billing stamp: which pair-ledger key this row was
              // counted under, when that key is not the literal sender — so
              // release and the refusal-path recount target exactly the
              // ledger billing chose, even after the sender's roster changes.
              ...(senderScope !== msg.senderId ? { qPair: senderScope } : {}),
            },
            // A duplicate msgId must not double-count: refused here, read
            // below as the idempotent no-op it is.
            ConditionExpression: 'attribute_not_exists(recipientId)',
          },
        },
      ];
      const putIndex = transactItems.length - 1;

      // COMMIT-TIME REVOCATION ENFORCEMENT: the handler's sender/recipient tombstone prechecks
      // are UX — a revoke transaction committing between the precheck read
      // and this commit (or a stale eventually-consistent precheck read
      // resuming after it) would let a send commit FROM or TO a revoked
      // device. These ConditionCheck items make the refusal part of the SAME
      // transaction as the row and its ledgers, so once the roster/tombstone
      // TransactWrite commits, no send commits either way — the condition is
      // the authorization, under every interleaving. A MISSING user row
      // passes deliberately: existence policy belongs to the handler (tests
      // and legacy paths enqueue for rowless users), and a tombstone can
      // only exist on a row. `serverMinted` (deliverAccountsNotice only)
      // skips the SENDER side alone: revoke notices are attributed to the
      // revoked member without that device acting. A self-send carries one
      // check — two operations on one item would be rejected wholesale.
      const tombstoneCheck = (userId: string): TransactItem => ({
        ConditionCheck: {
          TableName: TABLES.users,
          Key: { userId },
          ConditionExpression:
            'attribute_not_exists(userId) OR attribute_not_exists(tombstoned) OR tombstoned <> :tomb',
          ExpressionAttributeValues: { ':tomb': true },
        },
      });
      let senderCheckIndex = -1;
      if (opts?.serverMinted !== true && msg.senderId !== msg.recipientId) {
        senderCheckIndex = transactItems.length;
        transactItems.push(tombstoneCheck(msg.senderId));
      }
      const recipientCheckIndex = transactItems.length;
      transactItems.push(tombstoneCheck(msg.recipientId));
      // COMMIT-TIME GROUP-REACH ENFORCEMENT (see
      // GroupReachPin): a send admitted by the WIDENED owner-group clause
      // commits only while BOTH the bound owner and the widened counterparty
      // are still in the authorizing roster. An amicable unlink leaves both
      // user rows live, so the tombstone checks above cannot carry this; the
      // group row's own membership set can, in the same transaction.
      let groupReachIndex = -1;
      if (opts?.groupReachPin !== undefined) {
        groupReachIndex = transactItems.length;
        transactItems.push({
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: groupRowKey(opts.groupReachPin.groupId) },
            ConditionExpression:
              'attribute_exists(userId) AND contains(memberIds, :gOwner) AND contains(memberIds, :gMember)',
            ExpressionAttributeValues: {
              ':gOwner': opts.groupReachPin.ownerUserId,
              ':gMember': opts.groupReachPin.memberUserId,
            },
          },
        });
      }

      // Bounded retries: TransactionConflict is DynamoDB serialising
      // concurrent transactions on the shared ledger items — transient by
      // definition. A quota refusal is answered IMMEDIATELY: it
      // schedules the out-of-band reconcile and throws, never paying for a
      // partition scan on the caller's clock — the synchronous
      // recount-and-retry this loop used to run was a free read-amplification
      // DoS (see reconcileLedgerSlice). A pair contended past the bound is
      // refused as over-quota rather than surfaced as a 500: the caller's
      // remedy — slow down — is the same.
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
          // Committed: advance the ledger clocks to this send's expiry where
          // it is genuinely newer. After the return path so a
          // refused send never touches a clock.
          await bumpLedgerClocks();
          return { inserted: true };
        } catch (err) {
          if (errName(err) !== 'TransactionCanceledException') throw err;
          const reasons =
            (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
          const failed = (i: number): boolean => reasons[i]?.Code === 'ConditionalCheckFailed';
          // The tombstone conditions outrank every other outcome — fail
          // CLOSED even when the duplicate-msgId condition also fired: a
          // revoked participant must never see the idempotent success.
          if (failed(senderCheckIndex)) throw new QueueParticipantTombstonedError('sender');
          if (failed(recipientCheckIndex)) throw new QueueParticipantTombstonedError('recipient');
          // The group-reach pin outranks the duplicate-msgId success for the
          // same reason the tombstones do: a send whose authorization died
          // must never see the idempotent 200.
          if (failed(groupReachIndex)) {
            throw new QueueGroupReachRevokedError(opts!.groupReachPin!.arm);
          }
          // Already queued and already counted: the idempotent-retry success —
          // but reported as NOT an insert, because the caller's
          // wake/notification budgets must be spent only by sends that stored
          // something new. Treated as success either way: an honest client
          // retrying after a dropped response must not see an error, and the
          // sender-visible response never distinguishes the two outcomes.
          if (failed(putIndex)) return { inserted: false };
          const pairFailed = failed(0);
          const strangerFailed = !established && failed(1);
          if (pairFailed || strangerFailed) {
            // Schedule the heal OUT OF BAND and refuse now. The
            // ledger may be telling the truth (genuinely full — nothing to
            // heal) or drifted HIGH over TTL-reaped rows; either way this
            // refusal must not pay for finding out. A genuinely drifted pair
            // is refused for at most the few sends it takes the leased,
            // budgeted scan to complete — never forever, and never at the
            // price of an unbounded synchronous scan per refusal.
            //
            // AWAITED: under the AWS host this is
            // the DURABLE handoff, and it must complete BEFORE this refusal
            // returns — the container may freeze the moment it does. It is
            // one queueing call (debounced per container), never the repair
            // itself, so the 429 stays immediate; and a handoff failure is
            // swallowed inside scheduleLedgerReconcile, so it can never turn
            // the refusal into a 500.
            if (pairFailed) {
              await scheduleLedgerReconcile(msg.recipientId, {
                kind: 'pair',
                // The SCOPE the refused ledger is keyed by: heal the
                // ledger that actually refused, which for a grouped sender
                // is the collapsed `#quota#<groupId>` row.
                senderId: senderScope,
              });
            }
            if (strangerFailed) {
              await scheduleLedgerReconcile(msg.recipientId, { kind: 'stranger' });
            }
            throw new QueuedQuotaExceededError();
          }
          // TransactionConflict (or a cancellation with no condition failure
          // of ours): retry the whole decision against fresh state.
        }
      }
      throw new QueuedQuotaExceededError();
    },

    async reconcileQueueLedger(recipientId, target) {
      // The worker's entry: one slice, all invariants inside the slice
      // (lease single-flight, page/wall-clock budget, never lower from an
      // incomplete scan, (qGen, qVer)-bound resume). Key and filter are
      // derived here from the discriminator — an event can never aim the
      // reconciler at an arbitrary row or carry its own filter.
      const { ledgerMsgId, filter } = reconcileTargetFacts(target);
      return reconcileLedgerSlice(recipientId, ledgerMsgId, filter);
    },

    async *listQueuedMessages(recipientId, afterMsgId) {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await doc.send(
          new QueryCommand({
            TableName: TABLES.messages,
            // Strictly above the cursor — or above the ledger namespace when
            // there is none. One range predicate is both the resume point
            // (S2b) and what keeps bookkeeping rows out of the drain (S1).
            KeyConditionExpression: 'recipientId = :r AND msgId > :after',
            ExpressionAttributeValues: {
              ':r': recipientId,
              ':after': afterMsgId ?? QUEUE_CONTROL_CEILING,
            },
            // msgId is the sort key; ULIDs sort chronologically.
            ScanIndexForward: true,
            ExclusiveStartKey: lastKey,
          }),
        );
        const page = (res.Items ?? []) as QueuedMessage[];
        if (page.length > 0) yield page;
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
    },

    async getQueuedMessage(recipientId, msgId) {
      // Ledger keys are unreachable from here for the same reason the ack's
      // delete refuses them below — a probe must never read bookkeeping.
      if (isQueueControlKey(msgId)) return undefined;
      const got = await doc.send(
        new GetCommand({
          TableName: TABLES.messages,
          Key: { recipientId, msgId },
          ConsistentRead: true,
        }),
      );
      return got.Item as QueuedMessage | undefined;
    },

    async deleteQueuedMessage(recipientId, msgId) {
      // Ledger keys are unreachable from here by construction (and by the
      // frame schema's ULID shape one layer up): an ack that could delete
      // bookkeeping would let any recipient zero a sender's count.
      if (isQueueControlKey(msgId)) return;
      // Release needs the row's billing facts (sender, size, whether it was
      // billed to the stranger aggregate). The read is not the atomicity —
      // the transaction below is: its Delete carries attribute_exists, so of
      // two concurrent acks exactly one deletes AND decrements, and the other
      // cancels whole. A crash before the transaction releases nothing and
      // deletes nothing — the ack retries; there is no state where the count
      // dropped without the row.
      const got = await doc.send(
        new GetCommand({
          TableName: TABLES.messages,
          Key: { recipientId, msgId },
          // `expiresAt` is projected too: a TTL-lagged expired row
          // may already have been EXCLUDED from the ledger by a refusal-path
          // recount, so decrementing for it would double-release below the
          // truth.
          // `qPair`: the billing stamp — the pair-ledger key this row
          // was counted under when the sender was group-collapsed. Release
          // must decrement exactly the ledger billing chose, not the one the
          // sender's CURRENT roster would choose.
          ProjectionExpression: 'senderId, msgBytes, qUnknown, expiresAt, qNonce, qPair',
          // #11 — STRONGLY CONSISTENT. Release runs the instant a client acks,
          // which for a live-delivered message is moments after the row was
          // written. An eventually-consistent read can miss that just-written
          // row, treat its absence as "already acked", and skip the release —
          // leaving the row queued AND the pair/stranger ledger charged until
          // the next reconnect or TTL. The read must see what the enqueue
          // committed.
          ConsistentRead: true,
        }),
      );
      const row = got.Item;
      if (!row) return; // already acked (or TTL-reaped): nothing to release
      const senderId = typeof row.senderId === 'string' ? row.senderId : undefined;
      // The pair-ledger key this row was BILLED under: the `qPair`
      // stamp for a group-collapsed sender, else the literal sender ULID.
      const pairScope = typeof row.qPair === 'string' ? row.qPair : senderId;
      const rowBytes = typeof row.msgBytes === 'number' ? row.msgBytes : 0;
      const billedUnknown = row.qUnknown === true;
      const nonce = typeof row.qNonce === 'string' ? row.qNonce : undefined;

      // EVERY delete this release issues (the expired-row
      // delete, the transactional delete, the contention fallback) is
      // conditioned on the server-minted nonce THIS read captured. `msgId` is
      // sender-controlled: the moment a concurrent ack frees it, a colluding
      // sender can queue a replacement at the same id, and an existence-only
      // delete would destroy that replacement while decrementing the ORIGINAL
      // sender's ledger — the victim's message lost and still charged, the
      // original ledger driven negative. A row from before the nonce existed
      // is bound by the nonce's absence instead; any post-deploy replacement
      // carries one, so the stale delete still refuses.
      const rowDeleteCondition = nonce !== undefined ? 'qNonce = :n' : 'attribute_not_exists(qNonce)';
      const rowDeleteValues = nonce !== undefined ? { ':n': nonce } : undefined;
      const deleteRowAlone = async (): Promise<void> => {
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.messages,
              Key: { recipientId, msgId },
              ConditionExpression: rowDeleteCondition,
              ...(rowDeleteValues ? { ExpressionAttributeValues: rowDeleteValues } : {}),
            }),
          );
        } catch (err) {
          // Not the row this ack read (replaced, or already gone): not ours
          // to delete, and nothing left to release.
          if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        }
      };

      // after a release empties an UNESTABLISHED pair ledger, reap
      // the row rather than leaving one zero-count control row per sender for
      // the 30-day TTL. A conditional single-item delete, so a concurrent
      // enqueue that just repopulated the pair (qItems back above zero) is
      // spared, and an ESTABLISHED pair (`qEstab` present — a real
      // user-authored correspondence) is KEPT to age via its own TTL as the
      // correspondence signal. Without this, N free Sybils each leave one
      // durable ledger row in the victim partition that account deletion must
      // then synchronously walk inside a 10 s Lambda.
      const reapEmptyUnestablishedPairLedger = async (): Promise<void> => {
        if (!pairScope) return;
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.messages,
              Key: { recipientId, msgId: queuePairLedgerKey(pairScope) },
              ConditionExpression: 'qItems = :zero AND attribute_not_exists(qEstab)',
              ExpressionAttributeValues: { ':zero': 0 },
            }),
          );
        } catch (err) {
          // Not empty, established, or already gone: leave it.
          if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        }
      };

      // The release decision loop. EVERY attempt re-decides from scratch —
      // the expiry classification against a FRESH clock, and the ledger
      // decrements against a FRESH consistent read of each ledger — and the
      // transaction is BOUND to exactly what that attempt observed
      //. The previous shape read the row once, chose
      // "live → decrement" once, and committed on mere existence: an ack that
      // decided just before the expiry boundary could then land AFTER a
      // refusal-path reconcile had already excluded the row and admitted a
      // successor, decrementing a ledger that no longer counted it — the cap
      // defeated from below. Now any ledger mutation between an attempt's
      // read and its commit (that reconcile's reset, a concurrent release, an
      // enqueue) fails the (qGen, qVer) binding and the WHOLE decision is
      // re-made — at which point the row re-reads as expired and takes the
      // no-decrement path.
      for (let attempt = 0; attempt < 6; attempt++) {
        // an EXPIRED row (past its TTL, not yet reaped) may
        // already have been dropped from the ledger by a refusal-path recount,
        // which filters `expiresAt > now`. Decrementing for it would take the
        // ledger BELOW the live truth — a defeated cap. Delete the physical
        // row WITHOUT touching any ledger: the safe drift direction is UP (a
        // stale count the refusal path reconciles away, and the ledger's own
        // TTL clears), never DOWN. The store reads wall time here exactly as
        // production enqueue set the row's `expiresAt` from it; re-read each
        // attempt so a decision delayed across the boundary is re-made on the
        // right side of it.
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (typeof row.expiresAt === 'number' && row.expiresAt <= nowSeconds) {
          await deleteRowAlone();
          return;
        }

        // The ledgers THIS attempt will decrement, read consistently so the
        // (qGen, qVer) binding is captured from current state. An absent
        // ledger (TTL-reaped first, or a legacy row from before the ledger
        // existed) simply has nothing to release — never CREATE one by
        // decrementing; ADD on a missing item would mint a TTL-less ghost row
        // at -1 (the releaseCrewSlot lesson).
        const readLedger = async (
          ledgerMsgId: string,
        ): Promise<Record<string, unknown> | undefined> =>
          (
            await doc.send(
              new GetCommand({
                TableName: TABLES.messages,
                Key: { recipientId, msgId: ledgerMsgId },
                ConsistentRead: true,
              }),
            )
          ).Item;
        const pairLedger = pairScope ? await readLedger(queuePairLedgerKey(pairScope)) : undefined;
        const strangerLedger =
          pairScope && billedUnknown ? await readLedger(QUEUE_STRANGER_LEDGER_KEY) : undefined;

        const decrement = (
          ledgerMsgId: string,
          observed: Record<string, unknown>,
        ): TransactItem => {
          const bind = ledgerBind(observed);
          return {
            Update: {
              TableName: TABLES.messages,
              Key: { recipientId, msgId: ledgerMsgId },
              // `qVer` bumps on the release too, so a
              // refusal-path reconcile racing this ack observes the change
              // and stands down; `qGen` is minted iff this incarnation
              // predates generations.
              UpdateExpression:
                'SET qGen = if_not_exists(qGen, :gen) ADD qItems :negOne, qBytes :negBytes, qVer :one',
              ConditionExpression: bind.cond,
              ExpressionAttributeValues: {
                ':negOne': -1,
                ':negBytes': -rowBytes,
                ':one': 1,
                ':gen': randomUUID(),
                ...bind.values,
              },
            },
          };
        };

        const ops: TransactItem[] = [
          {
            Delete: {
              TableName: TABLES.messages,
              Key: { recipientId, msgId },
              // The identity binding, not mere existence.
              ConditionExpression: rowDeleteCondition,
              ...(rowDeleteValues ? { ExpressionAttributeValues: rowDeleteValues } : {}),
            },
          },
          ...(pairLedger ? [decrement(queuePairLedgerKey(pairScope!), pairLedger)] : []),
          ...(strangerLedger ? [decrement(QUEUE_STRANGER_LEDGER_KEY, strangerLedger)] : []),
        ];
        if (ops.length === 1) {
          // Nothing left to release — just the identity-bound delete.
          await deleteRowAlone();
          return;
        }
        try {
          await doc.send(new TransactWriteCommand({ TransactItems: ops }));
          // Released cleanly: reap the pair ledger if this ack emptied an
          // unestablished one. Best-effort and conditional; a
          // failure to reap only leaves a row the ledger's own TTL clears.
          await reapEmptyUnestablishedPairLedger();
          return;
        } catch (err) {
          if (errName(err) !== 'TransactionCanceledException') throw err;
          const reasons =
            (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
          // The row this ack read is gone or replaced: a concurrent ack won
          // and IT released (and owns the ledger reap), or a different
          // sender's replacement now lives at this id. Either way there is
          // nothing here for THIS ack to release or delete.
          if (reasons[0]?.Code === 'ConditionalCheckFailed') return;
          // A ledger moved (or vanished) between this attempt's read and its
          // commit: loop — the next attempt re-reads the clock and the
          // ledgers and re-binds. Pure TransactionConflict retries the same
          // way.
        }
      }
      // Contended past the bound: delivery correctness outranks ledger
      // exactness. Delete the row (still identity-bound); if a release was
      // thereby skipped the ledger drifts UP, which the enqueue refusal path
      // reconciles away.
      await deleteRowAlone();
      // A best-effort reap here too: if the ledger did land at zero and is
      // unestablished, do not leave the control row for the full TTL.
      await reapEmptyUnestablishedPairLedger();
    },

    async hasQueuedCorrespondence(senderId, recipientId, nowSeconds) {
      // ESTABLISHED, not merely EXISTS: the pair ledger is created and
      // counted by automatic carriers too, so its existence was mintable by
      // the victim's own device (an auto call.end/busy back to a caller, a
      // read receipt). Only a user-authored frame sets `qEstab`, and only that
      // confers correspondence.
      return (await getPairLedger(senderId, recipientId, nowSeconds))?.established === true;
    },

    async hasQueuedCorrespondenceAny(writerKeys, receiverPartitions, nowSeconds) {
      // The group-aware walk — same `qEstab` rule as the single-key form
      // above, probed over every key the correspondence may be billed under
      // (bounded GetItems; one shared helper with the enqueue classification
      // so the two consumers cannot drift on what "established" means).
      return pairEstablishedAny(writerKeys, receiverPartitions, nowSeconds);
    },

    async writeConsentEdge(userId, agentId, nowMs) {
      // BOUNDED CONFLICT RETRY (a remediation): every write
      // and every delete for one human contends on the shared `#count`
      // item, so two in-flight requests from one account collide as
      // TransactionConflict — a transient inside the same
      // TransactionCanceledException that carries real refusals. The old
      // comment said the throw "must propagate so the caller retries", but
      // no caller did: the SDK does not retry it (a non-throttling 400) and
      // both HTTP adapters map the throw to a 500 — the stated contract had
      // no implementer. So the retry lives HERE, bounded, reasons-read
      // (only a cancellation with NO ConditionalCheckFailed is a conflict;
      // a refused condition is an ANSWER and returns at once — except an
      // pin, which is a stale read and retries the same bound), and
      // with no sleep: by the time the exception surfaces the colliding
      // transaction has already settled, so an immediate re-attempt
      // re-serializes. Contended past the bound, the throw stands — an
      // honest 500 beats a spin (a pin past the bound answers 'contended',
      // because the caller's request is fine and a retry would work).
      for (let attempt = 0; ; attempt += 1) {
        // THE PER-GROUP CAP: a grouped caller's 16
        // consent slots are the GROUP's, summed fresh from every member's
        // own `#count` control row — never a stored aggregate that could rot
        // apart from its source (per-member counts also ride each member
        // through unlink: the departing device keeps its own edges, and the
        // group total shrinks by construction). The transaction pins the
        // group epoch + the caller's membership and every sibling's count,
        // so the committed state provably satisfied sum + 1 <= cap. A solo
        // caller keeps the shipped two-item transaction, plus ONE
        // ConditionCheck on its own user row (`attribute_not_exists(
        // groupId)`) — without it a link committing between this read and
        // the commit would strand an edge the group sum never counted.
        // NOT flag-gated: caps are enforcement.
        const callerRes = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId },
            ConsistentRead: true,
          }),
        );
        const caller = callerRes.Item as UserRecord | undefined;
        let groupPin:
          | {
              epoch: number;
              own: number | undefined;
              siblings: Array<{ userId: string; count: number | undefined }>;
            }
          | undefined;
        if (caller?.groupId !== undefined) {
          const groupRes = await doc.send(
            new GetCommand({
              TableName: TABLES.users,
              Key: { userId: groupRowKey(caller.groupId) },
              ConsistentRead: true,
            }),
          );
          const groupItem = groupRes.Item;
          const members = (groupItem?.members ?? []) as AccountGroupMember[];
          if (groupItem && members.some((m) => m.userId === userId)) {
            const counts = new Map<string, number | undefined>();
            let total = 0;
            for (const member of members) {
              const countRes = await doc.send(
                new GetCommand({
                  TableName: TABLES.consentEdges,
                  Key: { userId: member.userId, agentId: CONSENT_COUNT_KEY },
                  ConsistentRead: true,
                }),
              );
              const edges = countRes.Item?.edges as number | undefined;
              counts.set(member.userId, edges);
              total += edges ?? 0;
            }
            // Precheck half — the pins below make the refusal atomic.
            if (total >= CONSENT_MAX_EDGES) return 'cap_reached';
            groupPin = {
              epoch: groupItem.epoch as number,
              own: counts.get(userId),
              siblings: members
                .filter((m) => m.userId !== userId)
                .map((m) => ({ userId: m.userId, count: counts.get(m.userId) })),
            };
          }
        }
        // A count pin: absent-at-read must still be absent, present-at-read
        // still at its read value — `edges` only ever moves by ADD/Delete,
        // so equality is the whole pin.
        const edgesPin = (value: number | undefined, name: string): string =>
          value === undefined ? 'attribute_not_exists(edges)' : `edges = ${name}`;
        try {
          // One transaction, edge + counter or neither (the adoptCrewMember
          // discipline): an edge must never exist without its slot being
          // counted, and a slot must never be taken for an edge the write
          // refused. Item 0 is the edge Put, item 1 the counter Update,
          // item 2 the caller's user-row/group pin, 3.. sibling pins.
          await doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: TABLES.consentEdges,
                    Item: { userId, agentId, createdAt: nowMs },
                    // Absence, so the idempotent re-consent cancels instead of
                    // double-counting the slot.
                    ConditionExpression: 'attribute_not_exists(userId)',
                  },
                },
                groupPin
                  ? {
                      Update: {
                        TableName: TABLES.consentEdges,
                        Key: { userId, agentId: CONSENT_COUNT_KEY },
                        UpdateExpression: 'ADD edges :one',
                        // The caller's own count pinned at its read value:
                        // the GROUP sum is the cap here, checked above and
                        // made atomic by this pin plus the sibling pins.
                        ConditionExpression: edgesPin(groupPin.own, ':own'),
                        ExpressionAttributeValues: {
                          ':one': 1,
                          ...(groupPin.own !== undefined ? { ':own': groupPin.own } : {}),
                        },
                      },
                    }
                  : {
                      Update: {
                        TableName: TABLES.consentEdges,
                        Key: { userId, agentId: CONSENT_COUNT_KEY },
                        UpdateExpression: 'ADD edges :one',
                        // Unlike the crew counter (which lives on a row that
                        // must already exist), ADD here CREATES the control
                        // row on the first consent — attribute_not_exists(
                        // edges) admits exactly that creation, and
                        // edges <:cap holds every write after it under the
                        // cap so two concurrent writes cannot both pass
                        // ('s rule).
                        ConditionExpression: 'attribute_not_exists(edges) OR edges < :cap',
                        ExpressionAttributeValues: { ':one': 1, ':cap': CONSENT_MAX_EDGES },
                      },
                    },
                groupPin
                  ? {
                      ConditionCheck: {
                        TableName: TABLES.users,
                        Key: { userId: groupRowKey(caller!.groupId!) },
                        ConditionExpression:
                          'attribute_exists(userId) AND epoch = :gEpoch AND contains(memberIds, :caller)',
                        ExpressionAttributeValues: { ':gEpoch': groupPin.epoch, ':caller': userId },
                      },
                    }
                  : {
                      ConditionCheck: {
                        TableName: TABLES.users,
                        Key: { userId },
                        // attribute_not_exists(userId) admits the rare
                        // direct-call path with no user row (the route always
                        // has one); an EXISTING row must still be ungrouped.
                        ConditionExpression:
                          'attribute_not_exists(userId) OR attribute_not_exists(groupId)',
                      },
                    },
                ...(groupPin
                  ? groupPin.siblings.map(
                      (sibling, i): TransactItem => ({
                        ConditionCheck: {
                          TableName: TABLES.consentEdges,
                          Key: { userId: sibling.userId, agentId: CONSENT_COUNT_KEY },
                          ConditionExpression: edgesPin(sibling.count, `:s${i}`),
                          ...(sibling.count !== undefined
                            ? { ExpressionAttributeValues: { [`:s${i}`]: sibling.count } }
                            : {}),
                        },
                      }),
                    )
                  : []),
              ],
            }),
          );
          return 'written';
        } catch (err) {
          if (errName(err) !== 'TransactionCanceledException') throw err;
          // Read the reasons, never assume them (the deleteUser lesson): the
          // same exception covers refusals, conflicts and throttling.
          const reasons =
            (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
          // The edge refusing takes precedence: a re-consent by a caller at
          // the cap is 'already' (it needs no slot — it has one), exactly the
          // member-first rule adoptCrewMember records.
          if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'already';
          const counterRefused = reasons[1]?.Code === 'ConditionalCheckFailed';
          const pinRefused = reasons
            .slice(2)
            .some((r) => r?.Code === 'ConditionalCheckFailed');
          // Solo counter refusal is the per-partition cap, exactly as
          // shipped. A grouped counter refusal is the OWN-COUNT PIN — a
          // stale read, not an answer — and retries with the pins.
          if (counterRefused && groupPin === undefined) return 'cap_reached';
          if (counterRefused || pinRefused) {
            if (attempt >= CONSENT_TXN_ATTEMPTS - 1) return 'contended';
            continue;
          }
          if (attempt >= CONSENT_TXN_ATTEMPTS - 1) throw err;
        }
      }
    },

    async deleteConsentEdge(userId, agentId) {
      // TWO TRANSACTION SHAPES, tried in turn, both bounded by the same
      // conflict-retry rule writeConsentEdge records (a remediation):
      // A. the ordinary release — delete the edge, decrement the counter,
      // CONDITIONED on the decrement leaving at least one edge counted
      // (`edges >:one`);
      // B. the LAST edge — delete the edge and DELETE the `#count` row in
      // one transaction (`edges =:one`), so a human who revokes every
      // consent leaves the table holding NOTHING about them. The
      // counter was the one row that outlived total revocation — a
      // permanent "this account once participated in the consent
      // graph" record in exactly the knowledge class this store
      // refuses to retain — and deleting it is safe by the write path's own
      // shape: with no edges left, the next consent legitimately
      // recreates it at 1 through the attribute_not_exists(edges)
      // branch. Deleting ONLY inside the same transaction as the last
      // edge is what keeps the latent cap-reset hole shut (a counter
      // must never vanish while edges remain). No oracle is minted:
      // the route still answers 204 uniformly, no read route exists,
      // and the one thing extra latency here could tell the caller —
      // "that was your own last edge" — is a fact about their own
      // partition, not about any other account.
      // A concurrent write between A and B re-refuses B's `edges =:one`
      // condition and loops back to A (bounded). Contended or drifted past
      // the bound, REVOCATION IS NEVER BLOCKED: the edge is deleted alone,
      // and a skipped release only drifts the counter UP — the narrowing
      // direction (fewer grants storable, never more).
      for (let attempt = 0; ; attempt += 1) {
        // Shape A — delete + decrement, leaving >= 1 counted.
        try {
          await doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Delete: {
                    TableName: TABLES.consentEdges,
                    Key: { userId, agentId },
                    ConditionExpression: 'attribute_exists(userId)',
                  },
                },
                {
                  Update: {
                    TableName: TABLES.consentEdges,
                    Key: { userId, agentId: CONSENT_COUNT_KEY },
                    UpdateExpression: 'ADD edges :minusOne',
                    // Both halves load-bearing (the releaseCrewSlot rule):
                    // ADD on a missing item would mint a ghost control row
                    // at -1, and edges > 1 routes the last edge to shape B.
                    ConditionExpression: 'attribute_exists(userId) AND edges > :one',
                    ExpressionAttributeValues: { ':minusOne': -1, ':one': 1 },
                  },
                },
              ],
            }),
          );
          return;
        } catch (err) {
          if (errName(err) !== 'TransactionCanceledException') throw err;
          const reasons =
            (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
          const edgeRefused = reasons[0]?.Code === 'ConditionalCheckFailed';
          const counterRefused = reasons[1]?.Code === 'ConditionalCheckFailed';
          if (edgeRefused) {
            // Already gone (idempotent repeat, or a concurrent delete won
            // and took the release). Nothing to delete, nothing to give back.
            return;
          }
          if (!counterRefused) {
            // Pure conflict: retry the same shape, bounded.
            if (attempt >= CONSENT_TXN_ATTEMPTS - 1) break;
            continue;
          }
          // Edge present, counter not decrementable past 1: either this is
          // the last counted edge (shape B's case) or drift (row missing /
          // already 0). Shape B decides which, transactionally.
        }
        // Shape B — the last edge: edge and counter leave together.
        try {
          await doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Delete: {
                    TableName: TABLES.consentEdges,
                    Key: { userId, agentId },
                    ConditionExpression: 'attribute_exists(userId)',
                  },
                },
                {
                  Delete: {
                    TableName: TABLES.consentEdges,
                    Key: { userId, agentId: CONSENT_COUNT_KEY },
                    ConditionExpression: 'attribute_exists(userId) AND edges = :one',
                    ExpressionAttributeValues: { ':one': 1 },
                  },
                },
              ],
            }),
          );
          return;
        } catch (err) {
          if (errName(err) !== 'TransactionCanceledException') throw err;
          const reasons =
            (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
          if (reasons[0]?.Code === 'ConditionalCheckFailed') return; // raced: edge gone
          // Counter is not exactly 1 (a concurrent write bumped it, or
          // drift: missing / 0 with the edge still present) — or a pure
          // conflict. Loop back to shape A, bounded.
          if (attempt >= CONSENT_TXN_ATTEMPTS - 1) break;
        }
      }
      // Past the bound (sustained contention, or the drifted counter no
      // shape can satisfy): delete the edge alone — revocation is never
      // blocked, and the counter can only drift UP (narrowing).
      await doc.send(
        new DeleteCommand({ TableName: TABLES.consentEdges, Key: { userId, agentId } }),
      );
    },

    async hasConsentEdge(userId, agentId) {
      // The control row is not an edge (belt — the route's ULID validation
      // already keeps '#count' out of agentId).
      if (agentId === CONSENT_COUNT_KEY) return false;
      // Strongly consistent, non-negotiably: this is the enforcement read at
      // the ws arms, and the revocation semantic is "delete the edge; the
      // NEXT send is refused". An eventually-consistent read would deliver
      // frames a just-deleted edge no longer authorizes (the
      // gate.consistentread precedent).
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.consentEdges,
          Key: { userId, agentId },
          ConsistentRead: true,
        }),
      );
      return res.Item !== undefined;
    },

    async purgeConsentEdges(userId) {
      // Page keys-only through the human's own partition and batch-delete —
      // edges and the `#count` control row together (the purgeQueuedMessages
      // shape). The one Query this table ever takes, and it is destructive.
      // ConsistentRead, NON-NEGOTIABLY (a remediation): the
      // purgeQueuedMessages precedent this copies is only safe eventually-
      // consistent because every messages row carries a 30-day TTL — a row
      // a stale page misses is reaped anyway. Consent edges have NO TTL and
      // no reaper by design, no agentId index, and no read route, so an
      // edge written moments before DELETE /v1/account (the plausible panic
      // sequence) that a stale page missed would survive as a permanent,
      // unreachable association record about a deleted human — breaking
      // stated lifetime and the deletion-completeness argument
      // account.ts makes. The in-repo precedent is listOneTimePrekeyIds,
      // the OTHER non-TTL'd purge on this same handler path.
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await doc.send(
          new QueryCommand({
            TableName: TABLES.consentEdges,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
            ProjectionExpression: 'userId, agentId',
            ConsistentRead: true,
            ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
          }),
        );
        await chunkedBatchWrite(
          doc,
          TABLES.consentEdges,
          (res.Items ?? []).map((item) => ({
            DeleteRequest: { Key: { userId, agentId: item.agentId } },
          })),
        );
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
    },

    // --- Optional account grouping ---

    async getAccountGroup(groupId) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: groupRowKey(groupId) },
          // Strongly consistent, non-negotiably: this read backs roster
          // decisions (fan-out targets, cert serving), and an eventually-
          // consistent read would serve a roster a just-committed revoke no
          // longer authorizes (pinned by gate.consistentread.test.ts).
          ConsistentRead: true,
        }),
      );
      const item = res.Item;
      if (!item) return undefined;
      return {
        groupId,
        members: (item.members ?? []) as AccountGroupMember[],
        identifierRefs: (item.identifierRefs ?? []) as string[],
        epoch: item.epoch as number,
        createdAt: item.createdAt as number,
        ...(item.discoverableAfter !== undefined
          ? { discoverableAfter: item.discoverableAfter as number }
          : {}),
        ...(item.attachCreated === true ? { attachCreated: true } : {}),
        ...(item.usernameRenamedAt !== undefined
          ? { usernameRenamedAt: item.usernameRenamedAt as number }
          : {}),
        // `memberClasses` and `memberIds` (the string sets the class-slot
        // and acting-member conditions test) are deliberately NOT surfaced:
        // they are derived bookkeeping for the ConditionExpressions,
        // maintained inside the transactions; `members` is the pinned
        // shape and the single truth readers get.
      };
    },

    async isAccountsFeatureEnabled() {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: ACCOUNTS_FEATURE_FLAG_KEY },
          ConsistentRead: true,
        }),
      );
      // Fail CLOSED: absent row, absent attribute, or any non-`true` value
      // all read as OFF — the dark deploy stays dark by construction.
      return res.Item?.enabled === true;
    },
    async isAccountsPhoneFeatureEnabled() {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: ACCOUNTS_PHONE_FEATURE_FLAG_KEY },
          ConsistentRead: true,
        }),
      );
      // The master flag's exact fail-closed read: the phone
      // train stays dark inside a live email-v1 deploy until an operator
      // writes this row, and deleting it is the class kill switch.
      return res.Item?.enabled === true;
    },
    async isAccountsUsernameFeatureEnabled() {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: ACCOUNTS_USERNAME_FEATURE_FLAG_KEY },
          ConsistentRead: true,
        }),
      );
      // The same fail-closed read, third class: the username routes
      // stay dark until an operator writes this row; deleting it is the
      // class kill switch AND the rotation-window brake.
      return res.Item?.enabled === true;
    },

    async putLinkOffer(rec) {
      assertWellFormedLinkTuple(rec);
      const cancelled = await sendRosterTransact(doc, [
              {
                Put: {
                  TableName: TABLES.sessions,
                  // NO `userId` ATTRIBUTE ON THIS ROW — the auth-challenge
                  // rule: the sessions user-index is partitioned on
                  // `userId`, and carrying one would have
                  // `deleteSessionsForUser` batch-delete live offers on
                  // every sign-in.
                  Item: {
                    token: linkOfferKey(rec.offerNonce),
                    kind: 'linkOffer',
                    offerNonce: rec.offerNonce,
                    groupId: rec.groupId,
                    offererUserId: rec.offererUserId,
                    acceptorUserId: rec.acceptorUserId,
                    acceptorClass: rec.acceptorClass,
                    ...(rec.offererClass !== undefined
                      ? { offererClass: rec.offererClass }
                      : {}),
                    rosterEpoch: rec.rosterEpoch,
                    expiresAt: rec.expiresAt,
                    offerSig: rec.offerSig,
                  },
                  // Single-mint: the loser of a nonce collision must never
                  // overwrite the winner's tuple.
                  ConditionExpression: 'attribute_not_exists(#t)',
                  ExpressionAttributeNames: { '#t': 'token' },
                },
              },
              // The reverse pointers: the nonce lands in a
              // string set on BOTH named users' rows, same transaction, so
              // the sweep finds every pending offer naming a deleted
              // member by GetItem walk — never a scan. attribute_exists
              // guards both: a pointer write must never mint a ghost user
              // row for a deleted account.
              {
                Update: {
                  TableName: TABLES.users,
                  Key: { userId: rec.offererUserId },
                  UpdateExpression: 'ADD linkOfferNonces :n',
                  ConditionExpression: 'attribute_exists(userId)',
                  ExpressionAttributeValues: { ':n': new Set([rec.offerNonce]) },
                },
              },
              {
                Update: {
                  TableName: TABLES.users,
                  Key: { userId: rec.acceptorUserId },
                  UpdateExpression: 'ADD linkOfferNonces :n',
                  ConditionExpression: 'attribute_exists(userId)',
                  ExpressionAttributeValues: { ':n': new Set([rec.offerNonce]) },
                },
              },
      ]);
      if (!cancelled) return 'created';
      if (cancelled[0]?.Code === 'ConditionalCheckFailed') return 'exists';
      if (
        cancelled[1]?.Code === 'ConditionalCheckFailed' ||
        cancelled[2]?.Code === 'ConditionalCheckFailed'
      ) {
        return 'unknown_member';
      }
      // Three items, three conditions — a cancellation naming none of them
      // is store drift worth failing loudly on.
      throw new Error('link offer: unclassifiable transaction cancellation');
    },

    async getLinkOffer(offerNonce, nowSeconds) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.sessions,
          Key: { token: linkOfferKey(offerNonce) },
          ConsistentRead: true,
        }),
      );
      const item = res.Item;
      if (!item || item.kind !== 'linkOffer') return undefined;
      // The clock decides, not the TTL reaper (the pair-ledger discipline):
      // an expired-but-unreaped row reads as gone.
      if ((item.expiresAt as number) <= nowSeconds) return undefined;
      return {
        offerNonce: item.offerNonce as string,
        groupId: item.groupId as string,
        offererUserId: item.offererUserId as string,
        acceptorUserId: item.acceptorUserId as string,
        acceptorClass: item.acceptorClass as DeviceClass,
        ...(item.offererClass !== undefined
          ? { offererClass: item.offererClass as DeviceClass }
          : {}),
        rosterEpoch: item.rosterEpoch as number,
        expiresAt: item.expiresAt as number,
        offerSig: item.offerSig as string,
      };
    },

    async putLinkOfferInit(rec) {
      assertWellFormedLinkTuple(rec);
      const cancelled = await sendRosterTransact(doc, [
        {
          Put: {
            TableName: TABLES.sessions,
            // NO `userId` attribute — the auth-challenge rule the offer row
            // follows, for the same reason (the sessions user-index).
            Item: {
              token: linkInitKey(rec.offerNonce),
              kind: 'linkOfferInit',
              offerNonce: rec.offerNonce,
              groupId: rec.groupId,
              offererUserId: rec.offererUserId,
              acceptorUserId: rec.acceptorUserId,
              acceptorClass: rec.acceptorClass,
              ...(rec.offererClass !== undefined ? { offererClass: rec.offererClass } : {}),
              rosterEpoch: rec.rosterEpoch,
              expiresAt: rec.expiresAt,
            },
            // Single-mint, exactly as the offer row: a nonce collision's
            // loser must never overwrite the winner's tuple.
            ConditionExpression: 'attribute_not_exists(#t)',
            ExpressionAttributeNames: { '#t': 'token' },
          },
        },
        // The reverse pointer — OFFERER ONLY (unsigned-init
        // amplification). The INIT leg verifies no signature, so writing a
        // pointer onto the ACCEPTOR's row here let any bearer append permanent,
        // uncleanable residue to a third party's row on the CALLER's budget
        // (13k entries brick a users item at the 400 KB cap). The standing
        // discipline only ever wrote the reverse pointer AFTER a signature
        // verified; this unsigned call had widened that surface, so the
        // acceptor's pointer moves to `promoteLinkOfferInit` (the submit leg,
        // where A's signature is checked). The offerer writes only its OWN row
        // here — self-inflicted, priced by its own linkOffer bucket — and an
        // init abandoned before submit stays sweep-findable from that side; an
        // acceptor gains nothing from a ceremony that never produced a signed
        // offer.
        {
          Update: {
            TableName: TABLES.users,
            Key: { userId: rec.offererUserId },
            UpdateExpression: 'ADD linkOfferNonces :n',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':n': new Set([rec.offerNonce]) },
          },
        },
      ]);
      if (!cancelled) return 'created';
      if (cancelled[0]?.Code === 'ConditionalCheckFailed') return 'exists';
      if (cancelled[1]?.Code === 'ConditionalCheckFailed') return 'unknown_member';
      throw new Error('link offer init: unclassifiable transaction cancellation');
    },

    async getLinkOfferInit(offerNonce, nowSeconds) {
      return readLinkOfferInit(doc, offerNonce, nowSeconds);
    },

    async promoteLinkOfferInit(offerNonce, offerSig, nowSeconds) {
      // The tuple comes from the INIT ROW (strongly consistent), never the
      // caller: the offer row can only ever carry what the server recorded
      // for A to sign — a signature over anything else already failed
      // upstream, and there are no parameters left to smuggle here.
      const init = await readLinkOfferInit(doc, offerNonce, nowSeconds);
      if (!init) return 'gone';
      const cancelled = await sendRosterTransact(doc, [
        {
          Delete: {
            TableName: TABLES.sessions,
            Key: { token: linkInitKey(offerNonce) },
            // Single-use consume, the challenge-row discipline: kind and the
            // explicit expiry re-checked inside the condition even though
            // the read above just did — every reader of the namespace checks
            // attributes rather than trusting key shape or its own snapshot.
            ConditionExpression: 'kind = :k AND expiresAt > :now',
            ExpressionAttributeValues: { ':k': 'linkOfferInit', ':now': nowSeconds },
          },
        },
        {
          Put: {
            TableName: TABLES.sessions,
            Item: {
              token: linkOfferKey(offerNonce),
              kind: 'linkOffer',
              offerNonce: init.offerNonce,
              groupId: init.groupId,
              offererUserId: init.offererUserId,
              acceptorUserId: init.acceptorUserId,
              acceptorClass: init.acceptorClass,
              ...(init.offererClass !== undefined ? { offererClass: init.offererClass } : {}),
              rosterEpoch: init.rosterEpoch,
              expiresAt: init.expiresAt,
              offerSig,
            },
            ConditionExpression: 'attribute_not_exists(#t)',
            ExpressionAttributeNames: { '#t': 'token' },
          },
        },
        // The ACCEPTOR's reverse pointer lands HERE, not at init (the
        // unsigned-init amplification) — A's op="offer" signature has now
        // verified upstream, so this keeps the posture of
        // writing the reverse pointer only AFTER a signature. `attribute_exists`
        // guards it: an acceptor deleted between init and submit fails the
        // condition, the whole promote cancels ('gone'), and submit answers the
        // collapsed refusal. The OFFERER's pointer already exists from the init
        // write (set ADD is idempotent), so it is not repeated.
        {
          Update: {
            TableName: TABLES.users,
            Key: { userId: init.acceptorUserId },
            UpdateExpression: 'ADD linkOfferNonces :n',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':n': new Set([init.offerNonce]) },
          },
        },
      ]);
      return cancelled ? 'gone' : 'promoted';
    },

    async isUserTombstoned(userId) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId },
          ProjectionExpression: 'tombstoned',
          // Strongly consistent: this backs the read-time enforcement a
          // just-committed revoke depends on.
          ConsistentRead: true,
        }),
      );
      return res.Item?.tombstoned === true;
    },

    async linkDeviceToGroup({ offerNonce, acceptSig, nowSeconds, linkedAtMs }) {
      // The signed tuple comes from the OFFER ROW (strongly consistent), not
      // from the caller: a replayed nonce cannot smuggle different
      // parameters, because there are no parameters to smuggle.
      const offerRes = await doc.send(
        new GetCommand({
          TableName: TABLES.sessions,
          Key: { token: linkOfferKey(offerNonce) },
          ConsistentRead: true,
        }),
      );
      const offer = offerRes.Item;
      if (!offer || offer.kind !== 'linkOffer') return 'offer_consumed';
      // Explicit expiry field, checked here AND inside the conditional
      // delete below — TTL reaping is cleanup, never the enforcement.
      if ((offer.expiresAt as number) <= nowSeconds) return 'offer_expired';

      const groupId = offer.groupId as string;
      const offererUserId = offer.offererUserId as string;
      const acceptorUserId = offer.acceptorUserId as string;
      const acceptorClass = offer.acceptorClass as DeviceClass;
      const offererClass = offer.offererClass as DeviceClass | undefined;
      const rosterEpoch = offer.rosterEpoch as number;

      //the desktop slot is a schema reservation ONLY in v1 — the
      // schema accepts the value, this transaction refuses it, and the
      // future activation is a lift of exactly this check, not a migration.
      if (acceptorClass === 'desktop' || offererClass === 'desktop') return 'desktop_reserved';

      const gkey = groupRowKey(groupId);
      // The FULL signed-tuple context rides the certs: this
      // transaction consumes the offer row, and a certificate whose preimage
      // nobody can re-derive is not a certificate. Everything but the
      // subject identity keys, which verifiers supply from their own pins.
      const certs: AccountGroupMember['certs'] = {
        offerSig: offer.offerSig as string,
        acceptSig,
        groupId,
        offererUserId,
        acceptorUserId,
        class: acceptorClass,
        rosterEpoch,
        offerNonce,
        expiresAt: offer.expiresAt as number,
      };
      // Consumed-offer pointer cleanup: the winning link removes
      // the nonce from both users' reverse sets in the same transaction.
      const nonceSet = new Set([offerNonce]);
      const acceptorMember: AccountGroupMember = {
        userId: acceptorUserId,
        class: acceptorClass,
        linkedAt: linkedAtMs,
        certs,
      };

      const readUser = async (id: string): Promise<UserRecord | undefined> => {
        const res = await doc.send(
          new GetCommand({ TableName: TABLES.users, Key: { userId: id }, ConsistentRead: true }),
        );
        return res.Item as UserRecord | undefined;
      };
      const readConsentCount = async (id: string): Promise<number | undefined> => {
        const res = await doc.send(
          new GetCommand({
            TableName: TABLES.consentEdges,
            Key: { userId: id, agentId: CONSENT_COUNT_KEY },
            ConsistentRead: true,
          }),
        );
        return res.Item?.edges as number | undefined;
      };
      // Bounded pin retry: a cancelled transaction leaves the offer row
      // untouched, so a stale count re-reads and re-runs once; twice is
      // honest contention.
      // NO human-class precheck here, DELIBERATELY:
      // the transaction's own `attribute_not_exists(accountClass)` conditions
      // are the ONLY decider for the refusal (agents never occupy device
      // slots — the human-class transaction precedent), and the
      // cancellation classification below names the outcome. A data-layer
      // precheck made the pinned claim "the condition, never the precheck,
      // answers" false: the planted-offer tests were exercising a read, and
      // deleting the conditions would have left them green.
      for (let attempt = 0; ; attempt++) {
        const acceptorRow = await readUser(acceptorUserId);
        const offererRow = await readUser(offererUserId);
        if (!acceptorRow || !offererRow) return 'unknown_member';

        // THE MERGED-CAP SUM: every party of the would-be merged
        // roster, each with its own crew count — the offerer/acceptor pin on
        // their own Update items, other members on appended ConditionChecks.
        // Belt-and-braces for any future pristineness relaxation, and live
        // enforcement for a lived-in joiner the precheck missed.
        const otherMembers: Array<{ userId: string; crew: number | undefined }> = [];
        let mergedCrew = (offererRow.crewCount ?? 0) + (acceptorRow.crewCount ?? 0);
        const partyIds = [offererUserId, acceptorUserId];

        let groupItem: TransactItem;
        let offererItem: TransactItem;
        if (rosterEpoch === 0) {
          // First link: the row is born with BOTH members (the minted
          // groupId was a name until this commit makes it state).
          const offererMember: AccountGroupMember = {
            userId: offererUserId,
            // putLinkOffer enforced presence for rosterEpoch 0.
            class: offererClass as DeviceClass,
            linkedAt: linkedAtMs,
            certs,
          };
          groupItem = {
            Put: {
              TableName: TABLES.users,
              Item: {
                userId: gkey,
                members: [offererMember, acceptorMember],
                // Derived bookkeeping for the ConditionExpressions:
                // `contains` cannot look inside a list of maps, so the
                // classes ride beside the list as a string set (the class-slot
                // condition) and so do the member ULIDs (`memberIds`, the
                // acting-member condition), both recomputed by every roster transaction
                // under the epoch pin.
                memberClasses: new Set([offererMember.class, acceptorClass]),
                memberIds: new Set([offererUserId, acceptorUserId]),
                identifierRefs: [],
                epoch: 1,
                createdAt: linkedAtMs,
              },
              // A concurrent first link of the same minted groupId (or a lazy
              // solo group from an identifier attach) loses here: an epoch-0
              // offer only ever lands on a row that does not exist.
              ConditionExpression: 'attribute_not_exists(userId)',
            },
          };
          offererItem = {
            Update: {
              TableName: TABLES.users,
              Key: { userId: offererUserId },
              UpdateExpression: 'SET groupId = :g DELETE linkOfferNonces :n',
              // First link demands a SOLO offerer — the same
              // attribute_not_exists(groupId) rule the joiner gets — that is
              // HUMAN (the class condition) with its crew count still at
              // the read value the merged sum used.
              ConditionExpression:
                'attribute_exists(userId) AND attribute_not_exists(groupId) AND ' +
                'attribute_not_exists(accountClass) AND ' +
                `(${crewPin(offererRow.crewCount, ':offCrew')})`,
              ExpressionAttributeValues: {
                ':g': groupId,
                ':n': nonceSet,
                ...(offererRow.crewCount !== undefined ? { ':offCrew': offererRow.crewCount } : {}),
              },
            },
          };
        } else {
          // Join: read the row to recompute the class set. The snapshot is
          // safe to build from because the transaction pins `epoch` to the
          // OFFER's rosterEpoch — if the roster moved after this read (or
          // after signing), the condition refuses and nothing lands.
          const current = await doc.send(
            new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
          );
          const row = current.Item;
          // Row gone: dissolved (or never existed) after signing. The offer's
          // epoch names a roster state that no longer exists.
          if (!row) return 'stale_epoch';
          const members = (row.members ?? []) as AccountGroupMember[];
          for (const member of members) {
            if (member.userId === offererUserId) continue;
            const memberRow = await readUser(member.userId);
            otherMembers.push({ userId: member.userId, crew: memberRow?.crewCount });
            mergedCrew += memberRow?.crewCount ?? 0;
            partyIds.push(member.userId);
          }
          const newClasses = new Set(members.map((m) => m.class));
          newClasses.add(acceptorClass);
          const newIds = new Set(members.map((m) => m.userId));
          newIds.add(acceptorUserId);
          groupItem = {
            Update: {
              TableName: TABLES.users,
              Key: { userId: gkey },
              UpdateExpression:
                'SET members = list_append(members, :m), memberClasses = :cls, memberIds = :ids, epoch = :next',
              // THE FOUR CONDITIONS, each its own clause so each fails on its
              // own honest accident: the epoch pin (an acceptance never lands
              // over a roster that moved after signing), the
              // class-slot condition (one member per class — the
              // crew-adopt precedent), the ≤3 cap as belt-and-braces
              // (enforced INDEPENDENTLY of the class bookkeeping, so a
              // corrupt or future-relaxed class set still cannot mint a
              // fourth member), and the OFFERER's own presence in the
              // AUTHORITATIVE roster: a stale user
              // row that still names this groupId is not membership — the
              // epoch pin proves the roster has not MOVED since the offer,
              // never that the offerer was ever in it, so a nonmember whose
              // row drifted could otherwise invite a device into a group it
              // does not belong to.
              ConditionExpression:
                'attribute_exists(userId) AND epoch = :e AND NOT contains(memberClasses, :c) AND size(members) < :cap AND contains(memberIds, :off)',
              ExpressionAttributeValues: {
                ':m': [acceptorMember],
                ':cls': newClasses,
                ':ids': newIds,
                ':next': rosterEpoch + 1,
                ':e': rosterEpoch,
                ':c': acceptorClass,
                ':cap': ACCOUNT_GROUP_MAX_MEMBERS,
                ':off': offererUserId,
              },
            },
          };
          // The offerer must still be the grouped device the offer said it
          // was. Its MEMBERSHIP is guarded by the epoch pin above (removal
          // bumps the epoch); this condition catches the row-level drift the
          // group row cannot see (account deleted, groupId cleared) — an
          // Update rather than a bare ConditionCheck so the consumed offer's
          // reverse pointer leaves with the same conditions. The
          // class + crew-pin clauses are the (a member is human by
          // construction; the pin holds the merged sum).
          offererItem = {
            Update: {
              TableName: TABLES.users,
              Key: { userId: offererUserId },
              UpdateExpression: 'DELETE linkOfferNonces :n',
              ConditionExpression:
                'attribute_exists(userId) AND groupId = :g AND ' +
                'attribute_not_exists(accountClass) AND ' +
                `(${crewPin(offererRow.crewCount, ':offCrew')})`,
              ExpressionAttributeValues: {
                ':g': groupId,
                ':n': nonceSet,
                ...(offererRow.crewCount !== undefined ? { ':offCrew': offererRow.crewCount } : {}),
              },
            },
          };
        }

        // Consent counts for every merged party — the sum's other half.
        const consentPins: Array<{ userId: string; count: number | undefined }> = [];
        let mergedConsent = 0;
        for (const id of partyIds) {
          const count = await readConsentCount(id);
          consentPins.push({ userId: id, count });
          mergedConsent += count ?? 0;
        }
        // THE MERGED-CAP REFUSAL, its own distinct result; the handler
        // collapses it.
        if (mergedCrew > CREW_MAX_MEMBERS || mergedConsent > CONSENT_MAX_EDGES) {
          return 'cap_exceeded';
        }

        const transactItems: TransactItem[] = [
          groupItem,
          offererItem,
          {
            Update: {
              TableName: TABLES.users,
              Key: { userId: acceptorUserId },
              UpdateExpression: 'SET groupId = :g DELETE linkOfferNonces :n',
              // The pristineness classes that can
              // RACE the precheck — a concurrent link of this device, or
              // an identifier attach lazily creating it a solo group — fail
              // HERE, as transaction refusals, not trusted prechecks. The
              // class condition (an integration-class account offered a
              // device-link slot is REFUSED in the transaction) and the crew
              // pin are.
              ConditionExpression:
                'attribute_exists(userId) AND attribute_not_exists(groupId) AND ' +
                'attribute_not_exists(accountClass) AND ' +
                `(${crewPin(acceptorRow.crewCount, ':accCrew')})`,
              ExpressionAttributeValues: {
                ':g': groupId,
                ':n': nonceSet,
                ...(acceptorRow.crewCount !== undefined ? { ':accCrew': acceptorRow.crewCount } : {}),
              },
            },
          },
          {
            Delete: {
              TableName: TABLES.sessions,
              Key: { token: linkOfferKey(offerNonce) },
              // Single-use consume, the challenge-row discipline: the
              // condition re-checks kind, tuple, and the explicit expiry even
              // though the nonce key already binds the row — every reader of
              // the namespace checks attributes rather than trusting key
              // shape alone.
              ConditionExpression:
                'kind = :k AND groupId = :g AND acceptorUserId = :b AND rosterEpoch = :e AND expiresAt > :now',
              ExpressionAttributeValues: {
                ':k': 'linkOffer',
                ':g': groupId,
                ':b': acceptorUserId,
                ':e': rosterEpoch,
                ':now': nowSeconds,
              },
            },
          },
          // The pins (items 4..N): the remaining members' crew counts and
          // every party's consent `#count`, each still at its read value — a
          // ConditionCheck reads one row inside the transaction and mutates
          // nothing (the enqueue-tombstone precedent), so a concurrent adopt
          // or consent write cancels the link instead of slipping the sum.
          ...otherMembers.map(
            (member, i): TransactItem => ({
              ConditionCheck: {
                TableName: TABLES.users,
                Key: { userId: member.userId },
                ConditionExpression: crewPin(member.crew, `:mc${i}`),
                ...(member.crew !== undefined
                  ? { ExpressionAttributeValues: { [`:mc${i}`]: member.crew } }
                  : {}),
              },
            }),
          ),
          ...consentPins.map(
            (party, i): TransactItem => ({
              ConditionCheck: {
                TableName: TABLES.consentEdges,
                Key: { userId: party.userId, agentId: CONSENT_COUNT_KEY },
                ConditionExpression: edgesPin(party.count, `:cc${i}`),
                ...(party.count !== undefined
                  ? { ExpressionAttributeValues: { [`:cc${i}`]: party.count } }
                  : {}),
              },
            }),
          ),
        ];

        const reasons = await sendRosterTransact(doc, transactItems);
        if (!reasons) return 'linked';
        // Classify the refusal for the caller. The classification re-reads
        // are UX — the refusal itself already happened, atomically, in the
        // conditions above (the precheck is
        // UX, the condition is the authorization). Pure-conflict transients
        // never reach here: sendRosterTransact re-attempts them and throws
        // past the bound, so a refusal below always names a real condition.
        const failed = (i: number): boolean => reasons[i]?.Code === 'ConditionalCheckFailed';
        if (failed(0)) {
          const after = await doc.send(
            new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
          );
          const row = after.Item;
          if (!row) return 'stale_epoch';
          if ((row.epoch as number) !== rosterEpoch) return 'stale_epoch';
          const classes = ((row.members ?? []) as AccountGroupMember[]).map((m) => m.class);
          if (classes.includes(acceptorClass)) return 'class_occupied';
          if (((row.members ?? []) as AccountGroupMember[]).length >= ACCOUNT_GROUP_MAX_MEMBERS) {
            return 'group_full';
          }
          // The membership condition (`contains(memberIds,:off)`):
          // an offerer absent from the authoritative roster — or a corrupt
          // row missing its derived set — is a stale-roster fact, same
          // answer class. Classified AFTER the slot/size facts: those also
          // held atomically and name the more meaningful accident.
          const rosterIds = row.memberIds as Set<string> | undefined;
          if (rosterEpoch !== 0 && (!rosterIds || !rosterIds.has(offererUserId))) {
            return 'stale_epoch';
          }
          // First-link Put against an existing row lands here when the row
          // matches the offer's shape anyway: the roster moved after
          // signing.
          return 'stale_epoch';
        }
        if (failed(2)) {
          const after = await readUser(acceptorUserId);
          if (!after) return 'unknown_member';
          if (after.accountClass === 'integration') return 'integration_class';
          if (after.groupId !== undefined) return 'already_grouped';
          // Only the crew pin can remain: a concurrent adopt moved the
          // joiner's count after the sum was taken. Bounded retry below.
        } else if (failed(1)) {
          const after = await readUser(offererUserId);
          if (!after) return 'unknown_member';
          if (after.accountClass === 'integration') return 'integration_class';
          // First link: the offerer gained a group after signing. Join: its
          // groupId no longer names this group. Both are the offer's roster
          // assumption going stale.
          if (rosterEpoch === 0 && after.groupId !== undefined) return 'already_grouped';
          if (rosterEpoch !== 0 && after.groupId !== groupId) return 'stale_epoch';
          // The crew pin — bounded retry below.
        } else if (reasons.slice(4).some((r) => r?.Code === 'ConditionalCheckFailed')) {
          // A member crew pin or a consent-count pin moved (items 4..N) —
          // bounded retry below.
        } else {
          // Only the offer consume failed: consumed by the link that won (or
          // expired inside the race window — same answer, the offer is dead).
          return 'offer_consumed';
        }
        if (attempt > 0) return 'cap_contended';
      }
    },

    async unlinkDeviceFromGroup(input) {
      // The caller's clock stamps any last-exit username tombstone;
      // the store's own wall clock is the landed call sites' fallback.
      return rosterRemoval(doc, { ...input, nowMs: input.nowMs ?? wallNowMs() }, 'unlink');
    },

    async revokeDeviceFromGroup(input) {
      return rosterRemoval(
        doc,
        { ...input, nowMs: input.nowMs ?? wallNowMs() },
        'revoke',
        input.agents ?? [],
      );
    },

    async deleteGroupedUser(userId, groupId, claims, nowMs) {
      // The member-deletion loop: epoch is read fresh and pinned by the
      // shared rosterRemoval body (one machinery for unlink, revoke, AND
      // deletion — two copies is where the epoch rules would drift), with
      // the ordinary bounded retry over raced rosters and the deleteUser
      // tombstoned-claim fallback (`keepClaim`) folded in. Self-mutation by
      // construction (acting = target = the dying member), so the actor
      // ConditionCheck is skipped and the target item's own conditions
      // carry class + liveness + the crew backstop.
      let keepClaim = false;
      for (let attempt = 0; attempt < ROSTER_TXN_ATTEMPTS; attempt++) {
        const group = await this.getAccountGroup(groupId);
        if (!group) return 'unknown_group';
        if (!group.members.some((m) => m.userId === userId)) return 'stale';
        const outcome = await rosterRemoval(
          doc,
          {
            groupId,
            actingUserId: userId,
            targetUserId: userId,
            rosterEpoch: group.epoch,
            nowMs: nowMs ?? wallNowMs(),
          },
          'delete',
          [],
          { ...(claims.identityKeyPub !== undefined ? { identityKeyPub: claims.identityKeyPub } : {}), keepClaim },
        );
        if (outcome === 'deleted') return 'deleted';
        if (outcome === 'crew_not_empty') return 'crew_not_empty';
        if (outcome === 'unknown_group') return 'unknown_group';
        if (outcome === 'claim_tombstoned') {
          // The tombstone survives every deletion (the rule);
          // retry deleting the row alone — deleteUser's exact fallback.
          keepClaim = true;
          continue;
        }
        // stale_epoch / not_member / not_acting_member: a raced mutation —
        // re-read and re-drive from the fresh snapshot.
      }
      return 'stale';
    },

    async purgeLinkOffersForUser(offerNonces) {
      // the offer sweep: one unconditional Delete per (nonce, namespace)
      // GetItem-free, Query-free, idempotent (a dead nonce deletes
      // nothing). Both namespaces per nonce, because the same nonce keys
      // first an init row and then the promoted offer row, and the sweep
      // cannot know which of the two the ceremony reached.
      for (const nonce of offerNonces) {
        await doc.send(
          new DeleteCommand({
            TableName: TABLES.sessions,
            Key: { token: linkOfferKey(nonce) },
          }),
        );
        await doc.send(
          new DeleteCommand({
            TableName: TABLES.sessions,
            Key: { token: linkInitKey(nonce) },
          }),
        );
      }
    },

    async tombstoneAgentBindings(agents) {
      if (agents.length === 0) return 'done';
      const items: TransactItem[] = [];
      for (const agent of agents) {
        // USER row AND idkey claim, mirroring the roster transaction's in-band
        // agent tombstone: the user-row
        // tombstone is the read-time enforcement, the claim tombstone blocks
        // re-auth. `attribute_exists` makes both idempotent — a repeat of the
        // completed revoke re-writes true over true, and a vanished row
        // (a racing self-deletion) fails the condition.
        items.push({
          Update: {
            TableName: TABLES.users,
            Key: { userId: agent.userId },
            UpdateExpression: 'SET tombstoned = :t',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':t': true },
          },
        });
        items.push({
          Update: {
            TableName: TABLES.users,
            Key: { userId: idkeyClaimKey(agent.identityKeyPub) },
            UpdateExpression: 'SET tombstoned = :t',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':t': true },
          },
        });
      }
      const reasons = await sendRosterTransact(doc, items);
      // Any condition lost ⇒ an agent row raced away; the retry re-reads the
      // roster's agent list and drops the dead one (never a partial commit).
      return reasons ? 'binding_conflict' : 'done';
    },

    // --- Email linking + recovery ---
    async putEmailCode(rec) {
      await doc.send(
        new PutCommand({
          TableName: TABLES.sessions,
          // NO `userId` ATTRIBUTE (the linkoffer# rule): the sessions
          // user-index would batch-delete pending codes on every sign-in.
          // The requester rides in `requesterId` instead.
          Item: {
            token: emailCodeKey(rec.userId, rec.purpose),
            kind: 'emailCode',
            requesterId: rec.userId,
            purpose: rec.purpose,
            claimKey: rec.claimKey,
            ...(rec.targetGroupId !== undefined ? { targetGroupId: rec.targetGroupId } : {}),
            deviceClass: rec.deviceClass,
            code: rec.code,
            attempts: rec.attempts,
            createdAt: rec.createdAt,
            expiresAt: rec.expiresAt,
          },
        }),
      );
    },
    async takeEmailCodeAttempt(userId, purpose, nowSeconds) {
      try {
        const res = await doc.send(
          new UpdateCommand({
            TableName: TABLES.sessions,
            Key: { token: emailCodeKey(userId, purpose) },
            // The conditional increment IS the attempt cap (release pin: 5) —
            // and the EXPLICIT expiry check (the clock, never the reaper):
            // an expired-but-unreaped row refuses here, atomically, so
            // concurrent guesses can never share an attempt.
            UpdateExpression: 'ADD attempts :one',
            ConditionExpression: 'kind = :k AND expiresAt > :now AND attempts < :cap',
            ExpressionAttributeValues: {
              ':one': 1,
              ':k': 'emailCode',
              ':now': nowSeconds,
              ':cap': EMAIL_CODE_ATTEMPT_CAP,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        const item = res.Attributes;
        if (!item) return undefined;
        return {
          userId: item.requesterId as string,
          purpose: item.purpose as EmailCodeRecord['purpose'],
          claimKey: item.claimKey as string,
          ...(item.targetGroupId !== undefined
            ? { targetGroupId: item.targetGroupId as string }
            : {}),
          deviceClass: item.deviceClass as DeviceClass,
          code: item.code as string,
          attempts: item.attempts as number,
          createdAt: item.createdAt as number,
          expiresAt: item.expiresAt as number,
        };
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') {
          // The refusal already happened atomically above; whether it was
          // absence, expiry, or the cap is invisible to the caller (one
          // collapsed answer). REAP the expired case physically: the
          // sessions-table TTL is asynchronous cleanup, and "it expires
          // eventually" is not deletion — the conditional delete takes only
          // a row past its OWN clock, so a fresh replacement row (a racing
          // re-request) is never collateral.
          try {
            await doc.send(
              new DeleteCommand({
                TableName: TABLES.sessions,
                Key: { token: emailCodeKey(userId, purpose) },
                ConditionExpression: 'kind = :k AND expiresAt <= :now',
                ExpressionAttributeValues: { ':k': 'emailCode', ':now': nowSeconds },
              }),
            );
          } catch (reapErr) {
            if (errName(reapErr) !== 'ConditionalCheckFailedException') throw reapErr;
          }
          return undefined;
        }
        throw err;
      }
    },
    async deleteEmailCode(userId, purpose) {
      await doc.send(
        new DeleteCommand({
          TableName: TABLES.sessions,
          Key: { token: emailCodeKey(userId, purpose) },
        }),
      );
    },
    async getIdentifierClaim(claimKey) {
      // The key shape is the caller's (opaque-ref derived); the kind check is
      // this layer's — every reader of a shared namespace re-checks
      // attributes rather than trusting key shape.
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: claimKey },
          ConsistentRead: true,
        }),
      );
      const item = res.Item;
      if (!item || item.kind !== 'identifierClaim') return undefined;
      // A username TOMBSTONE is not a claim: this class-general read
      // answers absent for it — the username class reads its own rows
      // through `getUsernameClaim`, which sees (and reaps) tombstones.
      if (item.tombstoned === true) return undefined;
      return {
        claimKey,
        groupId: item.groupId as string,
        createdAt: item.createdAt as number,
        verifiedAt: item.verifiedAt as number,
        discoverable: item.discoverable === true,
        ...(item.discoverableAfter !== undefined
          ? { discoverableAfter: item.discoverableAfter as number }
          : {}),
        ...(typeof item.skeletonKey === 'string' ? { skeletonKey: item.skeletonKey } : {}),
      };
    },
    async migrateIdentifierClaimForward({ oldClaimKey, newClaimKey, claim, newSkeletonKey }) {
      // The username class's skeleton twin moves with the claim: the
      // caller must supply the newest-version skeleton key, or the row would
      // stay behind on the retiring version — loud, never a silent orphan.
      if (claim.skeletonKey !== undefined && newSkeletonKey === undefined) {
        throw new Error('migrate: a username claim moves with its skeleton key');
      }
      // The opportunistic re-write: move a claim that resolved under a
      // retiring key version forward to the newest version so a completed
      // rotation orphans only DORMANT rows, never resolving ones. Read the
      // group's ref snapshot; if it no longer names the old key (unlinked, or
      // a prior migration won) there is nothing to move.
      const gkey = groupRowKey(claim.groupId);
      const groupRes = await doc.send(
        new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
      );
      const groupItem = groupRes.Item;
      if (!groupItem) return 'noop';
      const oldRefs = (groupItem.identifierRefs ?? []) as string[];
      if (!oldRefs.includes(oldClaimKey)) return 'noop';
      const newRefs = oldRefs.map((ref) => (ref === oldClaimKey ? newClaimKey : ref));
      const items: TransactItem[] = [
        {
          // The new-version claim, born once — a racing migration that already
          // wrote it loses here and the whole re-write no-ops (best-effort).
          Put: {
            TableName: TABLES.users,
            Item: {
              userId: newClaimKey,
              kind: 'identifierClaim',
              groupId: claim.groupId,
              createdAt: claim.createdAt,
              verifiedAt: claim.verifiedAt,
              discoverable: claim.discoverable,
              ...(claim.discoverableAfter !== undefined
                ? { discoverableAfter: claim.discoverableAfter }
                : {}),
              ...(newSkeletonKey !== undefined ? { skeletonKey: newSkeletonKey } : {}),
            },
            ConditionExpression: 'attribute_not_exists(userId)',
          },
        },
        {
          // Re-point the group's refs under the snapshot condition (the
          // last-member-exit discipline): a concurrent unlink/attach that
          // moved the refs refuses the whole re-write.
          Update: {
            TableName: TABLES.users,
            Key: { userId: gkey },
            UpdateExpression: 'SET identifierRefs = :new',
            ConditionExpression: 'attribute_exists(userId) AND identifierRefs = :old',
            ExpressionAttributeValues: { ':new': newRefs, ':old': oldRefs },
          },
        },
        {
          // The old-version row goes, its groupId pinned so a key re-minted for
          // another group after a stale snapshot is never collateral.
          Delete: {
            TableName: TABLES.users,
            Key: { userId: oldClaimKey },
            ConditionExpression: 'attribute_not_exists(userId) OR groupId = :g',
            ExpressionAttributeValues: { ':g': claim.groupId },
          },
        },
        // The skeleton twin, same shape: born once under the newest
        // version, the retiring-version row deleted under its claim pin.
        ...(claim.skeletonKey !== undefined && newSkeletonKey !== undefined
          ? [
              {
                Put: {
                  TableName: TABLES.users,
                  Item: {
                    userId: newSkeletonKey,
                    kind: 'usernameSkeleton',
                    groupId: claim.groupId,
                    claimKey: newClaimKey,
                    createdAt: claim.createdAt,
                  },
                  ConditionExpression: 'attribute_not_exists(userId)',
                },
              } satisfies TransactItem,
              {
                Delete: {
                  TableName: TABLES.users,
                  Key: { userId: claim.skeletonKey },
                  ConditionExpression: 'attribute_not_exists(userId) OR groupId = :g',
                  ExpressionAttributeValues: { ':g': claim.groupId },
                },
              } satisfies TransactItem,
            ]
          : []),
      ];
      const reasons = await sendRosterTransact(doc, items);
      // A lost condition ⇒ a racing writer; leave the old row for the next
      // resolution (still resolvable during the window), never a partial commit.
      return reasons ? 'noop' : 'migrated';
    },
    async isIdentifierSuppressed(suppressionKey, nowSeconds) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: suppressionKey },
          ConsistentRead: true,
        }),
      );
      const item = res.Item;
      if (!item || item.kind !== suppressionKindForKey(suppressionKey)) return false;
      const expiresAt = item.expiresAt as number | undefined;
      if (expiresAt !== undefined && expiresAt > nowSeconds) return true;
      // Elapsed (or a pre-expiry-era row, which no deployed store can hold —
      // the class shipped dark): the read is the reaper (the users
      // table has no TTL attribute). The conditional delete takes only an
      // elapsed row, so a concurrent re-suppression's fresh stamp survives;
      // either way THIS send proceeds to SES, whose account-level
      // suppression remains the durable authority and re-writes the shadow
      // synchronously if the address is still bad.
      try {
        await doc.send(
          new DeleteCommand({
            TableName: TABLES.users,
            Key: { userId: suppressionKey },
            ConditionExpression:
              'kind = :k AND (attribute_not_exists(expiresAt) OR expiresAt <= :now)',
            ExpressionAttributeValues: {
              ':k': suppressionKindForKey(suppressionKey),
              ':now': nowSeconds,
            },
          }),
        );
      } catch (err) {
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      }
      return false;
    },
    async putIdentifierSuppression(suppressionKey, nowMs) {
      await doc.send(
        new PutCommand({
          TableName: TABLES.users,
          Item: {
            userId: suppressionKey,
            kind: suppressionKindForKey(suppressionKey),
            suppressedAt: nowMs,
            // The pinned explicit expiry: enforcement is
            // the reading walk above, never a reaper the table doesn't
            // have. PER-CLASS by the key's prefix (the phone
            // pin was declared and read by nothing — an unwired pin is
            // drift waiting to ship); today the two values are aliases, and
            // this read is what makes a future divergence take effect.
            expiresAt:
              Math.floor(nowMs / 1000) +
              (suppressionKey.startsWith(PHONE_SUPPRESSION_PREFIX)
                ? PHONE_SUPPRESSION_TTL_SECONDS
                : EMAIL_SUPPRESSION_TTL_SECONDS),
          },
        }),
      );
    },
    async getIdentifierRecoveryCooldown(claimKeys, nowSeconds) {
      // The identifier-keyed shadow walk (class-
      // aware — each claim key maps to its OWN class's shadow):
      // one strongly consistent GetItem per active claim-key version, max of
      // the still-live stamps — the explicit clock decides, never the reaper.
      let live: number | undefined;
      for (const claimKey of claimKeys) {
        const shadowKey = cooldownKeyFromClaimKey(claimKey);
        const res = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: shadowKey },
            ConsistentRead: true,
          }),
        );
        const item = res.Item;
        if (!item || item.kind !== cooldownKindForKey(shadowKey)) continue;
        const until = item.discoverableAfter as number;
        if (until > nowSeconds && (live === undefined || until > live)) {
          live = until;
          continue;
        }
        // Elapsed: inert by its own clock (unchanged), and REAPED by this
        // walk (the
        // users table has no TTL attribute, so the read is the reaper). The
        // condition takes only a still-elapsed row, so a concurrent
        // recovery completion's fresh stamp is never collateral.
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.users,
              Key: { userId: shadowKey },
              ConditionExpression: 'kind = :k AND discoverableAfter <= :now',
              ExpressionAttributeValues: {
                ':k': cooldownKindForKey(shadowKey),
                ':now': nowSeconds,
              },
            }),
          );
        } catch (err) {
          if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        }
      }
      return live;
    },
    async attachIdentifier({ userId, deviceClass, existingGroupId, newGroupId, claimKey, refsSnapshot, retiringClaimKeys, nowMs, discoverableAfter }) {
      const groupId = existingGroupId ?? newGroupId;
      // THE PER-CLASS BACKSTOP, MADE STRUCTURAL. Until the third class
      // the size cap below enforced one-per-class by COINCIDENCE on a full
      // snapshot: 2 refs met cap 2, so a matching-snapshot same-class attach
      // refused at size. With IDENTIFIER_KINDS at 3 the cap is 3 and that
      // coincidence is gone — a hostile or buggy DataLayer caller passing
      // the matching 2-ref snapshot could append a second same-class ref
      // with DynamoDB's blessing. So the store now checks the CLASS itself,
      // against the exact snapshot the transaction will CAS on: a matching
      // snapshot already holding this class's ref refuses HERE, and a stale
      // one still dies at the `identifierRefs =:snapshot` condition — so no
      // committed attach can ever mint a second ref of one class, whatever
      // the handler checked. size stays beside it as the total backstop.
      if (
        existingGroupId !== undefined &&
        (refsSnapshot ?? []).some(
          (ref) => identifierClassForClaimKey(ref) === identifierClassForClaimKey(claimKey),
        )
      ) {
        return 'identifier_cap';
      }
      const claimItem: TransactItem = {
        Put: {
          TableName: TABLES.users,
          Item: {
            userId: claimKey,
            kind: 'identifierClaim',
            groupId,
            createdAt: nowMs,
            verifiedAt: nowMs,
            // Default OFF, structurally: consent is a LATER owner write.
            discoverable: false,
            // The re-arm rule: a still-live recovery cool-down carried
            // from the GROUP row onto the re-minted claim, so unlink +
            // re-attach cannot shed it.
            ...(discoverableAfter !== undefined ? { discoverableAfter } : {}),
          },
          // One group per identifier, ever — the claim-row discipline: a
          // second group attaching the same address loses HERE, atomically.
          ConditionExpression: 'attribute_not_exists(userId)',
        },
      };
      const codeConsume: TransactItem = {
        Delete: {
          TableName: TABLES.sessions,
          Key: { token: emailCodeKey(userId, 'attach') },
          // Single-use consume of the VALIDATED code row (the challenge-row
          // discipline): kind, purpose, and the claim key it authorized are
          // re-pinned so a replaced row (a racing re-request for a DIFFERENT
          // address) cannot be spent by this attach.
          ConditionExpression: 'kind = :k AND purpose = :p AND claimKey = :c',
          ExpressionAttributeValues: { ':k': 'emailCode', ':p': 'attach', ':c': claimKey },
        },
      };
      // Claim uniqueness across the WHOLE rotation window: the newest-version Put's attribute_not_exists covers only
      // its own version, so each RETIRING-version key is condition-checked
      // absent in the same transaction — the same normalized address can
      // never belong to two groups just because a rotation is in flight.
      const retiringChecks: TransactItem[] = (retiringClaimKeys ?? []).map((key) => ({
        ConditionCheck: {
          TableName: TABLES.users,
          Key: { userId: key },
          ConditionExpression: 'attribute_not_exists(userId)',
        },
      }));
      // The CALLER's class + liveness, pinned in-transaction on the
      // existing-group branch: the solo branch's
      // user-row Update already carries `attribute_not_exists(accountClass)`,
      // but here the caller's row was previously untouched — membership via
      // `contains(memberIds,:caller)` implies human only by construction,
      // and the pinned discipline is precheck AND condition on every
      // identifier surface.
      const callerClassCheck: TransactItem = {
        ConditionCheck: {
          TableName: TABLES.users,
          Key: { userId },
          ConditionExpression:
            'attribute_exists(userId) AND attribute_not_exists(accountClass) AND attribute_not_exists(tombstoned)',
        },
      };
      const items: TransactItem[] =
        existingGroupId !== undefined
          ? [
              claimItem,
              {
                Update: {
                  TableName: TABLES.users,
                  Key: { userId: groupRowKey(existingGroupId) },
                  UpdateExpression: 'SET identifierRefs = list_append(identifierRefs, :ref)',
                  // THE PER-CLASS ONE-SLOT CAP AS A CONDITION: a `size` cap cannot see class
                  // prefixes, so the CLASS half is exact equality against
                  // the snapshot the HANDLER class-checked (no ref of this
                  // class's prefix in it) — a racing same-class attach moved
                  // the snapshot and loses here, atomically, while the other
                  // class's standing ref rides through untouched. The
                  // `size` cap RETURNS beside it (snapshot
                  // equality alone is a CAS, not a cap — a caller passing a
                  // matching snapshot that already held a same-class ref
                  // would have appended a second one with DynamoDB's
                  // blessing): the storage layer refuses ANY growth past
                  // the pinned total (MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
                  // one slot per class), regardless of what the handler
                  // checked. Plus the caller's own membership,
                  // in-transaction (the memberIds rule).
                  ConditionExpression:
                    'attribute_exists(userId) AND identifierRefs = :snapshot AND size(identifierRefs) < :cap AND contains(memberIds, :caller)',
                  ExpressionAttributeValues: {
                    ':ref': [claimKey],
                    ':snapshot': [...(refsSnapshot ?? [])],
                    ':cap': MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
                    ':caller': userId,
                  },
                },
              },
              codeConsume,
              callerClassCheck,
              ...retiringChecks,
            ]
          : [
              claimItem,
              {
                // The lazy solo group: born satisfying the class-slot
                // invariant — the attach call declared the class, there is no
                // classless member state. No ceremony ran, so the member
                // entry honestly carries NO certs (block-and-warn is
                // the correct peer posture for it). `attachCreated` marks the
                // class for the downgrade reap: this
                // client can never learn the minted groupId, so the
                // identifier unlink is its only exit and must take the row.
                Put: {
                  TableName: TABLES.users,
                  Item: {
                    userId: groupRowKey(newGroupId),
                    members: [{ userId, class: deviceClass, linkedAt: nowMs }],
                    memberClasses: new Set([deviceClass]),
                    memberIds: new Set([userId]),
                    identifierRefs: [claimKey],
                    epoch: 1,
                    createdAt: nowMs,
                    attachCreated: true,
                  },
                  ConditionExpression: 'attribute_not_exists(userId)',
                },
              },
              {
                Update: {
                  TableName: TABLES.users,
                  Key: { userId },
                  UpdateExpression: 'SET groupId = :g',
                  // The pristineness condition:
                  // a caller a racing link just grouped fails HERE. The class
                  // condition: an integration can never found a
                  // group — the human-class rule enforced in the transaction,
                  // never only in the handler's identifierEligible precheck.
                  ConditionExpression:
                    'attribute_exists(userId) AND attribute_not_exists(groupId) AND ' +
                    'attribute_not_exists(accountClass)',
                  ExpressionAttributeValues: { ':g': newGroupId },
                },
              },
              codeConsume,
              ...retiringChecks,
            ];
      const reasons = await sendRosterTransact(doc, items);
      if (!reasons) return 'attached';
      const failed = (i: number): boolean => reasons[i]?.Code === 'ConditionalCheckFailed';
      if (failed(0)) return 'claim_exists';
      // A retiring-version claim held elsewhere is the SAME refusal class as
      // the newest-version Put losing: the address is claimed.
      for (let i = items.length - retiringChecks.length; i < items.length; i++) {
        if (failed(i)) return 'claim_exists';
      }
      if (existingGroupId !== undefined) {
        if (failed(1)) {
          const after = await doc.send(
            new GetCommand({
              TableName: TABLES.users,
              Key: { userId: groupRowKey(existingGroupId) },
              ConsistentRead: true,
            }),
          );
          if (!after.Item) return 'unknown_member';
          const ids = after.Item.memberIds as Set<string> | undefined;
          if (!ids || !ids.has(userId)) return 'unknown_member';
          // Classification is UX (everything below collapses upstream): a
          // ref of THIS class present is the per-class slot filled; any
          // other snapshot movement is a raced other-class attach/unlink.
          const refs = (after.Item.identifierRefs ?? []) as string[];
          // Exhaustive over the possession-proof classes: a
          // username key here throws by name rather than reading as email.
          const classPrefix = attachClassPrefixForClaimKey(claimKey);
          return refs.some((ref) => ref.startsWith(classPrefix)) ? 'identifier_cap' : 'stale';
        }
        // The caller-class pin (item 3) refused: not a live human row.
        if (failed(3)) return 'unknown_member';
        return 'code_gone';
      }
      if (failed(1)) return 'already_grouped';
      if (failed(2)) {
        const row = await doc.send(
          new GetCommand({ TableName: TABLES.users, Key: { userId }, ConsistentRead: true }),
        );
        return row.Item ? 'already_grouped' : 'unknown_member';
      }
      return 'code_gone';
    },
    async unlinkIdentifierClass({ userId, groupId, refsSnapshot, claimKeys }) {
      // The shared per-class body (`unlinkIdentifierRefs`, — one copy of
      // the refs CAS, the membership pin, and the lazy-solo reap); this
      // class's rows are DELETED, each under its groupId pin: a claim
      // re-minted for ANOTHER group after a stale snapshot must not be
      // deleted by this caller.
      return unlinkIdentifierRefs(
        doc,
        { userId, groupId, refsSnapshot, claimKeys },
        async () =>
          claimKeys.map(
            (claimKey): TransactItem => ({
              Delete: {
                TableName: TABLES.users,
                Key: { userId: claimKey },
                ConditionExpression: 'attribute_not_exists(userId) OR groupId = :g',
                ExpressionAttributeValues: { ':g': groupId },
              },
            }),
          ),
        async () => (await this.getRecoveryPending(groupId))?.newUserId,
      );
    },
    async setIdentifierDiscoverable(claimKey, groupId, actingUserId, discoverable) {
      // ONE TransactWrite: the consent write
      // commits only while the acting caller is a CURRENT member of the
      // claim's group — the discipline (the handler's snapshot reads
      // are UX, the condition is the authorization), so a member removed
      // after the handler's read, or still visible through a stale
      // eventually consistent user-row read, cannot toggle the surviving
      // group's public discoverability.
      const reasons = await sendRosterTransact(doc, [
        {
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: groupRowKey(groupId) },
            ConditionExpression: 'attribute_exists(userId) AND contains(memberIds, :actor)',
            ExpressionAttributeValues: { ':actor': actingUserId },
          },
        },
        {
          Update: {
            TableName: TABLES.users,
            Key: { userId: claimKey },
            UpdateExpression: 'SET discoverable = :d',
            // The groupId pin: a stale caller cannot toggle a key that has
            // since been re-claimed by another group. The cool-down attribute
            // is deliberately untouched — consent and cool-down are
            // independent halves of the read-time rule.
            ConditionExpression: 'kind = :k AND groupId = :g',
            ExpressionAttributeValues: { ':d': discoverable, ':k': 'identifierClaim', ':g': groupId },
          },
        },
        {
          // The ACTOR's class + liveness: consent
          // is an owner decision, and "owner" is human by construction —
          // pinned here so the construction is load-bearing at the write,
          // not only in the handler's precheck.
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: actingUserId },
            ConditionExpression:
              'attribute_exists(userId) AND attribute_not_exists(accountClass) AND attribute_not_exists(tombstoned)',
          },
        },
      ]);
      // Either lost condition — vanished/re-claimed key, or a caller no
      // longer a member — is the same silent 'gone' the uniform 204 absorbs.
      return reasons ? 'gone' : 'set';
    },
    // --- Username claims ---
    async getUsernameClaim(claimKey, nowSeconds) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: claimKey },
          ConsistentRead: true,
        }),
      );
      const item = res.Item;
      if (!item || item.kind !== 'identifierClaim') return undefined;
      if (item.tombstoned !== true) {
        return {
          claimKey,
          groupId: item.groupId as string,
          createdAt: item.createdAt as number,
          verifiedAt: item.verifiedAt as number,
          discoverable: item.discoverable === true,
          ...(item.discoverableAfter !== undefined
            ? { discoverableAfter: item.discoverableAfter as number }
            : {}),
          ...(typeof item.skeletonKey === 'string' ? { skeletonKey: item.skeletonKey } : {}),
        };
      }
      const freesAt = item.freesAt as number;
      const skeletonKey = typeof item.skeletonKey === 'string' ? item.skeletonKey : undefined;
      if (freesAt > nowSeconds) {
        return {
          claimKey,
          tombstoned: true,
          freesAt,
          ...(typeof item.formerGroupId === 'string' ? { formerGroupId: item.formerGroupId } : {}),
          ...(skeletonKey !== undefined ? { skeletonKey } : {}),
        };
      }
      // ELAPSED: inert to the claim condition already (it reads as absent),
      // and REAPED by this read — the suppression-shadow rule (the
      // users table has no TTL attribute, so the read is the reaper). Each
      // delete takes only a still-elapsed TOMBSTONE, so a claim that just
      // overwrote either key with a live row is never collateral. The
      // skeleton tombstone goes with the claim tombstone that remembers it.
      const reap = async (key: string, kind: 'identifierClaim' | 'usernameSkeleton') => {
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.users,
              Key: { userId: key },
              ConditionExpression: 'kind = :k AND tombstoned = :t AND freesAt <= :now',
              ExpressionAttributeValues: { ':k': kind, ':t': true, ':now': nowSeconds },
            }),
          );
        } catch (err) {
          if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        }
      };
      await reap(claimKey, 'identifierClaim');
      if (skeletonKey !== undefined) await reap(skeletonKey, 'usernameSkeleton');
      return undefined;
    },
    async claimUsername({
      userId,
      groupId,
      refsSnapshot,
      claimKey,
      skeletonKey,
      retiringClaimKeys,
      retiringSkeletonKeys,
      discoverable,
      discoverableAfter,
      reclaimingOwn = false,
      nowMs,
    }) {
      // THE PER-CLASS ONE-SLOT CAP, structural (the attach lane's rule):
      // a snapshot already holding a username ref refuses HERE — the
      // handler routes that caller to rename — and a stale snapshot still
      // dies at the refs CAS below, so no committed claim can ever mint a
      // second username ref, whatever the handler checked.
      if (refsSnapshot.some((ref) => identifierClassForClaimKey(ref) === 'username')) {
        return 'identifier_cap';
      }
      const nowSeconds = Math.floor(nowMs / 1000);
      // THE COOL-DOWN AS A CONDITION ON THE CLAIM (the hoarding fix): the
      // rename's exact clause — `usernameRenamedAt` absent or ≥30 days old
      // because unlink stamps it and a claim of ANOTHER name after an
      // unlink is a rename in two verbs. Dropped for the reclaim of this
      // group's own live tombstone (the handler's pre-read), so the
      // former-owner right is never priced. Never stamped by a claim.
      const cooldownClause = reclaimingOwn
        ? ''
        : ' AND (attribute_not_exists(usernameRenamedAt) OR usernameRenamedAt <= :cutoff)';
      const cooldownValues = reclaimingOwn
        ? {}
        : { ':cutoff': nowSeconds - USERNAME_RENAME_COOLDOWN_SECONDS };
      const items: TransactItem[] = [
        {
          // (0) The exact-name row, born under the newest version — the
          // EXPLICIT consent bit from the request (the row's default
          // stays OFF, this is the one write that may set it ON at birth),
          // claimedAt-as-verifiedAt (the landed record shape), the skeleton
          // twin's key carried for every later lifecycle site, and the
          // recovery cool-down re-armed from the group carrier.
          Put: {
            TableName: TABLES.users,
            Item: {
              userId: claimKey,
              kind: 'identifierClaim',
              groupId,
              createdAt: nowMs,
              verifiedAt: nowMs,
              discoverable,
              skeletonKey,
              ...(discoverableAfter !== undefined ? { discoverableAfter } : {}),
            },
            ConditionExpression: USERNAME_CLAIM_FREE_CONDITION,
            ExpressionAttributeValues: usernameClaimFreeValues(nowSeconds, groupId),
          },
        },
        {
          // (1) The skeleton row SAME condition: `al1ce` is
          // unclaimable while `alice` stands, and vice versa.
          Put: {
            TableName: TABLES.users,
            Item: {
              userId: skeletonKey,
              kind: 'usernameSkeleton',
              groupId,
              claimKey,
              createdAt: nowMs,
            },
            ConditionExpression: USERNAME_CLAIM_FREE_CONDITION,
            ExpressionAttributeValues: usernameClaimFreeValues(nowSeconds, groupId),
          },
        },
        {
          // (2) The group takes the ref under the refs CAS (the per-class
          // slot's atomic arm), the `size()` total backstop, the caller's
          // membership in-transaction — the attach Update's exact condition
          // — and the cool-down clause above.
          Update: {
            TableName: TABLES.users,
            Key: { userId: groupRowKey(groupId) },
            UpdateExpression: 'SET identifierRefs = list_append(identifierRefs, :ref)',
            ConditionExpression:
              'attribute_exists(userId) AND identifierRefs = :snapshot AND size(identifierRefs) < :cap AND contains(memberIds, :caller)' +
              cooldownClause,
            ExpressionAttributeValues: {
              ':ref': [claimKey],
              ':snapshot': [...refsSnapshot],
              ':cap': MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
              ':caller': userId,
              ...cooldownValues,
            },
          },
        },
        {
          // (3) The caller's class + liveness pin.
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId },
            ConditionExpression:
              'attribute_exists(userId) AND attribute_not_exists(accountClass) AND attribute_not_exists(tombstoned)',
          },
        },
        // (4..) Uniqueness across the WHOLE rotation window: every retiring-
        // version key of BOTH rows, condition-checked with THE SAME
        // tombstone-aware expression — so a live claim under a retiring
        // version refuses this one, and a former owner's reclaim survives a
        // tombstone sitting on a retiring version (corrected).
        ...[...retiringClaimKeys, ...retiringSkeletonKeys].map(
          (key): TransactItem => ({
            ConditionCheck: {
              TableName: TABLES.users,
              Key: { userId: key },
              ConditionExpression: USERNAME_CLAIM_FREE_CONDITION,
              ExpressionAttributeValues: usernameClaimFreeValues(nowSeconds, groupId),
            },
          }),
        ),
      ];
      const reasons = await sendRosterTransact(doc, items);
      if (!reasons) return 'claimed';
      const failed = (i: number): boolean => reasons[i]?.Code === 'ConditionalCheckFailed';
      // Occupancy outranks every other classification (`taken` is the
      // product's one distinguishable answer): either row, any version.
      if (failed(0) || failed(1)) return 'taken';
      for (let i = 4; i < items.length; i++) {
        if (failed(i)) return 'taken';
      }
      if (failed(2)) {
        const after = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: groupRowKey(groupId) },
            ConsistentRead: true,
          }),
        );
        if (!after.Item) return 'unknown_member';
        const ids = after.Item.memberIds as Set<string> | undefined;
        if (!ids || !ids.has(userId)) return 'unknown_member';
        const refs = (after.Item.identifierRefs ?? []) as string[];
        if (refs.some(isUsernameClaimRef)) return 'identifier_cap';
        // Refs still exactly the snapshot with the caller a member: the
        // `size()` backstop cannot have refused (a snapshot without a
        // username ref holds at most the two possession-proof classes), so
        // the cool-down clause did — the rename's own classification.
        const unchanged =
          refs.length === refsSnapshot.length && refsSnapshot.every((k, i) => refs[i] === k);
        return unchanged && !reclaimingOwn ? 'cooldown' : 'stale';
      }
      if (failed(3)) return 'unknown_member';
      return 'stale';
    },
    async renameUsername({
      userId,
      groupId,
      refsSnapshot,
      oldClaimKey,
      claimKeys,
      skeletonKeys,
      discoverable,
      nowMs,
    }) {
      // The held name under ANY active version is a no-op rename: no
      // transaction (two operations on one item reject wholesale) and no
      // cool-down consumed.
      if (claimKeys.includes(oldClaimKey)) return 'same_name';
      if (!refsSnapshot.includes(oldClaimKey)) return 'stale';
      const old = await readLiveUsernameClaim(doc, oldClaimKey);
      if (!old || old.groupId !== groupId) return 'stale';
      const newClaimKey = claimKeys[0]!;
      const newSkeletonKey = skeletonKeys[0]!;
      // `alice` → `al1ce`: one skeleton row serves both names, so it is
      // RE-POINTED (one Put, pinned to us and to the old claim) rather than
      // tombstoned and re-born in one transaction.
      const sameSkeleton = old.skeletonKey === newSkeletonKey;
      const nowSeconds = Math.floor(nowMs / 1000);
      const newRefs = refsSnapshot.map((ref) => (ref === oldClaimKey ? newClaimKey : ref));
      const items: TransactItem[] = [];
      // (1) The old claim key becomes its tombstone — former owner = this
      // group, 30-day reclaim right. (It remembers its skeleton tombstone
      // for the reaping read only when one is written beside it.)
      items.push(
        usernameTombstoneItem({
          key: oldClaimKey,
          kind: 'identifierClaim',
          groupId,
          nowMs,
          formerGroupId: groupId,
          ...(sameSkeleton ? {} : { skeletonKey: old.skeletonKey }),
        }),
      );
      // (2) The old skeleton key: tombstone, or the re-point.
      items.push(
        sameSkeleton
          ? {
              Put: {
                TableName: TABLES.users,
                Item: {
                  userId: old.skeletonKey,
                  kind: 'usernameSkeleton',
                  groupId,
                  claimKey: newClaimKey,
                  createdAt: nowMs,
                },
                ConditionExpression: 'kind = :k AND groupId = :g AND claimKey = :old',
                ExpressionAttributeValues: {
                  ':k': 'usernameSkeleton',
                  ':g': groupId,
                  ':old': oldClaimKey,
                },
              },
            }
          : usernameTombstoneItem({
              key: old.skeletonKey,
              kind: 'usernameSkeleton',
              groupId,
              nowMs,
              formerGroupId: groupId,
            }),
      );
      // (3) The new claim key under the tombstone-aware condition, the
      // request's explicit consent bit, the recovery cool-down carried
      // from the old row (a rename is not a way to shed it).
      const newClaimIndex = items.length;
      items.push({
        Put: {
          TableName: TABLES.users,
          Item: {
            userId: newClaimKey,
            kind: 'identifierClaim',
            groupId,
            createdAt: nowMs,
            verifiedAt: nowMs,
            discoverable,
            skeletonKey: sameSkeleton ? old.skeletonKey : newSkeletonKey,
            ...(old.discoverableAfter !== undefined
              ? { discoverableAfter: old.discoverableAfter }
              : {}),
          },
          ConditionExpression: USERNAME_CLAIM_FREE_CONDITION,
          ExpressionAttributeValues: usernameClaimFreeValues(nowSeconds, groupId),
        },
      });
      // (4) The new skeleton key, same condition — dropped on the re-point.
      let newSkeletonIndex = -1;
      if (!sameSkeleton) {
        newSkeletonIndex = items.length;
        items.push({
          Put: {
            TableName: TABLES.users,
            Item: {
              userId: newSkeletonKey,
              kind: 'usernameSkeleton',
              groupId,
              claimKey: newClaimKey,
              createdAt: nowMs,
            },
            ConditionExpression: USERNAME_CLAIM_FREE_CONDITION,
            ExpressionAttributeValues: usernameClaimFreeValues(nowSeconds, groupId),
          },
        });
      }
      // (5) The group: the ref re-pointed under the refs CAS and the
      // membership pin, AND THE COOL-DOWN AS A CONDITION — `usernameRenamedAt`
      // absent or at least 30 days old — stamped only when the whole
      // transaction commits (success-only consumption).
      const groupIndex = items.length;
      items.push({
        Update: {
          TableName: TABLES.users,
          Key: { userId: groupRowKey(groupId) },
          UpdateExpression: 'SET identifierRefs = :new, usernameRenamedAt = :nowS',
          ConditionExpression:
            'attribute_exists(userId) AND identifierRefs = :snapshot AND contains(memberIds, :caller) AND ' +
            '(attribute_not_exists(usernameRenamedAt) OR usernameRenamedAt <= :cutoff)',
          ExpressionAttributeValues: {
            ':new': newRefs,
            ':nowS': nowSeconds,
            ':snapshot': [...refsSnapshot],
            ':caller': userId,
            ':cutoff': nowSeconds - USERNAME_RENAME_COOLDOWN_SECONDS,
          },
        },
      });
      // The caller's class + liveness pin.
      const callerIndex = items.length;
      items.push({
        ConditionCheck: {
          TableName: TABLES.users,
          Key: { userId },
          ConditionExpression:
            'attribute_exists(userId) AND attribute_not_exists(accountClass) AND attribute_not_exists(tombstoned)',
        },
      });
      // The retiring-version checks for BOTH new rows, minus the rows this
      // transaction already owns through items 1-2 (a retiring-version
      // twin of the old skeleton is the old skeleton — one operation per
      // item, and it is being tombstoned, not checked).
      const retiringStart = items.length;
      const own = new Set([oldClaimKey, old.skeletonKey]);
      for (const key of [...claimKeys.slice(1), ...skeletonKeys.slice(1)]) {
        if (own.has(key)) continue;
        items.push({
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: key },
            ConditionExpression: USERNAME_CLAIM_FREE_CONDITION,
            ExpressionAttributeValues: usernameClaimFreeValues(nowSeconds, groupId),
          },
        });
      }
      const reasons = await sendRosterTransact(doc, items);
      if (!reasons) return 'renamed';
      const failed = (i: number): boolean => reasons[i]?.Code === 'ConditionalCheckFailed';
      if (failed(newClaimIndex) || (newSkeletonIndex >= 0 && failed(newSkeletonIndex))) {
        return 'taken';
      }
      for (let i = retiringStart; i < items.length; i++) {
        if (failed(i)) return 'taken';
      }
      if (failed(groupIndex)) {
        // Which clause is invisible in the reason — re-read to say which
        // (classification is UX; the refusal already happened atomically):
        // refs still exactly the snapshot with the caller a member means the
        // cool-down clause refused.
        const after = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: groupRowKey(groupId) },
            ConsistentRead: true,
          }),
        );
        if (!after.Item) return 'unknown_member';
        const ids = after.Item.memberIds as Set<string> | undefined;
        if (!ids || !ids.has(userId)) return 'unknown_member';
        const refs = (after.Item.identifierRefs ?? []) as string[];
        const unchanged =
          refs.length === refsSnapshot.length && refsSnapshot.every((k, i) => refs[i] === k);
        return unchanged ? 'cooldown' : 'stale';
      }
      if (failed(callerIndex)) return 'unknown_member';
      // Items 1-2 (the old rows' pins) lost: the held name moved under us.
      return 'stale';
    },
    async unlinkUsername({ userId, groupId, refsSnapshot, claimKey, nowMs }) {
      // The ref must be in the snapshot the CAS binds, or the refs would
      // keep naming a row this call tombstoned.
      if (!refsSnapshot.includes(claimKey)) return 'stale';
      // The skeleton key is learned from the live row (never re-derived);
      // a ref whose live row is already gone contributes no tombstone —
      // the email unlink's `attribute_not_exists` tolerance, same posture.
      const old = await readLiveUsernameClaim(doc, claimKey);
      return unlinkIdentifierRefs(
        doc,
        {
          userId,
          groupId,
          refsSnapshot,
          claimKeys: [claimKey],
          // An unlink is a name change: the surviving group row takes the
          // rename cool-down stamp (the hoarding fix).
          stampUsernameRenamedAt: Math.floor(nowMs / 1000),
        },
        async (dissolve) => {
          if (!old || old.groupId !== groupId) return [];
          // The former-owner right exists only while the group survives to
          // exercise it (a dissolved group's id must not dangle in a row).
          const former = dissolve ? {} : { formerGroupId: groupId };
          return [
            usernameTombstoneItem({
              key: claimKey,
              kind: 'identifierClaim',
              groupId,
              nowMs,
              skeletonKey: old.skeletonKey,
              ...former,
            }),
            usernameTombstoneItem({
              key: old.skeletonKey,
              kind: 'usernameSkeleton',
              groupId,
              nowMs,
              ...former,
            }),
          ];
        },
        async () => (await this.getRecoveryPending(groupId))?.newUserId,
      );
    },
    async revokeUsername({ claimKey, nowMs }) {
      // Bounded re-read loop over the holder's refs CAS (the roster
      // transactions' ROSTER_TXN_ATTEMPTS discipline): a holder renaming or
      // unlinking under the operator moves the rows or the refs, and the
      // retry re-reads rather than mis-tombstoning a name that moved.
      for (let attempt = 0; attempt < ROSTER_TXN_ATTEMPTS; attempt++) {
        const live = await readLiveUsernameClaim(doc, claimKey);
        if (!live) return { outcome: 'gone' };
        const gkey = groupRowKey(live.groupId);
        const groupRes = await doc.send(
          new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
        );
        const refs = (groupRes.Item?.identifierRefs ?? []) as string[];
        const items: TransactItem[] = [
          // Nobody-reclaims: NO formerGroupId on either tombstone.
          usernameTombstoneItem({
            key: claimKey,
            kind: 'identifierClaim',
            groupId: live.groupId,
            nowMs,
            skeletonKey: live.skeletonKey,
          }),
          usernameTombstoneItem({
            key: live.skeletonKey,
            kind: 'usernameSkeleton',
            groupId: live.groupId,
            nowMs,
          }),
        ];
        if (groupRes.Item !== undefined && refs.includes(claimKey)) {
          // The holder's slot reopens: the ref leaves under the CAS, so no
          // live ref ever names a tombstone. (A group row that no longer
          // names the key — drift — leaves the rows' tombstoning to stand
          // alone; nothing here invents a ref to remove.)
          items.push({
            Update: {
              TableName: TABLES.users,
              Key: { userId: gkey },
              UpdateExpression: 'SET identifierRefs = :new',
              ConditionExpression: 'attribute_exists(userId) AND identifierRefs = :old',
              ExpressionAttributeValues: {
                ':new': refs.filter((ref) => ref !== claimKey),
                ':old': refs,
              },
            },
          });
        }
        const reasons = await sendRosterTransact(doc, items);
        if (!reasons) return { outcome: 'revoked', groupId: live.groupId };
        // Any lost condition: the rows or the refs moved — re-read.
      }
      return { outcome: 'stale' };
    },
    async putRecoveryPending(rec) {
      // Snapshot the standing row FIRST: a
      // replacement over a cancelled/expired row for a DIFFERENT device
      // must clear the displaced device's reverse pointer post-commit, and
      // the only place its ULID exists is the row this Put overwrites.
      const standing = await this.getRecoveryPending(rec.groupId);
      const reasons = await sendRosterTransact(doc, [
        {
          Put: {
            TableName: TABLES.users,
            Item: {
              userId: recoveryRowKey(rec.groupId),
              kind: 'recoveryPending',
              groupId: rec.groupId,
              newUserId: rec.newUserId,
              deviceClass: rec.deviceClass,
              claimKey: rec.claimKey,
              // The identifier class AT BIRTH — derived
              // from the claim-key PREFIX that proved the code, NEVER from
              // the caller (any identifierClass on `rec` is ignored): what
              // the phone kill switch reads on the shared completion path.
              // The recovery-lane NARROWING: a username-class key here
              // is a programming error that throws, never a recorded class.
              identifierClass: recoveryIdentifierClassForClaimKey(rec.claimKey),
              requestedAt: rec.requestedAt,
              completesAt: rec.completesAt,
              expiresAt: rec.expiresAt,
            },
            // ONE pending recovery per group — but a CANCELLED or expired
            // row is not pending: a fresh legitimate recovery (the user who
            // fat-fingered the class, or whose first attempt a cautious
            // sibling killed) replaces it rather than being locked out until
            // the TTL reaper happens by.
            ConditionExpression:
              'attribute_not_exists(userId) OR canceled = :true OR expiresAt <= :nowS',
            ExpressionAttributeValues: {
              ':true': true,
              ':nowS': Math.floor(rec.requestedAt / 1000),
            },
          },
        },
        {
          Update: {
            TableName: TABLES.users,
            Key: { userId: rec.newUserId },
            // The reverse pointer, under the recovering device's OWN
            // pristineness condition: a grouped device can never hold a
            // pending recovery ('s rule, applied to this verb).
            // The class condition is the: an agent never drives a
            // recovery ceremony — enforced in the transaction, never only in
            // the handler's identifierEligible precheck.
            UpdateExpression: 'SET recoveryGroupId = :g',
            ConditionExpression:
              'attribute_exists(userId) AND attribute_not_exists(groupId) AND ' +
              'attribute_not_exists(tombstoned) AND attribute_not_exists(accountClass)',
            ExpressionAttributeValues: { ':g': rec.groupId },
          },
        },
        // THE LIVENESS PINS: the handler's claim
        // re-resolve and group read are prechecks — a deletion sweep, an
        // identifier unlink, or a dissolution committing between them and
        // this transaction would otherwise mint a recovery row for a DEAD
        // group (an orphan no member can ever cancel and no sweep will ever
        // walk). Both facts are re-bound here as ConditionChecks, so a
        // recovery row can only be born while the claim still names the
        // group AND the group row still exists — thereafter its fate rides
        // the group's (last-member exit, dissolve, lazy-solo reap all
        // delete it in-transaction).
        {
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: rec.claimKey },
            ConditionExpression: 'kind = :ck AND groupId = :cg',
            ExpressionAttributeValues: { ':ck': 'identifierClaim', ':cg': rec.groupId },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: groupRowKey(rec.groupId) },
            ConditionExpression: 'attribute_exists(userId)',
          },
        },
      ]);
      if (!reasons) {
        // Committed: the displaced device's pointer (if any) is cleared as
        // the same best-effort cleanup every reap site runs — conditioned on
        // still naming THIS group, so a device that re-entered a fresh
        // recovery elsewhere is never collateral.
        if (standing !== undefined && standing.newUserId !== rec.newUserId) {
          await clearRecoveryPointer(doc, rec.groupId, standing.newUserId);
        }
        return 'created';
      }
      if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'exists';
      if (reasons[1]?.Code === 'ConditionalCheckFailed') {
        const row = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: rec.newUserId },
            ConsistentRead: true,
          }),
        );
        return row.Item ? 'not_pristine' : 'unknown_member';
      }
      if (
        reasons[2]?.Code === 'ConditionalCheckFailed' ||
        reasons[3]?.Code === 'ConditionalCheckFailed'
      ) {
        // Claim unlinked or group gone since the precheck — the same
        // collapsed refusal every recovery race answers (the handler folds
        // every non-'created' outcome into accountsRefusal).
        return 'stale';
      }
      throw new Error('recovery pending: unclassifiable transaction cancellation');
    },
    async getRecoveryPending(groupId) {
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: recoveryRowKey(groupId) },
          ConsistentRead: true,
        }),
      );
      const item = res.Item;
      if (!item || item.kind !== 'recoveryPending') return undefined;
      return {
        groupId: item.groupId as string,
        newUserId: item.newUserId as string,
        deviceClass: item.deviceClass as DeviceClass,
        claimKey: item.claimKey as string,
        // The claim-key PREFIX is authoritative and the read FAILS CLOSED
        // (the bare `?? 'email'` was the one
        // fail-OPEN link in the phone kill switch — a phone row whose
        // stored attribute went missing would have completed with the flag
        // deleted). The prefix is the SAME derivation putRecoveryPending
        // records at birth (identifierClassForClaimKey); the stored 'phone'
        // value is honored as belt. Only a non-phone prefix with no phone
        // attribute reads 'email' — every genuine previous row.
        identifierClass:
          (item.claimKey as string).startsWith(PHONE_CLAIM_KEY_PREFIX) ||
          item.identifierClass === 'phone'
            ? 'phone'
            : 'email',
        requestedAt: item.requestedAt as number,
        completesAt: item.completesAt as number,
        ...(item.canceled === true ? { canceled: true } : {}),
        expiresAt: item.expiresAt as number,
      };
    },
    async cancelRecoveryPending(groupId, nowSeconds) {
      try {
        const res = await doc.send(
          new UpdateCommand({
            TableName: TABLES.users,
            Key: { userId: recoveryRowKey(groupId) },
            UpdateExpression: 'SET canceled = :t',
            // Existence + the row's own explicit expiry: the cancel lands at
            // any point inside (or after) the delay while the row is LIVE,
            // idempotently — completion's attribute_not_exists(canceled) is
            // the other half of "the cancel WINS", and DynamoDB serializes
            // the two writes. An EXPIRED row is not cancellable (completion
            // already refuses it by the clock) — it is reapable, below.
            ConditionExpression: 'attribute_exists(userId) AND kind = :k AND expiresAt > :now',
            ExpressionAttributeValues: { ':t': true, ':k': 'recoveryPending', ':now': nowSeconds },
            // ALL_NEW for the recovering device's ULID: a LIVE
            // cancel used to leave the refused device's
            // reverse pointer standing indefinitely — the canceled row stays
            // (replaceable, readable-refusing), but the pointer clears now,
            // like every other site that retires a recovery.
            ReturnValues: 'ALL_NEW',
          }),
        );
        const canceledFor = res.Attributes?.newUserId as string | undefined;
        if (canceledFor !== undefined) {
          await clearRecoveryPointer(doc, groupId, canceledFor);
        }
        return 'canceled';
      } catch (err) {
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      }
      // The refusing read REAPS the expired case physically (the
      // users table has no TTL attribute, so "it expires eventually" was
      // false for this class until now). Conditioned on the row's OWN clock,
      // so a fresh legitimate replacement row is never collateral; the
      // recovering device's reverse pointer is cleared as the same
      // best-effort cleanup the other reap sites run.
      const stale = await this.getRecoveryPending(groupId);
      if (stale !== undefined && stale.expiresAt <= nowSeconds) {
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.users,
              Key: { userId: recoveryRowKey(groupId) },
              ConditionExpression: 'kind = :k AND expiresAt <= :now',
              ExpressionAttributeValues: { ':k': 'recoveryPending', ':now': nowSeconds },
            }),
          );
          await clearRecoveryPointer(doc, groupId, stale.newUserId);
        } catch (reapErr) {
          if (errName(reapErr) !== 'ConditionalCheckFailedException') throw reapErr;
        }
      }
      return 'gone';
    },
    async completeRecovery({ groupId, newUserId, nowSeconds, linkedAtMs, discoverableAfter }) {
      // Bounded pin retry (the link transaction's
      // discipline): a lost count pin re-reads and re-runs once; twice is
      // honest contention, collapsed upstream like every recovery refusal.
      for (let attempt = 0; attempt < 2; attempt++) {
      // Snapshot reads — UX and item-building only; every decision below is
      // re-bound inside the transaction's conditions (the discipline:
      // the precheck is UX, the condition is the authorization).
      const pending = await this.getRecoveryPending(groupId);
      if (!pending || pending.newUserId !== newUserId) return { outcome: 'gone' };
      if (pending.canceled === true) return { outcome: 'canceled' };
      if (pending.completesAt > nowSeconds) return { outcome: 'not_ready' };
      // THE UPPER BOUND, enforced by the CLOCK not the TTL reaper: a
      // pending row proven days ago must not stay completable forever
      // long after the 72 h notice scrolled off every survivor's screen. The
      // completion window is [completesAt, expiresAt); past it the row is
      // stale, whether or not the async reaper has swept it. The Delete
      // condition below re-binds this atomically. And the refusing read now
      // REAPS the expired row physically (the users table has no TTL
      // attribute at all, so nothing else ever would): conditioned on the
      // row's own clock so a fresh replacement is never collateral, with the
      // recovering device's reverse pointer cleared as best-effort cleanup.
      if (pending.expiresAt <= nowSeconds) {
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.users,
              Key: { userId: recoveryRowKey(groupId) },
              ConditionExpression: 'kind = :k AND expiresAt <= :now',
              ExpressionAttributeValues: { ':k': 'recoveryPending', ':now': nowSeconds },
            }),
          );
          await clearRecoveryPointer(doc, groupId, pending.newUserId);
        } catch (reapErr) {
          if (errName(reapErr) !== 'ConditionalCheckFailedException') throw reapErr;
        }
        return { outcome: 'stale' };
      }
      // THE PROVING CLAIM MUST STILL NAME THIS GROUP: a member
      // who cut the identifier off during the window — unlink, the intuitive
      // "kill the email" defense — revoked the very basis the code proved, so
      // completion refuses, mirroring the verify leg's re-resolve. A dissolved
      // group already fails the group read below; this catches the group that
      // merely lost its identifier.
      const provingClaim = await this.getIdentifierClaim(pending.claimKey);
      if (!provingClaim || provingClaim.groupId !== groupId) return { outcome: 'stale' };
      const gkey = groupRowKey(groupId);
      const current = await doc.send(
        new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
      );
      const row = current.Item;
      // Claims die with the group's last member, so a claim that resolved at
      // request time names a group that has since dissolved: nothing to
      // recover.
      if (!row) return { outcome: 'stale' };
      const epoch = row.epoch as number;
      const members = (row.members ?? []) as AccountGroupMember[];
      const incumbentMember = members.find((m) => m.class === pending.deviceClass);
      let incumbentKey: string | undefined;
      if (incumbentMember) {
        const victim = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: incumbentMember.userId },
            ConsistentRead: true,
          }),
        );
        incumbentKey = victim.Item?.identityKeyPub as string | undefined;
        if (!incumbentKey) return { outcome: 'stale' };
      }
      const newMember: AccountGroupMember = {
        userId: newUserId,
        class: pending.deviceClass,
        linkedAt: linkedAtMs,
        // NO certs, honestly: no ceremony ran — peers owe this device
        // the full TOFU ceremony and siblings see an un-cross-signed
        // member (block-and-warn) until a human accepts it.
      };
      const remaining = members.filter((m) => m.userId !== (incumbentMember?.userId ?? ''));
      const nextMembers = [...remaining, newMember];
      if (!incumbentMember && members.length >= ACCOUNT_GROUP_MAX_MEMBERS) {
        return { outcome: 'stale' };
      }
      const identifierRefs = (row.identifierRefs ?? []) as string[];

      // THE MERGED-CAP SUM (the link
      // transaction's exact discipline, sum-fresh-and-pin): recovery
      // admission conditions class and groupId but NOT crew/consent state,
      // so a lived-in solo account CAN recover into a group — and without
      // this sum the post-recovery roster would hold its capacity on top of
      // the survivors'. Sum every post-recovery member's counters, refuse
      // what would EXCEED a cap, and pin every operand in the transaction
      // below so a concurrent adopt/consent write cancels the completion
      // instead of slipping the sum. The INCUMBENT's counters leave with it
      // (they ride its ULID — binding-fate carrier), so only
      // `nextMembers` sum.
      const readCrewCount = async (id: string): Promise<number | undefined> => {
        const res = await doc.send(
          new GetCommand({ TableName: TABLES.users, Key: { userId: id }, ConsistentRead: true }),
        );
        return res.Item?.crewCount as number | undefined;
      };
      const readConsentCount = async (id: string): Promise<number | undefined> => {
        const res = await doc.send(
          new GetCommand({
            TableName: TABLES.consentEdges,
            Key: { userId: id, agentId: CONSENT_COUNT_KEY },
            ConsistentRead: true,
          }),
        );
        return res.Item?.edges as number | undefined;
      };
      const crewCounts = new Map<string, number | undefined>();
      const consentCounts = new Map<string, number | undefined>();
      let mergedCrew = 0;
      let mergedConsent = 0;
      for (const member of nextMembers) {
        const crew = await readCrewCount(member.userId);
        crewCounts.set(member.userId, crew);
        mergedCrew += crew ?? 0;
        const edges = await readConsentCount(member.userId);
        consentCounts.set(member.userId, edges);
        mergedConsent += edges ?? 0;
      }
      if (mergedCrew > CREW_MAX_MEMBERS || mergedConsent > CONSENT_MAX_EDGES) {
        return { outcome: 'cap_exceeded' };
      }
      const items: TransactItem[] = [
        {
          Delete: {
            TableName: TABLES.users,
            Key: { userId: recoveryRowKey(groupId) },
            // THE RECOVERY GUARDS AS CONDITIONS ("transaction-enforced,
            // not advisory"): the caller is the device the code proved, the
            // 72 h delay has elapsed on the transaction's OWN clock check,
            // and no surviving member cancelled — the cancel WINS because
            // this condition loses to it under serialization.
            ConditionExpression:
              'kind = :k AND newUserId = :u AND completesAt <= :now AND expiresAt > :now AND attribute_not_exists(canceled)',
            ExpressionAttributeValues: {
              ':k': 'recoveryPending',
              ':u': newUserId,
              ':now': nowSeconds,
            },
          },
        },
        {
          Update: {
            TableName: TABLES.users,
            Key: { userId: gkey },
            // The replace shape under the epoch pin: members,
            // memberClasses, and memberIds recomputed from the pinned
            // snapshot, epoch bumped — a kit rebind or roster mutation that
            // committed after the snapshot refuses the whole transaction
            // (the two recovery verbs serialize on exactly this condition,
            // coexistence).
            UpdateExpression:
              'SET members = :m, memberClasses = :cls, memberIds = :ids, epoch = :next, discoverableAfter = :da',
            ConditionExpression: 'attribute_exists(userId) AND epoch = :e',
            ExpressionAttributeValues: {
              ':m': nextMembers,
              ':cls': new Set(nextMembers.map((m) => m.class)),
              ':ids': new Set(nextMembers.map((m) => m.userId)),
              ':next': epoch + 1,
              ':e': epoch,
              // The GROUP-LEVEL cool-down carrier: survives the
              // claim rows' unlink, so a re-minted claim re-arms from it.
              ':da': discoverableAfter,
            },
          },
        },
        {
          Update: {
            TableName: TABLES.users,
            Key: { userId: newUserId },
            // The recovered device is a NEW ULID with a NEW key: its row
            // must still be pristine — attribute_not_exists(groupId) — so a
            // device that linked anywhere in the 72 h window cannot ALSO
            // complete a recovery. The reverse pointer clears with the join.
            // The class condition: an agent never becomes a
            // group member through ANY verb, recovery included. The crew pin:
            // the merged-cap sum above holds
            // at commit.
            UpdateExpression: 'SET groupId = :g REMOVE recoveryGroupId',
            ConditionExpression:
              'attribute_exists(userId) AND attribute_not_exists(groupId) AND ' +
              'attribute_not_exists(tombstoned) AND attribute_not_exists(accountClass) AND ' +
              `(${crewPin(crewCounts.get(newUserId), ':nuCrew')})`,
            ExpressionAttributeValues: {
              ':g': groupId,
              ...(crewCounts.get(newUserId) !== undefined
                ? { ':nuCrew': crewCounts.get(newUserId) }
                : {}),
            },
          },
        },
        // The 7-day discovery cool-down, stamped as SCHEMA on every claim row
        // (a read-time rule, no scheduler) — consent itself is untouched.
        ...identifierRefs.map(
          (ref): TransactItem => ({
            Update: {
              TableName: TABLES.users,
              Key: { userId: ref },
              UpdateExpression: 'SET discoverableAfter = :da',
              ConditionExpression: 'attribute_exists(userId) AND groupId = :g',
              ExpressionAttributeValues: { ':da': discoverableAfter, ':g': groupId },
            },
          }),
        ),
        // THE IDENTIFIER-KEYED CARRIERS (CROSS-CLASS): completion arms a
        // cool-down shadow for EVERY identifier the group holds — BOTH
        // classes — plus the proving claim key itself (it may have been
        // unlinked mid-window and so be absent from the refs). One shadow
        // per class was the reopened re-attach hole: a phone-proved recovery
        // armed only phonecool#, so unlinking the EMAIL and re-attaching it
        // from a brand-new account was born with a clean slate inside the
        // 7-day window. The shadow rows outlive the claim rows AND the
        // group row, so no unlink / dissolve / fresh-account re-attach loop
        // in EITHER class — can shed the cool-down; the attach legs read
        // them back across every active key version.
        // Unconditional replaces: a later recovery stamps a later horizon.
        // A username ref on the group (onward) maps to NO shadow and is
        // filtered, not thrown on: the handle class is
        // recovery-excluded, and its presence must never brick an email- or
        // phone-proved completion.
        ...[
          ...new Set(
            [pending.claimKey, ...identifierRefs]
              .map(cooldownShadowKeyForClaimKey)
              .filter((key): key is string => key !== null),
          ),
        ].map(
          (shadowKey): TransactItem => ({
            Put: {
              TableName: TABLES.users,
              Item: {
                userId: shadowKey,
                kind: cooldownKindForKey(shadowKey),
                discoverableAfter,
                updatedAt: nowSeconds,
              },
            },
          }),
        ),
      ];
      if (incumbentMember && incumbentKey !== undefined) {
        // THE INCUMBENT CASE IS THE NORMAL CASE: the ordinary lost phone
        // still sits in the phone slot, and completion is the replace
        // transaction — revoke-with-tombstone of the incumbent + attach of
        // the recovered device, ONE TransactWrite. Row tombstone + idkey
        // claim tombstone: the record is the enforcement;
        // the caller re-drives teardown as cleanup.
        items.push({
          Update: {
            TableName: TABLES.users,
            Key: { userId: incumbentMember.userId },
            UpdateExpression: 'SET tombstoned = :t, formerGroupId = :g REMOVE groupId',
            ConditionExpression: 'attribute_exists(userId) AND groupId = :g',
            ExpressionAttributeValues: { ':t': true, ':g': groupId },
          },
        });
        items.push({
          Update: {
            TableName: TABLES.users,
            Key: { userId: idkeyClaimKey(incumbentKey) },
            UpdateExpression: 'SET tombstoned = :t',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':t': true },
          },
        });
      }
      // THE FINDING-4 PINS, appended LAST so every classification index
      // above stays stable: each SURVIVOR's crewCount still at its read
      // value (the new member's pin rides its own Update item), and every
      // post-recovery member's consent `#count` likewise — ConditionChecks
      // that read one row inside the transaction and mutate nothing (the
      // link transaction's items 4..N, one shape).
      const pinStart = items.length;
      remaining.forEach((member, i) => {
        items.push({
          ConditionCheck: {
            TableName: TABLES.users,
            Key: { userId: member.userId },
            ConditionExpression: crewPin(crewCounts.get(member.userId), `:rc${i}`),
            ...(crewCounts.get(member.userId) !== undefined
              ? { ExpressionAttributeValues: { [`:rc${i}`]: crewCounts.get(member.userId) } }
              : {}),
          },
        });
      });
      nextMembers.forEach((member, i) => {
        items.push({
          ConditionCheck: {
            TableName: TABLES.consentEdges,
            Key: { userId: member.userId, agentId: CONSENT_COUNT_KEY },
            ConditionExpression: edgesPin(consentCounts.get(member.userId), `:re${i}`),
            ...(consentCounts.get(member.userId) !== undefined
              ? { ExpressionAttributeValues: { [`:re${i}`]: consentCounts.get(member.userId) } }
              : {}),
          },
        });
      });
      const reasons = await sendRosterTransact(doc, items);
      if (!reasons) {
        return {
          outcome: 'completed',
          deviceClass: pending.deviceClass,
          rosterEpoch: epoch + 1,
          ...(incumbentMember && incumbentKey !== undefined
            ? { incumbent: { userId: incumbentMember.userId, identityKeyPub: incumbentKey } }
            : {}),
          survivors: remaining.map((m) => m.userId),
        };
      }
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        // Re-read to say WHICH guard won — classification is UX; the refusal
        // already happened atomically above.
        const after = await this.getRecoveryPending(groupId);
        if (!after || after.newUserId !== newUserId) return { outcome: 'gone' };
        if (after.canceled === true) return { outcome: 'canceled' };
        if (after.completesAt > nowSeconds) return { outcome: 'not_ready' };
        // Past its window, or the proving claim gone: either way stale (both
        // already collapse to the one refusal upstream).
        return { outcome: 'stale' };
      }
      // A count pin lost to concurrent adopt/consent traffic —
      // or the new member's own Update refused on its crew pin alone (its
      // pristineness clauses re-read intact): re-read and re-run once.
      const failed = (i: number): boolean => reasons[i]?.Code === 'ConditionalCheckFailed';
      let pinLost = false;
      for (let i = pinStart; i < items.length; i++) if (failed(i)) pinLost = true;
      if (failed(2)) {
        const after = await doc.send(
          new GetCommand({ TableName: TABLES.users, Key: { userId: newUserId }, ConsistentRead: true }),
        );
        const u = after.Item as UserRecord | undefined;
        if (
          !u ||
          u.groupId !== undefined ||
          u.tombstoned === true ||
          u.accountClass !== undefined
        ) {
          return { outcome: 'stale' };
        }
        pinLost = true;
      }
      if (pinLost && !failed(1)) continue;
      return { outcome: 'stale' };
      }
      return { outcome: 'stale' };
    },
    async purgeIdentifierArtifactsForUser(userId, hints, nowMs) {
      // the sweep slice: idempotent, keyed off the pre-delete
      // read's hints, best-effort in the same sense every sweep step is —
      // a crash mid-way is re-driven by the caller's retry; the FULL sweep
      // (multi-member groups, offer rows) is stated on the interface.
      // BOTH per-purpose code slots (attach and recovery) die with the
      // account — the slots are per purpose, and the sweep takes
      // every one of them.
      await doc.send(
        new DeleteCommand({
          TableName: TABLES.sessions,
          Key: { token: emailCodeKey(userId, 'attach') },
        }),
      );
      await doc.send(
        new DeleteCommand({
          TableName: TABLES.sessions,
          Key: { token: emailCodeKey(userId, 'recovery') },
        }),
      );
      if (hints.recoveryGroupId !== undefined) {
        // The account dying WAS a pending recovering device: its recovery row
        // goes too (conditioned on still naming it — a row re-minted for a
        // different device survives).
        try {
          await doc.send(
            new DeleteCommand({
              TableName: TABLES.users,
              Key: { userId: recoveryRowKey(hints.recoveryGroupId) },
              ConditionExpression: 'kind = :k AND newUserId = :u',
              ExpressionAttributeValues: { ':k': 'recoveryPending', ':u': userId },
            }),
          );
        } catch (err) {
          if (errName(err) !== 'ConditionalCheckFailedException') throw err;
        }
      }
      if (hints.groupId === undefined) return;
      // Sole-member solo group (the attach-created class introduces): the
      // group row, its claim rows, and any pending recovery die with the
      // account, so nothing here joins the unreaped-forever class.
      const res = await doc.send(
        new GetCommand({
          TableName: TABLES.users,
          Key: { userId: groupRowKey(hints.groupId) },
          ConsistentRead: true,
        }),
      );
      const row = res.Item;
      if (!row) return;
      const members = (row.members ?? []) as AccountGroupMember[];
      if (members.length !== 1 || members[0]!.userId !== userId) return;
      const refs = (row.identifierRefs ?? []) as string[];
      const items: TransactItem[] = [
        {
          Delete: {
            TableName: TABLES.users,
            Key: { userId: groupRowKey(hints.groupId) },
            // The last-member-exit snapshot condition: a raced
            // attach re-pointing the refs refuses the delete rather than
            // orphaning an unreachable claim row.
            ConditionExpression: 'identifierRefs = :refs',
            ExpressionAttributeValues: { ':refs': refs },
          },
        },
        ...refs
          .filter((ref) => !isUsernameClaimRef(ref))
          .map(
            (ref): TransactItem => ({
              Delete: { TableName: TABLES.users, Key: { userId: ref } },
            }),
          ),
        // The username rows are tombstoned, not deleted (the dissolve
        // rule rosterRemoval's last-member exit applies, same shape).
        ...(await usernameDissolveTombstones(doc, refs, hints.groupId, nowMs ?? wallNowMs())),
        {
          Delete: {
            TableName: TABLES.users,
            Key: { userId: recoveryRowKey(hints.groupId) },
          },
        },
      ];
      const reasons = await sendRosterTransact(doc, items);
      // A lost snapshot race is left for the retry (the sweep is idempotent);
      // nothing partial committed.
      void reasons;
    },
  };
}

/**
 * Malformed link tuples are programming errors at the caller, thrown
 * loud rather than stored: a first link is exactly the rosterEpoch-0 case
 * and is the only case that carries the offerer's class (the group row is
 * born with both members), and no ceremony links a device to itself or two
 * devices into one class. One validator for the init row AND the offer row,
 * because two copies is where the rules would drift.
 */
function assertWellFormedLinkTuple(rec: LinkOfferInitRecord): void {
  if ((rec.rosterEpoch === 0) !== (rec.offererClass !== undefined)) {
    throw new Error('link offer: offererClass present iff first link (rosterEpoch 0)');
  }
  if (rec.offererUserId === rec.acceptorUserId) {
    throw new Error('link offer: a device cannot link to itself');
  }
  if (rec.offererClass !== undefined && rec.offererClass === rec.acceptorClass) {
    throw new Error('link offer: first link cannot declare one class twice');
  }
}

/** The init-row read behind `getLinkOfferInit` and the promote — strongly
 * consistent, kind-checked, explicit-expiry-checked (the pair-ledger
 * discipline: an expired-but-unreaped row reads as gone). */
async function readLinkOfferInit(
  doc: DynamoDBDocumentClient,
  offerNonce: string,
  nowSeconds: number,
): Promise<LinkOfferInitRecord | undefined> {
  const res = await doc.send(
    new GetCommand({
      TableName: TABLES.sessions,
      Key: { token: linkInitKey(offerNonce) },
      ConsistentRead: true,
    }),
  );
  const item = res.Item;
  if (!item || item.kind !== 'linkOfferInit') return undefined;
  if ((item.expiresAt as number) <= nowSeconds) return undefined;
  return {
    offerNonce: item.offerNonce as string,
    groupId: item.groupId as string,
    offererUserId: item.offererUserId as string,
    acceptorUserId: item.acceptorUserId as string,
    acceptorClass: item.acceptorClass as DeviceClass,
    ...(item.offererClass !== undefined
      ? { offererClass: item.offererClass as DeviceClass }
      : {}),
    rosterEpoch: item.rosterEpoch as number,
    expiresAt: item.expiresAt as number,
  };
}

/**
 * The shared roster-removal transaction behind unlink AND revoke — one
 * body, because the two strengths differ ONLY in what happens to the target
 * row (amicable: groupId cleared, account continues; revoke: row tombstoned
 * with the formerGroupId hint, idkey claim tombstoned), and two copies of
 * the epoch/membership machinery is where drift would live.
 */
/** Count pins: absent-at-read must still be absent, present-at-read
 * still at its read value — both counters only ever move by ADD, so equality
 * is the whole pin. ONE body for the link transaction AND the recovery
 * completion: two copies is where drift would live. */
const crewPin = (value: number | undefined, name: string): string =>
  value === undefined ? 'attribute_not_exists(crewCount)' : `crewCount = ${name}`;
const edgesPin = (value: number | undefined, name: string): string =>
  value === undefined ? 'attribute_not_exists(edges)' : `edges = ${name}`;

/** The roster-removal input with the clock RESOLVED (the wrappers fill the
 * store's wall clock in when the caller passed none): a last member's exit
 * tombstones username rows, and a tombstone needs a `freesAt`. */
type ClockedRosterMutationInput = RosterMutationInput & { nowMs: number };

async function rosterRemoval(
  doc: DynamoDBDocumentClient,
  { groupId, actingUserId, targetUserId, rosterEpoch, nowMs }: ClockedRosterMutationInput,
  strength: 'unlink',
): Promise<UnlinkDeviceResult>;
async function rosterRemoval(
  doc: DynamoDBDocumentClient,
  { groupId, actingUserId, targetUserId, rosterEpoch, nowMs }: ClockedRosterMutationInput,
  strength: 'revoke',
  agents?: readonly AgentBinding[],
): Promise<RevokeDeviceResult>;
async function rosterRemoval(
  doc: DynamoDBDocumentClient,
  { groupId, actingUserId, targetUserId, rosterEpoch, nowMs }: ClockedRosterMutationInput,
  strength: 'delete',
  agents: readonly AgentBinding[],
  deletion: { identityKeyPub?: string; keepClaim: boolean },
): Promise<UnlinkDeviceResult | 'deleted' | 'crew_not_empty' | 'claim_tombstoned'>;
async function rosterRemoval(
  doc: DynamoDBDocumentClient,
  { groupId, actingUserId, targetUserId, rosterEpoch, nowMs }: ClockedRosterMutationInput,
  strength: 'unlink' | 'revoke' | 'delete',
  agents: readonly AgentBinding[] = [],
  deletion?: { identityKeyPub?: string; keepClaim: boolean },
): Promise<UnlinkDeviceResult | RevokeDeviceResult | 'deleted' | 'crew_not_empty' | 'claim_tombstoned'> {
  const gkey = groupRowKey(groupId);
  const current = await doc.send(
    new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
  );
  const row = current.Item;
  if (!row) return 'unknown_group';
  // Classification PREchecks on the snapshot — UX, never the authorization
  //: the transaction below re-binds
  // the epoch AND the acting member's presence in its own
  // ConditionExpressions (`epoch =:e AND contains(memberIds,:actor)`),
  // so a mutation whose actor was removed between this read and commit
  // fails the CONDITION, not a hopeful read. `memberIds` is the derived
  // string-set twin of `members` (the memberClasses pattern) because
  // `contains` cannot walk a list of maps.
  if ((row.epoch as number) !== rosterEpoch) return 'stale_epoch';
  const members = (row.members ?? []) as AccountGroupMember[];
  if (!members.some((m) => m.userId === actingUserId)) return 'not_acting_member';
  if (!members.some((m) => m.userId === targetUserId)) return 'not_member';
  const remaining = members.filter((m) => m.userId !== targetUserId);
  const identifierRefs = (row.identifierRefs ?? []) as string[];

  const groupItem: TransactItem =
    remaining.length === 0
      ? {
          // The last member's departure deletes the group row: a group is
          // its members, and an empty group row would be an orphan the
          // deletion sweep would have to know about. Conditioned on
          // `identifierRefs` not having moved since the snapshot (finding
          // 3): the claim-row deletes appended below take exactly the
          // snapshot's refs with them, and a raced attach re-pointing the
          // list refuses the whole transaction rather than orphaning an
          // unreachable emailhash# row — the reverse list is the ONLY way
          // the GetItem-only sweep can find those rows.
          Delete: {
            TableName: TABLES.users,
            Key: { userId: gkey },
            ConditionExpression:
              'epoch = :e AND contains(memberIds, :actor) AND identifierRefs = :refs',
            ExpressionAttributeValues: {
              ':e': rosterEpoch,
              ':actor': actingUserId,
              ':refs': identifierRefs,
            },
          },
        }
      : {
          Update: {
            TableName: TABLES.users,
            Key: { userId: gkey },
            // members, memberClasses, and memberIds recomputed from the
            // pinned snapshot, never patched in place — under the epoch
            // condition the recomputation is exact, and it self-heals any
            // drift between the list and the derived sets.
            UpdateExpression:
              'SET members = :m, memberClasses = :cls, memberIds = :ids, epoch = :next',
            ConditionExpression:
              'attribute_exists(userId) AND epoch = :e AND contains(memberIds, :actor)',
            ExpressionAttributeValues: {
              ':m': remaining,
              ':cls': new Set(remaining.map((m) => m.class)),
              ':ids': new Set(remaining.map((m) => m.userId)),
              ':next': rosterEpoch + 1,
              ':e': rosterEpoch,
              ':actor': actingUserId,
            },
          },
        };

  const targetItem: TransactItem =
    strength === 'unlink'
      ? {
          Update: {
            TableName: TABLES.users,
            Key: { userId: targetUserId },
            // Amicable: the device continues as the standalone anonymous
            // account it always was — groupId gone, row otherwise intact.
            // The class condition: a
            // member is human by construction of the link conditions, and
            // this keeps that true AT the mutation even under corrupt or
            // future-relaxed roster state — precheck AND condition, every
            // ceremony surface.
            UpdateExpression: 'REMOVE groupId',
            ConditionExpression:
              'attribute_exists(userId) AND groupId = :g AND attribute_not_exists(accountClass)',
            ExpressionAttributeValues: { ':g': groupId },
          },
        }
      : strength === 'delete'
        ? {
            // member DELETION: the roster removal and the
            // guarded user-row delete are ONE transaction, so a refused
            // deletion destroys NOTHING — roster included. The crew
            // backstop rides HERE ('s condition,
            // the deleteUser `requireEmptyCrew` twin): an adopt committing
            // after the handler's read-time check cancels the whole
            // transaction instead of orphaning an unrevokable crew.
            Delete: {
              TableName: TABLES.users,
              Key: { userId: targetUserId },
              ConditionExpression:
                'attribute_exists(userId) AND groupId = :g AND attribute_not_exists(accountClass) AND ' +
                '(attribute_not_exists(crewCount) OR crewCount = :zero)',
              ExpressionAttributeValues: { ':g': groupId, ':zero': 0 },
            },
          }
        : {
          Update: {
            TableName: TABLES.users,
            Key: { userId: targetUserId },
            // Revoke-lost/stolen: the record IS the enforcement —
            // the dead row keeps a non-authoritative
            // formerGroupId so a peer holding only this ULID can re-target
            // and the tombstone is what session validation and the
            // enqueue path refuse on (land those read sites). The
            // class condition: the same belt as above.
            UpdateExpression: 'SET tombstoned = :t, formerGroupId = :g REMOVE groupId',
            ConditionExpression:
              'attribute_exists(userId) AND groupId = :g AND attribute_not_exists(accountClass)',
            ExpressionAttributeValues: { ':t': true, ':g': groupId },
          },
        };

  const transactItems: TransactItem[] = [groupItem, targetItem];
  if (strength === 'revoke') {
    // The victim's identity key never re-auths: same tombstone the
    // integration-revocation ladder writes, in the SAME transaction as the
    // roster removal — "session revocation alone is not revocation".
    const victim = await doc.send(
      new GetCommand({ TableName: TABLES.users, Key: { userId: targetUserId }, ConsistentRead: true }),
    );
    const identityKeyPub = victim.Item?.identityKeyPub as string | undefined;
    if (!identityKeyPub) return 'not_member';
    transactItems.push({
      Update: {
        TableName: TABLES.users,
        Key: { userId: idkeyClaimKey(identityKeyPub) },
        UpdateExpression: 'SET tombstoned = :t',
        // Only an EXISTING claim can be tombstoned (the
        // tombstoneIdentityKey rule) — and every account minted through
        // getOrCreateUserByIdentityKey has one, so a missing claim here is
        // drift worth failing loudly on, not mapping to a refusal.
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeValues: { ':t': true },
      },
    });
  }
  const idkeyItemIndex = strength === 'revoke' ? 2 : -1;
  // DELETION frees the human key (the deleteUser both-or-neither shape,
  // fused into this transaction): claim row deleted beside the user row,
  // conditioned so a TOMBSTONE survives every deletion — when the tombstone guard refuses, the caller retries with
  // `keepClaim` and the row goes alone, exactly deleteUser's fallback.
  let claimItemIndex = -1;
  if (strength === 'delete' && deletion?.identityKeyPub !== undefined && !deletion.keepClaim) {
    claimItemIndex = transactItems.length;
    transactItems.push({
      Delete: {
        TableName: TABLES.users,
        Key: { userId: idkeyClaimKey(deletion.identityKeyPub) },
        ConditionExpression: 'attribute_not_exists(tombstoned)',
      },
    });
  }
  // The victim's agent bindings die in the SAME transaction (binding
  // fate): each named integration gets its USER row AND its idkey claim
  // row tombstoned — the identical pair the victim itself gets — so "session
  // revocation alone is not revocation" holds for agents too. The USER-row
  // tombstone is what makes the RECORD the enforcement across the crash window
  // (auth.ts `isUserTombstoned`, the ws send/enqueue checks read it); the
  // claim tombstone blocks re-auth. Tombstoning the claim ALONE left the
  // agent's already-issued bearer alive until teardown ran — the very
  // enforcement-vs-cleanup inversion closed for the victim,
  // now closed for its agents. Ownership was verified by the handler; the
  // conditions only guard against a row racing away (an agent self-deleting),
  // classified as a retryable conflict, never a partial revoke.
  const agentItemStart = transactItems.length;
  if (strength === 'revoke') {
    for (const agent of agents) {
      transactItems.push({
        Update: {
          TableName: TABLES.users,
          Key: { userId: agent.userId },
          UpdateExpression: 'SET tombstoned = :t',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: { ':t': true },
        },
      });
      transactItems.push({
        Update: {
          TableName: TABLES.users,
          Key: { userId: idkeyClaimKey(agent.identityKeyPub) },
          UpdateExpression: 'SET tombstoned = :t',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: { ':t': true },
        },
      });
    }
  }
  const agentItemEnd = transactItems.length;
  let pendingRecoverer: string | undefined;
  if (remaining.length === 0) {
    // Last member out: every identifier claim row the reverse
    // list names dies in the SAME transaction as the group row —
    // "only deleting the LAST member … deletes the group row, identifier
    // claims, and consent state" (consent lives ON the claim row).
    // Unconditional deletes, appended LAST so the classification indexes
    // above stay stable: the group-row `identifierRefs =:refs` condition
    // already guarantees the list is current at commit, and deleting an
    // already-gone row is a no-op. The refs carry FULL versioned claim keys
    // (`emailhash#v<K>#…`), so the walk is version-complete by construction
    // a rotation-window claim dies exactly like a current-version one.
    // The USERNAME class is the exception: its
    // claim row and skeleton row are TOMBSTONED here, not deleted — the
    // dissolve writes the same 30-day tombstones a rename or unlink does,
    // nobody-reclaims (no `formerGroupId`: this group dies in this same
    // transaction), so a deleted person's name is neither orphaned live nor
    // instantly re-claimable.
    for (const ref of identifierRefs) {
      if (isUsernameClaimRef(ref)) continue;
      transactItems.push({
        Delete: { TableName: TABLES.users, Key: { userId: ref } },
      });
    }
    transactItems.push(...(await usernameDissolveTombstones(doc, identifierRefs, groupId, nowMs)));
    // The pending `recovery#` row dies with its group (before this,
    // a last-member exit orphaned it forever on the TTL-less users table:
    // inert, because completion re-reads the claim and the group, but
    // unreaped). Unconditional for the same reason as the refs. The
    // recovering device's non-authoritative reverse pointer is cleared
    // post-commit as best-effort cleanup (the stale-pointer class) — snapshot its
    // owner now, while the row still exists.
    const pendingRow = await doc.send(
      new GetCommand({
        TableName: TABLES.users,
        Key: { userId: recoveryRowKey(groupId) },
        ConsistentRead: true,
      }),
    );
    if (pendingRow.Item?.kind === 'recoveryPending') {
      pendingRecoverer = pendingRow.Item.newUserId as string;
    }
    transactItems.push({
      Delete: { TableName: TABLES.users, Key: { userId: recoveryRowKey(groupId) } },
    });
  }
  // The ACTOR's class, pinned in-transaction: the
  // `contains(memberIds,:actor)` condition proves membership, and members
  // are human by construction — this keeps that construction load-bearing at
  // the mutation itself. Skipped for a SELF-mutation (actor === target): two
  // operations on one item reject wholesale, and the target item above
  // already carries the identical class condition.
  let actorItemIndex = -1;
  if (actingUserId !== targetUserId) {
    actorItemIndex = transactItems.length;
    transactItems.push({
      ConditionCheck: {
        TableName: TABLES.users,
        Key: { userId: actingUserId },
        ConditionExpression:
          'attribute_exists(userId) AND attribute_not_exists(accountClass) AND attribute_not_exists(tombstoned)',
      },
    });
  }

  const reasons = await sendRosterTransact(doc, transactItems);
  if (!reasons) {
    if (pendingRecoverer !== undefined) {
      await clearRecoveryPointer(doc, groupId, pendingRecoverer);
    }
    return strength === 'unlink' ? 'unlinked' : strength === 'revoke' ? 'revoked' : 'deleted';
  }
  {
    if (idkeyItemIndex >= 0 && reasons[idkeyItemIndex]?.Code === 'ConditionalCheckFailed') {
      // The idkey claim row is missing for a live member: store drift the
      // birth transaction makes impossible. Loud, never silent.
      throw new Error('revoke: identity-key claim row missing for a live member');
    }
    if (claimItemIndex >= 0 && reasons[claimItemIndex]?.Code === 'ConditionalCheckFailed') {
      // The tombstone guard refused the claim delete (deleteUser's fallback
      // class): nothing committed; the caller retries keeping the tombstone.
      return 'claim_tombstoned';
    }
    for (let i = agentItemStart; i < agentItemEnd; i++) {
      if (reasons[i]?.Code === 'ConditionalCheckFailed') {
        // A named agent's claim row vanished after the handler's ownership
        // read — a racing voluntary self-deletion. Nothing committed; the
        // retry re-reads and drops the dead agent from its list.
        return 'binding_conflict';
      }
    }
    if (actorItemIndex >= 0 && reasons[actorItemIndex]?.Code === 'ConditionalCheckFailed') {
      return 'not_acting_member';
    }
    if (reasons[1]?.Code === 'ConditionalCheckFailed') {
      if (strength === 'delete') {
        // The fused row delete refused. Which clause is invisible in the
        // reason — re-read to say which (classification is UX; the refusal
        // already happened atomically): a live crew answers the
        // crew_not_empty the handler owes its caller with NOTHING
        // destroyed; anything else is the ordinary raced-roster class.
        const raced = await doc.send(
          new GetCommand({
            TableName: TABLES.users,
            Key: { userId: targetUserId },
            ConsistentRead: true,
          }),
        );
        if (raced.Item !== undefined && ((raced.Item.crewCount as number | undefined) ?? 0) > 0) {
          return 'crew_not_empty';
        }
        return 'not_member';
      }
      return 'not_member';
    }
    // Group row condition lost: the roster (or its identifier list) moved
    // between snapshot and commit — the losing side of the
    // serialization — or the acting member is absent from `memberIds` (the
    // in-transaction binding).
    const after = await doc.send(
      new GetCommand({ TableName: TABLES.users, Key: { userId: gkey }, ConsistentRead: true }),
    );
    if (!after.Item) return 'unknown_group';
    if ((after.Item.epoch as number) === rosterEpoch) {
      const ids = after.Item.memberIds as Set<string> | undefined;
      if (!ids || !ids.has(actingUserId)) return 'not_acting_member';
    }
    return 'stale_epoch';
  }
}
