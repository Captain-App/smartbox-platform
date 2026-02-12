/**
 * OpenClaw - Multi-Tenant Bot Platform (v2026.02.12)
 *
 * This Worker runs personal AI assistant instances in Cloudflare Sandbox containers.
 * Each authenticated user gets their own isolated sandbox and R2 storage.
 *
 * Features:
 * - Per-user sandbox isolation ({firstname}-{telegram}-{tier}-ss{shortid})
 * - Per-user R2 storage (users/{userId}/)
 * - Supabase authentication
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 *
 * Required secrets (set via `wrangler secret put`):
 * - SUPABASE_JWT_SECRET: Supabase JWT secret for auth
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - SUPABASE_URL: Supabase project URL (for issuer validation)
 * - MOLTBOT_GATEWAY_MASTER_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv, AuthenticatedUser } from './types';
import { createSupabaseAuthMiddleware } from '../platform/auth';
import {
  ensureMoltbotGateway,
  getSandboxForUser,
  getInstanceTypeName,
  getGatewayMasterToken,
} from './gateway';
import { publicRoutes, api, adminUi, debug, cdp, relayRoutes, adminRouter } from './routes';
import { redactSensitiveParams } from './utils/logging';
import configErrorHtml from './assets/config-error.html';
import { proxyHandler } from './proxy';
import { scheduled as scheduledHandler } from './scheduled';

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];
  const isTestMode = env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true';

  if (!getGatewayMasterToken(env)) {
    missing.push('MOLTBOT_GATEWAY_MASTER_TOKEN (or legacy MOLTBOT_GATEWAY_TOKEN)');
  }

  // Require Supabase JWT secret for authentication (skip in dev/test mode)
  if (!isTestMode && !env.SUPABASE_JWT_SECRET) {
    missing.push('SUPABASE_JWT_SECRET');
  }

  // Check for AI Gateway or direct Anthropic configuration
  if (env.AI_GATEWAY_API_KEY) {
    // AI Gateway requires both API key and base URL
    if (!env.AI_GATEWAY_BASE_URL) {
      missing.push('AI_GATEWAY_BASE_URL (required when using AI_GATEWAY_API_KEY)');
    }
  } else if (!env.ANTHROPIC_API_KEY) {
    // Direct Anthropic access requires API key
    missing.push('ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY');
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 *
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  console.log(`[REQ] Has ANTHROPIC_API_KEY: ${!!c.env.ANTHROPIC_API_KEY}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

/**
 * Get the sandbox name for the current request.
 * Uses authenticated user's sandbox name, or falls back to 'moltbot' for public routes.
 */
function getSandboxNameForRequest(c: { get: (key: 'user') => AuthenticatedUser | undefined }): string {
  const user = c.get('user');
  if (user) {
    return user.sandboxName;
  }
  // Fallback for public routes (before auth runs)
  return 'moltbot';
}

// Middleware: Initialize sandbox for all requests
// Note: For authenticated routes, the sandbox name is updated after auth middleware runs
// Skip sandbox init for debug/admin routes - they create their own sandbox instances
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/debug/admin/') || url.pathname.startsWith('/api/super/')) {
    // Debug admin and super admin routes handle their own sandbox instances
    return next();
  }

  const options = buildSandboxOptions(c.env);
  const sandboxName = getSandboxNameForRequest(c);
  const user = c.get('user');

  const sandboxBinding = user ? getSandboxForUser(c.env, user.id) : c.env.Sandbox;
  const sandbox = getSandbox(sandboxBinding, sandboxName, options);

  if (user) {
    const instanceType = getInstanceTypeName(user.id);
    const isTiered = sandboxBinding !== c.env.Sandbox;
    console.log(`[SANDBOX] User ${user.id} using ${instanceType}${isTiered ? ' (tiered)' : ' (legacy)'}`);
  }

  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// AUTH ROUTES: Login, logout, and OAuth callbacks
// =============================================================================

// Login page - redirect to main app for SSO
app.get('/login', async (c) => {
  const returnUrl = encodeURIComponent('https://claw.captainapp.co.uk/auth/callback');
  return c.redirect(`https://captainapp.co.uk/auth?redirect=${returnUrl}`);
});

