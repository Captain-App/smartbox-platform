/**
 * Shared authentication utilities for moltworker architecture
 */

import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { AuthenticatedUser, AccessUser } from './types.js';

// =============================================================================
// Constants
// =============================================================================

export const AUTH_COOKIE_NAME = 'sb-access-token';
export const AUTH_HEADER_NAME = 'Authorization';
export const ADMIN_SECRET_HEADER = 'X-Admin-Secret';

// User tier mapping for tiered routing
export const USER_TIER_MAP: Record<string, 1 | 2 | 3> = {
  // Tier 3: High priority users
  '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b': 3, // jack
};

// Default tier for users not in the map
export const DEFAULT_USER_TIER = 1;

// =============================================================================
// Supabase Auth
// =============================================================================

export interface SupabaseJwtPayload {
  sub: string; // User ID
  email?: string;
  aud: string;
  exp: number;
  iat: number;
  iss?: string;
  [key: string]: unknown;
}

/**
 * Verify a Supabase JWT token
 */
export async function verifySupabaseToken(
  token: string,
  jwtSecret: string,
  supabaseUrl?: string
): Promise<SupabaseJwtPayload> {
  // For Supabase, we need to use the JWT secret directly
  // The secret is used to verify HS256 tokens
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(jwtSecret);
  
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ['HS256'],
    issuer: supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined,
  });
  
  return payload as SupabaseJwtPayload;
}

/**
 * Extract token from Authorization header or cookie
 */
export function extractAuthToken(
  headers: Headers,
  cookies?: Record<string, string>
): string | null {
  // Check Authorization header first
  const authHeader = headers.get(AUTH_HEADER_NAME);
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }
  
  // Check cookie
  if (cookies && cookies[AUTH_COOKIE_NAME]) {
    return cookies[AUTH_COOKIE_NAME];
  }
  
  // Parse Cookie header if not already parsed
  const cookieHeader = headers.get('Cookie');
  if (cookieHeader) {
    const token = parseCookie(cookieHeader, AUTH_COOKIE_NAME);
    if (token) {
      return token;
    }
  }
  
  return null;
}

/**
 * Parse a specific cookie value from Cookie header
 */
export function parseCookie(cookieHeader: string, name: string): string | null {
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [cookieName, cookieValue] = cookie.trim().split('=');
    if (cookieName === name) {
      return decodeURIComponent(cookieValue);
    }
  }
  return null;
}

/**
 * Parse all cookies from Cookie header
 */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  const parts = cookieHeader.split(';');
  
  for (const part of parts) {
    const [name, value] = part.trim().split('=');
    if (name && value !== undefined) {
      cookies[name] = decodeURIComponent(value);
    }
  }
  
  return cookies;
}

// =============================================================================
// Admin Auth
// =============================================================================

/**
 * Validate admin secret header
 */
export function validateAdminSecret(
  headers: Headers,
  expectedSecret: string | undefined
): boolean {
  if (!expectedSecret) {
    return false;
  }
  
  const providedSecret = headers.get(ADMIN_SECRET_HEADER);
  return providedSecret === expectedSecret;
}

/**
 * Check if user is an admin based on user ID list
 */
export function isAdminUser(
  userId: string,
  adminUserIds?: string
): boolean {
  if (!adminUserIds) {
    return false;
  }
  
  const admins = adminUserIds.split(',').map(id => id.trim());
  return admins.includes(userId);
}

// =============================================================================
// User Creation
// =============================================================================

/**
 * Create an authenticated user from JWT payload
 */
export function createAuthenticatedUser(
  payload: SupabaseJwtPayload
): AuthenticatedUser {
  const userId = payload.sub;
  const tier = USER_TIER_MAP[userId] || DEFAULT_USER_TIER;
  
  return {
    id: userId,
    email: payload.email,
    sandboxName: `openclaw-${userId}`,
    r2Prefix: `users/${userId}`,
    tier,
  };
}

// =============================================================================
// Tiered Routing
// =============================================================================

/**
 * Get the tier for a user
 */
export function getUserTier(userId: string): 1 | 2 | 3 {
  return USER_TIER_MAP[userId] || DEFAULT_USER_TIER;
}

/**
 * Check if user should use tiered routing
 */
export function shouldUseTieredRouting(
  userId: string,
  tieredRoutingEnabled: boolean | string | undefined
): boolean {
  if (!tieredRoutingEnabled || tieredRoutingEnabled === 'false') {
    return false;
  }
  
  // Currently only specific users are migrated
  return userId in USER_TIER_MAP;
}

// =============================================================================
// Gateway Token
// =============================================================================

/**
 * Derive a per-user gateway token from master token
 * Uses HMAC-SHA256 for deterministic derivation
 */
export async function deriveUserGatewayToken(
  masterToken: string,
  userId: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(masterToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(userId)
  );
  
  // Convert to base64url
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Get the gateway master token from environment
 * Prefers MOLTBOT_GATEWAY_MASTER_TOKEN, falls back to legacy MOLTBOT_GATEWAY_TOKEN
 */
export function getGatewayMasterToken(env: { 
  MOLTBOT_GATEWAY_MASTER_TOKEN?: string;
  MOLTBOT_GATEWAY_TOKEN?: string;
}): string | undefined {
  return env.MOLTBOT_GATEWAY_MASTER_TOKEN || env.MOLTBOT_GATEWAY_TOKEN;
}

// =============================================================================
// Legacy Cloudflare Access Auth (deprecated)
// =============================================================================

/**
 * Verify Cloudflare Access JWT (legacy)
 * @deprecated Use Supabase auth instead
 */
export async function verifyAccessToken(
  token: string,
  teamDomain: string,
  aud: string
): Promise<AccessUser> {
  const jwksUrl = new URL('/cdn-cgi/access/certs', `https://${teamDomain}`);
  const JWKS = createRemoteJWKSet(jwksUrl);
  
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://${teamDomain}`,
    audience: aud,
  });
  
  return {
    email: payload.email as string,
    name: payload.name as string | undefined,
  };
}
