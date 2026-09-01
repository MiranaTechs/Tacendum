import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerFrame, TypingFrame } from '@tacendum/shared';
import { wsDefaultHandler, type WsDeps, type WsResult } from '../src/handlers/ws.js';
import { LIMITS } from '../src/ratelimit.js';
import type { DataLayer } from '../src/db/data.js';
import { allQueued, makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * Live-updating replies (rate decision):
 * the server truths streaming rides on, pinned WITHOUT changing the server.
 *
 * The decision's load-bearing claim is that the server diff for streaming is
 * EMPTY: intermediate stream edits are sealed `x.edit` chatter riding the
 * EXISTING typing wire frame (handleTyping's .1 integration predicate) and
 * the EXISTING typing budget (`LIMITS.typing`, keyed `typing:<sender>`),
 * while `integrationSend` stays exactly {capacity: 10, refillPerSec: 30/60}.
 * These tests pin the three truths that decision text depends on:
 *
 * 1. PAYLOAD OPACITY — the payload is sealed, so the server cannot and
 * does not distinguish an x.edit-shaped intermediate from an
 * x.typing-shaped keepalive: same path, byte-identical relay toward
 * the owner, and the same uniform drop toward a stranger.
 * 2. BUDGET ARITHMETIC — the decision's emission profile (0.5/s
 * intermediates + 0.134/s typing refreshes) never draws a 429 from
 * LIMITS.typing's 15-burst/3-per-s over a sustained window, while an
 * abusive 4/s sustained profile does. Constants-only where arithmetic
 * suffices; a MOVING clock where the bucket needs time — the injected
 * clock drives deps.now AND the limiter together, so no deadline
 * arithmetic hides behind a frozen now (the frozen-clock rule).
 * 3. THE RATE-DECISION GUARD — a literal pin on integrationSend naming
 * the decision, so a future silent raise fails a test that cites it.
 *
 * If any of these breaks, the .4 rate decision's text is no longer true
 * and must be re-decided, not patched around.
 */

/** The decision's emission profile, verbatim from the .4 text: one
 * intermediate per ATTEND_POLL_MS (2 s) = 0.5/s, plus typing refreshes at
 * 0.134/s (one per ≤7.5 s; packages/cli/src/attend.ts owns the cadence
 * constants — the DECISION TEXT's numbers are what is pinned here). */
const INTERMEDIATES_PER_SEC = 0.5;
const REFRESHES_PER_SEC = 0.134;
/** The decision's stated headroom: 3/s sustained over 0.634/s emitted. */
const DECIDED_HEADROOM = 4.7;
/** The profile the decision names as abusive: 4/s sustained. */
const ABUSIVE_PER_SEC = 4;
/** Each streamed turn spends exactly TWO integrationSend tokens (anchor +
 * final edit) — the decision's per-turn price. */
const STREAM_TOKENS_PER_TURN = 2;

/** Driving intervals for the moving-clock tests. Math.floor makes the driven
 * refresh cadence at least as hot as the decision's 0.134/s bound, so the
 * "never a 429" pin is conservative. */
const INTERMEDIATE_INTERVAL_MS = 1000 / INTERMEDIATES_PER_SEC; // 2000
const REFRESH_INTERVAL_MS = Math.floor(1000 / REFRESHES_PER_SEC); // 7462
const ABUSIVE_INTERVAL_MS = 1000 / ABUSIVE_PER_SEC; // 250

/** x.edit-SHAPED bytes: what a sealed intermediate would decrypt to. On the
 * wire it is base64 ciphertext the server never opens — encoding a literal
 * envelope here is the test SAYING what the bytes mean while proving the
 * server never reads them. */
const X_EDIT_SHAPED = Buffer.from(
  JSON.stringify({
    tcm: 'x.edit',
    ref: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    seq: 3,
    text: 'half a sentence, mid-stream…',
  }),
).toString('base64');

/** x.typing-SHAPED bytes: the keepalive the same lane carried .4. */
const X_TYPING_SHAPED = Buffer.from(JSON.stringify({ tcm: 'x.typing' })).toString('base64');

function makeFakeSender() {
  const posted: Array<{ connectionId: string; frame: ServerFrame }> = [];
  return {
    posted,
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      posted.push({ connectionId, frame });
      return true;
    },
  };
}

const SENDER = '0000000000000000000SENDER1'; // the streaming integration
const OWNER = '00000000000000000000WNER03'; // its bound owner
const STRANGER = '000000000000000000STRNGR04'; // everyone else

