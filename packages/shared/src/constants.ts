/**
 * Shared constants for moltworker architecture
 */

// =============================================================================
// Ports
// =============================================================================

export const MOLTBOT_PORT = 18789;
export const GATEWAY_HEALTH_PORT = 18790;

// =============================================================================
// Timeouts
// =============================================================================

export const DEFAULT_EXEC_TIMEOUT = 30000; // 30 seconds
export const MAX_EXEC_TIMEOUT = 300000; // 5 minutes
export const CONTAINER_START_TIMEOUT = 60000; // 60 seconds
export const HEALTH_CHECK_TIMEOUT = 5000; // 5 seconds
export const WEBSOCKET_TIMEOUT = 30000; // 30 seconds

// =============================================================================
// Rate Limiting
// =============================================================================

export const DEFAULT_RATE_LIMIT = {
  requestsPerMinute: 60,
  requestsPerHour: 1000,
};

export const ADMIN_RATE_LIMIT = {
  requestsPerMinute: 120,
  requestsPerHour: 5000,
};

// =============================================================================
// Feature Flags
// =============================================================================

export const FEATURE_FLAGS = {
  // Use new Admin API Worker for admin endpoints
  USE_NEW_ADMIN_API: 'USE_NEW_ADMIN_API',
  // Use new Container Gateway Worker for container proxy
  USE_NEW_CONTAINER_GATEWAY: 'USE_NEW_CONTAINER_GATEWAY',
  // Enable tiered routing for specific users
  TIERED_ROUTING_ENABLED: 'TIERED_ROUTING_ENABLED',
  // Store exec results in Durable Objects (not in-memory)
  EXEC_RESULTS_IN_DO: 'EXEC_RESULTS_IN_DO',
  // Enable dual-write mode for testing
  DUAL_WRITE_ENABLED: 'DUAL_WRITE_ENABLED',
};

// =============================================================================
// Routing
// =============================================================================

export const ROUTES = {
  // Admin API routes
  ADMIN_API_PREFIX: '/api/super',
  ADMIN_DASHBOARD: '/api/super/state/dashboard',
  ADMIN_USERS: '/api/super/users',
  
  // Container Gateway routes
  CONTAINER_PREFIX: '/container',
  WEBSOCKET_PREFIX: '/ws',
  
  // Public routes
  HEALTH_CHECK: '/sandbox-health',
  STATUS: '/api/status',
  
  // Legacy admin UI
  ADMIN_UI: '/_admin',
};

// =============================================================================
// HTTP Status Codes
// =============================================================================

export const HTTP_STATUS = {
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

// =============================================================================
// Container States
// =============================================================================

export const CONTAINER_STATES = {
  ACTIVE: 'active',
  IDLE: 'idle',
  SLEEPING: 'sleeping',
  STOPPED: 'stopped',
  ERROR: 'error',
  STARTING: 'starting',
} as const;

// =============================================================================
// Sandbox Names
// =============================================================================

export function getSandboxName(userId: string): string {
  return `openclaw-${userId}`;
}

export function getR2Prefix(userId: string): string {
  return `users/${userId}`;
}

// =============================================================================
// Exec Result Constants
// =============================================================================

export const EXEC_RESULT_TTL_HOURS = 24; // How long to keep exec results
export const EXEC_MAX_RESULTS_PER_USER = 100; // Max results to store per user
export const EXEC_CLEANUP_BATCH_SIZE = 50; // How many results to clean up at once

// =============================================================================
// Health Check Constants
// =============================================================================

export const HEALTH_CHECK_CONFIG = {
  maxConsecutiveFailures: 3,
  checkIntervalMs: 60000, // 1 minute
  restartBackoffMs: 300000, // 5 minutes between auto-restarts
  circuitBreakerThreshold: 5, // Restarts in 15 min window before circuit breaker
  circuitBreakerWindowMs: 15 * 60 * 1000, // 15 minutes
};

// =============================================================================
// Cost Tracking Constants
// =============================================================================

export const COST_RATES = {
  workers: {
    perMillionRequests: 0.50,
    perGBSecond: 0.0000125,
  },
  r2: {
    perGBMonth: 0.015,
    perMillionOperations: 0.50,
  },
  durableObjects: {
    perBillionRequests: 0.50,
    perGBMonth: 0.20,
  },
  sandbox: {
    perGBSecond: 0.000025, // Estimated
  },
};

// =============================================================================
// User Registry
// =============================================================================

export const DEFAULT_USER_REGISTRY: Array<{
  userId: string;
  name: string;
  tier: 1 | 2 | 3;
}> = [
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
