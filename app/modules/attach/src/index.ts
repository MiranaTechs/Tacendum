import NativeAttach, {
  type PickedDocument,
  type PickedLocation,
} from './NativeAttach';

export type { PickedDocument, PickedLocation };

/** System document picker; null on cancel. Size cap enforced natively. */
export function pickDocument(maxBytes: number): Promise<PickedDocument | null> {
  return NativeAttach.pickDocument(maxBytes);
}

/** One position, once. Rejects 'denied' or 'timeout'. */
export function currentLocation(timeoutMs: number): Promise<PickedLocation> {
  return NativeAttach.currentLocation(timeoutMs);
}

/** QuickLook decrypted bytes; the temp file dies with the presentation. */
export function previewFile(dataB64: string, name: string): Promise<void> {
  return NativeAttach.previewFile(dataB64, name);
}
