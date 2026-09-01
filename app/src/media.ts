import {
  launchCamera,
  launchImageLibrary,
  type ImagePickerResponse,
  type PhotoQuality,
} from 'react-native-image-picker';
import { MAX_ATTACHMENT_BYTES } from '@tacendum/shared';

/**
 * One place where photos enter the app. The two sending entry points (a
 * message photo and a profile picture) downscale here, because everything
 * picked that way is encrypted and shipped whole — an unbounded pick is a
 * memory and bandwidth problem before it is ever a product one.
 *
 * `pickImageFile` is the exception, and the reason it is a separate function:
 * a photo picked to be *read* rather than sent must not be downscaled at all.
 */

export type PickSource = 'library' | 'camera';

export interface PickedImage {
  base64: string;
  width: number;
  height: number;
}

export interface PickOptions {
  /** Longest edge after downscaling. */
  maxEdge: number;
  /** JPEG quality, 0-1. */
  quality: PhotoQuality;
}

/** A message photo: big enough to fill a bubble and open full-screen. */
export const MESSAGE_PHOTO: PickOptions = { maxEdge: 1440, quality: 0.7 };

/** A profile picture is only ever shown small, and it ships to every peer. */
export const AVATAR_PHOTO: PickOptions = { maxEdge: 512, quality: 0.8 };

export class PickCancelled extends Error {}

/**
 * iOS refused access to the photo library or the camera. Carries which one so
 * the screen can name the right permission — and offer Settings, which is the
 * only place the person can actually change it.
 */
export class PickDenied extends Error {
  constructor(public source: PickSource) {
    super('denied');
  }
}

/** There is no camera to open (Simulator, or hardware restrictions). */
export class PickUnavailable extends Error {}

/**
 * Returns the picked image, or throws: PickCancelled when the person backed
 * out (callers ignore it), PickDenied/PickUnavailable for the two conditions a
 * person can act on, and a plain Error otherwise. The thrown text is never
 * shown — callers map the class to copy.
 */
export async function pickImage(
  source: PickSource,
  options: PickOptions,
): Promise<PickedImage> {
  const shared = {
    mediaType: 'photo' as const,
    includeBase64: true,
    maxWidth: options.maxEdge,
    maxHeight: options.maxEdge,
    quality: options.quality,
    selectionLimit: 1,
  };
  const result: ImagePickerResponse =
    source === 'library'
      ? await launchImageLibrary(shared)
      : await launchCamera({ ...shared, saveToPhotos: false });

  if (result.didCancel) throw new PickCancelled();
  // Classified BEFORE the asset check: a denial and an unreadable file arrive
  // the same way (no asset), and telling someone their photo is broken when
  // the app was never allowed to look at it sends them nowhere useful.
  if (result.errorCode === 'permission') throw new PickDenied(source);
  if (result.errorCode === 'camera_unavailable') throw new PickUnavailable();
  const asset = result.assets?.[0];
  if (!asset?.base64 || !asset.width || !asset.height) {
    // Fixed, not `result.errorMessage`: the picker's message is a raw platform
    // string, and this was the last path by which one could reach a screen.
    throw new Error('photo unreadable');
  }
  // The picker's resize is a request, not a guarantee (it won't re-encode
  // some formats), so the cap is enforced here rather than trusted.
  if (asset.base64.length > MAX_ATTACHMENT_BYTES - 64) {
    throw new Error('That photo is too large to send.');
  }
  return { base64: asset.base64, width: asset.width, height: asset.height };
}

/**
 * A picked file, exactly as the library holds it — no resize, no re-encode,
 * no base64. Reading a QR is the one job where the picker's convenience
 * downscale is the failure: 1440px at JPEG quality 0.7 smears the module
 * edges of a dense code until Vision cannot binarise it. This path hands the
 * original file across as a URI and lets the native side read the pixels.
 */
export interface PickedFile {
  /** file:// URI of the library's copy in tmp. */
  uri: string;
  width: number;
  height: number;
}

/**
 * Above this many pixels a picture is refused rather than decoded. The native
 * side bounds this again from the file's properties; this is the cheap check,
 * before anything is allocated.
 */
export const QR_MAX_PIXELS = 80_000_000;

/** Above this many bytes, likewise. */
export const QR_MAX_BYTES = 64 * 1024 * 1024;

/** The picked file is beyond what we will try to read. */
export class PickTooLarge extends Error {}

/**
 * Pick one photo and return where it is, not what is in it. Throws the same
 * classes as pickImage — PickCancelled when the person backed out (callers
 * ignore it), PickDenied for a permission the person can act on — plus
 * PickTooLarge, and a plain Error otherwise.
 */
export async function pickImageFile(source: PickSource): Promise<PickedFile> {
  const shared = {
    mediaType: 'photo' as const,
    // No maxWidth, no maxHeight, no quality: every one of those makes the
    // picker re-encode, and a re-encoded QR is the thing this exists to avoid.
    includeBase64: false,
    includeExtra: true, // fileSize, so the byte bound is real
    selectionLimit: 1,
    // The original representation. 'compatible' would transcode HEIC to JPEG
    // for us; CGImageSource reads HEIC directly, so the transcode is pure loss.
    assetRepresentationMode: 'current' as const,
  };
  const result: ImagePickerResponse =
    source === 'library'
      ? await launchImageLibrary(shared)
      : await launchCamera({ ...shared, saveToPhotos: false });

  if (result.didCancel) throw new PickCancelled();
  // Same order as pickImage: a denial and an unreadable file both arrive as
  // "no asset", and telling someone their photo is broken when the app was
  // never allowed to look at it sends them nowhere useful.
  if (result.errorCode === 'permission') throw new PickDenied(source);
  if (result.errorCode === 'camera_unavailable') throw new PickUnavailable();
  const asset = result.assets?.[0];
  if (!asset?.uri || !asset.width || !asset.height) {
    throw new Error('photo unreadable');
  }
  if (asset.width * asset.height > QR_MAX_PIXELS) throw new PickTooLarge();
  if (typeof asset.fileSize === 'number' && asset.fileSize > QR_MAX_BYTES) {
    throw new PickTooLarge();
  }
  return { uri: asset.uri, width: asset.width, height: asset.height };
}
