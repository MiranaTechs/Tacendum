/**
 * Canonical DynamoDB table names, shared by the table-creation script, the
 * server DB layer, and any tooling. One source of truth.
 */
export const TABLES = {
  users: 'tacendum_users',
  prekeys: 'tacendum_prekeys',
  sessions: 'tacendum_sessions',
  connections: 'tacendum_connections',
  messages: 'tacendum_messages',
  /** VoIP push tokens, one row per user. Single-row-per-user
   * on purpose: multi-device is out of scope, and when it arrives this gains a
   * deviceId sort key — an additive change. */
  pushTokens: 'tacendum_push_tokens',
  /** Fixed-window rate-limit counters: one row per
   * (bucket, window), atomic ADD, reaped by TTL. Holds counts and bucket key
   * strings only — never account identity beyond what the bucket key itself
   * encodes (userIds and source IPs, same data the in-memory limiter held). */
  rateBuckets: 'tacendum_rate_buckets',
  activity: 'tacendum_activity',
  /**
   * Abuse reports. One row per report, keyed by an opaque
   * ULID so nothing about the table's shape reveals who reported whom.
   *
   * THE ONE TABLE THAT CAN HOLD PLAINTEXT, and only ever text a reporting
   * user selected message by message and sent deliberately. Everything else
   * in this system is ciphertext or an identifier; this exists because App
   * Store guideline 1.2 requires a reporting mechanism a human can act on,
   * and end-to-end encryption answers "why can't you filter server-side"
   * without answering "how do I report someone".
   *
   * TTL'd like the rest: a report that has not been acted on within its
   * window is not going to be, and an abuse queue is the last place that
   * should accumulate indefinitely.
   */
  reports: 'tacendum_reports',
  /**
   * Pairwise consent edges: one row per DIRECTED
   * (human userId -> integration agentId) authorization, keyed exactly by
   * that pair, plus one `#count` control row per human partition holding the
   * CONSENT_MAX_EDGES counter the write transaction conditions on.
   *
   * NO INDEX, now or ever, and the absence is the no-enumeration refusal in storage
   * shape: an index over `agentId` would answer "who consented to this
   * agent" — the enumeration this design refuses to every caller including
   * the agent's own owner (the machine.ts stance). Every read is a point
   * GetItem for one caller-supplied pair; the one partition Query is the
   * account-deletion purge, destructive and scoped to the caller's own
   * partition (the purgeQueuedMessages precedent).
   *
   * NOT TTL'd: an edge is durable authorization state, like `crewId` — it
   * dies when its writer deletes it, or with its writer's account.
   */
  consentEdges: 'tacendum_consent_edges',
} as const;

export type TableKey = keyof typeof TABLES;
export type TableName = (typeof TABLES)[TableKey];

/**
 * There is deliberately NO index on the users table.
 *
 * The phone GSI that used to live here (`phone-index`) died with the phone
 * number, and nothing may replace it: an index over
 * any account identifier — a number, an identity key — is a bulk
 * "who is registered" enumeration primitive on a table whose whole point is
 * that it cannot be walked. Identifier -> account resolution goes through the
 * `idkey#` CLAIM ROW instead: a strongly consistent GetItem on the base table
 * that answers for exactly one caller-supplied key at a time. The infra
 * security suite enforces that no execution role holds Query on this table.
 */

/**
 * GSI on the sessions table, userId -> that user's session rows.
 *
 * Sessions are keyed by token DIGEST, so without this index there is no way to
 * find a user's other sessions: a leaked token could only be killed by
 * deleting the whole account, and account deletion left siblings to lapse by
 * TTL. Pending auth-challenge rows live in the same table but carry no
 * `userId`, so DynamoDB leaves them out of the index entirely — which is
 * load-bearing, not incidental: with one, every sign-in's session sweep would
 * batch-delete live challenges.
 */
export const SESSIONS_USER_INDEX = 'user-index';

/** UTC-day lookup for pseudonymous hourly human-activity records. */
export const ACTIVITY_DAY_INDEX = 'activity-day-index';

/**
 * Environment variables carrying the physical table names in AWS, where the
 * CDK stack passes CloudFormation-generated names to Lambda. Locally they are
 * unset and the canonical `TABLES` names above apply. Names only; resolution
 * (reading process.env) lives in the server DB layer so this module stays
 * platform-free for the app and CLI.
 */
export const TABLE_ENV_VARS = {
  users: 'TACENDUM_TABLE_USERS',
  prekeys: 'TACENDUM_TABLE_PREKEYS',
  sessions: 'TACENDUM_TABLE_SESSIONS',
  connections: 'TACENDUM_TABLE_CONNECTIONS',
  messages: 'TACENDUM_TABLE_MESSAGES',
  pushTokens: 'TACENDUM_TABLE_PUSH_TOKENS',
  rateBuckets: 'TACENDUM_TABLE_RATE_BUCKETS',
  activity: 'TACENDUM_TABLE_ACTIVITY',
  reports: 'TACENDUM_TABLE_REPORTS',
  consentEdges: 'TACENDUM_TABLE_CONSENT_EDGES',
} as const satisfies Record<TableKey, string>;

/**
 * The call-metric dedupe table — deliberately BESIDE `TABLES` /
 * `TABLE_ENV_VARS`, not inside them: those name the tables EVERY application
 * function receives (infra's stack suite pins that), and this one is
 * injected into the HTTP function alone (pinned too). It used to exist only
 * in CDK, under an env name hard-coded in the stack, the AWS adapter and the
 * infra test, and the local table script never created it. One contract now:
 * the stack keeps its literal (no CDK change), the adapter reads it from
 * here, and `scripts/create-tables.ts` creates the local twin with the same
 * key and TTL attribute the stack declares. */
export const CALL_METRIC_DEDUPE_TABLE = {
  name: 'tacendum_call_metric_dedupe',
  envVar: 'TACENDUM_TABLE_CALL_METRIC_DEDUPE',
  /** PK `key` (S) — the opaque dedupe key; never a report body or a caller. */
  partitionKey: 'key',
  ttlAttribute: 'expiresAt',
} as const;
