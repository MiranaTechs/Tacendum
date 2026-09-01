import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Deps } from './handlers/http.js';

/**
 * Presigned-URL attachment store shared by the local (MinIO) and Lambda (S3)
 * dependency factories — one implementation so the two hosts cannot drift.
 * Presigning is local signature work inside the AWS SDK — SigV4 for S3,
 * RSA-SHA1 for CloudFront — so no network call happens here, handler latency
 * is unaffected, and unit tests need no running store. It is inventoried:
 * the SDK performing its own primitive to authenticate US to AWS, over bytes
 * that are already libsignal ciphertext. "Pure signature math" was the older
 * phrasing and it read as though no cryptography were involved at all, which
 * is how these two calls once escaped the crypto inventory.
 */

/** Blobs live under one flat prefix; the random id carries all the entropy. */
export const ATTACHMENT_KEY_PREFIX = 'a/';

/** URLs are short-lived: long enough for a mobile upload on a slow link,
 * short enough that a leaked URL goes stale quickly. Also safely inside the
 * Lambda role's session lifetime, which caps presigned validity. */
export const ATTACHMENT_URL_TTL_SECONDS = 600;

/**
 * Blob-store configuration, injected via env like DynamoDB's (db/client.ts):
 * unset -> MinIO local defaults; the CDK stack sets S3_ENDPOINT='' (real S3)
 * plus the generated bucket name.
 */
export interface S3Config {
  region: string;
  endpoint: string | undefined;
  bucket: string;
}

export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config {
  const endpoint = env.S3_ENDPOINT ?? 'http://localhost:9000';
  const resolvedEndpoint = endpoint === '' ? undefined : endpoint;
  // The 'attachments' default only exists for the local MinIO bucket. Against
  // real S3 a defaulted global bucket name is a squatting hazard, so an unset
  // name fails fast — same posture as the empty TACENDUM_TABLE_* guard.
  const bucket = env.ATTACHMENTS_BUCKET ?? (resolvedEndpoint ? 'attachments' : '');
  if (!bucket) {
    throw new Error('ATTACHMENTS_BUCKET must be set when S3_ENDPOINT targets real S3');
  }
  return { region: env.AWS_REGION ?? 'us-east-1', endpoint: resolvedEndpoint, bucket };
}

export function makeS3Client(config: Pick<S3Config, 'region' | 'endpoint'>): S3Client {
  const isLocal = Boolean(config.endpoint);
  return new S3Client({
    region: config.region,
    // The SDK's default flexible-checksum behavior signs a CRC32 of the
    // (absent) command body into presigned PUTs — the empty-body checksum —
    // and real S3 then rejects the client's actual upload with BadDigest.
    // WHEN_REQUIRED drops the auto-checksum; integrity is covered end-to-end
    // by the AES-GCM tag, which is stronger than any transport CRC.
    // (verified by probe.)
    requestChecksumCalculation: 'WHEN_REQUIRED',
    // MinIO needs path-style addressing (no per-bucket DNS locally).
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    // docker-compose.yml MinIO root credentials; ignored fields in AWS where
    // the role's provider chain supplies real credentials.
    ...(isLocal
      ? { credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } }
      : {}),
  });
}

/**
 * CDN download signing: when all three env
 * values are present, downloads are CloudFront signed URLs on our own domain
 * instead of presigned S3 URLs on an *.s3.amazonaws.com host. Uploads stay
 * presigned S3 either way — routing the PUT path through the CDN waits on a
 * real-device probe of OAC's payload-hash behavior.
 */
export interface CdnConfig {
  /** e.g. files.tacendum.com — bare host, no scheme. */
  domain: string;
  /** CloudFront public-key id (the stack's AttachmentSigningKey). */
  keyPairId: string;
  /** Secrets Manager ARN whose `privateKeyPem` field holds the RSA key. */
  privateKeySecretArn: string;
}

/** All three set → CDN signing; none set → presigned S3 (local MinIO, and the
 * production rollback lever). A partial set is a misconfigured deploy and
 * fails fast rather than serving broken download URLs. */
