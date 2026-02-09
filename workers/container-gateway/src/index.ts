/**
 * Container Gateway Worker - Minimal Stub
 */

import { Hono } from 'hono';

// Container class export required by wrangler
export class Sandbox {}

interface Env {
  MOLTBOT_BUCKET: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'container-gateway',
    mode: 'stub',
    timestamp: new Date().toISOString(),
  });
});

app.all('*', (c) => {
  return c.json({
    error: 'Container Gateway not fully implemented',
    service: 'container-gateway',
    path: c.req.path,
  }, 501);
});

export default app;
