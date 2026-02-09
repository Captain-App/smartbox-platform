/**
 * Shared utilities for moltworker architecture
 */

// =============================================================================
// Logging Utilities
// =============================================================================

/**
 * Redact sensitive parameters from URL search params
 */
export function redactSensitiveParams(url: URL): string {
  const sensitiveParams = ['token', 'key', 'secret', 'password', 'auth'];
  const params = new URLSearchParams(url.search);
  
  for (const param of sensitiveParams) {
    if (params.has(param)) {
      params.set(param, '[REDACTED]');
    }
  }
  
  const queryString = params.toString();
  return queryString ? `?${queryString}` : '';
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Generate a unique execution ID
 */
export function generateExecId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `exec-${timestamp}-${random}`;
}

// =============================================================================
// Time Utilities
// =============================================================================

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Parse duration string to milliseconds
 * Supports: 1s, 1m, 1h, 1d
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }
  
  const value = parseInt(match[1], 10);
  const unit = match[2];
  
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  
  return value * multipliers[unit];
}

/**
 * Get ISO timestamp for a date (defaults to now)
 */
export function getTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

// =============================================================================
// String Utilities
// =============================================================================

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Sanitize a string for use in a filename
 */
export function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9-_]/g, '_');
}

/**
 * Convert string to base64
 */
export function toBase64(str: string): string {
  return btoa(str);
}

/**
 * Convert base64 to string
 */
export function fromBase64(str: string): string {
  return atob(str);
}

// =============================================================================
// Object Utilities
// =============================================================================

/**
 * Deep merge two objects
 * Arrays are replaced, not concatenated
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
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
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      ) as T[Extract<keyof T, string>];
    } else {
      result[key] = sourceVal as T[Extract<keyof T, string>];
    }
  }
  
  return result;
}

/**
 * Pick specific keys from an object
 */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  
  return result;
}

/**
 * Omit specific keys from an object
 */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj } as Omit<T, K>;
  
  for (const key of keys) {
    delete (result as Record<string, unknown>)[key as string];
  }
  
  return result;
}

// =============================================================================
// Array Utilities
// =============================================================================

/**
 * Chunk an array into smaller arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Remove duplicates from an array
 */
export function unique<T>(array: T[]): T[] {
  return [...new Set(array)];
}

/**
 * Group array items by a key function
 */
export function groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  
  for (const item of array) {
    const key = keyFn(item);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  }
  
  return groups;
}

// =============================================================================
// Response Utilities
// =============================================================================

/**
 * Create a standardized JSON response
 */
export function jsonResponse<T>(
  data: T,
  status = 200,
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/**
 * Create an error response
 */
export function errorResponse(
  message: string,
  status = 500,
  details?: Record<string, unknown>
): Response {
  return jsonResponse(
    {
      error: message,
      ...(details && { details }),
      timestamp: new Date().toISOString(),
    },
    status
  );
}

// =============================================================================
// URL Utilities
// =============================================================================

/**
 * Build a URL with query parameters
 */
export function buildUrl(
  base: string,
  params: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(base);
  
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  
  return url.toString();
}

/**
 * Get pathname segments from a URL
 */
export function getPathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}
