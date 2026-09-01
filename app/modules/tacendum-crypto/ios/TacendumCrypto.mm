#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#if __has_include(<TacendumCryptoSpec/TacendumCryptoSpec.h>)
#import <TacendumCryptoSpec/TacendumCryptoSpec.h>
#elif __has_include(<ReactCodegen/TacendumCryptoSpec/TacendumCryptoSpec.h>)
#import <ReactCodegen/TacendumCryptoSpec/TacendumCryptoSpec.h>
#else
#import "TacendumCryptoSpec.h"
#endif

#if __has_include("TacendumCrypto-Swift.h")
#import "TacendumCrypto-Swift.h"
#else
#import <TacendumCrypto/TacendumCrypto-Swift.h>
#endif

/**
 * TurboModule shim: marshals promises onto a serial queue and delegates every
 * operation to TacendumCryptoImpl (Swift), which owns all libsignal calls and
 * protocol state. Payload contents are never logged.
 */
@interface TacendumCrypto : NSObject <NativeTacendumCryptoSpec>
@end

@implementation TacendumCrypto

RCT_EXPORT_MODULE()

/**
 * Process-global serial queue. The queue must be shared across every
 * TacendumCrypto instance because the on-disk stores (TacendumCryptoImpl.shared)
 * are process-global: a Metro/dev reload re-instantiates the TurboModule, and a
 * per-instance queue would let the new instance's blocks run libsignal store
 * access concurrently with blocks still draining on the old instance's queue.
 */
+ (dispatch_queue_t)sharedQueue
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("com.tacendum.crypto", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeTacendumCryptoSpecJSI>(params);
}

static void rejectWithError(RCTPromiseRejectBlock reject, NSString *op, NSError *error)
{
  NSString *message = error.localizedDescription
      ?: [NSString stringWithFormat:@"%@ failed", op];
  // Surface an identity change (safety-number change) as a distinct code so the
  // JS layer can block-and-warn rather than treat it as generic corruption.
  NSString *code = @"crypto_error";
  if ([message hasPrefix:@"identity_changed"]) {
    code = @"identity_changed";
  } else if ([message hasPrefix:@"store_busy"]) {
    // The store lock timed out — the notification extension holds it. The JS
    // layer must retry via redelivery rather than poison the message.
    code = @"store_busy";
  }
  reject(code, message, error);
}

- (void)generateAndStoreKeys:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] generateAndStoreKeysAndReturnError:&error];
    if (result == nil) {
      rejectWithError(reject, @"generateAndStoreKeys", error);
    } else {
      resolve(result);
    }
  });
}

- (void)existingKeysForUpload:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] existingKeysForUploadAndReturnError:&error];
    if (result == nil) {
      rejectWithError(reject, @"existingKeysForUpload", error);
    } else {
      resolve(result);
    }
  });
}

- (void)hasIdentity:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSNumber *present = [[TacendumCryptoImpl shared] hasIdentityAndReturnError:&error];
    if (present == nil) {
      rejectWithError(reject, @"hasIdentity", error);
    } else {
      resolve(present);
    }
  });
}

- (void)processPreKeyBundle:(NSString *)bundleJson
                 selfUserId:(NSString *)selfUserId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] processPreKeyBundle:bundleJson
                                                    selfUserId:selfUserId
                                                         error:&error];
    if (!ok) {
      rejectWithError(reject, @"processPreKeyBundle", error);
    } else {
      resolve(nil);
    }
  });
}

- (void)hasSession:(NSString *)peerUserId
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSNumber *result = [[TacendumCryptoImpl shared] hasSession:peerUserId error:&error];
    if (result == nil) {
      rejectWithError(reject, @"hasSession", error);
    } else {
      resolve(result);
    }
  });
}

- (void)safetyNumber:(NSString *)selfUserId
          peerUserId:(NSString *)peerUserId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] safetyNumber:selfUserId
                                                      peerUserId:peerUserId
                                                           error:&error];
    if (result == nil) {
      rejectWithError(reject, @"safetyNumber", error);
    } else {
      resolve(result);
    }
  });
}

