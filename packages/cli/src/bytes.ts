/**
 * Base64 <-> bytes helpers. Encoding only — no cryptography.
 * libsignal's 0.98 typings want `Uint8Array<ArrayBuffer>`, so we always copy
 * into a fresh Uint8Array rather than handing over Buffer views.
 */

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function utf8ToBytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
