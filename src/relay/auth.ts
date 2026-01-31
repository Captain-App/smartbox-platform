/**
 * Relay Authentication Middleware
 *
 * Handles authentication for relay endpoints using either:
 * 1. Supabase JWT (moltworker users) - Authorization: Bearer <jwt>
 * 2. API Key (external bots) - X-Relay-Key: <api-key>
 */

import type { Context, Next } from 'hono';
import type { AppEnv, MoltbotEnv } from '../types';
import { verifySupabaseJWT, getUserIdFromPayload } from '../../platform/auth/supabase-jwt';
import type { RelayAuthContext, RelayApiKey } from './types';

// Type for the extended relay environment
export interface RelayEnv extends MoltbotEnv {
  RELAY: KVNamespace;
}

export type RelayAppEnv = {
  Bindings: RelayEnv;
  Variables: AppEnv['Variables'] & {
    relayAuth?: RelayAuthContext;
  };
};

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(c: Context<RelayAppEnv>): string | null {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Extract API key from X-Relay-Key header
 */
function extractApiKey(c: Context<RelayAppEnv>): string | null {
  return c.req.header('X-Relay-Key') || null;
}

/**
 * Verify a Supabase JWT and return the user's botId.
 *
 * For moltworker users, we use their Supabase user ID as the botId.
 * This maps 1:1 since each user has their own bot instance.
 */
async function verifyJwtAuth(
  c: Context<RelayAppEnv>,
  token: string
): Promise<RelayAuthContext | null> {
  const jwtSecret = c.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = c.env.SUPABASE_URL;

  if (!jwtSecret) {
    console.error('[RELAY-AUTH] SUPABASE_JWT_SECRET not configured');
    return null;
  }

  try {
    const expectedIssuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined;
    const payload = await verifySupabaseJWT(token, jwtSecret, expectedIssuer);
    const userId = getUserIdFromPayload(payload);

    // For moltworker users, we need to look up their bot's Telegram ID
    // For now, we'll use their Supabase user ID as the bot identifier
    // The actual Telegram bot ID mapping happens when they register
    return {
      botId: userId,
      botName: `moltworker-${userId.slice(0, 8)}`,
      authMethod: 'jwt',
    };
  } catch (err) {
    console.error('[RELAY-AUTH] JWT verification failed:', err);
    return null;
  }
}

/**
 * Verify an API key and return the associated bot info.
 */
async function verifyApiKeyAuth(
  c: Context<RelayAppEnv>,
  apiKey: string
): Promise<RelayAuthContext | null> {
  try {
    const keyData = await c.env.RELAY.get(`relay:apikey:${apiKey}`, 'json') as RelayApiKey | null;

    if (!keyData) {
      console.log('[RELAY-AUTH] API key not found');
      return null;
    }

    return {
      botId: keyData.botId,
      botName: keyData.botName,
      authMethod: 'apikey',
    };
  } catch (err) {
    console.error('[RELAY-AUTH] API key lookup failed:', err);
    return null;
  }
}

/**
 * Create relay authentication middleware.
 *
 * Checks for JWT first, then falls back to API key.
 * Sets `relayAuth` on context if authentication succeeds.
 */
export function createRelayAuthMiddleware() {
  return async (c: Context<RelayAppEnv>, next: Next) => {
    // Check for JWT first
    const bearerToken = extractBearerToken(c);
    if (bearerToken) {
      const auth = await verifyJwtAuth(c, bearerToken);
      if (auth) {
        c.set('relayAuth', auth);
        console.log(`[RELAY-AUTH] JWT auth: botId=${auth.botId}`);
        return next();
      }
      // JWT was provided but invalid
      return c.json({ error: 'Invalid or expired JWT' }, 401);
    }

    // Fall back to API key
    const apiKey = extractApiKey(c);
    if (apiKey) {
      const auth = await verifyApiKeyAuth(c, apiKey);
      if (auth) {
        c.set('relayAuth', auth);
        console.log(`[RELAY-AUTH] API key auth: botId=${auth.botId}`);
        return next();
      }
      // API key was provided but invalid
      return c.json({ error: 'Invalid API key' }, 401);
    }

    // No authentication provided
    return c.json(
      {
        error: 'Authentication required',
        hint: 'Provide Authorization: Bearer <jwt> or X-Relay-Key: <api-key>',
      },
      401
    );
  };
}

/**
 * Require admin access for an endpoint.
 *
 * Must be used after relay auth middleware.
 * Only allows moltworker users who are in the ADMIN_USER_IDS list.
 */
export function requireAdminAccess() {
  return async (c: Context<RelayAppEnv>, next: Next) => {
    const relayAuth = c.get('relayAuth');

    if (!relayAuth) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Only JWT auth (moltworker users) can be admins
    if (relayAuth.authMethod !== 'jwt') {
      return c.json({ error: 'Admin access requires moltworker authentication' }, 403);
    }

    // Check if user is in admin list
    const adminIds = c.env.ADMIN_USER_IDS?.split(',').map((id) => id.trim()) || [];
    if (!adminIds.includes(relayAuth.botId)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    return next();
  };
}
