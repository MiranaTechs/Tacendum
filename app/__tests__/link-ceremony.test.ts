/**
 * THE LINKING CEREMONY, CLIENT HALF — the
 * refusal cases first, because the ceremony's central property is what it
 * REFUSES to do:
 *
 *  1. A SCANNED ULID ALONE NEVER PRODUCES A LINK. Scanning yields a code
 *     and a stalled machine: no init, no signature, no submit until the
 *     human confirms on the scanning device — and even a confirmed,
 *     signed, submitted OFFER moves no roster. Without the OTHER device's
 *     confirmed, signed acceptance the ceremony stalls forever and the
 *     local group state never comes into being.
 *
 *  2. THE PREIMAGE IS EXACTLY THE OP-FRAMED APPENDIX A FORM —
 *     "tacendum-link-v1" ‖ op ‖ groupId ‖ A ‖ B ‖ subjectIdentityPubKey ‖
 *     class ‖ rosterEpoch ‖ offerNonce ‖ expiresAt, every field
 *     uint16be-length-prefixed. A reordered, unprefixed, op-stripped, or
 *     pubkey-stripped construction FAILS the committed fixture
 *     (packages/shared/linkvectors.json — the byte pin four
 *     implementations answer to).
 *
 *  3. A REVOKED DEVICE DISAPPEARS FROM THE ROSTER UI: the memberRevoked
 *     notice flips the row's state and the "Linked devices" screen stops
 *     listing it — rendered through the real screen, not a filter unit.
 *
 * The ceremony logic runs against injected fakes (call ledgers — the suite
 * asserts what NEVER happens, which needs a ledger, not a network); the
 * signing itself is native and proved by link-vectors.test.ts against the
 * Swift device-run fixtures.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  LINK_OFFER_TTL_SECONDS,
  linkOpSignedBytes,
  type AccountsNoticeFrame,
  type PrekeyBundle,
} from '@tacendum/shared';
import { LINK_POLL_STEPS_MS, LINK_POLL_TAIL_MS } from '../src/screens/LinkDeviceScreen';
import {
  AcceptorCeremony,
  currentRoster,
  dissolveGrouping,
  handleAccountsNoticeFrame,
  LINKING_COPY,
  mutateRoster,
  NoVerificationCodeError,
  OffererCeremony,
  onPeerRosterNotice,
  pendingOfferWaiting,
  reconcilePendingLink,
  redrivePendingMutations,
  type LinkingDeps,
  type PeerRosterNotice,
} from '../src/linking';
import * as accountsUsername from '../src/accountsUsername';
import * as db from '../src/db';
import { LinkedDevicesScreen } from '../src/screens/LinkedDevicesScreen';

const vectors = require('../../packages/shared/linkvectors.json') as {
  domain: string;
  cases: Array<{
    op: string;
    groupId: string;
    offererUserId: string;
    acceptorUserId: string;
    subjectIdentityPubKey: string;
    class: 'phone' | 'tablet' | 'desktop';
    rosterEpoch: number;
    offerNonce: string;
    expiresAt: number;
    preimageHex: string;
  }>;
};

/* ── fixtures ─────────────────────────────────────────────────────── */

const SELF = '01HQAAAA00000000000000000A';
const OTHER = '01HQBBBB00000000000000000B';
const THIRD = '01HQCCCC00000000000000000C';
const GROUP = '01HQGGGG0000000000000000G0';
const NONCE = '01HQNNNN00000000000000000N';
const NOW_MS = 1_756_000_000_000;
const EXPIRES = Math.floor(NOW_MS / 1000) + 600;
const CODE = '111112222233333444445555566666777778888899999000001111122222';

function bundleFor(userId: string, siblings?: PrekeyBundle['siblings']): PrekeyBundle {
  return {
    userId,
    registrationId: 7,
    identityKey: `IDKEY+${userId.slice(-4)}`,
    signedPrekey: { keyId: 1, pub: 'AA==', sig: 'AA==' },
    kyberPrekey: { keyId: 1, pub: 'AA==', sig: 'AA==' },
    ...(siblings ? { rosterVersion: 1, siblings } : {}),
  };
}

interface Ledger {
  init: unknown[];
  submit: Array<{ nonce: string; sig: string }>;
  accept: Array<{ nonce: string; sig: string }>;
  sign: Array<{ op: string; tuple: Record<string, unknown> }>;
  mutation: Array<{ op: string; body: Record<string, unknown> }>;
  bundles: string[];
  verify: Array<{ key: string; op: string; sig: string }>;
}

interface FakeState {
  group: { groupId: string; rosterEpoch: number } | null;
  devices: db.LinkedDeviceRow[];
  pendingOffer: { offerNonce: string; noticeJson: string; receivedAt: number } | null;
  pendingCeremony: { offerJson: string; createdAt: number } | null;
  pendingMutations: Map<string, db.PendingLinkMutationRow>;
  siblingAgents: Map<string, string[]>;
  pristine: boolean;
  bundleSiblings: Map<string, NonNullable<PrekeyBundle['siblings']>>;
}

function fakeDeps(): { deps: LinkingDeps; calls: Ledger; state: FakeState } {
  const calls: Ledger = {
    init: [],
    submit: [],
    accept: [],
    sign: [],
    mutation: [],
    bundles: [],
    verify: [],
  };
  const state: FakeState = {
    group: null,
    devices: [],
    pendingOffer: null,
    pendingCeremony: null,
    pendingMutations: new Map(),
    siblingAgents: new Map(),
    pristine: true,
    bundleSiblings: new Map(),
  };
  const deps: LinkingDeps = {
    api: {
      getPrekeyBundle: async (_t, userId) => {
        calls.bundles.push(userId);
        return bundleFor(userId, state.bundleSiblings.get(userId));
      },
      linkOfferInit: async (_t, body) => {
        calls.init.push(body);
        return { groupId: GROUP, rosterEpoch: 0, offerNonce: NONCE, expiresAt: EXPIRES };
      },
      linkOfferSubmit: async (_t, nonce, sig) => {
        calls.submit.push({ nonce, sig });
      },
      linkAccept: async (_t, nonce, sig) => {
        calls.accept.push({ nonce, sig });
      },
      rosterMutation: async (_t, op, body) => {
        calls.mutation.push({ op, body });
      },
    },
    crypto: {
      processPreKeyBundle: async () => undefined,
      safetyNumber: async () => CODE,
      signLinkOp: async (op, tuple) => {
        calls.sign.push({ op, tuple: { ...tuple } });
        return fakeSig(op, tuple as unknown as Record<string, unknown>);
      },
      // The verify half, faked as the sign fake's mirror: a signature
      // is valid iff it is what signLinkOp would have produced for that op
      // over the SAME nine-field tuple — so the forged fixtures
      // ("OFFERSIG"), a substituted subject, a re-classed wrap, and a
      // shifted epoch all fail, with the module's own logic deciding
      // everything else.
      verifyLinkOp: async (key, op, tuple, sig) => {
        calls.verify.push({ key, op, sig });
        return sig === fakeSig(op, tuple as unknown as Record<string, unknown>);
      },
      identityPublicKey: async () => `IDKEY+${SELF.slice(-4)}`,
    },
    db: {
      loadLinkGroup: async () => state.group,
      saveLinkGroup: async (groupId, rosterEpoch) => {
        state.group = { groupId, rosterEpoch };
      },
      upsertLinkedDevice: async row => {
        state.devices = [...state.devices.filter(d => d.userId !== row.userId), { ...row }];
      },
      markLinkedDeviceState: async (userId, deviceState, updatedAt) => {
        state.devices = state.devices.map(d =>
          d.userId === userId ? { ...d, state: deviceState, updatedAt } : d,
        );
      },
      listLinkedDevices: async () => [...state.devices],
      clearLinkGroup: async () => {
        state.group = null;
        state.devices = [];
      },
      savePendingLinkOffer: async (offerNonce, noticeJson, receivedAt) => {
        state.pendingOffer = { offerNonce, noticeJson, receivedAt };
      },
      loadPendingLinkOffer: async () => state.pendingOffer,
      deletePendingLinkOffer: async () => {
        state.pendingOffer = null;
      },
      savePendingLinkCeremony: async (offerJson, createdAt) => {
        state.pendingCeremony = { offerJson, createdAt };
      },
      loadPendingLinkCeremony: async () => state.pendingCeremony,
      deletePendingLinkCeremony: async () => {
        state.pendingCeremony = null;
      },
      pristineForLink: async () => state.pristine,
      savePendingLinkMutation: async row => {
        state.pendingMutations.set(row.offerNonce, { ...row });
      },
      listPendingLinkMutations: async () => [...state.pendingMutations.values()],
      deletePendingLinkMutation: async offerNonce => {
        state.pendingMutations.delete(offerNonce);
      },
      listSiblingAgents: async deviceUserId => state.siblingAgents.get(deviceUserId) ?? [],
      // The recovery-notice store (the loudness surfacing). This
      // suite's ceremonies never mint one; the accounts-flows suite drives
      // the recovery lifecycle.
      saveRecoveryNotice: async () => undefined,
      loadRecoveryNotice: async () => null,
      clearUsernameIdentifier: async () => undefined,
      saveUsernameNotice: async () => undefined,
    },
    token: async () => 'bearer-token',
    selfId: async () => SELF,
    now: () => NOW_MS,
    freshNonce: () => NONCE,
  };
  return { deps, calls, state };
}

