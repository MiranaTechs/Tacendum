#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>

#if __has_include(<ScreenSecuritySpec/ScreenSecuritySpec.h>)
#import <ScreenSecuritySpec/ScreenSecuritySpec.h>
#elif __has_include(<ReactCodegen/ScreenSecuritySpec/ScreenSecuritySpec.h>)
#import <ReactCodegen/ScreenSecuritySpec/ScreenSecuritySpec.h>
#else
#import "ScreenSecuritySpec.h"
#endif

#if __has_include("ScreenSecurity-Swift.h")
#import "ScreenSecurity-Swift.h"
#else
#import <ScreenSecurity/ScreenSecurity-Swift.h>
#endif

/**
 * TurboModule shim: forwards capture/screenshot notifications from
 * ScreenSecurityImpl (Swift) to JS as codegen events. The app-switcher cover
 * arms in +load, independent of the JS runtime — see NativeScreenSecurity.ts.
 */
@interface ScreenSecurity : NativeScreenSecuritySpecBase <NativeScreenSecuritySpec, RCTInvalidating>
@end

// Arms at image load (RCT_EXPORT_MODULE already owns +load). Observers only;
// no UIKit work happens until the lifecycle notifications fire on the main
// thread. This must not wait for JS: the cover exists to beat the OS snapshot
// that a fast app switch triggers before the bundle has even loaded.
__attribute__((constructor)) static void TacendumArmSwitcherCover(void)
{
  [ScreenSecurityImpl activateSwitcherCover];
}

@implementation ScreenSecurity

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (void)start
{
  // Rebind on every call: a Metro/dev reload creates a fresh TurboModule
  // instance whose emitter must replace the stale one held by the singleton.
  __weak ScreenSecurity *weakSelf = self;
  [[ScreenSecurityImpl shared]
      startOnCapturedChanged:^(BOOL captured) {
        [weakSelf emitOnCapturedChanged:captured];
      }
      onScreenshot:^{
        [weakSelf emitOnScreenshot];
      }];
}

- (void)getIsCaptured:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(@([ScreenSecurityImpl isCapturedNow]));
  });
}

- (void)invalidate
{
  // Runtime teardown (reload/shutdown): drop the singleton's sinks with
  // main-thread synchronization so a capture/screenshot notification landing
  // mid-teardown can never emit into a TurboModule whose C++ half is being
  // destroyed. TurboModuleManager waits for invalidate before freeing it,
  // and both notification callbacks fire on the main thread — clearing the
  // sinks there closes the race completely. The next start() rebinds.
  if (NSThread.isMainThread) {
    [[ScreenSecurityImpl shared] stop];
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      [[ScreenSecurityImpl shared] stop];
    });
  }
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeScreenSecuritySpecJSI>(params);
}

@end
