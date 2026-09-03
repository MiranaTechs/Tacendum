import { z } from 'zod';
import { DeviceClassSchema, GroupMemberCerts, Ulid } from '@tacendum/shared';
import type { AccountSyncEnvelope } from './envelope';
import {
  applyServedRoster,
  type PeerDevicesDeps,
  type ServedSibling,
} from './peerDevices';

/**
 * SIBLING SYNC PAYLOADS — the five typed
 * sync kinds riding `x.acct.sync` envelopes in the pairwise sessions
 * between OWN linked devices: sent transcripts, read state, per-contact
 * local names, peer rosters/cross-signature certs, and (for agent owners)
 * the machine-peers roster. Necessary because the server refuses to serve
 * rosters even to the owner — own-device consistency is the devices' own
 * business, inside the ratchet.
 *
 * TRUST BOUNDARY, stated: a sync envelope is applied ONLY when its sender
 * is a member of THIS device's own linked-device roster in state 'linked'
 * (messaging enforces that before calling in here), and even then the
 * 'roster' kind re-verifies every certificate locally through
 * peerDevices.applyServedRoster — a sibling's VERDICT is never imported,
 * only its evidence. What IS taken on the sibling's word (transcripts,
 * read state, local names, machine peers) is exactly what that sibling
 * could already make true by being the same account's device.
 *
 * DELIBERATELY EXCLUDED: safety-number verification state. My
 * tablet's "verified" is my tablet's ceremony — propagating it would forge
 * a human act.
 *
 * Parse-permissive on receive (the house rule): a malformed payload
 * returns 'dropped' and costs the sync, never a row and never a throw —
 * the caller acks either way, because a poison sync row redelivered
 * forever helps nobody.
 */

/* ── the five payload schemas ─────────────────────────────────────── */

/** k='transcript': a message this account SENT from a sibling device — the
 * receiver materialises its own 'out' row so the thread reads whole. */
export const SyncTranscript = z.object({
  /** The conversation (anchor contact) the send belongs to. */
  peerId: Ulid,
  /** The shared message id (dev.msg `m`, or the plain wire id). */
  msgId: z.string().min(1).max(64),
  body: z.string().min(1),
  ts: z.number().int().nonnegative(),
  /** The disappearing-timer deadline the sender stamped on its OWN row
   * (absolute epoch ms), so the sibling's copy expires with it — a transcript
   * used to be materialised with no expiry at all and outlived the message it
   * copied. Optional and ADDITIVE: an older sibling's parse strips it and
   * keeps the transcript. */
  expiresAt: z.number().int().positive().optional(),
});
export type SyncTranscript = z.infer<typeof SyncTranscript>;

/** k='read': the account read `peerId`'s thread on a sibling, up to `ts`.
 * `msgIds` names the rows where the sender holds them; it MAY be empty —
 * the receiver's badge advance keys on `ts` (a thread can be re-opened
 * with nothing new to name, and the open still clears the badge). */
export const SyncReadState = z.object({
  peerId: Ulid,
  msgIds: z.array(z.string().min(1).max(64)).max(64),
  ts: z.number().int().nonnegative(),
});
export type SyncReadState = z.infer<typeof SyncReadState>;

/** k='name': the per-contact local name chosen on a sibling. */
export const SyncLocalName = z.object({
  peerId: Ulid,
  /** '' clears the local name. */
  name: z.string().max(190),
  ts: z.number().int().nonnegative(),
});
export type SyncLocalName = z.infer<typeof SyncLocalName>;

/** k='roster': a peer's device set as one sibling learned it — EVIDENCE
 * (certs + keys), never verdicts; the receiver re-verifies locally. */
export const SyncPeerRoster = z.object({
  anchorId: Ulid,
  devices: z
    .array(
      z.object({
        userId: Ulid,
        // The shared schema, never the words spelled here (the slot-word invariant).
        class: DeviceClassSchema,
        certs: GroupMemberCerts,
        identityKeyPub: z.string().min(1).max(128),
      }),
    )
    .max(8),
});
export type SyncPeerRoster = z.infer<typeof SyncPeerRoster>;

/** k='machines': the integration-class accounts THIS sending device owns
 * — what lets a surviving sibling honestly name a
 * revoked device's agents as `boundAgents`. */
