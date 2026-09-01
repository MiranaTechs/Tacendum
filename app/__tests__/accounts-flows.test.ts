/**
 * THE IDENTIFIER / RECOVERY STATE MACHINE —
 * refusal-first, because the wire's refusals are DESIGNED collapses and
 * the client's one job is to change nothing on them:
 *
 *  - a refused attach/verify/unlink leaves local state byte-untouched;
 *  - the consent toggle records this device's OWN decision (the uniform
 *    204 proves nothing and is never treated as a receipt);
 *  - recovery: verify births the durable pending row; completion refuses
 *    before `completesAt` WITHOUT a network call; a refused completion
 *    (cancel and not-yet are deliberately indistinguishable) keeps the
 *    pending row so the person can retry; the surviving member's cancel
 *    flips the stored notice.
 *
 * Plus the two producers this phase lands:
 *  - the recovery notices STORE (handleAccountsNoticeFrame:
 *    requested/completed/cancelled all
 *    'stored', with the listener fired);
 *  - the dissolve producer (dissolveGrouping): the signed dissolve
 *    is emitted OVER THE INTACT ROSTER before any unlink leaves, every
 *    other member is unlinked by this device's signature, and this device
 *    leaves LAST (the last exit is the server transaction that deletes
 *    the group row and its claims).
 */

import type { AccountsNoticeFrame } from '@tacendum/shared';
import { ApiRequestError } from '../src/api';
import * as accounts from '../src/accounts';
import {
  dissolveGrouping,
  handleAccountsNoticeFrame,
  onRecoveryNotice,
  onPeerRosterNotice,
  type LinkingDeps,
  type PeerRosterNotice,
} from '../src/linking';
import type * as db from '../src/db';

const SELF = '01HQAAAA00000000000000000A';
const OTHER = '01HQBBBB00000000000000000B';
const GROUP = '01HQGGGG0000000000000000G0';
const NOW_MS = 1_756_000_000_000;

const REFUSAL = new ApiRequestError('refused', 403, 'accounts_refused');

/* ── the accounts fake (call-ledger style) ─────────────────────────── */

interface Ledger {
  calls: string[];
  identifier: db.AccountIdentifierRow | null;
  phoneIdentifier: db.PhoneIdentifierRow | null;
  recovery: db.LocalRecoveryRow | null;
  notice: db.RecoveryNoticeRow | null;
  group: { groupId: string; rosterEpoch: number } | null;
}

