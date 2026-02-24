/**
 * Admin API Routes
 * Fleet management endpoints for the Admin API Worker
 */

import { Hono } from 'hono';
import { isSandboxNotReadyError, waitForSandboxReady, withRetry } from '../sandbox-resilience.js';

// Inline shared types and constants
interface AdminApiAppEnv {
  Bindings: {
    EXEC_RESULT_STORE: DurableObjectNamespace;
    Sandbox: DurableObjectNamespace;
    SandboxStandard1: DurableObjectNamespace;
    SandboxStandard2: DurableObjectNamespace;
    SandboxStandard3: DurableObjectNamespace;
    MOLTBOT_BUCKET: R2Bucket;
    RELAY: KVNamespace;
    PLATFORM_DB: D1Database;
    MOLTBOT_GATEWAY_MASTER_TOKEN: string;
  };
}

const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

const CONTAINER_STATES = {
  ACTIVE: 'active',
  IDLE: 'idle',
  SLEEPING: 'sleeping',
  STOPPED: 'stopped',
  ERROR: 'error',
  STARTING: 'starting',
} as const;

const DEFAULT_USER_REGISTRY = [
  { userId: '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b', name: 'jack', tier: 3 },
  { userId: '81bf6a68-28fe-48ef-b257-f9ad013e6298', name: 'josh', tier: 1 },
  { userId: 'fe56406b-a723-43cf-9f19-ba2ffcb135b0', name: 'miles', tier: 1 },
  { userId: '38b1ec2b-7a70-4834-a48d-162b8902b0fd', name: 'kyla', tier: 1 },
  { userId: '0f1195c1-6b57-4254-9871-6ef3b7fa360c', name: 'rhys', tier: 1 },
  { userId: 'e29fd082-6811-4e29-893e-64699c49e1f0', name: 'ben_lippold', tier: 1 },
  { userId: '6d575ef4-7ac8-4a17-b732-e0e690986e58', name: 'david_geddes', tier: 1 },
  { userId: 'aef3677b-afdf-4a7e-bbeb-c596f0d94d29', name: 'adnan', tier: 1 },
  { userId: '5bb7d208-2baf-4c95-8aec-f28e016acedb', name: 'david_lippold', tier: 1 },
  { userId: 'f1647b02-c311-49c3-9c72-48b8fc5da350', name: 'joe_james', tier: 1 },
];

function getSandboxName(userId: string): string {
  return `openclaw-${userId}`;
}

function generateExecId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function validateAdminSecret(headers: Headers, masterToken: string): boolean {
  const secret = headers.get('X-Admin-Secret');
  return secret === masterToken;
}

function getGatewayMasterToken(env: AdminApiAppEnv['Bindings']): string {
  return env.MOLTBOT_GATEWAY_MASTER_TOKEN || '';
}

// Import gateway utilities (shim for worker isolation)
import { getSandboxForUser, ensureMoltbotGateway, checkHealth } from '../gateway-shim.js';
import { backupToR2 } from '../../../../src/gateway/tar-backup.js';

const adminRouter = new Hono<AdminApiAppEnv>();

// =============================================================================
// Authentication Middleware
// =============================================================================

adminRouter.use('*', async (c, next) => {
  const masterToken = getGatewayMasterToken(c.env);
  const isValid = validateAdminSecret(c.req.raw.headers, masterToken);
  
  if (!isValid) {
    return c.json({
      error: 'Super admin access required',
      hint: 'Provide X-Admin-Secret header',
    }, HTTP_STATUS.FORBIDDEN);
  }
  
  c.set('isSuperAdmin', true);
  await next();
});

// =============================================================================
// Helper Functions
// =============================================================================

async function getUserSandbox(env: AdminApiAppEnv['Bindings'], userId: string, keepAlive = false) {
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = getSandboxName(userId);
  const sandboxBinding = getSandboxForUser(env, userId);
  
  return getSandbox(sandboxBinding, sandboxName, {
    keepAlive,
    containerTimeouts: {
      instanceGetTimeoutMS: 30000,
      portReadyTimeoutMS: 60000,
    },
  });
}

