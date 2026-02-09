/**
 * Daily/rolling backup system for user data.
 * Creates point-in-time snapshots by copying backup.tar.gz in R2.
 *
 * With the tar-based backup system, each user has a single
 * backup.tar.gz in R2. Rolling/daily backups just copy that
 * file to a timestamped location — one R2 GET + one R2 PUT per user.
 */

import type { MoltbotEnv } from '../types';

const BACKUP_RETENTION_DAYS = 7;
const BACKUP_MARKER_KEY = 'backups/.last-rolling-backup';
const ROLLING_BACKUP_ENABLED = true;

interface BackupResult {
  success: boolean;
  date: string;
  usersBackedUp: number;
  filesBackedUp: number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Get today's date in YYYY-MM-DD format (UTC)
 */
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get current timestamp in YYYY-MM-DD-HH-MM format (UTC)
 */
function getCurrentTimestamp(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(Math.floor(now.getUTCMinutes() / 20) * 20).padStart(2, '0'); // Round to 20-min slot
  return `${date}-${hours}-${minutes}`;
}

/**
 * Check if rolling backup has run in the last 20 minutes
 */
async function hasRollingBackupRunRecently(bucket: R2Bucket): Promise<boolean> {
  try {
    const marker = await bucket.get(BACKUP_MARKER_KEY);
    if (!marker) return false;

    const lastBackup = await marker.text();
    const currentSlot = getCurrentTimestamp();

    return lastBackup.trim() === currentSlot;
  } catch {
    return false;
  }
}

/**
 * Check if daily backup has already run today
 */
async function hasBackupRunToday(bucket: R2Bucket): Promise<boolean> {
  try {
    const marker = await bucket.get(BACKUP_MARKER_KEY);
    if (!marker) return false;

    const lastBackup = await marker.text();
    return lastBackup.trim() === getTodayDate();
  } catch {
    return false;
  }
}

/**
 * Copy a single user's backup.tar.gz to a timestamped backup location.
 * Returns true if the user had a backup to copy.
 */
async function copyUserBackup(
  bucket: R2Bucket,
  userId: string,
  timestamp: string
): Promise<boolean> {
  const srcKey = `users/${userId}/backup.tar.gz`;
  const dstKey = `backups/${timestamp}/users/${userId}/backup.tar.gz`;

  try {
    const obj = await bucket.get(srcKey);
    if (!obj) return false;

    const data = await obj.arrayBuffer();
    await bucket.put(dstKey, data, {
      customMetadata: {
        ...obj.customMetadata,
        backupTimestamp: timestamp,
      },
    });
    return true;
  } catch (err) {
    console.error(`[backup] Failed to copy backup for ${userId.slice(0, 8)}: ${err}`);
    return false;
  }
}

/**
 * Get list of registered user IDs from R2
 */
async function getRegisteredUserIds(bucket: R2Bucket): Promise<string[]> {
  const userIds: string[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix: 'users/', delimiter: '/', cursor });
    for (const prefix of listed.delimitedPrefixes || []) {
      // Extract userId from "users/{userId}/"
      const match = prefix.match(/^users\/([^/]+)\/$/);
      if (match) {
        userIds.push(match[1]);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return userIds;
}

/**
 * Clean up old backups beyond retention period
 */
async function cleanupOldBackups(bucket: R2Bucket): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - BACKUP_RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().split('T')[0].replace(/-/g, '');

  let deleted = 0;

  try {
    const listed = await bucket.list({ prefix: 'backups/', delimiter: '/' });

    for (const prefix of listed.delimitedPrefixes || []) {
      // Match both daily "backups/2026-01-25/" and rolling "backups/2026-02-03-22-00/" timestamps
      const match = prefix.match(/^backups\/(\d{4}-\d{2}-\d{2}(?:-\d{2}-\d{2})?)\/$/);
      if (match) {
        const datePart = match[1].replace(/-/g, '').substring(0, 8);
        if (datePart < cutoffStr) {
          console.log(`[backup] Cleaning up old backup: ${prefix}`);

          let cursor: string | undefined;
          do {
            const objects = await bucket.list({ prefix, cursor });
            for (const obj of objects.objects) {
              await bucket.delete(obj.key);
              deleted++;
            }
            cursor = objects.truncated ? objects.cursor : undefined;
          } while (cursor);
        }
      }
    }
  } catch (err) {
    console.error(`[backup] Cleanup error: ${err}`);
  }

  return deleted;
}

/**
 * Create a rolling 20-minute backup of all user data.
 * Copies each user's backup.tar.gz to backups/{timestamp}/users/{userId}/backup.tar.gz
 */
export async function createRollingBackup(env: MoltbotEnv): Promise<BackupResult> {
  if (!ROLLING_BACKUP_ENABLED) {
    return { success: true, date: getCurrentTimestamp(), usersBackedUp: 0, filesBackedUp: 0, skipped: true, skipReason: 'Rolling backup disabled' };
  }

  const timestamp = getCurrentTimestamp();
  const bucket = env.MOLTBOT_BUCKET;

  if (!bucket) {
    return { success: false, date: timestamp, usersBackedUp: 0, filesBackedUp: 0, error: 'R2 bucket not configured' };
  }

  // Check if already backed up in this 20-minute slot
  if (await hasRollingBackupRunRecently(bucket)) {
    console.log(`[backup] Rolling backup already completed for ${timestamp}`);
    return { success: true, date: timestamp, usersBackedUp: 0, filesBackedUp: 0, skipped: true, skipReason: 'Already backed up in this slot' };
  }

  console.log(`[backup] Starting rolling 20-min backup for ${timestamp}`);

  let usersBackedUp = 0;
  let filesBackedUp = 0;

  try {
    const userIds = await getRegisteredUserIds(bucket);

    for (const userId of userIds) {
      if (await copyUserBackup(bucket, userId, timestamp)) {
        usersBackedUp++;
        filesBackedUp++; // One file per user (backup.tar.gz)
      }
    }

    // Update the backup marker
    await bucket.put(BACKUP_MARKER_KEY, timestamp);

    // Cleanup old backups
    const deleted = await cleanupOldBackups(bucket);
    if (deleted > 0) {
      console.log(`[backup] Cleaned up ${deleted} old rolling backup files`);
    }

    console.log(`[backup] Rolling backup complete: ${usersBackedUp} users at ${timestamp}`);

    return { success: true, date: timestamp, usersBackedUp, filesBackedUp };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[backup] Rolling backup failed: ${error}`);
    return { success: false, date: timestamp, usersBackedUp, filesBackedUp, error };
  }
}

/**
 * Create a daily backup of all user data.
 * Copies each user's backup.tar.gz to backups/{date}/users/{userId}/backup.tar.gz
 */
export async function createDailyBackup(env: MoltbotEnv): Promise<BackupResult> {
  const today = getTodayDate();
  const bucket = env.MOLTBOT_BUCKET;

  if (!bucket) {
    return { success: false, date: today, usersBackedUp: 0, filesBackedUp: 0, error: 'R2 bucket not configured' };
  }

  // Check if already backed up today
  if (await hasBackupRunToday(bucket)) {
    console.log(`[backup] Daily backup already completed for ${today}`);
    return { success: true, date: today, usersBackedUp: 0, filesBackedUp: 0, skipped: true, skipReason: 'Already backed up today' };
  }

  console.log(`[backup] Starting daily backup for ${today}`);

  let usersBackedUp = 0;
  let filesBackedUp = 0;

  try {
    const userIds = await getRegisteredUserIds(bucket);

    for (const userId of userIds) {
      if (await copyUserBackup(bucket, userId, today)) {
        usersBackedUp++;
        filesBackedUp++;
      }
    }

    // Update the backup marker
    await bucket.put(BACKUP_MARKER_KEY, today);

    // Cleanup old backups
    const deleted = await cleanupOldBackups(bucket);
    if (deleted > 0) {
      console.log(`[backup] Cleaned up ${deleted} old backup files`);
    }

    console.log(`[backup] Daily backup complete: ${usersBackedUp} users`);

    return { success: true, date: today, usersBackedUp, filesBackedUp };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[backup] Daily backup failed: ${error}`);
    return { success: false, date: today, usersBackedUp, filesBackedUp, error };
  }
}