function b64(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const bChar = i + 1 < text.length ? text.charCodeAt(i + 1) : undefined;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : undefined;
    out += alphabet[a >> 2];
    out += alphabet[((a & 0x03) << 4) | ((bChar ?? 0) >> 4)];
    out += bChar === undefined ? '=' : alphabet[((bChar & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : alphabet[c & 0x3f];
  }
  return out;
}

/** The fake signature scheme, BASE64-LEGAL because notice fields ride the
 * real zod wire (SignatureB64/IdentityKeyB64), and TUPLE-BOUND
 * deliberately: a signature is valid iff it names the op AND
 * the exact nine-field mutation tuple — the earlier op-only algebra let
 * an omitted or swapped binding verify anyway, which is precisely the
 * defect class the member*-notice fixes exist to catch. A compact digest
 * keeps the base64 inside the schema's length cap. */
const sigDigest = (op: string, tuple: Record<string, unknown>): string => {
  const line = [
    op,
    tuple.groupId,
    tuple.offererUserId,
    tuple.acceptorUserId,
    tuple.subjectIdentityPubKey,
    tuple.class,
    tuple.rosterEpoch,
    tuple.offerNonce,
    tuple.expiresAt,
  ].join('|');
  let h = 5381;
  for (const ch of line) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0');
};
const fakeSig = (op: string, tuple: Record<string, unknown>): string =>
  b64(`sig(${op}:${sigDigest(op, tuple)})`);
/** A canonical-base64 spelling of a fixture identity key, for fields the
 * schema validates as keys. */
const keyFor = (id: string): string => b64(`IDKEY+${id.slice(-4)}`);
/** The raw fixture key the crypto fake serves (`bundleFor`/identityPublicKey). */
const rawKey = (id: string): string => `IDKEY+${id.slice(-4)}`;

/** The OFFER tuple exactly as the acceptor-side verifier rebuilds it:
 * subject = the ACCEPTOR's own registered key. */
const offerTuple = (over: Record<string, unknown> = {}) => ({
  groupId: GROUP,
  offererUserId: OTHER,
  acceptorUserId: SELF,
  subjectIdentityPubKey: rawKey(SELF),
  class: 'phone',
  rosterEpoch: 0,
  offerNonce: NONCE,
  expiresAt: EXPIRES,
  ...over,
});

function noticeFrame(notice: Record<string, unknown>): AccountsNoticeFrame {
  return {
    type: 'accounts',
    from: OTHER,
    msgId: '01HQMMMM00000000000000000M',
    payload: b64(JSON.stringify(notice)),
    ts: NOW_MS,
  };
}

const offerNotice = (over: Record<string, unknown> = {}) => ({
  kind: 'linkOffer',
  groupId: GROUP,
  offererUserId: OTHER,
  acceptorUserId: SELF,
  acceptorClass: 'phone',
  rosterEpoch: 0,
  offerNonce: NONCE,
  expiresAt: EXPIRES,
  // A GENUINE offer signature under the fake scheme (what the offerer's
  // signLinkOp produces over the tuple the acceptor rebuilds). The earlier
  // anchor fixture here was the ASCII string "OFFERSIG" and the ceremony
  // accepted it; now the forged form is a dedicated
  // refusal case below.
  offerSig: fakeSig('offer', offerTuple()),
  ...over,
});

/** The signed-mutation fields every member* removal notice carries —
 * acting member SELF, whose key the fake verify
 * resolves through identityPublicKey; the signature covers the FULL
 * mutation tuple (class included). */
const signedMutationFields = (
  op: 'unlink' | 'revoke',
  target: string,
  signedRosterEpoch: number,
  cls: 'phone' | 'tablet' = 'tablet',
) => ({
  actingUserId: SELF,
  subjectIdentityPubKey: keyFor(target),
  offerNonce: NONCE,
  expiresAt: EXPIRES,
  signedRosterEpoch,
  signature: fakeSig(op, {
    groupId: GROUP,
    offererUserId: SELF,
    acceptorUserId: target,
    subjectIdentityPubKey: keyFor(target),
    class: cls,
    rosterEpoch: signedRosterEpoch,
    offerNonce: NONCE,
    expiresAt: EXPIRES,
  }),
});

/** The certificate block a memberLinked notice carries — the
 * offerSig is genuine over the cert's OWN tuple (subject = the joiner's
 * key), which is exactly what the receiver rebuilds and verifies. */
const linkedNoticeCerts = (userId: string, rosterEpoch: number) => {
  const tuple = {
    groupId: GROUP,
    offererUserId: SELF,
    acceptorUserId: userId,
    subjectIdentityPubKey: keyFor(userId),
    class: 'tablet' as const,
    rosterEpoch,
    offerNonce: NONCE,
    expiresAt: EXPIRES,
  };
  return {
    identityKeyPub: keyFor(userId),
    certs: {
      offerSig: fakeSig('offer', tuple),
      acceptSig: fakeSig('accept', { ...tuple, subjectIdentityPubKey: keyFor(SELF) }),
      groupId: GROUP,
      offererUserId: SELF,
      acceptorUserId: userId,
      class: 'tablet' as const,
      rosterEpoch,
      offerNonce: NONCE,
      expiresAt: EXPIRES,
    },
  };
};

/* ── 1. the stall: a scanned ULID alone never links ───────────────── */

describe('a scanned ULID alone NEVER produces a link', () => {
  it('scanning yields a code and a stalled machine — nothing signed, nothing submitted', async () => {
    const { deps, calls, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    expect(ceremony.phase).toBe('code');
    expect(ceremony.code).toBe(CODE);
    // The ONLY network traffic was the read-only bundle fetch. No init row,
    // no signature, no offer — the scanner is a party, not a trigger.
    expect(calls.init).toHaveLength(0);
    expect(calls.sign).toHaveLength(0);
    expect(calls.submit).toHaveLength(0);
    expect(calls.accept).toHaveLength(0);
    expect(state.group).toBeNull();
    expect(await currentRoster(deps)).toEqual([]);
  });

  it('a confirmed, signed, submitted OFFER still moves no roster — without the acceptance it stalls', async () => {
    const { deps, calls, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    // The offer exists…
    expect(calls.init).toHaveLength(1);
    expect(calls.submit).toEqual([
      {
        nonce: NONCE,
        sig: fakeSig('offer', {
          groupId: GROUP,
          offererUserId: SELF,
          acceptorUserId: OTHER,
          subjectIdentityPubKey: rawKey(OTHER),
          class: 'tablet',
          rosterEpoch: 0,
          offerNonce: NONCE,
          expiresAt: EXPIRES,
        }),
      },
    ]);
    expect(ceremony.phase).toBe('waiting');
    // …and that is ALL that exists: no group, no roster rows, and the
    // completion probe finds nothing for as long as nobody accepts.
    expect(state.group).toBeNull();
    expect(await ceremony.checkLinked()).toBe(false);
    expect(ceremony.phase).toBe('waiting');
    expect(state.group).toBeNull();
    expect(await currentRoster(deps)).toEqual([]);
  });

  it('past the offer\'s own expiry the stall becomes a visible failure — never a link', async () => {
    const { deps, state } = fakeDeps();
    let nowMs = NOW_MS;
    const clocked: LinkingDeps = { ...deps, now: () => nowMs };
    const ceremony = await OffererCeremony.begin(OTHER, clocked);
    await ceremony.confirm('tablet');
    nowMs = (EXPIRES + 1) * 1000;
    expect(await ceremony.checkLinked()).toBe(false);
    expect(ceremony.phase).toBe('failed');
    expect(state.group).toBeNull();
  });

  it('the offer preimage the ceremony signs is the full mutation tuple, subject = the ACCEPTOR key', async () => {
    const { deps, calls } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    expect(calls.sign).toEqual([
      {
        op: 'offer',
        tuple: {
          groupId: GROUP,
          offererUserId: SELF,
          acceptorUserId: OTHER,
          subjectIdentityPubKey: `IDKEY+${OTHER.slice(-4)}`,
          class: 'tablet',
          rosterEpoch: 0,
          offerNonce: NONCE,
          expiresAt: EXPIRES,
        },
      },
    ]);
    // Single-shot: the human confirmation cannot be replayed into a second
    // signature.
    await expect(ceremony.confirm('tablet')).rejects.toThrow();
  });

  it('the acceptor side stalls the same way: showing the offer signs nothing', async () => {
    const { deps, calls, state } = fakeDeps();
    expect(await handleAccountsNoticeFrame(noticeFrame(offerNotice()), deps)).toBe('stored');
    const opened = await AcceptorCeremony.open(deps);
    expect(opened).toBeInstanceOf(AcceptorCeremony);
    const ceremony = opened as AcceptorCeremony;
    expect(ceremony.code).toBe(CODE);
    expect(calls.sign).toHaveLength(0);
    expect(calls.accept).toHaveLength(0);
    expect(state.group).toBeNull();
    // Declining kills the ceremony visibly and signs nothing, ever.
    await ceremony.decline();
    expect(state.pendingOffer).toBeNull();
    expect(calls.sign).toHaveLength(0);
  });

  it('acceptance is the signed half: accept() signs op=accept, subject = the OFFERER key', async () => {
    const { deps, calls, state } = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice()), deps);
    const ceremony = (await AcceptorCeremony.open(deps)) as AcceptorCeremony;
    await ceremony.accept();
    expect(calls.sign).toEqual([
      {
        op: 'accept',
        tuple: {
          groupId: GROUP,
          offererUserId: OTHER,
          acceptorUserId: SELF,
          subjectIdentityPubKey: `IDKEY+${OTHER.slice(-4)}`,
          class: 'phone',
          rosterEpoch: 0,
          offerNonce: NONCE,
          expiresAt: EXPIRES,
        },
      },
    ]);
    expect(calls.accept).toEqual([
      {
        nonce: NONCE,
        sig: fakeSig('accept', {
          groupId: GROUP,
          offererUserId: OTHER,
          acceptorUserId: SELF,
          subjectIdentityPubKey: rawKey(OTHER),
          class: 'phone',
          rosterEpoch: 0,
          offerNonce: NONCE,
          expiresAt: EXPIRES,
        }),
      },
    ]);
    expect(state.group?.groupId).toBe(GROUP);
    // The joiner records ITSELF too: both sides render the same
    // two-member roster, "This device" included.
    expect(
      state.devices.some(d => d.userId === SELF && d.state === 'linked' && d.class === 'phone'),
    ).toBe(true);
  });

  it('an expired offer never reaches a screen, and a lived-in device never sees the ceremony', async () => {
    const expired = fakeDeps();
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame(offerNotice({ expiresAt: Math.floor(NOW_MS / 1000) - 1 })),
        expired.deps,
      ),
    ).toBe('dropped');
    expect(expired.state.pendingOffer).toBeNull();

    // client half: pristine or nothing.
    const livedIn = fakeDeps();
    livedIn.state.pristine = false;
    expect(await handleAccountsNoticeFrame(noticeFrame(offerNotice()), livedIn.deps)).toBe(
      'dropped',
    );
    expect(livedIn.state.pendingOffer).toBeNull();

    // …and a stored offer on a device that STOPPED being pristine refuses at
    // open time with the named refusal, not a confirm surface.
    const raced = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice()), raced.deps);
    raced.state.pristine = false;
    expect(await AcceptorCeremony.open(raced.deps)).toBe('not_pristine');
  });

  it('the history sentence is byte-pinned into the link-time copy', () => {
    expect(LINKING_COPY.historyStance).toBe('This device shows messages from today forward.');
  });

  it('the join-existing-account copy (2026-10-08 follow-up) names the live doors and breaks no census', () => {
    // The unlinked second device's guidance (the Email and handle screens'
    // needs-verification states): every sentence passes the censuses the
    // deck already lives under, and the doors it names are the live labels.
    const all = [
      LINKING_COPY.joinExistingAccount,
      LINKING_COPY.joinExistingAccountLivedIn,
      LINKING_COPY.joinExistingAccountInfoLabel,
      ...LINKING_COPY.joinExistingAccountInfo,
      LINKING_COPY.joinExistingAccountStartOver,
    ];
    expect(LINKING_COPY.joinExistingAccountInfo.length).toBeGreaterThanOrEqual(4);
    expect(new Set(all).size).toBe(all.length);
    for (const s of all) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
      // The Android drift net: no bare device noun outside the token —
      // "device" and "phone number" are the words allowed.
      expect(s).not.toMatch(/iphone|ipad|tablet/i);
      expect(s.replace(/phone (number|call)s?/gi, '')).not.toMatch(/\bphone\b/i);
      // The handle class's word census (this deck is not allowlisted).
      expect(s).not.toMatch(/username/i);
      // The Rooms vocabulary: rooms, never chats.
      expect(s).not.toMatch(/\bchats?\b/i);
      // No slot word spelled outside deviceNoun.ts (P3): "one device of
      // each kind", as classMismatch and newDeviceSlot already say.
      expect(s).not.toMatch(/\bslot\b/i);
      // The QR payload is a bare ID: the copy names a QR code and a screen,
      // never a link or a scheme.
      expect(s).not.toMatch(/https?:|tacendum:|deep link/i);
    }
    // The live labels, by literal — a renamed door must fail here.
    const info = LINKING_COPY.joinExistingAccountInfo.join(' ');
    for (const door of [
      'Settings',
      'Account',
      LINKING_COPY.settingsRow,
      'Link a device',
      'Your profile',
      'Show QR code',
    ]) {
      expect(info).toContain(door);
    }
    // The ceremony's order (codeInstruction: the existing device confirms
    // first) and its two preconditions, said where they matter.
    expect(info).toContain('confirm it on the other device first, then here');
    expect(info).toContain('one device of each kind');
    expect(info).toContain('fresh install');
    // The proof pass (2026-10-08): the three sentences added beside them
    // — the offerer's own "Linked.", the link-offer budget's 429 and the
    // roster-change refusal — ride the same census (no idiom noun, no
    // handle-class word, no "chat"), and the offerer's sentence names the
    // NEW device as the one that starts from today, never this one.
    for (const s of [LINKING_COPY.linkedOfferer, LINKING_COPY.rateLimited, LINKING_COPY.rosterRefused]) {
      expect(s).not.toMatch(/iphone|ipad|tablet/i);
      expect(s.replace(/phone (number|call)s?/gi, '')).not.toMatch(/\bphone\b/i);
      expect(s).not.toMatch(/username/i);
      expect(s).not.toMatch(/\bchats?\b/i);
    }
    expect(LINKING_COPY.linkedOfferer).toBe('Linked. The new device shows messages from today forward.');
    expect(LINKING_COPY.linkedOfferer).not.toBe(`Linked. ${LINKING_COPY.historyStance}`);
    expect(LINKING_COPY.rosterRefused).not.toContain('new device');
    expect(LINKING_COPY.joinExistingAccount).toContain('started from the other device');
    expect(LINKING_COPY.joinExistingAccount).not.toMatch(/\bwill join\b/);
    expect(LINKING_COPY.joinExistingAccountLivedIn).toContain('only a fresh install can be linked');
    expect(LINKING_COPY.joinExistingAccountLivedIn).toContain('cannot be verified here as well');
    expect(LINKING_COPY.joinExistingAccountStartOver).toContain('Delete account');
    expect(LINKING_COPY.joinExistingAccountStartOver).toContain('Your profile');
    // The pinned sentences this follow-up reuses by reference are unchanged.
    expect(LINKING_COPY.historyStance).toBe('This device shows messages from today forward.');
    expect(LINKING_COPY.settingsRow).toBe('Linked devices');
  });
});

