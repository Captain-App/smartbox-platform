/**
 * Supabase JWT verification stubs
 *
 * Real implementation is in moltworker-platform.
 * The container runtime relies on the platform for authentication.
 */

import * as jose from 'jose';

/**
 * JWT payload structure from Supabase
 */
export interface SupabaseJWTPayload {
  sub: string;
  email?: string;
  aud: string;
  role?: string;
  exp: number;
  iat: number;
  iss?: string;
}

/**
 * Verify a Supabase JWT token
 * Used by relay and public routes for token validation
 */
export async function verifySupabaseJWT(
  token: string,
  secret: string,
  expectedIssuer?: string
): Promise<SupabaseJWTPayload | null> {
  try {
    const secretKey = new TextEncoder().encode(secret);
    const options: jose.JWTVerifyOptions = {
      algorithms: ['HS256'],
    };
    if (expectedIssuer) {
      options.issuer = expectedIssuer;
    }
    const { payload } = await jose.jwtVerify(token, secretKey, options);
    return payload as SupabaseJWTPayload;
  } catch (error) {
    console.error('[JWT] Verification failed:', error);
    return null;
  }
}

/**
 * Extract user ID from JWT payload
 */
export function getUserIdFromPayload(payload: SupabaseJWTPayload): string {
  return payload.sub;
}