- (void)resetPeer:(NSString *)peerUserId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] resetPeerIdentity:peerUserId error:&error];
    if (!ok) {
      rejectWithError(reject, @"resetPeer", error);
    } else {
      resolve(nil);
    }
  });
}

- (void)encryptText:(NSString *)selfUserId
         peerUserId:(NSString *)peerUserId
          plaintext:(NSString *)plaintext
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] encryptText:selfUserId
                                                     peerUserId:peerUserId
                                                      plaintext:plaintext
                                                          error:&error];
    if (result == nil) {
      rejectWithError(reject, @"encryptText", error);
    } else {
      resolve(result);
    }
  });
}

- (void)decryptEnvelope:(NSString *)selfUserId
           senderUserId:(NSString *)senderUserId
                msgType:(NSString *)msgType
             payloadB64:(NSString *)payloadB64
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] decryptEnvelope:selfUserId
                                                       senderUserId:senderUserId
                                                            msgType:msgType
                                                         payloadB64:payloadB64
                                                              error:&error];
    if (result == nil) {
      rejectWithError(reject, @"decryptEnvelope", error);
    } else {
      resolve(result);
    }
  });
}

- (void)randomBytes:(double)count
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] randomBytes:(NSInteger)count error:&error];
    if (result == nil) {
      rejectWithError(reject, @"randomBytes", error);
    } else {
      resolve(result);
    }
  });
}

- (void)sha256:(NSString *)dataB64
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] sha256:dataB64 error:&error];
    if (result == nil) {
      rejectWithError(reject, @"sha256", error);
    } else {
      resolve(result);
    }
  });
}

- (void)blobEncrypt:(NSString *)plaintextB64
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] blobEncrypt:plaintextB64 error:&error];
    if (result == nil) {
      rejectWithError(reject, @"blobEncrypt", error);
    } else {
      resolve(result);
    }
  });
}

- (void)signAuthChallenge:(NSString *)challengeB64
                apiOrigin:(NSString *)apiOrigin
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] signAuthChallenge:challengeB64
                                                            apiOrigin:apiOrigin
                                                                error:&error];
    if (result == nil) {
      rejectWithError(reject, @"signAuthChallenge", error);
    } else {
      resolve(result);
    }
  });
}

- (void)signLinkOp:(NSString *)op
           groupId:(NSString *)groupId
     offererUserId:(NSString *)offererUserId
    acceptorUserId:(NSString *)acceptorUserId
subjectIdentityPubKeyB64:(NSString *)subjectIdentityPubKeyB64
       deviceClass:(NSString *)deviceClass
       rosterEpoch:(NSString *)rosterEpoch
        offerNonce:(NSString *)offerNonce
         expiresAt:(NSString *)expiresAt
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] signLinkOp:op
                                                       groupId:groupId
                                                 offererUserId:offererUserId
                                                acceptorUserId:acceptorUserId
                                      subjectIdentityPubKeyB64:subjectIdentityPubKeyB64
                                                   deviceClass:deviceClass
                                                   rosterEpoch:rosterEpoch
                                                    offerNonce:offerNonce
                                                     expiresAt:expiresAt
                                                         error:&error];
    if (result == nil) {
      rejectWithError(reject, @"signLinkOp", error);
    } else {
      resolve(result);
    }
  });
}

- (void)verifyLinkOp:(NSString *)identityPubKeyB64
                  op:(NSString *)op
             groupId:(NSString *)groupId
       offererUserId:(NSString *)offererUserId
      acceptorUserId:(NSString *)acceptorUserId
