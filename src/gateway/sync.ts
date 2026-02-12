import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { backupToR2 } from './tar-backup';
import { isBackupFeatureEnabled } from '../config/backup';

/**
 * Result of a sync operation with detailed status
 */
export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
  /** Unique sync ID for verification */
  syncId?: string;
  /** Number of files synced */
  fileCount?: number;
  /** Duration of sync in milliseconds */
  durationMs?: number;
  /** Rsync exit code (kept for interface compat, always 0 for tar) */
  rsyncExitCode?: number;
}

/**
 * Options for syncing to R2
 */
export interface SyncOptions {
  /** User's R2 prefix for per-user storage (e.g., 'users/{userId}') */
  r2Prefix?: string;
  /** Sync mode: 'blocking' waits for completion, 'async' returns immediately */
  mode?: 'blocking' | 'async';
  /** Timeout for sync operation (ms) */
  timeoutMs?: number;
  /** Force sync even if one was recently completed */
  emergency?: boolean;
  /** Only sync critical files */
  criticalOnly?: boolean;
}

/**
 * In-memory lock to prevent concurrent syncs for the same user.
 * Key is r2Prefix, value is timestamp when sync started.
 * Must be per-instance (not persisted) — it's a coordination lock.
 */
const syncLocks: Map<string, number> = new Map();
const SYNC_LOCK_TIMEOUT_MS = 60_000; // 60 seconds max sync duration

/**
 * Get recent sync results for a user from D1.
 * Falls back to empty array if D1 is unavailable.
 */
export async function getRecentSyncResultsFromDB(db: D1Database, userId: string): Promise<SyncResult[]> {
  try {
    const { results } = await db.prepare(
      `SELECT success, sync_id, duration_ms, file_count, error, created_at
       FROM sync_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
    ).bind(userId).all<{
      success: number;
      sync_id: string | null;
      duration_ms: number | null;
      file_count: number | null;
      error: string | null;
      created_at: string;
    }>();
    return results.map(r => ({
      success: r.success === 1,
      syncId: r.sync_id ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      fileCount: r.file_count ?? undefined,
      error: r.error ?? undefined,
      lastSync: r.success === 1 ? r.created_at : undefined,
    }));
  } catch (e) {
    console.warn('[SYNC] D1 read failed:', e);
    return [];
  }
}

/** In-memory fallback for recent sync results (for code without D1) */
const recentSyncResults: Map<string, SyncResult[]> = new Map();
const MAX_RECENT_RESULTS = 10;

/**
 * Get recent sync results for a user (sync fallback — in-memory only)
 */
export function getRecentSyncResults(r2Prefix?: string): SyncResult[] {
  const key = r2Prefix || 'default';
  return recentSyncResults.get(key) || [];
}

/**
 * Get count of consecutive sync failures from D1, with in-memory fallback
 */
export async function getConsecutiveSyncFailuresFromDB(db: D1Database, userId: string): Promise<number> {
  try {
    const { results } = await db.prepare(
      `SELECT success FROM sync_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
    ).bind(userId).all<{ success: number }>();
    let count = 0;
    for (const r of results) {
      if (r.success === 0) count++;
      else break;
    }
    return count;
  } catch (e) {
    console.warn('[SYNC] D1 failure count failed:', e);
    return getConsecutiveSyncFailures();
  }
}

