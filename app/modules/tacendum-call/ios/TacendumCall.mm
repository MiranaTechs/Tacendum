#import <AVFoundation/AVFoundation.h>
#import <CallKit/CallKit.h>
#import <Foundation/Foundation.h>
#import <PushKit/PushKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>

// CallKit and PushKit are imported BEFORE the generated -Swift.h on purpose.
// That header declares CallKitCenter's `CXProviderDelegate` and
// `PKPushRegistryDelegate` conformances, so without these the header cannot
// parse — and the failure does not read as a missing import. It reads as
// every selector on every Swift class in the module suddenly not existing.

#if __has_include(<TacendumCallSpec/TacendumCallSpec.h>)
#import <TacendumCallSpec/TacendumCallSpec.h>
#elif __has_include(<ReactCodegen/TacendumCallSpec/TacendumCallSpec.h>)
#import <ReactCodegen/TacendumCallSpec/TacendumCallSpec.h>
#else
#import "TacendumCallSpec.h"
#endif

#if __has_include("TacendumCall-Swift.h")
#import "TacendumCall-Swift.h"
#else
#import <TacendumCall/TacendumCall-Swift.h>
#endif

/**
 * TurboModule shim for calling.
 *
 * Every method forwards to TacendumCallImpl (Swift) and every event comes back
 * through a single emitter closure that this class fans out to the codegen
 * emitters. Nothing here decides anything — it is a translation layer between
 * the codegen ABI and Swift, and the reasoning lives on both sides of it.
 */
@interface TacendumCall : NativeTacendumCallSpecBase <NativeTacendumCallSpec, RCTInvalidating>
@end

@implementation TacendumCall

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  // CallKit and PushKit registration both touch main-thread-only APIs, but
  // neither happens at construction — they happen when JS asks. Setting this
  // YES would block startup on work nothing has requested yet.
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    // Rebind on every construction: a Metro reload creates a fresh
    // TurboModule whose emitter must replace the one the Swift singleton is
    // still holding, or events land in a destroyed C++ half.
    __weak TacendumCall *weakSelf = self;
    [[TacendumCallImpl shared] bindEmitter:^(NSString *event, NSString *payload) {
      TacendumCall *strongSelf = weakSelf;
      if (strongSelf == nil) {
        return;
      }
      [strongSelf dispatch:event payload:payload];
    }];
  }
  return self;
}

/// Fan one (name, json) pair out to the right codegen emitter.
- (void)dispatch:(NSString *)event payload:(NSString *)payload
{
  if ([event isEqualToString:@"iceCandidate"]) {
    [self emitOnIceCandidate:payload];
  } else if ([event isEqualToString:@"iceState"]) {
    [self emitOnIceState:payload];
  } else if ([event isEqualToString:@"connectionState"]) {
    [self emitOnConnectionState:payload];
  } else if ([event isEqualToString:@"remoteTrackAdded"]) {
    [self emitOnRemoteTrackAdded:payload];
  } else if ([event isEqualToString:@"remoteTrackRemoved"]) {
    [self emitOnRemoteTrackRemoved:payload];
  } else if ([event isEqualToString:@"callKitAnswer"]) {
    [self emitOnCallKitAnswer:payload];
  } else if ([event isEqualToString:@"callKitEnd"]) {
    [self emitOnCallKitEnd:payload];
  } else if ([event isEqualToString:@"callKitMute"]) {
    [self emitOnCallKitMute:payload];
  } else if ([event isEqualToString:@"callKitAudioActivated"]) {
    [self emitOnCallKitAudioActivated:payload];
  } else if ([event isEqualToString:@"callKitAudioDeactivated"]) {
    [self emitOnCallKitAudioDeactivated:payload];
  } else if ([event isEqualToString:@"voipPush"]) {
    [self emitOnVoipPush:payload];
  } else if ([event isEqualToString:@"voipTokenUpdated"]) {
    [self emitOnVoipTokenUpdated:payload];
  } else if ([event isEqualToString:@"alertTokenUpdated"]) {
    [self emitOnAlertTokenUpdated:payload];
  } else if ([event isEqualToString:@"audioRouteChanged"]) {
    [self emitOnAudioRouteChanged:payload];
  } else if ([event isEqualToString:@"thermalStateChanged"]) {
    [self emitOnThermalStateChanged:payload];
  } else if ([event isEqualToString:@"statsSample"]) {
    [self emitOnStatsSample:payload];
  }
}

