import CoreLocation
import Foundation
import QuickLook
import UIKit
import UniformTypeIdentifiers

/**
 * The native halves of attaching beyond photos.
 *
 * One presentation at a time, enforced with a `busy` rejection rather than a
 * queue: these are user-initiated surfaces, and a queued second picker
 * appearing after the first dismisses is a surprise, not a service.
 *
 * Every completion path resolves or rejects EXACTLY once — delegates hold the
 * completion and nil it on first use, because UIKit is allowed to call
 * `documentPicker(_:didPickDocumentsAt:)` and `documentPickerWasCancelled(_:)`
 * in surprising orders across OS versions.
 */
@objc(AttachImpl)
public final class AttachImpl: NSObject {
  @objc public static let shared = AttachImpl()

  private var pickDelegate: PickDelegate?
  private var previewController: PreviewHost?
  private var locationOneShot: LocationOneShot?

  /// Where a preview's decrypted bytes live, for exactly as long as the
  /// preview does.
  private static var previewDir: URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("tacendum-preview", isDirectory: true)
  }

  /**
   * Delete anything a previous run left behind.
   *
   * The dismissal cleanup cannot fire if the app is FORCE-KILLED mid-preview
   * — plaintext would then sit in tmp until iOS felt like purging it, which
   * is a promise this app does not get to make. Called at module init, so
   * every launch starts with an empty directory.
   */
  @objc public func sweepPreviewLeftovers() {
    try? FileManager.default.removeItem(at: Self.previewDir)
  }

  // MARK: - document pick

  @objc public func pickDocument(
    _ maxBytes: Double,
    resolve: @escaping ([String: Any]?) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    DispatchQueue.main.async {
      guard self.pickDelegate == nil, self.previewController == nil else {
        reject("busy", "another picker or preview is already presented")
        return
      }
      guard let host = Self.topViewController() else {
        reject("no_ui", "no view controller to present from")
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
      // asCopy: true — the system copies into our sandbox, so there is no
      // security-scoped bookmark to hold and nothing of ours ever touches
      // the provider's URL after this call.
      let delegate = PickDelegate(maxBytes: Int(maxBytes)) { [weak self] outcome in
        // Back to MAIN before touching `pickDelegate`: the busy guard above
        // reads it there, and the read completion runs on a global queue.
        DispatchQueue.main.async { self?.pickDelegate = nil }
        switch outcome {
        case .picked(let doc): resolve(doc)
        case .cancelled: resolve(nil)
        case .failed(let code, let message): reject(code, message)
        }
      }
      self.pickDelegate = delegate
      picker.delegate = delegate
      picker.allowsMultipleSelection = false
      // A presentation UIKit refuses (another controller mid-transition) has
      // no delegate callback at all: without this the JS promise hangs
      // forever and `pickDelegate` stays set, wedging every later pick as
      // 'busy'. The completion nils it either way.
      host.present(picker, animated: true) { [weak picker, weak delegate] in
        if picker?.presentingViewController == nil {
          delegate?.finish(.failed("present_failed", "the picker did not appear"))
        }
      }
    }
  }

  private enum PickOutcome {
    case picked([String: Any])
    case cancelled
    case failed(String, String)
  }

  private final class PickDelegate: NSObject, UIDocumentPickerDelegate {
    private let maxBytes: Int
    private var completion: ((PickOutcome) -> Void)?
    /// The pick's read finishes on a global queue while cancellation arrives
    /// on main. Reading and nilling `completion` without this lock let both
    /// observe it non-nil and resolve the SAME JS promise twice.
    private let lock = NSLock()
    init(maxBytes: Int, completion: @escaping (PickOutcome) -> Void) {
      self.maxBytes = maxBytes
      self.completion = completion
    }
    func finish(_ outcome: PickOutcome) {
      lock.lock()
      let c = completion
      completion = nil
      lock.unlock()
      c?(outcome)
    }
    func documentPicker(
      _ controller: UIDocumentPickerViewController,
      didPickDocumentsAt urls: [URL]
    ) {
      guard let url = urls.first else { return finish(.cancelled) }
      // Reading happens OFF the main thread: a 10 MB read on main would hitch
      // the dismiss animation, and the size check must come from the disk,
      // not from a provider's claim.
      DispatchQueue.global(qos: .userInitiated).async {
        defer { try? FileManager.default.removeItem(at: url) }
        do {
          let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
          let size = (attrs[.size] as? NSNumber)?.intValue ?? Int.max
          guard size <= self.maxBytes else {
            return self.finish(.failed("too_large", "file is \(size) bytes"))
          }
          let data = try Data(contentsOf: url)
          guard data.count <= self.maxBytes else {
            return self.finish(.failed("too_large", "file is \(data.count) bytes"))
          }
          let mime = UTType(filenameExtension: url.pathExtension)?
            .preferredMIMEType ?? "application/octet-stream"
          self.finish(.picked([
            "name": url.lastPathComponent,
            "size": data.count,
            "mime": mime,
            "dataB64": data.base64EncodedString(),
          ]))
        } catch {
          self.finish(.failed("read_failed", error.localizedDescription))
        }
      }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      finish(.cancelled)
    }
  }

  // MARK: - one-shot location

  @objc public func currentLocation(
    _ timeoutMs: Double,
    resolve: @escaping ([String: Any]) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    DispatchQueue.main.async {
      guard self.locationOneShot == nil else {
        reject("busy", "a location request is already running")
        return
      }
      let shot = LocationOneShot(timeout: timeoutMs / 1000.0) { [weak self] result in
        self?.locationOneShot = nil
        switch result {
        case .success(let loc):
          resolve([
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "acc": loc.horizontalAccuracy,
          ])
        case .failure(let code):
          reject(code.rawValue, code.rawValue)
        }
      }
      self.locationOneShot = shot
      shot.start()
    }
  }

  private enum LocationFailure: String, Error {
    case denied
    case timeout
    case unavailable
  }

  private final class LocationOneShot: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let timeout: TimeInterval
    private var completion: ((Result<CLLocation, LocationFailure>) -> Void)?
    private var timer: Timer?

    init(timeout: TimeInterval, completion: @escaping (Result<CLLocation, LocationFailure>) -> Void) {
      self.timeout = timeout
      self.completion = completion
      super.init()
      manager.delegate = self
      manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }
    func start() {
      timer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
        self?.finish(.failure(.timeout))
      }
      switch manager.authorizationStatus {
      case .notDetermined:
        manager.requestWhenInUseAuthorization()
      case .denied, .restricted:
        finish(.failure(.denied))
      default:
        manager.requestLocation()
      }
    }
    private func finish(_ result: Result<CLLocation, LocationFailure>) {
      timer?.invalidate()
      timer = nil
      let c = completion
      completion = nil
      c?(result)
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
      guard completion != nil else { return }
      switch manager.authorizationStatus {
      case .authorizedWhenInUse, .authorizedAlways:
        manager.requestLocation()
      case .denied, .restricted:
        finish(.failure(.denied))
      case .notDetermined:
        break
      @unknown default:
        break
      }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
      guard let loc = locations.last else { return }
      finish(.success(loc))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
      finish(.failure((error as? CLError)?.code == .denied ? .denied : .unavailable))
    }
  }

  // MARK: - preview

  @objc public func previewFile(
    _ dataB64: String,
    name: String,
    resolve: @escaping () -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    DispatchQueue.main.async {
      guard self.previewController == nil, self.pickDelegate == nil else {
        reject("busy", "another picker or preview is already presented")
        return
      }
      // Filename sanitised to its last path component so a hostile name like
      // "../../x" cannot steer the write; the directory is ours and private.
      // Traversal is only half of it. Bidi controls and newlines spoof the
      // QuickLook title exactly as they spoof the bubble, and a name that is
      // fine in UTF-16 units can still exceed the filesystem's 255-BYTE
      // component limit (emoji cost four bytes each), which fails the write.
      var safeName = (name as NSString).lastPathComponent
        .components(separatedBy: .controlCharacters).joined()
        .replacingOccurrences(of: "\u{202A}", with: "")
        .replacingOccurrences(of: "\u{202B}", with: "")
        .replacingOccurrences(of: "\u{202C}", with: "")
        .replacingOccurrences(of: "\u{202D}", with: "")
        .replacingOccurrences(of: "\u{202E}", with: "")
        .replacingOccurrences(of: "\u{2066}", with: "")
        .replacingOccurrences(of: "\u{2067}", with: "")
        .replacingOccurrences(of: "\u{2068}", with: "")
        .replacingOccurrences(of: "\u{2069}", with: "")
        .replacingOccurrences(of: "\u{200B}", with: "")
      while safeName.utf8.count > 200, !safeName.isEmpty {
        safeName.removeLast()
      }
      if safeName.isEmpty { safeName = "file" }
      let dir = Self.previewDir
      // Decode and write OFF the main thread — 7 MB of base64 plus the disk
      // write is a visible hitch on the thread drawing the UI — then come
      // back to main, where UIKit and every field above it live.
      let readyName = safeName
      DispatchQueue.global(qos: .userInitiated).async {
        guard let data = Data(base64Encoded: dataB64) else {
          DispatchQueue.main.async { reject("bad_data", "not base64") }
          return
        }
        let url: URL
        do {
          try? FileManager.default.removeItem(at: dir)
          try FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
          )
          url = dir.appendingPathComponent(readyName)
          try data.write(to: url, options: [.completeFileProtection])
        } catch {
          try? FileManager.default.removeItem(at: dir)
          DispatchQueue.main.async { reject("write_failed", error.localizedDescription) }
          return
        }
        DispatchQueue.main.async {
          guard let host = Self.topViewController() else {
            try? FileManager.default.removeItem(at: dir)
            reject("no_ui", "no view controller to present from")
            return
          }
          let preview = PreviewHost(url: url) { [weak self] in
            // The plaintext leaves the disk with the presentation.
            try? FileManager.default.removeItem(at: dir)
            self?.previewController = nil
          }
          self.previewController = preview
          host.present(preview, animated: true) { [weak self, weak preview] in
            // Same refusal case as the picker: no presentation means no
            // dismissal, so the bytes and the busy flag would both persist.
            if preview?.presentingViewController == nil {
              try? FileManager.default.removeItem(at: dir)
              self?.previewController = nil
            }
          }
          resolve()
        }
      }
    }
  }

  private final class PreviewHost: QLPreviewController, QLPreviewControllerDataSource {
    private let url: URL
    private let onDismiss: () -> Void
    init(url: URL, onDismiss: @escaping () -> Void) {
      self.url = url
      self.onDismiss = onDismiss
      super.init(nibName: nil, bundle: nil)
      dataSource = self
    }
    required init?(coder: NSCoder) { return nil }
    override func viewDidDisappear(_ animated: Bool) {
      super.viewDidDisappear(animated)
      if isBeingDismissed || presentingViewController == nil { onDismiss() }
    }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(
      _ controller: QLPreviewController,
      previewItemAt index: Int
    ) -> QLPreviewItem {
      url as NSURL
    }
  }

  // MARK: - plumbing

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
    let window = scenes
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}
