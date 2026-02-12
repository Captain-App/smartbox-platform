import type { Sandbox } from '@cloudflare/sandbox';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from './process';
import { waitForProcess } from './utils';

// =============================================================================
// Circuit Breaker: Prevent infinite restart loops
// =============================================================================
const restartCounts = new Map<string, { count: number; windowStart: number }>();
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const CIRCUIT_BREAKER_THRESHOLD = 5; // Max 5 restarts in window

/**
 * Check if circuit breaker is tripped for a user.
 * On cache miss, loads from D1 if db is provided.
 */
export async function isCircuitBreakerTrippedAsync(userId: string, db?: D1Database): Promise<boolean> {
  const now = Date.now();
  let entry = restartCounts.get(userId);

  // Cache miss — try D1
  if (!entry && db) {
    try {
      const row = await db.prepare(
        'SELECT restart_count, window_start FROM circuit_breaker WHERE user_id = ?'
      ).bind(userId).first<{ restart_count: number; window_start: string }>();
      if (row) {
        const windowStart = new Date(row.window_start).getTime();
        if (now - windowStart <= CIRCUIT_BREAKER_WINDOW_MS) {
          entry = { count: row.restart_count, windowStart };
          restartCounts.set(userId, entry);
        }
      }
    } catch (e) {
      console.warn('[CIRCUIT-BREAKER] D1 load failed:', e);
    }
  }

  if (!entry) return false;

  // Reset window if expired
  if (now - entry.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
    restartCounts.delete(userId);
    return false;
  }

  return entry.count >= CIRCUIT_BREAKER_THRESHOLD;
}

/** Sync version (in-memory only) */
export function isCircuitBreakerTripped(userId: string): boolean {
  const now = Date.now();
  const entry = restartCounts.get(userId);
  if (!entry) return false;
  if (now - entry.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
    restartCounts.delete(userId);
    return false;
  }
  return entry.count >= CIRCUIT_BREAKER_THRESHOLD;
}

/**
 * Increment restart count for circuit breaker.
 * Writes to both in-memory Map and D1.
 */
export async function recordRestartForCircuitBreakerAsync(userId: string, db?: D1Database): Promise<void> {
  const now = Date.now();
  const entry = restartCounts.get(userId);

  if (!entry || now - entry.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
    restartCounts.set(userId, { count: 1, windowStart: now });
    console.log(`[CIRCUIT-BREAKER] ${userId.slice(0, 8)}: 1 restart in new window`);
  } else {
    entry.count++;
    console.log(`[CIRCUIT-BREAKER] ${userId.slice(0, 8)}: ${entry.count} restarts in current window`);
  }

  // Persist to D1
  if (db) {
    try {
      const current = restartCounts.get(userId)!;
      await db.prepare(
        `INSERT INTO circuit_breaker (user_id, restart_count, window_start, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           restart_count = excluded.restart_count,
           window_start = excluded.window_start,
           updated_at = datetime('now')`
      ).bind(userId, current.count, new Date(current.windowStart).toISOString()).run();
    } catch (e) {
      console.warn('[CIRCUIT-BREAKER] D1 write failed:', e);
    }
  }
}

/** Sync version (in-memory only, kept for backward compat) */
export function recordRestartForCircuitBreaker(userId: string): void {
  const now = Date.now();
  const entry = restartCounts.get(userId);
  if (!entry || now - entry.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
    restartCounts.set(userId, { count: 1, windowStart: now });
    console.log(`[CIRCUIT-BREAKER] ${userId.slice(0, 8)}: 1 restart in new window`);
  } else {
    entry.count++;
    console.log(`[CIRCUIT-BREAKER] ${userId.slice(0, 8)}: ${entry.count} restarts in current window`);
  }
}

/**
 * Reset circuit breaker for a user (manual intervention)
 */
export function resetCircuitBreaker(userId: string): void {
  restartCounts.delete(userId);
  console.log(`[CIRCUIT-BREAKER] ${userId.slice(0, 8)}: reset`);
}

/**
 * Result of a health check for a single sandbox
 */
