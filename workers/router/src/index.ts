/**
 * Edge Router Worker - Simplified
 * 
 * Entry point for all requests with feature flag routing.
 */

import { Hono } from 'hono';

// Inline environment type
interface RouterAppEnv {
  Bindings: {
    ADMIN_API: Fetcher;
    CONTAINER_GATEWAY: Fetcher;
    RATE_LIMIT_KV?: KVNamespace;
    USE_NEW_ADMIN_API: string;
    USE_NEW_CONTAINER_GATEWAY: string;
  };
  Variables: {
    requestId: string;
    startTime: number;
  };
}

// Inline constants
const HTTP_STATUS = {
  OK: 200,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function redactSensitiveParams(url: URL): string {
  const params = new URLSearchParams(url.search);
  const redacted = new URLSearchParams();
  for (const [key, value] of params) {
    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('key')) {
      redacted.set(key, '[REDACTED]');
    } else {
      redacted.set(key, value);
    }
  }
  return redacted.toString() ? `?${redacted.toString()}` : '';
}

const app = new Hono<RouterAppEnv>();

// =============================================================================
// Middleware
// =============================================================================

// Request ID and logging
app.use('*', async (c, next) => {
  const requestId = generateRequestId();
  c.set('requestId', requestId);
  c.set('startTime', Date.now());
  
  const url = new URL(c.req.url);
  console.log(`[ROUTER] [${requestId}] ${c.req.method} ${url.pathname}${redactSensitiveParams(url)}`);
  
  c.header('X-Request-Id', requestId);
  
  await next();
  
  const duration = Date.now() - c.get('startTime');
  console.log(`[ROUTER] [${requestId}] ${c.req.method} ${url.pathname} - ${c.res.status} (${duration}ms)`);
});

// CORS
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Secret, X-Request-Id');
  
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  
  await next();
});

// Rate limiting
app.use('*', async (c, next) => {
  const env = c.env;
  
  if (!env.RATE_LIMIT_KV) {
    return next();
  }
  
  const clientId = getClientId(c);
  const rateLimitKey = `rate_limit:${clientId}`;
  
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 60;
  
  const current = await env.RATE_LIMIT_KV.get(rateLimitKey);
  const requests = current ? JSON.parse(current) : [];
  
  const validRequests = requests.filter((ts: number) => now - ts < windowMs);
  
  if (validRequests.length >= maxRequests) {
    return c.json({
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil((windowMs - (now - validRequests[0])) / 1000),
    }, HTTP_STATUS.TOO_MANY_REQUESTS);
  }
  
  validRequests.push(now);
  await env.RATE_LIMIT_KV.put(rateLimitKey, JSON.stringify(validRequests), {
    expirationTtl: 60,
  });
  
  await next();
});

// =============================================================================
// Public Routes
// =============================================================================

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'edge-router',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/status', async (c) => {
  return c.json({
    status: 'ok',
    service: 'moltworker',
    router: 'edge-router',
    featureFlags: {
      useNewAdminApi: c.env.USE_NEW_ADMIN_API === 'true',
      useNewContainerGateway: c.env.USE_NEW_CONTAINER_GATEWAY === 'true',
    },
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// Admin API Routes with Feature Flag
// =============================================================================

app.all('/api/super/*', async (c) => {
  const env = c.env;
  const useNewAdminApi = env.USE_NEW_ADMIN_API === 'true';
  
  console.log(`[ROUTER] Admin API request - useNewAdminApi=${useNewAdminApi}`);
  
  if (useNewAdminApi) {
    console.log('[ROUTER] Routing to Admin API Worker');
    return routeToAdminApi(c);
  } else {
    console.log('[ROUTER] Feature flag disabled - returning 503');
    return c.json({ 
      error: 'New Admin API not enabled',
      hint: 'Set USE_NEW_ADMIN_API=true to enable'
    }, 503);
  }
});

// =============================================================================
// Container Gateway Routes with Feature Flag
// =============================================================================

app.get('/login', async (c) => {
  const returnUrl = encodeURIComponent('https://claw.captainapp.co.uk/auth/callback');
  return c.redirect(`https://captainapp.co.uk/auth?redirect=${returnUrl}`);
});

app.get('/auth/callback', async (c) => {
  return c.html(getAuthCallbackHtml());
});

app.get('/logout', async (c) => {
  return c.html(getLogoutHtml());
});

app.all('/_admin/*', async (c) => {
  const useNewGateway = c.env.USE_NEW_CONTAINER_GATEWAY === 'true';
  
  if (useNewGateway) {
    return routeToContainerGateway(c);
  } else {
    return c.json({ 
      error: 'New Container Gateway not enabled',
      hint: 'Set USE_NEW_CONTAINER_GATEWAY=true to enable'
    }, 503);
  }
});

app.all('*', async (c) => {
  const env = c.env;
  const useNewGateway = env.USE_NEW_CONTAINER_GATEWAY === 'true';
  
  if (useNewGateway) {
    return routeToContainerGateway(c);
  } else {
    return c.json({ 
      error: 'New Container Gateway not enabled',
      hint: 'Set USE_NEW_CONTAINER_GATEWAY=true to enable'
    }, 503);
  }
});

// =============================================================================
// Routing Functions
// =============================================================================

async function routeToAdminApi(c: any): Promise<Response> {
  const env = c.env;
  const request = c.req.raw;
  
  const newRequest = new Request(request, {
    headers: {
      ...Object.fromEntries(request.headers),
      'X-Forwarded-For': c.req.header('CF-Connecting-IP') || 'unknown',
      'X-Request-Id': c.get('requestId'),
    },
  });
  
  return env.ADMIN_API.fetch(newRequest);
}

async function routeToContainerGateway(c: any): Promise<Response> {
  const env = c.env;
  const request = c.req.raw;
  
  const newRequest = new Request(request, {
    headers: {
      ...Object.fromEntries(request.headers),
      'X-Forwarded-For': c.req.header('CF-Connecting-IP') || 'unknown',
      'X-Request-Id': c.get('requestId'),
    },
  });
  
  return env.CONTAINER_GATEWAY.fetch(newRequest);
}

// =============================================================================
// Helper Functions
// =============================================================================

function getClientId(c: any): string {
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    try {
      const token = authHeader.replace('Bearer ', '');
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.sub) {
        return payload.sub;
      }
    } catch {
      // Invalid token
    }
  }
  
  return c.req.header('CF-Connecting-IP') || 'unknown';
}

function getAuthCallbackHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>Signing in...</title></head>
<body>
  <p>Signing in...</p>
  <script>
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    if (accessToken) {
      document.cookie = 'sb-access-token=' + encodeURIComponent(accessToken) + '; domain=.captainapp.co.uk; path=/; max-age=3600; SameSite=Lax; Secure';
      window.location.replace('/');
    } else {
      window.location.replace('/');
    }
  </script>
</body>
</html>`;
}

function getLogoutHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>Logging out...</title></head>
<body>
  <p>Logging out...</p>
  <script>
    document.cookie = 'sb-access-token=; domain=.captainapp.co.uk; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure';
    window.location.href = '/login';
  </script>
</body>
</html>`;
}

// =============================================================================
// Error Handling
// =============================================================================

app.onError((err, c) => {
  console.error('[ROUTER] Error:', err);
  return c.json({
    error: 'Internal server error',
    message: err.message,
    requestId: c.get('requestId'),
    timestamp: new Date().toISOString(),
  }, 500);
});

app.notFound((c) => {
  return c.json({
    error: 'Not found',
    path: c.req.path,
    requestId: c.get('requestId'),
  }, 404);
});

export default app;