export function readCdnConfig(env: NodeJS.ProcessEnv = process.env): CdnConfig | undefined {
  const domain = env.ATTACHMENTS_CDN_DOMAIN ?? '';
  const keyPairId = env.ATTACHMENTS_CDN_KEY_PAIR_ID ?? '';
  const privateKeySecretArn = env.ATTACHMENTS_CDN_PRIVATE_KEY_SECRET_ARN ?? '';
  if (!domain && !keyPairId && !privateKeySecretArn) return undefined;
  if (!domain || !keyPairId || !privateKeySecretArn) {
    throw new Error(
      'ATTACHMENTS_CDN_DOMAIN, ATTACHMENTS_CDN_KEY_PAIR_ID and ATTACHMENTS_CDN_PRIVATE_KEY_SECRET_ARN must be set together',
    );
  }
  return { domain, keyPairId, privateKeySecretArn };
}

/** Fetches the signing key once per container and caches the promise — a
 * cold start pays one Secrets Manager call, warm invocations pay none, and
 * concurrent first calls share the same fetch instead of racing. */
function makePrivateKeyLoader(secretArn: string): () => Promise<string> {
  const sm = new SecretsManagerClient({});
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= sm.send(new GetSecretValueCommand({ SecretId: secretArn })).then(res => {
      const parsed = JSON.parse(res.SecretString ?? '{}') as { privateKeyPem?: string };
      if (!parsed.privateKeyPem || !parsed.privateKeyPem.includes('BEGIN')) {
        // Reject the placeholder the stack creates — signing with it would
        // mint URLs CloudFront refuses, which reads as data loss to the app.
        throw new Error('attachment signing secret does not hold a private key yet');
      }
      return parsed.privateKeyPem;
    });
    // A failed fetch must not be cached forever: clear on rejection so the
    // next request retries instead of poisoning the container.
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };
}

export function makeS3Attachments(
  client: S3Client,
  bucket: string,
  cdn: CdnConfig | undefined = readCdnConfig(),
  // Injectable for tests; production uses the caching Secrets Manager loader.
  loadPrivateKey: (() => Promise<string>) | undefined = cdn
    ? makePrivateKeyLoader(cdn.privateKeySecretArn)
    : undefined,
): Deps['attachments'] {
  return {
    // ContentLength rides in the signature as a signed header, so the store
    // itself rejects an upload of any other size — the MAX_ATTACHMENT_BYTES
    // cap holds even against a client that ignores the API contract.
    // ContentType is signed for the same reason: the uploader must not choose
    // the type the store (and the CDN in front of it) later serves. Every
    // attachment body is client-side ciphertext, so this is defence in depth
    // for the header, not an XSS fix — nothing interpretable is stored either
    // way. The app already sends exactly this value (uploadBlob in
    // app/src/api.ts), so the pin changes nothing for honest clients.
    // `signableHeaders` is required: the S3 presigner treats content-type as
    // unsignable by default (browsers historically overrode it), so setting
    // ContentType on the command alone signs NOTHING — verified against the
    // generated URL's X-Amz-SignedHeaders.
    uploadUrl: (attachmentId, contentLength) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${ATTACHMENT_KEY_PREFIX}${attachmentId}`,
          ContentLength: contentLength,
          ContentType: 'application/octet-stream',
        }),
        {
          expiresIn: ATTACHMENT_URL_TTL_SECONDS,
          signableHeaders: new Set(['content-type']),
        },
      ),
    downloadUrl: async (attachmentId) => {
      if (cdn && loadPrivateKey) {
        return getCloudFrontSignedUrl({
          url: `https://${cdn.domain}/${ATTACHMENT_KEY_PREFIX}${attachmentId}`,
          keyPairId: cdn.keyPairId,
          privateKey: await loadPrivateKey(),
          dateLessThan: new Date(Date.now() + ATTACHMENT_URL_TTL_SECONDS * 1000).toISOString(),
        });
      }
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: `${ATTACHMENT_KEY_PREFIX}${attachmentId}`,
        }),
        { expiresIn: ATTACHMENT_URL_TTL_SECONDS },
      );
    },
  };
}
