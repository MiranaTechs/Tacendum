/**
 * The x.edit overlay store — the three guards,
 * each against the failure it exists to stop:
 *
 *  - seq STRICTLY increasing per (peer, ref): a replayed or reordered relay
 *    frame repaints nothing (equal loses too — "later wins" means LATER);
 *  - closed is terminal: after the durable final edit, a late intermediate
 *    repaints nothing, INCLUDING one for a ref that never streamed;
 *  - the 15s fade, on an INJECTED MOVING clock (the frozen-clock rule:
 *    a pinned now() beside advancing timers has shipped release-blocking
 *    defects under a green suite — every timing assertion here advances t).
 *
 * The store is memory only by contract; there is no db import to misuse,
 * and the messaging suite pins the funnel side (no row, no preview, no
 * unread, no ack).
 */
import {
  createStreamEditStore,
  STREAM_EXPIRY_MS,
  STREAM_SLOTS_PER_PEER_MAX,
  STREAM_SWEEP_AFTER_MS,
} from '../src/streamEdits';

const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const OTHER = '01OTHERZ3NDEKTSV4RRFFQ69G5';
const REF = '01REFZZ3NDEKTSV4RRFFQ69G5F';

function makeStore(startAt = 0) {
  let t = startAt;
  const store = createStreamEditStore(() => t);
  return {
    store,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe('seq — strictly increasing per key', () => {
  test('later wins; equal and older repaint nothing', () => {
    const { store } = makeStore();
    expect(store.apply(PEER, REF, 1, 'one')).toBe(true);
    expect(store.apply(PEER, REF, 1, 'one again')).toBe(false);
    expect(store.apply(PEER, REF, 0, 'zero')).toBe(false);
    expect(store.get(PEER, REF)?.text).toBe('one');
    // Gaps are legal and unobservable — loss tolerance is the point.
    expect(store.apply(PEER, REF, 7, 'seven')).toBe(true);
    expect(store.apply(PEER, REF, 3, 'three, late')).toBe(false);
    expect(store.get(PEER, REF)?.text).toBe('seven');
  });

  test('the counter is per (peer, ref): the SAME ref under another peer is another slot', () => {
    const { store } = makeStore();
    store.apply(PEER, REF, 5, 'from peer');
    // A stranger quoting the same msgId lands in their own slot — never
    // over the real one (the db.applyEdit WHERE-clause argument, applied
    // to memory).
    expect(store.apply(OTHER, REF, 1, 'from other')).toBe(true);
    expect(store.get(PEER, REF)?.text).toBe('from peer');
    expect(store.get(OTHER, REF)?.text).toBe('from other');
  });

  test('the counter survives the fade: an expired slot still refuses old seq', () => {
    const { store, tick } = makeStore();
    store.apply(PEER, REF, 5, 'five');
    tick(STREAM_EXPIRY_MS + 1);
    expect(store.get(PEER, REF)).toBeNull(); // faded…
    expect(store.apply(PEER, REF, 4, 'stale replay')).toBe(false); // …not reset
    expect(store.apply(PEER, REF, 6, 'six')).toBe(true);
    expect(store.get(PEER, REF)?.text).toBe('six');
  });
});

describe('closed — terminal', () => {
  test('close ends the key: no repaint, ever again', () => {
    const { store } = makeStore();
    store.apply(PEER, REF, 1, 'streaming…');
    store.close(PEER, REF);
    expect(store.get(PEER, REF)).toBeNull();
    expect(store.apply(PEER, REF, 99, 'late intermediate')).toBe(false);
    expect(store.get(PEER, REF)).toBeNull();
  });

  test('close works for a ref that never streamed — the late frame it refuses may be the FIRST one', () => {
    const { store } = makeStore();
    store.close(PEER, REF);
    expect(store.apply(PEER, REF, 1, 'first and late')).toBe(false);
    expect(store.get(PEER, REF)).toBeNull();
  });

  test('close is idempotent and scoped to its own key', () => {
    const { store } = makeStore();
    store.apply(PEER, REF, 1, 'a');
    store.apply(OTHER, REF, 1, 'b');
    store.close(PEER, REF);
    store.close(PEER, REF);
    expect(store.get(OTHER, REF)?.text).toBe('b');
  });
});

describe('the fade — a moving clock', () => {
  test('fresh until STREAM_EXPIRY_MS, gone at it', () => {
    const { store, tick } = makeStore();
    store.apply(PEER, REF, 1, 'alive');
    tick(STREAM_EXPIRY_MS - 1);
    expect(store.get(PEER, REF)?.text).toBe('alive');
    tick(1);
    expect(store.get(PEER, REF)).toBeNull();
  });

  test('every accepted frame restarts the fade — a live stream never flickers', () => {
    const { store, tick } = makeStore();
    store.apply(PEER, REF, 1, 'one');
    tick(STREAM_EXPIRY_MS - 1_000);
    store.apply(PEER, REF, 2, 'two');
    tick(STREAM_EXPIRY_MS - 1);
    expect(store.get(PEER, REF)?.text).toBe('two');
  });

  test('a REFUSED frame does not restart the fade', () => {
    const { store, tick } = makeStore();
    store.apply(PEER, REF, 5, 'five');
    tick(STREAM_EXPIRY_MS - 1);
    store.apply(PEER, REF, 5, 'replay'); // refused: equal seq
    tick(1);
    expect(store.get(PEER, REF)).toBeNull();
  });
});

describe('clear and subscribe', () => {
  test('clear wipes every slot (the relock rule) but keeps subscribers', () => {
    const { store } = makeStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(1));
    store.apply(PEER, REF, 1, 'a');
    store.clear();
    expect(store.get(PEER, REF)).toBeNull();
    store.apply(PEER, REF, 1, 'next workspace');
    expect(seen).toHaveLength(3); // apply, clear, apply — the listener survived
  });

  test('accepted apply, close and non-empty clear emit; a refused apply stays silent', () => {
    const { store } = makeStore();
    let emits = 0;
    const off = store.subscribe(() => {
      emits += 1;
    });
    store.apply(PEER, REF, 1, 'a'); // 1
    store.apply(PEER, REF, 1, 'refused'); // still 1 — no repaint storm
    expect(emits).toBe(1);
    store.close(PEER, REF); // 2
    expect(emits).toBe(2);
    store.clear(); // 3
    store.clear(); // empty: still 3
    expect(emits).toBe(3);
    off();
    store.apply(PEER, REF, 2, 'b');
    expect(emits).toBe(3);
  });

  test('a throwing subscriber never breaks the frame path', () => {
    const { store } = makeStore();
    store.subscribe(() => {
      throw new Error('broken subscriber');
    });
    expect(store.apply(PEER, REF, 1, 'still lands')).toBe(true);
    expect(store.get(PEER, REF)?.text).toBe('still lands');
  });
});

/**
 * BOUNDED MEMORY — red-first. Fade was RENDER-only: a
 * hostile peer minting slots against ever-new msgIds at relay pace grew the
 * map without bound. The bound is per PEER (the key's peer scoping already
 * stops cross-thread writes): a small slot cap with dead-first/oldest-first
 * eviction on insert, closed markers folded into the SAME cap, and an
 * opportunistic sweep of long-dead slots on the only path that grows.
 * The accepted trade, stated: an evicted or swept slot releases its seq and
 * closed guards, so a sufficiently late replay can repaint — in the sender's
 * OWN thread only, for one fade window, healed by any next frame — which is
 * strictly better than unbounded growth.
 */
describe('bounded memory — the per-peer cap, eviction, and the sweep', () => {
  const ref = (i: number) => `${REF}${i}`;

  test('a flood of new refs from one peer holds the cap: newest slots paint, oldest are GONE (guards released)', () => {
    const { store } = makeStore(1_000);
    const FLOOD = 40;
    for (let i = 0; i < FLOOD; i += 1) {
      expect(store.apply(PEER, ref(i), 1, `text ${i}`)).toBe(true);
    }
    // Only the newest STREAM_SLOTS_PER_PEER_MAX survive…
    for (let i = 0; i < FLOOD - STREAM_SLOTS_PER_PEER_MAX; i += 1) {
      expect(store.get(PEER, ref(i))).toBeNull();
    }
    for (let i = FLOOD - STREAM_SLOTS_PER_PEER_MAX; i < FLOOD; i += 1) {
      expect(store.get(PEER, ref(i))?.text).toBe(`text ${i}`);
    }
    // …and an evicted slot is DELETED, not faded: its seq guard went with it
    // (equal seq would be refused by a retained slot).
    expect(store.apply(PEER, ref(0), 1, 'fresh slot')).toBe(true);
  });

  test('eviction prefers the dead: faded slots go first (oldest first), live slots survive', () => {
    const { store, tick } = makeStore(1_000);
    for (let i = 0; i < STREAM_SLOTS_PER_PEER_MAX - 1; i += 1) {
      store.apply(PEER, ref(i), 1, `old ${i}`);
      tick(1); // distinct ages: ref(0) is the oldest
    }
    tick(STREAM_EXPIRY_MS + 1); // every slot above is faded, none sweep-old
    store.apply(PEER, 'live-ref', 3, 'still live'); // the cap is now full
    store.apply(PEER, 'new-ref', 1, 'newcomer'); // insert at cap: one eviction
    // The live slot and the newcomer both paint — eviction took a faded one.
    expect(store.get(PEER, 'live-ref')?.text).toBe('still live');
    expect(store.get(PEER, 'new-ref')?.text).toBe('newcomer');
    // The OLDEST faded slot went; its younger sibling kept its seq guard.
    // (Guard check FIRST — it does not grow; the reborn insert below is
    // itself an insert-at-cap and would evict the sibling next.)
    expect(store.apply(PEER, ref(1), 1, 'replay')).toBe(false);
    expect(store.apply(PEER, ref(0), 1, 'reborn')).toBe(true);
  });

  test('when every slot is live, the oldest live one is evicted — never the newcomer refused', () => {
    const { store, tick } = makeStore(1_000);
    for (let i = 0; i < STREAM_SLOTS_PER_PEER_MAX; i += 1) {
      store.apply(PEER, ref(i), 2, `live ${i}`);
      tick(1);
    }
    store.apply(PEER, 'one-more', 1, 'past the cap');
    expect(store.get(PEER, ref(0))).toBeNull(); // the oldest live slot went
    expect(store.get(PEER, ref(1))?.text).toBe('live 1'); // its junior stayed
    expect(store.get(PEER, 'one-more')?.text).toBe('past the cap');
    expect(store.apply(PEER, ref(0), 2, 'reborn')).toBe(true); // gone, not refused
  });

  test('closed markers ride the SAME cap: a close flood is bounded, retained markers still refuse stragglers', () => {
    const { store } = makeStore(1_000);
    const FLOOD = 40;
    for (let i = 0; i < FLOOD; i += 1) store.close(PEER, ref(i));
    // The newest markers hold the terminal guard…
    expect(store.apply(PEER, ref(FLOOD - 1), 1, 'straggler')).toBe(false);
    expect(store.apply(PEER, ref(FLOOD - STREAM_SLOTS_PER_PEER_MAX), 1, 'straggler')).toBe(false);
    // …and beyond the cap the oldest were evicted — bounded beats eternal.
    expect(store.apply(PEER, ref(0), 1, 'reopened: the accepted trade')).toBe(true);
  });

  test('the opportunistic sweep: a peer’s next insert clears its long-dead slots — and ONLY the long-dead', () => {
    const { store, tick } = makeStore(1_000);
    store.apply(PEER, REF, 5, 'a stream that died');
    store.close(PEER, `${REF}closed`);
    tick(STREAM_SWEEP_AFTER_MS - 1);
    store.apply(PEER, ref(1), 1, 'inside the window');
    // Inside the retention window both guards hold (the fade pin above
    // covers EXPIRY; this pins the window's far edge).
    expect(store.apply(PEER, REF, 4, 'stale replay')).toBe(false);
    expect(store.apply(PEER, `${REF}closed`, 1, 'straggler')).toBe(false);
    tick(1); // now exactly sweep-old
    store.apply(PEER, ref(2), 1, 'the insert that sweeps');
    expect(store.apply(PEER, REF, 4, 'released with the slot')).toBe(true);
    expect(store.apply(PEER, `${REF}closed`, 1, 'released marker too')).toBe(true);
  });

  test('the cap is PER PEER: one peer’s flood evicts nothing of another’s', () => {
    const { store } = makeStore(1_000);
    store.apply(OTHER, REF, 7, 'the other thread');
    for (let i = 0; i < 40; i += 1) store.apply(PEER, ref(i), 1, `text ${i}`);
    expect(store.get(OTHER, REF)?.text).toBe('the other thread');
    expect(store.apply(OTHER, REF, 7, 'replay')).toBe(false);
  });
});
