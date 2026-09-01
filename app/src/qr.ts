import * as native from 'tacendum-qr';
import { extractId, URI_SHAPED } from './peerId';

/**
 * An account id as a picture, in both directions.
 *
 * There is no directory and no browsable namespace, so an id only ever
 * reaches a person because somebody handed it over. A QR is
 * that hand-over in a form a phone can read back: a picture you can send, and
 * a picture you can pick out of a library.
 *
 * The native module is deliberately dumb — CoreImage draws pixels, Vision
 * finds payloads, the file system carries one file. Every decision about what
 * a payload is ALLOWED to mean lives here, which is the same split as
 * `screenSecurity.ts` and its native module, and is what keeps this file
 * unit-testable with the native side replaced.
 *
 * The read direction is a trust boundary. A decoded payload is attacker-
 * controlled text out of an arbitrary image file, and `extractId` is the only
 * thing permitted to turn it into an id.
 *
 * Nothing here talks to the network. This file must not import `./api`,
 * `./ws`, `./messaging`, `./registration` or `./db`: reading a QR produces a
 * string that a text field is filled with, and nothing else. That is what
 * keeps the import path legal in a duress session, where `messaging.start()`
 * is never called.
 */

/* ── constants ────────────────────────────────────────────── */

/**
 * Requested raster edge. 768 gives 23 whole pixels per module for a
 * 26-character payload, and is 4.4x the 176pt the panel draws it at, so the
 * screen decimates rather than interpolates.
 */
export const QR_PIXELS = 768;

/**
 * The longest payload we will even consider. A Tacendum QR is 26 characters;
 * the headroom is for a code someone generated elsewhere with a sentence
 * around the id. Beyond this it is somebody else's QR, not ours.
 */
export const MAX_PAYLOAD_CHARS = 64;

/*
 * The URI-shape guard (`URI_SHAPED`, a scheme then a colon: `WIFI:`,
 * `https:`, `mailto:`, `otpauth:`) lives in `peerId.ts` so the paste path
 * refuses by exactly the same shape. It is matched before `extractId` ever
 * sees the payload — see `idFromPayloads` for why that ordering is the
 * security property.
 */

/* ── errors ───────────────────────────────────────────────── */
/* Classes, not codes: the screen maps the class to a sentence, and
 * `instanceof` survives a refactor that a string literal would not. This is
 * the idiom `media.ts` already uses for the picker. */

/** CoreImage would not draw it, or the module is not in this build. */
export class QrEncodeFailed extends Error {}

/** The file could not be written or read back for sharing. */
export class QrShareFailed extends Error {}

/** Vision found no QR code at all in the picture. */
export class QrNoCode extends Error {}

/**
 * More than one distinct code. We refuse rather than pick one: taking the
 * first silently addresses the wrong person, and there is no directory to
 * catch that mistake afterwards.
 */
export class QrAmbiguous extends Error {
  constructor(public count: number) {
    super('ambiguous');
  }
}

/** A QR, but not a Tacendum id — a Wi-Fi code, a link, a ticket. */
export class QrNotAnId extends Error {}

/** Their QR is your QR. */
export class QrOwnId extends Error {}

/** The image itself could not be opened, or was refused as absurdly large. */
export class QrImageUnreadable extends Error {}

/* ── types ────────────────────────────────────────────────── */

export interface SelfQr {
  /** PNG bytes, base64. */
  pngB64: string;
  /** The same bytes as an <Image source={{uri}}> value. Never touches disk. */
  dataUri: string;
}

export interface QrInk {
  /** '#RRGGBB' for the modules. Resolved from the theme by the caller. */
  darkHex: string;
  /** '#RRGGBB' for the paper and the quiet zone. */
  lightHex: string;
  /** Requested edge in pixels; defaults to QR_PIXELS. */
  pixels?: number;
}

/* ── the draw direction ───────────────────────────────────── */

/**
 * The payload for an id. It is the BARE ULID — no scheme, no prefix, no URL.
 * A URL would put the id somewhere a browser can open, log and sync, and it
 * would make every Tacendum code look like a link worth tapping.
 *
 * Exported so a test can assert the payload is exactly the id.
 */
export function selfPayload(id: string): string {
  const out = extractId(id);
  // We never encode a string we have not ourselves validated: a malformed id
  // drawn into a picture is a wrong number that travels.
  if (out === null) throw new QrEncodeFailed('not an id');
  return out;
}

