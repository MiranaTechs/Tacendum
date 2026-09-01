import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * TurboModule spec for attachments beyond photos (codegen input).
 *
 * Three jobs JS cannot do, and the properties that make them safe:
 *
 *  - `pickDocument` enforces the size cap NATIVELY, before the bytes exist in
 *    JS at all: a 2 GB video picked by accident is refused by a stat() call,
 *    never materialised as a base64 string that would take the runtime down.
 *  - `currentLocation` is a ONE-SHOT read. No monitoring, no significant-
 *    change subscription, nothing that outlives the promise — the app never
 *    holds a standing claim on where the person is.
 *  - `previewFile` writes the decrypted bytes to a private temp file only for
 *    the lifetime of the QuickLook presentation, and deletes it on dismiss.
 *
 * Nothing in this module touches the network.
 */

export interface PickedDocument {
  /** Display filename, as the provider names it. */
  name: string;
  /** Byte size on disk (what was actually read). */
  size: number;
  /** Preferred MIME type, or application/octet-stream when unknown. */
  mime: string;
  /** The file's bytes, base64. Present only when size <= the cap passed in. */
  dataB64: string;
}

export interface PickedLocation {
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres, as CoreLocation reports it. */
  acc: number;
}

export interface Spec extends TurboModule {
  /**
   * Present the system document picker. Resolves null when the person
   * cancels — cancellation is an answer, not an error. Rejects with code
   * 'too_large' when the chosen file exceeds `maxBytes`, and 'busy' when a
   * pick or preview is already presented.
   */
  pickDocument(maxBytes: number): Promise<PickedDocument | null>;

  /**
   * One position, once, with When-In-Use authorisation requested on demand.
   * Rejects 'denied' when authorisation is refused and 'timeout' after
   * `timeoutMs` without a fix.
   */
  currentLocation(timeoutMs: number): Promise<PickedLocation>;

  /**
   * QuickLook the given bytes under `name`. The temp file lives exactly as
   * long as the presentation. Rejects 'busy' when something is already up.
   */
  previewFile(dataB64: string, name: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Attach');
