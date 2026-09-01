import AVFoundation
import UIKit

/**
 * A live camera QR scanner.
 *
 * Like the rest of this module it holds NO policy: it reports every symbol it
 * saw in one frame and decides nothing about them. `app/src/qr.ts` owns what a
 * Tacendum id is, whether a payload is one, and what to do when two symbols
 * are visible at once — and it is the same `idFromPayloads` the still-image
 * path uses, so the two cannot drift.
 *
 * **Reporting an ARRAY is the security-relevant part.** A scanner that
 * reported only its best or first symbol would make the ambiguity refusal in
 * `idFromPayloads` unreachable: the choice would already have been made, here,
 * by whichever code AVFoundation happened to list first. Two codes in frame
 * has to reach JavaScript as two codes.
 *
 * Nothing here logs a payload.
 */
@objc(QrScannerController)
public final class QrScannerController: UIViewController {
  /// Called once, with every distinct payload visible in the frame that
  /// triggered the read. An empty array is never delivered — the session
  /// simply keeps running until something is seen or the user cancels.
  private let onResult: ([String]) -> Void
  private let onCancel: () -> Void

  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?
  /// The session runs on its own queue; `finished` is only ever touched on the
  /// main queue, where both the delegate callback and the cancel button land.
  private var finished = false

  /// Keeps the preview upright on devices that rotate.
  /// iPhones never see this matter — the app is portrait-only there — but
  /// the iPad rotates through all four orientations and a preview connection
  /// with no rotation set renders the feed sideways in landscape. On iOS 17+
  /// the `AVCaptureDevice.RotationCoordinator` owns the angle; stored as
  /// `Any?` because stored properties cannot carry an availability guard.
  private var rotationCoordinator: Any?
  private var rotationObservation: NSKeyValueObservation?

  /// The interruption state: `AVCaptureSession` is interrupted when the
  /// app shares the screen (Split View / Slide Over), and a frozen feed reads
  /// as a broken scanner. This overlay names the way back instead.
  private var interruptedOverlay: UIView?
  /// "Point the camera at their QR code" — hidden while the interruption
  /// overlay is up, because there is no camera to point.
  private var hintLabel: UILabel?
  /// Retained so the interruption overlay can restack it above itself: the
  /// way out must stay reachable while the camera is gone.
  private var cancelButton: UIButton?

  @objc public init(
    onResult: @escaping ([String]) -> Void,
    onCancel: @escaping () -> Void
  ) {
    self.onResult = onResult
    self.onCancel = onCancel
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not used") }

  public override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      // No camera, or it is unavailable. Cancel rather than present a black
      // rectangle the person has to work out is broken.
      finish { self.onCancel() }
      return
    }
    session.addInput(input)

    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      finish { self.onCancel() }
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    // QR only. Accepting every symbology would mean a barcode on a parcel
    // could satisfy the scan and reach the id validator, which is a strange
    // way to end up addressing a stranger.
    output.metadataObjectTypes = output.availableMetadataObjectTypes.filter { $0 == .qr }

    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = view.bounds
    view.layer.addSublayer(layer)
    preview = layer

    armPreviewRotation(device: device, layer: layer)
    armInterruptionState()

    addCancelButton()

