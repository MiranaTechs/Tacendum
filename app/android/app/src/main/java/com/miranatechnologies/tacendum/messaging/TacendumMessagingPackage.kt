package com.miranatechnologies.tacendum.messaging

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers [TacendumMessagingModule] with the React instance.
 *
 * Added by hand in MainApplication rather than autolinked, because this is not
 * a package — it is part of the application, and there is nothing for
 * autolinking to discover.
 *
 * `isTurboModule = false`, served through the bridgeless interop layer: the
 * same shape AppearancePrefsModule already uses in the crypto module, and for
 * the same reason — the surface is Android-only, and the shared codegen specs
 * must not grow methods iOS never implements.
 */
class TacendumMessagingPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when (name) {
        TacendumMessagingModule.NAME -> TacendumMessagingModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        TacendumMessagingModule.NAME to
            ReactModuleInfo(
                TacendumMessagingModule.NAME,
                TacendumMessagingModule.NAME,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                false, // isTurboModule
            ),
    )
  }
}
