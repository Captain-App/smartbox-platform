/**
 * Admin API Worker - Fleet management with Durable Object-backed exec results
 */

import { Hono } from 'hono';
import { adminRouter } from './routes/admin.js';
import { ExecResultStore } from './durable-objects/exec-result-store.js';

// Inline environment type
interface AdminApiAppEnv {
  Bindings: {
    EXEC_RESULT_STORE: DurableObjectNamespace;
    Sandbox: DurableObjectNamespace;
    SandboxStandard1: DurableObjectNamespace;
    SandboxStandard2: DurableObjectNamespace;
    SandboxStandard3: DurableObjectNamespace;
    MOLTBOT_BUCKET: R2Bucket;
    RELAY: KVNamespace;
    PLATFORM_DB: D1Database;
    MOLTBOT_GATEWAY_MASTER_TOKEN: string;
  };
}

const app = new Hono<AdminApiAppEnv>();

// =============================================================================
// Middleware
// =============================================================================

// Request logging
app.use('*', async (c, next) => {
  const start = Date.now();
  console.log(`[ADMIN-API] ${c.req.method} ${c.req.path}`);
  
  await next();
  
  const duration = Date.now() - start;
  console.log(`[ADMIN-API] ${c.req.method} ${c.req.path} - ${c.res.status} (${duration}ms)`);
});

// Error handling
app.onError((err, c) => {
  console.error('[ADMIN-API] Error:', err);
  return c.json({
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString(),
  }, { status: 500 });
});

// =============================================================================
// Routes
// =============================================================================

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'admin-api',
    timestamp: new Date().toISOString(),
  });
});

// Mount admin routes
app.route('/api/super', adminRouter);

// 404 handler
app.notFound((c) => {
  return c.json({
    error: 'Not found',
    path: c.req.path,
  }, { status: 404 });
});

// =============================================================================
// Container Classes (required for container bindings)
// =============================================================================

// Re-export Sandbox from the SDK — container bindings need the real class
// NOTE: existing production deployments depend on the class name `SandboxV6`.
export { Sandbox as SandboxV6 } from '@cloudflare/sandbox';
// Legacy class names still referenced by existing Durable Objects in production.
export { Sandbox as SandboxV1 } from '@cloudflare/sandbox';
export { Sandbox as SandboxV2 } from '@cloudflare/sandbox';
export { Sandbox as SandboxV3 } from '@cloudflare/sandbox';
export { Sandbox as SandboxV4 } from '@cloudflare/sandbox';
export { Sandbox as SandboxV5 } from '@cloudflare/sandbox';
export { Sandbox as SandboxStandard1 } from '@cloudflare/sandbox';
export { Sandbox as SandboxStandard2 } from '@cloudflare/sandbox';
export { Sandbox as SandboxStandard3 } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

// =============================================================================
// Exports
// =============================================================================

export { ExecResultStore };
export default app;
