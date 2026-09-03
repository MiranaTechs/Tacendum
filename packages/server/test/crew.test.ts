import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { CREW_MAX_MEMBERS, TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { makeTestOnlyDataLayer, type TestOnlyDataLayer } from '../src/db/data.js';
import { userRefForLog } from '../src/opaque-ref.js';
import { crewAdoptHandler } from '../src/handlers/crew.js';
import { integrationRevokeHandler } from '../src/handlers/integrations.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { allQueued, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * Crew data layer against REAL DynamoDB.
 *
 * The properties under test are transactional, so the memory db cannot prove
 * them: the adopt is one TransactWriteItems whose owner-side condition holds
 * the CREW_MAX_MEMBERS cap (a handler read-then-check would let concurrent
 * adopts both pass), and the release is a conditional ADD
 * whose attribute_exists guard is what keeps a release against a deleted
 * owner from MINTING a ghost user row at crewCount = -1. Runs against
 * DynamoDB Local; skips when it is down unless TACENDUM_REQUIRE_DDB=1.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let db: TestOnlyDataLayer;
let doc: DynamoDBDocumentClient;
let available = false;

/** Distinct identities per run so reruns never collide. Digits only, which is
 * valid Crockford base32, so every minted id is a real ULID. */
const RUN = `${Date.now()}`;
let seq = 0;

/** A fresh, valid, run-unique ULID. */
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** Create an account directly at the data layer, class included. */
async function mkUser(accountClass?: 'integration'): Promise<string> {
  const userId = uid();
  const res = await db.getOrCreateUserByIdentityKey(
    `crew-key-${RUN}-${userId}`,
    userId,
    Date.now(),
    accountClass,
  );
  expect(res.kind).toBe('ok');
  return userId;
}

/** An integration already PAIRED to `owner` via the real write-once bind —
 * the state adoption now requires. Adoption never claims: an
 * unpaired member refuses owner_conflict, so every test whose subject is the
 * adopt itself starts from the paired row production would hand it. */
async function mkPairedIntegration(owner: string): Promise<string> {
  const member = await mkUser('integration');
  expect(await db.bindIntegrationOwner(member, owner)).toBe('bound');
  return member;
}

/** Handler deps over the REAL data layer: the deterministic clock and
 * limiter from the shared helpers, the transactional adopt underneath. The
 * mint is overridden to a run-unique id so reruns against a persistent local
 * table can never collide on a crewId minted by an earlier run. */
let hdeps: TestDeps;
let mintSeq = 0;

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  db = makeTestOnlyDataLayer(doc);
  hdeps = {
    ...makeTestDeps(db),
    newUserId: () => `crew-${RUN}-hmint-${++mintSeq}`,
    // Salted so crew_adopted's edge is pinned as opaque refs.
    userRefSalt: 'crew-test-user-ref-salt',
  };
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.users);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local unavailable');
  }
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('adoptCrewMember', () => {
  gated('adopt stamps the member and mints + stores the crew on the owner', async () => {
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);
    const minted = `crew-${RUN}-mint-a`;

    expect(await db.adoptCrewMember(owner, member, minted)).toBe('adopted');

    const ownerRow = await db.getUserById(owner);
    expect(ownerRow?.crewId).toBe(minted);
    expect(ownerRow?.crewCount).toBe(1);
    const memberRow = await db.getUserById(member);
    expect(memberRow?.crewId).toBe(minted);
    // ownerUserId is the BIND's write; the adopt only stamps crewId onto it
    // (adoption never claims).
    expect(memberRow?.ownerUserId).toBe(owner);
  });

  gated('a second adopt reuses the owner crewId — the fresh mint candidate is ignored', async () => {
    const owner = await mkUser();
    const first = await mkPairedIntegration(owner);
    const second = await mkPairedIntegration(owner);
    const minted = `crew-${RUN}-reuse-a`;

    expect(await db.adoptCrewMember(owner, first, minted)).toBe('adopted');
    // A different candidate on the second call, as the real handler would
    // pass: it must NOT take — one crew per owner.
    expect(await db.adoptCrewMember(owner, second, `crew-${RUN}-reuse-b`)).toBe('adopted');

    expect((await db.getUserById(owner))?.crewId).toBe(minted);
    expect((await db.getUserById(second))?.crewId).toBe(minted);
    // ...and the count reflects both members.
    expect((await db.getUserById(owner))?.crewCount).toBe(2);
  });

  gated('re-adopting the same member answers already and does not double-count', async () => {
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);
    const minted = `crew-${RUN}-again`;

    expect(await db.adoptCrewMember(owner, member, minted)).toBe('adopted');
    expect(await db.adoptCrewMember(owner, member, minted)).toBe('already');

    // The refusal is what protects the count: a slot per member, not per call.
    expect((await db.getUserById(owner))?.crewCount).toBe(1);
  });

  gated('a member already in a DIFFERENT crew refuses: crew_conflict', async () => {
    const ownerA = await mkUser();
    const ownerB = await mkUser();
    const member = await mkPairedIntegration(ownerA);

    expect(await db.adoptCrewMember(ownerA, member, `crew-${RUN}-of-a`)).toBe('adopted');
    expect(await db.adoptCrewMember(ownerB, member, `crew-${RUN}-of-b`)).toBe('crew_conflict');

    // The loser's rows are untouched: no crew minted, no slot taken...
    const bRow = await db.getUserById(ownerB);
    expect(bRow?.crewId).toBeUndefined();
    expect(bRow?.crewCount).toBeUndefined();
    // ...and the member stays exactly where it was.
    const memberRow = await db.getUserById(member);
    expect(memberRow?.crewId).toBe(`crew-${RUN}-of-a`);
    expect(memberRow?.ownerUserId).toBe(ownerA);
  });

  gated('a human-class member refuses: not_integration', async () => {
    const owner = await mkUser();
    const human = await mkUser();

    expect(await db.adoptCrewMember(owner, human, `crew-${RUN}-hum`)).toBe('not_integration');

    // Atomicity: the owner side must have rolled back with it.
    const ownerRow = await db.getUserById(owner);
    expect(ownerRow?.crewId).toBeUndefined();
    expect(ownerRow?.crewCount).toBeUndefined();
    const humanRow = await db.getUserById(human);
    expect(humanRow?.crewId).toBeUndefined();
    expect(humanRow?.ownerUserId).toBeUndefined();
  });

  gated('a member that does not exist refuses: not_integration', async () => {
    const owner = await mkUser();
    expect(await db.adoptCrewMember(owner, uid(), `crew-${RUN}-ghostm`)).toBe('not_integration');
    expect((await db.getUserById(owner))?.crewCount).toBeUndefined();
  });

  gated('a member bound to a DIFFERENT owner refuses: owner_conflict', async () => {
    const ownerA = await mkUser();
    const ownerB = await mkUser();
    const member = await mkUser('integration');
    expect(await db.bindIntegrationOwner(member, ownerB)).toBe('bound');

    expect(await db.adoptCrewMember(ownerA, member, `crew-${RUN}-oc`)).toBe('owner_conflict');

    const memberRow = await db.getUserById(member);
    expect(memberRow?.ownerUserId).toBe(ownerB);
    expect(memberRow?.crewId).toBeUndefined();
  });

  gated('a member already bound to THIS owner adopts fine — the pair-then-adopt path', async () => {
    const owner = await mkUser();
    const member = await mkUser('integration');
    expect(await db.bindIntegrationOwner(member, owner)).toBe('bound');

    expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-pair`)).toBe('adopted');
    expect((await db.getUserById(member))?.crewId).toBe(`crew-${RUN}-pair`);
  });

  gated('an owner row that does not exist refuses: unknown_owner', async () => {
    // Paired to the ghost id by a RAW write: the real
    // bind transaction itself refuses a missing owner (`unknown_owner` — the
    // owner-liveness ConditionCheck), so the ghost-paired row this test
    // needs is synthetic state only drift could produce. An UNPAIRED member
    // would refuse owner_conflict before the owner outcome is even read —
    // adoption never claims — and this test is about the OWNER
    // side of the adopt transaction.
    const ghost = uid();
    const member = await mkUser('integration');
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: member },
        UpdateExpression: 'SET ownerUserId = :o',
        ExpressionAttributeValues: { ':o': ghost },
      }),
    );
    expect(await db.adoptCrewMember(ghost, member, `crew-${RUN}-noown`)).toBe('unknown_owner');
    // And nothing landed on the member — the transaction is all-or-nothing.
    const memberRow = await db.getUserById(member);
    expect(memberRow?.crewId).toBeUndefined();
    // The bind's write survives untouched; the refused adopt wrote nothing.
    expect(memberRow?.ownerUserId).toBe(ghost);
  });

  gated('an integration-class owner refuses: unknown_owner — an injectable node cannot admit', async () => {
    const bot = await mkUser('integration');
    // Paired to the bot (synthetic — the data-layer bind does not inspect the
    // owner id) so the OWNER-side accountClass condition is the one refusal:
    // unpaired, the member side would answer owner_conflict first — adoption
    // never claims.
    const member = await mkPairedIntegration(bot);

    expect(await db.adoptCrewMember(bot, member, `crew-${RUN}-botown`)).toBe('unknown_owner');

    // Neither row moved: no crew on the would-be owner, nothing on the member
    // beyond the bind it started with.
    expect((await db.getUserById(bot))?.crewId).toBeUndefined();
    expect((await db.getUserById(member))?.crewId).toBeUndefined();
    expect((await db.getUserById(member))?.ownerUserId).toBe(bot);
  });

  gated('the CREW_MAX_MEMBERS + 1-th adopt refuses with the count unchanged', async () => {
    const owner = await mkUser();
    for (let i = 0; i < CREW_MAX_MEMBERS; i++) {
      const member = await mkPairedIntegration(owner);
      expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-cap`)).toBe('adopted');
    }
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS);

    // Paired, so the CAP is the one refusal — an unpaired overflow would
    // answer owner_conflict instead (adoption never claims).
    const overflow = await mkPairedIntegration(owner);
    expect(await db.adoptCrewMember(owner, overflow, `crew-${RUN}-cap`)).toBe('cap_reached');

    // The count did not move, and the refused member gained NO crewId — the
    // member update is in the same transaction as the refused owner update.
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS);
    const overflowRow = await db.getUserById(overflow);
    expect(overflowRow?.crewId).toBeUndefined();
    expect(overflowRow?.ownerUserId).toBe(owner);

    // A released slot makes room again — the revoke-then-replace loop
    // builds on (its slot release calls exactly this method).
    await db.releaseCrewSlot(owner);
    expect(await db.adoptCrewMember(owner, overflow, `crew-${RUN}-cap`)).toBe('adopted');
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS);
  });

  gated('an UNPAIRED integration is never claimed by adoption', async () => {
    // The account-theft primitive, reproduced: the old member condition — attribute_not_exists(ownerUserId)
    // OR ownerUserId =:owner — let whoever adopted FIRST claim a never-bound
    // integration, writing themselves in as owner, and the true owner's later
    // bind refused owner_conflict forever. Adoption never claims:
    // an unpaired member refuses, with the SAME collapsed code as
    // bound-to-someone-else so the refusal is not an ownership oracle.
    const ownerA = await mkUser();
    const ownerB = await mkUser();
    const member = await mkUser('integration'); // NO bind — pairing never ran

    expect(await db.adoptCrewMember(ownerA, member, `crew-${RUN}-claim-a`)).toBe('owner_conflict');

    // The sharp half: the refused adopt wrote NOTHING. Under the old condition
    // the member row would read ownerUserId = ownerA right here.
    const memberRow = await db.getUserById(member);
    expect(memberRow?.ownerUserId).toBeUndefined();
    expect(memberRow?.crewId).toBeUndefined();
    expect((await db.getUserById(ownerA))?.crewCount).toBeUndefined();

    // The true owner is NOT blocked: the write-once bind still lands...
    expect(await db.bindIntegrationOwner(member, ownerB)).toBe('bound');
    // ...and the paired adopt then goes through whole.
    expect(await db.adoptCrewMember(ownerB, member, `crew-${RUN}-claim-b`)).toBe('adopted');
    expect((await db.getUserById(member))?.ownerUserId).toBe(ownerB);
    expect((await db.getUserById(member))?.crewId).toBe(`crew-${RUN}-claim-b`);
  });
});

