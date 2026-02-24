/**
 * Sandbox resilience helpers
 *
 * Cloudflare Sandbox cold-starts can produce transient errors like:
 *  - "Session 'sandbox-openclaw-…' is not ready or shell has died"
 *  - connection resets
 *
 * These helpers provide small, dependency-free retries and a readiness probe.
 */

export function isSandboxNotReadyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    /not ready/i.test(msg) ||
    /shell has died/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /EPIPE/i.test(msg)
  );
}

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  shouldRetry?: (err: unknown) => boolean;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<{ value?: T; attempts: number; lastError?: unknown }> {
  const retries = opts.retries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  const jitter = opts.jitter ?? true;
  const shouldRetry = opts.shouldRetry ?? isSandboxNotReadyError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err;
      const canRetry = attempt < retries && shouldRetry(err);
      if (!canRetry) break;

      let delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      if (jitter) delayMs = Math.floor(delayMs * (0.7 + Math.random() * 0.6));
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  return { attempts: retries, lastError };
}

export async function waitForSandboxReady(
  sandbox: any,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ ready: boolean; attempts: number; lastError?: unknown }>
{
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError: unknown;

  while (Date.now() < deadline) {
    attempts++;
    try {
      // listProcesses is a good signal that the session is up.
      await sandbox.listProcesses();
      // and the gateway health endpoint tells us port forwarding works.
      // NOTE: containerFetch signature differs across versions; use the existing pattern.
      try {
        await sandbox.containerFetch(new Request('http://localhost:18789/health'), 18789);
      } catch {
        // don't fail readiness purely on /health; listProcesses is the primary gate.
      }
      return { ready: true, attempts };
    } catch (err) {
      lastError = err;
      if (!isSandboxNotReadyError(err)) {
        // Non-transient; bail early.
        return { ready: false, attempts, lastError };
      }
      await sleep(intervalMs);
    }
  }

  return { ready: false, attempts, lastError };
}
