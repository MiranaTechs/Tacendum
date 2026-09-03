/**
 * MULTI-DEVICE TOFU — written FIRST
 * and failing before the fix, refusals leading:
 *
 *  1. A server-asserted sibling WITHOUT a valid cross-signature blocks
 *     exactly like a key change: the device lands in the 'pending' hold
 *     state, the inbound gate answers 'hold' (messages queued un-acked —
 *     the identityChanged contract), and no fan-out leg ever
 *     targets it. The server's word alone moves nothing.
 *
 *  2. WITH a valid cross-signature — the link certificate verifying
 *     under an identity key this device ALREADY pinned for that contact —
 *     the sibling is auto-accepted, the inline notice surfaces (the
 *     "Alice added a tablet" finding, class included), and delivery is
 *     ordinary.
 *
 *  3. A blocked contact's newly cross-signed sibling is BORN BLOCKED
 *     (the roster-keyed auto-extension): rotating device ULIDs inside a
 *     group evades nothing.
 *
 *  4. A verified `dissolve` notice (the peer-visible half) drops the
 *     sibling association and invalidates the cached certificates; a
 *     forged one is dropped and moves nothing.
 *
 * The suite drives the REAL pin-store logic — peerDevices' own chain
 * verification and state machine — against injected fakes whose verify
 * implements a deterministic signature scheme, so what is asserted is the
 * module's decision, never a stubbed verdict.
 */

import type { GroupMemberCerts, LinkOpTuple } from '@tacendum/shared';
import {
  acceptPeerDevice,
  applyPeerMutationNotice,
  applyServedRoster,
  fanoutDeviceSet,
  forgetPeerIdentity,
  inboundGateFor,
  recordPeerIdentity,
  type PeerDeviceRow,
  type PeerDevicesDeps,
} from '../src/peerDevices';

/* ── fixtures ─────────────────────────────────────────────────────── */

const ANCHOR = '01HQAAAA00000000000000000A'; // the contact we already know
const TABLET = '01HQBBBB00000000000000000B'; // the sibling they add
const THIRD = '01HQCCCC00000000000000000C';
const GROUP = '01HQGGGG0000000000000000G0';
const NONCE = '01HQNNNN00000000000000000N';
const NOW = 1_756_000_000_000;

const ANCHOR_KEY = 'QU5DSE9SS0VZ'; // the key we pinned at first contact
const TABLET_KEY = 'VEFCTEVUS0VZ';
const STRANGER_KEY = 'U1RSQU5HRVI=';
/** The contact's NEW identity — what their bundle serves after a key change
 * the human accepted. */
const ANCHOR_KEY_2 = 'QU5DSE9SS0VZMg==';

/** The deterministic fake signature scheme the fake verify checks: a
 * signature is valid iff it names the op, the SIGNER's key, the subject key
 * and the nonce — so the suite mints "genuine" certs only under keys it
 * actually holds, and the module's chain logic does the rest. */
function mintSig(op: string, signerKey: string, tuple: LinkOpTuple): string {
  return `xsig(${op}:${signerKey}:${tuple.subjectIdentityPubKey}:${tuple.offerNonce})`;
}

function certTuple(subjectKey: string): LinkOpTuple {
  return {
    groupId: GROUP,
    offererUserId: ANCHOR,
    acceptorUserId: TABLET,
    subjectIdentityPubKey: subjectKey,
    class: 'tablet',
    rosterEpoch: 0,
    offerNonce: NONCE,
    expiresAt: Math.floor(NOW / 1000) + 600,
  };
}

/** The certs on the tablet's roster entry: the offer is the ANCHOR's
 * certification of the tablet's key. `signerKey` decides forgery. */
function tabletCerts(signerKey: string): GroupMemberCerts {
  return {
    offerSig: mintSig('offer', signerKey, certTuple(TABLET_KEY)),
    acceptSig: mintSig('accept', TABLET_KEY, certTuple(ANCHOR_KEY)),
    groupId: GROUP,
    offererUserId: ANCHOR,
    acceptorUserId: TABLET,
    class: 'tablet',
    rosterEpoch: 0,
    offerNonce: NONCE,
    expiresAt: Math.floor(NOW / 1000) + 600,
  };
}

interface FakeState {
  rows: Map<string, PeerDeviceRow>;
  blocks: Map<string, number>;
}

