import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { ServerFrame } from '@tacendum/shared';
import type { WsSender } from '../handlers/ws.js';

/**
 * API Gateway Management API plumbing shared by the WebSocket adapter
 * (ws.lambda.ts, live routing on $default) and the post-connect drain Lambda
 * (ws-drain.lambda.ts). One client per (domain, stage), cached across warm
 * invocations.
 */

const clients = new Map<string, ApiGatewayManagementApiClient>();

export function managementClientFor(
  domainName: string,
  stage: string,
): ApiGatewayManagementApiClient {
  const key = `${domainName}/${stage}`;
  let client = clients.get(key);
  if (!client) {
    client = new ApiGatewayManagementApiClient({
      endpoint: `https://${domainName}/${stage}`,
    });
    clients.set(key, client);
  }
  return client;
}

/**
 * Best-effort transport disconnect — API Gateway `DeleteConnection`, the
 * cloud twin of `socket.close` in the local adapter's live-socket map. Used
 * by session/account revocation to hang up a socket whose session is gone, and
 * by the `$default` recheck when a surviving socket speaks. Built from the same
 * management endpoint as `senderFor`, so it rides the ManageConnections grant
 * (which covers DELETE @connections) the WS function already holds. An already
 * gone connection is success — the goal is exactly that the socket be gone.
 */
export function disconnectorFor(
  domainName: string,
  stage: string,
): (connectionId: string) => Promise<void> {
  const client = managementClientFor(domainName, stage);
  return async (connectionId: string): Promise<void> => {
    try {
      await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (err) {
      if (err instanceof Error && err.name === 'GoneException') return;
      throw err;
    }
  };
}

/** `WsSender` backed by PostToConnection — the cloud twin of the local
 * adapter's live-socket map. Resolves false when the connection is gone. */
export function senderFor(domainName: string, stage: string): WsSender {
  const client = managementClientFor(domainName, stage);
  return {
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      try {
        await client.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(JSON.stringify(frame)),
          }),
        );
        return true;
      } catch (err) {
        // Stale connection (client gone): treat as not-delivered, not an error.
        if (err instanceof Error && err.name === 'GoneException') return false;
        throw err;
      }
    },
  };
}
