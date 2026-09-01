#!/usr/bin/env ruby
# frozen_string_literal: true

# Add the notification-service extension target to Tacendum.xcodeproj.
#
# WHY A SCRIPT AND NOT A HAND-EDIT. `project.pbxproj` is a graph of UUID-keyed
# objects; a new native target needs a PBXNativeTarget, two build
# configurations, a product reference in the Products group, a
# PBXTargetDependency and a PBXContainerItemProxy on the app, an Embed App
# Extensions copy phase, and source/framework build phases — all cross-linked.
# Hand-editing that is not a diff anyone can review, and a wrong UUID produces
# an Xcode that opens the project and silently shows no targets.
#
# WHY NOT A GENERATOR. xcodegen and tuist would want to own the whole project
# file, which this repo does not do. CocoaPods already vendors `xcodeproj`, so
# the dependency is one already on every machine that can build this app.
#
# IDEMPOTENT: running it twice is a no-op. That matters because it is a
# checked-in step someone will run again after a merge, not a one-time act.
#
# Usage:
#   ruby app/ios/scripts/add-nse-target.rb
#
# It is deliberately NOT wired into a build phase. Mutating the project file
# during a build is how a project ends up with four copies of a target.

GEMS = Dir.glob('/opt/homebrew/Cellar/cocoapods/*/libexec/gems/*/lib')
$LOAD_PATH.unshift(*GEMS)
require 'xcodeproj'

ROOT = File.expand_path('../..', __dir__)
PROJECT = File.join(ROOT, 'ios', 'Tacendum.xcodeproj')
TARGET_NAME = 'TacendumNSE'
APP_TARGET = 'Tacendum'
BUNDLE_ID = 'com.miranatechnologies.tacendum.nse'
# The Apple Team ID is deliberately NOT here, and not read from ENV either:
# whatever this script resolves gets SAVED into the tracked project.pbxproj,
# so an env lookup would just launder the literal back into git on the next
# run. (It used to be a TEAM constant holding the literal Team ID —
# targeting information that fails .env.example's "public by another
# route?" test.) Instead the target
# gets the same build-setting reference the app target carries; the value
# lives in app/ios/Tacendum.xcconfig (gitignored, schema in
# Tacendum.xcconfig.example), attached as the project-level base
# configuration, which every target inherits.
TEAM_REF = '$(TACENDUM_DEVELOPMENT_TEAM)'
SOURCE_DIR = File.join(ROOT, 'ios', TARGET_NAME)

# Files the extension shares with the app, compiled into BOTH targets.
#
# NOT by depending on the tacendum-crypto pod: that pod is a React Native
# TurboModule, so its .mm imports React and taking it would pull the whole
# framework into a process that must never boot a JS runtime. These three are
# plain Swift over Foundation and LibSignalClient, which the extension already
# links, and compiling the same file twice is cheaper in every sense than
# maintaining a second copy of the store.
#
# The alternative — the extension keeping its own path constants and its own
# store implementation — fails silently when they drift: it opens an empty
# directory, finds no identity, and every notification falls back to the
# server's generic body with nothing to diagnose.
SHARED_SOURCES = %w[
  SharedContainer.swift
  StoreLock.swift
  TacendumStores.swift
].map { |f| File.join(ROOT, 'modules', 'tacendum-crypto', 'ios', f) }

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == APP_TARGET }
abort "no #{APP_TARGET} target" unless app

# A SHARED scheme, written whether or not the target is new.
#
# Xcode creates schemes lazily, in the user's own `xcuserdata`, the first time
# it opens a project — which means they do not exist on a fresh clone and are
# not in git. `xcodebuild -scheme TacendumNSE` is how this target's build is
# verified in isolation (proving it does not drag React Native in
# through the app), and that command needs a scheme that is checked in.
#
# Written on every run rather than only on creation, so deleting the scheme and
# re-running restores it.
def write_scheme(project, target)
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(target)
  # No test or launch action: an app extension cannot be launched on its own,
  # and a scheme that claims it can produces a confusing failure rather than a
  # clear one.
  scheme.save_as(project.path, target.name, true)
  puts "wrote shared scheme #{target.name}"
end