function fakeDeps(
  overrides: Partial<Record<string, () => Promise<never>>> = {},
): { deps: accounts.AccountsDeps; state: Ledger } {
  const state: Ledger = {
    calls: [],
    identifier: null,
    phoneIdentifier: null,
    recovery: null,
    notice: null,
    group: null,
  };
  const refuse = (name: string) =>
    overrides[name] ??
    (async () => {
      state.calls.push(name);
    });
  const deps: accounts.AccountsDeps = {
    api: {
      emailRequestCode: refuse('emailRequestCode') as accounts.AccountsDeps['api']['emailRequestCode'],
      emailVerify: refuse('emailVerify') as accounts.AccountsDeps['api']['emailVerify'],
      emailUnlink: refuse('emailUnlink') as accounts.AccountsDeps['api']['emailUnlink'],
      setDiscoverable: refuse('setDiscoverable') as accounts.AccountsDeps['api']['setDiscoverable'],
      discoveryLookup: async () => {
        state.calls.push('discoveryLookup');
        throw REFUSAL;
      },
      recoveryRequestCode: refuse('recoveryRequestCode') as accounts.AccountsDeps['api']['recoveryRequestCode'],
      recoveryVerify:
        (overrides.recoveryVerify as accounts.AccountsDeps['api']['recoveryVerify']) ??
        (async () => {
          state.calls.push('recoveryVerify');
          return { groupId: GROUP, completesAt: Math.floor(NOW_MS / 1000) + 72 * 3600 };
        }),
      recoveryRequestCodePhone: refuse('recoveryRequestCodePhone') as accounts.AccountsDeps['api']['recoveryRequestCodePhone'],
      recoveryVerifyPhone: async () => {
        state.calls.push('recoveryVerifyPhone');
        return { groupId: GROUP, completesAt: Math.floor(NOW_MS / 1000) + 72 * 3600 };
      },
      recoveryCancel: refuse('recoveryCancel') as accounts.AccountsDeps['api']['recoveryCancel'],
      recoveryComplete: refuse('recoveryComplete') as accounts.AccountsDeps['api']['recoveryComplete'],
      authChallenge: async () => {
        state.calls.push('authChallenge');
        return { challenge: 'CHAL' };
      },
      getPrekeyBundle: async () => {
        state.calls.push('getPrekeyBundle');
        throw new Error('no bundle in this suite');
      },
    },
    crypto: {
      identityPublicKey: async () => 'IDKEY',
      signAuthChallenge: async c => `sig(${c})`,
    },
    db: {
      loadAccountIdentifier: async () => state.identifier,
      saveAccountIdentifier: async row => {
        state.identifier = { ...row };
      },
      clearAccountIdentifier: async () => {
        state.identifier = null;
      },
      savePhoneIdentifier: async row => {
        state.phoneIdentifier = { ...row };
      },
      clearPhoneIdentifier: async () => {
        state.phoneIdentifier = null;
      },
      loadLocalRecovery: async () => state.recovery,
      saveLocalRecovery: async row => {
        state.recovery = { ...row };
      },
      clearLocalRecovery: async () => {
        state.recovery = null;
      },
      saveRecoveryNotice: async row => {
        state.notice = { ...row };
      },
      loadRecoveryNotice: async () => state.notice,
      upsertChat: async () => {
        state.calls.push('upsertChat');
      },
      setLocalName: async () => {
        state.calls.push('setLocalName');
      },
      loadLinkGroup: async () => state.group,
      saveLinkGroup: async (groupId, rosterEpoch) => {
        state.group = { groupId, rosterEpoch };
      },
      upsertLinkedDevice: async () => {
        state.calls.push('upsertLinkedDevice');
      },
    },
    dissolve: async () => {
      state.calls.push('dissolve');
    },
    token: async () => 'bearer',
    selfId: async () => SELF,
    now: () => NOW_MS,
  };
  return { deps, state };
}

const refusing = (name: string) => ({
  [name]: async () => {
    throw REFUSAL;
  },
});

/* ── attach / consent / unlink ─────────────────────────────────────── */

describe('email attach — refusal-first', () => {
  it('a refused code request records NO pending address', async () => {
    const { deps, state } = fakeDeps(refusing('emailRequestCode'));
    expect(await accounts.requestAttachCode('a@b.co', deps)).toBe('refused');
    expect(state.identifier).toBeNull();
  });

  it('a sent code records the normalized pending address — and only that', async () => {
    const { deps, state } = fakeDeps();
    expect(await accounts.requestAttachCode('  Alice@Example.COM ', deps)).toBe('sent');
    expect(state.identifier).toMatchObject({
      email: null,
      pendingEmail: 'alice@example.com',
      discoverable: false,
    });
  });

  it('the consent toggle records this device’s own decision — and a refusal records nothing', async () => {
    const { deps, state } = fakeDeps();
    state.identifier = {
      email: 'alice@example.com',
      verifiedAt: NOW_MS,
      discoverable: false,
      pendingEmail: null,
      pendingRequestedAt: null,
      // The restored placeholder: the owner's own
      // toggle is the REAL decision that settles it.
      restoredAt: NOW_MS,
    };
    expect(await accounts.setDiscoverable(true, deps)).toBe('ok');
    expect(state.identifier.discoverable).toBe(true);
    expect(state.identifier.restoredAt).toBeNull();

    const refused = fakeDeps(refusing('setDiscoverable'));
    refused.state.identifier = { ...state.identifier, discoverable: false, restoredAt: NOW_MS };
    expect(await accounts.setDiscoverable(true, refused.deps)).toBe('refused');
    expect(refused.state.identifier.discoverable).toBe(false);
    expect(refused.state.identifier.restoredAt).toBe(NOW_MS);
  });

  it('a refused unlink keeps local state; a successful one clears it', async () => {
    const attached: db.AccountIdentifierRow = {
      email: 'alice@example.com',
      verifiedAt: NOW_MS,
      discoverable: true,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: null,
    };
    const refused = fakeDeps(refusing('emailUnlink'));
    refused.state.identifier = { ...attached };
    expect(await accounts.unlinkIdentifier(refused.deps)).toBe('refused');
    expect(refused.state.identifier).toEqual(attached);

    const ok = fakeDeps();
    ok.state.identifier = { ...attached };
    expect(await accounts.unlinkIdentifier(ok.deps)).toBe('ok');
    expect(ok.state.identifier).toBeNull();
  });

  it('downgrade tolerates an already-gone identifier and still dissolves', async () => {
    const { deps, state } = fakeDeps(refusing('emailUnlink'));
    state.identifier = null;
    expect(await accounts.downgradeToAnonymous(deps)).toBe('downgraded');
    expect(state.calls).toContain('dissolve');
  });
});

