import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getGatewayMasterToken } from '../gateway';
import { getActiveUserIds, getUserNames, getUserRegistry, findUserByName } from '../lib/user-registry';

/**
 * Admin API routes for managing user containers
 * These endpoints are protected by super admin authentication
 * and provide container state management and native file operations
 */
const adminRouter = new Hono<AppEnv>();

// Authentication middleware for super admin endpoints
async function requireSuperAuth(c: any, next: () => Promise<void>) {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);

  if (!adminSecret || adminSecret !== expectedSecret) {
    return c.json({
      error: 'Super admin access required',
      hint: 'Provide X-Admin-Secret header'
    }, 403);
  }

  await next();
}

// Helper: Get sandbox for a user with tiered routing support
async function getUserSandbox(env: any, userId: string, keepAlive = false) {
  const { getSandbox } = await import('@cloudflare/sandbox');
  const { getSandboxForUser } = await import('../gateway/tiers');
  const sandboxName = `openclaw-${userId}`;

  // Use tiered routing for migrated users, legacy for others
  const sandboxBinding = getSandboxForUser(env, userId);

  return getSandbox(sandboxBinding, sandboxName, {
    keepAlive,
    containerTimeouts: {
      instanceGetTimeoutMS: 30000,
      portReadyTimeoutMS: 60000,
    }
  });
}

// Container states
type ContainerState = 'active' | 'idle' | 'sleeping' | 'stopped' | 'error';

interface ContainerStatus {
  state: ContainerState;
  lastActivity: string | null;
  processCount: number;
  memoryMB: number | null;
  uptimeSeconds: number | null;
  version: string | null;
  error?: string;
}

// Live state check types (v2 synchronous endpoint)
type LiveContainerState = 'stopped' | 'idle' | 'starting' | 'active' | 'error';

interface LiveState {
  state: LiveContainerState;
  userId: string;
  processCount: number;
  gatewayHealthy: boolean | null;
  checkedAt: string;
  latencyMs: number;
  lastSyncAt?: string | null;
  error?: string;
}

/**
 * Performs a synchronous live health check on a user's container
 *
 * Steps:
 * 1. Get sandbox reference (fast, from DO namespace)
 * 2. List processes to check if any are running
 * 3. If processes exist, ping gateway port 18789
 * 4. Return state based on actual results
 *
 * Performance Budget: <500ms for single container
 */
