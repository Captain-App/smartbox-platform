/**
 * Scheduled handler for cron triggers.
 * Runs health checks, syncs, backups, and resource monitoring for all user containers.
 */

import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { HEALTH_CHECK_CONFIG } from '../config';
import {
  ensureMoltbotGateway,
  checkHealth,
  shouldRestart,
  recordRestart,
  recordRestartForCircuitBreaker,
  createDailyBackup,
  createRollingBackup,
  getSandboxForUser,
  getTierForUser,
  restartContainer,
  collectAllContainerStats,
  syncToR2,
  syncCriticalFilesToR2,
  getConsecutiveSyncFailures,
} from '../gateway';
import { getSandboxName } from '../gateway/tiers';
import { getActiveUserIdsFromDB, getActiveUserIds } from '../lib/user-registry';
import { isBackupFeatureEnabled } from '../config/backup';
import {
  createIssue,
  logSyncEvent,
  logHealthEvent,
  logRestartEvent,
} from '../monitoring';

/**
 * Build sandbox options based on environment configuration.
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  return { sleepAfter };
}

/**
 * Phase 1: Health checks for all user containers.
 * Auto-starts stopped gateways and auto-restarts unhealthy ones.
 */
async function runHealthChecks(
  env: MoltbotEnv,
  userIds: Set<string>,
  options: SandboxOptions,
): Promise<{
  healthyCount: number;
  unhealthyCount: number;
  restartCount: number;
  skippedCount: number;
  syncSuccessCount: number;
  syncFailCount: number;
  issues: Array<{ userId: string; type: string; error: string }>;
}> {
  let healthyCount = 0;
  let unhealthyCount = 0;
  let restartCount = 0;
  let syncSuccessCount = 0;
  let syncFailCount = 0;
  let skippedCount = 0;
  const issues: Array<{ userId: string; type: string; error: string }> = [];

  for (const userId of userIds) {
    const sandboxName = getSandboxName(userId);
    const r2Prefix = `users/${userId}`;

    try {
      const sandboxBinding = getSandboxForUser(env, userId);
      const tier = getTierForUser(userId);
      const sandbox = getSandbox(sandboxBinding, sandboxName, options);

      const bindingName = sandboxBinding === env.Large ? 'standard-3' :
                          sandboxBinding === env.Medium ? 'standard-2' : 'standard-1';
      console.log(`[cron] Processing user ${userId.slice(0, 8)} on tier ${tier} (binding: ${bindingName})`);

      // Check if gateway is running
      const processes = await sandbox.listProcesses();
      const gatewayRunning = processes.some((p: any) =>
        (p.command?.includes('openclaw gateway') || p.command?.includes('openclaw-gateway') || p.command?.includes('start-moltbot.sh')) &&
        p.status === 'running'
      );

      if (!gatewayRunning) {
        // Check if user has a backup (meaning they've been set up)
        const backupHead = await env.SMARTBOX_BUCKET.head(`users/${userId}/backup.tar.gz`);
        if (backupHead && backupHead.size > 200) {
          console.log(`[cron] Auto-starting gateway for ${sandboxName} — has ${Math.round(backupHead.size / 1024)}KB backup but no gateway`);
          try {
            await ensureMoltbotGateway(sandbox, env, userId);
            console.log(`[cron] Auto-started gateway for ${sandboxName}`);
            restartCount++;
          } catch (startErr) {
            console.error(`[cron] Failed to auto-start ${sandboxName}:`, startErr);
            issues.push({ userId, type: 'auto_start_failed', error: startErr instanceof Error ? startErr.message : 'Unknown error' });
            skippedCount++;
            continue;
          }
        } else {
          console.log(`[cron] Skipping ${sandboxName} — no gateway and no backup`);
          skippedCount++;
          continue;
        }
      }

      // Run health check
      const healthResult = await checkHealth(sandbox, userId, HEALTH_CHECK_CONFIG, env.PLATFORM_DB);

      logHealthEvent(userId, healthResult.healthy, {
        consecutiveFailures: healthResult.consecutiveFailures,
        processRunning: healthResult.checks.processRunning,
        portReachable: healthResult.checks.portReachable,
        uptimeSeconds: healthResult.uptimeSeconds,
      });

      if (healthResult.healthy) {
        healthyCount++;
        console.log(`[cron] Health OK: ${sandboxName} (uptime: ${healthResult.uptimeSeconds}s)`);
      } else {
        unhealthyCount++;
        console.warn(`[cron] Health FAIL: ${sandboxName} - failures: ${healthResult.consecutiveFailures}, checks: ${JSON.stringify(healthResult.checks)}`);

        if (shouldRestart(userId, HEALTH_CHECK_CONFIG)) {
          console.log(`[cron] Auto-restarting ${sandboxName} after ${healthResult.consecutiveFailures} consecutive failures`);
          issues.push({ userId, type: 'auto_restart', error: `${healthResult.consecutiveFailures} consecutive health check failures` });

          if (env.PLATFORM_DB) {
            await createIssue(env.PLATFORM_DB, {
              type: 'health_failure',
              severity: 'high',
              userId,
              message: `Auto-restart triggered after ${healthResult.consecutiveFailures} consecutive health check failures`,
              details: {
                checks: healthResult.checks,
                uptimeSeconds: healthResult.uptimeSeconds,
              },
            });
          }

          try {
            recordRestartForCircuitBreaker(userId);
            const restartResult = await restartContainer(sandbox, env, userId);

            if (restartResult.success) {
              recordRestart(userId);
              restartCount++;
              logRestartEvent(userId, true, 'auto_health_failure', {
                previousFailures: healthResult.consecutiveFailures,
              });
              console.log(`[cron] Auto-restart initiated for ${sandboxName}${restartResult.syncResult?.success ? ' with pre-shutdown sync' : ''}`);
            } else {
              throw new Error(restartResult.message);
            }
          } catch (restartErr) {
            const errorMsg = restartErr instanceof Error ? restartErr.message : 'Unknown error';
            console.error(`[cron] Failed to restart ${sandboxName}:`, restartErr);
            issues.push({ userId, type: 'restart_failed', error: errorMsg });
            logRestartEvent(userId, false, 'auto_health_failure', { previousFailures: healthResult.consecutiveFailures });

            if (env.PLATFORM_DB) {
              await createIssue(env.PLATFORM_DB, {
                type: 'restart',
                severity: 'critical',
                userId,
                message: `Auto-restart failed: ${errorMsg}`,
                details: { previousFailures: healthResult.consecutiveFailures },
              });
            }
          }
        }
      }

      // Run sync
      await runDataSync(env, sandbox, userId, r2Prefix, syncSuccessCount, syncFailCount, issues);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[cron] Error processing ${sandboxName}:`, err);
      issues.push({ userId, type: 'cron_error', error: errorMsg });
    }
  }

  return { healthyCount, unhealthyCount, restartCount, skippedCount, syncSuccessCount, syncFailCount, issues };
}

/**
 * Phase 2: Run data sync for a single user's sandbox.
 */
async function runDataSync(
  env: MoltbotEnv,
  sandbox: any,
  userId: string,
  r2Prefix: string,
  _syncSuccessCount: number,
  _syncFailCount: number,
  issues: Array<{ userId: string; type: string; error: string }>,
): Promise<{ success: boolean }> {
  const sandboxName = getSandboxName(userId);

  // Critical files sync
  if (isBackupFeatureEnabled('CRITICAL_FILE_PRIORITY')) {
    const criticalSyncResult = await syncCriticalFilesToR2(sandbox, env, { r2Prefix });
    if (criticalSyncResult.success) {
      console.log(`[cron] Critical files synced for ${sandboxName} in ${criticalSyncResult.durationMs}ms`);
    } else {
      console.warn(`[cron] Critical file sync failed for ${sandboxName}:`, criticalSyncResult);
    }
  }

  // Full sync
  const syncResult = await syncToR2(sandbox, env, { r2Prefix });

  logSyncEvent(userId, syncResult.success, syncResult.durationMs || 0, {
    fileCount: syncResult.fileCount,
    error: syncResult.error,
    syncId: syncResult.syncId,
  });

  if (syncResult.success) {
    console.log(`[cron] Synced ${sandboxName}: ${syncResult.fileCount} files in ${syncResult.durationMs}ms`);
  } else {
    console.error(`[cron] Sync failed for ${sandboxName}: ${syncResult.error}`);
    issues.push({ userId, type: 'sync_failed', error: syncResult.error || 'Unknown error' });

    const consecutiveFailures = getConsecutiveSyncFailures(r2Prefix);
    if (consecutiveFailures >= 3 && env.PLATFORM_DB) {
      console.warn(`[cron] Recording sync failure to D1: ${consecutiveFailures} consecutive failures for ${userId}`);
      await createIssue(env.PLATFORM_DB, {
        type: 'sync_failure',
        severity: 'medium',
        userId,
        message: `${consecutiveFailures} consecutive sync failures`,
        details: {
          rsyncExitCode: syncResult.rsyncExitCode,
          syncId: syncResult.syncId,
          error: syncResult.error,
          details: syncResult.details,
        },
      });
    }
  }

  return { success: syncResult.success };
}

/**
 * Phase 3-4: Run rolling and daily backups.
 */
async function runBackups(env: MoltbotEnv): Promise<void> {
  // Rolling 20-minute backup
  try {
    const rollingResult = await createRollingBackup(env);
    if (rollingResult.skipped) {
      console.log(`[cron] Rolling backup: skipped (${rollingResult.skipReason})`);
    } else if (rollingResult.success) {
      console.log(`[cron] Rolling backup: ${rollingResult.usersBackedUp} users, ${rollingResult.filesBackedUp} files at ${rollingResult.date}`);
    } else {
      console.error(`[cron] Rolling backup failed: ${rollingResult.error}`);
    }
  } catch (err) {
    console.error(`[cron] Rolling backup error:`, err);
  }

  // Daily backup
  try {
    const backupResult = await createDailyBackup(env);
    if (backupResult.skipped) {
      console.log(`[cron] Daily backup: skipped (${backupResult.skipReason})`);
    } else if (backupResult.success) {
      console.log(`[cron] Daily backup: ${backupResult.usersBackedUp} users, ${backupResult.filesBackedUp} files`);
    } else {
      console.error(`[cron] Daily backup failed: ${backupResult.error}`);
    }
  } catch (err) {
    console.error(`[cron] Daily backup error:`, err);
  }
}

/**
 * Phase 5: Resource monitoring collection.
 */
async function runResourceMonitoring(env: MoltbotEnv): Promise<void> {
  try {
    console.log('[cron] Starting resource monitoring collection...');
    await collectAllContainerStats(env);
    console.log('[cron] Resource monitoring collection complete');
  } catch (err) {
    console.error(`[cron] Resource monitoring error:`, err);
  }
}

/**
 * Phase 6: Fleet-wide safe backup.
 * Calls backup-safe endpoint per user with validation.
 */
async function runFleetBackup(
  env: MoltbotEnv,
  userIds: Set<string>,
  fetchFn: (request: Request, env: MoltbotEnv) => Promise<Response>,
): Promise<void> {
  try {
    console.log('[cron] Starting fleet-wide safe backup...');
    const backupResults = { success: 0, skipped: 0, failed: 0 };

    for (const userId of userIds) {
      try {
        const backupResponse = await fetchFn(
          new Request(`http://localhost/api/super/users/${userId}/backup-safe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Admin-Secret': env.MOLTBOT_GATEWAY_MASTER_TOKEN || '',
            },
            body: JSON.stringify({ source: 'cron-auto' }),
          }),
          env
        );

        if (backupResponse.status === 200) {
          backupResults.success++;
          console.log(`[cron] Safe backup succeeded for ${userId.slice(0, 8)}`);
        } else if (backupResponse.status === 409) {
          backupResults.skipped++;
          const result = await backupResponse.json() as { reason?: string };
          console.log(`[cron] Safe backup skipped for ${userId.slice(0, 8)}: ${result.reason}`);
        } else {
          backupResults.failed++;
          console.error(`[cron] Safe backup failed for ${userId.slice(0, 8)}: ${backupResponse.status}`);
        }
      } catch (backupErr) {
        backupResults.failed++;
        console.error(`[cron] Safe backup error for ${userId.slice(0, 8)}:`, backupErr);
      }
    }

    console.log(`[cron] Fleet backup complete: ${backupResults.success} success, ${backupResults.skipped} skipped, ${backupResults.failed} failed`);
  } catch (err) {
    console.error(`[cron] Fleet backup error:`, err);
  }
}

