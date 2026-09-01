package com.miranatechnologies.tacendum.call

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.ModuleSpec
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class TacendumCallPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == NativeTacendumCallSpec.NAME) TacendumCallModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        NativeTacendumCallSpec.NAME to
            ReactModuleInfo(
                NativeTacendumCallSpec.NAME,
                NativeTacendumCallSpec.NAME,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                true, // isTurboModule
            )
    )
  }

  override fun getViewManagers(reactContext: ReactApplicationContext): List<ModuleSpec> =
      listOf(ModuleSpec.viewManagerSpec { TacendumVideoViewManager() })
}