describe('releaseCrewSlot', () => {
  gated('a release decrements the owner count by one', async () => {
    const owner = await mkUser();
    const first = await mkPairedIntegration(owner);
    const second = await mkPairedIntegration(owner);
    await db.adoptCrewMember(owner, first, `crew-${RUN}-rel`);
    await db.adoptCrewMember(owner, second, `crew-${RUN}-rel`);

    await db.releaseCrewSlot(owner);

    expect((await db.getUserById(owner))?.crewCount).toBe(1);
  });

  gated('releasing at zero does not go negative', async () => {
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);
    await db.adoptCrewMember(owner, member, `crew-${RUN}-zero`);

    await db.releaseCrewSlot(owner);
    expect((await db.getUserById(owner))?.crewCount).toBe(0);
    // The second release is the crash-retried teardown re-running: swallowed,
    // and the count stays parked at zero rather than banking a free slot.
    await db.releaseCrewSlot(owner);
    expect((await db.getUserById(owner))?.crewCount).toBe(0);
  });

  gated('releasing against an owner that never adopted is a no-op', async () => {
    const owner = await mkUser();
    await db.releaseCrewSlot(owner);
    const row = await db.getUserById(owner);
    expect(row).toBeTruthy();
    expect(row?.crewCount).toBeUndefined();
  });

  gated('releasing against a DELETED owner row is a no-op that creates no row', async () => {
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);
    await db.adoptCrewMember(owner, member, `crew-${RUN}-del`);
    await db.deleteUser(owner, { identityKeyPub: `crew-key-${RUN}-${owner}` });

    // The load-bearing guard: ADD on a missing item CREATES it,
    // so without attribute_exists this release would mint a ghost user row
    // holding nothing but crewCount = -1 — which getUserById would then
    // happily serve as an account.
    await db.releaseCrewSlot(owner);

    expect(await db.getUserById(owner)).toBeUndefined();
  });
});

