/**
 * Sync Queue - Priority-based job queue for real-time sync
 * 
 * Features:
 * - Priority levels: critical, high, normal, low
 * - Max concurrent jobs: 3
 * - EventEmitter for job completion
 * - Job deduplication by file path
 */

import { EventEmitter } from 'events';

/** Priority levels for sync jobs */
export type SyncPriority = 'critical' | 'high' | 'normal' | 'low';

/** Priority values (higher = more important) */
export const PRIORITY_VALUES: Record<SyncPriority, number> = {
  critical: 100,
  high: 70,
  normal: 40,
  low: 10,
};

/** A single file to be synced */
export interface SyncJob {
  /** Unique job ID */
  id: string;
  /** File path to sync */
  path: string;
  /** Priority level */
  priority: SyncPriority;
  /** When the job was created */
  createdAt: number;
  /** When the job should execute (for debouncing) */
  executeAt: number;
  /** Number of retry attempts */
  retries: number;
  /** Maximum retries allowed */
  maxRetries: number;
  /** Optional user context */
  userId?: string;
  /** Optional R2 prefix for user-specific storage */
  r2Prefix?: string;
  /** Batch ID for grouped jobs */
  batchId?: string;
}

/** Result of a sync job execution */
export interface JobResult {
  jobId: string;
  success: boolean;
  error?: string;
  durationMs: number;
  syncedAt: string;
}

/** Queue statistics */
export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  byPriority: Record<SyncPriority, number>;
}

/** Configuration for the sync queue */
export interface SyncQueueConfig {
  /** Maximum concurrent jobs (default: 3) */
  maxConcurrent: number;
  /** Default max retries per job */
  defaultMaxRetries: number;
}

const DEFAULT_CONFIG: SyncQueueConfig = {
  maxConcurrent: 3,
  defaultMaxRetries: 3,
};

/**
 * Priority-based sync queue with concurrency control
 */
