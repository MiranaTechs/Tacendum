require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "TacendumCall"
  s.version      = package["version"]
  s.summary      = "Tacendum calling: WebRTC, CallKit, PushKit"
  s.description  = package["description"]
  s.homepage     = "https://github.com/tacendum/tacendum"
  s.license      = package["license"]
  s.authors      = "Tacendum"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/tacendum/tacendum.git", :tag => s.version.to_s }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.0"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  # The media stack. Pinned to the exact version the link spike cleared
  # against LibSignalClient's prebuilt Rust archive: two
  # static libraries each carrying their own BoringSSL is a duplicate-symbol
  # hazard, and the insidious failure is not a link error but one library's
  # calls silently resolving to the other's implementation.
  s.dependency "react-native-webrtc"

  install_modules_dependencies(s)
end
