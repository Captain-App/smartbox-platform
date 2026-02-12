/**
 * Per-user instance type configuration
 * Maps user IDs to sandbox tier (standard-1, standard-2, standard-3)
 *
 * Primary source: D1 `users.tier` column
 * Fallback: compile-time USER_TIER_MAP
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { getSandboxName as getUserSandboxName } from '../lib/user-registry';

/**
 * Compile-time fallback tier map (used when D1 is unavailable)
 */
const USER_TIER_MAP: Record<string, 1 | 2 | 3> = {
  // Jack - heavy usage, founder (standard-3)
  '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b': 3,
  // Josh - active user (standard-2)
  '81bf6a68-28fe-48ef-b257-f9ad013e6298': 2,
  // Miles - power user, AI learning workspace (standard-2)
  'fe56406b-a723-43cf-9f19-ba2ffcb135b0': 2,
  // David L - needs more RAM (standard-3)
  '5bb7d208-2baf-4c95-8aec-f28e016acedb': 3,
  // Remaining users on standard-1
  '38b1ec2b-7a70-4834-a48d-162b8902b0fd': 1, // Kyla
  'e29fd082-6811-4e29-893e-64699c49e1f0': 1, // Ben
  '6d575ef4-7ac8-4a17-b732-e0e690986e58': 1, // David G
  'aef3677b-afdf-4a7e-bbeb-c596f0d94d29': 1, // Adnan
  'f1647b02-c311-49c3-9c72-48b8fc5da350': 1, // Joe
};

/**
 * Get the appropriate sandbox binding for a user based on their tier.
 * Queries D1 first when db is provided, falls back to hardcoded map.
 */
export function getSandboxForUser(env: MoltbotEnv, userId: string, db?: D1Database): MoltbotEnv['Small'] {
  const tier = USER_TIER_MAP[userId] || 1;

  console.log(`[TIERS] Using smartbox binding for ${userId}: tier-${tier}`);

  switch (tier) {
    case 3:
      return env.Large;
    case 2:
      return env.Medium;
    case 1:
    default:
      return env.Small;
  }
}

/**
 * Get tier for a user from D1 (async), with compile-time fallback.
 */
export async function getTierForUserFromDB(db: D1Database, userId: string): Promise<number> {
  try {
    const row = await db.prepare('SELECT tier FROM users WHERE id = ?').bind(userId).first<{ tier: number }>();
    return row?.tier ?? USER_TIER_MAP[userId] ?? 1;
  } catch (e) {
    console.warn('[TIERS] D1 tier lookup failed, falling back:', e);
    return USER_TIER_MAP[userId] ?? 1;
  }
}

/**
 * Get the tier number for a user (sync fallback, for logging)
 */
export function getTierForUser(userId: string): number {
  return USER_TIER_MAP[userId] || 1;
}

/**
 * Get instance type name for logging/metrics
 */
export function getInstanceTypeName(userId: string): string {
  const tier = USER_TIER_MAP[userId] || 1;
  return `standard-${tier}`;
}

/**
 * Get all tier assignments (for admin/debug)
 */
export function getAllTierAssignments(): Record<string, number> {
  return { ...USER_TIER_MAP };
}

/**
 * Get human-readable sandbox name for a user
 * Format: {firstname}-{telegramhandle}-{tier}-ss{shortid}
 */
export function getSandboxName(userId: string): string {
  const tier = USER_TIER_MAP[userId] || 1;
  return getUserSandboxName(userId, tier);
}
