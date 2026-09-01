/**
 * The x.edit stream overlay — what the phone
 * REMEMBERS about a reply that is still being written, and nothing more.
 *
 * A streaming turn mints ONE durable anchor row; intermediates then arrive
 * as sealed `x.edit {ref, seq, text}` on the relay-only typing lane and are
 * painted OVER that row from here. This store is deliberately dumb about
 * everything except four guards, because everything else already has an
 * owner: the schema bounds the payload (packages/shared/stream-envelope),
 * messaging owns the apply predicate (the anchor row must exist and belong
 * to the sender), and the durable `tcm:'edit'` final owns the truth.
 *
 * The four guards:
 *
 *  - SEQ STRICTLY INCREASING PER KEY. Later wins; equal or older is
 *    ignored. Gaps are legal and unobservable — a dropped frame is healed
 *    wholly by the next snapshot (full replacement).
 *    The counter survives expiry on purpose: fade is a RENDER fact, not a
 *    state reset, and a reset would let a replayed old frame repaint.
 *
 *  - CLOSED IS TERMINAL. When the durable final edit for a ref applies,
 *    the key closes and every further relay frame for it is ignored — a
 *    late intermediate must never repaint a finalized bubble. The closed
 *    marker is kept (text dropped) rather than deleted, because deleting
 *    it is exactly how a straggler frame would sneak back in.
 *
 *  - STREAM_EXPIRY_MS FADE. An overlay whose last frame is old is not
 *    returned: the stream died (app backgrounded, relay lost, CLI crashed)
 *    and the bubble reverts to durable truth until the final edit heals
 *    it. The clock is INJECTED (app/src/typing.ts's discipline, and the
 *    frozen-clock rule: tests advance a moving clock, never pin one).
 *
 *  - BOUNDED, PER PEER. Fade alone was render-only — a peer
 *    minting frames (or durable-final closes) against ever-new msgIds at
 *    relay pace grew this map without bound for the life of the process.
 *    Growth happens only where a NEW slot is inserted, so that path holds
 *    the whole bound: an opportunistic sweep of the peer's long-dead slots
 *    (dead ≥ STREAM_SWEEP_AFTER_MS), then a hard cap of
 *    STREAM_SLOTS_PER_PEER_MAX slots — closed markers INCLUDED, they are
 *    the same flood — evicting dead-first, oldest-first, so a live stream
 *    is the last thing standing. THE TRADE, stated: an evicted or swept
 *    slot releases its seq and closed guards, so a sufficiently late
 *    replay can repaint — in the sender's OWN thread only (the peer
 *    scoping below), for one fade window, healed by any next frame or the
 *    durable row it sits over. Strictly better than unbounded growth, and
 *    unreachable for an honest lane: one peer streams one reply at a time,
 *    and stragglers arrive in seconds, not sweep-windows.
 *
 * MEMORY ONLY, by contract: nothing here may ever touch the database, the
 * chat list, the unread count, the badge, or a notification. The overlay
 * is a rendering courtesy for an open thread; every durable consequence of
 * the reply belongs to the anchor row and the final edit.
 */

/** How long the last accepted frame keeps the overlay painted. The typing
 * indicator's expiry (TYPING_EXPIRY_MS), for the typing lane's reason: the
 * sender refreshes well inside this window while alive, so a silent lane
 * means the stream is gone, not slow. */
export const STREAM_EXPIRY_MS = 15_000;

/** The per-peer slot bound, closed markers included. Small on
 * purpose: an honest peer streams ONE reply at a time, so anything past a
 * handful of slots is either ancient or a flood — and the flood is the
 * thing this caps. */
export const STREAM_SLOTS_PER_PEER_MAX = 8;

/** How long a render-dead slot (faded, or a closed marker) keeps its seq /
 * closed guard before the sweep may drop it: several full fade windows, so
 * every realistic straggler — relay redelivery is seconds — still meets its
 * guard, while an idle peer's slots go to zero on their next frame. */
export const STREAM_SWEEP_AFTER_MS = STREAM_EXPIRY_MS * 4;

/** What the thread renders over the anchor: the snapshot, and when its
 * frame arrived (the fade base — the SCREEN schedules its own repaint off
 * `at + STREAM_EXPIRY_MS`, this store keeps no timers). */
export interface StreamEditOverlay {
  text: string;
  at: number;
}

interface Slot {
  seq: number;
  /** Emptied at close — the marker must outlive the words, not the words
   * the marker. */
  text: string;
  at: number;
  closed: boolean;
}

