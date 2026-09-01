import UIKit

/**
 * Screen security, formal route only. iOS provides no way to BLOCK a
 * screenshot (and Apple DTS has ruled the `isSecureTextEntry` wrapping trick
 * an unsupported side effect, App Review Guideline 2.5.1), so this class does
 * the three things the platform supports:
 *
 *  1. reports `UIScreen.isCaptured` changes (recording / AirPlay / mirroring)
 *     so JS can blank live content while capture is running;
 *  2. reports `userDidTakeScreenshotNotification` so the conversation can
 *     disclose the screenshot after the fact;
 *  3. covers the key window the moment the app resigns active — before the
 *     OS takes the app-switcher snapshot — hardening the JS-side overlay in
 *     App.tsx, which cannot run until the bundle is live.
 *
 * The cover mirrors the JS `privacy-overlay`: opaque paperGround sheet with
 * the brand mark (BrandMark.tsx ratios, bar height 20) at the quarter line —
 * the same composition the loading frame, the lock screen and the launch
 * storyboard hold, so every cover of the app is the same image.
 */
@objc(ScreenSecurityImpl)
public final class ScreenSecurityImpl: NSObject {
  @objc public static let shared = ScreenSecurityImpl()

  private var observing = false
  private var onCapturedChanged: ((Bool) -> Void)?
  private var onScreenshot: (() -> Void)?

  /** Every screen this app's scenes actually sit on. The deprecated
   * main-screen singleton is retired from every connected-scene beat
   * (one no-scene fallback
   * survives in isCapturedNow): under Stage Manager / an external display
   * "main" stops naming the screen the app is on — the screens that matter
   * for capture are exactly the ones hosting a connected scene. Main-thread
   * only, like every caller of it here (the .mm dispatches `getIsCaptured`
   * to main; the notifications arrive on main). */
  private static func connectedScreens() -> [UIScreen] {
    var screens: [UIScreen] = []
    for scene in UIApplication.shared.connectedScenes {
      guard let windowScene = scene as? UIWindowScene else { continue }
      if !screens.contains(where: { $0 === windowScene.screen }) {
        screens.append(windowScene.screen)
      }
    }
    return screens
  }

  /** Captured means captured ANYWHERE the app is visible: with a second
   * scene/screen in play, blanking only when every screen is clean is the
   * fail-open direction.
   *
   * With NO scene connected the ANY-over-scenes read has nothing to ask —
   * and answering false there is its own fail-open: a VoIP/CallKit wake
   * cold-starts this process UI-less, and a recording that is ALREADY
   * running fires no change notification (nothing changes; it simply
   * continues), so a false seed would stand while conversations render
   * into an active capture (a review found the claimed JS re-ask
   * compensating for this beat did not
   * exist). The deprecated main-screen singleton read below is retained
   * SOLELY as that no-scene fallback; the scenes path owns every
   * connected-scene beat, where Stage Manager makes "main" ambiguous. */
  @objc public static func isCapturedNow() -> Bool {
    let screens = connectedScreens()
    if screens.isEmpty {
      return UIScreen.main.isCaptured
    }
    return screens.contains { $0.isCaptured }
  }

  /** Bind (or rebind, after a dev reload) the JS event sinks and start
   * observing. Observation itself is armed once; sinks swap freely. */
  @objc public func start(
    onCapturedChanged: @escaping (Bool) -> Void,
    onScreenshot: @escaping () -> Void
  ) {
    DispatchQueue.main.async {
      self.onCapturedChanged = onCapturedChanged
      self.onScreenshot = onScreenshot
      guard !self.observing else { return }
      self.observing = true
      let center = NotificationCenter.default
      center.addObserver(
        self,
        selector: #selector(self.capturedDidChange),
        name: UIScreen.capturedDidChangeNotification,
        object: nil
      )
      center.addObserver(
        self,
        selector: #selector(self.didTakeScreenshot),
        name: UIApplication.userDidTakeScreenshotNotification,
        object: nil
      )
      center.addObserver(
        self,
        selector: #selector(self.sceneWillConnect),
        name: UIScene.willConnectNotification,
        object: nil
      )
    }
  }

  /** Drop the JS sinks (module invalidate — reload/shutdown). Observation
   * stays armed; the next start() rebinds. Main-thread only, like start(). */
  @objc public func stop() {
    onCapturedChanged = nil
    onScreenshot = nil
  }