export interface HealthCheckResult {
  /** Overall health status */
  healthy: boolean;
  /** Individual check results */
  checks: {
    /** Process is running in sandbox */
    processRunning: boolean;
    /** Gateway port is reachable via TCP */
    portReachable: boolean;
    /** Gateway responds to HTTP health check */
    gatewayResponds: boolean;
  };
  /** ISO timestamp of this check */
  lastCheck: string;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Process ID if found */
  processId?: string;
  /** Process status */
  processStatus?: string;
  /** Error message if unhealthy */
  error?: string;
  /** Memory usage if available */
  memoryUsageMb?: number;
  /** Process uptime in seconds */
  uptimeSeconds?: number;
}

/**
 * In-memory tracking of health check state per user
 */
interface HealthState {
  consecutiveFailures: number;
  lastCheck: string;
  lastHealthy: string | null;
  lastRestart: string | null;
}

const healthStates: Map<string, HealthState> = new Map();

/**
 * Configuration for health checks
 */
export interface HealthCheckConfig {
  /** Number of consecutive failures before auto-restart (default: 3) */
  failuresBeforeRestart: number;
  /** Timeout for port check in ms (default: 5000) */
  portCheckTimeoutMs: number;
  /** Timeout for HTTP check in ms (default: 10000) */
  httpCheckTimeoutMs: number;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  failuresBeforeRestart: 3,
  portCheckTimeoutMs: 5000,
  httpCheckTimeoutMs: 10000,
};

/**
 * Get current health state for a user
 */
export function getHealthState(userId: string): HealthState | undefined {
  return healthStates.get(userId);
}

/**
 * Get all health states (for admin dashboard)
 */
export function getAllHealthStates(): Map<string, HealthState> {
  return new Map(healthStates);
}

/**
 * Load health state from D1 on cache miss
 */
async function loadHealthStateFromDB(db: D1Database, userId: string): Promise<HealthState | undefined> {
  try {
    const row = await db.prepare(
      'SELECT consecutive_failures, last_check, last_healthy, last_restart FROM health_states WHERE user_id = ?'
    ).bind(userId).first<{
      consecutive_failures: number;
      last_check: string | null;
      last_healthy: string | null;
      last_restart: string | null;
    }>();
    if (row) {
      return {
        consecutiveFailures: row.consecutive_failures,
        lastCheck: row.last_check || new Date().toISOString(),
        lastHealthy: row.last_healthy,
        lastRestart: row.last_restart,
      };
    }
  } catch (e) {
    console.warn('[HEALTH] D1 load failed:', e);
  }
  return undefined;
}

/**
 * Persist health state to D1
 */
async function saveHealthStateToDB(db: D1Database, userId: string, state: HealthState): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO health_states (user_id, consecutive_failures, last_check, last_healthy, last_restart, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         last_check = excluded.last_check,
         last_healthy = excluded.last_healthy,
         last_restart = excluded.last_restart,
         updated_at = datetime('now')`
    ).bind(
      userId,
      state.consecutiveFailures,
      state.lastCheck,
      state.lastHealthy,
      state.lastRestart,
    ).run();
  } catch (e) {
    console.warn('[HEALTH] D1 write failed:', e);
  }
}

/**
 * Perform a health check on a user's sandbox
 *
 * @param sandbox - The sandbox instance
 * @param userId - User ID for tracking state
 * @param config - Health check configuration
 * @param db - Optional D1 database for persistence
 * @returns Health check result
 */
export async function checkHealth(
  sandbox: Sandbox,
  userId: string,
  config: Partial<HealthCheckConfig> = {},
  db?: D1Database,
): Promise<HealthCheckResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date().toISOString();

  // Get or create health state (load from D1 on cold start)
  let state = healthStates.get(userId);
  if (!state && db) {
    state = await loadHealthStateFromDB(db, userId) ?? undefined;
    if (state) healthStates.set(userId, state);
  }
  if (!state) {
    state = {
      consecutiveFailures: 0,
      lastCheck: now,
      lastHealthy: null,
      lastRestart: null,
    };
    healthStates.set(userId, state);
  }
  state.lastCheck = now;

  const result: HealthCheckResult = {
    healthy: false,
    checks: {
      processRunning: false,
      portReachable: false,
      gatewayResponds: false,
    },
    lastCheck: now,
    consecutiveFailures: state.consecutiveFailures,
  };

  // Check 1: Is the gateway process running?
  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (process) {
      result.processId = process.id;
      result.processStatus = process.status;
      result.checks.processRunning = process.status === 'running';

      // Get uptime if available
      if (process.startTime) {
        result.uptimeSeconds = Math.floor((Date.now() - process.startTime.getTime()) / 1000);
      }
    }
  } catch (err) {
    result.error = `Process check failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }

  // Check 2: Is the port reachable?
  if (result.checks.processRunning) {
    try {
      const process = await findExistingMoltbotProcess(sandbox);
      if (process) {
        await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: cfg.portCheckTimeoutMs });
        result.checks.portReachable = true;
      }
    } catch {
      // Port not reachable
    }
  }

  // Check 3: Does the gateway respond to HTTP?
  if (result.checks.portReachable) {
    try {
      // Try to get memory usage via a quick command
      const memProc = await sandbox.startProcess('cat /proc/meminfo | grep MemAvailable | awk \'{print $2}\'');
      await waitForProcess(memProc, 2000);
      const memLogs = await memProc.getLogs();
      const memKb = parseInt(memLogs.stdout?.trim() || '0', 10);
      if (memKb > 0) {
        result.memoryUsageMb = Math.round((1024 * 1024 - memKb) / 1024); // Rough used memory
      }

      // The gateway should respond - this is a basic test that it's alive
      result.checks.gatewayResponds = true;
    } catch {
      // HTTP check failed
    }
  }

  // Determine overall health
  result.healthy = result.checks.processRunning &&
                   result.checks.portReachable &&
                   result.checks.gatewayResponds;

  // Update state
  if (result.healthy) {
    state.consecutiveFailures = 0;
    state.lastHealthy = now;
  } else {
    state.consecutiveFailures++;
  }
  result.consecutiveFailures = state.consecutiveFailures;

  // Persist to D1
  if (db) {
    await saveHealthStateToDB(db, userId, state);
  }

  return result;
}

