import type { Sandbox } from '@cloudflare/sandbox';
import { MOLTBOT_PORT } from '../config';
import { deriveUserGatewayToken, getGatewayMasterToken } from '../gateway';
import type { AuthenticatedUser, MoltbotEnv } from '../types';
import { redactSensitiveParams } from '../utils/logging';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

export interface ProxyWebSocketOptions {
  sandbox: Sandbox;
  request: Request;
  env: MoltbotEnv;
  user?: AuthenticatedUser;
  debugLogs: boolean;
}

/**
 * Proxy a WebSocket connection to the container gateway.
 * Handles token injection, client↔container relay, and error transformation.
 */
export async function proxyWebSocket(options: ProxyWebSocketOptions): Promise<Response> {
  const { sandbox, request, env, user, debugLogs } = options;
  const url = new URL(request.url);
  const redactedSearch = redactSensitiveParams(url);

  console.log('[WS] Proxying WebSocket connection to Moltbot');
  if (debugLogs) {
    console.log('[WS] URL:', url.pathname + redactedSearch);
  }

  // Inject gateway token for container auth
  let gatewayToken: string | undefined;
  const masterToken = getGatewayMasterToken(env);
  if (user && masterToken) {
    gatewayToken = await deriveUserGatewayToken(masterToken, user.id);
    console.log(`[WS] Using per-user derived token for user ${user.id.slice(0, 8)}...`);
  } else {
    gatewayToken = masterToken;
  }

  // Add token to URL and as header
  const wsUrl = new URL(request.url);
  if (gatewayToken) {
    wsUrl.searchParams.set('token', gatewayToken);
    if (debugLogs) {
      console.log('[WS] Set gateway token in WebSocket URL');
    }
  }

  // Create request with token in header as well
  const wsHeaders = new Headers(request.headers);
  if (gatewayToken) {
    wsHeaders.set('X-Gateway-Token', gatewayToken);
    wsHeaders.set('Authorization', `Bearer ${gatewayToken}`);
  }
  const wsRequest = new Request(wsUrl.toString(), {
    method: request.method,
    headers: wsHeaders,
  });

  // Get WebSocket connection to the container
  const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
  console.log('[WS] wsConnect response status:', containerResponse.status);

  // Get the container-side WebSocket
  const containerWs = containerResponse.webSocket;
  if (!containerWs) {
    console.error('[WS] No WebSocket in container response - falling back to direct proxy');
    return containerResponse;
  }

  if (debugLogs) {
    console.log('[WS] Got container WebSocket, setting up interception');
  }

  // Create a WebSocket pair for the client
  const [clientWs, serverWs] = Object.values(new WebSocketPair());

  // Accept both WebSockets
  serverWs.accept();
  containerWs.accept();

  if (debugLogs) {
    console.log('[WS] Both WebSockets accepted');
    console.log('[WS] containerWs.readyState:', containerWs.readyState);
    console.log('[WS] serverWs.readyState:', serverWs.readyState);
  }

  // Relay messages from client to container, injecting token into connect credentials
  serverWs.addEventListener('message', (event) => {
    if (debugLogs) {
      console.log('[WS] Client -> Container:', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)');
    }
    let data = event.data;

    // Inject gateway token into connect message auth field
    if (typeof data === 'string' && gatewayToken) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.method === 'connect' && parsed.params) {
          if (debugLogs) {
            console.log('[WS] Injecting gateway token into connect auth');
          }
          parsed.params.auth = parsed.params.auth || {};
          parsed.params.auth.token = gatewayToken;
          delete parsed.params.device;
          delete parsed.params.credentials;
          if (parsed.params.client?.id === 'clawdbot-control-ui' || parsed.params.client?.id === 'control-ui') {
            if (debugLogs) {
              console.log('[WS] Changing client ID from', parsed.params.client.id, 'to webchat for proxy compatibility');
            }
            parsed.params.client.id = 'webchat';
          }
          data = JSON.stringify(parsed);
          if (debugLogs) {
            console.log('[WS] Modified connect params (device removed):', JSON.stringify(parsed.params).slice(0, 300));
          }
        }
      } catch (e) {
        // Not JSON, pass through as-is
      }
    }

    if (containerWs.readyState === WebSocket.OPEN) {
      containerWs.send(data);
    } else if (debugLogs) {
      console.log('[WS] Container not open, readyState:', containerWs.readyState);
    }
  });

  // Relay messages from container to client, with error transformation
  containerWs.addEventListener('message', (event) => {
    if (debugLogs) {
      console.log('[WS] Container -> Client (raw):', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)');
    }
    let data = event.data;

    // Try to intercept and transform error messages
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (debugLogs) {
          console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
        }
        if (parsed.error?.message) {
          if (debugLogs) {
            console.log('[WS] Original error.message:', parsed.error.message);
          }
          parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
          if (debugLogs) {
            console.log('[WS] Transformed error.message:', parsed.error.message);
          }
          data = JSON.stringify(parsed);
        }
      } catch (e) {
        if (debugLogs) {
          console.log('[WS] Not JSON or parse error:', e);
        }
      }
    }

    if (serverWs.readyState === WebSocket.OPEN) {
      serverWs.send(data);
    } else if (debugLogs) {
      console.log('[WS] Server not open, readyState:', serverWs.readyState);
    }
  });

  // Handle close events
  serverWs.addEventListener('close', (event) => {
    if (debugLogs) {
      console.log('[WS] Client closed:', event.code, event.reason);
    }
    containerWs.close(event.code, event.reason);
  });

  containerWs.addEventListener('close', (event) => {
    if (debugLogs) {
      console.log('[WS] Container closed:', event.code, event.reason);
    }
    // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
    let reason = transformErrorMessage(event.reason, url.host);
    if (reason.length > 123) {
      reason = reason.slice(0, 120) + '...';
    }
    if (debugLogs) {
      console.log('[WS] Transformed close reason:', reason);
    }
    serverWs.close(event.code, reason);
  });

  // Handle errors
  serverWs.addEventListener('error', (event) => {
    console.error('[WS] Client error:', event);
    containerWs.close(1011, 'Client error');
  });

  containerWs.addEventListener('error', (event) => {
    console.error('[WS] Container error:', event);
    serverWs.close(1011, 'Container error');
  });

  if (debugLogs) {
    console.log('[WS] Returning intercepted WebSocket response');
  }
  return new Response(null, {
    status: 101,
    webSocket: clientWs,
  });
}
