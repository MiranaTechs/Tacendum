/**
 * THE EARPIECE FACT — whether this device is KNOWN to have no receiver.
 *
 * The speaker toggle's whole claim is a route distinction: earpiece against
 * loudspeaker. iPads have no earpiece — `overrideOutputAudioPort(.none)`
 * lands on the loudspeaker, `.defaultToSpeaker` changes nothing, and a
 * control that says "Speaker off" over audio still playing from the
 * loudspeaker is exactly the route-vs-UI lie this codebase documents
 * fighting (the lit-button precedent at `call/index.ts` and
 * `CallKitCenter.swift`: the button reflects the route the device took,
 * never the route the UI wished for). So on the pad idiom the 1:1 and group
 * call screens do not render the control at all — no control, no claim.
 *
 * IDIOM-DRIVEN, NEVER WINDOW-DRIVEN — deviceNoun.ts's rule, for the same
 * reason: this is a fact about the HARDWARE, and a Split View pane at phone
 * width does not grow an earpiece.
 *
 * Why "known absent" and not "exists": the constant is true only where the
 * tree actually knows the receiver is missing — the iPad idiom, by Apple's
 * own hardware line. Android tablets are NOT claimed here: some ship
 * earpieces and some do not, no API answers it honestly from JS, and the
 * telecom-less device class that dominates the no-earpiece tablets fails
 * closed at the call button anyway once the telecom-capability guard lands —
 * their honest degraded UI is that phase's lane, on hardware evidence, not a
 * guess baked in here. On every device this cannot vouch for, the toggle
 * stays: showing a control that works everywhere we have ever shipped is not
 * the lie; claiming a route we know does not exist is.
 *
 * A PLAIN CONSTANT, resolved once at module load, like DEVICE_NOUN: hardware
 * does not change mid-process.
 */

import { Platform } from 'react-native';

/** True exactly where the tree knows there is no earpiece: the iPad idiom. */
export const EARPIECE_KNOWN_ABSENT: boolean =
  Platform.OS === 'ios' && Platform.isPad === true;
