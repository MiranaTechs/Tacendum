package com.miranatechnologies.tacendum.crypto

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class TacendumCryptoPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      when (name) {
        NativeTacendumCryptoSpec.NAME -> TacendumCryptoModule(reactContext)
        AppearancePrefsModule.NAME -> AppearancePrefsModule(reactContext)
        else -> null
      }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        NativeTacendumCryptoSpec.NAME to
            ReactModuleInfo(
                NativeTacendumCryptoSpec.NAME,
                NativeTacendumCryptoSpec.NAME,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                true, // isTurboModule
            ),
        // The SharedPreferences appearance accessor: a plain module served
        // through the TurboModule interop layer (isTurboModule=false), so the
        // shared codegen specs stay identical across platforms.
        AppearancePrefsModule.NAME to
            ReactModuleInfo(
                AppearancePrefsModule.NAME,
                AppearancePrefsModule.NAME,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                false, // isTurboModule
            ),
    )
  }
}