function fakeDeps(): { deps: PeerDevicesDeps; state: FakeState } {
  const state: FakeState = { rows: new Map(), blocks: new Map() };
  const deps: PeerDevicesDeps = {
    db: {
      getPeerDevice: async userId => state.rows.get(userId) ?? null,
      listPeerDevices: async anchorId =>
        [...state.rows.values()].filter(r => r.anchorId === anchorId),
      upsertPeerDevice: async row => {
        state.rows.set(row.userId, { ...row });
      },
      peerBlockedAt: async peerId => state.blocks.get(peerId) ?? null,
      blockPeer: async (peerId, at) => {
        state.blocks.set(peerId, at);
      },
    },
    crypto: {
      // The REAL decision stays in the module: this only checks the fake
      // scheme's algebra, exactly as libsignal only checks curve algebra.
      verifyLinkOp: async (keyB64, op, tuple, sig) =>
        sig === mintSig(op, keyB64, tuple),
    },
    now: () => NOW,
  };
  return { deps, state };
}

/** The contact as we already hold them: one pinned device — themselves. */
async function pinAnchor(deps: PeerDevicesDeps): Promise<void> {
  await deps.db.upsertPeerDevice({
    userId: ANCHOR,
    anchorId: ANCHOR,
    class: 'unknown',
    state: 'linked',
    identityKeyPub: ANCHOR_KEY,
    certsJson: '',
    updatedAt: NOW,
  });
}

/* ── 1. un-cross-signed sibling: block-and-warn, never trust ──────── */

