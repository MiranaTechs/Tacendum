import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeS3Attachments, makeS3Client, readS3Config } from '../src/storage.js';

/**
 * Live blob-store round trip against local MinIO (docker-compose.yml): the
 * presigned PUT/GET pair the app uses, plus proof that the signed
 * Content-Length actually rejects a different-sized upload. Skips when MinIO
 * is unreachable (same posture as the DynamoDB Local integration suites).
 *
 * The store is read from the environment, exactly as the DynamoDB suites
 * read DDB_ENDPOINT: unset, S3_ENDPOINT is the compose MinIO on
 * localhost:9000; set, it is whatever MinIO a verification stood up on a
 * free port. The old `readS3Config({})` pinned localhost:9000 no matter what
 * was set, and on a Mac running Herd that port is php-fpm — so under
 * TACENDUM_REQUIRE_DDB=1 this file failed as a whole even with a reachable
 * throwaway MinIO beside the throwaway DynamoDB Local (2026-10-08 verify).
 */

const config = readS3Config();
const store = makeS3Attachments(makeS3Client(config), config.bucket);

let available = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${config.endpoint}/minio/health/live`);
    available = res.ok;
  } catch {
    available = false;
  }
  if (!available && process.env.TACENDUM_REQUIRE_DDB === '1') {
    // The docker-compose stack is one unit; if DDB is required, MinIO is too.
    throw new Error('TACENDUM_REQUIRE_DDB=1 but MinIO is unreachable');
  }
  if (!available) console.warn('[skip] MinIO not reachable; skipping attachment integration tests');
});

function freshId(): string {
  return randomBytes(32).toString('base64url');
}

describe('attachment blobs round-trip through MinIO', () => {
  it('presigned PUT stores the blob and presigned GET returns identical bytes', async (ctx) => {
    if (!available) ctx.skip();
    const id = freshId();
    const body = randomBytes(4096).toString('base64'); // base64 text, as the app uploads

    const uploadUrl = await store.uploadUrl(id, body.length);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    expect(put.status).toBe(200);

    const downloadUrl = await store.downloadUrl(id);
    const get = await fetch(downloadUrl);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(body);
  });

  it('rejects an upload whose size differs from the signed Content-Length', async (ctx) => {
    if (!available) ctx.skip();
    const id = freshId();
    const uploadUrl = await store.uploadUrl(id, 1000);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'x'.repeat(2000),
    });
    // Signature covers content-length, so a mismatched size fails auth.
    expect(put.status).toBeGreaterThanOrEqual(400);

    const downloadUrl = await store.downloadUrl(id);
    const get = await fetch(downloadUrl);
    expect(get.status).toBe(404); // nothing was stored
  });

  it('rejects an upload that claims a Content-Type other than the signed one', async (ctx) => {
    if (!available) ctx.skip();
    const id = freshId();
    const body = randomBytes(1024).toString('base64');
    const uploadUrl = await store.uploadUrl(id, body.length);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' }, // not what the URL signed
      body,
    });
    // Signature covers content-type, so the uploader cannot choose the type
    // the store (and the CDN in front of it) will later serve.
    expect(put.status).toBeGreaterThanOrEqual(400);

    const get = await fetch(await store.downloadUrl(id));
    expect(get.status).toBe(404); // nothing was stored
  });

  it('a download URL for an unknown id 404s at the store', async (ctx) => {
    if (!available) ctx.skip();
    const get = await fetch(await store.downloadUrl(freshId()));
    expect(get.status).toBe(404);
  });
});
