import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStores } from '../src/stores.js';
import { loadOrGenerateKeys, signAuthChallenge } from '../src/messaging.js';

/**
 * Failed registrations must not grow the prekey store
 * without bound, and no fix for that may ever reclaim a key the server might
 * be advertising.
 *
 * The trigger: register once successfully, point the API at a closed port,
 * and retry `register` on a cron. Every attempt rotated a fresh batch of 100
 * one-time prekeys before the network ever answered, so each failure left
 * 100 orphaned private-key files — directory latency, inode exhaustion, and
 * eventually the id-space refusal that bricks registration for the identity.
 *
 * These tests assert OUTCOMES, not the reclaim mechanism: the on-disk count
 * stays bounded through a retry storm, any batch whose attempt reached an
 * auth signature survives everything, and every advertised id is answerable
 * from disk.
 *
 * CORRECTED at an earlier revision. This note used to add "upload payloads never repeat
 * an id", and to say that an implementation which bounded growth by REUSING
 * batches "would fail the never-reissue contract the wider gate suite pins".
 * That reading was the defect, not the guard: the earlier implementation it
 * blessed deleted the unpublished batch and then allocated 100 fresh ids in
 * its place, so a once-a-minute retry still exhausted the 24-bit id space in
 * ~116 days and left registration permanently refused. Reuse is now what
 * bounds this, and gate.prekeys.test.ts pins the invariant the repeat-ban was
 * a proxy for: an id may recur only carrying the identical public key, from a
 * batch the marker proves the server never received.
 *
 * MODELING NOTE. cmdRegister runs rotate -> signAuthChallenge -> upload
 * under register.lock (the order is load-bearing and pinned by comment in
 * main.ts). A closed port kills the attempt at the challenge fetch — after
 * rotation, before any signature — so:
 *   - a FAILED attempt is `loadOrGenerateKeys` alone;
 *   - a SIGNED attempt adds `signAuthChallenge`, the last local event before
 *     `PUT /v1/keys`. The tests deliberately do not distinguish "signed,
 *     upload failed" from "signed, upload succeeded": the client cannot
 *     either (a timed-out PUT may have been applied), so signed batches must
 *     be treated as published forever.
 */

const ORIGIN = 'https://api.test';
const CHALLENGE = Buffer.from('prekey-growth-fixed-challenge').toString('base64');

async function failedAttempt(name: string) {
  return loadOrGenerateKeys(new FileStores(name));
}

