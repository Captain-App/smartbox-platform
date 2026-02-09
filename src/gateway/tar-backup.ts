/**
 * Tar-based backup system for user data.
 *
 * Replaces rsync+s3fs with atomic tar.gz snapshots transferred
 * directly between container and R2 via the Sandbox/R2 APIs.
 * No FUSE mounts, no per-file HTTP requests, no stale mounts.
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { waitForProcess } from './utils';

/** Excludes for tar backup — same as the old rsync excludes */
const TAR_EXCLUDES = [
  'node_modules',
  '.git',
  '.npm',
  '.cache',
  '.openclaw-templates',
  '*.lock',
  '*.log',
  '*.tmp',
].map(e => `--exclude='${e}'`).join(' ');

const BACKUP_TIMEOUT_MS = 15_000;
const RESTORE_TIMEOUT_MS = 15_000;
const BACKUP_KEY = 'backup.tar.gz';
const ARCHIVE_KEY = 'backup-archive.tar.gz';
const BACKUP_COOLDOWN_SECS = 300; // 5 minutes after restore before allowing backup
const RESTORE_MARKER = '/root/.openclaw/.restore-time';

export interface TarBackupResult {
  success: boolean;
  error?: string;
  durationMs: number;
  sizeBytes?: number;
  syncId?: string;
}

export interface TarRestoreResult {
  success: boolean;
  error?: string;
  durationMs: number;
  format: 'tar' | 'legacy' | 'fresh';
}

/**
 * Generate a unique sync ID for verification
 */
function generateSyncId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `tar-${timestamp}-${random}`;
}

/**
 * Backup container's /root/ to R2 as a single tar.gz file.
 *
 * Steps:
 * 1. Validate /root/.openclaw/openclaw.json exists
 * 2. tar czf /tmp/backup.tar.gz /root/ (in container)
 * 3. Read tar.gz from container via sandbox.readFile()
 * 4. PUT to R2 as users/{userId}/backup.tar.gz
 * 5. Write .last-sync marker to R2
 * 6. Cleanup temp file in container
 */
