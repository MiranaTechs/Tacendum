package com.miranatechnologies.tacendum.call

import org.webrtc.EglBase

/**
 * The one EGL context.
 *
 * Hardware encode and decode, the capture path's `SurfaceTextureHelper`, and
 * every `SurfaceViewRenderer` must share a context or frames are copied
 * through system memory between them — which on a video call is the difference
 * between a warm phone and a hot one.
 *
 * A process-wide singleton rather than a field on the module, because the
 * Fabric view manager creates renderers without a module reference and the
 * alternative is threading one through the view layer for a value that is
 * genuinely global. Created lazily on first use and never released: an EGL
 * context released while a renderer still holds it is a crash, and the only
 * moment at which nothing holds it is process death.
 */
internal object CallEgl {
  val base: EglBase by lazy { EglBase.create() }

  val context: EglBase.Context
    get() = base.eglBaseContext
}