/* ── 2. the preimage is exactly the specified form ───────────────── */

describe('the op-framed preimage, length-prefixed — variants FAIL the fixture', () => {
  const c = vectors.cases.find(v => v.op === 'offer')!;
  const utf8 = (text: string): number[] => [...text].map(ch => ch.charCodeAt(0));
  const b64bytes = (data: string): number[] => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Map([...alphabet].map((ch, i) => [ch, i] as const));
    const clean = data.replace(/=+$/, '');
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const ch of clean) {
      buffer = (buffer << 6) | lookup.get(ch)!;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buffer >> bits) & 0xff);
      }
    }
    return out;
  };
  const prefixed = (field: number[]): number[] => [
    (field.length >> 8) & 0xff,
    field.length & 0xff,
    ...field,
  ];
  const hex = (bytes: number[]): string =>
    bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
  const fields = () => ({
    op: utf8(c.op),
    groupId: utf8(c.groupId),
    offerer: utf8(c.offererUserId),
    acceptor: utf8(c.acceptorUserId),
    subject: b64bytes(c.subjectIdentityPubKey),
    klass: utf8(c.class),
    epoch: utf8(String(c.rosterEpoch)),
    nonce: utf8(c.offerNonce),
    expires: utf8(String(c.expiresAt)),
  });
  const domain = utf8('tacendum-link-v1');

  it('the shared builder reproduces the pinned bytes exactly', () => {
    const built = linkOpSignedBytes('offer', {
      groupId: c.groupId,
      offererUserId: c.offererUserId,
      acceptorUserId: c.acceptorUserId,
      subjectIdentityPubKey: c.subjectIdentityPubKey,
      class: c.class,
      rosterEpoch: c.rosterEpoch,
      offerNonce: c.offerNonce,
      expiresAt: c.expiresAt,
    });
    expect(hex([...built])).toBe(c.preimageHex);
    // …and the hand assembly here agrees, so the variant encoders below are
    // trustworthy witnesses rather than strawmen.
    const f = fields();
    const assembled = [
      ...domain,
      ...prefixed(f.op),
      ...prefixed(f.groupId),
      ...prefixed(f.offerer),
      ...prefixed(f.acceptor),
      ...prefixed(f.subject),
      ...prefixed(f.klass),
      ...prefixed(f.epoch),
      ...prefixed(f.nonce),
      ...prefixed(f.expires),
    ];
    expect(hex(assembled)).toBe(c.preimageHex);
  });

  it('a REORDERED preimage fails the fixture (acceptor before offerer)', () => {
    const f = fields();
    const reordered = [
      ...domain,
      ...prefixed(f.op),
      ...prefixed(f.groupId),
      ...prefixed(f.acceptor),
      ...prefixed(f.offerer),
      ...prefixed(f.subject),
      ...prefixed(f.klass),
      ...prefixed(f.epoch),
      ...prefixed(f.nonce),
      ...prefixed(f.expires),
    ];
    expect(hex(reordered)).not.toBe(c.preimageHex);
  });

  it('an UNPREFIXED preimage fails the fixture (bare concatenation — the oldest bug there is)', () => {
    const f = fields();
    const unprefixed = [
      ...domain,
      ...f.op,
      ...f.groupId,
      ...f.offerer,
      ...f.acceptor,
      ...f.subject,
      ...f.klass,
      ...f.epoch,
      ...f.nonce,
      ...f.expires,
    ];
    expect(hex(unprefixed)).not.toBe(c.preimageHex);
  });

  it('an OP-STRIPPED preimage fails the fixture (an acceptance must never read as any other op)', () => {
    const f = fields();
    const opStripped = [
      ...domain,
      ...prefixed(f.groupId),
      ...prefixed(f.offerer),
      ...prefixed(f.acceptor),
      ...prefixed(f.subject),
      ...prefixed(f.klass),
      ...prefixed(f.epoch),
      ...prefixed(f.nonce),
      ...prefixed(f.expires),
    ];
    expect(hex(opStripped)).not.toBe(c.preimageHex);
  });

  it('a PUBKEY-STRIPPED preimage fails the fixture (the certificate must name WHICH key)', () => {
    const f = fields();
    const keyStripped = [
      ...domain,
      ...prefixed(f.op),
      ...prefixed(f.groupId),
      ...prefixed(f.offerer),
      ...prefixed(f.acceptor),
      ...prefixed(f.klass),
      ...prefixed(f.epoch),
      ...prefixed(f.nonce),
      ...prefixed(f.expires),
    ];
    expect(hex(keyStripped)).not.toBe(c.preimageHex);
  });
});

/* ── 3. a revoked device disappears from the roster UI ────────────── */

describe('the Linked-devices roster', () => {
  async function renderScreen(): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        React.createElement(LinkedDevicesScreen, {
          profile: {
            userId: SELF,
            registrationId: 7,
            displayName: '',
            about: '',
            avatarB64: '',
            profileVersion: 0,
          },
          onBack: () => undefined,
          onLinkNew: () => undefined,
        }),
      );
    });
    return tree;
  }

  it('a revoked device disappears from the roster UI (memberRevoked notice → row gone)', async () => {
    const { deps, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 2 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: OTHER, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    // The SCREEN reads through the real db module: point its listing at the
    // fake state so the render and the notice handler share one truth.
    const listing = jest
      .spyOn(db, 'listLinkedDevices')
      .mockImplementation(async () => [...state.devices]);
    try {
      const tree = await renderScreen();
      expect(tree.root.findAllByProps({ testID: `linked-device-${OTHER}` })).not.toHaveLength(0);

      await ReactTestRenderer.act(async () => {
        const outcome = await handleAccountsNoticeFrame(
          noticeFrame({
            kind: 'memberRevoked',
            groupId: GROUP,
            userId: OTHER,
            class: 'tablet',
            rosterEpoch: 3,
            ...signedMutationFields('revoke', OTHER, 2),
          }),
          deps,
        );
        expect(outcome).toBe('stored');
      });

      // Gone from the screen…
      expect(tree.root.findAllByProps({ testID: `linked-device-${OTHER}` })).toHaveLength(0);
      // …and from the roster projection, while the history row SURVIVES
      // underneath with its state flipped (the loud device-list record).
      expect((await currentRoster(deps)).map(d => d.userId)).toEqual([SELF]);
      expect(state.devices.find(d => d.userId === OTHER)?.state).toBe('revoked');
      tree.unmount();
    } finally {
      listing.mockRestore();
    }
  });

  it('an unlink mutation signs the FULL tuple over the TARGET key and the roster drops the member', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 4 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    await mutateRoster('unlink', { userId: THIRD, class: 'tablet' }, deps);
    expect(calls.sign).toEqual([
      {
        op: 'unlink',
        tuple: {
          groupId: GROUP,
          offererUserId: SELF,
          acceptorUserId: THIRD,
          subjectIdentityPubKey: `IDKEY+${THIRD.slice(-4)}`,
          class: 'tablet',
          rosterEpoch: 4,
          offerNonce: NONCE,
          expiresAt: Math.floor(NOW_MS / 1000) + 300,
        },
      },
    ]);
    expect(calls.mutation).toHaveLength(1);
    expect(calls.mutation[0]!.op).toBe('unlink');
    expect((await currentRoster(deps)).map(d => d.userId)).toEqual([SELF]);
  });
});

