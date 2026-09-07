package com.miranatechnologies.tacendum.call

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.widget.FrameLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import java.lang.ref.WeakReference
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * The view half of the video surface — the Kotlin twin of
 * `ios/TacendumVideoHost.swift`.
 *
 * A `FrameLayout` wrapping a `SurfaceViewRenderer` rather than the renderer
 * itself, for two reasons that both matter: the renderer is DESTROYED and
 * rebuilt (see `detach`), which a view manager handing React a single instance
 * cannot survive; and a black ground behind it is what makes "no video yet"
 * read as nothing-here rather than as a hole showing whatever is behind it.
 */
class TacendumVideoHost(context: Context) : FrameLayout(context) {

  private var renderer: SurfaceViewRenderer? = null
  private var attached: VideoTrack? = null
  private var surfaceToken = ""
  private var generation = 0
  private var ready = false
  private val main = Handler(Looper.getMainLooper())
  private var cid = ""
  private var role = VideoTrackRegistry.Role.REMOTE

  /**
   * Held here rather than read back off the renderer, because the renderer is
   * swapped out and the replacement has to come up looking like the one it
   * replaced — a camera flip must not un-mirror the preview.
   */
  private var mirrored = false
  private var scaling = RendererCommon.ScalingType.SCALE_ASPECT_FILL

  init {
    // Black rather than transparent: a video surface that has not received a
    // frame yet should read as "nothing here".
    setBackgroundColor(Color.BLACK)
    installRenderer()
  }