export interface StreamEditStore {
  /** One relay frame. True iff the overlay changed (the guards above are
   * the only reasons it would not). */
  apply(peerId: string, ref: string, seq: number, text: string): boolean;
  /** The durable final edit for (peer, ref) applied: close the key for
   * good. Idempotent; creates the closed marker even for a ref that never
   * streamed, because the late frame it refuses may be the FIRST one. */
  close(peerId: string, ref: string): void;
  /** The overlay to paint, or null — absent, closed, or faded. */
  get(peerId: string, ref: string): StreamEditOverlay | null;
  /** Repaint signal. Subscription-owned: clear() wipes entries, never
   * listeners (the messaging listener-set convention). */
  subscribe(listener: () => void): () => void;
  /** Wipe every entry (messaging.stop(): a decoy
   * session must not inherit the real session's half-written replies). */
  clear(): void;
}

export function createStreamEditStore(
  // Late-bound on purpose: `= Date.now` would capture the REAL function at
  // module load, and a test that then installs fake timers would advance
  // the screen's clock while this store kept real time — two clocks, the
  // exact failure class the frozen-clock rule records. Resolving
  // `Date.now` per call keeps the store on whatever clock the process is
  // actually running.
  now: () => number = () => Date.now(),
): StreamEditStore {
  /** Peer → (ref → slot). The peer is the OUTER key, structurally: a
   * stranger quoting another thread's msgId addresses their own peer's
   * map, never the real one (db.applyEdit's WHERE-clause argument, applied
   * to memory) — and the bound is per peer, so the peer map is also the
   * unit the sweep and the cap walk. A peer's map is never left empty:
   * every deletion happens inside `insert`, which always sets the new slot
   * after it prunes. */
  const peers = new Map<string, Map<string, Slot>>();
  const listeners = new Set<() => void>();

  /** THE ONE GROWING PATH — every new slot, streamed or closed
   * marker, enters here, so this is where the bound lives. Sweep first
   * (drop the peer's slots dead long enough that no realistic straggler
   * needs their guard), then cap: evict render-DEAD slots (closed, or
   * faded) before LIVE ones, oldest `at` first within each class — the
   * stable sort keeps insertion order on ties — so a live stream survives
   * everything but a flood of other live streams from its own sender. */
  function insert(peerId: string, ref: string, slot: Slot): void {
    const t = now();
    let refs = peers.get(peerId);
    if (refs === undefined) {
      refs = new Map<string, Slot>();
      peers.set(peerId, refs);
    }
    for (const [r, s] of refs) {
      if (t - s.at >= STREAM_SWEEP_AFTER_MS) refs.delete(r);
    }
    if (refs.size >= STREAM_SLOTS_PER_PEER_MAX) {
      const deadFirstOldestFirst = [...refs.entries()].sort((a, b) => {
        const aLive = !a[1].closed && t - a[1].at < STREAM_EXPIRY_MS ? 1 : 0;
        const bLive = !b[1].closed && t - b[1].at < STREAM_EXPIRY_MS ? 1 : 0;
        return aLive - bLive || a[1].at - b[1].at;
      });
      for (const [r] of deadFirstOldestFirst) {
        if (refs.size < STREAM_SLOTS_PER_PEER_MAX) break;
        refs.delete(r);
      }
    }
    refs.set(ref, slot);
  }

  function emit(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Advisory only — a broken subscriber must not break the frame
        // path (messaging.emitTyping's rule).
      }
    }
  }

  return {
    apply(peerId, ref, seq, text): boolean {
      const slot = peers.get(peerId)?.get(ref);
      if (slot) {
        if (slot.closed) return false;
        if (seq <= slot.seq) return false;
        slot.seq = seq;
        slot.text = text;
        slot.at = now();
      } else {
        insert(peerId, ref, { seq, text, at: now(), closed: false });
      }
      emit();
      return true;
    },

    close(peerId, ref): void {
      const slot = peers.get(peerId)?.get(ref);
      if (slot) {
        if (slot.closed) return;
        slot.closed = true;
        slot.text = '';
        // The marker's retention clock runs from the CLOSE — the straggler
        // window it guards opens now, not at the last accepted frame.
        slot.at = now();
      } else {
        insert(peerId, ref, { seq: -1, text: '', at: now(), closed: true });
      }
      // Emitted even when nothing was painted: the screen's memo is cheap,
      // and a missed close is a bubble frozen mid-sentence.
      emit();
    },

    get(peerId, ref): StreamEditOverlay | null {
      const slot = peers.get(peerId)?.get(ref);
      if (!slot || slot.closed) return null;
      if (now() - slot.at >= STREAM_EXPIRY_MS) return null;
      return { text: slot.text, at: slot.at };
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clear(): void {
      if (peers.size === 0) return;
      peers.clear();
      emit();
    },
  };
}

/** The app's one instance — messaging writes it, the thread screen reads
 * it. Tests that need the clock make their own via the factory. */
export const streamEdits = createStreamEditStore();
