import { encodeEnvelope, isCarrierEnvelope } from './envelope';
import { buildTranscriptSync } from './sync';
import {
  fanoutDeviceSet,
  type PeerDevicesDeps,
} from './peerDevices';
import * as dbModule from './db';

/**
 * PER-DEVICE SESSION FAN-OUT ON SEND —
 * one send to a grouped peer becomes one sealed envelope per
 * (sender-device → recipient-device) pair, plus sibling-sync envelopes to
 * the sender's own other devices, every leg its own pairwise session and
 * all of them sharing ONE message id (the group-envelope shared-id
 * discipline, `dev.msg m`). The server stays dumb: each leg is an ordinary
 * send to a bare device ULID.
 *
 * SHAPE RULES, load-bearing:
 *  - An UNGROUPED peer with no sender siblings produces exactly today's
 *    single bare leg — byte-identical wire, the pre-accounts path
 *    untouched by construction.
 *  - A GROUPED peer's legs (the anchor's included) wear the `dev.msg`
 *    wrapper so every recipient device holds the same message id — a
 *    grouped peer's devices are all accounts-capable clients (an old
 *    client cannot link), so the wrapper costs nothing (the skew note).
 *  - Sender siblings get `x.acct.sync` transcript envelopes — the sent
 *    transcript, not a message: the sibling materialises its own 'out'
 *    row under the same shared id.
 *  - A device in the 'pending' hold, or 'removed'/'revoked', gets ZERO
 *    legs — peerDevices.fanoutDeviceSet is the one place that rule lives.
 *
 * STALE-ROSTER HANDLING (honest about the wire): the server refuses
 * a send to a TOMBSTONED ULID with the named `recipient_revoked` error —
 * `handleLegRefusal` records that truth locally so the next fan-out
 * excludes the dead device, and the caller re-fetches the roster on the
 * same signal. Everything else is client-driven.
 */

export interface DeviceFanoutDeps {
  peers: PeerDevicesDeps;
  ownDevices(): Promise<dbModule.LinkedDeviceRow[]>;
  crypto: {
    encryptText(
      selfUserId: string,
      peerUserId: string,
      plaintext: string,
    ): Promise<{ msgType: string; payload: string }>;
  };
}

/** One leg of a device fan-out: a sealed envelope for one device ULID. */
export interface DeviceLeg {
  to: string;
  kind: 'peer' | 'sibling';
  msgType: string;
  payload: string;
}

/** The targets a send must seal for, before any crypto: the peer's device
 * set and the sender's own linked siblings. */
export async function deviceFanoutTargets(
  selfUserId: string,
  anchorId: string,
  deps: DeviceFanoutDeps,
): Promise<{ peerDevices: string[]; siblings: string[] }> {
  const peerDevices = await fanoutDeviceSet(anchorId, deps.peers);
  const siblings = (await deps.ownDevices())
    .filter(row => row.state === 'linked' && row.userId !== selfUserId)
    .map(row => row.userId)
    .sort();
  return { peerDevices, siblings };
}

/**
 * Build every leg of one send: encrypt `body` for each of the peer's
 * devices and a transcript sync for each own sibling — each leg a DISTINCT
 * pairwise session (its own encryptText address), all sharing `msgId`.
 */
export async function buildDeviceLegs(
  args: {
    selfUserId: string;
    anchorId: string;
    body: string;
    msgId: string;
    ts: number;
  },
  deps: DeviceFanoutDeps,
): Promise<DeviceLeg[]> {
  const { peerDevices, siblings } = await deviceFanoutTargets(
    args.selfUserId,
    args.anchorId,
    deps,
  );
  const legs: DeviceLeg[] = [];
  // CARRIERS GO BARE: a carrier acts on rows each device
  // already holds (react/edit/del/read key on the shared id; x.* routes on
  // its own name), so the dev.msg wrapper buys no dedupe and would detour
  // carriers handled BEFORE the one content switch (read receipts,
  // x.acct.*) into arms that drop them. And a carrier is not conversation:
  // no transcript sync leg — a sibling materialising an 'out' row for a
  // read receipt would write a raw carrier line into the thread preview.
  const carrier = isCarrierEnvelope(args.body);
  // The pre-accounts wire, untouched: one device, no siblings — bare body.
  const plain =
    carrier || (peerDevices.length <= 1 && siblings.length === 0)
      ? args.body
      : encodeEnvelope({ tcm: 'dev.msg', m: args.msgId, b: args.body });
  for (const to of peerDevices) {
    try {
      const { msgType, payload } = await deps.crypto.encryptText(
        args.selfUserId,
        to,
        plain,
      );
      legs.push({ to, kind: 'peer', msgType, payload });
    } catch (err) {
      // A leg whose session bootstrap answers the named tombstone refusal
      // (the one server-side refusal) records that truth and is SKIPPED
      // — the rest of the fan-out still sends. Anything else fails the
      // compose loudly, as before.
      if (!(await handleLegRefusal(to, err, deps))) throw err;
    }
  }
  if (siblings.length > 0 && !carrier) {
    const syncBody = encodeEnvelope(
      buildTranscriptSync({
        peerId: args.anchorId,
        msgId: args.msgId,
        body: args.body,
        ts: args.ts,
      }),
    );
    for (const to of siblings) {
      try {
        const { msgType, payload } = await deps.crypto.encryptText(
          args.selfUserId,
          to,
          syncBody,
        );
        legs.push({ to, kind: 'sibling', msgType, payload });
      } catch (err) {
        // A sibling revoked mid-compose: skip the sync leg — own-roster
        // truth arrives by the SIGNED member* notice, not by this error.
        if (!isRecipientRevokedError(err)) throw err;
      }
    }
  }
  return legs;
}

/** True when an error is the server's named refusal for a send to a
 * tombstoned device ULID (the one server-side refusal). */
export function isRecipientRevokedError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'recipient_revoked';
}

/**
 * A leg refused with the named error: the device is DEAD server-side
 * (revoke/replace committed) — record that truth so the very next fan-out
 * excludes it. Returns true when the refusal was the named one and was
 * recorded; false says "not mine, rethrow".
 */
export async function handleLegRefusal(
  to: string,
  err: unknown,
  deps: DeviceFanoutDeps,
): Promise<boolean> {
  if (!isRecipientRevokedError(err)) return false;
  const row = await deps.peers.db.getPeerDevice(to);
  if (row && row.state !== 'revoked') {
    await deps.peers.db.upsertPeerDevice({
      ...row,
      state: 'revoked',
      updatedAt: deps.peers.now(),
    });
  }
  return true;
}
