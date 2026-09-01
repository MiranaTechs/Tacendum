import AVFoundation
import CoreImage
import ImageIO
import UIKit
import Vision

/**
 * The two halves of a QR picture that JavaScript cannot do: CoreImage draws
 * the symbol, Vision reads one back out of a still image, and a single file in
 * Caches carries it to the share sheet.
 *
 * This class holds no policy. It does not know what a Tacendum id looks like,
 * it does not decide whether a decoded string is one, and it never inspects
 * the payload it is handed — app/src/qr.ts owns all of that (the same split as
 * ScreenSecurityImpl vs App.tsx). Nothing here logs a payload:
 * the error details below describe structure only, never content.
 *
 * Called from TacendumQr.mm on a global concurrent queue. Every entry point is
 * a pure function of its arguments plus the one fixed file path, so there is
 * no shared mutable state to serialise.
 */
@objc(TacendumQrImpl)
public final class TacendumQrImpl: NSObject {
  @objc public static let shared = TacendumQrImpl()

  private override init() {
    super.init()
  }

  // MARK: - Live camera scan

  /**
   * Present the camera scanner and report every symbol in the frame that
   * satisfied the read.
   *
   * Main-queue only: it touches UIKit and the presented view controller.
   * `onCancel` covers both the Cancel button and "there is no usable camera",
   * because to a caller those are the same outcome — no id was obtained — and
   * distinguishing them would only invite the UI to say something it cannot
   * know.
   */
  @objc public func presentScanner(
    onResult: @escaping ([String]) -> Void,
    onCancel: @escaping () -> Void
  ) {
    // Permission first. Presenting a scanner before asking shows a black
    // rectangle and then a system prompt over the top of it.
    let proceed = { [weak self] in
      guard let self = self else { return onCancel() }
      guard let host = self.topViewController() else { return onCancel() }
      let scanner = QrScannerController(onResult: onResult, onCancel: onCancel)
      host.present(scanner, animated: true)
    }

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      DispatchQueue.main.async(execute: proceed)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async { granted ? proceed() : onCancel() }
      }
    default:
      // Denied or restricted. Cancel rather than reject: the screen that asked
      // already has a settings affordance for the still-image path, and a
      // rejection here would surface as an error where a refusal is the truth.
      DispatchQueue.main.async(execute: onCancel)
    }
  }

  private func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap({ $0.windows }).first(where: { $0.isKeyWindow })
      ?? scenes.first?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }

  // MARK: - Errors

  /**
   * Codes exist for diagnosis only — app/src/qr.ts deliberately does not
   * branch on them, because every one of these produces the same sentence and
   * the same recovery for the person holding the phone. `CustomNSError` is
   * what puts the code in `userInfo["code"]` under domain "TacendumQr", which
   * is the shape TacendumQr.mm's rejectQr() reads.
   */
  enum QrError: LocalizedError, CustomNSError {
    /// An argument this module refuses to work with (length, range, format).
    case badArgument(String)
    /// CoreImage would not draw the symbol.
    case encodeFailed(String)
    /// The file is not an image ImageIO can open.
    case unreadable(String)
    /// The image is absurdly large; refused from its properties, before any
    /// pixels are allocated.
    case tooLarge(String)
    /// Vision itself failed. (Finding no code is NOT this — it is an empty
    /// array, a normal outcome.)
    case decodeFailed(String)
    /// The share file could not be written.
    case writeFailed(String)

    static var errorDomain: String { "TacendumQr" }

    var code: String {
      switch self {
      case .badArgument: return "qr_bad_argument"
      case .encodeFailed: return "qr_encode_failed"
      case .unreadable: return "qr_unreadable"
      case .tooLarge: return "qr_too_large"
      case .decodeFailed: return "qr_decode_failed"
      case .writeFailed: return "qr_write_failed"
      }
    }

    var errorCode: Int {
      switch self {
      case .badArgument: return 1
      case .encodeFailed: return 2
      case .unreadable: return 3
      case .tooLarge: return 4
      case .decodeFailed: return 5
      case .writeFailed: return 6
      }
    }

    /// Structural detail only. Never the text being encoded, never a decoded
    /// payload, never the path of a photo the person picked.
    private var detail: String {
      switch self {
      case .badArgument(let d), .encodeFailed(let d), .unreadable(let d),
        .tooLarge(let d), .decodeFailed(let d), .writeFailed(let d):
        return d
      }
    }

    var errorDescription: String? { "\(code): \(detail)" }

    var errorUserInfo: [String: Any] {
      return ["code": code, NSLocalizedDescriptionKey: errorDescription ?? code]
    }
  }

  // MARK: - Limits

  /// Longest string we will draw. A Tacendum id is 26 characters; the headroom
  /// is slack, not an invitation — beyond this it is somebody else's payload.
  private static let maxTextBytes = 512

  /// Requested raster edge, clamped. Below 64 nothing is scannable; above 2048
  /// we are drawing a wall poster into a bridge string.
  private static let minPixels = 64
  private static let maxPixels = 2048

  /// Quiet zone, in modules, baked into the exported PNG. The ISO spec asks
  /// for 4 and CIQRCodeGenerator supplies 1 (verified: a 25-module symbol
  /// arrives with a 27x27 extent). The file leaves the app and gets cropped,
  /// pasted and recompressed by people we do not control, so it cannot borrow
  /// the panel's padding — it carries its own.
  private static let quietModules = 4

  /// A QR symbol is 21 modules (version 1) to 177 (version 40). Anything
  /// outside that is not a symbol and we refuse to raster it.
  private static let minModules = 21
  private static let maxModules = 177

  /// Refused from the file's properties, before a pixel is decoded.
  private static let maxSourceEdge = 30_000
  private static let maxSourcePixels = 80_000_000

  /// Working ceiling for decoding. ImageIO's decimation down to this is both
  /// the memory bound and the quality path: Lanczos keeps module edges far
  /// better than a re-encode would.
  private static let maxWorkingEdge = 4096

  /// Shared because a CIContext is expensive to build and documented
  /// thread-safe; the work itself is a 25x25 render, so there is nothing to
  /// gain from a context per call.
  private let ciContext = CIContext(options: nil)

  // MARK: - Encode

  /**
   * Draw `text` as a QR and return the PNG bytes, base64.
   *
   * The one defect that matters here is a blurry symbol, so the raster is
   * built by hand rather than by scaling a CIImage: one pixel per module from
   * CoreImage, then an INTEGER upscale with interpolation and antialiasing
   * both off. Any fractional scale or any smoothing leaves modules with soft,
   * unequal edges, and a cheap decoder pointed at a screen will not binarise
   * them.
   */
  @objc public func encodePng(
    _ text: String,
    pixels: Int,
    darkHex: String,
    lightHex: String
  ) throws -> String {
    guard !text.isEmpty, text.utf8.count <= Self.maxTextBytes else {
      throw QrError.badArgument("text must be 1...\(Self.maxTextBytes) bytes")
    }
    guard pixels >= Self.minPixels, pixels <= Self.maxPixels else {
      throw QrError.badArgument("pixels must be \(Self.minPixels)...\(Self.maxPixels)")
    }
    guard let dark = Self.rgb(fromHex: darkHex), let light = Self.rgb(fromHex: lightHex) else {
      throw QrError.badArgument("colours must be #RRGGBB")
    }

    guard let generator = CIFilter(name: "CIQRCodeGenerator") else {
      throw QrError.encodeFailed("no CIQRCodeGenerator")
    }
    generator.setValue(Data(text.utf8), forKey: "inputMessage")
    // Correction level M, not H, and this is a deliberate trade.
    //
    // A 26-character id is 26 bytes, which is exactly the byte-mode capacity
    // of a version-2 symbol at M: 25 modules. At H the same payload needs
    // version 3-4, so 29-33 modules. The picture is displayed at a fixed
    // ~176pt and is then screenshotted, re-compressed and photographed off a
    // screen — conditions where robustness comes from each module being big
    // enough to survive resampling, not from having more, smaller modules
    // carrying more redundancy. Fewer, larger modules wins here; M also keeps
    // ~15% recovery, which covers the compression artefacts H would be
    // spending its extra area on.
    generator.setValue("M", forKey: "inputCorrectionLevel")
    guard let symbol = generator.outputImage else {
      throw QrError.encodeFailed("generator produced nothing")
    }

    // CIQRCodeGenerator emits the symbol plus exactly one module of quiet
    // zone. Crop that off so the quiet zone is ours to size (4 modules, below)
    // rather than the generator's 1.
    let core = symbol.cropped(to: symbol.extent.insetBy(dx: 1, dy: 1))
    let moduleCount = Int(core.extent.width.rounded())
    guard
      moduleCount >= Self.minModules,
      moduleCount <= Self.maxModules,
      Int(core.extent.height.rounded()) == moduleCount
    else {
      throw QrError.encodeFailed("implausible symbol")
    }

    // Recolour before rastering. The generator draws black modules on white
    // paper; CIFalseColor maps black -> inputColor0 and white -> inputColor1,
    // so the theme's ink and paper arrive as the only two colours in the file
    // and the raster below can be drawn opaque with no masking step.
    guard let recolour = CIFilter(name: "CIFalseColor") else {
      throw QrError.encodeFailed("no CIFalseColor")
    }
    recolour.setValue(core, forKey: "inputImage")
    recolour.setValue(CIColor(red: dark.0, green: dark.1, blue: dark.2), forKey: "inputColor0")
    recolour.setValue(CIColor(red: light.0, green: light.1, blue: light.2), forKey: "inputColor1")
    guard let inked = recolour.outputImage else {
      throw QrError.encodeFailed("recolour produced nothing")
    }

    // 1:1 — one pixel per module. Everything after this is whole-pixel
    // replication, never resampling.
    guard let modules = ciContext.createCGImage(inked, from: core.extent) else {
      throw QrError.encodeFailed("no 1:1 raster")
    }

    let total = moduleCount + 2 * Self.quietModules
    // Integer scale only: a fractional scale gives some modules one more pixel
    // than their neighbours, and the ragged edge is exactly what a decoder
    // reads as noise. `pixels` is therefore a request, not a promise — at 768
    // with 25 modules this is scale 23, edge 759.
    let scale = max(1, pixels / total)
    let edge = total * scale

    let space = CGColorSpaceCreateDeviceRGB()
    guard
      let canvas = CGContext(
        data: nil,
        width: edge,
        height: edge,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ),
      let paper = CGColor(colorSpace: space, components: [light.0, light.1, light.2, 1])
    else {
      throw QrError.encodeFailed("no canvas")
    }

    // The two lines that decide whether any of this scans.
    canvas.interpolationQuality = .none
    canvas.setShouldAntialias(false)

    canvas.setFillColor(paper)
    canvas.fill(CGRect(x: 0, y: 0, width: edge, height: edge))
    canvas.draw(
      modules,
      in: CGRect(
        x: Self.quietModules * scale,
        y: Self.quietModules * scale,
        width: moduleCount * scale,
        height: moduleCount * scale
      )
    )

    guard let raster = canvas.makeImage(), let png = UIImage(cgImage: raster).pngData() else {
      throw QrError.encodeFailed("no PNG")
    }
    return png.base64EncodedString()
  }

  // MARK: - Decode

  /**
   * Every distinct QR payload in the image at `fileUri`, in detection order.
   *
   * Finding nothing is a normal outcome and returns an empty array: "there is
   * no QR in this photo" is a sentence the JS layer writes, not an error the
   * native side raises. The input is bounded twice on the way in — once from
   * the file's declared dimensions, which allocates nothing, and again by
   * decoding through a thumbnail ceiling — so a hostile or merely absurd
   * picture is refused rather than paged into memory.
   */
  @objc public func decodeFile(_ fileUri: String) throws -> [String] {
    guard let url = URL(string: fileUri), url.isFileURL else {
      throw QrError.badArgument("not a file:// uri")
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
      throw QrError.unreadable("not an image ImageIO can open")
    }

    // Properties, not pixels: nothing is allocated to reach this check.
    guard
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
      let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
      width > 0,
      height > 0
    else {
      throw QrError.unreadable("no pixel dimensions")
    }
    guard
      width <= Self.maxSourceEdge,
      height <= Self.maxSourceEdge,
      width * height <= Self.maxSourcePixels
    else {
      throw QrError.tooLarge("image beyond the decode ceiling")
    }

    let oversized = max(width, height) > Self.maxWorkingEdge
    let loaded: CGImage? =
      oversized
      ? CGImageSourceCreateThumbnailAtIndex(
        source,
        0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceThumbnailMaxPixelSize: Self.maxWorkingEdge,
          kCGImageSourceCreateThumbnailWithTransform: true,
        ] as CFDictionary
      )
      : CGImageSourceCreateImageAtIndex(source, 0, nil)
    guard let image = loaded else {
      throw QrError.unreadable("no decodable pixels")
    }

    // The thumbnail path already applied the EXIF transform, so its pixels are
    // upright; the full-size path did not, so Vision is told. (Barcode
    // detection is rotation-tolerant either way — this keeps the geometry
    // honest rather than the detection possible.)
    var orientation = CGImagePropertyOrientation.up
    if !oversized,
      let raw = (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value,
      let declared = CGImagePropertyOrientation(rawValue: raw)
    {
      orientation = declared
    }

    let request = VNDetectBarcodesRequest()
    // .qr only. A Code-128 on a parcel label or an Aztec on a boarding pass in
    // the same frame is then not even a candidate, so it cannot become the
    // "second code" that makes an otherwise fine picture ambiguous.
    request.symbologies = [.qr]
    #if targetEnvironment(simulator)
      // Later request revisions detect with an ML model that needs the GPU
      // inference stack, which the simulator does not reliably provide (host
      // macOS dependent; observed failing here). Revision 1 is the classic
      // geometric detector and runs everywhere. Device builds keep Vision's
      // default, so shipping detection quality is unchanged.
      request.revision = VNDetectBarcodesRequestRevision1
    #endif

    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    do {
      try handler.perform([request])
    } catch {
      // Domain and code only — structural, diagnosable, and never payload.
      let e = error as NSError
      throw QrError.decodeFailed("Vision could not run (\(e.domain) \(e.code))")
    }

    // Detection order preserved; exact duplicates collapsed. Vision reports
    // one symbol twice often enough that treating that as two codes would
    // refuse pictures that are perfectly unambiguous.
    var payloads: [String] = []
    for observation in request.results ?? [] {
      guard let payload = observation.payloadStringValue else { continue }
      // payloadStringValue, never payloadData — the latter is iOS 17+ and this
      // app's floor is 15.1.
      if !payloads.contains(payload) {
        payloads.append(payload)
      }
    }
    return payloads
  }

  // MARK: - The share file

  /// One file, one fixed name, never the id in the name: a filename carrying
  /// the ULID would surface it in the share sheet, in Photos metadata and in
  /// every filesystem index that walks past — the same leak the bare-payload
  /// (not-a-URL) decision exists to prevent.
  private static let shareDirectory = "tacendum-qr"
  private static let shareFilename = "tacendum-id.png"

  private func shareUrl() throws -> URL {
    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    else {
      throw QrError.writeFailed("no caches directory")
    }
    return
      caches
      .appendingPathComponent(Self.shareDirectory, isDirectory: true)
      .appendingPathComponent(Self.shareFilename, isDirectory: false)
  }

  /**
   * Put the PNG where the share sheet can reach it and return its file:// URI.
   *
   * Caches rather than Documents, and excluded from backup: this is a
   * plaintext picture of the only address anyone has for this account, so it
   * must never reach an iCloud backup and must be evictable. The write is
   * atomic and always to the same path, so at most one of these exists at a
   * time and the previous one is replaced rather than accumulated.
   */
  @objc public func writeSharePng(_ pngB64: String) throws -> String {
    guard let bytes = Data(base64Encoded: pngB64), !bytes.isEmpty else {
      throw QrError.badArgument("not base64 PNG bytes")
    }
    var url = try shareUrl()
    do {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try bytes.write(to: url, options: [.atomic])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    } catch {
      throw QrError.writeFailed("could not write the share file")
    }
    return url.absoluteString
  }

  /**
   * Remove it. Called when the panel closes, not when the share sheet
   * dismisses — AirDrop keeps reading the file after the sheet is gone. A
   * missing file is the expected case as often as not, so this never fails.
   */
  @objc public func clearSharePng() throws {
    guard let url = try? shareUrl() else { return }
    try? FileManager.default.removeItem(at: url)
  }

  // MARK: - Colour

  /// '#RRGGBB' -> components, or nil. Strict on purpose: the palette lives in
  /// the theme and arrives as a parameter, so anything else here is a caller
  /// bug worth surfacing rather than a colour worth guessing.
  private static func rgb(fromHex hex: String) -> (CGFloat, CGFloat, CGFloat)? {
    let characters = Array(hex.utf8)
    guard characters.count == 7, characters[0] == UInt8(ascii: "#") else { return nil }
    var value: UInt32 = 0
    for byte in characters.dropFirst() {
      let digit: UInt32
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(byte - UInt8(ascii: "0"))
      case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(byte - UInt8(ascii: "a")) + 10
      case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(byte - UInt8(ascii: "A")) + 10
      default: return nil
      }
      value = value << 4 | digit
    }
    return (
      CGFloat((value >> 16) & 0xFF) / 255.0,
      CGFloat((value >> 8) & 0xFF) / 255.0,
      CGFloat(value & 0xFF) / 255.0
    )
  }
}
