// A photo waiting for a look before it sends.
//
// The pure half, deliberately: the state machine and the size estimate, with
// no React and no picker in it, so the fragile screen holds the panel and
// nothing else. Import direction is one-way — this module reads `../media`
// for its two types and imports nothing from `../screens/`.
import { type PickedImage, type PickSource } from '../media';

/**
 * The three states a picked photo can be in, and no fourth.
 *
 * `none` is the ordinary composer. `review` is a photo on screen with the
 * decision still open. `sending` is that same photo committed — kept as its
 * own state rather than a boolean beside the bytes, because the two
 * questions a render asks ("is there a photo?" and "has it gone?") must not
 * be able to disagree, and because a second press of Send while the first is
 * in flight is exactly how a photo gets sent twice.
 *
 * The bytes ride INSIDE the state. That is what makes discarding total: one
 * assignment drops the photo and the base64 together, and there is no second
 * place holding a copy for a later render to find.
 */
export type PhotoReview =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'review';
      readonly picked: PickedImage;
      readonly source: PickSource;
    }
  | {
      readonly kind: 'sending';
      readonly picked: PickedImage;
      readonly source: PickSource;
    };

/** The empty state, shared: `discardReview()` returns this exact object, so
 * a render can compare by identity as well as by kind. */
export const NO_PHOTO_REVIEW: PhotoReview = { kind: 'none' };

/**
 * How tall the photo may draw in the panel.
 *
 * Smaller than `t.layout.photoMaxHeight` (320, the bubble's ceiling) on
 * purpose: this frame sits where the composer sits, above a keyboard, and it
 * has to leave the two controls and the size line on screen at accessibility
 * text sizes. It is a look, not the viewer — the full picture is a tap away
 * once it has sent.
 */
export const PHOTO_REVIEW_MAX_HEIGHT = 200;

/** A successful pick, waiting for a decision. */
export function reviewPicked(
  picked: PickedImage,
  source: PickSource,
): PhotoReview {
  return { kind: 'review', picked, source };
}

/**
 * The decision to send. A no-op from every other state: from `none` there
 * are no bytes to send, and from `sending` the send is already under way —
 * neither can be turned into a send by asking twice.
 */
export function reviewSending(current: PhotoReview): PhotoReview {
  if (current.kind !== 'review') return current;
  return { kind: 'sending', picked: current.picked, source: current.source };
}

/** Nothing under review, and no bytes retained. */
export function discardReview(): PhotoReview {
  return NO_PHOTO_REVIEW;
}

/**
 * Discard, REFUSED once the send is under way.
 *
 * The panel stays up while the photo goes, and its ✕ used to be the one
 * control on it with no guard: pressing it dropped the panel and stopped
 * nothing, so the person who pressed "Discard" then watched that photo
 * arrive in the thread. There is no way to un-send from here — the bytes
 * are already with `messaging` — so the honest answer is that the control
 * is unavailable, in the state machine as well as on the screen.
 */
export function discardUnlessSending(current: PhotoReview): PhotoReview {
  if (current.kind === 'sending') return current;
  return NO_PHOTO_REVIEW;
}

/**
 * The shape of the picture, for a frame that is a MAXIMUM rather than a
 * fixed height: a wide, short photo then takes only the height it needs and
 * gives the rest back to the size line and the two controls.
 *
 * A picker that answered with no dimensions gets a square. `0` and `NaN`
 * both reach here from a decoder that could not read the header, and a
 * `NaN` aspect ratio takes the whole panel's layout down with it.
 */
export function photoAspect(picked: PickedImage): number {
  const { width, height } = picked;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  if (width <= 0 || height <= 0) return 1;
  return width / height;
}

/**
 * Whether "Take another" belongs on this panel: a camera pick still awaiting
 * a decision. A library pick has no take to repeat — its second choice is
 * the picker again, which the ✕ and the + already reach — and a photo
 * already going out is past the offer.
 */
export function offersRetake(current: PhotoReview): boolean {
  return current.kind === 'review' && current.source === 'camera';
}

/**
 * The bytes this photo will send at, from the base64 it is carried in.
 *
 * base64 packs three bytes into four characters, and the trailing `=` are
 * padding standing in for bytes that are not there — so the count is exact,
 * not an estimate, once the padding is dropped. It is also the ONLY number
 * that cannot be a lie: `width`/`height` describe the picture, and the
 * sender's own idea of a file size describes the file before the picker
 * re-encoded it.
 */
export function photoBytes(base64: string): number {
  let end = base64.length;
  while (end > 0 && base64[end - 1] === '=') end -= 1;
  return Math.floor((end * 3) / 4);
}

/**
 * That size as whole kilobytes, for the one line the panel shows.
 *
 * Floored at 1: a photo small enough to round to zero is still a photo, and
 * "About 0 KB" reads as a failure rather than a small picture. 1024 to the
 * kilobyte, the same arithmetic `formatBytes` uses for a document.
 */
export function photoKilobytes(base64: string): number {
  const bytes = photoBytes(base64);
  if (bytes === 0) return 0;
  return Math.max(1, Math.round(bytes / 1024));
}
