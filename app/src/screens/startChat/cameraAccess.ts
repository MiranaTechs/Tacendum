import { PermissionsAndroid, Platform } from 'react-native';
import * as nativeCall from 'tacendum-call';

/**
 * Why a camera scan came back empty, and the one way to ask again.
 *
 * Both native scanners report a refused camera exactly as they report a
 * cancel: an empty result (iOS calls its cancel path, Android's scanner
 * activity finishes with nothing). So after an EMPTY scan, and only then,
 * the screen reads the camera permission through the read the calls feature
 * already ships (`tacendum-call`), which never shows a prompt. No native
 * change, so the scanner contract and Link device stay exactly as they are.
 *
 * What the read can and cannot tell:
 *  - granted: it was a cancel. A missing or unusable camera with access
 *    granted also lands here, because both scanners report it as a cancel;
 *  - denied: refused. On iOS a Screen Time or device-management block reads
 *    as denied too, so it gets the same sentence (which also offers a photo);
 *  - undetermined: on Android the calls module answers this until IT has
 *    asked, and the scanner just asked, so it counts as refused; on iOS the
 *    scanner itself asks before it opens, so an empty scan was a cancel.
 */

export type EmptyScanReason = 'cancelled' | 'refused' | 'unknown';

/** Read once after a scan returned nothing. Never throws. */
export async function cameraAfterEmptyScan(): Promise<EmptyScanReason> {
  try {
    const state = await nativeCall.cameraPermission();
    if (state === 'granted') return 'cancelled';
    if (state === 'denied') return 'refused';
    return Platform.OS === 'android' ? 'refused' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export type AskAgainOutcome = 'granted' | 'never' | 'denied';

/**
 * Android's Try again: ask the system directly (RN core, on the person's
 * press). The system dialog shows only while Android can still ask; once it
 * will not, the answer is "never ask again" at once, and the caller offers
 * Settings instead of launching a scanner that could only be refused — the
 * black secure scanner screen never flashes for a permanent refusal.
 * Never throws.
 */
export async function askCameraAgainAndroid(): Promise<AskAgainOutcome> {
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
    if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
    if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'never';
    return 'denied';
  } catch {
    return 'denied';
  }
}
