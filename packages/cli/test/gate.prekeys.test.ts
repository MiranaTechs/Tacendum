import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStores } from '../src/stores.js';
import { loadOrGenerateKeys } from '../src/messaging.js';

/**
 * a returning registration must not re-advertise
 * one-time prekeys the server may already have handed out.
 *
 * The failure it prevents is silent and permanent. `PUT /v1/keys` REPLACES the
 * server's pool, so re-uploading the local set puts back every key the server
 * had already allocated to an in-flight sender. Two senders then receive the
 * same one-time prekey; the first message to arrive consumes its private half
 * locally (libsignal deletes a used one-time prekey), and the second can never
 * decrypt — after which the inbound path classifies it as tamper and acks it
 * away, destroying the server's only copy.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-prekeys-'));
  process.env.TACENDUM_HOME = home;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('returning registration rotates its one-time prekeys', () => {
  it('uploads a disjoint set of keyIds on the second run', async () => {
    const stores = new FileStores('bot');
    const first = await loadOrGenerateKeys(stores);
    const firstIds = first.oneTimePrekeys.map((p) => p.keyId);
    expect(firstIds.length).toBeGreaterThan(0);

    const second = await loadOrGenerateKeys(new FileStores('bot'));
    const secondIds = second.oneTimePrekeys.map((p) => p.keyId);

    // Not one id in common: the server's replaced pool contains only keys it
    // has never handed to anyone.
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(secondIds.length).toBe(firstIds.length);
  });

  it('KEEPS the old private halves on disk, so queued ciphertext still opens', async () => {
    const stores = new FileStores('bot');
    const first = await loadOrGenerateKeys(stores);
    const firstIds = first.oneTimePrekeys.map((p) => p.keyId);

    await loadOrGenerateKeys(new FileStores('bot'));

    // The whole reason rotation is safe: a sender who fetched one of these
    // before the re-registration still has a decryptable session, because we
    // added keys rather than overwriting them.
    const onDisk = new FileStores('bot').prekeys.ids();
    for (const id of firstIds) expect(onDisk).toContain(id);
  });

  it('does not touch the identity, signed or kyber keys', async () => {
    const first = await loadOrGenerateKeys(new FileStores('bot'));
    const second = await loadOrGenerateKeys(new FileStores('bot'));

    // The identity key IS the account and is immutable server-side; the signed
    // and kyber prekeys are long-lived and re-advertising them is correct.
    expect(second.identityKey).toBe(first.identityKey);
    expect(second.registrationId).toBe(first.registrationId);
    expect(second.signedPrekey).toEqual(first.signedPrekey);
    expect(second.kyberPrekey).toEqual(first.kyberPrekey);
  });

  it('never reissues an id whose key was CONSUMED and deleted', async () => {
    // The trap the first version of this fix walked into. libsignal deletes a
    // one-time prekey the moment it is used, so the highest id ON DISK walks
    // backwards — and an id derived from the directory alone would hand the
    // consumed id out again under a different key. A peer holding the old
    // bundle would then send against an id the store answers with the wrong
    // key, and the message would never open.
    const stores = new FileStores('bot');
    const first = await loadOrGenerateKeys(stores);
    const top = Math.max(...first.oneTimePrekeys.map((p) => p.keyId));

    // Consume the HIGHEST one, exactly as a decrypt would.
    await stores.prekeys.removePreKey(top);
    expect(stores.prekeys.ids()).not.toContain(top);

    const second = await loadOrGenerateKeys(new FileStores('bot'));
    expect(second.oneTimePrekeys.map((p) => p.keyId)).not.toContain(top);
  });

  it('never offers an id under a second key across several registrations', async () => {
    // NARROWED at an earlier revision, and the narrowing is the point. This asserted that
    // no id EVER appeared in two payloads — a proxy for F1, not F1 itself.
    // What destroys a message is the server being able to hand ONE one-time
    // prekey to TWO senders, which needs the id to come back under a DIFFERENT
    // key, or to come back at all after the server has been serving it. An id
    // re-offered with the identical key, from a batch the unpublished marker
    // proves never reached the server, does neither: the server never had it,
    // so nobody holds a bundle for it, and the payload is its first publication.
    // The old assertion outlawed exactly the reuse that stops a failing retry
    // loop from burning 100 ids a minute (an earlier review).
    const seen = new Map<number, string>();
    for (let run = 0; run < 3; run++) {
      const keys = await loadOrGenerateKeys(new FileStores('bot'));
      for (const p of keys.oneTimePrekeys) {
        const previous = seen.get(p.keyId);
        if (previous !== undefined) expect(p.pub).toBe(previous);
        seen.set(p.keyId, p.pub);
      }
    }
    // Still allocating upward, not recycling: three runs cannot collapse onto
    // one batch's worth of ids, or "reuse" would be hiding a stalled allocator.
    expect(seen.size).toBeGreaterThan(100);
  });
});

describe('rotation survives its own success (gate F1 verify round)', () => {
  // Two tests asserting pruning were REMOVED here (an earlier review): the pruning
  // they pinned deleted keys the server was still advertising — a rotation
  // that fails before `PUT /v1/keys` advances local generations while the
  // server pool is unchanged, so local generation count is not evidence about
  // the server. The no-pruning contract now lives in
  // gate.prekey-durability.test.ts; `rotateOneTimePrekeys` has the argument.

  it('never reissues an id under a new key, even after a decrypt consumed a file', async () => {
    // The high-water mark is what stops the allocator from walking backwards
    // into gaps left by consumed (libsignal-deleted) keys. Narrowed with the
    // test above: the id may recur only as the SAME unpublished batch being
    // re-offered, never under a key the previous payload did not carry.
    const first = await loadOrGenerateKeys(new FileStores('bot'));
    const seen = new Map<number, string>(first.oneTimePrekeys.map((p) => [p.keyId, p.pub]));
    // Consume one, exactly as a prekey decrypt does, so the allocator has a
    // hole below the mark to walk backwards into if it is going to.
    const stores = new FileStores('bot');
    const top = Math.max(...first.oneTimePrekeys.map((p) => p.keyId));
    await stores.prekeys.removePreKey(top);

    for (let run = 0; run < 5; run++) {
      const keys = await loadOrGenerateKeys(new FileStores('bot'));
      for (const p of keys.oneTimePrekeys) {
        // The consumed id is gone for good: its private half is deleted, so
        // any re-offer would be a new key under an id peers already hold.
        expect(p.keyId).not.toBe(top);
        const previous = seen.get(p.keyId);
        if (previous !== undefined) expect(p.pub).toBe(previous);
        seen.set(p.keyId, p.pub);
      }
    }
  });

  it('allocates a huge id space without a stack overflow', () => {
    // `Math.max(...ids)` is a SPREAD: every surviving id becomes a function
    // argument. Nothing prunes the directory any more, so iteration is the
    // only thing standing between an old account and that RangeError.
    const stores = new FileStores('bot');
    for (let i = 1; i <= 5000; i++) {
      // Touch files directly — cheaper than minting 5000 real keypairs.
      writeFileSync(join(stores.root, 'prekeys', `${i}.bin`), 'x');
    }
    expect(() => stores.prekeys.nextId()).not.toThrow();
    expect(stores.prekeys.nextId()).toBeGreaterThan(5000);
  });
});
