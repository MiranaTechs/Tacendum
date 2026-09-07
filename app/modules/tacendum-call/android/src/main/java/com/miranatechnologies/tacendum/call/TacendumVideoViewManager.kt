package com.miranatechnologies.tacendum.call

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.TacendumVideoViewManagerDelegate
import com.facebook.react.viewmanagers.TacendumVideoViewManagerInterface

/**
 * The Fabric component that renders one call's video.
 *
 * **`cid` and `track` are applied TOGETHER.** Fabric hands props to the four
 * setters below one at a time, and the iOS file records what happens when each
 * one resubscribes on its own: the binding starts depending on the order and
 * completeness of the writes rather than on the props, and a recycled view
 * carries its previous life's track into the next call. Setters record the
 * props; the completed transaction binds them together with the surface token.
 * No intermediate binding may report a frame for the new view lifetime.
 */
@ReactModule(name = TacendumVideoViewManager.NAME)
class TacendumVideoViewManager :
    SimpleViewManager<TacendumVideoHost>(), TacendumVideoViewManagerInterface<TacendumVideoHost> {

  private val delegate: ViewManagerDelegate<TacendumVideoHost> =
      TacendumVideoViewManagerDelegate(this)

  /** Per-view prop state, so a bind always sees both halves. */
  private val pendingCid = HashMap<TacendumVideoHost, String>()
  private val pendingRole = HashMap<TacendumVideoHost, String>()
  private val pendingSurface = HashMap<TacendumVideoHost, String>()

  override fun getDelegate(): ViewManagerDelegate<TacendumVideoHost> = delegate

  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): TacendumVideoHost =
      TacendumVideoHost(context)

  override fun setCid(view: TacendumVideoHost, value: String?) {
    pendingCid[view] = value ?: ""
  }

  override fun setTrack(view: TacendumVideoHost, value: String?) {
    pendingRole[view] = value ?: DEFAULT_TRACK
  }

  override fun setSurfaceId(view: TacendumVideoHost, value: String?) {
    pendingSurface[view] = value ?: ""
  }

  override fun setMirror(view: TacendumVideoHost, value: Boolean) {
    view.setMirrored(value)
  }

  override fun setObjectFit(view: TacendumVideoHost, value: String?) {
    view.setObjectFit(value)
  }

  override fun onAfterUpdateTransaction(view: TacendumVideoHost) {
    super.onAfterUpdateTransaction(view)
    view.bind(pendingCid[view] ?: "", pendingRole[view] ?: DEFAULT_TRACK, pendingSurface[view] ?: "")
    view.publishReadiness()
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
      mapOf("topFrameReady" to mapOf("registrationName" to "onFrameReady"))

  /**
   * Fabric is done with this view — it goes back to the recycle pool, alive.
   *
   * Both halves matter: the host resets its own binding and destroys its
   * renderer, and the prop state kept here is dropped, or the map grows for
   * the life of the process and the next tenant of this instance inherits the
   * previous one's cid.
   */
  override fun onDropViewInstance(view: TacendumVideoHost) {
    pendingCid.remove(view)
    pendingRole.remove(view)
    pendingSurface.remove(view)
    view.resetForRecycle()
    super.onDropViewInstance(view)
  }

  companion object {
    const val NAME = "TacendumVideoView"

    /** The spec's own default for `track` — `remote` is the person you called. */
    private const val DEFAULT_TRACK = "remote"
  }
}