/* ── 4. fail-closed ceremony refusals ──────────────── */

describe('fail-closed ceremony refusals', () => {
  it('no verification code ⇒ no offerer ceremony — a blank code must never reach a confirm button', async () => {
    const { deps, calls } = fakeDeps();
    const noCode: LinkingDeps = {
      ...deps,
      crypto: { ...deps.crypto, safetyNumber: async () => null },
    };
    await expect(OffererCeremony.begin(OTHER, noCode)).rejects.toBeInstanceOf(
      NoVerificationCodeError,
    );
    expect(calls.init).toHaveLength(0);
    expect(calls.sign).toHaveLength(0);
  });

  it('no verification code ⇒ no acceptor ceremony, and the offer row survives the transient', async () => {
    const { deps, calls, state } = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice()), deps);
    const noCode: LinkingDeps = {
      ...deps,
      crypto: { ...deps.crypto, safetyNumber: async () => null },
    };
    await expect(AcceptorCeremony.open(noCode)).rejects.toBeInstanceOf(NoVerificationCodeError);
    expect(state.pendingOffer).not.toBeNull();
    expect(calls.sign).toHaveLength(0);
  });

  it('a bundle naming the wrong account is refused on BOTH sides — the pinned key and the signed subject must be one device', async () => {
    const offerer = fakeDeps();
    const lying: LinkingDeps = {
      ...offerer.deps,
      api: { ...offerer.deps.api, getPrekeyBundle: async () => bundleFor(THIRD) },
    };
    await expect(OffererCeremony.begin(OTHER, lying)).rejects.toThrow(
      'prekey bundle names the wrong account',
    );
    expect(offerer.calls.sign).toHaveLength(0);

    const acceptor = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice()), acceptor.deps);
    const lying2: LinkingDeps = {
      ...acceptor.deps,
      api: { ...acceptor.deps.api, getPrekeyBundle: async () => bundleFor(THIRD) },
    };
    await expect(AcceptorCeremony.open(lying2)).rejects.toThrow(
      'prekey bundle names the wrong account',
    );
    expect(acceptor.calls.sign).toHaveLength(0);
  });

  it('an offer naming a class this device is not answers class_mismatch — B never signs a falsehood about itself', async () => {
    const { deps, calls } = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice({ acceptorClass: 'tablet' })), deps);
    expect(await AcceptorCeremony.open(deps)).toBe('class_mismatch');
    expect(calls.sign).toHaveLength(0);
  });

  it('a stale late offer never masks a live earlier one: dead rows are reaped and the next tried', async () => {
    const { deps } = fakeDeps();
    const rows = [
      {
        offerNonce: 'NONCE-EXPIRED',
        noticeJson: JSON.stringify(
          offerNotice({ offerNonce: 'NONCE-EXPIRED', expiresAt: Math.floor(NOW_MS / 1000) - 1 }),
        ),
        receivedAt: NOW_MS,
      },
      { offerNonce: NONCE, noticeJson: JSON.stringify(offerNotice()), receivedAt: NOW_MS - 1000 },
    ];
    const layered: LinkingDeps = {
      ...deps,
      db: {
        ...deps.db,
        loadPendingLinkOffer: async () => rows[0] ?? null,
        deletePendingLinkOffer: async nonce => {
          const i = rows.findIndex(r => r.offerNonce === nonce);
          if (i >= 0) rows.splice(i, 1);
        },
      },
    };
    const opened = await AcceptorCeremony.open(layered);
    expect(opened).toBeInstanceOf(AcceptorCeremony);
    expect((opened as AcceptorCeremony).offer.offerNonce).toBe(NONCE);
    expect(rows).toHaveLength(1); // the expired row was reaped, the live one shown
  });
});

describe('a pending offer waiting to be shown (the home-surface re-read)', () => {
  it('answers true for a live offer, without a bundle fetch or a pin', async () => {
    const { deps, calls, state } = fakeDeps();
    state.pendingOffer = {
      offerNonce: NONCE,
      noticeJson: JSON.stringify(offerNotice()),
      receivedAt: NOW_MS,
    };
    expect(await pendingOfferWaiting(deps)).toBe(true);
    expect(calls.bundles).toHaveLength(0); // a probe, not the ceremony
    expect(state.pendingOffer).not.toBeNull();
  });

  it('answers false when nothing waits, and reaps an expired row on the way', async () => {
    const { deps, state } = fakeDeps();
    expect(await pendingOfferWaiting(deps)).toBe(false);
    state.pendingOffer = {
      offerNonce: NONCE,
      noticeJson: JSON.stringify(
        offerNotice({ expiresAt: Math.floor(NOW_MS / 1000) - 1 }),
      ),
      receivedAt: NOW_MS,
    };
    expect(await pendingOfferWaiting(deps)).toBe(false);
    expect(state.pendingOffer).toBeNull(); // dead weight, reaped
  });
});

/* ── 5. unsigned-notice hardening ──────────────────── */

describe('unsigned-notice hardening: epoch monotonicity, no resurrection', () => {
  it('a replayed memberLinked behind local truth is dropped, and a revoked device NEVER reappears', async () => {
    const { deps, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 4 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: OTHER, class: 'tablet', state: 'revoked', updatedAt: NOW_MS, certsJson: '' },
    ];
    // The memberLinked that arrived before the revoke, redelivered after it
    // (ack-after-handle makes redelivery routine) — VALIDLY SIGNED, so what
    // drops it is the replay guard, not the signature:
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberLinked',
          groupId: GROUP,
          userId: OTHER,
          class: 'tablet',
          rosterEpoch: 3,
          ...linkedNoticeCerts(OTHER, 2),
        }),
        deps,
      ),
    ).toBe('dropped');
    expect(state.devices.find(d => d.userId === OTHER)?.state).toBe('revoked');
    // Even a NEWER, validly-signed memberLinked cannot resurrect a revoked
    // ULID — its key is tombstoned, so no honest notice can re-link it:
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberLinked',
          groupId: GROUP,
          userId: OTHER,
          class: 'tablet',
          rosterEpoch: 9,
          ...linkedNoticeCerts(OTHER, 8),
        }),
        deps,
      ),
    ).toBe('dropped');
    expect((await currentRoster(deps)).map(d => d.userId)).toEqual([SELF]);
  });

  it('a stale self-named memberUnlinked cannot wipe local group state — even wearing an INFLATED outer epoch', async () => {
    const { deps, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 5 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    // A VALIDLY SIGNED old self-unlink (signed at epoch 3 — behind local
    // truth 5) replayed with the unsigned outer epoch inflated to 99: the
    // guard keys on the SIGNED epoch, so the
    // outer number is powerless and the destructive wipe stays unreachable.
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberUnlinked',
          groupId: GROUP,
          userId: SELF,
          class: 'phone',
          rosterEpoch: 99,
          ...signedMutationFields('unlink', SELF, 3, 'phone'),
        }),
        deps,
      ),
    ).toBe('dropped');
    expect(state.group).not.toBeNull();
    expect(state.devices).toHaveLength(1);
  });

  it('an UNSIGNED or FORGED member* notice drops even when its epoch is ahead — server word alone moves nothing', async () => {
    const { deps, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 2 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: OTHER, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    // The unsigned wire shape (no signature fields at all) fails the schema:
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({ kind: 'memberRevoked', groupId: GROUP, userId: OTHER, class: 'tablet', rosterEpoch: 9 }),
        deps,
      ),
    ).toBe('dropped');
    // A present-but-forged signature fails the verify:
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberRevoked',
          groupId: GROUP,
          userId: OTHER,
          class: 'tablet',
          rosterEpoch: 9,
          ...signedMutationFields('revoke', OTHER, 8),
          signature: 'Rk9SR0VE',
        }),
        deps,
      ),
    ).toBe('dropped');
    // …and a forged memberLinked certificate admits nothing:
    const forged = linkedNoticeCerts(THIRD, 2);
    forged.certs.offerSig = 'Rk9SR0VE';
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberLinked',
          groupId: GROUP,
          userId: THIRD,
          class: 'tablet',
          rosterEpoch: 3,
          ...forged,
        }),
        deps,
      ),
    ).toBe('dropped');
    expect(state.devices.find(d => d.userId === OTHER)?.state).toBe('linked');
    expect(state.devices.some(d => d.userId === THIRD)).toBe(false);
    expect(state.group?.rosterEpoch).toBe(2);
  });

  it('a validly signed memberLinked ADMITS the member, key and certs recorded', async () => {
    const { deps, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 2 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberLinked',
          groupId: GROUP,
          userId: THIRD,
          class: 'tablet',
          rosterEpoch: 3,
          ...linkedNoticeCerts(THIRD, 2),
        }),
        deps,
      ),
    ).toBe('stored');
    const row = state.devices.find(d => d.userId === THIRD);
    expect(row?.state).toBe('linked');
    expect(row?.identityKeyPub).toBe(keyFor(THIRD));
    expect(row?.certsJson).toContain(linkedNoticeCerts(THIRD, 2).certs.offerSig);
    expect(state.group?.rosterEpoch).toBe(3);
  });

  it('outer fields cannot re-wrap a signed certificate — class, group, and EPOCH all bind', async () => {
    const { deps, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 4 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: OTHER, class: 'tablet', state: 'unlinked', updatedAt: NOW_MS, certsJson: '' },
    ];
    // A VALID old certificate (signed at epoch 0 — the original link)
    // re-wrapped with an INFLATED outer epoch to slide past a naive outer
    // guard and re-link the amicably-unlinked member: the guard keys on
    // the SIGNED epoch (0 + 1 < 4), so the wrap is dead weight.
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberLinked',
          groupId: GROUP,
          userId: OTHER,
          class: 'tablet',
          rosterEpoch: 9,
          ...linkedNoticeCerts(OTHER, 0),
        }),
        deps,
      ),
    ).toBe('dropped');
    expect(state.devices.find(d => d.userId === OTHER)?.state).toBe('unlinked');
    expect(state.group?.rosterEpoch).toBe(4);
    // A fresh certificate re-wrapped with a DIFFERENT outer class: the
    // outer/inner binding drops it before any verify.
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'memberLinked',
          groupId: GROUP,
          userId: THIRD,
          class: 'phone',
          rosterEpoch: 5,
          ...linkedNoticeCerts(THIRD, 4),
        }),
        deps,
      ),
    ).toBe('dropped');
    expect(state.devices.some(d => d.userId === THIRD)).toBe(false);
  });
});