/**
 * List available backup dates
 */
export async function listBackupDates(bucket: R2Bucket): Promise<string[]> {
  const dates: string[] = [];

  try {
    const listed = await bucket.list({ prefix: 'backups/', delimiter: '/' });

    for (const prefix of listed.delimitedPrefixes || []) {
      const match = prefix.match(/^backups\/(\d{4}-\d{2}-\d{2}(?:-\d{2}-\d{2})?)\/$/);
      if (match) {
        dates.push(match[1]);
      }
    }
  } catch (err) {
    console.error(`[backup] Failed to list backup dates: ${err}`);
  }

  return dates.sort().reverse(); // Most recent first
}

/**
 * Restore a user from a specific backup date.
 * Copies backup.tar.gz from the backup location back to the user's live location.
 */
export async function restoreUserFromBackup(
  bucket: R2Bucket,
  userId: string,
  backupDate: string
): Promise<{ success: boolean; filesRestored: number; error?: string }> {
  const srcKey = `backups/${backupDate}/users/${userId}/backup.tar.gz`;
  const dstKey = `users/${userId}/backup.tar.gz`;

  try {
    const obj = await bucket.get(srcKey);
    if (!obj) {
      return { success: false, filesRestored: 0, error: `No backup found for ${userId} at ${backupDate}` };
    }

    const data = await obj.arrayBuffer();
    await bucket.put(dstKey, data, {
      customMetadata: {
        ...obj.customMetadata,
        restoredFrom: backupDate,
        restoredAt: new Date().toISOString(),
      },
    });

    console.log(`[backup] Restored backup.tar.gz for user ${userId} from ${backupDate}`);
    return { success: true, filesRestored: 1 };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, filesRestored: 0, error };
  }
}