#pragma mark - lifecycle

- (void)configure:(NSString *)iceServersJson
        relayOnly:(BOOL)relayOnly
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] configureWithIceServersJson:iceServersJson
                                               relayOnly:relayOnly
                                                 resolve:resolve
                                                  reject:reject];
}

- (void)createOffer:(NSString *)cid
          withVideo:(BOOL)withVideo
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] createOfferWithCid:cid
                                      withVideo:withVideo
                                        resolve:resolve
                                         reject:reject];
}

- (void)createAnswer:(NSString *)cid
      remoteOfferSdp:(NSString *)remoteOfferSdp
           withVideo:(BOOL)withVideo
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] createAnswerWithCid:cid
                                  remoteOfferSdp:remoteOfferSdp
                                       withVideo:withVideo
                                         resolve:resolve
                                          reject:reject];
}

- (void)setRemoteAnswer:(NSString *)cid
                    sdp:(NSString *)sdp
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] setRemoteAnswerWithCid:cid sdp:sdp resolve:resolve reject:reject];
}

- (void)addIceCandidates:(NSString *)cid
          candidatesJson:(NSString *)candidatesJson
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] addIceCandidatesWithCid:cid
                                      candidatesJson:candidatesJson
                                             resolve:resolve
                                              reject:reject];
}

- (void)restartIce:(NSString *)cid
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] restartIceWithCid:cid resolve:resolve reject:reject];
}

- (void)close:(NSString *)cid
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] closeCallWithCid:cid resolve:resolve reject:reject];
}

#pragma mark - media

// The APPLIED VERDICT crosses the bridge. Resolving nil
// here — which is what these did — threw away the one fact a small-group
// session needs: whether that leg's track was actually changed. JS turns the
// boolean into all-or-close-the-leg; a promise that always resolved the same
// value made that guarantee exist only in the tests.
- (void)setAudioEnabled:(NSString *)cid
                     on:(BOOL)on
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  BOOL applied = [[TacendumCallImpl shared] setAudioEnabledWithCid:cid on:on];
  resolve(@(applied));
}

- (void)setVideoEnabled:(NSString *)cid
                     on:(BOOL)on
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  BOOL applied = [[TacendumCallImpl shared] setVideoEnabledWithCid:cid on:on];
  resolve(@(applied));
}

- (void)switchCamera:(NSString *)cid
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] switchCameraWithCid:cid];
  resolve(nil);
}

- (void)setSpeaker:(NSString *)cid
                on:(BOOL)on
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] setSpeakerEnabled:on];
  resolve(nil);
}

- (void)getStats:(NSString *)cid
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] getStatsWithCid:cid resolve:resolve];
}

#pragma mark - CallKit

- (void)reportOutgoingCall:(NSString *)cid
                    handle:(NSString *)handle
                     video:(BOOL)video
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [[CallKitCenter shared] reportOutgoingCallWithCid:cid handle:handle hasVideo:video];
  resolve(nil);
}

- (void)reportOutgoingConnected:(NSString *)cid
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  [[CallKitCenter shared] reportOutgoingConnectedWithCid:cid];
  resolve(nil);
}

- (void)reportIncomingCall:(NSString *)cid
                    peerId:(NSString *)peerId
                    handle:(NSString *)handle
               displayName:(NSString *)displayName
                  hasVideo:(BOOL)hasVideo
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [[CallKitCenter shared] reportIncomingCallWithCid:cid
                                             peerId:peerId
                                             handle:handle
                                        displayName:displayName
                                           hasVideo:hasVideo
                                         completion:^(NSError *error) {
    if (error != nil) {
      reject(@"report_failed", error.localizedDescription, error);
    } else {
      resolve(nil);
    }
  }];
}

