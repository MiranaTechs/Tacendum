import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, LibSignalErrorBase } from '@signalapp/libsignal-client';
import type { PrekeyBundle } from '@tacendum/shared';

// The CLI stores read $TACENDUM_HOME at call time — point it at a temp dir
// before importing the modules that resolve store paths.
const home = mkdtempSync(join(tmpdir(), 'tacendum-safety-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, computeSafetyNumber, isIdentityChange } =
  await import('../src/messaging.js');

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

describe('safety numbers', () => {
  it('are symmetric: the same 60-digit number on both ends of a session', async () => {
    const aliceStores = new FileStores('alice');
    const bobStores = new FileStores('bob');
    const aliceUpload = await generateAndStoreKeys(aliceStores);
    const bobUpload = await generateAndStoreKeys(bobStores);

    // Each pins the other's identity (establishes a session).
    await establishSession(aliceStores, ALICE, bundleFrom(BOB, bobUpload));
    await establishSession(bobStores, BOB, bundleFrom(ALICE, aliceUpload));

    const snAliceView = await computeSafetyNumber(aliceStores, ALICE, BOB);
    const snBobView = await computeSafetyNumber(bobStores, BOB, ALICE);

    expect(snAliceView).not.toBeNull();
    expect(snAliceView).toHaveLength(60);
    expect(snAliceView).toBe(snBobView); // identical on both devices
  });

  it('returns null before a peer identity is pinned', async () => {
    const stores = new FileStores('lonely');
    await generateAndStoreKeys(stores);
    expect(await computeSafetyNumber(stores, 'self', 'never-met')).toBeNull();
  });
});

describe('identity-change detection', () => {
  it('recognizes an UntrustedIdentity libsignal error and nothing else', () => {
    const changed = new LibSignalErrorBase('peer key changed', 'UntrustedIdentity', 'decrypt');
    expect(changed.code).toBe(ErrorCode.UntrustedIdentity);
    expect(isIdentityChange(changed)).toBe(true);

    expect(isIdentityChange(new Error('some other failure'))).toBe(false);
    expect(isIdentityChange(new LibSignalErrorBase('dup', 'DuplicatedMessage', 'decrypt'))).toBe(
      false,
    );
  });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

beforeAll(() => {
  /* home is created above at import time */
});
