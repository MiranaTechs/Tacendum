package com.miranatechnologies.tacendum.call

import android.content.Context
import android.provider.Settings

/**
 * Telecom-less devices fail closed, HONESTLY.
 *
 * `TelecomCenter.register()` has always answered a Boolean, and both callers
 * discarded it — so on a device whose Telecom subsystem is absent or refuses
 * the self-managed PhoneAccount (WiFi-only tablets are the known class), every
 * call died deep inside `addNewIncomingCall`/`placeCall` with no ring and
 * nothing to say. This object is where the verdict now LANDS: both callers
 * (`TacendumCallModule`'s construction, `CallWake`'s pre-JS wake) record what
 * register() answered, and every Telecom report path consults the record
 * before touching the platform, so the refusal is immediate and carries the
 * honest verdict instead of surfacing as a dead call. JS reads the same fact
 * back through the `telecomAvailable` surface — its TurboModule contract
 * method rides the JS half; until that lands the guard is behavior-only.
 *
 * FAIL-CLOSED by rule: an UNKNOWN verdict refuses calls.
 * The two real entry points both register before any report can run, so
 * "unknown" is unreachable in practice — the rule exists for the caller that
 * forgets, whose forgetting can then only refuse calls loudly, never ring a
 * device that cannot carry one.
 *
 * Messaging never consults this object, deliberately: the divergence is
 * "calls fail closed with a reason, messaging unaffected".
 */
internal object TelecomGuard {

  /**
   * The harness's register()-refusal seam: the
   * WiFi-only-tablet refusal is NOT synthesizable on google_apis emulator
   * images — they declare `android.software.telecom` and every telephony
   * feature, and disabling the platform telecom package is inert at API 35
   * (Telecom lives in system_server) — so the `LEG: telecom-guard` device leg
   * forces the verdict here instead:
   *
   *   adb shell settings put global tacendum_force_telecom_refusal 1
   *
   * DEBUG BUILDS ONLY, the `enableSyntheticVideo` posture: the
   * constant still compiles into a Release APK, but the read is gated on
   * `BuildConfig.DEBUG`, so outside a debug build the switch is disconnected,
   * not merely unset. Everything downstream of register() — the recorded
   * verdict, the report guards, the honest refusal — is the shipped code
   * under test either way, which is what makes the seam a rig for the guard
   * rather than a second implementation of it. The class's only true rig is
   * real hardware: the WiFi-only-tablet case.
   */
  const val REFUSAL_SEAM_SETTING = "tacendum_force_telecom_refusal"

  /** The latest register() verdict; null until a caller records one. */
  @Volatile private var lastVerdict: Boolean? = null

  /**
   * Latest-wins, in both directions: register() runs on every module
   * construction and on every call-wake, so a transient refusal HEALS on the
   * next successful registration, and a device whose Telecom went away
   * CLOSES on the next refused one.
   */
  fun recordVerdict(available: Boolean) {
    lastVerdict = available
  }

  /** The fact JS surfaces. Null: no register() has answered yet. */
  fun telecomAvailable(): Boolean? = lastVerdict

  /**
   * The report paths' gate: only an explicit successful registration opens
   * it. `TelecomCenter.reportFresh` and `reportOutgoingCall` read this before
   * touching Telecom and answer the refusal verdict when it is closed.
   */
  fun callsPermitted(): Boolean = lastVerdict == true

  /** The seam, read at its one call site (`TelecomCenter.register`). */
  fun refusalForced(context: Context): Boolean =
      refusalForced(BuildConfig.DEBUG) {
        Settings.Global.getInt(context.contentResolver, REFUSAL_SEAM_SETTING, 0) == 1
      }

  /**
   * The seam decision with its two platform edges injected, so the JVM suite
   * (`TelecomGuardTest`) can pin the shape no
   * emulator run demonstrates: a Release build never consults the reader AT
   * ALL, and a reader that THROWS reads as seam-absent — the seam exists to
   * synthesize refusals on a rig, and a broken settings read must never be
   * able to refuse calls on a device in someone's hand.
   */
  fun refusalForced(debugBuild: Boolean, readSeam: () -> Boolean): Boolean {
    if (!debugBuild) return false
    return try {
      readSeam()
    } catch (unreadable: Exception) {
      false
    }
  }

  /** Tests only: the process-level latch must not leak between cases. */
  fun resetForTest() {
    lastVerdict = null
  }
}