/* ── recovery ──────────────────────────────────────────── */

describe('recovery — the pending row, the clock, and the honest collapses', () => {
  it('verify births the durable pending row; a refusal births nothing', async () => {
    const { deps, state } = fakeDeps();
    const result = await accounts.confirmRecoveryCode('a@b.co', '123456', deps);
    expect(result.outcome).toBe('pending');
    expect(state.recovery).toMatchObject({ groupId: GROUP, kind: 'email', value: 'a@b.co' });

    const refused = fakeDeps({
      recoveryVerify: async () => {
        throw REFUSAL;
      },
    });
    expect(
      (await accounts.confirmRecoveryCode('a@b.co', '000000', refused.deps)).outcome,
    ).toBe('refused');
    expect(refused.state.recovery).toBeNull();
  });

  it('completion before completesAt refuses LOCALLY — no network call is made', async () => {
    const { deps, state } = fakeDeps();
    state.recovery = {
      kind: 'email',
      value: 'a@b.co',
      groupId: GROUP,
      completesAt: Math.floor(NOW_MS / 1000) + 60,
      verifiedAt: NOW_MS,
    };
    expect(await accounts.completeRecovery(deps)).toBe('not_ready');
    expect(state.calls).not.toContain('authChallenge');
    expect(state.calls).not.toContain('recoveryComplete');
    expect(state.recovery).not.toBeNull();
  });

  it('a REFUSED completion keeps the pending row (cancel and not-yet are indistinguishable by design)', async () => {
    const { deps, state } = fakeDeps(refusing('recoveryComplete'));
    state.recovery = {
      kind: 'email',
      value: 'a@b.co',
      groupId: GROUP,
      completesAt: Math.floor(NOW_MS / 1000) - 1,
      verifiedAt: NOW_MS,
    };
    expect(await accounts.completeRecovery(deps)).toBe('refused');
    expect(state.recovery).not.toBeNull();
  });

  it('an accepted completion records the group, this device’s row, the RESTORED identifier, and clears the pending record', async () => {
    const { deps, state } = fakeDeps();
    state.recovery = {
      kind: 'email',
      value: 'a@b.co',
      groupId: GROUP,
      completesAt: Math.floor(NOW_MS / 1000) - 1,
      verifiedAt: NOW_MS,
    };
    expect(await accounts.completeRecovery(deps)).toBe('completed');
    expect(state.group).toMatchObject({ groupId: GROUP });
    expect(state.calls).toContain('upsertLinkedDevice');
    expect(state.recovery).toBeNull();
    // The recovered device gets its local identifier row — the
    // email IS known and verified (the recovery code was an inbox
    // round-trip), so the unlink and consent controls exist — recorded as
    // the RESTORED placeholder: `discoverable` is not a decision here (the
    // server preserved the pre-loss consent, unreadable by design), and
    // `restoredAt` marks exactly that until the owner's own toggle.
    expect(state.identifier).toMatchObject({
      email: 'a@b.co',
      discoverable: false,
      restoredAt: NOW_MS,
    });
  });

  it('a refused completion over a COMMITTED earlier attempt reconciles: the own bundle proves grouped, the local half finishes', async () => {
    // The crash window: a prior completion committed
    // server-side and died before the local writes — the pending row is
    // consumed, every retry refuses. The committed truth is readable
    // through the EXISTING keys route: the device's own bundle serves
    // rosterVersion exactly when it is grouped.
    const { deps, state } = fakeDeps(refusing('recoveryComplete'));
    deps.api.getPrekeyBundle = async () =>
      ({ userId: SELF, rosterVersion: 5 } as never);
    state.recovery = {
      kind: 'email',
      value: 'a@b.co',
      groupId: GROUP,
      completesAt: Math.floor(NOW_MS / 1000) - 1,
      verifiedAt: NOW_MS,
    };
    expect(await accounts.completeRecovery(deps)).toBe('completed');
    expect(state.group).toMatchObject({ groupId: GROUP, rosterEpoch: 5 });
    expect(state.identifier).toMatchObject({ email: 'a@b.co', restoredAt: NOW_MS });
    expect(state.recovery).toBeNull();

    // And the guard the reconciliation must keep: a device already grouped
    // by ANY other path is not this crash window — the refusal stands and
    // nothing is overwritten.
    const grouped = fakeDeps(refusing('recoveryComplete'));
    grouped.deps.api.getPrekeyBundle = async () =>
      ({ userId: SELF, rosterVersion: 9 } as never);
    grouped.state.group = { groupId: 'OTHERGROUP', rosterEpoch: 2 };
    grouped.state.recovery = {
      kind: 'email',
      value: 'a@b.co',
      groupId: GROUP,
      completesAt: Math.floor(NOW_MS / 1000) - 1,
      verifiedAt: NOW_MS,
    };
    expect(await accounts.completeRecovery(grouped.deps)).toBe('refused');
    expect(grouped.state.group).toMatchObject({ groupId: 'OTHERGROUP', rosterEpoch: 2 });
    expect(grouped.state.recovery).not.toBeNull();
  });

  it('the surviving member’s cancel flips the stored notice to cancelled', async () => {
    const { deps, state } = fakeDeps();
    state.notice = {
      kind: 'requested',
      groupId: GROUP,
      class: 'phone',
      completesAt: Math.floor(NOW_MS / 1000) + 3600,
      receivedAt: NOW_MS,
    };
    expect(await accounts.cancelRecovery(deps)).toBe('ok');
    expect(state.notice.kind).toBe('cancelled');

    const refused = fakeDeps(refusing('recoveryCancel'));
    refused.state.notice = {
      kind: 'requested',
      groupId: GROUP,
      class: 'phone',
      completesAt: null,
      receivedAt: NOW_MS,
    };
    expect(await accounts.cancelRecovery(refused.deps)).toBe('refused');
    expect(refused.state.notice.kind).toBe('requested');
  });
});

