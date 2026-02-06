import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars, deriveCaptainAppKey, deriveUserGatewayToken, getGatewayMasterToken } from './env';
import { mountR2Storage } from './r2';
import { syncBeforeShutdown, syncToR2 } from './sync';
import { isBackupFeatureEnabled } from '../config/backup';
import { getTierForUser } from './tiers';

/**
 * In-memory lock to prevent concurrent gateway starts for the same sandbox.
 * Key is sandbox name (e.g., 'openclaw-{userId}'), value is a promise that resolves
 * when the start attempt completes.
 */
const startupLocks: Map<string, Promise<Process>> = new Map();

/**
 * Load user-specific secrets from R2
 * These are stored at users/{userId}/secrets.json
 */
async function loadUserSecrets(env: MoltbotEnv, userId: string): Promise<Record<string, string>> {
  try {
    const secretsKey = `users/${userId}/secrets.json`;
    const object = await env.MOLTBOT_BUCKET.get(secretsKey);

    if (!object) {
      console.log(`[Secrets] No user secrets found for ${userId.slice(0, 8)}...`);
      return {};
    }

    const text = await object.text();
    const secrets = JSON.parse(text) as Record<string, string>;
    const keys = Object.keys(secrets).filter(k => secrets[k]);
    console.log(`[Secrets] Loaded ${keys.length} secrets for user ${userId.slice(0, 8)}...: ${keys.join(', ')}`);
    return secrets;
  } catch (err) {
    console.error(`[Secrets] Failed to load user secrets:`, err);
    return {};
  }
}

/**
 * Find an existing Moltbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "openclaw devices list"
      const isGatewayProcess =
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('openclaw gateway') ||
        proc.command.includes('clawdbot gateway'); // legacy compat
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');
      
      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Moltbot gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param userId - Optional user ID for per-user token derivation (multi-tenant mode)
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv, userId?: string): Promise<Process> {
  // Use sandbox name as lock key to prevent concurrent starts for the same container
  const sandboxName = userId ? `openclaw-${userId}` : 'openclaw-default';

  // Check if there's already a startup in progress for this sandbox
  const existingStartup = startupLocks.get(sandboxName);
  if (existingStartup) {
    console.log(`[Gateway] Startup already in progress for ${sandboxName}, waiting...`);
    try {
      return await existingStartup;
    } catch {
      // Previous startup failed, we'll try again below
      console.log(`[Gateway] Previous startup failed for ${sandboxName}, retrying...`);
    }
  }

  // Create a new startup promise and store it
  const startupPromise = doEnsureMoltbotGateway(sandbox, env, userId, sandboxName);
  startupLocks.set(sandboxName, startupPromise);

  try {
    const result = await startupPromise;
    return result;
  } finally {
    // Clean up the lock after completion (success or failure)
    // Use setTimeout to keep the lock for a short time to prevent rapid retries
    setTimeout(() => {
      if (startupLocks.get(sandboxName) === startupPromise) {
        startupLocks.delete(sandboxName);
      }
    }, 5000);
  }
}

/**
 * Internal implementation of ensureMoltbotGateway
 */
