/**
 * Shared types for moltworker architecture
 * Used across all workers: router, admin-api, container-gateway
 */

import type { Sandbox } from '@cloudflare/sandbox';

// =============================================================================
// User Types
// =============================================================================

/**
 * Authenticated user for OpenClaw platform
 */
export interface AuthenticatedUser {
  /** User's unique ID (UUID from Supabase) */
  id: string;
  /** User's email address */
  email?: string;
  /** Sandbox name for this user (e.g., 'openclaw-{userId}') */
  sandboxName: string;
  /** R2 prefix for this user's data (e.g., 'users/{userId}') */
  r2Prefix: string;
  /** User's tier level for routing decisions */
  tier?: 1 | 2 | 3;
}

/**
 * Legacy: Authenticated user from Cloudflare Access
 * @deprecated Use AuthenticatedUser instead
 */
export interface AccessUser {
  email: string;
  name?: string;
}

// =============================================================================
// Environment Types
// =============================================================================

/**
 * Base environment bindings shared across all workers
 */
export interface BaseEnv {
  // R2 bucket for persistent storage
  MOLTBOT_BUCKET: R2Bucket;
  
  // Feature flags
  DEV_MODE?: string;
  DEBUG_ROUTES?: string;
  TIERED_ROUTING_ENABLED?: string;
  
  // Admin configuration
  ADMIN_USER_IDS?: string;
  
  // Secrets (set via wrangler secret)
  MOLTBOT_GATEWAY_MASTER_TOKEN?: string;
  SUPABASE_JWT_SECRET?: string;
  
  // Browser Rendering binding for CDP shim
  BROWSER?: Fetcher;
}

/**
 * Environment for Edge Router Worker
 */
export interface RouterEnv extends BaseEnv {
  // Service bindings to other workers
  ADMIN_API: Service;
  CONTAINER_GATEWAY: Service;
  
  // Rate limiting
  RATE_LIMIT_KV?: KVNamespace;
  
  // Feature flags for routing
  USE_NEW_ADMIN_API?: string;
  USE_NEW_CONTAINER_GATEWAY?: string;
}

/**
 * Environment for Admin API Worker
 */
export interface AdminApiEnv extends BaseEnv {
  // Durable Object for exec results
  EXEC_RESULT_STORE: DurableObjectNamespace<ExecResultStore>;
  
  // D1 database for platform issues
  PLATFORM_DB?: D1Database;
  
  // Sandbox bindings for all tiers
  SandboxStandard1: DurableObjectNamespace<Sandbox>;
  SandboxStandard2: DurableObjectNamespace<Sandbox>;
  SandboxStandard3: DurableObjectNamespace<Sandbox>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  
  // KV for bot-to-bot relay
  RELAY?: KVNamespace;
}

/**
 * Environment for Container Gateway Worker
 */
export interface ContainerGatewayEnv extends BaseEnv {
  // Sandbox bindings for all tiers
  SandboxStandard1: DurableObjectNamespace<Sandbox>;
  SandboxStandard2: DurableObjectNamespace<Sandbox>;
  SandboxStandard3: DurableObjectNamespace<Sandbox>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  
  // Static assets binding
  ASSETS: Fetcher;
}

/**
 * Legacy: Full environment (for backward compatibility)
 */
export interface MoltbotEnv extends BaseEnv {
  // Per-tier sandbox bindings
  SandboxStandard1: DurableObjectNamespace<Sandbox>;
  SandboxStandard2: DurableObjectNamespace<Sandbox>;
  SandboxStandard3: DurableObjectNamespace<Sandbox>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  
  ASSETS: Fetcher;
  PLATFORM_DB?: D1Database;
  
  // AI Gateway configuration
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  
  // Legacy direct provider configuration
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  CAPTAINAPP_MASTER_KEY?: string;
  MOLTBOT_GATEWAY_TOKEN?: string;
  
  CLAWDBOT_BIND_MODE?: string;
  E2E_TEST_MODE?: string;
  SANDBOX_SLEEP_AFTER?: string;
  
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_PROJECT_REF?: string;
  
  // Legacy Cloudflare Access (deprecated)
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  CF_ACCOUNT_ID?: string;
  