  /** Put a fresh renderer on screen, wearing this host's mirroring and fit. */
  private fun installRenderer() {
    if (renderer != null) return
    val fresh = SurfaceViewRenderer(context)
    // BEFORE the surface exists, which is why this is here and not in a
    // setter: `setZOrderMediaOverlay` is only honoured while the SurfaceView
    // has no surface yet. `true` for the LOCAL preview — the picture-in-
    // picture corner has to draw ON TOP of the full-screen remote surface, and
    // two plain SurfaceViews compose in an order nothing in the view hierarchy
    // controls, so without this the self-view is behind the call and invisible
    // on some devices and in front on others.
    fresh.setZOrderMediaOverlay(role == VideoTrackRegistry.Role.LOCAL)
    val epoch = generation
    val owner = WeakReference(this)
    val queue = main
    fresh.init(CallEgl.context, object : RendererCommon.RendererEvents {
      override fun onFirstFrameRendered() {
        queue.post {
          val host = owner.get() ?: return@post
          if (host.generation != epoch || host.attached == null) return@post
          host.ready = true
          host.publishReadiness()
        }
      }
      override fun onFrameResolutionChanged(width: Int, height: Int, rotation: Int) = Unit
    })
    fresh.setScalingType(scaling)
    fresh.setMirror(mirrored)
    fresh.setEnableHardwareScaler(true)
    addView(fresh, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    renderer = fresh
  }

  // MARK: - props

  /**
   * Bind to a (cid, role) IN ONE STEP.
   *
   * The iOS file records what two independent setters cost: each one
   * resubscribed on its own, so applying a cid and a role together — which is
   * what every mount does — first subscribed with the OTHER field still stale,
   * and the binding then depended on the ORDER and COMPLETENESS of the prop
   * writes rather than on the props. A view from Fabric's recycle pool is
   * handed to a different element, and a diff that misses one of the two
   * setters leaves the surface attached to the track the view's PREVIOUS life
   * was showing: the full-screen surface rendering this device's own camera
   * while the caller waits to be seen.
   *
   * The view manager therefore keeps both props and calls this once with both.
   */
  fun bind(nextCid: String, nextTrack: String?, nextSurface: String) {
    val nextRole = VideoTrackRegistry.Role.from(nextTrack)
    if (nextCid == cid && nextRole == role && nextSurface == surfaceToken) return
    cid = nextCid
    role = nextRole
    surfaceToken = nextSurface
    // The z-order is decided when the surface is created, so a role change has
    // to rebuild the renderer or a view recycled from remote to local composes
    // underneath the call it is supposed to sit on.
    resubscribe()
  }

  fun setMirrored(value: Boolean) {
    mirrored = value
    renderer?.setMirror(value)
  }

  fun setObjectFit(value: String?) {
    scaling =
        if (value == "contain") RendererCommon.ScalingType.SCALE_ASPECT_FIT
        else RendererCommon.ScalingType.SCALE_ASPECT_FILL
    renderer?.setScalingType(scaling)
  }

  /**
   * Back to the state the constructor left, for Fabric's recycle pool.
   *
   * A pooled view is not garbage collected, so nothing else runs for it:
   * without this it sits in the pool still registered with the registry and
   * still holding the dead call's track attached to its renderer — and it
   * carries that binding into whatever element dequeues it next.
   */
  fun resetForRecycle() {
    VideoTrackRegistry.stopObserving(this)
    detach()
    cid = ""
    surfaceToken = ""
    role = VideoTrackRegistry.Role.REMOTE
    mirrored = false
    scaling = RendererCommon.ScalingType.SCALE_ASPECT_FILL
    renderer?.setMirror(false)
    renderer?.setScalingType(scaling)
  }

  // MARK: - track binding

  private fun resubscribe() {
    VideoTrackRegistry.stopObserving(this)
    detach()
    if (cid.isEmpty()) return
    VideoTrackRegistry.observe(cid, role, this) { track -> attach(track) }
  }

  private fun attach(track: VideoTrack?) {
    if (track === attached) return
    detach()
    if (track == null) return
    installRenderer()
    val target = renderer ?: return
    track.addSink(target)
    attached = track
  }

  /**
   * THE RENDERER IS DESTROYED, NOT MERELY UNSUBSCRIBED — and this is the fix
   * for the bug that put this device's own face on the full-screen surface.
   *
   * A `SurfaceViewRenderer` HOLDS ITS LAST DECODED FRAME. Removing it from a
   * track stops new frames arriving; it does not clear what is already on
   * screen. `clearImage()` exists and is not enough on its own — it posts a
   * clear to the render thread that a surface already being torn down may
   * never run — and Fabric recycles component views, so a stale frame survives
   * into the NEXT CALL, in a view handed to a different React element.
   *
   * That is the reported iOS symptom exactly, and the Android renderer has the
   * same property: a corner self-view goes back to the pool with this device's
   * face frozen in it; the next call dequeues it as the FULL-SCREEN remote
   * surface; it binds to the remote track correctly and waits for a frame —
   * showing the stale local face the whole time. Both surfaces then show the
   * same person, and if no remote frame ever arrives it never resolves.
   *
   * A fresh renderer has no frame to show, so this host's black background
   * reads through: "no video yet", which is the truth. Every binding lifetime
   * gets a fresh renderer and readiness generation, even before a track arrives.
   */
  private fun detach() {
    val track = attached
    val current = renderer
    if (current != null && track != null) track.removeSink(current)
    attached = null
    releaseRenderer()
    installRenderer()
  }

  private fun releaseRenderer() {
    generation += 1
    ready = false
    publishReadiness()
    val current = renderer ?: return
    renderer = null
    current.clearImage()
    current.release()
    removeView(current)
  }

  override fun onDetachedFromWindow() {
    // The same destroy-and-rebuild, driven by the window this time. A view
    // taken off screen with a live renderer keeps an EGL surface and the last
    // frame; re-attaching rebuilds both from the binding, which is state this
    // host still holds.
    val track = attached
    if (track != null) renderer?.let { track.removeSink(it) }
    attached = null
    VideoTrackRegistry.stopObserving(this)
    releaseRenderer()
    super.onDetachedFromWindow()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    installRenderer()
    resubscribe()
    publishReadiness()
  }

  fun publishReadiness() {
    if (surfaceToken.isEmpty() || id == NO_ID) return
    val reactContext = context as? ReactContext ?: return
    val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
    dispatcher.dispatchEvent(FrameReadyEvent(UIManagerHelper.getSurfaceId(this), id, surfaceToken, generation, ready))
  }
}

private class FrameReadyEvent(
    surfaceId: Int, viewTag: Int, private val token: String,
    private val generation: Int, private val ready: Boolean,
) : Event<FrameReadyEvent>(surfaceId, viewTag) {
  override fun getEventName() = "topFrameReady"
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = Arguments.createMap().apply {
    putString("surfaceId", token)
    putInt("generation", generation)
    putBoolean("ready", ready)
  }
}
