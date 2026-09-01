# Third-Party Notices

This inventory covers direct third-party dependencies declared by the root,
`app`, and `packages/*` manifests. Versions and license values reproduce each
installed package's metadata; a missing license field is listed as `UNKNOWN`.
Workspace packages (`@tacendum/*` and `tacendum-*`) are excluded. Native
modules under `app/modules/*` declare only the `react` and `react-native` peer
dependencies already listed under `app`.

| Package | Version | License | Used by |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.228 | SEE LICENSE IN README.md | packages/cli |
| `@aws-sdk/client-apigatewaymanagementapi` | 3.1107.0 | Apache-2.0 | packages/server |
| `@aws-sdk/client-cloudwatch` | 3.1107.0 | Apache-2.0 | packages/server |
| `@aws-sdk/client-dynamodb` | 3.1091.0 | Apache-2.0 | root |
| `@aws-sdk/client-dynamodb` | 3.1107.0 | Apache-2.0 | packages/server |
| `@aws-sdk/client-lambda` | 3.1107.0 | Apache-2.0 | packages/server |
| `@aws-sdk/client-pinpoint-sms-voice-v2` | 3.1118.0 | Apache-2.0 | packages/server |
| `@aws-sdk/client-s3` | 3.1091.0 | Apache-2.0 | root |
| `@aws-sdk/client-s3` | 3.1107.0 | Apache-2.0 | packages/server |
| `@aws-sdk/client-secrets-manager` | 3.1107.0 | Apache-2.0 | packages/server |
| `@aws-sdk/client-sesv2` | 3.1117.0 | Apache-2.0 | packages/server |
| `@aws-sdk/cloudfront-signer` | 3.1098.0 | Apache-2.0 | packages/server |
| `@aws-sdk/lib-dynamodb` | 3.1091.0 | Apache-2.0 | root |
| `@aws-sdk/lib-dynamodb` | 3.1107.0 | Apache-2.0 | packages/server |
| `@aws-sdk/s3-request-presigner` | 3.1107.0 | Apache-2.0 | packages/server |
| `@babel/core` | 7.29.7 | MIT | app |
| `@babel/plugin-transform-export-namespace-from` | 7.29.7 | MIT | app |
| `@babel/preset-env` | 7.29.7 | MIT | app |
| `@babel/runtime` | 7.29.7 | MIT | app |
| `@eslint/js` | 9.39.5 | MIT | root |
| `@op-engineering/op-sqlite` | 17.1.2 | MIT | app |
| `@react-native-community/cli` | 20.1.0 | MIT | app |
| `@react-native-community/cli-platform-android` | 20.1.0 | MIT | app |
| `@react-native-community/cli-platform-ios` | 20.1.0 | MIT | app |
| `@react-native/babel-preset` | 0.86.0 | MIT | app |
| `@react-native/eslint-config` | 0.86.0 | MIT | app |
| `@react-native/jest-preset` | 0.86.0 | MIT | app |
| `@react-native/metro-config` | 0.86.0 | MIT | app |
| `@react-native/new-app-screen` | 0.86.0 | MIT | app |
| `@react-native/typescript-config` | 0.86.0 | MIT | app |
| `@signalapp/libsignal-client` | 0.100.0 | AGPL-3.0-only | packages/cli, packages/server |
| `@types/aws-lambda` | 8.10.162 | MIT | packages/server |
| `@types/jest` | 29.5.14 | MIT | app |
| `@types/node` | 22.20.1 | MIT | root |
| `@types/react` | 19.2.17 | MIT | app |
| `@types/react-test-renderer` | 19.1.0 | MIT | app |
| `@types/ws` | 8.18.1 | MIT | packages/cli, packages/server |
| `esbuild` | 0.28.1 | MIT | packages/server |
| `eslint` | 8.57.1 | MIT | app |
| `eslint` | 9.39.5 | MIT | root |
| `jest` | 29.7.0 | MIT | app |
| `prettier` | 2.8.8 | MIT | app |
| `prettier` | 3.9.6 | MIT | root |
| `react` | 19.2.3 | MIT | app |
| `react-native` | 0.86.0 | MIT | app |
| `react-native-dotenv` | 4.1.1 | MIT | app |
| `react-native-image-picker` | 8.2.1 | MIT | app |
| `react-native-safe-area-context` | 5.8.0 | MIT | app |
| `react-native-svg` | 15.15.5 | MIT | app |
| `react-native-webrtc` | 124.0.8 | MIT | app |
| `react-test-renderer` | 19.2.3 | MIT | app |
| `tsx` | 4.23.1 | MIT | root |
| `typescript` | 5.9.3 | Apache-2.0 | root, app |
| `typescript-eslint` | 8.66.0 | MIT | root |
| `ulid` | 3.0.2 | MIT | app, packages/cli, packages/server |
| `uqr` | 0.1.3 | MIT | packages/cli |
| `vitest` | 3.2.7 | MIT | root |
| `ws` | 8.21.3 | MIT | packages/cli, packages/server |
| `zod` | 4.4.3 | MIT | app, packages/cli, packages/server, packages/shared |

## libsignal

`@signalapp/libsignal-client` provides the protocol implementation used for
end-to-end encryption in the CLI and server. Its installed metadata declares
`AGPL-3.0-only`, matching this project's license.

## License texts

After installation, each package's full license text is available under
`node_modules/<package>/`, usually as `LICENSE`, `LICENSE.md`, or `COPYING`.