export async function backupToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  r2Prefix: string
): Promise<TarBackupResult> {
  const startTime = Date.now();
  const syncId = generateSyncId();

  // Cooldown: don't backup too soon after restore — container may still be initializing
  try {
    const cooldownProc = await sandbox.startProcess(
      `test -f ${RESTORE_MARKER} && ` +
      `age=$(($(date +%s) - $(cat ${RESTORE_MARKER}))) && ` +
      `echo "RESTORE_AGE:$age"`
    );
    await waitForProcess(cooldownProc, 3000);
    const cooldownLogs = await cooldownProc.getLogs();
    const ageMatch = (cooldownLogs.stdout || '').match(/RESTORE_AGE:(\d+)/);
    if (ageMatch) {
      const ageSecs = parseInt(ageMatch[1], 10);
      if (ageSecs < BACKUP_COOLDOWN_SECS) {
        const remaining = BACKUP_COOLDOWN_SECS - ageSecs;
        console.log(`[tar-backup] Skipping backup for ${r2Prefix} — cooldown active (${remaining}s remaining, restored ${ageSecs}s ago)`);
        return {
          success: false,
          error: `Backup cooldown: ${remaining}s remaining after restore`,
          durationMs: Date.now() - startTime,
          syncId,
        };
      }
    }
  } catch {
    // Marker doesn't exist or failed to read — no cooldown, proceed with backup
  }

  try {
    // 1. Validate config exists, is valid, and has real user data (not just template)
    const checkProc = await sandbox.startProcess(
      'test -f /root/.openclaw/openclaw.json && ' +
      'node -e "const c=JSON.parse(require(\'fs\').readFileSync(\'/root/.openclaw/openclaw.json\')); ' +
      'if(!c.agents && !c.channels && !c.gateway) throw new Error(\'Empty config\'); ' +
      'if(c.providers) throw new Error(\'Template config with rejected providers key\'); ' +
      'console.log(\'ok\')"'
    );
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    if (!checkLogs.stdout?.includes('ok')) {
      return {
        success: false,
        error: `Backup aborted: config check failed: ${(checkLogs.stderr || checkLogs.stdout || 'unknown').slice(-200)}`,
        durationMs: Date.now() - startTime,
        syncId,
      };
    }

    // 2. Create tar.gz in container — backup EVERYTHING under /root/
    // No cherry-picking. The whole workspace, all config, all sessions, everything.
    const tarCmd = `tar czf /tmp/backup.tar.gz -C / ${TAR_EXCLUDES} \
      root/ \
      2>&1; echo "TAR_EXIT:$?"`;
    const tarProc = await sandbox.startProcess(tarCmd);
    await waitForProcess(tarProc, BACKUP_TIMEOUT_MS);
    const tarLogs = await tarProc.getLogs();
    const tarOutput = (tarLogs.stdout || '') + (tarLogs.stderr || '');

    // Check tar exit code from output
    const exitMatch = tarOutput.match(/TAR_EXIT:(\d+)/);
    const tarExit = exitMatch ? parseInt(exitMatch[1], 10) : -1;
    // tar exit 1 = "file changed as we read it" — acceptable for live data
    if (tarExit !== 0 && tarExit !== 1) {
      return {
        success: false,
        error: `tar failed with exit code ${tarExit}: ${tarOutput.slice(-300)}`,
        durationMs: Date.now() - startTime,
        syncId,
      };
    }

    // 3. Read tar.gz from container
    // Use readFile which returns base64 string, or readFileAsBuffer if available
    let fileData: Uint8Array;
    try {
      // Try reading the file size first to warn about large backups
      const sizeProc = await sandbox.startProcess('stat -c%s /tmp/backup.tar.gz 2>/dev/null || stat -f%z /tmp/backup.tar.gz 2>/dev/null');
      await waitForProcess(sizeProc, 3000);
      const sizeLogs = await sizeProc.getLogs();
      const sizeBytes = parseInt(sizeLogs.stdout?.trim() || '0', 10);

      if (sizeBytes > 50 * 1024 * 1024) {
        console.warn(`[tar-backup] WARNING: backup.tar.gz is ${Math.round(sizeBytes / 1024 / 1024)}MB — may be slow to transfer`);
      }

      // Read as base64 via shell (most reliable across SDK versions)
      const readProc = await sandbox.startProcess('base64 /tmp/backup.tar.gz');
      await waitForProcess(readProc, BACKUP_TIMEOUT_MS);
      const readLogs = await readProc.getLogs();
      const base64Data = readLogs.stdout?.trim();

      if (!base64Data) {
        return {
          success: false,
          error: 'Failed to read backup.tar.gz from container (empty output)',
          durationMs: Date.now() - startTime,
          syncId,
        };
      }

      // Decode base64 to Uint8Array
      const binaryString = atob(base64Data);
      fileData = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        fileData[i] = binaryString.charCodeAt(i);
      }
    } catch (readErr) {
      return {
        success: false,
        error: `Failed to read tar.gz from container: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
        durationMs: Date.now() - startTime,
        syncId,
      };
    }

    // 4. PUT to R2
    // If existing backup is much larger, archive it first as a safety net
    const r2Key = `${r2Prefix}/${BACKUP_KEY}`;
    try {
      const existing = await env.MOLTBOT_BUCKET.head(r2Key);
      if (existing && existing.size > fileData.length * 2) {
        // Archive the existing larger backup before overwriting
        const archiveKey = `${r2Prefix}/backup-archive.tar.gz`;
        const existingData = await env.MOLTBOT_BUCKET.get(r2Key);
        if (existingData) {
          await env.MOLTBOT_BUCKET.put(archiveKey, existingData.body, {
            customMetadata: {
              archivedAt: new Date().toISOString(),
              originalSize: String(existing.size),
              reason: `New backup ${fileData.length}B < existing ${existing.size}B`,
            },
          });
          console.log(`[tar-backup] Archived ${Math.round(existing.size / 1024)}KB backup before overwriting with ${Math.round(fileData.length / 1024)}KB for ${r2Prefix}`);
        }
      }
    } catch (headErr) {
      console.warn(`[tar-backup] R2 archive check failed for ${r2Prefix}: ${headErr}`);
    }

    const timestamp = new Date().toISOString();
    await env.MOLTBOT_BUCKET.put(r2Key, fileData, {
      customMetadata: {
        timestamp,
        syncId,
        sizeBytes: String(fileData.length),
      },
    });

    // 5. Write .last-sync marker to R2
    await env.MOLTBOT_BUCKET.put(
      `${r2Prefix}/.last-sync`,
      `${syncId}|${timestamp}`
    );

    // 6. Cleanup temp file in container (fire and forget)
    sandbox.startProcess('rm -f /tmp/backup.tar.gz').catch(() => {});

    const durationMs = Date.now() - startTime;
    console.log(`[tar-backup] Backup complete for ${r2Prefix} in ${durationMs}ms (${Math.round(fileData.length / 1024)}KB)`);

    return {
      success: true,
      durationMs,
      sizeBytes: fileData.length,
      syncId,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[tar-backup] Backup failed for ${r2Prefix}: ${errorMsg}`);

    // Cleanup temp file on error
    sandbox.startProcess('rm -f /tmp/backup.tar.gz').catch(() => {});

    return {
      success: false,
      error: errorMsg,
      durationMs: Date.now() - startTime,
      syncId,
    };
  }
}