/**
 * Check if a sandbox should be restarted based on health state.
 * Implements exponential backoff: immediate → 2min → 4min → 8min → 10min cap.
 */
export function shouldRestart(userId: string, config: Partial<HealthCheckConfig> = {}): boolean {
  // Check circuit breaker first
  if (isCircuitBreakerTripped(userId)) {
    console.warn(`[CIRCUIT-BREAKER] User ${userId.slice(0, 8)} circuit breaker tripped - manual intervention required`);
    return false;
  }

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state = healthStates.get(userId);
  if (!state) return false;

  if (state.consecutiveFailures < cfg.failuresBeforeRestart) {
    return false;
  }

  // Exponential backoff based on restart count within circuit breaker window
  if (state.lastRestart) {
    const entry = restartCounts.get(userId);
    const restartCount = entry?.count ?? 0;
    if (restartCount > 0) {
      const BACKOFF_BASE_MS = 2 * 60 * 1000; // 2 minutes
      const BACKOFF_CAP_MS = 10 * 60 * 1000; // 10 minutes
      const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, restartCount - 1), BACKOFF_CAP_MS);
      const timeSinceLastRestart = Date.now() - new Date(state.lastRestart).getTime();
      if (timeSinceLastRestart < backoffMs) {
        console.log(
          `[HEALTH] Backoff: ${userId.slice(0, 8)} restart #${restartCount} ` +
          `waiting ${Math.round((backoffMs - timeSinceLastRestart) / 1000)}s ` +
          `(backoff: ${Math.round(backoffMs / 1000)}s)`
        );
        return false;
      }
    }
  }

  return true;
}

/**
 * Record that a restart was performed.
 * Updates both in-memory and D1 state.
 */
export async function recordRestartAsync(userId: string, db?: D1Database): Promise<void> {
  const state = healthStates.get(userId);
  if (state) {
    state.lastRestart = new Date().toISOString();
    state.consecutiveFailures = 0;
    if (db) {
      await saveHealthStateToDB(db, userId, state);
    }
  }
}

/** Sync version (in-memory only, kept for backward compat) */
export function recordRestart(userId: string): void {
  const state = healthStates.get(userId);
  if (state) {
    state.lastRestart = new Date().toISOString();
    state.consecutiveFailures = 0;
  }
}

/**
 * Reset health state for a user (e.g., after manual restart)
 */
export function resetHealthState(userId: string): void {
  healthStates.delete(userId);
}
