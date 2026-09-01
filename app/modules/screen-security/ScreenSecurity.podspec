require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "ScreenSecurity"
  s.version      = package["version"]
  s.summary      = "Tacendum screen security: capture events and app-switcher cover"
  s.description  = package["description"]
  s.homepage     = "https://github.com/tacendum/tacendum"
  s.license      = package["license"]
  s.authors      = "Tacendum"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/tacendum/tacendum.git", :tag => s.version.to_s }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.0"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  install_modules_dependencies(s)
end
