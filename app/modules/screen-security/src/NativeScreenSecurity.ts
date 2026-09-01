import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * TurboModule spec for screen security (codegen input).
 *
 * Formal route only (Apple DTS, 2026: `isSecureTextEntry` wrapping is an
 * unsupported side effect): iOS cannot BLOCK a screenshot, so this module
 * observes — capture state for live blanking, screenshot events for
 * disclosure — and natively covers the app the moment it resigns active,
 * before the OS takes the app-switcher snapshot.
 */
export interface Spec extends TurboModule {
  /**
   * Begin forwarding capture/screenshot events to JS; idempotent. The native
   * app-switcher cover is NOT gated on this — it arms at process load so a
   * fast app switch after cold launch can never beat the JS bundle.
   */
  start(): void;

  /** Current UIScreen.isCaptured (recording, AirPlay, mirroring). */
  getIsCaptured(): Promise<boolean>;

  /** Fires with the new state when capture starts or stops. */
  readonly onCapturedChanged: EventEmitter<boolean>;

  /** Fires after the user has taken a screenshot (iOS: after the fact). */
  readonly onScreenshot: EventEmitter<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ScreenSecurity');