// Auth callback - handle session tokens from the hash (set by app.captainapp.co.uk)
app.get('/auth/callback', async (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Signing in...</title>
      <style>
        body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #fff; }
        .loading { text-align: center; }
        .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #f97316; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="loading">
        <div class="spinner"></div>
        <p>Signing in...</p>
      </div>
      <script>
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');

        if (accessToken) {
          const domain = '; domain=.captainapp.co.uk';
          document.cookie = 'sb-access-token=' + encodeURIComponent(accessToken) + domain + '; path=/; max-age=3600; SameSite=Lax; Secure';
          window.location.replace('/');
        } else {
          window.location.replace('/');
        }
      </script>
    </body>
    </html>
  `);
});

// Logout - redirect to main app's logout
app.get('/logout', async (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head><title>Logging out...</title></head>
    <body>
      <p>Logging out...</p>
      <script>
        document.cookie = 'sb-access-token=; domain=.captainapp.co.uk; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure';
        document.cookie = 'captainapp-sso-v1=; domain=.captainapp.co.uk; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure';
        window.location.href = '/login';
      </script>
    </body>
    </html>
  `);
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

app.route('/', publicRoutes);

// Debug bypass endpoint (requires secret header, bypasses CF Access)
app.get('/debug-bypass', async (c) => {
  console.log('[DEBUG-BYPASS] Hit debug-bypass endpoint');
  const secret = c.req.header('X-Debug-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);

  console.log('[DEBUG-BYPASS] Secret provided:', !!secret);
  console.log('[DEBUG-BYPASS] Expected secret exists:', !!expectedSecret);

  if (!secret || secret !== expectedSecret) {
    console.log('[DEBUG-BYPASS] Unauthorized - secret mismatch');
    return c.json({ error: 'Unauthorized', hasSecret: !!secret, hasExpected: !!expectedSecret }, 401);
  }

  const sandbox = c.get('sandbox');

  try {
    const processes = await sandbox.listProcesses();
    const gatewayProcess = processes.find((p: any) => p.command.includes('start-moltbot'));

    return c.json({
      gateway: {
        running: !!gatewayProcess,
        processId: gatewayProcess?.id,
        status: gatewayProcess?.status,
      },
      totalProcesses: processes.length,
      env: {
        hasAnthropicKey: !!c.env.ANTHROPIC_API_KEY,
        hasOpenAIKey: !!c.env.OPENAI_API_KEY,
        hasGatewayToken: !!getGatewayMasterToken(c.env),
        devMode: c.env.DEV_MODE,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// Mount Relay routes (bot-to-bot message relay, uses its own auth middleware)
app.route('/relay', relayRoutes);

// =============================================================================
// SUPER ADMIN ROUTES: Protected by X-Admin-Secret header
// =============================================================================

app.route('/api/super', adminRouter);

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    return c.json({
      error: 'Configuration error',
      message: 'Required environment variables are not configured',
      missing: missingVars,
      hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
    }, 503);
  }

  return next();
});

// Middleware: Supabase authentication for protected routes
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const publicPaths = ['/login', '/logout', '/auth/callback'];
  const isPublicPath = publicPaths.includes(url.pathname) ||
                       url.pathname.startsWith('/_admin/assets/') ||
                       url.pathname.startsWith('/debug/admin/') ||
                       url.pathname.startsWith('/api/super/');
  console.log(`[AUTH] Path: ${url.pathname}, isPublic: ${isPublicPath}`);
  if (isPublicPath) {
    return next();
  }

  // Skip auth for admin API routes when X-Admin-Secret header is valid
  if (url.pathname.startsWith('/api/admin/')) {
    const adminSecret = c.req.header('X-Admin-Secret');
    const expectedSecret = getGatewayMasterToken(c.env);
    if (adminSecret && adminSecret === expectedSecret) {
      console.log(`[AUTH] Admin secret auth for ${url.pathname}`);
      return next();
    }
  }

  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createSupabaseAuthMiddleware({
    type: acceptsHtml ? 'html' : 'json',
  });

  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// Emergency container reset endpoint (requires auth)
async function handleEmergencyReset(c: any) {
  const sandbox = c.get('sandbox');
  const userId = c.get('user')?.id;

  console.log(`[RESET] Resetting sandbox for user: ${userId}`);

  try {
    const allProcesses = await sandbox.listProcesses();
    for (const proc of allProcesses) {
      try { await proc.kill(); } catch (e) { console.warn('[RESET] Kill failed:', e); }
    }
    await new Promise(r => setTimeout(r, 2000));

    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch(e => {
      console.error('[RESET] Gateway restart failed:', e);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({ success: true, message: 'Container reset initiated', sandbox: userId ? `openclaw-${userId}` : 'moltbot' });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
}
app.get('/emergency-reset', handleEmergencyReset);
app.post('/emergency-reset', handleEmergencyReset);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', proxyHandler);

// =============================================================================
// DURABLE OBJECT EXPORTS
// =============================================================================

// Export Durable Object classes for tiered instance types
export { Sandbox } from '@cloudflare/sandbox';

// Legacy exports (for migration compatibility — all referenced in wrangler.jsonc migration tags)
export class SandboxStandard1 extends Sandbox {}
export class SandboxStandard2 extends Sandbox {}
export class SandboxStandard3 extends Sandbox {}
export class SmartboxSmall extends Sandbox {}
export class SmartboxMedium extends Sandbox {}
export class SmartboxLarge extends Sandbox {}

// Clean tier names (v6)
// Small=1vCPU/1GB, Medium=2vCPU/2GB, Large=4vCPU/4GB
export class Small extends Sandbox {}
export class Medium extends Sandbox {}
export class Large extends Sandbox {}

export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledEvent, env: MoltbotEnv, ctx: ExecutionContext) =>
    scheduledHandler(event, env, ctx, async (req, e) => app.fetch(req, e)),
};