describe('deleteCrewMemberAndReleaseSlot — exactly-once by construction', () => {
  gated('deletes the member and releases exactly ONE slot — a repeat releases nothing', async () => {
    const owner = await mkUser();
    const m1 = await mkPairedIntegration(owner);
    const m2 = await mkPairedIntegration(owner);
    expect(await db.adoptCrewMember(owner, m1, `crew-${RUN}-atomic`)).toBe('adopted');
    expect(await db.adoptCrewMember(owner, m2, `crew-${RUN}-atomic`)).toBe('adopted');

    await db.deleteCrewMemberAndReleaseSlot(m1, owner);
    expect(await db.getUserById(m1)).toBeUndefined();
    expect((await db.getUserById(owner))?.crewCount).toBe(1);

    // The concurrent-teardown race, collapsed to its essence: a second caller
    // that also pre-read the member row arrives after it is gone. The
    // delete's attribute_exists cancels the WHOLE transaction, so the
    // decrement never runs — where the old delete-then-release two-step
    // decremented again and under-counted the crew.
    await db.deleteCrewMemberAndReleaseSlot(m1, owner);
    expect((await db.getUserById(owner))?.crewCount).toBe(1);
    expect(await db.getUserById(m2)).toBeDefined();
  });

  gated('a member whose owner row is GONE is still deleted — no ghost row, nothing released', async () => {
    // The drift shape the owner-side fallback exists for: the owner row
    // vanished under a still-adopted member (pre-fix data; nothing current
    // produces it — the handler now refuses a human self-delete with a live
    // crew). The teardown still owes the member row's deletion.
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);
    expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-drift`)).toBe('adopted');
    await doc.send(new DeleteCommand({ TableName: SERVER_TABLES.users, Key: { userId: owner } }));

    await db.deleteCrewMemberAndReleaseSlot(member, owner);

    expect(await db.getUserById(member)).toBeUndefined();
    // And the release did NOT resurrect the owner: ADD on a missing item
    // creates it, which is the ghost-row hazard the owner condition guards.
    expect(await db.getUserById(owner)).toBeUndefined();
  });
});

/**
 * A TestOnlyDataLayer whose doc client runs `beforeTransact` immediately before
 * forwarding each TransactWriteCommand (1-indexed); everything else passes
 * straight through. Real DynamoDB end to end — this only schedules a
 * concurrent writer's COMMITTED work into the gap between adoptCrewMember's
 * pre-read and its transaction, the interleaving a two-process race produces
 * nondeterministically and a test must produce on demand.
 */
function interleaved(beforeTransact: (transactSeq: number) => Promise<void>): TestOnlyDataLayer {
  let transactSeq = 0;
  const send = async (command: object): Promise<unknown> => {
    if (command instanceof TransactWriteCommand) await beforeTransact(++transactSeq);
    return (doc.send as unknown as (c: object) => Promise<unknown>)(command);
  };
  return makeTestOnlyDataLayer({ send } as unknown as DynamoDBDocumentClient);
}

describe('the crew pin — a member crewId is always its owner crewId', () => {
  gated('a first adopt that loses the mint race retries and stamps the WINNER crew', async () => {
    const owner = await mkUser();
    const winnerMember = await mkPairedIntegration(owner);
    const loserMember = await mkPairedIntegration(owner);
    const winnerCrew = `crew-${RUN}-race-won`;
    const loserCandidate = `crew-${RUN}-race-stale`;

    const racedDb = interleaved(async (seq) => {
      // The winner's WHOLE first adopt commits in the gap between the
      // loser's pre-read ("owner has no crew yet") and its transaction.
      if (seq === 1) {
        expect(await db.adoptCrewMember(owner, winnerMember, winnerCrew)).toBe('adopted');
      }
    });

    // The loser walks in carrying its own freshly-minted candidate. The pin
    // refuses the stale write; one retry against the winner's crew succeeds.
    expect(await racedDb.adoptCrewMember(owner, loserMember, loserCandidate)).toBe('adopted');

    // THE invariant, asserted directly: every member carries its OWNER's
    // crewId — the winner's mint, never the loser's stale candidate. Without
    // the pin the loser's owner update no-ops through if_not_exists while
    // its member update stamps the candidate anyway: a member stranded in a
    // crew of one, with the owner in the other.
    const ownerRow = await db.getUserById(owner);
    expect(ownerRow?.crewId).toBe(winnerCrew);
    expect((await db.getUserById(winnerMember))?.crewId).toBe(winnerCrew);
    expect((await db.getUserById(loserMember))?.crewId).toBe(winnerCrew);
    expect((await db.getUserById(loserMember))?.crewId).not.toBe(loserCandidate);
    expect(ownerRow?.crewCount).toBe(2);
  });

  gated('a second pin conflict gives up honestly: crew_contended, one retry only', async () => {
    const owner = await mkUser();
    // Paired, so the moving crewId is the ONLY refusal in play — the member
    // side stays adoptable throughout (adoption never claims).
    const member = await mkPairedIntegration(owner);

    // Pathological contention, driven directly: the owner's crew moves under
    // BOTH attempts. Production never rewrites a set crewId, so this state
    // is synthetic — but the guard must give up honestly rather than loop or
    // map moving state onto a terminal outcome that means something else.
    const contendedDb = interleaved(async (seq) => {
      await doc.send(
        new UpdateCommand({
          TableName: SERVER_TABLES.users,
          Key: { userId: owner },
          UpdateExpression: 'SET crewId = :c',
          ExpressionAttributeValues: { ':c': `crew-${RUN}-cont-${seq}` },
        }),
      );
    });

    expect(await contendedDb.adoptCrewMember(owner, member, `crew-${RUN}-cont-mint`)).toBe(
      'crew_contended',
    );

    // Nothing landed: the member holds its bind and nothing more, and no
    // slot was ever taken.
    const memberRow = await db.getUserById(member);
    expect(memberRow?.crewId).toBeUndefined();
    expect(memberRow?.ownerUserId).toBe(owner);
    expect((await db.getUserById(owner))?.crewCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase — the owner-called adopt route, and slot release on every teardown.
// Same real-DynamoDB harness: the properties the route sits on (the cap, the
// release) are the transactional ones above, so the handler is exercised over
// the same store rather than a double.
// ---------------------------------------------------------------------------

async function adopt(caller: string, member: unknown): Promise<HttpResult> {
  const event: HttpEvent = {
    method: 'POST',
    path: '/v1/crew/adopt',
    headers: { 'content-type': 'application/json' },
    pathParameters: {},
    body: JSON.stringify({ member }),
    sourceIp: '198.51.100.7',
  };
  return crewAdoptHandler(event, hdeps, { userId: caller });
}

async function revoke(caller: string, target: string): Promise<HttpResult> {
  const event: HttpEvent = {
    method: 'DELETE',
    path: `/v1/integrations/${target}`,
    headers: {},
    pathParameters: { userId: target },
    sourceIp: '198.51.100.7',
  };
  return integrationRevokeHandler(event, hdeps, { userId: caller });
}

async function selfDelete(caller: string): Promise<HttpResult> {
  const event: HttpEvent = {
    method: 'DELETE',
    path: '/v1/account',
    headers: {},
    pathParameters: {},
    sourceIp: '198.51.100.7',
  };
  return deleteAccountHandler(event, hdeps, { userId: caller });
}

function errorCode(res: HttpResult): string {
  return parseBody<{ error: { code: string } }>(res.body).error.code;
}

/** Fill an owner's crew to the cap directly at the data layer — the cap is
 * the proven property, not what these tests are about, and going through the
 * handler would spend the owner's crewAdopt budget on setup. */
async function fillToCap(owner: string, mint: string): Promise<string[]> {
  const members: string[] = [];
  for (let i = 0; i < CREW_MAX_MEMBERS; i++) {
    const member = await mkPairedIntegration(owner);
    expect(await db.adoptCrewMember(owner, member, mint)).toBe('adopted');
    members.push(member);
  }
  return members;
}

describe('POST /v1/crew/adopt', () => {
  gated('the owner adopts: 204, and the rows show it', async () => {
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);

    const res = await adopt(owner, member);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();

    const ownerRow = await db.getUserById(owner);
    const memberRow = await db.getUserById(member);
    expect(ownerRow?.crewId).toBeDefined();
    expect(memberRow?.crewId).toBe(ownerRow?.crewId);
    expect(memberRow?.ownerUserId).toBe(owner);
    expect(ownerRow?.crewCount).toBe(1);
    // Opaque refs only in the retained log (this used to
    // pin the raw owner→member ULID edge): the adopt line carries the two
    // refs and nothing else — no ids, no crewId, no payloads.
    const memberRef = userRefForLog(member, 'crew-test-user-ref-salt');
    const line = hdeps.logs.find(
      (l) => l.event === 'crew_adopted' && l.fields['memberRef'] === memberRef,
    );
    expect(line?.fields).toEqual({
      ownerRef: userRefForLog(owner, 'crew-test-user-ref-salt'),
      memberRef,
    });
    expect(JSON.stringify(line)).not.toContain(owner);
    expect(JSON.stringify(line)).not.toContain(member);
  });

  gated('re-adopt is an idempotent 204 and does not double-count', async () => {
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);

    expect((await adopt(owner, member)).statusCode).toBe(204);
    expect((await adopt(owner, member)).statusCode).toBe(204);

    expect((await db.getUserById(owner))?.crewCount).toBe(1);
  });

  gated('a non-owner caller gets 403 — one code, so ownership is not probeable', async () => {
    const ownerA = await mkUser();
    const ownerB = await mkUser();
    const member = await mkPairedIntegration(ownerA);
    expect((await adopt(ownerA, member)).statusCode).toBe(204);

    const res = await adopt(ownerB, member);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('not_integration_owner');

    // Nothing moved: the member stays in A's crew, and B gained no crew state.
    expect((await db.getUserById(member))?.ownerUserId).toBe(ownerA);
    expect((await db.getUserById(ownerB))?.crewCount).toBeUndefined();
  });

  gated('adopting a HUMAN answers the SAME 403 as someone else\'s integration', async () => {
    // The collapse is the point (mirroring the revoke handler): a distinct
    // code for "that is a human" would make this route a class oracle for
    // any authenticated caller holding a ULID.
    const owner = await mkUser();
    const human = await mkUser();

    const res = await adopt(owner, human);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('not_integration_owner');
    expect((await db.getUserById(owner))?.crewCount).toBeUndefined();
  });

  gated('adopting yourself is a 400', async () => {
    const owner = await mkUser();
    const res = await adopt(owner, owner);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('invalid_request');
  });

  gated('a malformed member id is a 400 before any read', async () => {
    const owner = await mkUser();
    const res = await adopt(owner, 'not-a-ulid');
    expect(res.statusCode).toBe(400);
  });

  gated('an unknown member is a 404', async () => {
    const owner = await mkUser();
    const res = await adopt(owner, uid());
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not_found');
  });

  gated('an INTEGRATION caller gets a clear 403 — an injectable node cannot admit', async () => {
    const bot = await mkUser('integration');
    const member = await mkUser('integration');

    const res = await adopt(bot, member);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('integration_forbidden');

    // Defence in depth held at the first layer; the member shows no trace.
    expect((await db.getUserById(member))?.crewId).toBeUndefined();
    expect((await db.getUserById(member))?.ownerUserId).toBeUndefined();
  });

  gated('a caller whose account is gone gets 403, not a crash', async () => {
    // Authenticated but deleted mid-session: the token can outlive the row.
    const res = await adopt(uid(), await mkUser('integration'));
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('unknown_owner');
  });

  gated('the cap maps to 409 cap_reached', async () => {
    const owner = await mkUser();
    await fillToCap(owner, `crew-${RUN}-h409`);
    const overflow = await mkPairedIntegration(owner);

    const res = await adopt(owner, overflow);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('cap_reached');
  });

  gated('adopts past LIMITS.crewAdopt are rate limited', async () => {
    // crewAdopt capacity is 5 (5/min sustained): five calls pass the
    // limiter, the sixth answers 429 whatever it would have said otherwise.
    const owner = await mkUser();
    for (let i = 0; i < 5; i++) {
      const member = await mkPairedIntegration(owner);
      expect((await adopt(owner, member)).statusCode).toBe(204);
    }
    const res = await adopt(owner, await mkUser('integration'));
    expect(res.statusCode).toBe(429);
    expect(res.headers?.['retry-after']).toBeDefined();
  });

  gated('pathological contention maps to 503 crew_contended — retryable, never terminal', async () => {
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);

    // Same synthetic drive as the pin suite above: the owner's crew moves
    // under BOTH transaction attempts, so the data layer's single retry is
    // spent and the handler must surface the honest retryable outcome.
    const contendedDb = interleaved(async (seq) => {
      await doc.send(
        new UpdateCommand({
          TableName: SERVER_TABLES.users,
          Key: { userId: owner },
          UpdateExpression: 'SET crewId = :c',
          ExpressionAttributeValues: { ':c': `crew-${RUN}-hcont-${seq}` },
        }),
      );
    });

    const event: HttpEvent = {
      method: 'POST',
      path: '/v1/crew/adopt',
      headers: { 'content-type': 'application/json' },
      pathParameters: {},
      body: JSON.stringify({ member }),
      sourceIp: '198.51.100.7',
    };
    const res = await crewAdoptHandler(event, { ...hdeps, db: contendedDb }, { userId: owner });
    expect(res.statusCode).toBe(503);
    expect(errorCode(res)).toBe('crew_contended');
    expect(res.headers?.['retry-after']).toBeDefined();
  });
});

describe('slot release on teardown', () => {
  gated('owner revoke of a crew member frees the slot: a replacement adopts at the cap', async () => {
    const owner = await mkUser();
    const members = await fillToCap(owner, `crew-${RUN}-trevoke`);
    const replacement = await mkPairedIntegration(owner);

    // At the cap the replacement is refused — the control that proves the
    // release below is what makes the difference.
    expect(errorCode(await adopt(owner, replacement))).toBe('cap_reached');

    expect((await revoke(owner, members[0]!)).statusCode).toBe(204);
    expect(await db.getUserById(members[0]!)).toBeUndefined();
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS - 1);

    // The freed slot is adoptable again, into the SAME crew.
    expect((await adopt(owner, replacement)).statusCode).toBe(204);
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS);
    expect((await db.getUserById(replacement))?.crewId).toBe(
      (await db.getUserById(owner))?.crewId,
    );
  });

  gated('integration self-delete frees the slot: a replacement adopts at the cap', async () => {
    const owner = await mkUser();
    const members = await fillToCap(owner, `crew-${RUN}-tself`);
    const replacement = await mkPairedIntegration(owner);

    expect((await selfDelete(members[0]!)).statusCode).toBe(200);
    expect(await db.getUserById(members[0]!)).toBeUndefined();
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS - 1);

    expect((await adopt(owner, replacement)).statusCode).toBe(204);
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS);
  });

  gated('revoking a NON-crew integration releases nothing', async () => {
    // The release is guarded on the row carrying a crewId: an owner with a
    // full crew revoking a merely-BOUND (never adopted) integration must not
    // bank a free ninth slot.
    const owner = await mkUser();
    await fillToCap(owner, `crew-${RUN}-tbound`);
    const boundOnly = await mkUser('integration');
    expect(await db.bindIntegrationOwner(boundOnly, owner)).toBe('bound');

    expect((await revoke(owner, boundOnly)).statusCode).toBe(204);
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS);
    expect(errorCode(await adopt(owner, await mkPairedIntegration(owner)))).toBe('cap_reached');
  });

  gated('two concurrent revokes of ONE member release ONE slot — the cap holds', async () => {
    const owner = await mkUser();
    const members = await fillToCap(owner, `crew-${RUN}-race2`);
    const target = members[0]!;

    // Revoke #1 pre-reads the member row; before ITS transaction commits,
    // revoke #2 runs to completion — the interleaving both handlers'
    // pre-reads permit, produced on demand exactly as the pin suite does.
    const racedDb = interleaved(async (seq) => {
      if (seq === 1) expect((await revoke(owner, target)).statusCode).toBe(204);
    });
    const event: HttpEvent = {
      method: 'DELETE',
      path: `/v1/integrations/${target}`,
      headers: {},
      pathParameters: { userId: target },
      sourceIp: '198.51.100.7',
    };
    const res = await integrationRevokeHandler(event, { ...hdeps, db: racedDb }, { userId: owner });
    // The loser still answers an idempotent 204 — the revoke IS complete...
    expect(res.statusCode).toBe(204);
    expect(await db.getUserById(target)).toBeUndefined();
    // ...but only ONE slot came back. The old delete-then-release two-step
    // decremented in BOTH executions here: seven rows at crewCount = 6, so
    // two replacement adopts put nine live members under a reported eight —
    // the cap bypass the gate named. Exactly one replacement fits now.
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS - 1);
    expect((await adopt(owner, await mkPairedIntegration(owner))).statusCode).toBe(204);
    expect(errorCode(await adopt(owner, await mkPairedIntegration(owner)))).toBe('cap_reached');
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS);
  });

  gated('an integration self-delete racing an owner revoke of the SAME member releases one slot', async () => {
    // The identical race through the OTHER teardown path (account.ts), which
    // shares the transactional method — asserted separately so account.ts
    // can never quietly fall back to the two-step.
    const owner = await mkUser();
    const members = await fillToCap(owner, `crew-${RUN}-race3`);
    const target = members[0]!;

    const racedDb = interleaved(async (seq) => {
      if (seq === 1) expect((await revoke(owner, target)).statusCode).toBe(204);
    });
    const event: HttpEvent = {
      method: 'DELETE',
      path: '/v1/account',
      headers: {},
      pathParameters: {},
      sourceIp: '198.51.100.7',
    };
    const res = await deleteAccountHandler(event, { ...hdeps, db: racedDb }, { userId: target });
    expect(res.statusCode).toBe(200);
    expect(await db.getUserById(target)).toBeUndefined();
    expect((await db.getUserById(owner))?.crewCount).toBe(CREW_MAX_MEMBERS - 1);
    expect((await adopt(owner, await mkPairedIntegration(owner))).statusCode).toBe(204);
    expect(errorCode(await adopt(owner, await mkPairedIntegration(owner)))).toBe('cap_reached');
  });

  gated('a HUMAN self-delete is REFUSED while the crew lives — and succeeds once it is empty', async () => {
    // The previous shape
    // of this test asserted only that the owner row vanished — which PASSED
    // while preserving the vulnerability: members kept a dead ownerUserId and
    // an intact crewId, member→member sends still passed the crew predicate,
    // and nobody could ever revoke them (revoke demands row.ownerUserId ===
    // auth.userId, the owner is gone, and a re-registered operator mints a
    // brand-new ULID — ULIDs never recur).
    const owner = await mkUser();
    const m1 = await mkPairedIntegration(owner);
    const m2 = await mkPairedIntegration(owner);
    expect((await adopt(owner, m1)).statusCode).toBe(204);
    expect((await adopt(owner, m2)).statusCode).toBe(204);
    // Ciphertext queued for the owner: the probe that the refusal is a REAL
    // refusal. The old handler purged the queue before it ever read the row,
    // and a refusal issued after the purge is not a refusal.
    await db.enqueueMessage({
      recipientId: owner,
      msgId: uid(),
      senderId: m1,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const refused = await selfDelete(owner);
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('crew_not_empty');
    // The detail names the count — the length of the operator's to-do list.
    expect(parseBody<{ error: { detail: string } }>(refused.body).error.detail).toContain('2');

    // The crew is untouched...
    const ownerRow = await db.getUserById(owner);
    expect(ownerRow?.crewCount).toBe(2);
    expect(ownerRow?.crewId).toBeDefined();
    expect((await db.getUserById(m1))?.crewId).toBe(ownerRow?.crewId);
    expect((await db.getUserById(m2))?.crewId).toBe(ownerRow?.crewId);
    // ...and so is everything else: the refusal preceded every destructive
    // step, so the queued ciphertext survived it.
    expect(await allQueued(db, owner)).toHaveLength(1);

    // Revoking each member by the ULID it was adopted under — the documented
    // path, and the only enforceable one (no owner→members index, no Query on
    // users: the server cannot enumerate a crew to cascade) — empties the
    // crew, after which the delete goes through.
    expect((await revoke(owner, m1)).statusCode).toBe(204);
    expect((await revoke(owner, m2)).statusCode).toBe(204);
    // The refused delete and both revokes spent the acct-delete burst of 3;
    // refill one token so the limiter is not what this asserts.
    hdeps.advanceMs(60_000);
    expect((await selfDelete(owner)).statusCode).toBe(200);
    expect(await db.getUserById(owner)).toBeUndefined();
  });
});

/**
 * A TestOnlyDataLayer whose doc client runs `beforeDelete` immediately before
 * forwarding each single-item DeleteCommand (1-indexed); everything else
 * passes straight through. The DeleteCommand sibling of `interleaved` above:
 * deleteUser's tombstone fallback re-runs the user-row delete OUTSIDE the
 * transaction, and the gap in front of THAT delete is one a concurrent
 * adopt can commit into just as it can the gap before the transaction.
 */
function interleavedOnDelete(beforeDelete: (deleteSeq: number) => Promise<void>): TestOnlyDataLayer {
  let deleteSeq = 0;
  const send = async (command: object): Promise<unknown> => {
    if (command instanceof DeleteCommand) await beforeDelete(++deleteSeq);
    return (doc.send as unknown as (c: object) => Promise<unknown>)(command);
  };
  return makeTestOnlyDataLayer({ send } as unknown as DynamoDBDocumentClient);
}

describe('the delete-leg crew guard — enforced AT the row, not only at the read', () => {
  gated('an adopt committing between the handler read and the delete is refused by the row condition', async () => {
    // The residual the read-time check left open: the handler observes
    // crewCount = 0 and proceeds, an adopt COMMITS in the gap, and an
    // unconditional delete would remove the owner row anyway — the exact
    // ownerless, unrevokable crew again, reopened through a
    // narrower window. Same deterministic scheduling as every race in this
    // file: the adopt is placed into the gap on demand.
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);

    const racedDb = interleaved(async (seq) => {
      // deleteUser's TransactWriteItems is the only transaction the human
      // delete path issues; the whole adopt commits just before it.
      if (seq === 1) {
        expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-toctou`)).toBe('adopted');
      }
    });
    const event: HttpEvent = {
      method: 'DELETE',
      path: '/v1/account',
      headers: {},
      pathParameters: {},
      sourceIp: '198.51.100.7',
    };
    const res = await deleteAccountHandler(event, { ...hdeps, db: racedDb }, { userId: owner });

    // Refused with the same shape as the read-time check — a caller cannot
    // tell which of the two said no, and must not need to.
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('crew_not_empty');
    expect(parseBody<{ error: { detail: string } }>(res.body).error.detail).toContain('1');

    // The owner row SURVIVED the interleaving, crew intact...
    const ownerRow = await db.getUserById(owner);
    expect(ownerRow?.crewCount).toBe(1);
    expect(ownerRow?.crewId).toBeDefined();
    expect((await db.getUserById(member))?.ownerUserId).toBe(owner);
    expect((await db.getUserById(member))?.crewId).toBe(ownerRow?.crewId);
    // ...and so did its CLAIM row — the transaction cancelled as a unit, so
    // the both-or-neither pairing held: the key still resolves to the owner,
    // never to nobody (the unclearable `account_conflict` state).
    expect((await db.getUserByIdentityKeyClaim(`crew-key-${RUN}-${owner}`))?.userId).toBe(owner);

    // The refusal is recoverable exactly as the read-time one is: revoke the
    // member, and the retried delete goes through whole.
    expect((await revoke(owner, member)).statusCode).toBe(204);
    expect((await selfDelete(owner)).statusCode).toBe(200);
    expect(await db.getUserById(owner)).toBeUndefined();
    expect(await db.getUserByIdentityKeyClaim(`crew-key-${RUN}-${owner}`)).toBeUndefined();
  });

  gated('deleteUser under the guard: crew_not_empty while a member lives, deleted once none does', async () => {
    // The data-layer contract by itself: 'crew_not_empty' deletes NOTHING,
    // and the same guarded call succeeds once the crew is gone — the guard
    // refuses a state, not the account.
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);
    expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-guard`)).toBe('adopted');
    const key = `crew-key-${RUN}-${owner}`;

    expect(await db.deleteUser(owner, { identityKeyPub: key }, { requireEmptyCrew: true })).toBe(
      'crew_not_empty',
    );
    expect((await db.getUserById(owner))?.crewCount).toBe(1);
    expect((await db.getUserByIdentityKeyClaim(key))?.userId).toBe(owner);

    await db.deleteCrewMemberAndReleaseSlot(member, owner);
    // crewCount now EXISTS at 0 (releases park it, never remove it) — the
    // `= :zero` half of the condition, exercised deliberately.
    expect((await db.getUserById(owner))?.crewCount).toBe(0);
    expect(await db.deleteUser(owner, { identityKeyPub: key }, { requireEmptyCrew: true })).toBe(
      'deleted',
    );
    expect(await db.getUserById(owner)).toBeUndefined();
    expect(await db.getUserByIdentityKeyClaim(key)).toBeUndefined();
  });

  gated('the tombstone-fallback delete carries the guard too — the narrower gap is also closed', async () => {
    // When the claim is tombstoned the transaction cancels and deleteUser
    // retries the user row as a single DeleteCommand — a second, narrower
    // read-then-delete gap. An adopt committing THERE must be refused by the
    // fallback's own condition, or the guard has a bypass through the
    // tombstone path. A tombstoned HUMAN claim is synthetic today (revoke
    // tombstones integration keys), but the mechanism is shared and must not
    // drift — same reasoning as the synthetic crew-pin contention above.
    const owner = await mkUser();
    const member = await mkPairedIntegration(owner);
    const key = `crew-key-${RUN}-${owner}`;
    await db.tombstoneIdentityKey(key);

    const racedDb = interleavedOnDelete(async (seq) => {
      // The fallback user-row delete is the only single-item DeleteCommand
      // this call issues; the adopt commits just before it.
      if (seq === 1) {
        expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-fallback`)).toBe('adopted');
      }
    });
    expect(
      await racedDb.deleteUser(owner, { identityKeyPub: key }, { requireEmptyCrew: true }),
    ).toBe('crew_not_empty');

    // Nothing was deleted: owner row intact with its crew, tombstone intact.
    expect((await db.getUserById(owner))?.crewCount).toBe(1);

    // Emptied, the same call completes through the same fallback: the user
    // row goes, and the tombstoned claim survives it — forever.
    await db.deleteCrewMemberAndReleaseSlot(member, owner);
    expect(await db.deleteUser(owner, { identityKeyPub: key }, { requireEmptyCrew: true })).toBe(
      'deleted',
    );
    expect(await db.getUserById(owner)).toBeUndefined();
    const again = await db.getOrCreateUserByIdentityKey(key, uid(), Date.now());
    expect(again.kind).toBe('tombstoned');
  });
});

