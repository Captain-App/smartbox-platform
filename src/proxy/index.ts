import type { Context } from 'hono';
import type { AppEnv } from '../types';
import {
  ensureMoltbotGateway,
  findExistingMoltbotProcess,
} from '../gateway';
import { proxyWebSocket } from './websocket';
import { proxyHttp } from './http';
import loadingPageHtml from '../assets/loading.html';

/**
 * Catch-all proxy handler.
 * Decides between WebSocket and HTTP proxy, handles gateway startup
 * and loading page logic.
 */
export async function proxyHandler(c: Context<AppEnv>): Promise<Response> {
  const sandbox = c.get('sandbox');
  const user = c.get('user');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Determine request type
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await) - pass user ID for per-user token
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env, user?.id).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      })
    );

    // Return the loading page immediately, with user info injected
    const userEmail = user?.email || 'User';
    const loadingPage = loadingPageHtml.replace('{{USER_EMAIL}}', userEmail);
    return c.html(loadingPage);
  }

  // Ensure moltbot is running (this will wait for startup) - pass user ID for per-user token
  try {
    await ensureMoltbotGateway(sandbox, c.env, user?.id);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json({
      error: 'Moltbot gateway failed to start',
      details: errorMessage,
      hint,
    }, 503);
  }

  // Proxy to Moltbot
  if (isWebSocketRequest) {
    return proxyWebSocket({
      sandbox,
      request,
      env: c.env,
      user,
      debugLogs: c.env.DEBUG_ROUTES === 'true',
    });
  }

  return proxyHttp({
    sandbox,
    request,
    env: c.env,
    user,
  });
}
