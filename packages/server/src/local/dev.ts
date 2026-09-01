/**
 * Local dev entrypoint: HTTP adapter (registration/auth/keys) + WebSocket
 * adapter (real-time ciphertext routing) hosting the same pure handlers the
 * future CDK stack will deploy.
 */
import { makeDeps, startHttpServer } from './http.js';
import { startWsServer } from './ws.js';

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const WS_PORT = Number(process.env.WS_PORT ?? 8081);

const deps = makeDeps();
startHttpServer(HTTP_PORT, deps);
startWsServer(WS_PORT, deps);