// `cid` names the placeholder being dismissed, '' to match whatever is pending
// for the peer. The parameter order matches the TurboModule spec exactly; the
// generated Swift selector is dismissPendingIncomingCallWithPeerId:reason:cid:.
- (void)dismissPendingIncomingCall:(NSString *)peerId
                            reason:(NSString *)reason
                               cid:(NSString *)cid
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  [[CallKitCenter shared] dismissPendingIncomingCallWithPeerId:peerId reason:reason cid:cid];
  resolve(nil);
}

- (void)updateIncomingCallDisplay:(NSString *)cid
                      displayName:(NSString *)displayName
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  [[CallKitCenter shared] updateDisplayWithCid:cid displayName:displayName];
  resolve(nil);
}

- (void)endCall:(NSString *)cid
         reason:(NSString *)reason
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  [[CallKitCenter shared] endCallWithCid:cid reason:reason];
  resolve(nil);
}

#pragma mark - PushKit

- (void)getVoipToken:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([[CallKitCenter shared] currentVoipToken]);
}

- (void)registerForVoipPush:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [[CallKitCenter shared] registerForVoipPush];
  resolve(nil);
}

#pragma mark - message notifications

- (void)requestNotificationPermission:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] requestNotificationPermissionWithResolve:resolve reject:reject];
}

- (void)getAlertToken:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([[TacendumCallImpl shared] currentAlertToken]);
}

- (void)bundleId:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([[TacendumCallImpl shared] bundleIdentifier]);
}

- (void)setBadgeCount:(double)count
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  // Clamped, not trusted: codegen types this as a double because JS has one
  // number type, and a negative or fractional badge is a UIKit no-op at best.
  [[TacendumCallImpl shared] setBadgeCount:(NSInteger)MAX(0, (long)count)];
  resolve(nil);
}

#pragma mark - device pressure

- (void)startMonitoringPressure:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] startMonitoringPressure];
  resolve(nil);
}

- (void)stopMonitoringPressure:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] stopMonitoringPressure];
  resolve(nil);
}

- (void)applyVideoCap:(NSString *)cid
          maxLongEdge:(double)maxLongEdge
               maxFps:(double)maxFps
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] applyVideoCapWithCid:cid
                                      maxLongEdge:(NSInteger)maxLongEdge
                                           maxFps:(NSInteger)maxFps
                                          resolve:resolve
                                           reject:reject];
}

- (void)sampleQuality:(NSString *)cid
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] sampleQualityWithCid:cid resolve:resolve reject:reject];
}

#pragma mark - event readiness

- (void)flushPendingEvents:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] flushPendingEvents];
  resolve(nil);
}

#pragma mark - permissions

- (void)cameraPermission:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([[TacendumCallImpl shared] cameraPermission]);
}

- (void)micPermission:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([[TacendumCallImpl shared] micPermission]);
}

- (void)requestPermissions:(BOOL)video
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] requestPermissionsWithVideo:video resolve:resolve];
}

- (void)enableFingerprintFault:(BOOL)on
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] enableFingerprintFault:on];
  resolve(nil);
}

- (void)runSharedCaptureSpike:(double)legs
                      seconds:(double)seconds
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  // The capture spike. Long-running by design (it asks for ten minutes),
  // so the implementation resolves from its own queue rather than blocking
  // here — a spike that froze the UI thread would change the very thermal
  // numbers it exists to measure.
  [[TacendumCallImpl shared] runSharedCaptureSpikeWithLegs:(NSInteger)legs
                                                   seconds:seconds
                                                   resolve:^(id result) {
                                                     resolve(result);
                                                   }];
}

- (void)enableSyntheticVideo:(BOOL)on
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumCallImpl shared] enableSyntheticVideo:on];
  resolve(nil);
}

#pragma mark - teardown

- (void)invalidate
{
  // A reload must not leave the Swift singleton emitting into a TurboModule
  // whose C++ half is being destroyed. The next init rebinds.
  //
  // `suspendEvents` before the rebind, not instead of it: an empty block would
  // swallow whatever CallKit raises during the reload, and a reload with a
  // call up is exactly when that matters. Suspending buffers those instead,
  // and the reloaded JS releases them when its listeners are attached.
  [[TacendumCallImpl shared] suspendEvents];
  [[TacendumCallImpl shared] bindEmitter:^(NSString *event, NSString *payload) {
  }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeTacendumCallSpecJSI>(params);
}

@end
