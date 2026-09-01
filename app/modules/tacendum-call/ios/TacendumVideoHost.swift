import Foundation
import UIKit
import WebRTC

/**
 * The UIKit half of the video surface.
 *
 * Kept in Swift and separate from the Fabric component view so that the
 * rendering logic — which track, which orientation, what to show when there
 * is not one — is readable without wading through C++ component plumbing.
 *
 * `RTCMTLVideoView` is the Metal renderer. The OpenGL one still exists in
 * libwebrtc but is deprecated on iOS and costs a full extra copy per frame.
 */
@objc(TacendumVideoHost)
public final class TacendumVideoHost: UIView {
  /// `var`, because detaching REPLACES it. See `detach()`.
  private var renderer = RTCMTLVideoView(frame: .zero)
  private var attached: RTCVideoTrack?
  private var cid = ""
  private var role: VideoTrackRegistry.Role = .remote
  /// Held here rather than read back off the renderer, because the renderer is
  /// swapped out and the replacement has to come up looking like the one it
  /// replaced — a camera flip must not un-mirror the preview.
  private var mirrored = false
  private var fitMode: Fit = .fill

  @objc public override init(frame: CGRect) {
    super.init(frame: frame)
    // Black rather than clear: a video surface that has not received a frame
    // yet should read as "nothing here", not as a hole showing whatever is
    // behind it.
    backgroundColor = .black
    installRenderer()
  }

  /// Put the current renderer on screen, wearing this host's mirroring and fit.
  private func installRenderer() {
    renderer.videoContentMode = fitMode == .fill ? .scaleAspectFill : .scaleAspectFit
    renderer.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    renderer.translatesAutoresizingMaskIntoConstraints = false
    addSubview(renderer)
    NSLayoutConstraint.activate([
      renderer.leadingAnchor.constraint(equalTo: leadingAnchor),
      renderer.trailingAnchor.constraint(equalTo: trailingAnchor),
      renderer.topAnchor.constraint(equalTo: topAnchor),
      renderer.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  /// Which way `videoContentMode` is pointing, in this file's own words so the
  /// renderer swap has something to restore from.
  private enum Fit { case fill, fit }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  deinit {
    // Both halves matter: the registry would otherwise keep calling a dead
    // view, and the track would keep a renderer attached to a view that is
    // being freed.
    VideoTrackRegistry.shared.stopObserving(owner: self)
    attached?.remove(renderer)
  }

  // MARK: - props

  /**
   * Bind to a (cid, role) IN ONE STEP.
   *
   * These were two setters, and the pair had a hole in it that put the wrong
   * person on screen. Each one resubscribed on its own, so applying a cid and
   * a role together — which is what every mount does — first subscribed with
   * the OTHER field still stale. That transient is harmless on its own; what
   * was not harmless is that it made this view's binding depend on the ORDER
   * and the COMPLETENESS of the prop writes rather than on the props
   * themselves. A view arriving from Fabric's recycle pool is handed to a
   * different React element with `oldProps == nullptr`, and a diff that
   * misses one of the two setters leaves the surface attached to the track
   * the view's PREVIOUS life was showing: the full-screen surface rendering
   * this device's own camera while the caller waits to be seen.
   *
   * One call, one subscription, and the binding is a pure function of the
   * arguments — there is no ordering left to get wrong.
   */
  @objc public func bindCid(_ nextCid: String, role nextRole: String) {
    let resolved = VideoTrackRegistry.Role(rawValue: nextRole) ?? .remote
    guard nextCid != cid || resolved != role else { return }
    cid = nextCid
    role = resolved
    resubscribe()
  }

  /**
   * Back to the state `init` left, for Fabric's recycle pool.
   *
   * A pooled view is not deallocated, so `deinit` never runs for it: without
   * this it sits in the pool still registered with the registry and still
   * holding the dead call's `RTCVideoTrack` attached to its renderer — and it
   * carries that binding into whatever element dequeues it next.
   *
   * Named for its caller rather than `reset`: a bare `reset` on a `UIView`
   * subclass is a selector some framework could already own, and the failure
   * mode of colliding with one is a view that misbehaves rather than a build
   * that stops.
   */
  @objc public func resetForRecycle() {
    VideoTrackRegistry.shared.stopObserving(owner: self)
    // `detach` is what discards the last frame; the fields below only matter
    // so the next `bindCid`/`setMirror`/`setObjectFit` is compared against the
    // state a fresh view would be in.
    detach()
    cid = ""
    role = .remote
    mirrored = false
    fitMode = .fill
    renderer.transform = .identity
    renderer.videoContentMode = .scaleAspectFill
  }

  @objc public func setMirror(_ value: Bool) {
    // A transform on the RENDERER, not the view: mirroring the view would also
    // flip anything a parent draws over it.
    mirrored = value
    renderer.transform = value ? CGAffineTransform(scaleX: -1, y: 1) : .identity
  }

  @objc public func setObjectFit(_ value: String) {
    fitMode = value == "contain" ? .fit : .fill
    renderer.videoContentMode = fitMode == .fit ? .scaleAspectFit : .scaleAspectFill
  }

  // MARK: - track binding

  private func resubscribe() {
    VideoTrackRegistry.shared.stopObserving(owner: self)
    detach()
    guard !cid.isEmpty else { return }
    VideoTrackRegistry.shared.observe(cid: cid, role: role, owner: self) { [weak self] track in
      self?.attach(track)
    }
  }

  private func attach(_ track: RTCVideoTrack?) {
    guard track !== attached else { return }
    detach()
    guard let track = track else { return }
    track.add(renderer)
    attached = track
  }

  /**
   * THE RENDERER IS DESTROYED, NOT MERELY UNSUBSCRIBED — and this is the fix
   * for the bug that put this device's own face on the full-screen surface.
   *
   * `RTCMTLVideoView` HOLDS ITS LAST DECODED FRAME. Removing it from a track
   * stops new frames arriving; it does not clear what is already on screen,
   * and there is no API that does (`renderFrame(nil)` returns without
   * clearing). So the pixels of whatever this surface last showed survive
   * every rebind — and Fabric recycles component views, so they survive into
   * the NEXT CALL, in a view handed to a different React element.
   *
   * That is the reported symptom exactly. A corner self-view from the last
   * call goes back to the pool with this device's face frozen in its
   * renderer; the next call dequeues it as the FULL-SCREEN remote surface; it
   * binds to the remote track correctly and waits for a frame — showing the
   * stale local face the whole time. Both surfaces then show the same person,
   * and if no remote frame ever arrives it never resolves.
   *
   * A fresh `RTCMTLVideoView` has no frame to show, so it draws nothing and
   * this host's black background reads through: "no video yet", which is the
   * truth. Guarded on there having BEEN a track, so the common no-op paths —
   * a rebind before anything attached, a nil notification for a track that
   * was never there — do not churn a Metal layer for nothing.
   */
  private func detach() {
    guard let track = attached else { return }
    track.remove(renderer)
    attached = nil
    renderer.removeFromSuperview()
    renderer = RTCMTLVideoView(frame: bounds)
    installRenderer()
  }
}
