/**
 * Cost tracking and monitoring for Moltworker platform
 * 
 * Calculates estimated costs based on:
 * - Cloudflare Workers invocations and duration
 * - R2 storage and operations
 * - Durable Objects requests and storage
 * 
 * Cost model (from Cloudflare published pricing):
 * - Workers: $0.50/million requests + $12.50/million GB-seconds
 * - R2: $0.015/GB-month storage + $0.36/million operations
 * - Durable Objects: $5/billion requests + $2.50/GB-month storage
 * - Sandbox: Included in Workers pricing
 */

import type { AppEnv } from '../types';

// Cost constants (per-unit pricing)
export const COST_RATES = {
  // Workers: $0.50 per million requests
  workers: {
    requestsPerMillion: 0.50,
    gbSecondsPerMillion: 12.50,
  },
  // R2: $0.015 per GB-month storage, $0.36 per million operations
  r2: {
    storagePerGBMonth: 0.015,
    operationsPerMillion: 0.36,
  },
  // Durable Objects: $5 per billion requests, $2.50 per GB-month storage
  durableObjects: {
    requestsPerBillion: 5.00,
    storagePerGBMonth: 2.50,
  },
} as const;

// List of all user IDs for cost tracking
const KNOWN_USER_IDS = [
  '38b1ec2b-7a70-4834-a48d-162b8902b0fd', // kyla
  '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b', // jack
  '6d575ef4-7ac8-4a17-b732-e0e690986e58', // david geddes
  '0f1195c1-6b57-4254-9871-6ef3b7fa360c', // rhys
  '679f60a6-2e00-403b-86f1-f4696149294f', // james
  'aef3677b-afdf-4a7e-bbeb-c596f0d94d29', // adnan
  '5bb7d208-2baf-4c95-8aec-f28e016acedb', // david lippold
  'e29fd082-6811-4e29-893e-64699c49e1f0', // ben lippold
  'fe56406b-a723-43cf-9f19-ba2ffcb135b0', // miles
  '81bf6a68-28fe-48ef-b257-f9ad013e6298', // josh
];

// User name mapping for display
const USER_NAMES: Record<string, string> = {
  '38b1ec2b-7a70-4834-a48d-162b8902b0fd': 'kyla',
  '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b': 'jack',
  '6d575ef4-7ac8-4a17-b732-e0e690986e58': 'david_geddes',
  '0f1195c1-6b57-4254-9871-6ef3b7fa360c': 'rhys',
  '679f60a6-2e00-403b-86f1-f4696149294f': 'james',
  'aef3677b-afdf-4a7e-bbeb-c596f0d94d29': 'adnan',
  '5bb7d208-2baf-4c95-8aec-f28e016acedb': 'david_lippold',
  'e29fd082-6811-4e29-893e-64699c49e1f0': 'ben_lippold',
  'fe56406b-a723-43cf-9f19-ba2ffcb135b0': 'miles',
  '81bf6a68-28fe-48ef-b257-f9ad013e6298': 'josh',
};

// Cost data interfaces
export interface UserCostBreakdown {
  userId: string;
  userName: string;
  workers: {
    requests: number;
    gbSeconds: number;
    cost: number;
  };
  r2: {
    storageGB: number;
    operations: number;
    cost: number;
  };
  durableObjects: {
    requests: number;
    storageGB: number;
    cost: number;
  };
  totalCost: number;
  percentageOfTotal: number;
}

export interface ServiceCostBreakdown {
  service: 'workers' | 'r2' | 'durableObjects' | 'sandbox';
  description: string;
  cost: number;
  percentageOfTotal: number;
  details: {
    requests?: number;
    duration?: number;
    storage?: number;
    operations?: number;
  };
}

export interface CostSummary {
  period: {
    start: string;
    end: string;
    days: number;
  };
  totalCost: number;
  userCount: number;
  serviceCount: number;
  userBreakdown: UserCostBreakdown[];
  serviceBreakdown: ServiceCostBreakdown[];
  trends: {
    vsLastMonth: number; // percentage change
    projectedMonthly: number;
  };
  alerts: CostAlert[];
}

export interface CostAlert {
  type: 'threshold' | 'anomaly' | 'trend';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  details?: Record<string, unknown>;
}

export interface CostFilter {
  userId?: string;
  service?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * GraphQL query for Cloudflare Analytics API
 * Gets Workers invocations and duration
 */
const WORKERS_ANALYTICS_QUERY = `
  query WorkersAnalytics($zoneTag: String!, $since: Time!, $until: Time!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1dGroups(
          limit: 10000,
          filter: { date_geq: $since, date_leq: $until }
        ) {
          dimensions {
            date
          }
          sum {
            requests
            bytes
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for R2 analytics
 */
const R2_ANALYTICS_QUERY = `
  query R2Analytics($accountTag: String!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(
          limit: 10000,
          filter: { date_geq: $since, date_leq: $until }
        ) {
          dimensions {
            date
            bucketName
          }
          sum {
            metadataSize
            objectCount
          }
        }
        r2OperationsAdaptiveGroups(
          limit: 10000,
          filter: { date_geq: $since, date_leq: $until }
        ) {
          dimensions {
            date
            actionType
          }
          sum {
            requests
          }
        }
      }
    }
  }
