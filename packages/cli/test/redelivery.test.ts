import { describe, expect, it } from 'vitest';
import { ErrorCode, LibSignalErrorBase } from '@signalapp/libsignal-client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrekeyBundle } from '@tacendum/shared';

const home = mkdtempSync(join(tmpdir(), 'tacendum-redelivery-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText, decryptEnvelope } = await import(
  '../src/messaging.js'
);

const ALICE = '01ALICEALICEALICEALICEALIC';
const BOB = '01BOBBOBBOBBOBBOBBOBBOBBOB';

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
): PrekeyBundle {
  return {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: upload.oneTimePrekeys[0],
  };
}

/**
 * Why the `call.offer` ack is NOT deferred.
 *
 * The reducer contract originally specified holding the offer's ack until the call reached a
 * terminal state, so that "the WS drain re-delivers the offer on relaunch"
 * and a phone killed while ringing could still substantiate its CallKit UI.
 *
 * That premise requires the redelivered ciphertext to be decryptable a second
 * time. It is not: `decryptEnvelope` advances the Double Ratchet and destroys
 * the message key before the plaintext is ever persisted, and libsignal
 * rejects the duplicate. In the app the rejection is indistinguishable from
 * tamper, so it takes the branch that writes a VISIBLE error row into the
 * conversation — the deferred ack would have manufactured one of those on
 * every reconnect during a 60-second ring.
 *
 * The offer is therefore acked on receipt like every other call envelope, and
 * the cold-launch case is served by persisting the decrypted offer instead
 * (`db.saveCallOffer`). This test is the reason that decision stands; if
 * libsignal ever tolerated duplicates, it would fail and that contract could be
 * revisited.
 */
describe('Double Ratchet redelivery', () => {
  it('cannot decrypt the same ciphertext twice, so an unacked offer is unrecoverable', async () => {
    const aliceStores = new FileStores('alice-rd');
    const bobStores = new FileStores('bob-rd');
    const aliceUpload = await generateAndStoreKeys(aliceStores);
    const bobUpload = await generateAndStoreKeys(bobStores);
    await establishSession(aliceStores, ALICE, bundleFrom(BOB, bobUpload));
    await establishSession(bobStores, BOB, bundleFrom(ALICE, aliceUpload));

    const offer = JSON.stringify({ tcm: 'call.offer', cid: 'C', sdp: 'v=0' });
    const { msgType, payload } = await encryptText(aliceStores, ALICE, BOB, offer);

    // First delivery: fine.
    expect(await decryptEnvelope(bobStores, BOB, ALICE, msgType, payload)).toBe(offer);

    // The server redelivering an unacked row hands over the identical bytes.
    // Asserted by libsignal ERROR CODE, not by message text: the point is that
    // the ratchet refuses a duplicate, and a bare `.toThrow()` would also pass
    // if the store had simply gone missing.
    const err = await decryptEnvelope(bobStores, BOB, ALICE, msgType, payload).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LibSignalErrorBase);
    expect((err as LibSignalErrorBase).code).toBe(ErrorCode.DuplicatedMessage);
  });
});