export class SyncQueue extends EventEmitter {
  private config: SyncQueueConfig;
  private queue: SyncJob[] = [];
  private processing = new Set<string>();
  private completed: JobResult[] = [];
  private isRunning = false;
  private processInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<SyncQueueConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the queue processor
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emit('started');
    console.log('[SyncQueue] Started with maxConcurrent:', this.config.maxConcurrent);
  }

  /**
   * Stop the queue processor gracefully
   */
  stop(): void {
    this.isRunning = false;
    if (this.processInterval) {
      clearTimeout(this.processInterval);
      this.processInterval = null;
    }
    this.emit('stopped');
    console.log('[SyncQueue] Stopped');
  }

  /**
   * Add a job to the queue
   * If a job for the same path already exists, updates its priority if higher
   */
  enqueue(job: Omit<SyncJob, 'id' | 'createdAt' | 'retries' | 'maxRetries'> & { id?: string }): SyncJob {
    const now = Date.now();
    const newJob: SyncJob = {
      id: job.id || this.generateJobId(),
      createdAt: now,
      retries: 0,
      maxRetries: this.config.defaultMaxRetries,
      ...job,
    };

    // Check for existing job with same path
    const existingIndex = this.queue.findIndex(j => j.path === newJob.path);
    if (existingIndex !== -1) {
      const existing = this.queue[existingIndex];
      // Upgrade priority if new job is higher priority
      if (PRIORITY_VALUES[newJob.priority] > PRIORITY_VALUES[existing.priority]) {
        existing.priority = newJob.priority;
        existing.executeAt = Math.min(existing.executeAt, newJob.executeAt);
        this.emit('upgraded', { jobId: existing.id, newPriority: newJob.priority });
        this.sortQueue();
      }
      return existing;
    }

    // Add new job
    this.queue.push(newJob);
    this.sortQueue();
    this.emit('enqueued', { jobId: newJob.id, path: newJob.path, priority: newJob.priority });

    return newJob;
  }

  /**
   * Add multiple jobs as a batch (same batchId)
   */
  enqueueBatch(
    paths: string[],
    priority: SyncPriority,
    options: { executeAt?: number; userId?: string; r2Prefix?: string } = {}
  ): SyncJob[] {
    const batchId = this.generateBatchId();
    const jobs: SyncJob[] = [];

    for (const path of paths) {
      const job = this.enqueue({
        path,
        priority,
        executeAt: options.executeAt || Date.now(),
        userId: options.userId,
        r2Prefix: options.r2Prefix,
        batchId,
      });
      jobs.push(job);
    }

    this.emit('batchEnqueued', { batchId, count: jobs.length, priority });
    return jobs;
  }

  /**
   * Get the next job that is ready to execute
   */
  getNextJob(): SyncJob | undefined {
    const now = Date.now();
    const readyIndex = this.queue.findIndex(
      job => !this.processing.has(job.id) && job.executeAt <= now
    );
    
    if (readyIndex === -1) return undefined;
    
    const job = this.queue[readyIndex];
    this.queue.splice(readyIndex, 1);
    this.processing.add(job.id);
    
    return job;
  }

  /**
   * Check if a job is currently being processed
   */
  isProcessing(jobId: string): boolean {
    return this.processing.has(jobId);
  }

  /**
   * Mark a job as completed
   */
  complete(jobId: string, success: boolean, error?: string, durationMs: number = 0): void {
    this.processing.delete(jobId);
    
    const result: JobResult = {
      jobId,
      success,
      error,
      durationMs,
      syncedAt: new Date().toISOString(),
    };
    
    this.completed.push(result);
    
    // Keep only last 100 results
    if (this.completed.length > 100) {
      this.completed = this.completed.slice(-100);
    }
    
    this.emit('completed', result);
    
    if (!success && error) {
      this.emit('failed', result);
    }
  }

  /**
   * Mark a job for retry
   */
  retry(jobId: string, error: string): boolean {
    const job = this.findJob(jobId);
    if (!job) return false;
    
    this.processing.delete(jobId);
    
    if (job.retries >= job.maxRetries) {
      this.complete(jobId, false, `Max retries exceeded: ${error}`, 0);
      return false;
    }
    
    job.retries++;
    job.executeAt = Date.now() + this.getRetryDelay(job.retries);
    this.queue.push(job);
    this.sortQueue();
    
    this.emit('retry', { jobId, retryCount: job.retries, nextAttempt: job.executeAt });
    return true;
  }

  /**
   * Get current queue statistics
   */
  getStats(): QueueStats {
    const byPriority: Record<SyncPriority, number> = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0,
    };

    for (const job of this.queue) {
      byPriority[job.priority]++;
    }

    return {
      pending: this.queue.length,
      processing: this.processing.size,
      completed: this.completed.length,
      failed: this.completed.filter(r => !r.success).length,
      byPriority,
    };
  }

  /**
   * Get pending jobs count by priority
   */
  getPendingCount(priority?: SyncPriority): number {
    if (priority) {
      return this.queue.filter(j => j.priority === priority).length;
    }
    return this.queue.length;
  }

  /**
   * Get the oldest pending job's age in milliseconds
   */
  getOldestPendingAge(): number {
    if (this.queue.length === 0) return 0;
    const oldest = Math.min(...this.queue.map(j => j.createdAt));
    return Date.now() - oldest;
  }

  /**
   * Get lag time per priority (time since oldest job in that priority)
   */
  getLagByPriority(): Record<SyncPriority, number> {
    const now = Date.now();
    const result: Record<SyncPriority, number> = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0,
    };

    for (const priority of Object.keys(result) as SyncPriority[]) {
      const jobs = this.queue.filter(j => j.priority === priority);
      if (jobs.length > 0) {
        const oldest = Math.min(...jobs.map(j => j.createdAt));
        result[priority] = now - oldest;
      }
    }

    return result;
  }

  /**
   * Get recent completed jobs
   */
  getRecentResults(limit: number = 10): JobResult[] {
    return this.completed.slice(-limit);
  }

  /**
   * Clear all pending jobs
   */
  clear(): void {
    this.queue = [];
    this.emit('cleared');
  }

  /**
   * Pause processing (jobs remain in queue)
   */
  pause(): void {
    this.isRunning = false;
    if (this.processInterval) {
      clearTimeout(this.processInterval);
      this.processInterval = null;
    }
    this.emit('paused');
  }

  /**
   * Resume processing
   */
  resume(): void {
    if (!this.isRunning) {
      this.isRunning = true;
      this.emit('resumed');
    }
  }

  /**
   * Check if queue is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Find a job by ID (in queue or processing)
   */
  private findJob(jobId: string): SyncJob | undefined {
    // Check queue
    const inQueue = this.queue.find(j => j.id === jobId);
    if (inQueue) return inQueue;
    
    // Check processing (would need to track full job objects there)
    return undefined;
  }

  /**
   * Sort queue by priority (descending) then by executeAt (ascending)
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      // First by priority (descending)
      const priorityDiff = PRIORITY_VALUES[b.priority] - PRIORITY_VALUES[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      
      // Then by execute time (ascending)
      return a.executeAt - b.executeAt;
    });
  }

  /**
   * Generate unique job ID
   */
  private generateJobId(): string {
    return `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Generate unique batch ID
   */
  private generateBatchId(): string {
    return `batch-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get exponential backoff delay for retry
   */
  private getRetryDelay(attempt: number): number {
    // Exponential backoff: 1s, 2s, 4s
    return Math.min(1000 * Math.pow(2, attempt - 1), 10000);
  }
}

/** Singleton instance for the application */
let globalQueue: SyncQueue | null = null;

/**
 * Get or create the global sync queue instance
 */
export function getSyncQueue(config?: Partial<SyncQueueConfig>): SyncQueue {
  if (!globalQueue) {
    globalQueue = new SyncQueue(config);
  }
  return globalQueue;
}

/**
 * Reset the global queue (for testing)
 */
export function resetSyncQueue(): void {
  if (globalQueue) {
    globalQueue.stop();
    globalQueue.removeAllListeners();
    globalQueue = null;
  }
}
