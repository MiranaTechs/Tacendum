import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_KEY_PREFIX,
  ATTACHMENT_URL_TTL_SECONDS,
  makeS3Attachments,
  makeS3Client,
  readCdnConfig,
} from '../src/storage.js';

/**
 * Phase A: with CDN config, downloads are CloudFront
 * signed URLs on our host; without it, everything presigns against S3
 * exactly as before. Uploads presign against S3 in BOTH modes — the PUT
 * migration is Phase B and must not leak in here by accident.
 */

const CDN = {
  domain: 'files.tacendum.com',
  keyPairId: 'K2TESTKEYPAIRID',
  privateKeySecretArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:test',
};

// A real key: cloudfront-signer does real RSA-SHA1 signing, and a fake PEM
// would only prove we can catch a parse error.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const client = makeS3Client({ region: 'us-east-1', endpoint: 'http://localhost:9000' });

describe('readCdnConfig', () => {
  it('is undefined when nothing is set (local MinIO and the rollback lever)', () => {
    expect(readCdnConfig({})).toBeUndefined();
  });

  it('returns the config when all three are set', () => {
    expect(
      readCdnConfig({
        ATTACHMENTS_CDN_DOMAIN: CDN.domain,
        ATTACHMENTS_CDN_KEY_PAIR_ID: CDN.keyPairId,
        ATTACHMENTS_CDN_PRIVATE_KEY_SECRET_ARN: CDN.privateKeySecretArn,
      }),
    ).toEqual(CDN);
  });

  it('a partial set is a misconfigured deploy and throws', () => {
    expect(() => readCdnConfig({ ATTACHMENTS_CDN_DOMAIN: CDN.domain })).toThrow(/together/);
  });
});

describe('download URLs', () => {
  it('without CDN config: presigned S3, unchanged', async () => {
    const store = makeS3Attachments(client, 'attachments', undefined);
    const url = new URL(await store.downloadUrl('blob-id'));
    expect(url.host).toBe('localhost:9000');
    expect(url.pathname).toBe(`/attachments/${ATTACHMENT_KEY_PREFIX}blob-id`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('with CDN config: a CloudFront signed URL on our domain', async () => {
    const store = makeS3Attachments(client, 'attachments', CDN, async () => PRIVATE_PEM);
    const url = new URL(await store.downloadUrl('blob-id'));
    expect(url.host).toBe(CDN.domain);
    expect(url.pathname).toBe(`/${ATTACHMENT_KEY_PREFIX}blob-id`);
    // Canned-policy signature triplet — what CloudFront validates at the edge.
    expect(url.searchParams.get('Key-Pair-Id')).toBe(CDN.keyPairId);
    expect(url.searchParams.get('Signature')).toBeTruthy();
    const expires = Number(url.searchParams.get('Expires'));
    const now = Math.floor(Date.now() / 1000);
    expect(expires).toBeGreaterThan(now);
    expect(expires).toBeLessThanOrEqual(now + ATTACHMENT_URL_TTL_SECONDS + 5);
  });

  it('a failed key load surfaces as a rejection, not a broken URL', async () => {
    const store = makeS3Attachments(client, 'attachments', CDN, async () => {
      throw new Error('secret not populated');
    });
    await expect(store.downloadUrl('blob-id')).rejects.toThrow('secret not populated');
  });
});

describe('upload URLs', () => {
  it('always presign against S3, in both modes (Phase B is gated)', async () => {
    for (const cdn of [undefined, CDN]) {
      const store = makeS3Attachments(client, 'attachments', cdn, async () => PRIVATE_PEM);
      const url = new URL(await store.uploadUrl('blob-id', 1024));
      expect(url.host).toBe('localhost:9000');
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    }
  });
});