/* ── the recovery notices, stored + surfaced ────────────────────── */

function b64(text: string): string {
  // The notice payloads here are pure ASCII (ULIDs, enums, integers), so a
  // hand-rolled encoder avoids a Node Buffer type dependency in this tree.
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : undefined;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : undefined;
    out += alphabet[a >> 2];
    out += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : alphabet[c & 0x3f];
  }
  return out;
}

function linkingFake(): { deps: LinkingDeps; stored: db.RecoveryNoticeRow[] } {
  const stored: db.RecoveryNoticeRow[] = [];
  const deps: LinkingDeps = {
    api: {
      getPrekeyBundle: async (_token, userId) => ({
        userId,
        registrationId: 7,
        identityKey: `IDKEY+${userId.slice(-4)}`,
        signedPrekey: { keyId: 1, pub: 'AA==', sig: 'AA==' },
        kyberPrekey: { keyId: 1, pub: 'AA==', sig: 'AA==' },
      }),
      linkOfferInit: async () => {
        throw new Error('not in this suite');
      },
      linkOfferSubmit: async () => undefined,
      linkAccept: async () => undefined,
      rosterMutation: async () => undefined,
    },
    crypto: {
      processPreKeyBundle: async () => undefined,
      safetyNumber: async () => null,
      signLinkOp: async (op, tuple) => `sig(${op}:${tuple.rosterEpoch})`,
      verifyLinkOp: async () => true,
      identityPublicKey: async () => 'OWNKEY',
    },
    db: {
      loadLinkGroup: async () => null,
      saveLinkGroup: async () => undefined,
      upsertLinkedDevice: async () => undefined,
      markLinkedDeviceState: async () => undefined,
      listLinkedDevices: async () => [],
      clearLinkGroup: async () => undefined,
      savePendingLinkOffer: async () => undefined,
      loadPendingLinkOffer: async () => null,
      deletePendingLinkOffer: async () => undefined,
      savePendingLinkCeremony: async () => undefined,
      loadPendingLinkCeremony: async () => null,
      deletePendingLinkCeremony: async () => undefined,
      pristineForLink: async () => true,
      savePendingLinkMutation: async () => undefined,
      listPendingLinkMutations: async () => [],
      deletePendingLinkMutation: async () => undefined,
      listSiblingAgents: async () => [],
      saveRecoveryNotice: async row => {
        stored.push({ ...row });
      },
      loadRecoveryNotice: async () => stored[stored.length - 1] ?? null,
      clearUsernameIdentifier: async () => undefined,
      saveUsernameNotice: async () => undefined,
    },
    token: async () => 'bearer',
    selfId: async () => SELF,
    now: () => NOW_MS,
    freshNonce: () => '01HQNNNN00000000000000000N',
  };
  return { deps, stored };
}