let db: DataLayer;
let deps: TestDeps;
let wsDeps: WsDeps & { sender: ReturnType<typeof makeFakeSender> };

function typingFrame(overrides: Partial<TypingFrame> = {}): TypingFrame {
  return {
    type: 'typing',
    to: OWNER,
    msgType: 'ciphertext',
    payload: X_EDIT_SHAPED,
    ...overrides,
  };
}

async function sendTyping(frame: TypingFrame = typingFrame()): Promise<WsResult> {
  return wsDefaultHandler(
    {
      routeKey: '$default' as const,
      connectionId: 'conn-sender',
      senderUserId: SENDER,
      body: JSON.stringify(frame),
    },
    wsDeps,
  );
}

function framesTo(connectionId: string): ServerFrame[] {
  return wsDeps.sender.posted
    .filter((p) => p.connectionId === connectionId)
    .map((p) => p.frame);
}

beforeEach(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  wsDeps = {
    ...deps,
    sender: makeFakeSender(),
    scheduleDrain: async () => {},
    schedulePush: async () => {},
  };
  await db.createUser({ userId: OWNER, createdAt: deps.now() });
  await db.createUser({ userId: STRANGER, createdAt: deps.now() });
  await db.createUser({
    userId: SENDER,
    createdAt: deps.now(),
    accountClass: 'integration',
  });
  expect(await db.bindIntegrationOwner(SENDER, OWNER)).toBe('bound');
  await db.putConnection({
    userId: OWNER,
    connectionId: 'conn-owner',
    connectedAt: deps.now(),
  });
});

describe('4 payload opacity — the server cannot and does not distinguish x.edit from x.typing', () => {
  it('x.edit-shaped sealed bytes relay byte-identical toward the owner, exactly as x.typing-shaped bytes do', async () => {
    const editRes = await sendTyping(typingFrame({ payload: X_EDIT_SHAPED }));
    const keepaliveRes = await sendTyping(typingFrame({ payload: X_TYPING_SHAPED }));

    // Same path, same result: the responses are byte-identical.
    expect(JSON.stringify(editRes)).toBe(JSON.stringify(keepaliveRes));
    expect(editRes).toEqual({ statusCode: 200 });

    const relayed = framesTo('conn-owner');
    expect(relayed).toHaveLength(2);
    const [editRelay, keepaliveRelay] = relayed;
    if (editRelay?.type !== 'typing' || keepaliveRelay?.type !== 'typing') {
      throw new Error('expected typing relays');
    }
    // Byte-identical payloads through the relay — the sealed intermediate
    // arrives exactly as sent, unopened.
    expect(editRelay.payload).toBe(X_EDIT_SHAPED);
    expect(keepaliveRelay.payload).toBe(X_TYPING_SHAPED);
    // And apart from the sealed payload, the two relayed frames are the SAME
    // frame: same envelope, same from, same msgType, same ts. Nothing about
    // the relay varies with what the ciphertext contains.
    expect({ ...editRelay, payload: '<sealed>' }).toEqual({
      ...keepaliveRelay,
      payload: '<sealed>',
    });
  });

  it('streamed chatter is relay-only: no queue row, no wake, no receipt — for x.edit-shaped bytes too', async () => {
    await sendTyping(typingFrame({ payload: X_EDIT_SHAPED }));

    expect(await allQueued(db, OWNER)).toHaveLength(0);
    expect(deps.pushesSent).toHaveLength(0);
    expect(deps.alertsSent).toHaveLength(0);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });

  it('x.edit-shaped chatter draws the uniform drop toward a stranger — frame-level silence, byte-identical response', async () => {
    // Give the stranger every advantage: a live connection. The .1
    // predicate (owner or same-crew integration) must still drop the frame
    // with a response byte-identical to a delivered relay — opacity holds on
    // the refusal side too, or the drop would leak what the bytes were.
    await db.putConnection({
      userId: STRANGER,
      connectionId: 'conn-stranger',
      connectedAt: deps.now(),
    });

    const dropped = await sendTyping(typingFrame({ to: STRANGER, payload: X_EDIT_SHAPED }));
    const relayedRes = await sendTyping(typingFrame({ to: OWNER, payload: X_EDIT_SHAPED }));

    expect(JSON.stringify(dropped)).toBe(JSON.stringify(relayedRes));
    expect(framesTo('conn-stranger')).toHaveLength(0);
    expect(framesTo('conn-owner')).toHaveLength(1);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });
});

