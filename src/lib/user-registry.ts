/**
 * Central user registry - single source of truth for all user IDs and names.
 *
 * Hardcoded FALLBACK_REGISTRY is used for sync code paths that can't await.
 * D1-backed async functions are the primary data source when a db handle is available.
 */

export interface UserEntry {
  id: string;
  name: string;
  fullName: string;
  agentName: string;
  telegramHandle?: string;
  status: 'active' | 'deleted';
}

/** D1 row shape (column names use snake_case) */
interface UserRow {
  id: string;
  name: string;
  full_name: string;
  agent_name: string;
  telegram_handle: string | null;
  status: string;
  tier: number;
}

const FALLBACK_REGISTRY: UserEntry[] = [
  { id: '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b', name: 'jack',          fullName: 'Jack Lippold',    agentName: 'sable',      telegramHandle: 'captainoftheclawd_bot', status: 'active' },
  { id: '81bf6a68-28fe-48ef-b257-f9ad013e6298', name: 'josh',          fullName: 'Joshua Carey',    agentName: 'kestrel',    telegramHandle: 'davy_jones_hunts_bot', status: 'active' },
  { id: 'fe56406b-a723-43cf-9f19-ba2ffcb135b0', name: 'miles',         fullName: 'Miles',           agentName: 'miles',      status: 'active' },
  { id: '38b1ec2b-7a70-4834-a48d-162b8902b0fd', name: 'kyla',          fullName: 'Kyla Warder',     agentName: 'echo',       status: 'active' },
  { id: '0f1195c1-6b57-4254-9871-6ef3b7fa360c', name: 'rhys',          fullName: 'Rhys Meredith',   agentName: 'claw',       status: 'active' },
  { id: 'e29fd082-6811-4e29-893e-64699c49e1f0', name: 'ben_lippold',   fullName: 'Ben Lippold',     agentName: 'echo7',      status: 'active' },
  { id: '6d575ef4-7ac8-4a17-b732-e0e690986e58', name: 'david_geddes',  fullName: 'David Geddes',    agentName: 'wisp',       status: 'active' },
  { id: 'aef3677b-afdf-4a7e-bbeb-c596f0d94d29', name: 'adnan',         fullName: 'Adnan Khan',      agentName: 'adnan',      status: 'active' },
  { id: '5bb7d208-2baf-4c95-8aec-f28e016acedb', name: 'david_lippold', fullName: 'David Lippold',   agentName: 'david',      status: 'active' },
  { id: 'f1647b02-c311-49c3-9c72-48b8fc5da350', name: 'joe_james',     fullName: 'Joe James',       agentName: 'joe',        status: 'active' },
  { id: '679f60a6-2e00-403b-86f1-f4696149294f', name: 'james_old',     fullName: 'Joshua Carey (old container)', agentName: 'old', status: 'deleted' },
];

// =============================================================================
// D1-backed async functions (primary source when db is available)
// =============================================================================

function rowToEntry(row: UserRow): UserEntry {
  return {
    id: row.id,
    name: row.name,
    fullName: row.full_name,
    agentName: row.agent_name,
    telegramHandle: row.telegram_handle ?? undefined,
    status: row.status as 'active' | 'deleted',
  };
}

/** Get all active user IDs from D1 */
export async function getActiveUserIdsFromDB(db: D1Database): Promise<string[]> {
  try {
    const { results } = await db.prepare('SELECT id FROM users WHERE status = ?').bind('active').all<{ id: string }>();
    return results.map(r => r.id);
  } catch (e) {
    console.warn('[USER-REGISTRY] D1 query failed, falling back to hardcoded:', e);
    return getActiveUserIds();
  }
}

/** Get a single user from D1 */
export async function getUserFromDB(db: D1Database, userId: string): Promise<UserEntry | undefined> {
  try {
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
    return row ? rowToEntry(row) : undefined;
  } catch (e) {
    console.warn('[USER-REGISTRY] D1 user lookup failed, falling back:', e);
    return FALLBACK_REGISTRY.find(u => u.id === userId);
  }
}

/** Get full user registry from D1 */
export async function getUserRegistryFromDB(db: D1Database): Promise<UserEntry[]> {
  try {
    const { results } = await db.prepare('SELECT * FROM users ORDER BY name').all<UserRow>();
    return results.map(rowToEntry);
  } catch (e) {
    console.warn('[USER-REGISTRY] D1 registry query failed, falling back:', e);
    return [...FALLBACK_REGISTRY];
  }
}

// =============================================================================
// Sync fallback functions (for code paths that can't await)
// =============================================================================

/** All active user IDs (sync fallback) */
export function getActiveUserIds(): string[] {
  return FALLBACK_REGISTRY.filter(u => u.status === 'active').map(u => u.id);
}

/** All user IDs including deleted */
export function getAllUserIds(): string[] {
  return FALLBACK_REGISTRY.map(u => u.id);
}

/** Map of userId -> short name */
export function getUserNames(): Record<string, string> {
  return Object.fromEntries(FALLBACK_REGISTRY.map(u => [u.id, u.name]));
}

/** Get display name for a userId */
export function getUserName(userId: string): string | undefined {
  return FALLBACK_REGISTRY.find(u => u.id === userId)?.name;
}

/** Get first name for a userId */
export function getUserFirstName(userId: string): string | undefined {
  const entry = FALLBACK_REGISTRY.find(u => u.id === userId);
  if (!entry) return undefined;
  return entry.fullName.split(' ')[0].toLowerCase();
}

/** Get agent name for a userId */
export function getUserAgentName(userId: string): string | undefined {
  return FALLBACK_REGISTRY.find(u => u.id === userId)?.agentName;
}

/** Get telegram handle for a userId (no fallback - returns undefined if not set) */
export function getUserTelegramHandle(userId: string): string | undefined {
  return FALLBACK_REGISTRY.find(u => u.id === userId)?.telegramHandle;
}

/** Get full registry (sync fallback for admin API) */
export function getUserRegistry(): UserEntry[] {
  return [...FALLBACK_REGISTRY];
}

/** Look up a user by short name */
export function findUserByName(name: string): UserEntry | undefined {
  const lower = name.toLowerCase();
  return FALLBACK_REGISTRY.find(u =>
    u.name.toLowerCase() === lower ||
    u.fullName.toLowerCase() === lower ||
    u.fullName.toLowerCase().includes(lower)
  );
}

/**
 * Generate a human-readable sandbox name for a user
 * Format: {firstname}-{telegramhandle}-tier{tier}-ss{shortid}
 * Falls back to 'unknown' if no telegram handle configured
 * Example: jack-captainoftheclawd_bot-tier3-ss760b
 */
export function getSandboxName(userId: string, tier?: number): string {
  const firstName = getUserFirstName(userId) || 'unknown';
  const handle = getUserTelegramHandle(userId) || 'unknown';
  const shortId = userId.slice(-4);
  const tierSuffix = tier ? `tier${tier}` : 'tier1';

  return `${firstName}-${handle}-${tierSuffix}-ss${shortId}`;
}