/* ── 6. roster-mutation hardening ──────────────────── */

describe('roster mutations: staleness recovery + the revoked completion signal', () => {
  it('a stale local epoch re-syncs from the served rosterVersion — one dropped notice cannot wedge revoke', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 1 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    const fresher: LinkingDeps = {
      ...deps,
      api: {
        ...deps.api,
        getPrekeyBundle: async (_t, userId) => ({ ...bundleFor(userId), rosterVersion: 6 }),
      },
    };
    await mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, fresher);
    expect(calls.sign[0]!.tuple.rosterEpoch).toBe(6);
    expect((calls.mutation[0]!.body as { rosterEpoch: number }).rosterEpoch).toBe(6);
    expect(state.group?.rosterEpoch).toBe(7);
  });

  it('a 404 recipient_revoked is the COMPLETION signal: local truth follows the committed removal instead of wedging', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 3 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    const tombstoned: LinkingDeps = {
      ...deps,
      api: {
        ...deps.api,
        getPrekeyBundle: async () => {
          throw Object.assign(new Error('recipient_revoked'), { code: 'recipient_revoked' });
        },
      },
    };
    await mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, tombstoned);
    expect(calls.sign).toHaveLength(0); // nothing to sign — the removal already committed
    expect(calls.mutation).toHaveLength(0);
    expect(state.devices.find(d => d.userId === THIRD)?.state).toBe('revoked');
    expect((await currentRoster(deps)).map(d => d.userId)).toEqual([SELF]);
  });
});

/* ── 7. the offerer's durable record ───────────────── */

describe("the offerer's durable pending record: the link survives the screen", () => {
  /** The tuple completion rebuilds FROM ITS OWN PENDING RECORD: group, nonce, epoch, class, expiry all from the
   * ceremony this device ran — subject = its own key, signer = the
   * ceremony-pinned joiner key. */
  const COMPLETION_TUPLE = {
    groupId: GROUP,
    offererUserId: SELF,
    acceptorUserId: OTHER,
    subjectIdentityPubKey: rawKey(SELF),
    class: 'tablet' as const,
    rosterEpoch: 0,
    offerNonce: NONCE,
    expiresAt: EXPIRES,
  };
  const CEREMONY_CERTS = {
    // Genuine under the fake scheme: completion now VERIFIES the acceptance
    // certificate before declaring linked — a server
    // asserting membership without a real acceptance completes nothing.
    offerSig: fakeSig('offer', { ...COMPLETION_TUPLE, subjectIdentityPubKey: rawKey(OTHER) }),
    acceptSig: fakeSig('accept', COMPLETION_TUPLE),
    groupId: GROUP,
    offererUserId: SELF,
    acceptorUserId: OTHER,
    class: 'tablet' as const,
    rosterEpoch: 0,
    offerNonce: NONCE,
    expiresAt: EXPIRES,
  };

  it('a committed acceptance reconciles after the scan screen is gone — no false "alone" state, no wedged verbs', async () => {
    const { deps, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    expect(state.pendingCeremony).not.toBeNull();
    // The ceremony object is dropped (screen unmounted); B accepts:
    state.bundleSiblings.set(OTHER, [{ userId: SELF, class: 'phone', certs: CEREMONY_CERTS }]);
    expect(await reconcilePendingLink(deps)).toBe(true);
    expect(state.group?.groupId).toBe(GROUP);
    expect((await currentRoster(deps)).map(d => d.userId).sort()).toEqual(
      [SELF, OTHER].sort(),
    );
    expect(state.pendingCeremony).toBeNull(); // consumed
  });

  it('"Stop waiting" halts the probe from this object but KEEPS the row — the only path to a late acceptance', async () => {
    const { deps, calls, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    expect(state.pendingCeremony).not.toBeNull();
    expect(ceremony.expiresAt).toBe(EXPIRES);
    const fetched = calls.bundles.length;

    ceremony.cancel();
    expect(ceremony.phase).toBe('cancelled');
    // A stopped screen spends no more of the joiner's prekeys…
    expect(await ceremony.checkLinked()).toBe(false);
    expect(calls.bundles.length).toBe(fetched);
    // …and the durable record stays: the server has no withdrawal route, the
    // offerer is excluded from the memberLinked fan-out, so deleting this row
    // would let the new device join with this one none the wiser.
    expect(state.pendingCeremony).not.toBeNull();
  });

  it('an expired pending record reaps instead of probing — no prekey spent on a dead offer', async () => {
    const { deps, calls, state } = fakeDeps();
    state.pendingCeremony = {
      offerJson: JSON.stringify({
        groupId: GROUP,
        rosterEpoch: 0,
        offerNonce: NONCE,
        expiresAt: Math.floor(NOW_MS / 1000) - 1,
        acceptorUserId: OTHER,
        acceptorClass: 'tablet',
        acceptorIdentityKey: rawKey(OTHER),
      }),
      createdAt: NOW_MS - 1000,
    };
    expect(await reconcilePendingLink(deps)).toBe(false);
    expect(state.pendingCeremony).toBeNull();
    expect(calls.bundles).toHaveLength(0);
  });

  it('the completion-probe pacing stays inside the pinned per-target prekey budget (30/day)', () => {
    // Every probe consumes one of the JOINER's one-time prekeys, so the
    // worst case over the full offer TTL is the number that must fit the
    // pinned budget — the arithmetic the screen's header states.
    const steppedMs = LINK_POLL_STEPS_MS.reduce((a: number, b: number) => a + b, 0);
    const tailProbes = Math.floor(
      (LINK_OFFER_TTL_SECONDS * 1000 - steppedMs) / LINK_POLL_TAIL_MS,
    );
    const worstCase = LINK_POLL_STEPS_MS.length + tailProbes;
    expect(worstCase).toBe(12);
    expect(worstCase).toBeLessThanOrEqual(30);
  });

  it('a server asserting membership WITHOUT a verifying acceptance certificate completes nothing', async () => {
    const { deps, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    state.bundleSiblings.set(OTHER, [
      { userId: SELF, class: 'phone', certs: { ...CEREMONY_CERTS, acceptSig: 'Rk9SR0VE' } },
    ]);
    expect(await reconcilePendingLink(deps)).toBe(false);
    expect(state.group).toBeNull();
    expect(state.pendingCeremony).not.toBeNull(); // the probe keeps stalling
  });

  it('a certificate from a DIFFERENT ceremony completes nothing — the tuple binds to the PENDING record', async () => {
    const { deps, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    // A signature that IS valid — over some other ceremony's nonce — served
    // inside this ceremony's completion probe: completion rebuilds the
    // tuple from its OWN pending row (group, nonce, epoch, class, expiry),
    // so the foreign acceptance verifies against nothing here.
    const foreign = fakeSig('accept', { ...COMPLETION_TUPLE, offerNonce: 'SOME-OTHER-NONCE' });
    state.bundleSiblings.set(OTHER, [
      { userId: SELF, class: 'phone', certs: { ...CEREMONY_CERTS, acceptSig: foreign } },
    ]);
    expect(await reconcilePendingLink(deps)).toBe(false);
    expect(state.group).toBeNull();
  });

  it('completion links EXACTLY the two ceremony parties — a server-injected extra sibling is not blanket-linked', async () => {
    const { deps, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    state.bundleSiblings.set(OTHER, [
      { userId: SELF, class: 'phone', certs: CEREMONY_CERTS },
      // The injected row a compelled server would love to make a
      // sibling-sync recipient:
      { userId: THIRD, class: 'tablet', certs: CEREMONY_CERTS },
    ]);
    expect(await reconcilePendingLink(deps)).toBe(true);
    expect((await currentRoster(deps)).map(d => d.userId).sort()).toEqual(
      [SELF, OTHER].sort(),
    );
    expect(state.devices.some(d => d.userId === THIRD)).toBe(false);
  });
});

/* ── 8. client-verified offers + the persisted re-drive ──────── */

describe('the offerSig is client-verified truth', () => {
  it('the anchor forgery — ASCII "OFFERSIG" — is reaped at open, nothing shown, nothing signed', async () => {
    const { deps, calls, state } = fakeDeps();
    await handleAccountsNoticeFrame(
      noticeFrame(offerNotice({ offerSig: 'T0ZGRVJTSUc=' })),
      deps,
    );
    expect(state.pendingOffer).not.toBeNull();
    expect(await AcceptorCeremony.open(deps)).toBeNull();
    expect(state.pendingOffer).toBeNull(); // forged row reaped
    expect(calls.sign).toHaveLength(0);
    expect(calls.accept).toHaveLength(0);
    // The verify ran against the OFFERER's served key with op=offer.
    expect(calls.verify.some(v => v.op === 'offer' && v.key === `IDKEY+${OTHER.slice(-4)}`)).toBe(
      true,
    );
  });

  it('a genuine offerSig opens the ceremony exactly as before', async () => {
    const { deps } = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice()), deps);
    expect(await AcceptorCeremony.open(deps)).toBeInstanceOf(AcceptorCeremony);
  });
});

describe('the persisted signed mutation re-drive', () => {
  it('the signed request is persisted BEFORE the call and re-driven BYTE-IDENTICAL after a crash', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 3 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    // The crash window: the server call throws AFTER the row is persisted
    // (commit-then-crash is indistinguishable to the client).
    const crashing: LinkingDeps = {
      ...deps,
      api: {
        ...deps.api,
        rosterMutation: async () => {
          throw new Error('socket died');
        },
      },
    };
    await expect(
      mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, crashing),
    ).rejects.toThrow('socket died');
    const stored = [...state.pendingMutations.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.op).toBe('revoke');
    const storedBody = JSON.parse(stored[0]!.bodyJson) as Record<string, unknown>;
    expect(storedBody.signature).toBe(
      fakeSig('revoke', {
        groupId: GROUP,
        offererUserId: SELF,
        acceptorUserId: THIRD,
        subjectIdentityPubKey: rawKey(THIRD),
        class: 'tablet',
        rosterEpoch: 3,
        offerNonce: NONCE,
        expiresAt: Math.floor(NOW_MS / 1000) + 300,
      }),
    );

    // The re-drive sends the SAME signed bytes — never rebuilt, never
    // re-signed — and completes the local record on success.
    await redrivePendingMutations(deps);
    expect(calls.sign).toHaveLength(1); // no second signature EVER
    expect(calls.mutation).toHaveLength(1);
    expect(calls.mutation[0]!.body).toEqual(storedBody);
    expect(state.pendingMutations.size).toBe(0);
    expect(state.devices.find(d => d.userId === THIRD)?.state).toBe('revoked');
  });

  it('an expired stored mutation reaps without a wire call; recipient_revoked completes locally', async () => {
    const { deps, calls, state } = fakeDeps();
    state.devices = [
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    state.pendingMutations.set('EXPIRED', {
      offerNonce: 'EXPIRED',
      op: 'revoke',
      bodyJson: JSON.stringify({ targetUserId: THIRD }),
      createdAt: NOW_MS - 1000,
      expiresAt: Math.floor(NOW_MS / 1000) - 1,
    });
    await redrivePendingMutations(deps);
    expect(calls.mutation).toHaveLength(0);
    expect(state.pendingMutations.size).toBe(0);

    state.pendingMutations.set(NONCE, {
      offerNonce: NONCE,
      op: 'revoke',
      bodyJson: JSON.stringify({ targetUserId: THIRD }),
      createdAt: NOW_MS,
      expiresAt: EXPIRES,
    });
    const tombstoned: LinkingDeps = {
      ...deps,
      api: {
        ...deps.api,
        rosterMutation: async () => {
          throw Object.assign(new Error('recipient_revoked'), { code: 'recipient_revoked' });
        },
      },
    };
    await redrivePendingMutations(tombstoned);
    expect(state.pendingMutations.size).toBe(0);
    expect(state.devices.find(d => d.userId === THIRD)?.state).toBe('revoked');
  });

  it('a revoke names the victim device’s synced machine peers as boundAgents', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 3 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    const AGENT = '01HQDDDD00000000000000000D';
    state.siblingAgents.set(THIRD, [AGENT]);
    await mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, deps);
    expect((calls.mutation[0]!.body as { boundAgents?: string[] }).boundAgents).toEqual([AGENT]);
    // …and an amicable unlink NEVER names agents (the binding rides with
    // the departing device).
    state.group = { groupId: GROUP, rosterEpoch: 4 };
    state.devices = state.devices.map(d =>
      d.userId === THIRD ? { ...d, state: 'linked' as const } : d,
    );
    await mutateRoster('unlink', { userId: THIRD, class: 'tablet' }, deps);
    expect(
      (calls.mutation[1]!.body as { boundAgents?: string[] }).boundAgents,
    ).toBeUndefined();
  });

  it('a stale synced agent cannot wedge the kill switch — a refused revoke retries once WITHOUT agents', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 3 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    const AGENT = '01HQDDDD00000000000000000D';
    state.siblingAgents.set(THIRD, [AGENT]);
    const refusingAgents: LinkingDeps = {
      ...deps,
      api: {
        ...deps.api,
        rosterMutation: async (_t, op, body) => {
          calls.mutation.push({ op, body });
          if ((body as { boundAgents?: string[] }).boundAgents !== undefined) {
            throw Object.assign(new Error('refused'), { status: 403 });
          }
        },
      },
    };
    await mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, refusingAgents);
    expect(calls.mutation).toHaveLength(2);
    expect((calls.mutation[0]!.body as { boundAgents?: string[] }).boundAgents).toEqual([AGENT]);
    expect((calls.mutation[1]!.body as { boundAgents?: string[] }).boundAgents).toBeUndefined();
    // Same signed tuple both times — never re-signed for the retry.
    expect(calls.sign).toHaveLength(1);
    expect(state.devices.find(d => d.userId === THIRD)?.state).toBe('revoked');
  });
});

