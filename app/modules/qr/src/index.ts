import NativeTacendumQr from './NativeTacendumQr';

/**
 * Typed JS surface over the native QR module. Nothing here decides anything —
 * see app/src/qr.ts for what a payload is allowed to mean.
 */

/** This binary has no QR module (a simulator build older than the pod). */
export class QrUnavailable extends Error {}

function native() {
  if (NativeTacendumQr == null) {
    throw new QrUnavailable('tacendum-qr is not in this build');
  }
  return NativeTacendumQr;
}

export function encodePng(
  text: string,
  pixels: number,
  darkHex: string,
  lightHex: string,
): Promise<string> {
  return native().encodePng(text, pixels, darkHex, lightHex);
}
/**
 * Present the live camera scanner.
 *
 * Resolves with every QR payload in the frame that satisfied the read, or an
 * empty array on cancel / no camera / no permission — none of which is an
 * error worth surfacing as one.
 */
export function scanWithCamera(): Promise<string[]> {
  return native().scanWithCamera();
}

export function decodeFile(fileUri: string): Promise<string[]> {
  return native().decodeFile(fileUri);
}
export function writeSharePng(pngB64: string): Promise<string> {
  return native().writeSharePng(pngB64);
}
export function clearSharePng(): Promise<void> {
  return native().clearSharePng();
}