async function getLiveState(userId: string, env: AdminApiAppEnv['Bindings']) {
  const startTime = Date.now();
  
  try {
    const sandbox = await getUserSandbox(env, userId, false);

    // Best-effort readiness: avoid misclassifying cold-start as STOPPED.
    await waitForSandboxReady(sandbox, { timeoutMs: 8000, intervalMs: 400 });

    const procRes = await withRetry<any[]>(async () => sandbox.listProcesses(), {
      retries: 3,
      baseDelayMs: 200,
      maxDelayMs: 1500,
    });

    if (!procRes.value) {
      const processError = procRes.lastError;
      return {
        state: CONTAINER_STATES.STOPPED,
        userId,
        processCount: 0,
        gatewayHealthy: null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        error: processError instanceof Error ? processError.message : 'Failed to list processes',
      };
    }

    const processes: any[] = procRes.value;
    
    if (processes.length === 0) {
      return {
        state: CONTAINER_STATES.IDLE,
        userId,
        processCount: 0,
        gatewayHealthy: null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
      };
    }
    
    // Check gateway health
    const gatewayHealthy = await checkGatewayHealth(sandbox);
    
    return {
      state: gatewayHealthy ? CONTAINER_STATES.ACTIVE : 'starting',
      userId,
      processCount: processes.length,
      gatewayHealthy,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      state: CONTAINER_STATES.STOPPED,
      userId,
      processCount: 0,
      gatewayHealthy: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function checkGatewayHealth(sandbox: any): Promise<boolean> {
  try {
    const response = await sandbox.containerFetch(
      new Request('http://localhost:18789/'),
      18789
    );
    return response.status > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// User Registry Routes
// =============================================================================

adminRouter.get('/users', async (c) => {
  const registry = DEFAULT_USER_REGISTRY.map(u => ({
    ...u,
    status: 'active',
    createdAt: new Date().toISOString(),
  }));
  
  return c.json({
    users: registry,
    total: registry.length,
    active: registry.length,
  });
});

adminRouter.get('/users/lookup/:name', async (c) => {
  const name = c.req.param('name');
  const user = DEFAULT_USER_REGISTRY.find(
    u => u.name.toLowerCase() === name.toLowerCase()
  );
  
  if (!user) {
    return c.json({ error: `No user found matching "${name}"` }, HTTP_STATUS.NOT_FOUND);
  }
  
  return c.json({
    ...user,
    status: 'active',
    createdAt: new Date().toISOString(),
  });
});

// =============================================================================
// R2-Only Endpoints (No DO interaction)
// =============================================================================

adminRouter.post('/users/:id/backup-now', async (c) => {
  const userId = c.req.param('id');
  const r2Prefix = `users/${userId}`;

  // Fire-and-forget: backups can take longer than typical HTTP timeouts.
  // We start it in the background and return 202 immediately.
  c.executionCtx.waitUntil((async () => {
    try {
      const sandbox = await getUserSandbox(c.env, userId, true);
      await ensureMoltbotGateway(sandbox, c.env, userId);
      const result = await backupToR2(sandbox as any, c.env as any, r2Prefix);
      console.log('[backup-now]', userId.slice(0, 8), result);
    } catch (err) {
      console.error('[backup-now] failed', userId.slice(0, 8), err);
    }
  })());

  return c.json({ userId, r2Prefix, status: 'started', timestamp: new Date().toISOString() }, 202);
});

adminRouter.get('/users/:id/r2-status', async (c) => {
  const userId = c.req.param('id');
  
  try {
    const prefix = `users/${userId}/`;
    
    // Check for backup.tar.gz
    const backupHead = await c.env.MOLTBOT_BUCKET.head(`${prefix}backup.tar.gz`);
    
    // Check legacy formats
    const legacyListed = await c.env.MOLTBOT_BUCKET.list({ prefix: `${prefix}root/`, limit: 1 });
    const hasLegacyRoot = legacyListed.objects.length > 0;
    const openlawListed = await c.env.MOLTBOT_BUCKET.list({ prefix: `${prefix}openclaw/`, limit: 1 });
    const hasLegacyOpenclaw = openlawListed.objects.length > 0;
    
    const backupFormat = backupHead ? 'tar' : 
                         hasLegacyRoot ? 'legacy-root' : 
                         hasLegacyOpenclaw ? 'legacy-openclaw' : 'none';
    
    // Get sync marker
    const lastSync = await c.env.MOLTBOT_BUCKET.get(`${prefix}.last-sync`);
    
    // Parse last sync time
    let syncTime: Date | null = null;
    let minutesSinceSync: number | null = null;
    
    if (lastSync) {
      const syncText = await lastSync.text();
      const timestamp = syncText.split('|')[1] || syncText;
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) {
        syncTime = parsed;
        minutesSinceSync = Math.round((Date.now() - parsed.getTime()) / 60000);
      }
    }
    
    return c.json({
      userId,
      backupFormat,
      hasBackup: backupFormat !== 'none',
      backup: backupHead ? {
        sizeBytes: backupHead.size,
        sizeMB: Math.round(backupHead.size / 1024 / 1024 * 100) / 100,
        uploaded: backupHead.uploaded?.toISOString(),
      } : null,
      lastSync: syncTime?.toISOString() || null,
      minutesSinceSync,
      healthy: minutesSinceSync !== null && minutesSinceSync < 5,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// =============================================================================
// Container State Routes
// =============================================================================

adminRouter.get('/users/:id/state', async (c) => {
  const userId = c.req.param('id');
  
  try {
    const sandbox = await getUserSandbox(c.env, userId, false);
    
    const status = {
      state: CONTAINER_STATES.STOPPED,
      lastActivity: null as string | null,
      processCount: 0,
      memoryMB: null as number | null,
      uptimeSeconds: null as number | null,
      version: null as string | null,
    };
    
    try {
      const processes = await sandbox.listProcesses();
      status.processCount = processes.length;
      
      const gatewayProcess = processes.find((p: any) =>
        p.command?.includes('openclaw gateway') &&
        (p.status === 'running' || p.status === 'starting')
      );
      
      if (gatewayProcess) {
        status.state = CONTAINER_STATES.ACTIVE;
        status.lastActivity = gatewayProcess.startTime?.toISOString() || null;
        
        if (gatewayProcess.startTime) {
          status.uptimeSeconds = Math.floor(
            (Date.now() - gatewayProcess.startTime.getTime()) / 1000
          );
        }
      } else if (processes.length > 0) {
        status.state = CONTAINER_STATES.IDLE;
      }
    } catch (sandboxError) {
      status.state = CONTAINER_STATES.SLEEPING;
    }
    
    // Check R2 for last sync
    try {
      const syncKey = `users/${userId}/.last-sync`;
      const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);
      if (syncObj && !status.lastActivity) {
        const syncData = await syncObj.text();
        status.lastActivity = syncData.split('|')[0] || syncData;
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
    return c.json({
      userId,
      state: CONTAINER_STATES.ERROR,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

adminRouter.get('/users/:id/state/v2', async (c) => {
  const userId = c.req.param('id');
  const state = await getLiveState(userId, c.env);
  
  // Add last sync info
  try {
    const syncKey = `users/${userId}/.last-sync`;
    const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);
    if (syncObj) {
      const syncData = await syncObj.text();
      state.lastSyncAt = syncData.split('|')[0] || syncData;
    }
  } catch {
    // Ignore
  }
  
  return c.json(state);
});

adminRouter.get('/state/dashboard', async (c) => {
  const startTime = Date.now();
  const userIds = DEFAULT_USER_REGISTRY.map(u => u.userId);

  const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    let t: any;
    const timeout = new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(t);
    }
  };

  // IMPORTANT: never let one wedged Sandbox DO stall the entire dashboard.
  const checks = await Promise.all(
    userIds.map(async (userId) => {
      try {
        return await withTimeout(getLiveState(userId, c.env), 8000, `getLiveState(${userId.slice(0, 8)})`);
      } catch (error) {
        return {
          state: CONTAINER_STATES.ERROR,
          userId,
          name: DEFAULT_USER_REGISTRY.find(u => u.userId === userId)?.name || userId.slice(0, 8),
          processCount: 0,
          gatewayHealthy: null,
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : 'Failed to check',
        };
      }
    })
  );

  const totalLatency = Date.now() - startTime;

  return c.json({
    users: checks.map(c => ({
      ...c,
      name: DEFAULT_USER_REGISTRY.find(u => u.userId === c.userId)?.name || c.userId.slice(0, 8),
    })),
    summary: {
      total: checks.length,
      active: checks.filter(c => c.state === CONTAINER_STATES.ACTIVE).length,
      idle: checks.filter(c => c.state === CONTAINER_STATES.IDLE).length,
      starting: checks.filter(c => c.state === 'starting').length,
      stopped: checks.filter(c => c.state === CONTAINER_STATES.STOPPED).length,
      error: checks.filter(c => c.state === CONTAINER_STATES.ERROR).length,
    },
    totalLatencyMs: totalLatency,
    checkedAt: new Date().toISOString(),
  });
});

// =============================================================================
// Lifecycle Routes
// =============================================================================

adminRouter.post('/users/:id/restart-async', async (c) => {
  const userId = c.req.param('id');
  
  try {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    const restartPromise = (async () => {
      try {
        console.log(`[ASYNC-RESTART] Starting restart for ${userId.slice(0, 8)}...`);
        
        try {
          const killed = await sandbox.killAllProcesses();
          console.log(`[ASYNC-RESTART] Killed ${killed} processes`);
        } catch (e) {
          console.warn(`[ASYNC-RESTART] killAllProcesses() failed:`, e);
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
        await ensureMoltbotGateway(sandbox, c.env, userId);

        // Verify gateway health (this is the real success criteria)
        const healthy = await checkHealth(sandbox);
        if (!healthy) {
          let logTail = '';
          try {
            const r = await sandbox.exec('tail -n 120 /tmp/moltbot-startup.log 2>/dev/null || true', { timeout: 5000 });
            logTail = r.stdout || '';
          } catch {}
          throw new Error(`Gateway not healthy after restart\n--- startup log tail ---\n${logTail}`);
        }

        console.log(`[ASYNC-RESTART] Gateway healthy for ${userId.slice(0, 8)}`);
      } catch (err) {
        console.error(`[ASYNC-RESTART] Failed for ${userId.slice(0, 8)}:`, err);
      }
    })();
    
    c.executionCtx.waitUntil(restartPromise);
    
    return c.json({
      success: true,
      userId,
      message: 'Restart initiated in background',
      checkStatusUrl: `/api/super/users/${userId}/r2-status`,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

adminRouter.post('/bulk/restart', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { userIds: requestedIds, delayMs = 5000 } = body;
  
  const allUserIds = DEFAULT_USER_REGISTRY.map(u => u.userId);
  const targetIds = requestedIds && Array.isArray(requestedIds) ? requestedIds : allUserIds;
  
  const restartPromise = (async () => {
    for (let i = 0; i < targetIds.length; i++) {
      const userId = targetIds[i];
      try {
        console.log(`[BULK-RESTART] (${i + 1}/${targetIds.length}) Restarting ${userId.slice(0, 8)}...`);
        const sandbox = await getUserSandbox(c.env, userId, true);
        
        try {
          await sandbox.killAllProcesses();
        } catch {
          try {
            await sandbox.exec('kill -9 -1 2>/dev/null; true', { timeout: 5000 });
          } catch { /* ignore */ }
        }
        
        await new Promise(r => setTimeout(r, 2000));
        
        try {
          await sandbox.exec('rm -f /tmp/openclaw*.lock /root/.openclaw/*.lock 2>/dev/null', { timeout: 5000 });
        } catch { /* ignore */ }
        
        await ensureMoltbotGateway(sandbox, c.env, userId);

        const healthy = await checkHealth(sandbox);
        if (!healthy) {
          let logTail = '';
          try {
            const r = await sandbox.exec('tail -n 120 /tmp/moltbot-startup.log 2>/dev/null || true', { timeout: 5000 });
            logTail = r.stdout || '';
          } catch {}
          throw new Error(`Gateway not healthy after restart\n--- startup log tail ---\n${logTail}`);
        }
        
        console.log(`[BULK-RESTART] (${i + 1}/${targetIds.length}) ${userId.slice(0, 8)} healthy`);
      } catch (error) {
        console.error(`[BULK-RESTART] (${i + 1}/${targetIds.length}) ${userId.slice(0, 8)} failed:`, error);
      }
      
      if (i < targetIds.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  })();
  
  c.executionCtx.waitUntil(restartPromise);
  
  return c.json({
    message: 'Bulk restart initiated in background',
    total: targetIds.length,
    delayMs,
    estimatedDurationMs: targetIds.length * (delayMs + 5000),
    checkStatusUrl: '/api/super/state/dashboard',
  });
});

// =============================================================================
// Sync Exec (quick commands, ≤15s, returns stdout inline)
// =============================================================================

adminRouter.post('/users/:id/exec-sync', async (c) => {
  const userId = c.req.param('id');
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, HTTP_STATUS.BAD_REQUEST);
  }
  
  const { command, timeout = 15000 } = body;
  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, HTTP_STATUS.BAD_REQUEST);
  }
  
  // Cap at 20s to stay within worker 30s limit
  const cappedTimeout = Math.min(timeout, 20000);
  
  try {
    const sandbox = await getUserSandbox(c.env, userId, true);
    const result = await sandbox.exec(command, { timeout: cappedTimeout });
    
    return c.json({
      userId,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      userId,
      command,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// =============================================================================
// Message endpoint — send a message to a bot's gateway via openclaw agent CLI
//
// IMPORTANT: This endpoint used to contribute to DO overload by repeatedly
// hitting a sick control-plane. We add:
//   - circuit breaker (short-circuit for a short window after overload)
//   - dedupe (collapse identical requests for a short window)
//   - tighter timeouts (keep Worker requests bounded)
// =============================================================================

adminRouter.post('/users/:id/message', async (c) => {
  const userId = c.req.param('id');

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, HTTP_STATUS.BAD_REQUEST);
  }

  const { message, sessionKey } = body;
  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message is required' }, HTTP_STATUS.BAD_REQUEST);
  }

  // Circuit breaker (cache-backed): if we recently saw overload, stop piling on.
  const breakerKey = new Request(`https://admin-api.internal/cb/message/${userId}`);
  const breakerHit = await caches.default.match(breakerKey);
  if (breakerHit) {
    const info = await breakerHit.json().catch(() => ({} as any));
    return c.json(
      {
        userId,
        error: 'circuit_open',
        message: 'Message endpoint temporarily disabled due to recent overload. Try again shortly.',
        retryAfterSeconds: info?.retryAfterSeconds ?? 60,
      },
      503,
      {
        'Retry-After': String(info?.retryAfterSeconds ?? 60),
        'Cache-Control': 'no-store',
      }
    );
  }

  // Dedupe identical requests briefly to prevent retry storms (cache-backed).
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${userId}|${sessionKey ?? ''}|${message}`)
  );
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const dedupeKey = new Request(`https://admin-api.internal/dedupe/message/${hashHex}`);
  const deduped = await caches.default.match(dedupeKey);
  if (deduped) {
    // Return exact cached response
    const cachedText = await deduped.text();
    return new Response(cachedText, {
      status: deduped.status,
      headers: {
        'Content-Type': 'application/json',
        'X-Deduped': '1',
        'Cache-Control': 'no-store',
      },
    });
  }

  try {
    const sandbox = await getUserSandbox(c.env, userId, true);

    const ready = await waitForSandboxReady(sandbox, { timeoutMs: 20000, intervalMs: 500 });
    if (!ready.ready) {
      const lastError = ready.lastError instanceof Error ? ready.lastError.message : String(ready.lastError ?? 'sandbox_not_ready');
      return c.json(
        { userId, error: 'sandbox_not_ready', attempts: ready.attempts, lastError, retryAfterSeconds: 30 },
        503,
        { 'Retry-After': '30', 'Cache-Control': 'no-store' }
      );
    }

    // Ensure gateway is running first
    await ensureMoltbotGateway(sandbox, c.env, userId);

    // Use gateway hook directly (avoids hanging exec sessions and CLI/model mismatches)
    // Derive the same per-user gateway token we use for gateway.auth.token.
    const master = c.env.MOLTBOT_GATEWAY_MASTER_TOKEN || '';
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`gateway-token:${userId}`));
    const token = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

    const hookPayload: any = {
      message,
      name: 'Admin',
      sessionKey: sessionKey || undefined,
      deliver: true,
      channel: 'telegram',
      to: '5322411764',
      thinking: 'minimal',
    };

    const hookReq = new Request('http://localhost:18789/hooks/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openclaw-token': token,
      },
      body: JSON.stringify(hookPayload),
    });

    // Fire-and-forget delivery by starting a process in the sandbox. This avoids
    // the exec-result DO plumbing (which can wedge under load) and avoids waiting
    // for Telegram API latency.
    const safeMsg = message.replace(/"/g, '\\"');
    const deliverCmd = `sh -lc "openclaw message send --channel telegram --target 5322411764 --message \"${safeMsg}\""`;

    const delivery = await withRetry(async () => {
      await sandbox.startProcess(deliverCmd);
      return true;
    }, {
      retries: 4,
      baseDelayMs: 250,
      maxDelayMs: 4000,
    });

    if (!delivery.value) {
      const lastError = delivery.lastError instanceof Error ? delivery.lastError.message : String(delivery.lastError ?? 'delivery_failed');
      const retryAfterSeconds = 30;
      return c.json(
        { userId, error: 'delivery_failed', attempts: delivery.attempts, lastError, retryAfterSeconds },
        503,
        { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' }
      );
    }

    const payload = {
      userId,
      message,
      status: 202,
      response: 'started',
      timestamp: new Date().toISOString(),
    };

    const resp = c.json(payload);

    // Cache success briefly for dedupe.
    // NOTE: caches.default respects Cache-Control: max-age.
    c.executionCtx.waitUntil(
      caches.default.put(
        dedupeKey,
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60',
          },
        })
      )
    );

    return resp;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    if (isSandboxNotReadyError(error)) {
      const retryAfterSeconds = 30;
      return c.json(
        { userId, error: 'sandbox_not_ready', lastError: msg, retryAfterSeconds },
        503,
        { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' }
      );
    }

    // If we detect overload symptoms, open the circuit for 2 minutes.
    const isOverload = /overloaded|Too many requests queued/i.test(msg);
    if (isOverload) {
      const retryAfterSeconds = 120;
      c.executionCtx.waitUntil(
        caches.default.put(
          breakerKey,
          new Response(JSON.stringify({ retryAfterSeconds }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `public, max-age=${retryAfterSeconds}`,
            },
          })
        )
      );
    }

    const payload = {
      userId,
      error: msg,
      circuitOpened: isOverload || undefined,
      timestamp: new Date().toISOString(),
    };

    // Cache error briefly for dedupe (prevents hammering on repeat).
    c.executionCtx.waitUntil(
      caches.default.put(
        dedupeKey,
        new Response(JSON.stringify(payload), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=15',
          },
        })
      )
    );

    return c.json(payload, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// =============================================================================
// Exec Routes with DO Persistence (async, for long-running commands)
// =============================================================================

adminRouter.post('/users/:id/exec', async (c) => {
  const userId = c.req.param('id');
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, HTTP_STATUS.BAD_REQUEST);
  }
  
  const {
    command,
    timeout = 30000,
    env: cmdEnv,
    workingDir,
  } = body;
  
  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, HTTP_STATUS.BAD_REQUEST);
  }
  
  const fullCommand = workingDir ? `cd ${workingDir} && ${command}` : command;
  const execId = generateExecId();
  
  // Store in Durable Object
  const doId = c.env.EXEC_RESULT_STORE.idFromName('global');
  const doStub = c.env.EXEC_RESULT_STORE.get(doId);
  
  await doStub.fetch(new Request('http://do/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      execId,
      userId,
      command: fullCommand,
    }),
  }));
  
  // Run in background
  const backgroundPromise = (async () => {
    try {
      const sandbox = await getUserSandbox(c.env, userId, true);

      const ready = await waitForSandboxReady(sandbox, { timeoutMs: 20000, intervalMs: 500 });
      if (!ready.ready) {
        throw new Error(
          `sandbox_not_ready after ${ready.attempts} attempts: ` +
            (ready.lastError instanceof Error ? ready.lastError.message : String(ready.lastError ?? 'unknown'))
        );
      }

      const started = await withRetry(async () => sandbox.startProcess(fullCommand, { env: cmdEnv }), {
        retries: 4,
        baseDelayMs: 250,
        maxDelayMs: 4000,
      });
      if (!started.value) {
        throw started.lastError instanceof Error ? started.lastError : new Error(String(started.lastError ?? 'Failed to start process'));
      }

      const proc = started.value as any;
      const result = await proc.waitForExit(timeout);
      const logs = await proc.getLogs();
      
      // Update result in DO
      await doStub.fetch(new Request('http://do/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          execId,
          updates: {
            status: 'completed',
            exitCode: (result as any).exitCode ?? proc.exitCode ?? -1,
            stdout: logs.stdout || '',
            stderr: logs.stderr || '',
            completedAt: new Date().toISOString(),
          },
        }),
      }));
    } catch (error) {
      console.error('[EXEC-BG] Error:', error);
      
      await doStub.fetch(new Request('http://do/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          execId,
          updates: {
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
            completedAt: new Date().toISOString(),
          },
        }),
      }));
    }
  })();
  
  c.executionCtx.waitUntil(backgroundPromise);
  
  return c.json({
    userId,
    command: fullCommand,
    execId,
    status: 'running',
    async: true,
    timestamp: new Date().toISOString(),
    pollUrl: `/api/super/users/${userId}/exec/${execId}/status`,
  });
});

adminRouter.get('/users/:id/exec/:execId/status', async (c) => {
  const userId = c.req.param('id');
  const execId = c.req.param('execId');
  
  // Get from Durable Object
  const doId = c.env.EXEC_RESULT_STORE.idFromName('global');
  const doStub = c.env.EXEC_RESULT_STORE.get(doId);
  
  const response = await doStub.fetch(new Request(`http://do/get/${execId}`));
  
  if (response.status === 404) {
    return c.json({
      userId,
      execId,
      found: false,
      error: 'Exec result not found',
    }, HTTP_STATUS.NOT_FOUND);
  }
  
  const result = await response.json();
  
  return c.json({
    execId,
    found: true,
    ...result,
  });
});

// =============================================================================
// Config Routes
// =============================================================================

adminRouter.get('/users/:id/config', async (c) => {
  const userId = c.req.param('id');
  
  try {
    const configKey = `users/${userId}/openclaw/openclaw.json`;
    const configObj = await c.env.MOLTBOT_BUCKET.get(configKey);
    
    if (!configObj) {
      return c.json({ error: 'Config not found in R2' }, HTTP_STATUS.NOT_FOUND);
    }
    
    const configText = await configObj.text();
    const config = JSON.parse(configText);
    
    return c.json({
      userId,
      source: 'r2',
      config,
      lastModified: configObj.uploaded,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

adminRouter.put('/users/:id/config', async (c) => {
  const userId = c.req.param('id');
  
  let config;
  try {
    config = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, HTTP_STATUS.BAD_REQUEST);
  }
  
  try {
    const configKey = `users/${userId}/openclaw/openclaw.json`;
    const historyKey = `users/${userId}/openclaw/openclaw.json.history`;
    
    // Save history
    try {
      const existing = await c.env.MOLTBOT_BUCKET.get(configKey);
      if (existing) {
        const existingText = await existing.text();
        const historyEntry = {
          timestamp: new Date().toISOString(),
          config: JSON.parse(existingText),
        };
        
        const existingHistory = await c.env.MOLTBOT_BUCKET.get(historyKey);
        let history: any[] = [];
        if (existingHistory) {
          try {
            history = JSON.parse(await existingHistory.text());
          } catch {}
        }
        history.push(historyEntry);
        if (history.length > 10) {
          history = history.slice(-10);
        }
        
        await c.env.MOLTBOT_BUCKET.put(historyKey, JSON.stringify(history, null, 2), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
    } catch {}
    
    // Write new config
    const configText = JSON.stringify(config, null, 2);
    await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
      httpMetadata: { contentType: 'application/json' },
    });
    
    return c.json({
      userId,
      success: true,
      message: 'Config updated in R2',
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

adminRouter.patch('/users/:id/config', async (c) => {
  const userId = c.req.param('id');
  
  let patch;
  try {
    patch = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, HTTP_STATUS.BAD_REQUEST);
  }
  
  try {
    const configKey = `users/${userId}/openclaw/openclaw.json`;
    
    // Get existing config
    const existing = await c.env.MOLTBOT_BUCKET.get(configKey);
    let currentConfig: any = {};
    if (existing) {
      try {
        currentConfig = JSON.parse(await existing.text());
      } catch {
        return c.json({ error: 'Existing config is not valid JSON' }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }
    
    // Deep merge
    const merged = deepMerge(currentConfig, patch);
    const configText = JSON.stringify(merged, null, 2);
    
    // Save
    await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
      httpMetadata: { contentType: 'application/json' },
    });
    
    return c.json({
      userId,
      success: true,
      message: 'Config patched (deep merge) in R2',
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// =============================================================================
// Bulk Operations
// =============================================================================

adminRouter.post('/bulk/config-patch', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { patch, userIds: requestedIds } = body;
  
  if (!patch || typeof patch !== 'object') {
    return c.json({ error: 'patch object is required' }, HTTP_STATUS.BAD_REQUEST);
  }
  
  const allUserIds = DEFAULT_USER_REGISTRY.map(u => u.userId);
  const targetIds = requestedIds && Array.isArray(requestedIds) ? requestedIds : allUserIds;
  
  const results: Array<{ userId: string; success: boolean; error?: string }> = [];
  
  for (const userId of targetIds) {
    try {
      const configKey = `users/${userId}/openclaw/openclaw.json`;
      const existing = await c.env.MOLTBOT_BUCKET.get(configKey);
      
      let currentConfig: any = {};
      if (existing) {
        try {
          currentConfig = JSON.parse(await existing.text());
        } catch {}
      }
      
      const merged = deepMerge(currentConfig, patch);
      const configText = JSON.stringify(merged, null, 2);
      
      await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
        httpMetadata: { contentType: 'application/json' },
      });
      
      results.push({ userId, success: true });
    } catch (error) {
      results.push({
        userId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  
  return c.json({
    success: results.every(r => r.success),
    total: results.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  });
});

// =============================================================================
// Utility Functions
// =============================================================================

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

export { adminRouter };