# Add every .swift in ios/TacendumNSE that the target does not already compile.
#
# THIS RUNS ON BOTH PATHS, and it did not used to. The idempotency guard below
# returned before the source loop, so the promise made by this script — that a
# new file is picked up by re-running it — was false in the only state where
# anyone would need it: the target already exists and a file has just been
# added. Re-running printed "nothing else to do" and changed nothing.
#
# The failure that follows is usually loud (a Swift file that references the
# new type gets "cannot find X in scope"), but not always: a self-contained
# file nothing references yet is simply never compiled, `xcodebuild` reports
# BUILD SUCCEEDED, and the code is absent from the .appex. That is the shape
# the next step is in — adding a decryptor to an extension whose only visible
# symptom would be a notification that still shows the fallback text.
#
# Keyed on the file NAME already in the phase, so re-running cannot produce a
# duplicate build file (which Xcode reports as a duplicate-symbol link error).
def sync_sources(project, target)
  group = project.main_group.find_subpath(TARGET_NAME, true)
  group.set_source_tree('SOURCE_ROOT')
  group.set_path(TARGET_NAME)
  have = target.source_build_phase.files.map { |f| f.file_ref&.display_name }.compact
  added = []

  Dir.glob(File.join(SOURCE_DIR, '*.swift')).sort.each do |path|
    name = File.basename(path)
    next if have.include?(name)
    ref = group.files.find { |f| f.display_name == name } || group.new_reference(name)
    target.add_file_references([ref])
    added << name
  end

  # The shared files live outside this group, so they are referenced by
  # absolute path from a group of their own. Same duplicate guard: re-running
  # must never add a second build file, which Xcode reports as a duplicate
  # symbol at link time rather than as anything about this script.
  shared = project.main_group.find_subpath('TacendumNSE-Shared', true)
  SHARED_SOURCES.each do |path|
    name = File.basename(path)
    next if have.include?(name)
    ref = shared.files.find { |f| f.display_name == name } ||
          shared.new_file(path)
    target.add_file_references([ref])
    added << name
  end

  added
end

if (existing = project.targets.find { |t| t.name == TARGET_NAME })
  write_scheme(project, existing)
  added = sync_sources(project, existing)
  if added.empty?
    puts "#{TARGET_NAME} already present, sources up to date"
  else
    project.save
    puts "#{TARGET_NAME} already present; added #{added.join(', ')}"
  end
  exit 0
end

ext = project.new_target(
  :app_extension,
  TARGET_NAME,
  :ios,
  app.deployment_target,
)

# The gem adds a Foundation.framework reference built from its own hardcoded
# LAST_KNOWN_IOS_SDK, which points at an SDK version this machine may not have
# — it shows as a red file in Xcode. Harmless to the build, but a red file is a
# thing people then try to fix.
#
# BOTH the build file AND the file reference have to go. Removing only the
# former leaves the PBXFileReference alive (the gem drops an object from the
# project only when its referrer count reaches zero, and the group still refers
# to it), so the red entry survives — which is exactly what the first version
# of this script committed. The now-empty group it lived in goes too.
ext.frameworks_build_phase.files.each do |f|
  ref = f.file_ref
  next unless f.display_name == 'Foundation.framework'
  f.remove_from_project
  next unless ref
  group = ref.parent
  ref.remove_from_project
  group.remove_from_project if group.respond_to?(:children) && group.children.empty?
end

ext.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_BUNDLE_IDENTIFIER'] = BUNDLE_ID
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['INFOPLIST_FILE'] = "#{TARGET_NAME}/Info.plist"
  s['CODE_SIGN_ENTITLEMENTS'] = "#{TARGET_NAME}/#{TARGET_NAME}.entitlements"
  s['DEVELOPMENT_TEAM'] = TEAM_REF
  s['SWIFT_VERSION'] = '5.0'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SKIP_INSTALL'] = 'YES'
  # An extension may not call APIs marked unavailable to extensions. Setting
  # this NO would compile and then fail App Store validation, which is a much
  # later and much more expensive place to learn it.
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  # Matches the app: the project forces this off, and a mismatch between the
  # two targets produces module-verification failures that read as missing
  # headers.
  s['SWIFT_ENABLE_EXPLICIT_MODULES'] = 'NO'
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['MARKETING_VERSION'] = '1.0'
  s['CURRENT_PROJECT_VERSION'] = '1'
end

# Sources: whatever is in ios/TacendumNSE, through the same function the
# already-present path uses, so the two can never disagree about what the
# target compiles.
sync_sources(project, ext)

# The app embeds the extension, and must build it first.
app.add_dependency(ext)
embed = app.build_phases.find do |p|
  p.respond_to?(:name) && p.name == 'Embed App Extensions'
end
embed ||= app.new_copy_files_build_phase('Embed App Extensions').tap do |phase|
  phase.symbol_dst_subfolder_spec = :plug_ins
end
embed.add_file_reference(ext.product_reference, true)

write_scheme(project, ext)
project.save
puts "added #{TARGET_NAME} (#{BUNDLE_ID})"