async function getLiveState(userId: string, env: AppEnv): Promise<LiveState> {
  const startTime = Date.now();

  try {
    // Step 1: Get sandbox reference (fast, from DO namespace)
    const sandbox = await getUserSandbox(env, userId, false);

    // Step 2: List processes - lightweight operation (<100ms)
    let processes: any[] = [];
    try {
      processes = await sandbox.listProcesses();
    } catch (processError) {
      // If we can't list processes, sandbox might be hibernating or stopped
      return {
        state: 'stopped',
        userId,
        processCount: 0,
        gatewayHealthy: null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        error: processError instanceof Error ? processError.message : 'Failed to list processes',
      };
    }

    // No processes = idle state
    if (processes.length === 0) {
      return {
        state: 'idle',
        userId,
        processCount: 0,
        gatewayHealthy: null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
      };
    }

    // Step 3: Check gateway health on port 18789
    const gatewayHealthy = await checkGatewayHealth(sandbox);

    // Step 4: Determine state based on gateway health
    return {
      state: gatewayHealthy ? 'active' : 'starting',
      userId,
      processCount: processes.length,
      gatewayHealthy,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
    };

  } catch (error) {
    // Can't get sandbox reference = stopped
    return {
      state: 'stopped',
      userId,
      processCount: 0,
      gatewayHealthy: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if the gateway is healthy by attempting to connect via containerFetch
 * Port 18789 serves both WebSocket and HTTP traffic - any response means it's alive
 */
async function checkGatewayHealth(sandbox: any): Promise<boolean> {
  try {
    // Use containerFetch to check if the gateway responds on port 18789
    // This matches how the main app actually communicates with the gateway
    const response = await sandbox.containerFetch(
      new Request('http://localhost:18789/'),
      18789
    );

    // Any non-zero status means the server responded (even 404 is OK)
    return response.status > 0;
  } catch {
    // Connection refused or timeout = gateway not healthy
    return false;
  }
}

/** Get all active user IDs from the shared registry */
async function getAllUserIdsFromRegistry(): Promise<string[]> {
  return getActiveUserIds();
}

// =============================================================================
// User Registry
// =============================================================================

// GET /api/super/users - List all registered users with names
adminRouter.get('/users', requireSuperAuth, async (c) => {
  const registry = getUserRegistry();
  return c.json({
    users: registry,
    total: registry.length,
    active: registry.filter(u => u.status === 'active').length,
  });
});

// GET /api/super/users/lookup/:name - Look up user by name
adminRouter.get('/users/lookup/:name', requireSuperAuth, async (c) => {
  const name = c.req.param('name');
  const user = findUserByName(name);
  if (!user) {
    return c.json({ error: `No user found matching "${name}"` }, 404);
  }
  return c.json(user);
});

// =============================================================================
// Lightweight R2-Only Endpoints (Bypass DO - work even when DO is stuck)
// =============================================================================

/**
 * GET /api/super/users/:id/r2-status
 * Check user's R2 backup status (NO DO interaction)
 * Fast (<1s) even if DO is stuck
 */
adminRouter.get('/users/:id/r2-status', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  console.log(`[R2-STATUS] Starting for user ${userId.slice(0, 8)}...`);

  try {
    const prefix = `users/${userId}/`;

    // Check for backup.tar.gz (new format)
    const backupHead = await c.env.MOLTBOT_BUCKET.head(`${prefix}backup.tar.gz`);

    // Check for legacy files to determine format
    const legacyListed = await c.env.MOLTBOT_BUCKET.list({ prefix: `${prefix}root/`, limit: 1 });
    const hasLegacyRoot = legacyListed.objects.length > 0;
    const openlawListed = await c.env.MOLTBOT_BUCKET.list({ prefix: `${prefix}openclaw/`, limit: 1 });
    const hasLegacyOpenclaw = openlawListed.objects.length > 0;

    const backupFormat = backupHead ? 'tar' : hasLegacyRoot ? 'legacy-root' : hasLegacyOpenclaw ? 'legacy-openclaw' : 'none';

    // Get sync marker
    const lastSync = await c.env.MOLTBOT_BUCKET.get(`${prefix}.last-sync`);

    // Get secrets keys (not values)
    const secretsObj = await c.env.MOLTBOT_BUCKET.get(`${prefix}secrets.json`);
    let secretKeys: string[] | null = null;
    if (secretsObj) {
      try {
        const secrets = JSON.parse(await secretsObj.text());
        secretKeys = Object.keys(secrets).filter(k => !!secrets[k]);
      } catch { /* ignore */ }
    }

    // Parse last sync time (format: "syncId|timestamp" or just "timestamp")
    const lastSyncText = lastSync ? await lastSync.text() : null;
    let syncTime: Date | null = null;
    let minutesSinceSync: number | null = null;
    let syncId: string | null = null;
    if (lastSyncText) {
      try {
        if (lastSyncText.includes('|')) {
          const parts = lastSyncText.split('|');
          syncId = parts[0];
          const parsed = new Date(parts[1].trim());
          if (!isNaN(parsed.getTime())) {
            syncTime = parsed;
          }
        } else {
          const parsed = new Date(lastSyncText.trim());
          if (!isNaN(parsed.getTime())) {
            syncTime = parsed;
          }
        }
        if (syncTime) {
          minutesSinceSync = Math.round((Date.now() - syncTime.getTime()) / 60000);
        }
      } catch { /* ignore invalid dates */ }
    }

    return c.json({
      userId,
      backupFormat,
      hasBackup: backupFormat !== 'none',
      backup: backupHead ? {
        sizeBytes: backupHead.size,
        sizeMB: Math.round(backupHead.size / 1024 / 1024 * 100) / 100,
        uploaded: backupHead.uploaded?.toISOString(),
        metadata: backupHead.customMetadata,
      } : null,
      lastSync: syncTime?.toISOString() || null,
      syncId,
      minutesSinceSync,
      secrets: secretKeys,
      healthy: minutesSinceSync !== null && minutesSinceSync < 5,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

/**
 * GET /api/super/users/:id/r2-health
 * Quick health check via R2 markers (NO DO interaction)
 */
adminRouter.get('/users/:id/r2-health', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  try {
    const lastSync = await c.env.MOLTBOT_BUCKET.get(`users/${userId}/.last-sync`);

    if (!lastSync) {
      return c.json({
        healthy: false,
        reason: 'No sync data found in R2',
        userId,
      });
    }

    const syncContent = await lastSync.text();
    const timestamp = syncContent.split('|')[1] || syncContent;
    const syncTime = new Date(timestamp);
    const minutesSinceSync = (Date.now() - syncTime.getTime()) / 60000;

    return c.json({
      healthy: minutesSinceSync < 5,
      lastSync: syncTime.toISOString(),
      minutesSinceSync: Math.round(minutesSinceSync),
      threshold: 5,
      userId,
    });
  } catch (error) {
    return c.json({
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown',
      userId,
    }, 500);
  }
});

/**
 * POST /api/super/users/:id/restart-async
 * Restart user's container (returns immediately, restart happens in background)
 */
adminRouter.post('/users/:id/restart-async', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  try {
    const sandbox = await getUserSandbox(c.env, userId, true);

    // Fire restart in background - don't wait
    const restartPromise = (async () => {
      try {
        console.log(`[ASYNC-RESTART] Starting restart for ${userId.slice(0, 8)}...`);

        // Batch kill all processes in one API call (not one-by-one)
        try {
          const killed = await sandbox.killAllProcesses();
          console.log(`[ASYNC-RESTART] Killed ${killed} processes via killAllProcesses()`);
        } catch (e) {
          console.warn(`[ASYNC-RESTART] killAllProcesses() failed, trying shell kill:`, e);
          // Fallback: shell-based kill
          try {
            await sandbox.exec('kill -9 -1 2>/dev/null; true', { timeout: 5000 });
          } catch { /* ignore - process may kill itself */ }
        }

        await new Promise(r => setTimeout(r, 2000));

        // Clear locks
        try {
          await sandbox.exec('rm -f /tmp/openclaw*.lock /root/.openclaw/*.lock 2>/dev/null', { timeout: 5000 });
        } catch { /* ignore */ }

        // Start gateway
        const { ensureMoltbotGateway } = await import('../gateway');
        await ensureMoltbotGateway(sandbox, c.env, userId);

        console.log(`[ASYNC-RESTART] ✅ Gateway started for ${userId.slice(0, 8)}`);
      } catch (err) {
        console.error(`[ASYNC-RESTART] ❌ Failed for ${userId.slice(0, 8)}:`, err);
      }
    })();

    c.executionCtx.waitUntil(restartPromise);

    return c.json({
      success: true,
      userId,
      message: 'Restart initiated in background',
      checkStatusUrl: `/api/super/users/${userId}/r2-status`,
      note: 'Check status in 30-60 seconds',
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

/**
 * POST /api/super/users/:id/sync-async
 * Trigger a sync in the background (returns immediately)
 */
adminRouter.post('/users/:id/sync-async', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  try {
    const sandbox = await getUserSandbox(c.env, userId, true);

    // Fire sync in background
    const syncPromise = (async () => {
      try {
        const { syncToR2 } = await import('../gateway');
        const result = await syncToR2(sandbox, c.env, { r2Prefix: `users/${userId}` });
        console.log(`[ASYNC-SYNC] ${userId.slice(0, 8)}: ${result.success ? 'success' : result.error}`);
      } catch (err) {
        console.error(`[ASYNC-SYNC] ${userId.slice(0, 8)} failed:`, err);
      }
    })();

    c.executionCtx.waitUntil(syncPromise);

    return c.json({
      success: true,
      userId,
      message: 'Sync initiated in background',
      checkStatusAt: `/api/super/users/${userId}/r2-status`,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

/**
 * POST /api/super/users/:id/emergency-reset
 * Emergency reset: deletes all local state, forces restore from R2
 */
adminRouter.post('/users/:id/emergency-reset', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  try {
    const sandbox = await getUserSandbox(c.env, userId, true);

    console.log(`[EMERGENCY-RESET] Starting for ${userId.slice(0, 8)}...`);

    // Batch kill all processes in one API call
    try {
      const killed = await sandbox.killAllProcesses();
      console.log(`[EMERGENCY-RESET] Killed ${killed} processes via killAllProcesses()`);
    } catch (e) {
      console.warn(`[EMERGENCY-RESET] killAllProcesses() failed, trying shell kill:`, e);
      try {
        await sandbox.exec('kill -9 -1 2>/dev/null; true', { timeout: 5000 });
      } catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 2000));

    // Clear all locks and local state
    try {
      await sandbox.exec('rm -rf /tmp/openclaw*.lock /root/.openclaw/*.lock /root/.openclaw/.last-sync 2>/dev/null', { timeout: 5000 });
    } catch { /* ignore */ }

    // Start fresh gateway (will restore from R2)
    const { ensureMoltbotGateway } = await import('../gateway');
    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch(err => {
      console.error(`[EMERGENCY-RESET] Gateway start failed for ${userId.slice(0, 8)}:`, err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      userId,
      message: 'Emergency reset initiated - restoring from R2',
      checkStatusUrl: `/api/super/users/${userId}/r2-status`,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

// =============================================================================
// Phase 2: State-Aware API
// =============================================================================

// GET /api/super/users/:id/state - Get container state
adminRouter.get('/users/:id/state', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  try {
    const sandbox = await getUserSandbox(c.env, userId, false);
    const status: ContainerStatus = {
      state: 'stopped',
      lastActivity: null,
      processCount: 0,
      memoryMB: null,
      uptimeSeconds: null,
      version: null,
    };

    try {
      // Try to list processes - if this fails, container is sleeping/stopped
      const processes = await sandbox.listProcesses();
      status.processCount = processes.length;

      // Check if gateway is running
      const gatewayProcess = processes.find((p: any) =>
        p.command?.includes('openclaw gateway') &&
        (p.status === 'running' || p.status === 'starting')
      );

      if (gatewayProcess) {
        status.state = 'active';
        status.lastActivity = gatewayProcess.startTime?.toISOString() || null;

        // Calculate uptime if we have a start time
        if (gatewayProcess.startTime) {
          const uptime = Math.floor((Date.now() - gatewayProcess.startTime.getTime()) / 1000);
          status.uptimeSeconds = uptime;
        }
      } else if (processes.length > 0) {
        status.state = 'idle';
      }

      // Try to get version from a running process
      if (status.state === 'active') {
        try {
          const versionProc = await sandbox.startProcess('openclaw --version');
          await new Promise(r => setTimeout(r, 500));
          const logs = await versionProc.getLogs();
          const version = (logs.stdout || logs.stderr || '').trim();
          if (version) {
            status.version = version;
          }
        } catch {
          // Ignore version check errors
        }
      }

      // Try to get memory info (this will only work if container is responsive)
      if (status.state === 'active') {
        try {
          const memProc = await sandbox.startProcess("free -m | awk '/^Mem:/{print $3}'");
          await new Promise(r => setTimeout(r, 500));
          const memLogs = await memProc.getLogs();
          const memUsed = parseInt(memLogs.stdout?.trim() || '0', 10);
          if (!isNaN(memUsed)) {
            status.memoryMB = memUsed;
          }
        } catch {
          // Ignore memory check errors
        }
      }

    } catch (sandboxError) {
      // Sandbox exists but is not responsive - likely sleeping
      status.state = 'sleeping';
      status.error = sandboxError instanceof Error ? sandboxError.message : 'Sandbox unresponsive';
    }

    // Check R2 for last sync timestamp
    try {
      const syncKey = `users/${userId}/.last-sync`;
      const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);
      if (syncObj) {
        const syncData = await syncObj.text();
        if (syncData) {
          // Use R2 sync time as fallback for lastActivity
          if (!status.lastActivity) {
            status.lastActivity = syncData.split('|')[0] || syncData;
          }
        }
      }
    } catch {
      // Ignore R2 errors
    }

    return c.json({
      userId,
      ...status,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      state: 'error',
      error: errorMessage,
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

// GET /api/super/users/:id/logs - Get gateway process logs
adminRouter.get('/users/:id/logs', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  try {
    const sandbox = await getUserSandbox(c.env, userId, false);
    const processes = await sandbox.listProcesses();
    // Find gateway process - prefer running, fall back to most recent completed
    let gatewayProcess = processes.find((p: any) =>
      (p.command?.includes('start-moltbot.sh') || p.command?.includes('openclaw gateway') || p.command?.includes('openclaw-gateway')) &&
      (p.status === 'running' || p.status === 'starting')
    );
    if (!gatewayProcess) {
      // Fall back to most recently completed gateway process (for crash logs)
      const completed = processes.filter((p: any) =>
        (p.command?.includes('start-moltbot.sh') || p.command?.includes('openclaw gateway') || p.command?.includes('openclaw-gateway'))
      );
      gatewayProcess = completed[completed.length - 1] || null;
    }
    if (!gatewayProcess) {
      return c.json({ userId, error: 'No gateway process found', processes: processes.map((p: any) => ({ id: p.id, command: p.command, status: p.status })) }, 404);
    }
    const logs = await gatewayProcess.getLogs();
    const tail = parseInt(c.req.query('tail') || '200');
    const stdoutLines = (logs.stdout || '').split('\n');
    const stderrLines = (logs.stderr || '').split('\n');
    return c.json({
      userId,
      processId: gatewayProcess.id,
      command: gatewayProcess.command,
      status: gatewayProcess.status,
      stdout: stdoutLines.slice(-tail).join('\n'),
      stderr: stderrLines.slice(-tail).join('\n'),
      totalStdoutLines: stdoutLines.length,
      totalStderrLines: stderrLines.length,
    });
  } catch (error) {
    return c.json({ userId, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// GET /api/super/users/:id/state/v2 - Live synchronous state check
adminRouter.get('/users/:id/state/v2', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  const state = await getLiveState(userId, c.env);

  // Add last sync info from R2 if available
  try {
    const syncKey = `users/${userId}/.last-sync`;
    const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);
    if (syncObj) {
      const syncData = await syncObj.text();
      state.lastSyncAt = syncData.split('|')[0] || syncData;
    }
  } catch {
    // Ignore R2 errors
  }

  return c.json(state);
});

// GET /api/super/state/dashboard - Batch status for all users
adminRouter.get('/state/dashboard', requireSuperAuth, async (c) => {
  const startTime = Date.now();

  // Get list of all users (from R2)
  const userIds = await getAllUserIdsFromRegistry();

  if (userIds.length === 0) {
    return c.json({
      users: [],
      summary: {
        total: 0,
        active: 0,
        idle: 0,
        starting: 0,
        stopped: 0,
        error: 0,
      },
      totalLatencyMs: 0,
      checkedAt: new Date().toISOString(),
    });
  }

  // Check all containers in parallel
  const names = getUserNames();
  const checks = await Promise.all(
    userIds.map(async (userId) => {
      try {
        const state = await getLiveState(userId, c.env);
        return { ...state, name: names[userId] || userId.slice(0, 8) };
      } catch (error) {
        return {
          state: 'error' as const,
          userId,
          name: names[userId] || userId.slice(0, 8),
          processCount: 0,
          gatewayHealthy: null,
          checkedAt: new Date().toISOString(),
          latencyMs: 0,
          error: error instanceof Error ? error.message : 'Failed to check',
        };
      }
    })
  );

  const totalLatency = Date.now() - startTime;

  return c.json({
    users: checks,
    summary: {
      total: checks.length,
      active: checks.filter(c => c.state === 'active').length,
      idle: checks.filter(c => c.state === 'idle').length,
      starting: checks.filter(c => c.state === 'starting').length,
      stopped: checks.filter(c => c.state === 'stopped').length,
      error: checks.filter(c => c.state === 'error').length,
    },
    totalLatencyMs: totalLatency,
    checkedAt: new Date().toISOString(),
  });
});

// POST /api/super/users/:id/wake - Wake up container
adminRouter.post('/users/:id/wake', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const { ensureMoltbotGateway } = await import('../gateway');

  try {
    const sandbox = await getUserSandbox(c.env, userId, true);

    // Check current state
    let currentState: ContainerState = 'stopped';
    let existingProcess = null;

    try {
      const processes = await sandbox.listProcesses();
      existingProcess = processes.find((p: any) =>
        p.command?.includes('openclaw gateway') &&
        (p.status === 'running' || p.status === 'starting')
      );

      if (existingProcess) {
        currentState = 'active';
      } else if (processes.length > 0) {
        currentState = 'idle';
      } else {
        currentState = 'sleeping';
      }
    } catch {
      currentState = 'sleeping';
    }

    // If already active or idle, no-op
    if (currentState === 'active' || currentState === 'idle') {
      return c.json({
        userId,
        previousState: currentState,
        currentState: 'active',
        action: 'none',
        message: 'Container is already running',
      });
    }

    // Start the container
    console.log(`[WAKE] Waking up container for user ${userId}...`);

    // Kill any stale processes first (batch)
    try {
      await sandbox.killAllProcesses();
    } catch {
      // Ignore if can't kill processes
    }

    // Wait a moment for cleanup
    await new Promise(r => setTimeout(r, 1000));

    // Start gateway
    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch((err: Error) => {
      console.error(`[WAKE] Gateway start failed for ${userId}:`, err);
      throw err;
    });
    c.executionCtx.waitUntil(bootPromise);

    // Poll for health check (max 60 seconds)
    const maxWaitMs = 60000;
    const pollIntervalMs = 2000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));

      try {
        const processes = await sandbox.listProcesses();
        const gatewayProcess = processes.find((p: any) =>
          p.command?.includes('openclaw gateway') &&
          p.status === 'running'
        );

        if (gatewayProcess) {
          return c.json({
            userId,
            previousState: currentState,
            currentState: 'active',
            action: 'started',
            message: 'Container is now active',
            waitedMs: Date.now() - startTime,
          });
        }
      } catch {
        // Continue polling
      }
    }

    // Timeout
    return c.json({
      userId,
      previousState: currentState,
      currentState: 'error',
      action: 'timeout',
      message: 'Container failed to become ready within 60 seconds',
      waitedMs: maxWaitMs,
    }, 504);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
      message: 'Failed to wake container',
    }, 500);
  }
});

// Auto-wake middleware helper
async function withWake(env: any, userId: string, operation: () => Promise<Response>, executionCtx?: ExecutionContext): Promise<Response> {
  const sandbox = await getUserSandbox(env, userId, true);

  // Check if container needs waking — look for gateway process specifically
  let needsWake = false;
  try {
    const processes = await sandbox.listProcesses();
    const gatewayRunning = processes.some((p: any) =>
      (p.command?.includes('openclaw gateway') || p.command?.includes('openclaw-gateway') || p.command?.includes('start-moltbot.sh')) &&
      p.status === 'running'
    );
    if (!gatewayRunning) {
      needsWake = true;
    }
  } catch {
    needsWake = true;
  }

  // Wake if needed
  if (needsWake) {
    const { ensureMoltbotGateway } = await import('../gateway');
    console.log(`[AUTO-WAKE] Waking container for ${userId} before operation`);

    // Kill stale processes (batch)
    try {
      await sandbox.killAllProcesses();
    } catch {}

    await new Promise(r => setTimeout(r, 1000));

    // Start gateway
    const bootPromise = ensureMoltbotGateway(sandbox, env, userId).catch(() => {});
    
    // Use waitUntil if available to keep the worker alive
    if (executionCtx?.waitUntil) {
      executionCtx.waitUntil(bootPromise);
    }

    // Wait for it to be ready
    const maxWaitMs = 30000;
    const pollIntervalMs = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      try {
        const processes = await sandbox.listProcesses();
        if (processes.some((p: any) => p.command?.includes('openclaw gateway') && p.status === 'running')) {
          break;
        }
      } catch {}
    }
  }

  return await operation();
}

// Store for async exec results (in-memory, per-worker)
// For production, consider using Durable Objects or KV for persistence across workers
const asyncExecResults = new Map<string, {
  userId: string;
  command: string;
  status: 'running' | 'completed' | 'error';
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}>();

// POST /api/super/users/:id/exec - Execute command synchronously (waits for result)
adminRouter.post('/users/:id/exec', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  
  const {
    command,
    timeout = 10000,
    env: cmdEnv,
    workingDir,
  } = body;

  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, 400);
  }

  const fullCommand = workingDir
    ? `cd ${workingDir} && ${command}`
    : command;

  try {
    const sandbox = await getUserSandbox(c.env, userId, true);
    const proc = await sandbox.startProcess(fullCommand, { env: cmdEnv });
    
    // Wait for completion with a hard timeout
    const deadline = Date.now() + Math.min(timeout, 20000);
    while (proc.status === 'running' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));
    }
    
    const logs = await proc.getLogs();
    const timedOut = proc.status === 'running';
    
    return c.json({
      userId,
      command: fullCommand,
      status: timedOut ? 'timeout' : 'completed',
      exitCode: proc.exitCode ?? -1,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      userId,
      command: fullCommand,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

// GET /api/super/users/:id/exec/:execId/status - Poll async exec status
adminRouter.get('/users/:id/exec/:execId/status', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const execId = c.req.param('execId');

  const result = asyncExecResults.get(execId);

  if (!result) {
    return c.json({
      userId,
      execId,
      found: false,
      error: 'Exec result not found. It may have expired or never existed.',
    }, 404);
  }

  return c.json({
    execId,
    found: true,
    ...result,
  });
});

// =============================================================================
// Phase 1: Native File Operations
// =============================================================================

// GET /api/super/users/:id/files/:path{.+} - Read file from container
adminRouter.get('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const rawPath = c.req.param('path') || '';

  if (!rawPath) {
    return c.json({ error: 'File path is required' }, 400);
  }

  // Ensure path starts with / for absolute paths
  const filePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);

    try {
      // Use cat via startProcess — most reliable across SDK versions
      const { waitForProcess } = await import('../gateway/utils');
      const proc = await sandbox.startProcess(`cat '${filePath}' 2>&1`);
      await waitForProcess(proc, 5000);
      const logs = await proc.getLogs();
      
      if (proc.exitCode !== 0) {
        const stderr = logs.stderr || logs.stdout || '';
        if (stderr.includes('No such file') || stderr.includes('not found')) {
          return c.json({ userId, path: filePath, error: 'File not found' }, 404);
        }
        if (stderr.includes('Is a directory')) {
          // It's a directory — list it instead
          const lsProc = await sandbox.startProcess(`ls -la '${filePath}' 2>&1`);
          await waitForProcess(lsProc, 5000);
          const lsLogs = await lsProc.getLogs();
          return c.json({ userId, path: filePath, type: 'directory', listing: lsLogs.stdout || '' });
        }
        return c.json({ userId, path: filePath, error: stderr }, 500);
      }

      return c.json({
        userId,
        path: filePath,
        content: logs.stdout || '',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return c.json({
        userId,
        path: filePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });
});

// HEAD /api/super/users/:id/files/:path{.+}/exists - Check file exists and get metadata
adminRouter.get('/users/:id/files/:path{.+}/exists', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';

  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);

    try {
      const result = await sandbox.exists(path);

      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to check file existence',
        }, 500);
      }

      return c.json({
        userId,
        path,
        exists: result.exists,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// PUT /api/super/users/:id/files/:path{.+} - Write file using native SDK
adminRouter.put('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';

  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  // Get content from request body
  let content: string;
  try {
    const body = await c.req.json();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'Request body must have a "content" string field' }, 400);
    }
    content = body.content;
  } catch {
    // Try reading as plain text
    content = await c.req.text();
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);

    try {
      // Ensure directory exists
      const dirPath = path.substring(0, path.lastIndexOf('/')) || '/';
      if (dirPath !== '/') {
        await sandbox.mkdir(dirPath, { recursive: true });
      }

      // Use native writeFile SDK method
      const result = await sandbox.writeFile(path, content);

      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to write file',
          exitCode: result.exitCode,
        }, 500);
      }

      // Also backup to R2
      try {
        const r2Key = `users/${userId}/${path}`;
        await c.env.MOLTBOT_BUCKET.put(r2Key, content, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });
      } catch (r2Error) {
        console.log(`[WRITE] R2 backup failed for ${path}:`, r2Error);
        // Don't fail the request if R2 backup fails
      }

      return c.json({
        userId,
        path,
        success: true,
        bytesWritten: content.length,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// DELETE /api/super/users/:id/files/:path{.+} - Delete file
adminRouter.delete('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';

  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);

    try {
      const result = await sandbox.deleteFile(path);

      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to delete file',
          exitCode: result.exitCode,
        }, 500);
      }

      return c.json({
        userId,
        path,
        success: true,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// GET /api/super/users/:id/files - List files in directory
adminRouter.get('/users/:id/files', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const dirPath = c.req.query('path') || '/root';
  const recursive = c.req.query('recursive') === 'true';

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);

    try {
      const { waitForProcess } = await import('../gateway/utils');
      const cmd = recursive
        ? `find '${dirPath}' -type f 2>&1 | head -200`
        : `ls -la '${dirPath}' 2>&1`;
      const proc = await sandbox.startProcess(cmd);
      await waitForProcess(proc, 10000);
      const logs = await proc.getLogs();

      return c.json({
        userId,
        path: dirPath,
        recursive,
        output: logs.stdout || '',
        exitCode: proc.exitCode,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return c.json({
        userId,
        path: dirPath,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });
});

// =============================================================================
// Phase 3: R2 Dropbox Pattern
// =============================================================================

// POST /api/super/users/:id/config/reload - Trigger container to reload from R2
adminRouter.post('/users/:id/config/reload', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);

    try {
      // Trigger the container to reload config from R2
      // This uses a signal or special command to tell the gateway to reload
      const reloadProc = await sandbox.startProcess('killall -HUP openclaw 2>/dev/null || true');
      await new Promise(r => setTimeout(r, 1000));
      await reloadProc.getLogs();

      return c.json({
        userId,
        success: true,
        message: 'Config reload signal sent to container',
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        error: errorMessage,
        message: 'Failed to send reload signal',
      }, 500);
    }
  });
});

// GET /api/super/users/:id/config - Get config from R2 (R2-first pattern)
adminRouter.get('/users/:id/config', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  try {
    // Read from R2 first (R2-first pattern)
    const configKey = `users/${userId}/openclaw/openclaw.json`;
    const configObj = await c.env.MOLTBOT_BUCKET.get(configKey);

    if (!configObj) {
      return c.json({
        userId,
        error: 'Config not found in R2',
      }, 404);
    }

    const configText = await configObj.text();
    let config: any;
    try {
      config = JSON.parse(configText);
    } catch {
      return c.json({
        userId,
        error: 'Config is not valid JSON',
        raw: configText.substring(0, 1000),
      }, 500);
    }

    return c.json({
      userId,
      source: 'r2',
      config,
      lastModified: configObj.uploaded,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// PUT /api/super/users/:id/config - Update config in R2 (R2-first pattern)
adminRouter.put('/users/:id/config', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  let config: any;
  try {
    config = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Store old version for rollback capability
    const configKey = `users/${userId}/openclaw/openclaw.json`;
    const historyKey = `users/${userId}/openclaw/openclaw.json.history`;

    // Get existing config for history
    try {
      const existing = await c.env.MOLTBOT_BUCKET.get(configKey);
      if (existing) {
        const existingText = await existing.text();
        const historyEntry = {
          timestamp: new Date().toISOString(),
          config: JSON.parse(existingText),
        };

        // Append to history (simple approach - in production, consider limiting history size)
        const existingHistory = await c.env.MOLTBOT_BUCKET.get(historyKey);
        let history: any[] = [];
        if (existingHistory) {
          try {
            history = JSON.parse(await existingHistory.text());
          } catch {}
        }
        history.push(historyEntry);

        // Keep only last 10 versions
        if (history.length > 10) {
          history = history.slice(-10);
        }

        await c.env.MOLTBOT_BUCKET.put(historyKey, JSON.stringify(history, null, 2), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
    } catch {
      // Ignore history errors
    }

    // Write new config to R2
    const configText = JSON.stringify(config, null, 2);
    await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
      httpMetadata: { contentType: 'application/json' },
    });

    // Trigger container reload
    return await withWake(c.env, userId, async () => {
      const sandbox = await getUserSandbox(c.env, userId, true);

      // Write config to container as well
      try {
        await sandbox.mkdir('/root/.openclaw', { recursive: true });
        await sandbox.writeFile('/root/.openclaw/openclaw.json', configText);
      } catch (writeError) {
        console.log(`[CONFIG] Failed to write to container:`, writeError);
      }

      // Send reload signal
      try {
        const reloadProc = await sandbox.startProcess('killall -HUP openclaw 2>/dev/null || true');
        await new Promise(r => setTimeout(r, 500));
        await reloadProc.getLogs();
      } catch {
        // Ignore signal errors
      }

      return c.json({
        userId,
        success: true,
        message: 'Config updated in R2 and container',
        timestamp: new Date().toISOString(),
      });
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// GET /api/super/users/:id/config/history - Get config version history
adminRouter.get('/users/:id/config/history', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  try {
    const historyKey = `users/${userId}/openclaw/openclaw.json.history`;
    const historyObj = await c.env.MOLTBOT_BUCKET.get(historyKey);

    if (!historyObj) {
      return c.json({
        userId,
        history: [],
        count: 0,
      });
    }

    const historyText = await historyObj.text();
    let history: any[] = [];
    try {
      history = JSON.parse(historyText);
    } catch {
      return c.json({
        userId,
        error: 'History file is corrupted',
      }, 500);
    }

    return c.json({
      userId,
      history: history.map((h, i) => ({
        version: i + 1,
        timestamp: h.timestamp,
      })),
      count: history.length,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// POST /api/super/users/:id/config/rollback - Rollback to previous version
adminRouter.post('/users/:id/config/rollback', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { version } = body;

  if (!version || typeof version !== 'number' || version < 1) {
    return c.json({ error: 'Version number is required (1-indexed)' }, 400);
  }

  try {
    const historyKey = `users/${userId}/openclaw/openclaw.json.history`;
    const historyObj = await c.env.MOLTBOT_BUCKET.get(historyKey);

    if (!historyObj) {
      return c.json({
        userId,
        error: 'No history available for rollback',
      }, 404);
    }

    const historyText = await historyObj.text();
    let history: any[] = [];
    try {
      history = JSON.parse(historyText);
    } catch {
      return c.json({
        userId,
        error: 'History file is corrupted',
      }, 500);
    }

    // Version is 1-indexed from the end (1 = most recent)
    const historyIndex = history.length - version;
    if (historyIndex < 0 || historyIndex >= history.length) {
      return c.json({
        userId,
        error: `Invalid version. Available: 1-${history.length}`,
      }, 400);
    }

    const targetConfig = history[historyIndex].config;
    const configKey = `users/${userId}/openclaw/openclaw.json`;

    // Save current as new history entry
    const currentObj = await c.env.MOLTBOT_BUCKET.get(configKey);
    if (currentObj) {
      const currentText = await currentObj.text();
      history.push({
        timestamp: new Date().toISOString(),
        config: JSON.parse(currentText),
        note: 'Auto-saved before rollback',
      });
    }

    // Write rolled back config
    const configText = JSON.stringify(targetConfig, null, 2);
    await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
      httpMetadata: { contentType: 'application/json' },
    });

    // Update history
    await c.env.MOLTBOT_BUCKET.put(historyKey, JSON.stringify(history, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });

    // Update container
    return await withWake(c.env, userId, async () => {
      const sandbox = await getUserSandbox(c.env, userId, true);

      try {
        await sandbox.writeFile('/root/.openclaw/openclaw.json', configText);

        const reloadProc = await sandbox.startProcess('killall -HUP openclaw 2>/dev/null || true');
        await new Promise(r => setTimeout(r, 500));
        await reloadProc.getLogs();
      } catch {
        // Ignore container update errors
      }

      return c.json({
        userId,
        success: true,
        rolledBackTo: {
          version,
          timestamp: history[historyIndex].timestamp,
        },
        message: 'Config rolled back successfully',
      });
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// =============================================================================
// Cost Tracking Endpoints
// =============================================================================

// GET /api/super/cost - Get total cost summary across all users
adminRouter.get('/cost', requireSuperAuth, async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '30', 10);
    const threshold = c.req.query('threshold') ? parseFloat(c.req.query('threshold')!) : undefined;

    const { generateCostSummary } = await import('../lib/cost-tracking');
    const summary = await generateCostSummary(c.env, { days, threshold });

    return c.json(summary);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/users/:id - Get cost breakdown for specific user
adminRouter.get('/cost/users/:id', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  try {
    const days = parseInt(c.req.query('days') || '30', 10);

    const { getUserCostSummary, generateCostSummary } = await import('../lib/cost-tracking');
    const userCost = await getUserCostSummary(c.env, userId, { days });

    if (!userCost) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Get total for percentage calculation
    const totalSummary = await generateCostSummary(c.env, { days });
    userCost.percentageOfTotal = totalSummary.totalCost > 0
      ? (userCost.totalCost / totalSummary.totalCost) * 100
      : 0;

    return c.json({
      userId,
      userName: userCost.userName,
      period: totalSummary.period,
      cost: userCost,
      totalPlatformCost: totalSummary.totalCost,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/service/:service - Get cost breakdown by service type
adminRouter.get('/cost/service/:service', requireSuperAuth, async (c) => {
  const service = c.req.param('service') as 'workers' | 'r2' | 'durableObjects' | 'sandbox';

  if (!['workers', 'r2', 'durableObjects', 'sandbox'].includes(service)) {
    return c.json({ error: 'Invalid service type' }, 400);
  }

  try {
    const days = parseInt(c.req.query('days') || '30', 10);

    const { generateCostSummary } = await import('../lib/cost-tracking');
    const summary = await generateCostSummary(c.env, { days });

    const serviceBreakdown = summary.serviceBreakdown.find(s => s.service === service);

    if (!serviceBreakdown) {
      return c.json({ error: 'Service not found' }, 404);
    }

    // Get per-user breakdown for this service
    const userBreakdown = summary.userBreakdown.map(u => ({
      userId: u.userId,
      userName: u.userName,
      cost: service === 'workers' ? u.workers.cost :
            service === 'r2' ? u.r2.cost :
            service === 'durableObjects' ? u.durableObjects.cost : 0,
      details: service === 'workers' ? { requests: u.workers.requests, gbSeconds: u.workers.gbSeconds } :
               service === 'r2' ? { storageGB: u.r2.storageGB, operations: u.r2.operations } :
               service === 'durableObjects' ? { requests: u.durableObjects.requests, storageGB: u.durableObjects.storageGB } :
               {},
    }));

    return c.json({
      service,
      period: summary.period,
      summary: serviceBreakdown,
      users: userBreakdown.sort((a, b) => b.cost - a.cost),
      totalCost: summary.totalCost,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/trend - Get month-over-month cost trending
adminRouter.get('/cost/trend', requireSuperAuth, async (c) => {
  try {
    const { generateCostSummary, getBillingPeriod } = await import('../lib/cost-tracking');

    // Current period
    const currentDays = parseInt(c.req.query('days') || '30', 10);
    const currentSummary = await generateCostSummary(c.env, { days: currentDays });

    // Previous period for comparison
    const prevPeriod = getBillingPeriod(currentDays);
    const prevStart = new Date(prevPeriod.start);
    prevStart.setDate(prevStart.getDate() - currentDays);
    const prevEnd = new Date(prevPeriod.start);

    // Calculate mock previous period costs (would use historical data in production)
    // For now, estimate based on current trend
    const trendFactor = 0.95; // Assume 5% growth month-over-month as default

    return c.json({
      current: {
        period: currentSummary.period,
        totalCost: currentSummary.totalCost,
        userCount: currentSummary.userCount,
        serviceBreakdown: currentSummary.serviceBreakdown,
      },
      previous: {
        period: {
          start: prevStart.toISOString(),
          end: prevEnd.toISOString(),
          days: currentDays,
        },
        estimatedTotalCost: currentSummary.totalCost * trendFactor,
        estimatedChange: ((currentSummary.totalCost - (currentSummary.totalCost * trendFactor)) / (currentSummary.totalCost * trendFactor)) * 100,
      },
      trends: currentSummary.trends,
      note: 'Historical data tracking not yet implemented - showing estimates based on current usage',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/check - Check cost against threshold
adminRouter.get('/cost/check', requireSuperAuth, async (c) => {
  try {
    const threshold = parseFloat(c.req.query('threshold') || '50');
    const days = parseInt(c.req.query('days') || '30', 10);

    const { checkCostThreshold } = await import('../lib/cost-tracking');
    const result = await checkCostThreshold(c.env, threshold, { days });

    return c.json({
      check: {
        threshold,
        days,
        exceeded: result.exceeded,
        current: result.current,
        remaining: Math.max(0, threshold - result.current),
        percentUsed: (result.current / threshold) * 100,
      },
      alerts: result.alerts,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/rates - Get current pricing rates
adminRouter.get('/cost/rates', requireSuperAuth, async (c) => {
  const { COST_RATES } = await import('../lib/cost-tracking');

  return c.json({
    rates: COST_RATES,
    description: {
      workers: 'Cloudflare Workers - per million requests and GB-seconds',
      r2: 'R2 Object Storage - per GB-month storage and million operations',
      durableObjects: 'Durable Objects - per billion requests and GB-month storage',
    },
    effectiveDate: '2025-01-01',
    source: 'Cloudflare published pricing',
  });
});

// =============================================================================
// Deep Merge Helper
// =============================================================================

/**
 * Deep merge two objects. Arrays are replaced, not concatenated.
 * Source values override target values at each level.
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

// =============================================================================
// PATCH Config (Deep Merge)
// =============================================================================

/**
 * PATCH /api/super/users/:id/config - Deep merge patch into existing config
 * Reads existing config from R2, deep merges the patch, writes back.
 * Preserves existing channels/settings not mentioned in the patch.
 */
adminRouter.patch('/users/:id/config', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  let patch: any;
  try {
    patch = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const configKey = `users/${userId}/openclaw/openclaw.json`;

    // GET existing config
    const existing = await c.env.MOLTBOT_BUCKET.get(configKey);
    let currentConfig: any = {};
    if (existing) {
      try {
        currentConfig = JSON.parse(await existing.text());
      } catch {
        return c.json({ error: 'Existing config is not valid JSON' }, 500);
      }
    }

    // Deep merge
    const merged = deepMerge(currentConfig, patch);
    const configText = JSON.stringify(merged, null, 2);

    // Save history
    try {
      const historyKey = `users/${userId}/openclaw/openclaw.json.history`;
      const existingHistory = await c.env.MOLTBOT_BUCKET.get(historyKey);
      let history: any[] = [];
      if (existingHistory) {
        try { history = JSON.parse(await existingHistory.text()); } catch {}
      }
      history.push({ timestamp: new Date().toISOString(), config: currentConfig });
      if (history.length > 10) history = history.slice(-10);
      await c.env.MOLTBOT_BUCKET.put(historyKey, JSON.stringify(history, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      });
    } catch { /* ignore history errors */ }

    // PUT merged config
    await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
      httpMetadata: { contentType: 'application/json' },
    });

    // Update container
    try {
      const sandbox = await getUserSandbox(c.env, userId, true);
      await sandbox.mkdir('/root/.openclaw', { recursive: true });
      await sandbox.writeFile('/root/.openclaw/openclaw.json', configText);
      const reloadProc = await sandbox.startProcess('killall -HUP openclaw 2>/dev/null || true');
      await new Promise(r => setTimeout(r, 500));
      await reloadProc.getLogs();
    } catch {
      // Container may not be running - R2 config will be picked up on next start
    }

    return c.json({
      userId,
      success: true,
      message: 'Config patched (deep merge) in R2 and container',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      userId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

// =============================================================================
// Bulk Operations
// =============================================================================

/**
 * POST /api/super/bulk/config-patch
 * Apply a config patch (deep merge) to all or specified users.
 * Body: { patch: {...}, userIds?: string[] }
 */
adminRouter.post('/bulk/config-patch', requireSuperAuth, async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { patch, userIds: requestedIds } = body;
  if (!patch || typeof patch !== 'object') {
    return c.json({ error: 'patch object is required' }, 400);
  }

  const allUserIds = await getAllUserIdsFromRegistry();
  const targetIds = requestedIds && Array.isArray(requestedIds) ? requestedIds : allUserIds;

  const results: Array<{ userId: string; success: boolean; error?: string }> = [];

  for (const userId of targetIds) {
    try {
      const configKey = `users/${userId}/openclaw/openclaw.json`;
      const existing = await c.env.MOLTBOT_BUCKET.get(configKey);
      let currentConfig: any = {};
      if (existing) {
        try { currentConfig = JSON.parse(await existing.text()); } catch {}
      }

      const merged = deepMerge(currentConfig, patch);
      const configText = JSON.stringify(merged, null, 2);

      await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
        httpMetadata: { contentType: 'application/json' },
      });

      // Try to update container (best effort)
      try {
        const sandbox = await getUserSandbox(c.env, userId, true);
        await sandbox.mkdir('/root/.openclaw', { recursive: true });
        await sandbox.writeFile('/root/.openclaw/openclaw.json', configText);
      } catch { /* container may not be running */ }

      results.push({ userId, success: true });
    } catch (error) {
      results.push({ userId, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  return c.json({
    success: results.every(r => r.success),
    total: results.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/super/bulk/restart
 * Sequentially restart all or specified user containers.
 * Body: { userIds?: string[], delayMs?: number }
 * Default delay: 5000ms between restarts.
 */
adminRouter.post('/bulk/restart', requireSuperAuth, async (c) => {
  let body: any;
  try {
    body = await c.req.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const { userIds: requestedIds, delayMs = 5000 } = body;
  const allUserIds = await getAllUserIdsFromRegistry();
  const targetIds = requestedIds && Array.isArray(requestedIds) ? requestedIds : allUserIds;

  const results: Array<{ userId: string; success: boolean; error?: string }> = [];

  // Run restarts sequentially in background so we can return immediately
  const restartPromise = (async () => {
    for (let i = 0; i < targetIds.length; i++) {
      const userId = targetIds[i];
      try {
        console.log(`[BULK-RESTART] (${i + 1}/${targetIds.length}) Restarting ${userId.slice(0, 8)}...`);
        const sandbox = await getUserSandbox(c.env, userId, true);

        // Kill all processes
        try {
          await sandbox.killAllProcesses();
        } catch {
          try {
            await sandbox.exec('kill -9 -1 2>/dev/null; true', { timeout: 5000 });
          } catch { /* ignore */ }
        }

        await new Promise(r => setTimeout(r, 2000));

        // Clear locks
        try {
          await sandbox.exec('rm -f /tmp/openclaw*.lock /root/.openclaw/*.lock 2>/dev/null', { timeout: 5000 });
        } catch { /* ignore */ }

        // Start gateway
        const { ensureMoltbotGateway } = await import('../gateway');
        await ensureMoltbotGateway(sandbox, c.env, userId);

        console.log(`[BULK-RESTART] (${i + 1}/${targetIds.length}) ✅ ${userId.slice(0, 8)} restarted`);
        results.push({ userId, success: true });
      } catch (error) {
        console.error(`[BULK-RESTART] (${i + 1}/${targetIds.length}) ❌ ${userId.slice(0, 8)}:`, error);
        results.push({ userId, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }

      // Delay between restarts (skip after last)
      if (i < targetIds.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    console.log(`[BULK-RESTART] Complete: ${results.filter(r => r.success).length}/${results.length} succeeded`);
  })();

  c.executionCtx.waitUntil(restartPromise);

  return c.json({
    message: 'Bulk restart initiated in background',
    total: targetIds.length,
    delayMs,
    estimatedDurationMs: targetIds.length * (delayMs + 5000),
    checkStatusUrl: '/api/super/state/dashboard',
    timestamp: new Date().toISOString(),
  });
});

// POST /api/super/users/:id/message - Send message to container via openclaw agent CLI
// Connects to the gateway over WebSocket and runs an agent turn
adminRouter.post('/users/:id/message', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { message, sessionKey } = body;

  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message (string) is required' }, 400);
  }

  const session = sessionKey || `admin-${Date.now()}`;

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);

    // Write message to temp file to avoid shell escaping issues
    const tmpFile = `/tmp/admin-msg-${Date.now()}.txt`;
    await sandbox.writeFile(tmpFile, message);

    const cmd = [
      'openclaw agent',
      `--message "$(cat ${tmpFile})"`,
      `--session-id "${session}"`,
      '--json',
      '--timeout 60',
      `2>&1; rm -f ${tmpFile}`,
    ].join(' ');

    const proc = await sandbox.startProcess(cmd);

    // Poll for completion (up to ~25s for Worker timeout safety)
    const deadline = Date.now() + 25_000;
    let output = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      const logs = await proc.getLogs();
      output = logs.stdout || '';
      // Look for JSON output (openclaw agent --json outputs a JSON object)
      if (output.includes('"status"')) break;
    }

    // Strip deprecation warnings and other non-JSON preamble
    const jsonStart = output.indexOf('{');
    const jsonContent = jsonStart >= 0 ? output.slice(jsonStart) : '';

    if (!jsonContent.trim()) {
      return c.json({
        status: 'pending',
        userId,
        sessionKey: session,
        note: 'Message sent but response not yet available. Check session history.',
        rawOutput: output || undefined,
      }, 202);
    }

    try {
      const parsed = JSON.parse(jsonContent);
      // Extract the text reply from the agent response
      const text = parsed.result?.payloads?.[0]?.text;
      return c.json({
        status: parsed.status === 'ok' ? 'complete' : parsed.status,
        userId,
        sessionKey: session,
        reply: text || null,
        response: parsed,
      });
    } catch {
      return c.json({
        status: 'complete',
        userId,
        sessionKey: session,
        rawOutput: output,
      });
    }
  });
});

// GET /api/super/users/:id/sessions - List agent sessions in container
adminRouter.get('/users/:id/sessions', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    const proc = await sandbox.startProcess(
      'ls -la /root/.openclaw/agents/main/sessions/ 2>/dev/null | tail -20'
    );
    await new Promise(r => setTimeout(r, 2000));
    const logs = await proc.getLogs();
    return c.json({ userId, sessions: logs.stdout || 'No sessions found' });
  });
});

export { adminRouter };