/* ── 9. the signed peer-notice feed ─────── */

describe('a committed mutation feeds the peer-facing notice fan-out', () => {
  it('mutateRoster emits the EXACT signed tuple + signature it sent', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 3 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    const heard: unknown[] = [];
    const unsubscribe = onPeerRosterNotice(notice => {
      heard.push(notice);
    });
    try {
      await mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, deps);
    } finally {
      unsubscribe();
    }
    expect(heard).toEqual([
      {
        op: 'revoke',
        tuple: calls.sign[0]!.tuple,
        signature: (calls.mutation[0]!.body as { signature: string }).signature,
      },
    ]);
  });

  it('a REFUSED mutation emits nothing — peers only ever hear committed truth', async () => {
    const { deps, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 3 };
    state.devices = [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ];
    const refusing: LinkingDeps = {
      ...deps,
      api: {
        ...deps.api,
        rosterMutation: async () => {
          throw Object.assign(new Error('refused'), { status: 403 });
        },
      },
    };
    const heard: unknown[] = [];
    const unsubscribe = onPeerRosterNotice(notice => {
      heard.push(notice);
    });
    try {
      await expect(
        mutateRoster('unlink', { userId: THIRD, class: 'tablet' }, refusing),
      ).rejects.toThrow();
    } finally {
      unsubscribe();
    }
    expect(heard).toEqual([]);
  });
});

/* ── 10. the acceptor's own-bundle loop ──── */

describe('the acceptor links exactly the ceremony counterpart', () => {
  it('a server-injected extra sibling in the own bundle is not blanket-linked', async () => {
    const { deps, state } = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice()), deps);
    const ceremony = (await AcceptorCeremony.open(deps)) as AcceptorCeremony;
    state.bundleSiblings.set(SELF, [
      {
        userId: OTHER,
        class: 'tablet',
        certs: linkedNoticeCerts(OTHER, 0).certs,
      },
      {
        userId: THIRD,
        class: 'tablet',
        certs: linkedNoticeCerts(THIRD, 0).certs,
      },
    ]);
    await ceremony.accept();
    expect((await currentRoster(deps)).map(d => d.userId).sort()).toEqual(
      [SELF, OTHER].sort(),
    );
    expect(state.devices.some(d => d.userId === THIRD)).toBe(false);
    // The offerer's row carries the CEREMONY-pinned key, not a served one.
    expect(state.devices.find(d => d.userId === OTHER)?.identityKeyPub).toBe(rawKey(OTHER));
  });
});

/* ── 11. the join branch (fix/username-discovery, 2026-10-08 — S2) ─── */

/**
 * S2, the client half. Two facts about the server the ceremony never
 * accounted for:
 *
 *  (a) a device that verified an email BEFORE its first link is grouped
 *      server-side — the attach lazily minted a solo group (§3) — while it
 *      holds no local group row: the verify answer is `{}` and a bundle
 *      carries no groupId. Its next offer therefore declared an
 *      offererClass, which is the one thing linkOfferInit refuses from a
 *      grouped offerer. The ceremony now asks its OWN bundle first (the
 *      keys route serves rosterVersion exactly when the caller is grouped)
 *      and records the group the server names at init.
 *  (b) the server's JOIN branch appends only the joiner's entry: the
 *      offerer's own entry stays certless (an attach-created founder) or
 *      keeps an EARLIER ceremony's certs (a re-link after an unlink), and
 *      the joiner's own entry — the one carrying THIS ceremony's certs —
 *      is filtered out of the joiner's bundle. Completion now ALSO reads
 *      the joiner's entry of the offerer's OWN bundle, verified EXACTLY as
 *      before: the ceremony-pinned joiner key, op=accept, the tuple from
 *      this device's own pending record. Only the bytes' location differs.
 */
