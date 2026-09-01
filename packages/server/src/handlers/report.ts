import { CreateReportRequest } from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import {
  errorResult,
  json,
  parseJson,
  rateLimitedResult,
  type AuthedHandler,
} from './http.js';

/**
 * POST /v1/reports — abuse reports.
 *
 * WHY THIS ENDPOINT EXISTS AT ALL, given the product's premise. App Store
 * guideline 1.2 requires apps with user-to-user content to offer a reporting
 * mechanism with timely responses, the ability to block, and published
 * contact information. End-to-end encryption is a complete answer to
 * "why don't you filter server-side" — it is not an answer to
 * "how do I report someone", and the first design was wrong to think
 * arguing the point would do instead.
 *
 * WHAT MAKES IT SAFE TO HAVE. The report is a deliberate act with a bounded
 * payload, not a tap on a wiretap:
 *
 * 1. **The reporter is the caller.** `reporterId` comes from the session,
 * never the body, so nobody can file a report as somebody else — which
 * would be a harassment primitive with the service's name on it.
 * 2. **Excerpts are optional and hand-picked.** The default report is
 * account plus category and contains no message text whatsoever. Nothing
 * in the client attaches anything automatically; the DTO caps the array
 * at five and each body at 2 000 characters so "report" can never quietly
 * become "upload this conversation".
 * 3. **No message ids, no ciphertext.** Deliberate, and the reason is
 * structural: an id would let this table be joined to the envelope the
 * relay already forwarded, recreating exactly the sender-recipient
 * linkage the architecture exists to prevent.
 * 4. **Self-reports are refused.** Not a safety rule — a garbage-in rule.
 * The only thing reporting yourself achieves is a row in a human's queue.
 * 5. **Write-only.** There is no read path, here or in the DataLayer. An
 * endpoint that could read a report back is an endpoint that discloses
 * who reported whom.
 *
 * WHAT IS NOT VERIFIED, ON PURPOSE. The reported account is not checked for
 * existence. A lookup would turn this into an account-enumeration oracle —
 * ask about an id, learn from the response whether it is real — and the cost
 * of accepting a report about a nonexistent id is one dead row that expires
 * on its own. Enumeration resistance is worth more than queue tidiness; the
 * users table deliberately has no index for the same reason.
 */
export const createReportHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`report:${auth.userId}`, LIMITS.reportCreate);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, CreateReportRequest);
  if (!parsed.ok) return parsed.result;
  const { reportedUserId, reason, excerpts } = parsed.data;

  if (reportedUserId === auth.userId) {
    return errorResult(400, 'invalid_request', 'cannot report your own account');
  }

  const now = deps.now();
  const rec = {
    reportId: deps.newReportId(),
    reporterId: auth.userId,
    reportedUserId,
    reason,
    // Omitted entirely rather than stored as an empty array, so a row with
    // no excerpts is visibly a row with no excerpts.
    ...(excerpts && excerpts.length > 0 ? { excerpts } : {}),
    createdAt: now,
    expiresAt: Math.floor(now / 1000) + REPORT_TTL_SECONDS,
  };
  await deps.db.putReport(rec);

  // NOT logged: reporterId, reportedUserId, reason, and obviously no excerpt.
  // A log line naming both parties would put the reporting relationship into
  // CloudWatch for ninety days — the one place it must not be, since the
  // whole point of a report is that the reported party never learns of it.
  // The opaque id alone is enough to find the row when a human goes looking.
  deps.log('report_created', { reportId: rec.reportId });

  return json(201, { reportId: rec.reportId });
};

/**
 * 180 days. Longer than any other retention here, and deliberately so: an
 * abuse queue that expired on the ordinary 30- or 90-day clock would drop
 * the pattern evidence that makes a repeat offender visible, which is the
 * only thing that distinguishes a moderation record from a complaint box.
 * Still bounded — an unbounded one would be the same mistake the attachment
 * access logs made.
 */
const REPORT_TTL_SECONDS = 180 * 24 * 3600;
