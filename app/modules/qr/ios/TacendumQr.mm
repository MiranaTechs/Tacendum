#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

// AVFoundation BEFORE the generated -Swift.h, for the same reason TacendumCall.mm
// documents: that header declares QrScannerController's
// `AVCaptureMetadataOutputObjectsDelegate` conformance, and without this it
// cannot parse. The failure does not read as a missing import — it reads as
// "cannot find protocol declaration", and in the sibling module it read as
// every Swift type in the module ceasing to exist.
//
// Third time this pattern has cost a build. The rule: if a Swift class in a
// module conforms to a protocol from an Apple framework, every .mm that
// imports that module's -Swift.h must import the framework first.

#if __has_include(<TacendumQrSpec/TacendumQrSpec.h>)
#import <TacendumQrSpec/TacendumQrSpec.h>
#elif __has_include(<ReactCodegen/TacendumQrSpec/TacendumQrSpec.h>)
#import <ReactCodegen/TacendumQrSpec/TacendumQrSpec.h>
#else
#import "TacendumQrSpec.h"
#endif

#if __has_include("TacendumQr-Swift.h")
#import "TacendumQr-Swift.h"
#else
#import <TacendumQr/TacendumQr-Swift.h>
#endif

/**
 * TurboModule shim: forwards each call to TacendumQrImpl (Swift), which owns
 * CoreImage, Vision and the one file in Caches. The module is stateless — no
 * serial queue, unlike TacendumCrypto, because there are no shared stores to
 * protect — so every call goes straight to a global concurrent queue. Vision
 * in particular must never run on the main thread.
 *
 * Payloads are never logged: the reject codes below describe
 * the failure, never the id being drawn or the string that was decoded.
 */
@interface TacendumQr : NSObject <NativeTacendumQrSpec>
@end

@implementation TacendumQr

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeTacendumQrSpecJSI>(params);
}

/**
 * Preserves the Swift side's own code when it set one, so a rejection stays
 * diagnosable. app/src/qr.ts deliberately does NOT branch on these — they all
 * end in the same sentence for the person — but a crash report or a Metro log
 * that says which half failed is worth the six characters.
 */
static void rejectQr(RCTPromiseRejectBlock reject, NSString *fallbackCode, NSError *error)
{
  NSString *code = error.domain != nil && [error.domain isEqualToString:@"TacendumQr"] && error.userInfo[@"code"] != nil
      ? error.userInfo[@"code"] : fallbackCode;
  reject(code, error.localizedDescription ?: fallbackCode, error);
}

- (void)encodePng:(NSString *)text
           pixels:(double)pixels
          darkHex:(NSString *)darkHex
         lightHex:(NSString *)lightHex
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    // Codegen types every JS number as a double; the Swift side takes the
    // requested edge as a whole number of pixels and clamps it there.
    NSString *result = [[TacendumQrImpl shared] encodePng:text
                                                  pixels:(NSInteger)pixels
                                                 darkHex:darkHex
                                                lightHex:lightHex
                                                   error:&error];
    if (result == nil) {
      rejectQr(reject, @"qr_encode_failed", error);
    } else {
      resolve(result);
    }
  });
}

- (void)scanWithCamera:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  // Resolves with the payload array, or with an EMPTY array when the person
  // cancels or there is no usable camera. Empty rather than a rejection: a
  // cancel is not an error, and `app/src/qr.ts` already treats "no codes" as
  // its own outcome (QrNoCode) rather than as a failure.
  __block BOOL settled = NO;
  [[TacendumQrImpl shared]
      presentScannerOnResult:^(NSArray<NSString *> *payloads) {
        if (settled) return;
        settled = YES;
        resolve(payloads);
      }
      onCancel:^{
        if (settled) return;
        settled = YES;
        resolve(@[]);
      }];
}

- (void)decodeFile:(NSString *)fileUri
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    NSArray<NSString *> *payloads = [[TacendumQrImpl shared] decodeFile:fileUri error:&error];
    if (payloads == nil) {
      rejectQr(reject, @"qr_decode_failed", error);
    } else {
      // An empty array means "no QR in this picture", which is an ordinary
      // outcome and resolves. Only a broken read rejects.
      resolve(payloads);
    }
  });
}

- (void)writeSharePng:(NSString *)pngB64
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    NSString *uri = [[TacendumQrImpl shared] writeSharePng:pngB64 error:&error];
    if (uri == nil) {
      rejectQr(reject, @"qr_write_failed", error);
    } else {
      resolve(uri);
    }
  });
}

- (void)clearSharePng:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    // Hygiene, so it resolves either way: a file that was never written and a
    // file that is already gone are both the state this asks for.
    [[TacendumQrImpl shared] clearSharePngAndReturnError:NULL];
    resolve(nil);
  });
}

@end
