#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>

#if __has_include(<TacendumAudioSpec/TacendumAudioSpec.h>)
#import <TacendumAudioSpec/TacendumAudioSpec.h>
#elif __has_include(<ReactCodegen/TacendumAudioSpec/TacendumAudioSpec.h>)
#import <ReactCodegen/TacendumAudioSpec/TacendumAudioSpec.h>
#else
#import "TacendumAudioSpec.h"
#endif

#if __has_include("TacendumAudio-Swift.h")
#import "TacendumAudio-Swift.h"
#else
#import <TacendumAudio/TacendumAudio-Swift.h>
#endif

/**
 * TurboModule shim over TacendumAudioImpl (Swift). Pure forwarding: every
 * policy — the temp-file lifetime, the call gate, one-player-at-a-time, the
 * decoded-duration truth — lives in the Swift class where it can be read in
 * one place.
 *
 * The event sinks are bound in `init` and torn down in `invalidate`, so the
 * Swift side can never emit into a TurboModule the runtime has destroyed.
 */
@interface TacendumAudio : NativeTacendumAudioSpecBase <NativeTacendumAudioSpec, RCTInvalidating>
@end

@implementation TacendumAudio

RCT_EXPORT_MODULE()

- (instancetype)init
{
  if ((self = [super init])) {
    // Anything a kill left in the recording directory dies at the first
    // moment this module exists in a new process — the dismissal cleanup
    // cannot run if the process was killed mid-recording.
    [[TacendumAudioImpl shared] sweepLeftovers];

    __weak TacendumAudio *weakSelf = self;
    [[TacendumAudioImpl shared]
        bindOnLevel:^(double level) {
          // Codegen types a numeric event as NSNumber, not double.
          [weakSelf emitOnLevel:@(level)];
        }
        onRecordingFinished:^(NSDictionary *result) {
          [weakSelf emitOnRecordingFinished:result];
        }
        onPlaybackFinished:^{
          [weakSelf emitOnPlaybackFinished];
        }
        onPlaybackProgress:^(double seconds) {
          [weakSelf emitOnPlaybackProgress:@(seconds)];
        }];
  }
  return self;
}

- (void)invalidate
{
  // Synchronous on the Swift side: after this returns no emit can land, the
  // microphone is not left hot for a runtime that no longer exists, and an
  // in-flight recording's plaintext file is deleted rather than orphaned.
  [[TacendumAudioImpl shared] invalidate];
}

- (void)startRecording:(double)maxSeconds
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumAudioImpl shared] startRecording:maxSeconds
                                     resolve:^{
                                       resolve(nil);
                                     }
                                      reject:^(NSString *code, NSString *message) {
                                        reject(code, message, nil);
                                      }];
}

- (void)stopRecording:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumAudioImpl shared] stopRecordingWithResolve:^(NSDictionary *result) {
    resolve(result);
  }
                                                reject:^(NSString *code, NSString *message) {
                                                  reject(code, message, nil);
                                                }];
}

- (void)cancelRecording:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  // Cancelling is idempotent by contract — safe to call when idle — so the
  // Swift side takes no reject block and this one is deliberately unused.
  [[TacendumAudioImpl shared] cancelRecordingWithResolve:^{
    resolve(nil);
  }];
}

- (void)startPlayback:(NSString *)dataB64
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumAudioImpl shared] startPlayback:dataB64
                                    resolve:^(double seconds) {
                                      // The decoded length, so JS can correct
                                      // a sender's claimed duration.
                                      resolve(@(seconds));
                                    }
                                     reject:^(NSString *code, NSString *message) {
                                       reject(code, message, nil);
                                     }];
}

- (void)stopPlayback:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumAudioImpl shared] stopPlaybackWithResolve:^{
    resolve(nil);
  }];
}

- (void)startRingback:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumAudioImpl shared] startRingbackWithResolve:^{
    resolve(nil);
  }
                                                reject:^(NSString *code, NSString *message) {
                                                  reject(code, message, nil);
                                                }];
}

- (void)stopRingback:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  // Stopping is idempotent by contract — safe when idle — so the Swift side
  // takes no reject block and this one is deliberately unused.
  [[TacendumAudioImpl shared] stopRingbackWithResolve:^{
    resolve(nil);
  }];
}

- (void)playMessageTone:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  // Resolves quietly on every path — a call up, a tone file that would not
  // write, a player that refused — because it is fired with `void` from a
  // delivery path that must never fail over a sound. The Swift side takes
  // no reject block and this one is deliberately unused.
  [[TacendumAudioImpl shared] playMessageToneWithResolve:^{
    resolve(nil);
  }];
}

- (void)sweepTemp:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [[TacendumAudioImpl shared] sweepTempWithResolve:^{
    resolve(nil);
  }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeTacendumAudioSpecJSI>(params);
}

@end
