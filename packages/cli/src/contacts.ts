import { MessageLog } from './msglog.js';
import { isUserId } from './profile.js';
import { FileStores } from './stores.js';

/**
 * The contact roster.
 *
 * An agent and a human have the same problem before sending: "who is 01ARZ…,
 * and do I still believe it?" This module answers from what the client already
 * knows — nothing here talks to the server, because the server's opinion of a
 * peer is exactly what TOFU exists to not depend on.
 *
 * Sources, and what each contributes:
 *   identities/<peer>.<dev>.pub   the TOFU pin — a peer becomes "known" the
 *                                 moment a session pinned their key
 *   identity-changes.json         the pins currently under refusal
 *   peer-names.json               display names from `profile` envelopes,
 *                                 authenticated by the ratchet that carried
 *                                 them
 *   messages.jsonl                last message time, from the message log
 *
 * TRUST STATE is one of three words, and the precedence is the security
 * property: a pending identity change beats an existing pin, because "pinned"
 * about a peer this client is actively refusing to decrypt would report the
 * opposite of the one thing the warning was written to say.
 *   changed      an identity change is pending — verify out of band, then
 *                `tacendum trust`
 *   pinned       a key is pinned (trust-on-first-use); the safety number is
 *                comparable
 *   unverified   the peer is known only by reputation (a logged message or a
 *                recorded name) with no key currently pinned — e.g. after
 *                `trust` un-pins and before the next message re-pins
 */

export type TrustState = 'pinned' | 'changed' | 'unverified';

export interface ContactRow {
  userId: string;
  /** From a `profile` envelope, if one ever arrived. Peer-chosen text. */
  name?: string;
  trust: TrustState;
  /** Last logged message involving this peer (ms), if any. */
  lastMessageAt?: number;
}

export function listContacts(name: string): ContactRow[] {
  const stores = new FileStores(name);
  const log = new MessageLog(name);

  const pinned = new Set(stores.identity.pinnedPeers());
  const changed = new Set(stores.listIdentityChanges());
  const names = stores.loadPeerNames();

  // The log is newest-first from `read()`, so the FIRST occurrence of a peer
  // is their latest message — no per-peer max needed.
  const lastByPeer = new Map<string, number>();
  for (const record of log.read()) {
    if (!lastByPeer.has(record.peer)) lastByPeer.set(record.peer, record.ts);
  }

  // The union of everything any source knows, filtered to id-shaped values:
  // directory names and side files are inputs like any other, and a stray
  // file must become a skipped entry, not a row.
  const ids = [...new Set([...pinned, ...changed, ...Object.keys(names), ...lastByPeer.keys()])]
    .filter(isUserId);

  const rows: ContactRow[] = ids.map((userId) => {
    const trust: TrustState = changed.has(userId)
      ? 'changed'
      : pinned.has(userId)
        ? 'pinned'
        : 'unverified';
    const displayName = names[userId];
    const last = lastByPeer.get(userId);
    return {
      userId,
      trust,
      ...(displayName !== undefined ? { name: displayName } : {}),
      ...(last !== undefined ? { lastMessageAt: last } : {}),
    };
  });

  // Most recently heard from first — the order an operator scans an inbox in —
  // then the never-messaged, alphabetically so the output is stable run to run.
  rows.sort((a, b) => {
    const la = a.lastMessageAt ?? -1;
    const lb = b.lastMessageAt ?? -1;
    if (la !== lb) return lb - la;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return rows;
}