export const SyncMachinePeers = z.object({
  /** The whole current list; the apply replaces wholesale (idempotent). */
  agentIds: z.array(Ulid).max(8),
  ts: z.number().int().nonnegative(),
});
export type SyncMachinePeers = z.infer<typeof SyncMachinePeers>;

/* ── builders (compose-strict: local code with a surface to report to) ── */

export function buildTranscriptSync(d: SyncTranscript): AccountSyncEnvelope {
  return { tcm: 'x.acct.sync', k: 'transcript', d: SyncTranscript.parse(d) };
}

export function buildReadSync(d: SyncReadState): AccountSyncEnvelope {
  return { tcm: 'x.acct.sync', k: 'read', d: SyncReadState.parse(d) };
}

export function buildLocalNameSync(d: SyncLocalName): AccountSyncEnvelope {
  return { tcm: 'x.acct.sync', k: 'name', d: SyncLocalName.parse(d) };
}

export function buildPeerRosterSync(d: SyncPeerRoster): AccountSyncEnvelope {
  return { tcm: 'x.acct.sync', k: 'roster', d: SyncPeerRoster.parse(d) };
}

export function buildMachinePeersSync(d: SyncMachinePeers): AccountSyncEnvelope {
  return { tcm: 'x.acct.sync', k: 'machines', d: SyncMachinePeers.parse(d) };
}

/* ── the apply ────────────────────────────────────────────────────── */

export interface SyncApplyDeps {
  /** Insert the sibling-sent transcript as this device's own 'out' row —
   * false when the row already exists (idempotent redelivery). */
  insertSentTranscript(d: SyncTranscript): Promise<boolean>;
  /** Mark the named inbound messages read (the receipts machinery's own
   * rules apply; unknown ids are ignored, never trusted into existence). */
  markReadSynced(d: SyncReadState): Promise<void>;
  setLocalName(d: SyncLocalName): Promise<void>;
  /** peerDevices deps — the 'roster' kind re-verifies locally. */
  peerDevices: PeerDevicesDeps;
  /** Replace the sending sibling's machine-peers list. */
  replaceSiblingMachinePeers(
    deviceUserId: string,
    agentIds: readonly string[],
    ts: number,
  ): Promise<void>;
}

/**
 * Apply one sibling sync envelope from `senderDeviceId` (already verified a
 * 'linked' member of this device's OWN roster by the caller). Returns
 * 'applied' or 'dropped' — the caller acks either way.
 */
export async function applySiblingSync(
  senderDeviceId: string,
  envelope: AccountSyncEnvelope,
  deps: SyncApplyDeps,
): Promise<'applied' | 'dropped'> {
  switch (envelope.k) {
    case 'transcript': {
      const parsed = SyncTranscript.safeParse(envelope.d);
      if (!parsed.success) return 'dropped';
      await deps.insertSentTranscript(parsed.data);
      return 'applied';
    }
    case 'read': {
      const parsed = SyncReadState.safeParse(envelope.d);
      if (!parsed.success) return 'dropped';
      await deps.markReadSynced(parsed.data);
      return 'applied';
    }
    case 'name': {
      const parsed = SyncLocalName.safeParse(envelope.d);
      if (!parsed.success) return 'dropped';
      await deps.setLocalName(parsed.data);
      return 'applied';
    }
    case 'roster': {
      const parsed = SyncPeerRoster.safeParse(envelope.d);
      if (!parsed.success) return 'dropped';
      // Evidence only: the same TOFU verification the served bundle gets —
      // an unverifiable device lands in the same 'pending' hold whichever
      // road it arrived by.
      const siblings: ServedSibling[] = parsed.data.devices.map(dev => ({
        userId: dev.userId,
        class: dev.class,
        certs: dev.certs,
        identityKeyPub: dev.identityKeyPub,
      }));
      await applyServedRoster(
        { anchorId: parsed.data.anchorId, siblings },
        deps.peerDevices,
      );
      return 'applied';
    }
    case 'machines': {
      const parsed = SyncMachinePeers.safeParse(envelope.d);
      if (!parsed.success) return 'dropped';
      await deps.replaceSiblingMachinePeers(
        senderDeviceId,
        parsed.data.agentIds,
        parsed.data.ts,
      );
      return 'applied';
    }
  }
}