describe('recovery notices are STORED and surfaced', () => {
  const frame = (payload: object): AccountsNoticeFrame => ({
    type: 'accounts',
    msgId: '01HQMSGZ00000000000000000M',
    from: OTHER,
    payload: b64(JSON.stringify(payload)),
    ts: NOW_MS,
  });
  const COMPLETES = Math.floor(NOW_MS / 1000) + 72 * 3600;

  it('requested stores with the cancel horizon; a cancel settles it; the listener fires', async () => {
    const { deps, stored } = linkingFake();
    const fired: number[] = [];
    const off = onRecoveryNotice(() => fired.push(1));
    try {
      expect(
        await handleAccountsNoticeFrame(
          frame({
            kind: 'recoveryRequested',
            groupId: GROUP,
            class: 'phone',
            completesAt: COMPLETES,
          }),
          deps,
        ),
      ).toBe('stored');
      expect(stored[stored.length - 1]).toMatchObject({
        kind: 'requested',
        class: 'phone',
        completesAt: COMPLETES,
      });

      expect(
        await handleAccountsNoticeFrame(
          frame({ kind: 'recoveryCancelled', groupId: GROUP }),
          deps,
        ),
      ).toBe('stored');
      // The attempt's horizon survives its terminal state — it is what identifies the attempt.
      expect(stored[stored.length - 1]).toMatchObject({
        kind: 'cancelled',
        completesAt: COMPLETES,
      });
      expect(fired).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('a STALE requested replay cannot resurrect a settled attempt; a genuinely fresh one can', async () => {
    const { deps, stored } = linkingFake();
    await handleAccountsNoticeFrame(
      frame({ kind: 'recoveryRequested', groupId: GROUP, class: 'phone', completesAt: COMPLETES }),
      deps,
    );
    await handleAccountsNoticeFrame(frame({ kind: 'recoveryCancelled', groupId: GROUP }), deps);
    // The SAME attempt's requested notice, redelivered late: dropped — the
    // cancel already settled it.
    expect(
      await handleAccountsNoticeFrame(
        frame({ kind: 'recoveryRequested', groupId: GROUP, class: 'phone', completesAt: COMPLETES }),
        deps,
      ),
    ).toBe('dropped');
    expect(stored[stored.length - 1]).toMatchObject({ kind: 'cancelled' });
    // A NEW attempt has a strictly later 72 h horizon — it stores.
    expect(
      await handleAccountsNoticeFrame(
        frame({
          kind: 'recoveryRequested',
          groupId: GROUP,
          class: 'phone',
          completesAt: COMPLETES + 3600,
        }),
        deps,
      ),
    ).toBe('stored');
    expect(stored[stored.length - 1]).toMatchObject({
      kind: 'requested',
      completesAt: COMPLETES + 3600,
    });
  });

  it('a notice naming a group this device is NOT in drops; completed stores for the matching group', async () => {
    const { deps, stored } = linkingFake();
    deps.db.loadLinkGroup = async () => ({ groupId: GROUP, rosterEpoch: 2 });
    expect(
      await handleAccountsNoticeFrame(
        frame({
          kind: 'recoveryRequested',
          groupId: '01HQFFFF0000000000000000F0',
          class: 'phone',
          completesAt: COMPLETES,
        }),
        deps,
      ),
    ).toBe('dropped');
    expect(stored).toHaveLength(0);
    expect(
      await handleAccountsNoticeFrame(
        frame({
          kind: 'recoveryCompleted',
          groupId: GROUP,
          userId: OTHER,
          class: 'phone',
          rosterEpoch: 3,
        }),
        deps,
      ),
    ).toBe('stored');
    expect(stored[stored.length - 1]).toMatchObject({ kind: 'completed' });
  });
});

/* ── the dissolve producer ────────────────────────────────────── */

describe('dissolveGrouping — the flow that signs a dissolve', () => {
  it('signs over the INTACT roster first, then unlinks others, then self LAST', async () => {
    const { deps } = linkingFake();
    const events: string[] = [];
    const mutations: Array<{ op: string; target: string }> = [];
    deps.db.loadLinkGroup = async () => ({ groupId: GROUP, rosterEpoch: 4 });
    deps.db.listLinkedDevices = async () => [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '', identityKeyPub: 'OWNKEY' },
      { userId: OTHER, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '', identityKeyPub: 'K2' },
    ];
    deps.api.rosterMutation = async (_t, op, body) => {
      events.push(`mutate:${body.targetUserId}`);
      mutations.push({ op, target: body.targetUserId });
    };
    const notices: PeerRosterNotice[] = [];
    const off = onPeerRosterNotice(n => {
      if (n.op === 'dissolve') {
        events.push('dissolve-notice');
        notices.push(n);
      }
    });
    try {
      await dissolveGrouping(deps);
    } finally {
      off();
    }
    // The signed statement rides FIRST, over the intact epoch-4 roster;
    // the sibling leaves next; this device leaves LAST (its exit is the
    // server's group-row + claim deletion).
    expect(events[0]).toBe('dissolve-notice');
    expect(events.slice(1)).toEqual([`mutate:${OTHER}`, `mutate:${SELF}`]);
    expect(mutations.every(m => m.op === 'unlink')).toBe(true);
    expect(notices[0]!.tuple).toMatchObject({
      groupId: GROUP,
      offererUserId: SELF,
      acceptorUserId: SELF,
      subjectIdentityPubKey: 'OWNKEY',
      rosterEpoch: 4,
    });
  });

  it('a device that was never ceremonially grouped dissolves nothing — and signs nothing', async () => {
    const { deps } = linkingFake();
    let signed = 0;
    deps.crypto.signLinkOp = async () => {
      signed += 1;
      return 'sig';
    };
    await dissolveGrouping(deps);
    expect(signed).toBe(0);
  });

  it('the dissolve statement is AWAITED: the roster does not move until the fan-out listener settles, and a failed statement dissolves nothing', async () => {
    const { deps } = linkingFake();
    const events: string[] = [];
    deps.db.loadLinkGroup = async () => ({ groupId: GROUP, rosterEpoch: 4 });
    deps.db.listLinkedDevices = async () => [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '', identityKeyPub: 'OWNKEY' },
      { userId: OTHER, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '', identityKeyPub: 'K2' },
    ];
    deps.api.rosterMutation = async (_t, _op, body) => {
      events.push(`mutate:${body.targetUserId}`);
    };
    // An ASYNC listener (the messaging fan-out shape): its settle must
    // strictly precede the first roster mutation — the order is
    // statement first, teardown second, and "first" means durably enqueued,
    // not merely started.
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const off = onPeerRosterNotice(n => {
      if (n.op !== 'dissolve') return;
      return gate.then(() => {
        events.push('statement-durable');
      });
    });
    try {
      const run = dissolveGrouping(deps);
      // Give the producer every chance to run ahead — it must not.
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
      expect(events).toEqual([]);
      release();
      await run;
    } finally {
      off();
    }
    expect(events[0]).toBe('statement-durable');
    expect(events.slice(1)).toEqual([`mutate:${OTHER}`, `mutate:${SELF}`]);

    // And the failure half: a statement that cannot be made durable stops
    // the dissolve BEFORE any unlink — a partial downgrade is never a
    // silent one.
    const failing = linkingFake();
    const mutations: string[] = [];
    failing.deps.db.loadLinkGroup = async () => ({ groupId: GROUP, rosterEpoch: 4 });
    failing.deps.db.listLinkedDevices = async () => [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '', identityKeyPub: 'OWNKEY' },
    ];
    failing.deps.api.rosterMutation = async (_t, _op, body) => {
      mutations.push(body.targetUserId);
    };
    const offFail = onPeerRosterNotice(n =>
      n.op === 'dissolve' ? Promise.reject(new Error('no statement')) : undefined,
    );
    try {
      await expect(dissolveGrouping(failing.deps)).rejects.toThrow('no statement');
    } finally {
      offFail();
    }
    expect(mutations).toEqual([]);
  });
});
