import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * TurboModule spec for QR pictures (codegen input).
 *
 * There is no directory and no server lookup, so an id reaches a person as
 * something they can hand over. This module does the two halves JS cannot:
 * CoreImage draws the code, Vision reads one back out of a still image. It
 * holds no policy — what the payload means, and whether a decoded string is
 * an id at all, is decided in app/src/qr.ts.
 */
export interface Spec extends TurboModule {
  /**
   * A QR of `text` as PNG bytes, base64. `pixels` is the requested edge; the
   * real edge is the largest whole-module multiple that fits, so every module
   * is an exact square of pixels. `darkHex`/`lightHex` are 6-digit RGB with a
   * leading '#': the palette lives in the theme, never here.
   */
  encodePng(
    text: string,
    pixels: number,
    darkHex: string,
    lightHex: string,
  ): Promise<string>;

  /**
   * Every distinct QR payload Vision finds in the image at `fileUri`, in
   * detection order. Empty array when there is no code — that is a normal
   * outcome, not a failure, and must not reject.
   */
  decodeFile(fileUri: string): Promise<string[]>;

  /**
   * Present the live camera scanner; resolve with every QR payload visible in
   * the frame that satisfied the read.
   *
   * Resolves with an EMPTY array when the person cancels, or when there is no
   * usable camera or permission — none of which is an error. The array shape
   * matters: reporting only the first symbol would make the ambiguity refusal
   * in `app/src/qr.ts` unreachable, because the choice would already have been
   * made natively.
   */
  scanWithCamera(): Promise<string[]>;

  /** Writes `pngB64` to a fixed Caches path and resolves its file:// URI. */
  writeSharePng(pngB64: string): Promise<string>;

  /** Deletes that file if it exists. Never rejects for "not there". */
  clearSharePng(): Promise<void>;
}

// `get`, NOT `getEnforcing`. A module-scope getEnforcing throws at bundle
// evaluation against a simulator binary that predates this pod, which takes
// down globalThis.TacendumDev and with it every unrelated app-verify check.
// Absence is reported at call time instead (see index.ts).
export default TurboModuleRegistry.get<Spec>('TacendumQr');
