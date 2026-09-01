package com.miranatechnologies.tacendum

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.miranatechnologies.tacendum.messaging.TacendumMessagingPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Background delivery. NOT autolinked, and it
          // cannot be: the foreground service that holds the socket, its
          // notification channels and the manifest entry that declares the
          // service all belong to the APPLICATION rather than to any of the
          // six native modules under app/modules/. Autolinking discovers
          // packages; this is not one.
          add(TacendumMessagingPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