describe('the no-release delete guard — no phantom slots', () => {
  gated('an adopt committing between a teardown read and its delete cannot leak a slot', async () => {
    // This race disproved an assumption the crew guard
    // rests on. A teardown decides "is this an adopted member?" from a READ.
    // `crewId` only ever goes absent→present, so an adopt committing in that
    // gap used to send a now-adopted member down the NO-RELEASE path: the row
    // went, the owner's crewCount never came down, and the slot was leaked
    // with no ULID left to revoke. Eight of those and the owner can neither
    // adopt (cap_reached) nor delete their account (crew_not_empty), forever.
    const owner = await mkUser();
    const member = await mkUser('integration');
    expect(await db.bindIntegrationOwner(member, owner)).toBe('bound');

    // The teardown observes a member with NO crewId, so it aims at the
    // no-release delete — then the adopt lands in the gap.
    expect((await db.getUserById(member))?.crewId).toBeUndefined();
    const racedDb = interleaved(async (seq) => {
      if (seq === 1) {
        expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-phantom`)).toBe('adopted');
      }
    });
    expect(await racedDb.deleteUser(member, {}, { requireNoCrewId: true })).toBe('crew_appeared');

    // Refused, and NOTHING deleted — the member is still there to be released
    // properly, which is the whole point of refusing rather than riding through.
    expect(await db.getUserById(member)).toBeDefined();
    expect((await db.getUserById(owner))?.crewCount).toBe(1);

    // The caller now takes the atomic path, and the slot comes back.
    await db.deleteCrewMemberAndReleaseSlot(member, owner);
    expect(await db.getUserById(member)).toBeUndefined();
    expect((await db.getUserById(owner))?.crewCount).toBe(0);
  });

  gated('crewCount equals the true live-member count after a raced revoke', async () => {
    // A property rather than a mechanism
    // check: whatever the interleaving, the count must not drift from reality,
    // because account deletion refuses on it.
    const owner = await mkUser();
    const member = await mkUser('integration');
    expect(await db.bindIntegrationOwner(member, owner)).toBe('bound');

    const racedDb = interleaved(async (seq) => {
      if (seq === 1) {
        expect(await db.adoptCrewMember(owner, member, `crew-${RUN}-drift`)).toBe('adopted');
      }
    });
    // The revoke handler's own branch: reads no crewId, aims no-release, is
    // refused, then routes to the atomic path. Driven here through the data
    // layer so the interleaving is deterministic.
    if ((await racedDb.deleteUser(member, {}, { requireNoCrewId: true })) === 'crew_appeared') {
      await db.deleteCrewMemberAndReleaseSlot(member, owner);
    }
    expect(await db.getUserById(member)).toBeUndefined();
    // Zero live members, so zero claimed slots — and the owner can still
    // delete their own account, which a phantom slot would have blocked.
    expect((await db.getUserById(owner))?.crewCount).toBe(0);
    expect(
      await db.deleteUser(owner, { identityKeyPub: `crew-key-${RUN}-${owner}` }, { requireEmptyCrew: true }),
    ).toBe('deleted');
  });
});
