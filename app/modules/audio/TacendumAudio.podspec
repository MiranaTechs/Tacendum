require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "TacendumAudio"
  s.version      = package["version"]
  s.summary      = "Tacendum voice notes: protected-file recording, memory-only playback"
  s.description  = package["description"]
  s.homepage     = "https://github.com/tacendum/tacendum"
  s.license      = package["license"]
  s.authors      = "Tacendum"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/tacendum/tacendum.git", :tag => s.version.to_s }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.0"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }
  # AudioToolbox carries the message-arrival chime (AudioServices system
  # sound — no session write, honours the silent switch).
  s.frameworks   = "AVFoundation", "AudioToolbox", "CallKit"

  install_modules_dependencies(s)
end
