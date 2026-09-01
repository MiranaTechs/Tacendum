import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@tacendum/shared';
import { createAttachmentHandler, getAttachmentHandler } from '../src/handlers/attachments.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import { LIMITS } from '../src/ratelimit.js';
import {
  ATTACHMENT_KEY_PREFIX,
  makeS3Attachments,
  makeS3Client,
  readS3Config,
} from '../src/storage.js';
import {
  jsonPost,
  makeMemoryDb,
  makeTestDeps,
  parseBody,
  testAttachmentId,
  type TestDeps,
} from './helpers.js';

const USER = 'user-under-test';

function auth(userId = USER): AuthContext {
  return { userId };
}

function fetchEvent(attachmentId: string | undefined): HttpEvent {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    ...(attachmentId !== undefined ? { pathParameters: { attachmentId } } : {}),
  };
}

describe('attachments — presigned blob endpoints', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeTestDeps(makeMemoryDb());
  });

  it('create mints a fresh id and an upload URL for the exact length (200)', async () => {
    const res = await createAttachmentHandler(jsonPost({ contentLength: 1234 }), deps, auth());
    expect(res.statusCode).toBe(200);
    const body = parseBody<{ attachmentId: string; uploadUrl: string }>(res.body);
    expect(body.attachmentId).toBe(testAttachmentId(1));
    expect(body.uploadUrl).toBe(`https://blobs.test/put/${testAttachmentId(1)}?len=1234`);
  });

  it('create rejects a malformed body (400 invalid_request)', async () => {
    for (const body of [{}, { contentLength: 'big' }, { contentLength: 10.5 }]) {
      const res = await createAttachmentHandler(jsonPost(body), deps, auth());
      expect(res.statusCode).toBe(400);
    }
  });

  it('create rejects zero, negative, and over-cap lengths (400)', async () => {
    for (const contentLength of [0, -1, MAX_ATTACHMENT_BYTES + 1]) {
      const res = await createAttachmentHandler(jsonPost({ contentLength }), deps, auth());
      expect(res.statusCode).toBe(400);
    }
    const ok = await createAttachmentHandler(
      jsonPost({ contentLength: MAX_ATTACHMENT_BYTES }),
      deps,
      auth(),
    );
    expect(ok.statusCode).toBe(200);
  });

  it('create logs the size but never the attachment id (log-hygiene posture)', async () => {
    await createAttachmentHandler(jsonPost({ contentLength: 99 }), deps, auth());
    const entry = deps.logs.find((l) => l.event === 'attachment_upload_url_minted');
    expect(entry?.fields).toEqual({ contentLength: 99 });
    expect(JSON.stringify(deps.logs)).not.toContain(testAttachmentId(1));
  });

  it('create is rate limited per user (429 with retry-after)', async () => {
    for (let i = 0; i < LIMITS.attachmentCreate.capacity; i++) {
      const res = await createAttachmentHandler(jsonPost({ contentLength: 1 }), deps, auth());
      expect(res.statusCode).toBe(200);
    }
    const limited = await createAttachmentHandler(jsonPost({ contentLength: 1 }), deps, auth());
    expect(limited.statusCode).toBe(429);
    expect(limited.headers?.['retry-after']).toBeDefined();
    // A different user still has a full bucket.
    const other = await createAttachmentHandler(
      jsonPost({ contentLength: 1 }),
      deps,
      auth('other'),
    );
    expect(other.statusCode).toBe(200);
  });

  it('fetch returns a download URL for a well-formed id (200)', async () => {
    const id = testAttachmentId(7);
    const res = await getAttachmentHandler(fetchEvent(id), deps, auth());
    expect(res.statusCode).toBe(200);
    expect(parseBody(res.body)).toEqual({ downloadUrl: `https://blobs.test/get/${id}` });
  });

  it('fetch rejects a missing or malformed id before touching the store (400)', async () => {
    for (const id of [undefined, '', 'short', 'has/slash'.padEnd(43, 'a'), 'a'.repeat(44)]) {
      const res = await getAttachmentHandler(fetchEvent(id), deps, auth());
      expect(res.statusCode).toBe(400);
    }
  });

  it('fetch is rate limited per caller (429)', async () => {
    const id = testAttachmentId(1);
    for (let i = 0; i < LIMITS.attachmentFetch.capacity; i++) {
      const res = await getAttachmentHandler(fetchEvent(id), deps, auth());
      expect(res.statusCode).toBe(200);
    }
    const limited = await getAttachmentHandler(fetchEvent(id), deps, auth());
    expect(limited.statusCode).toBe(429);
  });
});

describe('attachments — S3 presigner (offline signature math, no store needed)', () => {
  const client = makeS3Client({ region: 'us-east-1', endpoint: 'http://localhost:9000' });
  const store = makeS3Attachments(client, 'attachments');

  it('upload URL pins the exact Content-Length as a signed header', async () => {
    const url = new URL(await store.uploadUrl(testAttachmentId(1), 4321));
    expect(url.pathname).toBe(`/attachments/${ATTACHMENT_KEY_PREFIX}${testAttachmentId(1)}`);
    // content-length in X-Amz-SignedHeaders means the store enforces the size:
    // a PUT with any other length fails signature validation.
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('upload URL pins application/octet-stream as a signed Content-Type', async () => {
    // O8: with content-type in X-Amz-SignedHeaders, the uploader cannot pick
    // the type the object is later served with — defence in depth for the CDN
    // path. (Attachment bodies are client-side ciphertext, so no interpretable
    // HTML can be produced either way; this closes the header, not an XSS.)
    const url = new URL(await store.uploadUrl(testAttachmentId(1), 4321));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
  });

  it('upload URL carries no SDK auto-checksum (real S3 would reject the body)', async () => {
    // The SDK's flexible-checksum default signs a CRC32 of the EMPTY command
    // body into the URL; the client's real upload then fails BadDigest on S3.
    const url = new URL(await store.uploadUrl(testAttachmentId(1), 4321));
    for (const key of url.searchParams.keys()) {
      expect(key.toLowerCase()).not.toContain('checksum');
    }
    expect(url.searchParams.get('X-Amz-SignedHeaders')).not.toContain('checksum');
  });

  it('download URL signs a GET for the same key without a length pin', async () => {
    const url = new URL(await store.downloadUrl(testAttachmentId(1)));
    expect(url.pathname).toBe(`/attachments/${ATTACHMENT_KEY_PREFIX}${testAttachmentId(1)}`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});

describe('attachments — S3 config guard', () => {
  it('defaults to local MinIO when unset', () => {
    const cfg = readS3Config({});
    expect(cfg).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      bucket: 'attachments',
    });
  });

  it('fails fast when pointed at real S3 without a bucket name', () => {
    expect(() => readS3Config({ S3_ENDPOINT: '' })).toThrow(/ATTACHMENTS_BUCKET/);
  });

  it('accepts the AWS shape: empty endpoint + explicit bucket', () => {
    const cfg = readS3Config({ S3_ENDPOINT: '', ATTACHMENTS_BUCKET: 'real-bucket' });
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.bucket).toBe('real-bucket');
  });
});
