import { codegenNativeComponent, type ViewProps } from 'react-native';
import type { WithDefault } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * A surface that renders one call's video.
 *
 * **Why a component of our own rather than `react-native-webrtc`'s `RTCView`.**
 * `RTCView` resolves a track through that library's own registry, populated by
 * *its* peer-connection factory. This module owns a separate factory — it has
 * to, because it also owns the codec preferences, the audio session and the
 * CallKit handshake — so its tracks are invisible to that registry. Pointing
 * `RTCView` at one produces a black rectangle and no error, which is precisely
 * the failure that went unnoticed until a review looked for a renderer and
 * found none.
 *
 * The view takes a `cid` and a track name rather than a track object. Tracks cannot
 * cross the bridge, and a call's tracks change underneath the UI — a remote
 * track arrives after the answer, a camera flip replaces the local one — so
 * the view resolves the current track natively on every update and simply
 * shows nothing when there is not one yet.
 */
export interface NativeProps extends ViewProps {
  /** Which call. Empty renders an inert placeholder rather than failing. */
  cid: string;

  /**
   * `remote` is the person you are talking to; `local` is this device's
   * camera preview.
   *
   * Named `track` rather than `role`: `ViewProps` already has a `role`, which
   * is the ACCESSIBILITY role, and shadowing it would both fail to typecheck
   * and quietly take a name a screen reader depends on.
   */
  track?: WithDefault<'remote' | 'local', 'remote'>;

  /**
   * Mirror horizontally. Correct for the FRONT camera preview only: people
   * expect their own preview to behave like a mirror, and expect the remote
   * image not to.
   */
  mirror?: WithDefault<boolean, false>;

  /** `cover` fills and crops; `contain` letterboxes. */
  objectFit?: WithDefault<'cover' | 'contain', 'cover'>;
}

export default codegenNativeComponent<NativeProps>('TacendumVideoView');