describe('S2: the join branch — an attach-created founder links, and the offerer completes a join', () => {
  const JOIN_EPOCH = 1;
  /** The completion tuple of a JOIN: the server's init named the group's
   * current epoch (1 for an attach-created solo group); everything else is
   * this device's own pending record, subject = its own key. */
  const JOIN_TUPLE = {
    groupId: GROUP,
    offererUserId: SELF,
    acceptorUserId: OTHER,
    subjectIdentityPubKey: rawKey(SELF),
    class: 'tablet' as const,
    rosterEpoch: JOIN_EPOCH,
    offerNonce: NONCE,
    expiresAt: EXPIRES,
  };
  const JOIN_CERTS = {
    offerSig: fakeSig('offer', { ...JOIN_TUPLE, subjectIdentityPubKey: rawKey(OTHER) }),
    acceptSig: fakeSig('accept', JOIN_TUPLE),
    groupId: GROUP,
    offererUserId: SELF,
    acceptorUserId: OTHER,
    class: 'tablet' as const,
    rosterEpoch: JOIN_EPOCH,
    offerNonce: NONCE,
    expiresAt: EXPIRES,
  };

  /** A device grouped SERVER-SIDE with no local group row (it verified an
   * email, which minted a solo group): its own bundle serves rosterVersion
   * — the only wire that says so — and init answers the group's epoch. */
  function attachCreatedFounder() {
    const made = fakeDeps();
    made.state.bundleSiblings.set(SELF, []); // grouped (rosterVersion served), alone
    made.deps.api.linkOfferInit = async (_t, body) => {
      made.calls.init.push(body);
      return { groupId: GROUP, rosterEpoch: JOIN_EPOCH, offerNonce: NONCE, expiresAt: EXPIRES };
    };
    return made;
  }

  /** The join as the server serves it after the acceptance commits: this
   * device's entry on the JOINER's bundle is certless (the join branch
   * appends only the joiner's entry); the joiner's entry on this device's
   * OWN bundle carries the ceremony's certs. */
  function serveCommittedJoin(state: FakeState, joinerEntryCerts = JOIN_CERTS) {
    state.bundleSiblings.set(OTHER, [{ userId: SELF, class: 'phone' }]);
    state.bundleSiblings.set(SELF, [{ userId: OTHER, class: 'tablet', certs: joinerEntryCerts }]);
  }

  it('(a) an attach-created founder declares NO offererClass: the own bundle says grouped, init names the group', async () => {
    const { deps, calls, state } = attachCreatedFounder();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    expect(calls.bundles).toEqual([OTHER]);
    await ceremony.confirm('tablet');
    // ONE own-bundle probe, before init, and the class is NOT declared.
    expect(calls.bundles).toEqual([OTHER, SELF]);
    expect(calls.init).toEqual([{ acceptorUserId: OTHER, acceptorClass: 'tablet' }]);
    // The offer signs the epoch the server named for the join.
    expect(calls.sign).toEqual([
      {
        op: 'offer',
        tuple: {
          groupId: GROUP,
          offererUserId: SELF,
          acceptorUserId: OTHER,
          subjectIdentityPubKey: rawKey(OTHER),
          class: 'tablet',
          rosterEpoch: JOIN_EPOCH,
          offerNonce: NONCE,
          expiresAt: EXPIRES,
        },
      },
    ]);
    // RE-CUT 2026-10-08 (the gate pass): NO group row before the acceptance
    // — the server-named id becomes local truth only when the acceptance is
    // verified (completeOffererLink). The earlier pin recorded it at init;
    // that row outlived an abandoned ceremony, and once the solo group
    // dissolved it made every later link classless and refused, the
    // downgrade's dissolve fail on every retry, and recovery notices for the
    // re-attached group implausible (the abandoned-init case below).
    expect(state.group).toBeNull();
    expect(ceremony.phase).toBe('waiting');
    expect(state.pendingCeremony).not.toBeNull();
  });

  it('(a) a truly solo device still declares its own class — and records no group before the acceptance', async () => {
    const { deps, calls, state } = fakeDeps();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    expect(calls.bundles).toEqual([OTHER, SELF]); // the probe: no rosterVersion served
    expect(calls.init).toEqual([
      { acceptorUserId: OTHER, acceptorClass: 'tablet', offererClass: 'phone' },
    ]);
    expect(state.group).toBeNull();
  });

  it('(a) a device holding a local group row probes nothing — the row is the answer', async () => {
    const { deps, calls, state } = fakeDeps();
    state.group = { groupId: GROUP, rosterEpoch: 3 };
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    expect(calls.bundles).toEqual([OTHER]);
    expect(calls.init).toEqual([{ acceptorUserId: OTHER, acceptorClass: 'tablet' }]);
    expect(state.group).toEqual({ groupId: GROUP, rosterEpoch: 3 });
  });

  it('(b) the offerer completes a join when only the JOINER\'s entry carries the certs — verified under the pinned key, over the pending tuple', async () => {
    const { deps, calls, state } = attachCreatedFounder();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    // Before the acceptance the joiner's bundle names no sibling: the probe
    // stalls as ever and spends NONE of this device's own prekeys.
    const before = calls.bundles.length;
    expect(await ceremony.checkLinked()).toBe(false);
    expect(calls.bundles.slice(before)).toEqual([OTHER]);
    expect(calls.verify).toEqual([]);

    serveCommittedJoin(state);
    const probe = calls.bundles.length;
    expect(await ceremony.checkLinked()).toBe(true);
    expect(ceremony.phase).toBe('linked');
    // The joiner's bundle first (its served key must still be the pinned
    // one), then — only because the join committed — this device's own.
    expect(calls.bundles.slice(probe)).toEqual([OTHER, SELF]);
    // EXACTLY the original verification: signer = the ceremony-pinned
    // joiner key, op = accept, the signature found on the joiner's entry.
    expect(calls.verify).toEqual([{ key: rawKey(OTHER), op: 'accept', sig: JOIN_CERTS.acceptSig }]);
    expect(state.group).toEqual({ groupId: GROUP, rosterEpoch: 1 });
    expect((await currentRoster(deps)).map(d => d.userId).sort()).toEqual([SELF, OTHER].sort());
    for (const row of state.devices) expect(JSON.parse(row.certsJson)).toEqual(JOIN_CERTS);
    expect(state.devices.find(d => d.userId === OTHER)?.identityKeyPub).toBe(rawKey(OTHER));
    expect(state.devices.find(d => d.userId === SELF)?.identityKeyPub).toBe(rawKey(SELF));
    expect(state.pendingCeremony).toBeNull(); // consumed
  });

  it('(b) the unmounted path completes the same join: reconcilePendingLink shares the probe', async () => {
    const { deps, state } = attachCreatedFounder();
    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    serveCommittedJoin(state);
    expect(await reconcilePendingLink(deps)).toBe(true);
    expect(state.group?.groupId).toBe(GROUP);
    expect((await currentRoster(deps)).map(d => d.userId).sort()).toEqual([SELF, OTHER].sort());
    expect(state.pendingCeremony).toBeNull();
  });

  it('(b) a re-link after an unlink: the own entry carries the OLD ceremony\'s certs, so THIS ceremony\'s are read from the joiner\'s entry', async () => {
    const RELINK_EPOCH = 2;
    const { deps, calls, state } = fakeDeps();
    // Grouped locally since the first ceremony (with THIRD, since unlinked).
    state.group = { groupId: GROUP, rosterEpoch: RELINK_EPOCH };
    const OLD_TUPLE = {
      ...JOIN_TUPLE,
      acceptorUserId: THIRD,
      rosterEpoch: 0,
      offerNonce: 'NONCE-FIRST-CEREMONY',
    };
    const OLD_CERTS = {
      offerSig: fakeSig('offer', { ...OLD_TUPLE, subjectIdentityPubKey: rawKey(THIRD) }),
      acceptSig: fakeSig('accept', OLD_TUPLE),
      groupId: GROUP,
      offererUserId: SELF,
      acceptorUserId: THIRD,
      class: 'tablet' as const,
      rosterEpoch: 0,
      offerNonce: 'NONCE-FIRST-CEREMONY',
      expiresAt: EXPIRES,
    };
    state.devices = [
      {
        userId: SELF,
        class: 'phone',
        state: 'linked',
        updatedAt: NOW_MS,
        certsJson: JSON.stringify(OLD_CERTS),
        identityKeyPub: rawKey(SELF),
      },
      {
        userId: THIRD,
        class: 'tablet',
        state: 'unlinked',
        updatedAt: NOW_MS,
        certsJson: JSON.stringify(OLD_CERTS),
        identityKeyPub: rawKey(THIRD),
      },
    ];
    deps.api.linkOfferInit = async (_t, body) => {
      calls.init.push(body);
      return { groupId: GROUP, rosterEpoch: RELINK_EPOCH, offerNonce: NONCE, expiresAt: EXPIRES };
    };
    const RELINK_TUPLE = { ...JOIN_TUPLE, rosterEpoch: RELINK_EPOCH };
    const RELINK_CERTS = { ...JOIN_CERTS, rosterEpoch: RELINK_EPOCH, acceptSig: fakeSig('accept', RELINK_TUPLE), offerSig: fakeSig('offer', { ...RELINK_TUPLE, subjectIdentityPubKey: rawKey(OTHER) }) };

    const ceremony = await OffererCeremony.begin(OTHER, deps);
    await ceremony.confirm('tablet');
    expect(calls.init).toEqual([{ acceptorUserId: OTHER, acceptorClass: 'tablet' }]);
    // The server's join branch: this device's entry keeps the FIRST
    // ceremony's certs; the new tablet's entry carries THIS ceremony's.
    state.bundleSiblings.set(OTHER, [{ userId: SELF, class: 'phone', certs: OLD_CERTS }]);
    state.bundleSiblings.set(SELF, [
      { userId: OTHER, class: 'tablet', certs: RELINK_CERTS },
      { userId: THIRD, class: 'tablet', certs: OLD_CERTS }, // a server still listing the leaver
    ]);
    expect(await ceremony.checkLinked()).toBe(true);
    // The own entry's old acceptance was tried under the pinned key and
    // refused; the joiner's entry's verified — same key, same tuple.
    expect(calls.verify).toEqual([
      { key: rawKey(OTHER), op: 'accept', sig: OLD_CERTS.acceptSig },
      { key: rawKey(OTHER), op: 'accept', sig: RELINK_CERTS.acceptSig },
    ]);
    expect((await currentRoster(deps)).map(d => d.userId).sort()).toEqual([SELF, OTHER].sort());
    expect(JSON.parse(state.devices.find(d => d.userId === OTHER)!.certsJson)).toEqual(RELINK_CERTS);
    expect(JSON.parse(state.devices.find(d => d.userId === SELF)!.certsJson)).toEqual(RELINK_CERTS);
    // The leaver's history row is untouched and not re-linked.
    expect(state.devices.find(d => d.userId === THIRD)?.state).toBe('unlinked');
  });

  describe('(b) negatives — the joiner\'s entry on the own bundle buys nothing the original path would refuse', () => {
    /** A key-BOUND verify fake for the wrong-signer case: valid iff the
     * signature was made by `key` over the exact op + tuple. */
    const keyedSig = (key: string, op: string, tuple: Record<string, unknown>): string =>
      b64(`sig(${key}:${op}:${sigDigest(op, tuple)})`);

    async function committedCeremony(joinerEntryCerts: typeof JOIN_CERTS) {
      const made = attachCreatedFounder();
      const ceremony = await OffererCeremony.begin(OTHER, made.deps);
      await ceremony.confirm('tablet');
      serveCommittedJoin(made.state, joinerEntryCerts);
      // Nothing is recorded before completion (the gate pass re-cut the
      // init-time row): no local group row at all.
      const groupBefore = made.state.group;
      return { ...made, ceremony, groupBefore };
    }

    function nothingCompleted(
      state: FakeState,
      groupBefore: { groupId: string; rosterEpoch: number } | null,
    ): void {
      expect(groupBefore).toBeNull();
      expect(state.group).toEqual(groupBefore); // untouched since init: still none
      expect(state.devices).toEqual([]);
      expect(state.pendingCeremony).not.toBeNull(); // the probe keeps stalling
    }

    it('WRONG SIGNER: an acceptance under a key that is not the ceremony-pinned joiner key', async () => {
      const made = attachCreatedFounder();
      made.deps.crypto.verifyLinkOp = async (key, op, tuple, sig) => {
        made.calls.verify.push({ key, op, sig });
        return sig === keyedSig(key, op, tuple as unknown as Record<string, unknown>);
      };
      const ceremony = await OffererCeremony.begin(OTHER, made.deps);
      await ceremony.confirm('tablet');
      const groupBefore = made.state.group; // none before the acceptance
      // THIRD's key signed a byte-perfect accept over the right tuple:
      serveCommittedJoin(made.state, {
        ...JOIN_CERTS,
        acceptSig: keyedSig(rawKey(THIRD), 'accept', JOIN_TUPLE),
      });
      expect(await ceremony.checkLinked()).toBe(false);
      expect(ceremony.phase).toBe('waiting');
      // Verified under the PINNED key only — never under a served one.
      expect(made.calls.verify).toEqual([
        { key: rawKey(OTHER), op: 'accept', sig: keyedSig(rawKey(THIRD), 'accept', JOIN_TUPLE) },
      ]);
      nothingCompleted(made.state, groupBefore);

      // And the control: the SAME fake admits the genuine signer.
      serveCommittedJoin(made.state, {
        ...JOIN_CERTS,
        acceptSig: keyedSig(rawKey(OTHER), 'accept', JOIN_TUPLE),
      });
      expect(await ceremony.checkLinked()).toBe(true);
    });

    it('WRONG TRANSCRIPT: a genuine acceptance over another nonce, another epoch, or another class', async () => {
      for (const over of [
        { offerNonce: 'SOME-OTHER-NONCE' },
        { rosterEpoch: 0 },
        { class: 'phone' as const },
        { groupId: '01HQGGGG0000000000000000G1' },
      ]) {
        const { ceremony, state, calls, groupBefore } = await committedCeremony({
          ...JOIN_CERTS,
          acceptSig: fakeSig('accept', { ...JOIN_TUPLE, ...over }),
        });
        expect(await ceremony.checkLinked()).toBe(false);
        expect(ceremony.phase).toBe('waiting');
        expect(calls.verify).toHaveLength(1);
        expect(calls.verify[0]!.key).toBe(rawKey(OTHER));
        nothingCompleted(state, groupBefore);
      }
    });

    it('STALE CEREMONY: the joiner\'s entry carries an EARLIER ceremony\'s certs, genuine over THAT tuple', async () => {
      const STALE_TUPLE = { ...JOIN_TUPLE, rosterEpoch: 0, offerNonce: 'NONCE-EARLIER-OFFER' };
      const { ceremony, state, groupBefore } = await committedCeremony({
        ...JOIN_CERTS,
        rosterEpoch: 0,
        offerNonce: 'NONCE-EARLIER-OFFER',
        offerSig: fakeSig('offer', { ...STALE_TUPLE, subjectIdentityPubKey: rawKey(OTHER) }),
        acceptSig: fakeSig('accept', STALE_TUPLE),
      });
      // Completion rebuilds the tuple from its OWN pending record, never
      // from the served certificate — so a real but older acceptance
      // verifies against nothing here.
      expect(await ceremony.checkLinked()).toBe(false);
      nothingCompleted(state, groupBefore);
    });

    it('NO CERTS ANYWHERE: a server asserting membership on both bundles without a certificate completes nothing', async () => {
      const made = attachCreatedFounder();
      const ceremony = await OffererCeremony.begin(OTHER, made.deps);
      await ceremony.confirm('tablet');
      const groupBefore = made.state.group; // none before the acceptance
      made.state.bundleSiblings.set(OTHER, [{ userId: SELF, class: 'phone' }]);
      made.state.bundleSiblings.set(SELF, [{ userId: OTHER, class: 'tablet' }]);
      expect(await ceremony.checkLinked()).toBe(false);
      expect(made.calls.verify).toEqual([]);
      nothingCompleted(made.state, groupBefore);
    });

    it('A ROTATED JOINER KEY: the joiner\'s bundle serving a different key is never a completion — and the own bundle is not even asked', async () => {
      const made = attachCreatedFounder();
      const ceremony = await OffererCeremony.begin(OTHER, made.deps);
      await ceremony.confirm('tablet');
      const groupBefore = made.state.group; // none before the acceptance
      serveCommittedJoin(made.state);
      made.deps.api.getPrekeyBundle = async (_t, userId) => {
        made.calls.bundles.push(userId);
        const bundle = bundleFor(userId, made.state.bundleSiblings.get(userId));
        if (userId === OTHER) bundle.identityKey = 'IDKEY+ROTATED';
        return bundle;
      };
      const before = made.calls.bundles.length;
      expect(await ceremony.checkLinked()).toBe(false);
      expect(made.calls.bundles.slice(before)).toEqual([OTHER]); // no own-bundle fetch
      expect(made.calls.verify).toEqual([]);
      nothingCompleted(made.state, groupBefore);
    });

    it('THE OWN BUNDLE NAMING ANOTHER ACCOUNT is refused like every mis-named bundle, and nothing is stored', async () => {
      const made = attachCreatedFounder();
      const ceremony = await OffererCeremony.begin(OTHER, made.deps);
      await ceremony.confirm('tablet');
      const groupBefore = made.state.group; // none before the acceptance
      serveCommittedJoin(made.state);
      made.deps.api.getPrekeyBundle = async (_t, userId) => {
        made.calls.bundles.push(userId);
        return userId === SELF
          ? bundleFor(THIRD, [{ userId: OTHER, class: 'tablet', certs: JOIN_CERTS }])
          : bundleFor(userId, made.state.bundleSiblings.get(userId));
      };
      await expect(ceremony.checkLinked()).rejects.toThrow('prekey bundle names the wrong account');
      expect(made.calls.verify).toEqual([]);
      nothingCompleted(made.state, groupBefore);
      // The durable path swallows the transient and keeps the row.
      expect(await reconcilePendingLink(made.deps)).toBe(false);
      expect(made.state.pendingCeremony).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// The gate pass (2026-10-08): an abandoned init leaves NO group row, so the
// solo group's later dissolve cannot strand this device; and every roster
// change drops the cached account-state read.
// ---------------------------------------------------------------------------

describe('the gate pass: an abandoned init, then the solo group dissolves — nothing stale is left behind', () => {
  /** The server as devices.ts rules it after the dissolve: a solo offerer
   * must declare its class (a classless init is the collapsed refusal), and
   * the own bundle serves no rosterVersion. */
  function dissolvedOnTheServer(made: ReturnType<typeof fakeDeps>): void {
    made.state.bundleSiblings.delete(SELF);
    made.deps.api.linkOfferInit = async (_t, body) => {
      made.calls.init.push(body);
      if (body.offererClass === undefined) {
        const refusal = new Error('not available') as Error & { status: number; code: string };
        refusal.status = 403;
        refusal.code = 'accounts_refused';
        throw refusal;
      }
      return { groupId: '01HQMINT0000000000000000M0', rosterEpoch: 0, offerNonce: NONCE, expiresAt: EXPIRES + 1_000 };
    };
  }

  /** An attach-created founder (grouped server-side, no local row) whose
   * ceremony nobody accepted: the offer expires with no row written. */
  async function abandonedInit() {
    const made = fakeDeps();
    made.state.bundleSiblings.set(SELF, []);
    made.deps.api.linkOfferInit = async (_t, body) => {
      made.calls.init.push(body);
      return { groupId: GROUP, rosterEpoch: 1, offerNonce: NONCE, expiresAt: EXPIRES };
    };
    const ceremony = await OffererCeremony.begin(OTHER, made.deps);
    await ceremony.confirm('tablet');
    expect(made.calls.init).toEqual([{ acceptorUserId: OTHER, acceptorClass: 'tablet' }]);
    expect(made.state.group).toBeNull();
    made.deps.now = () => NOW_MS + (LINK_OFFER_TTL_SECONDS + 1) * 1000;
    expect(await ceremony.checkLinked()).toBe(false);
    expect(ceremony.phase).toBe('failed');
    expect(made.state.group).toBeNull();
    expect(made.state.pendingCeremony).toBeNull();
    return made;
  }

  it('the next ceremony probes the own bundle again and DECLARES the class, and is admitted', async () => {
    const made = await abandonedInit();
    dissolvedOnTheServer(made);
    const next = await OffererCeremony.begin(OTHER, made.deps);
    await next.confirm('tablet');
    expect(made.calls.init[made.calls.init.length - 1]).toEqual({
      acceptorUserId: OTHER,
      acceptorClass: 'tablet',
      offererClass: 'phone',
    });
    expect(next.phase).toBe('waiting');
  });

  it('Go back to anonymous dissolves nothing from here (no row, no peer notice, no self-unlink) and resolves — the email leg alone is the downgrade', async () => {
    const made = await abandonedInit();
    dissolvedOnTheServer(made);
    const heard: PeerRosterNotice[] = [];
    const off = onPeerRosterNotice(async notice => {
      heard.push(notice);
    });
    try {
      await expect(dissolveGrouping(made.deps)).resolves.toBeUndefined();
    } finally {
      off();
    }
    expect(made.calls.mutation).toEqual([]);
    expect(made.calls.sign.filter(s => s.op === 'dissolve')).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('a recovery notice naming the group a later re-attach minted is plausible and STORED — the 72 h cancel warning reaches this device', async () => {
    const made = await abandonedInit();
    dissolvedOnTheServer(made);
    const stored: Array<{ kind: string; groupId: string }> = [];
    made.deps.db.saveRecoveryNotice = async row => {
      stored.push({ kind: row.kind, groupId: row.groupId });
    };
    const REATTACHED = '01HQGGGG0000000000000000G2';
    expect(
      await handleAccountsNoticeFrame(
        noticeFrame({
          kind: 'recoveryRequested',
          groupId: REATTACHED,
          class: 'tablet',
          completesAt: Math.floor(NOW_MS / 1000) + 72 * 3600,
        }),
        made.deps,
      ),
    ).toBe('stored');
    expect(stored).toEqual([{ kind: 'requested', groupId: REATTACHED }]);
  });
});

describe('the gate pass: every roster change drops the cached account-state read', () => {
  it('the offerer’s completion, the acceptor’s acceptance, a member* notice and a revocation each invalidate it', async () => {
    const invalidate = jest.spyOn(accountsUsername, 'invalidateIdentifierState');
    // The offerer completes a join.
    const made = fakeDeps();
    made.state.bundleSiblings.set(SELF, []);
    made.deps.api.linkOfferInit = async (_t, body) => {
      made.calls.init.push(body);
      return { groupId: GROUP, rosterEpoch: 1, offerNonce: NONCE, expiresAt: EXPIRES };
    };
    const ceremony = await OffererCeremony.begin(OTHER, made.deps);
    await ceremony.confirm('tablet');
    expect(invalidate).not.toHaveBeenCalled();
    const JOIN_TUPLE = {
      groupId: GROUP,
      offererUserId: SELF,
      acceptorUserId: OTHER,
      subjectIdentityPubKey: rawKey(SELF),
      class: 'tablet' as const,
      rosterEpoch: 1,
      offerNonce: NONCE,
      expiresAt: EXPIRES,
    };
    const certs = {
      offerSig: fakeSig('offer', { ...JOIN_TUPLE, subjectIdentityPubKey: rawKey(OTHER) }),
      acceptSig: fakeSig('accept', JOIN_TUPLE),
      groupId: GROUP,
      offererUserId: SELF,
      acceptorUserId: OTHER,
      class: 'tablet' as const,
      rosterEpoch: 1,
      offerNonce: NONCE,
      expiresAt: EXPIRES,
    };
    made.state.bundleSiblings.set(OTHER, [{ userId: SELF, class: 'phone', certs }]);
    expect(await ceremony.checkLinked()).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);

    // The acceptor accepts.
    const joiner = fakeDeps();
    await handleAccountsNoticeFrame(noticeFrame(offerNotice()), joiner.deps);
    const accepting = (await AcceptorCeremony.open(joiner.deps)) as AcceptorCeremony;
    await accepting.accept();
    expect(invalidate).toHaveBeenCalledTimes(2);

    // A usernameRevoked notice lands with the screen closed.
    expect(
      await handleAccountsNoticeFrame(noticeFrame({ kind: 'usernameRevoked' }), joiner.deps),
    ).toBe('stored');
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
});