async function doEnsureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv, userId: string | undefined, sandboxName: string): Promise<Process> {
  const startupStart = Date.now();

  // Log tier/binding info
  const tierInfo = userId ? `user ${userId.slice(0, 8)} (tier: ${getTierForUser(userId)})` : 'default';
  console.log(`[STARTUP] Starting gateway for ${tierInfo}`);
  console.log(`[STARTUP] Sandbox: ${sandboxName}`);

  // Mount R2 storage (fire-and-forget - don't block startup)
  // R2 is used as a backup - the startup script will restore from it on boot
  console.log('[STARTUP] Phase 1: Initiating R2 mount (non-blocking)...');
  const r2MountStart = Date.now();
  const r2MountPromise = mountR2Storage(sandbox, env)
    .then(success => {
      const duration = Date.now() - r2MountStart;
      if (success) {
        console.log(`[STARTUP] R2 mount succeeded in ${duration}ms`);
      } else {
        console.warn(`[STARTUP] R2 mount failed after ${duration}ms - using degraded mode`);
      }
      return success;
    })
    .catch(err => {
      console.error('[STARTUP] R2 mount error:', err);
      return false;
    });
  // Don't await - gateway starts immediately while R2 mounts in background

  // Ensure user is registered in R2 for cron discovery
  // This writes a marker file so the cron can find new users
  if (userId && env.MOLTBOT_BUCKET) {
    try {
      const markerKey = `users/${userId}/.registered`;
      const existing = await env.MOLTBOT_BUCKET.head(markerKey);
      if (!existing) {
        const now = new Date().toISOString();
        await env.MOLTBOT_BUCKET.put(markerKey, JSON.stringify({ registeredAt: now, userId }));
        console.log(`[Gateway] Registered new user ${userId.slice(0, 8)}... in R2 for cron discovery`);
      }
    } catch (err) {
      // Non-critical - user will be discovered eventually
      console.log(`[Gateway] Failed to register user in R2:`, err);
    }
  }

  // Check if Moltbot is already running or starting
  console.log('[STARTUP] Phase 2: Checking for existing gateway process...');
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log(`[STARTUP] Found existing process: ${existingProcess.id} (status: ${existingProcess.status})`);

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log(`[STARTUP] Waiting for port ${MOLTBOT_PORT} (timeout: ${STARTUP_TIMEOUT_MS}ms)...`);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      const totalDuration = Date.now() - startupStart;
      console.log(`[STARTUP] ✅ Gateway ready (existing process) in ${totalDuration}ms`);
      return existingProcess;
    } catch (e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      const waitDuration = Date.now() - startupStart;
      console.log(`[STARTUP] Existing process not reachable after ${waitDuration}ms, killing and restarting...`);
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('[STARTUP] Failed to kill process:', killError);
      }
    }
  }

  // Derive per-user gateway token if userId provided
  let userGatewayToken: string | undefined;
  const masterToken = getGatewayMasterToken(env);
  if (userId && masterToken) {
    userGatewayToken = await deriveUserGatewayToken(masterToken, userId);
    console.log(`[Gateway] Derived per-user token for user ${userId.slice(0, 8)}...`);
  }

  // Derive per-user CaptainApp API key if master key is set
  let captainAppKey: string | undefined;
  if (userId && env.CAPTAINAPP_MASTER_KEY) {
    captainAppKey = await deriveCaptainAppKey(env.CAPTAINAPP_MASTER_KEY, userId);
    console.log(`[CaptainApp] Derived per-user API key for user ${userId.slice(0, 8)}...`);
  }

  // Load user-specific secrets from R2
  let userSecrets: Record<string, string> = {};
  if (userId) {
    userSecrets = await loadUserSecrets(env, userId);
  }

  // Start a new Moltbot gateway
  console.log('[STARTUP] Phase 3: Starting new gateway process...');
  const envVars = buildEnvVars(env, userGatewayToken, userId);
  console.log(`[STARTUP] Gateway token: ${envVars.OPENCLAW_GATEWAY_TOKEN ? 'SET' : 'MISSING'}`);
  console.log(`[STARTUP] R2 credentials: ${envVars.R2_ACCESS_KEY_ID ? 'SET' : 'MISSING'}`);
  console.log(`[STARTUP] AI API key: ${envVars.ANTHROPIC_API_KEY ? 'SET' : envVars.OPENAI_API_KEY ? 'SET (OpenAI)' : 'MISSING'}`);
  console.log(`[STARTUP] AI Gateway URL: ${envVars.AI_GATEWAY_BASE_URL || '(direct)'}`);
  console.log(`[STARTUP] CaptainApp key: ${captainAppKey ? 'DERIVED' : 'MISSING'}`);
  console.log(`[STARTUP] Total env vars: ${Object.keys(envVars).length}`);

  // Merge user secrets into env vars for API keys only
  // Channel tokens (Telegram, Discord, Slack) are managed via the bot's control UI
  // and stored in the bot's config file, not injected via env vars
  if (userSecrets.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = userSecrets.ANTHROPIC_API_KEY;
  if (userSecrets.OPENAI_API_KEY) envVars.OPENAI_API_KEY = userSecrets.OPENAI_API_KEY;

  // CaptainApp: use derived key (automatic), fall back to R2 secret (manual override)
  if (captainAppKey) {
    envVars.CAPTAINAPP_API_KEY = captainAppKey;
  } else if (userSecrets.CAPTAINAPP_API_KEY) {
    envVars.CAPTAINAPP_API_KEY = userSecrets.CAPTAINAPP_API_KEY;
  }

  const command = '/usr/local/bin/start-moltbot.sh';

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log(`[STARTUP] Process started: id=${process.id} status=${process.status}`);
  } catch (startErr) {
    console.error('[STARTUP] Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log(`[STARTUP] Phase 4: Waiting for port ${MOLTBOT_PORT} (timeout: ${STARTUP_TIMEOUT_MS}ms)...`);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });

    const totalDuration = Date.now() - startupStart;
    console.log(`[STARTUP] ✅ Gateway ready in ${totalDuration}ms`);

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[STARTUP] stdout:', logs.stdout.slice(-500));
    if (logs.stderr) console.log('[STARTUP] stderr:', logs.stderr.slice(-500));
  } catch (e) {
    const totalDuration = Date.now() - startupStart;
    console.error(`[STARTUP] ❌ Gateway failed after ${totalDuration}ms:`, e);

    // Get detailed logs for debugging
    try {
      const logs = await process.getLogs();
      console.error('[STARTUP] Failed startup - stderr:', logs.stderr);
      console.error('[STARTUP] Failed startup - stdout:', logs.stdout);
      throw new Error(`Gateway failed to start in ${STARTUP_TIMEOUT_MS}ms. Stderr: ${logs.stderr || '(empty)'}`);
    } catch (logErr) {
      if (logErr instanceof Error && logErr.message.startsWith('Gateway failed')) throw logErr;
      console.error('[STARTUP] Failed to get logs:', logErr);
      throw e;
    }
  }

  return process;
}

