import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getGatewayMasterToken } from '../gateway';

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

// Helper: Get sandbox for a user
async function getUserSandbox(env: any, userId: string, keepAlive = false) {
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  return getSandbox(env.Sandbox, sandboxName, { 
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
        p.command?.includes('clawdbot gateway') && 
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
          const versionProc = await sandbox.startProcess('clawdbot --version');
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
        p.command?.includes('clawdbot gateway') && 
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
    
    // Kill any stale processes first
    try {
      const processes = await sandbox.listProcesses();
      for (const proc of processes) {
        try {
          await proc.kill();
        } catch {
          // Ignore kill errors
        }
      }
    } catch {
      // Ignore if can't list processes
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
          p.command?.includes('clawdbot gateway') && 
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
async function withWake(env: any, userId: string, operation: () => Promise<Response>): Promise<Response> {
  const sandbox = await getUserSandbox(env, userId, true);
  
  // Check if container needs waking
  let needsWake = false;
  try {
    const processes = await sandbox.listProcesses();
    const gatewayRunning = processes.some((p: any) => 
      p.command?.includes('clawdbot gateway') && 
      p.status === 'running'
    );
    if (!gatewayRunning && processes.length === 0) {
      needsWake = true;
    }
  } catch {
    needsWake = true;
  }

  // Wake if needed
  if (needsWake) {
    const { ensureMoltbotGateway } = await import('../gateway');
    console.log(`[AUTO-WAKE] Waking container for ${userId} before operation`);
    
    // Kill stale processes
    try {
      const processes = await sandbox.listProcesses();
      for (const proc of processes) {
        try { await proc.kill(); } catch {}
      }
    } catch {}
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Start gateway
    const bootPromise = ensureMoltbotGateway(sandbox, env, userId).catch(() => {});
    env.executionCtx?.waitUntil?.(bootPromise);
    
    // Wait for it to be ready
    const maxWaitMs = 30000;
    const pollIntervalMs = 1000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      try {
        const processes = await sandbox.listProcesses();
        if (processes.some((p: any) => p.command?.includes('clawdbot gateway') && p.status === 'running')) {
          break;
        }
      } catch {}
    }
  }

  return await operation();
}

// POST /api/super/users/:id/exec - Execute command with auto-wake
adminRouter.post('/users/:id/exec', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { command, timeout = 30000, env: cmdEnv } = body;

  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Execute the command
      const startTime = Date.now();
      const proc = await sandbox.startProcess(command, {
        env: cmdEnv,
      });

      // Wait for completion or timeout
      const result = await Promise.race([
        proc.waitForExit(timeout),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Command timeout')), timeout)
        ),
      ]);

      const logs = await proc.getLogs();
      const duration = Date.now() - startTime;

      return c.json({
        userId,
        command,
        exitCode: (result as any).exitCode ?? proc.exitCode ?? -1,
        stdout: logs.stdout || '',
        stderr: logs.stderr || '',
        duration,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        command,
        error: errorMessage,
        stdout: '',
        stderr: '',
        timestamp: new Date().toISOString(),
      }, 500);
    }
  });
});

// =============================================================================
// Phase 1: Native File Operations
// =============================================================================

// GET /api/super/users/:id/files/* - Read file using native SDK
adminRouter.get('/users/:id/files/*', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('*') || '';
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Use native readFile SDK method
      const result = await sandbox.readFile(path);
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to read file',
          exitCode: result.exitCode,
        }, 500);
      }

      // For binary files or large files, return metadata only
      if (result.isBinary || (result.size && result.size > 1024 * 1024)) {
        return c.json({
          userId,
          path,
          size: result.size,
          encoding: result.encoding,
          isBinary: result.isBinary,
          mimeType: result.mimeType,
          message: 'File is binary or large (>1MB). Use R2 for streaming.',
        }, 200);
      }

      return c.json({
        userId,
        path,
        content: result.content,
        encoding: result.encoding,
        size: result.size,
        mimeType: result.mimeType,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Check if file doesn't exist
      if (errorMessage.includes('not found') || errorMessage.includes('No such file')) {
        return c.json({
          userId,
          path,
          error: 'File not found',
        }, 404);
      }
      
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// HEAD /api/super/users/:id/files/* - Check file exists and get metadata
adminRouter.get('/users/:id/files/*/exists', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const pathParam = c.req.param('*') || '';
  // Remove the trailing '/exists' from the path
  const path = pathParam.replace(/\/exists$/, '');
  
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

// PUT /api/super/users/:id/files/* - Write file using native SDK
adminRouter.put('/users/:id/files/*', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('*') || '';
  
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

// DELETE /api/super/users/:id/files/* - Delete file
adminRouter.delete('/users/:id/files/*', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('*') || '';
  
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
  const path = c.req.query('path') || '/';
  const recursive = c.req.query('recursive') === 'true';

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      const result = await sandbox.listFiles(path, { recursive });
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to list files',
          exitCode: result.exitCode,
        }, 500);
      }

      return c.json({
        userId,
        path,
        files: result.files,
        count: result.count,
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
      const reloadProc = await sandbox.startProcess('killall -HUP clawdbot 2>/dev/null || true');
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
    const configKey = `users/${userId}/clawdbot/clawdbot.json`;
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
    const configKey = `users/${userId}/clawdbot/clawdbot.json`;
    const historyKey = `users/${userId}/clawdbot/clawdbot.json.history`;
    
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
        await sandbox.mkdir('/root/.clawdbot', { recursive: true });
        await sandbox.writeFile('/root/.clawdbot/clawdbot.json', configText);
      } catch (writeError) {
        console.log(`[CONFIG] Failed to write to container:`, writeError);
      }

      // Send reload signal
      try {
        const reloadProc = await sandbox.startProcess('killall -HUP clawdbot 2>/dev/null || true');
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
    const historyKey = `users/${userId}/clawdbot/clawdbot.json.history`;
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
    const historyKey = `users/${userId}/clawdbot/clawdbot.json.history`;
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
    const configKey = `users/${userId}/clawdbot/clawdbot.json`;
    
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
        await sandbox.writeFile('/root/.clawdbot/clawdbot.json', configText);
        
        const reloadProc = await sandbox.startProcess('killall -HUP clawdbot 2>/dev/null || true');
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

export { adminRouter };
