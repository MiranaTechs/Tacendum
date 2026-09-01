require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "TacendumCrypto"
  s.version      = package["version"]
  s.summary      = "Tacendum native crypto module over LibSignalClient"
  s.description  = package["description"]
  s.homepage     = "https://github.com/tacendum/tacendum"
  s.license      = package["license"]
  s.authors      = "Tacendum"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/tacendum/tacendum.git", :tag => s.version.to_s }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.0"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  # Deliberately unversioned. The pin lives in the app Podfile, which fetches
  # LibSignalClient by git COMMIT (8e49f09b… — what v0.98.0 dereferences to),
  # on both the app and NSE targets; podspec deps cannot express a git pin, so
  # CocoaPods resolves this against that Podfile entry. Do not add a version
  # here: it would silently disagree with the Podfile rather than constrain it.
  # Guarded by app/__tests__/podfile.pins.test.ts.
  s.dependency "LibSignalClient"

  install_modules_dependencies(s)
end