describe('a server-asserted sibling WITHOUT a valid cross-signature', () => {
  it('lands in the hold state: inbound gate holds (queued un-acked), zero fan-out legs', async () => {
    const { deps, state } = fakeDeps();
    await pinAnchor(deps);
    // The server asserts a sibling whose cert was signed by a key we never
    // pinned — the forged-roster case.
    const findings = await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(STRANGER_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    expect(findings).toEqual([
      { userId: TABLET, class: 'tablet', outcome: 'unverified' },
    ]);
    expect(state.rows.get(TABLET)?.state).toBe('pending');
    // Blocks exactly like a key change: messages from it queue un-acked.
    expect(await inboundGateFor(TABLET, deps)).toBe('hold');
    // …and no leg is ever addressed to it.
    expect(await fanoutDeviceSet(ANCHOR, deps)).toEqual([ANCHOR]);
  });

  it('a pending row UPGRADES when a verifiable certificate arrives', async () => {
    const { deps, state } = fakeDeps();
    await pinAnchor(deps);
    // First signal: unverifiable — the hold.
    await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(STRANGER_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    expect(state.rows.get(TABLET)?.state).toBe('pending');
    // Next signal carries the GENUINE certificate: the same machine
    // re-judges the held row and upgrades it — with the acceptance finding,
    // because this is the moment the inline notice belongs to.
    const findings = await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    expect(findings).toEqual([
      { userId: TABLET, class: 'tablet', outcome: 'accepted' },
    ]);
    expect(state.rows.get(TABLET)?.state).toBe('linked');
    expect(await inboundGateFor(TABLET, deps)).toBe('deliver');
  });

  it('the human accepting it is the only way out of the hold', async () => {
    const { deps } = fakeDeps();
    await pinAnchor(deps);
    await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(STRANGER_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    await acceptPeerDevice(TABLET, deps);
    expect(await inboundGateFor(TABLET, deps)).toBe('deliver');
    expect(await fanoutDeviceSet(ANCHOR, deps)).toEqual([ANCHOR, TABLET]);
  });
});

/* ── 2. cross-signed sibling: inline notice, ordinary delivery ────── */

describe('a sibling WITH a valid cross-signature', () => {
  it('is auto-accepted with the inline finding (class included) and delivers', async () => {
    const { deps, state } = fakeDeps();
    await pinAnchor(deps);
    const findings = await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    // The "Alice added a tablet" finding: who, which class, accepted.
    expect(findings).toEqual([
      { userId: TABLET, class: 'tablet', outcome: 'accepted' },
    ]);
    expect(state.rows.get(TABLET)?.state).toBe('linked');
    expect(await inboundGateFor(TABLET, deps)).toBe('deliver');
    expect(await fanoutDeviceSet(ANCHOR, deps)).toEqual([ANCHOR, TABLET]);
  });

  it('is idempotent: the same served roster twice reports nothing new', async () => {
    const { deps } = fakeDeps();
    await pinAnchor(deps);
    const roster = {
      anchorId: ANCHOR,
      siblings: [
        { userId: TABLET, class: 'tablet' as const, certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
      ],
    };
    await applyServedRoster(roster, deps);
    expect(await applyServedRoster(roster, deps)).toEqual([]);
  });

  it('a revoked device NEVER resurrects from a served roster', async () => {
    const { deps, state } = fakeDeps();
    await pinAnchor(deps);
    await deps.db.upsertPeerDevice({
      userId: TABLET,
      anchorId: ANCHOR,
      class: 'tablet',
      state: 'revoked',
      identityKeyPub: TABLET_KEY,
      certsJson: '',
      updatedAt: NOW - 1,
    });
    const findings = await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    expect(findings).toEqual([]);
    expect(state.rows.get(TABLET)?.state).toBe('revoked');
    expect(await fanoutDeviceSet(ANCHOR, deps)).toEqual([ANCHOR]);
  });
});

/* ── 3. roster-keyed blocks: the sibling is born blocked ─────── */

describe('a blocked contact adding a cross-signed device', () => {
  it('the new sibling is born blocked — ULID rotation evades nothing', async () => {
    const { deps, state } = fakeDeps();
    await pinAnchor(deps);
    await deps.db.blockPeer(ANCHOR, NOW - 5);
    await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    expect(state.blocks.get(TABLET)).toBe(NOW);
    // Accepted AND blocked are orthogonal records: the roster is truthful,
    // the block is the person's decision, extended to the roster.
    expect(state.rows.get(TABLET)?.state).toBe('linked');
  });

  it('an unblocked contact’s sibling is not blocked', async () => {
    const { deps, state } = fakeDeps();
    await pinAnchor(deps);
    await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
    expect(state.blocks.has(TABLET)).toBe(false);
  });
});

/* ── 4. the verified dissolve notice (the peer-visible half) ───── */

describe('a dissolve notice', () => {
  async function groupedPair(deps: PeerDevicesDeps): Promise<void> {
    await pinAnchor(deps);
    await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
  }

  function dissolveTuple(): LinkOpTuple {
    return {
      groupId: GROUP,
      offererUserId: ANCHOR,
      acceptorUserId: ANCHOR,
      subjectIdentityPubKey: ANCHOR_KEY,
      class: 'unknown' as never, // set per-test; see below
      rosterEpoch: 2,
      offerNonce: NONCE,
      expiresAt: Math.floor(NOW / 1000) + 300,
    };
  }

  it('VERIFIED: drops the sibling association and invalidates the cached certs', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    expect(state.rows.get(TABLET)?.certsJson).not.toBe('');
    const tuple = { ...dissolveTuple(), class: 'phone' as const };
    const outcome = await applyPeerMutationNotice(
      {
        senderDeviceId: ANCHOR,
        op: 'dissolve',
        tuple,
        signature: mintSig('dissolve', ANCHOR_KEY, tuple),
      },
      deps,
    );
    expect(outcome).toBe('applied');
    // The association is GONE: each device is its own standalone contact…
    expect(state.rows.get(TABLET)?.anchorId).toBe(TABLET);
    expect(state.rows.get(ANCHOR)?.anchorId).toBe(ANCHOR);
    // …the cached certificates are invalidated (the epoch moved)…
    expect(state.rows.get(TABLET)?.certsJson).toBe('');
    // …and fan-out no longer multiplies.
    expect(await fanoutDeviceSet(ANCHOR, deps)).toEqual([ANCHOR]);
  });

  it('FORGED: is dropped and moves nothing', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    const tuple = { ...dissolveTuple(), class: 'phone' as const };
    const outcome = await applyPeerMutationNotice(
      {
        senderDeviceId: ANCHOR,
        op: 'dissolve',
        tuple,
        signature: mintSig('dissolve', STRANGER_KEY, tuple),
      },
      deps,
    );
    expect(outcome).toBe('dropped');
    expect(state.rows.get(TABLET)?.anchorId).toBe(ANCHOR);
    expect(state.rows.get(TABLET)?.certsJson).not.toBe('');
    expect(await fanoutDeviceSet(ANCHOR, deps)).toEqual([ANCHOR, TABLET]);
  });

  it('a signed unlink/revoke from a linked member removes exactly the target', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    const tuple: LinkOpTuple = {
      groupId: GROUP,
      offererUserId: ANCHOR,
      acceptorUserId: TABLET,
      subjectIdentityPubKey: TABLET_KEY,
      class: 'tablet',
      rosterEpoch: 2,
      offerNonce: NONCE,
      expiresAt: Math.floor(NOW / 1000) + 300,
    };
    const outcome = await applyPeerMutationNotice(
      {
        senderDeviceId: ANCHOR,
        op: 'revoke',
        tuple,
        signature: mintSig('revoke', ANCHOR_KEY, tuple),
      },
      deps,
    );
    expect(outcome).toBe('applied');
    expect(state.rows.get(TABLET)?.state).toBe('revoked');
    expect(await fanoutDeviceSet(ANCHOR, deps)).toEqual([ANCHOR]);
    // Terminal: a later served roster cannot re-link it (case 2 above).
  });

  it('a notice from a sender outside the pinned set is dropped unheard', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    const tuple = { ...dissolveTuple(), class: 'phone' as const, offererUserId: THIRD, acceptorUserId: THIRD };
    const outcome = await applyPeerMutationNotice(
      {
        senderDeviceId: THIRD,
        op: 'dissolve',
        tuple,
        signature: mintSig('dissolve', STRANGER_KEY, tuple),
      },
      deps,
    );
    expect(outcome).toBe('dropped');
    expect(state.rows.get(TABLET)?.anchorId).toBe(ANCHOR);
  });
});

