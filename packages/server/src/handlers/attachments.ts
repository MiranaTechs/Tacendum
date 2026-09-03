import { CreateAttachmentRequest } from '@tacendum/shared';
import { type AuthedHandler, errorResult, json, parseJson, rateLimitedResult } from './http.js';
import { LIMITS } from '../ratelimit.js';

/**
 * E2EE attachment blob endpoints (presigned-URL path). The server is a
 * dumb ciphertext store: the client encrypts media before upload and ships the
 * decryption key + digest to the recipient INSIDE the Signal-encrypted message,
 * so the blob, its key, and its metadata never meet server-side.
 *
 * Access model (Signal's CDN model): the 256-bit random attachment id is the
 * read capability — there is deliberately no sender/recipient binding in the
 * store, which would only add conversation metadata the design avoids. Both
 * routes still require a valid bearer token, and per-user token buckets bound
 * mint/fetch abuse.
 */

/** Server-minted ids are 32 random bytes base64url (43 chars) — see Deps. */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{43}$/;

/** The unit of the daily byte window (LIMITS.attachmentBytesDaily). */
const MIB = 1024 * 1024;

// POST /v1/attachments -> { attachmentId, uploadUrl }
export const createAttachmentHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`attach-create:${auth.userId}`, LIMITS.attachmentCreate);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, CreateAttachmentRequest);
  if (!parsed.ok) return parsed.result;

  // THE DAILY BYTE WINDOW: whole MiB per mint, so a day's uploads are
  // bounded in bytes and not only in count. Taken after the parse (the
  // length is what is charged) and before the signed PUT exists.
  const bytesRetry = await deps.rateLimit.take(
    `attach-bytes:${auth.userId}`,
    LIMITS.attachmentBytesDaily,
    Math.ceil(parsed.data.contentLength / MIB),
  );
  if (bytesRetry > 0) return rateLimitedResult(bytesRetry);

  const attachmentId = deps.newAttachmentId();
  const uploadUrl = await deps.attachments.uploadUrl(attachmentId, parsed.data.contentLength);
  // Metadata only: size is operationally useful; the id itself stays
  // out of the log so log access alone never grants blob access.
  deps.log('attachment_upload_url_minted', { contentLength: parsed.data.contentLength });
  return json(200, { attachmentId, uploadUrl });
};

// GET /v1/attachments/{attachmentId} -> { downloadUrl }
export const getAttachmentHandler: AuthedHandler = async (event, deps, auth) => {
  const attachmentId = event.pathParameters?.attachmentId;
  if (!attachmentId || !ATTACHMENT_ID.test(attachmentId)) {
    return errorResult(400, 'invalid_request', 'invalid attachment id');
  }

  const retry = await deps.rateLimit.take(`attach-fetch:${auth.userId}`, LIMITS.attachmentFetch);
  if (retry > 0) return rateLimitedResult(retry);

  // No existence probe: a URL for a missing blob 404s at the store, and a
  // HeadObject here would only add latency without changing the outcome.
  const downloadUrl = await deps.attachments.downloadUrl(attachmentId);
  return json(200, { downloadUrl });
};
