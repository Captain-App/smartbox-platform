import { Hono } from 'hono';
import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';
import type { AppEnv, MoltbotEnv } from '../types';
import { MOLTBOT_PORT, HEALTH_CHECK_CONFIG } from '../config';
import { findExistingMoltbotProcess, checkHealth, getHealthState, getRecentSyncResults, getSandboxForUser, getTierForUser } from '../gateway';
import { verifySupabaseJWT } from '../../platform/auth/supabase-jwt';

/**
 * Build sandbox options based on environment configuration.
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  return { sleepAfter };
}

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Enhanced health check for gateway status
// Checks the user's sandbox if authenticated, otherwise default sandbox
publicRoutes.get('/api/status', async (c) => {
  let sandbox = c.get('sandbox');
  let userId: string | undefined;

  // Try to get authenticated user's sandbox
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '') ||
                  c.req.raw.headers.get('cookie')?.match(/sb-access-token=([^;]+)/)?.[1];

    if (token && c.env.SUPABASE_JWT_SECRET) {
      const decoded = await verifySupabaseJWT(token, c.env.SUPABASE_JWT_SECRET);
      if (decoded) {
        userId = decoded.sub;
        const sandboxName = `openclaw-${userId}`;
        const options = buildSandboxOptions(c.env);
        const sandboxBinding = getSandboxForUser(c.env, userId);
        sandbox = getSandbox(sandboxBinding, sandboxName, options);
        console.log(`[API/status] Using authenticated user sandbox: ${sandboxName} (tier: ${getTierForUser(userId)})`);
      }
    }
  } catch (err) {
    console.log('[API/status] Auth check failed, using default sandbox:', err);
  }

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({
        ok: false,
        status: 'not_running',
        userId: userId?.slice(0, 8),
      });
    }

    // Run full health check if userId is available
    if (userId) {
      const healthResult = await checkHealth(sandbox, userId, HEALTH_CHECK_CONFIG);
      const healthState = getHealthState(userId);
      const recentSyncs = getRecentSyncResults(`users/${userId}`);

      return c.json({
        ok: healthResult.healthy,
        status: healthResult.healthy ? 'healthy' : 'unhealthy',
        processId: process.id,
        processStatus: process.status,
        checks: healthResult.checks,
        consecutiveFailures: healthResult.consecutiveFailures,
        uptimeSeconds: healthResult.uptimeSeconds,
        memoryUsageMb: healthResult.memoryUsageMb,
        lastHealthy: healthState?.lastHealthy,
        lastRestart: healthState?.lastRestart,
        recentSyncs: recentSyncs.slice(0, 3).map(s => ({
          success: s.success,
          lastSync: s.lastSync,
          fileCount: s.fileCount,
          durationMs: s.durationMs,
          error: s.error,
        })),
        userId: userId.slice(0, 8),
      });
    }

    // Basic check for unauthenticated requests
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({
        ok: true,
        status: 'running',
        processId: process.id,
        processStatus: process.status,
      });
    } catch {
      return c.json({
        ok: false,
        status: 'not_responding',
        processId: process.id,
        processStatus: process.status,
      });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// NOTE: /assets/* is NOT handled here - those requests go to the container proxy
// The auth middleware bypasses auth for /assets/* paths so they can be proxied

export { publicRoutes };