/**
 * Main scheduled handler — orchestrates all cron phases.
 */
export async function scheduled(
  _event: ScheduledEvent,
  env: MoltbotEnv,
  _ctx: ExecutionContext,
  fetchFn: (request: Request, env: MoltbotEnv) => Promise<Response>,
): Promise<void> {
  console.log('[cron] Starting health checks and backup sync...');

  // Use D1 if available, fallback to hardcoded registry
  let userIdArray: string[];
  if (env.PLATFORM_DB) {
    userIdArray = await getActiveUserIdsFromDB(env.PLATFORM_DB);
  } else {
    userIdArray = getActiveUserIds();
  }
  const userIds = new Set<string>(userIdArray);

  console.log(`[cron] Found ${userIds.size} users to check`);

  const options = buildSandboxOptions(env);

  // Phase 1-2: Health checks and syncs
  const stats = await runHealthChecks(env, userIds, options);

  // Phase 3-4: Backups
  await runBackups(env);

  // Phase 5: Resource monitoring
  await runResourceMonitoring(env);

  // Phase 6: Fleet backup
  await runFleetBackup(env, userIds, fetchFn);

  // Log summary
  console.log(`[cron] Complete - Health: ${stats.healthyCount} healthy, ${stats.unhealthyCount} unhealthy, ${stats.restartCount} restarted`);
  console.log(`[cron] Complete - Sync: ${stats.syncSuccessCount} succeeded, ${stats.syncFailCount} failed, ${stats.skippedCount} skipped`);
  if (stats.issues.length > 0) {
    console.error(`[cron] Issues:`, JSON.stringify(stats.issues.slice(0, 10)));
  }
}
