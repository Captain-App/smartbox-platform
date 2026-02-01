/**
 * Daily backup system for user data
 * Creates point-in-time snapshots of all user data in R2
 */

import type { MoltbotEnv } from '../types';

const BACKUP_RETENTION_DAYS = 7;
const BACKUP_MARKER_KEY = 'backups/.last-daily-backup';

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
 * Copy a single object to backup location
 */
async function copyObject(
  bucket: R2Bucket,
  sourceKey: string,
  destKey: string
): Promise<boolean> {
  try {
    const obj = await bucket.get(sourceKey);
    if (!obj) return false;
    
    const data = await obj.arrayBuffer();
    await bucket.put(destKey, data, {
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    });
    return true;
  } catch (err) {
    console.error(`[backup] Failed to copy ${sourceKey}: ${err}`);
    return false;
  }
}

/**
 * Delete old backups beyond retention period
 */
async function cleanupOldBackups(bucket: R2Bucket): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - BACKUP_RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];
  
  let deleted = 0;
  
  try {
    // List all backup dates
    const listed = await bucket.list({ prefix: 'backups/', delimiter: '/' });
    
    for (const prefix of listed.delimitedPrefixes || []) {
      // Extract date from prefix like "backups/2026-01-25/"
      const match = prefix.match(/^backups\/(\d{4}-\d{2}-\d{2})\/$/);
      if (match && match[1] < cutoffStr) {
        console.log(`[backup] Cleaning up old backup: ${prefix}`);
        
        // List and delete all objects under this date
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
  } catch (err) {
    console.error(`[backup] Cleanup error: ${err}`);
  }
  
  return deleted;
}

/**
 * Create a daily backup of all user data
 * Copies users/* to backups/{date}/users/*
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
  const usersSeen = new Set<string>();
  
  try {
    // List all user data
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: 'users/', cursor });
      
      for (const obj of listed.objects) {
        // Skip if it's just a directory marker
        if (obj.key.endsWith('/') && obj.size === 0) continue;
        
        // Track unique users
        const userMatch = obj.key.match(/^users\/([^/]+)\//);
        if (userMatch) {
          usersSeen.add(userMatch[1]);
        }
        
        // Copy to backup location
        const backupKey = `backups/${today}/${obj.key}`;
        if (await copyObject(bucket, obj.key, backupKey)) {
          filesBackedUp++;
        }
      }
      
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    
    usersBackedUp = usersSeen.size;
    
    // Update the backup marker
    await bucket.put(BACKUP_MARKER_KEY, today);
    
    // Cleanup old backups
    const deleted = await cleanupOldBackups(bucket);
    console.log(`[backup] Cleaned up ${deleted} old backup files`);
    
    console.log(`[backup] Daily backup complete: ${usersBackedUp} users, ${filesBackedUp} files`);
    
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
      const match = prefix.match(/^backups\/(\d{4}-\d{2}-\d{2})\/$/);
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
 * Restore a user from a specific backup date
 */
export async function restoreUserFromBackup(
  bucket: R2Bucket,
  userId: string,
  backupDate: string
): Promise<{ success: boolean; filesRestored: number; error?: string }> {
  const sourcePrefix = `backups/${backupDate}/users/${userId}/`;
  const destPrefix = `users/${userId}/`;
  
  let filesRestored = 0;
  
  try {
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix: sourcePrefix, cursor });
      
      for (const obj of listed.objects) {
        const destKey = obj.key.replace(sourcePrefix, destPrefix);
        if (await copyObject(bucket, obj.key, destKey)) {
          filesRestored++;
        }
      }
      
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    
    console.log(`[backup] Restored ${filesRestored} files for user ${userId} from ${backupDate}`);
    return { success: true, filesRestored };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, filesRestored, error };
  }
}
