import { DEVICE_NOUN } from './deviceNoun';
import { apiCreateReport } from './api';
import type { ReportReason } from '@tacendum/shared';
import { currentToken } from './reauth';

/**
 * Abuse reporting.
 *
 * WHY THIS EXISTS IN A PRODUCT BUILT NOT TO READ MESSAGES. App Store
 * guideline 1.2 requires apps carrying user-to-user content to offer a way to
 * report, the ability to block, and published contact information. End-to-end
 * encryption is a complete answer to "why don't you filter server-side"; it is
 * not an answer to "how do I report someone". Blocking already exists
 * (`blocking.ts`) and is the stronger remedy — this is the weaker one that
 * reaches a human.
 *
 * THE ONE PLACE PLAINTEXT CAN LEAVE THIS DEVICE. Every other path sends
 * ciphertext the relay cannot read. This one can send message text, and the
 * design keeps that narrow rather than convenient:
 *
 * - Excerpts are OPTIONAL. `report(peerId, reason)` with nothing attached is a
 *   complete report, and it is the default the screen offers.
 * - Nothing is attached automatically. The caller passes exactly what a person
 *   selected; there is no "include recent messages" convenience, because a
 *   convenience is how a report becomes a transcript upload nobody consented
 *   to in the way they thought they did.
 * - Timestamps are coarsened to the hour before they leave. A precise `sentAt`
 *   would let the report be lined up against the relay's own delivery record;
 *   the hour is enough for a human deciding what happened, and not enough to
 *   correlate.
 * - No message ids and no ciphertext travel, ever. The wire type has no field
 *   for either (`CreateReportRequest`), so this is enforced by the schema
 *   rather than by remembering.
 */

/** What the caller hands over, in the app's own terms. */
export interface ReportDraft {
  reason: ReportReason;
  /**
   * Messages the person picked, one by one. Empty or absent is the normal
   * case and produces a report with no message content at all.
   */
  excerpts?: { body: string; direction: 'in' | 'out'; sentAt: number }[];
}

/** Server-side cap (`CreateReportRequest`), mirrored so the UI can stop a
 * person before a refusal rather than after one. */
export const MAX_REPORT_EXCERPTS = 5;

/** Milliseconds in an hour — the precision an excerpt's timestamp survives. */
const HOUR_MS = 3_600_000;

/**
 * Round down to the hour. Applied on THIS side of the wire on purpose: the
 * server never sees the precise value, so the coarsening is a property of what
 * is sent rather than a promise about what is stored.
 */
export function coarsenTimestamp(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * File the report. Returns the opaque id so the screen can show it — a person
 * who later writes to `hello@tacendum.com` can name their report without
 * quoting its contents back into an email.
 *
 * Throws on failure rather than swallowing: unlike the About-screen links,
 * this one the user must be told about. Silently dropping a report would be
 * worse than not offering the feature, because they would believe it landed.
 */
export async function report(
  peerId: string,
  draft: ReportDraft,
): Promise<string> {
  const token = await currentToken();
  // No session, no report. Throwing here rather than sending an unauthorized
  // request keeps the failure honest: the screen tells the person nothing
  // left the device, which is true, instead of surfacing a 401 they cannot
  // act on.
  if (!token) throw new Error('not signed in');

  const excerpts = (draft.excerpts ?? [])
    .slice(0, MAX_REPORT_EXCERPTS)
    .map((e) => ({
      body: e.body,
      direction: e.direction,
      sentAt: coarsenTimestamp(e.sentAt),
    }));

  const res = await apiCreateReport(token, {
    reportedUserId: peerId,
    reason: draft.reason,
    // Omitted rather than sent empty, so "no excerpts" is visibly that on the
    // wire and in the stored row.
    ...(excerpts.length > 0 ? { excerpts } : {}),
  });
  return res.reportId;
}

/**
 * The copy deck, in one place for the same reason `BLOCK_COPY` is: a consent
 * sentence that drifts between screens is a consent sentence nobody can be
 * held to.
 *
 * The tone rule these follow, and it is the whole point of the feature: say
 * what leaves the device, before the button, in words that do not need a
 * second reading. Nothing here promises an outcome — "we will look at it" is
 * a commitment to a process, not to a verdict, and promising a verdict is how
 * a moderation queue becomes a broken promise.
 */
export const REPORT_COPY = {
  title: 'Reporting',
  action: 'Report this person',
  /** Above the reason list, before anything is chosen. */
  intro:
    'A report goes to a person at Mirana who reads it. Blocking is the stronger move and takes effect immediately — reporting asks us to look.',
  reasonQuestion: 'What is happening?',
  reasons: [
    { value: 'harassment' as const, label: 'Harassment or threats' },
    { value: 'spam' as const, label: 'Spam' },
    { value: 'impersonation' as const, label: 'Pretending to be someone' },
    { value: 'child_safety' as const, label: 'Child safety' },
    { value: 'other' as const, label: 'Something else' },
  ],
  /**
   * The consent sentence. It names the default first — that nothing they
   * wrote is included — because the surprising fact is what has to be legible,
   * and the surprising fact in an encrypted messenger is that anything could
   * be sent at all.
   */
  attachIntro:
    'Your messages are not included. If you want us to see specific ones, choose them here — that text will be readable by us, and only what you choose is sent.',
  attachAction: 'Choose messages',
  attachNone: 'No messages attached',
  attachCount: (n: number) =>
    n === 1 ? '1 message attached' : `${n} messages attached`,
  attachLimit: `You can attach up to ${MAX_REPORT_EXCERPTS}.`,
  submit: 'Send report',
  cancel: 'Cancel',
  /** Confirms the process, not an outcome. */
  sentTitle: 'Report sent.',
  sentBody:
    'A person will read it. We will not tell them you reported them, and nothing about this appears in your room with them.',
  sentReference: (id: string) => `Reference ${id}`,
  sentBlockHint:
    'Reporting does not block them. If you want their messages discarded as they arrive, block them too.',
  // The device is named in the platform's
  // own words via the token. Same sentence, same guarantee, per device.
  failed: `The report was not sent. Nothing left your ${DEVICE_NOUN} — try again.`,
  /** Rate limit, said plainly rather than as an error code. */
  tooMany:
    'You have sent several reports recently. Wait a little before sending another.',
  announceSent: 'Report sent. A person will read it.',
} as const;
