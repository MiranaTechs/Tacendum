import TacendumCall
import UIKit
import UserNotifications
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // Foreground banners are suppressed BY POLICY, not by accident. With no
    // delegate, iOS presents a remote notification with its original alert
    // options even while the app is frontmost — so a message that raced a
    // reconnect could banner over the very conversation it belongs to. The
    // socket delivers everything the person is looking at; notifications are
    // for the phone in the pocket.
    UNUserNotificationCenter.current().delegate = self

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "Tacendum",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  /**
   * The APNs alert token — the only place iOS delivers it.
   *
   * ON THE UIApplicationDelegate, which is what makes it fire at all. These
   * two callbacks originally sat inside ReactNativeDelegate — a factory
   * delegate iOS knows nothing about — where they compiled cleanly, looked
   * exactly right, and were never called once. That single misplacement was
   * the whole reason the alert token never registered on any device: the
   * permission prompt appeared (that call lives elsewhere and worked), the
   * VoIP token registered (PushKit delivers through its own delegate), and
   * this method sat dead — so every layer above concluded "the token has not
   * arrived yet" forever, and no client-side retry could ever help.
   *
   * Distinct from the PushKit token that rings the phone for a call: a device
   * gets one from each, and sending an alert to the VoIP token is accepted by
   * APNs and silently never arrives.
   *
   * Hex, lowercase, no separators — the format APNs expects in the request
   * path. `map` over the buffer rather than `description`, which on newer
   * iOS returns something like `{length = 32, bytes = 0x...}` and would be
   * registered as a token that can never receive anything.
   */
  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    // NATIVE log, deliberately: JS console output only reaches Xcode when
    // Metro is attached, and a device build runs from the embedded bundle —
    // so this line is the one place token issuance is visible at all. Length
    // only; the token is the capability to push to this phone.
    #if DEBUG
    NSLog("[push] APNs alert token issued (%d hex chars)", hex.count)
    #endif
    TacendumCallImpl.shared.setAlertToken(hex)
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    // Nothing. Not even the badge — the app recomputes it from the database
    // on every transition, and the number it computes is the true one.
    completionHandler([])
  }

  /**
   * A banner tap becomes a NAVIGATION INTENT: the
   * notification's `threadIdentifier` — a bare row key the NSE minted from
   * the address the decrypt succeeded against (`push.from`, or `g/` plus
   * the room id) — written to the shared container for the JS router to
   * redeem AFTER the app's own unlock has ruled (app/src/pushnav.ts).
   *
   * WHY A FILE AND NOT A URL: navigation rides notification identifiers
   * and in-process plumbing ONLY. No URL scheme, no deep link, no Linking
   * surface — the bare-id guardrail covers every entry surface, and the
   * URL-types key stays absent from both Info.plists (each absence pinned
   * by jest, push.tapnav.test.ts).
   *
   * WHAT CROSSES, EXACTLY: a row key and a timestamp. Never the payload
   * mirror, never a rendered line, never a name — what waits on disk while
   * the lock screen stands names nobody and quotes nothing. The redemption
   * is duress-aware BY PLACEMENT, not by cleverness: this path ends at the
   * write; the app then launches or foregrounds through its ordinary flow
   * — lock.ts's verdict included, which this file cannot see and must
   * never anticipate — and pushnav.ts consumes the intent only where a
   * REAL workspace already opened (the decoy arm discards it unread). A
   * tap can therefore never widen what any verdict shows; it only chooses
   * which already-permitted screen appears first.
   *
   * ONLY the platform's default tap action is honoured. No category is
   * registered anywhere in this app — an Approve button
   * that works while the app claims to be locked is an authorization
   * surface the lock says does not exist, because device unlock cannot
   * distinguish the duress passcode — so a non-default action identifier
   * here is a foreign shape and is deliberately ignored.
   */
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
      Self.recordPendingNav(
        thread: response.notification.request.content.threadIdentifier
      )
    }
    completionHandler()
  }

  /// Mirrors `SharedContainer.appGroupIdentifier` (tacendum-crypto), which
  /// this target sees only across the pod boundary; the literal is pinned
  /// against that file by jest exactly as `coalesce-counts` is pinned
  /// across its two languages.
  private static let appGroupIdentifier = "group.com.miranatechnologies.tacendum"

  /// One line on disk: "<unix-ms> <threadIdentifier>", under the
  /// shared-state conventions TacendumCryptoImpl owns — same directory,
  /// same protection class, atomic write. The shape guard accepts the two
  /// shapes the NSE mints — a bare 26-char id, or "g/" plus one — and
  /// drops everything else (CollapseCounter's key launder), so a
  /// notification this app did not thread navigates nowhere: the generic
  /// banner of a locked or degraded phone carries no threadIdentifier and
  /// writes no intent. Failures are silent by design — a lost tap costs
  /// one navigation, and the app still opens exactly where it opens today.
  private static func recordPendingNav(thread: String) {
    let key = thread.hasPrefix("g/") ? String(thread.dropFirst(2)) : thread
    guard key.count == 26,
          key.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
    else { return }
    guard let root = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroupIdentifier
    ) else { return }
    let dir = root.appendingPathComponent("tacendum-shared", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: dir,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    let url = dir.appendingPathComponent("pending-nav", isDirectory: false)
    let line = "\(Int(Date().timeIntervalSince1970 * 1000)) \(thread)"
    try? Data(line.utf8).write(
      to: url,
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    )
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    // No token, so no message notifications. Degraded, not broken — messages
    // still arrive over the socket — and the error is never logged in a
    // shipping build: it can name the device. The next launch tries again.
    //
    // In DEBUG it IS logged, because this is the failure that looks exactly
    // like success from the outside: the permission prompt is local and
    // appears whether or not APNs registration then works.
    #if DEBUG
    NSLog("[push] APNs registration FAILED: %@", error.localizedDescription)
    #endif
    TacendumCallImpl.shared.setAlertToken("")
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
