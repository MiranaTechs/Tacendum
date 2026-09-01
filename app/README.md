# Tacendum mobile app

This directory contains the React Native 0.86 client for iOS and Android. Set
up the repository-root dependencies and local backend before starting the app.

## Local backend

From the repository root:

```sh
cp .env.example .env
pnpm install
pnpm infra:up
pnpm tables:create
pnpm dev
```

Debug builds read the repository `.env` at bundle time. Restart Metro after
changing it. Release builds always use the hosted `aws` environment and ignore
local endpoint overrides.

## Start Metro

```sh
pnpm --dir app start
```

Metro listens on port 8083 because the local WebSocket adapter uses 8081.

## iOS

Requirements: macOS, Xcode 26+, CocoaPods 1.13+, and watchman. Install Ruby and
pod dependencies from the repository root:

```sh
cd app
bundle install
cd ios
bundle exec pod install
cd ../..
```

Simulator builds need no signing configuration. For a device build, copy the
template and set `TACENDUM_DEVELOPMENT_TEAM` in the local file:

```sh
cp app/ios/Tacendum.xcconfig.example app/ios/Tacendum.local.xcconfig
```

With Metro running, launch the app from another shell:

```sh
pnpm --dir app ios
```

## Android

Requirements: Android SDK platform 36, build-tools 36.0.0, NDK
27.1.12297006, `ANDROID_HOME`, JDK 17 for Gradle, and JDK 21 for the host-JVM
libsignal suites. `minSdk` is 26.

With Metro running:

```sh
pnpm --dir app android
```

Run the native Android checks with:

```sh
pnpm --dir app android:check
```

## Checks

```sh
pnpm --dir app test
pnpm --dir app typecheck
pnpm --dir app lint
```

Jest mocks native modules and exercises the JavaScript application. Native
crypto and device-only behavior require their platform-specific suites.

## Troubleshooting

- Restart Metro after changing `.env`.
- Confirm Metro is listening on 8083, not the WebSocket adapter's 8081.
- A device signing error usually means
  `app/ios/Tacendum.local.xcconfig` is absent or has no
  `TACENDUM_DEVELOPMENT_TEAM` value. Simulator builds do not require it.
- For toolchain setup, use React Native's
  [environment guide](https://reactnative.dev/docs/set-up-your-environment)
  and [troubleshooting guide](https://reactnative.dev/docs/troubleshooting).

Tacendum is independent. References to React Native, Apple, Android, and other
products identify technical compatibility only and do not imply affiliation,
sponsorship, or endorsement. Trademarks belong to their respective owners.
