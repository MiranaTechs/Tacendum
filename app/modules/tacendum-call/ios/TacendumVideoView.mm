#import <CallKit/CallKit.h>
#import <Foundation/Foundation.h>
#import <PushKit/PushKit.h>
#import <UIKit/UIKit.h>

// CallKit and PushKit BEFORE the generated -Swift.h, for the same reason
// TacendumCall.mm documents: that header declares CallKitCenter's
// CXProviderDelegate and PKPushRegistryDelegate conformances, and without
// these it cannot parse. The failure does not read as a missing import — it
// reads as every Swift type in the module ceasing to exist. Learned once in
// the sibling file and promptly repeated here.

#import <React/RCTViewComponentView.h>
#import <react/renderer/components/TacendumCallSpec/ComponentDescriptors.h>
#import <react/renderer/components/TacendumCallSpec/EventEmitters.h>
#import <react/renderer/components/TacendumCallSpec/Props.h>
#import <react/renderer/components/TacendumCallSpec/RCTComponentViewHelpers.h>

#if __has_include("TacendumCall-Swift.h")
#import "TacendumCall-Swift.h"
#else
#import <TacendumCall/TacendumCall-Swift.h>
#endif

using namespace facebook::react;

/**
 * Fabric component view for `TacendumVideoView`.
 *
 * All of the rendering behaviour lives in `TacendumVideoHost` (Swift); this
 * exists only to translate codegen props into calls on it. Keeping the split
 * means the interesting decisions — which track, what to show before one
 * arrives, how mirroring interacts with a camera flip — are readable without
 * reading C++.
 */
@interface TacendumVideoView : RCTViewComponentView
@end

@implementation TacendumVideoView {
  TacendumVideoHost *_host;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<TacendumVideoViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const TacendumVideoViewProps>();
    _props = defaultProps;
    _host = [[TacendumVideoHost alloc] initWithFrame:frame];
    __weak TacendumVideoView *weakSelf = self;
    _host.onFrameReady = ^(NSString *surfaceId, NSInteger generation, BOOL ready) {
      TacendumVideoView *strongSelf = weakSelf;
      if (!strongSelf || !strongSelf->_eventEmitter) return;
      auto emitter = std::static_pointer_cast<const TacendumVideoViewEventEmitter>(strongSelf->_eventEmitter);
      emitter->onFrameReady({std::string(surfaceId.UTF8String), static_cast<int>(generation), static_cast<bool>(ready)});
    };
    self.contentView = _host;
  }
  return self;
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &next = *std::static_pointer_cast<const TacendumVideoViewProps>(props);

  // MOUNT (`oldProps == nullptr`) APPLIES EVERYTHING; only an update diffs.
  //
  // This used to fall back to `_props` when Fabric passed no old props, which
  // it does on every Insert — and `_props` is the LAST STATE OF A DIFFERENT
  // ELEMENT when the view came out of the recycle pool. The diff was then
  // computed against a stranger, and any prop the two happened to share was
  // never written to the host. For `track` that is not a cosmetic miss: the
  // host keeps the role it was rendering in its previous life, so a surface
  // asking for `remote` stayed bound to the local camera and the person saw
  // themselves where the other person should have been.
  //
  // A mount is also exactly the moment where diffing buys nothing: there is
  // no previous frame on this element to preserve.
  //
  // A raw pointer off `oldProps` rather than a cast shared_ptr: the caller
  // owns that reference for the whole call, so nothing here needs to hold
  // one, and `nullptr` is what says "this is a mount".
  const TacendumVideoViewProps *prev =
      oldProps ? static_cast<const TacendumVideoViewProps *>(oldProps.get()) : nullptr;

  // Explicit conversion rather than an RCTConversions helper: those live in a
  // header this target does not otherwise need, and a std::string is a
  // std::string.
  //
  // Guarded together because they are ONE binding: re-binding tears down and
  // re-attaches a renderer, which drops a frame, and Fabric calls this on
  // every commit.
  if (!prev || next.cid != prev->cid || next.track != prev->track || next.surfaceId != prev->surfaceId) {
    [_host bindCid:[NSString stringWithUTF8String:next.cid.c_str()]
              role:next.track == TacendumVideoViewTrack::Local ? @"local" : @"remote"
         surfaceId:[NSString stringWithUTF8String:next.surfaceId.c_str()]];
  }
  if (!prev || next.mirror != prev->mirror) {
    [_host setMirror:next.mirror];
  }
  if (!prev || next.objectFit != prev->objectFit) {
    [_host setObjectFit:next.objectFit == TacendumVideoViewObjectFit::Contain ? @"contain"
                                                                             : @"cover"];
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)updateEventEmitter:(const EventEmitter::Shared &)eventEmitter
{
  [super updateEventEmitter:eventEmitter];
  [_host publishReadiness];
}

/**
 * Fabric's recycle contract, which this view was not honouring.
 *
 * An unmounted component view is not freed — it goes into a per-component
 * pool and is handed to the next element of the same kind. Nothing in React
 * Native resets `_props` on the way in, and `TacendumVideoHost` keeps a live
 * registry subscription and an attached `RTCVideoTrack`, so a pooled view
 * carried a finished call's binding into its next life.
 *
 * Only the host is reset. `_props` is DELIBERATELY LEFT ALONE: the superclass
 * diffs every inherited prop — opacity, background, borders, accessibility —
 * against `_props` rather than against `oldProps`, so that pointer is what
 * describes this UIView's actual native state. Resetting it to defaults would
 * make the superclass believe it had already applied values it had not, and a
 * recycled surface would keep the previous element's opacity or background
 * because no setter would ever run for them.
 *
 * The binding above no longer needs it reset anyway: `updateProps` treats a
 * null `oldProps` as a mount and writes every one of THIS view's props
 * unconditionally, so the host is a function of the current props and not of
 * what the pointer happens to hold.
 */
- (void)prepareForRecycle
{
  [_host resetForRecycle];
  [super prepareForRecycle];
}

@end

Class<RCTComponentViewProtocol> TacendumVideoViewCls(void)
{
  return TacendumVideoView.class;
}