  CDP_SECRET?: string;
  WORKER_URL?: string;
  RELAY?: KVNamespace;
}

// =============================================================================
// Durable Object Types
// =============================================================================

/**
 * Exec result stored in Durable Object
 */
export interface ExecResult {
  execId: string;
  userId: string;
  command: string;
  status: 'running' | 'completed' | 'error';
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Durable Object for storing exec results
 */
export interface ExecResultStore {
  create(execId: string, userId: string, command: string): Promise<void>;
  update(execId: string, updates: Partial<ExecResult>): Promise<void>;
  get(execId: string): Promise<ExecResult | null>;
  list(userId?: string, limit?: number): Promise<ExecResult[]>;
  cleanup(olderThanHours?: number): Promise<number>;
}

// =============================================================================
// Container Types
// =============================================================================

export type ContainerState = 'active' | 'idle' | 'sleeping' | 'stopped' | 'error';
export type LiveContainerState = 'stopped' | 'idle' | 'starting' | 'active' | 'error';

export interface ContainerStatus {
  state: ContainerState;
  lastActivity: string | null;
  processCount: number;
  memoryMB: number | null;
  uptimeSeconds: number | null;
  version: string | null;
  error?: string;
}

export interface LiveState {
  state: LiveContainerState;
  userId: string;
  processCount: number;
  gatewayHealthy: boolean | null;
  checkedAt: string;
  latencyMs: number;
  lastSyncAt?: string | null;
  error?: string;
}

// =============================================================================
// API Response Types
// =============================================================================

export interface ApiError {
  error: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  timestamp: string;
}

// =============================================================================
// User Registry Types
// =============================================================================

export interface UserRegistryEntry {
  userId: string;
  name: string;
  email?: string;
  tier: 1 | 2 | 3;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  migratedAt?: string;
}

// =============================================================================
// Hono App Environment Types
// =============================================================================

export type RouterAppEnv = {
  Bindings: RouterEnv;
  Variables: {
    user?: AuthenticatedUser;
    requestId: string;
    startTime: number;
  };
};

export type AdminApiAppEnv = {
  Bindings: AdminApiEnv;
  Variables: {
    user?: AuthenticatedUser;
    isSuperAdmin: boolean;
    requestId: string;
  };
};

export type ContainerGatewayAppEnv = {
  Bindings: ContainerGatewayEnv;
  Variables: {
    user?: AuthenticatedUser;
    sandbox: Sandbox;
    requestId: string;
  };
};

export type LegacyAppEnv = {
  Bindings: MoltbotEnv;
  Variables: {
    sandbox: Sandbox;
    user?: AuthenticatedUser;
    accessUser?: AccessUser;
  };
};

// =============================================================================
// Feature Flag Types
// =============================================================================

export interface FeatureFlags {
  useNewAdminApi: boolean;
  useNewContainerGateway: boolean;
  tieredRoutingEnabled: boolean;
  execResultsInDO: boolean;
  dualWriteEnabled: boolean;
}

// =============================================================================
// D1 Database Types
// =============================================================================

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T>(statements: D1PreparedStatement[]): Promise<T[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T>(): Promise<D1Result<T[]>>;
  raw<T>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results: T;
  lastRowId: number | null;
  changes: number;
  duration: number;
  error?: string;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

// =============================================================================
// Cost Tracking Types
// =============================================================================

export interface CostSummary {
  period: {
    start: string;
    end: string;
    days: number;
  };
  totalCost: number;
  userCount: number;
  serviceBreakdown: ServiceCost[];
  userBreakdown: UserCost[];
  trends: CostTrends;
}

export interface ServiceCost {
  service: 'workers' | 'r2' | 'durableObjects' | 'sandbox';
  cost: number;
  details: Record<string, number>;
}

export interface UserCost {
  userId: string;
  userName: string;
  totalCost: number;
  workers: { cost: number; requests: number; gbSeconds: number };
  r2: { cost: number; storageGB: number; operations: number };
  durableObjects: { cost: number; requests: number; storageGB: number };
  percentageOfTotal?: number;
}

export interface CostTrends {
  daily: Array<{ date: string; cost: number }>;
  projectedMonthly: number;
}
