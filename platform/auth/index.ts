/**
 * Authentication module exports
 *
 * The main auth middleware logic has moved to moltworker-platform.
 * This module provides minimal stubs for backward compatibility.
 */

import type { Context, Next } from 'hono';
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { verifySupabaseJWT, getUserIdFromPayload } from './supabase-jwt';

export { verifySupabaseJWT, getUserIdFromPayload } from './supabase-jwt';

/**
 * Options for the auth middleware
 */
interface AuthMiddlewareOptions {
  type?: 'json' | 'html';
}

/**
 * Create Supabase auth middleware
 *
 * Verifies JWT tokens from cookies or Authorization header.
 * On success, sets user info and updates sandbox binding.
 */
export function createSupabaseAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const responseType = options.type || 'json';

  return async (c: Context, next: Next) => {
    const env = c.env as {
      SUPABASE_JWT_SECRET?: string;
      DEV_MODE?: string;
      E2E_TEST_MODE?: string;
      Sandbox: DurableObjectNamespace<Sandbox>;
    };

    // Skip auth in dev/test mode
    if (env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true') {
      return next();
    }

    // Extract token from cookie or header
    const token = extractToken(c);
    if (!token) {
      return authError(c, responseType, 'Authentication required');
    }

    // Verify JWT
    const secret = env.SUPABASE_JWT_SECRET;
    if (!secret) {
      console.error('[Auth] SUPABASE_JWT_SECRET not configured');
      return authError(c, responseType, 'Authentication not configured');
    }

    const payload = await verifySupabaseJWT(token, secret);
    if (!payload) {
      return authError(c, responseType, 'Invalid or expired token');
    }

    // Set user info
    const userId = getUserIdFromPayload(payload);
    const sandboxName = `openclaw-${userId}`;
    const r2Prefix = `users/${userId}`;

    c.set('user', {
      id: userId,
      email: payload.email,
      sandboxName,
      r2Prefix,
    });

    // Update sandbox binding for this user
    const sandbox = getSandbox(env.Sandbox, sandboxName, { keepAlive: true });
    c.set('sandbox', sandbox);

    return next();
  };
}

/**
 * Extract token from cookie or Authorization header
 */
function extractToken(c: Context): string | null {
  // Try Authorization header first
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Try cookie
  const cookie = c.req.header('Cookie') || '';
  const match = cookie.match(/sb-access-token=([^;]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }

  return null;
}

/**
 * Return auth error response
 */
function authError(c: Context, type: 'json' | 'html', message: string) {
  if (type === 'html') {
    return c.redirect('/login');
  }
  return c.json({ error: message }, 401);
}