`;

/**
 * Get date range for current billing period
 * Cloudflare billing typically aligns with calendar month
 */
export function getBillingPeriod(days: number = 30): { start: Date; end: Date; days: number } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  
  return {
    start,
    end,
    days,
  };
}

/**
 * Fetch Workers analytics from Cloudflare GraphQL API
 * Note: This is a placeholder - actual implementation requires CF API token
 */
async function fetchWorkersAnalytics(
  accountId: string,
  apiToken: string,
  since: Date,
  until: Date
): Promise<{ requests: number; gbSeconds: number }> {
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: WORKERS_ANALYTICS_QUERY,
        variables: {
          accountTag: accountId,
          since: since.toISOString(),
          until: until.toISOString(),
        },
      }),
    });

    if (!response.ok) {
      console.error('[CostTracking] Workers analytics fetch failed:', response.status);
      return { requests: 0, gbSeconds: 0 };
    }

    const data = await response.json();
    
    // Extract and aggregate data
    const zones = data?.data?.viewer?.zones || [];
    let totalRequests = 0;
    let totalBytes = 0;

    for (const zone of zones) {
      for (const group of zone.httpRequests1dGroups || []) {
        totalRequests += group.sum?.requests || 0;
        totalBytes += group.sum?.bytes || 0;
      }
    }

    // Estimate GB-seconds based on bytes and average processing time
    // This is an approximation - actual values come from Workers analytics
    const estimatedGbSeconds = (totalBytes / 1e9) * 0.1; // Assume 100ms average processing

    return {
      requests: totalRequests,
      gbSeconds: estimatedGbSeconds,
    };
  } catch (error) {
    console.error('[CostTracking] Error fetching Workers analytics:', error);
    return { requests: 0, gbSeconds: 0 };
  }
}

/**
 * Fetch R2 analytics from Cloudflare GraphQL API
 */
async function fetchR2Analytics(
  accountId: string,
  apiToken: string,
  since: Date,
  until: Date
): Promise<{ storageGB: number; operations: number }> {
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: R2_ANALYTICS_QUERY,
        variables: {
          accountTag: accountId,
          since: since.toISOString(),
          until: until.toISOString(),
        },
      }),
    });

    if (!response.ok) {
      console.error('[CostTracking] R2 analytics fetch failed:', response.status);
      return { storageGB: 0, operations: 0 };
    }

    const data = await response.json();
    
    const accounts = data?.data?.viewer?.accounts || [];
    let totalStorage = 0;
    let totalOperations = 0;

    for (const account of accounts) {
      for (const group of account.r2StorageAdaptiveGroups || []) {
        totalStorage += group.sum?.metadataSize || 0;
      }
      for (const group of account.r2OperationsAdaptiveGroups || []) {
        totalOperations += group.sum?.requests || 0;
      }
    }

    return {
      storageGB: totalStorage / 1e9, // Convert bytes to GB
      operations: totalOperations,
    };
  } catch (error) {
    console.error('[CostTracking] Error fetching R2 analytics:', error);
    return { storageGB: 0, operations: 0 };
  }
}

/**
 * Calculate estimated cost based on usage
 */
export function calculateCost(
  workersRequests: number,
  workersGbSeconds: number,
  r2StorageGB: number,
  r2Operations: number,
  doRequests: number = 0,
  doStorageGB: number = 0
): { workers: number; r2: number; durableObjects: number; total: number } {
  const workersCost = 
    (workersRequests / 1_000_000) * COST_RATES.workers.requestsPerMillion +
    (workersGbSeconds / 1_000_000) * COST_RATES.workers.gbSecondsPerMillion;

  const r2Cost = 
    r2StorageGB * COST_RATES.r2.storagePerGBMonth +
    (r2Operations / 1_000_000) * COST_RATES.r2.operationsPerMillion;

  const doCost = 
    (doRequests / 1_000_000_000) * COST_RATES.durableObjects.requestsPerBillion +
    doStorageGB * COST_RATES.durableObjects.storagePerGBMonth;

  return {
    workers: Math.max(0, workersCost),
    r2: Math.max(0, r2Cost),
    durableObjects: Math.max(0, doCost),
    total: Math.max(0, workersCost + r2Cost + doCost),
  };
}

/**
 * Get R2 usage per user from bucket listing
 * This estimates storage per user based on their prefix in R2
 */
export async function getR2UsagePerUser(
  bucket: R2Bucket
): Promise<Record<string, { storageGB: number; operations: number }>> {
  const usage: Record<string, { storageGB: number; operations: number }> = {};

  try {
    // List all objects and aggregate by user prefix
    const listed = await bucket.list({ prefix: 'users/' });
    
    for (const obj of listed.objects) {
      const match = obj.key.match(/^users\/([^/]+)\//);
      if (match) {
        const userId = match[1];
        if (!usage[userId]) {
          usage[userId] = { storageGB: 0, operations: 0 };
        }
        usage[userId].storageGB += obj.size / 1e9;
        // Estimate operations based on object count (rough approximation)
        usage[userId].operations += 1;
      }
    }

    return usage;
  } catch (error) {
    console.error('[CostTracking] Error getting R2 usage per user:', error);
    return {};
  }
}

/**
 * Get container activity metrics from R2 sync markers
 * Used to estimate Workers/Sandbox usage
 */
export async function getContainerActivityMetrics(
  bucket: R2Bucket,
  userId: string
): Promise<{ lastSync: Date | null; syncCount: number; estimatedRequests: number }> {
  try {
    const syncKey = `users/${userId}/.last-sync`;
    const syncObj = await bucket.get(syncKey);
    
    let lastSync: Date | null = null;
    let syncCount = 0;

    if (syncObj) {
      const syncData = await syncObj.text();
      const timestamp = syncData.split('|')[0] || syncData;
      lastSync = new Date(timestamp);
    }

    // List sync-related objects to estimate activity
    const prefix = `users/${userId}/`;
    const listed = await bucket.list({ prefix });
    syncCount = listed.objects.length;

    // Estimate requests based on sync count and file activity
    // This is a rough heuristic - actual request count requires analytics API
    const estimatedRequests = syncCount * 100; // Assume ~100 requests per sync operation

    return {
      lastSync,
      syncCount,
      estimatedRequests,
    };
  } catch (error) {
    console.error('[CostTracking] Error getting activity metrics for', userId, error);
    return { lastSync: null, syncCount: 0, estimatedRequests: 0 };
  }
}

/**
 * Generate cost summary for all users
 */
export async function generateCostSummary(
  env: AppEnv,
  options: {
    days?: number;
    threshold?: number;
  } = {}
): Promise<CostSummary> {
  const period = getBillingPeriod(options.days || 30);
  const userBreakdown: UserCostBreakdown[] = [];

  // Get R2 usage per user
  const r2Usage = await getR2UsagePerUser(env.MOLTBOT_BUCKET);

  // Calculate costs for each user
  for (const userId of KNOWN_USER_IDS) {
    const userR2 = r2Usage[userId] || { storageGB: 0, operations: 0 };
    const activity = await getContainerActivityMetrics(env.MOLTBOT_BUCKET, userId);

    // Estimate Workers usage based on activity
    // This is an approximation - real data requires Cloudflare Analytics API
    const estimatedWorkersRequests = activity.estimatedRequests;
    const estimatedGbSeconds = activity.syncCount * 0.5; // Assume 0.5 GB-seconds per operation

    // Calculate costs
    const costs = calculateCost(
      estimatedWorkersRequests,
      estimatedGbSeconds,
      userR2.storageGB,
      userR2.operations * 10, // Estimate 10 operations per file
      0, // DO requests - need separate tracking
      0  // DO storage - typically minimal for this use case
    );

    userBreakdown.push({
      userId,
      userName: USER_NAMES[userId] || userId.slice(0, 8),
      workers: {
        requests: estimatedWorkersRequests,
        gbSeconds: estimatedGbSeconds,
        cost: costs.workers,
      },
      r2: {
        storageGB: userR2.storageGB,
        operations: userR2.operations * 10,
        cost: costs.r2,
      },
      durableObjects: {
        requests: 0,
        storageGB: 0,
        cost: costs.durableObjects,
      },
      totalCost: costs.total,
      percentageOfTotal: 0, // Will be calculated after total
    });
  }

  // Calculate total and percentages
  const totalCost = userBreakdown.reduce((sum, u) => sum + u.totalCost, 0);
  for (const user of userBreakdown) {
    user.percentageOfTotal = totalCost > 0 ? (user.totalCost / totalCost) * 100 : 0;
  }

  // Sort by cost descending
  userBreakdown.sort((a, b) => b.totalCost - a.totalCost);

  // Generate service breakdown
  const serviceBreakdown: ServiceCostBreakdown[] = [
    {
      service: 'workers',
      description: 'Workers invocations and compute time',
      cost: userBreakdown.reduce((sum, u) => sum + u.workers.cost, 0),
      percentageOfTotal: 0,
      details: {
        requests: userBreakdown.reduce((sum, u) => sum + u.workers.requests, 0),
        duration: userBreakdown.reduce((sum, u) => sum + u.workers.gbSeconds, 0),
      },
    },
    {
      service: 'r2',
      description: 'R2 object storage and operations',
      cost: userBreakdown.reduce((sum, u) => sum + u.r2.cost, 0),
      percentageOfTotal: 0,
      details: {
        storage: userBreakdown.reduce((sum, u) => sum + u.r2.storageGB, 0),
        operations: userBreakdown.reduce((sum, u) => sum + u.r2.operations, 0),
      },
    },
    {
      service: 'durableObjects',
      description: 'Durable Objects (ChatRooms, etc.)',
      cost: userBreakdown.reduce((sum, u) => sum + u.durableObjects.cost, 0),
      percentageOfTotal: 0,
      details: {
        requests: userBreakdown.reduce((sum, u) => sum + u.durableObjects.requests, 0),
        storage: userBreakdown.reduce((sum, u) => sum + u.durableObjects.storageGB, 0),
      },
    },
    {
      service: 'sandbox',
      description: 'Sandbox container instances (included in Workers)',
      cost: 0,
      percentageOfTotal: 0,
      details: {},
    },
  ];

  // Calculate service percentages
  for (const service of serviceBreakdown) {
    service.percentageOfTotal = totalCost > 0 ? (service.cost / totalCost) * 100 : 0;
  }

  // Generate alerts
  const alerts: CostAlert[] = [];
  
  // Threshold alerts
  if (options.threshold && totalCost > options.threshold) {
    alerts.push({
      type: 'threshold',
      severity: totalCost > options.threshold * 2 ? 'critical' : 'warning',
      message: `Total cost ($${totalCost.toFixed(2)}) exceeds threshold ($${options.threshold.toFixed(2)})`,
      details: { threshold: options.threshold, actual: totalCost },
    });
  }

  // High user cost alerts
  const highestUser = userBreakdown[0];
  if (highestUser && highestUser.percentageOfTotal > 50) {
    alerts.push({
      type: 'anomaly',
      severity: 'warning',
      message: `${highestUser.userName} accounts for ${highestUser.percentageOfTotal.toFixed(1)}% of total cost`,
      details: { userId: highestUser.userId, percentage: highestUser.percentageOfTotal },
    });
  }

  // Calculate trends (mock - would need historical data)
  const vsLastMonth = 0; // Would compare with previous period
  const projectedMonthly = totalCost * (30 / period.days); // Extrapolate to 30 days

  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      days: period.days,
    },
    totalCost,
    userCount: KNOWN_USER_IDS.length,
    serviceCount: 3,
    userBreakdown,
    serviceBreakdown,
    trends: {
      vsLastMonth,
      projectedMonthly,
    },
    alerts,
  };
}

/**
 * Get cost summary for a specific user
 */
export async function getUserCostSummary(
  env: AppEnv,
  userId: string,
  options: { days?: number } = {}
): Promise<UserCostBreakdown | null> {
  if (!KNOWN_USER_IDS.includes(userId)) {
    return null;
  }

  const period = getBillingPeriod(options.days || 30);
  const r2Usage = await getR2UsagePerUser(env.MOLTBOT_BUCKET);
  const userR2 = r2Usage[userId] || { storageGB: 0, operations: 0 };
  const activity = await getContainerActivityMetrics(env.MOLTBOT_BUCKET, userId);

  const estimatedWorkersRequests = activity.estimatedRequests;
  const estimatedGbSeconds = activity.syncCount * 0.5;

  const costs = calculateCost(
    estimatedWorkersRequests,
    estimatedGbSeconds,
    userR2.storageGB,
    userR2.operations * 10,
    0,
    0
  );

  return {
    userId,
    userName: USER_NAMES[userId] || userId.slice(0, 8),
    workers: {
      requests: estimatedWorkersRequests,
      gbSeconds: estimatedGbSeconds,
      cost: costs.workers,
    },
    r2: {
      storageGB: userR2.storageGB,
      operations: userR2.operations * 10,
      cost: costs.r2,
    },
    durableObjects: {
      requests: 0,
      storageGB: 0,
      cost: costs.durableObjects,
    },
    totalCost: costs.total,
    percentageOfTotal: 0, // Would need total for context
  };
}

/**
 * Check if cost exceeds threshold and generate alert
 */
export async function checkCostThreshold(
  env: AppEnv,
  threshold: number,
  options: { days?: number } = {}
): Promise<{ exceeded: boolean; current: number; threshold: number; alerts: CostAlert[] }> {
  const summary = await generateCostSummary(env, { days: options.days || 30, threshold });
  
  return {
    exceeded: summary.totalCost > threshold,
    current: summary.totalCost,
    threshold,
    alerts: summary.alerts,
  };
}

export { KNOWN_USER_IDS, USER_NAMES };
