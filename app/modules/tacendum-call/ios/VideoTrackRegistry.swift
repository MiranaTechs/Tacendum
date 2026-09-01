import Foundation
import WebRTC

/**
 * Where a video view finds a call's tracks.
 *
 * A track cannot cross the bridge, and the UI is written against a `cid`, so
 * something has to hold the mapping. It also has to survive the fact that a
 * call's tracks appear and change at moments the UI does not control: the
 * remote track arrives when the answer is applied, the local one is replaced
 * by a camera flip, and both vanish on teardown.
 *
 * So views REGISTER an interest and are told; they do not poll and they do not
 * hold a track themselves. A view that attaches before the remote track exists
 * — the normal case, since the screen is on-screen while the call is still
 * connecting — simply shows nothing and is updated when the track lands.
 */
final class VideoTrackRegistry {
  static let shared = VideoTrackRegistry()

  enum Role: String {
    case local
    case remote
  }

  private struct Key: Hashable {
    let cid: String
    let role: Role
  }

  private var tracks: [Key: RTCVideoTrack] = [:]
  private var observers: [Key: [ObjectIdentifier: (RTCVideoTrack?) -> Void]] = [:]
  /// All access is on the main queue: `RTCVideoRenderer` attachment is a UIKit
  /// operation, and the alternative — a lock plus a main-queue hop per
  /// notification — buys nothing when every consumer is a view anyway.
  private let queue = DispatchQueue.main

  func set(_ track: RTCVideoTrack?, cid: String, role: Role) {
    let apply = {
      let key = Key(cid: cid, role: role)
      if let track = track {
        self.tracks[key] = track
      } else {
        self.tracks.removeValue(forKey: key)
      }
      for (_, notify) in self.observers[key] ?? [:] { notify(track) }
    }
    if Thread.isMainThread { apply() } else { queue.async(execute: apply) }
  }

  /// Drop everything for a call. Called on teardown so a renderer cannot keep
  /// a dead call's last frame — or, worse, its track alive.
  func clear(cid: String) {
    let apply = {
      for role in [Role.local, Role.remote] {
        let key = Key(cid: cid, role: role)
        self.tracks.removeValue(forKey: key)
        for (_, notify) in self.observers[key] ?? [:] { notify(nil) }
      }
    }
    if Thread.isMainThread { apply() } else { queue.async(execute: apply) }
  }

  /// Observe a (cid, role). Fires immediately with the current value, which is
  /// usually nil — the screen is up before the call connects.
  func observe(
    cid: String,
    role: Role,
    owner: AnyObject,
    onChange: @escaping (RTCVideoTrack?) -> Void
  ) {
    let key = Key(cid: cid, role: role)
    var forKey = observers[key] ?? [:]
    forKey[ObjectIdentifier(owner)] = onChange
    observers[key] = forKey
    onChange(tracks[key])
  }

  func stopObserving(owner: AnyObject) {
    let id = ObjectIdentifier(owner)
    for (key, var forKey) in observers {
      forKey.removeValue(forKey: id)
      observers[key] = forKey.isEmpty ? nil : forKey
    }
  }
}