/**
 * Restore user data from R2 to container.
 *
 * Priority:
 * 1. Try backup.tar.gz (new format) — fastest, atomic
 * 2. Fall back to legacy individual files from R2
 * 3. If nothing found, return "fresh" — gateway starts with template config
 */
export async function restoreFromR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  r2Prefix: string
): Promise<TarRestoreResult> {
  const startTime = Date.now();

  try {
    // 1. Try tar.gz backup first
    const r2Key = `${r2Prefix}/${BACKUP_KEY}`;
    const tarObject = await env.MOLTBOT_BUCKET.get(r2Key);

    if (tarObject && tarObject.size > 200) {
      // Only reject obviously corrupt/empty tar files (< 200 bytes).
      // Valid config-only backups are ~1KB, full backups are 100KB+.
      console.log(`[tar-restore] Found backup.tar.gz for ${r2Prefix} (${tarObject.size} bytes)`);

      // Get the data as ArrayBuffer
      const arrayBuffer = await tarObject.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      // Write to container via sandbox.writeFile with base64 encoding
      // Chunk the btoa call to avoid stack overflow with large Uint8Arrays
      const ENCODE_CHUNK = 32768;
      const base64Chunks: string[] = [];
      for (let i = 0; i < data.length; i += ENCODE_CHUNK) {
        const slice = data.subarray(i, Math.min(i + ENCODE_CHUNK, data.length));
        base64Chunks.push(btoa(String.fromCharCode.apply(null, Array.from(slice))));
      }
      const base64Data = base64Chunks.join('');

      // Write base64 to container, then decode to tar.gz
      // Use sandbox.writeFile for the base64 string (it's text, no shell escaping issues)
      await sandbox.writeFile('/tmp/backup.b64', base64Data);

      // Decode base64 to tar.gz
      const decodeProc = await sandbox.startProcess(
        'base64 -d /tmp/backup.b64 > /tmp/backup.tar.gz && rm /tmp/backup.b64'
      );
      await waitForProcess(decodeProc, 10000);

      // Extract tar.gz and write cooldown marker in one shot
      const extractProc = await sandbox.startProcess(
        `tar xzf /tmp/backup.tar.gz -C / && rm -f /tmp/backup.tar.gz && date +%s > ${RESTORE_MARKER}`
      );
      await waitForProcess(extractProc, RESTORE_TIMEOUT_MS);
      const extractLogs = await extractProc.getLogs();

      if (extractProc.exitCode !== null && extractProc.exitCode !== 0) {
        console.error(`[tar-restore] Extract failed with exit ${extractProc.exitCode}: ${extractLogs.stderr?.slice(-300)}`);
        // Fall through to legacy restore
      } else {
        const durationMs = Date.now() - startTime;
        console.log(`[tar-restore] Restored from tar.gz for ${r2Prefix} in ${durationMs}ms (cooldown marker set)`);
        return { success: true, durationMs, format: 'tar' };
      }
    }

    if (tarObject && tarObject.size <= 200) {
      console.warn(`[tar-restore] Skipping backup.tar.gz for ${r2Prefix} — too small (${tarObject.size} bytes), likely corrupt. Trying archive fallback.`);
    }

    // 1b. Try backup-archive.tar.gz as fallback (archived larger backup)
    const archiveKey = `${r2Prefix}/${ARCHIVE_KEY}`;
    const archiveObject = await env.MOLTBOT_BUCKET.get(archiveKey);
    if (archiveObject && archiveObject.size > 200) {
      console.log(`[tar-restore] Found archive backup for ${r2Prefix} (${archiveObject.size} bytes)`);
      const arrayBuffer = await archiveObject.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const ENCODE_CHUNK = 32768;
      const base64Chunks: string[] = [];
      for (let i = 0; i < data.length; i += ENCODE_CHUNK) {
        const slice = data.subarray(i, Math.min(i + ENCODE_CHUNK, data.length));
        base64Chunks.push(btoa(String.fromCharCode.apply(null, Array.from(slice))));
      }
      await sandbox.writeFile('/tmp/backup.b64', base64Chunks.join(''));
      const decodeProc = await sandbox.startProcess('base64 -d /tmp/backup.b64 > /tmp/backup.tar.gz && rm /tmp/backup.b64');
      await waitForProcess(decodeProc, 10000);
      const extractProc = await sandbox.startProcess(`tar xzf /tmp/backup.tar.gz -C / && rm -f /tmp/backup.tar.gz && date +%s > ${RESTORE_MARKER}`);
      await waitForProcess(extractProc, RESTORE_TIMEOUT_MS);
      if (extractProc.exitCode === null || extractProc.exitCode === 0) {
        const durationMs = Date.now() - startTime;
        console.log(`[tar-restore] Restored from archive for ${r2Prefix} in ${durationMs}ms (cooldown marker set)`);
        return { success: true, durationMs, format: 'tar' };
      }
    }

    // 2. Priority: restore critical files (config + pairing + identity) — fast, <5s
    // This ensures Telegram bots respond to paired users and pairing state persists across deploys.
    const criticalCount = await restoreCriticalFilesFromR2(sandbox, env, r2Prefix);

    // 3. Restore full legacy data — comprehensive restore including sessions, SOUL.md, memory/, workspace/
    // Critical files are not enough — we need complete continuity for the agent to function properly.
    console.log(`[tar-restore] ${criticalCount} critical files restored, now performing full legacy restore for ${r2Prefix}...`);
    
    const legacyResult = await legacyRestoreFromR2(sandbox, env, r2Prefix);
    
    if (legacyResult.success) {
      const durationMs = Date.now() - startTime;
      console.log(`[tar-restore] Full legacy restore completed for ${r2Prefix} in ${durationMs}ms (${legacyResult.format})`);
      try {
        const markerProc3 = await sandbox.startProcess(`mkdir -p /root/.openclaw && date +%s > ${RESTORE_MARKER}`);
        await waitForProcess(markerProc3, 3000);
      } catch { /* marker write failure shouldn't block restore */ }
      return { success: true, durationMs, format: legacyResult.format };
    }

    // 4. Nothing found — fresh start
    const durationMs = Date.now() - startTime;
    console.log(`[tar-restore] No backup found for ${r2Prefix}, starting fresh`);
    return { success: true, durationMs, format: 'fresh' };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[tar-restore] Restore failed for ${r2Prefix}: ${errorMsg}`);

    // Cleanup temp files on error
    sandbox.startProcess('rm -f /tmp/backup.tar.gz /tmp/backup.b64').catch(() => {});

    return {
      success: false,
      error: errorMsg,
      durationMs: Date.now() - startTime,
      format: 'fresh',
    };
  }
}

/**
 * Write a file from R2 to the container using sandbox.writeFile().
 * Falls back to base64 pipe via startProcess for binary files.
 */
async function writeR2FileToContainer(
  sandbox: Sandbox,
  env: MoltbotEnv,
  r2Key: string,
  containerPath: string,
): Promise<boolean> {
  const data = await env.MOLTBOT_BUCKET.get(r2Key);
  if (!data) return false;

  const arrayBuffer = await data.arrayBuffer();

  // Ensure parent directory exists
  const dir = containerPath.substring(0, containerPath.lastIndexOf('/'));
  const mkdirProc = await sandbox.startProcess(`mkdir -p '${dir}'`);
  await waitForProcess(mkdirProc, 3000, 100); // 100ms poll for fast ops

  // Use sandbox.writeFile for text content (config, session logs, etc.)
  // For binary files, fall back to base64 pipe
  const bytes = new Uint8Array(arrayBuffer);

  // Try sandbox.writeFile first (works for text content)
  try {
    const text = new TextDecoder().decode(bytes);
    // Verify it decoded cleanly (no replacement chars for binary data)
    if (!text.includes('\ufffd')) {
      await sandbox.writeFile(containerPath, text);
      return true;
    }
  } catch {
    // Fall through to base64 approach
  }

  // Fallback: write via base64 chunks through shell
  // Chunk the base64 encoding to avoid stack overflow with large files
  const chunks: string[] = [];
  const ENCODE_CHUNK = 32768; // Process 32KB at a time for btoa
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + ENCODE_CHUNK, bytes.length));
    chunks.push(btoa(String.fromCharCode.apply(null, Array.from(slice))));
  }
  const base64Data = chunks.join('');

  // Write base64 to temp file in chunks, then decode
  const tmpFile = `/tmp/restore-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.b64`;
  const WRITE_CHUNK = 65536;
  for (let i = 0; i < base64Data.length; i += WRITE_CHUNK) {
    const chunk = base64Data.slice(i, i + WRITE_CHUNK);
    const op = i === 0 ? '>' : '>>';
    const writeProc = await sandbox.startProcess(
      `printf '%s' '${chunk}' ${op} ${tmpFile}`
    );
    await waitForProcess(writeProc, 5000, 100);
  }

  const decodeProc = await sandbox.startProcess(
    `base64 -d ${tmpFile} > '${containerPath}' && rm -f ${tmpFile}`
  );
  await waitForProcess(decodeProc, 10000, 100);

  return true;
}

/**
 * Critical files that must be restored BEFORE the gateway starts.
 * These are small JSON files (~8 files, <5s total).
 *
 * Without these, the gateway starts in a broken state:
 * - No config → uses template defaults
 * - No pairing data → dmPolicy:"pairing" silently drops all Telegram messages
 * - No identity → gateway generates new device identity, breaks pairing
 * - No auth profiles → loses channel auth state
 * - No telegram offset → re-processes old messages
 */
const CRITICAL_FILES = [
  'openclaw.json',
  'devices/paired.json',
  'devices/pending.json',
  'credentials/telegram-pairing.json',
  'identity/device.json',
  'identity/device-auth.json',
  'auth-profiles.json',
  'telegram/update-offset-default.json',
];

/**
 * Priority restore: grab critical files (config + pairing + identity) from R2.
 * This is fast (<5s) and ensures the gateway has both config AND pairing data
 * so Telegram bots respond to paired users immediately after restart.
 *
 * Returns the number of files successfully restored.
 */
async function restoreCriticalFilesFromR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  r2Prefix: string
): Promise<number> {
  // Determine which R2 prefix format has data
  // Try root/ first (new format), then openclaw/ (old format), then clawdbot/ (oldest)
  const prefixFormats = [
    { r2Dir: `${r2Prefix}/root/.openclaw`, label: 'root/' },
    { r2Dir: `${r2Prefix}/openclaw`, label: 'openclaw/' },
    { r2Dir: `${r2Prefix}/clawdbot`, label: 'clawdbot/' },
  ];

  for (const { r2Dir, label } of prefixFormats) {
    let restoredCount = 0;
    const restoredFiles: string[] = [];

    for (const file of CRITICAL_FILES) {
      // Handle clawdbot format rename: clawdbot.json → openclaw.json
      const r2File = label === 'clawdbot/' && file === 'openclaw.json' ? 'clawdbot.json' : file;
      const r2Key = `${r2Dir}/${r2File}`;
      const containerPath = `/root/.openclaw/${file}`;

      try {
        const ok = await writeR2FileToContainer(sandbox, env, r2Key, containerPath);
        if (ok) {
          restoredCount++;
          restoredFiles.push(file);
        }
      } catch {
        // File doesn't exist in this format, skip
      }
    }

    if (restoredCount > 0) {
      console.log(`[critical-restore] Restored ${restoredCount} critical files from ${label} format: ${restoredFiles.join(', ')}`);
      return restoredCount;
    }
  }

  console.log(`[critical-restore] No critical files found in R2 for ${r2Prefix}`);
  return 0;
}

/**
 * Legacy restore: download individual files from R2 and write to container.
 *
 * Handles multiple backup formats:
 * - New format: users/{userId}/root/ (full /root/ tree)
 * - Old format: users/{userId}/openclaw/ (config only)
 * - Legacy format: users/{userId}/clawdbot/ (pre-rename)
 */
async function legacyRestoreFromR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  r2Prefix: string
): Promise<TarRestoreResult> {
  const startTime = Date.now();

  try {
    // Try new format first: root/
    let listed = await env.MOLTBOT_BUCKET.list({ prefix: `${r2Prefix}/root/`, limit: 500 });
    if (listed.objects.length > 0) {
      console.log(`[legacy-restore] Found ${listed.objects.length} files in ${r2Prefix}/root/`);
      let restored = 0;
      let failed = 0;

      for (const obj of listed.objects) {
        if (obj.size === 0) continue;

        // Map R2 key to container path: users/{userId}/root/.openclaw/foo → /root/.openclaw/foo
        const relativePath = obj.key.slice(`${r2Prefix}/root`.length); // e.g., /.openclaw/foo
        const containerPath = `/root${relativePath}`;

        try {
          const ok = await writeR2FileToContainer(sandbox, env, obj.key, containerPath);
          if (ok) restored++;
          else failed++;
        } catch (fileErr) {
          failed++;
          console.warn(`[legacy-restore] Failed to restore ${obj.key}: ${fileErr}`);
        }
      }

      console.log(`[legacy-restore] Restored ${restored} files from root/ format (${failed} failed)`);
      return {
        success: restored > 0,
        durationMs: Date.now() - startTime,
        format: 'legacy',
      };
    }

    // Try openclaw/ format
    listed = await env.MOLTBOT_BUCKET.list({ prefix: `${r2Prefix}/openclaw/`, limit: 500 });
    if (listed.objects.length > 0) {
      console.log(`[legacy-restore] Found ${listed.objects.length} files in ${r2Prefix}/openclaw/`);
      let restored = 0;
      let failed = 0;

      for (const obj of listed.objects) {
        if (obj.size === 0) continue;

        // Map: users/{userId}/openclaw/foo → /root/.openclaw/foo
        const relativePath = obj.key.slice(`${r2Prefix}/openclaw`.length);
        const containerPath = `/root/.openclaw${relativePath}`;

        try {
          const ok = await writeR2FileToContainer(sandbox, env, obj.key, containerPath);
          if (ok) restored++;
          else failed++;
        } catch (fileErr) {
          failed++;
          console.warn(`[legacy-restore] Failed to restore ${obj.key}: ${fileErr}`);
        }
      }

      console.log(`[legacy-restore] Restored ${restored} files from openclaw/ format (${failed} failed)`);
      return {
        success: restored > 0,
        durationMs: Date.now() - startTime,
        format: 'legacy',
      };
    }

    // Try clawdbot/ format (oldest)
    listed = await env.MOLTBOT_BUCKET.list({ prefix: `${r2Prefix}/clawdbot/`, limit: 500 });
    if (listed.objects.length > 0) {
      console.log(`[legacy-restore] Found ${listed.objects.length} files in ${r2Prefix}/clawdbot/ (migrating to openclaw)`);
      let restored = 0;
      let failed = 0;

      for (const obj of listed.objects) {
        if (obj.size === 0) continue;

        // Map: users/{userId}/clawdbot/foo → /root/.openclaw/foo
        const relativePath = obj.key.slice(`${r2Prefix}/clawdbot`.length);
        // Handle clawdbot.json → openclaw.json rename
        const mappedPath = relativePath === '/clawdbot.json' ? '/openclaw.json' : relativePath;
        const containerPath = `/root/.openclaw${mappedPath}`;

        try {
          const ok = await writeR2FileToContainer(sandbox, env, obj.key, containerPath);
          if (ok) restored++;
          else failed++;
        } catch (fileErr) {
          failed++;
          console.warn(`[legacy-restore] Failed to restore ${obj.key}: ${fileErr}`);
        }
      }

      console.log(`[legacy-restore] Restored ${restored} files from clawdbot/ format (${failed} failed, migrated to openclaw)`);
      return {
        success: restored > 0,
        durationMs: Date.now() - startTime,
        format: 'legacy',
      };
    }

    // Nothing found
    return {
      success: true,
      durationMs: Date.now() - startTime,
      format: 'fresh',
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[legacy-restore] Failed: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
      durationMs: Date.now() - startTime,
      format: 'fresh',
    };
  }
}