async function signedAttempt(name: string) {
  const stores = new FileStores(name);
  const keys = await loadOrGenerateKeys(stores);
  await signAuthChallenge(stores, CHALLENGE, ORIGIN);
  return keys;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-pkgrowth-'));
  process.env.TACENDUM_HOME = home;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('failed registrations do not grow the store without bound', () => {
  it('holds the key count at published + one pending batch through a retry storm', async () => {
    const published = await signedAttempt('bot');
    // The bound is the OUTCOME: whatever was ever signed for, plus at most
    // one not-yet-signed batch awaiting its first upload. Anything above it
    // means failures are accreting garbage — 100 files per cron tick.
    const bound = 2 * published.oneTimePrekeys.length;
    for (let i = 0; i < 4; i++) {
      await failedAttempt('bot');
      expect(new FileStores('bot').prekeys.count()).toBeLessThanOrEqual(bound);
    }
  });

  it('burns no ID SPACE either: the storm re-offers one batch, it does not mint one', async () => {
    // ADDED at an earlier revision, because the file-count bound above passed while the
    // defect was live. An earlier revision bounded the count by DELETING the unpublished
    // batch and allocating 100 fresh ids in its place, so a once-a-minute
    // retry still walked the durable high-water mark through the 24-bit space
    // in ~116 days — after which `rotateOneTimePrekeys` refuses forever, and
    // the account cannot register again even once the endpoint recovers. The
    // id mark, not the file count, is the exhaustible resource.
    await signedAttempt('bot');
    const pending = await failedAttempt('bot');
    const mark = new FileStores('bot').prekeys.nextId();

    for (let i = 0; i < 10; i++) {
      const retry = await failedAttempt('bot');
      // Byte-identical: the same ids carrying the same public halves. Any
      // difference is a fresh allocation wearing the word "reuse".
      expect(retry.oneTimePrekeys).toEqual(pending.oneTimePrekeys);
    }
    expect(new FileStores('bot').prekeys.nextId()).toBe(mark);
  });

  it('recovers after the storm: fresh ids, all answerable, storm garbage gone', async () => {
    const first = await signedAttempt('bot');
    for (let i = 0; i < 3; i++) await failedAttempt('bot');
    const final = await signedAttempt('bot');

    const held = new FileStores('bot').prekeys.ids();
    // Every id this upload advertises has its private half on disk — an
    // advertised id with no key is a message that decrypt-fails and is acked
    // away as poison.
    for (const p of final.oneTimePrekeys) expect(held).toContain(p.keyId);
    // No id is ever seen twice across upload payloads (the F1 contract):
    // a repeat under a different key gives two senders the same prekey, and
    // the second message can never open.
    const firstIds = new Set(first.oneTimePrekeys.map((p) => p.keyId));
    for (const p of final.oneTimePrekeys) expect(firstIds.has(p.keyId)).toBe(false);
    // Both signed batches survive; the storm's failed batches do not stack.
    expect(held.length).toBeLessThanOrEqual(3 * final.oneTimePrekeys.length);
  });
});

describe('a batch whose attempt reached the auth signature is never reclaimed', () => {
  it('signed batches survive a storm of later failures', async () => {
    // Two registrations that got as far as signing — the server may be
    // advertising either batch, or holding handed-out bundles from both.
    const gen = await signedAttempt('bot');
    const rotated = await signedAttempt('bot');

    for (let i = 0; i < 3; i++) await failedAttempt('bot');

    const held = new FileStores('bot').prekeys.ids();
    for (const p of gen.oneTimePrekeys) expect(held).toContain(p.keyId);
    for (const p of rotated.oneTimePrekeys) expect(held).toContain(p.keyId);
  });
});

describe('the reclaim record can only ever cost bytes, never keys', () => {
  // Both tests write the record file directly. If the implementation renames
  // it these injections become inert junk files and the assertions still
  // hold, so the tests degrade to vacuous-but-green — noted so a reviewer of
  // a rename knows to re-point them.

  it('a torn (corrupt) record licenses deleting nothing', async () => {
    const published = await signedAttempt('bot');
    const pending = await failedAttempt('bot');
    writeFileSync(join(new FileStores('bot').root, 'prekeys-unpublished.json'), '{"ids": torn');

    // Must neither throw nor delete: corrupt evidence reclaims nothing.
    const after = await failedAttempt('bot');
    const held = new FileStores('bot').prekeys.ids();
    for (const p of published.oneTimePrekeys) expect(held).toContain(p.keyId);
    // The batch the corrupt record orphaned leaks — bytes, the safe direction.
    for (const p of pending.oneTimePrekeys) expect(held).toContain(p.keyId);
    for (const p of after.oneTimePrekeys) expect(held).toContain(p.keyId);
  });

  it('ANY auth signature after a batch is minted makes it unreclaimable', async () => {
    // A session token renewal (session.ts) signs a challenge too, and a
    // signature is the raw material of a token — after one exists, "no upload
    // could have followed this batch" is no longer provable, whoever asked
    // for it. An implementation that keyed reclaim rights to registration's
    // OWN signature would delete this batch here and stake a message on the
    // difference between two callers it cannot actually tell apart.
    await signedAttempt('bot');
    const pending = await failedAttempt('bot');
    // The renewal, with no rotation attached.
    await signAuthChallenge(new FileStores('bot'), CHALLENGE, ORIGIN);

    await failedAttempt('bot');
    const held = new FileStores('bot').prekeys.ids();
    // Kept: the signed-for batch is possibly published forever. The cost is
    // one batch of bytes per renewal that interleaves a retry storm — the
    // safe direction.
    for (const p of pending.oneTimePrekeys) expect(held).toContain(p.keyId);
  });
});