/** Sync fallback (in-memory) */
export function getConsecutiveSyncFailures(r2Prefix?: string): number {
  const results = getRecentSyncResults(r2Prefix);
  let count = 0;
  for (const result of results) {
    if (!result.success) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Store a sync result — writes to both in-memory and D1
 */
async function storeSyncResult(r2Prefix: string | undefined, result: SyncResult, db?: D1Database): Promise<void> {
  // In-memory
  const key = r2Prefix || 'default';
  const results = recentSyncResults.get(key) || [];
  results.unshift(result);
  if (results.length > MAX_RECENT_RESULTS) {
    results.pop();
  }
  recentSyncResults.set(key, results);

  // D1
  if (db && r2Prefix) {
    // Extract userId from r2Prefix (format: "users/{userId}")
    const userId = r2Prefix.replace('users/', '');
    try {
      await db.prepare(
        `INSERT INTO sync_history (user_id, success, sync_id, duration_ms, file_count, error)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        userId,
        result.success ? 1 : 0,
        result.syncId ?? null,
        result.durationMs ?? null,
        result.fileCount ?? null,
        result.error ?? null,
      ).run();
    } catch (e) {
      console.warn('[SYNC] D1 write failed:', e);
    }
  }
}

/**
 * Sync moltbot data from container to R2 for persistence.
 *
 * Uses atomic tar.gz backup: tar the whole /root/ tree, transfer
 * as a single blob to R2. ~4s total vs 45s+ for the old rsync+s3fs.
 */
export async function syncToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const startTime = Date.now();
  const lockKey = options.r2Prefix || 'default';

  // Check if another sync is already in progress for this user
  const existingLock = syncLocks.get(lockKey);
  if (existingLock) {
    const lockAge = Date.now() - existingLock;
    if (lockAge < SYNC_LOCK_TIMEOUT_MS) {
      const result: SyncResult = {
        success: false,
        error: 'Sync already in progress',
        details: `Another sync started ${Math.round(lockAge / 1000)}s ago. Skipping to prevent race condition.`,
        durationMs: Date.now() - startTime,
      };
      await storeSyncResult(options.r2Prefix, result, env.PLATFORM_DB);
      return result;
    }
    // Lock is stale, clear it
    syncLocks.delete(lockKey);
  }

  // Acquire lock
  syncLocks.set(lockKey, Date.now());

  try {
    const r2Prefix = options.r2Prefix || 'default';
    const tarResult = await backupToR2(sandbox, env, r2Prefix);

    const result: SyncResult = {
      success: tarResult.success,
      error: tarResult.error,
      syncId: tarResult.syncId,
      durationMs: tarResult.durationMs,
      lastSync: tarResult.success ? new Date().toISOString() : undefined,
      rsyncExitCode: tarResult.success ? 0 : undefined,
    };

    await storeSyncResult(options.r2Prefix, result, env.PLATFORM_DB);
    return result;
  } finally {
    // Release lock
    syncLocks.delete(lockKey);
  }
}

/**
 * Priority sync for critical files only.
 *
 * With tar-based backup, this is a no-op since tar is already atomic
 * and captures everything in one shot. Kept for interface compatibility.
 */
export async function syncCriticalFilesToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: SyncOptions = {}
): Promise<SyncResult> {
  // Tar backup is atomic — no need for a separate critical-files-only sync.
  // Just delegate to the full backup.
  if (!isBackupFeatureEnabled('CRITICAL_FILE_PRIORITY')) {
    return {
      success: true,
      syncId: 'critical-noop',
      durationMs: 0,
      details: 'CRITICAL_FILE_PRIORITY feature flag is disabled',
    };
  }

  return syncToR2(sandbox, env, options);
}

/**
 * Pre-shutdown sync - ensures all data is synced before container restart.
 *
 * With tar-based backup this is simply one atomic backup. No need for
 * two-stage critical-then-full since tar captures everything at once.
 */
export async function syncBeforeShutdown(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: SyncOptions = {}
): Promise<SyncResult> {
  if (!isBackupFeatureEnabled('SHUTDOWN_SYNC')) {
    console.log('[shutdown] SHUTDOWN_SYNC feature flag is disabled, skipping pre-shutdown sync');
    return {
      success: true,
      syncId: 'shutdown-skipped',
      durationMs: 0,
      details: 'SHUTDOWN_SYNC feature flag is disabled',
    };
  }

  console.log(`[shutdown] Starting pre-shutdown tar backup for ${options.r2Prefix || 'default'}`);
  const result = await syncToR2(sandbox, env, options);

  if (result.success) {
    console.log(`[shutdown] Pre-shutdown backup completed in ${result.durationMs}ms`);
  } else {
    console.error(`[shutdown] Pre-shutdown backup failed: ${result.error}`);
  }

  return {
    ...result,
    syncId: `shutdown-${result.syncId}`,
  };
}
