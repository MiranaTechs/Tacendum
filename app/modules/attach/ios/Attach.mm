#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#if __has_include(<AttachSpec/AttachSpec.h>)
#import <AttachSpec/AttachSpec.h>
#elif __has_include(<ReactCodegen/AttachSpec/AttachSpec.h>)
#import <ReactCodegen/AttachSpec/AttachSpec.h>
#else
#import "AttachSpec.h"
#endif

#if __has_include("Attach-Swift.h")
#import "Attach-Swift.h"
#else
#import <Attach/Attach-Swift.h>
#endif

/**
 * TurboModule shim over AttachImpl (Swift). Pure forwarding: every policy —
 * size caps, one-at-a-time presentation, temp-file lifetime — lives in the
 * Swift class where it can be read in one place.
 */
@interface Attach : NativeAttachSpecBase <NativeAttachSpec>
@end

@implementation Attach

RCT_EXPORT_MODULE()

/// Anything a force-kill left in the preview directory dies here, at the
/// first moment this module exists in a new process.
- (instancetype)init
{
  if ((self = [super init])) {
    [[AttachImpl shared] sweepPreviewLeftovers];
  }
  return self;
}

- (void)pickDocument:(double)maxBytes
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [[AttachImpl shared] pickDocument:maxBytes
                            resolve:^(NSDictionary *_Nullable doc) {
                              resolve(doc ?: (id)kCFNull);
                            }
                             reject:^(NSString *code, NSString *message) {
                               reject(code, message, nil);
                             }];
}

- (void)currentLocation:(double)timeoutMs
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[AttachImpl shared] currentLocation:timeoutMs
                               resolve:^(NSDictionary *loc) {
                                 resolve(loc);
                               }
                                reject:^(NSString *code, NSString *message) {
                                  reject(code, message, nil);
                                }];
}

- (void)previewFile:(NSString *)dataB64
               name:(NSString *)name
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [[AttachImpl shared] previewFile:dataB64
                              name:name
                           resolve:^{
                             resolve(nil);
                           }
                            reject:^(NSString *code, NSString *message) {
                              reject(code, message, nil);
                            }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeAttachSpecJSI>(params);
}

@end
