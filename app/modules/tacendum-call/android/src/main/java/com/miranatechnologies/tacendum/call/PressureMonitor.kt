package com.miranatechnologies.tacendum.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Thermal state, power save, and battery — the Kotlin twin
 * of `TacendumCallImpl`'s pressure extension.
 *
 * All three are notification-driven rather than polled: a video call already
 * costs enough CPU without a timer waking to ask how hot the phone is.
 * Started when a call starts rather than at launch, because a phone that is
 * not in a call has no video to reduce.
 *
 * **The thermal mapping is four Android buckets onto iOS's four**, and it is
 * a mapping rather than a rename, so it is written down:
 *
 * | Android `THERMAL_STATUS_*` | reported | why |
 * |---|---|---|
 * | `NONE` | `nominal` | nothing to do |
 * | `LIGHT` | `fair` | the first level the platform will admit to |
 * | `MODERATE`, `SEVERE` | `serious` | throttling is happening; caps apply |
 * | `CRITICAL`, `EMERGENCY`, `SHUTDOWN` | `critical` | drop to voice |
 *
 * `SEVERE` folds into `serious` rather than `critical` on purpose: `critical`
 * is the level at which the pressure policy offers to abandon video, and doing that
 * one bucket early on a phone that is merely throttling is a worse call than
 * a hot one.
 *
 * **Below API 29 there is no thermal API at all**, and this reports `nominal`
 * forever. That is a real gap on API 26–28, not a claim that those devices
 * stay cool: the policy above the bridge simply never fires there. Recorded
 * here rather than hidden behind a constant with no comment; power save and
 * battery still work on those devices and still drive the same policy.
 */
internal class PressureMonitor(
    private val context: Context,
    private val emit: (String, String) -> Unit,
) {

  private var monitoring = false
  private var lastBatteryPercent = -1
  private val executor = Executors.newSingleThreadExecutor { Thread(it, "tacendum-pressure") }

  /**
   * `Any?` rather than the listener type, deliberately.
   *
   * `PowerManager.OnThermalStatusChangedListener` is API 29 and this class
   * loads on API 26. A field whose declared type does not exist on the device
   * is a resolution the verifier has to soft-fail its way past; storing it
   * untyped and casting inside the version guard keeps the API-29 type out of
   * every signature this class publishes.
   */
  private var thermalListener: Any? = null

  private val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          when (intent?.action) {
            PowerManager.ACTION_POWER_SAVE_MODE_CHANGED -> emitPressure()
            Intent.ACTION_BATTERY_CHANGED -> {
              // ACTION_BATTERY_CHANGED fires on charge state and on every
              // sampling tick, not only on a level change. Emitting each time
              // would put a bridge crossing on a timer nobody asked for, so
              // the whole-percent value is what gates it — the same shape as
              // iOS's `batteryLevelDidChangeNotification`.
              val percent = percentFrom(intent)
              if (percent != lastBatteryPercent) {
                lastBatteryPercent = percent
                emitPressure()
              }
            }
            else -> Unit
          }
        }
      }

  fun start() {
    if (monitoring) return
    monitoring = true

    val filter = IntentFilter()
    filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
    filter.addAction(Intent.ACTION_BATTERY_CHANGED)
    // NOT_EXPORTED: these are protected system broadcasts, and an exported
    // registration would let any app on the device spoof them.
    ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val power = context.getSystemService(PowerManager::class.java)
      if (power != null) {
        val listener = PowerManager.OnThermalStatusChangedListener { emitPressure() }
        thermalListener = listener
        power.addThermalStatusListener(executor, listener)
      }
    }

    // Once immediately: a call placed on an already-hot phone must start
    // capped rather than wait for the state to CHANGE, which it may not.
    emitPressure()
  }

  fun stop() {
    if (!monitoring) return
    monitoring = false
    try {
      context.unregisterReceiver(receiver)
    } catch (never: IllegalArgumentException) {
      // Unregistering a receiver that was never registered throws; a teardown
      // path must not.
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val listener = thermalListener as? PowerManager.OnThermalStatusChangedListener
      if (listener != null) {
        context.getSystemService(PowerManager::class.java)?.removeThermalStatusListener(listener)
      }
    }
    thermalListener = null
    lastBatteryPercent = -1
  }

  fun emitPressure() {
    val power = context.getSystemService(PowerManager::class.java)
    val thermal =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && power != null) {
          thermalName(power.currentThermalStatus)
        } else {
          "nominal"
        }
    val payload = JSONObject()
    payload.put("state", thermal)
    payload.put("lowPower", power?.isPowerSaveMode ?: false)
    val percent = currentBatteryPercent()
    // JSONObject.NULL rather than -1, so the policy can tell "unknown" from
    // "empty": treating unknown as 0 would offer to drop every call on a rig
    // that declines to report a level.
    if (percent < 0) payload.put("battery", JSONObject.NULL)
    else payload.put("battery", percent / 100.0)
    emit(EVENT, payload.toString())
  }

  private fun currentBatteryPercent(): Int {
    val manager = context.getSystemService(BatteryManager::class.java) ?: return -1
    val level = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    return if (level in 0..100) level else -1
  }

  private fun percentFrom(intent: Intent): Int {
    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    if (level < 0 || scale <= 0) return -1
    return level * 100 / scale
  }

  private fun thermalName(status: Int): String =
      when (status) {
        PowerManager.THERMAL_STATUS_NONE -> "nominal"
        PowerManager.THERMAL_STATUS_LIGHT -> "fair"
        PowerManager.THERMAL_STATUS_MODERATE, PowerManager.THERMAL_STATUS_SEVERE -> "serious"
        PowerManager.THERMAL_STATUS_CRITICAL,
        PowerManager.THERMAL_STATUS_EMERGENCY,
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
        else -> "nominal"
      }

  companion object {
    const val EVENT = "thermalStateChanged"
  }
}