/**
 * Restart a user's container with pre-shutdown sync.
 * 
 * This function:
 * 1. Triggers pre-shutdown sync to ensure data is saved to R2
 * 2. Waits for sync to complete (with timeout)
 * 3. Kills all processes
 * 4. Restarts the gateway
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param userId - The user ID to restart
 * @returns Promise that resolves when restart is initiated
 */
export async function restartContainer(
  sandbox: Sandbox,
  env: MoltbotEnv,
  userId: string
): Promise<{ success: boolean; syncResult?: { success: boolean; error?: string }; message: string }> {
  const r2Prefix = `users/${userId}`;
  
  console.log(`[Restart] Initiating restart for user ${userId.slice(0, 8)}...`);

  // Step 1: Pre-shutdown sync (if feature enabled)
  let syncResult: { success: boolean; error?: string } = { success: true };
  
  if (isBackupFeatureEnabled('SHUTDOWN_SYNC')) {
    console.log(`[Restart] Running pre-shutdown sync for ${userId.slice(0, 8)}...`);
    try {
      const result = await syncBeforeShutdown(sandbox, env, {
        r2Prefix,
        mode: 'blocking',
        timeoutMs: 30000, // 30s max for pre-shutdown sync
        emergency: true,
      });
      
      syncResult = {
        success: result.success,
        error: result.error,
      };
      
      if (result.success) {
        console.log(`[Restart] Pre-shutdown sync completed for ${userId.slice(0, 8)}... in ${result.durationMs}ms`);
      } else {
        console.error(`[Restart] Pre-shutdown sync failed for ${userId.slice(0, 8)}...:`, result.error);
        // Continue with restart anyway - we don't want to block restart indefinitely
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[Restart] Pre-shutdown sync error for ${userId.slice(0, 8)}...:`, errorMsg);
      syncResult = { success: false, error: errorMsg };
      // Continue with restart
    }
  } else {
    console.log(`[Restart] SHUTDOWN_SYNC feature flag disabled, skipping pre-shutdown sync`);
  }

  // Step 2: Kill all processes
  try {
    const processes = await sandbox.listProcesses();
    console.log(`[Restart] Killing ${processes.length} processes for ${userId.slice(0, 8)}...`);
    
    for (const proc of processes) {
      try {
        await proc.kill();
        console.log(`[Restart] Killed process ${proc.id}`);
      } catch (e) {
        console.log(`[Restart] Failed to kill process ${proc.id}:`, e);
      }
    }
    
    // Wait for processes to die
    await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (e) {
    console.error(`[Restart] Error killing processes for ${userId.slice(0, 8)}...:`, e);
  }

  // Step 3: Start fresh gateway
  try {
    console.log(`[Restart] Starting fresh gateway for ${userId.slice(0, 8)}...`);
    
    // Start in background - don't await to avoid timeout
    ensureMoltbotGateway(sandbox, env, userId).catch(err => {
      console.error(`[Restart] Gateway start failed for ${userId.slice(0, 8)}...:`, err);
    });
    
    return {
      success: true,
      syncResult,
      message: 'Container restart initiated',
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Restart] Failed to start gateway for ${userId.slice(0, 8)}...:`, errorMsg);
    
    return {
      success: false,
      syncResult,
      message: `Restart failed: ${errorMsg}`,
    };
  }
}