  @objc private func capturedDidChange() {
    // Recomputed over the connected scenes rather than read off the
    // notification's screen object: JS holds ONE boolean, and it must agree
    // with what `getIsCaptured` would answer at the same moment.
    onCapturedChanged?(Self.isCapturedNow())
  }

  @objc private func didTakeScreenshot() {
    onScreenshot?()
  }

  /** The first scene can connect AFTER JS seeded from the no-scene
   * fallback (the cold-start beat isCapturedNow documents). Recompute over
   * what just became the authoritative scenes path and push it, so the JS
   * boolean converges even if the seed raced. willConnect, not
   * didActivate: it fires exactly once per scene connection — the precise
   * beat connectedScreens() gains a member — whereas didActivate re-fires
   * on every foreground pass; a capture change after connection is owned
   * by capturedDidChange above. Arrives on the main thread, like every
   * scene-lifecycle notification. */
  @objc private func sceneWillConnect() {
    onCapturedChanged?(Self.isCapturedNow())
  }

  // MARK: - App-switcher cover

  private static var cover: UIView?
  private static var coverArmed = false

  /** Called from ObjC +load: registers lifecycle observers only. All UIKit
   * work waits for the notifications, which arrive on the main thread. */
  @objc public static func activateSwitcherCover() {
    guard !coverArmed else { return }
    coverArmed = true
    let center = NotificationCenter.default
    center.addObserver(
      forName: UIApplication.willResignActiveNotification,
      object: nil,
      queue: .main
    ) { _ in showCover() }
    center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { _ in hideCover() }
  }

  // theme.ts: paperGround #EFF2EB, pine #0E6B45.
  private static let paperGround = UIColor(
    red: 0xEF / 255.0, green: 0xF2 / 255.0, blue: 0xEB / 255.0, alpha: 1
  )
  private static let pine = UIColor(
    red: 0x0E / 255.0, green: 0x6B / 255.0, blue: 0x45 / 255.0, alpha: 1
  )

  private static func showCover() {
    guard cover == nil, let window = frontWindow() else { return }
    // The keyboard lives in its own system window ABOVE this one, and the
    // app-switcher snapshot includes it — with the QuickType bar echoing the
    // words just typed into a private message. Tear it down before the OS
    // renders the card. Cost: transient resignations (Face ID, permission
    // alerts) also drop keyboard focus; the person re-taps the composer.
    window.endEditing(true)
    let sheet = UIView(frame: window.bounds)
    sheet.backgroundColor = paperGround
    sheet.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    // Two turns of a conversation, bar height 20 (BrandMark.tsx ratios), the
    // mark's top at the quarter line of the screen. The sheet is rebuilt on
    // every resignation, so the frame math needs no rotation handling.
    let size: CGFloat = 20
    let markWidth = (1.545 + 2.795) * size
    let mark = UIView(
      frame: CGRect(
        x: (sheet.bounds.width - markWidth) / 2,
        y: sheet.bounds.height * 0.25,
        width: markWidth,
        height: (2 + 0.227) * size
      ))
    mark.autoresizingMask = [
      .flexibleLeftMargin, .flexibleRightMargin, .flexibleBottomMargin,
    ]

    let solid = UIView(
      frame: CGRect(x: 0, y: 0, width: 2.955 * size, height: size))
    solid.backgroundColor = pine
    solid.layer.cornerRadius = size / 2
    mark.addSubview(solid)

    let reply = UIView(
      frame: CGRect(
        x: 1.545 * size, y: (1 + 0.227) * size, width: 2.795 * size,
        height: size
      ))
    reply.backgroundColor = .clear
    reply.layer.borderColor = pine.cgColor
    reply.layer.borderWidth = 0.33 * size
    reply.layer.cornerRadius = size / 2
    mark.addSubview(reply)

    sheet.addSubview(mark)
    window.addSubview(sheet)
    cover = sheet
  }

  private static func hideCover() {
    cover?.removeFromSuperview()
    cover = nil
  }

  private static func frontWindow() -> UIWindow? {
    for scene in UIApplication.shared.connectedScenes {
      guard let windowScene = scene as? UIWindowScene else { continue }
      if let key = windowScene.windows.first(where: { $0.isKeyWindow }) {
        return key
      }
      if let any = windowScene.windows.first {
        return any
      }
    }
    // No scene manifest in this app; the classic delegate path still exists.
    return UIApplication.shared.delegate?.window ?? nil
  }
}