/* ── 5. an accepted identity change re-pins the roster row ── */

describe('an accepted identity change', () => {
  /** The contact with a cross-signed tablet, as before the key change. */
  async function groupedPair(deps: PeerDevicesDeps): Promise<void> {
    await pinAnchor(deps);
    await applyServedRoster(
      {
        anchorId: ANCHOR,
        siblings: [
          { userId: TABLET, class: 'tablet', certs: tabletCerts(ANCHOR_KEY), identityKeyPub: TABLET_KEY },
        ],
      },
      deps,
    );
  }

  /** A revoke of the tablet, signed by the anchor under `signerKey`. */
  function revokeNotice(signerKey: string) {
    const tuple: LinkOpTuple = {
      groupId: GROUP,
      offererUserId: ANCHOR,
      acceptorUserId: TABLET,
      subjectIdentityPubKey: TABLET_KEY,
      class: 'tablet',
      rosterEpoch: 2,
      offerNonce: NONCE,
      expiresAt: Math.floor(NOW / 1000) + 300,
    };
    return {
      senderDeviceId: ANCHOR,
      op: 'revoke' as const,
      tuple,
      signature: mintSig('revoke', signerKey, tuple),
    };
  }

  it('unpins the retired key: a notice signed under it is dropped, and the row keeps its place in the set', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    await forgetPeerIdentity(ANCHOR, deps);
    const row = state.rows.get(ANCHOR)!;
    expect(row.identityKeyPub).toBe('');
    expect(row).toMatchObject({ anchorId: ANCHOR, state: 'linked', class: 'unknown' });
    // The key the human retired vouches for nothing any more.
    expect(await applyPeerMutationNotice(revokeNotice(ANCHOR_KEY), deps)).toBe('dropped');
    expect(state.rows.get(TABLET)?.state).toBe('linked');
  });

  it('the next served bundle re-pins through the empty-key path, and a notice under the NEW key verifies', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    await forgetPeerIdentity(ANCHOR, deps);
    // What the next bundle fetch does — recordPeerIdentity with no force: the
    // ordinary first-contact call, admitted because the row is unpinned.
    await recordPeerIdentity(ANCHOR, ANCHOR_KEY_2, deps);
    expect(state.rows.get(ANCHOR)).toMatchObject({
      identityKeyPub: ANCHOR_KEY_2,
      anchorId: ANCHOR,
      state: 'linked',
      updatedAt: NOW,
    });
    // THE DEFECT: before the fix the row still held ANCHOR_KEY, so this
    // genuine notice under the accepted key failed silently, forever.
    expect(await applyPeerMutationNotice(revokeNotice(ANCHOR_KEY_2), deps)).toBe('applied');
    expect(state.rows.get(TABLET)?.state).toBe('revoked');
  });

  it('a forgery under the OLD key still fails after the re-pin', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    await forgetPeerIdentity(ANCHOR, deps);
    await recordPeerIdentity(ANCHOR, ANCHOR_KEY_2, deps);
    expect(await applyPeerMutationNotice(revokeNotice(ANCHOR_KEY), deps)).toBe('dropped');
    expect(state.rows.get(TABLET)?.state).toBe('linked');
  });

  it('a standing key is never overwritten by a plain record — only by force', async () => {
    const { deps, state } = fakeDeps();
    await groupedPair(deps);
    // The long-standing rule, kept: a different key for the same ULID
    // arriving on an ordinary fetch is the identityChanged path's business.
    await recordPeerIdentity(ANCHOR, STRANGER_KEY, deps);
    expect(state.rows.get(ANCHOR)?.identityKeyPub).toBe(ANCHOR_KEY);
    // The acceptance path's own re-pin: forced, and the row keeps its
    // anchor, class, state and certs — only the key moves.
    const before = state.rows.get(ANCHOR)!;
    await recordPeerIdentity(ANCHOR, ANCHOR_KEY_2, deps, { force: true });
    expect(state.rows.get(ANCHOR)).toEqual({
      ...before,
      identityKeyPub: ANCHOR_KEY_2,
      updatedAt: NOW,
    });
    expect(await applyPeerMutationNotice(revokeNotice(ANCHOR_KEY_2), deps)).toBe('applied');
  });

  it('forgetting an unknown contact, or one already unpinned, writes nothing', async () => {
    const { deps, state } = fakeDeps();
    await forgetPeerIdentity(ANCHOR, deps);
    expect(state.rows.size).toBe(0);
    await pinAnchor(deps);
    await forgetPeerIdentity(ANCHOR, deps);
    const once = { ...state.rows.get(ANCHOR)! };
    await forgetPeerIdentity(ANCHOR, deps);
    expect(state.rows.get(ANCHOR)).toEqual(once);
  });
});
