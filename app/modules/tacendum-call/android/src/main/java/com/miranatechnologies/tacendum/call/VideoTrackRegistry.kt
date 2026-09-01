package com.miranatechnologies.tacendum.call

import android.os.Handler
import android.os.Looper
import org.webrtc.VideoTrack

/**
 * Where a video view finds a call's tracks — the Kotlin
 * twin of `ios/VideoTrackRegistry.swift`.
 *
 * A track cannot cross the bridge, and the UI is written against a `cid`, so
 * something has to hold the mapping. It also has to survive the fact that a
 * call's tracks appear and change at moments the UI does not control: the
 * remote track arrives when the answer is applied, the local one is replaced
 * by a camera flip, and both vanish on teardown.
 *
 * So views REGISTER an interest and are told; they do not poll and they do not
 * hold a track themselves. A view that attaches before the remote track exists
 * — the normal case, since the screen is on-screen while the call is still
 * connecting — simply shows nothing and is updated when the track lands.
 */
internal object VideoTrackRegistry {

  enum class Role(val wire: String) {
    LOCAL("local"),
    REMOTE("remote");

    companion object {
      /** Unknown names resolve to `remote`, matching the Swift `?? .remote`. */
      fun from(value: String?): Role =
          entries.firstOrNull { it.wire == value } ?: REMOTE
    }
  }

  private data class Key(val cid: String, val role: Role)

  private val tracks = HashMap<Key, VideoTrack>()
  private val observers = HashMap<Key, MutableMap<Any, (VideoTrack?) -> Unit>>()

  /**
   * All access is on the main thread: attaching a `VideoSink` is a view
   * operation, and the alternative — a lock plus a main-thread hop per
   * notification — buys nothing when every consumer is a view anyway.
   */
  private val main = Handler(Looper.getMainLooper())

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  fun set(track: VideoTrack?, cid: String, role: Role) {
    onMain {
      val key = Key(cid, role)
      if (track != null) tracks[key] = track else tracks.remove(key)
      // A COPY of the observer map: a notified view resubscribes from inside
      // its callback (`bind` does exactly that when a prop write lands in the
      // same frame), and mutating the map that is being walked is a crash on
      // the main thread rather than a missed update.
      observers[key]?.values?.toList()?.forEach { it(track) }
    }
  }

  /**
   * Drop everything for a call. Called on teardown so a renderer cannot keep
   * a dead call's last frame — or, worse, its track alive.
   */
  fun clear(cid: String) {
    onMain {
      for (role in Role.entries) {
        val key = Key(cid, role)
        tracks.remove(key)
        observers[key]?.values?.toList()?.forEach { it(null) }
      }
    }
  }

  /**
   * Observe a (cid, role). Fires immediately with the current value, which is
   * usually null — the screen is up before the call connects.
   */
  fun observe(cid: String, role: Role, owner: Any, onChange: (VideoTrack?) -> Unit) {
    onMain {
      val key = Key(cid, role)
      val forKey = observers.getOrPut(key) { HashMap() }
      forKey[owner] = onChange
      onChange(tracks[key])
    }
  }

  fun stopObserving(owner: Any) {
    onMain {
      val empty = ArrayList<Key>()
      for ((key, forKey) in observers) {
        forKey.remove(owner)
        if (forKey.isEmpty()) empty.add(key)
      }
      for (key in empty) observers.remove(key)
    }
  }
}
