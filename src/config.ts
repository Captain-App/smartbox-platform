/**
 * Configuration constants for OpenClaw Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (30 seconds - fail fast) */
export const STARTUP_TIMEOUT_MS = 30_000;

/**
 * R2 bucket name for persistent storage.
 * Can be overridden via R2_BUCKET_NAME env var for test isolation.
 */
export function getR2BucketName(env?: { R2_BUCKET_NAME?: string }): string {
  return env?.R2_BUCKET_NAME || 'moltbot-data';
}

/** Health check configuration */
export const HEALTH_CHECK_CONFIG = {
  /** Number of consecutive failures before auto-restart */
  failuresBeforeRestart: 3,
  /** Timeout for port check in ms */
  portCheckTimeoutMs: 5000,
  /** Timeout for HTTP check in ms */
  httpCheckTimeoutMs: 10000,
};