/** Draw my own id. Throws QrEncodeFailed for every native failure. */
export async function encodeSelfQr(id: string, ink: QrInk): Promise<SelfQr> {
  const payload = selfPayload(id);
  try {
    const pngB64 = await native.encodePng(
      payload,
      ink.pixels ?? QR_PIXELS,
      ink.darkHex,
      ink.lightHex,
    );
    if (pngB64 === '') throw new Error('empty');
    return { pngB64, dataUri: `data:image/png;base64,${pngB64}` };
  } catch (err) {
    // The native reject code is deliberately not inspected. Codes exist for
    // diagnosis; branching on them would put native vocabulary into policy
    // and give the screen nothing extra to say.
    if (err instanceof QrEncodeFailed) throw err;
    throw new QrEncodeFailed('encode');
  }
}

/**
 * Put the PNG on disk so the share sheet can attach it; returns a file:// URI
 * for Share.share({ url }). Throws QrShareFailed.
 */
export async function writeShareImage(pngB64: string): Promise<string> {
  try {
    return await native.writeSharePng(pngB64);
  } catch {
    throw new QrShareFailed('write');
  }
}

/**
 * Remove that file. Never throws — a plaintext picture of the owner's only
 * reachability address should not linger, but failing to tidy up is not
 * something to put in front of anyone.
 */
export async function clearShareImage(): Promise<void> {
  try {
    await native.clearSharePng();
  } catch {
    /* best effort */
  }
}

/* ── the read direction: the trust boundary ───────────────── */

/**
 * The one id in that picture, validated. Throws — never returns null:
 *   QrImageUnreadable  the file could not be opened or was refused as too big
 *   QrNoCode           no QR code in the picture
 *   QrAmbiguous        more than one distinct code
 *   QrNotAnId          a QR, but not a Tacendum id
 *   QrOwnId            that is your own code
 *
 * The order of the checks is the whole security surface of the import
 * direction, and each one is here because the cheaper alternative addresses
 * somebody else.
 */
/**
 * Turn decoded QR payloads into a peer id, or throw.
 *
 * Split out from `readIdFromImage` so the live camera scanner cannot drift
 * from the still-image path. Every guard below is security-relevant, and a
 * second implementation of them — written months later, against a different
 * decoder, by someone reading a screen rather than this comment — is exactly
 * how one of them would quietly go missing.
 *
 * The camera hands over the same shape a still image does: whatever symbols
 * were visible at once. That is deliberate. A live scanner that reported only
 * its "best" symbol would silently make the ambiguity refusal below
 * unreachable, because the choice would already have been made.
 */
export function idFromPayloads(payloads: string[], selfId: string): string {
  // Vision occasionally reports one symbol twice; that must not read as
  // ambiguity, so exact-equal payloads collapse before anything is counted.
  const distinct = Array.from(
    new Set(payloads.map(p => p.trim()).filter(p => p !== '')),
  );

  if (distinct.length === 0) throw new QrNoCode();

  // Refuse BEFORE looking at content, even when only one of them is a valid
  // id. Vision returns an ordered array and taking [0] is a silent guess
  // about which person the sender meant.
  if (distinct.length > 1) throw new QrAmbiguous(distinct.length);

  const payload = distinct[0]!;

  // Two guards that both run before `extractId`, because `extractId` finds a
  // 26-character Crockford run ANYWHERE in a string. A Wi-Fi code with a long
  // random password, or a URL with a long slug, can contain one by accident —
  // and a false id addresses a real stranger.
  if (payload.length > MAX_PAYLOAD_CHARS) throw new QrNotAnId();
  if (URI_SHAPED.test(payload)) throw new QrNotAnId();

  // `extractId` is the only validator. The decoded string is never trusted,
  // sliced, uppercased or regexed here. Its fold() maps O→0 and I/L→1, and
  // deliberately reports U rather than folding it to V — so a misread of
  // those characters surfaces as a refusal instead of a different account.
  const id = extractId(payload);
  if (id === null) throw new QrNotAnId();

  if (id === selfId) throw new QrOwnId();

  return id;
}

/**
 * Read a peer id from the live camera.
 *
 * Shares `idFromPayloads` with the still-image path, so the ambiguity, length
 * and URI-shape refusals apply identically — the camera is a different way to
 * obtain payloads, not a different set of rules for judging them.
 *
 * A cancelled scan resolves with no payloads and surfaces as `QrNoCode`, which
 * is the same outcome as pointing the camera at a wall. The caller decides
 * whether that deserves a message.
 */
export async function readIdFromCamera(selfId: string): Promise<string> {
  let payloads: string[];
  try {
    payloads = await native.scanWithCamera();
  } catch {
    throw new QrImageUnreadable('camera');
  }
  return idFromPayloads(payloads, selfId);
}

export async function readIdFromImage(
  fileUri: string,
  selfId: string,
): Promise<string> {
  let payloads: string[];
  try {
    payloads = await native.decodeFile(fileUri);
  } catch {
    throw new QrImageUnreadable('decode');
  }
  return idFromPayloads(payloads, selfId);
}