    // startRunning blocks; off the main thread or the presentation animation
    // stutters and the first frames are dropped.
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      self?.session.startRunning()
    }
  }

  public override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
    interruptedOverlay?.frame = view.bounds
    // Pre-17 fallback: no RotationCoordinator exists, so the preview follows
    // the interface orientation, re-read here because rotation always
    // re-lays-out this full-screen view. Same-named cases map 1:1 for a
    // preview layer. (`videoOrientation` is deprecated FROM iOS 17, where the
    // coordinator path below runs instead.)
    if #unavailable(iOS 17.0) {
      guard
        let connection = preview?.connection,
        connection.isVideoOrientationSupported,
        let scene = view.window?.windowScene
      else { return }
      switch scene.interfaceOrientation {
      case .portrait: connection.videoOrientation = .portrait
      case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
      case .landscapeLeft: connection.videoOrientation = .landscapeLeft
      case .landscapeRight: connection.videoOrientation = .landscapeRight
      case .unknown: break
      @unknown default: break
      }
    }
  }

  /// iOS 17+: bind the preview connection's `videoRotationAngle` to the
  /// device's rotation coordinator, initial value plus KVO for every rotation
  /// after it. Before 17 the `viewDidLayoutSubviews` fallback stands.
  private func armPreviewRotation(
    device: AVCaptureDevice, layer: AVCaptureVideoPreviewLayer
  ) {
    guard #available(iOS 17.0, *) else { return }
    let coordinator = AVCaptureDevice.RotationCoordinator(
      device: device, previewLayer: layer)
    rotationCoordinator = coordinator
    applyPreviewRotation(coordinator.videoRotationAngleForHorizonLevelPreview)
    rotationObservation = coordinator.observe(
      \.videoRotationAngleForHorizonLevelPreview, options: [.new]
    ) { [weak self] coordinator, _ in
      let angle = coordinator.videoRotationAngleForHorizonLevelPreview
      // KVO delivery queue is unspecified; the layer belongs to main.
      DispatchQueue.main.async { self?.applyPreviewRotation(angle) }
    }
  }

  @available(iOS 17.0, *)
  private func applyPreviewRotation(_ angle: CGFloat) {
    guard
      let connection = preview?.connection,
      connection.isVideoRotationAngleSupported(angle)
    else { return }
    connection.videoRotationAngle = angle
  }

  public override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if session.isRunning {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        self?.session.stopRunning()
      }
    }
  }

  private func addCancelButton() {
    let button = UIButton(type: .system)
    button.setTitle("Cancel", for: .normal)
    button.setTitleColor(.white, for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
    button.accessibilityLabel = "Cancel scanning"
    button.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    button.translatesAutoresizingMaskIntoConstraints = false
    cancelButton = button
    view.addSubview(button)
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
      button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
    ])

    let hint = UILabel()
    hint.text = "Point the camera at their QR code"
    hint.textColor = .white
    hint.font = .systemFont(ofSize: 15)
    hint.textAlignment = .center
    hint.numberOfLines = 0
    hint.translatesAutoresizingMaskIntoConstraints = false
    hintLabel = hint
    view.addSubview(hint)
    NSLayoutConstraint.activate([
      hint.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      hint.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      hint.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -40),
    ])
  }

  // MARK: - Split View interruption

  /// iPadOS interrupts the capture session when the app is not full screen
  /// (Split View / Slide Over: `videoDeviceNotAvailableWithMultipleForeground`
  /// `Apps`). Without this the last frame freezes under the hint and the
  /// scanner looks broken; the recorded design is an explicit "go full screen
  /// to scan" state rather than the multitasking-camera entitlement.
  private func armInterruptionState() {
    let center = NotificationCenter.default
    center.addObserver(
      self,
      selector: #selector(sessionWasInterrupted(_:)),
      name: AVCaptureSession.wasInterruptedNotification,
      object: session
    )
    center.addObserver(
      self,
      selector: #selector(sessionInterruptionEnded),
      name: AVCaptureSession.interruptionEndedNotification,
      object: session
    )
  }

  @objc private func sessionWasInterrupted(_ note: Notification) {
    guard
      let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey]
        as? Int,
      let reason = AVCaptureSession.InterruptionReason(rawValue: raw),
      reason == .videoDeviceNotAvailableWithMultipleForegroundApps
    else {
      // Other interruptions (audio session, system pressure) end on their
      // own and "go full screen" would be the wrong instruction for them.
      return
    }
    DispatchQueue.main.async { [weak self] in self?.showInterruptedState() }
  }

  @objc private func sessionInterruptionEnded() {
    DispatchQueue.main.async { [weak self] in self?.hideInterruptedState() }
  }

  private func showInterruptedState() {
    guard interruptedOverlay == nil, isViewLoaded else { return }

    // Opaque, over the frozen frame — a stale camera image under fresh text
    // reads as a live feed that stopped obeying.
    let sheet = UIView(frame: view.bounds)
    sheet.backgroundColor = .black

    let title = UILabel()
    title.text = "Go full screen to scan"
    title.textColor = .white
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    title.textAlignment = .center
    title.numberOfLines = 0

    let body = UILabel()
    body.text = "The camera pauses while Tacendum shares the screen with another app."
    body.textColor = .white
    body.font = .systemFont(ofSize: 15)
    body.textAlignment = .center
    body.numberOfLines = 0

    for label in [title, body] {
      label.translatesAutoresizingMaskIntoConstraints = false
      sheet.addSubview(label)
    }
    NSLayoutConstraint.activate([
      title.centerYAnchor.constraint(
        equalTo: sheet.centerYAnchor, constant: -24),
      title.leadingAnchor.constraint(
        equalTo: sheet.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      title.trailingAnchor.constraint(
        equalTo: sheet.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      body.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 12),
      body.leadingAnchor.constraint(equalTo: title.leadingAnchor),
      body.trailingAnchor.constraint(equalTo: title.trailingAnchor),
    ])

    // On top of everything — the preview is a LAYER of `view`, and how a
    // subview inserted at index 0 stacks against a manually added sublayer
    // is exactly the kind of undocumented interleaving this must not depend
    // on — then the Cancel button is restacked above the sheet, so the way
    // out stays reachable while the camera is gone.
    view.addSubview(sheet)
    if let cancel = cancelButton { view.bringSubviewToFront(cancel) }
    interruptedOverlay = sheet
    // "Point the camera" is the wrong sentence while there is no camera.
    hintLabel?.isHidden = true

    UIAccessibility.post(notification: .layoutChanged, argument: title)
  }

  private func hideInterruptedState() {
    interruptedOverlay?.removeFromSuperview()
    interruptedOverlay = nil
    hintLabel?.isHidden = false
  }

  @objc private func cancelTapped() {
    finish { self.onCancel() }
  }

  /// Dismiss exactly once. Both the delegate and the cancel button can fire —
  /// a second callback would resolve a promise that is already settled, and
  /// dismissing twice drops the presenting view controller's next modal.
  private func finish(_ deliver: @escaping () -> Void) {
    guard !finished else { return }
    finished = true
    let complete = { deliver() }
    if presentingViewController != nil {
      dismiss(animated: true, completion: complete)
    } else {
      complete()
    }
  }
}

extension QrScannerController: AVCaptureMetadataOutputObjectsDelegate {
  public func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    let payloads = metadataObjects
      .compactMap { $0 as? AVMetadataMachineReadableCodeObject }
      .filter { $0.type == .qr }
      .compactMap { $0.stringValue }

    guard !payloads.isEmpty else { return }
    // Every symbol in the frame, not the first. See the note at the top: the
    // ambiguity refusal lives in JavaScript and can only work if it is given
    // the ambiguity.
    finish { self.onResult(payloads) }
  }
}