subjectIdentityPubKeyB64:(NSString *)subjectIdentityPubKeyB64
         deviceClass:(NSString *)deviceClass
         rosterEpoch:(NSString *)rosterEpoch
          offerNonce:(NSString *)offerNonce
           expiresAt:(NSString *)expiresAt
        signatureB64:(NSString *)signatureB64
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSNumber *result = [[TacendumCryptoImpl shared] verifyLinkOp:identityPubKeyB64
                                                              op:op
                                                         groupId:groupId
                                                   offererUserId:offererUserId
                                                  acceptorUserId:acceptorUserId
                                        subjectIdentityPubKeyB64:subjectIdentityPubKeyB64
                                                     deviceClass:deviceClass
                                                     rosterEpoch:rosterEpoch
                                                      offerNonce:offerNonce
                                                       expiresAt:expiresAt
                                                    signatureB64:signatureB64
                                                           error:&error];
    if (result == nil) {
      rejectWithError(reject, @"verifyLinkOp", error);
    } else {
      resolve(result);
    }
  });
}

- (void)identityPublicKey:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] identityPublicKeyAndReturnError:&error];
    if (result == nil) {
      rejectWithError(reject, @"identityPublicKey", error);
    } else {
      resolve(result);
    }
  });
}

- (void)pinVerifier:(NSString *)pin
            saltB64:(NSString *)saltB64
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] pinVerifier:pin saltB64:saltB64 error:&error];
    if (result == nil) {
      rejectWithError(reject, @"pinVerifier", error);
    } else {
      resolve(result);
    }
  });
}

- (void)blobDecrypt:(NSString *)keyB64
            blobB64:(NSString *)blobB64
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] blobDecrypt:keyB64 blobB64:blobB64 error:&error];
    if (result == nil) {
      rejectWithError(reject, @"blobDecrypt", error);
    } else {
      resolve(result);
    }
  });
}

- (void)getSecret:(NSString *)key
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    NSString *result = [[TacendumCryptoImpl shared] getSecret:key error:&error];
    if (result == nil) {
      rejectWithError(reject, @"getSecret", error);
    } else {
      resolve(result);
    }
  });
}

- (void)setSecret:(NSString *)key
            value:(NSString *)value
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] setSecret:key value:value error:&error];
    if (!ok) {
      rejectWithError(reject, @"setSecret", error);
    } else {
      resolve(nil);
    }
  });
}

- (void)deleteSecret:(NSString *)key
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] deleteSecret:key error:&error];
    if (!ok) {
      rejectWithError(reject, @"deleteSecret", error);
    } else {
      resolve(nil);
    }
  });
}

- (void)writeSharedState:(NSString *)name
                   value:(NSString *)value
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] writeSharedState:name value:value error:&error];
    if (!ok) {
      rejectWithError(reject, @"writeSharedState", error);
    } else {
      resolve(nil);
    }
  });
}

- (void)readSharedState:(NSString *)name
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    resolve([[TacendumCryptoImpl shared] readSharedState:name]);
  });
}

- (void)deleteSharedState:(NSString *)name
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] deleteSharedState:name error:&error];
    if (!ok) {
      rejectWithError(reject, @"deleteSharedState", error);
    } else {
      resolve(nil);
    }
  });
}

- (NSString *)prepareDatabaseDirectory:(NSString *)fileName
{
  // SYNCHRONOUS — the spec declares a non-Promise return, so codegen makes
  // this a sync JSI call — and deliberately NOT on the serial queue: the
  // caller (db.ts conn()) must have the migration finished before op-sqlite
  // opens the database, and this touches only the Library-root database
  // files, which nothing on the crypto queue reads or writes. Failures
  // travel inside the returned JSON (see the Swift impl), so there is no
  // promise to reject.
  return [[TacendumCryptoImpl shared] prepareDatabaseDirectory:fileName];
}

- (void)readInbox:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    resolve([[TacendumCryptoImpl shared] readInbox]);
  });
}

- (void)clearInboxEntry:(NSString *)msgId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] clearInboxEntry:msgId error:&error];
    if (!ok) {
      rejectWithError(reject, @"clearInboxEntry", error);
    } else {
      resolve(nil);
    }
  });
}

- (void)resetProtocolState:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async([TacendumCrypto sharedQueue], ^{
    NSError *error = nil;
    BOOL ok = [[TacendumCryptoImpl shared] resetProtocolStateAndReturnError:&error];
    if (!ok) {
      rejectWithError(reject, @"resetProtocolState", error);
    } else {
      resolve(nil);
    }
  });
}

@end