describe('4 budget arithmetic — LIMITS.typing (15 burst / 3 per s) carries the stream', () => {
  it('LIMITS.typing is exactly {capacity: 15, refillPerSec: 3} — the budget the decision sized the profile against', () => {
    expect(LIMITS.typing).toEqual({ capacity: 15, refillPerSec: 3 });
  });

  it('constants-only: 0.5/s intermediates + 0.134/s refreshes sit 4.7x under LIMITS.typing sustained; 4/s does not fit', () => {
    const emitted = INTERMEDIATES_PER_SEC + REFRESHES_PER_SEC; // 0.634/s
    expect(emitted).toBeLessThan(LIMITS.typing.refillPerSec);
    expect(LIMITS.typing.refillPerSec / emitted).toBeGreaterThanOrEqual(DECIDED_HEADROOM);
    expect(ABUSIVE_PER_SEC).toBeGreaterThan(LIMITS.typing.refillPerSec);
  });

  it('moving clock: the decision profile (0.5/s + 0.134/s) never draws a 429 from LIMITS.typing over a sustained window', async () => {
    // Two minutes of sustained streaming — 60 intermediates + 17 refreshes
    // through the REAL handler and the REAL bucket, on one moving clock.
    const WINDOW_MS = 120_000;
    const events: number[] = [];
    for (let t = INTERMEDIATE_INTERVAL_MS; t <= WINDOW_MS; t += INTERMEDIATE_INTERVAL_MS) {
      events.push(t);
    }
    for (let t = 0; t <= WINDOW_MS; t += REFRESH_INTERVAL_MS) events.push(t);
    events.sort((a, b) => a - b);

    let clockMs = 0;
    for (const at of events) {
      deps.advanceMs(at - clockMs);
      clockMs = at;
      const res = await sendTyping(
        typingFrame({ payload: at % INTERMEDIATE_INTERVAL_MS === 0 ? X_EDIT_SHAPED : X_TYPING_SHAPED }),
      );
      expect(res).toEqual({ statusCode: 200 });
    }
    // Every frame relayed — none refused, none silently dropped.
    expect(framesTo('conn-owner')).toHaveLength(events.length);
    expect(framesTo('conn-sender').filter((f) => f.type === 'error')).toHaveLength(0);
    // And two minutes of chatter left NOTHING durable behind.
    expect(await allQueued(db, OWNER)).toHaveLength(0);
    expect(deps.pushesSent).toHaveLength(0);
  });

  it('moving clock: an abusive 4/s sustained profile draws the 429 the decision profile never does', async () => {
    const WINDOW_MS = 60_000;
    const statuses: number[] = [];
    for (let t = 0; t <= WINDOW_MS; t += ABUSIVE_INTERVAL_MS) {
      if (t > 0) deps.advanceMs(ABUSIVE_INTERVAL_MS);
      const res = await sendTyping();
      statuses.push(res.statusCode);
    }
    const refused = statuses.filter((s) => s === 429);
    expect(refused.length).toBeGreaterThan(0);
    // The burst absorbs the start — it is the SUSTAINED rate that trips, so
    // the first full burst-capacity of frames goes through untouched.
    expect(statuses.slice(0, LIMITS.typing.capacity)).toEqual(
      Array<number>(LIMITS.typing.capacity).fill(200),
    );
    // The refusal is the standard rate_limited error, on the typing bucket.
    const errors = framesTo('conn-sender').filter((f) => f.type === 'error');
    expect(errors.length).toBe(refused.length);
    expect(errors[0]).toMatchObject({ type: 'error', code: 'rate_limited' });
  });
});

describe('THE RATE DECISION — the quota that STANDS', () => {
  it('integrationSend stays exactly {capacity: 10, refillPerSec: 30/60} — not raised, not special-cased', () => {
    // The named decision: the 30/min class quota STANDS; the delta channel
    // is the sealed x.* namespace over the relay-only typing lane, NOT a
    // quota raise. A silent raise here is a re-decision and must fail this
    // test until the .4 decision text is rewritten to match.
    expect(LIMITS.integrationSend).toEqual({ capacity: 10, refillPerSec: 30 / 60 });
  });

  it('two integrationSend tokens per streamed turn (anchor + final edit): 30/min sustains 15 streamed turns a minute', () => {
    const perMinute = LIMITS.integrationSend.refillPerSec * 60; // 30
    expect(perMinute / STREAM_TOKENS_PER_TURN).toBe(15);
    // And a turn's durable cost fits the burst: anchor + final together are
    // well inside capacity, so a single streamed turn never trips the class
    // quota on burst alone.
    expect(STREAM_TOKENS_PER_TURN).toBeLessThanOrEqual(LIMITS.integrationSend.capacity);
  });
});
