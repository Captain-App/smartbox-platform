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
  }, 500);
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
  }, 404);
});

// =============================================================================
// Container Classes (required for container bindings)
// =============================================================================

// Container/DO classes.
//
// We MUST export class names that already have Durable Objects on prod.
// Even if we no longer use SandboxStandard*, Cloudflare will refuse deploys
// unless the classes still exist (or we run an explicit delete-class migration).
import { Sandbox as SandboxBase } from '@cloudflare/sandbox';

export class Sandbox extends SandboxBase {}
export class SandboxV4 extends SandboxBase {}
export class SandboxStandard1 extends SandboxBase {}
export class SandboxStandard2 extends SandboxBase {}
export class SandboxStandard3 extends SandboxBase {}

// =============================================================================
// Exports
// =============================================================================

export { ExecResultStore };
export default app;
